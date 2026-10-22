# SOC-Lite · Workflows n8n

Automatización de la capa de orquestación del SOC-Lite: **ingesta → deduplicación →
triaje con LLM → notificación → ticket/incidente → bitácora**, más los trabajos
programados de **SLA**, **métricas** y **reportes**.

> 📖 Referencia funcional detallada (nodo a nodo, diagramas, payloads y política de
> errores): [`docs/05-workflow-n8n.md`](../docs/05-workflow-n8n.md)

---

## 1. Inventario de workflows

| # | Archivo | Nombre en n8n | Disparador | Nodos | Estado |
|---|---|---|---|---|---|
| 01 | `soc_lite_triage_workflow.json` | SOC-Lite · 01 · Triage automático de alertas | Webhook `POST /webhook/wazuh-alert` + Error Trigger | 27 | **Núcleo** |
| 02 | `soc_lite_dedup_suppression_workflow.json` | SOC-Lite · 02 · Deduplicación y supresión de ruido | Schedule cada 5 min | 11 | Auxiliar |
| 03 | `soc_lite_sla_escalation_workflow.json` | SOC-Lite · 03 · Escalado de SLA | Schedule cada 5 min | 11 | Auxiliar |
| 04 | `soc_lite_metrics_aggregation_workflow.json` | SOC-Lite · 04 · Agregación de métricas diarias y ANALYZE | Schedule diario 00:30 | 10 | Auxiliar |
| 05 | `soc_lite_report_generation_workflow.json` | SOC-Lite · 05 · Generación de reporte operativo semanal | Schedule lunes 07:00 | 13 | Auxiliar |

**Dependencias:** todos los workflows escriben/leen en PostgreSQL (`soclite`). El
workflow 01 depende además del microservicio LangChain (`http://langchain:8001`) y de
Slack; el 05 depende del backend (`/api/v1/reports/...`) y del almacenamiento de objetos.

---

## 2. Importación en n8n

Requisitos: **n8n 1.60 o superior** (los `typeVersion` de los nodos son los indicados en
la sección 1 del documento de diseño). Comprobado con los nodos base
`postgres@2.4`, `httpRequest@4.2`, `switch@3`, `if@2`, `slack@2.2`, `code@2`,
`scheduleTrigger@1.2`, `errorTrigger@1`, `webhook@2`. Para n8n < 1.5 bajar
`set` de 3.4 → 3.3 y `respondToWebhook` de 1.1 → 1.

### Opción A — interfaz web

1. Entrar en n8n (`https://n8n.org.local` o `http://localhost:5678`).
2. **Workflows → ⋯ → Import from File** y seleccionar cada `.json`.
3. Repetir con los cinco archivos.
4. **Guardar** cada workflow (aparecerán inactivos).

### Opción B — CLI (importación por lotes)

```bash
# Dentro del contenedor n8n (o con n8n CLI instalado en el host)
docker compose exec -T n8n n8n import:workflow --separate --input=/data/n8n/soc-lite
# (los 5 .json deben estar copiados en /data/n8n/soc-lite)
```

### Opción C — API pública de n8n

```bash
N8N_URL="http://localhost:5678"
N8N_KEY="<API key de n8n>"
for f in soc_lite_*.json; do
  curl -sS -X POST "$N8N_URL/api/v1/workflows" \
    -H "X-N8N-API-KEY: $N8N_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$f" | jq -r '.id + " " + .name'
done
```

> ⚠️ La API de n8n **ignora** los `credentials` del JSON (los `id` son locales a cada
> instancia). Después de importar hay que **reasignar las credenciales** en cada nodo:
> los nodos PostgreSQL, Slack y SMTP traen el marcador
> `REEMPLAZAR_CON_ID_CREDENCIAL_*`. En la UI aparecerán en rojo con el aviso
> *«Credential not found»*.

---

## 3. Variables de entorno del contenedor n8n

Los JSON **no contienen secretos**. Se leen del entorno del contenedor
(`docker-compose.yml` → `env_file: .env`, o `environment:` directo):

