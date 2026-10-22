/**
 * SOC-Lite · Estadísticas y precisión del triaje automático.
 *
 * Responde a la pregunta de gestión clave del caso de uso: *¿el LLM está acertando?*
 * Muestra la precisión frente a la validación humana, la distribución de veredictos,
 * el rendimiento por modelo/prompt y el uso real de las herramientas de threat intel.
 *
 * Fuente de datos: GET /triage/stats y GET /triage/results (contrato §4).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Gauge,
  RefreshCw,
  Target,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  ConfidenceBadge,
  DataTable,
  ErrorState,
  FilterField,
  KpiCard,
  Loading,
  SeverityBadge,
  VerdictBadge,
  verdictChartColor,
} from '@/components';
import type { Column } from '@/components';
import { triageApi } from '@/api/triage';
import { LIST_REFRESH_MS, queryKeys } from '@/api/queryClient';
import type { TriageResultListItem } from '@/types/alert';
import { SEVERITY_LEVELS, VERDICT_LABELS } from '@/types/enums';
import type { TriageVerdict } from '@/types/enums';
import { getErrorMessage } from '@/utils/errors';
import {
  cx,
  formatDateTime,
  formatMillis,
  formatNumber,
  formatPercent,
  toPercentNumber,
  truncate,
} from '@/utils/format';

const DAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 7, label: 'Últimos 7 días' },
  { value: 30, label: 'Últimos 30 días' },
  { value: 90, label: 'Últimos 90 días' },
  { value: 365, label: 'Último año' },
];

const TOOLTIP_STYLE = {
  backgroundColor: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: '0.5rem',
  color: '#e2e8f0',
  fontSize: '0.75rem',
};

interface NamedValue {
  name: string;
  value: number;
  verdict?: string;
}

export function TriageStats(): JSX.Element {
  const [days, setDays] = useState(30);
  const [verdictFilter, setVerdictFilter] = useState<TriageVerdict | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  /* ---------------------------------------------------------------- */
  /* Consultas                                                         */
  /* ---------------------------------------------------------------- */
  const statsQuery = useQuery({
    queryKey: queryKeys.triage.stats({ days }),
    queryFn: () => triageApi.stats({ days }),
    refetchInterval: LIST_REFRESH_MS,
    staleTime: 20_000,
  });

  const resultsQuery = useQuery({
    queryKey: queryKeys.triage.results({ page, page_size: pageSize, verdict: verdictFilter || undefined }),
    queryFn: () =>
      triageApi.results({
        page,
        page_size: pageSize,
        ...(verdictFilter ? { verdict: verdictFilter } : {}),
      }),
    refetchInterval: LIST_REFRESH_MS,
    staleTime: 20_000,
  });

  const stats = statsQuery.data;

  /* ---------------------------------------------------------------- */
  /* Series para los gráficos                                          */
  /* ---------------------------------------------------------------- */
  const verdictSeries = useMemo<NamedValue[]>(() => {
    const distribution = stats?.verdict_distribution ?? {};
    return Object.entries(distribution)
      .map(([verdict, count]) => ({
        name: VERDICT_LABELS[verdict as TriageVerdict] ?? verdict,
        verdict,
        value: Number(count) || 0,
      }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [stats]);

  const modelSeries = useMemo(
    () =>
      (stats?.by_model ?? []).map((entry) => ({
        name: entry.model_name,
        ejecuciones: entry.runs ?? 0,
        confianza: toPercentNumber(entry.avg_confidence ?? 0, 0),
      })),
    [stats],
  );

  const latencySeries = useMemo(() => {
    const latency = stats?.latency_ms;
    if (!latency) return [];
    return [
      { metric: 'Media', ms: Math.round(latency.avg ?? 0) },
      { metric: 'Mediana', ms: Math.round(latency.median ?? 0) },
      { metric: 'P95', ms: Math.round(latency.p95 ?? 0) },
      { metric: 'Máxima', ms: Math.round(latency.max ?? 0) },
    ];
  }, [stats]);

  const toolSeries = useMemo(
    () =>
      (stats?.tools_usage ?? [])
        .slice(0, 8)
        .map((entry) => ({ name: entry.tool, invocaciones: entry.count })),
    [stats],
  );

  /* ---------------------------------------------------------------- */
  /* Tabla de triajes recientes                                        */
  /* ---------------------------------------------------------------- */
  const columns = useMemo<Array<Column<TriageResultListItem>>>(
    () => [
      {
        key: 'created_at',
        header: 'Ejecutado',
        render: (row) => (
          <span className="whitespace-nowrap text-slate-300">{formatDateTime(row.created_at)}</span>
        ),
        getValue: (row) => row.created_at,
      },
      {
        key: 'alert_id',
        header: 'Alerta',
        render: (row) => (
          <a className="soc-link font-mono text-xs" href={`/alerts/${row.alert_id}`}>
            #{row.alert_id}
          </a>
        ),
      },
      {
        key: 'alert_rule_id',
        header: 'Regla',
        hideOnMobile: true,
        render: (row) => (
          <span className="font-mono text-xs text-slate-400">{row.alert_rule_id ?? '—'}</span>
        ),
      },
      {
        key: 'verdict',
        header: 'Veredicto',
        render: (row) => <VerdictBadge verdict={row.verdict} />,
      },
      {
        key: 'severity',
        header: 'Severidad',
        render: (row) => <SeverityBadge severity={row.severity} />,
      },
      {
        key: 'confidence',
        header: 'Confianza',
        align: 'center',
        render: (row) => <ConfidenceBadge confidence={row.confidence} />,
      },
      {
        key: 'risk_score',
        header: 'Riesgo',
        align: 'right',
        render: (row) => (
          <span className="font-mono text-sm text-slate-300">{row.risk_score ?? '—'}</span>
        ),
      },
      {
        key: 'latency_ms',
        header: 'Latencia',
        align: 'right',
        hideOnMobile: true,
        render: (row) => (
          <span className="font-mono text-xs text-slate-400">{formatMillis(row.latency_ms)}</span>
        ),
      },
      {
        key: 'summary',
        header: 'Resumen',
        hideOnMobile: true,
        render: (row) => (
          <span className="text-slate-400" title={row.summary}>
            {truncate(row.summary, 80)}
          </span>
        ),
      },
      {
        key: 'human_feedback',
        header: 'Validación',
        align: 'center',
        hideOnMobile: true,
        render: (row) =>
          row.human_feedback === 'confirmed_tp' ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
              <CheckCircle2 size={13} aria-hidden="true" /> TP
            </span>
          ) : row.human_feedback === 'confirmed_fp' ? (
            <span className="inline-flex items-center gap-1 text-xs text-red-400">
              <XCircle size={13} aria-hidden="true" /> FP
            </span>
          ) : (
            <span className="text-xs text-slate-500">pendiente</span>
          ),
      },
    ],
    [],
  );

  const results = resultsQuery.data?.items ?? [];
  const resultsTotal = resultsQuery.data?.total ?? 0;

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */
  if (statsQuery.isError) {
    return (
      <ErrorState
        title="No se pudieron cargar las estadísticas de triaje"
        message={getErrorMessage(statsQuery.error)}
        onRetry={() => void statsQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <BrainCircuit size={20} className="text-cyan-400" aria-hidden="true" />
            Triaje automatizado
          </h1>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-400">
            Precisión del agente LLM frente a la validación humana, rendimiento por modelo y prompt, y uso
            efectivo de las herramientas de inteligencia de amenazas.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <FilterField label="Periodo" htmlFor="triage-days">
            <select
              id="triage-days"
              className="soc-input"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {DAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterField>
          <button
            type="button"
            className="soc-btn-secondary"
            onClick={() => {
              void statsQuery.refetch();
              void resultsQuery.refetch();
            }}
            disabled={statsQuery.isFetching}
          >
            <RefreshCw size={15} className={cx(statsQuery.isFetching && 'animate-spin')} aria-hidden="true" />
            Actualizar
          </button>
        </div>
      </header>

      {/* KPIs */}
      <section className="grid gap-4 soc-grid-auto" aria-label="Indicadores del triaje">
        <KpiCard
          label="Triajes ejecutados"
          value={formatNumber(stats?.total_triaged ?? 0)}
          hint={`En los últimos ${days} días`}
          tone="accent"
          icon={<Activity size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Precisión (TP/(TP+FP))"
          value={stats?.precision != null ? formatPercent(stats.precision) : '—'}
          hint="Frente a veredictos del modelo"
          target="≥ 85 %"
          tone={stats?.precision != null && stats.precision >= 0.85 ? 'ok' : 'warn'}
          icon={<Target size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Concordancia con analista"
          value={
            stats?.agreement_with_human != null ? formatPercent(stats.agreement_with_human) : 'sin datos'
          }
          hint={`${formatNumber(stats?.human_confirmed_tp ?? 0)} TP y ${formatNumber(
            stats?.human_confirmed_fp ?? 0,
          )} FP confirmados`}
          tone="default"
          icon={<CheckCircle2 size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Tasa de falsos positivos"
          value={stats?.false_positive_rate != null ? formatPercent(stats.false_positive_rate) : '—'}
          hint="Objetivo de gestión: ≤ 30 %"
          target="≤ 30 %"
          tone={stats?.false_positive_rate != null && stats.false_positive_rate <= 0.3 ? 'ok' : 'warn'}
          icon={<XCircle size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Confianza media"
          value={stats?.avg_confidence != null ? formatPercent(stats.avg_confidence) : '—'}
          hint="Autoevaluación del modelo"
          tone="default"
          icon={<Gauge size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Latencia media"
          value={formatMillis(stats?.latency_ms.avg ?? stats?.avg_latency_ms ?? 0)}
          hint={`P95 ${formatMillis(stats?.latency_ms.p95 ?? 0)}`}
          tone="default"
          icon={<Clock size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Tokens por triaje"
          value={stats?.avg_tokens != null ? formatNumber(stats.avg_tokens) : '—'}
          hint="Entrada + salida (coste del contexto)"
          tone="default"
          icon={<BrainCircuit size={16} />}
          loading={statsQuery.isLoading}
        />
        <KpiCard
          label="Herramientas usadas"
          value={formatNumber((stats?.tools_usage ?? []).reduce((sum, item) => sum + item.count, 0))}
          hint={`${(stats?.tools_usage ?? []).length} herramientas distintas`}
          tone="default"
          icon={<Wrench size={16} />}
          loading={statsQuery.isLoading}
        />
      </section>

      {/* Gráficos */}
      <section className="grid gap-4 lg:grid-cols-2">
        <article className="soc-panel p-4">
          <h2 className="soc-panel-title mb-3">Distribución de veredictos</h2>
          {statsQuery.isLoading ? (
            <Loading label="Calculando distribución…" />
          ) : verdictSeries.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Sin triajes registrados en el periodo seleccionado.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={verdictSeries}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                >
                  {verdictSeries.map((entry) => (
                    <Cell key={entry.verdict ?? entry.name} fill={verdictChartColor(entry.verdict ?? '')} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: '0.75rem', color: '#94a3b8' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </article>

        <article className="soc-panel p-4">
          <h2 className="soc-panel-title mb-3">Latencia del triaje (ms)</h2>
          {latencySeries.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">Sin datos de latencia.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={latencySeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="metric" stroke="#64748b" fontSize={12} />
                <YAxis stroke="#64748b" fontSize={12} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="ms" fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </article>

        <article className="soc-panel p-4">
          <h2 className="soc-panel-title mb-3">Ejecuciones por modelo</h2>
          {modelSeries.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">Sin datos por modelo.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={modelSeries} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis type="number" stroke="#64748b" fontSize={12} />
                <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={11} width={130} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: '0.75rem', color: '#94a3b8' }} />
                <Bar dataKey="ejecuciones" fill="#22d3ee" radius={[0, 4, 4, 0]} />
                <Bar dataKey="confianza" fill="#34d399" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </article>

        <article className="soc-panel p-4">
          <h2 className="soc-panel-title mb-3">Uso de herramientas de threat intel</h2>
          {toolSeries.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Aún no se han registrado invocaciones de herramientas.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={toolSeries} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis type="number" stroke="#64748b" fontSize={12} />
                <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={11} width={170} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="invocaciones" fill="#a78bfa" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </article>
      </section>

      {/* Distribución por severidad + carga por modelo */}
      <section className="grid gap-4 lg:grid-cols-2">
        <article className="soc-panel p-4">
          <h2 className="soc-panel-title mb-3">Severidad asignada por el LLM</h2>
          <ul className="space-y-2">
            {SEVERITY_LEVELS.map((severity) => {
              const value = stats?.by_severity?.[severity] ?? 0;
              const total = stats?.total_triaged || 1;
              const pct = Math.round((value / total) * 100);
              return (
                <li key={severity} className="flex items-center gap-3">
                  <span className="w-24 shrink-0">
                    <SeverityBadge severity={severity} />
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                    <span
                      className="block h-full rounded-full bg-cyan-500/70"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono text-xs text-slate-400">
                    {formatNumber(value)} ({pct} %)
                  </span>
                </li>
              );
            })}
          </ul>
        </article>

        <article className="soc-panel p-4">
          <h2 className="soc-panel-title mb-3">Rendimiento por modelo y versión de prompt</h2>
          {(stats?.by_model ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">Sin datos por modelo.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="soc-table">
                <caption className="sr-only">Rendimiento por modelo de lenguaje</caption>
                <thead>
                  <tr>
                    <th scope="col">Modelo</th>
                    <th scope="col">Prompt</th>
                    <th scope="col" className="text-right">
                      Ejec.
                    </th>
                    <th scope="col" className="text-right">
                      Confianza
                    </th>
                    <th scope="col" className="text-right">
                      Latencia
                    </th>
                    <th scope="col" className="text-right">
                      % FP
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(stats?.by_model ?? []).map((entry) => (
                    <tr key={`${entry.model_name}-${entry.prompt_version ?? ''}`}>
                      <td className="font-mono text-xs text-slate-200">{entry.model_name}</td>
                      <td className="text-xs text-slate-400">{entry.prompt_version ?? '—'}</td>
                      <td className="text-right font-mono text-xs text-slate-300">{formatNumber(entry.runs)}</td>
                      <td className="text-right font-mono text-xs text-slate-300">
                        {entry.avg_confidence != null ? formatPercent(entry.avg_confidence) : '—'}
                      </td>
                      <td className="text-right font-mono text-xs text-slate-400">
                        {formatMillis(entry.avg_latency_ms ?? null)}
                      </td>
                      <td className="text-right font-mono text-xs text-slate-300">
                        {entry.fp_rate != null ? formatPercent(entry.fp_rate) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      {/* Tabla de triajes recientes */}
      <section aria-label="Triajes recientes">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Triajes recientes</h2>
          <div className="w-56">
            <FilterField label="Filtrar por veredicto" htmlFor="triage-verdict">
              <select
                id="triage-verdict"
                className="soc-input"
                value={verdictFilter}
                onChange={(event) => {
                  setVerdictFilter(event.target.value as TriageVerdict | '');
                  setPage(1);
                }}
              >
                <option value="">Todos los veredictos</option>
                {Object.entries(VERDICT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FilterField>
          </div>
        </div>

        {resultsQuery.isError ? (
          <ErrorState
            message={getErrorMessage(resultsQuery.error)}
            onRetry={() => void resultsQuery.refetch()}
          />
        ) : (
          <DataTable<TriageResultListItem>
            columns={columns}
            data={results}
            rowKey="id"
            loading={resultsQuery.isLoading}
            page={page}
            pageSize={pageSize}
            total={resultsTotal}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            emptyTitle="Sin triajes registrados"
            emptyDescription="Ejecuta un triaje desde el detalle de una alerta para poblar esta vista."
            caption="Resultados de triaje del agente LLM"
          />
        )}
      </section>
    </div>
  );
}

export default TriageStats;
