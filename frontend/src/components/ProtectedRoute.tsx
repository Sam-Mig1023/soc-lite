/**
 * SOC-Lite · Rutas protegidas.
 * Verifica la sesión y, opcionalmente, los permisos RBAC antes de renderizar la ruta.
 */
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Loading } from './States';
import { Forbidden } from './PermissionGate';
import type { PermissionCode } from '@/types/enums';

export interface ProtectedRouteProps {
  /** Permiso o lista de permisos exigidos por la ruta. */
  permission?: PermissionCode | PermissionCode[];
  requireAll?: boolean;
  children?: ReactNode;
}

/**
 * Guarda de ruta:
 * 1. Mientras se restaura la sesión muestra el cargador global.
 * 2. Sin sesión redirige a `/login` conservando el destino en `location.state.from`.
 * 3. Con sesión pero sin permisos muestra la pantalla 403.
 */
export function ProtectedRoute({ permission, requireAll = false, children }: ProtectedRouteProps): JSX.Element {
  const { isAuthenticated, isBootstrapping, hasPermission, hasAnyPermission } = useAuth();
  const location = useLocation();

  if (isBootstrapping) return <Loading label="Validando sesión…" className="min-h-screen" />;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  if (permission) {
    const list = Array.isArray(permission) ? permission : [permission];
    const allowed = requireAll
      ? list.every((code) => hasPermission(code))
      : hasAnyPermission(list);
    if (!allowed) return <Forbidden />;
  }

  return <>{children ?? <Outlet />}</>;
}

export default ProtectedRoute;