| Variable | Usada por | Ejemplo | Descripción |
|---|---|---|---|
| `SOC_INGEST_KEY` | 01 | `soclite_9f2c…` | Clave compartida del header `X-Ingest-Key`. **Obligatoria**; sin ella el nodo 1b lanza error. |
| `INTERNAL_SERVICE_TOKEN` | 01 | `Bearer interno` | Token del microservicio LangChain (red interna). |
| `LANGCHAIN_URL` | 01 | `http://langchain:8001/triage` | Endpoint de triaje (contrato §4). |
| `OSTICKET_API_URL` | 01 | `https://soporte.org.local/api/http.php/tickets.json` | Si está definida, se usa osTicket; si no, `REDMINE_TICKET_URL`. |
| `REDMINE_TICKET_URL` | 01 | `https://redmine.org.local/issues.json` | Alternativa a osTicket. |
| `OSTICKET_API_KEY` / `REDMINE_API_KEY` | 01 | — | API key del sistema de tickets (header `X-API-Key`). |
| `OSTICKET_BASE_URL` | 01 | `https://soporte.org.local` | Base para construir `external_ticket_url`. |
| `SLACK_CHANNEL` | 01 | `#soc-alertas` | Canal del workflow 01. |
| `DASHBOARD_BASE_URL` | 01, 03 | `http://localhost:3000` | Enlaces a `/#/alerts/{id}`. |
| `TRIAGE_MODEL` / `TRIAGE_PROMPT_VERSION` | 01 | `llama3.1:8b` / `triage_v3` | Metadatos del modelo (fallback si el LLM no los devuelve). |
| `N8N_ORIGIN_IP` | 01, 02, 03 | `10.10.2.90` | IP de n8n registrada en `audit_log.ip_address`. |
| `SOC_SCHEMA` | 01 | `soclite` | Esquema por defecto. |
| `DEDUP_WINDOW_MINUTES` / `DEDUP_MAX_COUNT` / `SUPPRESS_FP_RATE` | 02 | `30` / `25` / `0.9` | Ventana de deduplicación y umbrales de supresión. |
| `SLA_WARN_MINUTES` | 03 | `10` | Ventana de aviso previo al vencimiento. |
| `ESCALATION_CHANNEL` | 03 | `#soc-escalamientos` | Canal de escalados de SLA. |
| `SOC_MANAGER_EMAIL` | 03 | `manager@org.local` | Responsable del escalado. |
| `METRIC_DATE_OFFSET_DAYS` / `LOOKBACK_DAYS` | 04 | `1` / `2` | Día a recalcular y ventana de revisión idempotente. |
| `ANALYZE_TARGETS` | 04 | `soclite.alerts,…` | Tablas del `ANALYZE` nocturno. |
| `KPI_SLACK_CHANNEL` | 04 | `#soc-metricas` | Canal del informe de KPIs. |
| `SOCLITE_API_USER` / `SOCLITE_API_PASSWORD` | 05 | `svc-n8n` / `…` | Usuario de servicio con permiso `reports:export`. |
| `REPORT_STORAGE_DIR` / `REPORT_UPLOAD_URL` | 05 | `/data/reports/soc-lite` / `http://minio:9000/soc-lite-reports` | Destino del artefacto (volumen o S3/MinIO). |
| `REPORT_UPLOAD_AUTH` | 05 | `AWS4-HMAC-SHA256 …` | Cabecera `Authorization` del `PUT` a S3/MinIO. |
| `REPORT_PUBLIC_BASE_URL` | 05 | `https://n8n.org.local/files/reports` | URL base del enlace de descarga. |
| `REPORT_RECIPIENTS` | 05 | `soc_manager@org.local,ciso@org.local` | Destinatarios del correo semanal. |
| `REPORT_SLACK_CHANNEL` | 05 | `#soc-reportes` | Canal de aviso del reporte. |
| `SMTP_FROM` | 05 | `soc-lite@org.local` | Remitente del correo. |

Ejemplo de `docker-compose.yml`:

```yaml
services:
  n8n:
    image: n8nio/n8n:1.68.0
    environment:
      - N8N_HOST=n8n.org.local
      - N8N_PROTOCOL=https
      - WEBHOOK_URL=https://n8n.org.local/
      - GENERIC_TIMEZONE=America/Santiago
      - TZ=America/Santiago
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
      - SOC_INGEST_KEY=${SOC_INGEST_KEY}
      - INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN}
      - LANGCHAIN_URL=http://langchain:8001/triage
      - OSTICKET_API_URL=${OSTICKET_API_URL}
      - OSTICKET_API_KEY=${OSTICKET_API_KEY}
      - SLACK_CHANNEL=#soc-alertas
      - DASHBOARD_BASE_URL=http://localhost:3000
      - SOCLITE_API_USER=${SOCLITE_API_USER}
      - SOCLITE_API_PASSWORD=${SOCLITE_API_PASSWORD}
      - REPORT_UPLOAD_URL=http://minio:9000/soc-lite-reports
      - REPORT_UPLOAD_AUTH=${REPORT_UPLOAD_AUTH}
      - REPORT_RECIPIENTS=soc_manager@org.local,ciso@org.local
    volumes:
      - n8n_data:/home/node/.n8n
      - ./reports:/data/reports
    networks: [soc-lite]
```

