# =====================================================================
# SOC-Lite · Backend FastAPI
# Multi-stage: builder con compiladores, runtime mínimo sin toolchain.
# =====================================================================
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
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

# Librerías de sistema mínimas (libpq para PostgreSQL, fuentes para ReportLab)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash --uid 10001 soclite

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=soclite:soclite app ./app
COPY --chown=soclite:soclite tests ./tests

RUN mkdir -p /app/storage/reports /app/storage/tmp \
    && chown -R soclite:soclite /app/storage

USER soclite

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

# 4 workers Uvicorn tras el balanceador de nginx
CMD ["gunicorn", "app.main:app", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--workers", "4", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "180", \
     "--graceful-timeout", "30", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
