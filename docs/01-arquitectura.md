# SOC-Lite · Arquitectura del sistema

> **Caso de uso 1 — Triaje automático de alertas SOC (Crítico)**
> Solución accesible para PYME / empresa mediana / organismo público que combina
> orquestación low-code (n8n) con enriquecimiento contextual y razonamiento LLM
> (LangChain) para reducir la fatiga de alertas.

---

## 1. Problema y propuesta de valor

### El vacío de conocimiento

| Realidad del mercado | Consecuencia para una PYME |
|---|---|
| Los SOAR comerciales (Cortex XSOAR, Splunk SOAR) cuestan decenas de miles de USD/año | Inaccesibles: el SOC queda sin automatización |
| Los SIEM open source (Wazuh, OPNsense, Suricata) **generan** alertas pero no las **priorizan ni enriquecen** | El analista recibe 500–2.000 alertas/día sin contexto |
| 70–90 % de las alertas son falsos positivos o de baja relevancia | Fatiga de alertas → las alertas críticas se ignoran |
| Sin personal nocturno | MTTT de horas o días; la ventana de detección se pierde |

### La propuesta

**SOC-Lite** es una capa de triaje inteligente que se coloca **entre el SIEM y el analista**:

```
   Wazuh / OPNsense / Suricata
              │  (webhook JSON)
              ▼
    ┌─────────────────────┐
    │   n8n (orquestación)│   ingesta · deduplicación · enrutamiento
    └──────────┬──────────┘
               │ HTTP
               ▼
    ┌─────────────────────┐
    │ Microservicio       │   agente LLM con herramientas:
    │ LangChain + Ollama  │   AbuseIPDB · VirusTotal · GeoIP · MITRE · memoria
    └──────────┬──────────┘
               │ JSON estructurado (Pydantic)
               ▼
    ┌─────────────────────┐
    │ Backend FastAPI     │   API, RBAC, auditoría, métricas, reportes
    └──────────┬──────────┘
               │
    ┌──────────┴──────────┬──────────────┬──────────────┐
    ▼                     ▼              ▼              ▼
PostgreSQL          Slack/Telegram   osTicket       Dashboard React
(alertas, triaje,   (solo alta       (ticket)       (KPIs, MTTT, FP)
 auditoría)          severidad)
```

### Resultados medibles (objetivo del sistema)

| Indicador | Antes | Después | KPI del sistema |
|---|---|---|---|
| MTTT (Mean Time To Triage) | 2–8 h | 30 s – 5 min | `mttt_seconds` ≤ 900 s en críticas |
| Fatiga de alertas | 100 % revisadas por humano | ~12 % escalan a humano | `automation_rate` ≥ 0,85 |
| Reducción de ruido | 0 % | 70–85 % | `noise_reduction` ≥ 0,70 |
| Cobertura horaria | 8×5 | 24×7 | SLA crítico ≥ 95 % |
| Tasa de falsos positivos | desconocida | medida y trazable | `false_positive_rate` ≤ 0,30 |

### Encaje normativo

| Marco | Control / función | Cómo lo cubre SOC-Lite |
|---|---|---|
| **ISO/IEC 27001:2022** | A.8.15 Registro de eventos | Bitácora `audit_log` inmutable con encadenamiento sha256 |
| | A.8.16 Actividades de seguimiento | Triaje y clasificación automatizada de eventos |
| | A.5.24 Planificación y preparación de la respuesta a incidentes | Módulo de incidentes + acciones de respuesta |
| | A.5.25 Evaluación de eventos de seguridad | Veredicto y severidad del agente LLM |
| | A.5.26 Respuesta a incidentes | Escalado automático y creación de tickets |
| | A.5.28 Recopilación de evidencia | `raw_payload`, `enrichment_data.raw_response`, trazas `trace_id` |
| | A.5.7 Inteligencia de amenazas | Herramientas AbuseIPDB / VirusTotal / MISP |
| | A.5.15 · A.8.2 · A.8.3 Control de acceso | RBAC con 22 permisos y 5 roles |
| **NIST CSF 2.0** | DE.AE-02/03/04/06 Análisis de eventos adversos | Priorización, correlación y umbralización |
| | RS.AN-03/06 Análisis de incidentes | Razonamiento trazable + línea de tiempo |
| | RS.MA-01 Gestión de la respuesta | Incidentes y acciones |
| | GV.OC-03 Requisitos legales y contractuales | Reportes exportables y retención |

