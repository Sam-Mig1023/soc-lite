/**
 * SOC-Lite · Listado de alertas.
 * Filtros (severidad, estado, origen, fechas, búsqueda, riesgo mínimo), paginación y
 * ordenamiento server-side, selección múltiple y acción masiva de cambio de estado.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { BellRing, Download, ExternalLink, ShieldCheck, Zap } from 'lucide-react';
import { alertsApi } from '@/api/alerts';
import { reportsApi } from '@/api/reports';
import { LIST_REFRESH_MS, queryKeys } from '@/api/queryClient';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, FilterField } from '@/components/FilterBar';
import { DateRangePicker, isoFrom, isoTo, type DateRangeValue } from '@/components/DateRangePicker';
import { RiskScore, SeverityBadge, SourceTypeBadge, StatusBadge, VerdictBadge } from '@/components/Badges';
import { ConfirmDialog } from '@/components/Modal';
import { ExportMenu } from '@/components/ExportMenu';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import type { AlertListItem } from '@/types/alert';
import {
  ALERT_STATUSES,
  ALERT_STATUS_LABELS,
  SEVERITY_LEVELS,
  SEVERITY_LABELS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  type AlertStatus,
  type SeverityLevel,
  type SourceType,
} from '@/types/enums';
import { getErrorMessage } from '@/utils/errors';
import { debounce, formatDateTime, formatDuration, formatRelative, truncate } from '@/utils/format';

const PAGE_SIZE_DEFAULT = 25;

interface FiltersState {
  severity: string;
  status: string;
  sourceType: string;
  minRisk: string;
  q: string;
  range: DateRangeValue;
}

/** Listado de alertas con filtros y acciones masivas. */
export function Alerts(): JSX.Element {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [filters, setFilters] = useState<FiltersState>(() => ({
    severity: searchParams.get('severity') ?? '',
    status: searchParams.get('status') ?? '',
    sourceType: searchParams.get('source_type') ?? '',
    minRisk: searchParams.get('min_risk_score') ?? '',
    q: searchParams.get('q') ?? '',
    range: { from: searchParams.get('from') ?? '', to: searchParams.get('to') ?? '' },
  }));
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const [page, setPage] = useState(Number(searchParams.get('page') ?? 1));
  const [pageSize, setPageSize] = useState(Number(searchParams.get('page_size') ?? PAGE_SIZE_DEFAULT));
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' }>({
    by: searchParams.get('sort_by') ?? 'risk_score',
    dir: (searchParams.get('sort_dir') as 'asc' | 'desc') ?? 'desc',
  });
  const [selected, setSelected] = useState<Array<string | number>>([]);
  const [bulkStatus, setBulkStatus] = useState<AlertStatus | null>(null);

  const canWrite = Boolean(permissions?.includes('*') || permissions?.includes('alerts:write'));
  const canExport = Boolean(permissions?.includes('*') || permissions?.includes('reports:export'));

  /** Sincroniza el estado de filtros con el querystring (compartible/enlazable). */
  const syncUrl = useCallback(
    (next: { filters?: FiltersState; page?: number; pageSize?: number; sort?: { by: string; dir: 'asc' | 'desc' } }) => {
      const f = next.filters ?? filters;
      const p = next.page ?? page;
      const ps = next.pageSize ?? pageSize;
      const s = next.sort ?? sort;
      const params: Record<string, string> = {};
      if (f.severity) params.severity = f.severity;
      if (f.status) params.status = f.status;
      if (f.sourceType) params.source_type = f.sourceType;
      if (f.minRisk) params.min_risk_score = f.minRisk;
      if (f.q) params.q = f.q;
      if (f.range.from) params.from = f.range.from;
      if (f.range.to) params.to = f.range.to;
      if (p > 1) params.page = String(p);
      if (ps !== PAGE_SIZE_DEFAULT) params.page_size = String(ps);
      if (s.by !== 'risk_score' || s.dir !== 'desc') {
        params.sort_by = s.by;
        params.sort_dir = s.dir;
      }
      setSearchParams(params, { replace: true });
    },
    [filters, page, pageSize, setSearchParams, sort],
  );

  const query = useMemo(
    () => ({
      page,
      page_size: pageSize,
      severity: (filters.severity || undefined) as SeverityLevel | undefined,
      status: (filters.status || undefined) as AlertStatus | undefined,
      source_type: (filters.sourceType || undefined) as SourceType | undefined,
      min_risk_score: filters.minRisk ? Number(filters.minRisk) : undefined,
      q: filters.q || undefined,
      from: isoFrom(filters.range.from),
      to: isoTo(filters.range.to),
      sort_by: sort.by,
      sort_dir: sort.dir,
    }),
    [page, pageSize, filters, sort],
  );

  const alertsQuery = useQuery({
    queryKey: queryKeys.alerts.list(query),
    queryFn: () => alertsApi.list(query),
    refetchInterval: LIST_REFRESH_MS,
    placeholderData: (previous) => previous,
  });

  const bulkMutation = useMutation({
    mutationFn: (payload: { ids: number[]; status: AlertStatus }) => alertsApi.bulkStatus(payload),
    onSuccess: (result, variables) => {
      toast.success(
        'Estado actualizado',
        `${variables.ids.length} alerta(s) marcadas como ${ALERT_STATUS_LABELS[variables.status]}.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.alerts.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
      setSelected([]);
      setBulkStatus(null);
      void result;
    },
    onError: (error) => {
      toast.error('No se pudo aplicar el cambio masivo', getErrorMessage(error));
    },
  });

  /* Cambio de filtros: vuelve a la página 1 */
  const updateFilters = (patch: Partial<FiltersState>): void => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setPage(1);
    syncUrl({ filters: next, page: 1 });
  };

  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setFilters((current) => {
          const next = { ...current, q: value };
          syncUrl({ filters: next, page: 1 });
          return next;
        });
        setPage(1);
      }, 400),
    [syncUrl],
  );

  const handleSortChange = (by: string, dir: 'asc' | 'desc'): void => {
    const next = { by, dir };
    setSort(next);
    syncUrl({ sort: next });
  };

  const resetFilters = (): void => {
    const empty: FiltersState = { severity: '', status: '', sourceType: '', minRisk: '', q: '', range: { from: '', to: '' } };
    setFilters(empty);
    setSearchDraft('');
    setPage(1);
    syncUrl({ filters: empty, page: 1 });
  };

  const activeCount = useMemo(
    () =>
      [filters.severity, filters.status, filters.sourceType, filters.minRisk, filters.q, filters.range.from]
        .filter(Boolean).length,
    [filters],
  );

  const selectedIds = useMemo(() => selected.map((key) => Number(key)).filter((id) => Number.isFinite(id)), [selected]);
  const rows = alertsQuery.data?.items ?? [];

  const columns: Array<Column<AlertListItem>> = [
    {
      key: 'id',
      header: 'ID',
      width: '86px',
      sortable: true,
      getValue: (row) => row.id,
      render: (row) => (
        <Link to={`/alerts/${row.id}`} className="font-mono text-xs text-cyan-400 hover:text-cyan-300 hover:underline">
          #{row.id}
        </Link>
      ),
    },
    {
      key: 'severity',
      header: 'Severidad',
      sortable: true,
      width: '110px',
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    {
      key: 'status',
      header: 'Estado',
      sortable: true,
      width: '120px',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'risk_score',
      header: 'Riesgo',
      sortable: true,
      width: '110px',
      render: (row) => <RiskScore score={row.risk_score} />,
    },
    {
      key: 'rule_description',
      header: 'Regla',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-200" title={row.rule_description ?? ''}>
            {truncate(row.rule_description, 70)}
          </p>
          <p className="font-mono text-[11px] text-slate-500">
            {row.rule_id ? `rule ${row.rule_id}` : 'sin regla'}
            {row.rule_groups && row.rule_groups.length > 0 ? ` · ${row.rule_groups.slice(0, 2).join(', ')}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'source_type',
      header: 'Origen',
      sortable: true,
      width: '110px',
      render: (row) => (
        <div className="flex flex-col gap-1">
          <SourceTypeBadge source={row.source_type} />
          <span className="truncate font-mono text-[11px] text-slate-500" title={row.agent_name ?? ''}>
            {row.agent_name ?? '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'source_ip',
      header: 'IP origen → destino',
      hideOnMobile: true,
      render: (row) => (
        <span className="font-mono text-xs text-slate-300">
          {row.source_ip ?? '—'}
          <span className="mx-1 text-slate-600">→</span>
          {row.dest_ip ?? '—'}
        </span>
      ),
    },
    {
      key: 'verdict',
      header: 'Veredicto',
      width: '150px',
      hideOnMobile: true,
      render: (row) => <VerdictBadge verdict={row.verdict} />,
    },
    {
      key: 'occurred_at',
      header: 'Ocurrió',
      sortable: true,
      width: '140px',
      render: (row) => (
        <div>
          <p className="text-xs text-slate-300" title={formatDateTime(row.occurred_at)}>
            {formatRelative(row.occurred_at)}
          </p>
          <p className="font-mono text-[10px] text-slate-500">{formatDateTime(row.occurred_at).slice(0, 16)}</p>
        </div>
      ),
    },
    {
      key: 'mttt_seconds',
      header: 'MTTT',
      sortable: true,
      width: '90px',
      hideOnMobile: true,
      render: (row) => <span className="font-mono text-xs text-slate-400">{formatDuration(row.mttt_seconds)}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '48px',
      align: 'center',
      render: (row) => (
        <Link
          to={`/alerts/${row.id}`}
          className="inline-flex rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-cyan-300"
          aria-label={`Ver detalle de la alerta ${row.id}`}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <BellRing size={20} className="text-cyan-400" aria-hidden="true" />
            Alertas
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            {alertsQuery.data
              ? `${alertsQuery.data.total.toLocaleString('es-CL')} alertas coinciden con los filtros`
              : 'Correlación de Wazuh, OPNsense, Suricata y Zeek'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            contextLabel="Reporte operativo"
            disabled={!canExport}
            disabledReason="Necesitas el permiso reports:export"
            options={[
              {
                format: 'pdf',
                description: 'Volumen, MTTT y top reglas',
                onExport: () => reportsApi.generateOperational({ format: 'pdf', from: isoFrom(filters.range.from), to: isoTo(filters.range.to) }),
              },
              {
                format: 'xlsx',
                description: 'Datos en hoja de cálculo',
                onExport: () => reportsApi.generateOperational({ format: 'xlsx', from: isoFrom(filters.range.from), to: isoTo(filters.range.to) }),
              },
            ]}
            trigger={
              <>
                <Download size={15} aria-hidden="true" />
                Exportar
              </>
            }
          />
        </div>
      </header>

      <FilterBar
        columns={4}
        activeCount={activeCount}
        onReset={resetFilters}
        searchValue={searchDraft}
        onSearchChange={(value) => {
          setSearchDraft(value);
          debouncedSearch(value);
        }}
        searchPlaceholder="Buscar por descripción, IP, agente o fingerprint…"
      >
        <FilterField label="Severidad" htmlFor="filter-severity">
          <select
            id="filter-severity"
            className="soc-input"
            value={filters.severity}
            onChange={(event) => updateFilters({ severity: event.target.value })}
          >
            <option value="">Todas</option>
            {SEVERITY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {SEVERITY_LABELS[level]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Estado" htmlFor="filter-status">
          <select
            id="filter-status"
            className="soc-input"
            value={filters.status}
            onChange={(event) => updateFilters({ status: event.target.value })}
          >
            <option value="">Todos</option>
            {ALERT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {ALERT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Origen" htmlFor="filter-source">
          <select
            id="filter-source"
            className="soc-input"
            value={filters.sourceType}
            onChange={(event) => updateFilters({ sourceType: event.target.value })}
          >
            <option value="">Todos</option>
            {SOURCE_TYPES.map((source) => (
              <option key={source} value={source}>
                {SOURCE_TYPE_LABELS[source]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Rango de fechas" htmlFor="filter-range">
          <div id="filter-range">
            <DateRangePicker value={filters.range} onChange={(value) => updateFilters({ range: value })} presets={[1, 7, 30, 90]} />
          </div>
        </FilterField>

        <FilterField label="Score de riesgo mínimo" htmlFor="filter-risk">
          <div className="flex items-center gap-2">
            <input
              id="filter-risk"
              type="range"
              min={0}
              max={100}
              step={5}
              value={filters.minRisk || 0}
              onChange={(event) => updateFilters({ minRisk: event.target.value === '0' ? '' : event.target.value })}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-cyan-500"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Number(filters.minRisk || 0)}
            />
            <span className="w-10 shrink-0 text-right font-mono text-xs text-slate-300">{filters.minRisk || 0}</span>
          </div>
        </FilterField>
      </FilterBar>

      {/* Barra de acciones masivas */}
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-800/60 bg-cyan-950/30 px-4 py-3">
          <p className="text-sm text-cyan-200">
            <ShieldCheck size={15} className="mr-1.5 inline" aria-hidden="true" />
            {selectedIds.length} alerta(s) seleccionada(s)
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              Cambiar estado a
              <select
                className="soc-input w-auto py-1 text-xs"
                value={bulkStatus ?? ''}
                onChange={(event) => setBulkStatus((event.target.value || null) as AlertStatus | null)}
                disabled={!canWrite}
                aria-label="Nuevo estado para las alertas seleccionadas"
              >
                <option value="">Selecciona…</option>
                {ALERT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {ALERT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="soc-btn-primary py-1.5 text-xs"
              disabled={!canWrite || !bulkStatus || bulkMutation.isPending}
              title={canWrite ? undefined : 'Necesitas el permiso alerts:write'}
              onClick={() => {
                if (bulkStatus) bulkMutation.mutate({ ids: selectedIds, status: bulkStatus });
              }}
            >
              <Zap size={13} aria-hidden="true" />
              {bulkMutation.isPending ? 'Aplicando…' : 'Aplicar a seleccionadas'}
            </button>
            <button type="button" className="soc-btn-ghost py-1.5 text-xs" onClick={() => setSelected([])}>
              Cancelar selección
            </button>
          </div>
        </div>
      ) : null}

      <div className="soc-panel overflow-hidden">
        <DataTable<AlertListItem>
          columns={columns}
          data={rows}
          rowKey="id"
          loading={alertsQuery.isPending || alertsQuery.isFetching}
          error={alertsQuery.isError ? getErrorMessage(alertsQuery.error) : null}
          onRetry={() => void alertsQuery.refetch()}
          selectable={canWrite}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          sortBy={sort.by}
          sortDir={sort.dir}
          onSortChange={handleSortChange}
          page={alertsQuery.data?.page ?? page}
          pageSize={pageSize}
          total={alertsQuery.data?.total}
          onPageChange={(next) => {
            setPage(next);
            syncUrl({ page: next });
          }}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
            syncUrl({ pageSize: next, page: 1 });
          }}
          emptyTitle="No hay alertas con estos criterios"
          emptyDescription="Ajusta los filtros, amplía el rango de fechas o limpia la búsqueda."
          emptyAction={
            <button type="button" className="soc-btn-secondary" onClick={resetFilters}>
              Limpiar filtros
            </button>
          }
          caption="Listado paginado de alertas de seguridad"
          maxHeight="62vh"
        />
      </div>

      <ConfirmDialog
        open={bulkStatus !== null}
        tone="warning"
        title="Confirmar cambio masivo de estado"
        message={
          <>
            Se cambiará el estado de <strong>{selectedIds.length}</strong> alerta(s) a{' '}
            <strong>{bulkStatus ? ALERT_STATUS_LABELS[bulkStatus] : ''}</strong>.
          </>
        }
        confirmLabel="Aplicar cambio"
        loading={bulkMutation.isPending}
        onConfirm={() => {
          if (bulkStatus) bulkMutation.mutate({ ids: selectedIds, status: bulkStatus });
        }}
        onCancel={() => setBulkStatus(null)}
        details={
          <span className="font-mono">
            IDs: {selectedIds.slice(0, 30).join(', ')}
            {selectedIds.length > 30 ? ` … (+${selectedIds.length - 30})` : ''}
          </span>
        }
      />
    </div>
  );
}

export default Alerts;
