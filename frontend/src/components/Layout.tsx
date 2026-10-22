/**
 * SOC-Lite · Layout principal: sidebar colapsable + topbar + breadcrumb + contenido.
 * El layout es el ÚNICO componente que consulta permisos concretos y los publica a las
 * páginas mediante `Outlet context`, de modo que las páginas no conocen el RBAC.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BellRing,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Cpu,
  FileBarChart,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Radio,
  ScrollText,
  ShieldHalf,
  Siren,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useAuth, usePermission } from '@/context/AuthContext';
import { ConfirmDialog } from './Modal';
import { cx, formatDateTime } from '@/utils/format';

/* ------------------------------------------------------------------ */
/* Navegación                                                          */
/* ------------------------------------------------------------------ */

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Permiso mínimo para ver la entrada del menú. */
  permission: string;
  end?: boolean;
}

const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Operación',
    items: [
      { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={17} />, permission: 'dashboard:read', end: true },
      { to: '/alerts', label: 'Alertas', icon: <BellRing size={17} />, permission: 'alerts:read' },
      { to: '/incidents', label: 'Incidentes', icon: <Siren size={17} />, permission: 'incidents:read' },
      { to: '/triage', label: 'Triaje IA', icon: <Cpu size={17} />, permission: 'triage:read' },
    ],
  },
  {
    title: 'Gobierno',
    items: [
      { to: '/reports', label: 'Reportes', icon: <FileBarChart size={17} />, permission: 'reports:read' },
      { to: '/audit', label: 'Bitácora', icon: <ScrollText size={17} />, permission: 'audit:read' },
    ],
  },
  {
    title: 'Administración',
    items: [
      { to: '/users', label: 'Usuarios', icon: <Users size={17} />, permission: 'users:read' },
      { to: '/roles', label: 'Roles y permisos', icon: <UserCog size={17} />, permission: 'roles:read' },
    ],
  },
];

/** Mapa segmento-de-ruta → miga de pan legible. */
const BREADCRUMBS: Record<string, string> = {
  dashboard: 'Dashboard',
  alerts: 'Alertas',
  incidents: 'Incidentes',
  triage: 'Triaje IA',
  reports: 'Reportes',
  audit: 'Bitácora de auditoría',
  users: 'Usuarios',
  roles: 'Roles y permisos',
  profile: 'Mi perfil',
};

