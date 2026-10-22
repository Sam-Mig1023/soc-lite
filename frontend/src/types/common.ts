/**
 * SOC-Lite · Tipos transversales (envelope de paginación, errores, filtros).
 * Alineado con docs/00-contrato-api.md §Paginación y §Errores.
 */

/** Cuerpo de error normalizado del backend. */
export interface ApiError {
  detail: string;
  code?: string;
  trace_id?: string;
  status?: number;
}

/** Envelope de paginación server-side devuelto por todos los listados. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

/** Envelope vacío reutilizable en estados iniciales. */
export const EMPTY_PAGE: Paginated<never> = {
  items: [],
  total: 0,
  page: 1,
  page_size: 25,
  pages: 0,
};

export type SortDir = 'asc' | 'desc';

/** Parámetros de paginación comunes. */
export interface PageParams {
  page?: number;
  page_size?: number;
}

/** Rango temporal ISO-8601 usado por casi todos los filtros. */
export interface DateRange {
  from?: string;
  to?: string;
}

/** Base de toda query de listado. */
export interface ListQuery extends PageParams, DateRange {
  q?: string;
  sort_by?: string;
  sort_dir?: SortDir;
}

/** Opción para `<select>` y menús. */
export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
}

export type Nullable<T> = T | null;

/** Resultado genérico de una mutación. */
export interface MutationResult<T = void> {
  data?: T;
  message?: string;
}

/** Fila de la bitácora de auditoría (contrato §8 / schema.sql audit_log). */
export interface AuditLogEntry {
  id: number;
  occurred_at: string;
  user_id: number | null;
  username: string | null;
  module: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  result: string;
  detail: string | null;
  /** Diff: contrato §8 usa `before` / `after` (schema: before_data/after_data). */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changes: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  http_method: string | null;
  http_path: string | null;
  http_status: number | null;
  duration_ms: number | null;
  trace_id: string | null;
  severity: string;
}

/** Filtros de la bitácora (contrato §8 GET /audit/logs). */
export interface AuditLogQuery extends ListQuery {
  user_id?: number;
  module?: string;
  action?: string;
  result?: string;
  severity?: string;
}

/** Estadísticas de la bitácora (contrato §8 GET /audit/stats). */
export interface AuditStats {
  total?: number;
  by_module: Array<{ module: string; count: number }>;
  by_action: Array<{ action: string; count: number }>;
  by_user: Array<{ user_id: number; username: string; count: number }>;
  by_result?: Array<{ result: string; count: number }>;
}

/** Reporte generado (schema.sql generated_reports). */
export interface GeneratedReport {
  id: number;
  report_type: string;
  report_format: string;
  title: string;
  period_from: string | null;
  period_to: string | null;
  file_path?: string;
  file_size: number | null;
  checksum_sha256?: string | null;
  parameters?: Record<string, unknown>;
  requested_by: number | null;
  requested_by_username?: string | null;
  status: string;
  error?: string | null;
  created_at: string;
  expires_at?: string | null;
}
