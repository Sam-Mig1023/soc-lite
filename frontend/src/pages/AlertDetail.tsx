/**
 * SOC-Lite · Detalle de alerta.
 * Cabecera (severidad/estado/riesgo), resumen del LLM con badge de confianza, razonamiento,
 * acciones recomendadas, IOCs enriquecidos, MITRE ATT&CK, log completo, timeline y panel
 * de acciones (estado, asignación, triaje, falso positivo, incidente, ticket).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  Building2,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  Cpu,
  Flag,
  Globe2,
  Hash,
  ListChecks,
  Network,
  RefreshCw,
  Server,
  ShieldAlert,
  Siren,
  Tag,
  Ticket,
  UserCheck,
} from 'lucide-react';
import { alertsApi } from '@/api/alerts';
import { incidentsApi } from '@/api/incidents';
import { triageApi } from '@/api/triage';
import { usersApi } from '@/api/users';
import { queryKeys } from '@/api/queryClient';
import {
  ConfidenceBadge,
  PriorityBadge,
  RiskScore,
  SeverityBadge,
  SourceTypeBadge,
  StatusBadge,
  VerdictBadge,
} from '@/components/Badges';
import { Modal } from '@/components/Modal';
import { ErrorState, Loading, Skeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { getEmbeddedTriage, type EnrichmentRecord, type RecommendedAction } from '@/types/alert';
import { ALERT_STATUSES, ALERT_STATUS_LABELS, type AlertStatus, type Priority, type SeverityLevel } from '@/types/enums';
import { getErrorMessage } from '@/utils/errors';
import { copyToClipboard, cx, formatDateTime, formatDuration, formatMillis, formatRelative } from '@/utils/format';

/** Color del chip de veredicto de un IOC. */
function iocVerdictClass(verdict?: string | null): string {
  switch (verdict) {
    case 'malicious':
      return 'border-red-700 bg-red-950/40 text-red-200';
    case 'suspicious':
      return 'border-amber-700 bg-amber-950/40 text-amber-200';
    case 'clean':
      return 'border-emerald-700 bg-emerald-950/40 text-emerald-200';
    default:
      return 'border-slate-700 bg-slate-800/60 text-slate-400';
  }
}

/** Título de sección reutilizable del detalle. */
function Panel({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title: string;
  icon?: JSX.Element;
  actions?: JSX.Element | null;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={cx('soc-panel', className)}>
      <header className="soc-panel-header">
        <h2 className="soc-panel-title flex items-center gap-2">
          {icon}
          {title}
        </h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Fila etiqueta/valor de la ficha técnica. */
function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-0.5 truncate text-sm text-slate-200">{children}</div>
    </div>
  );
}

