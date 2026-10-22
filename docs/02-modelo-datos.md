# SOC-Lite · Modelo de datos PostgreSQL y datos semilla

Archivos: [`db/schema.sql`](../db/schema.sql) · [`db/seed.sql`](../db/seed.sql) · [`db/synthetic_data.sql`](../db/synthetic_data.sql)

---

## 1. Justificación de PostgreSQL como base principal

| Requisito del sistema | Capacidad de PostgreSQL que lo resuelve |
|---|---|
| Payloads crudos del SIEM de forma heterogénea | `JSONB` con índices **GIN** (`jsonb_path_ops`) y consultas por ruta |
| Direcciones IP y MAC como datos de primera clase | Tipos nativos `INET` y `MACADDR` con operadores de red (`<<`, `>>`) |
| Grupos de reglas y técnicas MITRE (listas) | Tipo `ARRAY` con índices GIN |
| Percentiles de MTTT (mediana, P95) en tiempo real | `percentile_cont() WITHIN GROUP` — no requiere ETL externo |
| Búsqueda difusa sobre descripciones de reglas | Extensión `pg_trgm` + índice GIN `gin_trgm_ops` |
| Inmutabilidad de la evidencia de auditoría | `RULE ... DO INSTEAD NOTHING` + trigger de encadenamiento sha256 con `pgcrypto` |
| Reportes que no degradan el dashboard | Tabla de agregados `alert_metrics_daily` refrescada por job |
| Enumeraciones validadas en el motor | Tipos `ENUM` nativos (8 tipos) |
| Transaccionalidad ACID en la ingesta | MVCC con niveles de aislamiento configurables |

**Descartados:** MongoDB (no aporta integridad referencial para RBAC ni percentiles nativos),
Elasticsearch (coste operativo y de licencia; se reserva como destino de logs si el
volumen lo exige), MySQL (sin `INET`/`ARRAY`/`JSONB` equivalente ni reglas de inmutabilidad).

---

## 2. Diagrama entidad-relación (lógico)

```
                       ┌──────────────┐        ┌──────────────────┐
                       │   users      │───┐    │   permissions    │
                       │ (RBAC)       │   │    │ code module:action│
                       └──────┬───────┘   │    └────────┬─────────┘
                              │           │             │
                       ┌──────▼───────┐   │    ┌────────▼─────────┐
                       │  user_roles  │   └───▶│  role_permissions│
                       └──────┬───────┘        └────────▲─────────┘
                              │                         │
                       ┌──────▼───────┐                 │
                       │    roles     │─────────────────┘
                       └──────────────┘
                              ▲
                              │ granted_by
                              │
   ┌───────────┐      ┌───────┴────────┐      ┌──────────────────┐
   │  assets   │◀─────│    alerts      │─────▶│  enrichment_data │
   │ hostname  │      │ fingerprint UQ │      │ provider/indicator│
   │ criticality│     │ severity/status│      └──────────────────┘
   └───────────┘      │ risk_score     │
                      │ mttt/mttr      │      ┌──────────────────┐
                      └───────┬────────┘─────▶│  triage_results  │
                              │               │ verdict/confidence│
                              │               │ is_current (unique)│
                              │               └──────────────────┘
                              │
                      ┌───────▼────────┐        ┌─────────────────┐
                      │ incident_alerts│───────▶│   incidents     │
                      └────────────────┘        └────────┬────────┘
                                                         │
                                                ┌────────▼─────────┐
                                                │ incident_actions │
                                                └──────────────────┘

   ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐   ┌────────────────┐
   │  audit_log   │   │ refresh_tokens│   │  integrations    │   │ notifications  │
   │ inmutable    │   │ (rotación)    │   │ (SIEM/TI/tickets)│   │ (cola salida)  │
   │ hash chain   │   └───────────────┘   └──────────────────┘   └────────────────┘
   └──────────────┘

   ┌──────────────────────┐   ┌──────────────┐   ┌──────────────────┐
   │ alert_metrics_daily  │   │ kpi_targets  │   │ generated_reports│
   │ (agregados por día)  │   │ (objetivos)  │   │ (PDF/Word/Excel) │
   └──────────────────────┘   └──────────────┘   └──────────────────┘
```

---

## 3. Diccionario de datos

### 3.1 `users` — cuentas de acceso

