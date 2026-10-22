/**
 * SOC-Lite · Tipos del dashboard y métricas KPI.
 * Contrato: docs/00-contrato-api.md §6 (GET /dashboard/*) y esquema v_mttt_daily / v_analyst_workload.
 */
import type { DateRange } from './common';
import type { SeverityLevel } from './enums';

/** GET /dashboard/summary — ejemplo normativo del contrato §6. */
export interface DashboardSummary {
  period: { from: string; to: string };
  alerts_total: number;
  alerts_pending: number;
  by_severity: Record<SeverityLevel, number>;
  mttt_seconds: { avg: number; median: number; p95: number };
  false_positive_rate: number;
  automation_rate: number;
  incidents_open: number;
  sla_compliance: Partial<Record<SeverityLevel, number>>;
  noise_reduction: number;
}

/** GET /dashboard/alerts-by-severity — serie temporal. */
export interface SeveritySeriesPoint {
  period: string;
  info?: number;
  low?: number;
  medium?: number;
  high?: number;
  critical?: number;
  total?: number;
}

export interface SeveritySeriesQuery extends DateRange {
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

/** GET /dashboard/mttt-trend — MTTT diario vs objetivo SLA. */
export interface MtttTrendPoint {
  date: string;
  mttt_avg_sec: number;
  mttt_p95_sec?: number;
  /** Objetivo de referencia (según contrato, "objetivo SLA"). */
  target_sec?: number;
  target_sla_sec?: number;
}

/** Elemento de GET /dashboard/top-sources. */
export interface TopSourceItem {
  key?: string;
  label?: string;
  value?: string;
  name?: string;
  count: number;
  avg_risk_score?: number;
  severity?: SeverityLevel;
  fp_rate?: number;
  agent_name?: string;
  rule_id?: string;
  rule_description?: string;
  model_name?: string;
  prompt_version?: string;
  risk_score?: number;
}

/** Respuesta normalizada de GET /dashboard/top-sources. */
export interface TopSourcesResponse {
  source_ips?: TopSourceItem[];
  agents?: TopSourceItem[];
  rules?: TopSourceItem[];
}

/** Elemento de tasa de falsos positivos por regla o modelo. */
export interface FpRateItem {
  key?: string;
  rule_id?: string;
  rule_description?: string;
  model_name?: string;
  prompt_version?: string;
  total: number;
  fp: number;
  fp_pct: number;
}

/** GET /dashboard/fp-rate. */
export interface FpRateResponse {
  global_rate?: number;
  total_triaged?: number;
  false_positives?: number;
  by_rule?: FpRateItem[];
  by_model?: FpRateItem[];
}

/** GET /dashboard/sla-compliance. */
export interface SlaComplianceItem {
  severity: SeverityLevel;
  compliant: number;
  total: number;
  compliance: number;
  target?: number;
  avg_seconds?: number;
}

export interface SlaComplianceResponse {
  items?: SlaComplianceItem[];
  by_severity?: Partial<Record<SeverityLevel, number>>;
  period?: DateRange;
}

/** GET /dashboard/analyst-workload (vista v_analyst_workload). */
export interface AnalystWorkloadItem {
  user_id: number;
  username: string;
  full_name?: string;
  abiertas: number;
  escaladas: number;
  cerradas: number;
  mttt_promedio?: number | null;
  total?: number;
}

/** Parámetro común de rango temporal para los widgets. */
export interface DashboardRangeQuery extends DateRange {
  days?: number;
}