---

## 2. Arquitectura del sistema

### 2.1 Vista de capas

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ CAPA DE PRESENTACIÓN                                                          │
│  React 18 + TypeScript + Vite + TailwindCSS + Recharts + TanStack Query       │
│  ├─ Dashboard (KPIs, MTTT, severidad, top orígenes, tasa FP, SLA, carga)     │
│  ├─ Alertas (lista filtrable + detalle con resumen LLM y acciones)           │
│  ├─ Incidentes · Usuarios · Roles (matriz de permisos) · Auditoría · Reportes│
│  └─ RBAC en UI: los componentes se ocultan según permisos efectivos           │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS · JWT Bearer · CORS restringido
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ CAPA DE LÓGICA DE NEGOCIO                                                     │
│                                                                               │
│  ┌────────────────────────────┐        ┌──────────────────────────────────┐  │
│  │ n8n  (orquestación)        │        │ Backend FastAPI (API + dominio)  │  │
│  │ · Webhook de ingesta       │───────▶│ · Auth JWT + refresh rotativo    │  │
│  │ · Deduplicación/supresión  │        │ · RBAC (22 permisos)             │  │
│  │ · Enrutamiento por severidad│       │ · Gestión de alertas/triaje      │  │
│  │ · Notificación (Slack/TG)  │        │ · Incidentes y acciones          │  │
│  │ · Ticket (osTicket/Redmine)│        │ · Métricas y dashboard           │  │
│  │ · SLA y agregados (cron)   │        │ · Reportes PDF/Word/Excel        │  │
│  └────────────┬───────────────┘        │ · Bitácora de auditoría          │  │
│               │                        └───────────────┬──────────────────┘  │
│               │  HTTP interno                          │                     │
│               ▼                                        │                     │
│  ┌────────────────────────────────────────┐            │                     │
│  │ Microservicio LangChain (FastAPI:8001) │◀───────────┘                     │
│  │ · Agente ReAct (LangGraph)             │   POST /triage                    │
│  │ · Tools: AbuseIPDB, VirusTotal, GeoIP, │                                   │
│  │   contexto Wazuh, memoria de FP, MITRE │                                   │
│  │ · LLM local: Ollama (llama3.1:8b)      │                                   │
│  │ · Salida estructurada Pydantic         │                                   │
│  └────────────────────────────────────────┘                                   │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ SQLAlchemy 2.0 async (asyncpg) · pool 10+20
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ CAPA DE DATOS                                                                 │
│  PostgreSQL 15+ (esquema `soclite`)   ·  Redis (caché de enriquecimiento)     │
│  alerts · enrichment_data · triage_results · incidents · incident_actions     │
│  users · roles · permissions · assets · audit_log · notifications             │
│  alert_metrics_daily · kpi_targets · integrations · generated_reports         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Componentes e interacciones

| # | Componente | Tecnología | Responsabilidad | Se comunica con |
|---|---|---|---|---|
| C1 | **Frontend SPA** | React 18 + TS + Vite | Interfaz de operación y gestión | C3 (REST/JSON) |
| C2 | **n8n** | n8n 1.x | Orquestación low-code, reintentos, enrutamiento, notificaciones | C3, C4, Wazuh, Slack, osTicket |
| C3 | **Backend API** | FastAPI + SQLAlchemy 2.0 | Dominio, RBAC, persistencia, métricas, reportes, auditoría | C1, C2, C4, C5, C6 |
| C4 | **Servicio de triaje** | FastAPI + LangChain + LangGraph | Razonamiento LLM, enriquecimiento, clasificación | C3, C6, APIs de TI |
| C5 | **PostgreSQL** | PostgreSQL 15+ | Fuente de verdad transaccional y de auditoría | C3, C2 |
| C6 | **Ollama** | llama3.1:8b / mistral:7b | Inferencia LLM local (sin exfiltración de datos) | C4 |
| C7 | **Wazuh / OPNsense** | Wazuh 4.x, Suricata | Detección y generación de alertas | C2 (webhook) |

