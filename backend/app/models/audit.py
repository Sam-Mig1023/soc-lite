"""SOC-Lite · Modelos ORM: bitácora de auditoría encadenada."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM as PGEnum, INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.models.enums import AuditAction, AuditResult


def _enum(enum_cls, name: str):
    """Enum nativo de PostgreSQL (creado por db/schema.sql; aquí sólo se referencia)."""
    return PGEnum(
        enum_cls,
        name=name,
        schema="soclite",
        create_type=False,
        values_callable=lambda e: [m.value for m in e],
    )


class AuditLog(Base):
    """Registro inmutable de entradas y salidas por módulo.

    Requisito: usuario, fecha, hora, acción, módulo y resultado.
    Cumple ISO/IEC 27001:2022 A.8.15 (registro de eventos) y NIST CSF DE.AE.
    Inmutabilidad garantizada por reglas PostgreSQL (no UPDATE / no DELETE)
    y por encadenamiento de hashes sha256 (hash_prev → hash_self).
    """

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    username: Mapped[str | None] = mapped_column(String(64))
    module: Mapped[str] = mapped_column(String(48), nullable=False)
    action: Mapped[AuditAction] = mapped_column(_enum(AuditAction, "audit_action"), nullable=False)
    entity: Mapped[str | None] = mapped_column(String(48))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    result: Mapped[AuditResult] = mapped_column(
        _enum(AuditResult, "audit_result"), default=AuditResult.SUCCESS, nullable=False
    )
    detail: Mapped[str | None] = mapped_column(Text)
    before_data: Mapped[dict | None] = mapped_column(JSONB)
    after_data: Mapped[dict | None] = mapped_column(JSONB)
    changes: Mapped[dict | None] = mapped_column(JSONB)
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(Text)
    http_method: Mapped[str | None] = mapped_column(String(10))
    http_path: Mapped[str | None] = mapped_column(Text)
    http_status: Mapped[int | None] = mapped_column(SmallInteger)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    trace_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    session_id: Mapped[str | None] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(16), default="info", nullable=False)
    hash_prev: Mapped[str | None] = mapped_column(String(64))
    hash_self: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        Index("idx_audit_occurred", "occurred_at"),
        Index("idx_audit_user", "user_id", "occurred_at"),
        Index("idx_audit_module", "module", "action", "occurred_at"),
        Index("idx_audit_entity", "entity", "entity_id"),
        Index("idx_audit_failed", "result", postgresql_where=text("result <> 'success'")),
    )
