"""SOC-Lite · Modelos ORM: incidentes y acciones de respuesta."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, ENUM as PGEnum, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.models.enums import IncidentStatus, PriorityLevel, SeverityLevel


def _enum(enum_cls, name: str):
    """Enum nativo de PostgreSQL (creado por db/schema.sql; aquí sólo se referencia)."""
    return PGEnum(
        enum_cls,
        name=name,
        schema="soclite",
        create_type=False,
        values_callable=lambda e: [m.value for m in e],
    )


class Incident(Base):
    __tablename__ = "incidents"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    incident_code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[IncidentStatus] = mapped_column(
        _enum(IncidentStatus, "incident_status"), default=IncidentStatus.OPEN, nullable=False
    )
    priority: Mapped[PriorityLevel] = mapped_column(
        _enum(PriorityLevel, "priority_level"), default=PriorityLevel.P3, nullable=False
    )
    severity: Mapped[SeverityLevel] = mapped_column(
        _enum(SeverityLevel, "severity_level"), default=SeverityLevel.MEDIUM, nullable=False
    )
    category: Mapped[str | None] = mapped_column(String(64))
    mitre_tactics: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    contained_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    owner_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    external_ticket_id: Mapped[str | None] = mapped_column(String(64))
    external_ticket_url: Mapped[str | None] = mapped_column(Text)
    impact: Mapped[str | None] = mapped_column(Text)
    root_cause: Mapped[str | None] = mapped_column(Text)
    lessons_learned: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    owner: Mapped["User | None"] = relationship(foreign_keys=[owner_id], lazy="joined")  # noqa: F821
    creator: Mapped["User | None"] = relationship(foreign_keys=[created_by], lazy="joined")  # noqa: F821
    actions: Mapped[list["IncidentAction"]] = relationship(
        back_populates="incident", cascade="all, delete-orphan",
        order_by="IncidentAction.created_at.desc()", lazy="selectin",
    )
    alert_links: Mapped[list["IncidentAlert"]] = relationship(
        back_populates="incident", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (Index("idx_incidents_status", "status", "priority", "detected_at"),)

    @property
    def mttr_seconds(self) -> int | None:
        end = self.resolved_at or self.closed_at
        if end is None:
            return None
        return int((end - self.detected_at).total_seconds())


class IncidentAlert(Base):
    __tablename__ = "incident_alerts"

    incident_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("incidents.id", ondelete="CASCADE"), primary_key=True
    )
    alert_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("alerts.id", ondelete="CASCADE"), primary_key=True
    )
    linked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    linked_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))

    incident: Mapped[Incident] = relationship(back_populates="alert_links")


class IncidentAction(Base):
    __tablename__ = "incident_actions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    incident_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False
    )
    action_type: Mapped[str] = mapped_column(String(48), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="pending", nullable=False)
    automated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    performed_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    incident: Mapped[Incident] = relationship(back_populates="actions")
