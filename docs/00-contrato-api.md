# SOC-Lite — Contrato de API canónico (v1)

> **Documento normativo.** Backend, microservicio LangChain, frontend y workflows n8n se
> construyen contra este contrato. Cualquier cambio aquí obliga a actualizar los tres.

- **Base URL backend:** `http://localhost:8000/api/v1`
- **Base URL microservicio LLM:** `http://localhost:8001` (red interna, nunca expuesto a Internet)
- **Autenticación:** OAuth2 Password Bearer (JWT HS256, `access_token` 30 min, `refresh_token` 8 h)
- **Formato:** JSON UTF-8, fechas ISO-8601 con zona (`2025-01-31T14:22:05-05:00`)
- **Paginación:** `?page=1&page_size=25` → envelope `{items, total, page, page_size, pages}`
- **Errores:** `{"detail": "...", "code": "ALERT_NOT_FOUND", "trace_id": "..."}`
- **Idempotencia:** `POST /alerts/ingest` acepta `Idempotency-Key` (o `alert_fingerprint` en el cuerpo).

## Enumeraciones (compartidas backend ↔ frontend ↔ n8n)

```
severity_level : info | low | medium | high | critical
alert_status   : pending | enriching | triaged | escalated | closed | false_positive
triage_verdict : true_positive | false_positive | benign | suspicious | inconclusive
incident_status: open | in_progress | contained | resolved | closed
priority       : p1 | p2 | p3 | p4
source_type    : wazuh | opnsense | suricata | zeek | manual | api
```

## 1. Autenticación y sesión

| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| POST | `/auth/login` | público | `application/x-www-form-urlencoded` (`username`,`password`). Devuelve tokens + perfil + permisos. Registra `LOGIN` en bitácora. |
| POST | `/auth/refresh` | público (refresh válido) | Rota el refresh token. |
| POST | `/auth/logout` | autenticado | Revoca refresh token. Registra `LOGOUT`. |
| GET | `/auth/me` | autenticado | Perfil, roles y permisos efectivos. |
| POST | `/auth/change-password` | autenticado | Cambio de contraseña con verificación de la anterior. |

`POST /auth/login` → `200`:
```json
{
  "access_token": "eyJ...", "refresh_token": "eyJ...", "token_type": "bearer",
  "expires_in": 1800,
  "user": {"id": 3, "username": "analista1", "email": "a1@org.local",
           "full_name": "Ana Torres", "roles": ["analyst"], "permissions": ["alerts:read","alerts:write"]}
}
```

## 2. Usuarios, roles y permisos (RBAC)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/users` | `users:read` | Lista paginada; filtros `q`, `is_active`, `role`. |
| POST | `/users` | `users:write` | Alta de usuario. |
| GET | `/users/{id}` | `users:read` | Detalle con roles. |
| PUT | `/users/{id}` | `users:write` | Actualización (email, full_name, is_active). |
| DELETE | `/users/{id}` | `users:delete` | Baja lógica (`is_active=false`). |
| POST | `/users/{id}/roles` | `users:write` | Asigna roles `{"roles": ["analyst","auditor"]}`. |
| GET | `/roles` | `roles:read` | Lista de roles con permisos y nº de usuarios. |
| POST | `/roles` | `roles:write` | Alta de rol + permisos. |
| PUT | `/roles/{id}` | `roles:write` | Edición (nombre, descripción, permisos). |
| DELETE | `/roles/{id}` | `roles:delete` | Baja lógica; bloquea roles de sistema. |
| GET | `/permissions` | `roles:read` | Catálogo de permisos agrupado por módulo. |

Permisos del sistema (formato `modulo:accion`):
`dashboard:read`, `alerts:read`, `alerts:write`, `alerts:delete`, `triage:read`, `triage:run`,
`incidents:read`, `incidents:write`, `assets:read`, `assets:write`, `reports:read`,
`reports:export`, `users:read`, `users:write`, `users:delete`, `roles:read`, `roles:write`,
`roles:delete`, `audit:read`, `audit:export`, `settings:read`, `settings:write`.

Roles de sistema: `admin`, `soc_manager`, `analyst`, `auditor`, `viewer`.

## 3. Alertas

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| POST | `/alerts/ingest` | API key de ingesta | Punto de entrada de Wazuh/OPNsense (llamado por n8n o directo). |
| GET | `/alerts` | `alerts:read` | Filtros: `severity`, `status`, `source_type`, `assigned_to`, `from`, `to`, `q`, `min_risk_score`, `has_triage`. |
| GET | `/alerts/{id}` | `alerts:read` | Detalle + enriquecimiento + triaje + incidente + timeline. |
| PATCH | `/alerts/{id}` | `alerts:write` | `{"status": "...", "assigned_to": 4, "notes": "..."}`. |
| POST | `/alerts/bulk/status` | `alerts:write` | `{"ids": [1,2], "status": "closed"}`. |
| GET | `/alerts/{id}/enrichment` | `triage:read` | Indicadores consultados (VT, AbuseIPDB, GeoIP). |
| GET | `/alerts/{id}/timeline` | `alerts:read` | Eventos ordenados de la alerta. |
| DELETE | `/alerts/{id}` | `alerts:delete` | Borrado lógico. |