> `N8N_ENCRYPTION_KEY` **debe** fijarse; si cambia, n8n no puede descifrar las
> credenciales guardadas y hay que reasignarlas todas.

---

## 4. Configuración de credenciales

Crear en **Credentials → Add credential**:

### 4.1 PostgreSQL — `SOC-Lite PostgreSQL (soclite)`

| Campo | Valor |
|---|---|
| Host | `postgres` |
| Database | `soclite` |
| User | `soclite` (o `soclite_app` con permisos DML sobre `soclite.*`) |
| Password | `<POSTGRES_PASSWORD>` |
| Port | `5432` |
| SSL | `disable` en la red interna Docker; `require` si es gestionado |
| **Search Path** | `soclite, public` |

Asignar esta credencial a **todos los nodos PostgreSQL** (22 en total). Si no se define
*Search Path*, los nodos funcionan igual porque todas las consultas usan el nombre
cualificado `soclite.<tabla>`.

Permisos mínimos recomendados para el usuario de n8n:

```sql
GRANT USAGE ON SCHEMA soclite TO soclite_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA soclite TO soclite_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA soclite TO soclite_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA soclite
  GRANT SELECT, INSERT, UPDATE ON TABLES TO soclite_app;
-- La bitácora es inmutable: el usuario de n8n NUNCA debe tener DELETE/UPDATE sobre audit_log
REVOKE DELETE, UPDATE ON soclite.audit_log FROM soclite_app;
```

### 4.2 Slack — `SOC-Lite Slack (Bot OAuth)`

1. Crear una app en <https://api.slack.com/apps> (tipo *From scratch*).
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `chat:write.public`,
   `files:write` (si se adjuntan reportes), `channels:read`.
3. Instalar en el workspace e invitar al bot a `#soc-alertas`, `#soc-escalamientos`,
   `#soc-metricas`, `#soc-reportes` (`/invite @SOC-Lite`).
4. En n8n: credencial **Slack API → Access Token** = `xoxb-…`.

### 4.3 HTTP Header Auth (alternativa a la validación por Code)

El workflow 01 valida `X-Ingest-Key` en el nodo `1b · Validar y normalizar (Code)` para
poder comparar en tiempo constante y **auditar el intento fallido**. Si se prefiere una
credencial nativa:

1. **Credentials → Header Auth**: *Name* `X-Ingest-Key`, *Value* `<clave>`.
2. En el nodo Webhook, *Authentication → Header Auth* y seleccionar la credencial.
3. En el nodo 1b, comentar el bloque `if (!safeEqual(ingestKey, ENV_KEY))` (n8n ya
   rechazó la petición antes de llegar al workflow).

### 4.4 SMTP — `SOC-Lite SMTP` (workflow 05)

Host/puerto del relay corporativo, usuario, contraseña y *Secure* (STARTTLS). Remitente
por defecto en `SMTP_FROM`.

### 4.5 Telegram (opcional, variante del nodo 8b)

1. Crear el bot con `@BotFather` y obtener `TELEGRAM_BOT_TOKEN`.
2. Añadir el bot al grupo y obtener el `chat_id` (p. ej. `-1001234567890`).
3. En n8n: credencial **Telegram API** → *Access Token*.
4. Sustituir el nodo `8b · Variante Telegram (comentada)` por un nodo **Telegram**
   (`n8n-nodes-base.telegram`, `typeVersion 1.2`) con `chatId = {{ $env.TELEGRAM_CHAT_ID }}`
   y el mismo texto que el mensaje de Slack (plantilla lista en el propio nodo 8b).

### 4.6 Almacenamiento de reportes (workflow 05)

