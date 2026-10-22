"""SOC-Lite · Router de roles y permisos (RBAC)."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, RoleReader, RoleWriter, require_permissions
from app.models import Permission, Role, User, role_permissions, user_roles
from app.models.enums import AuditAction
from app.schemas.common import MessageResponse
from app.schemas.user import (
    PermissionGroup,
    PermissionRead,
    RoleCreate,
    RoleRead,
    RoleUpdate,
)
from app.services.audit_service import AuditService

router = APIRouter(tags=["Roles y permisos"])


def _role_read(role: Role, user_count: int = 0) -> RoleRead:
    return RoleRead(
        id=role.id,
        code=role.code,
        name=role.name,
        description=role.description,
        is_system=role.is_system,
        permissions=[p.code for p in role.permissions],
        user_count=user_count,
    )


async def _user_counts(db: DbSession) -> dict[int, int]:
    rows = (await db.execute(select(user_roles.c.role_id, func.count(user_roles.c.user_id)).group_by(user_roles.c.role_id))).all()
    return {rid: n for rid, n in rows}


async def _resolve_permissions(db: DbSession, codes: list[str]) -> list[Permission]:
    perms = (await db.execute(select(Permission).where(Permission.code.in_(codes)))).scalars().all()
    missing = set(codes) - {p.code for p in perms}
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Permisos inexistentes: {', '.join(sorted(missing))}",
        )
    return list(perms)


@router.get("/roles", response_model=list[RoleRead], summary="Listar roles")
async def list_roles(db: DbSession, current: RoleReader) -> list[RoleRead]:
    roles = (await db.execute(select(Role).options(selectinload(Role.permissions)).order_by(Role.id))).scalars().all()
    counts = await _user_counts(db)
    await AuditService(db).log(
        module="roles", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="role", detail=f"Listado de roles ({len(roles)})", ip_address=current.ip_address,
        http_method="GET", http_path="/api/v1/roles", http_status=200,
    )
    return [_role_read(r, counts.get(r.id, 0)) for r in roles]


@router.post("/roles", response_model=RoleRead, status_code=status.HTTP_201_CREATED, summary="Crear rol")
async def create_role(body: RoleCreate, db: DbSession, current: RoleWriter) -> RoleRead:
    exists = (await db.execute(select(Role.id).where(Role.code == body.code))).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="El código de rol ya existe")

    role = Role(code=body.code, name=body.name, description=body.description, is_system=False)
    if body.permissions:
        role.permissions = await _resolve_permissions(db, body.permissions)
    db.add(role)
    await db.flush()

    await AuditService(db).log(
        module="roles", action=AuditAction.CREATE, user_id=current.id, username=current.username,
        entity="role", entity_id=role.id, detail=f"Alta de rol {role.code}",
        after={"code": role.code, "permissions": body.permissions},
        ip_address=current.ip_address, severity="warning",
    )
    return _role_read(role)


@router.put("/roles/{role_id}", response_model=RoleRead, summary="Actualizar rol y sus permisos")
async def update_role(role_id: int, body: RoleUpdate, db: DbSession, current: RoleWriter) -> RoleRead:
    role = (
        await db.execute(select(Role).options(selectinload(Role.permissions)).where(Role.id == role_id))
    ).scalar_one_or_none()
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rol no encontrado")
    if role.code == "admin" and body.permissions is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El rol admin conserva todos los permisos por diseño (control de continuidad)",
        )

    before = {"name": role.name, "description": role.description, "permissions": [p.code for p in role.permissions]}
    if body.name is not None:
        role.name = body.name
    if body.description is not None:
        role.description = body.description
    if body.permissions is not None:
        role.permissions = await _resolve_permissions(db, body.permissions)
    await db.flush()

    await AuditService(db).log(
        module="roles", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="role", entity_id=role_id, detail=f"Actualización del rol {role.code}",
        before=before,
        after={"name": role.name, "description": role.description, "permissions": [p.code for p in role.permissions]},
        ip_address=current.ip_address, severity="critical",
    )
    counts = await _user_counts(db)
    return _role_read(role, counts.get(role.id, 0))


@router.delete("/roles/{role_id}", response_model=MessageResponse, summary="Eliminar rol")
async def delete_role(
    role_id: int,
    db: DbSession,
    current: Annotated[CurrentUser, Depends(require_permissions("roles:delete"))],
) -> MessageResponse:
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rol no encontrado")
    if role.is_system:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No es posible eliminar un rol de sistema")

    assigned = (await db.execute(select(func.count(user_roles.c.user_id)).where(user_roles.c.role_id == role_id))).scalar_one()
    if assigned:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"El rol tiene {assigned} usuario(s) asignado(s); reasígnelos antes de eliminar",
        )

    code = role.code
    await db.delete(role)
    await db.flush()
    await AuditService(db).log(
        module="roles", action=AuditAction.DELETE, user_id=current.id, username=current.username,
        entity="role", entity_id=role_id, detail=f"Eliminación del rol {code}",
        before={"code": code}, ip_address=current.ip_address,
        http_method="DELETE", http_path=f"/api/v1/roles/{role_id}", http_status=200, severity="critical",
    )
    return MessageResponse(message=f"Rol {code} eliminado")


@router.get("/permissions", response_model=list[PermissionGroup], summary="Catálogo de permisos por módulo")
async def list_permissions(db: DbSession, current: RoleReader) -> list[PermissionGroup]:
    perms = (await db.execute(select(Permission).order_by(Permission.module, Permission.action))).scalars().all()
    grouped: dict[str, list[PermissionRead]] = {}
    for p in perms:
        grouped.setdefault(p.module, []).append(PermissionRead.model_validate(p))
    await AuditService(db).log(
        module="roles", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="permission", detail=f"Consulta del catálogo de permisos ({len(perms)})",
        ip_address=current.ip_address, http_method="GET", http_path="/api/v1/permissions", http_status=200,
    )
    return [PermissionGroup(module=m, permissions=ps) for m, ps in sorted(grouped.items())]
