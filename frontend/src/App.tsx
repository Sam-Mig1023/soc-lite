/**
 * SOC-Lite · Raíz de la SPA: composición del enrutador.
 * Las rutas de negocio están protegidas por sesión; el layout publica los permisos
 * efectivos a las páginas mediante el contexto del `Outlet`.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Forbidden } from '@/components/PermissionGate';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Alerts from '@/pages/Alerts';
import AlertDetail from '@/pages/AlertDetail';
import Incidents from '@/pages/Incidents';
import IncidentDetail from '@/pages/IncidentDetail';
import Users from '@/pages/Users';
import Roles from '@/pages/Roles';
import AuditLog from '@/pages/AuditLog';
import Reports from '@/pages/Reports';
import TriageStats from '@/pages/TriageStats';
import NotFound from '@/pages/NotFound';

/** Tabla de rutas de la aplicación (ver README del frontend). */
export function App(): JSX.Element {
  return (
    <Routes>
      {/* Ruta pública */}
      <Route path="/login" element={<Login />} />

      {/* Rutas autenticadas: guarda de sesión + layout común */}
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="dashboard" element={<Navigate to="/" replace />} />

          <Route path="alerts" element={<Alerts />} />
          <Route path="alerts/:id" element={<AlertDetail />} />

          <Route path="incidents" element={<Incidents />} />
          <Route path="incidents/:id" element={<IncidentDetail />} />

          <Route path="triage" element={<TriageStats />} />

          <Route path="reports" element={<Reports />} />

          <Route
            path="audit"
            element={
              <ProtectedRoute permission="audit:read">
                <AuditLog />
              </ProtectedRoute>
            }
          />

          <Route
            path="users"
            element={
              <ProtectedRoute permission="users:read">
                <Users />
              </ProtectedRoute>
            }
          />
          <Route
            path="roles"
            element={
              <ProtectedRoute permission="roles:read">
                <Roles />
              </ProtectedRoute>
            }
          />

          <Route path="forbidden" element={<Forbidden />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      {/* Rutas fuera del layout: se resuelven en la guarda (redirige a /login) */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
