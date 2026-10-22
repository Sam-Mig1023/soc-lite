"""SOC-Lite · Aplicación FastAPI principal.

Punto de entrada del backend. Ensambla:
  * middleware (CORS, cabeceras de seguridad, bitácora de auditoría),
  * manejadores de error uniformes,
  * routers de la API v1,
  * endpoints de observabilidad (health, readiness, métricas Prometheus).

Ejecución en desarrollo:  uvicorn app.main:app --reload --port 8000
Ejecución en producción:  gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import configure_logging
from app.db.session import check_database_health, engine
from app.middleware.audit_middleware import AuditMiddleware, SecurityHeadersMiddleware

logger = logging.getLogger("soclite")

DESCRIPTION = """
**SOC-Lite** — Triaje automático de alertas SOC con orquestación low-code (n8n) y
razonamiento LLM (LangChain + Ollama local).

*Reduce la fatiga de alertas priorizando y enriqueciendo los eventos del SIEM
(Wazuh/OPNsense) mediante un agente LLM con herramientas de inteligencia de amenazas.*

**Cumplimiento:** ISO/IEC 27001:2022 (A.8.15, A.8.16, A.5.24, A.5.28) · NIST CSF 2.0 (DE.AE, RS.AN, RS.MA).

**Trazabilidad:** toda operación sobre usuarios, roles, alertas, triaje, incidentes,
dashboard, reportes y auditoría queda registrada en la bitácora con usuario, fecha,
hora, módulo, acción y resultado, encadenada con hash sha256.
"""

TAGS_METADATA = [
    {"name": "Autenticación", "description": "Login, refresh, logout, perfil y cambio de contraseña."},
    {"name": "Usuarios", "description": "CRUD de usuarios y asignación de roles."},
    {"name": "Roles y permisos", "description": "RBAC: roles, permisos y matriz de acceso."},
    {"name": "Alertas", "description": "Ingesta (webhook Wazuh/OPNsense), consulta, actualización y timeline."},
    {"name": "Triaje automático", "description": "Ejecución del agente LangChain, resultados, feedback y precisión."},
    {"name": "Incidentes", "description": "Gestión de incidentes y acciones de respuesta."},
    {"name": "Dashboard", "description": "KPIs, MTTT, top orígenes, tasa de falsos positivos y SLA."},
    {"name": "Reportes", "description": "Reportes operativos, gerenciales y de auditoría en PDF, Word y Excel."},
    {"name": "Bitácora de auditoría", "description": "Consulta, estadísticas, verificación de integridad y exportación."},
    {"name": "Salud", "description": "Liveness y readiness probes."},
]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    logger.info(
        "Iniciando %s v%s en entorno %s", settings.APP_NAME, settings.APP_VERSION, settings.ENVIRONMENT
    )
    db = await check_database_health()
    if db.get("status") != "ok":
        logger.error("PostgreSQL no disponible al arrancar: %s", db)
    else:
        logger.info("PostgreSQL conectado (%s)", db.get("version"))

    if settings.ALLOW_EXTERNAL_LLM:
        logger.warning(
            "ALLOW_EXTERNAL_LLM=true: los datos de las alertas podrían salir de la infraestructura. "
            "Verifique la política de tratamiento de datos antes de habilitarlo en producción."
        )
    yield
    await engine.dispose()
    logger.info("Aplicación detenida y pool de conexiones liberado")


app = FastAPI(
    title=f"{settings.APP_NAME} API",
    description=DESCRIPTION,
    version=settings.APP_VERSION,
    openapi_tags=TAGS_METADATA,
    default_response_class=ORJSONResponse,
    docs_url="/docs" if settings.ENVIRONMENT != "production" else None,
    redoc_url="/redoc" if settings.ENVIRONMENT != "production" else None,
    openapi_url="/openapi.json" if settings.ENVIRONMENT != "production" else None,
    lifespan=lifespan,
    contact={"name": "Equipo SOC-Lite", "email": "soc@org.local"},
    license_info={"name": "Uso interno"},
)

# ----------------------------------------------------------------------
# Middleware (el orden de registro es inverso al de ejecución:
# el último registrado es el más externo)
# ----------------------------------------------------------------------
app.add_middleware(AuditMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Ingest-Key", "X-Source-Type",
                   "Idempotency-Key", "X-Service-Token", "X-Trace-Id"],
    expose_headers=["X-Trace-Id", "X-Report-Id", "X-Report-Checksum",
                    "Content-Disposition", "X-Required-Permissions"],
    max_age=600,
)

register_exception_handlers(app)

# ----------------------------------------------------------------------
# Rutas
# ----------------------------------------------------------------------
app.include_router(api_router, prefix=settings.API_V1_PREFIX)


@app.get("/", tags=["Salud"], summary="Información del servicio")
async def root() -> dict:
    return {
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "environment": settings.ENVIRONMENT,
        "docs": "/docs" if settings.ENVIRONMENT != "production" else None,
        "api": settings.API_V1_PREFIX,
        "modules": ["auth", "users", "roles", "alerts", "triage", "incidents",
                    "dashboard", "reports", "audit", "settings"],
    }


@app.get("/metrics", include_in_schema=False)
async def metrics():
    """Métricas Prometheus (puerto interno; no publicar a Internet)."""
    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
    from starlette.responses import Response

    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post(f"{settings.API_V1_PREFIX}/webhooks/wazuh", tags=["Alertas"], include_in_schema=False)
async def wazuh_webhook_alias(request: Request, auto_triage: bool = True):
    """Alias del endpoint de ingesta para simplificar la configuración en n8n/Wazuh."""
    from app.api.deps import require_ingest_key
    from app.db.session import AsyncSessionLocal
    from app.api.v1.routers.alerts import ingest_alert

    require_ingest_key(request)
    payload = await request.json()
    async with AsyncSessionLocal() as session:
        from fastapi import BackgroundTasks

        return await ingest_alert(
            request=request,
            db=session,
            background=BackgroundTasks(),
            payload=payload,
            auto_triage=auto_triage,
            x_source_type=request.headers.get("X-Source-Type", "wazuh"),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )


# Documentación estática de esquemas (opcional en producción)
try:
    app.mount("/static", StaticFiles(directory="storage", check_dir=False), name="static")
except Exception:  # pragma: no cover
    pass
