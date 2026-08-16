"""Settings.

Uses ``SettingsConfigDict`` rather than KookarCore's legacy inner ``class
Config``, and stays a focused ~30 fields rather than a 591-field monolith.
Importing this module has NO side effects - KookarCore's exports keys into
``os.environ`` at import time, which makes test isolation painful.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(PROJECT_ROOT / ".env"), ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # --- app -------------------------------------------------------------
    API_NAME: str = "Nutrient Tracker API"
    API_VERSION: str = "0.1.0"
    DESCRIPTION: str = "Personal calorie tracker. The only service that talks to the database."
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = False
    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"

    # --- supabase --------------------------------------------------------
    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""
    # Server-only. FastAPI is the sole application database client.
    SUPABASE_SERVICE_ROLE_KEY: str = ""

    # --- auth ------------------------------------------------------------
    # Permanent HS256 backend JWTs identify users without changing API URLs.
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    # Local-only escape hatch. Compile-time excluded from production builds.
    DISABLE_AUTH_FOR_LOCAL: bool = False

    # --- cors ------------------------------------------------------------
    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001"

    # --- llm -------------------------------------------------------------
    OPENAI_API_KEY: str = ""
    ORCHESTRATION_MODEL: str = "gpt-5.4"
    MANUAL_RESOLVER_MODEL: str = "gpt-4.1-mini"
    MEDIA_MEAL_RESOLVER_MODEL: str = "gpt-4.1-mini"
    VISION_MODEL: str = "gpt-4.1-mini"
    AUDIO_MODEL: str = "gpt-4o-mini-transcribe"

    # --- LangSmith (optional prompt registry + tracing) -------------------
    LANGSMITH_API_KEY: str = ""
    LANGSMITH_ENDPOINT: str = "https://api.smith.langchain.com"
    LANGSMITH_WORKSPACE_ID: str = ""
    LANGSMITH_PROJECT: str = "nutrient-tracker-agents"
    LANGSMITH_TRACING: bool = False

    # --- cache (optional; the app runs without it) ------------------------
    REDIS_URL: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def ai_enabled(self) -> bool:
        """AI features degrade to a clear disabled state without a key."""
        return bool(self.OPENAI_API_KEY)

    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() in {"production", "prod"}


settings = Settings()
