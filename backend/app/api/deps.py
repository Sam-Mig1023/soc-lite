"""SOC-Lite · Dependencias FastAPI: autenticación, RBAC y contexto de request."""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.context import get_audit_context
from app.core.security import decode_token, has_permission, verify_ingest_key, verify_service_token
from app.db.session import get_db
from app.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_PREFIX}/auth/login", auto_error=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]


class CurrentUser:
    """Contexto del usuario autenticado (perfil + permisos + metadatos de request)."""

    def __init__(self, user: User, payload: dict[str, Any], request: Request) -> None:
        self.user = user
        self.payload = payload
        self.request = request
        self.id = user.id
        self.username = user.username
        self.permissions: list[str] = user.permissions
        self.roles: list[str] = user.role_codes

    @property
    def ip_address(self) -> str | None:
        fwd = self.request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return self.request.client.host if self.request.client else None

    @property
    def user_agent(self) -> str | None:
        return self.request.headers.get("user-agent")

    @property
    def trace_id(self) -> str | None:
        return getattr(self.request.state, "trace_id", None)

    def can(self, permission: str) -> bool:
        return has_permission(self.permissions, permission)


async def get_current_user(
    request: Request,
    db: DbSession,
    token: Annotated[str | None, Depends(oauth2_scheme)] = None,
) -> CurrentUser:
    """Valida el JWT y carga el usuario con sus roles/permisos."""
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Credenciales inválidas o expiradas",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_exc
    try:
        payload = decode_token(token)
    except JWTError as exc:
        raise credentials_exc from exc
    if payload.get("typ") != "access":
        raise credentials_exc

    user_id = payload.get("sub")
    if not user_id:
        raise credentials_exc

    user = (
        await db.execute(select(User).where(User.id == int(user_id), User.deleted_at.is_(None)))
    ).scalar_one_or_none()

    if user is None:
        raise credentials_exc
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Usuario desactivado")
    if user.is_locked:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Usuario bloqueado temporalmente")

    # Propagar identidad al contexto de auditoría del request
    ctx = get_audit_context()
    if ctx is not None:
        ctx.user_id = user.id
        ctx.username = user.username

    return CurrentUser(user, payload, request)


def require_permissions(*required: str) -> Callable[..., Any]:
    """Factoría de dependencias RBAC. Uso: `Depends(require_permissions("alerts:write"))`."""

    async def _checker(current: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        missing = [p for p in required if not current.can(p)]
        if missing:
            # El middleware de auditoría registra el intento denegado (result=denied)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permisos insuficientes. Requerido: {', '.join(missing)}",
                headers={"X-Required-Permissions": ",".join(required)},
            )
        return current

    return _checker


def require_any_permission(*required: str) -> Callable[..., Any]:
    async def _checker(current: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        if not any(current.can(p) for p in required):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Se requiere al menos uno de: {', '.join(required)}",
            )
        return current

    return _checker


def require_ingest_key(request: Request) -> None:
    """Protege el endpoint de ingesta usado por el webhook de n8n/Wazuh."""
    header = request.headers.get("x-ingest-key") or request.headers.get("authorization")
    if not verify_ingest_key(header):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Clave de ingesta inválida o ausente (header X-Ingest-Key)",
        )


def require_service_token(request: Request) -> None:
    """Protege endpoints internos invocados por n8n con token de servicio."""
    if not verify_service_token(request.headers.get("authorization") or request.headers.get("x-service-token")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token de servicio inválido")


def parse_page(page: int = 1, page_size: int = 25) -> tuple[int, int]:
    page = max(1, page)
    page_size = max(1, min(200, page_size))
    return page, page_size


# ----------------------------------------------------------------------
# Alias de dependencias frecuentes
# ----------------------------------------------------------------------
AuthenticatedUser = Annotated[CurrentUser, Depends(get_current_user)]
DashboardReader = Annotated[CurrentUser, Depends(require_permissions("dashboard:read"))]
AlertReader = Annotated[CurrentUser, Depends(require_permissions("alerts:read"))]
AlertWriter = Annotated[CurrentUser, Depends(require_permissions("alerts:write"))]
TriageReader = Annotated[CurrentUser, Depends(require_permissions("triage:read"))]
TriageRunner = Annotated[CurrentUser, Depends(require_permissions("triage:run"))]
IncidentReader = Annotated[CurrentUser, Depends(require_permissions("incidents:read"))]
IncidentWriter = Annotated[CurrentUser, Depends(require_permissions("incidents:write"))]
ReportReader = Annotated[CurrentUser, Depends(require_permissions("reports:read"))]
ReportExporter = Annotated[CurrentUser, Depends(require_permissions("reports:export"))]
UserReader = Annotated[CurrentUser, Depends(require_permissions("users:read"))]
UserWriter = Annotated[CurrentUser, Depends(require_permissions("users:write"))]
RoleReader = Annotated[CurrentUser, Depends(require_permissions("roles:read"))]
RoleWriter = Annotated[CurrentUser, Depends(require_permissions("roles:write"))]
AuditReader = Annotated[CurrentUser, Depends(require_permissions("audit:read"))]
AuditExporter = Annotated[CurrentUser, Depends(require_permissions("audit:export"))]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
