from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

AVATAR_CACHE_ROUTE = "/media/avatar-cache"
LOGO_CACHE_ROUTE = "/media/logo-cache"
_MAX_AVATAR_BYTES = 1024 * 1024
_CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def get_business_data_dir() -> Path:
    settings = get_settings()
    database_url = settings.database_url
    if database_url.startswith("sqlite:///"):
        raw_path = database_url.replace("sqlite:///", "", 1)
        if raw_path and raw_path != ":memory:":
            return Path(unquote(raw_path)).expanduser().parent
    return Path("./data")


def get_avatar_cache_dir() -> Path:
    return get_business_data_dir() / "avatar-cache"


def get_logo_cache_dir() -> Path:
    return get_business_data_dir() / "logo-cache"


def _cached_url(filename: str) -> str:
    return f"{AVATAR_CACHE_ROUTE}/{filename}"


def _hash_url(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:40]


def _existing_cached_avatar(cache_dir: Path, url_hash: str) -> str | None:
    for extension in {".jpg", ".png", ".webp", ".gif"}:
        candidate = cache_dir / f"{url_hash}{extension}"
        if candidate.is_file():
            return _cached_url(candidate.name)
    return None


def _cache_remote_image(
    image_url: str,
    *,
    cache_dir: Path,
    route: str,
    log_label: str,
) -> str | None:
    image_url = image_url.strip()
    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None

    cache_dir.mkdir(parents=True, exist_ok=True)
    url_hash = _hash_url(image_url)
    existing = _existing_cached_avatar(cache_dir, url_hash)
    if existing:
        return existing.replace(AVATAR_CACHE_ROUTE, route, 1)

    try:
        with httpx.Client(timeout=5.0, follow_redirects=True, trust_env=False) as client:
            with client.stream("GET", image_url, headers={"User-Agent": "Mozilla/5.0"}) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                extension = _CONTENT_TYPE_EXTENSIONS.get(content_type)
                if not extension:
                    logger.warning("unsupported %s content type: %s", log_label, content_type or "<empty>")
                    return None
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > _MAX_AVATAR_BYTES:
                        logger.warning("%s too large: %s bytes", log_label, total)
                        return None
                    chunks.append(chunk)
    except Exception as exc:  # noqa: BLE001
        logger.warning("failed to cache %s: %s", log_label, exc)
        return None

    filename = f"{url_hash}{extension}"
    target = cache_dir / filename
    temp_target = cache_dir / f"{filename}.tmp"
    try:
        temp_target.write_bytes(b"".join(chunks))
        temp_target.replace(target)
    except OSError as exc:
        logger.warning("failed to write %s cache: %s", log_label, exc)
        try:
            temp_target.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    return f"{route}/{filename}"


def cache_customer_avatar(avatar_url: str) -> str | None:
    return _cache_remote_image(
        avatar_url,
        cache_dir=get_avatar_cache_dir(),
        route=AVATAR_CACHE_ROUTE,
        log_label="customer avatar",
    )


def cache_shop_logo(logo_url: str) -> str | None:
    return _cache_remote_image(
        logo_url,
        cache_dir=get_logo_cache_dir(),
        route=LOGO_CACHE_ROUTE,
        log_label="shop logo",
    )
