"""SOC-Lite · Registro único de modelos ORM.

Importar este módulo garantiza que todos los mappers estén configurados
antes de resolver relaciones entre módulos.
"""
from app.models.alert import Alert, Asset, EnrichmentData, TriageResult
from app.models.audit import AuditLog
from app.models.enums import (
    AUDIT_MODULES,
    AlertStatus,
    AuditAction,
    AuditResult,
    IncidentStatus,
    PriorityLevel,
    ReportFormat,
    SeverityLevel,
    SourceType,
    TriageVerdict,
)
from app.models.incident import Incident, IncidentAction, IncidentAlert
from app.models.ops import (
    AlertMetricsDaily,
    GeneratedReport,
    Integration,
    KpiTarget,
    Notification,
)
from app.models.user import Permission, RefreshToken, Role, User, role_permissions, user_roles

__all__ = [
    "AUDIT_MODULES",
    "Alert",
    "AlertMetricsDaily",
    "AlertStatus",
    "Asset",
    "AuditAction",
    "AuditLog",
    "AuditResult",
    "EnrichmentData",
    "GeneratedReport",
    "Incident",
    "IncidentAction",
    "IncidentAlert",
    "IncidentStatus",
    "Integration",
    "KpiTarget",
    "Notification",
    "Permission",
    "PriorityLevel",
    "RefreshToken",
    "ReportFormat",
    "Role",
    "SeverityLevel",
    "SourceType",
    "TriageResult",
    "TriageVerdict",
    "User",
    "role_permissions",
    "user_roles",
]
