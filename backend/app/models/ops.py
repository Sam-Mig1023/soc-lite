"""SOC-Lite · Modelos ORM: integraciones, notificaciones, reportes y métricas."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ENUM as PGEnum, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.models.enums import ReportFormat, SeverityLevel, SourceType


def _enum(enum_cls, name: str):
    """Enum nativo de PostgreSQL (creado por db/schema.sql; aquí sólo se referencia)."""
    return PGEnum(
        enum_cls,
        name=name,
        schema="soclite",
        create_type=False,
        values_callable=lambda e: [m.value for m in e],
    )


class Integration(Base):
    __tablename__ = "integrations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    code: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(48), nullable=False)
    base_url: Mapped[str | None] = mapped_column(Text)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    config: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    secret_ref: Mapped[str | None] = mapped_column(String(120))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    alert_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("alerts.id", ondelete="CASCADE"))
    incident_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("incidents.id", ondelete="CASCADE"))
    channel: Mapped[str] = mapped_column(String(24), nullable=False)
    target: Mapped[str | None] = mapped_column(String(160))
    severity: Mapped[SeverityLevel | None] = mapped_column(_enum(SeverityLevel, "severity_level"))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="queued", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("idx_notif_status", "status", "created_at"),)


class GeneratedReport(Base):
    __tablename__ = "generated_reports"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    report_type: Mapped[str] = mapped_column(String(48), nullable=False)
    report_format: Mapped[ReportFormat] = mapped_column(_enum(ReportFormat, "report_format"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    period_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    checksum_sha256: Mapped[str | None] = mapped_column(String(64))
    parameters: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    requested_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(24), default="completed", nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("idx_reports_type", "report_type", "created_at"),)


class AlertMetricsDaily(Base):
    __tablename__ = "alert_metrics_daily"

    metric_date: Mapped[date] = mapped_column(Date, primary_key=True)
    source_type: Mapped[SourceType] = mapped_column(_enum(SourceType, "source_type"), primary_key=True)
    severity: Mapped[SeverityLevel] = mapped_column(_enum(SeverityLevel, "severity_level"), primary_key=True)
    alerts_total: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    alerts_tp: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    alerts_fp: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    alerts_escalated: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    mttt_avg_sec: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    mttt_p95_sec: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    mttr_avg_sec: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    automation_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))


class KpiTarget(Base):
    __tablename__ = "kpi_targets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kpi_code: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    target_value: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)
    unit: Mapped[str] = mapped_column(String(24), nullable=False)
    direction: Mapped[str] = mapped_column(String(16), default="lower_is_better", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
