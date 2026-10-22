"""SOC-Lite · Microservicio de triaje con LangChain.

Expone un único endpoint funcional (`POST /triage`) consumido por el backend
FastAPI y por n8n, más endpoints de salud y de introspección. **Nunca se expone
a Internet**: corre en la red interna del stack Docker.

Ejecución: uvicorn app.main:app --host 0.0.0.0 --port 8001
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.agents.triage_agent import get_agent
from app.chains.prompts import PROMPT_VERSION
from app.core.config import settings
from app.schemas import HealthResponse, TriageRequest, TriageResponse
from app.tools.threat_intel import get_tools

logging.basicConfig(
    level=settings.LOG_LEVEL,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("soclite.triage.service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Iniciando %s v%s | proveedor=%s modelo=%s | herramientas=%d | LLM externo permitido=%s",
        settings.SERVICE_NAME, settings.SERVICE_VERSION, settings.LLM_PROVIDER,
        settings.OLLAMA_MODEL if settings.LLM_PROVIDER == "ollama" else settings.OPENAI_MODEL,
        len(get_tools()), settings.ALLOW_EXTERNAL_LLM,
    )
    if settings.ALLOW_EXTERNAL_LLM:
        logger.warning(
            "ALLOW_EXTERNAL_LLM=true: el contenido de las alertas se enviará a un proveedor externo. "
            "Verifique la base legal y la política de tratamiento de datos antes de usar en producción."
        )
    yield
    logger.info("Microservicio de triaje detenido")


app = FastAPI(
    title="SOC-Lite · Servicio de triaje LLM",
    description=(
        "Agente LangChain con herramientas de inteligencia de amenazas que clasifica, "
        "enriquece y prioriza alertas de SIEM. Inferencia local con Ollama por defecto."
    ),
    version=settings.SERVICE_VERSION,
    lifespan=lifespan,
    docs_url="/docs" if settings.ENVIRONMENT != "production" else None,
)


def verify_service_token(
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
    authorization: str | None = Header(default=None),
) -> None:
    """Autenticación servicio-a-servicio con token compartido."""
    provided = x_service_token or (authorization or "").removeprefix("Bearer ").strip()
    if provided != settings.INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token de servicio inválido")


@app.get("/health", response_model=HealthResponse, tags=["Salud"])
async def health() -> HealthResponse:
    """Comprueba la disponibilidad del microservicio y del LLM subyacente."""
    llm_reachable = False
    try:
        import httpx

        async with httpx.AsyncClient(timeout=4) as client:
            if settings.LLM_PROVIDER == "ollama":
                response = await client.get(f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/tags")
                llm_reachable = response.status_code == 200
            else:
                llm_reachable = True
    except Exception:
        llm_reachable = False

    return HealthResponse(
        status="ok" if llm_reachable else "degraded",
        service=settings.SERVICE_NAME,
        version=settings.SERVICE_VERSION,
        provider=settings.LLM_PROVIDER,
        model=settings.OLLAMA_MODEL if settings.LLM_PROVIDER == "ollama" else settings.OPENAI_MODEL,
        tools=[t.name for t in get_tools()],
        llm_reachable=llm_reachable,
        external_llm_allowed=settings.ALLOW_EXTERNAL_LLM,
    )


@app.post(
    "/triage",
    response_model=TriageResponse,
    tags=["Triaje"],
    dependencies=[Depends(verify_service_token)],
    summary="Clasificar y enriquecer una alerta",
)
async def triage(request: TriageRequest) -> TriageResponse:
    """Ejecuta el agente de triaje sobre una alerta y devuelve la evaluación estructurada.

    El agente consulta las herramientas disponibles (reputación de IP, VirusTotal,
    GeoIP, contexto histórico de la regla, memoria de falsos positivos, MITRE) y
    produce veredicto, severidad, score de riesgo, resumen ejecutivo, razonamiento
    trazable y acciones recomendadas.
    """
    started = time.perf_counter()
    logger.info(
        "Triaje solicitado alert_id=%s trace=%s rule=%s nivel=%s",
        request.alert_id, request.trace_id, request.alert.rule_id, request.alert.rule_level,
    )
    response = await get_agent().triage(request)
    logger.info(
        "Triaje completado alert_id=%s veredicto=%s riesgo=%s confianza=%.2f latencia=%dms herramientas=%s degradado=%s",
        request.alert_id, response.verdict, response.risk_score, response.confidence,
        response.latency_ms, ",".join(response.tools_used) or "-", response.degraded,
    )
    return response


@app.get("/triage/prompt", tags=["Triaje"], dependencies=[Depends(verify_service_token)])
async def current_prompt() -> dict:
    """Devuelve la versión de prompt activa (trazabilidad de cambios de prompt)."""
    from app.chains.prompts import SYSTEM_PROMPT, USER_TEMPLATE

    return {
        "prompt_version": PROMPT_VERSION,
        "system_prompt": SYSTEM_PROMPT,
        "user_template": USER_TEMPLATE,
        "model": settings.OLLAMA_MODEL if settings.LLM_PROVIDER == "ollama" else settings.OPENAI_MODEL,
        "temperature": settings.OLLAMA_TEMPERATURE,
    }


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Error no controlado en el servicio de triaje: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "Error interno del servicio de triaje", "error": str(exc)[:300]},
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8001, reload=settings.ENVIRONMENT == "development")
