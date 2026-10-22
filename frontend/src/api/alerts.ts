/**
 * SOC-Lite · API de alertas (contrato §3).
 */
import { buildParams, http } from './client';
import type { Paginated } from '@/types/common';
import type {
  AlertDetail,
  AlertListItem,
  AlertListQuery,
  AlertUpdateRequest,
  BulkStatusRequest,
  EnrichmentRecord,
  TimelineEvent,
} from '@/types/alert';

/** GET /alerts — listado paginado con todos los filtros del contrato. */
export async function list(query: AlertListQuery = {}): Promise<Paginated<AlertListItem>> {
  return http.getPage<AlertListItem>('/alerts', { params: buildParams({ ...query }) });
}

/** GET /alerts/{id} — detalle con enriquecimiento, triaje, incidente y timeline. */
export async function get(id: number): Promise<AlertDetail> {
  return http.get<AlertDetail>(`/alerts/${id}`);
}

/** PATCH /alerts/{id} — cambio de estado, asignación o notas. */
export async function update(id: number, payload: AlertUpdateRequest): Promise<AlertDetail> {
  return http.patch<AlertDetail>(`/alerts/${id}`, payload);
}

/** POST /alerts/bulk/status — cambio masivo de estado. */
export async function bulkStatus(payload: BulkStatusRequest): Promise<{ updated: number }> {
  return http.post<{ updated: number }>('/alerts/bulk/status', payload);
}

/** GET /alerts/{id}/enrichment — indicadores consultados (VT, AbuseIPDB, GeoIP…). */
export async function enrichment(id: number): Promise<EnrichmentRecord[]> {
  return http.get<EnrichmentRecord[]>(`/alerts/${id}/enrichment`);
}

/** GET /alerts/{id}/timeline — eventos ordenados de la alerta. */
export async function timeline(id: number): Promise<TimelineEvent[]> {
  return http.get<TimelineEvent[]>(`/alerts/${id}/timeline`);
}

/** DELETE /alerts/{id} — borrado lógico. */
export async function remove(id: number): Promise<void> {
  await http.del<void>(`/alerts/${id}`);
}

export const alertsApi = { list, get, update, bulkStatus, enrichment, timeline, remove };

export default alertsApi;