`GET /alerts` → `200`:
```json
{
  "items": [{
    "id": 1042, "alert_fingerprint": "wazuh:5710:10.0.4.21:2025-01-31T14:22:05Z",
    "rule_id": "5710", "rule_description": "Attempt to login using a non-existent user",
    "source_type": "wazuh", "agent_name": "SRV-DC01", "source_ip": "10.0.4.21",
    "dest_ip": "10.0.0.5", "severity": "high", "severity_raw": 10,
    "status": "triaged", "risk_score": 82, "verdict": "true_positive",
    "occurred_at": "2025-01-31T14:22:05-05:00", "created_at": "2025-01-31T14:22:31-05:00",
    "mttt_seconds": 47, "assigned_to": 3, "incident_id": 88
  }],
  "total": 318, "page": 1, "page_size": 25, "pages": 13
}
```

## 4. Triaje (LangChain)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| POST | `/triage/{alert_id}/run` | `triage:run` | Fuerza (re)ejecución del triaje; soporta `?force=true`. |
| GET | `/triage/results` | `triage:read` | Lista de triajes con métricas de confianza y tokens. |
| GET | `/triage/{alert_id}` | `triage:read` | Último triaje de la alerta. |
| POST | `/triage/{alert_id}/feedback` | `triage:read` | Etiqueta humana `{"is_false_positive": true, "comment": "..."}` — alimenta la tasa de FP. |
| GET | `/triage/stats` | `triage:read` | Precisión del modelo, distribución por veredicto, latencias y uso de herramientas. |

`GET /triage/stats?days=30` → `200`:
```json
{
  "period": {"from": "2025-01-01T00:00:00Z", "to": "2025-01-31T23:59:59Z"},
  "total_triages": 4382, "total_triaged": 4382,
  "by_verdict": {"true_positive": 512, "false_positive": 3218, "benign": 402,
                 "suspicious": 180, "inconclusive": 70},
  "verdict_distribution": {"true_positive": 512, "false_positive": 3218, "benign": 402,
                           "suspicious": 180, "inconclusive": 70},
  "by_severity": {"critical": 96, "high": 512, "medium": 1480, "low": 1700, "info": 594},
  "by_model": [{"model_name": "llama3.1:8b", "prompt_version": "triage_v3", "runs": 4100,
                "avg_latency_ms": 6180.0, "avg_confidence": 0.83, "tokens_in": 8840000,
                "tokens_out": 1520000, "cost_usd": 0.0, "fp_rate": 0.734}],
  "latency_ms": {"avg": 6180.0, "median": 5400.0, "p95": 12400.0, "max": 41000.0},
  "tools_usage": [{"tool": "abuseipdb_lookup", "count": 3900},
                  {"tool": "geoip_lookup", "count": 4382}],
  "precision": 0.137, "recall": 0.912, "f1": 0.239,
  "false_positive_rate": 0.734,
  "human_confirmed_tp": 480, "human_confirmed_fp": 3100,
  "agreement_with_human": 0.941, "accuracy": 0.941,
  "avg_confidence": 0.83, "avg_latency_ms": 6180.0, "avg_tokens": 2364.0
}
```

> **Nota de compatibilidad:** los pares `total_triages`/`total_triaged`,
> `by_verdict`/`verdict_distribution` y `avg_latency_ms`/`latency_ms.avg` transportan el
> mismo dato con la nomenclatura canónica y con el alias que consumen los widgets del
> frontend. Se mantienen ambos para que ningún consumidor transforme datos en el cliente.

