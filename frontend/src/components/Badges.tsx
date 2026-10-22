/**
 * SOC-Lite · Badges de severidad, estado de alerta, veredicto, prioridad,
 * estado de incidente, resultado de auditoría y riesgo numérico.
 * Los valores aceptados son EXACTAMENTE los del contrato (docs/00-contrato-api.md).
 */
import { AlertTriangle, CheckCircle2, HelpCircle, ShieldAlert, ShieldCheck } from 'lucide-react';
import type {
  AlertStatus,
  AuditResult,
  IncidentStatus,
  Priority,
  SeverityLevel,
  SourceType,
  TriageVerdict,
} from '@/types/enums';
import {
  ALERT_STATUS_LABELS,
  AUDIT_RESULT_LABELS,
  INCIDENT_STATUS_LABELS,
  PRIORITY_LABELS,
  SEVERITY_LABELS,
  SOURCE_TYPE_LABELS,
  VERDICT_LABELS,
} from '@/types/enums';
import { cx } from '@/utils/format';

/* ------------------------------------------------------------------ */
/* Severidad                                                           */
/* ------------------------------------------------------------------ */

const SEVERITY_CLASSES: Record<SeverityLevel, string> = {
  info: 'border-slate-600/70 bg-slate-700/30 text-slate-300',
  low: 'border-sky-700/70 bg-sky-900/30 text-sky-300',
  medium: 'border-amber-700/70 bg-amber-900/30 text-amber-300',
  high: 'border-orange-700/70 bg-orange-900/30 text-orange-300',
  critical: 'border-red-700 bg-red-900/40 text-red-200',
};

const SEVERITY_DOT: Record<SeverityLevel, string> = {
  info: 'bg-slate-400',
  low: 'bg-sky-400',
  medium: 'bg-amber-400',
  high: 'bg-orange-400',
  critical: 'bg-red-500 animate-pulse-slow',
};

/** Color sólido por severidad (para gráficos Recharts). */
export const SEVERITY_CHART_COLORS: Record<SeverityLevel, string> = {
  info: '#64748b',
  low: '#38bdf8',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};

export interface SeverityBadgeProps {
  severity: SeverityLevel | string | null | undefined;
  className?: string;
  withDot?: boolean;
  /** Añade el prefijo "Severidad:" para lectores de pantalla. */
  showLabel?: boolean;
}

