from __future__ import annotations

import array
import logging
import math
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from app.core.config import get_settings


logger = logging.getLogger(__name__)


def embedding_cache_path() -> Path:
    settings = get_settings()
    path = Path(settings.embedding_cache_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    path.mkdir(parents=True, exist_ok=True)
    return path


@lru_cache(maxsize=1)
def _model() -> object | None:
    settings = get_settings()
    if not settings.embedding_enabled:
        return None
    if settings.embedding_provider != "fastembed":
        logger.warning("embedding provider unsupported provider=%s", settings.embedding_provider)
        return None
    try:
        from fastembed import TextEmbedding

        options = {
            "model_name": settings.embedding_model,
            "cache_dir": str(embedding_cache_path()),
        }
        try:
            return TextEmbedding(**options, local_files_only=settings.embedding_local_files_only)
        except TypeError:
            return TextEmbedding(**options)
    except Exception as exc:
        logger.warning("embedding model unavailable model=%s error_type=%s", settings.embedding_model, type(exc).__name__)
        return None


def reset_embedding_model_cache() -> None:
    _model.cache_clear()


def embedding_available() -> bool:
    return _model() is not None


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = _model()
    if model is None:
        return []
    cleaned = [str(text or "").strip() for text in texts]
    if not cleaned:
        return []
    try:
        settings = get_settings()
        vectors = model.embed(cleaned, batch_size=settings.embedding_batch_size)  # type: ignore[attr-defined]
        return [[float(value) for value in vector] for vector in vectors]
    except Exception as exc:
        logger.warning("embedding generation failed error_type=%s", type(exc).__name__)
        return []


def pack_vector(vector: Iterable[float]) -> bytes:
    values = array.array("f", (float(value) for value in vector))
    if values.itemsize != 4:
        raise ValueError("float32 array is required")
    return values.tobytes()


def unpack_vector(payload: bytes) -> list[float]:
    values = array.array("f")
    values.frombytes(payload or b"")
    return [float(value) for value in values]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return dot / (left_norm * right_norm)
