/**
 * SOC-Lite · Contexto de autenticación y RBAC de la interfaz.
 *
 * Responsabilidades:
 * - Restaurar la sesión persistida (tokens + perfil) al arrancar la SPA.
 * - Exponer `user`, `roles`, `permissions` y helpers de autorización.
 * - Registrar el cierre de sesión ante el evento `soclite:session-expired` que emite
 *   la capa Axios cuando el refresh token deja de ser válido.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as authApi from '@/api/auth';
import {
  clearTokens,
  emitSessionExpired,
  getAuth,
  getAccessToken,
  getRefreshToken,
  onSessionExpired,
  setSession,
  setStoredUser,
} from '@/api/client';
import type { AuthProfile, LoginRequest, Session, User } from '@/types/auth';
import type { PermissionCode } from '@/types/enums';

export interface AuthContextValue {
  user: User | null;
  /**
   * Permisos efectivos.
   * `undefined` indica que aún no se han resuelto (cargando); `[]` que el usuario
   * no tiene permisos. Nunca se usa una lista vacía como "cargando" para no ocultar
   * acciones legítimas durante el arranque.
   */
  permissions: string[] | undefined;
  roles: string[];
  isAuthenticated: boolean;
  isBootstrapping: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (partial: Partial<User>) => void;
  hasPermission: (permission: PermissionCode) => boolean;
  hasAnyPermission: (permissions: PermissionCode[]) => boolean;
  hasAllPermissions: (permissions: PermissionCode[]) => boolean;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Deriva los permisos de los roles de sistema cuando `/auth/me` no los devuelve. */
const SYSTEM_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  soc_manager: [
    'dashboard:read',
    'alerts:read',
    'alerts:write',
    'triage:read',
    'triage:run',
    'incidents:read',
    'incidents:write',
    'assets:read',
    'assets:write',
    'reports:read',
    'reports:export',
    'users:read',
    'roles:read',
    'audit:read',
    'audit:export',
    'settings:read',
  ],
  analyst: [
    'dashboard:read',
    'alerts:read',
    'alerts:write',
    'triage:read',
    'triage:run',
    'incidents:read',
    'incidents:write',
    'assets:read',
    'reports:read',
  ],
  auditor: [
    'dashboard:read',
    'alerts:read',
    'triage:read',
    'incidents:read',
    'reports:read',
    'audit:read',
    'audit:export',
    'users:read',
    'roles:read',
  ],
  viewer: ['dashboard:read', 'alerts:read', 'triage:read'],
};

/** Completa los permisos a partir de los roles si el backend no los envía explícitamente. */
function derivePermissions(roles: string[], explicit: string[] | undefined): string[] | undefined {
  if (explicit && explicit.length > 0) return explicit;
  if (roles.length === 0) return undefined;
  const derived = new Set<string>();
  for (const role of roles) {
    for (const code of SYSTEM_ROLE_PERMISSIONS[role] ?? []) derived.add(code);
  }
  return derived.size > 0 ? [...derived] : undefined;
}

/** El contrato §1 incluye `permissions` junto al `user` en la respuesta de login. */
function tokenPermissions(tokens: { user: User; permissions?: string[] }): string[] | undefined {
  return Array.isArray(tokens.permissions) ? tokens.permissions : undefined;
}

