"""SOC-Lite · Router de autenticación (login, refresh, logout, perfil).

Cada operación de entrada/salida queda registrada en la bitácora de auditoría
con módulo `auth`, usuario, fecha/hora, acción y resultado.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select

from app.api.deps import AuthenticatedUser, DbSession
from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    hash_token,
    validate_password_strength,
    verify_password,
)
from app.models import RefreshToken, User
from app.models.enums import AuditAction, AuditResult
from app.schemas.user import (
    ChangePasswordRequest,
    LoginResponse,
    RefreshRequest,
    TokenPair,
    UserProfile,
)
from app.schemas.common import MessageResponse
from app.services.audit_service import AuditService

router = APIRouter(prefix="/auth", tags=["Autenticación"])


def _profile(user: User) -> UserProfile:
    return UserProfile(
        id=user.id,
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        department=user.department,
        phone=user.phone,
        is_active=user.is_active,
        mfa_enabled=user.mfa_enabled,
        roles=user.role_codes,
        permissions=user.permissions,
        last_login_at=user.last_login_at,
    )


@router.post("/login", response_model=LoginResponse, summary="Inicio de sesión (OAuth2 password flow)")
async def login(
    request: Request,
    db: DbSession,
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
) -> LoginResponse:
    audit = AuditService(db)
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else None)
    ua = request.headers.get("user-agent")

    user = (
        await db.execute(
            select(User).where(
                (User.username == form_data.username) | (User.email == form_data.username),
                User.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()

    # Usuario inexistente
    if user is None:
        await audit.log_login(None, ip, ua, success=False, detail=f"Usuario inexistente: {form_data.username}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario o contraseña incorrectos")

    # Bloqueo temporal por intentos fallidos (anti fuerza bruta)
    if user.is_locked:
        await audit.log(
            module="auth", action=AuditAction.LOGIN_FAILED, user_id=user.id, username=user.username,
            entity="session", result=AuditResult.DENIED, detail="Cuenta bloqueada temporalmente",
            ip_address=ip, user_agent=ua, severity="critical",
        )
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail=f"Cuenta bloqueada temporalmente hasta {user.locked_until:%Y-%m-%d %H:%M:%S} UTC",
        )

    if not user.is_active:
        await audit.log(
            module="auth", action=AuditAction.LOGIN_FAILED, user_id=user.id, username=user.username,
            entity="session", result=AuditResult.DENIED, detail="Usuario desactivado",
            ip_address=ip, user_agent=ua, severity="warning",
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Usuario desactivado")

    if not verify_password(form_data.password, user.hashed_password):
        user.failed_attempts = (user.failed_attempts or 0) + 1
        if user.failed_attempts >= settings.MAX_LOGIN_ATTEMPTS:
            user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=settings.LOCKOUT_MINUTES)
            user.failed_attempts = 0
        await db.flush()
        await audit.log_login(
            user, ip, ua, success=False,
            detail=f"Contraseña incorrecta (intento {user.failed_attempts}/{settings.MAX_LOGIN_ATTEMPTS})",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario o contraseña incorrectos")

    # MFA opcional (TOTP)
    if user.mfa_enabled:
        if not form_data.client_secret:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Se requiere código MFA (campo client_secret)")
        import pyotp

        if not pyotp.TOTP(user.mfa_secret or "").verify(form_data.client_secret, valid_window=1):
            await audit.log_login(user, ip, ua, success=False, detail="Código MFA inválido")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Código MFA inválido")

    # Login correcto
    user.failed_attempts = 0
    user.locked_until = None
    user.last_login_at = datetime.now(timezone.utc)
    user.last_login_ip = ip
    await db.flush()

    access = create_access_token(user.id, user.username, user.role_codes, user.permissions)
    refresh = create_refresh_token(user.id, user.username)
    payload = decode_token(refresh)

    db.add(
        RefreshToken(
            user_id=user.id,
            jti=payload["jti"],
            token_hash=hash_token(refresh),
            expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
            ip_address=ip,
            user_agent=(ua or "")[:500],
        )
    )
    await db.flush()
    await audit.log_login(user, ip, ua, success=True)

    return LoginResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=_profile(user),
    )


@router.post("/refresh", response_model=TokenPair, summary="Renovar token de acceso")
async def refresh_token(payload: RefreshRequest, request: Request, db: DbSession) -> TokenPair:
    try:
        data = decode_token(payload.refresh_token)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token inválido o expirado") from exc

    if data.get("typ") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Tipo de token incorrecto")

    stored = (
        await db.execute(
            select(RefreshToken).where(
                RefreshToken.jti == data["jti"],
                RefreshToken.revoked_at.is_(None),
                RefreshToken.token_hash == hash_token(payload.refresh_token),
            )
        )
    ).scalar_one_or_none()
    if stored is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revocado o desconocido")

    user = (await db.execute(select(User).where(User.id == int(data["sub"]), User.deleted_at.is_(None)))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no válido")

    # Rotación de refresh token (detección de reutilización)
    stored.revoked_at = datetime.now(timezone.utc)
    new_refresh = create_refresh_token(user.id, user.username)
    new_payload = decode_token(new_refresh)
    db.add(
        RefreshToken(
            user_id=user.id,
            jti=new_payload["jti"],
            token_hash=hash_token(new_refresh),
            expires_at=datetime.fromtimestamp(new_payload["exp"], tz=timezone.utc),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    await db.flush()

    return TokenPair(
        access_token=create_access_token(user.id, user.username, user.role_codes, user.permissions),
        refresh_token=new_refresh,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/logout", response_model=MessageResponse, summary="Cerrar sesión")
async def logout(current: AuthenticatedUser, db: DbSession, payload: RefreshRequest | None = None) -> MessageResponse:
    if payload and payload.refresh_token:
        try:
            data = decode_token(payload.refresh_token)
            stored = (
                await db.execute(select(RefreshToken).where(RefreshToken.jti == data["jti"]))
            ).scalar_one_or_none()
            if stored:
                stored.revoked_at = datetime.now(timezone.utc)
        except Exception:  # token ya inválido: el logout se completa igualmente
            pass
    else:
        # Revocar todas las sesiones activas del usuario
        tokens = (
            await db.execute(
                select(RefreshToken).where(RefreshToken.user_id == current.id, RefreshToken.revoked_at.is_(None))
            )
        ).scalars().all()
        for t in tokens:
            t.revoked_at = datetime.now(timezone.utc)
    await db.flush()

    await AuditService(db).log_logout(current.user, current.ip_address, current.user_agent)
    return MessageResponse(message="Sesión cerrada correctamente")


@router.get("/me", response_model=UserProfile, summary="Perfil del usuario autenticado")
async def me(current: AuthenticatedUser, db: DbSession) -> UserProfile:
    await AuditService(db).log(
        module="auth", action=AuditAction.READ, user_id=current.id, username=current.username,
        entity="user", entity_id=current.id, detail="Consulta de perfil propio",
        ip_address=current.ip_address, user_agent=current.user_agent,
        http_method="GET", http_path="/api/v1/auth/me", http_status=200,
    )
    return _profile(current.user)


@router.post("/change-password", response_model=MessageResponse, summary="Cambiar contraseña")
async def change_password(body: ChangePasswordRequest, current: AuthenticatedUser, db: DbSession) -> MessageResponse:
    if not verify_password(body.current_password, current.user.hashed_password):
        await AuditService(db).log(
            module="auth", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
            entity="user", entity_id=current.id, result=AuditResult.FAILURE,
            detail="Cambio de contraseña fallido: contraseña actual incorrecta",
            ip_address=current.ip_address, severity="warning",
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="La contraseña actual es incorrecta")

    ok, errors = validate_password_strength(body.new_password)
    if not ok:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=errors)

    current.user.hashed_password = hash_password(body.new_password)
    current.user.must_change_pwd = False
    await db.flush()
    await AuditService(db).log(
        module="auth", action=AuditAction.UPDATE, user_id=current.id, username=current.username,
        entity="user", entity_id=current.id, detail="Contraseña actualizada por el propio usuario",
        ip_address=current.ip_address, after={"password_changed": True},
    )
    return MessageResponse(message="Contraseña actualizada correctamente")
