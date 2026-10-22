"""SOC-Lite · Middleware de bitácora de auditoría (entrada/salida por módulo).

Estrategia de doble capa para cumplir el requisito *"bitácora de auditoría que
registre entradas y salidas por módulo (usuario, fecha, hora y acción realizada)"*
sin duplicar registros:

* **Capa de negocio** — los controladores llaman a `AuditService.log()` con el
  detalle funcional (before/after, entidad, motivo). Al escribir, marcan el
  contexto de request (`mark_audit_written`).
* **Capa de acceso** — este middleware cierra el request; si ningún controlador
  escribió una entrada para esa petición, genera automáticamente el registro de
  acceso (entrada/salida) con método, ruta, código HTTP y duración.

Resultado: **toda** petición autenticada a un módulo auditable deja exactamente
una traza con usuario + fecha + hora + módulo + acción + resultado, y las
operaciones sensibles añaden además su detalle de negocio.
"""
from __future__ import annotations

import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.core.context import RequestAuditContext, audit_context
from app.services.audit_service import AuditService, resolve_action, resolve_module

logger = logging.getLogger("soclite.middleware.audit")

# Rutas excluidas de la bitácora (ruido: documentación, métricas, estáticos)
EXCLUDED_PREFIXES = ("/docs", "/redoc", "/openapi.json", "/metrics", "/favicon.ico", "/api/v1/health")
EXCLUDED_METHODS = ("OPTIONS", "HEAD")


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path

        if any(path.startswith(p) for p in EXCLUDED_PREFIXES) or request.method in EXCLUDED_METHODS:
            return await call_next(request)

        trace_id = str(uuid.uuid4())
        request.state.trace_id = trace_id
        fwd = request.headers.get("x-forwarded-for")
        ip = (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None))

        ctx = RequestAuditContext(
            trace_id=trace_id,
            ip_address=ip,
            user_agent=request.headers.get("user-agent"),
            method=request.method,
            path=path,
            module=resolve_module(path),
            started_at=time.perf_counter(),
        )
        token = audit_context.set(ctx)

        try:
            response = await call_next(request)
        except Exception:
            # El handler de excepciones ya generó la respuesta; se registra el fallo.
            ctx.written = False
            audit_context.reset(token)
            await self._write_access_log(ctx, request, status_code=500)
            raise

        duration_ms = int((time.perf_counter() - ctx.started_at) * 1000)
        response.headers["X-Trace-Id"] = trace_id
        audit_context.reset(token)

        if response.status_code == 401:
            # No se audita aquí: el login fallido ya lo registra el router de auth
            return response

        if not ctx.written:
            await self._write_access_log(ctx, request, status_code=response.status_code, duration_ms=duration_ms)

        return response

    @staticmethod
    async def _write_access_log(
        ctx: RequestAuditContext, request: Request, status_code: int, duration_ms: int | None = None
    ) -> None:
        """Registro de acceso (entrada/salida) con sesión propia de BD."""
        from app.db.session import AsyncSessionLocal
        from app.models.enums import AuditResult

        result = AuditResult.SUCCESS
        severity = "info"
        if status_code == 403:
            result, severity = AuditResult.DENIED, "warning"
        elif status_code >= 500:
            result, severity = AuditResult.FAILURE, "critical"
        elif status_code >= 400:
            result, severity = AuditResult.FAILURE, "warning"

        if ctx.module in ("alerts", "triage") and request.method == "GET":
            # Las lecturas masivas de alertas/triaje generan mucho volumen: se
            # registran igualmente, pero el detalle se mantiene compacto.
            severity = "info"

        try:
            async with AsyncSessionLocal() as session:
                await AuditService(session).log(
                    module=ctx.module,
                    action=resolve_action(ctx.method, ctx.path),
                    user_id=ctx.user_id,
                    username=ctx.username or "anónimo",
                    entity="http_request",
                    entity_id=None,
                    result=result,
                    detail=(
                        f"[acceso] {ctx.method} {ctx.path} → HTTP {status_code}"
                        + (f" en {duration_ms} ms" if duration_ms is not None else "")
                    ),
                    ip_address=ctx.ip_address,
                    user_agent=ctx.user_agent,
                    http_method=ctx.method,
                    http_path=ctx.path,
                    http_status=status_code,
                    duration_ms=duration_ms,
                    trace_id=ctx.trace_id,
                    severity=severity,
                )
                await session.commit()
        except Exception as exc:  # pragma: no cover - la auditoría nunca debe romper la API
            logger.error("No fue posible escribir el registro de acceso en la bitácora: %s", exc)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Cabeceras de seguridad (ISO 27001 A.8.23 · NIST CSF PR.PS-01)."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self' http://localhost:8000 http://localhost:5173",
        )
        if request.url.scheme == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response
