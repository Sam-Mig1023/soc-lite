/**
 * SOC-Lite · Componentes de estado: Loading, EmptyState, ErrorBoundary, skeletons.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { cx } from '@/utils/format';

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface LoadingProps {
  label?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SPINNER_SIZE: Record<NonNullable<LoadingProps['size']>, number> = { sm: 16, md: 22, lg: 32 };

/** Indicador de carga con etiqueta accesible. */
export function Loading({ label = 'Cargando…', className, size = 'md' }: LoadingProps): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('flex flex-col items-center justify-center gap-3 py-10 text-slate-400', className)}
    >
      <Loader2 size={SPINNER_SIZE[size]} className="animate-spin text-cyan-400" aria-hidden="true" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** Sombra de carga para bloques de contenido. */
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div className={cx('soc-skeleton', className)} aria-hidden="true" />;
}

export interface SkeletonTableProps {
  rows?: number;
  cols?: number;
}

/** Esqueleto de tabla con `rows × cols` celdas. */
export function SkeletonTable({ rows = 8, cols = 5 }: SkeletonTableProps): JSX.Element {
  return (
    <div className="space-y-2 p-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
          {Array.from({ length: cols }).map((__, colIndex) => (
            <Skeleton key={colIndex} className="h-4 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Esqueleto para tarjetas KPI del dashboard. */
export function SkeletonCards({ count = 8 }: { count?: number }): JSX.Element {
  return (
    <div className="grid gap-4 soc-grid-auto" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="soc-panel space-y-3 p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* EmptyState                                                          */
/* ------------------------------------------------------------------ */

export interface EmptyStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/** Estado vacío reutilizable (listados sin resultados, filtros sin coincidencias). */
export function EmptyState({
  title = 'Sin resultados',
  description = 'No hay datos que coincidan con los criterios actuales.',
  action,
  icon,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <span className="rounded-full border border-slate-700 bg-slate-900 p-3 text-slate-500" aria-hidden="true">
        {icon ?? <Inbox size={24} />}
      </span>
      <h3 className="text-base font-semibold text-slate-200">{title}</h3>
      <p className="max-w-md text-sm text-slate-400">{description}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ErrorState                                                          */
/* ------------------------------------------------------------------ */

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

/** Estado de error con acción de reintento. */
export function ErrorState({
  title = 'Ocurrió un error',
  message,
  onRetry,
  className,
}: ErrorStateProps): JSX.Element {
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center gap-3 px-6 py-10 text-center', className)}>
      <span className="rounded-full border border-red-900/60 bg-red-950/40 p-3 text-red-400" aria-hidden="true">
        <AlertTriangle size={24} />
      </span>
      <h3 className="text-base font-semibold text-red-200">{title}</h3>
      <p className="max-w-lg text-sm text-slate-400">{message}</p>
      {onRetry ? (
        <button type="button" className="soc-btn-secondary" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ErrorBoundary                                                       */
/* ------------------------------------------------------------------ */

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Barrera de errores de React: evita que un fallo de render deje la SPA en blanco.
 * Muestra el mensaje, la traza resumida y un botón de reinicio.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Se registra en consola; el backend no expone endpoint de telemetría de UI.
    console.error('[SOC-Lite] Error de render no controlado:', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, fallback } = this.props;
    if (!error) return children;
    if (fallback) return fallback(error, this.reset);
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
        <div className="soc-panel w-full max-w-2xl p-6">
          <div className="flex items-start gap-3">
            <span className="rounded-full border border-red-900/60 bg-red-950/40 p-2 text-red-400" aria-hidden="true">
              <AlertTriangle size={22} />
            </span>
            <div className="flex-1">
              <h1 className="text-lg font-semibold text-red-200">La interfaz encontró un error inesperado</h1>
              <p className="mt-1 text-sm text-slate-400">
                El error fue registrado en la consola del navegador. Puedes reintentar el render o recargar la página.
              </p>
              <pre className="mt-4 max-h-48 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-red-300">
                {error.message}
              </pre>
              <div className="mt-4 flex gap-2">
                <button type="button" className="soc-btn-primary" onClick={this.reset}>
                  <RefreshCw size={15} aria-hidden="true" />
                  Reintentar
                </button>
                <button type="button" className="soc-btn-secondary" onClick={() => window.location.reload()}>
                  Recargar aplicación
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
