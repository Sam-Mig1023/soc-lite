/**
 * SOC-Lite · Punto único de importación de la capa de datos.
 *
 * IMPORTANTE: este barrel reexporta únicamente los módulos SIN colisiones de nombres.
 * Los módulos de recurso (alerts, users, roles…) exportan funciones homónimas
 * (`list`, `get`, `create`…), por lo que deben importarse desde su ruta explícita:
 *
 * ```ts
 * import { alertsApi } from '@/api/alerts';
 * import { usersApi } from '@/api/users';
 * ```
 *
 * `queryClient.ts` tampoco se reexporta de forma implícita: se importa explícitamente
 * con `@/api/queryClient` (queryClient, queryKeys, DASHBOARD_REFRESH_MS, LIST_REFRESH_MS).
 */
export * from './client';
export { queryClient, queryKeys, DASHBOARD_REFRESH_MS, LIST_REFRESH_MS } from './queryClient';

// Reexportaciones con espacio de nombres: evitan las colisiones de `list`/`get`/`create`
// y siguen ofreciendo un punto de entrada cómodo.
export * as authApi from './auth';
export * as usersApi from './users';
export * as rolesApi from './roles';
export * as alertsApi from './alerts';
export * as triageApi from './triage';
export * as incidentsApi from './incidents';
export * as dashboardApi from './dashboard';
export * as reportsApi from './reports';
export * as auditApi from './audit';
