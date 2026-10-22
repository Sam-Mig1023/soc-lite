"""SOC-Lite · Router de usuarios (CRUD + asignación de roles) con RBAC y auditoría."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, UserReader, UserWriter, require_permissions
from app.core.security import hash_password
from app.models import Role, User, user_roles
from app.models.enums import AuditAction, AuditResult
from app.schemas.common import BulkResult, MessageResponse, Page
from app.schemas.user import (
    ResetPasswordRequest,
    UserCreate,
    UserRead,
    UserRolesUpdate,
    UserUpdate,
)
from app.services.audit_service import AuditService

router = APIRouter(prefix="/users", tags=["Usuarios"])


async def _get_user_or_404(db: DbSession, user_id: int) -> User:
    user = (
        await db.execute(
            select(User).options(selectinload(User.roles).selectinload(Role.permissions)).where(
                User.id == user_id, User.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado")
    return user


async def _resolve_roles(db: DbSession, codes: list[str]) -> list[Role]:
    roles = (await db.execute(select(Role).where(Role.code.in_(codes)))).scalars().all()
    found = {r.code for r in roles}
    missing = set(codes) - found
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Roles inexistentes: {', '.join(sorted(missing))}",
        )
    return list(roles)


@router.get("", response_model=Page[UserRead], summary="Listar usuarios")
async def list_users(
    db: DbSession,
    current: UserReader,
    q: str | None = Query(None, description="Búsqueda por usuario, nombre o email"),
    is_active: bool | None = None,
    role: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> Page[UserRead]:
    stmt = select(User).where(User.deleted_at.is_(None))
    count_stmt = select(func.count(User.id)).where(User.deleted_at.is_(None))

    if q:
        like = f"%{q}%"
        cond = or_(User.username.ilike(like), User.full_name.ilike(like), User.email.ilike(like))
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    if is_active is not None:
        stmt = stmt.where(User.is_active.is_(is_active))
        count_stmt = count_stmt.where(User.is_active.is_(is_active))
    if role:
        stmt = stmt.join(user_roles, user_roles.c.user_id == User.id).join(Role, Role.id == user_roles.c.role_id).where(Role.code == role)
        count_stmt = count_stmt.join(user_roles, user_roles.c.user_id == User.id).join(Role, Role.id == user_roles.c.role_id).where(Role.code == role)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (
        await db.execute(
            stmt.options(selectinload(User.roles).selectinload(Role.permissions))
            .order_by(User.username)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    await AuditService(db).log(
        module="users", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="user", detail=f"Listado de usuarios (total={total})",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/users", http_status=200,
    )
    return Page.build([UserRead.model_validate(u) for u in rows], total, page, page_size)


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED, summary="Crear usuario")
async def create_user(body: UserCreate, db: DbSession, current: UserWriter) -> UserRead:
    exists = (
        await db.execute(select(User.id).where(or_(User.username == body.username, User.email == body.email)))
    ).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El usuario o email ya existe")

    roles = await _resolve_roles(db, body.roles)
    user = User(
        username=body.username,
        email=body.email,
        full_name=body.full_name,
        department=body.department,
        phone=body.phone,
        hashed_password=hash_password(body.password),
        must_change_pwd=body.must_change_pwd,
        is_active=True,
    )
    user.roles = roles
    db.add(user)
    await db.flush()

    await AuditService(db).log(
        module="users", action=AuditAction.CREATE, user_id=current.id, username=current.username,
        entity="user", entity_id=user.id, detail=f"Alta de usuario {user.username} con roles {body.roles}",
        after={"username": user.username, "email": user.email, "roles": body.roles, "is_active": True},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="POST", http_path="/api/v1/users", http_status=201, severity="warning",
    )
    return UserRead.model_validate(user)


@router.get("/{user_id}", response_model=UserRead, summary="Obtener usuario")
async def get_user(user_id: int, db: DbSession, current: UserReader) -> UserRead:
    user = await _get_user_or_404(db, user_id)
    await AuditService(db).log(
        module="users", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="user", entity_id=user_id, detail=f"Consulta del usuario {user.username}",
        ip_address=current.ip_address, user_agent=current.user_agent, http_method="GET",
        http_path=f"/api/v1/users/{user_id}", http_status=200,
    )
    return UserRead.model_validate(user)


@router.put("/{user_id}", response_model=UserRead, summary="Actualizar usuario")
async def update_user(user_id: int, body: UserUpdate, db: DbSession, current: UserWriter) -> UserRead:
    user = await _get_user_or_404(db, user_id)
    before = user.to_dict(exclude={"hashed_password"})

    if body.email and body.email != user.email:
        dup = (await db.execute(select(User.id).where(User.email == body.email, User.id != user_id))).scalar_one_or_none()
        if dup:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El email ya está en uso")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    if body.is_active is False and user.is_system:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No es posible desactivar una cuenta de sistema",
        )

    await db.flush()
    after = user.to_dict(exclude={"hashed_password"})

    await AuditService(db).log(
        module="users", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="user", entity_id=user_id, detail=f"Actualización del usuario {user.username}",
        before=before, after=after, ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="PUT", http_path=f"/api/v1/users/{user_id}", http_status=200, severity="warning",
    )
    return UserRead.model_validate(user)


@router.delete("/{user_id}", response_model=MessageResponse, summary="Desactivar usuario (baja lógica)")
async def delete_user(
    user_id: int,
    db: DbSession,
    current: Annotated[CurrentUser, Depends(require_permissions("users:delete"))],
) -> MessageResponse:
    user = await _get_user_or_404(db, user_id)
    if user.id == current.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No puede desactivar su propio usuario")
    if user.is_system:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No es posible desactivar una cuenta de sistema (protección de continuidad del SOC)",
        )

    before = user.to_dict(exclude={"hashed_password"})
    user.is_active = False
    user.deleted_at = datetime.now(timezone.utc)
    await db.flush()

    await AuditService(db).log(
        module="users", action=AuditAction.DELETE, user_id=current.id, username=current.username,
        entity="user", entity_id=user_id, detail=f"Baja lógica del usuario {user.username}",
        before=before, after={"is_active": False, "deleted_at": user.deleted_at.isoformat()},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="DELETE", http_path=f"/api/v1/users/{user_id}", http_status=200, severity="critical",
    )
    return MessageResponse(message=f"Usuario {user.username} desactivado")


@router.post("/{user_id}/roles", response_model=UserRead, summary="Asignar roles a un usuario")
async def assign_roles(user_id: int, body: UserRolesUpdate, db: DbSession, current: UserWriter) -> UserRead:
    user = await _get_user_or_404(db, user_id)
    before_roles = user.role_codes
    roles = await _resolve_roles(db, body.roles)

    if user.username == "admin" and "admin" not in body.roles:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No se puede retirar el rol admin al administrador del sistema")

    user.roles = roles
    await db.flush()

    await AuditService(db).log(
        module="users", action=AuditAction.ROLE_ASSIGN, user_id=current.id, username=current.username,
        entity="user", entity_id=user_id, detail=f"Asignación de roles a {user.username}",
        before={"roles": before_roles}, after={"roles": body.roles},
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="POST", http_path=f"/api/v1/users/{user_id}/roles", http_status=200, severity="warning",
    )
    return UserRead.model_validate(user)


@router.post("/{user_id}/reset-password", response_model=MessageResponse, summary="Restablecer contraseña (admin)")
async def reset_password(user_id: int, body: ResetPasswordRequest, db: DbSession, current: UserWriter) -> MessageResponse:
    user = await _get_user_or_404(db, user_id)
    user.hashed_password = hash_password(body.new_password)
    user.must_change_pwd = body.must_change_pwd
    user.failed_attempts = 0
    user.locked_until = None
    await db.flush()

    await AuditService(db).log(
        module="users", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="user", entity_id=user_id, detail=f"Restablecimiento de contraseña de {user.username} por administrador",
        ip_address=current.ip_address, user_agent=current.user_agent, severity="critical",
    )
    return MessageResponse(message="Contraseña restablecida; el usuario deberá cambiarla en el próximo inicio de sesión")