| Columna | Tipo | Restricción | Descripción |
|---|---|---|---|
| `id` | BIGSERIAL | PK | Identificador |
| `username` | VARCHAR(64) | UNIQUE, NOT NULL, ≥3 caracteres | Nombre de usuario |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL | Correo (login alternativo) |
| `full_name` | VARCHAR(160) | NOT NULL | Nombre completo |
| `hashed_password` | TEXT | NOT NULL | bcrypt (coste 12) |
| `is_active` | BOOLEAN | DEFAULT TRUE | Alta/baja lógica |
| `is_system` | BOOLEAN | DEFAULT FALSE | Cuenta protegida (no desactivable) |
| `must_change_pwd` | BOOLEAN | DEFAULT FALSE | Forzar cambio en el próximo acceso |
| `mfa_enabled` / `mfa_secret` | BOOLEAN / TEXT | | TOTP opcional |
| `failed_attempts` | SMALLINT | DEFAULT 0 | Contador anti fuerza bruta |
| `locked_until` | TIMESTAMPTZ | | Bloqueo temporal |
| `last_login_at` / `last_login_ip` | TIMESTAMPTZ / INET | | Último acceso |
| `deleted_at` | TIMESTAMPTZ | | Borrado lógico |

### 3.2 `roles` · `permissions` · tablas puente

| Tabla | Clave | Contenido |
|---|---|---|
| `roles` | `code` UNIQUE | 5 roles de sistema: `admin`, `soc_manager`, `analyst`, `auditor`, `viewer` |
| `permissions` | `code` UNIQUE | 22 permisos con formato `modulo:accion` |
| `user_roles` | (user_id, role_id) | Incluye `granted_by` y `granted_at` (trazabilidad de la asignación) |
| `role_permissions` | (role_id, permission_id) | Matriz de acceso |

### 3.3 `assets` — inventario (contexto del triaje)

`hostname` UNIQUE, `ip_address` INET, `asset_type` (server/workstation/firewall/ot/cloud/mobile),
`criticality` (low/medium/high/critical), `is_internet_facing`, `tags` TEXT[].

> **Por qué importa:** el agente LLM recibe `asset_criticality` y `is_internet_facing`.
> Un beaconing desde un PLC (activo OT crítico) se clasifica distinto que desde una
> estación de RRHH, con la misma regla del SIEM.

### 3.4 `alerts` — núcleo del sistema (nodos 3, 7 de n8n)

| Columna | Tipo | Descripción |
|---|---|---|
| `alert_fingerprint` | VARCHAR(255) UNIQUE | `sha256(source_type\|rule_id\|source_ip\|bucket 5 min)` — **clave de idempotencia** |
| `source_type` | ENUM | wazuh / opnsense / suricata / zeek / manual / api |
| `rule_id`, `rule_level`, `rule_description`, `rule_groups` | | Datos de la regla del SIEM |
| `severity` | ENUM | Normalizada: info/low/medium/high/critical |
| `severity_raw` | SMALLINT | Nivel original (0–15 Wazuh) — trazabilidad de la normalización |
| `status` | ENUM | pending → enriching → triaged → escalated → closed / false_positive |
| `source_ip`, `dest_ip`, `source_port`, `dest_port`, `protocol` | INET/INT | Red |
| `agent_name`, `agent_id`, `asset_id` | | Activo afectado (FK a `assets`) |
| `mitre_technique`, `mitre_tactic` | VARCHAR | Etiquetado ATT&CK |
| `full_log` | TEXT | Log completo (entrada del LLM) |
| `raw_payload` | JSONB | Evento crudo íntegro (**evidencia**, ISO A.5.28) |
| `risk_score` | SMALLINT 0–100 | Score ponderado (CHECK) |
| `verdict` | ENUM | Veredicto del triaje |
| `dedup_count` | INTEGER DEFAULT 1 | Repeticiones agrupadas |
| `mttt_seconds` / `mttr_seconds` | INTEGER | Métricas calculadas por trigger |
| `sla_due_at` | TIMESTAMPTZ | Vencimiento según severidad |

**Índices:** 8 índices incluyendo compuestos (`status, severity, occurred_at DESC`),
parciales (`assigned_to WHERE status NOT IN ('closed','false_positive')`),
GIN sobre `raw_payload`, `rule_groups` y búsqueda trgm sobre `rule_description`.

