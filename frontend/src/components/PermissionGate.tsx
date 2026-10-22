/**
 * SOC-Lite · Control de acceso en la interfaz (RBAC).
 *
 * Componente PURO: recibe los permisos por props. Quien los inyecta es `Layout`, que
 * llama a `usePermission('alerts:write')` desde `AuthContext` (fuente única de verdad).
 * Al no importar el contexto, el componente puede probarse de forma aislada.
 *
 * Nota de seguridad: ocultar en la UI es defensa en profundidad; el backend SIEMPRE
 * vuelve a validar el permiso (contrato §2).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, ShieldOff } from 'lucide-react';
import type { PermissionCode } from '@/types/enums';
import { cx } from '@/utils/format';

export interface PermissionGateProps {
  /** Permiso o lista de permisos, en formato `modulo:accion`. */
  permission?: PermissionCode | PermissionCode[];
  /** Todos los permisos son obligatorios (por defecto: basta uno). */
  requireAll?: boolean;
  /** Permisos efectivos del usuario, inyectados por el consumidor. */
  permissions?: string[];
  /** Roles efectivos del usuario (código de rol: admin, analyst…). */
  roles?: string[];
  /** Roles exigidos: basta uno de ellos. */
  requireAnyRole?: string[];
  children: ReactNode;
  /** Contenido alternativo cuando falta el permiso. */
  fallback?: ReactNode;
  /** Deshabilita en lugar de ocultar (útil para botones que deben verse atenuados). */
  mode?: 'hide' | 'disable';
  /** Información emergente que explica el motivo cuando `mode="disable"`. */
  disableReason?: string;
}

function isAllowed(
  granted: string[],
  permission?: PermissionCode | PermissionCode[],
  requireAll = false,
): boolean {
  if (!permission) return true;
  const list = Array.isArray(permission) ? permission : [permission];
  if (list.length === 0) return true;
  return requireAll ? list.every((code) => granted.includes(code)) : list.some((code) => granted.includes(code));
}

/** Renderiza `children` solo si el usuario tiene los permisos requeridos. */
export function PermissionGate({
  permission,
  requireAll = false,
  permissions = [],
  roles = [],
  requireAnyRole,
  children,
  fallback = null,
  mode = 'hide',
  disableReason = 'No tienes permisos suficientes para esta acción.',
}: PermissionGateProps): JSX.Element | null {
  const permissionOk = isAllowed(permissions, permission, requireAll);
  const roleOk =
    !requireAnyRole || requireAnyRole.length === 0 || requireAnyRole.some((role) => roles.includes(role));

  if (permissionOk && roleOk) return <>{children}</>;
  if (fallback !== null) return <>{fallback}</>;

  if (mode === 'disable') {
    return (
      <span
        className="inline-flex cursor-not-allowed items-center gap-1.5 opacity-45"
        title={disableReason}
        aria-disabled="true"
      >
        <Lock size={13} aria-hidden="true" />
        {children}
      </span>
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Página 403                                                          */
/* ------------------------------------------------------------------ */

export interface ForbiddenProps {
  title?: string;
  message?: string;
  className?: string;
}

/** Pantalla mostrada cuando el usuario autenticado no tiene permiso sobre una ruta. */
export function Forbidden({
  title = 'Acceso denegado',
  message = 'Tu rol no incluye el permiso necesario para ver esta sección. Si necesitas acceso, solicítalo al administrador del SOC.',
  className,
}: ForbiddenProps): JSX.Element {
  return (
    <div className={cx('flex min-h-[60vh] items-center justify-center p-6', className)}>
      <div className="soc-panel max-w-lg p-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-amber-800 bg-amber-950/40 text-amber-400">
          <ShieldOff size={24} aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold text-amber-200">{title}</h1>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Link to="/dashboard" className="soc-btn-primary">
            Ir al dashboard
          </Link>
          <Link to="/alerts" className="soc-btn-secondary">
            Ver alertas
          </Link>
        </div>
      </div>
    </div>
  );
}

export default PermissionGate;
