/**
 * SOC-Lite · Dashboard de métricas.
 *
 * 8 tarjetas KPI + 7 visualizaciones Recharts. Cada widget se alimenta de un endpoint
 * del contrato §6 (ver docs/04-frontend.md para el mapeo widget → endpoint).
 * Auto-refresh cada 30 s mediante TanStack Query.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Bell,
  Bot,
  Clock,
  Filter,
  Gauge,
  Percent,
  RefreshCw,
  Siren,
  TrendingDown,
  Users,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { dashboardApi } from '@/api/dashboard';
import { triageApi } from '@/api/triage';
import { DASHBOARD_REFRESH_MS, queryKeys } from '@/api/queryClient';
import { KpiCard } from '@/components/KpiCard';
import { ErrorState, SkeletonCards } from '@/components/States';
import { SEVERITY_CHART_COLORS, verdictChartColor } from '@/components/Badges';
import { DateRangePicker, isoFrom, isoTo, type DateRangeValue } from '@/components/DateRangePicker';
import { SEVERITY_LEVELS, SEVERITY_LABELS, VERDICT_LABELS, type SeverityLevel, type TriageVerdict } from '@/types/enums';
import type { SeveritySeriesPoint, TopSourceItem } from '@/types/dashboard';
import { getErrorMessage } from '@/utils/errors';
import { cx, formatDuration, formatNumber, formatPercent, toIsoDate, toPercentNumber } from '@/utils/format';

/** Paleta oscura compartida por todos los gráficos. */
const CHART_THEME = {
  grid: '#1e293b',
  axis: '#64748b',
  tooltipBg: '#0f172a',
  tooltipBorder: '#334155',
  target: '#22d3ee',
} as const;

const TOOLTIP_STYLE = {
  backgroundColor: CHART_THEME.tooltipBg,
  border: `1px solid ${CHART_THEME.tooltipBorder}`,
  borderRadius: '0.5rem',
  color: '#e2e8f0',
  fontSize: '12px',
};

const toNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Extrae una etiqueta legible de un item de `top-sources`. */
function sourceLabel(item: TopSourceItem): string {
  return item.label ?? item.value ?? item.name ?? item.rule_id ?? item.agent_name ?? '—';
}

