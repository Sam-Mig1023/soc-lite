"""SOC-Lite · Esquemas Pydantic: dashboard, reportes y auditoría.

Nota de compatibilidad: los widgets del dashboard consumen tanto la nomenclatura
canónica del contrato (`mttt_avg`, `period`) como los alias normalizados que usa el
frontend (`mttt_avg_sec`, `date`). El backend devuelve **ambos** en la misma
respuesta para que ninguna vista necesite transformar datos en el cliente.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, IPvAnyAddress

from app.models.enums import AuditAction, AuditResult, ReportFormat, SeverityLevel
from app.schemas.common import ORMModel


# ----------------------------------------------------------------------
# Dashboard
# ----------------------------------------------------------------------
class PeriodInfo(BaseModel):
    from_: datetime = Field(..., alias="from")
    to: datetime

    model_config = {"populate_by_name": True}


class MtttMetrics(BaseModel):
    avg: float
    median: float
    p95: float
    unit: str = "seconds"


class DashboardSummary(BaseModel):
    period: dict[str, datetime]
    alerts_total: int
    alerts_pending: int
    alerts_open: int
    by_severity: dict[str, int]
    by_status: dict[str, int]
    by_verdict: dict[str, int]
    mttt_seconds: MtttMetrics
    mttr_seconds: MtttMetrics
    false_positive_rate: float
    automation_rate: float
    noise_reduction: float
    incidents_open: int
    incidents_critical: int
    sla_compliance: dict[str, float]
    sla_breached: int
    alerts_today: int
    alerts_prev_period: int
    trend_pct: float


class SeveritySeriesPoint(BaseModel):
    period: str
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    info: int = 0
    total: int = 0


class MtttTrendPoint(BaseModel):
    """Punto diario de MTTT. Incluye los alias `*_sec` que consume el gráfico del dashboard."""

    period: str
    mttt_avg: float | None = None
    mttt_p95: float | None = None
    target_seconds: int | None = None
    alerts: int = 0
    # Alias normalizados (frontend)
    date: str
    mttt_avg_sec: float | None = None
    mttt_p95_sec: float | None = None
    target_sec: int | None = None
    target_sla_sec: int | None = None


class TopItem(BaseModel):
    """Elemento de un ranking. Expone `key`/`label` y los alias del frontend."""

    key: str
    label: str | None = None
    count: int
    extra: dict[str, Any] = Field(default_factory=dict)
    # Alias consumidos por los widgets del dashboard
    value: str | None = None
    name: str | None = None
    avg_risk_score: float | None = None
    rule_id: str | None = None
    rule_description: str | None = None
    agent_name: str | None = None
    model_name: str | None = None
    prompt_version: str | None = None
    total: int | None = None
    fp: int | None = None
    fp_pct: float | None = None


class FpRateBreakdown(BaseModel):
    global_rate: float
    total_triaged: int
    total_fp: int
    by_rule: list[TopItem]
    by_model: list[TopItem]
    human_agreement_rate: float | None = None
    # Alias del frontend
    false_positives: int = 0


class SlaComplianceItem(BaseModel):
    severity: SeverityLevel
    target_minutes: int
    compliant: int
    breached: int
    compliance_rate: float
    # Alias del frontend
    total: int = 0
    compliance: float = 0.0
    target: int | None = None
    avg_seconds: float | None = None


class SlaComplianceResponse(BaseModel):
    items: list[SlaComplianceItem]
    by_severity: dict[str, float] = Field(default_factory=dict)
    period: dict[str, datetime]


class AnalystWorkload(BaseModel):
    user_id: int
    username: str
    full_name: str
    open_alerts: int
    escalated: int
    closed: int
    avg_mttt_seconds: float | None = None
    # Alias del frontend
    abiertas: int = 0
    escaladas: int = 0
    cerradas: int = 0
    mttt_promedio: float | None = None
    total: int = 0


# ----------------------------------------------------------------------
# Auditoría
# ----------------------------------------------------------------------
class AuditLogRead(ORMModel):
    id: int
    occurred_at: datetime
    user_id: int | None = None
    username: str | None = None
    module: str
    action: AuditAction
    entity: str | None = None
    entity_id: str | None = None
    result: AuditResult
    detail: str | None = None
    ip_address: IPvAnyAddress | None = None
    user_agent: str | None = None
    http_method: str | None = None
    http_path: str | None = None
    http_status: int | None = None
    duration_ms: int | None = None
    trace_id: str | None = None
    severity: str
    hash_self: str | None = None


class AuditLogDetail(AuditLogRead):
    before_data: dict[str, Any] | None = None
    after_data: dict[str, Any] | None = None
    changes: dict[str, Any] | None = None
    session_id: str | None = None
    hash_prev: str | None = None
    # Alias del frontend (`before`/`after`)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None


class AuditStats(BaseModel):
    period: dict[str, datetime]
    total_events: int
    by_module: list[dict[str, Any]]
    by_action: list[dict[str, Any]]
    by_result: dict[str, int]
    by_user: list[dict[str, Any]]
    failed_logins: int
    denied_actions: int
    events_per_day: list[dict[str, Any]]
    # Alias del frontend
    total: int = 0


# ----------------------------------------------------------------------
# Reportes
# ----------------------------------------------------------------------
class ReportRequest(BaseModel):
    report_type: str = Field(..., pattern="^(operational|management|audit)$")
    report_format: ReportFormat = ReportFormat.PDF
    date_from: datetime | None = Field(None, alias="from")
    date_to: datetime | None = Field(None, alias="to")
    period: str | None = Field("monthly", description="daily|weekly|monthly|quarterly")
    include_charts: bool = True
    include_raw_data: bool = False
    sections: list[str] | None = None

    model_config = {"populate_by_name": True}


class GeneratedReportRead(ORMModel):
    id: int
    report_type: str
    report_format: ReportFormat
    title: str
    period_from: datetime | None = None
    period_to: datetime | None = None
    file_path: str
    file_size: int | None = None
    checksum_sha256: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    requested_by: int | None = None
    status: str
    error: str | None = None
    created_at: datetime
