/**
 * SOC-Lite · API de incidentes y acciones de respuesta (contrato §5).
 */
import { buildParams, http } from './client';
import type { Paginated } from '@/types/common';
import type {
  IncidentAction,
  IncidentActionRequest,
  IncidentCreateRequest,
  IncidentDetail,
  IncidentListItem,
  IncidentListQuery,
  IncidentTicket,
  IncidentUpdateRequest,
} from '@/types/incident';

/** GET /incidents — listado paginado con filtros `status`, `priority`, `from`, `to`. */
export async function list(query: IncidentListQuery = {}): Promise<Paginated<IncidentListItem>> {
  return http.getPage<IncidentListItem>('/incidents', { params: buildParams({ ...query }) });
}

/** GET /incidents/{id} — detalle con alertas vinculadas y acciones. */
export async function get(id: number): Promise<IncidentDetail> {
  return http.get<IncidentDetail>(`/incidents/${id}`);
}

/** POST /incidents — creación manual o desde triaje. */
export async function create(payload: IncidentCreateRequest): Promise<IncidentDetail> {
  return http.post<IncidentDetail>('/incidents', payload);
}

/** PUT /incidents/{id} — estado, prioridad y responsables. */
export async function update(id: number, payload: IncidentUpdateRequest): Promise<IncidentDetail> {
  return http.put<IncidentDetail>(`/incidents/${id}`, payload);
}

/** POST /incidents/{id}/alerts — vincula alertas al incidente. */
export async function linkAlerts(id: number, alertIds: number[]): Promise<IncidentDetail> {
  return http.post<IncidentDetail>(`/incidents/${id}/alerts`, { alert_ids: alertIds });
}

/** POST /incidents/{id}/actions — acción de respuesta (contener, aislar, ticket…). */
export async function addAction(id: number, payload: IncidentActionRequest): Promise<IncidentAction> {
  return http.post<IncidentAction>(`/incidents/${id}/actions`, payload);
}

/** GET /incidents/{id}/ticket — ticket externo (osTicket/Redmine) asociado. */
export async function ticket(id: number): Promise<IncidentTicket | null> {
  return http.get<IncidentTicket | null>(`/incidents/${id}/ticket`);
}

/** DELETE /incidents/{id} — cierre/borrado (si el backend lo habilita). */
export async function remove(id: number): Promise<void> {
  await http.del<void>(`/incidents/${id}`);
}

export const incidentsApi = { list, get, create, update, linkAlerts, addAction, ticket, remove };

export default incidentsApi;
