"""SOC-Lite · Seguridad: hashing de contraseñas, JWT y utilidades RBAC."""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from uuid import uuid4

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# bcrypt con factor de coste 12 (equilibrio seguridad/rendimiento, OWASP 2024)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)


# ----------------------------------------------------------------------
# Contraseñas
# ----------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError:
        return False


def validate_password_strength(password: str) -> tuple[bool, list[str]]:
    """Política de contraseñas (ISO 27001 A.5.17): longitud, complejidad, no comunes."""
    errors: list[str] = []
    if len(password) < settings.PASSWORD_MIN_LENGTH:
        errors.append(f"Debe tener al menos {settings.PASSWORD_MIN_LENGTH} caracteres")
    if not any(c.isupper() for c in password):
        errors.append("Debe incluir al menos una mayúscula")
    if not any(c.islower() for c in password):
        errors.append("Debe incluir al menos una minúscula")
    if not any(c.isdigit() for c in password):
        errors.append("Debe incluir al menos un dígito")
    if not any(c in "!@#$%^&*()-_=+[]{};:,.<>?/|~" for c in password):
        errors.append("Debe incluir al menos un carácter especial")
    common = {"password", "123456789012", "qwertyuiop12", "administrador", "soclite12345"}
    if password.lower() in common:
        errors.append("La contraseña es demasiado común")
    return (len(errors) == 0), errors


# ----------------------------------------------------------------------
# JWT
# ----------------------------------------------------------------------
def _create_token(subject: str, expires_minutes: int, token_type: str, **extra: Any) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "iat": int(now.timestamp()),
        "nbf": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=expires_minutes)).timestamp()),
        # refresh_tokens.jti is PostgreSQL UUID; keep the JWT claim compatible.
        "jti": str(uuid4()),
        "typ": token_type,
        "iss": settings.APP_NAME,
        **extra,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_access_token(user_id: int, username: str, roles: list[str], permissions: list[str]) -> str:
    return _create_token(
        str(user_id),
        settings.ACCESS_TOKEN_EXPIRE_MINUTES,
        "access",
        username=username,
        roles=roles,
        permissions=permissions,
    )


def create_refresh_token(user_id: int, username: str) -> str:
    return _create_token(str(user_id), settings.REFRESH_TOKEN_EXPIRE_MINUTES, "refresh", username=username)


def decode_token(token: str) -> dict[str, Any]:
    """Decodifica y valida un JWT. Lanza JWTError si es inválido o expirado."""
    return jwt.decode(
        token,
        settings.SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
        issuer=settings.APP_NAME,
    )


def hash_token(token: str) -> str:
    """Hash determinista para almacenar refresh tokens (nunca en claro)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------------
# RBAC
# ----------------------------------------------------------------------
def has_permission(granted: Iterable[str], required: str) -> bool:
    granted_set = set(granted)
    if "*" in granted_set or "admin:all" in granted_set:
        return True
    if required in granted_set:
        return True
    # Comodín de módulo: "alerts:*" cubre "alerts:read"
    module = required.split(":", 1)[0]
    return f"{module}:*" in granted_set


def has_any_permission(granted: Iterable[str], required: Iterable[str]) -> bool:
    return any(has_permission(granted, r) for r in required)


# ----------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------
def compute_fingerprint(*parts: Any) -> str:
    """Fingerprint sha256 para deduplicación de alertas (idempotencia)."""
    raw = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def verify_ingest_key(header_value: str | None) -> bool:
    """Comparación en tiempo constante de la clave de ingesta del webhook."""
    if not header_value:
        return False
    return hmac.compare_digest(header_value, settings.INGEST_API_KEY)


def verify_service_token(header_value: str | None) -> bool:
    if not header_value:
        return False
    token = header_value.removeprefix("Bearer ").strip()
    return hmac.compare_digest(token, settings.INTERNAL_SERVICE_TOKEN)


def calculate_risk_score(
    severity: str,
    rule_level: int | None,
    asset_criticality: str | None,
    ti_score: float | None = None,
    llm_confidence: float | None = None,
) -> int:
    """Score de riesgo 0-100 ponderado (heurística explicable, auditable).

    Pesos: severidad 35% · nivel regla 20% · criticidad activo 20% ·
           reputación TI 15% · confianza LLM 10%
    """
    base = {"critical": 100, "high": 80, "medium": 55, "low": 30, "info": 10}.get(severity, 50)
    level = min(100, (rule_level or 0) / 15 * 100)
    crit = {"critical": 100, "high": 75, "medium": 50, "low": 25}.get(asset_criticality or "medium", 50)
    ti = ti_score if ti_score is not None else 50.0
    conf = (llm_confidence or 0.5) * 100

    score = base * 0.35 + level * 0.20 + crit * 0.20 + ti * 0.15 + conf * 0.10
    return int(max(0, min(100, round(score))))