function useBreadcrumb(): Array<{ label: string; to?: string }> {
  const location = useLocation();
  return useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return [{ label: 'Dashboard' }];
    const crumbs: Array<{ label: string; to?: string }> = [{ label: 'Inicio', to: '/' }];
    let accumulated = '';
    segments.forEach((segment, index) => {
      accumulated += `/${segment}`;
      const label = /^\d+$/.test(segment)
        ? `Detalle #${segment}`
        : (BREADCRUMBS[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1));
      crumbs.push({ label, to: index === segments.length - 1 ? undefined : accumulated });
    });
    return crumbs;
  }, [location.pathname]);
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function SidebarContent({
  collapsed,
  permissions,
  onNavigate,
}: {
  collapsed: boolean;
  permissions: string[] | undefined;
  onNavigate?: () => void;
}): JSX.Element {
  return (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4" aria-label="Navegación principal">
      <Link to="/" className="flex items-center gap-2.5 px-2" onClick={onNavigate}>
        <span className="rounded-lg border border-cyan-800/70 bg-cyan-950/50 p-1.5 text-cyan-400">
          <ShieldHalf size={20} aria-hidden="true" />
        </span>
        {!collapsed ? (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold tracking-wide text-slate-100">SOC-Lite</span>
            <span className="block truncate text-[10px] uppercase tracking-widest text-slate-500">
              Security Operations
            </span>
          </span>
        ) : null}
      </Link>

      {NAV_SECTIONS.map((section) => {
        const visible = section.items.filter(
          (item) => !permissions || permissions.includes('*') || permissions.includes(item.permission),
        );
        if (visible.length === 0) return null;
        return (
          <div key={section.title}>
            {!collapsed ? (
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {section.title}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {visible.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cx(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-cyan-950/60 text-cyan-200 shadow-[inset_2px_0_0_0_#22d3ee]'
                          : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-200',
                        collapsed && 'justify-center',
                      )
                    }
                  >
                    <span aria-hidden="true">{item.icon}</span>
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** Permisos publicados por el layout a las páginas vía `Outlet context`. */
export interface LayoutContext {
  canWriteAlerts: boolean;
  canDeleteAlerts: boolean;
  canRunTriage: boolean;
  canWriteIncidents: boolean;
  canWriteUsers: boolean;
  canWriteRoles: boolean;
  canExportAudit: boolean;
  canExportReports: boolean;
}

/** Deriva los flags de acción a partir de la lista de permisos efectivos. */
export function deriveLayoutContext(permissions: string[] | undefined): LayoutContext {
  const has = (code: string): boolean =>
    Boolean(permissions && (permissions.includes('*') || permissions.includes(code)));
  return {
    canWriteAlerts: has('alerts:write'),
    canDeleteAlerts: has('alerts:delete'),
    canRunTriage: has('triage:run'),
    canWriteIncidents: has('incidents:write'),
    canWriteUsers: has('users:write'),
    canWriteRoles: has('roles:write'),
    canExportAudit: has('audit:export'),
    canExportReports: has('reports:export'),
  };
}

/** Marco principal de la aplicación autenticada. */
export function Layout(): JSX.Element {
  const { user, permissions, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const crumbs = useBreadcrumb();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // RBAC de acciones: única consulta explícita de permisos en el layout.
  const canWriteAlerts = usePermission('alerts:write');
  const canRunTriage = usePermission('triage:run');

  const outletContext: LayoutContext = useMemo(() => deriveLayoutContext(permissions), [permissions]);

  // El menú móvil se cierra al cambiar de ruta.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-950">
      <a
        href="#contenido-principal"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-cyan-500 focus:px-3 focus:py-2 focus:text-slate-950"
      >
        Saltar al contenido principal
      </a>

      {/* Sidebar fijo (escritorio) */}
      <aside
        className={cx(
          'sticky top-0 hidden h-screen shrink-0 border-r border-slate-800 bg-slate-900/70 backdrop-blur transition-[width] duration-200 lg:block',
          collapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <SidebarContent collapsed={collapsed} permissions={permissions} />
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          className="absolute bottom-4 right-[-13px] hidden h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-400 transition-colors hover:text-cyan-300 lg:flex"
          aria-label={collapsed ? 'Expandir menú lateral' : 'Colapsar menú lateral'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </aside>

      {/* Sidebar móvil */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/80" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <div className="relative h-full w-64 animate-fade-in border-r border-slate-800 bg-slate-900">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              aria-label="Cerrar menú"
            >
              <X size={18} />
            </button>
            <SidebarContent collapsed={false} permissions={permissions} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 lg:hidden"
              aria-label="Abrir menú de navegación"
            >
              <Menu size={18} />
            </button>

            {/* Breadcrumb */}
            <nav aria-label="Ruta de navegación" className="min-w-0 flex-1">
              <ol className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                {crumbs.map((crumb, index) => (
                  <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                    {index > 0 ? <ChevronRight size={12} aria-hidden="true" className="text-slate-700" /> : null}
                    {crumb.to ? (
                      <Link to={crumb.to} className="hover:text-cyan-300">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-300" aria-current="page">
                        {crumb.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>

            {/* Estado del sistema + perfil */}
            <div className="flex items-center gap-3">
              <span
                className="hidden items-center gap-1.5 rounded-full border border-emerald-800/70 bg-emerald-950/40 px-2.5 py-1 text-[11px] text-emerald-300 sm:inline-flex"
                title="Conectado al backend http://localhost:8000/api/v1"
              >
                <Radio size={12} className="animate-pulse-slow" aria-hidden="true" />
                En línea
              </span>

              <div className="hidden text-right md:block">
                <p className="truncate text-xs font-medium text-slate-200">{user?.full_name ?? '—'}</p>
                <p className="truncate text-[10px] uppercase tracking-wide text-slate-500">
                  {(user?.roles ?? []).join(', ') || 'sin rol'}
                </p>
              </div>

              <span
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-xs font-semibold uppercase text-cyan-300"
                aria-hidden="true"
              >
                {(user?.username ?? '?').slice(0, 2)}
              </span>

              {canWriteAlerts || canRunTriage ? (
                <Link
                  to="/alerts?status=pending"
                  className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
                  aria-label="Ver alertas pendientes"
                  title="Alertas pendientes"
                >
                  <Activity size={17} aria-hidden="true" />
                </Link>
              ) : null}

              <button
                type="button"
                onClick={() => setConfirmLogout(true)}
                className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-red-950/50 hover:text-red-300"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
              >
                <LogOut size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        </header>

        {/* Contenido */}
        <main id="contenido-principal" className="min-w-0 flex-1 px-4 py-5 sm:px-6">
          <Outlet context={outletContext} />
        </main>

        <footer className="border-t border-slate-800 px-4 py-3 text-[11px] text-slate-600 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Gauge size={12} aria-hidden="true" />
              SOC-Lite v1.0 · ISO/IEC 27001:2022 (A.8.15, A.5.24, A.5.28) · NIST CSF 2.0
            </span>
            <span className="flex items-center gap-1.5">
              <ClipboardList size={12} aria-hidden="true" />
              {user?.last_login_at ? `Último acceso ${formatDateTime(user.last_login_at)}` : 'Sesión activa'}
            </span>
          </div>
        </footer>
      </div>

      <ConfirmDialog
        open={confirmLogout}
        tone="warning"
        title="Cerrar sesión"
        message="Se revocará el refresh token en el servidor y volverás a la pantalla de acceso."
        confirmLabel="Cerrar sesión"
        loading={loggingOut}
        onConfirm={() => void handleLogout()}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
}

export default Layout;