### 2.3 Flujo de una alerta (secuencia)

```
Wazuh        n8n         Backend        LangChain      Ollama      PostgreSQL     Slack/osTicket
  │           │             │               │             │            │              │
  │ webhook   │             │               │             │            │              │
  ├──────────▶│             │               │             │            │              │
  │           │ normaliza + valida clave    │             │            │              │
  │           │ dedup (ventana 5 min)       │             │            │              │
  │           ├─ POST /alerts/ingest ──────▶│             │            │              │
  │           │             │ INSERT alert (pending) ─────────────────▶│              │
  │           │             │◀── alert_id ──────────────────────────────│              │
  │           │◀── 201 {alert_id, triage_queued} ─────────│            │              │
  │           │             │                               │            │              │
  │           │             ├─ POST /triage (interno) ─────▶│            │              │
  │           │             │               │ tools: AbuseIPDB/VT/GeoIP │              │
  │           │             │               ├──────────────────────────▶│ (APIs TI)    │
  │           │             │               ├─ inferencia ─▶│            │              │
  │           │             │               │◀─ JSON ───────│            │              │
  │           │             │◀─ TriageResponse ─────────────│            │              │
  │           │             │ INSERT triage_results + UPDATE alerts ────▶│              │
  │           │             │ INSERT audit_log (TRIAGE_RUN) ────────────▶│              │
  │           │             │                               │            │              │
  │           │◀─ Switch por severidad ────────────────────────────────────            │
  │           │  alta/crítica: notifica ──────────────────────────────────────────────▶│
  │           │  crítico: crea incidente + ticket ─────────────────────────────────────▶│
  │           │  registra en bitácora (EXPORT/NOTIFY) ──────────────────▶│              │
```

### 2.4 Dónde va cada responsabilidad (y por qué ese reparto)

| Necesidad | Componente elegido | Justificación |
|---|---|---|
| Integrar sistemas heterogéneos con reintentos y visibilidad operativa | **n8n** | Conectores nativos (Wazuh, Slack, osTicket, PostgreSQL) y reintentos declarativos sin escribir código |
| Razonar sobre la alerta con herramientas y memoria | **LangChain (microservicio)** | LangFlow no permite control fino de prompts, salida estructurada ni cadenas con lógica condicional; LangChain sí |
| Evitar exfiltración de datos de alertas | **Ollama local** | Inferencia on-premise; `ALLOW_EXTERNAL_LLM=false` por defecto |
| API transaccional con RBAC y auditoría | **FastAPI** | Async nativo, validación Pydantic, OpenAPI automático, alto rendimiento |
| Fuente de verdad y evidencia | **PostgreSQL** | Integridad transaccional, JSONB para payloads crudos, `INET`/`ARRAY` nativos, reglas de inmutabilidad |
| Caché de enriquecimiento y bloqueo anti fuerza bruta | **Redis** | TTL nativo, evita agotar cuotas de APIs gratuitas |

---

## 3. Decisiones de arquitectura (ADR resumidos)

| ADR | Decisión | Alternativa descartada | Motivo |
|---|---|---|---|
| ADR-01 | n8n **+** microservicio LangChain (híbrido) | Solo n8n; solo LangChain | n8n aporta integraciones y manejo de errores; LangChain aporta agentes con tools y control de prompts |
| ADR-02 | LLM local con Ollama por defecto | OpenAI API | Las alertas contienen datos sensibles (IPs internas, usuarios, rutas). Riesgo legal y de confidencialidad |
| ADR-03 | Salida del LLM validada con Pydantic | Texto libre parseado con regex | Determinismo del contrato backend ↔ agente; un modelo de 8B aluciona formato |
| ADR-04 | Bitácora con reglas PostgreSQL anti-UPDATE/DELETE + hash chain | Solo permisos de aplicación | Un DBA con privilegios podría alterar la evidencia; la inmutabilidad debe residir en la BD |
| ADR-05 | Métricas agregadas en `alert_metrics_daily` | Calcular todo en tiempo real | Con millones de alertas los percentiles en vivo degradan el dashboard |
| ADR-06 | Degradación heurística si el LLM cae | Fallar la ingesta | La operación 24/7 no puede depender de un único componente |
| ADR-07 | Reportes generados en el backend (reportlab/python-docx/openpyxl) | Servicio externo de plantillas | Menos piezas móviles; control total del formato exigido (PDF/Word/Excel) |
| ADR-08 | JWT con refresh rotativo almacenado con hash | Sesión en servidor | Escalado horizontal sin estado compartido; detección de reutilización de tokens |

