/**
 * SOC-Lite · Tipos de incidentes y acciones de respuesta.
 * Contrato: docs/00-contrato-api.md §5. Esquema: db/schema.sql incidents/incident_alerts/incident_actions.
 */
import type { PageParams, DateRange } from './common';
import type { AlertListItem } from './alert';
import type { IncidentStatus, Priority, SeverityLevel } from './enums';

export interface IncidentListItem {
  id: number;
  incident_code: string;
  title: string;
  description?: string | null;
  status: IncidentStatus;
  priority: Priority;
  severity: SeverityLevel;
  category?: string | null;
  mitre_tactics?: string[];
  detected_at: string;
  contained_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  owner_id: number | null;
  owner_username?: string | null;
  external_ticket_id?: string | null;
  external_ticket_url?: string | null;
  alerts_count?: number;
  created_by?: number | null;
  created_at: string;
  updated_at: string;
}

/** Acción de respuesta (incident_actions). */
export interface IncidentAction {
  id: number;
  incident_id: number;
  action_type: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  automated: boolean;
  performed_by: number | null;
  performed_by_username?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  result?: Record<string, unknown>;
  created_at: string;
}

/** Ticket externo asociado (GET /incidents/{id}/ticket). */
export interface IncidentTicket {
  id?: number | string;
  incident_id?: number;
  external_ticket_id?: string | null;
  external_ticket_url?: string | null;
  provider?: string | null;
  status?: string | null;
  created_at?: string | null;
}

/** Detalle completo GET /incidents/{id}. */
export interface IncidentDetail extends IncidentListItem {
  alerts?: AlertListItem[];
  actions?: IncidentAction[];
  owner?: { id: number; username: string; full_name: string } | null;
  ticket?: IncidentTicket | null;
  impact?: string | null;
  root_cause?: string | null;
  lessons_learned?: string | null;
}

export interface IncidentListQuery extends PageParams, DateRange {
  status?: IncidentStatus;
  priority?: Priority;
  q?: string;
  owner_id?: number;
}

export interface IncidentCreateRequest {
  title: string;
  description?: string;
  priority: Priority;
  severity: SeverityLevel;
  category?: string;
  owner_id?: number | null;
  alert_ids?: number[];
  detected_at?: string;
}

export interface IncidentUpdateRequest {
  title?: string;
  description?: string;
  status?: IncidentStatus;
  priority?: Priority;
  severity?: SeverityLevel;
  category?: string;
  owner_id?: number | null;
  impact?: string;
  root_cause?: string;
  lessons_learned?: string;
}

/** POST /incidents/{id}/actions. */
export interface IncidentActionRequest {
  action_type: string;
  description: string;
  automated?: boolean;
}

/** Catálogo de tipos de acción de respuesta (schema: isolate_host|block_ip|...). */
export const INCIDENT_ACTION_TYPES = [
  'isolate_host',
  'block_ip',
  'reset_credentials',
  'ticket',
  'notify',
  'forensics',
] as const;

export const INCIDENT_ACTION_TYPE_LABELS: Record<string, string> = {
  isolate_host: 'Aislar host',
  block_ip: 'Bloquear IP',
  reset_credentials: 'Restablecer credenciales',
  ticket: 'Crear ticket',
  notify: 'Notificar',
  forensics: 'Análisis forense',
};

export const INCIDENT_CATEGORIES = [
  'malware',
  'intrusion',
  'phishing',
  'dos',
  'insider',
  'other',
] as const;

export const INCIDENT_CATEGORY_LABELS: Record<string, string> = {
  malware: 'Malware',
  intrusion: 'Intrusión',
  phishing: 'Phishing',
  dos: 'Denegación de servicio',
  insider: 'Amenaza interna',
  other: 'Otra',
};
