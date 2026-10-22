/**
 * SOC-Lite · Tipos de alertas, enriquecimiento, triaje y timeline.
 * Contrato: docs/00-contrato-api.md §3 y §4. Esquema: db/schema.sql alerts/enrichment_data/triage_results.
 */
import type { PageParams, DateRange, SortDir } from './common';
import type {
  AlertStatus,
  SeverityLevel,
  SourceType,
  TriageVerdict,
  IocVerdict,
  IocType,
  Priority,
} from './enums';

/** Item del listado paginado GET /alerts. */
export interface AlertListItem {
  id: number;
  alert_fingerprint: string;
  external_id?: string | null;
  rule_id: string | null;
  rule_level?: number | null;
  rule_description: string | null;
  rule_groups?: string[];
  source_type: SourceType;
  source_name?: string | null;
  agent_id?: string | null;
  agent_name: string | null;
  asset_id?: number | null;
  source_ip: string | null;
  source_port?: number | null;
  dest_ip: string | null;
  dest_port?: number | null;
  protocol?: string | null;
  severity: SeverityLevel;
  severity_raw: number | null;
  status: AlertStatus;
  risk_score: number | null;
  verdict: TriageVerdict | null;
  mitre_technique?: string | null;
  mitre_tactic?: string | null;
  dedup_count?: number;
  is_suppressed?: boolean;
  occurred_at: string;
  created_at: string;
  triaged_at?: string | null;
  closed_at?: string | null;
  mttt_seconds: number | null;
  mttr_seconds?: number | null;
  sla_due_at?: string | null;
  assigned_to: number | null;
  assigned_to_username?: string | null;
  incident_id: number | null;
}

/** Alias corto usado por los componentes de tabla. */
export type Alert = AlertListItem;

/** Resultado de triaje LLM (triage_results). */
export interface TriageResult {
  id: number;
  alert_id: number;
  verdict: TriageVerdict;
  severity: SeverityLevel;
  risk_score: number | null;
  confidence: number | null;
  summary: string;
  reasoning: string[];
  recommended_actions: RecommendedAction[];
  mitre_techniques: string[];
  iocs: TriageIoc[];
  model_name: string;
  model_provider?: string;
  prompt_version: string;
  temperature?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
  tools_used: string[];
  langsmith_run_id?: string | null;
  trace_id?: string | null;
  human_feedback?: string | null;
  feedback_comment?: string | null;
  feedback_by?: number | null;
  feedback_at?: string | null;
  is_current?: boolean;
  created_at: string;
}

/** Acción recomendada por el LLM (triage_results.recommended_actions). */
export interface RecommendedAction {
  order: number;
  action: string;
  priority: Priority;
}

/** IOC detectado por el modelo (subconjunto de enrichment_data). */
export interface TriageIoc {
  type: IocType | string;
  value: string;
  verdict?: IocVerdict | string;
  source?: string;
  score?: number;
  country?: string;
  asn?: string;
  as_owner?: string;
}

/** Registro de enriquecimiento externo (enrichment_data). */
export interface EnrichmentRecord {
  id: number;
  alert_id: number;
  provider: string;
  indicator: string;
  indicator_type: IocType | string;
  verdict: IocVerdict | string | null;
  score: number | null;
  malicious_count?: number | null;
  total_engines?: number | null;
  country?: string | null;
  asn?: string | null;
  as_owner?: string | null;
  raw_response?: Record<string, unknown>;
  cache_hit: boolean;
  queried_at: string;
  expires_at?: string | null;
}

/** Evento del timeline de una alerta. */
export interface TimelineEvent {
  id: number | string;
  alert_id?: number;
  event_type?: string;
  action?: string;
  description: string;
  actor?: string | null;
  actor_username?: string | null;
  occurred_at: string;
  metadata?: Record<string, unknown> | null;
}

