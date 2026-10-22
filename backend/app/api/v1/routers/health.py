"""SOC-Lite · Router de salud y observabilidad."""
from __future__ import annotations

import httpx
from fastapi import APIRouter

from app.core.config import settings
from app.db.session import check_database_health

router = APIRouter(tags=["Salud"])


@router.get("/health", summary="Liveness probe")
async def health() -> dict:
    return {"status": "ok", "service": settings.APP_NAME, "version": settings.APP_VERSION,
            "environment": settings.ENVIRONMENT}


@router.get("/health/ready", summary="Readiness probe (PostgreSQL + microservicio LLM)")
async def readiness() -> dict:
    db = await check_database_health()

    llm_status: dict = {"status": "unreachable"}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{settings.LANGCHAIN_SERVICE_URL.rstrip('/')}/health")
            llm_status = response.json() if response.status_code == 200 else {"status": f"http_{response.status_code}"}
    except Exception as exc:  # pragma: no cover
        llm_status = {"status": "unreachable", "error": str(exc)}

    overall = "ok" if db.get("status") == "ok" else "degraded"
    return {
        "status": overall,
        "version": settings.APP_VERSION,
        "components": {
            "database": db,
            "llm_service": llm_status,
            "llm_provider": settings.LLM_PROVIDER,
            "llm_model": settings.OLLAMA_MODEL if settings.LLM_PROVIDER == "ollama" else settings.OPENAI_MODEL,
        },
    }
