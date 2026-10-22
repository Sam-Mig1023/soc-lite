# =====================================================================
# SOC-Lite · Microservicio de triaje (LangChain + LangGraph)
# =====================================================================
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip wheel \
    && /opt/venv/bin/pip install -r requirements.txt

# ---------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    TZ=America/Santiago

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl libmaxminddb0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash --uid 10002 triage

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=triage:triage app ./app

# Directorio para la base GeoLite2 (se monta como volumen de sólo lectura)
RUN mkdir -p /data && chown -R triage:triage /data

USER triage

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=15s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:8001/health || exit 1

# 2 workers: el agente mantiene conexión con Ollama y estado del grafo
CMD ["gunicorn", "app.main:app", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--workers", "2", \
     "--bind", "0.0.0.0:8001", \
     "--timeout", "180", \
     "--graceful-timeout", "30", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