/** Alerta vinculada a un incidente (resumen embebido en el detalle). */
export interface AlertIncidentRef {
  id: number;
  incident_code: string;
  title: string;
  status: string;
  priority: Priority;
}

/** Detalle completo GET /alerts/{id}. */
export interface AlertDetail extends AlertListItem {
  full_log?: string | null;
  raw_payload?: Record<string, unknown>;
  triage?: TriageResult | null;
  triage_result?: TriageResult | null;
  enrichment?: EnrichmentRecord[];
  incident?: AlertIncidentRef | null;
  timeline?: TimelineEvent[];
  assigned_to_user?: { id: number; username: string; full_name: string } | null;
}

/** Permite obtener el triaje embebido con cualquiera de las dos claves del contrato. */
export function getEmbeddedTriage(alert: AlertDetail | undefined | null): TriageResult | null {
  if (!alert) return null;
  return alert.triage ?? alert.triage_result ?? null;
}

/** Filtros de GET /alerts (contrato §3). */
export interface AlertListQuery extends PageParams, DateRange {
  severity?: SeverityLevel;
  status?: AlertStatus;
  source_type?: SourceType;
  assigned_to?: number;
  q?: string;
  min_risk_score?: number;
  has_triage?: boolean;
  sort_by?: string;
  sort_dir?: SortDir;
}

/** PATCH /alerts/{id}. */
export interface AlertUpdateRequest {
  status?: AlertStatus;
  assigned_to?: number | null;
  notes?: string;
}

/** POST /alerts/bulk/status. */
export interface BulkStatusRequest {
  ids: number[];
  status: AlertStatus;
}

/** POST /triage/{alert_id}/feedback. */
export interface TriageFeedbackRequest {
  is_false_positive: boolean;
  comment?: string;
}

/** Fila del listado GET /triage/results. */
export interface TriageResultListItem extends TriageResult {
  alert_rule_id?: string | null;
  alert_rule_description?: string | null;
  alert_severity?: SeverityLevel;
  alert_source_ip?: string | null;
}

export interface TriageResultsQuery extends PageParams, DateRange {
  verdict?: TriageVerdict;
  model_name?: string;
  min_confidence?: number;
}

/** Distribución de veredictos devuelta por /triage/stats. */
export interface VerdictDistributionEntry {
  verdict: TriageVerdict;
  count: number;
  percentage?: number;
}

/** Métricas por modelo/prompt de /triage/stats. */
export interface ModelUsageEntry {
  model_name: string;
  prompt_version?: string;
  runs: number;
  avg_latency_ms?: number;
  avg_confidence?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  fp_rate?: number;
  accuracy?: number;
}

/** GET /triage/stats. Refleja schemas/alert.py::TriageStats del backend. */
export interface TriageStats {
  period?: DateRange;
  /** Nomenclatura canónica del backend. */
  total_triages?: number;
  /** Alias normalizado (mismo valor que `total_triages`). */
  total_triaged: number;
  /** Distribución por veredicto en formato diccionario (contrato §4). */
  by_verdict?: Partial<Record<TriageVerdict, number>>;
  /** Mismo contenido que `by_verdict`, con el nombre que consumen los widgets. */
  verdict_distribution: Partial<Record<TriageVerdict, number>>;
  by_severity?: Partial<Record<SeverityLevel, number>>;
  by_model: ModelUsageEntry[];
  latency_ms: { avg: number; median: number; p95: number; max?: number };
  tools_usage?: Array<{ tool: string; count: number }>;
  precision?: number | null;
  recall?: number | null;
  f1?: number | null;
  false_positive_rate?: number | null;
  human_confirmed_tp?: number;
  human_confirmed_fp?: number;
  agreement_with_human?: number | null;
  accuracy?: number | null;
  avg_confidence?: number | null;
  avg_latency_ms?: number | null;
  avg_tokens?: number | null;
}

/** Respuesta de POST /triage/{id}/run (mismo shape que un resultado de triaje). */
export type TriageRunResponse = TriageResult;
