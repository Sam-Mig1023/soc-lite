"""SOC-Lite · Esquemas del microservicio de triaje (contrato con el backend)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Verdict = Literal["true_positive", "false_positive", "benign", "suspicious", "inconclusive"]
Severity = Literal["info", "low", "medium", "high", "critical"]
Priority = Literal["p1", "p2", "p3", "p4"]


class AlertPayload(BaseModel):
    rule_id: str | None = None
    rule_description: str | None = None
    rule_level: int | None = None
    rule_groups: list[str] = Field(default_factory=list)
    severity_siem: Severity = "medium"
    source_ip: str | None = None
    dest_ip: str | None = None
    agent_name: str | None = None
    full_log: str | None = None
    mitre_technique: str | None = None
    occurred_at: str | None = None
    dedup_count: int = 1


class TriageContext(BaseModel):
    recent_alerts_same_source: int = 0
    asset_criticality: str = "medium"
    asset_hostname: str | None = None
    asset_internet_facing: bool = False
    known_false_positives: int = 0
    is_working_hours: bool = True
    policy: dict[str, Any] = Field(default_factory=dict)


class TriageRequest(BaseModel):
    alert_id: int
    trace_id: str
    alert: AlertPayload
    context: TriageContext = Field(default_factory=TriageContext)


class RecommendedAction(BaseModel):
    order: int = 1
    action: str
    priority: Priority = "p3"
    automated: bool = False
    responsible: str | None = None


class Indicator(BaseModel):
    type: Literal["ip", "domain", "url", "hash", "email", "cve"] = "ip"
    value: str
    verdict: Literal["malicious", "suspicious", "clean", "unknown"] = "unknown"
    source: str = "unknown"
    score: float | None = None
    cache_hit: bool = False


class TriageOutput(BaseModel):
    """Salida estructurada que el agente debe producir (validada por Pydantic)."""

    verdict: Verdict = "inconclusive"
    severity: Severity = "medium"
    risk_score: int = Field(50, ge=0, le=100)
    confidence: float = Field(0.5, ge=0.0, le=1.0)
    summary: str = "Sin resumen generado."
    reasoning: list[str] = Field(default_factory=list)
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)
    mitre_techniques: list[str] = Field(default_factory=list)
    indicators: list[Indicator] = Field(default_factory=list)
    asset_impact: str | None = None
    false_positive_hypothesis: str | None = None
    sla_recommendation: Literal["inmediata", "1h", "8h", "24h"] = "8h"


class TriageResponse(TriageOutput):
    trace_id: str
    model: str
    provider: str
    prompt_version: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0
    tools_used: list[str] = Field(default_factory=list)
    degraded: bool = False
    error: str | None = None


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    provider: str
    model: str
    tools: list[str]
    llm_reachable: bool
    external_llm_allowed: bool
