# SOC-Lite · Backend (FastAPI)

Código: [`backend/`](../backend) · Contrato: [`docs/00-contrato-api.md`](00-contrato-api.md)

---

## 1. Estructura del proyecto

```
backend/
├── requirements.txt
├── app/
│   ├── main.py                        # aplicación FastAPI, middleware, routers
│   ├── core/
│   │   ├── config.py                  # Pydantic Settings (todo configurable por entorno)
│   │   ├── security.py                # bcrypt, JWT, RBAC, fingerprint, risk score
│   │   ├── context.py                 # contextvars del request (auditoría sin acoplamiento)
│   │   ├── exceptions.py              # errores de dominio + manejadores uniformes
│   │   └── logging.py                 # logging JSON ingerible por Wazuh/ELK
│   ├── db/
│   │   └── session.py                 # engine async, AsyncSessionLocal, health check
│   ├── models/                        # SQLAlchemy 2.0 (typed mapped_column)
│   │   ├── enums.py                   # espejo exacto de los ENUM de PostgreSQL
│   │   ├── user.py  alert.py  incident.py  audit.py  ops.py
│   ├── schemas/                       # Pydantic v2 (contratos de E/S)
│   │   ├── common.py  user.py  alert.py  incident.py  dashboard.py
│   ├── api/
│   │   ├── deps.py                    # autenticación, RBAC, dependencias tipadas
│   │   └── v1/
│   │       ├── router.py              # agregador
│   │       └── routers/
│   │           ├── auth.py  users.py  roles.py  alerts.py  triage.py
│   │           ├── incidents.py  dashboard.py  reports.py  audit.py  health.py
│   ├── services/
│   │   ├── audit_service.py           # bitácora: escritura, búsqueda, verificación de cadena
│   │   ├── triage_service.py          # orquestación del microservicio LangChain
│   │   ├── metrics_service.py         # agregaciones para el dashboard
│   │   └── report_service.py          # generación PDF / DOCX / XLSX / CSV
│   └── middleware/
│       └── audit_middleware.py        # bitácora de acceso + cabeceras de seguridad
└── tests/
```

**Patrón:** capas estrictas `router → service → model`. Los routers nunca ejecutan SQL
complejo; los servicios no conocen `Request`; los modelos no contienen lógica de negocio.

---

## 2. Configuración y arranque

`app/core/config.py` centraliza **más de 70 parámetros** con `pydantic-settings`:

```python
settings.database_url          # postgresql+asyncpg://...
settings.SLA_MINUTES           # {"critical": 15, "high": 60, "medium": 480, "low": 1440}
settings.MIN_SEVERITY_TO_PROCESS   # umbral de triaje (nivel regla Wazuh)
settings.AUTO_CLOSE_FP_CONFIDENCE  # cierre automático de falsos positivos
settings.ALLOW_EXTERNAL_LLM        # false por defecto → no exfiltración
settings.SECRET_KEY, JWT_ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES
```

`app/main.py`:

```python
@asynccontextmanager
async def lifespan(app):
    configure_logging()
    db = await check_database_health()          # verifica PostgreSQL al arrancar
    if settings.ALLOW_EXTERNAL_LLM: logger.warning(...)
    yield
    await engine.dispose()
```

Orden de middleware (el último registrado es el más externo):

```
CORS → SecurityHeaders → AuditMiddleware → routers
```

---

## 3. Autenticación y seguridad

### 3.1 Login (`POST /api/v1/auth/login`)

1. Busca por `username` **o** `email`.
2. Verifica bloqueo temporal (`locked_until`).
3. Verifica la contraseña con bcrypt (coste 12).
   - Fallo → incrementa `failed_attempts`; a los 5 intentos bloquea 15 min y registra
     `LOGIN_FAILED` con `severity="critical"`.
4. Si `mfa_enabled`, valida TOTP con ventana de ±1 intervalo.
5. Emite `access_token` (30 min) + `refresh_token` (8 h), guardando el **hash sha256**
   del refresh en `refresh_tokens` con `jti`, `expires_at`, IP y user-agent.
6. Registra `LOGIN` en la bitácora.

### 3.2 Refresh con rotación (`POST /auth/refresh`)

El refresh usado se revoca y se emite uno nuevo. Si llega un refresh ya revocado,
se rechaza → **detección de robo/reutilización de token**.

### 3.3 Política de contraseñas

`validate_password_strength()` valida longitud mínima (12), mayúscula, minúscula,
dígito, carácter especial y lista negra de contraseñas comunes. Se aplica en
`UserCreate` y en `ChangePasswordRequest` mediante `field_validator` de Pydantic.

