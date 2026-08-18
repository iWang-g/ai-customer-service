from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.provider import generate_with_provider


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_json_mode_and_temperature_are_forwarded_to_provider(self) -> None:
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [{"message": {"content": '{"intent":"normal_question"}'}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 5},
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
                    "model": "deepseek-v4-flash",
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

    async def test_model_call_observation_captures_usage_and_stage(self) -> None:
        from app.provider import finish_model_call_observations, start_model_call_observations

        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [{"message": {"content": "reply"}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 8},
        }
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None
        client.post.return_value = response
        token = start_model_call_observations()
        try:
            with patch("app.provider.httpx.AsyncClient", return_value=client):
                await generate_with_provider(
                    system="system",
                    user="user",
                    provider_config={
                        "provider": "deepseek",
                        "base_url": "https://api.deepseek.com",
                        "model": "deepseek-v4-flash",
                        "api_key": "test-key",
                        "enabled": True,
                    },
                    stage="intent",
                )
            observations = finish_model_call_observations(token)
        except Exception:
            finish_model_call_observations(token)
            raise

        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]["stage"], "intent")
        self.assertEqual(observations[0]["model"], "deepseek-v4-flash")
        self.assertEqual(observations[0]["input_tokens"], 20)
        self.assertEqual(observations[0]["output_tokens"], 8)


if __name__ == "__main__":
    unittest.main()
