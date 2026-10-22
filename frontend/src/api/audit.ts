/**
 * SOC-Lite · API de la bitácora de auditoría (contrato §8).
 */
import { buildParams, downloadBlob, http } from './client';
import type { DownloadedFile } from './client';
import type { AuditLogEntry, AuditLogQuery, AuditStats, Paginated } from '@/types/common';

/** GET /audit/logs — listado paginado con filtros por usuario/módulo/acción/resultado/fechas. */
export async function logs(query: AuditLogQuery = {}): Promise<Paginated<AuditLogEntry>> {
  return http.getPage<AuditLogEntry>('/audit/logs', { params: buildParams({ ...query }) });
}

/** GET /audit/logs/{id} — detalle con diff `before`/`after`. */
export async function log(id: number): Promise<AuditLogEntry> {
  return http.get<AuditLogEntry>(`/audit/logs/${id}`);
}

/** GET /audit/stats — conteo por módulo/acción/usuario. */
export async function stats(params: AuditLogQuery = {}): Promise<AuditStats> {
  const raw = await http.get<unknown>('/audit/stats', { params: buildParams({ ...params }) });
  const obj = (raw ?? {}) as Record<string, unknown>;
  const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    total: typeof obj.total === 'number' ? obj.total : undefined,
    by_module: asArray<AuditStats['by_module'][number]>(obj.by_module),
    by_action: asArray<AuditStats['by_action'][number]>(obj.by_action),
    by_user: asArray<AuditStats['by_user'][number]>(obj.by_user),
    by_result: asArray<NonNullable<AuditStats['by_result']>[number]>(obj.by_result),
  };
}

/** GET /audit/logs/export — export CSV/XLSX de la bitácora. */
export async function exportLogs(query: AuditLogQuery & { format: 'csv' | 'xlsx' }): Promise<DownloadedFile> {
  const { format, ...rest } = query;
  const stamp = new Date().toISOString().slice(0, 10);
  return downloadBlob(
    '/audit/logs/export',
    { ...rest, format },
    `soc-lite-bitacora-${stamp}.${format}`,
  );
}

export const auditApi = { logs, log, stats, exportLogs };

export default auditApi;
