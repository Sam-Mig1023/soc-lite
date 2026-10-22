/**
 * SOC-Lite · Roles y matriz de permisos.
 * CRUD de roles (los de sistema son inmutables en su baja) y matriz de permisos
 * agrupada por módulo, con acciones como columnas y checkboxes por celda.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Plus, ShieldCheck, Trash2, UserCog, Users } from 'lucide-react';
import { rolesApi } from '@/api/roles';
import { queryKeys } from '@/api/queryClient';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { Loading, ErrorState } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { groupPermissions, MODULE_LABELS, type Permission, type Role } from '@/types/auth';
import { getErrorMessage } from '@/utils/errors';
import { cx } from '@/utils/format';

/** Orden canónico de acciones dentro de cada módulo. */
const ACTION_ORDER = ['read', 'write', 'run', 'export', 'delete'] as const;

const ACTION_LABELS: Record<string, string> = {
  read: 'Consultar',
  write: 'Escribir',
  run: 'Ejecutar',
  export: 'Exportar',
  delete: 'Eliminar',
};

interface RoleFormState {
  code: string;
  name: string;
  description: string;
  permissions: string[];
}

const EMPTY_FORM: RoleFormState = { code: '', name: '', description: '', permissions: [] };

/** Pantalla de administración de roles y permisos. */
export function Roles(): JSX.Element {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canWrite = Boolean(permissions?.includes('*') || permissions?.includes('roles:write'));
  const canDelete = Boolean(permissions?.includes('*') || permissions?.includes('roles:delete'));

  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [form, setForm] = useState<RoleFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const [draftPermissions, setDraftPermissions] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  const rolesQuery = useQuery({ queryKey: queryKeys.roles.list(), queryFn: () => rolesApi.list() });

  const permissionsQuery = useQuery({
    queryKey: queryKeys.roles.permissions(),
    queryFn: () => rolesApi.permissions(),
    staleTime: 10 * 60_000,
  });

  const roles: Role[] = rolesQuery.data ?? [];
  const catalog: Permission[] = permissionsQuery.data ?? [];

  const selectedRole = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) ?? roles[0] ?? null,
    [roles, selectedRoleId],
  );

  /** Permisos en edición de la matriz (los del rol seleccionado hasta que se modifica). */
  const activePermissions = dirty ? draftPermissions : (selectedRole?.permissions ?? []);

  const groups = useMemo(() => groupPermissions(catalog), [catalog]);

  /** Columnas de acción presentes en el catálogo (respetando el orden canónico). */
  const actionColumns = useMemo(() => {
    const actions = new Set(catalog.map((permission) => permission.action));
    const ordered = ACTION_ORDER.filter((action) => actions.has(action));
    const extras = [...actions].filter((action) => !ACTION_ORDER.includes(action as (typeof ACTION_ORDER)[number]));
    return [...ordered, ...extras.sort()];
  }, [catalog]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.roles.all() });
  };

  const matrixMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { permissions: string[] } }) => rolesApi.update(id, payload),
    onSuccess: () => {
      toast.success('Matriz de permisos actualizada');
      setDirty(false);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo actualizar la matriz', getErrorMessage(error)),
  });

  const createMutation = useMutation({
    mutationFn: (payload: RoleFormState) =>
      rolesApi.create({
        code: payload.code.trim(),
        name: payload.name.trim(),
        description: payload.description || undefined,
        permissions: payload.permissions,
      }),
    onSuccess: (role) => {
      toast.success('Rol creado', `${role.name} (${role.code})`);
      setFormOpen(false);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo crear el rol', getErrorMessage(error)),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { name?: string; description?: string; permissions?: string[] } }) =>
      rolesApi.update(id, payload),
    onSuccess: () => {
      toast.success('Rol actualizado');
      setFormOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo actualizar el rol', getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rolesApi.remove(id),
    onSuccess: () => {
      toast.success('Rol eliminado (baja lógica)');
      setDeleteTarget(null);
      setSelectedRoleId(null);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo eliminar el rol', getErrorMessage(error)),
  });

  const togglePermission = (code: string): void => {
    if (!canWrite || !selectedRole) return;
    const base = activePermissions;
    const next = base.includes(code) ? base.filter((item) => item !== code) : [...base, code];
    setDraftPermissions(next);
    setDirty(true);
  };

  const toggleModule = (module: string, checked: boolean): void => {
    if (!canWrite || !selectedRole) return;
    const moduleCodes = catalog.filter((permission) => permission.module === module).map((permission) => permission.code);
    const base = new Set(activePermissions);
    for (const code of moduleCodes) {
      if (checked) base.add(code);
      else base.delete(code);
    }
    setDraftPermissions([...base]);
    setDirty(true);
  };

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormErrors([]);
    setFormOpen(true);
  };

  const openEdit = (role: Role): void => {
    setEditing(role);
    setForm({
      code: role.code,
      name: role.name,
      description: role.description ?? '',
      permissions: role.permissions,
    });
    setFormErrors([]);
    setFormOpen(true);
  };

  const submitForm = (): void => {
    const errors: string[] = [];
    if (!editing && !/^[a-z][a-z0-9_]{2,47}$/.test(form.code.trim())) {
      errors.push('El código debe empezar por letra y usar minúsculas, números o guion bajo (3-48 caracteres).');
    }
    if (form.name.trim().length < 3) errors.push('El nombre del rol es obligatorio (mínimo 3 caracteres).');
    if (form.permissions.length === 0) errors.push('Selecciona al menos un permiso.');
    setFormErrors(errors);
    if (errors.length > 0) return;

    if (editing) {
      updateRoleMutation.mutate({
        id: editing.id,
        payload: {
          name: form.name.trim(),
          description: form.description || undefined,
          permissions: form.permissions,
        },
      });
      return;
    }
    createMutation.mutate(form);
  };

  if (rolesQuery.isPending) return <Loading label="Cargando roles y permisos…" />;
  if (rolesQuery.isError) {
    return (
      <ErrorState
        title="No se pudieron cargar los roles"
        message={getErrorMessage(rolesQuery.error)}
        onRetry={() => void rolesQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <KeyRound size={20} className="text-cyan-400" aria-hidden="true" />
            Roles y permisos
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Matriz RBAC por módulo y acción · {catalog.length} permisos en {groups.length} módulos
          </p>
        </div>
        <button
          type="button"
          className="soc-btn-primary"
          disabled={!canWrite}
          title={canWrite ? undefined : 'Necesitas el permiso roles:write'}
          onClick={openCreate}
        >
          <Plus size={15} aria-hidden="true" />
          Nuevo rol
        </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Lista de roles */}
        <aside className="soc-panel h-fit">
          <header className="soc-panel-header">
            <h2 className="soc-panel-title">Roles ({roles.length})</h2>
          </header>
          <ul className="divide-y divide-slate-800">
            {roles.map((role) => {
              const isSelected = selectedRole?.id === role.id;
              return (
                <li key={role.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRoleId(role.id);
                      setDirty(false);
                      setDraftPermissions(role.permissions);
                    }}
                    className={cx(
                      'w-full px-3 py-2.5 text-left transition-colors',
                      isSelected ? 'bg-cyan-950/40 shadow-[inset_2px_0_0_0_#22d3ee]' : 'hover:bg-slate-800/60',
                    )}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-200">{role.name}</span>
                      {role.is_system ? (
                        <span className="shrink-0 rounded border border-cyan-800 bg-cyan-950/40 px-1 text-[10px] text-cyan-300">
                          sistema
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-mono">{role.code}</span>
                      <span className="flex items-center gap-1">
                        <ShieldCheck size={10} aria-hidden="true" />
                        {role.permissions.length}
                      </span>
                      {typeof role.users_count === 'number' ? (
                        <span className="flex items-center gap-1">
                          <Users size={10} aria-hidden="true" />
                          {role.users_count}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Matriz de permisos */}
        <section className="soc-panel min-w-0">
          <header className="soc-panel-header">
            <div className="min-w-0">
              <h2 className="soc-panel-title">
                {selectedRole ? `Matriz de permisos · ${selectedRole.name}` : 'Matriz de permisos'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {selectedRole?.description ?? 'Selecciona un rol para editar sus permisos.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {dirty && selectedRole ? (
                <>
                  <button
                    type="button"
                    className="soc-btn-ghost px-2 py-1 text-xs"
                    onClick={() => {
                      setDraftPermissions(selectedRole.permissions);
                      setDirty(false);
                    }}
                  >
                    Descartar
                  </button>
                  <button
                    type="button"
                    className="soc-btn-primary px-3 py-1 text-xs"
                    disabled={matrixMutation.isPending}
                    onClick={() => matrixMutation.mutate({ id: selectedRole.id, payload: { permissions: draftPermissions } })}
                  >
                    <Check size={13} aria-hidden="true" />
                    {matrixMutation.isPending ? 'Guardando…' : 'Guardar permisos'}
                  </button>
                </>
              ) : null}
              {selectedRole ? (
                <>
                  <button
                    type="button"
                    className="soc-btn-secondary px-2 py-1 text-xs"
                    disabled={!canWrite}
                    onClick={() => openEdit(selectedRole)}
                  >
                    <UserCog size={13} aria-hidden="true" />
                    Editar rol
                  </button>
                  <button
                    type="button"
                    className="soc-btn-ghost px-2 py-1 text-xs text-red-400 hover:text-red-300"
                    disabled={!canDelete || selectedRole.is_system}
                    title={
                      selectedRole.is_system
                        ? 'Los roles de sistema no se pueden eliminar'
                        : canDelete
                          ? 'Eliminar rol'
                          : 'Necesitas el permiso roles:delete'
                    }
                    onClick={() => setDeleteTarget(selectedRole)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </div>
          </header>

          <div className="p-4">
            {permissionsQuery.isPending ? (
              <Loading label="Cargando catálogo de permisos…" />
            ) : permissionsQuery.isError ? (
              <ErrorState
                title="No se pudo cargar el catálogo"
                message={getErrorMessage(permissionsQuery.error)}
                onRetry={() => void permissionsQuery.refetch()}
              />
            ) : groups.length === 0 ? (
              <p className="text-sm text-slate-500">El catálogo de permisos está vacío.</p>
            ) : (
              <div className="soc-scroll-x">
                <table className="soc-table min-w-[640px]">
                  <caption className="sr-only">
                    Matriz de permisos por módulo (filas) y acción (columnas) para el rol seleccionado
                  </caption>
                  <thead>
                    <tr>
                      <th className="soc-th sticky left-0 bg-slate-900">Módulo</th>
                      {actionColumns.map((action) => (
                        <th key={action} className="soc-th text-center">
                          {ACTION_LABELS[action] ?? action}
                        </th>
                      ))}
                      <th className="soc-th text-center">Todos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const moduleCodes = group.permissions.map((permission) => permission.code);
                      const allChecked = moduleCodes.length > 0 && moduleCodes.every((code) => activePermissions.includes(code));
                      return (
                        <tr key={group.module} className="hover:bg-slate-800/30">
                          <th scope="row" className="soc-td sticky left-0 bg-slate-900/95 text-left">
                            <span className="block text-sm font-medium text-slate-200">
                              {MODULE_LABELS[group.module] ?? group.label}
                            </span>
                            <span className="block font-mono text-[11px] text-slate-500">{group.module}</span>
                          </th>
                          {actionColumns.map((action) => {
                            const permission = group.permissions.find((item) => item.action === action);
                            if (!permission) {
                              return (
                                <td key={`${group.module}-${action}`} className="soc-td text-center text-slate-700">
                                  ·
                                </td>
                              );
                            }
                            const checked = activePermissions.includes(permission.code);
                            return (
                              <td key={permission.code} className="soc-td text-center">
                                <label className="inline-flex cursor-pointer items-center justify-center">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-cyan-500 disabled:opacity-40"
                                    checked={checked}
                                    disabled={!canWrite}
                                    onChange={() => togglePermission(permission.code)}
                                    aria-label={`${permission.description ?? permission.code} (${permission.code})`}
                                  />
                                </label>
                                <span className="mt-0.5 block font-mono text-[9px] text-slate-600">{permission.action}</span>
                              </td>
                            );
                          })}
                          <td className="soc-td text-center">
                            <label className="inline-flex cursor-pointer items-center justify-center">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500 disabled:opacity-40"
                                checked={allChecked}
                                disabled={!canWrite}
                                onChange={(event) => toggleModule(group.module, event.target.checked)}
                                aria-label={`Seleccionar todos los permisos del módulo ${group.module}`}
                              />
                            </label>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="soc-td text-xs text-slate-500" colSpan={actionColumns.length + 2}>
                        {activePermissions.length} de {catalog.length} permisos concedidos a{' '}
                        <span className="font-mono text-slate-300">{selectedRole?.code ?? '—'}</span>
                        {dirty ? <span className="ml-2 text-amber-400">cambios sin guardar</span> : null}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Alta / edición de rol */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Editar rol · ${editing.code}` : 'Nuevo rol'}
        description="El código del rol no puede cambiarse después de crearlo."
        size="lg"
        preventClose={createMutation.isPending || updateRoleMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setFormOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={createMutation.isPending || updateRoleMutation.isPending}
              onClick={submitForm}
            >
              {createMutation.isPending || updateRoleMutation.isPending
                ? 'Guardando…'
                : editing
                  ? 'Guardar cambios'
                  : 'Crear rol'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {formErrors.length > 0 ? (
            <ul role="alert" className="space-y-1 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-200">
              {formErrors.map((error) => (
                <li key={error}>• {error}</li>
              ))}
            </ul>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="soc-label" htmlFor="role-code">
                Código *
              </label>
              <input
                id="role-code"
                className="soc-input font-mono"
                value={form.code}
                disabled={Boolean(editing)}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
                placeholder="analyst_tier2"
              />
            </div>
            <div>
              <label className="soc-label" htmlFor="role-name">
                Nombre *
              </label>
              <input
                id="role-name"
                className="soc-input"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Analista Nivel 2"
              />
            </div>
          </div>

          <div>
            <label className="soc-label" htmlFor="role-description">
              Descripción
            </label>
            <textarea
              id="role-description"
              className="soc-input min-h-16"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Responsabilidades y alcance del rol"
            />
          </div>

          <fieldset>
            <legend className="soc-label">Permisos ({form.permissions.length} seleccionados)</legend>
            <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              {groups.map((group) => (
                <div key={group.module}>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {MODULE_LABELS[group.module] ?? group.module}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {group.permissions.map((permission) => (
                      <label key={permission.code} className="flex items-start gap-2 text-xs text-slate-300">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 accent-cyan-500"
                          checked={form.permissions.includes(permission.code)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              permissions: event.target.checked
                                ? [...form.permissions, permission.code]
                                : form.permissions.filter((code) => code !== permission.code),
                            })
                          }
                        />
                        <span>
                          <span className="font-mono text-[11px] text-slate-400">{permission.code}</span>
                          <span className="block text-[11px] text-slate-500">{permission.description ?? ''}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        tone="danger"
        title="Eliminar rol"
        message={
          <>
            Se eliminará el rol <strong>{deleteTarget?.name}</strong> ({deleteTarget?.code}). Los usuarios que lo tuvieran
            asignado perderán esos permisos.
          </>
        }
        confirmLabel="Eliminar rol"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default Roles;
