/**
 * SOC-Lite · Bitácora de auditoría (solo lectura, rastro inmutable).
 * Filtros por usuario/módulo/acción/resultado/severidad/fechas, vista de diff
 * antes/después en modal, contadores por módulo y exportación CSV/XLSX.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSearch, Fingerprint, History, ScrollText, ShieldAlert } from 'lucide-react';
import { auditApi } from '@/api/audit';
import { LIST_REFRESH_MS, queryKeys } from '@/api/queryClient';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, FilterField } from '@/components/FilterBar';
import { DateRangePicker, isoFrom, isoTo, type DateRangeValue } from '@/components/DateRangePicker';
import { AuditResultBadge } from '@/components/Badges';
import { Modal } from '@/components/Modal';
import { EmptyState, Skeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import type { AuditLogEntry } from '@/types/common';
import { AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_RESULTS } from '@/types/enums';
import { getErrorMessage } from '@/utils/errors';
import { cx, formatDateTime, formatRelative, humanizeAction, saveBlob, shortTrace, truncate } from '@/utils/format';

const PAGE_SIZE_DEFAULT = 50;

const SEVERITY_CLASSES: Record<string, string> = {
  info: 'border-slate-700 bg-slate-800/60 text-slate-300',
  warning: 'border-amber-700 bg-amber-950/40 text-amber-300',
  critical: 'border-red-700 bg-red-950/40 text-red-300',
};

const MODULE_LABELS: Record<string, string> = {
  auth: 'Autenticación',
  users: 'Usuarios',
  roles: 'Roles',
  alerts: 'Alertas',
  triage: 'Triaje',
  incidents: 'Incidentes',
  dashboard: 'Dashboard',
  reports: 'Reportes',
  audit: 'Auditoría',
  settings: 'Configuración',
  integrations: 'Integraciones',
};

/** Compara dos objetos planos y devuelve las claves cuyo valor cambió. */
function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  if (!before && !after) return [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => JSON.stringify((before ?? {})[key]) !== JSON.stringify((after ?? {})[key]));
}

