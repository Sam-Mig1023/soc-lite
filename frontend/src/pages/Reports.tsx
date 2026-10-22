/**
 * SOC-Lite · Pantalla de reportes exportables.
 *
 * Permite generar los tres reportes del contrato (§7) en PDF, Word (docx), Excel (xlsx)
 * y CSV, y descargar cualquier artefacto del historial. Toda generación queda registrada
 * en la bitácora de auditoría del backend con acción `EXPORT`.
 *
 * Requisitos cubiertos: "Reportes operacionales y de gestión exportables en PDF, Word y Excel".
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Download,
  FileSpreadsheet,
  FileText,
  FileType,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  DataTable,
  ErrorState,
  FilterField,
  KpiCard,
  Loading,
  PermissionGate,
  DateRangePicker,
  isoFrom,
  isoTo,
  useToast,
} from '@/components';
import type { Column, DateRangeValue } from '@/components';
import { reportsApi } from '@/api/reports';
import { LIST_REFRESH_MS, queryKeys } from '@/api/queryClient';
import { useAuth, usePermission } from '@/context/AuthContext';
import type { GeneratedReport } from '@/types/common';
import type { ReportFormat, ReportType } from '@/types/enums';
import { REPORT_FORMAT_LABELS, REPORT_TYPE_LABELS } from '@/types/enums';
import { getErrorMessage } from '@/utils/errors';
import {
  cx,
  daysAgoIso,
  formatBytes,
  formatDateTime,
  saveBlob,
  shortTrace,
  toIsoDate,
  truncate,
} from '@/utils/format';

/* ------------------------------------------------------------------ */
/* Catálogos                                                           */
/* ------------------------------------------------------------------ */

interface ReportDefinition {
  type: ReportType;
  title: string;
  description: string;
  formats: ReportFormat[];
  /** El reporte de gestión admite un `period` predefinido en lugar de fechas. */
  supportsPeriod?: boolean;
}

const REPORT_DEFINITIONS: ReportDefinition[] = [
  {
    type: 'operational',
    title: 'Reporte operativo SOC',
    description:
      'Volumen de alertas, MTTT/MTTR, top reglas y orígenes, precisión del triaje, incidentes y carga del equipo.',
    formats: ['pdf', 'docx', 'xlsx', 'csv'],
  },
  {
    type: 'management',
    title: 'Reporte gerencial y de cumplimiento',
    description:
      'Riesgo agregado, cumplimiento de SLA y mapeo de controles ISO/IEC 27001:2022 y NIST CSF 2.0.',
    formats: ['pdf', 'docx', 'xlsx'],
    supportsPeriod: true,
  },
  {
    type: 'audit',
    title: 'Extracto de bitácora de auditoría',
    description:
      'Eventos con usuario, fecha, hora, módulo, acción y resultado, más el hash de integridad de cada registro.',
    formats: ['xlsx', 'csv', 'pdf'],
  },
];

const PERIOD_OPTIONS: Array<{ value: 'weekly' | 'monthly' | 'quarterly'; label: string }> = [
  { value: 'weekly', label: 'Semanal (7 días)' },
  { value: 'monthly', label: 'Mensual (30 días)' },
  { value: 'quarterly', label: 'Trimestral (90 días)' },
];

const FORMAT_ICONS: Record<ReportFormat, JSX.Element> = {
  pdf: <FileText size={15} className="text-red-400" aria-hidden="true" />,
  docx: <FileType size={15} className="text-sky-400" aria-hidden="true" />,
  xlsx: <FileSpreadsheet size={15} className="text-emerald-400" aria-hidden="true" />,
  csv: <FileSpreadsheet size={15} className="text-amber-400" aria-hidden="true" />,
};

/* ------------------------------------------------------------------ */
/* Página                                                              */
/* ------------------------------------------------------------------ */