---

## 4. Despliegue

### 4.1 Topología Docker Compose (PYME: un solo host)

| Servicio | Imagen | Puertos | Recursos sugeridos |
|---|---|---|---|
| `postgres` | postgres:15-alpine | 5432 (solo red interna) | 2 vCPU · 4 GB RAM · 100 GB SSD |
| `redis` | redis:7-alpine | 6379 (interno) | 1 vCPU · 1 GB |
| `ollama` | ollama/ollama | 11434 (interno) | 4 vCPU · 16 GB RAM (o GPU) |
| `backend` | soc-lite/backend:1.0.0 | 8000 (interno tras proxy) | 2 vCPU · 2 GB |
| `langchain` | soc-lite/langchain:1.0.0 | 8001 (interno) | 2 vCPU · 2 GB |
| `n8n` | n8nio/n8n:latest | 5678 | 1 vCPU · 1 GB |
| `frontend` | soc-lite/frontend:1.0.0 | 5173 → nginx 80 | 1 vCPU · 512 MB |
| `nginx` | nginx:alpine | 443 público | TLS terminado, único punto expuesto |

**Requisito mínimo razonable:** 8 vCPU · 24 GB RAM · 200 GB SSD para la operación
completa con `llama3.1:8b` cuantizado en Q4. Sin GPU, un triaje tarda ~6–15 s;
con GPU (8 GB VRAM) baja a ~2–4 s.

### 4.2 Consideraciones de seguridad del despliegue

1. **Único punto expuesto:** nginx con TLS 1.3 y HSTS. Backend, LangChain, Ollama, PostgreSQL y Redis nunca publican puertos.
2. **Secretos** fuera del repositorio (`.env` con permisos 600, o Docker secrets / Vault).
3. **Segmentación:** la red `soc-internal` (backend↔BD↔LLM) es distinta de `soc-edge` (n8n↔nginx).
4. **Respaldos:** `pg_dump` diario cifrado + retención de bitácora ≥ 12 meses (ISO 27001 A.8.13).
5. **Aislamiento del LLM:** Ollama se ejecuta en un contenedor sin acceso saliente a Internet; sólo el servicio LangChain habla con las APIs de threat intel, y de forma opcional.
6. **Alta disponibilidad (opcional):** PostgreSQL con streaming replication y dos réplicas del backend tras nginx (el estado está en la BD, no en el proceso).

---

## 5. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación implementada |
|---|---|---|
| El LLM clasifica mal y cierra un verdadero positivo | Alto | `AUTO_CLOSE_FP_CONFIDENCE=0.90`, guardarraíles de coherencia (`_post_process`), retroalimentación humana obligatoria y métrica de concordancia |
| Alucinación de IOCs | Alto | Prompt exige declarar hechos vs. inferencias; las herramientas devuelven JSON de error explícito; los indicadores se guardan con su `source` |
| Prompt injection desde el log de la alerta | Medio | El log se inserta en un bloque delimitado; el agente no ejecuta acciones, sólo propone; la ejecución la autoriza un humano o n8n |
| Coste/ latencia del LLM local | Medio | Caché de enriquecimiento 24 h, `num_ctx` limitado, modelo 8B, triaje sólo por encima de `MIN_SEVERITY_TO_PROCESS=7` |
| Cuotas de APIs gratuitas (VT: 4 req/min) | Medio | Caché Redis, herramientas opcionales, degradación a heurística |
| Crecimiento de `audit_log` | Bajo | Particionado por mes y archivado a almacenamiento frío (retención 12 meses en caliente) |
| Fuga de datos de alertas a terceros | Alto | `ALLOW_EXTERNAL_LLM=false` por defecto; GeoIP local (MaxMind); sólo se consultan indicadores (IP/hash), nunca el log completo |
