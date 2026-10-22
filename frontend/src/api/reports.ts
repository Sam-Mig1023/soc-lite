/**
 * SOC-Lite · API de reportes exportables (contrato §7).
 * Las tres rutas de generación devuelven binarios (PDF/DOCX/XLSX/CSV).
 */
import { buildParams, downloadBlob, http } from './client';
import type { DownloadedFile } from './client';
import type { Paginated, GeneratedReport } from '@/types/common';
import type { ReportFormat, ReportType } from '@/types/enums';

/** MIME real de cada formato según el contrato §7. */
export const REPORT_MIME_TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

export const REPORT_EXTENSIONS: Record<ReportFormat, string> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  csv: 'csv',
};

export interface ReportRequestBase {
  from?: string;
  to?: string;
  format: ReportFormat;
}

export interface ManagementReportRequest extends ReportRequestBase {
  period?: 'weekly' | 'monthly' | 'quarterly';
}

function filenameFor(type: ReportType, format: ReportFormat): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `soc-lite-${type}-${stamp}.${REPORT_EXTENSIONS[format]}`;
}

/** GET /reports/operational — volumen, MTTT, top reglas e incidentes. */
export async function generateOperational(req: ReportRequestBase): Promise<DownloadedFile> {
  return downloadBlob(
    '/reports/operational',
    { format: req.format, from: req.from, to: req.to },
    filenameFor('operational', req.format),
  );
}

/** GET /reports/management — riesgo, cumplimiento ISO/NIST y tendencias. */
export async function generateManagement(req: ManagementReportRequest): Promise<DownloadedFile> {
  return downloadBlob(
    '/reports/management',
    { format: req.format, period: req.period ?? 'monthly', from: req.from, to: req.to },
    filenameFor('management', req.format),
  );
}

/** GET /reports/audit — extracto de bitácora (permiso `audit:export`). */
export async function generateAudit(req: ReportRequestBase): Promise<DownloadedFile> {
  return downloadBlob(
    '/reports/audit',
    { format: req.format, from: req.from, to: req.to },
    filenameFor('audit', req.format),
  );
}

/** GET /reports/inventory — historial de reportes generados. */
export async function inventory(
  query: { page?: number; page_size?: number } = {},
): Promise<Paginated<GeneratedReport>> {
  return http.getPage<GeneratedReport>('/reports/inventory', { params: buildParams({ ...query }) });
}

/** GET /reports/{id}/download — descarga del artefacto almacenado. */
export async function download(id: number, format: ReportFormat = 'pdf'): Promise<DownloadedFile> {
  return downloadBlob(`/reports/${id}/download`, undefined, filenameFor('operational', format));
}

export const reportsApi = {
  generateOperational,
  generateManagement,
  generateAudit,
  inventory,
  download,
  REPORT_MIME_TYPES,
  REPORT_EXTENSIONS,
};

export default reportsApi;
