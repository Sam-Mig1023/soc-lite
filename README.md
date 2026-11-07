# SOC-Lite · Triaje automático de alertas SOC

> **Caso de uso 1 (Crítico):** solución accesible para PYME / empresa mediana / organismo
> público que combina orquestación *low-code* (n8n) con enriquecimiento contextual y
> razonamiento LLM (LangChain + Ollama) para reducir la fatiga de alertas.
> Sustituye el MTTT de horas por minutos y habilita operación 24/7 sin personal nocturno.

[![Norma](https://img.shields.io/badge/ISO%2FIEC%2027001-2022-0f172a)](docs/01-arquitectura.md)
[![Marco](https://img.shields.io/badge/NIST%20CSF-2.0-06b6d4)](docs/01-arquitectura.md)
[![Licencia](https://img.shields.io/badge/licencia-uso%20interno-64748b)](#licencia)

---

## El problema en una frase

Los SOAR comerciales cuestan decenas de miles de dólares; las PYMEs sólo tienen SIEMs
open source que **generan** alertas pero no las **priorizan ni enriquecen**. El 70–90 %
son falsos positivos, así que las alertas críticas se pierden entre el ruido.

## La solución

```
Wazuh/OPNsense ──webhook──▶ n8n ──▶ LangChain + Ollama ──▶ PostgreSQL ──▶ Dashboard React
                            │                │                                │
                            │                └─ AbuseIPDB · VirusTotal · GeoIP │
                            │                   MITRE · memoria de FP         │
                            └──▶ Slack / Telegram / osTicket ◀────────────────┘

UNSW-NB15 (CSV) ──workflow n8n──▶ FastAPI ──▶ clasificador Random Forest + LangChain/Ollama
```

Para la evaluación con UNSW-NB15, el Random Forest se ajusta con el split oficial de
entrenamiento y su salida se pasa al agente LangChain como señal cuantitativa. Las
columnas de etiqueta, categoría e identificador se excluyen de las entradas predictoras;
el LLM aporta el análisis contextual y las acciones recomendadas.

**Dataset público utilizado:** [UNSW-NB15 — UNSW Canberra](https://research.unsw.edu.au/projects/unsw-nb15-dataset). Se utilizaron los archivos oficiales `UNSW_NB15_training-set.csv` y `UNSW_NB15_testing-set.csv`; el dataset se descarga desde la página de UNSW.

| Antes | Después |
|---|---|
| MTTT de 2–8 horas | **30 s – 5 min** |
| 100 % de alertas revisadas por un humano | **~12 %** escalan a humano |
| Sin cobertura nocturna | **24×7** |
| Tasa de falsos positivos desconocida | **medida y trazable** |

---

## Requisitos del sistema — cumplimiento

| Requisito obligatorio | Estado | Dónde |
|---|---|---|
| Stack tecnológico justificado (backend + frontend) | ✅ | [`docs/07-stack-tecnologico.md`](docs/07-stack-tecnologico.md) |
| PostgreSQL como base de datos principal | ✅ | [`db/schema.sql`](db/schema.sql) · [`docs/02-modelo-datos.md`](docs/02-modelo-datos.md) |
| Dashboard con métricas e indicadores | ✅ | [`backend/app/services/metrics_service.py`](backend/app/services/metrics_service.py) · `frontend/src/pages/Dashboard.tsx` |
| Reportes exportables en **PDF, Word y Excel** | ✅ | [`backend/app/services/report_service.py`](backend/app/services/report_service.py) |
| Módulo de usuarios, roles y perfiles (**RBAC**) | ✅ | [`backend/app/api/v1/routers/roles.py`](backend/app/api/v1/routers/roles.py) · 22 permisos / 5 roles |
| Bitácora de auditoría con **entrada/salida por módulo** (usuario, fecha, hora, acción) | ✅ | [`backend/app/middleware/audit_middleware.py`](backend/app/middleware/audit_middleware.py) · [`backend/app/services/audit_service.py`](backend/app/services/audit_service.py) |

---

## Instalación y arranque en Windows con Docker

Esta es la forma recomendada para ejecutar el proyecto en otra computadora sin
instalar Python, Node.js, PostgreSQL ni Redis. Los comandos siguientes son para
**PowerShell** y deben ejecutarse desde la carpeta raíz `soc-lite`.

### Requisitos

- Windows 10/11 con **Docker Desktop** instalado y abierto en modo Linux containers
  (WSL 2).
- **No es necesario instalar Ubuntu** para correr el proyecto: Docker Desktop usa
  WSL 2 internamente. Si Ubuntu ya está instalado, puedes dejarlo; no hace falta
  abrirlo para seguir estos pasos.
- Git, si se descargará el proyecto con `git clone`; también se puede recibir la
  carpeta completa o un ZIP.
- Conexión a Internet durante la primera ejecución para descargar imágenes y el
  modelo de Ollama. El modelo `llama3.1:8b` ocupa varios GB; deja espacio libre y
  espera a que termine su descarga antes de probar el triaje con IA. Se recomienda
  contar con 16 GB de RAM y unos 20 GB libres en disco para que el stack y el
  modelo tengan espacio suficiente.

### 1. Obtener el proyecto

Si se comparte como ZIP, descomprímelo. Si hay un repositorio Git disponible,
reemplaza la URL por la dirección real del repositorio:

```powershell
git clone <URL-del-repositorio> soc-lite
Set-Location .\soc-lite
```

Si ya recibiste la carpeta, abre PowerShell en ella. Confirma que estás en la raíz:

```powershell
Get-ChildItem docker-compose.yml, db\schema.sql, .env.example
```

Al compartir el proyecto, incluye el código y `.env.example`. No envíes tu `.env`,
los certificados generados en `deploy\certs`, ni bases de datos o archivos de datos
locales; cada persona crea su propia configuración y certificado siguiendo estos
pasos.

### 2. Crear la configuración local

```powershell
Copy-Item .env.example .env
```

Para una demostración local, revisa `.env` y reemplaza los valores de ejemplo de
`SECRET_KEY`, `INTERNAL_SERVICE_TOKEN`, `INGEST_API_KEY`, `POSTGRES_PASSWORD`,
`N8N_BASIC_AUTH_PASSWORD` y `N8N_ENCRYPTION_KEY` por valores propios. No compartas
el archivo `.env`: contiene secretos. Las claves de VirusTotal, AbuseIPDB y otros
servicios externos son opcionales para iniciar el sistema.

### 3. Crear el certificado local de HTTPS

Nginx requiere los dos archivos de certificado antes de arrancar. Este certificado
es autofirmado y sólo sirve para la demostración en `localhost`:

```powershell
New-Item -ItemType Directory -Force .\deploy\certs | Out-Null
docker run --rm -v "${PWD}/deploy/certs:/certs" alpine/openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /certs/privkey.pem -out /certs/fullchain.pem -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Al abrir `https://localhost`, el navegador puede mostrar una advertencia porque
el certificado no fue emitido por una autoridad pública. Para esta prueba local,
continúa a `localhost`; no uses este certificado en un servidor público.

### 4. Construir y arrancar los servicios

Verifica que Docker Desktop siga abierto y ejecuta:

```powershell
docker compose up -d --build
docker compose ps
```

La primera compilación puede tardar. Ollama descarga automáticamente el modelo
definido en `OLLAMA_MODEL` (por defecto `llama3.1:8b`) en un contenedor temporal.
Para ver el avance de esa descarga:

```powershell
docker compose logs -f ollama-pull
```

Cuando aparezca `Modelo listo`, presiona `Ctrl+C` para salir de los logs; esto no
detiene los servicios. Comprueba que los servicios principales aparezcan como
`healthy` o `Up`:

```powershell
docker compose ps
```

### 5. Abrir el sistema

- **SOC-Lite:** [https://localhost](https://localhost)
- **n8n:** [http://localhost:5678](http://localhost:5678) (usuario y contraseña
  configurados en `.env`, `N8N_BASIC_AUTH_USER` y `N8N_BASIC_AUTH_PASSWORD`)
- **API y documentación:** [https://localhost/docs](https://localhost/docs)
- **API base:** `https://localhost/api/v1`

Credenciales iniciales de SOC-Lite: consulta la tabla de credenciales de
demostración más abajo. Los workflows de ejemplo están en `n8n/`; se pueden
importar desde la interfaz de n8n. Para una guía de su funcionamiento, consulta
[`docs/05-workflow-n8n.md`](docs/05-workflow-n8n.md).

### 6. Detener o volver a iniciar

Desde la carpeta del proyecto:

```powershell
docker compose down       # detiene y elimina contenedores; conserva los datos
docker compose up -d      # vuelve a iniciar los servicios ya creados
```

**No ejecutes `docker compose down -v` si quieres conservar los datos**: esa opción
borra también los volúmenes de la base de datos, n8n y los modelos descargados.

### Solución rápida de problemas

- Si Docker indica que no puede conectar al daemon, abre Docker Desktop y espera a
  que indique que está ejecutándose.
- Si nginx se reinicia, confirma que existen
  `deploy\certs\fullchain.pem` y `deploy\certs\privkey.pem`; repite el paso 3.
- Si la página no carga, ejecuta `docker compose ps` y
  `docker compose logs --tail 100 nginx backend frontend`.
- Si el triaje con IA aún no responde, espera a que termine `ollama-pull` y revisa
  `docker compose logs --tail 100 ollama langchain`.
- Para reconstruir una imagen después de recibir una actualización del código,
  ejecuta `docker compose up -d --build`.

### Opción B — Desarrollo local (Linux/macOS; no necesario para Docker)

```bash
# 1. Base de datos
createdb soclite
psql -U soclite -d soclite -f db/schema.sql
psql -U soclite -d soclite -f db/seed.sql
# Opcional: 5.000 alertas sintéticas para probar el dashboard
psql -U soclite -d soclite -c "SELECT soclite.generate_synthetic_alerts(5000, 30);"

# 2. Backend
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 3. Microservicio de triaje
cd ../langchain-service && pip install -r requirements.txt
ollama pull llama3.1:8b
uvicorn app.main:app --reload --port 8001

# 4. Frontend
cd ../frontend && pnpm install && pnpm dev
```

### Credenciales de demostración

| Usuario | Contraseña | Rol | Para demostrar |
|---|---|---|---|
| `admin` | `Admin123!` | Administrador | Usuarios, roles y configuración |
| `soc_manager` | `Manager123!` | Jefe de SOC | Reportes gerenciales e incidentes |
| `analista1` | `Analyst123!` | Analista SOC | Triaje, feedback y gestión de alertas |
| `auditor1` | `Audit123!` | Auditor | Bitácora y reportes de auditoría (sólo lectura) |
| `visor1` | `Viewer123!` | Consulta | Dashboard de sólo lectura (**RBAC visible**) |

> ⚠️ Cambiar todas las contraseñas y `SECRET_KEY` antes de cualquier uso real.

---

## Estructura del repositorio

```
soc-lite/
├── docker-compose.yml            Stack completo (8 servicios)
├── .env.example                  Plantilla de configuración (70+ variables)
├── deploy/nginx.conf             Proxy inverso, TLS y cabeceras de seguridad
│
├── db/
│   ├── schema.sql                Esquema PostgreSQL completo (12 tablas, 4 vistas, 8 enums)
│   ├── seed.sql                  Datos semilla realistas (usuarios, roles, alertas, bitácora)
│   └── synthetic_data.sql        Generador de 5.000+ alertas para pruebas de carga
│
├── backend/                      FastAPI + SQLAlchemy 2.0 async
│   ├── app/core/                 Config, seguridad JWT/bcrypt, contexto, errores, logging
│   ├── app/models/               ORM tipado
│   ├── app/schemas/              Contratos Pydantic v2
│   ├── app/api/v1/routers/       10 routers: auth, users, roles, alerts, triage,
│   │                             incidents, dashboard, reports, audit, health
│   ├── app/services/             Auditoría, triaje, métricas, reportes
│   ├── app/middleware/           Bitácora de acceso + cabeceras de seguridad
│   └── Dockerfile
│
├── langchain-service/            Agente LLM (FastAPI + LangChain + LangGraph)
│   ├── app/agents/triage_agent.py   Agente ReAct con salida estructurada
│   ├── app/tools/threat_intel.py    6 herramientas con caché Redis
│   ├── app/chains/prompts.py        Prompts versionados + few-shot
│   └── Dockerfile
│
├── frontend/                     React 18 + TypeScript + Vite + Tailwind
│   └── src/{api,components,pages,context,types}
│
├── n8n/                          Workflows importables (JSON)
│   ├── soc_lite_triage_workflow.json
│   ├── soc_lite_dedup_suppression_workflow.json
│   ├── soc_lite_sla_escalation_workflow.json
│   ├── soc_lite_metrics_aggregation_workflow.json
│   └── soc_lite_report_generation_workflow.json
│
└── docs/                         Documentación de arquitectura
    ├── 00-contrato-api.md        Contrato normativo de la API v1
    ├── 01-arquitectura.md        Componentes, capas, ADR, despliegue, riesgos
    ├── 02-modelo-datos.md        Diccionario de datos y datos semilla
    ├── 03-backend.md             Implementación del backend
    ├── 04-frontend.md            Implementación del frontend
    ├── 05-workflow-n8n.md        Flujo de nodos paso a paso
    ├── 06-datasets-publicos.md   Datasets abiertos reutilizables
    └── 07-stack-tecnologico.md   Justificación del stack
```

---

## Documentación

| Documento | Contenido |
|---|---|
| [Instalación en Windows](instalacion.md) | Requisitos de Windows, WSL 2, Docker Desktop, almacenamiento de Ollama y arranque paso a paso |
| [Contrato de API](docs/00-contrato-api.md) | Endpoints, enums, envelopes y esquemas de error (normativo) |
| [Arquitectura](docs/01-arquitectura.md) | Problema, capas, componentes, ADR, topología, riesgos |
| [Modelo de datos](docs/02-modelo-datos.md) | 12 tablas, diccionario, inmutabilidad de la bitácora, semilla |
| [Backend](docs/03-backend.md) | RBAC, auditoría de doble capa, triaje, métricas, reportes |
| [Frontend](docs/04-frontend.md) | Estructura, estado, RBAC en UI, widgets y endpoints |
| [Workflows n8n](docs/05-workflow-n8n.md) | Los 10 nodos, entradas/salidas, reintentos, idempotencia |
| [Datasets públicos](docs/06-datasets-publicos.md) | Datasets de logs, TI, malware y evaluación de LLM |
| [Stack tecnológico](docs/07-stack-tecnologico.md) | Justificación de cada tecnología y su coste |

---

## Prueba rápida de la instalación

Después de que `docker compose ps` muestre los servicios principales como `Up` o
`healthy` y termine la descarga del modelo:

1. Abre `https://localhost` y, si aparece el aviso del certificado autofirmado,
   continúa a la página local.
2. Inicia sesión con `admin` / `Admin123!` (o usa cualquiera de las otras cuentas
   de demostración de la tabla anterior).
3. Revisa el Dashboard, Alertas e Incidentes. Puedes crear un incidente manual
   desde **Incidentes → Nuevo incidente**.
4. Abre n8n en `http://localhost:5678`. Los archivos de workflow están en `n8n/`;
   se importan desde la interfaz de n8n y requieren que se configuren las
   credenciales o integraciones que utilice cada flujo.

Para comprobar errores de inicio, usa `docker compose ps` y los comandos de logs
de la sección de solución rápida de problemas.

---

## Seguridad y cumplimiento

- **Sin exfiltración de datos:** `ALLOW_EXTERNAL_LLM=false` por defecto; inferencia con
  Ollama local; GeoIP con base MaxMind local. Sólo se consultan *indicadores* (IPs, hashes),
  nunca el log completo.
- **Bitácora inmutable:** reglas PostgreSQL que anulan `UPDATE`/`DELETE` + encadenamiento
  sha256 verificable con `GET /api/v1/audit/verify-chain`.
- **RBAC de mínimo privilegio:** 22 permisos granulares, 5 roles de sistema, matriz de
  permisos editable desde la interfaz, y ocultación de acciones en la UI.
- **Defensa en profundidad:** único puerto expuesto (443), TLS 1.2/1.3, HSTS, CSP,
  cabeceras de seguridad, límite de tasa en la ingesta, segmentación de redes.
- **Trazabilidad extremo a extremo:** el mismo `trace_id` correlaciona log del backend,
  triaje, bitácora y `X-Trace-Id` de la respuesta HTTP.

---

## Limitaciones conocidas y trabajo futuro

| Limitación | Mitigación actual | Trabajo futuro |
|---|---|---|
| Un modelo de 8B puede errar en casos ambiguos | `AUTO_CLOSE_FP_CONFIDENCE=0.90` + feedback humano + métrica de concordancia | Fine-tuning con el corpus de feedback acumulado |
| `audit_log` crece indefinidamente | Retención de 12 meses | Particionado declarativo por mes |
| Sin broker de tareas | Reportes síncronos + `BackgroundTasks` | Celery + Redis para reportes muy grandes |
| Prompt injection desde el log | Bloque delimitado; el agente sólo propone | Clasificador de inyección previo al prompt |
| Alertas descartadas por umbral de severidad | Umbral configurable | Modelo de *novelty detection* para lo descartado |

---

## Licencia

Uso interno. **Atención:** n8n se distribuye bajo *Sustainable Use License* (uso interno
libre; revisar términos si se redistribuye comercialmente). Ollama (MIT), LangChain (MIT),
FastAPI (MIT), PostgreSQL (PostgreSQL License), React (MIT).
