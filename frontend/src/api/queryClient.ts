/**
 * SOC-Lite · Configuración de TanStack Query v5.
 * Políticas de caché y reintentos pensadas para un SOC con auto-refresh:
 * - `staleTime` bajo en métricas (30 s) para que el dashboard se sienta vivo.
 * - Sin reintentos en errores 4xx (permisos, validación): reintentar no ayuda.
 * - `refetchOnWindowFocus` en `false` para no saturar el backend en turnos 24/7.
 * - Reintento con espera exponencial acotada en fallos de red y 5xx.
 */
import { QueryClient, type DefaultOptions } from '@tanstack/react-query';
import { isAxiosStatus, isNetworkError } from '@/utils/errors';

/** Intervalo de auto-refresh del dashboard (30 s, requisito funcional). */
export const DASHBOARD_REFRESH_MS = 30_000;

/** Intervalo de refresco de listados (alertas, incidentes, bitácora). */
export const LIST_REFRESH_MS = 60_000;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  if (isAxiosStatus(error, 401) || isAxiosStatus(error, 403) || isAxiosStatus(error, 404)) return false;
  if (isAxiosStatus(error, 422) || isAxiosStatus(error, 400) || isAxiosStatus(error, 409)) return false;
  return isNetworkError(error) || isAxiosStatus(error, 429) || isAxiosStatus(error, 500) || isAxiosStatus(error, 502) || isAxiosStatus(error, 503) || isAxiosStatus(error, 504);
}

const defaultOptions: DefaultOptions = {
  queries: {
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: shouldRetry,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    // Los errores 401 ya disparan el refresco de token en el interceptor.
    throwOnError: false,
  },
  mutations: {
    retry: 0,
    throwOnError: false,
  },
};

/** Cliente de consultas de la aplicación (una instancia por SPA). */
export const queryClient = new QueryClient({ defaultOptions });

/**
 * Claves de caché centralizadas.
 * Mantenerlas en un único objeto evita invalidaciones inconsistentes entre pantallas.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  dashboard: {
    all: () => ['dashboard'] as const,
    summary: (range: unknown) => ['dashboard', 'summary', range] as const,
    bySeverity: (range: unknown) => ['dashboard', 'alerts-by-severity', range] as const,
    mtttTrend: (days: number) => ['dashboard', 'mttt-trend', days] as const,
    topSources: (limit: number, range: unknown) => ['dashboard', 'top-sources', limit, range] as const,
    fpRate: (range: unknown) => ['dashboard', 'fp-rate', range] as const,
    slaCompliance: (range: unknown) => ['dashboard', 'sla-compliance', range] as const,
    analystWorkload: (range: unknown) => ['dashboard', 'analyst-workload', range] as const,
  },
  alerts: {
    all: () => ['alerts'] as const,
    list: (query: unknown) => ['alerts', 'list', query] as const,
    detail: (id: number) => ['alerts', 'detail', id] as const,
    enrichment: (id: number) => ['alerts', id, 'enrichment'] as const,
    timeline: (id: number) => ['alerts', id, 'timeline'] as const,
  },
  triage: {
    all: () => ['triage'] as const,
    results: (query: unknown) => ['triage', 'results', query] as const,
    latest: (alertId: number) => ['triage', 'alert', alertId] as const,
    stats: (params: unknown) => ['triage', 'stats', params] as const,
  },
  incidents: {
    all: () => ['incidents'] as const,
    list: (query: unknown) => ['incidents', 'list', query] as const,
    detail: (id: number) => ['incidents', 'detail', id] as const,
    ticket: (id: number) => ['incidents', id, 'ticket'] as const,
  },
  users: {
    all: () => ['users'] as const,
    list: (query: unknown) => ['users', 'list', query] as const,
    detail: (id: number) => ['users', 'detail', id] as const,
  },
  roles: {
    all: () => ['roles'] as const,
    list: () => ['roles', 'list'] as const,
    detail: (id: number) => ['roles', 'detail', id] as const,
    permissions: () => ['roles', 'permissions'] as const,
  },
  audit: {
    all: () => ['audit'] as const,
    logs: (query: unknown) => ['audit', 'logs', query] as const,
    detail: (id: number) => ['audit', 'log', id] as const,
    stats: (params: unknown) => ['audit', 'stats', params] as const,
  },
  reports: {
    all: () => ['reports'] as const,
    inventory: (query: unknown) => ['reports', 'inventory', query] as const,
  },
};

export default queryClient;
