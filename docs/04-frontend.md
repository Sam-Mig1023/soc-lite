# SOC-Lite · Frontend (React + TypeScript)

Código: [`frontend/`](../frontend) · Contrato: [`docs/00-contrato-api.md`](00-contrato-api.md)

---

## 1. Stack y justificación

| Tecnología | Versión | Por qué |
|---|---|---|
| **React** | 18.3 | Renderizado concurrente y `Suspense`: tablas de miles de alertas sin bloquear la interacción |
| **TypeScript** | 5.6 (`strict: true`) | Los enums y DTOs replican el contrato; un cambio de API rompe la compilación en vez de fallar en producción |
| **Vite** | 5.4 | Arranque en frío < 300 ms, HMR instantáneo, proxy `/api → :8000` que elimina el CORS en desarrollo |
| **TailwindCSS** | 3.4 | El tema oscuro tipo SOC (slate-900/950 + acentos cian) se define una vez; los badges de severidad comparten paleta |
| **TanStack Query** | 5 | Caché, revalidación y auto-refresh: un dashboard SOC no debe recargar la página |
| **Axios** | 1.7 | Interceptores para adjuntar el token y refrescarlo de forma transparente |
| **Recharts** | 2.13 | Gráficos SVG declarativos; cubre los seis widgets requeridos |
| **React Router** | 6.26 | Rutas anidadas con guardas de sesión y de permiso |
| **React Hook Form + Zod** | 7 / 3 | Validación en cliente con los mismos criterios que el backend |
| **lucide-react** | 0.451 | Iconografía consistente y ligera |

**Descartado:** Next.js (no se necesita SSR: es una consola interna tras autenticación),
Redux (el estado del servidor lo gestiona TanStack Query; el estado local es trivial).

---

## 2. Estructura de carpetas

```
frontend/
├── index.html                     Punto de entrada
├── vite.config.ts                 Proxy /api → localhost:8000, alias @/ → src/
├── tailwind.config.js             Tema SOC (paleta, sombras, animaciones)
├── tsconfig.json                  strict + noUnusedLocals + paths @/*
├── Dockerfile                     Build multi-stage → nginx (imagen final ~25 MB)
├── nginx.conf                     SPA fallback, caché de assets, gzip
└── src/
    ├── main.tsx                   Providers: QueryClient → Auth → Toast → Router
    ├── App.tsx                    Tabla de rutas y guardas
    ├── index.css                  Capas de componentes (.soc-panel, .soc-btn-*, .soc-input…)
    ├── api/
    │   ├── client.ts              Axios + interceptores + refresh con cola + downloadBlob
    │   ├── queryClient.ts         QueryClient, queryKeys, intervalos de refresco
    │   ├── index.ts               Barrel de la capa de datos
    │   └── auth|users|roles|alerts|triage|incidents|dashboard|reports|audit.ts
    ├── components/
    │   ├── Layout.tsx             Sidebar con navegación filtrada por permisos, topbar, breadcrumb
    │   ├── DataTable.tsx          Tabla genérica: orden server-side, paginación, selección múltiple
    │   ├── KpiCard.tsx            Tarjeta de KPI con tendencia, objetivo y tono
    │   ├── Badges.tsx             SeverityBadge, StatusBadge, VerdictBadge, RiskScore,
    │   │                          PriorityBadge, ConfidenceBadge, SourceTypeBadge, AuditResultBadge
    │   ├── Modal.tsx              Modal, ConfirmDialog, DecisionDialog (accesibles, con focus trap)
    │   ├── FilterBar.tsx          FilterBar + FilterField (rejilla responsive con buscador y reset)
    │   ├── DateRangePicker.tsx    Presets 24 h/7 d/30 d/90 d + conversión a ISO-8601
    │   ├── ExportMenu.tsx         Menú de exportación por blob con estado de descarga
    │   ├── States.tsx             Loading, Skeleton, SkeletonTable, SkeletonCards, EmptyState,
    │   │                          ErrorState, ErrorBoundary
    │   ├── Toast.tsx              Sistema de notificaciones + hook useToast
    │   ├── PermissionGate.tsx     RBAC en UI (hide/disable) + pantalla Forbidden
    │   └── ProtectedRoute.tsx     Guarda de sesión y de permiso por ruta
    ├── context/
    │   └── AuthContext.tsx        Sesión, permisos efectivos, hasPermission, usePermission
    ├── pages/                     Una carpeta por módulo funcional (ver §4)
    ├── types/
    │   ├── enums.ts               FUENTE DE VERDAD de los enums del contrato (§Enumeraciones)
    │   ├── common.ts              Paginated<T>, ApiError, filtros, GeneratedReport, AuditLogEntry
    │   ├── auth.ts                User, Session, LoginRequest, AuthProfile
    │   ├── alert.ts               AlertListItem, AlertDetail, TriageResult, EnrichmentRecord, TriageStats
    │   ├── incident.ts            IncidentListItem, IncidentDetail, IncidentAction
    │   └── dashboard.ts           DashboardSummary, MtttTrendPoint, FpRateResponse, SlaComplianceResponse
    └── utils/
        ├── format.ts              Fechas es-CL, duraciones, porcentajes, bytes, saveBlob, cx
        └── errors.ts              normalizeError, getErrorMessage, isForbidden, isUnauthorized…
```

