/**
 * SOC-Lite · Gestión de usuarios (CRUD + asignación de roles) con RBAC en la interfaz.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, ShieldCheck, UserCog, UserX, Users as UsersIcon } from 'lucide-react';
import { usersApi } from '@/api/users';
import { rolesApi } from '@/api/roles';
import { queryKeys } from '@/api/queryClient';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, FilterField } from '@/components/FilterBar';
import { Modal, ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import type { Role, User, UserCreateRequest, UserUpdateRequest } from '@/types/auth';
import { getErrorMessage } from '@/utils/errors';
import { debounce, cx, formatDateTime, formatRelative } from '@/utils/format';

const PAGE_SIZE_DEFAULT = 25;

interface UserFormState {
  username: string;
  email: string;
  full_name: string;
  password: string;
  department: string;
  phone: string;
  is_active: boolean;
  roles: string[];
}

const EMPTY_FORM: UserFormState = {
  username: '',
  email: '',
  full_name: '',
  password: '',
  department: '',
  phone: '',
  is_active: true,
  roles: [],
};

/** Validación mínima del formulario de alta (el backend valida de nuevo con Pydantic). */
function validate(form: UserFormState, isEdit: boolean): string[] {
  const errors: string[] = [];
  if (!isEdit) {
    if (form.username.trim().length < 3) errors.push('El usuario debe tener al menos 3 caracteres.');
    if (form.password.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('El correo electrónico no es válido.');
  if (form.full_name.trim().length < 3) errors.push('El nombre completo es obligatorio.');
  return errors;
}

/** Pantalla de administración de usuarios. */
export function Users(): JSX.Element {
  const { user: currentUser, permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canWrite = Boolean(permissions?.includes('*') || permissions?.includes('users:write'));
  const canDelete = Boolean(permissions?.includes('*') || permissions?.includes('users:delete'));

  const [filters, setFilters] = useState<{ q: string; isActive: '' | 'true' | 'false'; role: string }>({
    q: '',
    isActive: '',
    role: '',
  });
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' }>({ by: 'username', dir: 'asc' });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<UserFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [rolesTarget, setRolesTarget] = useState<User | null>(null);
  const [rolesDraft, setRolesDraft] = useState<string[]>([]);
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);

  const query = useMemo(
    () => ({
      page,
      page_size: pageSize,
      q: filters.q || undefined,
      is_active: filters.isActive === '' ? undefined : filters.isActive === 'true',
      role: filters.role || undefined,
      sort_by: sort.by,
      sort_dir: sort.dir,
    }),
    [page, pageSize, filters, sort],
  );

  const usersQuery = useQuery({
    queryKey: queryKeys.users.list(query),
    queryFn: () => usersApi.list(query),
    placeholderData: (previous) => previous,
  });

  const rolesQuery = useQuery({
    queryKey: queryKeys.roles.list(),
    queryFn: () => rolesApi.list(),
    staleTime: 5 * 60_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.all() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.roles.all() });
  };

  const createMutation = useMutation({
    mutationFn: (payload: UserCreateRequest) => usersApi.create(payload),
    onSuccess: (created) => {
      toast.success('Usuario creado', `${created.full_name} (${created.username})`);
      setFormOpen(false);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo crear el usuario', getErrorMessage(error)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: UserUpdateRequest }) => usersApi.update(id, payload),
    onSuccess: () => {
      toast.success('Usuario actualizado');
      setFormOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo actualizar el usuario', getErrorMessage(error)),
  });

  const rolesMutation = useMutation({
    mutationFn: ({ id, roles }: { id: number; roles: string[] }) => usersApi.assignRoles(id, roles),
    onSuccess: (updated) => {
      toast.success('Roles actualizados', `${updated.username}: ${(updated.roles ?? []).join(', ') || 'sin roles'}`);
      setRolesTarget(null);
      invalidate();
    },
    onError: (error) => toast.error('No se pudieron asignar los roles', getErrorMessage(error)),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => usersApi.remove(id),
    onSuccess: () => {
      toast.success('Usuario desactivado', 'La baja es lógica (is_active = false).');
      setDeactivateTarget(null);
      invalidate();
    },
    onError: (error) => toast.error('No se pudo desactivar el usuario', getErrorMessage(error)),
  });

  const roles: Role[] = rolesQuery.data ?? [];

  const openCreate = (): void => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormErrors([]);
    setFormOpen(true);
  };

  const openEdit = (target: User): void => {
    setEditing(target);
    setForm({
      username: target.username,
      email: target.email,
      full_name: target.full_name,
      password: '',
      department: target.department ?? '',
      phone: target.phone ?? '',
      is_active: target.is_active,
      roles: target.roles ?? [],
    });
    setFormErrors([]);
    setFormOpen(true);
  };

  const submitForm = (): void => {
    const errors = validate(form, Boolean(editing));
    setFormErrors(errors);
    if (errors.length > 0) return;

    if (editing) {
      updateMutation.mutate({
        id: editing.id,
        payload: {
          email: form.email,
          full_name: form.full_name,
          is_active: form.is_active,
          department: form.department || undefined,
          phone: form.phone || undefined,
        },
      });
      return;
    }

    createMutation.mutate({
      username: form.username.trim(),
      email: form.email.trim(),
      full_name: form.full_name.trim(),
      password: form.password,
      department: form.department || undefined,
      phone: form.phone || undefined,
      is_active: form.is_active,
      roles: form.roles,
    });
  };

  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setFilters((current) => ({ ...current, q: value }));
        setPage(1);
      }, 400),
    [],
  );

  const columns: Array<Column<User>> = [
    {
      key: 'username',
      header: 'Usuario',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-[11px] font-semibold uppercase text-cyan-300">
            {row.username.slice(0, 2)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-200">
              {row.full_name}
              {row.is_system ? (
                <span className="ml-1.5 rounded border border-cyan-800 bg-cyan-950/40 px-1 text-[10px] text-cyan-300">
                  sistema
                </span>
              ) : null}
            </p>
            <p className="truncate font-mono text-[11px] text-slate-500">{row.username}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Correo',
      sortable: true,
      hideOnMobile: true,
      render: (row) => <span className="text-xs text-slate-300">{row.email}</span>,
    },
    {
      key: 'roles',
      header: 'Roles',
      render: (row) =>
        row.roles.length === 0 ? (
          <span className="text-xs text-amber-400">sin roles</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.roles.map((role) => (
              <span key={role} className="soc-badge border-slate-700 bg-slate-800/60 font-mono text-slate-300">
                {role}
              </span>
            ))}
          </div>
        ),
    },
    {
      key: 'department',
      header: 'Departamento',
      hideOnMobile: true,
      render: (row) => <span className="text-xs text-slate-400">{row.department ?? '—'}</span>,
    },
    {
      key: 'is_active',
      header: 'Estado',
      width: '120px',
      render: (row) => (
        <span
          className={cx(
            'soc-badge',
            row.is_active
              ? 'border-emerald-700/70 bg-emerald-950/40 text-emerald-300'
              : 'border-slate-600 bg-slate-800/60 text-slate-400',
          )}
        >
          {row.is_active ? 'Activo' : 'Inactivo'}
        </span>
      ),
    },
    {
      key: 'last_login_at',
      header: 'Último acceso',
      sortable: true,
      hideOnMobile: true,
      width: '160px',
      render: (row) => (
        <div>
          <p className="text-xs text-slate-300">{row.last_login_at ? formatRelative(row.last_login_at) : 'nunca'}</p>
          <p className="font-mono text-[10px] text-slate-500">{formatDateTime(row.last_login_at)}</p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Acciones',
      width: '190px',
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            className="soc-btn-ghost px-2 py-1 text-xs"
            disabled={!canWrite}
            title={canWrite ? 'Editar usuario' : 'Necesitas el permiso users:write'}
            onClick={() => openEdit(row)}
          >
            <UserCog size={13} aria-hidden="true" />
            Editar
          </button>
          <button
            type="button"
            className="soc-btn-ghost px-2 py-1 text-xs"
            disabled={!canWrite}
            title={canWrite ? 'Asignar roles' : 'Necesitas el permiso users:write'}
            onClick={() => {
              setRolesTarget(row);
              setRolesDraft(row.roles ?? []);
            }}
          >
            <ShieldCheck size={13} aria-hidden="true" />
            Roles
          </button>
          <button
            type="button"
            className="soc-btn-ghost px-2 py-1 text-xs text-red-400 hover:text-red-300"
            disabled={!canDelete || !row.is_active || row.id === currentUser?.id}
            title={
              !canDelete
                ? 'Necesitas el permiso users:delete'
                : row.id === currentUser?.id
                  ? 'No puedes desactivar tu propio usuario'
                  : row.is_active
                    ? 'Desactivar usuario'
                    : 'Ya está inactivo'
            }
            onClick={() => setDeactivateTarget(row)}
          >
            <UserX size={13} aria-hidden="true" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
            <UsersIcon size={20} className="text-cyan-400" aria-hidden="true" />
            Usuarios
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            {usersQuery.data ? `${usersQuery.data.total} usuarios registrados` : 'Administración de cuentas y roles'}
          </p>
        </div>
        <button
          type="button"
          className="soc-btn-primary"
          disabled={!canWrite}
          title={canWrite ? undefined : 'Necesitas el permiso users:write'}
          onClick={openCreate}
        >
          <Plus size={15} aria-hidden="true" />
          Nuevo usuario
        </button>
      </header>

      <FilterBar
        columns={3}
        activeCount={[filters.q, filters.isActive, filters.role].filter(Boolean).length}
        onReset={() => {
          setFilters({ q: '', isActive: '', role: '' });
          setSearchDraft('');
          setPage(1);
        }}
        searchValue={searchDraft}
        onSearchChange={(value) => {
          setSearchDraft(value);
          debouncedSearch(value);
        }}
        searchPlaceholder="Buscar por nombre, usuario o correo…"
      >
        <FilterField label="Estado" htmlFor="user-active-filter">
          <select
            id="user-active-filter"
            className="soc-input"
            value={filters.isActive}
            onChange={(event) => {
              setFilters({ ...filters, isActive: event.target.value as '' | 'true' | 'false' });
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            <option value="true">Solo activos</option>
            <option value="false">Solo inactivos</option>
          </select>
        </FilterField>

        <FilterField label="Rol" htmlFor="user-role-filter">
          <select
            id="user-role-filter"
            className="soc-input"
            value={filters.role}
            onChange={(event) => {
              setFilters({ ...filters, role: event.target.value });
              setPage(1);
            }}
          >
            <option value="">Todos los roles</option>
            {roles.map((role) => (
              <option key={role.id} value={role.code}>
                {role.name} ({role.code})
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>

      <div className="soc-panel overflow-hidden">
        <DataTable<User>
          columns={columns}
          data={usersQuery.data?.items ?? []}
          rowKey="id"
          loading={usersQuery.isPending || usersQuery.isFetching}
          error={usersQuery.isError ? getErrorMessage(usersQuery.error) : null}
          onRetry={() => void usersQuery.refetch()}
          sortBy={sort.by}
          sortDir={sort.dir}
          onSortChange={(by, dir) => setSort({ by, dir })}
          page={usersQuery.data?.page ?? page}
          pageSize={pageSize}
          total={usersQuery.data?.total}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
          emptyTitle="Sin usuarios"
          emptyDescription="No hay usuarios que coincidan con los filtros."
          caption="Listado paginado de usuarios"
        />
      </div>

      {/* Alta / edición */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Editar usuario · ${editing.username}` : 'Nuevo usuario'}
        description={
          editing
            ? 'El usuario (username) no puede modificarse. Los roles se gestionan desde «Roles».'
            : 'La contraseña se almacena con bcrypt en el backend.'
        }
        size="lg"
        preventClose={createMutation.isPending || updateMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setFormOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={createMutation.isPending || updateMutation.isPending}
              onClick={submitForm}
            >
              {createMutation.isPending || updateMutation.isPending
                ? 'Guardando…'
                : editing
                  ? 'Guardar cambios'
                  : 'Crear usuario'}
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
              <label className="soc-label" htmlFor="user-username">
                Usuario *
              </label>
              <input
                id="user-username"
                className="soc-input"
                value={form.username}
                disabled={Boolean(editing)}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                placeholder="analista3"
              />
            </div>
            <div>
              <label className="soc-label" htmlFor="user-fullname">
                Nombre completo *
              </label>
              <input
                id="user-fullname"
                className="soc-input"
                value={form.full_name}
                onChange={(event) => setForm({ ...form, full_name: event.target.value })}
                placeholder="Ana Torres"
              />
            </div>
            <div>
              <label className="soc-label" htmlFor="user-email">
                Correo electrónico *
              </label>
              <input
                id="user-email"
                type="email"
                className="soc-input"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="ana.torres@org.local"
              />
            </div>
            {!editing ? (
              <div>
                <label className="soc-label" htmlFor="user-password">
                  Contraseña *
                </label>
                <input
                  id="user-password"
                  type="password"
                  className="soc-input"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  placeholder="Mínimo 8 caracteres"
                  autoComplete="new-password"
                />
              </div>
            ) : null}
            <div>
              <label className="soc-label" htmlFor="user-department">
                Departamento
              </label>
              <input
                id="user-department"
                className="soc-input"
                value={form.department}
                onChange={(event) => setForm({ ...form, department: event.target.value })}
                placeholder="Ciberseguridad"
              />
            </div>
            <div>
              <label className="soc-label" htmlFor="user-phone">
                Teléfono
              </label>
              <input
                id="user-phone"
                className="soc-input"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
                placeholder="+56 2 2345 6789"
              />
            </div>
          </div>

          {!editing ? (
            <fieldset>
              <legend className="soc-label">Roles iniciales</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {roles.map((role) => (
                  <label key={role.id} className="flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-800 accent-cyan-500"
                      checked={form.roles.includes(role.code)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          roles: event.target.checked
                            ? [...form.roles, role.code]
                            : form.roles.filter((code) => code !== role.code),
                        })
                      }
                    />
                    <span>
                      <span className="block text-slate-200">{role.name}</span>
                      <span className="block font-mono text-[11px] text-slate-500">{role.code}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-cyan-500"
                checked={form.is_active}
                onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
              />
              Usuario activo (puede iniciar sesión)
            </label>
          )}
        </div>
      </Modal>

      {/* Asignación de roles */}
      <Modal
        open={rolesTarget !== null}
        onClose={() => setRolesTarget(null)}
        title={`Roles de ${rolesTarget?.username ?? ''}`}
        description="Los roles determinan los permisos efectivos que devuelve /auth/me."
        size="md"
        preventClose={rolesMutation.isPending}
        footer={
          <>
            <button type="button" className="soc-btn-secondary" onClick={() => setRolesTarget(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="soc-btn-primary"
              disabled={rolesMutation.isPending || !rolesTarget}
              onClick={() => {
                if (rolesTarget) rolesMutation.mutate({ id: rolesTarget.id, roles: rolesDraft });
              }}
            >
              {rolesMutation.isPending ? 'Guardando…' : 'Guardar roles'}
            </button>
          </>
        }
      >
        <div className="space-y-2">
          {roles.map((role) => (
            <label
              key={role.id}
              className={cx(
                'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                rolesDraft.includes(role.code)
                  ? 'border-cyan-800 bg-cyan-950/30'
                  : 'border-slate-800 bg-slate-950/40 hover:border-slate-700',
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-800 accent-cyan-500"
                checked={rolesDraft.includes(role.code)}
                onChange={(event) =>
                  setRolesDraft(
                    event.target.checked
                      ? [...rolesDraft, role.code]
                      : rolesDraft.filter((code) => code !== role.code),
                  )
                }
              />
              <span className="flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-slate-200">{role.name}</span>
                  <span className="font-mono text-[11px] text-slate-500">{role.code}</span>
                  {role.is_system ? (
                    <span className="rounded border border-slate-700 px-1 text-[10px] text-slate-400">sistema</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{role.description ?? 'Sin descripción'}</span>
                <span className="mt-1 block text-[11px] text-slate-500">
                  {role.permissions.length} permiso(s){typeof role.users_count === 'number' ? ` · ${role.users_count} usuario(s)` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-cyan-300">
          <CheckCircle2 size={12} aria-hidden="true" />
          {rolesDraft.length} rol(es) seleccionado(s): {rolesDraft.join(', ') || 'ninguno'}
        </p>
      </Modal>

      <ConfirmDialog
        open={deactivateTarget !== null}
        tone="danger"
        title="Desactivar usuario"
        message={
          <>
            Se aplicará una baja lógica a <strong>{deactivateTarget?.username}</strong> (is_active = false). El usuario no
            podrá iniciar sesión, pero su historial y su rastro de auditoría se conservan.
          </>
        }
        confirmLabel="Desactivar"
        loading={deactivateMutation.isPending}
        onConfirm={() => {
          if (deactivateTarget) deactivateMutation.mutate(deactivateTarget.id);
        }}
        onCancel={() => setDeactivateTarget(null)}
      />
    </div>
  );
}

export default Users;
