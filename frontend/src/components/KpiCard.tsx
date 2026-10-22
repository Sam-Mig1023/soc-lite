/**
 * SOC-Lite · Tarjeta de KPI del dashboard (valor, tendencia, objetivo y sparkline opcional).
 */
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cx } from '@/utils/format';
import { Skeleton } from './States';

export type KpiTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger' | 'critical';

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Texto secundario (unidad, periodo, comparación). */
  hint?: string;
  /** Variación relativa, p. ej. `-0.12` o `12` (porcentaje). */
  trend?: number;
  /** Indica si una subida es buena (`true`) o mala (`false`). */
  trendPositiveIsGood?: boolean;
  target?: ReactNode;
  tone?: KpiTone;
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}

const TONE_STYLES: Record<KpiTone, string> = {
  default: 'border-slate-800 text-slate-100',
  accent: 'border-cyan-800/70 text-cyan-200',
  ok: 'border-emerald-800/70 text-emerald-200',
  warn: 'border-amber-800/70 text-amber-200',
  danger: 'border-red-800/70 text-red-200',
  critical: 'border-red-700 text-red-100',
};

const TONE_ICON: Record<KpiTone, string> = {
  default: 'bg-slate-800/80 text-slate-300',
  accent: 'bg-cyan-950/60 text-cyan-300',
  ok: 'bg-emerald-950/60 text-emerald-300',
  warn: 'bg-amber-950/60 text-amber-300',
  danger: 'bg-red-950/60 text-red-300',
  critical: 'bg-red-950/80 text-red-200',
};

/** Tarjeta KPI accesible: el valor se anuncia como texto completo. */
export function KpiCard({
  label,
  value,
  hint,
  trend,
  trendPositiveIsGood = true,
  target,
  tone = 'default',
  icon,
  loading = false,
  className,
}: KpiCardProps): JSX.Element {
  if (loading) {
    return (
      <div className={cx('soc-panel space-y-3 p-4', className)} aria-hidden="true">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-3 w-32" />
      </div>
    );
  }

  const hasTrend = typeof trend === 'number' && Number.isFinite(trend) && trend !== 0;
  const isUp = typeof trend === 'number' && trend > 0;
  const good = isUp === trendPositiveIsGood;
  const TrendIcon = !hasTrend ? Minus : isUp ? ArrowUpRight : ArrowDownRight;

  return (
    <section
      className={cx('soc-panel flex flex-col gap-2 p-4 transition-colors hover:border-slate-700', TONE_STYLES[tone], className)}
      aria-label={`${label}: ${typeof value === 'string' || typeof value === 'number' ? value : 'valor'}`}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</h3>
        {icon ? (
          <span className={cx('rounded-lg p-1.5', TONE_ICON[tone])} aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </header>

      <p className="font-mono text-2xl font-semibold leading-none text-inherit">{value}</p>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {hint ? <span className="text-slate-400">{hint}</span> : null}
        {hasTrend ? (
          <span
            className={cx('inline-flex items-center gap-0.5 font-medium', good ? 'text-emerald-400' : 'text-red-400')}
          >
            <TrendIcon size={13} aria-hidden="true" />
            {`${isUp ? '+' : ''}${trend?.toFixed(1)} %`}
          </span>
        ) : null}
        {target ? <span className="text-slate-500">Objetivo: {target}</span> : null}
      </footer>
    </section>
  );
}

export default KpiCard;
