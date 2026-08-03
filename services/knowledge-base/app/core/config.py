from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = Field(default="AI Customer Service Knowledge Base", alias="KB_APP_NAME")
    database_path: str = Field(default="./data/knowledge-base.db", alias="KB_DATABASE_PATH")
    asset_path: str = Field(default="./data/assets", alias="KB_ASSET_PATH")
    host: str = Field(default="127.0.0.1", alias="KB_HOST")
    port: int = Field(default=8010, alias="KB_PORT")
    log_level: str = Field(default="INFO", alias="KB_LOG_LEVEL")


@lru_cache
def get_settings() -> Settings:
    return Settings()