export function Reports(): JSX.Element {
  const toast = useToast();
  const auth = useAuth();
  const queryClient = useQueryClient();

  const canExport = usePermission('reports:export');
  const canExportAudit = usePermission('audit:export');
  const canReadAudit = usePermission('audit:read');

  const [reportType, setReportType] = useState<ReportType>('operational');
  const [format, setFormat] = useState<ReportFormat>('pdf');
  const [period, setPeriod] = useState<'weekly' | 'monthly' | 'quarterly'>('monthly');
  const [range, setRange] = useState<DateRangeValue>(() => ({
    from: daysAgoIso(30),
    to: toIsoDate(new Date()),
  }));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const definition = useMemo(
    () => REPORT_DEFINITIONS.find((item) => item.type === reportType) ?? REPORT_DEFINITIONS[0],
    [reportType],
  );

  /* ---------------------------------------------------------------- */
  /* Historial de reportes generados                                   */
  /* ---------------------------------------------------------------- */
  const inventoryQuery = useQuery({
    queryKey: queryKeys.reports.inventory({ page, page_size: pageSize }),
    queryFn: () => reportsApi.inventory({ page, page_size: pageSize }),
    refetchInterval: LIST_REFRESH_MS,
    staleTime: 15_000,
  });

  const inventory = inventoryQuery.data?.items ?? [];
  const inventoryTotal = inventoryQuery.data?.total ?? 0;

  const inventoryKpis = useMemo(() => {
    const byType = { operational: 0, management: 0, audit: 0 } as Record<string, number>;
    let bytes = 0;
    let last: string | null = null;
    for (const item of inventory) {
      byType[item.report_type] = (byType[item.report_type] ?? 0) + 1;
      bytes += item.file_size ?? 0;
      if (!last || item.created_at > last) last = item.created_at;
    }
    return { byType, bytes, last };
  }, [inventory]);

  /* ---------------------------------------------------------------- */
  /* Generación                                                        */
  /* ---------------------------------------------------------------- */
  const canGenerateSelected = definition.type === 'audit' ? canExportAudit : canExport;

  const generateMutation = useMutation({
    mutationFn: async () => {
      const from = isoFrom(range.from);
      const to = isoTo(range.to);
      if (definition.type === 'operational') {
        return reportsApi.generateOperational({ format, from, to });
      }
      if (definition.type === 'management') {
        return reportsApi.generateManagement({ format, period, from, to });
      }
      return reportsApi.generateAudit({ format, from, to });
    },
    onSuccess: async ({ blob, filename }) => {
      saveBlob(blob, filename);
      toast.success('Reporte generado correctamente', filename);
      await queryClient.invalidateQueries({ queryKey: queryKeys.reports.all() });
    },
    onError: (error: unknown) => {
      toast.error('No se pudo generar el reporte', getErrorMessage(error));
    },
  });

  const downloadMutation = useMutation({
    mutationFn: async (report: GeneratedReport) => {
      const fmt = (report.report_format as ReportFormat) ?? 'pdf';
      return reportsApi.download(report.id, fmt);
    },
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename);
      toast.success('Descarga iniciada', filename);
    },
    onError: (error: unknown) => {
      toast.error('No se pudo descargar el reporte', getErrorMessage(error));
    },
  });

  const handleGenerate = useCallback(() => {
    if (!canGenerateSelected) {
      toast.warning('Permisos insuficientes', 'Tu rol no permite exportar este tipo de reporte.');
      return;
    }
    generateMutation.mutate();
  }, [canGenerateSelected, generateMutation, toast]);

  /* ---------------------------------------------------------------- */
  /* Tabla del historial                                               */
  /* ---------------------------------------------------------------- */
  const columns = useMemo<Array<Column<GeneratedReport>>>(
    () => [
      {
        key: 'created_at',
        header: 'Generado',
        render: (row) => (
          <span className="whitespace-nowrap text-slate-300">{formatDateTime(row.created_at)}</span>
        ),
        getValue: (row) => row.created_at,
      },
      {
        key: 'report_type',
        header: 'Tipo',
        render: (row) => (
          <span className="font-medium text-slate-200">
            {REPORT_TYPE_LABELS[row.report_type as ReportType] ?? row.report_type}
          </span>
        ),
      },
      {
        key: 'report_format',
        header: 'Formato',
        render: (row) => {
          const fmt = row.report_format as ReportFormat;
          return (
            <span className="inline-flex items-center gap-1.5">
              {FORMAT_ICONS[fmt] ?? null}
              <span className="uppercase text-slate-300">{fmt}</span>
            </span>
          );
        },
      },
      {
        key: 'title',
        header: 'Título',
        render: (row) => (
          <span className="text-slate-300" title={row.title}>
            {truncate(row.title, 70)}
          </span>
        ),
      },
      {
        key: 'period',
        header: 'Periodo',
        hideOnMobile: true,
        render: (row) => (
          <span className="whitespace-nowrap text-xs text-slate-400">
            {row.period_from ? formatDateTime(row.period_from).slice(0, 10) : '—'} →{' '}
            {row.period_to ? formatDateTime(row.period_to).slice(0, 10) : '—'}
          </span>
        ),
      },
      {
        key: 'file_size',
        header: 'Tamaño',
        align: 'right',
        hideOnMobile: true,
        render: (row) => <span className="font-mono text-xs text-slate-400">{formatBytes(row.file_size)}</span>,
      },
      {
        key: 'checksum_sha256',
        header: 'Integridad',
        hideOnMobile: true,
        render: (row) =>
          row.checksum_sha256 ? (
            <span className="font-mono text-xs text-emerald-400/80" title={row.checksum_sha256}>
              {shortTrace(row.checksum_sha256, 10)}…
            </span>
          ) : (
            <span className="text-xs text-slate-500">—</span>
          ),
      },
      {
        key: 'actions',
        header: 'Acciones',
        align: 'right',
        render: (row) => (
          <button
            type="button"
            className="soc-btn-ghost px-2 py-1 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              downloadMutation.mutate(row);
            }}
            disabled={downloadMutation.isPending}
            aria-label={`Descargar ${row.title}`}
          >
            {downloadMutation.isPending && downloadMutation.variables?.id === row.id ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Download size={13} aria-hidden="true" />
            )}
            Descargar
          </button>
        ),
      },
    ],
    [downloadMutation],
  );

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <FileText size={20} className="text-cyan-400" aria-hidden="true" />
            Reportes
          </h1>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-400">
            Generación de reportes operativos, gerenciales y de auditoría exportables en PDF, Word (docx),
            Excel (xlsx) y CSV. Cada exportación se registra en la bitácora con acción <code>EXPORT</code>.
          </p>
        </div>
        <button
          type="button"
          className="soc-btn-secondary"
          onClick={() => void inventoryQuery.refetch()}
          disabled={inventoryQuery.isFetching}
        >
          <RefreshCw size={15} className={cx(inventoryQuery.isFetching && 'animate-spin')} aria-hidden="true" />
          Actualizar historial
        </button>
      </header>

      {/* KPIs del historial */}
      <section className="grid gap-4 soc-grid-auto" aria-label="Resumen del historial de reportes">
        <KpiCard
          label="Reportes generados"
          value={inventoryTotal}
          hint="Últimos registrados en el sistema"
          tone="accent"
          icon={<FileText size={16} />}
          loading={inventoryQuery.isLoading}
        />
        <KpiCard
          label="Operativos"
          value={inventoryKpis.byType.operational ?? 0}
          hint="En la página actual"
          tone="default"
          loading={inventoryQuery.isLoading}
        />
        <KpiCard
          label="Gerenciales"
          value={inventoryKpis.byType.management ?? 0}
          hint="En la página actual"
          tone="default"
          loading={inventoryQuery.isLoading}
        />
        <KpiCard
          label="Auditoría"
          value={inventoryKpis.byType.audit ?? 0}
          hint="En la página actual"
          tone="ok"
          icon={<ShieldCheck size={16} />}
          loading={inventoryQuery.isLoading}
        />
        <KpiCard
          label="Volumen total"
          value={formatBytes(inventoryKpis.bytes)}
          hint="Tamaño de los artefactos listados"
          tone="default"
          loading={inventoryQuery.isLoading}
        />
        <KpiCard
          label="Último reporte"
          value={inventoryKpis.last ? formatDateTime(inventoryKpis.last) : '—'}
          hint="Marca temporal de generación"
          tone="default"
          icon={<CalendarClock size={16} />}
          loading={inventoryQuery.isLoading}
        />
      </section>

      {/* Generador */}
      <PermissionGate
        permission={['reports:export', 'audit:export']}
        permissions={auth.permissions ?? []}
        roles={auth.roles}
        fallback={
          <section className="soc-panel p-4 text-sm text-slate-400">
            Tu rol no incluye permisos de exportación (<code>reports:export</code> /{' '}
            <code>audit:export</code>). Puedes consultar el historial, pero no generar ni descargar
            artefactos.
          </section>
        }
      >
        <section className="soc-panel p-4" aria-label="Generador de reportes">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Generar nuevo reporte
          </h2>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <FilterField label="Tipo de reporte" htmlFor="report-type">
              <select
                id="report-type"
                className="soc-input"
                value={reportType}
                onChange={(event) => {
                  const next = event.target.value as ReportType;
                  setReportType(next);
                  const nextDef = REPORT_DEFINITIONS.find((item) => item.type === next);
                  if (nextDef && !nextDef.formats.includes(format)) {
                    setFormat(nextDef.formats[0]);
                  }
                }}
              >
                {REPORT_DEFINITIONS.map((item) => (
                  <option key={item.type} value={item.type}>
                    {REPORT_TYPE_LABELS[item.type]}
                  </option>
                ))}
              </select>
            </FilterField>

            <FilterField label="Formato de salida" htmlFor="report-format">
              <select
                id="report-format"
                className="soc-input"
                value={format}
                onChange={(event) => setFormat(event.target.value as ReportFormat)}
              >
                {definition.formats.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {REPORT_FORMAT_LABELS[fmt]}
                  </option>
                ))}
              </select>
            </FilterField>

            {definition.supportsPeriod ? (
              <FilterField label="Periodicidad" htmlFor="report-period">
                <select
                  id="report-period"
                  className="soc-input"
                  value={period}
                  onChange={(event) =>
                    setPeriod(event.target.value as 'weekly' | 'monthly' | 'quarterly')
                  }
                >
                  {PERIOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </FilterField>
            ) : null}

            <DateRangePicker value={range} onChange={setRange} label="Rango del reporte" />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <p className="max-w-2xl text-xs text-slate-400">{definition.description}</p>
            <div className="flex items-center gap-2">
              {!canGenerateSelected ? (
                <span className="text-xs text-amber-400">
                  Falta el permiso {definition.type === 'audit' ? 'audit:export' : 'reports:export'}
                </span>
              ) : null}
              <button
                type="button"
                className="soc-btn-primary"
                onClick={handleGenerate}
                disabled={generateMutation.isPending || !canGenerateSelected}
              >
                {generateMutation.isPending ? (
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download size={15} aria-hidden="true" />
                )}
                Generar y descargar
              </button>
            </div>
          </div>
        </section>
      </PermissionGate>

      {/* Historial */}
      <section aria-label="Historial de reportes generados">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-200">Historial de reportes generados</h2>
          {canReadAudit ? (
            <span className="text-xs text-slate-500">
              Los metadatos incluyen el checksum sha256 para verificación de integridad.
            </span>
          ) : null}
        </div>

        {inventoryQuery.isError ? (
          <ErrorState
            message={getErrorMessage(inventoryQuery.error)}
            onRetry={() => void inventoryQuery.refetch()}
          />
        ) : inventoryQuery.isLoading ? (
          <Loading label="Cargando historial de reportes…" />
        ) : (
          <DataTable<GeneratedReport>
            columns={columns}
            data={inventory}
            rowKey="id"
            page={page}
            pageSize={pageSize}
            total={inventoryTotal}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            emptyTitle="Todavía no se han generado reportes"
            emptyDescription="Usa el generador para crear el primer reporte operativo, gerencial o de auditoría."
            caption="Historial de reportes generados por SOC-Lite"
          />
        )}
      </section>
    </div>
  );
}

export default Reports;