/** Renderiza un valor JSON de forma legible. */
function renderValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Página de bitácora de auditoría. */
export function AuditLog(): JSX.Element {
  const { permissions } = useAuth();
  const toast = useToast();

  const canExport = Boolean(permissions?.includes('*') || permissions?.includes('audit:export'));

  const [filters, setFilters] = useState<{
    module: string;
    action: string;
    result: string;
    severity: string;
    q: string;
    range: DateRangeValue;
  }>({ module: '', action: '', result: '', severity: '', q: '', range: { from: '', to: '' } });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' }>({ by: 'occurred_at', dir: 'desc' });
  const [detail, setDetail] = useState<AuditLogEntry | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(
    () => ({
      page,
      page_size: pageSize,
      module: filters.module || undefined,
      action: filters.action || undefined,
      result: filters.result || undefined,
      severity: filters.severity || undefined,
      q: filters.q || undefined,
      from: isoFrom(filters.range.from),
      to: isoTo(filters.range.to),
      sort_by: sort.by,
      sort_dir: sort.dir,
    }),
    [page, pageSize, filters, sort],
  );

  const logsQuery = useQuery({
    queryKey: queryKeys.audit.logs(query),
    queryFn: () => auditApi.logs(query),
    refetchInterval: LIST_REFRESH_MS,
    placeholderData: (previous) => previous,
  });

  const statsQuery = useQuery({
    queryKey: queryKeys.audit.stats({}),
    queryFn: () => auditApi.stats({}),
    staleTime: 5 * 60_000,
  });

  const handleExport = async (format: 'csv' | 'xlsx'): Promise<void> => {
    setExporting(true);
    try {
      const { blob, filename } = await auditApi.exportLogs({ ...query, format });
      saveBlob(blob, filename);
      toast.success(`Bitácora exportada en ${format.toUpperCase()}`, filename);
    } catch (error) {
      toast.error('No se pudo exportar la bitácora', getErrorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const activeCount = [
    filters.module,
    filters.action,
    filters.result,
    filters.severity,
    filters.q,
    filters.range.from,
  ].filter(Boolean).length;

  const columns: Array<Column<AuditLogEntry>> = [
    {
      key: 'occurred_at',
      header: 'Fecha y hora',
      sortable: true,
      width: '165px',
      render: (row) => (
        <div>
          <p className="font-mono text-xs text-slate-200">{formatDateTime(row.occurred_at)}</p>
          <p className="text-[10px] text-slate-500">{formatRelative(row.occurred_at)}</p>
        </div>
      ),
    },
    {
      key: 'username',
      header: 'Usuario',
      sortable: true,
      width: '140px',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-200">{row.username ?? 'sistema'}</p>
          {row.user_id ? <p className="font-mono text-[10px] text-slate-500">id {row.user_id}</p> : null}
        </div>
      ),
    },
    {
      key: 'module',
      header: 'Módulo',
      sortable: true,
      width: '130px',
      render: (row) => (
        <span className="soc-badge border-slate-700 bg-slate-800/60 font-mono text-slate-300">
          {MODULE_LABELS[row.module] ?? row.module}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Acción',
      sortable: true,
      width: '160px',
      render: (row) => (
        <span className="text-xs text-slate-300" title={row.action}>
          {humanizeAction(row.action)}
        </span>
      ),
    },
    {
      key: 'entity_id',
      header: 'Entidad',
      hideOnMobile: true,
      width: '150px',
      render: (row) => (
        <span className="font-mono text-xs text-slate-400">
          {row.entity ? `${row.entity}#${row.entity_id ?? ''}` : (row.entity_id ?? '—')}
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Resultado',
      sortable: true,
      width: '110px',
      render: (row) => <AuditResultBadge result={row.result} />,
    },
    {
      key: 'severity',
      header: 'Severidad',
      width: '110px',
      hideOnMobile: true,
      render: (row) => (
        <span className={cx('soc-badge', SEVERITY_CLASSES[row.severity] ?? SEVERITY_CLASSES.info)}>
          {row.severity}
        </span>
      ),
    },
    {
      key: 'detail',
      header: 'Detalle',
      hideOnMobile: true,
      render: (row) => (
        <span className="text-xs text-slate-400" title={row.detail ?? ''}>
          {truncate(row.detail, 60)}
        </span>
      ),
    },
    {
      key: 'ip_address',
      header: 'Origen',
      hideOnMobile: true,
      width: '130px',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-mono text-xs text-slate-300">{row.ip_address ?? '—'}</p>
          <p className="font-mono text-[10px] text-slate-600" title={row.trace_id ?? ''}>
            {shortTrace(row.trace_id)}
          </p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '60px',
      align: 'center',
      render: (row) => (
        <button
          type="button"
          className="soc-btn-ghost px-2 py-1 text-xs"
          onClick={() => setDetail(row)}
          aria-label={`Ver diff del evento ${row.id}`}
          title="Ver diff antes/después"
        >
          <FileSearch size={14} aria-hidden="true" />
        </button>
      ),
    },
  ];

  const diffKeys = detail ? changedKeys(detail.before, detail.after) : [];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <ScrollText size={20} className="text-cyan-400" aria-hidden="true" />
            Bitácora de auditoría
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Rastro inmutable con encadenamiento de hash (ISO/IEC 27001 A.8.15)
            {logsQuery.data ? ` · ${logsQuery.data.total.toLocaleString('es-CL')} eventos` : ''}
          </p>
        </div>
        <button
          type="button"
          className="soc-btn-secondary"
          disabled={!canExport || exporting}
          title={canExport ? undefined : 'Necesitas el permiso audit:export'}
          onClick={() => void handleExport('xlsx')}
        >
          <Download size={15} aria-hidden="true" />
          {exporting ? 'Exportando…' : 'Exportar XLSX'}
        </button>
      </header>

      {/* Contadores por módulo y acción */}
      {statsQuery.data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="soc-panel p-4">
            <h2 className="soc-panel-title mb-2">Eventos por módulo</h2>
            <ul className="space-y-1.5">
              {statsQuery.data.by_module.slice(0, 8).map((item) => {
                const max = Math.max(...statsQuery.data.by_module.map((entry) => entry.count), 1);
                return (
                  <li key={item.module} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 truncate text-slate-400" title={item.module}>
                      {MODULE_LABELS[item.module] ?? item.module}
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <span
                        className="block h-full rounded-full bg-cyan-500"
                        style={{ width: `${Math.round((item.count / max) * 100)}%` }}
                      />
                    </span>
                    <span className="w-12 shrink-0 text-right font-mono text-slate-300">{item.count}</span>
                  </li>
                );
              })}
              {statsQuery.data.by_module.length === 0 ? (
                <li className="text-xs text-slate-500">Sin datos de módulos.</li>
              ) : null}
            </ul>
          </section>

          <section className="soc-panel p-4">
            <h2 className="soc-panel-title mb-2">Eventos por acción</h2>
            <ul className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3">
              {statsQuery.data.by_action.slice(0, 12).map((item) => (
                <li
                  key={item.action}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5"
                >
                  <span className="truncate text-slate-400">{humanizeAction(item.action)}</span>
                  <span className="font-mono text-slate-200">{item.count}</span>
                </li>
              ))}
              {statsQuery.data.by_action.length === 0 ? (
                <li className="text-slate-500">Sin datos de acciones.</li>
              ) : null}
            </ul>
          </section>
        </div>
      ) : statsQuery.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}

      <FilterBar
        columns={5}
        activeCount={activeCount}
        onReset={() => {
          setFilters({ module: '', action: '', result: '', severity: '', q: '', range: { from: '', to: '' } });
          setPage(1);
        }}
        searchValue={filters.q}
        onSearchChange={(value) => {
          setFilters((current) => ({ ...current, q: value }));
          setPage(1);
        }}
        searchPlaceholder="Buscar en detalle, entidad, IP o trace_id…"
      >
        <FilterField label="Módulo" htmlFor="audit-module">
          <select
            id="audit-module"
            className="soc-input"
            value={filters.module}
            onChange={(event) => {
              setFilters({ ...filters, module: event.target.value });
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {AUDIT_MODULES.map((module) => (
              <option key={module} value={module}>
                {MODULE_LABELS[module] ?? module}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Acción" htmlFor="audit-action">
          <select
            id="audit-action"
            className="soc-input"
            value={filters.action}
            onChange={(event) => {
              setFilters({ ...filters, action: event.target.value });
              setPage(1);
            }}
          >
            <option value="">Todas</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {humanizeAction(action)}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Resultado" htmlFor="audit-result">
          <select
            id="audit-result"
            className="soc-input"
            value={filters.result}
            onChange={(event) => {
              setFilters({ ...filters, result: event.target.value });
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {AUDIT_RESULTS.map((result) => (
              <option key={result} value={result}>
                {result}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Severidad" htmlFor="audit-severity">
          <select
            id="audit-severity"
            className="soc-input"
            value={filters.severity}
            onChange={(event) => {
              setFilters({ ...filters, severity: event.target.value });
              setPage(1);
            }}
          >
            <option value="">Todas</option>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </FilterField>

        <FilterField label="Rango de fechas" htmlFor="audit-range">
          <div id="audit-range">
            <DateRangePicker
              value={filters.range}
              presets={[1, 7, 30, 90]}
              onChange={(value) => {
                setFilters({ ...filters, range: value });
                setPage(1);
              }}
            />
          </div>
        </FilterField>
      </FilterBar>

      <div className="soc-panel overflow-hidden">
        <DataTable<AuditLogEntry>
          columns={columns}
          data={logsQuery.data?.items ?? []}
          rowKey="id"
          loading={logsQuery.isPending || logsQuery.isFetching}
          error={logsQuery.isError ? getErrorMessage(logsQuery.error) : null}
          onRetry={() => void logsQuery.refetch()}
          sortBy={sort.by}
          sortDir={sort.dir}
          onSortChange={(by, dir) => setSort({ by, dir })}
          page={logsQuery.data?.page ?? page}
          pageSize={pageSize}
          total={logsQuery.data?.total}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          emptyTitle="Sin eventos de auditoría"
          emptyDescription="Ningún evento coincide con los filtros aplicados."
          caption="Bitácora de auditoría paginada"
        />
      </div>

      {/* Modal de detalle con diff */}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={`Evento #${detail?.id ?? ''} · ${humanizeAction(detail?.action)}`}
        description={detail ? `${formatDateTime(detail.occurred_at)} · ${detail.username ?? 'sistema'}` : undefined}
        size="xl"
        footer={
          <button type="button" className="soc-btn-secondary" onClick={() => setDetail(null)}>
            Cerrar
          </button>
        }
      >
        {detail ? (
          <div className="space-y-4">
            {/* Ficha del evento (esquema obligatorio del contrato §8) */}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              {[
                { label: 'Usuario', value: `${detail.username ?? 'sistema'}${detail.user_id ? ` (#${detail.user_id})` : ''}` },
                { label: 'Fecha y hora', value: formatDateTime(detail.occurred_at) },
                { label: 'Módulo', value: MODULE_LABELS[detail.module] ?? detail.module },
                { label: 'Acción', value: `${detail.action} · ${humanizeAction(detail.action)}` },
                { label: 'Resultado', value: detail.result },
                { label: 'Severidad', value: detail.severity },
                { label: 'Entidad', value: detail.entity ? `${detail.entity}#${detail.entity_id ?? ''}` : (detail.entity_id ?? '—') },
                { label: 'Dirección IP', value: detail.ip_address ?? '—' },
                { label: 'Duración', value: detail.duration_ms !== null ? `${detail.duration_ms} ms` : '—' },
                { label: 'Petición HTTP', value: `${detail.http_method ?? ''} ${detail.http_path ?? ''}`.trim() || '—' },
                { label: 'Estado HTTP', value: detail.http_status !== null ? String(detail.http_status) : '—' },
                { label: 'Trace ID', value: detail.trace_id ?? '—' },
              ].map((item) => (
                <div key={item.label} className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</dt>
                  <dd className="truncate font-mono text-xs text-slate-200" title={item.value}>
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
                <Fingerprint size={12} aria-hidden="true" />
                User-Agent
              </p>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">{detail.user_agent ?? '—'}</p>
            </div>

            {detail.detail ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Detalle</p>
                <p className="mt-1 text-sm text-slate-300">{detail.detail}</p>
              </div>
            ) : null}

            {/* Diff antes/después */}
            <div>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <History size={13} aria-hidden="true" />
                Diff antes / después
                {diffKeys.length > 0 ? (
                  <span className="rounded-full border border-cyan-800 bg-cyan-950/50 px-2 py-0.5 text-[10px] font-normal text-cyan-300">
                    {diffKeys.length} campo(s) modificado(s)
                  </span>
                ) : null}
              </h3>

              {!detail.before && !detail.after ? (
                <EmptyState
                  title="Sin diff registrado"
                  description="Este evento no contiene cambios estructurados (before/after)."
                  icon={<ShieldAlert size={20} />}
                />
              ) : (
                <div className="soc-scroll-x">
                  <table className="soc-table min-w-[640px]">
                    <thead>
                      <tr>
                        <th className="soc-th w-48">Campo</th>
                        <th className="soc-th">Antes</th>
                        <th className="soc-th">Después</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(diffKeys.length > 0
                        ? diffKeys
                        : [...new Set([...Object.keys(detail.before ?? {}), ...Object.keys(detail.after ?? {})])]
                      ).map((key) => {
                        const before = renderValue((detail.before ?? {})[key]);
                        const after = renderValue((detail.after ?? {})[key]);
                        const changed = before !== after;
                        return (
                          <tr key={key} className={changed ? 'bg-amber-950/10' : undefined}>
                            <td className="soc-td font-mono text-xs text-slate-400">{key}</td>
                            <td className={cx('soc-td font-mono text-xs', changed ? 'text-red-300' : 'text-slate-400')}>
                              {before}
                            </td>
                            <td className={cx('soc-td font-mono text-xs', changed ? 'text-emerald-300' : 'text-slate-400')}>
                              {after}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {detail.changes && Object.keys(detail.changes).length > 0 ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-400 hover:text-cyan-300">
                    Diff calculado por el backend (JSON)
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-400">
                    {JSON.stringify(detail.changes, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>

            {detail.before || detail.after ? (
              <details>
                <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-400 hover:text-cyan-300">
                  Payload completo (before / after)
                </summary>
                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-red-200">
                    {JSON.stringify(detail.before ?? {}, null, 2)}
                  </pre>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-emerald-200">
                    {JSON.stringify(detail.after ?? {}, null, 2)}
                  </pre>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default AuditLog;
