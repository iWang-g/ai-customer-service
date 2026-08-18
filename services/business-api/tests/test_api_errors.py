from __future__ import annotations

import asyncio
import json
import unittest

from fastapi.exceptions import RequestValidationError

from app.api.errors import request_validation_exception_handler


class ApiErrorHandlerTests(unittest.TestCase):
    def test_invalid_unicode_validation_input_returns_utf8_safe_422(self) -> None:
        error = RequestValidationError(
            [
                {
                    "type": "string_unicode",
                    "loc": ("body", "accounts", 0, "account_name"),
                    "msg": "Input should be a valid string",
                    "input": "broken\udcb7",
                }
            ]
        )

        response = asyncio.run(request_validation_exception_handler(None, error))
        payload = json.loads(response.body.decode("utf-8"))

        self.assertEqual(response.status_code, 422)
        self.assertEqual(payload["detail"][0]["input"], "broken�")


if __name__ == "__main__":
    unittest.main()