/** Envuelve cada widget con título, estado de carga y error locales. */
function Widget({
  title,
  description,
  icon,
  loading,
  error,
  onRetry,
  height = 260,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: JSX.Element;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  height?: number;
  actions?: JSX.Element | null;
  children: JSX.Element;
  className?: string;
}): JSX.Element {
  return (
    <section className={cx('soc-panel flex flex-col', className)}>
      <header className="soc-panel-header">
        <div className="min-w-0">
          <h2 className="soc-panel-title flex items-center gap-2">
            {icon}
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className="p-3" style={{ minHeight: height }}>
        {error ? (
          <ErrorState message={error} onRetry={onRetry} className="py-6" />
        ) : loading ? (
          <div className="flex h-full items-center justify-center py-10">
            <RefreshCw size={20} className="animate-spin text-cyan-500/70" aria-hidden="true" />
            <span className="sr-only">Cargando gráfico {title}</span>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** Dashboard principal del SOC. */
export function Dashboard(): JSX.Element {
  const [range, setRange] = useState<DateRangeValue>(() => {
    const today = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return { from: toIsoDate(start), to: toIsoDate(today) };
  });
  const [mtttDays, setMtttDays] = useState(30);

  const params = useMemo(
    () => ({ from: isoFrom(range.from), to: isoTo(range.to) }),
    [range.from, range.to],
  );

  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.summary(params),
    queryFn: () => dashboardApi.summary(params),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  const severityQuery = useQuery({
    queryKey: queryKeys.dashboard.bySeverity({ ...params, granularity: 'day' }),
    queryFn: () => dashboardApi.alertsBySeverity({ ...params, granularity: 'day' }),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  const mtttQuery = useQuery({
    queryKey: queryKeys.dashboard.mtttTrend(mtttDays),
    queryFn: () => dashboardApi.mtttTrend(mtttDays),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  const topQuery = useQuery({
    queryKey: queryKeys.dashboard.topSources(10, params),
    queryFn: () => dashboardApi.topSources(10, params),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  const slaQuery = useQuery({
    queryKey: queryKeys.dashboard.slaCompliance(params),
    queryFn: () => dashboardApi.slaCompliance(params),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  const workloadQuery = useQuery({
    queryKey: queryKeys.dashboard.analystWorkload(params),
    queryFn: () => dashboardApi.analystWorkload(params),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  /** Distribución de veredictos: única métrica que vive en /triage/stats (contrato §4). */
  const statsQuery = useQuery({
    queryKey: queryKeys.triage.stats(params),
    queryFn: () => triageApi.stats({ from: params.from, to: params.to }),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });

  const summary = summaryQuery.data;

  /* --------------------------- Datos derivados --------------------------- */

  const severityBars = useMemo(
    () =>
      SEVERITY_LEVELS.map((level) => ({
        severity: SEVERITY_LABELS[level],
        key: level,
        total: toNumber(summary?.by_severity?.[level]),
      })),
    [summary],
  );

  const severitySeries = useMemo(() => {
    const rows = severityQuery.data ?? [];
    return rows.map((point: SeveritySeriesPoint) => ({
      period: point.period,
      critical: toNumber(point.critical),
      high: toNumber(point.high),
      medium: toNumber(point.medium),
      low: toNumber(point.low),
      info: toNumber(point.info),
    }));
  }, [severityQuery.data]);

  const mtttSeries = useMemo(
    () =>
      (mtttQuery.data ?? []).map((point) => ({
        date: point.date,
        mttt: Math.round(toNumber(point.mttt_avg_sec)),
        p95: Math.round(toNumber(point.mttt_p95_sec)),
        objetivo: Math.round(toNumber(point.target_sla_sec ?? point.target_sec ?? 900)),
      })),
    [mtttQuery.data],
  );

  const verdictPie = useMemo(() => {
    const distribution = statsQuery.data?.verdict_distribution;
    if (!distribution) return [];
    return Object.entries(distribution).map(([verdict, count]) => ({
      name: VERDICT_LABELS[verdict as TriageVerdict] ?? verdict,
      verdict,
      value: toNumber(count),
    }));
  }, [statsQuery.data]);

  const topIps = useMemo(
    () => (topQuery.data?.source_ips ?? []).slice(0, 10).map((item) => ({ name: sourceLabel(item), total: toNumber(item.count) })),
    [topQuery.data],
  );

  const topRules = useMemo(
    () =>
      (topQuery.data?.rules ?? []).slice(0, 10).map((item) => ({
        name: item.rule_id ? `${item.rule_id} · ${item.rule_description ?? ''}`.slice(0, 42) : sourceLabel(item),
        total: toNumber(item.count),
      })),
    [topQuery.data],
  );

  const slaRows = useMemo(() => {
    const items = slaQuery.data?.items;
    if (items && items.length > 0) {
      return items.map((item) => ({
        severity: SEVERITY_LABELS[item.severity] ?? item.severity,
        cumplimiento: toPercentNumber(item.compliance),
        objetivo: toPercentNumber(item.target ?? (item.severity === 'critical' ? 0.95 : 0.9)),
      }));
    }
    const map = slaQuery.data?.by_severity;
    if (map) {
      return SEVERITY_LEVELS.filter((level) => map[level] !== undefined).map((level) => ({
        severity: SEVERITY_LABELS[level],
        cumplimiento: toPercentNumber(map[level]),
        objetivo: level === 'critical' ? 95 : 90,
      }));
    }
    return [];
  }, [slaQuery.data]);

  const workloadRows = useMemo(
    () =>
      (workloadQuery.data ?? []).map((item) => ({
        name: item.full_name ?? item.username,
        abiertas: toNumber(item.abiertas),
        escaladas: toNumber(item.escaladas),
        cerradas: toNumber(item.cerradas),
      })),
    [workloadQuery.data],
  );

  const summaryError = summaryQuery.isError ? getErrorMessage(summaryQuery.error) : null;

  return (
    <div className="space-y-5">
      {/* Encabezado */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Dashboard operativo</h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Métricas de triaje, ruido y cumplimiento de SLA
            {summary?.period ? (
              <>
                {' '}
                · periodo <span className="font-mono text-xs text-slate-300">
                  {summary.period.from.slice(0, 10)} → {summary.period.to.slice(0, 10)}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-400">
            <RefreshCw size={12} className="text-cyan-400" aria-hidden="true" />
            Auto-refresh 30 s
          </span>
          <DateRangePicker value={range} onChange={setRange} presets={[7, 30, 90]} />
        </div>
      </header>

      {/* KPIs */}
      {summaryQuery.isPending ? (
        <SkeletonCards count={8} />
      ) : summaryError ? (
        <div className="soc-panel p-4">
          <ErrorState
            title="No se pudieron cargar los KPI"
            message={summaryError}
            onRetry={() => void summaryQuery.refetch()}
          />
        </div>
      ) : (
        <div className="grid gap-4 soc-grid-auto">
          <KpiCard
            label="Alertas totales"
            value={formatNumber(summary?.alerts_total)}
            hint="En el periodo seleccionado"
            icon={<Bell size={15} />}
            tone="accent"
          />
          <KpiCard
            label="Pendientes"
            value={formatNumber(summary?.alerts_pending)}
            hint="Requieren triaje o cierre"
            icon={<Activity size={15} />}
            tone={toNumber(summary?.alerts_pending) > 100 ? 'warn' : 'default'}
          />
          <KpiCard
            label="MTTT promedio"
            value={formatDuration(summary?.mttt_seconds?.avg)}
            hint="Tiempo medio hasta el triaje"
            icon={<Clock size={15} />}
            target={formatDuration(900)}
          />
          <KpiCard
            label="MTTT mediana"
            value={formatDuration(summary?.mttt_seconds?.median)}
            hint="Valor central (p50)"
            icon={<Clock size={15} />}
          />
          <KpiCard
            label="MTTT p95"
            value={formatDuration(summary?.mttt_seconds?.p95)}
            hint="95 % de las alertas por debajo"
            icon={<Gauge size={15} />}
            tone={toNumber(summary?.mttt_seconds?.p95) > 3600 ? 'warn' : 'ok'}
            target={formatDuration(3600)}
          />
          <KpiCard
            label="Tasa de falsos positivos"
            value={formatPercent(summary?.false_positive_rate)}
            hint="Etiquetado humano + modelo"
            icon={<Percent size={15} />}
            tone={toNumber(summary?.false_positive_rate) > 0.3 ? 'warn' : 'ok'}
            target="< 30 %"
          />
          <KpiCard
            label="Automatización"
            value={formatPercent(summary?.automation_rate)}
            hint="Alertas triadas sin intervención"
            icon={<Bot size={15} />}
            tone={toNumber(summary?.automation_rate) >= 0.85 ? 'ok' : 'warn'}
            target="≥ 85 %"
          />
          <KpiCard
            label="Reducción de ruido"
            value={formatPercent(summary?.noise_reduction)}
            hint="Frente al volumen crudo del SIEM"
            icon={<Filter size={15} />}
            tone="ok"
            target="≥ 70 %"
          />
          <KpiCard
            label="Incidentes abiertos"
            value={formatNumber(summary?.incidents_open)}
            hint="Estado distinto de cerrado"
            icon={<Siren size={15} />}
            tone={toNumber(summary?.incidents_open) > 10 ? 'danger' : 'default'}
            trendPositiveIsGood={false}
          />
        </div>
      )}

      {/* Cumplimiento SLA por severidad (indicadores del resumen) */}
      {summary?.sla_compliance ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {SEVERITY_LEVELS.map((level) => (
            <KpiCard
              key={level}
              label={`SLA ${SEVERITY_LABELS[level]}`}
              value={formatPercent(summary.sla_compliance?.[level])}
              hint={level === 'critical' ? 'Objetivo < 15 min' : level === 'high' ? 'Objetivo < 1 h' : 'Objetivo < 8 h'}
              tone={toNumber(summary.sla_compliance?.[level]) >= 0.9 ? 'ok' : 'warn'}
            />
          ))}
        </div>
      ) : null}

      {/* Gráficos principales */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Widget
          title="Alertas por severidad"
          description="Distribución del volumen en el periodo"
          icon={<BarChart3 size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={summaryQuery.isPending}
          error={summaryError}
          onRetry={() => void summaryQuery.refetch()}
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={severityBars} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
              <XAxis dataKey="severity" stroke={CHART_THEME.axis} fontSize={11} />
              <YAxis stroke={CHART_THEME.axis} fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(34,211,238,0.06)' }} />
              <Bar dataKey="total" name="Alertas" radius={[4, 4, 0, 0]}>
                {severityBars.map((entry) => (
                  <Cell key={entry.key} fill={SEVERITY_CHART_COLORS[entry.key as SeverityLevel]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Widget>

        <Widget
          title="Evolución por severidad"
          description="Serie temporal diaria del volumen, apilada por severidad"
          icon={<BarChart3 size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={severityQuery.isPending}
          error={severityQuery.isError ? getErrorMessage(severityQuery.error) : null}
          onRetry={() => void severityQuery.refetch()}
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={severitySeries} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
              <XAxis
                dataKey="period"
                stroke={CHART_THEME.axis}
                fontSize={11}
                tickFormatter={(value: string) => value.slice(5, 10)}
              />
              <YAxis stroke={CHART_THEME.axis} fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(34,211,238,0.06)' }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              <Bar dataKey="info" name="Informativa" stackId="sev" fill={SEVERITY_CHART_COLORS.info} />
              <Bar dataKey="low" name="Baja" stackId="sev" fill={SEVERITY_CHART_COLORS.low} />
              <Bar dataKey="medium" name="Media" stackId="sev" fill={SEVERITY_CHART_COLORS.medium} />
              <Bar dataKey="high" name="Alta" stackId="sev" fill={SEVERITY_CHART_COLORS.high} />
              <Bar
                dataKey="critical"
                name="Crítica"
                stackId="sev"
                fill={SEVERITY_CHART_COLORS.critical}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </Widget>

        <Widget
          title="Tendencia MTTT vs objetivo SLA"
          description="Minutos medios hasta el triaje, por día"
          icon={<TrendingDown size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={mtttQuery.isPending}
          error={mtttQuery.isError ? getErrorMessage(mtttQuery.error) : null}
          onRetry={() => void mtttQuery.refetch()}
          actions={
            <select
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"
              value={mtttDays}
              onChange={(event) => setMtttDays(Number(event.target.value))}
              aria-label="Días de la tendencia MTTT"
            >
              {[7, 14, 30, 60, 90].map((days) => (
                <option key={days} value={days}>
                  {days} días
                </option>
              ))}
            </select>
          }
        >
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={mtttSeries} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
              <XAxis dataKey="date" stroke={CHART_THEME.axis} fontSize={11} tickFormatter={(value: string) => value.slice(5)} />
              <YAxis stroke={CHART_THEME.axis} fontSize={11} tickFormatter={(value: number) => `${Math.round(value / 60)}m`} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number, name: string) => [`${formatDuration(value)}`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              <Line type="monotone" dataKey="mttt" name="MTTT promedio" stroke="#22d3ee" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p95" name="MTTT p95" stroke="#f59e0b" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
              <Line
                type="monotone"
                dataKey="objetivo"
                name="Objetivo SLA"
                stroke={CHART_THEME.target}
                strokeWidth={1}
                strokeDasharray="6 4"
                dot={false}
                legendType="plainline"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </Widget>

        <Widget
          title="Distribución de veredictos"
          description="Salida del modelo de triaje"
          icon={<Bot size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={statsQuery.isPending}
          error={statsQuery.isError ? getErrorMessage(statsQuery.error) : null}
          onRetry={() => void statsQuery.refetch()}
        >
          {verdictPie.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-sm text-slate-500">
              <AlertOctagon size={22} aria-hidden="true" />
              Aún no hay triajes registrados en el periodo.
              <Link to="/triage" className="soc-link text-xs">
                Ver estadísticas de triaje
              </Link>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={verdictPie}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={95}
                  paddingAngle={2}
                  label={(props: { name?: string; percent?: number }) =>
                    `${props.name ?? ''} ${((props.percent ?? 0) * 100).toFixed(0)}%`
                  }
                  labelLine={false}
                >
                  {verdictPie.map((entry) => (
                    <Cell key={entry.verdict} fill={verdictChartColor(entry.verdict as TriageVerdict)} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Widget>

        <Widget
          title="Cumplimiento SLA por severidad"
          description="Porcentaje de alertas triadas dentro del objetivo"
          icon={<Gauge size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={slaQuery.isPending}
          error={slaQuery.isError ? getErrorMessage(slaQuery.error) : null}
          onRetry={() => void slaQuery.refetch()}
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={slaRows} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
              <XAxis type="number" domain={[0, 100]} stroke={CHART_THEME.axis} fontSize={11} tickFormatter={(v: number) => `${v}%`} />
              <YAxis type="category" dataKey="severity" stroke={CHART_THEME.axis} fontSize={11} width={70} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => [`${value} %`, 'Cumplimiento']} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              <Bar dataKey="cumplimiento" name="Cumplimiento" fill="#10b981" radius={[0, 4, 4, 0]} barSize={14} />
              <Bar dataKey="objetivo" name="Objetivo" fill="#334155" radius={[0, 4, 4, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </Widget>

        <Widget
          title="Top 10 IPs de origen"
          description="Orígenes con más alertas en el periodo"
          icon={<Activity size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={topQuery.isPending}
          error={topQuery.isError ? getErrorMessage(topQuery.error) : null}
          onRetry={() => void topQuery.refetch()}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topIps} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
              <XAxis type="number" stroke={CHART_THEME.axis} fontSize={11} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke={CHART_THEME.axis} fontSize={10} width={110} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="total" name="Alertas" fill="#22d3ee" radius={[0, 4, 4, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </Widget>

        <Widget
          title="Top 10 reglas disparadas"
          description="Reglas del SIEM con mayor volumen"
          icon={<BarChart3 size={14} className="text-cyan-400" aria-hidden="true" />}
          loading={topQuery.isPending}
          error={topQuery.isError ? getErrorMessage(topQuery.error) : null}
          onRetry={() => void topQuery.refetch()}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topRules} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
              <XAxis type="number" stroke={CHART_THEME.axis} fontSize={11} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke={CHART_THEME.axis} fontSize={10} width={150} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="total" name="Alertas" fill="#10b981" radius={[0, 4, 4, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </Widget>
      </div>

      {/* Carga por analista */}
      <Widget
        title="Carga por analista"
        description="Alertas abiertas, escaladas y cerradas por responsable"
        icon={<Users size={14} className="text-cyan-400" aria-hidden="true" />}
        loading={workloadQuery.isPending}
        error={workloadQuery.isError ? getErrorMessage(workloadQuery.error) : null}
        onRetry={() => void workloadQuery.refetch()}
        height={320}
      >
        {workloadRows.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">Sin datos de carga por analista en el periodo.</p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={workloadRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
              <XAxis dataKey="name" stroke={CHART_THEME.axis} fontSize={11} interval={0} angle={-12} textAnchor="end" height={54} />
              <YAxis stroke={CHART_THEME.axis} fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(34,211,238,0.06)' }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
              <Bar dataKey="abiertas" name="Abiertas" stackId="a" fill="#22d3ee" />
              <Bar dataKey="escaladas" name="Escaladas" stackId="a" fill="#ef4444" />
              <Bar dataKey="cerradas" name="Cerradas" stackId="a" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Widget>

      {/* Objetivos KPI (db/seed.sql kpi_targets) */}
      <section className="soc-panel p-4">
        <h2 className="soc-panel-title mb-3">Objetivos de gestión (kpi_targets)</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { code: 'mttt_critical', label: 'MTTT alertas críticas', target: 900, actual: toNumber(summary?.mttt_seconds?.avg), unit: 'seconds' },
            { code: 'fp_rate', label: 'Tasa de falsos positivos tolerada', target: 0.3, actual: toNumber(summary?.false_positive_rate), unit: 'percent' },
            { code: 'automation_rate', label: 'Automatización del triaje', target: 0.85, actual: toNumber(summary?.automation_rate), unit: 'percent' },
            { code: 'noise_reduction', label: 'Reducción de ruido', target: 0.7, actual: toNumber(summary?.noise_reduction), unit: 'percent' },
          ].map((kpi) => {
            const ok =
              kpi.unit === 'seconds' ? kpi.actual <= kpi.target : kpi.actual >= kpi.target;
            return (
              <div
                key={kpi.code}
                className={cx(
                  'rounded-lg border px-3 py-2.5',
                  ok ? 'border-emerald-800/60 bg-emerald-950/20' : 'border-amber-800/60 bg-amber-950/20',
                )}
              >
                <p className="text-xs text-slate-400">{kpi.label}</p>
                <p className="mt-1 font-mono text-sm text-slate-100">
                  {kpi.unit === 'seconds' ? formatDuration(kpi.actual) : formatPercent(kpi.actual)}
                  <span className="ml-2 text-xs text-slate-500">
                    objetivo {kpi.unit === 'seconds' ? formatDuration(kpi.target) : formatPercent(kpi.target, 0)}
                  </span>
                </p>
                <p className={cx('mt-1 text-[11px]', ok ? 'text-emerald-400' : 'text-amber-400')}>
                  {ok ? 'Dentro del objetivo' : 'Por debajo del objetivo'}
                </p>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default Dashboard;
