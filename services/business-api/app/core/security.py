from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

PASSWORD_ITERATIONS = 210_000
PASSWORD_ALGORITHM = "sha256"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(password: str, salt: str | None = None) -> str:
    salt_bytes = bytes.fromhex(salt) if salt else secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac(
        PASSWORD_ALGORITHM,
        password.encode("utf-8"),
        salt_bytes,
        PASSWORD_ITERATIONS,
    )
    return f"{PASSWORD_ITERATIONS}${salt_bytes.hex()}${derived.hex()}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        iterations_text, salt_hex, hash_hex = password_hash.split("$", 2)
        iterations = int(iterations_text)
    except ValueError:
        return False
    recalculated = hashlib.pbkdf2_hmac(
        PASSWORD_ALGORITHM,
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        iterations,
    ).hex()
    return hmac.compare_digest(recalculated, hash_hex)


def create_token(
    secret_key: str,
    *,
    subject: str,
    token_type: str,
    expires_delta: timedelta,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    payload: dict[str, Any] = {
        "sub": subject,
        "typ": token_type,
        "iat": int(utcnow().timestamp()),
        "exp": int((utcnow() + expires_delta).timestamp()),
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, secret_key, algorithm="HS256")


def decode_token(secret_key: str, token: str) -> dict[str, Any]:
    return jwt.decode(token, secret_key, algorithms=["HS256"])