/** Chip de severidad con color por nivel. */
export function SeverityBadge({
  severity,
  className,
  withDot = true,
  showLabel = false,
}: SeverityBadgeProps): JSX.Element {
  const key = (severity ?? 'info') as SeverityLevel;
  const styles = SEVERITY_CLASSES[key] ?? SEVERITY_CLASSES.info;
  const label = SEVERITY_LABELS[key] ?? String(severity ?? '—');
  return (
    <span
      className={cx('soc-badge', styles, className)}
      title={`Severidad: ${label}`}
      aria-label={showLabel ? `Severidad: ${label}` : undefined}
    >
      {withDot ? <span className={cx('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[key] ?? 'bg-slate-400')} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Estado de alerta                                                    */
/* ------------------------------------------------------------------ */

const ALERT_STATUS_CLASSES: Record<AlertStatus, string> = {
  pending: 'border-amber-700/70 bg-amber-950/40 text-amber-300',
  enriching: 'border-cyan-700/70 bg-cyan-950/40 text-cyan-300',
  triaged: 'border-indigo-700/70 bg-indigo-950/40 text-indigo-300',
  escalated: 'border-red-700/70 bg-red-950/40 text-red-300',
  closed: 'border-emerald-700/70 bg-emerald-950/40 text-emerald-300',
  false_positive: 'border-slate-600/70 bg-slate-800/50 text-slate-400',
};

export interface StatusBadgeProps {
  status: AlertStatus | string | null | undefined;
  className?: string;
}

/** Chip de estado de alerta. */
export function StatusBadge({ status, className }: StatusBadgeProps): JSX.Element {
  const key = (status ?? 'pending') as AlertStatus;
  const styles = ALERT_STATUS_CLASSES[key] ?? ALERT_STATUS_CLASSES.pending;
  const label = ALERT_STATUS_LABELS[key] ?? String(status ?? '—');
  return (
    <span className={cx('soc-badge', styles, className)} title={`Estado: ${label}`}>
      <span className="sr-only">Estado: </span>
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Veredicto de triaje                                                 */
/* ------------------------------------------------------------------ */

const VERDICT_CLASSES: Record<TriageVerdict, string> = {
  true_positive: 'border-red-700 bg-red-950/40 text-red-200',
  false_positive: 'border-slate-600 bg-slate-800/50 text-slate-300',
  benign: 'border-emerald-700 bg-emerald-950/40 text-emerald-300',
  suspicious: 'border-amber-700 bg-amber-950/40 text-amber-300',
  inconclusive: 'border-slate-600 bg-slate-800/60 text-slate-400',
};

const VERDICT_CHART_COLORS: Record<TriageVerdict, string> = {
  true_positive: '#ef4444',
  false_positive: '#64748b',
  benign: '#10b981',
  suspicious: '#f59e0b',
  inconclusive: '#8b5cf6',
};

export const VERDICT_COLORS = VERDICT_CHART_COLORS;

export interface VerdictBadgeProps {
  verdict: TriageVerdict | string | null | undefined;
  className?: string;
}

/** Chip del veredicto del modelo (true_positive, false_positive, …). */
export function VerdictBadge({ verdict, className }: VerdictBadgeProps): JSX.Element {
  if (!verdict) {
    return (
      <span className={cx('soc-badge border-slate-700 bg-slate-900 text-slate-500', className)} title="Sin triaje">
        <HelpCircle size={12} aria-hidden="true" />
        Sin triaje
      </span>
    );
  }
  const key = verdict as TriageVerdict;
  const styles = VERDICT_CLASSES[key] ?? VERDICT_CLASSES.inconclusive;
  const label = VERDICT_LABELS[key] ?? String(verdict);
  const Icon = key === 'true_positive' ? ShieldAlert : key === 'benign' ? ShieldCheck : key === 'false_positive' ? CheckCircle2 : AlertTriangle;
  return (
    <span className={cx('soc-badge', styles, className)} title={`Veredicto: ${label}`}>
      <Icon size={12} aria-hidden="true" />
      <span className="sr-only">Veredicto: </span>
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Riesgo, prioridad, incidente, resultado y origen                    */
/* ------------------------------------------------------------------ */

/** Color semántico según `risk_score` (0–100). */
export function riskTone(score: number | null | undefined): 'ok' | 'warn' | 'danger' | 'muted' {
  if (score === null || score === undefined) return 'muted';
  if (score >= 80) return 'danger';
  if (score >= 50) return 'warn';
  return 'ok';
}

export interface RiskScoreProps {
  score: number | null | undefined;
  className?: string;
  showMeter?: boolean;
}

/** Puntuación de riesgo (0–100) con barra opcional. */
export function RiskScore({ score, className, showMeter = true }: RiskScoreProps): JSX.Element {
  const tone = riskTone(score);
  const color =
    tone === 'danger'
      ? 'text-red-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'ok'
          ? 'text-emerald-300'
          : 'text-slate-500';
  const bar =
    tone === 'danger' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'ok' ? 'bg-emerald-500' : 'bg-slate-700';
  const value = score ?? null;
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <span className={cx('font-mono text-sm font-semibold', color)} aria-label={`Riesgo ${value ?? 'sin calcular'}`}>
        {value ?? '—'}
      </span>
      {showMeter && value !== null ? (
        <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-slate-800 sm:block" aria-hidden="true">
          <span className={cx('block h-full rounded-full', bar)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
        </span>
      ) : null}
    </div>
  );
}

const PRIORITY_CLASSES: Record<Priority, string> = {
  p1: 'border-red-700 bg-red-950/50 text-red-200',
  p2: 'border-orange-700 bg-orange-950/50 text-orange-200',
  p3: 'border-amber-700 bg-amber-950/50 text-amber-200',
  p4: 'border-slate-600 bg-slate-800/60 text-slate-300',
};

export const PRIORITY_CHART_COLORS: Record<Priority, string> = {
  p1: '#ef4444',
  p2: '#f97316',
  p3: '#f59e0b',
  p4: '#64748b',
};

export interface PriorityBadgeProps {
  priority: Priority | string | null | undefined;
  className?: string;
}

/** Chip de prioridad p1–p4. */
export function PriorityBadge({ priority, className }: PriorityBadgeProps): JSX.Element {
  const key = (priority ?? 'p4') as Priority;
  return (
    <span className={cx('soc-badge', PRIORITY_CLASSES[key] ?? PRIORITY_CLASSES.p4, className)}>
      {PRIORITY_LABELS[key] ?? String(priority ?? '—')}
    </span>
  );
}

const INCIDENT_STATUS_CLASSES: Record<IncidentStatus, string> = {
  open: 'border-red-700/70 bg-red-950/40 text-red-300',
  in_progress: 'border-amber-700/70 bg-amber-950/40 text-amber-300',
  contained: 'border-cyan-700/70 bg-cyan-950/40 text-cyan-300',
  resolved: 'border-emerald-700/70 bg-emerald-950/40 text-emerald-300',
  closed: 'border-slate-600/70 bg-slate-800/50 text-slate-400',
};

export interface IncidentStatusBadgeProps {
  status: IncidentStatus | string | null | undefined;
  className?: string;
}

/** Chip de estado de incidente. */
export function IncidentStatusBadge({ status, className }: IncidentStatusBadgeProps): JSX.Element {
  const key = (status ?? 'open') as IncidentStatus;
  return (
    <span className={cx('soc-badge', INCIDENT_STATUS_CLASSES[key] ?? INCIDENT_STATUS_CLASSES.open, className)}>
      <span className="sr-only">Estado: </span>
      {INCIDENT_STATUS_LABELS[key] ?? String(status ?? '—')}
    </span>
  );
}

const AUDIT_RESULT_CLASSES: Record<AuditResult, string> = {
  success: 'border-emerald-700/70 bg-emerald-950/40 text-emerald-300',
  failure: 'border-red-700/70 bg-red-950/40 text-red-300',
  denied: 'border-amber-700/70 bg-amber-950/40 text-amber-300',
};

export interface AuditResultBadgeProps {
  result: AuditResult | string | null | undefined;
  className?: string;
}

/** Chip del resultado de un evento de bitácora (success|failure|denied). */
export function AuditResultBadge({ result, className }: AuditResultBadgeProps): JSX.Element {
  const key = (result ?? 'success') as AuditResult;
  return (
    <span className={cx('soc-badge', AUDIT_RESULT_CLASSES[key] ?? AUDIT_RESULT_CLASSES.success, className)}>
      {AUDIT_RESULT_LABELS[key] ?? String(result ?? '—')}
    </span>
  );
}

export interface SourceTypeBadgeProps {
  source: SourceType | string | null | undefined;
  className?: string;
}

/** Chip del origen de la telemetría (wazuh, opnsense, …). */
export function SourceTypeBadge({ source, className }: SourceTypeBadgeProps): JSX.Element {
  const key = (source ?? 'manual') as SourceType;
  return (
    <span
      className={cx(
        'soc-badge border-slate-700 bg-slate-800/60 text-slate-300 font-mono uppercase',
        className,
      )}
      title={`Origen: ${SOURCE_TYPE_LABELS[key] ?? source ?? '—'}`}
    >
      {SOURCE_TYPE_LABELS[key] ?? String(source ?? '—')}
    </span>
  );
}

export interface ConfidenceBadgeProps {
  /** Confianza del modelo en escala 0–1. */
  confidence: number | null | undefined;
  className?: string;
}

/** Badge de confianza del LLM (alto ≥ 0,8 · medio ≥ 0,6 · bajo < 0,6). */
export function ConfidenceBadge({ confidence, className }: ConfidenceBadgeProps): JSX.Element {
  if (confidence === null || confidence === undefined) {
    return <span className={cx('soc-badge border-slate-700 bg-slate-900 text-slate-500', className)}>Sin dato</span>;
  }
  const pct = Math.round(confidence * 100);
  const styles =
    confidence >= 0.8
      ? 'border-emerald-700/70 bg-emerald-950/40 text-emerald-300'
      : confidence >= 0.6
        ? 'border-amber-700/70 bg-amber-950/40 text-amber-300'
        : 'border-red-700/70 bg-red-950/40 text-red-300';
  return (
    <span className={cx('soc-badge', styles, className)} title={`Confianza del modelo: ${pct} %`}>
      Confianza {pct} %
    </span>
  );
}

/** Color por veredicto para gráficos (pie de distribución). */
export function verdictChartColor(verdict: TriageVerdict | string): string {
  return VERDICT_CHART_COLORS[verdict as TriageVerdict] ?? '#8b5cf6';
}

export default SeverityBadge;