/** Proveedor de sesión: debe envolver toda la aplicación. */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[] | undefined>(undefined);
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  /** Cierra la sesión local sin llamar al backend (usado ante expiración). */
  const clearSession = useCallback(() => {
    clearTokens();
    setUser(null);
    setPermissions(undefined);
  }, []);

  const applyProfile = useCallback((profile: AuthProfile) => {
    setUser(profile.user);
    setStoredUser(profile.user);
    setPermissions(derivePermissions(profile.user.roles ?? [], profile.permissions));
  }, []);

  const refreshProfile = useCallback(async () => {
    const profile = await authApi.me();
    applyProfile(profile);
  }, [applyProfile]);

  /* Restauración de la sesión al montar la aplicación */
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async (): Promise<void> => {
      const stored = getAuth();
      if (!stored?.accessToken) {
        if (!cancelled) {
          setIsBootstrapping(false);
          setPermissions(undefined);
        }
        return;
      }

      if (!cancelled) setUser(stored.user ?? null);

      try {
        const profile = await authApi.me();
        if (!cancelled) applyProfile(profile);
      } catch {
        // El interceptor de Axios intentó refrescar; si falló, no hay sesión válida.
        const stillAuthenticated = Boolean(getAccessToken());
        if (!cancelled && !stillAuthenticated) clearSession();
        else if (!cancelled) setPermissions(derivePermissions(stored.user?.roles ?? [], undefined));
      } finally {
        if (!cancelled) setIsBootstrapping(false);
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyProfile, clearSession]);

  /* Cierre de sesión ante expiración del refresh token (evento de client.ts) */
  useEffect(() => onSessionExpired(clearSession), [clearSession]);

  /* Sincronización entre pestañas: si otra pestaña cierra sesión, esta también */
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== 'soclite.auth') return;
      const stored = getAuth();
      if (!stored && getRefreshToken() === null) {
        setUser(null);
        setPermissions(undefined);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const tokens = await authApi.login(credentials);
      const expiresAt = Date.now() + (tokens.expires_in ?? 1800) * 1000;
      const session: Session = {
        user: tokens.user,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      };
      setSession(session);
      setUser(tokens.user);
      setPermissions(derivePermissions(tokens.user?.roles ?? [], tokenPermissions(tokens)));

      // Se completa el perfil con `/auth/me` para obtener los permisos efectivos exactos.
      try {
        const profile = await authApi.me();
        applyProfile(profile);
      } catch {
        /* el login ya aportó roles y permisos suficientes para operar */
      }
    },
    [applyProfile],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* aunque la revocación falle, la sesión local se descarta */
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const updateProfile = useCallback((partial: Partial<User>) => {
    setUser((current) => {
      if (!current) return current;
      const next = { ...current, ...partial };
      setStoredUser(next);
      return next;
    });
  }, []);

  const roles = useMemo(() => user?.roles ?? [], [user]);

  const hasPermission = useCallback(
    (permission: PermissionCode) => {
      if (!permissions) return false;
      if (permissions.includes('*')) return true;
      return permissions.includes(permission);
    },
    [permissions],
  );

  const hasAnyPermission = useCallback(
    (list: PermissionCode[]) => list.some((code) => hasPermission(code)),
    [hasPermission],
  );

  const hasAllPermissions = useCallback(
    (list: PermissionCode[]) => list.every((code) => hasPermission(code)),
    [hasPermission],
  );

  const hasRole = useCallback((role: string) => roles.includes(role), [roles]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      permissions,
      roles,
      isAuthenticated: Boolean(user),
      isBootstrapping,
      login,
      logout,
      refreshProfile,
      updateProfile,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      hasRole,
    }),
    [
      user,
      permissions,
      roles,
      isBootstrapping,
      login,
      logout,
      refreshProfile,
      updateProfile,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      hasRole,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Acceso al contexto de autenticación. */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return context;
}

/**
 * Hook de autorización para ocultar acciones no permitidas.
 *
 * ```tsx
 * const canWrite = usePermission('alerts:write');
 * ```
 *
 * Devuelve `false` mientras los permisos siguen cargando para evitar mostrar
 * acciones que luego habría que retirar. Usa `usePermissions().loading` si
 * necesitas distinguir "cargando" de "denegado".
 */
export function usePermission(permission: PermissionCode | PermissionCode[]): boolean {
  const { permissions, hasPermission } = useAuth();
  if (!permissions) return false;
  const list = Array.isArray(permission) ? permission : [permission];
  return list.some((code) => hasPermission(code));
}

/** Versión ampliada: expone el estado de carga y exige todos los permisos. */
export function usePermissions(...required: PermissionCode[]): {
  allowed: boolean;
  loading: boolean;
  permissions: string[] | undefined;
} {
  const { permissions, hasAllPermissions } = useAuth();
  return {
    allowed: permissions ? (required.length === 0 ? true : hasAllPermissions(required)) : false,
    loading: permissions === undefined,
    permissions,
  };
}

/** Notifica manualmente la expiración de la sesión (p. ej. desde una pantalla). */
export function notifySessionExpired(): void {
  emitSessionExpired();
}

export default AuthProvider;
