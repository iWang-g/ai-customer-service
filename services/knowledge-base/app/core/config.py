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
    embedding_enabled: bool = Field(default=True, alias="KB_EMBEDDING_ENABLED")
    embedding_provider: str = Field(default="fastembed", alias="KB_EMBEDDING_PROVIDER")
    embedding_model: str = Field(default="BAAI/bge-small-zh-v1.5", alias="KB_EMBEDDING_MODEL")
    embedding_cache_path: str = Field(default="./data/models", alias="KB_EMBEDDING_CACHE_PATH")
    embedding_local_files_only: bool = Field(default=True, alias="KB_EMBEDDING_LOCAL_FILES_ONLY")
    embedding_batch_size: int = Field(default=16, ge=1, le=128, alias="KB_EMBEDDING_BATCH_SIZE")
    vector_search_enabled: bool = Field(default=True, alias="KB_VECTOR_SEARCH_ENABLED")
    vector_min_score: float = Field(default=0.5, ge=-1.0, le=1.0, alias="KB_VECTOR_MIN_SCORE")
    vector_candidate_limit: int = Field(default=80, ge=1, le=1000, alias="KB_VECTOR_CANDIDATE_LIMIT")
    hybrid_fts_limit: int = Field(default=80, ge=1, le=1000, alias="KB_HYBRID_FTS_LIMIT")
    hybrid_rrf_k: int = Field(default=60, ge=1, le=1000, alias="KB_HYBRID_RRF_K")
    jwt_secret_key: str = Field(
        default="development-only-secret-change-in-production",
        alias="JWT_SECRET_KEY",
    )
    legacy_owner_user_id: str = Field(default="", alias="KB_LEGACY_OWNER_USER_ID")
    cors_allow_origins: str = Field(
        default="http://127.0.0.1:9527,http://localhost:9527,null",
        alias="KB_CORS_ALLOW_ORIGINS",
    )

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allow_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
