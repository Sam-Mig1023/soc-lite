/**
 * SOC-Lite · Listado de incidentes + creación manual.
 * Filtros por estado, prioridad y rango; paginación server-side y alta de incidente.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, Plus, Siren, Users } from 'lucide-react';
import { incidentsApi } from '@/api/incidents';
import { usersApi } from '@/api/users';
import { LIST_REFRESH_MS, queryKeys } from '@/api/queryClient';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, FilterField } from '@/components/FilterBar';
import { DateRangePicker, isoFrom, isoTo, type DateRangeValue } from '@/components/DateRangePicker';
import { IncidentStatusBadge, PriorityBadge, SeverityBadge } from '@/components/Badges';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import type { IncidentCreateRequest, IncidentListItem } from '@/types/incident';
import { INCIDENT_CATEGORIES, INCIDENT_CATEGORY_LABELS } from '@/types/incident';
import {
  INCIDENT_STATUSES,
  INCIDENT_STATUS_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  SEVERITY_LEVELS,
  SEVERITY_LABELS,
  type IncidentStatus,
  type Priority,
  type SeverityLevel,
} from '@/types/enums';
import { getErrorMessage } from '@/utils/errors';
import { formatDateTime, formatRelative, truncate } from '@/utils/format';

const PAGE_SIZE_DEFAULT = 25;

const EMPTY_FORM: IncidentCreateRequest = {
  title: '',
  description: '',
  priority: 'p3',
  severity: 'medium',
  category: 'intrusion',
  owner_id: null,
};

/** Listado de incidentes con alta manual. */
export function Incidents(): JSX.Element {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const [status, setStatus] = useState((searchParams.get('status') ?? '') as IncidentStatus | '');
  const [priority, setPriority] = useState((searchParams.get('priority') ?? '') as Priority | '');
  const [range, setRange] = useState<DateRangeValue>({
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' }>({ by: 'detected_at', dir: 'desc' });
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<IncidentCreateRequest>(EMPTY_FORM);
  const closeModal = useCallback(() => setModalOpen(false), []);

  const canWrite = Boolean(permissions?.includes('*') || permissions?.includes('incidents:write'));
  const canReadUsers = Boolean(permissions?.includes('*') || permissions?.includes('users:read'));

  const query = useMemo(
    () => ({
      page,
      page_size: pageSize,
      status: status || undefined,
      priority: priority || undefined,
      from: isoFrom(range.from),
      to: isoTo(range.to),
      sort_by: sort.by,
      sort_dir: sort.dir,
    }),
    [page, pageSize, status, priority, range.from, range.to, sort],
  );

  const incidentsQuery = useQuery({
    queryKey: queryKeys.incidents.list(query),
    queryFn: () => incidentsApi.list(query),
    refetchInterval: LIST_REFRESH_MS,
    placeholderData: (previous) => previous,
  });

  const ownersQuery = useQuery({
    queryKey: queryKeys.users.list({ page: 1, page_size: 100, is_active: true }),
    queryFn: () => usersApi.list({ page: 1, page_size: 100, is_active: true }),
    enabled: canReadUsers && modalOpen,
  });

  const createMutation = useMutation({
    mutationFn: (payload: IncidentCreateRequest) => incidentsApi.create(payload),
    onSuccess: (incident) => {
      toast.success('Incidente creado', `${incident.incident_code} · ${incident.title}`);
      setModalOpen(false);
      setForm(EMPTY_FORM);
      void queryClient.invalidateQueries({ queryKey: queryKeys.incidents.all() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
    },
    onError: (error) => toast.error('No se pudo crear el incidente', getErrorMessage(error)),
  });

  const activeCount = [status, priority, range.from].filter(Boolean).length;

  const columns: Array<Column<IncidentListItem>> = [
    {
      key: 'incident_code',
      header: 'Código',
      sortable: true,
      width: '150px',
      render: (row) => (
        <Link to={`/incidents/${row.id}`} className="font-mono text-xs text-cyan-400 hover:underline">
          {row.incident_code}
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Título',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-200" title={row.title}>
            {row.title}
          </p>
          {row.description ? (
            <p className="truncate text-[11px] text-slate-500" title={row.description}>
              {truncate(row.description, 80)}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Estado',
      sortable: true,
      width: '130px',
      render: (row) => <IncidentStatusBadge status={row.status} />,
    },
    {
      key: 'priority',
      header: 'Prioridad',
      sortable: true,
      width: '130px',
      render: (row) => <PriorityBadge priority={row.priority} />,
    },
    {
      key: 'severity',
      header: 'Severidad',
      sortable: true,
      width: '110px',
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    {
      key: 'category',
      header: 'Categoría',
      hideOnMobile: true,
      width: '120px',
      render: (row) => (
        <span className="text-xs text-slate-400">
          {row.category ? (INCIDENT_CATEGORY_LABELS[row.category] ?? row.category) : '—'}
        </span>
      ),
    },
    {
      key: 'owner_id',
      header: 'Responsable',
      hideOnMobile: true,
      render: (row) => (
        <span className="flex items-center gap-1.5 text-xs text-slate-300">
          <Users size={12} aria-hidden="true" />
          {row.owner_username ?? (row.owner_id ? `#${row.owner_id}` : 'sin asignar')}
        </span>
      ),
    },
    {
      key: 'alerts_count',
      header: 'Alertas',
      width: '80px',
      align: 'center',
      render: (row) => <span className="font-mono text-xs text-slate-300">{row.alerts_count ?? '—'}</span>,
    },
    {
      key: 'detected_at',
      header: 'Detectado',
      sortable: true,
      width: '150px',
      render: (row) => (
        <div>
          <p className="text-xs text-slate-300">{formatRelative(row.detected_at)}</p>
          <p className="font-mono text-[10px] text-slate-500">{formatDateTime(row.detected_at)}</p>
        </div>
      ),
    },
    {
      key: 'ticket',
      header: 'Ticket',
      width: '70px',
      align: 'center',
      render: (row) =>
        row.external_ticket_url ? (
          <a
            href={row.external_ticket_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex text-cyan-400 hover:text-cyan-300"
            aria-label={`Abrir ticket ${row.external_ticket_id ?? ''}`}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : (
          <span className="text-slate-600">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <Siren size={20} className="text-red-400" aria-hidden="true" />
            Incidentes
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            {incidentsQuery.data
              ? `${incidentsQuery.data.total.toLocaleString('es-CL')} incidentes registrados`
              : 'Gestión del ciclo de vida de la respuesta a incidentes'}
          </p>
        </div>
        <button
          type="button"
          className="soc-btn-primary"
          disabled={!canWrite}
          title={canWrite ? undefined : 'Necesitas el permiso incidents:write'}
          onClick={() => setModalOpen(true)}
        >
          <Plus size={15} aria-hidden="true" />
          Nuevo incidente
        </button>
      </header>

      <FilterBar
        columns={4}
        activeCount={activeCount}
        onReset={() => {
          setStatus('');
          setPriority('');
          setRange({ from: '', to: '' });
          setPage(1);
        }}
      >
        <FilterField label="Estado" htmlFor="incident-status-filter">
          <select
            id="incident-status-filter"
            className="soc-input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as IncidentStatus | '');
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {INCIDENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {INCIDENT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Prioridad" htmlFor="incident-priority-filter">
          <select
            id="incident-priority-filter"
            className="soc-input"
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as Priority | '');
              setPage(1);
            }}
          >
            <option value="">Todas</option>
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Rango de detección" htmlFor="incident-range-filter">
          <div id="incident-range-filter">
            <DateRangePicker
              value={range}
              onChange={(value) => {
                setRange(value);
                setPage(1);
              }}
            />
          </div>
        </FilterField>
      </FilterBar>

      <div className="soc-panel overflow-hidden">
        <DataTable<IncidentListItem>
          columns={columns}
          data={incidentsQuery.data?.items ?? []}
          rowKey="id"
          loading={incidentsQuery.isPending || incidentsQuery.isFetching}
          error={incidentsQuery.isError ? getErrorMessage(incidentsQuery.error) : null}
          onRetry={() => void incidentsQuery.refetch()}
          sortBy={sort.by}
          sortDir={sort.dir}
          onSortChange={(by, dir) => setSort({ by, dir })}
          page={incidentsQuery.data?.page ?? page}
          pageSize={pageSize}
          total={incidentsQuery.data?.total}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          emptyTitle="Sin incidentes"
          emptyDescription="No hay incidentes que coincidan con los filtros seleccionados."
          caption="Listado paginado de incidentes"
        />
      </div>

      {/* Alta manual */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="Nuevo incidente"
        description="Registra un incidente manualmente. Podrás vincular alertas desde el detalle."
        size="lg"
        preventClose={createMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setModalOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={createMutation.isPending || form.title.trim().length < 5}
              onClick={() => createMutation.mutate(form)}
            >
              {createMutation.isPending ? 'Creando…' : 'Crear incidente'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="soc-label" htmlFor="new-incident-title">
              Título *
            </label>
            <input
              id="new-incident-title"
              className="soc-input"
              value={form.title}
              maxLength={255}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Intento de acceso no autorizado al controlador de dominio"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="soc-label" htmlFor="new-incident-priority">
                Prioridad
              </label>
              <select
                id="new-incident-priority"
                className="soc-input"
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value as Priority })}
              >
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="soc-label" htmlFor="new-incident-severity">
                Severidad
              </label>
              <select
                id="new-incident-severity"
                className="soc-input"
                value={form.severity}
                onChange={(event) => setForm({ ...form, severity: event.target.value as SeverityLevel })}
              >
                {SEVERITY_LEVELS.map((value) => (
                  <option key={value} value={value}>
                    {SEVERITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="soc-label" htmlFor="new-incident-category">
                Categoría
              </label>
              <select
                id="new-incident-category"
                className="soc-input"
                value={form.category ?? ''}
                onChange={(event) => setForm({ ...form, category: event.target.value })}
              >
                <option value="">Sin categoría</option>
                {INCIDENT_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {INCIDENT_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="soc-label" htmlFor="new-incident-owner">
              Responsable
            </label>
            <select
              id="new-incident-owner"
              className="soc-input"
              value={form.owner_id ?? ''}
              onChange={(event) => setForm({ ...form, owner_id: event.target.value ? Number(event.target.value) : null })}
              disabled={!canReadUsers}
            >
              <option value="">{canReadUsers ? 'Sin asignar' : 'Permiso users:read requerido'}</option>
              {(ownersQuery.data?.items ?? []).map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.full_name} ({owner.username})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="soc-label" htmlFor="new-incident-description">
              Descripción
            </label>
            <textarea
              id="new-incident-description"
              className="soc-input min-h-28"
              value={form.description ?? ''}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Contexto, activos afectados, evidencia inicial…"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default Incidents;
