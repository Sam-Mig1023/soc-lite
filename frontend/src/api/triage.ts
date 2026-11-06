/**
 * SOC-Lite · API de triaje LLM (contrato §4).
 */
import { buildParams, http } from './client';
import type { Paginated } from '@/types/common';
import type {
  TriageFeedbackRequest,
  TriageResult,
  TriageResultListItem,
  TriageResultsQuery,
  TriageStats,
} from '@/types/alert';

/** POST /triage/{alert_id}/run — fuerza (o re-ejecuta) el triaje con `?force=true`. */
export async function run(alertId: number, force = false): Promise<TriageResult> {
  return http.post<TriageResult>(`/triage/${alertId}/run`, undefined, {
    params: buildParams({ force }),
    // Debe superar el límite del backend (360 s) para recibir la respuesta final.
    timeout: 370000,
  });
}

/** GET /triage/results — listado de triajes con confianza y tokens. */
export async function results(query: TriageResultsQuery = {}): Promise<Paginated<TriageResultListItem>> {
  return http.getPage<TriageResultListItem>('/triage/results', { params: buildParams({ ...query }) });
}

/** GET /triage/{alert_id} — último triaje de la alerta. */
export async function latest(alertId: number): Promise<TriageResult> {
  return http.get<TriageResult>(`/triage/${alertId}`);
}

/** POST /triage/{alert_id}/feedback — etiqueta humana que alimenta la tasa de FP. */
export async function feedback(alertId: number, payload: TriageFeedbackRequest): Promise<TriageResult> {
  return http.post<TriageResult>(`/triage/${alertId}/feedback`, payload);
}

/** GET /triage/stats — precisión, distribución por veredicto y latencias. */
export async function stats(params?: Record<string, string | number | boolean | undefined>): Promise<TriageStats> {
  return http.get<TriageStats>('/triage/stats', { params: buildParams(params) });
}

export const triageApi = { run, results, latest, feedback, stats };

export default triageApi;
