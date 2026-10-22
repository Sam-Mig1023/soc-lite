/**
 * SOC-Lite · Tipos de autenticación, usuarios, roles y permisos.
 * Contrato: docs/00-contrato-api.md §1 y §2. Esquema: db/schema.sql users/roles/permissions.
 */

/** Usuario tal como lo expone la API. */
export interface User {
  id: number;
  username: string;
  email: string;
  full_name: string;
  is_active: boolean;
  is_system?: boolean;
  must_change_pwd?: boolean;
  mfa_enabled?: boolean;
  department?: string | null;
  phone?: string | null;
  last_login_at?: string | null;
  last_login_ip?: string | null;
  created_at?: string;
  updated_at?: string;
  roles: string[];
}

/** Payload del formulario de login (se envía como form-urlencoded). */
export interface LoginRequest {
  username: string;
  password: string;
}

/** Respuesta de POST /auth/login. */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
  /** El contrato §1 devuelve los permisos también en la raíz de la respuesta. */
  permissions?: string[];
}

/** Respuesta de POST /auth/refresh (rotación de refresh token). */
export interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Respuesta de GET /auth/me.
 * El contrato indica "perfil, roles y permisos efectivos" sin fijar el envoltorio:
 * se acepta tanto el usuario plano como `{ user }` / `{ user, permissions }`.
 */
export interface MeResponse {
  user: User;
  permissions?: string[];
}

/** Sesión persistida en el cliente. */
export interface Session {
  user: User;
  accessToken: string;
  refreshToken: string;
  /** epoch ms de expiración del access token. */
  expiresAt: number;
}

/** Perfil + permisos efectivos que consume el RBAC de la UI. */
export interface AuthProfile {
  user: User;
  permissions: string[];
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

/** Normaliza la respuesta de /auth/me a un perfil con permisos. */
export function normalizeMe(raw: unknown): AuthProfile {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const candidate = (obj.user ?? obj) as Record<string, unknown>;
  const roles = Array.isArray(candidate.roles) ? (candidate.roles as string[]) : [];
  const permissionsRaw = obj.permissions ?? candidate.permissions;
  const permissions = Array.isArray(permissionsRaw) ? (permissionsRaw as string[]) : [];
  const user: User = {
    id: Number(candidate.id ?? 0),
    username: String(candidate.username ?? ''),
    email: String(candidate.email ?? ''),
    full_name: String(candidate.full_name ?? candidate.username ?? ''),
    is_active: candidate.is_active !== false,
    is_system: Boolean(candidate.is_system),
    must_change_pwd: Boolean(candidate.must_change_pwd),
    mfa_enabled: Boolean(candidate.mfa_enabled),
    department: (candidate.department as string | null) ?? null,
    phone: (candidate.phone as string | null) ?? null,
    last_login_at: (candidate.last_login_at as string | null) ?? null,
    last_login_ip: (candidate.last_login_ip as string | null) ?? null,
    created_at: (candidate.created_at as string | undefined) ?? undefined,
    updated_at: (candidate.updated_at as string | undefined) ?? undefined,
    roles,
  };
  return { user, permissions };
}

/** Type-guard para distinguir la respuesta de login de otras respuestas. */
export function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_token === 'string' && typeof v.refresh_token === 'string';
}

export interface UserListQuery {
  page?: number;
  page_size?: number;
  q?: string;
  is_active?: boolean;
  role?: string;
}

export interface UserCreateRequest {
  username: string;
  email: string;
  full_name: string;
  password: string;
  department?: string;
  phone?: string;
  is_active?: boolean;
  roles?: string[];
}

export interface UserUpdateRequest {
  email?: string;
  full_name?: string;
  is_active?: boolean;
  department?: string;
  phone?: string;
}

export interface Role {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  permissions: string[];
  users_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface RoleCreateRequest {
  code: string;
  name: string;
  description?: string;
  permissions: string[];
}

export interface RoleUpdateRequest {
  name?: string;
  description?: string;
  permissions?: string[];
}

/** Catálogo de permisos agrupado por módulo (GET /permissions). */
export interface Permission {
  id: number;
  code: string;
  module: string;
  action: string;
  description?: string | null;
}

export interface PermissionGroup {
  module: string;
  label: string;
  permissions: Permission[];
}

/** Agrupa el catálogo plano de permisos por módulo, respetando el orden de la API. */
export function groupPermissions(permissions: Permission[]): PermissionGroup[] {
  const order: string[] = [];
  const map = new Map<string, Permission[]>();
  for (const p of permissions) {
    if (!map.has(p.module)) {
      map.set(p.module, []);
      order.push(p.module);
    }
    map.get(p.module)?.push(p);
  }
  return order.map((module) => ({
    module,
    label: MODULE_LABELS[module] ?? module,
    permissions: map.get(module) ?? [],
  }));
}

/** Etiquetas legibles de los módulos de permisos. */
export const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  alerts: 'Alertas',
  triage: 'Triaje',
  incidents: 'Incidentes',
  assets: 'Activos',
  reports: 'Reportes',
  users: 'Usuarios',
  roles: 'Roles y permisos',
  audit: 'Auditoría',
  settings: 'Configuración',
  integrations: 'Integraciones',
};
