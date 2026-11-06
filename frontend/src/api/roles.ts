/**
 * SOC-Lite · API de roles y permisos (contrato §2).
 */
import { http } from './client';
import type { Permission, Role, RoleCreateRequest, RoleUpdateRequest } from '@/types/auth';

/** GET /roles — lista de roles con permisos y nº de usuarios. */
export async function list(): Promise<Role[]> {
  return http.get<Role[]>('/roles');
}

/** GET /roles/{id} — detalle (si el backend lo expone). */
export async function get(id: number): Promise<Role> {
  return http.get<Role>(`/roles/${id}`);
}

/** POST /roles — alta de rol con permisos. */
export async function create(payload: RoleCreateRequest): Promise<Role> {
  return http.post<Role>('/roles', payload);
}

/** PUT /roles/{id} — edición de nombre, descripción y permisos. */
export async function update(id: number, payload: RoleUpdateRequest): Promise<Role> {
  return http.put<Role>(`/roles/${id}`, payload);
}

/** DELETE /roles/{id} — baja lógica (los roles de sistema están bloqueados). */
export async function remove(id: number): Promise<void> {
  await http.del<void>(`/roles/${id}`);
}

/**
 * GET /permissions — catálogo agrupado por módulo.
 * El backend puede devolver un array plano o `{items}`/`{permissions}` agrupado:
 * se normaliza aquí para que la matriz de RBAC siempre reciba una lista plana.
 */
export async function permissions(): Promise<Permission[]> {
  const data = await http.get<unknown>('/permissions');
  return flattenPermissions(data);
}

/** Normaliza las distintas formas del catálogo de permisos a `Permission[]`. */
export function flattenPermissions(raw: unknown): Permission[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item, index) => {
      // FastAPI returns GET /permissions as [{ module, permissions: [...] }].
      // Flatten this grouped response while retaining the module as a fallback.
      if (item && typeof item === 'object') {
        const group = item as Record<string, unknown>;
        if (typeof group.module === 'string' && Array.isArray(group.permissions)) {
          return group.permissions
            .map((permission, permissionIndex) =>
              coercePermission(permission, permissionIndex, group.module as string),
            )
            .filter((permission): permission is Permission => permission !== null);
        }
      }
      const permission = coercePermission(item, index);
      return permission ? [permission] : [];
    });
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['items', 'permissions', 'data'] as const) {
      if (Array.isArray(obj[key])) return flattenPermissions(obj[key]);
    }
    // Forma agrupada: { dashboard: [...], alerts: [...], ... }
    const grouped: Permission[] = [];
    for (const [module, value] of Object.entries(obj)) {
      if (!Array.isArray(value)) continue;
      value.forEach((item, index) => {
        const parsed = coercePermission(item, index, module);
        if (parsed) grouped.push(parsed);
      });
    }
    if (grouped.length > 0) return grouped;
  }
  return [];
}

/** Convierte una entrada heterogénea en `Permission` (o `null` si no es válida). */
function coercePermission(raw: unknown, index: number, moduleHint?: string): Permission | null {
  if (typeof raw === 'string') {
    const [module = moduleHint ?? '', action = ''] = raw.split(':');
    return { id: index + 1, code: raw, module, action, description: null };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const code = typeof obj.code === 'string' ? obj.code : '';
    if (!code) return null;
    const [codeModule, codeAction] = code.split(':');
    return {
      id: typeof obj.id === 'number' ? obj.id : index + 1,
      code,
      module: typeof obj.module === 'string' ? obj.module : moduleHint ?? codeModule ?? '',
      action: typeof obj.action === 'string' ? obj.action : codeAction ?? '',
      description: typeof obj.description === 'string' ? obj.description : null,
    };
  }
  return null;
}

export const rolesApi = { list, get, create, update, remove, permissions, flattenPermissions };

export default rolesApi;