**Triggers:**
- `trg_touch_alerts`: actualiza `updated_at`.
- `trg_alerts_mttt`: calcula automáticamente `mttt_seconds` al pasar a `triaged`,
  `mttr_seconds`/`closed_at` al cerrar, y `sla_due_at` según severidad
  (crítica 15 min, alta 1 h, media 8 h, baja 24 h).

### 3.5 `enrichment_data` — indicadores consultados

`provider` (virustotal/abuseipdb/geoip/shodan/otx/misp/whois), `indicator` + `indicator_type`
(ip/domain/url/hash/email/cve), `verdict`, `score`, `malicious_count`, `total_engines`,
`country`, `asn`, `as_owner`, `raw_response` JSONB, `cache_hit`, `expires_at`.

`UNIQUE (alert_id, provider, indicator, indicator_type)` → idempotencia del enriquecimiento.

### 3.6 `triage_results` — salida del agente LLM

| Columna | Descripción |
|---|---|
| `verdict`, `severity`, `risk_score`, `confidence` | Clasificación con CHECK de rango |
| `summary` | Resumen ejecutivo en lenguaje natural |
| `reasoning` JSONB | Cadena de razonamiento (**trazabilidad de la decisión automatizada**) |
| `recommended_actions` JSONB | `[{order, action, priority, automated}]` |
| `mitre_techniques` TEXT[], `iocs` JSONB | Etiquetado y evidencia |
| `model_name`, `model_provider`, `prompt_version`, `temperature` | **Reproducibilidad**: con qué modelo y prompt se decidió |
| `tokens_in/out`, `cost_usd`, `latency_ms`, `tools_used` | Coste y rendimiento |
| `trace_id`, `langsmith_run_id` | Correlación con trazas end-to-end |
| `human_feedback`, `feedback_comment`, `feedback_by`, `feedback_at` | Verdad de campo para medir precisión |
| `is_current` | Índice único parcial: sólo un triaje vigente por alerta |

### 3.7 `incidents` · `incident_alerts` · `incident_actions`

`incidents.incident_code` UNIQUE con formato `INC-YYYY-NNNNN`, `status`, `priority` (p1–p4),
`severity`, `category`, `mitre_tactics`, marcas temporales (`detected_at`, `contained_at`,
`resolved_at`, `closed_at`), `owner_id`, `external_ticket_id/url`, `impact`, `root_cause`,
`lessons_learned`. La propiedad `mttr_seconds` se calcula desde `detected_at`/`resolved_at`.

`incident_actions` registra la respuesta: `isolate_host`, `block_ip`, `reset_credentials`,
`ticket`, `notify`, `forensics`, con `automated` (bool), `status` y `result` JSONB.

### 3.8 `audit_log` — bitácora inmutable (requisito obligatorio)

**Campos exigidos por el requisito:** `username`/`user_id` (usuario), `occurred_at`
(fecha + hora con zona), `module` (módulo), `action` (acción realizada), `result` (resultado).

**Campos adicionales de valor probatorio:** `entity`/`entity_id`, `before_data`/`after_data`/`changes`
(diff automático), `ip_address`, `user_agent`, `http_method`/`http_path`/`http_status`,
`duration_ms`, `trace_id`, `severity`, `hash_prev`/`hash_self`.

**Mecanismos de inmutabilidad:**

```sql
-- 1. Reglas: se ignora cualquier UPDATE o DELETE
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- 2. Trigger: encadenamiento sha256 (hash_prev → hash_self)
CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
```

**Módulos auditables:** `auth`, `users`, `roles`, `alerts`, `triage`, `incidents`,
`dashboard`, `reports`, `audit`, `settings`, `integrations`.
**Acciones normalizadas:** `LOGIN`, `LOGOUT`, `LOGIN_FAILED`, `CREATE`, `READ`, `UPDATE`,
`DELETE`, `EXPORT`, `TRIAGE_RUN`, `TRIAGE_FEEDBACK`, `ROLE_ASSIGN`, `CONFIG_CHANGE`.

### 3.9 Tablas de soporte

| Tabla | Propósito |
|---|---|
| `refresh_tokens` | Rotación de sesiones; se guarda `token_hash` (sha256), nunca el token |
| `integrations` | Catálogo de conectores con `secret_ref` (referencia, no secreto) |
| `notifications` | Cola de salida con `status` (queued/sent/failed) y `attempts` |
| `generated_reports` | Metadatos del artefacto: ruta, tamaño, `checksum_sha256`, parámetros |
| `alert_metrics_daily` | Agregados por día/origen/severidad para el dashboard |
| `kpi_targets` | Objetivos de gestión (`mttt_critical`, `fp_rate`, `sla_compliance_critical`…) |