---

## 3. Decisiones de diseño

### 3.1 Estado: servidor en caché, local mínimo

El 95 % del estado de esta aplicación **vive en el servidor**. Por eso se usa
TanStack Query en lugar de Redux o Zustand:

```ts
useQuery({
  queryKey: queryKeys.dashboard.summary(range),
  queryFn: () => dashboardApi.summary(range),
  refetchInterval: DASHBOARD_REFRESH_MS,   // 30 s
});
```

- Las claves están centralizadas en `queryKeys` para que una invalidación sea consistente
  entre pantallas (`queryClient.invalidateQueries({ queryKey: queryKeys.alerts.all() })`).
- El **dashboard se auto-refresca cada 30 s**; los listados, cada 60 s (`LIST_REFRESH_MS`).
- El estado local se limita a filtros, paginación y modales (`useState`), y a los filtros
  derivados (`useMemo`) que alimentan los gráficos.

### 3.2 Cliente HTTP con refresh transparente

`src/api/client.ts` implementa:

1. **Interceptor de request**: adjunta `Authorization: Bearer <access_token>`.
2. **Interceptor de response**: ante un `401`, intenta `POST /auth/refresh` **una sola vez**,
   con una **cola de peticiones** para que 10 peticiones simultáneas no disparen 10 refrescos.
3. Si el refresh falla, limpia la sesión, emite `soclite:session-expired` y el `AuthContext`
   redirige a `/login`.
4. `downloadBlob()` centraliza la descarga de binarios (reportes y exportaciones) leyendo el
   nombre de fichero de `content-disposition` (incluido `filename*=UTF-8''`).

### 3.3 RBAC en la interfaz

Tres niveles de defensa, siempre con el backend como autoridad final:

| Nivel | Mecanismo | Ejemplo |
|---|---|---|
| **Ruta** | `<ProtectedRoute permission="audit:read">` | `/audit` redirige a `/forbidden` |
| **Navegación** | `Layout` filtra los enlaces por permiso | Un `analyst` no ve "Usuarios" ni "Roles" |
| **Acción** | `usePermission('alerts:write')` o `<PermissionGate>` | Los botones de escritura se ocultan o se atenúan con `title` explicativo |

```tsx
const canWrite = usePermission('alerts:write');

<button
  className="soc-btn-primary"
  disabled={!canWrite}
  title={canWrite ? undefined : 'Necesitas el permiso alerts:write'}
  onClick={submit}
>Guardar</button>
```

**Nota de seguridad documentada en el código:** ocultar en la UI es *defensa en profundidad*;
el backend vuelve a validar el permiso en cada endpoint y responde `403 PERMISSION_DENIED`,
lo que además queda registrado en la bitácora.

### 3.4 Accesibilidad y usabilidad

