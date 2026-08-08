from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = Field(default="AI Customer Service Business API", alias="APP_NAME")
    environment: str = Field(default="development", alias="ENVIRONMENT")
    api_prefix: str = Field(default="/api/v1", alias="API_PREFIX")
    database_url: str = Field(
        default="sqlite:///./data/business-api.db",
        alias="DATABASE_URL",
    )
    jwt_secret_key: str = Field(
        default="development-only-secret-change-in-production",
        alias="JWT_SECRET_KEY",
    )
    access_token_expire_minutes: int = Field(default=60, alias="ACCESS_TOKEN_EXPIRE_MINUTES")
    refresh_token_expire_days: int = Field(default=14, alias="REFRESH_TOKEN_EXPIRE_DAYS")
    default_admin_username: str = Field(default="admin", alias="DEFAULT_ADMIN_USERNAME")
    default_admin_password: str = Field(default="admin123", alias="DEFAULT_ADMIN_PASSWORD")
    default_admin_display_name: str = Field(default="管理员", alias="DEFAULT_ADMIN_DISPLAY_NAME")
    seed_demo_data: bool = Field(default=True, alias="SEED_DEMO_DATA")
    auto_create_tables: bool = Field(default=True, alias="AUTO_CREATE_TABLES")
    cors_allow_origins: str = Field(
        default="http://127.0.0.1:9527,http://localhost:9527,null",
        alias="CORS_ALLOW_ORIGINS",
    )
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    heartbeat_timeout_seconds: int = Field(default=120, alias="HEARTBEAT_TIMEOUT_SECONDS")
    ai_reply_base_url: str = Field(default="http://127.0.0.1:8020", alias="AI_REPLY_BASE_URL")
    knowledge_base_url: str = Field(default="http://127.0.0.1:8010", alias="KNOWLEDGE_BASE_URL")
    pdd_message_snapshot_write_enabled: bool = Field(
        default=False,
        alias="PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED",
    )

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allow_origins.split(",") if origin.strip()]

@lru_cache
def get_settings() -> Settings:
    return Settings()
