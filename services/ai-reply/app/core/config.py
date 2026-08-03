from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = Field(default="AI Customer Service Reply Service", alias="AI_REPLY_APP_NAME")
    host: str = Field(default="127.0.0.1", alias="AI_REPLY_HOST")
    port: int = Field(default=8020, alias="AI_REPLY_PORT")
    knowledge_base_url: str = Field(default="http://127.0.0.1:8010", alias="KNOWLEDGE_BASE_URL")
    provider: str = Field(default="local", alias="AI_PROVIDER")
    model: str = Field(default="deepseek-chat", alias="AI_MODEL")
    provider_base_url: str = Field(default="https://api.deepseek.com", alias="AI_PROVIDER_BASE_URL")
    provider_api_key: str = Field(default="", alias="AI_PROVIDER_API_KEY")
    deepseek_api_key: str = Field(default="", alias="DEEPSEEK_API_KEY")
    temperature: float = Field(default=0.2, alias="AI_TEMPERATURE")
    request_timeout_seconds: float = Field(default=20.0, alias="AI_REQUEST_TIMEOUT_SECONDS")


@lru_cache
def get_settings() -> Settings:
    return Settings()
