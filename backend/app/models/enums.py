"""SOC-Lite · Enumeraciones de dominio (espejo exacto de los tipos de PostgreSQL)."""
from __future__ import annotations

from enum import Enum


class SeverityLevel(str, Enum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

    @property
    def weight(self) -> int:
        return {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}[self.value]


class AlertStatus(str, Enum):
    PENDING = "pending"
    ENRICHING = "enriching"
    TRIAGED = "triaged"
    ESCALATED = "escalated"
    CLOSED = "closed"
    FALSE_POSITIVE = "false_positive"


class TriageVerdict(str, Enum):
    TRUE_POSITIVE = "true_positive"
    FALSE_POSITIVE = "false_positive"
    BENIGN = "benign"
    SUSPICIOUS = "suspicious"
    INCONCLUSIVE = "inconclusive"


class IncidentStatus(str, Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    CONTAINED = "contained"
    RESOLVED = "resolved"
    CLOSED = "closed"


class PriorityLevel(str, Enum):
    P1 = "p1"
    P2 = "p2"
    P3 = "p3"
    P4 = "p4"


class SourceType(str, Enum):
    WAZUH = "wazuh"
    OPNsense = "opnsense"  # noqa: N815 (alias explícito)
    OPN_SENSE = "opnsense"
    SURICATA = "suricata"
    ZEEK = "zeek"
    MANUAL = "manual"
    API = "api"


class AuditResult(str, Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    DENIED = "denied"


class AuditAction(str, Enum):
    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"
    LOGIN_FAILED = "LOGIN_FAILED"
    CREATE = "CREATE"
    READ = "READ"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    EXPORT = "EXPORT"
    TRIAGE_RUN = "TRIAGE_RUN"
    TRIAGE_FEEDBACK = "TRIAGE_FEEDBACK"
    ROLE_ASSIGN = "ROLE_ASSIGN"
    CONFIG_CHANGE = "CONFIG_CHANGE"


class ReportFormat(str, Enum):
    PDF = "pdf"
    DOCX = "docx"
    XLSX = "xlsx"
    CSV = "csv"


# Módulos auditables (entrada/salida por módulo — requisito normativo)
AUDIT_MODULES: tuple[str, ...] = (
    "auth",
    "users",
    "roles",
    "alerts",
    "triage",
    "incidents",
    "dashboard",
    "reports",
    "audit",
    "settings",
    "integrations",
)
