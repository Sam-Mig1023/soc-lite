/**
 * SOC-Lite · Enumeraciones canónicas
 * ---------------------------------------------------------------------------
 * FUENTE NORMATIVA: docs/00-contrato-api.md §"Enumeraciones" y db/schema.sql §1.
 * Cualquier valor debe coincidir EXACTAMENTE con el contrato. No añadir valores
 * que no existan en el backend.
 */

export const SEVERITY_LEVELS = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const ALERT_STATUSES = [
  'pending',
  'enriching',
  'triaged',
  'escalated',
  'closed',
  'false_positive',
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const TRIAGE_VERDICTS = [
  'true_positive',
  'false_positive',
  'benign',
  'suspicious',
  'inconclusive',
] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export const INCIDENT_STATUSES = [
  'open',
  'in_progress',
  'contained',
  'resolved',
  'closed',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SOURCE_TYPES = ['wazuh', 'opnsense', 'suricata', 'zeek', 'manual', 'api'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** db/schema.sql: audit_result */
export const AUDIT_RESULTS = ['success', 'failure', 'denied'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** db/schema.sql: audit_action */
export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'LOGIN_FAILED',
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'EXPORT',
  'TRIAGE_RUN',
  'TRIAGE_FEEDBACK',
  'ROLE_ASSIGN',
  'CONFIG_CHANGE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** db/schema.sql: report_format */
export const REPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** generated_reports.report_type */
export const REPORT_TYPES = ['operational', 'management', 'audit'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** audit_log.severity (SIEM interno) */
export const AUDIT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** Módulos auditables (contrato §8) */
export const AUDIT_MODULES = [
  'auth',
  'users',
  'roles',
  'alerts',
  'triage',
  'incidents',
  'dashboard',
  'reports',
  'audit',
  'settings',
  'integrations',
] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

/** Verdict de un IOC enriquecido (enrichment_data.verdict) */
export const IOC_VERDICTS = ['malicious', 'suspicious', 'clean', 'unknown'] as const;
export type IocVerdict = (typeof IOC_VERDICTS)[number];

/** Tipos de indicador (enrichment_data.indicator_type) */
export const IOC_TYPES = ['ip', 'domain', 'url', 'hash', 'email', 'cve'] as const;
export type IocType = (typeof IOC_TYPES)[number];

/**
 * Enum auxiliar del contrato interno backend → microservicio LLM:
 * recomendaciones de acción, campo `priority`.
 */
export type ActionPriority = Priority;

/** Catálogo de permisos del sistema (contrato §2). Formato `modulo:accion`. */
export const PERMISSIONS = [
  'dashboard:read',
  'alerts:read',
  'alerts:write',
  'alerts:delete',
  'triage:read',
  'triage:run',
  'incidents:read',
  'incidents:write',
  'assets:read',
  'assets:write',
  'reports:read',
  'reports:export',
  'users:read',
  'users:write',
  'users:delete',
  'roles:read',
  'roles:write',
  'roles:delete',
  'audit:read',
  'audit:export',
  'settings:read',
  'settings:write',
] as const;
export type PermissionCode = (typeof PERMISSIONS)[number] | (string & {});

/** Roles de sistema (contrato §2) */
export const SYSTEM_ROLE_CODES = ['admin', 'soc_manager', 'analyst', 'auditor', 'viewer'] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

/** Etiquetas legibles en español (UI) */
export const SEVERITY_LABELS: Record<SeverityLevel, string> = {
  info: 'Informativa',
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  pending: 'Pendiente',
  enriching: 'Enriqueciendo',
  triaged: 'Triada',
  escalated: 'Escalada',
  closed: 'Cerrada',
  false_positive: 'Falso positivo',
};

export const VERDICT_LABELS: Record<TriageVerdict, string> = {
  true_positive: 'Verdadero positivo',
  false_positive: 'Falso positivo',
  benign: 'Benigna',
  suspicious: 'Sospechosa',
  inconclusive: 'No concluyente',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Abierto',
  in_progress: 'En progreso',
  contained: 'Contenido',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  p1: 'P1 · Crítica',
  p2: 'P2 · Alta',
  p3: 'P3 · Media',
  p4: 'P4 · Baja',
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  wazuh: 'Wazuh',
  opnsense: 'OPNsense',
  suricata: 'Suricata',
  zeek: 'Zeek',
  manual: 'Manual',
  api: 'API',
};

export const AUDIT_RESULT_LABELS: Record<AuditResult, string> = {
  success: 'Éxito',
  failure: 'Fallo',
  denied: 'Denegado',
};

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word (docx)',
  xlsx: 'Excel (xlsx)',
  csv: 'CSV',
};

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  operational: 'Operativo',
  management: 'Gerencial',
  audit: 'Auditoría',
};

/**
 * Objetivo SLA por severidad, alineado con db/schema.sql (compute_mttt):
 * crítica < 15 min, alta < 1 h, media < 8 h, baja/info < 24 h.
 */
export const SLA_TARGET_SECONDS: Record<SeverityLevel, number> = {
  critical: 900,
  high: 3600,
  medium: 28800,
  low: 86400,
  info: 86400,
};