**Contrato interno backend → microservicio LangChain** `POST http://langchain:8001/triage`:
```json
// request
{ "alert_id": 1042, "trace_id": "b1f0…",
  "alert": { "rule_id": "5710", "rule_description": "...", "severity_raw": 10,
             "source_ip": "10.0.4.21", "dest_ip": "10.0.0.5", "agent_name": "SRV-DC01",
             "full_log": "...", "occurred_at": "2025-01-31T14:22:05Z" },
  "context": { "recent_alerts_same_source": 6, "asset_criticality": "high",
               "known_false_positives": 0, "policy": { "allow_external_llm": false } } }
// response
{ "trace_id": "b1f0…", "verdict": "true_positive", "severity": "high", "risk_score": 82,
  "confidence": 0.87, "summary": "Fuerza bruta…", "reasoning": ["…","…"],
  "recommended_actions": [{"order":1,"action":"Bloquear IP…","priority":"p1"}],
  "mitre_techniques": ["T1110.001"], "indicators": [{"type":"ip","value":"10.0.4.21","verdict":"malicious","source":"abuseipdb","score":94}],
  "model": "llama3.1:8b", "prompt_version": "triage_v3", "tokens_in": 2210, "tokens_out": 380,
  "latency_ms": 6400, "tools_used": ["abuseipdb_lookup","geoip_lookup","wazuh_context"] }
```

## 5. Incidentes

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/incidents` | `incidents:read` | Filtros `status`, `priority`, `from`, `to`. |
| POST | `/incidents` | `incidents:write` | Creación manual o desde triaje. |
| GET | `/incidents/{id}` | `incidents:read` | Detalle + alertas vinculadas + acciones. |
| PUT | `/incidents/{id}` | `incidents:write` | Actualización de estado, prioridad, responsables. |
| POST | `/incidents/{id}/alerts` | `incidents:write` | Vincula alertas `{"alert_ids": [1042]}`. |
| POST | `/incidents/{id}/actions` | `incidents:write` | Acción de respuesta (contener, aislar, ticket). |
| GET | `/incidents/{id}/ticket` | `incidents:read` | Ticket externo (osTicket/Redmine) asociado. |

## 6. Dashboard (métricas)

| Método | Ruta | Permiso | Devuelve |
|---|---|---|---|
| GET | `/dashboard/summary` | `dashboard:read` | KPIs: total alertas, por severidad, pendientes, MTTT medio/mediana, tasa FP, % automatizado. |
| GET | `/dashboard/alerts-by-severity?from&to&granularity=day` | `dashboard:read` | Serie temporal por severidad. |
| GET | `/dashboard/mttt-trend?days=30` | `dashboard:read` | MTTT diario + objetivo SLA. |
| GET | `/dashboard/top-sources?limit=10` | `dashboard:read` | Top IPs/agentes/reglas origen. |
| GET | `/dashboard/fp-rate` | `dashboard:read` | Tasa de falsos positivos global, por regla y por modelo. |
| GET | `/dashboard/sla-compliance` | `dashboard:read` | Cumplimiento de SLA por severidad (crítica < 15 min, alta < 1 h). |
| GET | `/dashboard/analyst-workload` | `dashboard:read` | Carga por analista (abiertas/escaladas/cerradas). |
| GET | `/dashboard/verdicts` | `dashboard:read` | Distribución de veredictos del triaje (gráfico circular). |
| POST | `/dashboard/refresh-metrics` | `settings:write` | Recalcula `alert_metrics_daily` y ejecuta `ANALYZE`. |

**Esquemas de respuesta de los widgets.** Todos incluyen la nomenclatura canónica **y** los
alias normalizados que consume el frontend, para evitar transformaciones en el cliente:

```jsonc
// GET /dashboard/alerts-by-severity
[{ "period": "2025-01-31T00:00:00Z", "critical": 4, "high": 18, "medium": 63,
   "low": 92, "info": 21, "total": 198 }]

// GET /dashboard/mttt-trend  (date/mttt_avg_sec/target_sla_sec son alias de period/mttt_avg/target_seconds)
[{ "period": "2025-01-31T00:00:00Z", "mttt_avg": 168.4, "mttt_p95": 640.0,
   "target_seconds": 3600, "alerts": 198, "date": "2025-01-31",
   "mttt_avg_sec": 168.4, "mttt_p95_sec": 640.0, "target_sec": 3600, "target_sla_sec": 3600 }]

// GET /dashboard/top-sources
{ "source_ips": [{ "key": "203.0.113.44", "label": "ip", "count": 312,
                   "extra": {"avg_risk": 78.2}, "value": "203.0.113.44",
                   "name": "203.0.113.44", "avg_risk_score": 78.2 }],
  "agents":    [{ "key": "WKS-CONTAB01", "agent_name": "WKS-CONTAB01", "count": 145 }],
  "rules":     [{ "key": "5710", "rule_id": "5710", "rule_description": "Attempt to login…",
                  "count": 187, "avg_risk_score": 82.0 }],
  "mitre":     [{ "key": "T1110.001", "count": 187 }] }