### 3.4 RBAC

**22 permisos** con formato `modulo:accion`. La comprobación admite comodines:

```python
def has_permission(granted, required) -> bool:
    if "*" in granted or "admin:all" in granted: return True
    if required in granted: return True
    return f"{required.split(':', 1)[0]}:*" in granted
```

Factoría de dependencias reutilizable:

```python
def require_permissions(*required: str) -> Callable:
    async def _checker(current: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        missing = [p for p in required if not current.can(p)]
        if missing:
            raise HTTPException(403, detail=f"Permisos insuficientes. Requerido: {', '.join(missing)}",
                                headers={"X-Required-Permissions": ",".join(required)})
        return current
    return _checker

AlertWriter = Annotated[CurrentUser, Depends(require_permissions("alerts:write"))]
```

Uso en un endpoint:

```python
@router.patch("/{alert_id}")
async def update_alert(alert_id: int, body: AlertUpdate, db: DbSession, current: AlertWriter):
    ...
```

### 3.5 Cabeceras de seguridad (`SecurityHeadersMiddleware`)

`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
`Permissions-Policy`, `Content-Security-Policy`, y `Strict-Transport-Security` bajo HTTPS.
Cubre ISO 27001 A.8.23 y NIST CSF PR.PS-01.

---

## 4. Bitácora de auditoría — implementación de doble capa

El requisito *"registre entradas y salidas por módulo (usuario, fecha, hora y acción realizada)"*
se resuelve con dos capas que **no duplican registros**:

```
┌──────────────────────────────────────────────────────────────────────┐
│ AuditMiddleware                                                       │
│ 1. Genera trace_id, captura IP, user-agent y módulo (por prefijo)    │
│ 2. Abre un RequestAuditContext (contextvars)                         │
│ 3. Ejecuta el endpoint                                               │
│ 4. Si ctx.written == False → escribe la ENTRADA/SALIDA de acceso     │
│    ("[acceso] PATCH /api/v1/alerts/1042 → HTTP 200 en 64 ms")        │
└──────────────────────────────────────────────────────────────────────┘
                              ▲ marca ctx.written = True
┌─────────────────────────────┴────────────────────────────────────────┐
│ AuditService.log() — capa de NEGOCIO                                  │
│ Escrito por los routers con detalle funcional: entidad, before/after, │
│ motivo, severidad. Ej.: "Cambio de estado pending → triaged"          │
└──────────────────────────────────────────────────────────────────────┘
```

**Resultado:** toda petición autenticada a un módulo auditable deja **exactamente una
traza** con usuario + fecha + hora + módulo + acción + resultado; las operaciones
sensibles añaden además el detalle de negocio y el diff.

Propiedades adicionales:

| Propiedad | Implementación |
|---|---|
| Fail-open | Si la bitácora falla, la operación de negocio continúa; se emite log `CRITICAL` |
| Diff automático | `compute_diff(before, after)` → `{"campo": {"from": ..., "to": ...}}` |
| Inmutabilidad | Reglas PostgreSQL + trigger de hash chain (no depende de la app) |
| Trazabilidad end-to-end | Todo evento comparte `trace_id` (también devuelto en `X-Trace-Id`) |
| Auditar al auditor | Las consultas a `/audit/logs` se registran a su vez |
| Verificación | `GET /audit/verify-chain` recorre la cadena `hash_prev → hash_self` |

Ejemplo de evento (respuesta real de la API):

```json
{
  "id": 90112, "occurred_at": "2025-01-31T14:23:02-05:00",
  "user_id": 3, "username": "analista1",
  "module": "alerts", "action": "UPDATE", "entity": "alert", "entity_id": "1042",
  "result": "success", "ip_address": "10.10.2.44",
  "http_method": "PATCH", "http_path": "/api/v1/alerts/1042", "http_status": 200,
  "duration_ms": 64, "trace_id": "b1f0a7e2-…",
  "before_data": {"status": "pending"}, "after_data": {"status": "closed"},
  "changes": {"status": {"from": "pending", "to": "closed"}},
  "severity": "warning"
}
```

---

## 5. Módulo de alertas

### 5.1 Ingesta (`POST /alerts/ingest`)

Protegida por `X-Ingest-Key` (comparación en tiempo constante con `hmac.compare_digest`).

```python
source = (x_source_type or payload.get("source_type") or "wazuh").lower()
normalized = AlertIngest.from_wazuh(payload) if source == "wazuh" and "rule" in payload \
             else AlertIngest.model_validate({**payload, "source_type": source})