- Estados explícitos en toda vista: `Loading` → `EmptyState` / `ErrorState` con reintento.
- `ErrorBoundary` global: un fallo de render no deja la SPA en blanco.
- Modales con focus trap, cierre por `Escape` y `aria-modal`.
- Tablas con `caption` (a veces `sr-only`), `scope="col"` y `aria-sort`.
- Colores de severidad acompañados siempre de **texto**, no sólo de color (daltonismo).
- `hideOnMobile` en la definición de columnas para que la tabla sea usable en tablet.

---

## 4. Páginas y widgets

| Página | Widgets / secciones | Endpoints que consume |
|---|---|---|
| `Login.tsx` | Formulario, credenciales demo, manejo de cuenta bloqueada | `POST /auth/login`, `GET /auth/me` |
| `Dashboard.tsx` | 8 tarjetas KPI + 6 gráficos + carga por analista | `/dashboard/summary`, `/alerts-by-severity`, `/mttt-trend`, `/top-sources`, `/fp-rate`, `/sla-compliance`, `/analyst-workload`, `/triage/stats` |
| `Alerts.tsx` | Filtros múltiples, tabla ordenable, selección múltiple, acción masiva | `GET /alerts`, `POST /alerts/bulk/status` |
| `AlertDetail.tsx` | Resumen LLM + razonamiento, acciones recomendadas, IOCs, MITRE, log, timeline, panel de acciones | `GET /alerts/{id}`, `/enrichment`, `/timeline`, `POST /triage/{id}/run`, `/feedback`, `PATCH /alerts/{id}`, `POST /incidents` |
| `Incidents.tsx` | Listado con prioridad/estado, creación | `GET/POST /incidents` |
| `IncidentDetail.tsx` | Alertas vinculadas, acciones de respuesta, ticket externo | `GET/PUT /incidents/{id}`, `/alerts`, `/actions`, `/ticket` |
| `TriageStats.tsx` | 8 KPI de precisión + 4 gráficos + tabla de triajes recientes | `GET /triage/stats`, `GET /triage/results` |
| `Reports.tsx` | Generador (tipo × formato × periodo) + KPIs del historial + tabla con descarga | `GET /reports/{operational,management,audit}`, `/reports/inventory`, `/reports/{id}/download` |
| `AuditLog.tsx` | Filtros por usuario/módulo/acción/resultado, diff antes/después, exportación | `GET /audit/logs`, `/audit/logs/{id}`, `/audit/stats`, `/audit/logs/export` |
| `Users.tsx` | CRUD, asignación de roles, activación/desactivación | `GET/POST/PUT/DELETE /users`, `POST /users/{id}/roles` |
| `Roles.tsx` | CRUD de roles + **matriz de permisos** con casillas agrupadas por módulo | `GET/POST/PUT/DELETE /roles`, `GET /permissions` |

---

## 5. Construcción de los gráficos

Todos los widgets usan **Recharts** y se alimentan de un endpoint distinto: la página no
calcula métricas, sólo presenta lo que agrega PostgreSQL.

| Widget | Componente Recharts | Endpoint | Campos usados |
|---|---|---|---|
| Alertas por severidad (distribución) | `BarChart` con `Cell` por color | `GET /dashboard/summary` → `by_severity` | severidad, conteo |
| Evolución por severidad (temporal) | `BarChart` apilado (`stackId`) | `GET /dashboard/alerts-by-severity?granularity=day` | `period`, `critical`, `high`, `medium`, `low`, `info` |
| Evolución del MTTT vs objetivo | `ComposedChart` (líneas + `ReferenceLine`) | `GET /dashboard/mttt-trend?days=30` | `date`, `mttt_avg_sec`, `mttt_p95_sec`, `target_sla_sec` |
| Distribución de veredictos | `PieChart` con `innerRadius` (donut) | `GET /triage/stats` → `verdict_distribution` | clave = veredicto, valor = conteo |
| Top 10 orígenes (IP / regla) | `BarChart` | `GET /dashboard/top-sources?limit=10` | `source_ips[].value/count`, `rules[].rule_id` + `count` |
| Cumplimiento de SLA | barras objetivo vs real | `GET /dashboard/sla-compliance` → `items[]` | `severity`, `compliance`, `target`, `total` |
| Carga por analista | `BarChart` apilado | `GET /dashboard/analyst-workload` | `abiertas`, `escaladas`, `cerradas` |
| Latencia del triaje | `BarChart` | `GET /triage/stats` → `latency_ms` | `avg`, `median`, `p95`, `max` |
| Ejecuciones por modelo | `BarChart` horizontal | `GET /triage/stats` → `by_model[]` | `model_name`, `runs`, `avg_confidence` |
| Uso de herramientas del agente | `BarChart` horizontal | `GET /triage/stats` → `tools_usage[]` | `tool`, `count` |

