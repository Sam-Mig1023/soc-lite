/**
 * SOC-Lite · Detalle de incidente: alertas vinculadas, acciones de respuesta y ticket externo.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Lock,
  NotebookPen,
  Plus,
  RefreshCw,
  Siren,
  Ticket,
  Timer,
  Users,
} from 'lucide-react';
import { incidentsApi } from '@/api/incidents';
import { usersApi } from '@/api/users';
import { queryKeys } from '@/api/queryClient';
import { IncidentStatusBadge, PriorityBadge, RiskScore, SeverityBadge, StatusBadge, VerdictBadge } from '@/components/Badges';
import { Modal } from '@/components/Modal';
import { ErrorState, Loading, Skeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import type { IncidentActionRequest, IncidentDetail as IncidentDetailModel } from '@/types/incident';
import { INCIDENT_ACTION_TYPES, INCIDENT_ACTION_TYPE_LABELS, INCIDENT_CATEGORY_LABELS } from '@/types/incident';
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
import { cx, formatDateTime, formatDuration, formatRelative } from '@/utils/format';

const ACTION_STATUS_CLASSES: Record<string, string> = {
  pending: 'border-slate-700 bg-slate-800/60 text-slate-300',
  running: 'border-cyan-700 bg-cyan-950/40 text-cyan-300',
  done: 'border-emerald-700 bg-emerald-950/40 text-emerald-300',
  failed: 'border-red-700 bg-red-950/40 text-red-300',
};

/** Detalle de un incidente con acciones de respuesta. */
export function IncidentDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const incidentId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { permissions } = useAuth();

  const canWrite = Boolean(permissions?.includes('*') || permissions?.includes('incidents:write'));
  const canReadUsers = Boolean(permissions?.includes('*') || permissions?.includes('users:read'));

  const [editOpen, setEditOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [form, setForm] = useState<{
    status: IncidentStatus;
    priority: Priority;
    severity: SeverityLevel;
    owner_id: number | null;
    impact: string;
    root_cause: string;
    lessons_learned: string;
  }>({
    status: 'open',
    priority: 'p3',
    severity: 'medium',
    owner_id: null,
    impact: '',
    root_cause: '',
    lessons_learned: '',
  });
  const [actionForm, setActionForm] = useState<IncidentActionRequest>({
    action_type: 'block_ip',
    description: '',
    automated: false,
  });
  const [alertIdsInput, setAlertIdsInput] = useState('');

  const detailQuery = useQuery({
    queryKey: queryKeys.incidents.detail(incidentId),
    queryFn: () => incidentsApi.get(incidentId),
    enabled: Number.isFinite(incidentId),
  });

  const ticketQuery = useQuery({
    queryKey: queryKeys.incidents.ticket(incidentId),
    queryFn: () => incidentsApi.ticket(incidentId),
    enabled: Number.isFinite(incidentId),
  });

  const ownersQuery = useQuery({
    queryKey: queryKeys.users.list({ page: 1, page_size: 100, is_active: true }),
    queryFn: () => usersApi.list({ page: 1, page_size: 100, is_active: true }),
    enabled: canReadUsers && editOpen,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.incidents.detail(incidentId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.incidents.all() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
  };

  const updateMutation = useMutation({
    mutationFn: (payload: Parameters<typeof incidentsApi.update>[1]) => incidentsApi.update(incidentId, payload),
    onSuccess: () => {
      toast.success('Incidente actualizado');
      setEditOpen(false);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo actualizar el incidente', getErrorMessage(error)),
  });

  const actionMutation = useMutation({
    mutationFn: (payload: IncidentActionRequest) => incidentsApi.addAction(incidentId, payload),
    onSuccess: (action) => {
      toast.success('Acción de respuesta registrada', `${INCIDENT_ACTION_TYPE_LABELS[action.action_type] ?? action.action_type}`);
      setActionOpen(false);
      setActionForm({ action_type: 'block_ip', description: '', automated: false });
      invalidate();
    },
    onError: (error) => toast.error('No se pudo registrar la acción', getErrorMessage(error)),
  });

  const linkMutation = useMutation({
    mutationFn: (alertIds: number[]) => incidentsApi.linkAlerts(incidentId, alertIds),
    onSuccess: () => {
      toast.success('Alertas vinculadas al incidente');
      setLinkOpen(false);
      setAlertIdsInput('');
      invalidate();
    },
    onError: (error) => toast.error('No se pudieron vincular las alertas', getErrorMessage(error)),
  });

  const incident: IncidentDetailModel | undefined = detailQuery.data;

  const parsedAlertIds = useMemo(
    () =>
      alertIdsInput
        .split(/[\s,;]+/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0),
    [alertIdsInput],
  );

  if (detailQuery.isPending) return <Loading label="Cargando incidente…" />;
  if (detailQuery.isError || !incident) {
    return (
      <ErrorState
        title="No se pudo cargar el incidente"
        message={getErrorMessage(detailQuery.error)}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const openEdit = (): void => {
    setForm({
      status: incident.status,
      priority: incident.priority,
      severity: incident.severity,
      owner_id: incident.owner_id,
      impact: incident.impact ?? '',
      root_cause: incident.root_cause ?? '',
      lessons_learned: incident.lessons_learned ?? '',
    });
    setEditOpen(true);
  };

  const ticket = ticketQuery.data ?? incident.ticket ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="soc-btn-ghost px-2 py-1 text-xs" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} aria-hidden="true" />
          Volver al listado
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="soc-btn-secondary py-1.5 text-xs"
            onClick={() => void detailQuery.refetch()}
            disabled={detailQuery.isFetching}
          >
            <RefreshCw size={13} className={cx(detailQuery.isFetching && 'animate-spin')} aria-hidden="true" />
            Actualizar
          </button>
          <button
            type="button"
            className="soc-btn-secondary py-1.5 text-xs"
            disabled={!canWrite}
            onClick={() => setLinkOpen(true)}
          >
            <Plus size={13} aria-hidden="true" />
            Vincular alertas
          </button>
          <button type="button" className="soc-btn-primary py-1.5 text-xs" disabled={!canWrite} onClick={openEdit}>
            <NotebookPen size={13} aria-hidden="true" />
            Actualizar incidente
          </button>
        </div>
      </div>

      {/* Cabecera */}
      <section className="soc-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-cyan-400">{incident.incident_code}</span>
              <IncidentStatusBadge status={incident.status} />
              <PriorityBadge priority={incident.priority} />
              <SeverityBadge severity={incident.severity} />
              {incident.category ? (
                <span className="soc-badge border-slate-700 bg-slate-800/60 text-slate-300">
                  {INCIDENT_CATEGORY_LABELS[incident.category] ?? incident.category}
                </span>
              ) : null}
            </div>
            <h1 className="mt-2 text-lg font-semibold text-slate-100">{incident.title}</h1>
            {incident.description ? (
              <p className="mt-2 max-w-3xl whitespace-pre-line text-sm text-slate-400">{incident.description}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <Siren size={13} aria-hidden="true" />
                Detectado {formatRelative(incident.detected_at)} · {formatDateTime(incident.detected_at)}
              </span>
              <span className="flex items-center gap-1.5">
                <Users size={13} aria-hidden="true" />
                Responsable {incident.owner?.full_name ?? (incident.owner_id ? `#${incident.owner_id}` : 'sin asignar')}
              </span>
              {incident.contained_at ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <Timer size={13} aria-hidden="true" />
                  Contenido {formatRelative(incident.contained_at)}
                </span>
              ) : null}
              {incident.resolved_at ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <CheckCircle2 size={13} aria-hidden="true" />
                  Resuelto {formatRelative(incident.resolved_at)}
                </span>
              ) : null}
            </div>
          </div>

          <div className="w-full max-w-xs space-y-2 sm:w-auto">
            {incident.mitre_tactics && incident.mitre_tactics.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {incident.mitre_tactics.map((tactic) => (
                  <span key={tactic} className="soc-badge border-indigo-800/70 bg-indigo-950/40 font-mono text-indigo-200">
                    {tactic}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
              <p className="flex items-center gap-1.5 text-slate-400">
                <Ticket size={13} aria-hidden="true" />
                Ticket externo
              </p>
              {ticket?.external_ticket_url ? (
                <a
                  href={ticket.external_ticket_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-flex items-center gap-1 font-mono text-cyan-300 hover:underline"
                >
                  {ticket.external_ticket_id ?? 'ver ticket'}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              ) : (
                <p className="mt-1 text-slate-500">Sin ticket asociado</p>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        {/* Alertas vinculadas */}
        <section className="soc-panel overflow-hidden">
          <header className="soc-panel-header">
            <h2 className="soc-panel-title flex items-center gap-2">
              <Siren size={14} className="text-cyan-400" aria-hidden="true" />
              Alertas vinculadas
            </h2>
            <span className="text-[11px] text-slate-500">{incident.alerts?.length ?? 0} alerta(s)</span>
          </header>
          {incident.alerts && incident.alerts.length > 0 ? (
            <div className="soc-scroll-x">
              <table className="soc-table">
                <thead>
                  <tr>
                    <th className="soc-th">ID</th>
                    <th className="soc-th">Severidad</th>
                    <th className="soc-th">Estado</th>
                    <th className="soc-th">Regla</th>
                    <th className="soc-th">Riesgo</th>
                    <th className="soc-th">Veredicto</th>
                    <th className="soc-th">Ocurrió</th>
                  </tr>
                </thead>
                <tbody>
                  {incident.alerts.map((alert) => (
                    <tr key={alert.id} className="hover:bg-slate-800/40">
                      <td className="soc-td">
                        <Link to={`/alerts/${alert.id}`} className="font-mono text-xs text-cyan-400 hover:underline">
                          #{alert.id}
                        </Link>
                      </td>
                      <td className="soc-td">
                        <SeverityBadge severity={alert.severity} />
                      </td>
                      <td className="soc-td">
                        <StatusBadge status={alert.status} />
                      </td>
                      <td className="soc-td max-w-xs truncate text-xs text-slate-300" title={alert.rule_description ?? ''}>
                        {alert.rule_description ?? '—'}
                      </td>
                      <td className="soc-td">
                        <RiskScore score={alert.risk_score} showMeter={false} />
                      </td>
                      <td className="soc-td">
                        <VerdictBadge verdict={alert.verdict} />
                      </td>
                      <td className="soc-td text-xs text-slate-400">{formatDateTime(alert.occurred_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-4 text-sm text-slate-500">
              Este incidente no tiene alertas vinculadas. Usa «Vincular alertas» para asociar IDs de alerta.
            </p>
          )}
        </section>

        {/* Acciones de respuesta */}
        <section className="soc-panel">
          <header className="soc-panel-header">
            <h2 className="soc-panel-title flex items-center gap-2">
              <ListChecks size={14} className="text-cyan-400" aria-hidden="true" />
              Acciones de respuesta
            </h2>
            <button
              type="button"
              className="soc-btn-secondary py-1 text-xs"
              disabled={!canWrite}
              title={canWrite ? undefined : 'Necesitas el permiso incidents:write'}
              onClick={() => setActionOpen(true)}
            >
              <Plus size={13} aria-hidden="true" />
              Registrar acción
            </button>
          </header>
          <div className="p-4">
            {!incident.actions || incident.actions.length === 0 ? (
              <p className="text-sm text-slate-500">Sin acciones de respuesta registradas.</p>
            ) : (
              <ol className="space-y-3">
                {incident.actions.map((action) => (
                  <li key={action.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-200">
                        {INCIDENT_ACTION_TYPE_LABELS[action.action_type] ?? action.action_type}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {action.automated ? (
                          <span className="soc-badge border-cyan-800 bg-cyan-950/40 text-cyan-300">Automática</span>
                        ) : null}
                        <span className={cx('soc-badge', ACTION_STATUS_CLASSES[action.status] ?? ACTION_STATUS_CLASSES.pending)}>
                          {action.status}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-400">{action.description}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {formatDateTime(action.created_at)}
                      {action.performed_by_username ? ` · ${action.performed_by_username}` : ''}
                      {action.finished_at ? ` · finalizada ${formatRelative(action.finished_at)}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        {/* Análisis post-incidente */}
        <section className="soc-panel xl:col-span-2">
          <header className="soc-panel-header">
            <h2 className="soc-panel-title flex items-center gap-2">
              <NotebookPen size={14} className="text-cyan-400" aria-hidden="true" />
              Análisis y lecciones aprendidas
            </h2>
          </header>
          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <div>
              <p className="soc-label">Impacto</p>
              <p className="whitespace-pre-line text-sm text-slate-300">{incident.impact || 'No documentado.'}</p>
            </div>
            <div>
              <p className="soc-label">Causa raíz</p>
              <p className="whitespace-pre-line text-sm text-slate-300">{incident.root_cause || 'No documentada.'}</p>
            </div>
            <div>
              <p className="soc-label">Lecciones aprendidas</p>
              <p className="whitespace-pre-line text-sm text-slate-300">{incident.lessons_learned || 'No documentadas.'}</p>
            </div>
          </div>
          <footer className="flex flex-wrap items-center gap-4 border-t border-slate-800 px-4 py-3 text-[11px] text-slate-500">
            <span>Creado {formatDateTime(incident.created_at)}</span>
            <span>Actualizado {formatDateTime(incident.updated_at)}</span>
            {incident.contained_at ? <span>Contención en {formatDuration(
              (new Date(incident.contained_at).getTime() - new Date(incident.detected_at).getTime()) / 1000,
            )}</span> : null}
          </footer>
        </section>
      </div>

      {/* Modal: actualizar incidente */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Actualizar incidente"
        size="lg"
        preventClose={updateMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setEditOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={updateMutation.isPending}
              onClick={() =>
                updateMutation.mutate({
                  status: form.status,
                  priority: form.priority,
                  severity: form.severity,
                  owner_id: form.owner_id,
                  impact: form.impact || undefined,
                  root_cause: form.root_cause || undefined,
                  lessons_learned: form.lessons_learned || undefined,
                })
              }
            >
              {updateMutation.isPending ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="soc-label" htmlFor="edit-status">
                Estado
              </label>
              <select
                id="edit-status"
                className="soc-input"
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value as IncidentStatus })}
              >
                {INCIDENT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {INCIDENT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="soc-label" htmlFor="edit-priority">
                Prioridad
              </label>
              <select
                id="edit-priority"
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
              <label className="soc-label" htmlFor="edit-severity">
                Severidad
              </label>
              <select
                id="edit-severity"
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
          </div>

          <div>
            <label className="soc-label" htmlFor="edit-owner">
              Responsable
            </label>
            <select
              id="edit-owner"
              className="soc-input"
              value={form.owner_id ?? ''}
              disabled={!canReadUsers}
              onChange={(event) => setForm({ ...form, owner_id: event.target.value ? Number(event.target.value) : null })}
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
            <label className="soc-label" htmlFor="edit-impact">
              Impacto
            </label>
            <textarea
              id="edit-impact"
              className="soc-input min-h-20"
              value={form.impact}
              onChange={(event) => setForm({ ...form, impact: event.target.value })}
            />
          </div>
          <div>
            <label className="soc-label" htmlFor="edit-rootcause">
              Causa raíz
            </label>
            <textarea
              id="edit-rootcause"
              className="soc-input min-h-20"
              value={form.root_cause}
              onChange={(event) => setForm({ ...form, root_cause: event.target.value })}
            />
          </div>
          <div>
            <label className="soc-label" htmlFor="edit-lessons">
              Lecciones aprendidas
            </label>
            <textarea
              id="edit-lessons"
              className="soc-input min-h-20"
              value={form.lessons_learned}
              onChange={(event) => setForm({ ...form, lessons_learned: event.target.value })}
            />
          </div>
        </div>
      </Modal>

      {/* Modal: registrar acción de respuesta */}
      <Modal
        open={actionOpen}
        onClose={() => setActionOpen(false)}
        title="Registrar acción de respuesta"
        description="Documenta la medida aplicada sobre el incidente (contención, bloqueo, ticket…)."
        size="md"
        preventClose={actionMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setActionOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={actionMutation.isPending || actionForm.description.trim().length < 5}
              onClick={() => actionMutation.mutate(actionForm)}
            >
              {actionMutation.isPending ? 'Registrando…' : 'Registrar acción'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="soc-label" htmlFor="action-type">
              Tipo de acción
            </label>
            <select
              id="action-type"
              className="soc-input"
              value={actionForm.action_type}
              onChange={(event) => setActionForm({ ...actionForm, action_type: event.target.value })}
            >
              {INCIDENT_ACTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {INCIDENT_ACTION_TYPE_LABELS[type] ?? type}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="soc-label" htmlFor="action-description">
              Descripción *
            </label>
            <textarea
              id="action-description"
              className="soc-input min-h-24"
              value={actionForm.description}
              onChange={(event) => setActionForm({ ...actionForm, description: event.target.value })}
              placeholder="Se bloqueó la IP 10.0.4.21 en el firewall perimetral durante 24 h."
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-cyan-500"
              checked={Boolean(actionForm.automated)}
              onChange={(event) => setActionForm({ ...actionForm, automated: event.target.checked })}
            />
            Acción ejecutada de forma automática (n8n / SOAR)
          </label>
        </div>
      </Modal>

      {/* Modal: vincular alertas */}
      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Vincular alertas al incidente"
        description="Introduce los IDs de alerta separados por comas, espacios o saltos de línea."
        size="sm"
        preventClose={linkMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setLinkOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={linkMutation.isPending || parsedAlertIds.length === 0}
              onClick={() => linkMutation.mutate(parsedAlertIds)}
            >
              {linkMutation.isPending ? 'Vinculando…' : `Vincular ${parsedAlertIds.length || ''}`}
            </button>
          </>
        }
      >
        <label className="soc-label" htmlFor="link-alerts">
          IDs de alerta
        </label>
        <textarea
          id="link-alerts"
          className="soc-input min-h-24 font-mono text-xs"
          value={alertIdsInput}
          onChange={(event) => setAlertIdsInput(event.target.value)}
          placeholder="1042, 1043, 1050"
        />
        {parsedAlertIds.length > 0 ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-cyan-300">
            <Lock size={12} aria-hidden="true" />
            {parsedAlertIds.length} ID(s) válidos: {parsedAlertIds.slice(0, 20).join(', ')}
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">Aún no hay IDs válidos.</p>
        )}
      </Modal>

      {detailQuery.isFetching ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Skeleton className="h-3 w-32" />
          Sincronizando…
        </div>
      ) : null}
    </div>
  );
}

export default IncidentDetail;