* **S3/MinIO** (por defecto, nodo `6`): `PUT` con `Authorization` precalculada en
  `REPORT_UPLOAD_AUTH`, o bien sustituir el nodo HTTP por un nodo **S3** con credencial
  *AWS (IAM)*.
* **Sistema de archivos compartido**: sustituir el nodo `6` por
  `n8n-nodes-base.readWriteFile` (`Write File`) con *File Name* `={{ $json.file_path }}` y
  *Data Property Name* `data`, montando el volumen `/data/reports` en el contenedor.

---

## 5. Orden de activación

```
1) soc_lite_triage_workflow            → ACTIVAR el primero (es el Error Workflow global)
2) soc_lite_dedup_suppression_workflow → activar
3) soc_lite_sla_escalation_workflow    → activar
4) soc_lite_metrics_aggregation_workflow → activar
5) soc_lite_report_generation_workflow → activar
```

Pasos previos obligatorios:

1. Cargar el esquema y los datos base:
   `psql -U soclite -d soclite -f db/schema.sql && psql … -f db/seed.sql`.
2. Verificar `/health/ready` del backend y `GET /health` del microservicio LangChain.
3. Crear las credenciales de la sección 4 y **asignarlas en todos los nodos**.
4. Definir `SOC_INGEST_KEY` y reiniciar el contenedor n8n.
5. Importar los cinco workflows y **registrar el Error Workflow global**:
   abrir cada workflow auxiliar (02–05) → **⋯ → Settings → Error Workflow** →
   `SOC-Lite · 01 · Triage automático de alertas (Wazuh/OPNsense → LLM → Ticket → Bitácora)`.
6. Activar en el orden indicado.

> En n8n el *Error Workflow* se referencia por **nombre**, por lo que no viene fijado en
> el JSON (evita dependencias frágiles entre instancias); hay que seleccionarlo una vez
> por workflow tras importar.

### Nota sobre la estructura del workflow 01

* **Nodos operativos (los 10 del diseño):** `1` Webhook · `2` IF · `3` PostgreSQL ·
  `4` HTTP LangChain · `5` Code post-triaje · `6` Switch · `7` PostgreSQL ·
  `8` Slack · `9b` HTTP ticket (+ `9c` PostgreSQL incidente) · `10` PostgreSQL bitácora.
* **Nodos de infraestructura:** `C · Set de entorno y variables globales` y
  `E · Error Trigger global` (+ `E1` de bitácora de fallo).
* **Nodos de apoyo:** `1b` (validación `X-Ingest-Key` y normalización), `3a` (contexto de
  activo), `7a` (relectura del estado), `6a`/`6b` (respuesta HTTP `202`), `9a`/`9d`
  (ticket), `8b` (variante Telegram comentada), `2b` (No-Op de descarte) y 4 *sticky notes*.

El nodo `C · Set de entorno` está conectado **antes** del Webhook de forma deliberada: es
la convención de n8n para garantizar que la configuración se evalúe en la misma ejecución
(en modo `executionOrder: v1` los nodos se ejecutan según el orden topológico). En el
editor aparece como el nodo de arranque del workflow; el disparador real sigue siendo el
Webhook.

---

## 6. Pruebas de humo

### 6.1 Ingesta de una alerta (workflow 01)

```bash
export INGEST_KEY="soclite_cambiar_esta_clave"
export N8N="http://localhost:5678"

curl -sS -i -X POST "$N8N/webhook/wazuh-alert" \
  -H "X-Ingest-Key: $INGEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2025-01-31T14:22:05.000Z",
    "rule": {
      "id": "5710",
      "level": 10,
      "description": "Attempt to login using a non-existent user",
      "groups": ["authentication_failed", "sshd"],
      "mitre": { "id": "T1110.001" }
    },
    "agent": { "id": "003", "name": "WKS-CONTAB01", "ip": "10.0.4.21" },
    "data": { "srcip": "203.0.113.44", "dstip": "10.0.4.21", "srcport": "51422", "dstport": "22" },
    "full_log": "sshd: Failed password for invalid user admin from 203.0.113.44"
  }'
```

Respuesta esperada (`202 Accepted`):

```json
{
  "accepted": true,
  "httpStatus": 202,
  "alert_id": 1043,
  "alert_fingerprint": "9f1c…64a",
  "was_duplicate": false,
  "dedup_count": 1,
  "severity": "high",
  "verdict": "true_positive",
  "risk_score": 93,
  "confidence": 0.91,
  "status": "escalated",
  "escalate": true,
  "trace_id": "b1f0e4a2-…",
  "dashboard_url": "http://localhost:3000/alerts/1043"
}
```

