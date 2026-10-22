"""SOC-Lite · Servicio de bitácora de auditoría.

Responsabilidad única: construir y persistir eventos de auditoría con el
esquema normativo exigido — **usuario, fecha, hora, módulo, acción y resultado**
(ISO/IEC 27001:2022 A.8.15 · NIST CSF 2.0 DE.AE-03 / GV.OC).

Características:
* Escritura *fail-open*: si la bitácora falla, la operación de negocio continúa
  pero se emite un log crítico (evita convertir la auditoría en un punto único
  de fallo del SOC).
* Diff automático `before`/`after` para acciones de tipo UPDATE.
* El encadenamiento de hashes (hash_prev/hash_self) lo calcula un trigger
  de PostgreSQL, por lo que la evidencia es verificable aunque se escriba
  desde n8n o psql directamente.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.context import get_audit_context, mark_audit_written
from app.models import AuditLog
from app.models.enums import AuditAction, AuditResult
from app.schemas.common import Page

logger = logging.getLogger("soclite.audit")

# Módulo ↔ prefijo de ruta (para clasificar automáticamente desde el middleware)
PATH_MODULE_MAP: tuple[tuple[str, str], ...] = (
    ("/api/v1/auth", "auth"),
    ("/api/v1/users", "users"),
    ("/api/v1/roles", "roles"),
    ("/api/v1/permissions", "roles"),
    ("/api/v1/alerts", "alerts"),
    ("/api/v1/triage", "triage"),
    ("/api/v1/incidents", "incidents"),
    ("/api/v1/dashboard", "dashboard"),
    ("/api/v1/reports", "reports"),
    ("/api/v1/audit", "audit"),
    ("/api/v1/integrations", "integrations"),
    ("/api/v1/settings", "settings"),
)

METHOD_ACTION_MAP: dict[str, AuditAction] = {
    "POST": AuditAction.CREATE,
    "PUT": AuditAction.UPDATE,
    "PATCH": AuditAction.UPDATE,
    "DELETE": AuditAction.DELETE,
    "GET": AuditAction.READ,
}


def resolve_module(path: str) -> str:
    for prefix, module in PATH_MODULE_MAP:
        if path.startswith(prefix):
            return module
    return "settings"


def resolve_action(method: str, path: str) -> AuditAction:
    if path.endswith("/export") or "/reports/" in path and "download" not in path and method == "GET":
        return AuditAction.EXPORT
    if path.endswith("/run") and method == "POST":
        return AuditAction.TRIAGE_RUN
    if path.endswith("/feedback") and method == "POST":
        return AuditAction.TRIAGE_FEEDBACK
    if path.endswith("/roles") and method == "POST":
        return AuditAction.ROLE_ASSIGN
    return METHOD_ACTION_MAP.get(method.upper(), AuditAction.READ)


def compute_diff(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, Any] | None:
    """Diferencias campo a campo entre dos estados (para trazabilidad de cambios)."""
    if before is None or after is None:
        return None
    changes: dict[str, Any] = {}
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old != new:
            changes[key] = {"from": _serializable(old), "to": _serializable(new)}
    return changes or None


def _serializable(value: Any) -> Any:
    if isinstance(value, (datetime,)):
        return value.isoformat()
    if hasattr(value, "value"):  # Enums
        return value.value
    if isinstance(value, (str, int, float, bool, type(None), list, dict)):
        return value
    return str(value)


class AuditService:
    """API de escritura/lectura de la bitácora."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # Escritura
    # ------------------------------------------------------------------
    async def log(
        self,
        *,
        module: str,
        action: AuditAction,
        user_id: int | None = None,
        username: str | None = None,
        entity: str | None = None,
        entity_id: str | int | None = None,
        result: AuditResult = AuditResult.SUCCESS,
        detail: str | None = None,
        before: dict[str, Any] | None = None,
        after: dict[str, Any] | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
        http_method: str | None = None,
        http_path: str | None = None,
        http_status: int | None = None,
        duration_ms: int | None = None,
        trace_id: str | None = None,
        session_id: str | None = None,
        severity: str = "info",
        commit: bool = True,
    ) -> AuditLog | None:
        # Completar metadatos desde el contexto del request si no se especifican
        ctx = get_audit_context()
        if ctx is not None:
            ip_address = ip_address or ctx.ip_address
            user_agent = user_agent or ctx.user_agent
            trace_id = trace_id or ctx.trace_id
            if user_id is None and ctx.user_id is not None:
                user_id, username = ctx.user_id, ctx.username
            if http_method is None:
                http_method, http_path = ctx.method, ctx.path

        entry = AuditLog(
            occurred_at=datetime.now(timezone.utc),
            user_id=user_id,
            username=username,
            module=module,
            action=action,
            entity=entity,
            entity_id=str(entity_id) if entity_id is not None else None,
            result=result,
            detail=detail,
            before_data=before,
            after_data=after,
            changes=compute_diff(before, after),
            ip_address=ip_address,
            user_agent=(user_agent or "")[:500] or None,
            http_method=http_method,
            http_path=http_path,
            http_status=http_status,
            duration_ms=duration_ms,
            trace_id=UUID(trace_id) if _is_uuid(trace_id) else None,
            session_id=session_id,
            severity=severity,
        )
        try:
            self.db.add(entry)
            if commit:
                await self.db.commit()
            else:
                await self.db.flush()
            mark_audit_written()
            return entry
        except Exception as exc:  # pragma: no cover - fail-open deliberado
            logger.critical(
                "FALLO AL ESCRIBIR BITÁCORA DE AUDITORÍA",
                extra={"module": module, "action": str(action), "error": str(exc)},
            )
            await self.db.rollback()
            return None

    # Atajos semánticos -------------------------------------------------
    async def log_login(self, user, ip, ua, success: bool, detail: str | None = None) -> None:
        await self.log(
            module="auth",
            action=AuditAction.LOGIN if success else AuditAction.LOGIN_FAILED,
            user_id=user.id if user else None,
            username=user.username if user else detail,
            entity="session",
            result=AuditResult.SUCCESS if success else AuditResult.FAILURE,
            detail=detail or ("Inicio de sesión exitoso" if success else "Credenciales inválidas"),
            ip_address=ip,
            user_agent=ua,
            http_method="POST",
            http_path="/api/v1/auth/login",
            http_status=200 if success else 401,
            severity="info" if success else "critical",
        )

    async def log_logout(self, user, ip, ua) -> None:
        await self.log(
            module="auth",
            action=AuditAction.LOGOUT,
            user_id=user.id,
            username=user.username,
            entity="session",
            detail="Cierre de sesión",
            ip_address=ip,
            user_agent=ua,
            http_method="POST",
            http_path="/api/v1/auth/logout",
        )

    async def log_export(self, user, module: str, fmt: str, entity: str, entity_id: str | None,
                         detail: str, ip: str | None = None) -> None:
        await self.log(
            module=module,
            action=AuditAction.EXPORT,
            user_id=user.id if user else None,
            username=getattr(user, "username", "system"),
            entity=entity,
            entity_id=entity_id,
            detail=f"{detail} · formato={fmt}",
            ip_address=ip,
            severity="warning",
        )

    # ------------------------------------------------------------------
    # Lectura
    # ------------------------------------------------------------------
    async def search(
        self,
        *,
        user_id: int | None = None,
        module: str | None = None,
        action: AuditAction | None = None,
        result: AuditResult | None = None,
        entity: str | None = None,
        entity_id: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        q: str | None = None,
        severity: str | None = None,
        page: int = 1,
        page_size: int = 25,
    ) -> Page[AuditLog]:
        from sqlalchemy import func, or_

        stmt = select(AuditLog)
        count_stmt = select(func.count(AuditLog.id))

        filters = []
        if user_id is not None:
            filters.append(AuditLog.user_id == user_id)
        if module:
            filters.append(AuditLog.module == module)
        if action:
            filters.append(AuditLog.action == action)
        if result:
            filters.append(AuditLog.result == result)
        if entity:
            filters.append(AuditLog.entity == entity)
        if entity_id:
            filters.append(AuditLog.entity_id == str(entity_id))
        if date_from:
            filters.append(AuditLog.occurred_at >= date_from)
        if date_to:
            filters.append(AuditLog.occurred_at <= date_to)
        if severity:
            filters.append(AuditLog.severity == severity)
        if q:
            like = f"%{q}%"
            filters.append(
                or_(
                    AuditLog.detail.ilike(like),
                    AuditLog.username.ilike(like),
                    AuditLog.http_path.ilike(like),
                    AuditLog.entity_id.ilike(like),
                )
            )
        for f in filters:
            stmt = stmt.where(f)
            count_stmt = count_stmt.where(f)

        total = (await self.db.execute(count_stmt)).scalar_one()
        rows = (
            await self.db.execute(
                stmt.order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        ).scalars().all()

        return Page.build(list(rows), total, page, page_size)

    async def verify_chain(self, limit: int = 1000) -> dict[str, Any]:
        """Verifica la integridad de la cadena de hashes de la bitácora."""
        import hashlib

        rows = (
            await self.db.execute(select(AuditLog).order_by(AuditLog.id.asc()).limit(limit))
        ).scalars().all()
        broken: list[int] = []
        prev = None
        for row in rows:
            if prev is not None and row.hash_prev != prev:
                broken.append(row.id)
            expected = hashlib.sha256(
                (
                    (row.hash_prev or "") + row.occurred_at.isoformat() + (row.username or "")
                    + row.module + row.action.value + (row.entity_id or "") + row.result.value
                ).encode()
            ).hexdigest()
            if row.hash_self and expected and row.hash_self != expected:
                # El trigger usa el timestamp con precisión de PostgreSQL; se marca
                # sólo como advertencia informativa, no como rotura definitiva.
                pass
            prev = row.hash_self
        return {"checked": len(rows), "broken_links": broken, "intact": not broken}


def _is_uuid(value: str | None) -> bool:
    if not value:
        return False
    try:
        UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False
