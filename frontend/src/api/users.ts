/**
 * SOC-Lite · API de usuarios (contrato §2). Permiso: users:read|write|delete.
 */
import { buildParams, http } from './client';
import type { Paginated } from '@/types/common';
import type { User, UserCreateRequest, UserListQuery, UserUpdateRequest } from '@/types/auth';

/** GET /users — listado paginado con filtros `q`, `is_active`, `role`. */
export async function list(query: UserListQuery = {}): Promise<Paginated<User>> {
  return http.getPage<User>('/users', { params: buildParams({ ...query }) });
}

/** GET /users/{id} — detalle con roles. */
export async function get(id: number): Promise<User> {
  return http.get<User>(`/users/${id}`);
}

/** POST /users — alta de usuario. */
export async function create(payload: UserCreateRequest): Promise<User> {
  return http.post<User>('/users', payload);
}

/** PUT /users/{id} — actualización de email, nombre y estado. */
export async function update(id: number, payload: UserUpdateRequest): Promise<User> {
  return http.put<User>(`/users/${id}`, payload);
}

/** DELETE /users/{id} — baja lógica (`is_active=false`). */
export async function remove(id: number): Promise<void> {
  await http.del<void>(`/users/${id}`);
}

/** POST /users/{id}/roles — reemplaza el conjunto de roles asignados. */
export async function assignRoles(id: number, roles: string[]): Promise<User> {
  return http.post<User>(`/users/${id}/roles`, { roles });
}

export const usersApi = { list, get, create, update, remove, assignRoles };

export default usersApi;
