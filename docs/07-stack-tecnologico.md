# SOC-Lite · Stack tecnológico detallado

> Justificación de cada elección: qué problema resuelve, por qué se eligió sobre las
> alternativas y qué coste operativo implica para una PYME / organismo público.

---

## 1. Resumen del stack

| Capa | Tecnología | Versión | Licencia |
|---|---|---|---|
| **Lenguaje backend** | Python | 3.11 / 3.12 | PSF |
| **Framework API** | FastAPI | 0.115 | MIT |
| **ORM** | SQLAlchemy (async) | 2.0 | MIT |
| **Driver BD** | asyncpg | 0.30 | Apache-2.0 |
| **Base de datos** | PostgreSQL | 15+ | PostgreSQL License |
| **Caché** | Redis | 7 | BSD-3 |
| **Migraciones** | Alembic | 1.14 | MIT |
| **Lenguaje frontend** | TypeScript | 5.6 | Apache-2.0 |
| **Framework UI** | React | 18 | MIT |
| **Bundler** | Vite | 6 | MIT |
| **Estilos** | TailwindCSS | 3.4 | MIT |
| **Estado servidor** | TanStack Query | 5 | MIT |
| **Gráficos** | Recharts | 2.13 | MIT |
| **Formularios** | React Hook Form + Zod | 7 / 3 | MIT |
| **Orquestación** | n8n | 1.x | Sustainable Use License |
| **Agentes LLM** | LangChain + LangGraph | 0.3 | MIT |
| **Inferencia LLM** | Ollama | latest | MIT |
| **Modelo LLM** | Llama 3.1 8B Instruct | — | Llama 3.1 Community |
| **PDF** | ReportLab | 4.2 | BSD-3 |
| **Word** | python-docx | 1.1 | MIT |
| **Excel** | openpyxl / XlsxWriter | 3.1 / 1.4 | MIT / BSD-2 |
| **Contenedores** | Docker + Compose | 27 / v2 | Apache-2.0 |
| **Proxy/TLS** | nginx | 1.27 | BSD-2 |

---

## 2. Backend

### 2.1 Python 3.11+

**Por qué:** es el lenguaje del ecosistema de seguridad y de IA (todas las librerías
de LangChain, los conectores de Wazuh, las herramientas de análisis de malware).
Python 3.11 aporta mejoras de rendimiento del 10–60 % sobre 3.10 y `asyncio.TaskGroup`.
Alternativas descartadas: Go (mejor rendimiento pero sin ecosistema de agentes LLM),
Node.js (el equipo ya domina n8n, pero para el dominio transaccional Python es superior
en validación de datos y en librerías de reportes).

### 2.2 FastAPI 0.115

| Ventaja | Impacto concreto en SOC-Lite |
|---|---|
| `async` nativo sobre ASGI | Una instancia atiende ingesta + dashboard + triaje sin bloquearse |
| Validación Pydantic v2 | El payload de Wazuh se valida y normaliza automáticamente |
| OpenAPI automático | `/docs` genera la documentación que consume el equipo de n8n |
| `Depends` composable | El RBAC se expresa como `AlertWriter = Annotated[..., Depends(require_permissions("alerts:write"))]` |
| `BackgroundTasks` | El triaje se encola sin bloquear la respuesta al SIEM |
| Rendimiento | ~3× Flask en benchmarks async; suficiente para 5.000 alertas/mes en un solo nodo |

Alternativas: Django REST (más pesado, ORM síncrono por defecto), Flask (sin validación
ni async nativos), NestJS (bueno, pero duplicaría lenguajes).

### 2.3 SQLAlchemy 2.0 async + asyncpg

- **SQLAlchemy 2.0** con `Mapped[...]`/`mapped_column` da tipado estático verificado por `mypy`.
- **asyncpg** es el driver PostgreSQL más rápido para asyncio (~3× psycopg2 en lecturas).
- `selectinload` evita el problema N+1 en alertas con enriquecimiento y triajes.
- El esquema se crea con `db/schema.sql` (fuente de verdad revisable en un pull request)
  y **Alembic** gestiona cambios incrementales posteriores.

### 2.4 PostgreSQL 15+

