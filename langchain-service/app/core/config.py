"""SOC-Lite · Configuración del microservicio de triaje."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore", case_sensitive=False)

    SERVICE_NAME: str = "soc-lite-triage"
    SERVICE_VERSION: str = "1.0.0"
    ENVIRONMENT: Literal["development", "staging", "production"] = "development"
    LOG_LEVEL: str = "INFO"

    # LLM
    LLM_PROVIDER: Literal["ollama", "openai", "azure"] = "ollama"
    OLLAMA_BASE_URL: str = "http://ollama:11434"
    OLLAMA_MODEL: str = "llama3.1:8b"
    OLLAMA_TEMPERATURE: float = 0.1
    OLLAMA_NUM_CTX: int = 8192
    OPENAI_API_KEY: str | None = None
    OPENAI_MODEL: str = "gpt-4o-mini"
    OPENAI_TEMPERATURE: float = 0.1
    ALLOW_EXTERNAL_LLM: bool = False
    MAX_AGENT_ITERATIONS: int = 8
    AGENT_TIMEOUT_SECONDS: int = 90

    # Inteligencia de amenazas
    VIRUSTOTAL_API_KEY: str | None = None
    ABUSEIPDB_API_KEY: str | None = None
    OTX_API_KEY: str | None = None
    GEOIP_DB_PATH: str = "/data/GeoLite2-City.mmdb"
    THREAT_INTEL_ENABLED: bool = True
    TI_CACHE_TTL_SECONDS: int = 86400
    TI_HTTP_TIMEOUT: int = 10

    # Caché
    REDIS_URL: str = "redis://redis:6379/0"

    # Seguridad interna
    INTERNAL_SERVICE_TOKEN: str = "cambiar-token-servicio-interno"
    BACKEND_URL: str = "http://backend:8000"

    # Prompt
    PROMPT_VERSION: str = "triage_v3"
    ENABLE_LANGSMITH: bool = False
    LANGCHAIN_TRACING_V2: bool = False
    LANGCHAIN_API_KEY: str | None = None
    LANGCHAIN_PROJECT: str = "soc-lite-triage"

    # Umbrales de decisión
    AUTO_ESCALATE_RISK: int = 75
    AUTO_CLOSE_FP_CONFIDENCE: float = 0.90


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