**Compatibilidad de esquemas:** el backend devuelve los campos canónicos del contrato **y**
los alias normalizados que consumen estos widgets (`mttt_avg` / `mttt_avg_sec`,
`period` / `date`, `key` / `value`). Así ninguna vista necesita transformar datos en el
cliente, y el contrato sigue siendo legible para otros consumidores.

**Colores:** `SEVERITY_CHART_COLORS` y `verdictChartColor()` viven en `components/Badges.tsx`,
de modo que un badge y su sector del gráfico comparten exactamente el mismo color.

---

## 6. Formularios y validación

- `Login.tsx` usa React Hook Form con esquema Zod (`username` ≥ 3 caracteres, `password` requerido).
- Los formularios de usuarios y roles validan en cliente los mismos criterios que el backend
  (longitud de contraseña, complejidad, formato de email) para dar *feedback* inmediato, pero
  **el backend vuelve a validar** con `validate_password_strength()`.
- Los errores `422 VALIDATION_ERROR` del backend se mapean campo a campo usando la lista
  `errors[]` del envelope de error.

---

## 7. Rendimiento

| Técnica | Efecto |
|---|---|
| Caché de TanStack Query con `staleTime` | Navegar entre páginas no refetch innecesariamente |
| Paginación **server-side** en todas las tablas | Nunca se cargan más de 200 filas |
| `useMemo` en las transformaciones de datos para gráficos | Evita recalcular series en cada render |
| Code splitting por ruta (Vite) | El bundle inicial no incluye las pantallas de administración |
| `maxHeight` con scroll interno en tablas largas | La cabecera permanece visible (`sticky`) |
| `gzip` + caché inmutable de `/assets/` en nginx | El bundle viaja comprimido y los assets hasheados no se re-descargan |

---

## 8. Pruebas y verificación

```bash
cd frontend
pnpm typecheck     # tsc --noEmit con strict + noUnusedLocals
pnpm build         # tsc -b && vite build
pnpm preview       # sirve dist/ para verificar el comportamiento de producción
```

**Lista de verificación manual sugerida:**

1. Entrar con `visor1` → no aparecen los menús de Usuarios, Roles, Bitácora ni el botón de
   exportar en Reportes (**RBAC visible**).
2. Entrar con `analista1` → aparece "Triaje IA", y en el detalle de una alerta los botones de
   cambio de estado están habilitados.
3. Entrar con `auditor1` → puede ver la Bitácora y exportarla, pero no modificar nada.
4. En el Dashboard, comprobar que los KPIs cambian al variar el rango de fechas.
5. En Reportes, generar el gerencial en **xlsx** y verificar que el libro contiene las 11 hojas
   con gráficos nativos.
6. En el detalle de una alerta, ejecutar **Triaje** y comprobar que el resumen, el razonamiento,
   las acciones recomendadas y los IOCs aparecen sin recargar la página.
7. Comprobar en `/audit` que todas las acciones anteriores quedaron registradas con usuario,
   fecha, hora, módulo, acción y resultado.

---

## 9. Despliegue

El `Dockerfile` construye la SPA y la sirve con nginx dentro del contenedor:

```bash
docker build -t soc-lite/frontend:1.0.0 \
  --build-arg VITE_API_URL=/api/v1 ./frontend
```

`VITE_API_URL` se inyecta **en tiempo de build** porque Vite serializa las variables `VITE_*`
dentro del bundle. En producción se usa la ruta relativa `/api/v1` y el nginx perimetral
(`deploy/nginx.conf`) enruta `/api/` hacia el contenedor `backend`.
