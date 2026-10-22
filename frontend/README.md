# SOC-Lite · Frontend

SPA en **React 18 + TypeScript + Vite + TailwindCSS** que consume la API v1 del backend.
Documentación de arquitectura y decisiones: [`docs/04-frontend.md`](../docs/04-frontend.md).

---

## Requisitos

- Node.js ≥ 18.18 (probado con 20 y 24)
- pnpm ≥ 8 (o npm)

## Instalación y arranque

```bash
cd frontend
pnpm install            # o: npm install
cp .env.example .env    # ajustar VITE_API_URL si el backend no está en el proxy
pnpm dev                # http://localhost:5173
```

El servidor de desarrollo aplica **proxy** de `/api` hacia `http://localhost:8000`, por lo
que no hay problemas de CORS en local.

## Scripts

| Comando | Descripción |
|---|---|
| `pnpm dev` | Servidor de desarrollo con HMR |
| `pnpm build` | Comprobación de tipos (`tsc -b`) + build de producción en `dist/` |
| `pnpm preview` | Sirve el build de producción localmente |
| `pnpm typecheck` | Sólo comprobación de tipos, sin emitir |

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `VITE_API_URL` | `/api/v1` | URL base de la API. Relativa en producción (tras el proxy inverso); absoluta en desarrollo si no se usa el proxy |
| `VITE_APP_NAME` | `SOC-Lite` | Nombre mostrado en la interfaz |

## Mapa de rutas

| Ruta | Página | Permiso mínimo |
|---|---|---|
| `/login` | Inicio de sesión | público |
| `/` | Dashboard de KPIs | `dashboard:read` |
| `/alerts` | Listado de alertas | `alerts:read` |
| `/alerts/:id` | Detalle con triaje LLM, IOCs y timeline | `alerts:read` |
| `/incidents` | Incidentes | `incidents:read` |
| `/incidents/:id` | Detalle y acciones de respuesta | `incidents:read` |
| `/triage` | Estadísticas y precisión del triaje | `triage:read` |
| `/reports` | Generación y descarga de reportes | `reports:read` |
| `/audit` | Bitácora de auditoría | `audit:read` |
| `/users` | Usuarios | `users:read` |
| `/roles` | Roles y matriz de permisos | `roles:read` |
| `/forbidden` | Acceso denegado | autenticado |

## Credenciales de demostración

| Usuario | Contraseña | Rol | Qué demuestra |
|---|---|---|---|
| `admin` | `Admin123!` | Administrador | Todo el sistema, usuarios y roles |
| `soc_manager` | `Manager123!` | Jefe de SOC | Reportes gerenciales, incidentes |
| `analista1` | `Analyst123!` | Analista SOC | Triaje, feedback, gestión de alertas |
| `auditor1` | `Audit123!` | Auditor | Bitácora y reportes de auditoría (sólo lectura) |
| `visor1` | `Viewer123!` | Consulta | Dashboard de sólo lectura — **el RBAC se hace visible** |

## Estructura

```
frontend/
├── src/
│   ├── api/            Cliente HTTP + un módulo por recurso (contrato §1-§8)
│   │   ├── client.ts   Axios, interceptores, refresh de token, descarga de blobs
│   │   ├── queryClient.ts  QueryClient + claves de caché centralizadas
│   │   └── auth|users|roles|alerts|triage|incidents|dashboard|reports|audit.ts
│   ├── components/     KpiCard, DataTable, Badges, Modal, FilterBar, ExportMenu,
│   │                   DateRangePicker, States, Toast, PermissionGate, Layout
│   ├── context/        AuthContext (sesión, permisos efectivos, hooks RBAC)
│   ├── pages/          Login, Dashboard, Alerts, AlertDetail, Incidents,
│   │                   IncidentDetail, TriageStats, Reports, AuditLog, Users, Roles
│   ├── types/          Enums y DTOs espejo del contrato de API
│   └── utils/          format.ts (formateo es-CL) y errors.ts (normalización de errores)
├── Dockerfile          Build multi-stage → nginx
└── nginx.conf          Servidor interno (SPA fallback + caché de assets)
```

## Doctor de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| 401 en bucle | `SECRET_KEY` distinta entre reinicios del backend | Fijar `SECRET_KEY` en `.env` |
| CORS bloqueado | `VITE_API_URL` absoluta sin CORS configurado | Usar la ruta relativa `/api/v1` con proxy |
| Menús vacíos | El usuario no tiene permisos (RBAC) | Iniciar sesión con `admin` para ver todo |
| Gráficos sin datos | Base de datos sin alertas | `SELECT soclite.generate_synthetic_alerts(5000, 30);` |