Pruebas negativas:

```bash
# Sin cabecera -> el nodo 1b lanza error; comprobar la entrada 'failure' en audit_log
curl -sS -i -X POST "$N8N/webhook/wazuh-alert" -H "Content-Type: application/json" -d '{"rule":{"id":"5710","level":10}}'

# Severidad baja (rule_level 5) -> descarte sin llamar al LLM (rama FALSE del IF)
curl -sS -i -X POST "$N8N/webhook/wazuh-alert" \
  -H "X-Ingest-Key: $INGEST_KEY" -H "Content-Type: application/json" \
  -d '{"rule":{"id":"5501","level":5,"description":"PAM: session opened"},"agent":{"name":"SRV-DB01"},"data":{"srcip":"10.0.4.21"}}'

# Idempotencia: reenviar el MISMO payload -> was_duplicate=true y dedup_count incrementado
```

Verificación en base de datos:

```sql
-- Última alerta con su triaje
SELECT a.id, a.severity, a.status, a.verdict, a.risk_score, a.dedup_count, a.mttt_seconds,
       t.model_name, t.confidence, t.trace_id
  FROM soclite.alerts a
  LEFT JOIN soclite.triage_results t ON t.alert_id = a.id AND t.is_current
 ORDER BY a.id DESC LIMIT 5;

-- Bitácora del triaje
SELECT id, occurred_at, username, module, action, entity_id, result, severity, trace_id
  FROM soclite.audit_log
 WHERE module = 'triage' ORDER BY id DESC LIMIT 10;

-- Incidente y ticket creados
SELECT id, incident_code, severity, priority, status, external_ticket_id, external_ticket_url
  FROM soclite.incidents ORDER BY id DESC LIMIT 5;
```

### 6.2 Deduplicación y supresión (workflow 02)

```bash
# Ejecución manual: n8n UI -> workflow 02 -> "Execute Workflow"
```

```sql
SELECT rule_id, source_ip, dedup_count, is_suppressed,
       raw_payload->'soc_lite_dedup' AS traza
  FROM soclite.alerts
 WHERE raw_payload ? 'soc_lite_dedup'
 ORDER BY id DESC LIMIT 10;
```

### 6.3 Escalado de SLA (workflow 03)

```sql
-- Fuerza una alerta pendiente a punto de vencer
UPDATE soclite.alerts
   SET status = 'pending', sla_due_at = now() + INTERVAL '3 minutes', closed_at = NULL
 WHERE id = (SELECT max(id) FROM soclite.alerts);

-- Ejecutar el workflow 03 desde la UI y luego:
SELECT id, status, triaged_at, sla_due_at FROM soclite.alerts ORDER BY id DESC LIMIT 3;
SELECT * FROM soclite.notifications WHERE payload->>'kind' = 'sla_escalation' ORDER BY id DESC LIMIT 5;
```

### 6.4 Métricas (workflow 04)

```bash
# Ejecución manual y comprobación del agregado
```

```sql
SELECT metric_date, source_type, severity, alerts_total, alerts_tp, alerts_fp,
       mttt_avg_sec, mttt_p95_sec, automation_rate
  FROM soclite.alert_metrics_daily ORDER BY metric_date DESC LIMIT 12;

SELECT payload FROM soclite.notifications WHERE payload->>'kind' = 'kpi_daily' ORDER BY id DESC LIMIT 1;
```

### 6.5 Reportes (workflow 05)

```bash
# Comprobar el endpoint con el JWT de servicio antes de ejecutar el workflow
TOKEN=$(curl -sS -X POST "http://localhost:8000/api/v1/auth/login" \
  -d "username=$SOCLITE_API_USER&password=$SOCLITE_API_PASSWORD" | jq -r .access_token)

curl -sS -o /tmp/reporte.pdf -w '%{http_code} %{content_type} %{size_download}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/v1/reports/operational?format=pdf&from=2025-01-24T00:00:00Z&to=2025-01-31T00:00:00Z"
```

