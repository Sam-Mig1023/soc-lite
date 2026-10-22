"""SOC-Lite · Esquemas Pydantic: alertas, enriquecimiento y triaje."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, IPvAnyAddress, field_validator

from app.models.enums import AlertStatus, SeverityLevel, SourceType, TriageVerdict
from app.schemas.common import ORMModel


# ----------------------------------------------------------------------
# Ingesta
# ----------------------------------------------------------------------
class AlertIngest(BaseModel):
    """Payload normalizado aceptado por POST /alerts/ingest.

    Acepta tanto el formato normalizado como el JSON crudo de Wazuh
    (el normalizador `from_wazuh` hace la conversión).
    """

    alert_fingerprint: str | None = None
    external_id: str | None = None
    source_type: SourceType = SourceType.WAZUH
    source_name: str | None = None
    rule_id: str | None = None
    rule_level: int | None = None
    rule_description: str | None = None
    rule_groups: list[str] = Field(default_factory=list)
    severity: SeverityLevel | None = None
    source_ip: str | None = None
    source_port: int | None = None
    dest_ip: str | None = None
    dest_port: int | None = None
    protocol: str | None = None
    agent_id: str | None = None
    agent_name: str | None = None
    mitre_technique: str | None = None
    mitre_tactic: str | None = None
    full_log: str | None = None
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime | None = None

    @classmethod
    def from_wazuh(cls, payload: dict[str, Any]) -> "AlertIngest":
        """Normaliza un evento crudo de Wazuh (webhook JSON) al contrato interno."""
        rule = payload.get("rule", {}) or {}
        agent = payload.get("agent", {}) or {}
        data = payload.get("data", {}) or {}
        mitre = rule.get("mitre", {}) or {}
        level = int(rule.get("level", 0) or 0)

        return cls(
            external_id=str(payload.get("id")),
            source_type=SourceType.WAZUH,
            source_name=payload.get("manager", {}).get("name") if isinstance(payload.get("manager"), dict) else "wazuh-manager",
            rule_id=str(rule.get("id")) if rule.get("id") is not None else None,
            rule_level=level,
            rule_description=rule.get("description"),
            rule_groups=list(rule.get("groups", []) or []),
            severity=level_to_severity(level),
            source_ip=data.get("srcip") or payload.get("srcip"),
            source_port=_safe_int(data.get("srcport")),
            dest_ip=data.get("dstip") or payload.get("dstip"),
            dest_port=_safe_int(data.get("dstport")),
            protocol=data.get("protocol"),
            agent_id=str(agent.get("id")) if agent.get("id") is not None else None,
            agent_name=agent.get("name"),
            mitre_technique=(mitre.get("id") or [None])[0],
            mitre_tactic=(mitre.get("tactic") or [None])[0],
            full_log=payload.get("full_log") or payload.get("full_log_raw"),
            raw_payload=payload,
            occurred_at=_parse_ts(payload.get("timestamp")),
        )


class IngestResponse(BaseModel):
    alert_id: int
    alert_fingerprint: str
    status: AlertStatus
    duplicated: bool = False
    severity: SeverityLevel
    triage_queued: bool = False
    message: str


# ----------------------------------------------------------------------
# Lectura
# ----------------------------------------------------------------------
class EnrichmentRead(ORMModel):
    id: int
    provider: str
    indicator: str
    indicator_type: str
    verdict: str | None = None
    score: float | None = None
    malicious_count: int | None = None
    total_engines: int | None = None
    country: str | None = None
    asn: str | None = None
    as_owner: str | None = None
    cache_hit: bool = False
    queried_at: datetime


class RecommendedAction(BaseModel):
    order: int = 1
    action: str
    priority: str = "p3"
    responsible: str | None = None
    automated: bool = False


class TriageRead(ORMModel):
    id: int
    alert_id: int
    verdict: TriageVerdict
    severity: SeverityLevel
    risk_score: int | None = None
    confidence: float | None = None
    summary: str
    reasoning: list[Any] = Field(default_factory=list)
    recommended_actions: list[Any] = Field(default_factory=list)
    mitre_techniques: list[str] = Field(default_factory=list)
    iocs: list[Any] = Field(default_factory=list)
    model_name: str
    model_provider: str
    prompt_version: str
    tokens_in: int | None = None
    tokens_out: int | None = None
    latency_ms: int | None = None
    tools_used: list[str] = Field(default_factory=list)
    human_feedback: str | None = None
    feedback_comment: str | None = None
    feedback_at: datetime | None = None
    is_current: bool
    created_at: datetime


class AlertListItem(ORMModel):
    id: int
    alert_fingerprint: str
    source_type: SourceType
    rule_id: str | None = None
    rule_description: str | None = None
    severity: SeverityLevel
    status: AlertStatus
    risk_score: int | None = None
    verdict: TriageVerdict | None = None
    source_ip: IPvAnyAddress | None = None
    dest_ip: IPvAnyAddress | None = None
    agent_name: str | None = None
    mitre_technique: str | None = None
    dedup_count: int
    assigned_to: int | None = None
    occurred_at: datetime
    triaged_at: datetime | None = None
    mttt_seconds: int | None = None
    sla_due_at: datetime | None = None


class AlertDetail(AlertListItem):
    external_id: str | None = None
    source_name: str | None = None
    rule_level: int | None = None
    rule_groups: list[str] = Field(default_factory=list)
    severity_raw: int | None = None
    source_port: int | None = None
    dest_port: int | None = None
    protocol: str | None = None
    agent_id: str | None = None
    asset_id: int | None = None
    mitre_tactic: str | None = None
    full_log: str | None = None
    raw_payload: dict[str, Any] = Field(default_factory=dict)
    is_suppressed: bool = False
    ingested_at: datetime
    closed_at: datetime | None = None
    mttr_seconds: int | None = None
    created_at: datetime
    enrichment: list[EnrichmentRead] = Field(default_factory=list)
    triages: list[TriageRead] = Field(default_factory=list)
    # Triaje vigente embebido (evita una segunda llamada desde el detalle de la alerta).
    # Se expone con los dos nombres usados por los clientes: `triage` y `triage_result`.
    triage: TriageRead | None = None
    triage_result: TriageRead | None = None


class TimelineEvent(BaseModel):
    """Evento de la línea de tiempo. `title`/`detail` son canónicos; `description`
    y `action` son alias para los consumidores que usan esa nomenclatura."""

    id: str | None = None
    occurred_at: datetime
    event_type: str
    title: str
    description: str | None = None
    action: str | None = None
    detail: str | None = None
    actor: str | None = None
    severity: str | None = None


# ----------------------------------------------------------------------
# Actualización / acciones
# ----------------------------------------------------------------------
class AlertUpdate(BaseModel):
    status: AlertStatus | None = None
    assigned_to: int | None = None
    severity: SeverityLevel | None = None
    is_suppressed: bool | None = None
    notes: str | None = None
    close_reason: str | None = None


class AlertBulkStatus(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
    status: AlertStatus
    close_reason: str | None = None


class TriageFeedback(BaseModel):
    is_false_positive: bool
    comment: str | None = Field(None, max_length=2000)
    corrected_severity: SeverityLevel | None = None


class TriageRunResponse(BaseModel):
    alert_id: int
    triage_id: int
    verdict: TriageVerdict
    severity: SeverityLevel
    risk_score: int
    confidence: float
    summary: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)
    incident_id: int | None = None
    ticket_id: str | None = None
    notified: bool = False
    latency_ms: int | None = None


class TriageStats(BaseModel):
    """Métricas de precisión y rendimiento del triaje automatizado (contrato §4).

    Incluye tanto la nomenclatura canónica (`total_triages`, `by_verdict`) como los
    alias normalizados que consumen los widgets del frontend (`total_triaged`,
    `verdict_distribution`, `latency_ms`, `by_model`).
    """

    period: dict[str, datetime] | None = None
    total_triages: int
    total_triaged: int
    by_verdict: dict[str, int]
    verdict_distribution: dict[str, int]
    by_severity: dict[str, int]
    by_model: list[ModelUsageEntry]
    latency_ms: LatencyMetrics
    tools_usage: list[ToolUsageEntry] = Field(default_factory=list)
    precision: float | None = None
    recall: float | None = None
    f1: float | None = None
    false_positive_rate: float | None = None
    human_confirmed_tp: int = 0
    human_confirmed_fp: int = 0
    agreement_with_human: float | None = None
    accuracy: float | None = None
    avg_confidence: float | None = None
    avg_latency_ms: float | None = None
    avg_tokens: float | None = None


class ModelUsageEntry(BaseModel):
    """Uso y rendimiento de un modelo/prompt concreto (detección de deriva)."""

    model_name: str
    prompt_version: str | None = None
    runs: int = 0
    avg_latency_ms: float | None = None
    avg_confidence: float | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    fp_rate: float | None = None
    accuracy: float | None = None


class LatencyMetrics(BaseModel):
    avg: float = 0.0
    median: float = 0.0
    p95: float = 0.0
    max: float = 0.0


class ToolUsageEntry(BaseModel):
    tool: str
    count: int


# ----------------------------------------------------------------------
# Helpers de normalización
# ----------------------------------------------------------------------
def level_to_severity(level: int | None) -> SeverityLevel:
    """Mapeo de nivel de regla Wazuh (0-15) a severidad normalizada."""
    lvl = level or 0
    if lvl >= 12:
        return SeverityLevel.CRITICAL
    if lvl >= 9:
        return SeverityLevel.HIGH
    if lvl >= 6:
        return SeverityLevel.MEDIUM
    if lvl >= 3:
        return SeverityLevel.LOW
    return SeverityLevel.INFO


def _safe_int(value: Any) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        from dateutil import parser

        return parser.parse(str(value))
    except Exception:
        return None