### 3.10 Vistas de apoyo

| Vista | Contenido |
|---|---|
| `v_alert_triage` | Alerta + triaje vigente + severidad del SIEM vs. del LLM (**detección de deriva**) |
| `v_fp_rate_by_rule` | Tasa de falsos positivos y MTTT por regla |
| `v_mttt_daily` | MTTT promedio y P95 diario por severidad |
| `v_analyst_workload` | Carga por analista (abiertas / escaladas / cerradas) |

---

## 4. Datos semilla

Ejecución: `psql -U soclite -d soclite -f db/seed.sql`

| Bloque | Contenido |
|---|---|
| Permisos | 22 permisos agrupados en 10 módulos |
| Roles | 5 roles con su matriz de permisos (`admin` con los 22) |
| Usuarios | 6 cuentas demo con contraseñas bcrypt (`crypt(..., gen_salt('bf',12))`) |
| Activos | 8 activos realistas: controlador de dominio, servidor de BD, web en DMZ, firewall perimetral, estaciones de Finanzas y RRHH, servidor de correo y **PLC de planta (OT)** |
| KPI | 6 objetivos de gestión alineados a la tabla de resultados del sistema |
| Integraciones | 10 conectores (Wazuh, OPNsense, VirusTotal, AbuseIPDB, GeoIP, Slack, Telegram, osTicket, Ollama, LangChain) |
| Alertas | 5 alertas representativas: fuerza bruta SSH (TP alto), escaneo autorizado (benigno), beaconing Cobalt Strike desde PLC OT (crítico escalado), sesión PAM por cron (FP), ransomware pendiente |
| Triajes | 4 resultados con razonamiento, acciones recomendadas, IOCs y retroalimentación humana |
| Enriquecimiento | 3 indicadores (AbuseIPDB 94/100, VirusTotal 52/72, GeoIP limpio con caché) |
| Incidentes | `INC-2025-00088` con 2 acciones de respuesta ya ejecutadas |
| Bitácora | 10 eventos que cubren login/logout, lectura, triaje, feedback, export, asignación de rol y **un `LOGIN_FAILED` crítico** |

**Credenciales demo** (cambiar en producción):

| Usuario | Contraseña | Rol | Uso para demostrar |
|---|---|---|---|
| `admin` | `Admin123!` | admin | Configuración, usuarios, roles |
| `soc_manager` | `Manager123!` | soc_manager | Reportes gerenciales, incidentes |
| `analista1` | `Analyst123!` | analyst | Triaje, feedback, gestión de alertas |
| `auditor1` | `Audit123!` | auditor | Bitácora y reportes de auditoría (solo lectura) |
| `visor1` | `Viewer123!` | viewer | Dashboard de solo lectura (RBAC demostrable) |

---

## 5. Datos sintéticos para pruebas de carga

`db/synthetic_data.sql` define la función `generate_synthetic_alerts(count, days_back)`:

```sql
SELECT soclite.generate_synthetic_alerts(5000, 30);
ANALYZE soclite.alerts;
```

Genera alertas realistas con distribución de severidad ponderada, tasas de falsos
positivos diferenciadas por severidad (92 % en `info` … 8 % en `critical`), triajes
asociados con tres modelos distintos, enriquecimiento aleatorio y recalcula
`alert_metrics_daily` al final. Permite validar el dashboard y los percentiles con
volumen representativo de una PYME mediana (≈5.000 alertas/mes).

---

## 6. Operación y mantenimiento

| Tarea | Frecuencia | Comando / mecanismo |
|---|---|---|
| Respaldo completo cifrado | Diario 01:00 | `pg_dump -Fc` + `gpg` → almacenamiento externo |
| Recalcular agregados | Diario 00:30 | Workflow n8n `soc_lite_metrics_aggregation` o `POST /dashboard/refresh-metrics` |
| Verificar integridad de bitácora | Semanal | `GET /api/v1/audit/verify-chain` |
| `VACUUM ANALYZE` | Semanal | `cron` sobre las tablas de mayor rotación |
| Archivado de `audit_log` | Mensual | Particionado por mes + export a almacenamiento frío (retención 12 meses) |
| Rotación de secretos | Trimestral | `.env`/Vault + `CONFIG_CHANGE` en bitácora |
