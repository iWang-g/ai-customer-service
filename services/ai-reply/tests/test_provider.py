from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.provider import generate_with_provider


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_json_mode_and_temperature_are_forwarded_to_provider(self) -> None:
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [{"message": {"content": '{"intent":"normal_question"}'}}]
        }
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None
        client.post.return_value = response
        with patch("app.provider.httpx.AsyncClient", return_value=client):
            content, provider = await generate_with_provider(
                system="system",
                user="user",
                provider_config={
                    "provider": "deepseek",
                    "base_url": "https://api.deepseek.com",
                    "model": "deepseek-chat",
                    "api_key": "test-key",
                    "enabled": True,
                    "temperature": 0.8,
                },
                temperature=0,
                json_mode=True,
            )

        payload = client.post.await_args.kwargs["json"]
        self.assertEqual(content, '{"intent":"normal_question"}')
        self.assertEqual(provider, "deepseek")
        self.assertEqual(payload["temperature"], 0)
        self.assertEqual(payload["response_format"], {"type": "json_object"})


if __name__ == "__main__":
    unittest.main()