// GET /dashboard/fp-rate
{ "global_rate": 0.734, "total_triaged": 4382, "total_fp": 3218, "false_positives": 3218,
  "human_agreement_rate": 0.941,
  "by_rule":  [{ "key": "5710", "rule_id": "5710", "rule_description": "Attempt to login…",
                 "count": 187, "fp": 42, "fp_pct": 0.2246, "total": 187, "extra": {"fp": 42} }],
  "by_model": [{ "key": "llama3.1:8b", "model_name": "llama3.1:8b", "prompt_version": "triage_v3",
                 "count": 4100, "total": 4100, "fp": 3010, "fp_pct": 0.7341,
                 "extra": {"avg_confidence": 0.83} }] }

// GET /dashboard/sla-compliance
{ "items": [{ "severity": "critical", "target_minutes": 15, "compliant": 94, "breached": 2,
              "compliance_rate": 0.9792, "total": 96, "compliance": 0.9792,
              "target": 900, "avg_seconds": 168.4 }],
  "by_severity": { "critical": 0.9792, "high": 0.9414 },
  "period": { "from": "2025-01-01T00:00:00Z", "to": "2025-01-31T23:59:59Z" } }

// GET /dashboard/analyst-workload  (abiertas/escaladas/cerradas son alias de open_alerts/escalated/closed)
[{ "user_id": 3, "username": "analista1", "full_name": "Ana Torres",
   "open_alerts": 41, "escalated": 12, "closed": 380, "avg_mttt_seconds": 154.2,
   "abiertas": 41, "escaladas": 12, "cerradas": 380, "mttt_promedio": 154.2, "total": 433 }]
```

`GET /dashboard/summary` → `200`:
```json
{ "period": {"from": "2025-01-01T00:00:00-05:00", "to": "2025-01-31T23:59:59-05:00"},
  "alerts_total": 4820, "alerts_pending": 41,
  "by_severity": {"critical": 96, "high": 512, "medium": 1480, "low": 2100, "info": 632},
  "mttt_seconds": {"avg": 168, "median": 96, "p95": 640},
  "false_positive_rate": 0.734, "automation_rate": 0.912,
  "incidents_open": 12, "sla_compliance": {"critical": 0.98, "high": 0.94},
  "noise_reduction": 0.78 }
```

## 7. Reportes exportables

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/reports/operational?format=pdf\|docx\|xlsx&from&to` | `reports:export` | Reporte operativo SOC (volumen, MTTT, top reglas, incidentes). |
| GET | `/reports/management?format=…&period=monthly` | `reports:export` | Reporte gerencial (riesgo, cumplimiento ISO/NIST, tendencias). |
| GET | `/reports/audit?format=…&from&to` | `audit:export` | Extracto de bitácora de auditoría. |
| GET | `/reports/inventory` | `reports:read` | Historial de reportes generados. |
| GET | `/reports/{id}/download` | `reports:read` | Descarga del artefacto almacenado. |

`Content-Type`: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
(docx) o `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx).
Toda generación registra en bitácora `EXPORT` con módulo, formato y rango.

## 8. Bitácora de auditoría

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/audit/logs` | `audit:read` | Filtros: `user_id`, `module`, `action`, `result`, `from`, `to`, `q`, `severity`. |
| GET | `/audit/logs/{id}` | `audit:read` | Detalle con `before`/`after` (diff JSON). |
| GET | `/audit/stats` | `audit:read` | Conteo por módulo/acción/usuario. |
| GET | `/audit/logs/export?format=csv\|xlsx` | `audit:export` | Export de bitácora. |

Esquema de evento (obligatorio: usuario, fecha, hora, acción, módulo, resultado):
```json
{ "id": 90112, "occurred_at": "2025-01-31T14:23:02-05:00", "user_id": 3, "username": "analista1",
  "module": "alerts", "action": "UPDATE", "entity": "alert", "entity_id": "1042",
  "result": "success", "ip_address": "10.10.2.44", "user_agent": "Mozilla/5.0",
  "trace_id": "b1f0…", "before": {"status": "pending"}, "after": {"status": "closed"},
  "detail": "Cierre de alerta tras validación" }
```
Acciones normalizadas: `LOGIN`, `LOGOUT`, `LOGIN_FAILED`, `CREATE`, `READ`, `UPDATE`, `DELETE`,
`EXPORT`, `TRIAGE_RUN`, `TRIAGE_FEEDBACK`, `ROLE_ASSIGN`, `CONFIG_CHANGE`.

**Módulos auditables (entrada/salida por módulo):** `auth`, `users`, `roles`, `alerts`,
`triage`, `incidents`, `dashboard`, `reports`, `audit`, `settings`, `integrations`.

## 9. Health / observabilidad

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Liveness (`{"status":"ok","version":"1.0.0"}`). |
| GET | `/health/ready` | Readiness: PostgreSQL, microservicio LLM, Redis. |
| GET | `/metrics` | Prometheus (fuera de `/api/v1`). |
