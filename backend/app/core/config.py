"""SOC-Lite · Configuración central (Pydantic Settings).

Todas las variables se leen de entorno o de `.env`. Los secretos nunca
se codifican en el repositorio (ISO 27001 A.5.17, A.8.24).
"""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any, Literal

from pydantic import Field, PostgresDsn, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # Aplicación
    # ------------------------------------------------------------------
    APP_NAME: str = "SOC-Lite"
    APP_VERSION: str = "1.0.0"
    ENVIRONMENT: Literal["development", "staging", "production"] = "development"
    DEBUG: bool = False
    API_V1_PREFIX: str = "/api/v1"
    TIMEZONE: str = "America/Santiago"
    BASE_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:5173"

    # ------------------------------------------------------------------
    # Seguridad / JWT
    # ------------------------------------------------------------------
    SECRET_KEY: str = Field(default="CAMBIAR-ESTA-CLAVE-EN-PRODUCCION-32+CHARS", min_length=32)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_MINUTES: int = 480
    PASSWORD_MIN_LENGTH: int = 12
    MAX_LOGIN_ATTEMPTS: int = 5
    LOCKOUT_MINUTES: int = 15
    MFA_ISSUER: str = "SOC-Lite"

    # Token de servicio para llamadas internas (n8n → backend)
    INTERNAL_SERVICE_TOKEN: str = "cambiar-token-servicio-interno"
    # Clave de ingesta del webhook de Wazuh
    INGEST_API_KEY: str = "cambiar-clave-ingesta"

    # ------------------------------------------------------------------
    # CORS
    # ------------------------------------------------------------------
    # NoDecode lets the validator accept the documented comma-separated .env value.
    CORS_ORIGINS: Annotated[list[str], NoDecode] = [
        "http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"
    ]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, v: Any) -> Any:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    # ------------------------------------------------------------------
    # PostgreSQL
    # ------------------------------------------------------------------
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "soclite"
    POSTGRES_PASSWORD: str = "soclite"
    POSTGRES_DB: str = "soclite"
    POSTGRES_SCHEMA: str = "soclite"
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_ECHO: bool = False

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def sync_database_url(self) -> str:
        return (
            f"postgresql+psycopg2://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    # ------------------------------------------------------------------
    # Redis (caché de enriquecimiento + bloqueo de intentos fallidos)
    # ------------------------------------------------------------------
    REDIS_URL: str = "redis://localhost:6379/0"
    ENRICHMENT_CACHE_TTL: int = 86_400  # 24 h

    # ------------------------------------------------------------------
    # Microservicio LangChain (triaje LLM)
    # ------------------------------------------------------------------
    LANGCHAIN_SERVICE_URL: str = "http://localhost:8001"
    LANGCHAIN_TIMEOUT_SECONDS: int = 360
    LANGCHAIN_MAX_RETRIES: int = 1
    TRIAGE_PROMPT_VERSION: str = "triage_v4"
    LLM_PROVIDER: Literal["ollama", "openai", "azure"] = "ollama"
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "llama3.1:8b"
    OPENAI_API_KEY: str | None = None
    OPENAI_MODEL: str = "gpt-4o-mini"
    ALLOW_EXTERNAL_LLM: bool = False  # política de no exfiltración de datos de alertas

    # ------------------------------------------------------------------
    # Integraciones de inteligencia de amenazas
    # ------------------------------------------------------------------
    VIRUSTOTAL_API_KEY: str | None = None
    ABUSEIPDB_API_KEY: str | None = None
    SHODAN_API_KEY: str | None = None
    OTX_API_KEY: str | None = None
    GEOIP_DB_PATH: str = "/data/GeoLite2-City.mmdb"
    THREAT_INTEL_ENABLED: bool = True

    # ------------------------------------------------------------------
    # Notificaciones / ticketing
    # ------------------------------------------------------------------
    SLACK_WEBHOOK_URL: str | None = None
    SLACK_CHANNEL: str = "#soc-alertas"
    TELEGRAM_BOT_TOKEN: str | None = None
    TELEGRAM_CHAT_ID: str | None = None
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_FROM: str = "soc-lite@org.local"
    N8N_REPORT_EMAIL_WEBHOOK_URL: str | None = None
    N8N_REPORT_EMAIL_WEBHOOK_SECRET: str | None = None
    OSTICKET_BASE_URL: str | None = None
    OSTICKET_API_KEY: str | None = None
    REDMINE_BASE_URL: str | None = None
    REDMINE_API_KEY: str | None = None

    # ------------------------------------------------------------------
    # Reglas de negocio del triaje (umbrales configurables)
    # ------------------------------------------------------------------
    MIN_SEVERITY_TO_PROCESS: int = 7          # rule_level Wazuh mínimo
    DEDUP_WINDOW_MINUTES: int = 5
    SUPPRESSION_WINDOW_MINUTES: int = 30
    RISK_SCORE_ESCALATION_THRESHOLD: int = 75
    AUTO_CLOSE_FP_CONFIDENCE: float = 0.90    # cierre automático si FP con alta confianza
    SLA_MINUTES: dict[str, int] = {
        "critical": 15,
        "high": 60,
        "medium": 480,
        "low": 1440,
        "info": 2880,
    }

    # ------------------------------------------------------------------
    # Reportes
    # ------------------------------------------------------------------
    REPORTS_DIR: str = "./storage/reports"
    REPORT_RETENTION_DAYS: int = 365
    COMPANY_NAME: str = "Organización Demo S.A."
    COMPANY_LOGO: str | None = "./assets/logo.png"

    # ------------------------------------------------------------------
    # Observabilidad
    # ------------------------------------------------------------------
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: Literal["json", "console"] = "json"
    SENTRY_DSN: str | None = None
    ENABLE_METRICS: bool = True


@lru_cache
def get_settings() -> Settings:
    """Instancia única de configuración (cacheada)."""
    return Settings()


settings = get_settings()