```sql
SELECT id, report_type, report_format, title, file_path, file_size, checksum_sha256,
       status, expires_at
  FROM soclite.generated_reports ORDER BY id DESC LIMIT 5;

SELECT id, module, action, entity_id, detail FROM soclite.audit_log
 WHERE module = 'reports' AND action = 'EXPORT' ORDER BY id DESC LIMIT 5;
```

Comparar el `checksum_sha256` de `generated_reports` con el de la respuesta de Slack o el
correo, y con el del archivo en disco/S3 (`sha256sum`), para validar la integridad.

---

## 7. Operación y diagnóstico

| Síntoma | Causa probable | Acción |
|---|---|---|
| `401 No autorizado: header X-Ingest-Key…` en los logs | Clave ausente/incorrecta o `SOC_INGEST_KEY` vacía | Revisar la variable en el contenedor y el header del cliente |
| El nodo LangChain agota los 3 intentos | Microservicio LLM caído o *timeout* de Ollama > 120 s | `curl http://langchain:8001/health`; revisar GPU/CPU del host |
| `uq_triage_current` violado | Dos ejecuciones simultáneas de la misma alerta | Reintentar; el nodo 7 ya demota el triaje anterior con `is_current=false` |
| Nodo Slack `channel_not_found` | El bot no está invitado al canal | `/invite @SOC-Lite` en el canal |
| `Credential not found` tras importar | La API ignora los `credentials` del JSON | Reasignar credenciales (sección 4) |
| Error Trigger no registra nada | No se fijó el *Error Workflow* en el workflow que falla | Registrar el workflow 01 como *Error Workflow* (sección 5) |
| El reporte semanal no se sube | `REPORT_UPLOAD_URL`/`REPORT_UPLOAD_AUTH` incorrectos | Probar el `PUT` con `curl --upload-file` |
| Alertas duplicadas sin agrupar | `occurred_at` fuera de la ventana de 5 min | Ajustar el bucket en el nodo 1b (constante `300000` ms) |

**Reintentos configurados**

| Nodo | `retryOnFail` | `maxTries` | `waitBetweenTries` | `timeout` |
|---|---|---|---|---|
| 01 · 4 HTTP `/triage` | sí | 3 | 2 000 ms | 120 s |
| 01 · 9b HTTP ticket | sí | 3 | 3 000 ms | 30 s |
| 05 · 3 HTTP login | sí | 3 | 2 000 ms | 15 s |
| 05 · 4 HTTP reporte | sí | 3 | 5 000 ms | 300 s |
| 05 · 6 HTTP subida | sí | 3 | 3 000 ms | 120 s |

`continueOnFail: true` en: `01 · 3a` (contexto de activo), `01 · 9c` (incidente/ticket),
`02 · 8` (traza de deduplicación), `03 · 7` (registro de notificación),
`04 · 5` (ANALYZE), `04 · 7` (snapshot de KPIs), `05 · 7` (registro del reporte),
`05 · 11` (correo).

**Consultas de vigilancia**

```sql
-- Ejecuciones fallidas más recientes (vía Error Trigger global)
SELECT occurred_at, username, module, entity_id, detail
  FROM soclite.audit_log
 WHERE result = 'failure' ORDER BY id DESC LIMIT 20;

-- Salud del pipeline (últimas 24 h)
SELECT count(*) AS ingeridas,
       count(*) FILTER (WHERE status = 'pending')   AS pendientes,
       count(*) FILTER (WHERE status = 'escalated') AS escaladas,
       count(*) FILTER (WHERE is_suppressed)        AS suprimidas,
       round(avg(mttt_seconds))                     AS mttt_medio
  FROM soclite.alerts WHERE occurred_at > now() - INTERVAL '24 hours';
```

---

## 8. Estructura de archivos

```
n8n/
├── README.md                                       ← este documento
├── soc_lite_triage_workflow.json                   ← 01 (núcleo, Webhook + Error Trigger)
├── soc_lite_dedup_suppression_workflow.json        ← 02 (Schedule 5 min)
├── soc_lite_sla_escalation_workflow.json           ← 03 (Schedule 5 min)
├── soc_lite_metrics_aggregation_workflow.json      ← 04 (Schedule 00:30)
└── soc_lite_report_generation_workflow.json        ← 05 (Schedule lunes 07:00)
```

Todos los JSON están validados sintácticamente
(`Get-Content -Raw | ConvertFrom-Json`) y el JavaScript de los 12 nodos `Code` valida
como cuerpo de una función `async` (el envoltorio que usa n8n).
