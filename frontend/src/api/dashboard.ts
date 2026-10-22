/**
 * SOC-Lite · API de métricas del dashboard (contrato §6).
 */
import { buildParams, http } from './client';
import type { DateRange } from '@/types/common';
import type {
  AnalystWorkloadItem,
  DashboardSummary,
  FpRateResponse,
  MtttTrendPoint,
  SeveritySeriesPoint,
  SlaComplianceResponse,
  TopSourcesResponse,
} from '@/types/dashboard';

/** Normaliza estructuras que pueden venir envueltas (`{items}`/`{data}`). */
function unwrapArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['items', 'data', 'results', 'series'] as const) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

/** GET /dashboard/summary — KPIs globales del periodo. */
export async function summary(params: DateRange = {}): Promise<DashboardSummary> {
  return http.get<DashboardSummary>('/dashboard/summary', { params: buildParams({ ...params }) });
}

/** GET /dashboard/alerts-by-severity — serie temporal por severidad. */
export async function alertsBySeverity(
  params: DateRange & { granularity?: 'hour' | 'day' | 'week' | 'month' } = {},
): Promise<SeveritySeriesPoint[]> {
  const raw = await http.get<unknown>('/dashboard/alerts-by-severity', {
    params: buildParams({ granularity: 'day', ...params }),
  });
  return unwrapArray<SeveritySeriesPoint>(raw);
}

/** GET /dashboard/mttt-trend — MTTT diario + objetivo SLA. */
export async function mtttTrend(days = 30, params: DateRange = {}): Promise<MtttTrendPoint[]> {
  const raw = await http.get<unknown>('/dashboard/mttt-trend', { params: buildParams({ days, ...params }) });
  return unwrapArray<MtttTrendPoint>(raw);
}

/** GET /dashboard/top-sources — top IPs, agentes y reglas origen. */
export async function topSources(limit = 10, params: DateRange = {}): Promise<TopSourcesResponse> {
  const raw = await http.get<unknown>('/dashboard/top-sources', { params: buildParams({ limit, ...params }) });
  if (Array.isArray(raw)) {
    // Forma alternativa: una única lista de orígenes.
    return { source_ips: raw as TopSourcesResponse['source_ips'] };
  }
  return (raw ?? {}) as TopSourcesResponse;
}

/** GET /dashboard/fp-rate — tasa de FP global, por regla y por modelo. */
export async function fpRate(params: DateRange = {}): Promise<FpRateResponse> {
  const raw = await http.get<unknown>('/dashboard/fp-rate', { params: buildParams({ ...params }) });
  return (raw ?? {}) as FpRateResponse;
}

/** GET /dashboard/sla-compliance — cumplimiento de SLA por severidad. */
export async function slaCompliance(params: DateRange = {}): Promise<SlaComplianceResponse> {
  const raw = await http.get<unknown>('/dashboard/sla-compliance', { params: buildParams({ ...params }) });
  if (Array.isArray(raw)) return { items: raw as SlaComplianceResponse['items'] };
  return (raw ?? {}) as SlaComplianceResponse;
}

/** GET /dashboard/analyst-workload — carga por analista. */
export async function analystWorkload(params: DateRange = {}): Promise<AnalystWorkloadItem[]> {
  const raw = await http.get<unknown>('/dashboard/analyst-workload', { params: buildParams({ ...params }) });
  return unwrapArray<AnalystWorkloadItem>(raw);
}

export const dashboardApi = {
  summary,
  alertsBySeverity,
  mtttTrend,
  topSources,
  fpRate,
  slaCompliance,
  analystWorkload,
};

export default dashboardApi;
