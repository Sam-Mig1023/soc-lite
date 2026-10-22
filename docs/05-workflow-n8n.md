# SOC-Lite · Documento 05 — Workflows n8n

> **Ámbito.** Este documento describe la capa de orquestación del SOC-Lite construida en
> **n8n**: la cadena de triaje automático (Webhook → deduplicación → PostgreSQL →
> agente LangChain → enrutamiento → notificación → ticket/incidente → bitácora) y los
> cuatro trabajos programados de soporte (deduplicación, SLA, métricas y reportes).
>
> **Documentos normativos con los que se alinea:**
> [`docs/00-contrato-api.md`](00-contrato-api.md) (contrato de API v1) y
> [`db/schema.sql`](../db/schema.sql) (esquema PostgreSQL `soclite`).
> Todos los endpoints, nombres de tabla, columnas y enumeraciones citados aquí son
> exactamente los de esos dos documentos.
>
> **Artefactos:** [`n8n/README.md`](../n8n/README.md) (guía de importación, credenciales y
> pruebas de humo) y los cinco archivos `n8n/soc_lite_*_workflow.json`.

---

## Índice

1. [Visión general y principios de diseño](#1-visión-general-y-principios-de-diseño)
2. [Mapa de workflows y contrato de datos](#2-mapa-de-workflows-y-contrato-de-datos)
3. [WF-01 · Diagrama de conexiones](#3-wf-01--diagrama-de-conexiones)
4. [WF-01 · Descripción paso a paso y nodos](#4-wf-01--descripción-paso-a-paso-y-nodos)
5. [WF-01 · Payloads de entrada y de cada etapa](#5-wf-01--payloads-de-entrada-y-de-cada-etapa)
6. [WF-01 · Política de reintentos y errores](#6-wf-01--política-de-reintentos-y-errores)
7. [Idempotencia y deduplicación](#7-idempotencia-y-deduplicación)
8. [WF-02 · Deduplicación y supresión de ruido](#8-wf-02--deduplicación-y-supresión-de-ruido)
9. [WF-03 · Escalado de SLA](#9-wf-03--escalado-de-sla)
10. [WF-04 · Agregación de métricas diarias](#10-wf-04--agregación-de-métricas-diarias)
11. [WF-05 · Generación de reportes](#11-wf-05--generación-de-reportes)
12. [Trazabilidad, auditoría y cumplimiento](#12-trazabilidad-auditoría-y-cumplimiento)
13. [Supuestos y decisiones de diseño](#13-supuestos-y-decisiones-de-diseño)

---

## 1. Visión general y principios de diseño

El SOC-Lite recibe eventos de **Wazuh** (HIDS/HIPS) y **OPNsense/Suricata** (IDS de
perímetro). El volumen bruto del SIEM es alto y mayoritariamente ruido; el objetivo de la
automatización es **triar antes de que intervenga un analista**, reducir el ruido y dejar
evidencia auditable de cada decisión.

```
                    ┌──────────────────────────────────────────────────────┐
   Wazuh /          │  n8n · WF-01 Triage automático                       │
   OPNsense ──POST─▶│  Webhook → Auth/Fingerprint → IF → INSERT pending    │
   /webhook/        │      → LLM(8001) → risk_score → Switch               │
   wazuh-alert      │      → triage_results + alerts → Slack → Ticket      │
                    │      → incidents (si critical) → audit_log           │
                    └───────┬───────────────────────┬──────────────────────┘
                            │                       │
              ┌─────────────▼──────────┐  ┌─────────▼───────────────────┐
              │ WF-02 Dedup (5 min)    │  │ WF-03 SLA (5 min)           │
              │ dedup_count/suppress   │  │ pending → escalated + aviso │
              └────────────────────────┘  └─────────────────────────────┘
              ┌────────────────────────┐  ┌─────────────────────────────┐
              │ WF-04 Métricas (00:30) │  │ WF-05 Reporte (lun 07:00)   │
              │ alert_metrics_daily    │  │ GET /reports/operational    │
              │ + ANALYZE + KPIs       │  │ → S3 → Slack/email          │
              └────────────────────────┘  └─────────────────────────────┘
```

### Principios aplicados

| Principio | Implementación |
|---|---|
| **Idempotencia primero** | `alert_fingerprint` = `sha256(source_type\|rule_id\|source_ip\|bucket 5 min)` con restricción `UNIQUE`; el `INSERT … ON CONFLICT` convierte un reintento o un duplicado en un incremento de `dedup_count`. |
| **Nada se pierde** | Toda decisión (triaje, deduplicación, escalado, reporte) deja fila en `soclite.audit_log` o `soclite.notifications`. |
| **Fallar de forma segura** | Validación de esquema del LLM con *fallback* a `inconclusive` + severidad derivada de `risk_score`; `retryOnFail` en todas las llamadas HTTP; `continueOnFail` solo en tareas accesorias. |
| **Sin secretos en el JSON** | Credenciales vía credenciales n8n y variables de entorno del contenedor (`$env.*`). |
| **Menor privilegio** | El usuario de base de datos de n8n **no** tiene `DELETE`/`UPDATE` sobre `audit_log` (la bitácora es inmutable por regla de negocio, ISO 27001 A.8.15). |
| **Ahorro de tokens** | El filtro `IF` descarta `rule_level < 7` y duplicados **antes** de llamar al LLM. |
| **Determinismo en el riesgo** | El `risk_score` se normaliza a un entero 0–100 con una fórmula explícita (no se confía ciegamente en el LLM). |

---

## 2. Mapa de workflows y contrato de datos

### 2.1 Inventario

| # | Workflow (archivo) | Disparador | Programación | Nodos | Escribe en |
|---|---|---|---|---|---|
| **01** | `soc_lite_triage_workflow.json` | Webhook `POST /webhook/wazuh-alert` + Error Trigger | por evento | 27 (10 operativos + 2 infraestructura + 4 notas + 11 de apoyo) | `alerts`, `triage_results`, `incidents`, `incident_alerts`, `audit_log` |
| **02** | `soc_lite_dedup_suppression_workflow.json` | Schedule Trigger | cada 5 min (`*/5 * * * *`) | 11 | `alerts` (dedup/supresión), `notifications` |
| **03** | `soc_lite_sla_escalation_workflow.json` | Schedule Trigger | cada 5 min (`*/5 * * * *`) | 11 | `alerts` (estado), `notifications`, `audit_log` |
| **04** | `soc_lite_metrics_aggregation_workflow.json` | Schedule Trigger | diario 00:30 (`30 0 * * *`) | 10 | `alert_metrics_daily`, `notifications`, `audit_log` |
| **05** | `soc_lite_report_generation_workflow.json` | Schedule Trigger | lunes 07:00 (`0 7 * * 1`) | 13 | `generated_reports`, `audit_log`, almacenamiento S3/NAS |

### 2.2 Tablas y vistas utilizadas (según `db/schema.sql`)

| Objeto | Uso en los workflows |
|---|---|
| `soclite.alerts` | Núcleo. Inserción de la alerta `pending`, actualización de `status`/`verdict`/`risk_score`/`triaged_at`, `dedup_count`, `is_suppressed`, `asset_id`. |
| `soclite.assets` | Correlación por `hostname` para obtener `criticality` (contexto del triaje). |
| `soclite.enrichment_data` | Consumida por el microservicio LangChain (indicadores VT/AbuseIPDB/GeoIP); n8n la referencia en el `ANALYZE` nocturno. |
| `soclite.triage_results` | Almacén de la salida del LLM. Índice parcial `uq_triage_current (alert_id) WHERE is_current`. |
| `soclite.incidents` + `soclite.incident_alerts` | Creación del incidente cuando el veredicto es `critical` y vinculación con la alerta. |
| `soclite.audit_log` | Bitácora inmutable con encadenado de hashes (`trg_audit_chain`). |
| `soclite.notifications` | Traza de notificaciones (Slack/escalados/…); canal `internal` para decisiones de deduplicación. |
| `soclite.alert_metrics_daily` | Agregado diario por `(metric_date, source_type, severity)`. |
| `soclite.generated_reports` | Inventario de artefactos de reporte con `checksum_sha256`. |
| `soclite.kpi_targets` | Objetivos de MTTT, tasa de FP, automatización y `noise_reduction`. |
| `soclite.users` | Solo lecturas puntuales (`system/n8n` no es usuario humano: `user_id = NULL`). |

### 2.3 Enumeraciones utilizadas

```
severity_level : info | low | medium | high | critical        (severity SIEM y del veredicto)
alert_status   : pending | enriching | triaged | escalated | closed | false_positive
triage_verdict : true_positive | false_positive | benign | suspicious | inconclusive
incident_status: open | in_progress | contained | resolved | closed
priority       : p1 | p2 | p3 | p4
source_type    : wazuh | opnsense | suricata | zeek | manual | api
audit_action   : LOGIN | LOGOUT | LOGIN_FAILED | CREATE | READ | UPDATE | DELETE | EXPORT
                 | TRIAGE_RUN | TRIAGE_FEEDBACK | ROLE_ASSIGN | CONFIG_CHANGE
audit_result   : success | failure | denied
report_format  : pdf | docx | xlsx | csv
```

**Fórmula del `alert_fingerprint`** (idéntica en el nodo Code `1b` y en el `INSERT … ON
CONFLICT` del nodo `3`):

```
fingerprint = sha256( source_type | rule_id | source_ip | floor(occurred_at / 5 min) )
```

`source_ip` toma el valor `na` y `rule_id` el valor `unknown` cuando el evento no los
trae, de modo que la huella siempre se pueda calcular.

### 2.4 Endpoints consumidos

| Endpoint | Workflow | Contrato |
|---|---|---|
| `POST http://langchain:8001/triage` | 01 | §4 — contrato interno backend ↔ microservicio LLM |
| `POST /api/v1/auth/login` (`form-urlencoded`) | 05 | §1 — OAuth2 password, devuelve `access_token` |
| `GET /api/v1/reports/operational?format=pdf&from&to` | 05 | §7 — reporte operativo (permiso `reports:export`) |
| `GET /api/v1/reports/inventory` | 05 | §7 — historial de reportes |
| `POST https://<osticket>/api/http.php/tickets.json` o `POST <redmine>/issues.json` | 01 | integración externa (no forma parte del contrato v1) |

> El workflow **no** llama a `POST /api/v1/alerts/ingest` porque escribe directamente en
> `soclite.alerts`. Si se prefiere centralizar la ingesta en el backend, sustituir el nodo
> `3 · INSERT alerta (PostgreSQL)` por un `HTTP Request` a
> `POST {{$env.BACKEND_BASE_URL}}/alerts/ingest` con el header `Idempotency-Key:
> {{$json.alert_fingerprint}}` (contrato §3) y conservar el nodo `3a` para el contexto.

---

## 3. WF-01 · Diagrama de conexiones

**Nombre:** SOC-Lite · 01 · Triage automático de alertas (Wazuh/OPNsense → LLM → Ticket → Bitácora)

```
C · Set de entorno y variables globales
        │
        ▼
1 · Webhook Wazuh/OPNsense ──(POST /webhook/wazuh-alert, JSON)
        │
        ▼
1b · Validar y normalizar (Code)            ← X-Ingest-Key + fingerprint sha256
        │
        ▼
2 · IF filtro duplicados y severidad ──true──▶ 3 · INSERT alerta (PostgreSQL)   [pending]
        │                                              │ RETURNING id
        │                                              ▼
        │                                    3a · UPDATE contexto activo (PostgreSQL)
        │                                              │ asset_criticality
        │                                              ▼
        │                                    4 · HTTP POST /triage (LangChain)
        │                                       retryOnFail·maxTries=3·120 s
        │                                              │ {statusCode, body}
        │                                              ▼
        │                                    5 · Post-triaje: validación y risk_score (Code)
        │                                              │
        │                                              ▼
        │                                    6 · Switch por severidad del veredicto
        │                                       ├─0 alta (critical/high) ─┐
        │                                       ├─1 media (medium) ───────┼──────────┐
        │                                       ├─2 baja (low/info/FP) ───┼──────────┤
        │                                       └─3 fallback ─────────────┘          │
        │                                              │                             │
        │                                              ▼                             │
        │                                    7 · INSERT triaje + UPDATE alerta ◀──────┘ (solo 0 y 3)
        │                                              │
        │                                              ▼
        │                                    7a · SELECT estado de la alerta
        │                                              │
        │                                              ▼
        │                                    8 · Slack alerta alta/crítica
        │                                              │
        │                                              ▼
        │                                    8b · Variante Telegram (comentada)  [No-Op]
        │                                              │
        │                                              ▼
        │                                    9a · Preparar ticket (Code)
        │                                              │
        │                                              ▼
        │                                    9b · HTTP crear ticket (osTicket/Redmine)
        │                                              │
        │                                              ▼
        │                                    9d · Normalizar ticket (Code)  → external_ticket_id
        │                                              │
        │                                              ▼
        │                                    9c · Incidente y ticket (PostgreSQL)  [solo critical]
        │                                              │
        ▼                                              ▼
2b · NoOp descarte ◀──false                   10 · Bitácora de auditoría (PostgreSQL)
                                                       │  ◀── (también salidas 1 y 2 del Switch)
                                                       ▼
                                              6a · Responder 202 Accepted (Code)
                                                       │
                                                       ▼
                                              6b · Respond to Webhook 202

E · Error Trigger global ──▶ E1 · Bitácora de fallo (PostgreSQL)   (audit_log, result='failure')
```

### Conexiones por nodo (formato `connections` de n8n)

| Nodo origen | Salida | Destino(s) |
|---|---|---|
| `C · Set de entorno` | main[0] | `1 · Webhook Wazuh/OPNsense` |
| `1 · Webhook` | main[0] | `1b · Validar y normalizar` |
| `1b · Validar y normalizar` | main[0] | `2 · IF filtro` |
| `2 · IF filtro` | main[0] (true) | `3 · INSERT alerta` |
| `2 · IF filtro` | main[1] (false) | `2b · NoOp descarte` |
| `3 · INSERT alerta` | main[0] | `3a · UPDATE contexto activo` |
| `3a · UPDATE contexto activo` | main[0] | `4 · HTTP POST /triage` |
| `4 · HTTP POST /triage` | main[0] | `5 · Post-triaje` |
| `5 · Post-triaje` | main[0] | `6 · Switch` |
| `6 · Switch` | main[0] `alta` | `7 · INSERT triaje + UPDATE alerta` |
| `6 · Switch` | main[1] `media` | `10 · Bitácora de auditoría` |
| `6 · Switch` | main[2] `baja` | `10 · Bitácora de auditoría` |
| `6 · Switch` | main[3] `fallback` | `7 · INSERT triaje + UPDATE alerta` |
| `7 · INSERT triaje + UPDATE` | main[0] | `7a · SELECT estado de la alerta` |
| `7a · SELECT estado` | main[0] | `8 · Slack alerta alta/crítica` |
| `8 · Slack` | main[0] | `8b · Variante Telegram (comentada)` |
| `8b · Variante Telegram` | main[0] | `9a · Preparar ticket` |
| `9a · Preparar ticket` | main[0] | `9b · HTTP crear ticket` |
| `9b · HTTP crear ticket` | main[0] | `9d · Normalizar ticket` |
| `9d · Normalizar ticket` | main[0] | `9c · Incidente y ticket` |
| `9c · Incidente y ticket` | main[0] | `10 · Bitácora de auditoría` |
| `10 · Bitácora de auditoría` | main[0] | `6a · Responder 202 Accepted` |
| `6a · Responder 202` | main[0] | `6b · Respond to Webhook 202` |
| `E · Error Trigger global` | main[0] | `E1 · Bitácora de fallo` |

> **Nota sobre los 10 nodos operativos.** El enunciado fija «exactamente 10 nodos» para el
> flujo principal (1 Webhook → 2 IF → 3 PostgreSQL → 4 HTTP LangChain → 5 Code
> post-triaje → 6 Switch → 7 PostgreSQL → 8 Slack → 9 Ticket/Incidente → 10 Bitácora) y
> pide **además** un `Error Trigger` global y un `Set` de variables de entorno. En el
> archivo se materializan los 12 nodos (10 operativos + 2 de infraestructura) más 11 nodos
> de apoyo (validación de la clave, contexto de activo, lectura del estado, respuesta HTTP,
> normalización del ticket, No-Op de descarte y 4 notas). Si se desea el archivo con
> exactamente 10 nodos, basta con eliminar `C · Set de entorno y variables globales`
> (sustituyendo sus valores por `$env.*` en cada expresión) y el bloque
> `E`/`E1` de tratamiento de errores.

---

## 4. WF-01 · Descripción paso a paso y nodos

### Paso a paso

1. **Recepción.** Wazuh/OPNsense hace `POST` a `/webhook/wazuh-alert` con el evento JSON.
   n8n normaliza las cabeceras a minúsculas y expone el cuerpo en `$json.body`.
2. **Autenticación y normalización.** El nodo `1b` compara el header `X-Ingest-Key` con
   `$env.SOC_INGEST_KEY` en **tiempo constante**; si no coincide, lanza un error que deja
   rastro en la bitácora. Después normaliza el payload (Wazuh o OPNsense) al esquema de
   `soclite.alerts` y calcula `alert_fingerprint`.
3. **Filtro de entrada.** El `IF` deja pasar solo eventos con `rule_level >= 7` que no
   estén marcados como duplicados ni suprimidos. El resto muere en `2b · NoOp descarte`
   (sin consumir tokens del LLM).
4. **Persistencia.** El `INSERT` crea la alerta en estado `pending`. Si el `fingerprint` ya
   existe (mismo `source_type`+`rule_id`+`source_ip` en el mismo bucket de 5 min) solo
   incrementa `dedup_count` y devuelve `was_duplicate = true`.
5. **Contexto.** `3a` correlaciona el `agent_name` con `soclite.assets` para obtener
   `asset_criticality`, contexto obligatorio del contrato del LLM.
6. **Triaje.** `POST http://langchain:8001/triage` con el contrato exacto del §4 del
   documento de API. 3 intentos, espera de 2 s (backoff gestionado por n8n), timeout 120 s.
7. **Post-proceso.** El nodo `Code` valida `verdict`, `severity`, `confidence` y
   `risk_score`, normaliza el riesgo 0–100 y prepara el registro de `triage_results`.
8. **Enrutamiento.** El `Switch` traduce la severidad del veredicto a prioridad operativa:
   `alta` (critical/high) y `fallback` siguen la cadena; `media` y `baja` van directas a la
   bitácora.
9. **Persistencia del triaje.** `7 · INSERT triaje + UPDATE alerta` demota el triaje
   anterior (`is_current=false`), inserta el vigente e actualiza `alerts`
   (`status`, `verdict`, `risk_score`, `triaged_at`).
10. **Notificación.** `8 · Slack` avisa solo a severidad alta/crítica con severidad,
    activo, IP, resumen del LLM y enlace al dashboard (variante Telegram documentada en `8b`).
11. **Ticket e incidente.** `9b` crea el ticket en osTicket/Redmine; `9d` extrae
    `external_ticket_id`; `9c` lo persiste y **solo si la severidad es `critical`** crea el
    incidente `INC-AAAA-NNNNN` y lo vincula en `incident_alerts`.
12. **Bitácora.** `10` inserta el evento `TRIAGE_RUN` en `audit_log`
    (`username = 'system/n8n'`, `user_id = NULL`) y responde `202 Accepted` con el resumen.
13. **Errores.** Cualquier fallo dispara el Error Trigger global `E` → `E1`, que registra
    `result='failure'` en `audit_log`.

### Tabla de nodos

| # | Nodo | Función | Entrada → Salida | Tipo n8n | Parámetros clave |
|---|---|---|---|---|---|
| E | `E · Error Trigger global` | Captura fallos de cualquier workflow del SOC que lo tenga registrado como *Error Workflow* | `{}` de error del workflow → `{workflow, execution}` | `n8n-nodes-base.errorTrigger@1` | `parameters: {}`. Se registra en **Settings → Error Workflow** de los workflows 02–05 (n8n lo referencia por nombre, no por JSON). |
| C | `C · Set de entorno y variables globales` | Declara las variables del workflow (URLs, canal, umbrales) | `{}` → objeto de configuración | `n8n-nodes-base.set@3.4` | `values.string`: `BACKEND_BASE_URL`, `LANGCHAIN_URL`, `DASHBOARD_BASE_URL`, `SOC_SCHEMA`, `SLACK_CHANNEL`, `SKIP_DEDUP_LOOKUP`, `OSTICKET_API_URL`, `REDMINE_TICKET_URL`, `N8N_ORIGIN_IP`, `N8N_USER_AGENT`, `TRIAGE_MODEL`, `TRIAGE_PROMPT_VERSION`, `TOKEN_COST_*_USD_PER_1K`, `INGEST_KEY_PREFIX`. |
| 1 | `1 · Webhook Wazuh/OPNsense` | Puerta de entrada HTTP del SIEM | `POST /webhook/wazuh-alert` (`body`, `headers`) → ítem con el payload crudo | `n8n-nodes-base.webhook@2` | `httpMethod=POST`, `path=wazuh-alert`, `responseMode=responseNode`, `options.rawBody=false`, `webhookId=soc-lite-wazuh-alert`. La autenticación se delega al nodo 1b. |
| 1b | `1b · Validar y normalizar (Code)` | Valida `X-Ingest-Key`; normaliza Wazuh/OPNsense; calcula `alert_fingerprint`; pre-escapa literales SQL | `{body, headers}` → `{alert_fingerprint, bucket_5min, source_type, rule_id, rule_level, severity, source_ip, dest_ip, agent_name, sql:{…}}` | `n8n-nodes-base.code@2` | `crypto.timingSafeEqual` para la clave; `bucket = floor(occurred_at/300000)*300000`; `sourceType` ∈ {wazuh, opnsense}; helpers `esc/q/arr/jst`. |
| 2 | `2 · IF filtro duplicados y severidad` | Descarta ruido y duplicados antes del LLM | ítem normalizado → rama **true** (continúa) / **false** (descarte) | `n8n-nodes-base.if@2` | 3 condiciones en `and`: `rule_level >= 7`; `dedup.exists != true`; `is_suppressed != true`. `typeValidation=loose`. |
| 2b | `2b · NoOp descarte (ruido/duplicado)` | Fin explícito de la rama descartada (visible en el editor) | rama false del IF → sin salida | `n8n-nodes-base.noOp@1` | — |
| 3 | `3 · INSERT alerta (PostgreSQL)` | Inserta la alerta en `pending` de forma idempotente | `sql.*` normalizado → `{id, alert_fingerprint, status, severity, dedup_count, occurred_at, was_duplicate, ingest_result}` | `n8n-nodes-base.postgres@2.4` | `operation=executeQuery`; `INSERT … ON CONFLICT (alert_fingerprint) DO UPDATE SET dedup_count = alerts.dedup_count + 1` ; `RETURNING … (xmax <> 0) AS was_duplicate`. Credencial PostgreSQL. |
| 3a | `3a · UPDATE contexto activo (PostgreSQL)` | Obtiene `asset_criticality` del inventario para el contexto del LLM | `{id}` → `{alert_id, asset_id, asset_criticality}` | `n8n-nodes-base.postgres@2.4` | `UPDATE alerts a SET asset_id = ast.id FROM assets ast WHERE ast.hostname = a.agent_name`; `continueOnFail=true`. |
| 4 | `4 · HTTP POST /triage (LangChain)` | Ejecuta el agente de triaje | alerta + contexto → `{statusCode, headers, body}` | `n8n-nodes-base.httpRequest@4.2` | `method=POST`, `url={{$env.LANGCHAIN_URL}}`, cabeceras `Content-Type`, `X-Internal-Token`, `X-Trace-Id`; `jsonBody` con `alert_id`, `trace_id`, `alert{…}`, `context{recent_alerts_same_source, asset_criticality, known_false_positives, policy.allow_external_llm:false}`; `retryOnFail=true`, `maxTries=3`, `waitBetweenTries=2000`, `options.timeout=120000`, `fullResponse=true`. |
| 5 | `5 · Post-triaje: validación y risk_score (Code)` | Valida el esquema del LLM, normaliza `risk_score` y prepara el registro de triaje | `{statusCode, body}` → `{ok, http_status, trace_id, alert_id, alert{severity,verdict,risk_score,escalate,low_tier}, slack{emoji,channel,dashboard_url}, validations{errors,warnings}, triage{…}, post{…}, sql{…}}` | `n8n-nodes-base.code@2` | Enums de `verdict`/`severity`; `risk = clamp(round(risk_score))`; si falta, `90*sev + ajuste(verdict) + contexto`; `escalate = severity ∈ {high, critical}`; `low_tier = severity ∈ {low, info} ∨ verdict = false_positive`; `sql.*` pre-escapado. |
| 6 | `6 · Switch por severidad del veredicto` | Enruta por severidad del veredicto | ítem post-triaje → 4 salidas | `n8n-nodes-base.switch@3` | `dataType=string`; reglas: `critical` y `high` → `alta (critical/high)`; `medium` → `media (medium)`; `low` y `false_positive` → `baja (low/info/falso positivo)`; `fallbackOutput=extra` → `fallback (revisión manual)`. Salidas 0 y 3 se fusionan en el nodo 7. |
| 7 | `7 · INSERT triaje + UPDATE alerta (PostgreSQL)` | Persiste el triaje vigente y actualiza la alerta | `sql.*` → `{alert_id, status, severity, verdict, risk_score, triaged_at, sla_due_at, triage_id, confidence, demoted}` | `n8n-nodes-base.postgres@2.4` | Una sola consulta con CTE: `demote` (`is_current=false`), `ins` (INSERT en `triage_results` con `is_current=true`), `upd` (`UPDATE alerts SET status/verdict/severity/risk_score/mitre_technique/triaged_at`). Respeta `uq_triage_current`. |
| 7a | `7a · SELECT estado de la alerta (PostgreSQL)` | Relee el estado consolidado (activo, triaje vigente, incidente) para alimentar la notificación y el ticket | `{alert_id}` → fila con `severity, risk_score, verdict, sla_due_at, asset_criticality, incident_id, sla_breached` | `n8n-nodes-base.postgres@2.4` | `LEFT JOIN triage_results … is_current`, `LEFT JOIN assets`, `LEFT JOIN LATERAL (incidents ⋈ incident_alerts)`. |
| 8 | `8 · Slack alerta alta/crítica` | Notifica al canal solo severidad alta/crítica | fila de `7a` → mensaje enviado | `n8n-nodes-base.slack@2.2` | `select=channel`, `channelId={{$env.SLACK_CHANNEL}}`, `text` con emoji por veredicto y marca de SLA vencido, `blocksUi` con severidad/riesgo/confianza, activo, IP, regla, veredicto, modelo, resumen del LLM, contador de deduplicación y enlace al dashboard. |
| 8b | `8b · Variante Telegram (comentada)` | Documenta la variante Telegram y actúa como No-Op | pasa el ítem | `n8n-nodes-base.code@2` | Plantilla de nodo `n8n-nodes-base.telegram@1.2` comentada (`chatId`, `text`, `parse_mode=Markdown`). |
| 9a | `9a · Preparar ticket (Code)` | Construye el cuerpo del ticket | fila de `7a` → `{alert_id, severity, ticket_target, ticket{…}}` | `n8n-nodes-base.code@2` | Payload osTicket (`alert, source, name, email, subject, message, priority, topicId, ip`) y alternativo Redmine (`issue{project_id, subject, description, priority_id}`) + bloque `soc_lite`. |
| 9b | `9b · HTTP crear ticket (osTicket/Redmine)` | Crea el ticket externo | `ticket{…}` → `{statusCode, body}` | `n8n-nodes-base.httpRequest@4.2` | `POST {{$env.OSTICKET_API_URL \|\| $env.REDMINE_TICKET_URL}}`; cabeceras `Content-Type`, `X-API-Key={{$env.OSTICKET_API_KEY}}`; `retryOnFail=true`, `maxTries=3`, `waitBetweenTries=3000`, `timeout=30000`. |
| 9d | `9d · Normalizar ticket (Code)` | Extrae `external_ticket_id`/`external_ticket_url` | respuesta del ticket → `{external_ticket_id, external_ticket_url, ticket_http_status}` | `n8n-nodes-base.code@2` | Soporta osTicket (`ticket_id`), Redmine (`issue.id`), `number` y respuesta en texto; *fallback* `MANUAL-<alert_id>`. |
| 9c | `9c · Incidente y ticket (PostgreSQL)` | Persiste el ticket y crea/actualiza el incidente | `{alert_id, external_ticket_id, external_ticket_url}` → `{incident_id, incident_code, incident_action}` (0 filas si no es `critical`) | `n8n-nodes-base.postgres@2.4` | CTE `seq` (código `INC-YYYY-NNNNN`), `app` (incidente existente), `new_inc` (`INSERT … WHERE severity='critical' AND NOT EXISTS(app)`), `linked` (`incident_alerts` con `ON CONFLICT DO NOTHING`), `updated` (actualiza el ticket del incidente existente). `continueOnFail=true`. |
| 10 | `10 · Bitácora de auditoría (PostgreSQL)` | Registra el triaje en la bitácora inmutable | `sql.*` de `5` → `{audit_id, occurred_at, hash_self}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO audit_log (… module='triage', action='TRIAGE_RUN', username='system/n8n', user_id=NULL, entity='alert', entity_id, result='success', detail, ip_address, http_method='POST', http_path='http://langchain:8001/triage', http_status, duration_ms=latency_ms, trace_id, severity)`. El trigger `trg_audit_chain` calcula `hash_prev`/`hash_self`. |
| 6a | `6a · Responder 202 Accepted (Code)` | Compone la respuesta HTTP al SIEM | salida de `10` → `{accepted, httpStatus, alert_id, severity, verdict, risk_score, status, escalate, trace_id, dashboard_url}` | `n8n-nodes-base.code@2` | Lee `$('3 · INSERT alerta…')` para `alert_fingerprint`/`was_duplicate`/`dedup_count`. |
| 6b | `6b · Respond to Webhook 202` | Cierra la petición HTTP | JSON → respuesta HTTP | `n8n-nodes-base.respondToWebhook@1.1` | `respondWith=json`, `responseBody={{JSON.stringify($json)}}`, `options.responseCode=202`. |
| E1 | `E1 · Bitácora de fallo (PostgreSQL)` | Registra el fallo del workflow | `{workflow, execution}` → `{audit_id, hash_self}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO audit_log (… module='triage', action='TRIAGE_RUN', entity='workflow', result='failure', detail='Fallo del workflow «…» en el nodo «…»', severity='critical')`. |

---

## 5. WF-01 · Payloads de entrada y de cada etapa

### 5.1 Entrada — evento Wazuh real (formato `wazuh-alerts-4.x` en JSON)

```json
{
  "timestamp": "2025-01-31T14:22:05.123+0000",
  "rule": {
    "level": 10,
    "description": "Attempt to login using a non-existent user",
    "id": "5710",
    "firedtimes": 1,
    "mail": false,
    "groups": ["authentication_failed", "sshd", "syslog"],
    "mitre": { "id": ["T1110.001"], "tactic": ["Credential Access"], "technique": ["Brute Force"] }
  },
  "agent": { "id": "003", "name": "WKS-CONTAB01", "ip": "10.0.4.21" },
  "manager": { "name": "wazuh-manager" },
  "id": "1706707325.123456",
  "full_log": "Jan 31 14:22:05 WKS-CONTAB01 sshd[28441]: Failed password for invalid user admin from 203.0.113.44 port 51422 ssh2",
  "decoder": { "name": "sshd" },
  "data": { "srcip": "203.0.113.44", "srcport": "51422", "dstip": "10.0.4.21", "dstport": "22", "protocol": "tcp" },
  "location": "/var/log/auth.log"
}
```

### 5.2 Entrada — evento OPNsense/Suricata (IDS)

```json
{
  "timestamp": "2025-01-31T11:40:12Z",
  "source_type": "opnsense",
  "event_type": "alert",
  "interface": { "name": "wan", "alias": "WAN", "src_ip": "192.0.2.55", "dest_ip": "10.0.9.31", "proto": "tcp", "src_port": 443, "dest_port": 51234, "sid": "2019141", "alert": "ET MALWARE Possible Cobalt Strike Beacon" },
  "hostname": "PLC-PLANTA1",
  "severity_raw": 12,
  "full_log": "Suricata: ET MALWARE Cobalt Strike Malleable C2 M1 (sid 2019141)"
}
```

### 5.3 Salida del nodo `1b` (normalización + fingerprint)

```json
{
  "alert_fingerprint": "9f1c2a5b7d3e4f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
  "bucket_5min": "2025-01-31T14:20:00.000Z",
  "source_type": "wazuh",
  "rule_id": "5710",
  "rule_level": 10,
  "rule_description": "Attempt to login using a non-existent user",
  "severity": "high",
  "severity_raw": 10,
  "status": "pending",
  "is_suppressed": false,
  "dedup_count": 1,
  "source_ip": "203.0.113.44",
  "dest_ip": "10.0.4.21",
  "agent_name": "WKS-CONTAB01",
  "mitre_technique": "T1110.001",
  "full_log": "Jan 31 14:22:05 WKS-CONTAB01 sshd[28441]: Failed password for invalid user admin from 203.0.113.44 port 51422 ssh2",
  "occurred_at": "2025-01-31T14:22:05.123Z",
  "raw_payload": { "…": "evento crudo íntegro" },
  "ingest": { "received_at": "2025-01-31T14:22:31.004Z", "ingest_key_id": "X-Ingest-Key", "origin_ip": "10.10.2.90", "headers_user_agent": "Wazuh/4.9.0", "auth_ok": true },
  "sql": {
    "alert_fingerprint": "'9f1c…f708'",
    "source_type": "'wazuh'",
    "rule_id": "'5710'",
    "rule_level": 10,
    "rule_description": "'Attempt to login using a non-existent user'",
    "rule_groups": "'{authentication_failed,sshd,syslog}'",
    "severity": "'high'",
    "source_ip": "'203.0.113.44'",
    "dest_ip": "'10.0.4.21'",
    "occurred_at": "'2025-01-31 14:22:05+00'"
  }
}
```

> Los campos `sql.*` son **literales SQL ya escapados** (las comillas van incluidas, `NULL`
> si el valor es vacío) y son los que consumen los nodos PostgreSQL. Esto evita
> interpolar valores crudos del SIEM en el SQL.

### 5.4 Salida del nodo `3` (INSERT alerta)

```json
{
  "id": 1043,
  "alert_fingerprint": "9f1c2a5b7d3e4f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
  "status": "pending",
  "severity": "high",
  "dedup_count": 1,
  "occurred_at": "2025-01-31T14:22:05.123Z",
  "was_duplicate": false,
  "ingest_result": "inserted"
}
```

Reenvío del mismo evento dentro del bucket de 5 minutos:

```json
{ "id": 1043, "status": "pending", "severity": "high", "dedup_count": 2, "was_duplicate": true, "ingest_result": "dedup" }
```

### 5.5 Salida del nodo `3a` (contexto de activo)

```json
{ "alert_id": 1043, "asset_id": 5, "asset_criticality": "high" }
```

Si el hostname no está en `soclite.assets`, el nodo no devuelve filas
(`continueOnFail: true`) y el nodo `4` envía `asset_criticality: "medium"`.

### 5.6 Petición del nodo `4` — `POST http://langchain:8001/triage`

```json
{
  "alert_id": 1043,
  "trace_id": "9f1c2a5b7d3e4f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
  "alert": {
    "rule_id": "5710",
    "rule_description": "Attempt to login using a non-existent user",
    "severity_raw": 10,
    "source_ip": "203.0.113.44",
    "dest_ip": "10.0.4.21",
    "agent_name": "WKS-CONTAB01",
    "full_log": "Jan 31 14:22:05 WKS-CONTAB01 sshd[28441]: Failed password for invalid user admin from 203.0.113.44 port 51422 ssh2",
    "occurred_at": "2025-01-31T14:22:05.123Z"
  },
  "context": {
    "recent_alerts_same_source": 0,
    "asset_criticality": "high",
    "known_false_positives": 0,
    "policy": { "allow_external_llm": false }
  }
}
```

> El contrato usa `trace_id` como string corto (`"b1f0…"`); aquí se envía el
> `alert_fingerprint` (sha256 hex), que es único por alerta y bucket. Es un **supuesto**
> documentado en §13.

### 5.7 Respuesta del LLM (cuerpo de `POST /triage`)

```json
{
  "trace_id": "b1f0e4a2-7c31-4d5e-9a12-3f6c8d2e1b04",
  "verdict": "true_positive",
  "severity": "high",
  "risk_score": 82,
  "confidence": 0.87,
  "summary": "Fuerza bruta SSH contra WKS-CONTAB01 desde 203.0.113.44 (AbuseIPDB 94/100, 312 reportes). 187 intentos en 4 minutos con usuarios inexistentes; sin autenticación exitosa posterior.",
  "reasoning": [
    "La IP origen 203.0.113.44 acumula 312 reportes de abuso (score 94/100)",
    "187 fallos de autenticación en 240 s → fuerza bruta automatizada (T1110.001)",
    "El activo destino es una estación de Finanzas con criticidad alta",
    "No hay eventos de autenticación exitosa posteriores"
  ],
  "recommended_actions": [
    { "order": 1, "action": "Bloquear IP 203.0.113.44 en FW-EDGE01 durante 24 h", "priority": "p1" },
    { "order": 2, "action": "Forzar cambio de contraseña de cuentas locales", "priority": "p2" }
  ],
  "mitre_techniques": ["T1110.001", "T1078"],
  "indicators": [
    { "type": "ip", "value": "203.0.113.44", "verdict": "malicious", "source": "abuseipdb", "score": 94 }
  ],
  "model": "llama3.1:8b",
  "prompt_version": "triage_v3",
  "tokens_in": 2210,
  "tokens_out": 380,
  "latency_ms": 6400,
  "tools_used": ["abuseipdb_lookup", "geoip_lookup", "wazuh_context"]
}
```

### 5.8 Salida del nodo `5` (validación y `risk_score`)

```json
{
  "ok": true,
  "http_status": 200,
  "trace_id": "b1f0e4a2-7c31-4d5e-9a12-3f6c8d2e1b04",
  "alert_id": 1043,
  "alert": { "id": 1043, "fingerprint": "9f1c…f708", "severity": "high", "verdict": "true_positive", "risk_score": 93, "escalate": true, "low_tier": false },
  "slack": { "emoji": ":warning:", "channel": "#soc-alertas", "dashboard_url": "http://localhost:3000/alerts/1043" },
  "validations": { "errors": [], "warnings": [] },
  "triage": { "verdict": "true_positive", "severity": "high", "risk_score": 93, "risk_score_reported": 82, "confidence": 0.87, "summary": "Fuerza bruta SSH…", "model": "llama3.1:8b", "prompt_version": "triage_v3" },
  "post": { "trace_id": "b1f0e4a2-…", "new_status": "escalated", "escalate": true, "low_tier": false, "severity": "high", "verdict": "true_positive", "risk_score": 93, "confidence": 0.87, "passed": true, "…": "…" },
  "sql": { "alert_id": 1043, "verdict": "'true_positive'", "severity": "'high'", "risk_score": 93, "confidence": 0.87, "new_status": "'escalated'", "alert_severity": "'high'", "p1": "'p2'", "trace_id": "'b1f0e4a2-…'", "…": "…" }
}
```

Cálculo del riesgo normalizado:

```
risk_normalizado = clamp( 0, 100, round( base(severidad) + ajuste(veredicto) + contexto ) )
  base     : info 10 · low 30 · medium 55 · high 75 · critical 90
  veredicto: true_positive +10 · suspicious +5 · inconclusive 0 · benign −10 · false_positive −30
  contexto : rule_level ≥ 12 → +5 · algún indicador 'malicious' → +8 · algún 'clean' → −3

Ejemplo (severidad high, true_positive, indicador malicioso):
  75 + 10 + 8 = 93      (el LLM había reportado 82; se conserva en risk_score_reported)
```

### 5.9 Salida del nodo `7` (triaje persistido + alerta actualizada)

```json
{
  "alert_id": 1043,
  "status": "escalated",
  "severity": "high",
  "verdict": "true_positive",
  "risk_score": 93,
  "triaged_at": "2025-01-31T14:23:18.512Z",
  "sla_due_at": "2025-01-31T15:22:05.123Z",
  "triage_id": 512,
  "confidence": 0.87,
  "demoted": 0
}
```

### 5.10 Salida del nodo `7a` (estado consolidado) → entrada de Slack y del ticket

```json
{
  "alert_id": 1043,
  "alert_fingerprint": "9f1c…f708",
  "status": "escalated",
  "severity": "high",
  "risk_score": 93,
  "verdict": "true_positive",
  "triaged_at": "2025-01-31T14:23:18.512Z",
  "sla_due_at": "2025-01-31T15:22:05.123Z",
  "mttt_seconds": 73,
  "occurred_at": "2025-01-31T14:22:05.123Z",
  "source_ip": "203.0.113.44",
  "agent_name": "WKS-CONTAB01",
  "rule_id": "5710",
  "rule_description": "Attempt to login using a non-existent user",
  "mitre_technique": "T1110.001",
  "triage_id": 512,
  "confidence": 0.87,
  "model_name": "llama3.1:8b",
  "summary": "Fuerza bruta SSH contra WKS-CONTAB01…",
  "trace_id": "b1f0e4a2-…",
  "asset_criticality": "high",
  "is_internet_facing": false,
  "business_owner": "Finanzas",
  "incident_id": null,
  "incident_code": null,
  "external_ticket_id": null,
  "triaged": true,
  "sla_breached": false
}
```

### 5.11 Mensaje de Slack (nodo `8`)

```
:warning: ALERTA HIGH · SOC-Lite
:red_circle: *ACCIÓN REQUERIDA* — status «escalated»

*Severidad:* high (SIEM level 10)  |  *Riesgo:* 93/100  |  *Confianza:* 0.87
*Activo:* WKS-CONTAB01  |  *IP origen:* 203.0.113.44  |  *Regla:* 5710
*Veredicto LLM:* true_positive  |  *Modelo:* llama3.1:8b

*Resumen del agente*
> Fuerza bruta SSH contra WKS-CONTAB01 desde 203.0.113.44 (AbuseIPDB 94/100, 312 reportes)…

Alertas vinculadas a la misma fuente en la ventana: *1*  |  Ver alerta #1043 en el dashboard
```

### 5.12 Ticket creado (nodo `9a` → `9b`) y respuesta

Petición (osTicket):

```json
{
  "alert": "Security",
  "source": "SOC-Lite n8n",
  "name": "SOC-Lite Automation",
  "email": "soc-lite@org.local",
  "subject": "[HIGH] SOC-Lite #1043 · Attempt to login using a non-existent user",
  "message": "Alerta SOC-Lite #1043 (9f1c2a5b7d3e4f60…)\n\nSeveridad: high  |  Riesgo: 93/100  |  Confianza: 0.87\nVeredicto del agente (llama3.1:8b): true_positive\nActivo: WKS-CONTAB01   IP origen: 203.0.113.44\n…\nDashboard: http://localhost:3000/alerts/1043",
  "priority": "High",
  "topicId": "seguridad",
  "ip": "203.0.113.44",
  "issue": { "project_id": 1, "subject": "[HIGH] SOC-Lite #1043 · …", "description": "…", "priority_id": 4 },
  "soc_lite": { "alert_id": 1043, "fingerprint": "9f1c…f708", "verdict": "true_positive", "risk_score": 93 }
}
```

Respuesta y normalización (`9d`):

```json
{ "ticket_id": "8412", "status": 201 }
```
```json
{ "alert_id": 1043, "external_ticket_id": "8412", "external_ticket_url": "https://soporte.org.local/scp/tickets.php?id=8412", "ticket_created": true }
```

### 5.13 Incidente creado (`9c`, solo severidad `critical`)

```json
{ "incident_id": 89, "incident_code": "INC-2025-00089", "incident_action": "created" }
```

Fila resultante en `soclite.incidents`:

```json
{
  "incident_code": "INC-2025-00089",
  "title": "[CRITICAL] Possible ransomware behavior detected: mass file encryption en SRV-DC01",
  "status": "open",
  "priority": "p1",
  "severity": "critical",
  "category": "malware",
  "detected_at": "2025-01-31T16:02:00Z",
  "external_ticket_id": "8413",
  "external_ticket_url": "https://soporte.org.local/scp/tickets.php?id=8413"
}
```

En `soclite.incident_alerts` se inserta `(incident_id=89, alert_id=1043, linked_by=<admin>)`.
Si la alerta ya pertenecía a un incidente, `9c` solo actualiza `external_ticket_id` y
`updated_at` (`incident_action: "updated"`).

### 5.14 Bitácora (`10`) y respuesta final (`6a`/`6b`)

`audit_log`:

```json
{
  "occurred_at": "2025-01-31T14:23:19.004-03:00",
  "user_id": null,
  "username": "system/n8n",
  "module": "triage",
  "action": "TRIAGE_RUN",
  "entity": "alert",
  "entity_id": "1043",
  "result": "success",
  "detail": "Triage automatico n8n: verdict=true_positive severity=high risk=93 conf=0.87",
  "ip_address": "203.0.113.44",
  "user_agent": "n8n-workflow/soc-lite-triage",
  "http_method": "POST",
  "http_path": "http://langchain:8001/triage",
  "http_status": 200,
  "duration_ms": 6400,
  "trace_id": "b1f0e4a2-7c31-4d5e-9a12-3f6c8d2e1b04",
  "severity": "warning",
  "hash_prev": "0000…0000",
  "hash_self": "a91f…7c02"
}
```

Respuesta HTTP `202 Accepted` al SIEM:

```json
{
  "accepted": true,
  "httpStatus": 202,
  "alert_id": 1043,
  "alert_fingerprint": "9f1c…f708",
  "was_duplicate": false,
  "dedup_count": 1,
  "severity": "high",
  "verdict": "true_positive",
  "risk_score": 93,
  "confidence": 0.87,
  "status": "escalated",
  "escalate": true,
  "trace_id": "b1f0e4a2-7c31-4d5e-9a12-3f6c8d2e1b04",
  "dashboard_url": "http://localhost:3000/alerts/1043",
  "processed_at": "2025-01-31T14:23:19.110Z"
}
```

---

## 6. WF-01 · Política de reintentos y errores

### 6.1 Reintentos por nodo

| Nodo | `retryOnFail` | `maxTries` | `waitBetweenTries` | `timeout` | Justificación |
|---|---|---|---|---|---|
| `4 · HTTP POST /triage` | ✅ | 3 | 2 000 ms | 120 000 ms | El LLM local puede tardar; el contrato admite 120 s. Con 2 s de espera se evita saturar Ollama. |
| `9b · HTTP crear ticket` | ✅ | 3 | 3 000 ms | 30 000 ms | Sistemas de ticketing con *rate limit*; el `external_ticket_id` es recuperable. |
| `3`, `3a`, `7`, `7a`, `9c`, `10`, `E1` (PostgreSQL) | ❌ | — | — | por defecto | Las consultas son de milisegundos; un fallo suele ser de esquema/permisos y no mejora al reintentar. La ejecución de n8n puede reintentarse manualmente desde la UI. |

> n8n implementa la espera creciente de forma lineal (`waitBetweenTries × intento`), que es
> el comportamiento asimilable al **backoff exponencial** solicitado sin recurrir a un
> bucle explícito. Si se necesita backoff estrictamente exponencial y con *jitter*, se
> puede sustituir el nodo `4` por un sub-workflow con `Wait` + contador, o mover el
> reintento al cliente del backend.

### 6.2 `continueOnFail`

| Nodo | Motivo |
|---|---|
| `3a · UPDATE contexto activo` | Si el activo no está inventariado, el triaje continúa con `asset_criticality = "medium"`. |
| `9c · Incidente y ticket` | Un fallo al crear el incidente no debe impedir el registro en la bitácora ni la respuesta HTTP. |

### 6.3 Tratamiento de errores

1. **Error Trigger global (`E`).** El workflow contiene el nodo `errorTrigger`. Se registra
   como *Error Workflow* de los workflows 02–05 (y de sí mismo) desde **Settings → Error
   Workflow**. n8n identifica los error workflows por **nombre**, por lo que no puede
   referenciarse de forma portable desde el JSON exportado.
2. **`E1 · Bitácora de fallo`.** Inserta en `audit_log` con `result='failure'`,
   `severity='critical'` y un `detail` con `workflow.name`, `execution.lastNodeExecuted` y
   `execution.error.message` (truncado a 1000 caracteres).
3. **Fallos de autenticación.** Una petición con `X-Ingest-Key` inválida lanza error en el
   nodo `1b`; la ejecución falla y `E1` deja constancia del intento (**fail closed**: no se
   persiste alerta ni se llama al LLM).
4. **Fallos del LLM.** Si el nodo `4` agota los 3 intentos, la ejecución falla y queda
   registrada; la alerta permanece en `pending` y el workflow **03 (SLA)** la escalará al
   acercarse el vencimiento del SLA. Es el mecanismo de recuperación previsto.
5. **Respuestas del LLM fuera de esquema.** El nodo `5` **no** lanza error: aplica valores
   por defecto (`verdict='inconclusive'`, `severity` derivada del riesgo, `confidence=0.5`,
   `ok=false` y `validations.warnings[]`) y el `Switch` envía esos casos a la salida
   `fallback`, que crea ticket pero no incidente. Esto garantiza que ninguna alerta quede
   sin triaje registrado.
6. **Errores de notificación/ticket.** Si Slack falla, la ejecución se detiene antes del
   ticket; si el ticketing falla tras 3 intentos, `9d` genera `MANUAL-<alert_id>` y `9c`
   puede seguir (con `continueOnFail`). En ambos casos la traza queda en el historial de
   ejecuciones de n8n y en la bitácora si se alcanzó el nodo `10`.

### 6.4 Detección de anomalías en la automatización

```sql
-- Fallos registrados por el Error Trigger global
SELECT occurred_at, username, entity_id AS workflow, detail
  FROM soclite.audit_log
 WHERE result = 'failure' AND module = 'triage'
 ORDER BY occurred_at DESC LIMIT 20;

-- Alertas que llevan demasiado tiempo sin triar (posible caída del microservicio LLM)
SELECT id, severity, status, occurred_at, sla_due_at,
       EXTRACT(EPOCH FROM (now() - occurred_at))::int AS edad_sec
  FROM soclite.alerts
 WHERE status = 'pending' AND deleted_at IS NULL
 ORDER BY occurred_at ASC LIMIT 20;
```

---

## 7. Idempotencia y deduplicación

El SOC-Lite aplica **tres capas** complementarias de control de duplicados.

### Capa 1 — Huella determinista + `UNIQUE` + `ON CONFLICT` (atómica, WF-01)

```sql
alert_fingerprint = sha256( source_type | rule_id | source_ip | floor(occurred_at / 5 min) )
```

* `alerts.alert_fingerprint` es **`VARCHAR(255) NOT NULL UNIQUE`** (`db/schema.sql:134`).
* El `INSERT` del nodo `3` usa `ON CONFLICT (alert_fingerprint) DO UPDATE SET dedup_count
  = soclite.alerts.dedup_count + 1`. Un reintento de Wazuh, un *timeout* de red o dos
  entregas del mismo evento **no crean alertas nuevas**.
* El `RETURNING … (xmax <> 0) AS was_duplicate` distingue inserción de incremento; el
  campo viaja en la respuesta HTTP (`was_duplicate`, `dedup_count`).
* La idempotencia es **atómica**: no hay ventana de carrera entre «consultar» y «escribir».

**Ventana de 5 minutos:** agrupa ráfagas del mismo ataque. Un escaneo de 400 eventos en
3 minutos desde una IP contra la misma regla produce **una** alerta con
`dedup_count = 400` (acotado por `DEDUP_MAX_COUNT` en WF-02).

### Capa 2 — Ventana deslizante de 30 min (WF-02, cada 5 min)

Reagrupa por `source_type + rule_id + source_ip` sobre los últimos 30 minutos con funciones
de ventana (`count(*) OVER (PARTITION BY …)`, `first_value(…)`) y fija
`dedup_count`/`is_suppressed` en la alerta «guardián» (la más antigua de la ráfaga),
dejando la traza de la decisión en `raw_payload.soc_lite_dedup`.

### Capa 3 — Supresión de falsos positivos conocidos (WF-02)

Una regla se considera ruido conocido si en los últimos 30 días acumula **≥ 20 triajes** y
**≥ 90 %** de ellos son `false_positive`. Esas alertas se marcan `is_suppressed = true` y
el `IF` del WF-01 las descarta antes de invocar al LLM. El umbral es configurable
(`SUPPRESS_FP_RATE`, `DEDUP_MAX_COUNT`) y la consulta usa el índice
`uq_triage_current` a través de `triage_results.is_current`.

### Otras garantías de idempotencia

| Operación | Mecanismo |
|---|---|
| Triaje | CTE `demote` pone `is_current = false` antes del `INSERT`; respeta el índice parcial `uq_triage_current (alert_id) WHERE is_current`. |
| Incidente | CTE `app` detecta el incidente ya vinculado y `new_inc` solo inserta si **no** existe; `incident_code` es único; el vínculo usa `ON CONFLICT (incident_id, alert_id) DO NOTHING`. |
| Deduplicación (WF-02) | Aplica el **mismo** `dedup_count` calculado en la ventana (no incrementa acumulativamente) → ejecuciones repetidas convergen al mismo valor. |
| Escalado de SLA (WF-03) | `UPDATE … WHERE status='pending'` + `RETURNING`: solo las alertas que **transicionan** en esa pasada se notifican. Ejecutar el workflow diez veces notifica una sola vez. |
| Métricas (WF-04) | `INSERT … ON CONFLICT (metric_date, source_type, severity) DO UPDATE` → recalcular el mismo día sobrescribe, nunca duplica. |
| Reportes (WF-05) | `file_path` incluye el rango de fechas; el registro en `generated_reports` es un histórico de intentos (se permiten varias generaciones del mismo periodo). |

### Efecto sobre el KPI de reducción de ruido

```
reduction_rate = 1 − (alertas escaladas / eventos ingeridos)
```

En el ejemplo: 400 eventos brutos → 1 alerta → 1 triaje → 0,25 % de escalado. La diferencia
se contabiliza como `dedup_count` (eventos colapsados) y `is_suppressed` (falsos positivos
conocidos), y alimenta el KPI `noise_reduction` de `soclite.kpi_targets`.

---

## 8. WF-02 · Deduplicación y supresión de ruido

**Disparador:** `Schedule Trigger` cada 5 minutos. **Archivo:**
`n8n/soc_lite_dedup_suppression_workflow.json`.

### Diagrama de conexiones

```
1 · Schedule cada 5 min
        │
        ▼
C · Set parámetros de ventana (DEDUP_WINDOW_MINUTES=30, DEDUP_MAX_COUNT=25, SUPPRESS_FP_RATE=0.9)
        ├──────────────────────────────┐
        ▼                              ▼
2 · SELECT ventana 30 min        3 · SELECT reglas FP conocidas
    (PostgreSQL)                     (PostgreSQL)
        │  main[0]                     │  main[1]
        └────────────┬─────────────────┘
                     ▼
        4 · Merge grupos + reglas FP (combineAll)
                     │
                     ▼
        5 · Calcular dedup y supresión (Code)
                     │
                     ▼
        6 · IF hay grupos ──true──▶ 7 · UPDATE dedup_count (PostgreSQL)
                     │                        │
                     │                        ▼
                     │              8 · Registrar decisión (PostgreSQL)
                     └──false──▶ 9 · NoOp sin cambios
```

### Descripción paso a paso

1. Cada 5 minutos se lanza la ventana deslizante de 30 minutos.
2. **Consulta A** agrupa las alertas recientes por `source_type + rule_id + source_ip`
   (incluye `dest_ip` para el caso IDS, donde la IP atacante es el destino del activo) y
   devuelve solo los grupos con más de un evento, con `events_in_window`,
   `keeper_alert_id` (el más antiguo), `burst_seconds` y la severidad máxima.
3. **Consulta B** calcula las reglas de supresión: tasa de FP ≥ 90 % sobre ≥ 20 triajes en
   30 días.
4. **Merge** combina ambas salidas para poder decidir en un único nodo Code.
5. **Code** calcula `dedup_count = min(events_in_window, DEDUP_MAX_COUNT)` y decide
   `is_suppressed` (regla ruidosa conocida **o** volumen anómalo). Sin grupos, emite un
   único ítem `noop` que cierra el workflow limpiamente.
6. **IF** separa el caso con trabajo (rama true) del caso vacío (rama false → NoOp).
7. **UPDATE** fija `dedup_count`/`is_suppressed` en el guardián del grupo y añade la traza
   en `raw_payload.soc_lite_dedup`.
8. **INSERT en `notifications`** (`channel='internal'`) deja la evidencia para el KPI.

### Tabla de nodos

| # | Nodo | Función | Entrada → Salida | Tipo n8n | Parámetros clave |
|---|---|---|---|---|---|
| 1 | `1 · Schedule cada 5 min` | Disparador periódico | — → ítem vacío | `n8n-nodes-base.scheduleTrigger@1.2` | `rule.interval[0] = { field: 'minutes', minutesInterval: 5 }` |
| C | `C · Set parámetros de ventana` | Parámetros de la ventana | `{}` → configuración | `n8n-nodes-base.set@3.4` | `DEDUP_WINDOW_MINUTES=30`, `DEDUP_MAX_COUNT=25`, `SUPPRESS_FP_RATE=0.9`, `SOC_SCHEMA`, `N8N_ORIGIN_IP` |
| 2 | `2 · SELECT ventana 30 min (PostgreSQL)` | Agrupa duplicados de los últimos 30 min | configuración → filas `{source_type, rule_id, source_ip, events_in_window, keeper_alert_id, burst_seconds, …}` | `n8n-nodes-base.postgres@2.4` | `executeQuery`; CTE `win` con `count(*) OVER (PARTITION BY source_type, rule_id, source_ip)` y `first_value(id) OVER (…)`; `HAVING count(*) > 1`; `LIMIT 500` |
| 3 | `3 · SELECT reglas FP conocidas (PostgreSQL)` | Catálogo de reglas ruidosas | configuración → filas `{rule_id, rule_description, total, fp, fp_pct, avg_confidence}` | `n8n-nodes-base.postgres@2.4` | `JOIN triage_results … is_current IS TRUE`; `HAVING count(*) >= 20 AND fp_ratio >= SUPPRESS_FP_RATE`; ventana de 30 días |
| 4 | `4 · Merge grupos + reglas FP` | Unifica ambas consultas | `main[0]` + `main[1]` → ítems combinados | `n8n-nodes-base.merge@3` | `mode=combine`, `combineBy=combineAll` |
| 5 | `5 · Calcular dedup y supresión (Code)` | Decide `dedup_count` y `is_suppressed` | ítems combinados → un ítem por grupo con `sql.*` | `n8n-nodes-base.code@2` | Map de reglas ruidosas; `suppressed = knownNoise \|\| highVolume`; *fallback* `{groups: 0, action: 'noop'}` |
| 6 | `6 · IF hay grupos` | Separa trabajo real de ejecución vacía | ítem → true/false | `n8n-nodes-base.if@2` | `$json.sql !== undefined` |
| 7 | `7 · UPDATE dedup_count (PostgreSQL)` | Persiste la decisión en la alerta | `sql.*` → `{alert_id, rule_id, dedup_count, is_suppressed, severity, status}` | `n8n-nodes-base.postgres@2.4` | `UPDATE alerts SET dedup_count, is_suppressed, raw_payload = raw_payload \|\| jsonb_build_object('soc_lite_dedup', …)`, `RETURNING` |
| 8 | `8 · Registrar decisión (PostgreSQL)` | Traza para el KPI de reducción de ruido | fila → `{notification_id, alert_id, status}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO notifications (channel='internal', target='dedup-suppression', payload jsonb, status='sent')`; `continueOnFail=true` |
| 9 | `9 · NoOp sin cambios` | Cierra la ejecución sin trabajo | rama false → sin salida | `n8n-nodes-base.noOp@1` | — |

### Payload de entrada/salida

Entrada (consulta A, ejemplo):

```json
{ "source_type": "wazuh", "rule_id": "5710", "source_ip": "203.0.113.44", "dest_ip": "10.0.4.21",
  "events_in_window": 187, "is_duplicate_group": true, "keeper_alert_id": 1043,
  "max_severity": "high", "max_rule_level": 10,
  "first_seen": "2025-01-31T14:22:05Z", "last_seen": "2025-01-31T14:26:31Z", "burst_seconds": 266 }
```

Entrada (consulta B, ejemplo):

```json
{ "rule_id": "5501", "rule_description": "PAM: Login session opened", "total": 412, "fp": 401,
  "fp_pct": 97.33, "avg_confidence": 0.94, "last_seen": "2025-01-31T13:50:00Z" }
```

Salida del nodo `5`:

```json
{ "source_type": "wazuh", "rule_id": "5710", "source_ip": "203.0.113.44",
  "events_in_window": 187, "dedup_count": 25, "keeper_alert_id": 1043,
  "suppressed": false, "suppress_reason": null, "fp_rate_pct": 22.0, "action": "dedup",
  "sql": { "rule_id": "'5710'", "dedup_count": 25, "is_suppressed": "FALSE", "keeper_alert_id": 1043, "window_minutes": 30 } }
```

Ejecución sin grupos:

```json
{ "groups": 0, "action": "noop", "detail": "Sin grupos de duplicados en la ventana de 30 min" }
```

---

## 9. WF-03 · Escalado de SLA

**Disparador:** `Schedule Trigger` cada 5 minutos. **Archivo:**
`n8n/soc_lite_sla_escalation_workflow.json`.

**SLA por severidad** (calculado por el trigger `trg_alerts_mttt` en el `INSERT`/`UPDATE`
de `alerts`): `critical` 15 min · `high` 1 h · `medium` 8 h · `low`/`info` 24 h.

### Diagrama de conexiones

```
1 · Schedule cada 5 min
        │
        ▼
C · Set parámetros SLA (SLA_WARN_MINUTES=10, ESCALATION_CHANNEL, SOC_MANAGER_EMAIL)
        │
        ▼
2 · SELECT y escalar SLA (PostgreSQL)     ← UPDATE pending → escalated + RETURNING
        │
        ▼
3 · Clasificar y preparar aviso (Code)    ← tier: vencido | critico | proximo
        │
        ▼
4 · Switch severidad y vencimiento
        ├─0 vencido / crítica (inmediato) ──▶ 5 · Slack escalado crítico ──┐
        ├─1 (idem, reglas agrupadas) ─────────────────────────────────────┤
        └─extra sin escalado ──▶ 9 · NoOp sin escalado                    │
                                                                          ▼
                                                    7 · Registrar notificación (PostgreSQL)
                                                                          │
                                                                          ▼
                                                    8 · Bitácora de escalado (PostgreSQL)
```

### Descripción paso a paso

1. Cada 5 minutos se buscan alertas `status='pending'` con `sla_due_at <= now() + 10 min`.
2. El `UPDATE … RETURNING` las pasa a `escalated` y devuelve **únicamente** las que
   transicionaron: garantía de que la notificación ocurre una sola vez por alerta.
3. El nodo `Code` clasifica (`vencido` si ya pasó, `critico` si quedan ≤ 5 min, `proximo`
   en el resto de la ventana), calcula la prioridad `p1..p4`, redacta el mensaje y prepara
   el SQL de la bitácora.
4. El `Switch` envía a Slack inmediato lo vencido o lo crítico; el resto cae en la salida
   *fallback* (NoOp) — los avisos preventivos se canalizan por la salida 0 cuando la
   severidad es crítica.
5. `7` registra la notificación en `soclite.notifications` y `8` audita el cambio de estado
   (`module='alerts'`, `action='UPDATE'`, con `before_data`/`after_data`).

### Tabla de nodos

| # | Nodo | Función | Entrada → Salida | Tipo n8n | Parámetros clave |
|---|---|---|---|---|---|
| 1 | `1 · Schedule cada 5 min` | Disparador | — → ítem | `n8n-nodes-base.scheduleTrigger@1.2` | `minutesInterval = 5` |
| C | `C · Set parámetros SLA` | Parámetros | `{}` → configuración | `n8n-nodes-base.set@3.4` | `SLA_WARN_MINUTES=10`, `ESCALATION_CHANNEL`, `SOC_MANAGER_EMAIL`, `DASHBOARD_BASE_URL`, `N8N_ORIGIN_IP` |
| 2 | `2 · SELECT y escalar SLA (PostgreSQL)` | Detecta y escala atómicamente | configuración → filas de alertas escaladas | `n8n-nodes-base.postgres@2.4` | CTE `vencidas` (`status='pending'`, `sla_due_at <= now() + INTERVAL '10 minutes'`, `LIMIT 200`) + `escaladas` (`UPDATE alerts SET status='escalated' … RETURNING`); devuelve `seconds_left`, `seconds_overdue`, `sla_tier`, `asset_criticality`, `assigned_username` |
| 3 | `3 · Clasificar y preparar aviso (Code)` | Clasifica y redacta | filas → un ítem por alerta con `notification_text` y `sql.*` | `n8n-nodes-base.code@2` | `tier ∈ {vencido, critico, proximo}`; `prio = p1..p4`; `escalate_to = soc_manager \| analyst_on_duty` |
| 4 | `4 · Switch severidad y vencimiento` | Enruta la notificación | ítem → `vencido / crítica (inmediato)` o `sin escalado` | `n8n-nodes-base.switch@3` | Reglas `severity == 'critical'` y `sla_tier == 'vencido'` comparten salida; `fallbackOutput=extra` |
| 5 | `5 · Slack escalado crítico` | Aviso inmediato | ítem → mensaje enviado | `n8n-nodes-base.slack@2.2` | canal `{{$json.channel}}`; texto con `:rotating_light:` y el detalle de vencimiento |
| 6 | `6 · Slack aviso preventivo` | Aviso de la ventana de 10 min | ítem → mensaje enviado | `n8n-nodes-base.slack@2.2` | canal `{{$json.channel}}`; texto con `:warning:` |
| 7 | `7 · Registrar notificación (PostgreSQL)` | Evidencia de la notificación | ítem → `{notification_id, alert_id, channel, status}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO notifications (channel='slack', payload jsonb con 'kind'='sla_escalation', seconds_left, seconds_overdue, escalate_to)`, `status='sent'`; `continueOnFail=true` |
| 8 | `8 · Bitácora de escalado (PostgreSQL)` | Audita `pending → escalated` | ítem → `{audit_id, hash_self}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO audit_log (module='alerts', action='UPDATE', entity='alert', before_data/after_data, ip_address, severity)` |
| 9 | `9 · NoOp sin escalado` | Salida de *fallback* | ítem → sin salida | `n8n-nodes-base.noOp@1` | — |

### Payloads

Salida del nodo `2`:

```json
{ "alert_id": 1045, "alert_fingerprint": "3c7d…91ab", "status": "escalated", "severity": "critical",
  "risk_score": 95, "verdict": "true_positive", "agent_name": "PLC-PLANTA1", "source_ip": "192.0.2.55",
  "rule_id": "IDS-9001", "rule_description": "ET MALWARE Possible Cobalt Strike Beacon",
  "occurred_at": "2025-01-31T11:40:00Z", "sla_due_at": "2025-01-31T11:55:00Z",
  "seconds_left": -420, "seconds_overdue": 420, "dedup_count": 3,
  "assigned_username": null, "asset_criticality": "critical",
  "sla_tier": "vencido", "minutes_overdue": 7 }
```

Salida del nodo `3`:

```json
{ "alert_id": 1045, "severity": "critical", "priority": "p1", "sla_tier": "vencido",
  "tier_label": "SLA VENCIDO", "channel": "#soc-escalamientos", "is_overdue": true,
  "minutes_overdue": 7, "escalate_to": "soc_manager",
  "notification_text": ":alarm_clock: *SLA VENCIDO* — alerta #1045 (CRITICAL / p1)\nActivo: PLC-PLANTA1  |  IP origen: 192.0.2.55  |  Regla: IDS-9001\nVencido hace 7 min  |  Vencimiento: 2025-01-31T11:55:00Z\nAsignada a: SIN ASIGNAR  |  Eventos agrupados: 3\n…\n<http://localhost:3000/alerts/1045|Ver alerta #1045 en el dashboard>",
  "dashboard_url": "http://localhost:3000/alerts/1045",
  "sql": { "alert_id": 1045, "sla_tier": "'vencido'", "seconds_overdue": 420, "…": "…" } }
```

Mensaje de Slack:

```
:rotating_light: *ESCALADO SLA CRITICO* — alerta #1045
:alarm_clock: *SLA VENCIDO* — alerta #1045 (CRITICAL / p1)
Activo: PLC-PLANTA1  |  IP origen: 192.0.2.55  |  Regla: IDS-9001
Vencido hace 7 min  |  Vencimiento: 2025-01-31T11:55:00Z
Asignada a: SIN ASIGNAR  |  Eventos agrupados: 3
ET MALWARE Possible Cobalt Strike Beacon
Ver alerta #1045 en el dashboard
```

---

## 10. WF-04 · Agregación de métricas diarias

**Disparador:** `Schedule Trigger` diario a las 00:30 (`30 0 * * *`). **Archivo:**
`n8n/soc_lite_metrics_aggregation_workflow.json`.

### Diagrama de conexiones

```
1 · Schedule diario 00:30
        │
        ▼
C · Set parámetros de métricas (METRIC_DATE_OFFSET_DAYS=1, LOOKBACK_DAYS=2, ANALYZE_TARGETS, KPI_SLACK_CHANNEL)
        │
        ▼
2 · Recalcular alert_metrics_daily (PostgreSQL)   ← UPSERT idempotente
        │
        ▼
3 · Calcular KPIs MTTT/FP (PostgreSQL)            ← MTTT, FP rate, reduction rate, SLA
        │
        ▼
4 · Formatear KPIs y ANALYZE (Code)
        ├──────────────────────────────┐
        ▼                              ▼
5 · ANALYZE (PostgreSQL)        7 · Registrar KPIs (PostgreSQL)
        │                              │
        ▼                              ▼
6 · Verificar ANALYZE           8 · Bitácora de métricas (PostgreSQL)
```

### Descripción paso a paso

1. A las 00:30 se recalcula el agregado diario para los últimos **2 días**
   (`LOOKBACK_DAYS=2`): el solapamiento corrige datos que llegan tarde y, como el
   `INSERT … ON CONFLICT` es idempotente, no duplica.
2. `alert_metrics_daily` se recalcula por `(metric_date, source_type, severity)` con
   `alerts_total`, `alerts_tp`, `alerts_fp`, `alerts_escalated`, `mttt_avg_sec`,
   `mttt_p95_sec`, `mttr_avg_sec` y `automation_rate`.
3. Se calculan los KPIs del **día anterior**: MTTT (medio/mediana/p95), MTTR, tasa de FP,
   `suppression_rate`, `noise_reduction_rate`, `automation_rate` y cumplimiento de SLA
   crítico (≤ 900 s) y alto (≤ 3600 s), comparados con `soclite.kpi_targets`.
4. El nodo `Code` formatea el informe (con ✅/❌ por objetivo) y compila el `ANALYZE`.
5. `ANALYZE` refresca las estadísticas del planificador de las tablas principales.
6. El snapshot de KPIs se guarda en `soclite.notifications` (`payload.kind = 'kpi_daily'`) y
   el proceso queda auditado en `audit_log`.

### Tabla de nodos

| # | Nodo | Función | Entrada → Salida | Tipo n8n | Parámetros clave |
|---|---|---|---|---|---|
| 1 | `1 · Schedule diario 00:30` | Disparador | — → ítem | `n8n-nodes-base.scheduleTrigger@1.2` | `field='cronExpression'`, `expression='30 0 * * *'` |
| C | `C · Set parámetros de métricas` | Parámetros | `{}` → configuración | `n8n-nodes-base.set@3.4` | `METRIC_DATE_OFFSET_DAYS=1`, `LOOKBACK_DAYS=2`, `ANALYZE_TARGETS`, `KPI_SLACK_CHANNEL` |
| 2 | `2 · Recalcular alert_metrics_daily (PostgreSQL)` | Recalcula el agregado diario | configuración → una fila por combinación actualizada | `n8n-nodes-base.postgres@2.4` | `INSERT INTO alert_metrics_daily … SELECT … GROUP BY 1,2,3 HAVING count(*) > 0 ON CONFLICT (metric_date, source_type, severity) DO UPDATE`; `percentile_cont(0.95) WITHIN GROUP (ORDER BY mttt_seconds)` |
| 3 | `3 · Calcular KPIs MTTT/FP (PostgreSQL)` | KPIs de gestión | configuración → una fila de KPIs | `n8n-nodes-base.postgres@2.4` | CTE `agg`/`base`; `fp_rate`, `suppression_rate`, `noise_reduction_rate`, `automation_rate`, `sla_compliance_critical/high`; subconsultas a `kpi_targets` |
| 4 | `4 · Formatear KPIs y ANALYZE (Code)` | Informe y SQL de mantenimiento | KPIs → `{kpi_text, kpi_breaches, kpi_ok, analyze_targets, analyze_sql, slack_channel}` | `n8n-nodes-base.code@2` | Formato `%`/segundos; `flag()` ✅/❌; validación de nombres de tabla con regex antes de componer el `ANALYZE` |
| 5 | `5 · ANALYZE (PostgreSQL)` | Refresca estadísticas | configuración → resultado del `ANALYZE` | `n8n-nodes-base.postgres@2.4` | `ANALYZE soclite.alerts, soclite.triage_results, soclite.incidents, soclite.audit_log, soclite.enrichment_data;`; `continueOnFail=true` |
| 6 | `6 · Verificar ANALYZE (PostgreSQL)` | Evidencia del mantenimiento | — → `{analyze_status, executed_at, tablas_analizadas}` | `n8n-nodes-base.postgres@2.4` | `SELECT 'ANALYZE_OK', now(), (SELECT count(*) FROM pg_stat_user_tables WHERE schemaname='soclite' AND last_analyze IS NOT NULL)` |
| 7 | `7 · Registrar KPIs (PostgreSQL)` | Snapshot histórico de KPIs | KPIs → `{notification_id, channel, status}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO notifications (channel='slack', payload jsonb con 'kind'='kpi_daily')`; `continueOnFail=true` |
| 8 | `8 · Bitácora de métricas (PostgreSQL)` | Auditoría del recálculo | KPIs → `{audit_id, hash_self}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO audit_log (module='dashboard', action='UPDATE', entity='alert_metrics_daily', entity_id=metric_date, after_data)` |

### KPIs calculados

| KPI | Fórmula | Objetivo (`kpi_targets`) |
|---|---|---|
| `mttt_avg_sec` | `avg(mttt_seconds)` del día | `mttt_critical` 900 s / `mttt_high` 3600 s |
| `mttt_p95_sec` | `percentile_cont(0.95)` | — (tendencia) |
| `fp_rate` | `count(verdict='false_positive') / count(triados)` | `fp_rate` ≤ 0,30 |
| `suppression_rate` | `count(is_suppressed) / count(ingeridas)` | — |
| `noise_reduction_rate` | `1 − escaladas / ingeridas` | `noise_reduction` ≥ 0,70 |
| `automation_rate` | `count(mttt_seconds IS NOT NULL) / count(ingeridas)` | `automation_rate` ≥ 0,85 |
| `sla_compliance_critical` | `count(mttt ≤ 900 s) / count(triados critical)` | `sla_compliance_critical` ≥ 0,95 |
| `sla_compliance_high` | `count(mttt ≤ 3600 s) / count(triados high)` | — (referencia 0,94) |

### Payload de salida (nodo `3`)

```json
{
  "metric_date": "2025-01-30",
  "alerts_total": 412, "alerts_ingested_raw": 3184, "alerts_triaged": 398,
  "alerts_tp": 96, "alerts_fp": 249, "alerts_escalated": 63, "alerts_closed": 305,
  "alerts_suppressed": 812, "duplicates_collapsed": 2019,
  "mttt_avg_sec": 168.42, "mttt_median_sec": 96.0, "mttt_p95_sec": 640.0, "mttr_avg_sec": 4210.5,
  "mttt_vs_target_pct": 18.71,
  "fp_rate": 0.6256, "suppression_rate": 0.2550, "noise_reduction_rate": 0.9802, "automation_rate": 0.1250,
  "sla_compliance_critical": 0.98, "sla_compliance_high": 0.94,
  "target_fp_rate": 0.30, "target_noise_reduction": 0.70, "target_automation_rate": 0.85,
  "calculated_at": "2025-01-31T00:30:02.114Z"
}
```

Informe de Slack (`kpi_text`):

```
*SOC-Lite · KPIs 2025-01-30*
:inbox_tray: Alertas ingeridas: *3184*  |  triadas: *398*  |  escaladas: *63*
:mag: TP: *96*  |  FP: *249*  |  suprimidas/deduplicadas: *812* (eventos colapsados: 2019)
:stopwatch: MTTT medio: *2.8 min*  |  mediana: *1.6 min*  |  p95: *10.7 min*
:hammer: MTTR medio: *1.17 h*
:x: Tasa de FP: *62.6 %* (objetivo <= 30.0 %)
:white_check_mark: Reduction rate: *98.0 %* (objetivo >= 70.0 %)
:x: Automatizacion: *12.5 %* (objetivo >= 85.0 %)
:white_check_mark: SLA crítico: *98.0 %*  |  :white_check_mark: SLA alto: *94.0 %*
```

---

## 11. WF-05 · Generación de reportes

**Disparador:** `Schedule Trigger` semanal, lunes 07:00 (`0 7 * * 1`). **Archivo:**
`n8n/soc_lite_report_generation_workflow.json`.

### Diagrama de conexiones

```
1 · Schedule semanal lunes 07:00
        │
        ▼
C · Set parámetros de reporte (BACKEND_BASE_URL, REPORT_TYPE=operational, REPORT_FORMAT=pdf, REPORT_PERIOD_DAYS=7, …)
        │
        ▼
2 · Preparar ventana y URLs (Code)      ← from/to ISO-8601 + URL del endpoint
        │
        ▼
3 · HTTP login backend (JWT)            ← POST /api/v1/auth/login (form-urlencoded)
        │  access_token
        ▼
4 · HTTP GET reporte PDF (backend)      ← GET /api/v1/reports/operational?format=pdf&from&to
        │  binario 'data'
        ▼
5 · Checksum SHA-256 (Code)             ← sha256 + nombre/ruta del artefacto
        │
        ▼
6 · HTTP subir artefacto (S3/MinIO)     ← PUT binario
        │
        ▼
7 · Registrar reporte (PostgreSQL)      ← INSERT en generated_reports
        │
        ▼
8 · Bitácora EXPORT (PostgreSQL)        ← INSERT en audit_log (module='reports')
        │
        ▼
9 · Formatear aviso y correo (Code)
        ├──────────────────────────────┐
        ▼                              ▼
10 · Slack reporte disponible    11 · Email a responsables
```

### Descripción paso a paso

1. El lunes a las 07:00 se calcula la ventana de los últimos 7 días en ISO-8601.
2. Se obtiene un JWT de servicio (`reports:export`) contra `POST /api/v1/auth/login`.
3. Se descarga el artefacto desde `GET /api/v1/reports/operational?format=pdf&from&to`
   (`responseFormat: file` → propiedad binaria `data`), con 3 intentos y 300 s de timeout.
4. El nodo `Code` calcula el SHA-256, el tamaño y la ruta
   `/AAAA/AAAA-MM/SOC-Lite_operational_<desde>_<hasta>.pdf`.
5. Se sube el binario por `PUT` a S3/MinIO (o se escribe en el volumen compartido).
6. Se registra en `soclite.generated_reports` (con `checksum_sha256`, `file_size`,
   `parameters`, `requested_by`, `expires_at = now() + 180 días`).
7. Se audita la acción `EXPORT` en `soclite.audit_log` (`module='reports'`) tal como exige el
   contrato §7.
8. Se notifica por Slack (`#soc-reportes`) y por correo a `REPORT_RECIPIENTS`.

### Tabla de nodos

| # | Nodo | Función | Entrada → Salida | Tipo n8n | Parámetros clave |
|---|---|---|---|---|---|
| 1 | `1 · Schedule semanal lunes 07:00` | Disparador | — → ítem | `n8n-nodes-base.scheduleTrigger@1.2` | `field='cronExpression'`, `expression='0 7 * * 1'` |
| C | `C · Set parámetros de reporte` | Parámetros | `{}` → configuración | `n8n-nodes-base.set@3.4` | `BACKEND_BASE_URL`, `REPORT_TYPE=operational`, `REPORT_FORMAT=pdf`, `REPORT_PERIOD_DAYS=7`, `REPORT_STORAGE_DIR`, `REPORT_PUBLIC_BASE_URL`, `REPORT_RECIPIENTS`, `REPORT_SLACK_CHANNEL` |
| 2 | `2 · Preparar ventana y URLs (Code)` | Ventana ISO y URLs | configuración → `{period_from, period_to, api_url, inventory_url, auth_url, storage_dir, public_base_url}` | `n8n-nodes-base.code@2` | `from = to − 7 días`; `api_url = {base}/reports/operational?format=pdf&from=…&to=…` |
| 3 | `3 · HTTP login backend (JWT)` | Obtiene `access_token` | configuración → `{access_token, refresh_token, token_type, expires_in, user}` | `n8n-nodes-base.httpRequest@4.2` | `POST {{$json.auth_url}}`, `contentType=form-urlencoded`, `username={{$env.SOCLITE_API_USER}}`, `password={{$env.SOCLITE_API_PASSWORD}}`; `retryOnFail`, `maxTries=3`, `waitBetweenTries=2000`, `timeout=15000` |
| 4 | `4 · HTTP GET reporte PDF (backend)` | Descarga el artefacto | `{access_token}` → binario `data` | `n8n-nodes-base.httpRequest@4.2` | `GET api_url`; cabeceras `Authorization: Bearer …`, `Accept: application/pdf`; `responseFormat=file`, `outputPropertyName=data`; `retryOnFail`, `maxTries=3`, `waitBetweenTries=5000`, `timeout=300000` |
| 5 | `5 · Checksum SHA-256 (Code)` | Integridad y nombre del archivo | binario → `{file_name, file_path, file_size, checksum_sha256, mime_type, public_url}` | `n8n-nodes-base.code@2` | `crypto.createHash('sha256')`; ruta por año/mes; conserva el binario para la subida |
| 6 | `6 · HTTP subir artefacto (S3/MinIO)` | Sube el artefacto | binario + metadatos → `{statusCode, headers, body}` | `n8n-nodes-base.httpRequest@4.2` | `PUT {{$env.REPORT_UPLOAD_URL}}{{$json.file_path}}`; `contentType=binaryData`, `inputDataFieldName=data`; cabeceras `Content-Type`, `x-amz-meta-checksum-sha256`, `Authorization`; `retryOnFail`, `maxTries=3`, `timeout=120000` |
| 7 | `7 · Registrar reporte (PostgreSQL)` | Registra el artefacto | metadatos → `{report_id, report_type, report_format, title, file_path, checksum_sha256, created_at}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO generated_reports (…, parameters jsonb, requested_by=(SELECT id FROM users WHERE username='admin'), status='completed', expires_at=now()+INTERVAL '180 days') RETURNING …`; `continueOnFail=true` |
| 8 | `8 · Bitácora EXPORT (PostgreSQL)` | Auditoría de exportación | `{report_id}` → `{audit_id, hash_self}` | `n8n-nodes-base.postgres@2.4` | `INSERT INTO audit_log (module='reports', action='EXPORT', entity='report', entity_id=report_id, after_data jsonb, http_method='GET', http_path='/api/v1/reports/operational?format=pdf')` |
| 9 | `9 · Formatear aviso y correo (Code)` | Cuerpo de correo y Slack | reporte + registro + auditoría → `{email_to, email_subject, email_html, slack_text, recipients[]}` | `n8n-nodes-base.code@2` | HTML con periodo, formato, tamaño, ruta, SHA-256, ID en `generated_reports` y enlace de descarga |
| 10 | `10 · Slack reporte disponible` | Aviso al canal | ítem → mensaje enviado | `n8n-nodes-base.slack@2.2` | canal `{{$json.slack_channel}}`, texto con `:page_with_curl:`, tamaño, checksum y enlace |
| 11 | `11 · Email a responsables` | Envío por correo | ítem → correo enviado | `n8n-nodes-base.emailSend@2.1` | `fromEmail={{$env.SMTP_FROM}}`, `toEmail={{$json.email_to}}`, `subject={{$json.email_subject}}`, `emailFormat=html`; `continueOnFail=true` |

### Payloads

Salida del nodo `2`:

```json
{ "report_type": "operational", "format": "pdf",
  "period_from": "2025-01-24T07:00:00Z", "period_to": "2025-01-31T07:00:00Z", "period_days": 7,
  "api_url": "http://backend:8000/api/v1/reports/operational?format=pdf&from=2025-01-24T07%3A00%3A00Z&to=2025-01-31T07%3A00%3A00Z",
  "inventory_url": "http://backend:8000/api/v1/reports/inventory?report_type=operational&page=1&page_size=5",
  "auth_url": "http://backend:8000/api/v1/auth/login",
  "storage_dir": "/data/reports/soc-lite",
  "public_base_url": "https://n8n.org.local/files/reports",
  "recipients": "soc_manager@org.local,ciso@org.local",
  "slack_channel": "#soc-reportes", "requested_by": "system/n8n" }
```

Salida del nodo `5`:

```json
{ "report_type": "operational", "format": "pdf",
  "period_from": "2025-01-24T07:00:00Z", "period_to": "2025-01-31T07:00:00Z",
  "file_name": "SOC-Lite_operational_20250124-20250131.pdf",
  "file_path": "/data/reports/soc-lite/2025/2025-01/SOC-Lite_operational_20250124-20250131.pdf",
  "public_url": "https://n8n.org.local/files/reports/2025/2025-01/SOC-Lite_operational_20250124-20250131.pdf",
  "file_size": 486213, "checksum_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "mime_type": "application/pdf", "generated_at": "2025-01-31T07:00:04.882Z",
  "title": "SOC-Lite · Reporte operativo 2025-01-24 → 2025-01-31" }
```

Salida del nodo `7`:

```json
{ "report_id": 14, "report_type": "operational", "report_format": "pdf",
  "title": "SOC-Lite · Reporte operativo 2025-01-24 → 2025-01-31",
  "file_path": "/data/reports/soc-lite/2025/2025-01/SOC-Lite_operational_20250124-20250131.pdf",
  "checksum_sha256": "e3b0c442…b855", "created_at": "2025-01-31T07:00:05.113Z" }
```

Mensaje de Slack (nodo `10`):

```
:page_with_curl: *Reporte operativo SOC-Lite 2025-01-24 → 2025-01-31*
Formato: *pdf*  |  Tamaño: *0.46 MB*  |  Registro: *# 14*
*/data/reports/soc-lite/2025/2025-01/SOC-Lite_operational_20250124-20250131.pdf*
SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
Descargar reporte
```

---

## 12. Trazabilidad, auditoría y cumplimiento

### 12.1 Eventos de bitácora generados por los workflows

| Workflow | `module` | `action` | `entity` / `entity_id` | `username` | `result` | Momento |
|---|---|---|---|---|---|---|
| 01 | `triage` | `TRIAGE_RUN` | `alert` / `<alert_id>` | `system/n8n` | `success` | tras el triaje y la actualización de la alerta |
| 01 | `triage` | `TRIAGE_RUN` | `workflow` / `<nombre>` | `system/n8n` | `failure` | Error Trigger global (cualquier fallo) |
| 03 | `alerts` | `UPDATE` | `alert` / `<alert_id>` | `system/n8n` | `success` | al escalar por SLA (`before`/`after` incluidos) |
| 04 | `dashboard` | `UPDATE` | `alert_metrics_daily` / `<fecha>` | `system/n8n` | `success` | tras recalcular agregados y KPIs |
| 05 | `reports` | `EXPORT` | `report` / `<report_id>` | `system/n8n` | `success` | al almacenar el reporte |

La bitácora es **inmutable**: `db/schema.sql:338-339` define reglas `ON UPDATE/ON DELETE DO
INSTEAD NOTHING`, y el disparador `trg_audit_chain` encadena `hash_prev`/`hash_self`
(sha256) para detectar manipulación.

### 12.2 Correlación end-to-end

```
Wazuh (evento)                                    →  alerts.raw_payload (JSONB íntegro)
  └─ alert_fingerprint (sha256 source|rule|ip|bucket)
       ├─ alerts.alert_fingerprint / id            →  clave de correlación
       ├─ triage_results.trace_id (UUID del LLM)   →  LangSmith / logs del microservicio
       ├─ audit_log.trace_id + entity_id           →  bitácora del triaje
       ├─ notifications.payload                    →  notificaciones emitidas
       └─ incidents.incident_code + external_ticket_id →  gestión y ticket externo
```

### 12.3 Correspondencia con normas

| Requisito | Evidencia en los workflows |
|---|---|
| ISO/IEC 27001 A.8.15 *(registro de eventos)* | `audit_log` con usuario, fecha, módulo, acción, resultado, IP, `trace_id` y encadenado de hashes. |
| ISO/IEC 27001 A.8.16 *(actividades de seguimiento)* | KPIs diarios (WF-04) y escalado automático de SLA (WF-03). |
| ISO/IEC 27001 A.5.24 *(gestión de incidentes)* | Creación automática de incidentes (WF-01, nodo `9c`) y notificación a responsables (WF-03). |
| ISO/IEC 27001 A.5.28 *(evidencia)* | `checksum_sha256` del reporte, `generated_reports` y trazas de deduplicación en `raw_payload`. |
| NIST CSF 2.0 · DE.AE | Correlación y enriquecimiento previos al análisis (`3a`, contexto del LLM). |
| NIST CSF 2.0 · RS.AN / RS.MA | Triaje automatizado, enrutamiento por severidad y acciones recomendadas. |
| NIST CSF 2.0 · GV.OC | Notificación y trazabilidad hacia responsables (`notifications`, `SOC_MANAGER_EMAIL`). |

---

## 13. Supuestos y decisiones de diseño

1. **Estado de los artefactos.** Los cinco JSON son exports de n8n **inactivos**
   (`"active": false`) y sus credenciales llevan el marcador
   `REEMPLAZAR_CON_ID_CREDENCIAL_*` (n8n no puede resolver credenciales de otra instancia).
2. **Error Workflow por nombre.** n8n referencia el error workflow por **nombre**, no por
   `id`, y la clave `settings.errorWorkflow` se exporta vacía a propósito para evitar
   dependencias frágiles entre instancias. Debe registrarse una vez tras importar
   (`n8n/README.md` §5).
3. **`trace_id` del contrato.** El contrato describe `trace_id` como un string corto
   (`"b1f0…"`). Hacia el microservicio se envía el `alert_fingerprint` (sha256 hex, 64
   caracteres, único por alerta y bucket) por ser el identificador disponible en ese punto;
   en `audit_log.trace_id` (tipo `UUID`) se escribe el `trace_id` devuelto por el LLM si es
   un UUID válido, y `NULL` en caso contrario.
4. **`rule_groups` / `text[]` en SQL.** El nodo PostgreSQL recibe `'{…}'::text[]` como
   literal ya compilado por el nodo `Code`. Es una decisión deliberada: el nodo PostgreSQL
   de n8n maneja de forma inconsistente los parámetros posicionales con arrays y JSON, por
   lo que se prefiere un literal escapado y verificable en el propio flujo (visible en la
   UI) frente a un `queryReplacement` opaco.
5. **Consulta previa de duplicados.** El enunciado pide que el nodo `IF` filtre
   «duplicados (consulta previa)». La deduplicación real es **atómica** en el `INSERT … ON
   CONFLICT` del nodo `3` (única forma de evitar condiciones de carrera entre el `SELECT` y
   el `INSERT`), y la consulta de ventana de 30 minutos vive en el workflow 02. El nodo `2`
   evalúa `dedup.exists` / `is_suppressed`, campos preparados por el nodo `1b`. Para usar
   una consulta previa literal, insertar un nodo PostgreSQL `SELECT` entre `1b` y `2` que
   devuelva `{exists: true}` cuando el fingerprint ya esté en el bucket.
6. **`api_key` de tickets.** La integración osTicket/Redmine **no** forma parte del contrato
   v1; el payload cubre los campos estándar de osTicket (`alert, source, name, email,
   subject, message, priority, topicId, ip`) y de Redmine (`issue{…}`), y el destino se
   elige con `OSTICKET_API_URL` / `REDMINE_TICKET_URL`.
7. **Usuario `system/n8n`.** n8n no es un usuario humano: los eventos se registran con
   `username = 'system/n8n'` y `user_id = NULL`. El `created_by` de los incidentes se
   resuelve al usuario `admin` (integración de sistema) porque la columna referencia
   `users(id)`.
8. **Cubetas de 5 minutos.** El bucket (`300000 ms`) equilibra agrupación de ráfagas y
   granularidad temporal; se puede ajustar cambiando la constante en el nodo `1b` (y el
   comentario del esquema, `db/schema.sql:184`).
9. **Variante Telegram.** Se entrega como nodo `Code` No-Op con la plantilla completa
   comentada; activarla requiere sustituir el nodo por `n8n-nodes-base.telegram@1.2` y
   definir `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
10. **`ANALYZE`.** Se envía una lista de tablas fija (parametrizable por
    `ANALYZE_TARGETS`) en una sola sentencia porque el nodo PostgreSQL de n8n no garantiza
    la ejecución de múltiples sentencias separadas por `;`. La versión compilada por el
    nodo `Code` (`analyze_sql`) queda disponible en el ítem para auditoría.
11. **Zona horaria.** Todos los workflows usan `settings.timezone = America/Santiago`;
    las fechas se envían a las API en **UTC ISO-8601** y la interfaz las presenta con
    desfase (`2025-01-31T14:22:05-05:00`), según el contrato.
12. **Reintentos.** `retryOnFail` de n8n implementa una espera **lineal** por intento
    (`waitBetweenTries × intento`). Se considera equivalente funcional al backoff
    exponencial solicitado; un backoff estrictamente exponencial con *jitter* requeriría un
    sub-workflow con `Wait` y contador.
13. **Métricas: ventana de 2 días.** `LOOKBACK_DAYS = 2` recalcula ayer y anteayer para
    absorber eventos que llegan tarde; el `ON CONFLICT … DO UPDATE` mantiene el resultado
    idempotente.
14. **Almacenamiento del reporte.** Por defecto se asume un *gateway* S3/MinIO accesible
    por HTTP con la cabecera `Authorization` precalculada. Alternativas documentadas: nodo
    S3 nativo con credencial IAM, o escritura en un volumen compartido con
    `readWriteFile`.
15. **Volumen del `INSERT` masivo.** Los workflows no procesan lotes de miles de alertas en
    una sola ejecución: el webhook trata un evento por petición y los `Schedule` tienen
    `LIMIT` (200–500 filas) para acotar el consumo de memoria y el tiempo de ejecución.
