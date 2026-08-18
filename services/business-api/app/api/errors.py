from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


def _utf8_safe(value: Any) -> Any:
    if isinstance(value, str):
        return "".join(
            "�" if 0xD800 <= ord(character) <= 0xDFFF else character
            for character in value
        )
    if isinstance(value, dict):
        return {str(key): _utf8_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_utf8_safe(item) for item in value]
    return value


async def request_validation_exception_handler(
    _request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": _utf8_safe(exc.errors())})