Ver la justificación completa en [`02-modelo-datos.md`](02-modelo-datos.md#1-justificación-de-postgresql-como-base-principal).
Los puntos decisivos son `JSONB` para los payloads crudos del SIEM, `INET`/`ARRAY` nativos,
`percentile_cont` para el MTTT P95 y las **reglas de inmutabilidad** para la bitácora.

### 2.5 Redis 7

- Caché de enriquecimiento con TTL de 24 h → respeta el límite de VirusTotal
  (4 req/min en el tier gratuito) y reduce la latencia del triaje.
- Backend de caché de la lista de permisos efectivos por usuario.
- Preparado para rate limiting y para el broker de Celery si los reportes crecen.

### 2.6 Seguridad

| Librería | Uso |
|---|---|
| `passlib[bcrypt]` + `bcrypt 4.2` | Hash de contraseñas con coste 12 (OWASP 2024) |
| `python-jose[cryptography]` | JWT HS256 firmados; `iss`/`exp`/`nbf`/`jti` validados |
| `pyotp` | MFA TOTP opcional por usuario |
| `cryptography` | Cifrado de respaldos y utilidades |
| `hmac.compare_digest` | Comparación en tiempo constante de claves de ingesta |

### 2.7 Reportes

| Librería | Formato | Por qué |
|---|---|---|
| **ReportLab** | PDF | Control absoluto de tablas, portadas y saltos; sin dependencias del sistema (a diferencia de WeasyPrint/wkhtmltopdf) |
| **python-docx** | DOCX | Formato nativo de Word; los organismos públicos exigen documentos editables |
| **openpyxl** | XLSX | Permite **gráficos nativos** en el libro y formato condicional; `XlsxWriter` se reserva para libros de sólo escritura de gran volumen |
| **matplotlib** | Imágenes | Embebido opcional de gráficos en PDF/Word |
| **Jinja2** | Plantillas | Personalización de reportes por cliente sin tocar código |

### 2.8 Observabilidad

`structlog` + logging JSON nativo → los logs del backend se envían al propio Wazuh
(se come su propia comida: si el backend falla, queda evidencia en el SIEM).
`prometheus-fastapi-instrumentator` expone latencias y throughput. `sentry-sdk` opcional.

---

## 3. Frontend

### 3.1 React 18 + TypeScript 5.6

- **React 18**: `useTransition`, `Suspense` y renderizado concurrente para tablas de
  miles de alertas sin bloquear la interfaz.
- **TypeScript estricto**: los enums y DTOs del backend se replican en `src/types/`, de
  modo que un cambio de contrato rompe la compilación en lugar de fallar en producción.
- Alternativas: Vue (excelente, pero el equipo tiene más experiencia en React),
  Angular (excesivo para una SPA de 10 vistas).

### 3.2 Vite 6

Arranque en frío < 300 ms y HMR instantáneo. Proxy de desarrollo `/api → localhost:8000`
para evitar CORS en local. Build de producción optimizado con code splitting por ruta.

### 3.3 TailwindCSS 3.4

Sistema de diseño por utilidades → el tema oscuro tipo SOC (slate-900, acentos cian)
se define una vez en `tailwind.config.js` y todos los badges de severidad comparten
la misma paleta. Sin CSS huérfano; el bundle final queda pequeño.

### 3.4 TanStack Query 5

Resuelve exactamente el problema del dashboard: **caché, revalidación y auto-refresh**.

```ts
useQuery({ queryKey: ['dashboard','summary'], queryFn: fetchSummary, refetchInterval: 30_000 })
```

Un dashboard SOC no debe recargar la página: los KPIs se refrescan solos cada 30 s y
las vistas previas se reutilizan al navegar.

### 3.5 Recharts 2.13

Gráficos SVG declarativos y accesibles. Cubre los seis widgets requeridos:

| Widget | Componente Recharts | Endpoint |
|---|---|---|
| Alertas por severidad | `BarChart` | `/dashboard/alerts-by-severity` |
| Evolución del MTTT vs SLA | `LineChart` con `ReferenceLine` | `/dashboard/mttt-trend` |
| Distribución de veredictos | `PieChart` | `/dashboard/verdicts` |
| Top orígenes | `BarChart` horizontal | `/dashboard/top-sources` |
| Cumplimiento SLA | `RadialBarChart` | `/dashboard/sla-compliance` |
| Carga por analista | `BarChart` apilado | `/dashboard/analyst-workload` |

### 3.6 Resto de librerías

| Librería | Uso |
|---|---|
| `axios` | Cliente HTTP con interceptores de refresh automático de token |
| `react-router-dom` 6 | Rutas protegidas por permiso |
| `react-hook-form` + `zod` | Formularios validados en cliente con los mismos criterios que el backend |
| `lucide-react` | Iconografía consistente y ligera |

---

## 4. Orquestación: n8n

**Por qué n8n y no Apache Airflow / Prefect / Temporal:**

| Criterio | n8n | Airflow | Temporal |
|---|---|---|---|
| Curva de aprendizaje para un equipo de SOC | Baja (visual) | Media | Alta (código) |
| Conectores listos para Wazuh, Slack, osTicket | Sí | Vía código | Vía código |
| Reintentos, backoff y manejo de errores | Declarativos | Sí | Sí |
| Autoalojable y sin coste de licencia | Sí | Sí | Sí |
| Inspección visual del flujo por auditores | **Sí** | No | No |
| Ejecuciones long-running y estado | Sí | Sí | Excelente |

Para un SOC de PYME, la **trazabilidad visual del flujo** es un requisito de auditoría
(de un vistazo se ve qué se hace con cada alerta), y n8n lo cumple sin escribir orquestación.

**Nota de licencia:** n8n usa *Sustainable Use License* — uso interno libre; si el
producto se redistribuye comercialmente a terceros hay que revisar los términos.

---

## 5. Capa de IA: LangChain + LangGraph + Ollama

### 5.1 Por qué LangChain y no LangFlow

| Necesidad del triaje | LangFlow | LangChain (microservicio) |
|---|---|---|
| Herramientas personalizadas con lógica de negocio (contexto Wazuh, memoria de FP) | Limitado | **Sí** |
| Salida estructurada validada con Pydantic | No | **Sí** (`response_format`) |
| Versionado y testeo de prompts en CI | No | **Sí** (`prompt_version` en BD) |
| Guardarraíles deterministas post-LLM | No | **Sí** (`_post_process`) |
| Memoria de incidentes | Básica | **Sí** |
| Control de iteraciones y recursión del agente | No | **Sí** (`recursion_limit`) |
| Degradación a heurística si el LLM cae | No | **Sí** |
| Prototipado visual | **Excelente** | No |

**Conclusión:** LangFlow para explorar prompts y LangChain para llevar la lógica a
producción. Es exactamente lo que pidió el caso de uso.

### 5.2 Modelo: Llama 3.1 8B Instruct vía Ollama

| Criterio | Evaluación |
|---|---|
| Calidad en clasificación con contexto | Suficiente con few-shot + salida JSON forzada |
| Requisitos de hardware | ~8 GB de RAM en Q4_K_M; no exige GPU (aunque la acelera 3–5×) |
| Confidencialidad | 100 % local: las alertas no salen de la infraestructura |
| Coste por inferencia | 0 (sólo electricidad) |
| Alternativas | `mistral:7b` (más rápido, algo menos preciso), `qwen2.5:7b` (buen multilenguaje), `llama3.3:70b` (mejor calidad, requiere 48 GB) |
| Opción externa | `LLM_PROVIDER=openai` disponible **sólo** con `ALLOW_EXTERNAL_LLM=true` explícito |

**Salida JSON forzada:** `ChatOllama(format="json")` usa *grammar-constrained decoding*,
lo que reduce drásticamente las alucinaciones de formato en modelos pequeños.
Además, `extract_json()` recupera el objeto JSON incluso si el modelo añade preámbulo.

### 5.3 Herramientas del agente

| Tool | Fuente | Datos que aporta | Coste |
|---|---|---|---|
| `abuseipdb_lookup` | AbuseIPDB API v2 | Score de abuso, nº de reportes, ISP, Tor | Gratuito hasta 1.000 consultas/día |
| `virustotal_lookup` | VirusTotal API v3 | Detecciones por motor, reputación, país, ASN | Gratuito 4 req/min · 500/día |
| `geoip_lookup` | MaxMind GeoLite2 **local** | País, ciudad, ASN | Gratuito (requiere registro) |
| `wazuh_context` | Backend SOC-Lite | Historial de la regla y su tasa de FP | Interno |
| `search_known_false_positives` | Backend SOC-Lite | **Memoria de incidentes** | Interno |
| `mitre_lookup` | Catálogo local | Técnica y táctica ATT&CK | Interno |

**Economía de contexto:** el prompt se limita a 8.192 tokens (`OLLAMA_NUM_CTX`) y el
`full_log` se trunca a 4.000 caracteres. El enriquecimiento se cachea 24 h en Redis.

---

## 6. Frontend ↔ Backend ↔ Orquestador: contratos

| Transporte | Formato | Autenticación |
|---|---|---|
| Frontend → Backend | REST/JSON | JWT Bearer (access 30 min + refresh rotativo) |
| n8n → Backend (ingesta) | REST/JSON | Header `X-Ingest-Key` (comparación en tiempo constante) |
| n8n ↔ Backend (interno) | REST/JSON | `X-Service-Token` |
| Backend → Microservicio LLM | REST/JSON | `X-Service-Token` |
| Microservicio → APIs de TI | HTTPS/JSON | API keys por proveedor (`secret_ref` en `.env`) |

---

## 7. Herramientas de desarrollo

| Área | Herramienta | Configuración |
|---|---|---|
| Linting/format backend | Ruff | Reglas E, F, I, N, UP, B, S, ANN (línea 110) |
| Tipado estático | mypy | `strict = true` sobre `app/` |
| Linting frontend | ESLint + `@typescript-eslint` | `no-explicit-any: error` |
| Formato frontend | Prettier | 100 columnas, comillas simples |
| Pruebas backend | pytest + pytest-asyncio + pytest-cov | Objetivo ≥ 80 % en `services/` |
| Pruebas API | httpx `AsyncClient` | Fixtures con BD de prueba efímera |
| Mocks de terceros | `respx` | Simula AbuseIPDB/VirusTotal sin gastar cuota |
| CI/CD | GitHub Actions / GitLab CI | lint → test → build → imagen → despliegue |
| Análisis de seguridad | `pip-audit`, `npm audit`, Trivy | Escaneo de dependencias e imagen |
| Gestión de secretos | `.env` (600) / Docker secrets / Vault | Nunca en el repositorio |

---

## 8. Requisitos de infraestructura

### 8.1 Escenario PYME (hasta 5.000 alertas/mes)

| Recurso | Especificación |
|---|---|
| CPU | 8 vCPU |
| RAM | 24 GB (8 GB sólo para Ollama con llama3.1:8b en Q4) |
| Disco | 200 GB SSD (BD + reportes + modelos) |
| Red | 1 Gbps interno; salida sólo para APIs de threat intel (opcional) |
| SO host | Ubuntu Server 22.04 LTS o Debian 12 |

### 8.2 Escenario con GPU (opcional, recomendado)

Añadir una GPU con ≥ 8 GB de VRAM (RTX 3060/4060 o T4) reduce el triaje de
~8 s a ~2,5 s, lo que permite bajar el umbral `MIN_SEVERITY_TO_PROCESS` de 7 a 4
y triar más del 95 % de las alertas.

### 8.3 Estimación de coste (orientativa, 2025)

| Concepto | Coste |
|---|---|
| Licencias de software | **0** (todo open source excepto la licencia de uso de n8n, gratuita para uso interno) |
| Servidor on-premise o VPS equivalente | 150–350 USD/mes |
| APIs de threat intel | 0 (tiers gratuitos) a 100 USD/mes (VirusTotal Premium) |
| **Total** | **≈ 2.000–5.500 USD/año** frente a decenas de miles de un SOAR comercial |

### 8.4 Comparativa con alternativas comerciales

| Aspecto | SOC-Lite | Cortex XSOAR | Splunk SOAR |
|---|---|---|---|
| Coste anual | 2–5,5 k USD | 50–150 k USD | 40–120 k USD |
| Despliegue on-premise sin exfiltración | Sí | Sí | Sí |
| LLM local para triaje | **Sí** | Parcial (requiere conectores) | Parcial |
| Personalización de prompts | Total | Limitada | Limitada |
| Curva de aprendizaje | Media | Alta | Alta |
| Adecuado para PYME | **Sí** | No | No |
