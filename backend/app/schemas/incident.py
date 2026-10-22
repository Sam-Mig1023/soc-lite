"""SOC-Lite · Esquemas Pydantic: incidentes."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.models.enums import IncidentStatus, PriorityLevel, SeverityLevel
from app.schemas.common import ORMModel


class IncidentActionRead(ORMModel):
    id: int
    action_type: str
    description: str
    status: str
    automated: bool
    performed_by: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    result: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class IncidentActionCreate(BaseModel):
    action_type: str = Field(..., max_length=48)
    description: str = Field(..., min_length=3)
    automated: bool = False
    status: str = "pending"
    result: dict[str, Any] = Field(default_factory=dict)


class IncidentAlertLink(BaseModel):
    alert_ids: list[int] = Field(..., min_length=1, max_length=200)


class IncidentBase(BaseModel):
    title: str = Field(..., min_length=5, max_length=255)
    description: str | None = None
    priority: PriorityLevel = PriorityLevel.P3
    severity: SeverityLevel = SeverityLevel.MEDIUM
    category: str | None = Field(None, max_length=64)
    mitre_tactics: list[str] = Field(default_factory=list)
    owner_id: int | None = None
    impact: str | None = None


class IncidentCreate(IncidentBase):
    alert_ids: list[int] = Field(default_factory=list)
    detected_at: datetime | None = None


class IncidentUpdate(BaseModel):
    title: str | None = Field(None, min_length=5, max_length=255)
    description: str | None = None
    status: IncidentStatus | None = None
    priority: PriorityLevel | None = None
    severity: SeverityLevel | None = None
    category: str | None = None
    owner_id: int | None = None
    impact: str | None = None
    root_cause: str | None = None
    lessons_learned: str | None = None
    external_ticket_id: str | None = None
    external_ticket_url: str | None = None


class IncidentListItem(ORMModel):
    id: int
    incident_code: str
    title: str
    status: IncidentStatus
    priority: PriorityLevel
    severity: SeverityLevel
    category: str | None = None
    detected_at: datetime
    resolved_at: datetime | None = None
    owner_id: int | None = None
    external_ticket_id: str | None = None
    alert_count: int = 0
    mttr_seconds: int | None = None


class IncidentDetail(IncidentListItem):
    description: str | None = None
    mitre_tactics: list[str] = Field(default_factory=list)
    contained_at: datetime | None = None
    closed_at: datetime | None = None
    impact: str | None = None
    root_cause: str | None = None
    lessons_learned: str | None = None
    external_ticket_url: str | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime
    actions: list[IncidentActionRead] = Field(default_factory=list)
    alert_ids: list[int] = Field(default_factory=list)

    @field_validator("alert_ids", mode="before")
    @classmethod
    def _links(cls, v):  # noqa: ANN001
        if v and hasattr(v[0], "alert_id"):
            return [link.alert_id for link in v]
        return v or []


class IncidentTicket(BaseModel):
    external_ticket_id: str | None = None
    external_ticket_url: str | None = None
    provider: str | None = None
    status: str | None = None
