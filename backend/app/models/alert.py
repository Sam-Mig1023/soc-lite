"""SOC-Lite · Modelos ORM: activos, alertas, enriquecimiento y triaje."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, ENUM as PGEnum, INET, JSONB, MACADDR, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.models.enums import AlertStatus, SeverityLevel, SourceType, TriageVerdict


def _enum(enum_cls, name: str):
    """Enum nativo de PostgreSQL usando los *valores* (minúsculas).

    El tipo ya existe (creado por db/schema.sql), por eso `create_type=False`:
    SQLAlchemy sólo lo referencia, nunca intenta crearlo.
    """
    return PGEnum(
        enum_cls,
        name=name,
        schema="soclite",
        create_type=False,
        values_callable=lambda e: [m.value for m in e],
    )


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hostname: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    ip_address: Mapped[str | None] = mapped_column(INET)
    mac_address: Mapped[str | None] = mapped_column(MACADDR)
    asset_type: Mapped[str] = mapped_column(String(48), default="server", nullable=False)
    criticality: Mapped[str] = mapped_column(String(16), default="medium", nullable=False)
    business_owner: Mapped[str | None] = mapped_column(String(160))
    location: Mapped[str | None] = mapped_column(String(120))
    os_family: Mapped[str | None] = mapped_column(String(64))
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, nullable=False)
    is_internet_facing: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    alerts: Mapped[list["Alert"]] = relationship(back_populates="asset")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    alert_fingerprint: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(160))
    source_type: Mapped[SourceType] = mapped_column(
        _enum(SourceType, "source_type"), default=SourceType.WAZUH, nullable=False
    )
    source_name: Mapped[str | None] = mapped_column(String(120))
    rule_id: Mapped[str | None] = mapped_column(String(64))
    rule_level: Mapped[int | None] = mapped_column(SmallInteger)
    rule_description: Mapped[str | None] = mapped_column(Text)
    rule_groups: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, nullable=False)
    severity: Mapped[SeverityLevel] = mapped_column(
        _enum(SeverityLevel, "severity_level"), default=SeverityLevel.MEDIUM, nullable=False
    )
    severity_raw: Mapped[int | None] = mapped_column(SmallInteger)
    status: Mapped[AlertStatus] = mapped_column(
        _enum(AlertStatus, "alert_status"), default=AlertStatus.PENDING, nullable=False
    )
    source_ip: Mapped[str | None] = mapped_column(INET)
    source_port: Mapped[int | None] = mapped_column(Integer)
    dest_ip: Mapped[str | None] = mapped_column(INET)
    dest_port: Mapped[int | None] = mapped_column(Integer)
    protocol: Mapped[str | None] = mapped_column(String(16))
    agent_id: Mapped[str | None] = mapped_column(String(64))
    agent_name: Mapped[str | None] = mapped_column(String(160))
    asset_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("assets.id", ondelete="SET NULL"))
    mitre_technique: Mapped[str | None] = mapped_column(String(24))
    mitre_tactic: Mapped[str | None] = mapped_column(String(48))
    full_log: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    risk_score: Mapped[int | None] = mapped_column(SmallInteger)
    verdict: Mapped[TriageVerdict | None] = mapped_column(_enum(TriageVerdict, "triage_verdict"))
    dedup_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    is_suppressed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    assigned_to: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    triaged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    mttt_seconds: Mapped[int | None] = mapped_column(Integer)
    mttr_seconds: Mapped[int | None] = mapped_column(Integer)
    sla_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    asset: Mapped[Asset | None] = relationship(back_populates="alerts", lazy="joined")
    assignee: Mapped["User | None"] = relationship(foreign_keys=[assigned_to], lazy="joined")  # noqa: F821
    enrichment: Mapped[list["EnrichmentData"]] = relationship(
        back_populates="alert", cascade="all, delete-orphan", lazy="selectin"
    )
    triages: Mapped[list["TriageResult"]] = relationship(
        back_populates="alert",
        cascade="all, delete-orphan",
        order_by="TriageResult.created_at.desc()",
        lazy="selectin",
    )

    __table_args__ = (
        # Los índices reales los crea db/schema.sql; estas declaraciones existen
        # para que el ORM conozca el esquema y Alembic pueda autogenerar diffs.
        Index("idx_alerts_occurred", "occurred_at"),
        Index("idx_alerts_status_sev", "status", "severity", "occurred_at"),
        Index("idx_alerts_source_ip", "source_ip"),
        Index("idx_alerts_agent", "agent_name"),
        Index("idx_alerts_rule", "rule_id"),
        Index("idx_alerts_assigned_open", "assigned_to",
              postgresql_where=text("status NOT IN ('closed','false_positive')")),
        Index("idx_alerts_risk", "risk_score"),
        Index("idx_alerts_raw_gin", "raw_payload", postgresql_using="gin"),
    )

    @property
    def current_triage(self) -> "TriageResult | None":
        return next((t for t in self.triages if t.is_current), None)

    @property
    def sla_breached(self) -> bool:
        if self.sla_due_at is None or self.closed_at is not None:
            return False
        return datetime.now(tz=self.sla_due_at.tzinfo) > self.sla_due_at


class EnrichmentData(Base):
    __tablename__ = "enrichment_data"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    alert_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(48), nullable=False)
    indicator: Mapped[str] = mapped_column(String(512), nullable=False)
    indicator_type: Mapped[str] = mapped_column(String(24), nullable=False)
    verdict: Mapped[str | None] = mapped_column(String(24))
    score: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    malicious_count: Mapped[int | None] = mapped_column(Integer)
    total_engines: Mapped[int | None] = mapped_column(Integer)
    country: Mapped[str | None] = mapped_column(String(64))
    asn: Mapped[str | None] = mapped_column(String(64))
    as_owner: Mapped[str | None] = mapped_column(String(160))
    raw_response: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    cache_hit: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    queried_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    alert: Mapped[Alert] = relationship(back_populates="enrichment")

    __table_args__ = (
        UniqueConstraint("alert_id", "provider", "indicator", "indicator_type", name="uq_enrichment_key"),
        Index("idx_enrich_alert", "alert_id"),
        Index("idx_enrich_indicator", "indicator", "indicator_type"),
    )


class TriageResult(Base):
    __tablename__ = "triage_results"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    alert_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    verdict: Mapped[TriageVerdict] = mapped_column(_enum(TriageVerdict, "triage_verdict"), nullable=False)
    severity: Mapped[SeverityLevel] = mapped_column(_enum(SeverityLevel, "severity_level"), nullable=False)
    risk_score: Mapped[int | None] = mapped_column(SmallInteger)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    reasoning: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    recommended_actions: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    mitre_techniques: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, nullable=False)
    iocs: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    model_name: Mapped[str] = mapped_column(String(96), nullable=False)
    model_provider: Mapped[str] = mapped_column(String(32), default="ollama", nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(24), default="triage_v1", nullable=False)
    temperature: Mapped[Decimal | None] = mapped_column(Numeric(3, 2), default=Decimal("0.10"))
    tokens_in: Mapped[int | None] = mapped_column(Integer)
    tokens_out: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(10, 6), default=0)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    tools_used: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, nullable=False)
    langsmith_run_id: Mapped[str | None] = mapped_column(String(96))
    trace_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    human_feedback: Mapped[str | None] = mapped_column(String(24))
    feedback_comment: Mapped[str | None] = mapped_column(Text)
    feedback_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"))
    feedback_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    alert: Mapped[Alert] = relationship(back_populates="triages")

    __table_args__ = (
        Index("idx_triage_alert", "alert_id", "created_at"),
        Index("idx_triage_verdict", "verdict", "created_at"),
        Index("uq_triage_current", "alert_id", unique=True, postgresql_where=text("is_current")),
    )