```

**Normalizador Wazuh** (`AlertIngest.from_wazuh`): extrae `rule.*`, `agent.*`, `data.*`,
`mitre.*`, convierte `timestamp` a datetime y aplica `level_to_severity()`:

| Nivel Wazuh | Severidad normalizada |
|---|---|
| ≥ 12 | `critical` |
| 9–11 | `high` |
| 6–8 | `medium` |
| 3–5 | `low` |
| 0–2 | `info` |

**Idempotencia y deduplicación:**

```python
bucket = occurred_at.replace(minute=(occurred_at.minute // 5) * 5, second=0, microsecond=0)
fingerprint = compute_fingerprint(source_type, rule_id, source_ip or agent_name, bucket.isoformat())
```

Si el `alert_fingerprint` ya existe → `dedup_count += 1`, se devuelve `duplicated: true`
y **no se re-tria**. Esto es lo que evita que una tormenta de 500 eventos idénticos
consuma 500 inferencias LLM.

**Resolución del activo:** busca en `assets` por `dest_ip` o `agent_name` para heredar
`criticality` e `is_internet_facing` (contexto del LLM).

**Encolado del triaje:** si `rule_level >= MIN_SEVERITY_TO_PROCESS` (7), se lanza
`BackgroundTasks` con su propia sesión de BD → la respuesta HTTP es inmediata.

### 5.2 Listado (`GET /alerts`)

Soporta 16 filtros: severidad múltiple, estado múltiple, veredicto, origen, activo, IP,
rango temporal, búsqueda textual (`ILIKE` sobre descripción y log), `min_risk_score`,
`has_triage`, `only_sla_breached`, orden por `occurred_at|risk_score|severity|mttt_seconds|id`
y paginación. Devuelve el envelope `Page` con `total` y `pages`.

### 5.3 Detalle, timeline y enriquecimiento

- `GET /alerts/{id}` → alerta + activo + indicadores + todos los triajes (con `is_current`).
- `GET /alerts/{id}/timeline` → eventos unificados: detección → ingesta → triaje →
  cambio de estado → incidente → eventos de auditoría, ordenados cronológicamente.
- `GET /alerts/{id}/enrichment` → indicadores con proveedor, veredicto y score.

### 5.4 Actualización y acciones masivas

`PATCH /alerts/{id}` con `AlertUpdate` (estado, asignación, severidad, supresión, notas).
Al cerrar se calcula `mttr_seconds`. `POST /alerts/bulk/status` procesa hasta 500 alertas
en una transacción, registrando una entrada de bitácora por alerta (`commit=False`).

---

## 6. Módulo de triaje

### 6.1 Orquestación (`TriageService`)

```python
async def run(self, alert, force=False):
    trace_id = str(uuid4())
    alert.status = ENRICHING                                   # 1. estado transitorio
    result = await self.call_langchain(alert, trace_id)        # 2. agente LLM (3 reintentos, backoff)
    triage = await self.persist(alert, result, trace_id)        # 3. persistencia + is_current
    incident = await self.maybe_create_incident(alert, triage)  # 4. incidente si crítico
    notified = await self.queue_notification(alert, triage)     # 5. encolar notificación
    return {...}
```

**Contexto enriquecido que se envía al agente** (`build_context`):

```python
{
  "recent_alerts_same_source": 6,        # correlación temporal (24 h)
  "asset_criticality": "high",           # desde el inventario
  "asset_internet_facing": False,
  "known_false_positives": 0,            # memoria de incidentes
  "is_working_hours": True,
  "policy": {"allow_external_llm": False, "max_severity_auto_close": "low"}
}
```

**Cliente HTTP resiliente:** `httpx.AsyncClient` con timeout de 120 s, 3 reintentos
y espera exponencial (`asyncio.sleep(min(2**attempt, 8))`).

**Degradación 24/7:** si el microservicio no responde, `heuristic_triage()` aplica
reglas deterministas (nivel de regla + criticidad del activo), marca `confidence=0.35`
y deja el texto "requiere validación manual". **La alerta nunca se pierde.**

### 6.2 Cálculo del `risk_score` (explicable y auditable)

```python
score = base * 0.35           # severidad normalizada
      + (rule_level/15*100) * 0.20   # nivel de la regla del SIEM
      + crit_weight * 0.20           # criticidad del activo
      + ti_score * 0.15              # reputación de los indicadores
      + llm_confidence * 100 * 0.10  # confianza del modelo
```

### 6.3 Decisión de estado posterior al triaje

| Condición | Estado resultante |
|---|---|
| `verdict = false_positive` **y** `confidence ≥ 0.90` | `false_positive` (cierre automático, MTTR calculado) |
| `severity ∈ {critical, high}` **o** `risk_score ≥ 75` | `escalated` |
| Resto | `triaged` |

### 6.4 Respuesta automatizada

- **Incidente:** se crea si `severity = critical` **o** `risk_score ≥ 90`, y el veredicto
  no es FP ni benigno. Código correlativo `INC-YYYY-NNNNN`, descripción con el resumen LLM,
  alerta vinculada en `incident_alerts`.
- **Notificación:** se encola en `notifications` sólo para severidad alta/crítica, con
  payload listo para Slack/Telegram/email (incluye enlace directo al dashboard).
- **Ticket:** `external_ticket_id`/`url` para osTicket o Redmine.

### 6.5 Retroalimentación humana (`POST /triage/{id}/feedback`)

Etiqueta `confirmed_tp` / `confirmed_fp` con comentario. Actualiza la alerta (si es FP,
la marca y cierra calculando MTTR) y alimenta la métrica `agreement_with_human` que
mide la precisión real del modelo. **Este es el mecanismo de mejora continua.**

### 6.6 Estadísticas (`GET /triage/stats`)

`total_triages`, distribución por veredicto/severidad/modelo, `precision` (TP/(TP+FP)),
`false_positive_rate`, `agreement_with_human`, `avg_confidence`, `avg_latency_ms`, `avg_tokens`.
Sirve para detectar **deriva del modelo** y comparar versiones de prompt.

---

## 7. Módulo de incidentes

CRUD completo más: vinculación de alertas (`POST /incidents/{id}/alerts` — marca las
alertas como `escalated`), registro de acciones de respuesta
(`POST /incidents/{id}/actions` con `action_type` ∈ isolate_host/block_ip/reset_credentials/
ticket/notify/forensics), y consulta del ticket externo. Las marcas temporales
(`contained_at`, `resolved_at`, `closed_at`) se actualizan automáticamente según el estado,
y `mttr_seconds` se deriva de `detected_at`/`resolved_at`.

---

## 8. Dashboard (`MetricsService`)

Todas las agregaciones se ejecutan **en PostgreSQL**, no en Python:

| Endpoint | Cálculo destacado |
|---|---|
| `GET /dashboard/summary` | 20 KPIs en una sola llamada: conteos por severidad/estado/veredicto, MTTT (avg/mediana/P95 con `percentile_cont`), MTTR, tasa de FP, tasa de automatización, reducción de ruido, incidentes, SLA, alertas de hoy, tendencia vs. periodo anterior |
| `GET /dashboard/alerts-by-severity` | `date_trunc(granularity, occurred_at)` con `granularity` ∈ hour/day/week/month |
| `GET /dashboard/mttt-trend` | MTTT diario avg+P95 y línea de objetivo SLA |
| `GET /dashboard/top-sources` | Top IPs, activos, reglas y técnicas MITRE (con riesgo medio) |
| `GET /dashboard/fp-rate` | Tasa global, por regla, por modelo y concordancia humana |
| `GET /dashboard/sla-compliance` | Cumplimiento y brecha por severidad |
| `GET /dashboard/analyst-workload` | Carga por analista (abiertas/escaladas/cerradas, MTTT promedio) |
| `POST /dashboard/refresh-metrics` | Recalcula `alert_metrics_daily` + `ANALYZE` (requiere `settings:write`) |

**Fórmula de reducción de ruido:** `(low + info + false_positives) / total`.
**Fórmula de automatización:** `alertas_con_triaje / total`.

---

## 9. Reportes exportables (`ReportService`)

Tres tipos × cuatro formatos:

| Tipo | Contenido |
|---|---|
| `operational` | Volumen, MTTT/MTTR, top reglas/orígenes, precisión del triaje, incidentes, alertas de mayor riesgo, carga del equipo |
| `management` | Todo lo anterior + mapeo de controles ISO/IEC 27001:2022 y NIST CSF 2.0, tendencias, cumplimiento SLA |
| `audit` | Extracto de bitácora (hasta 5.000 eventos en PDF/Word, 50.000 en CSV/Excel) con hash de integridad y resumen por módulo/acción |

| Formato | Librería | Detalles de implementación |
|---|---|---|
| **PDF** | `reportlab` | A4 horizontal, portada con periodo, 10 secciones, tablas con cabecera repetida, colores por severidad, mapeo normativo |
| **Word** | `python-docx` | Portada, encabezados jerárquicos, tablas con estilo `Light Grid Accent 1`, resumen ejecutivo redactado |
| **Excel** | `openpyxl` | 11 hojas: Resumen, Severidad (**con gráfico de barras**), MTTT_diario (**con gráfico de líneas vs. objetivo**), Top_origenes, Triaje, Incidentes, SLA, Equipo, Bitacora, Auditoria_resumen, Cumplimiento. Formato condicional de porcentajes, paneles congelados y autofiltros |
| **CSV** | `csv` | Export plano de alertas para análisis externo |

Cada generación:
1. Persiste el artefacto en `storage/reports/{tipo}/{YYYY}/{MM}/`.
2. Registra `generated_reports` con ruta, tamaño y **`checksum_sha256`**.
3. Escribe `EXPORT` en la bitácora con módulo, formato, rango y checksum.
4. Se devuelve con `Content-Disposition` y cabeceras `X-Report-Id` / `X-Report-Checksum`.

---

## 10. Manejo de errores

`app/core/exceptions.py` define la jerarquía de dominio
(`SocLiteError`, `NotFoundError`, `ConflictError`, `PermissionDeniedError`, `IntegrationError`)
y cuatro manejadores globales que producen **siempre** el mismo envelope:

```json
{
  "detail": "Permisos insuficientes. Requerido: alerts:write",
  "code": "PERMISSION_DENIED",
  "trace_id": "b1f0a7e2-4c3d-4f1a-9e2b-7d8c1a2b3c4d"
}
```

Códigos: `UNAUTHENTICATED`, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT`,
`VALIDATION_ERROR` (con lista de campos), `ACCOUNT_LOCKED`, `RATE_LIMITED`,
`INTEGRATION_ERROR`, `INTERNAL_ERROR`.

---

## 11. Observabilidad

| Aspecto | Implementación |
|---|---|
| Logs | JSON estructurado (`JsonFormatter`) con `@timestamp`, `level`, `service`, `trace_id`, `duration_ms` → ingerible directamente por Wazuh/ELK |
| Métricas | `GET /metrics` en formato Prometheus |
| Salud | `GET /health` (liveness, sin BD) y `GET /health/ready` (PostgreSQL + microservicio LLM) |
| Trazas | `X-Trace-Id` en todas las respuestas; mismo `trace_id` en `audit_log`, `triage_results` y el log del microservicio |
| Errores | `sentry-sdk` opcional vía `SENTRY_DSN` |

---

## 12. Pruebas y ejecución

```bash
# Preparar entorno
cd backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp ../.env.example ../.env                         # ajustar credenciales

# Base de datos
psql -U soclite -d soclite -f ../db/schema.sql
psql -U soclite -d soclite -f ../db/seed.sql

# Arrancar
uvicorn app.main:app --reload --port 8000
# Documentación interactiva: http://localhost:8000/docs

# Pruebas
pytest -q --cov=app
```

**Prueba de humo del flujo completo:**

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login \
  -d "username=analista1&password=Analyst123!" | jq -r .access_token)

# 2. Ingesta simulada de Wazuh
curl -s -X POST http://localhost:8000/api/v1/alerts/ingest \
  -H "X-Ingest-Key: $INGEST_API_KEY" -H "Content-Type: application/json" \
  -d '{"rule":{"id":"5710","level":10,"description":"Attempt to login using a non-existent user",
       "groups":["authentication_failed"]},
       "agent":{"id":"001","name":"WKS-CONTAB01"},
       "data":{"srcip":"203.0.113.44","dstip":"10.0.4.21"},
       "full_log":"sshd: Failed password for invalid user admin from 203.0.113.44",
       "timestamp":"2025-01-31T14:22:05Z"}' | jq

# 3. Dashboard
curl -s http://localhost:8000/api/v1/dashboard/summary -H "Authorization: Bearer $TOKEN" | jq .mttt_seconds

# 4. Reporte gerencial en Excel
curl -s "http://localhost:8000/api/v1/reports/management?format=xlsx" \
  -H "Authorization: Bearer $TOKEN" -o reporte.xlsx

# 5. Bitácora (comprobar que todo quedó registrado)
curl -s "http://localhost:8000/api/v1/audit/logs?page_size=10" \
  -H "Authorization: Bearer $TOKEN" | jq '.items[] | {module, action, username}'
```