/** Página de detalle de una alerta. */
export function AlertDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const alertId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { permissions } = useAuth();

  const canWrite = Boolean(permissions?.includes('*') || permissions?.includes('alerts:write'));
  const canRunTriage = Boolean(permissions?.includes('*') || permissions?.includes('triage:run'));
  const canReadTriage = Boolean(permissions?.includes('*') || permissions?.includes('triage:read'));
  const canReadUsers = Boolean(permissions?.includes('*') || permissions?.includes('users:read'));
  const canWriteIncidents = Boolean(permissions?.includes('*') || permissions?.includes('incidents:write'));

  const [statusDraft, setStatusDraft] = useState<AlertStatus | ''>('');
  const [assignee, setAssignee] = useState<number | ''>('');
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [incidentForm, setIncidentForm] = useState({
    title: '',
    priority: 'p2' as Priority,
    severity: 'high' as SeverityLevel,
    category: 'intrusion',
    description: '',
  });
  const [ticketInfo, setTicketInfo] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: queryKeys.alerts.detail(alertId),
    queryFn: () => alertsApi.get(alertId),
    enabled: Number.isFinite(alertId),
  });

  const enrichmentQuery = useQuery({
    queryKey: queryKeys.alerts.enrichment(alertId),
    queryFn: () => alertsApi.enrichment(alertId),
    enabled: Number.isFinite(alertId) && canReadTriage,
  });

  const timelineQuery = useQuery({
    queryKey: queryKeys.alerts.timeline(alertId),
    queryFn: () => alertsApi.timeline(alertId),
    enabled: Number.isFinite(alertId),
  });

  const usersQuery = useQuery({
    queryKey: queryKeys.users.list({ page: 1, page_size: 100, is_active: true }),
    queryFn: () => usersApi.list({ page: 1, page_size: 100, is_active: true }),
    enabled: canReadUsers,
  });

  const invalidateAlert = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.alerts.detail(alertId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.alerts.all() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.alerts.timeline(alertId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
  };

  const statusMutation = useMutation({
    mutationFn: (payload: { status?: AlertStatus; assigned_to?: number | null; notes?: string }) =>
      alertsApi.update(alertId, payload),
    onSuccess: () => {
      toast.success('Alerta actualizada');
      invalidateAlert();
      setStatusDraft('');
    },
    onError: (error) => toast.error('No se pudo actualizar la alerta', getErrorMessage(error)),
  });

  const triageMutation = useMutation({
    mutationFn: (force: boolean) => triageApi.run(alertId, force),
    onSuccess: (result) => {
      toast.success('Triaje ejecutado', `Veredicto: ${result.verdict} · confianza ${Math.round((result.confidence ?? 0) * 100)} %`);
      invalidateAlert();
      void queryClient.invalidateQueries({ queryKey: queryKeys.triage.all() });
    },
    onError: (error) => toast.error('El triaje falló', getErrorMessage(error)),
  });

  const feedbackMutation = useMutation({
    mutationFn: (isFalsePositive: boolean) =>
      triageApi.feedback(alertId, {
        is_false_positive: isFalsePositive,
        comment: isFalsePositive ? 'Marcado como falso positivo desde el detalle de la alerta' : undefined,
      }),
    onSuccess: () => {
      toast.success('Retroalimentación registrada', 'La etiqueta alimenta la tasa de falsos positivos.');
      invalidateAlert();
    },
    onError: (error) => toast.error('No se pudo registrar la retroalimentación', getErrorMessage(error)),
  });

  const incidentMutation = useMutation({
    mutationFn: () =>
      incidentsApi.create({
        title: incidentForm.title,
        description: incidentForm.description,
        priority: incidentForm.priority,
        severity: incidentForm.severity,
        category: incidentForm.category,
        alert_ids: [alertId],
      }),
    onSuccess: (incident) => {
      toast.success('Incidente creado', `${incident.incident_code} · ${incident.title}`);
      setShowIncidentModal(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.incidents.all() });
      invalidateAlert();
      navigate(`/incidents/${incident.id}`);
    },
    onError: (error) => toast.error('No se pudo crear el incidente', getErrorMessage(error)),
  });

  const alert = detailQuery.data;
  const triage = getEmbeddedTriage(alert);
  const enrichment: EnrichmentRecord[] = enrichmentQuery.data ?? alert?.enrichment ?? [];
  const timeline = timelineQuery.data ?? alert?.timeline ?? [];

  const iocs = useMemo(() => {
    if (triage?.iocs && triage.iocs.length > 0) return triage.iocs;
    return enrichment.map((record) => ({
      type: record.indicator_type,
      value: record.indicator,
      verdict: record.verdict ?? undefined,
      source: record.provider,
      score: record.score ?? undefined,
      country: record.country ?? undefined,
      asn: record.asn ?? undefined,
      as_owner: record.as_owner ?? undefined,
    }));
  }, [triage, enrichment]);

  const mitreTechniques = useMemo(() => {
    const fromTriage = triage?.mitre_techniques ?? [];
    const legacy = [alert?.mitre_technique, alert?.mitre_tactic].filter((value): value is string => Boolean(value));
    return [...new Set([...fromTriage, ...legacy])];
  }, [triage, alert]);

  if (detailQuery.isPending) return <Loading label="Cargando detalle de la alerta…" />;

  if (detailQuery.isError || !alert) {
    return (
      <ErrorState
        title="No se pudo cargar la alerta"
        message={getErrorMessage(detailQuery.error)}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const openIncidentModal = (): void => {
    setIncidentForm({
      title: `Alerta #${alert.id} · ${alert.rule_description ?? 'evento de seguridad'}`.slice(0, 120),
      priority: alert.severity === 'critical' ? 'p1' : alert.severity === 'high' ? 'p2' : 'p3',
      severity: alert.severity,
      category: 'intrusion',
      description: `Incidente creado desde la alerta #${alert.id} (regla ${alert.rule_id ?? 'n/d'}).\n\nResumen del triaje: ${
        triage?.summary ?? 'sin triaje disponible'
      }`,
    });
    setShowIncidentModal(true);
  };

  return (
    <div className="space-y-4">
      {/* Navegación superior */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="soc-btn-ghost px-2 py-1 text-xs" onClick={() => navigate(-1)}>
          <ArrowLeft size={14} aria-hidden="true" />
          Volver al listado
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="soc-btn-secondary py-1.5 text-xs"
            onClick={() => void detailQuery.refetch()}
            disabled={detailQuery.isFetching}
          >
            <RefreshCw size={13} className={cx(detailQuery.isFetching && 'animate-spin')} aria-hidden="true" />
            Actualizar
          </button>
          {alert.incident_id ? (
            <Link to={`/incidents/${alert.incident_id}`} className="soc-btn-secondary py-1.5 text-xs">
              <Siren size={13} aria-hidden="true" />
              Ver incidente #{alert.incident_id}
            </Link>
          ) : null}
        </div>
      </div>

      {/* Cabecera */}
      <section className="soc-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-cyan-400">#{alert.id}</span>
              <SeverityBadge severity={alert.severity} />
              <StatusBadge status={alert.status} />
              <VerdictBadge verdict={alert.verdict} />
              <SourceTypeBadge source={alert.source_type} />
              {alert.is_suppressed ? (
                <span className="soc-badge border-slate-600 bg-slate-800 text-slate-400">Suprimida</span>
              ) : null}
              {alert.dedup_count && alert.dedup_count > 1 ? (
                <span className="soc-badge border-cyan-800 bg-cyan-950/50 text-cyan-300">
                  {alert.dedup_count} eventos deduplicados
                </span>
              ) : null}
            </div>
            <h1 className="mt-2 text-lg font-semibold leading-snug text-slate-100">
              {alert.rule_description ?? 'Sin descripción de regla'}
            </h1>
            <p className="mt-1 font-mono text-xs text-slate-500">
              {alert.alert_fingerprint}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <Clock size={13} aria-hidden="true" />
                Ocurrió {formatRelative(alert.occurred_at)} · {formatDateTime(alert.occurred_at)}
              </span>
              <span className="flex items-center gap-1.5">
                <Cpu size={13} aria-hidden="true" />
                MTTT {formatDuration(alert.mttt_seconds)}
              </span>
              {alert.sla_due_at ? (
                <span
                  className={cx(
                    'flex items-center gap-1.5',
                    new Date(alert.sla_due_at).getTime() < Date.now() ? 'text-red-400' : 'text-emerald-400',
                  )}
                >
                  <Flag size={13} aria-hidden="true" />
                  SLA {formatDateTime(alert.sla_due_at)}
                </span>
              ) : null}
              {alert.assigned_to_user ? (
                <span className="flex items-center gap-1.5">
                  <UserCheck size={13} aria-hidden="true" />
                  Asignada a {alert.assigned_to_user.full_name}
                </span>
              ) : (
                <span className="text-amber-400">Sin asignar</span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Riesgo calculado</p>
            <RiskScore score={alert.risk_score} className="text-2xl" />
            {triage?.confidence !== null && triage?.confidence !== undefined && canReadTriage ? (
              <ConfidenceBadge confidence={triage.confidence} />
            ) : null}
          </div>
        </div>

        {/* Ficha técnica */}
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="IP origen">
            <span className="font-mono">{alert.source_ip ?? '—'}</span>
          </Field>
          <Field label="IP destino">
            <span className="font-mono">{alert.dest_ip ?? '—'}</span>
          </Field>
          <Field label="Puertos">
            <span className="font-mono">
              {alert.source_port ?? '—'} → {alert.dest_port ?? '—'} {alert.protocol ? `(${alert.protocol})` : ''}
            </span>
          </Field>
          <Field label="Agente / activo">
            <span className="flex items-center gap-1">
              <Server size={12} aria-hidden="true" />
              {alert.agent_name ?? '—'}
            </span>
          </Field>
          <Field label="Regla">
            <span className="font-mono">
              {alert.rule_id ?? '—'} {alert.rule_level ? `(nivel ${alert.rule_level})` : ''}
            </span>
          </Field>
          <Field label="Ingresada">
            <span>{formatDateTime(alert.created_at)}</span>
          </Field>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        {/* Columna principal */}
        <div className="space-y-4">
          {/* Resumen LLM */}
          <Panel
            title="Resumen del modelo de triaje"
            icon={<Bot size={14} className="text-cyan-400" aria-hidden="true" />}
            actions={
              <div className="flex items-center gap-2">
                {triage ? <ConfidenceBadge confidence={triage.confidence} /> : null}
                {triage ? <VerdictBadge verdict={triage.verdict} /> : null}
              </div>
            }
          >
            {!canReadTriage ? (
              <p className="text-sm text-slate-500">No tienes el permiso triage:read para ver el análisis del modelo.</p>
            ) : triage ? (
              <div className="space-y-4">
                <p className="text-sm leading-relaxed text-slate-200">{triage.summary}</p>

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                  <span className="font-mono">
                    {triage.model_name} · {triage.prompt_version}
                  </span>
                  <span>Latencia {formatMillis(triage.latency_ms)}</span>
                  <span>
                    Tokens {triage.tokens_in ?? '—'} in / {triage.tokens_out ?? '—'} out
                  </span>
                  {triage.tools_used.length > 0 ? <span>Herramientas: {triage.tools_used.join(', ')}</span> : null}
                  <span>{formatDateTime(triage.created_at)}</span>
                </div>

                {/* Razonamiento */}
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Cadena de razonamiento
                  </h3>
                  {triage.reasoning.length === 0 ? (
                    <p className="text-sm text-slate-500">El modelo no devolvió pasos de razonamiento.</p>
                  ) : (
                    <ol className="space-y-2">
                      {triage.reasoning.map((step, index) => (
                        <li key={index} className="flex gap-2.5 text-sm text-slate-300">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-900 font-mono text-[10px] text-cyan-400">
                            {index + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                {/* Acciones recomendadas */}
                <div>
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    <ListChecks size={13} aria-hidden="true" />
                    Acciones recomendadas
                  </h3>
                  {triage.recommended_actions.length === 0 ? (
                    <p className="text-sm text-slate-500">Sin acciones sugeridas.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {[...triage.recommended_actions]
                        .sort((a: RecommendedAction, b: RecommendedAction) => a.order - b.order)
                        .map((action) => (
                          <li
                            key={`${action.order}-${action.action}`}
                            className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
                          >
                            <span className="flex gap-2 text-sm text-slate-200">
                              <span className="font-mono text-xs text-slate-500">{action.order}.</span>
                              {action.action}
                            </span>
                            <PriorityBadge priority={action.priority} />
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <Bot size={22} className="text-slate-600" aria-hidden="true" />
                <p className="text-sm text-slate-400">Esta alerta aún no tiene un triaje registrado.</p>
                {canRunTriage ? (
                  <button
                    type="button"
                    className="soc-btn-primary"
                    onClick={() => triageMutation.mutate(true)}
                    disabled={triageMutation.isPending}
                  >
                    <Cpu size={15} aria-hidden="true" />
                    {triageMutation.isPending ? 'Ejecutando triaje…' : 'Ejecutar triaje ahora'}
                  </button>
                ) : null}
              </div>
            )}
          </Panel>

          {/* IOCs enriquecidos */}
          <Panel
            title="Indicadores enriquecidos (IOC)"
            icon={<Globe2 size={14} className="text-cyan-400" aria-hidden="true" />}
            actions={<span className="text-[11px] text-slate-500">{iocs.length} indicador(es)</span>}
          >
            {!canReadTriage ? (
              <p className="text-sm text-slate-500">Permiso triage:read requerido.</p>
            ) : iocs.length === 0 ? (
              <p className="text-sm text-slate-500">No se consultaron indicadores externos para esta alerta.</p>
            ) : (
              <div className="soc-scroll-x">
                <table className="soc-table">
                  <thead>
                    <tr>
                      <th className="soc-th">Tipo</th>
                      <th className="soc-th">Indicador</th>
                      <th className="soc-th">Veredicto</th>
                      <th className="soc-th">Proveedor</th>
                      <th className="soc-th">Score</th>
                      <th className="soc-th">Geolocalización / ASN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {iocs.map((ioc, index) => (
                      <tr key={`${ioc.type}-${ioc.value}-${index}`}>
                        <td className="soc-td">
                          <span className="soc-badge border-slate-700 bg-slate-800/60 font-mono uppercase text-slate-300">
                            {ioc.type}
                          </span>
                        </td>
                        <td className="soc-td">
                          <button
                            type="button"
                            className="font-mono text-xs text-cyan-300 hover:underline"
                            onClick={() => {
                              void copyToClipboard(ioc.value).then((ok) => {
                                if (ok) toast.success('Indicador copiado', ioc.value);
                              });
                            }}
                            title="Copiar indicador"
                          >
                            {ioc.value}
                          </button>
                        </td>
                        <td className="soc-td">
                          <span className={cx('soc-badge', iocVerdictClass(ioc.verdict))}>{ioc.verdict ?? 'unknown'}</span>
                        </td>
                        <td className="soc-td text-xs text-slate-400">{ioc.source ?? '—'}</td>
                        <td className="soc-td font-mono text-xs text-slate-300">{ioc.score ?? '—'}</td>
                        <td className="soc-td text-xs text-slate-400">
                          {ioc.country ?? '—'}
                          {ioc.asn ? ` · ${ioc.asn}` : ''}
                          {ioc.as_owner ? ` · ${ioc.as_owner}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {enrichmentQuery.isError ? (
              <p className="mt-2 text-xs text-amber-400">
                No se pudo consultar /alerts/{alert.id}/enrichment: {getErrorMessage(enrichmentQuery.error)}
              </p>
            ) : null}
          </Panel>

          {/* MITRE ATT&CK */}
          <Panel title="MITRE ATT&CK" icon={<Tag size={14} className="text-cyan-400" aria-hidden="true" />}>
            {mitreTechniques.length === 0 ? (
              <p className="text-sm text-slate-500">No se identificaron técnicas MITRE para esta alerta.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {mitreTechniques.map((technique) => (
                  <a
                    key={technique}
                    href={`https://attack.mitre.org/techniques/${technique.replace('.', '/')}/`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="soc-badge border-cyan-800/70 bg-cyan-950/40 font-mono text-cyan-200 hover:border-cyan-600"
                    title={`Ver ${technique} en MITRE ATT&CK`}
                  >
                    <Network size={12} aria-hidden="true" />
                    {technique}
                  </a>
                ))}
                {alert.mitre_tactic ? (
                  <span className="soc-badge border-indigo-800/70 bg-indigo-950/40 text-indigo-200">
                    Táctica: {alert.mitre_tactic}
                  </span>
                ) : null}
              </div>
            )}
          </Panel>

          {/* Log completo */}
          <Panel
            title="Log completo"
            icon={<Hash size={14} className="text-cyan-400" aria-hidden="true" />}
            actions={
              alert.full_log ? (
                <button
                  type="button"
                  className="soc-btn-ghost px-2 py-1 text-xs"
                  onClick={() => {
                    void copyToClipboard(alert.full_log ?? '').then((ok) => {
                      if (ok) toast.success('Log copiado al portapapeles');
                    });
                  }}
                >
                  <ClipboardCopy size={13} aria-hidden="true" />
                  Copiar
                </button>
              ) : null
            }
          >
            {alert.full_log ? (
              <pre className="max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
                {alert.full_log}
              </pre>
            ) : (
              <p className="text-sm text-slate-500">El evento no incluye log completo.</p>
            )}

            {alert.raw_payload && Object.keys(alert.raw_payload).length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-400 hover:text-cyan-300">
                  Payload crudo (JSON)
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-400">
                  {JSON.stringify(alert.raw_payload, null, 2)}
                </pre>
              </details>
            ) : null}
          </Panel>
        </div>

        {/* Columna lateral: acciones + timeline */}
        <div className="space-y-4">
          <Panel title="Panel de acciones" icon={<ShieldAlert size={14} className="text-cyan-400" aria-hidden="true" />}>
            <div className="space-y-4">
              {/* Cambio de estado */}
              <div>
                <label className="soc-label" htmlFor="alert-status">
                  Cambiar estado
                </label>
                <div className="flex gap-2">
                  <select
                    id="alert-status"
                    className="soc-input"
                    value={statusDraft}
                    onChange={(event) => setStatusDraft(event.target.value as AlertStatus | '')}
                    disabled={!canWrite}
                  >
                    <option value="">Selecciona un estado…</option>
                    {ALERT_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {ALERT_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="soc-btn-primary shrink-0"
                    disabled={!canWrite || !statusDraft || statusMutation.isPending}
                    title={canWrite ? undefined : 'Necesitas el permiso alerts:write'}
                    onClick={() => {
                      if (statusDraft) statusMutation.mutate({ status: statusDraft });
                    }}
                  >
                    Aplicar
                  </button>
                </div>
              </div>

              {/* Asignación */}
              <div>
                <label className="soc-label" htmlFor="alert-assignee">
                  Asignar analista
                </label>
                <div className="flex gap-2">
                  <select
                    id="alert-assignee"
                    className="soc-input"
                    value={assignee}
                    onChange={(event) => setAssignee(event.target.value ? Number(event.target.value) : '')}
                    disabled={!canWrite || !canReadUsers}
                  >
                    <option value="">
                      {canReadUsers ? 'Selecciona un analista…' : 'Permiso users:read requerido'}
                    </option>
                    {(usersQuery.data?.items ?? []).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.full_name} ({candidate.username})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="soc-btn-secondary shrink-0"
                    disabled={!canWrite || assignee === '' || statusMutation.isPending}
                    onClick={() => statusMutation.mutate({ assigned_to: assignee === '' ? null : Number(assignee) })}
                  >
                    <UserCheck size={14} aria-hidden="true" />
                    Asignar
                  </button>
                </div>
              </div>

              <div className="space-y-2 border-t border-slate-800 pt-3">
                {/* Triaje */}
                <button
                  type="button"
                  className="soc-btn-primary w-full"
                  disabled={!canRunTriage || triageMutation.isPending}
                  title={canRunTriage ? undefined : 'Necesitas el permiso triage:run'}
                  onClick={() => triageMutation.mutate(Boolean(triage))}
                >
                  <Cpu size={15} className={cx(triageMutation.isPending && 'animate-spin')} aria-hidden="true" />
                  {triageMutation.isPending ? 'Ejecutando triaje…' : triage ? 'Re-ejecutar triaje (force)' : 'Ejecutar triaje'}
                </button>

                {/* Falso positivo */}
                <button
                  type="button"
                  className="soc-btn-secondary w-full"
                  disabled={!canWrite || feedbackMutation.isPending}
                  title={canWrite ? undefined : 'Necesitas el permiso alerts:write'}
                  onClick={() => feedbackMutation.mutate(true)}
                >
                  <CheckCircle2 size={15} aria-hidden="true" />
                  Marcar falso positivo
                </button>

                {/* Confirmar verdadero positivo */}
                <button
                  type="button"
                  className="soc-btn-secondary w-full"
                  disabled={!canWrite || feedbackMutation.isPending}
                  onClick={() => feedbackMutation.mutate(false)}
                >
                  <ShieldAlert size={15} aria-hidden="true" />
                  Confirmar verdadero positivo
                </button>

                {/* Crear incidente */}
                <button
                  type="button"
                  className="soc-btn-secondary w-full"
                  disabled={!canWriteIncidents || Boolean(alert.incident_id)}
                  title={
                    alert.incident_id
                      ? 'La alerta ya está vinculada a un incidente'
                      : canWriteIncidents
                        ? undefined
                        : 'Necesitas el permiso incidents:write'
                  }
                  onClick={openIncidentModal}
                >
                  <Siren size={15} aria-hidden="true" />
                  {alert.incident_id ? `Incidente #${alert.incident_id}` : 'Crear incidente'}
                </button>

                {/* Crear ticket externo */}
                <button
                  type="button"
                  className="soc-btn-secondary w-full"
                  disabled={!canWriteIncidents}
                  onClick={async () => {
                    try {
                      const incident = alert.incident_id
                        ? { id: alert.incident_id }
                        : await incidentsApi.create({
                            title: `Ticket desde alerta #${alert.id}`,
                            priority: alert.severity === 'critical' ? 'p1' : 'p2',
                            severity: alert.severity,
                            alert_ids: [alert.id],
                          });
                      const created = await incidentsApi.addAction(Number(incident.id), {
                        action_type: 'ticket',
                        description: `Ticket externo solicitado desde la alerta #${alert.id}`,
                      });
                      setTicketInfo(`Acción de ticket registrada (id ${created.id}, estado ${created.status}).`);
                      toast.success('Acción de ticket registrada', 'Consulta el detalle del incidente para el enlace externo.');
                      invalidateAlert();
                    } catch (error) {
                      toast.error('No se pudo crear el ticket', getErrorMessage(error));
                    }
                  }}
                >
                  <Ticket size={15} aria-hidden="true" />
                  Crear ticket
                </button>
                {ticketInfo ? <p className="text-[11px] text-emerald-400">{ticketInfo}</p> : null}
              </div>

              {!canWrite ? (
                <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
                  Tu rol tiene acceso de solo lectura sobre alertas. Las acciones de escritura están deshabilitadas.
                </p>
              ) : null}
            </div>
          </Panel>

          {/* Timeline */}
          <Panel
            title="Timeline de la alerta"
            icon={<Clock size={14} className="text-cyan-400" aria-hidden="true" />}
            actions={
              timelineQuery.isFetching ? <RefreshCw size={12} className="animate-spin text-slate-500" aria-hidden="true" /> : null
            }
          >
            {timelineQuery.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : timeline.length === 0 ? (
              <p className="text-sm text-slate-500">Sin eventos registrados en el timeline.</p>
            ) : (
              <ol className="relative space-y-4 border-l border-slate-800 pl-4">
                {[...timeline]
                  .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
                  .map((event) => (
                    <li key={String(event.id)} className="relative">
                      <span
                        className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border border-slate-700 bg-cyan-500"
                        aria-hidden="true"
                      />
                      <p className="text-sm text-slate-200">{event.description}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {formatDateTime(event.occurred_at)}
                        {event.actor_username ?? event.actor ? ` · ${event.actor_username ?? event.actor}` : ''}
                        {event.event_type ? ` · ${event.event_type}` : ''}
                      </p>
                    </li>
                  ))}
              </ol>
            )}
          </Panel>

          {/* Contexto del activo */}
          <Panel title="Contexto del activo" icon={<Building2 size={14} className="text-cyan-400" aria-hidden="true" />}>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Activo (agent_name)</dt>
                <dd className="font-mono text-slate-200">{alert.agent_name ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">ID de agente</dt>
                <dd className="font-mono text-slate-200">{alert.agent_id ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Grupos de regla</dt>
                <dd className="text-right text-slate-200">
                  {alert.rule_groups && alert.rule_groups.length > 0 ? alert.rule_groups.join(', ') : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Fuente</dt>
                <dd className="text-slate-200">{alert.source_name ?? alert.source_type}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">ID externo</dt>
                <dd className="truncate font-mono text-slate-200">{alert.external_id ?? '—'}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>

      {/* Modal de creación de incidente */}
      <Modal
        open={showIncidentModal}
        onClose={() => setShowIncidentModal(false)}
        title="Crear incidente desde la alerta"
        description={`La alerta #${alert.id} quedará vinculada automáticamente al incidente.`}
        size="md"
        preventClose={incidentMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setShowIncidentModal(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={incidentMutation.isPending || incidentForm.title.trim().length < 5}
              onClick={() => incidentMutation.mutate()}
            >
              {incidentMutation.isPending ? 'Creando…' : 'Crear incidente'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="soc-label" htmlFor="incident-title">
              Título
            </label>
            <input
              id="incident-title"
              className="soc-input"
              value={incidentForm.title}
              onChange={(event) => setIncidentForm({ ...incidentForm, title: event.target.value })}
              maxLength={255}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="soc-label" htmlFor="incident-priority">
                Prioridad
              </label>
              <select
                id="incident-priority"
                className="soc-input"
                value={incidentForm.priority}
                onChange={(event) => setIncidentForm({ ...incidentForm, priority: event.target.value as Priority })}
              >
                <option value="p1">P1 · Crítica</option>
                <option value="p2">P2 · Alta</option>
                <option value="p3">P3 · Media</option>
                <option value="p4">P4 · Baja</option>
              </select>
            </div>
            <div>
              <label className="soc-label" htmlFor="incident-severity">
                Severidad
              </label>
              <select
                id="incident-severity"
                className="soc-input"
                value={incidentForm.severity}
                onChange={(event) => setIncidentForm({ ...incidentForm, severity: event.target.value as SeverityLevel })}
              >
                <option value="critical">Crítica</option>
                <option value="high">Alta</option>
                <option value="medium">Media</option>
                <option value="low">Baja</option>
                <option value="info">Informativa</option>
              </select>
            </div>
          </div>
          <div>
            <label className="soc-label" htmlFor="incident-category">
              Categoría
            </label>
            <select
              id="incident-category"
              className="soc-input"
              value={incidentForm.category}
              onChange={(event) => setIncidentForm({ ...incidentForm, category: event.target.value })}
            >
              <option value="malware">Malware</option>
              <option value="intrusion">Intrusión</option>
              <option value="phishing">Phishing</option>
              <option value="dos">Denegación de servicio</option>
              <option value="insider">Amenaza interna</option>
              <option value="other">Otra</option>
            </select>
          </div>
          <div>
            <label className="soc-label" htmlFor="incident-description">
              Descripción
            </label>
            <textarea
              id="incident-description"
              className="soc-input min-h-24"
              value={incidentForm.description}
              onChange={(event) => setIncidentForm({ ...incidentForm, description: event.target.value })}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default AlertDetail;
