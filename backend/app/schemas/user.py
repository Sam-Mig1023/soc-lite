"""SOC-Lite · Esquemas Pydantic: autenticación y usuarios/roles."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, IPvAnyAddress, field_validator

from app.core.config import settings
from app.schemas.common import ORMModel


# ----------------------------------------------------------------------
# Auth
# ----------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=64)
    password: str = Field(..., min_length=1)
    totp_code: str | None = Field(None, min_length=6, max_length=6)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserProfile(ORMModel):
    id: int
    username: str
    # Seed/demo accounts use internal .local addresses, which EmailStr rejects
    # as reserved domains even though they are valid stored profile values.
    email: str
    full_name: str
    department: str | None = None
    phone: str | None = None
    is_active: bool
    mfa_enabled: bool
    roles: list[str] = Field(default_factory=list)
    permissions: list[str] = Field(default_factory=list)
    last_login_at: datetime | None = None


class LoginResponse(TokenPair):
    user: UserProfile


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)

    @field_validator("new_password")
    @classmethod
    def _strength(cls, v: str) -> str:
        from app.core.security import validate_password_strength

        ok, errors = validate_password_strength(v)
        if not ok:
            raise ValueError("; ".join(errors))
        return v


# ----------------------------------------------------------------------
# Usuarios
# ----------------------------------------------------------------------
class UserBase(BaseModel):
    username: str = Field(..., min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9._-]+$")
    email: EmailStr
    full_name: str = Field(..., min_length=3, max_length=160)
    department: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=32)


class UserCreate(UserBase):
    password: str = Field(..., min_length=8)
    roles: list[str] = Field(default_factory=lambda: ["viewer"])
    must_change_pwd: bool = True

    @field_validator("password")
    @classmethod
    def _strength(cls, v: str) -> str:
        from app.core.security import validate_password_strength

        ok, errors = validate_password_strength(v)
        if not ok:
            raise ValueError("; ".join(errors))
        return v


class UserUpdate(BaseModel):
    email: EmailStr | None = None
    full_name: str | None = Field(None, min_length=3, max_length=160)
    department: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=32)
    is_active: bool | None = None
    mfa_enabled: bool | None = None


class UserRead(ORMModel):
    id: int
    username: str
    email: str
    full_name: str
    department: str | None = None
    phone: str | None = None
    is_active: bool
    mfa_enabled: bool
    must_change_pwd: bool
    last_login_at: datetime | None = None
    last_login_ip: IPvAnyAddress | None = None
    locked_until: datetime | None = None
    roles: list[str] = Field(default_factory=list)
    created_at: datetime

    @field_validator("roles", mode="before")
    @classmethod
    def _roles_to_codes(cls, v):  # noqa: ANN001
        if v and hasattr(v[0], "code"):
            return [r.code for r in v]
        return v or []


class UserRolesUpdate(BaseModel):
    roles: list[str] = Field(..., min_length=1)


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=8)
    must_change_pwd: bool = True


# ----------------------------------------------------------------------
# Roles y permisos
# ----------------------------------------------------------------------
class PermissionRead(ORMModel):
    id: int
    code: str
    module: str
    action: str
    description: str | None = None


class PermissionGroup(BaseModel):
    module: str
    permissions: list[PermissionRead]


class RoleBase(BaseModel):
    code: str = Field(..., min_length=2, max_length=48, pattern=r"^[a-z0-9_]+$")
    name: str = Field(..., min_length=2, max_length=96)
    description: str | None = None


class RoleCreate(RoleBase):
    permissions: list[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=96)
    description: str | None = None
    permissions: list[str] | None = None


class RoleRead(ORMModel):
    id: int
    code: str
    name: str
    description: str | None = None
    is_system: bool
    permissions: list[str] = Field(default_factory=list)
    user_count: int = 0

    @field_validator("permissions", mode="before")
    @classmethod
    def _perms_to_codes(cls, v):  # noqa: ANN001
        if v and hasattr(v[0], "code"):
            return [p.code for p in v]
        return v or []
