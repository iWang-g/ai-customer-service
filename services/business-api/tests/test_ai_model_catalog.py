from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, Mock, patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.api.routes.ai_config import list_catalog, sync_models
from app.models import AiModelCatalog, AiProviderConfig, Base, Robot, User
from app.services.ai_model_catalog_service import remove_unsupported_models


class AiModelCatalogTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="models", display_name="Models", password_hash="unused")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    async def test_sync_replaces_availability_without_exposing_credentials(self) -> None:
        self.db.add(AiModelCatalog(provider="deepseek", model_id="old", display_name="old", available=True))
        self.db.commit()
        response = Mock(status_code=200)
        response.json.return_value = {
            "data": [
                {"id": "deepseek-chat"},
                {"id": "deepseek-v4-pro"},
                {"id": "deepseek-v4-flash"},
                {"id": "deepseek-reasoner"},
            ]
        }
        response.raise_for_status.return_value = None
        client = AsyncMock()
        client.get.return_value = response
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = None

        with patch("app.api.routes.ai_config.provider_credentials", return_value=("deepseek", "https://example.invalid", "secret")), patch(
            "app.api.routes.ai_config.httpx.AsyncClient", return_value=context
        ):
            result = await sync_models(self.user, self.db)

        values = {item.model_id: item.available for item in result.items}
        self.assertEqual(values, {"deepseek-v4-flash": True, "deepseek-v4-pro": True})
        self.assertFalse(self.db.scalar(
            select(AiModelCatalog.available).where(AiModelCatalog.model_id == "old")
        ))
        self.assertFalse(hasattr(result.items[0], "api_key"))
        self.assertEqual(len(list_catalog(self.db).items), 2)

    async def test_catalog_cleanup_removes_legacy_models(self) -> None:
        self.db.add_all([
            AiModelCatalog(provider="deepseek", model_id="deepseek-chat", display_name="deepseek-chat"),
            AiModelCatalog(provider="deepseek", model_id="deepseek-v4-flash", display_name="deepseek-v4-flash"),
            AiProviderConfig(user_id=self.user.id, model="deepseek-chat"),
            Robot(user_id=self.user.id, name="legacy", config_json={"model": "deepseek-chat"}),
        ])
        self.db.commit()

        remove_unsupported_models(self.db)
        self.db.commit()
        self.db.expire_all()

        self.assertEqual(
            list(self.db.scalars(select(AiModelCatalog.model_id)).all()),
            ["deepseek-v4-flash"],
        )
        config = self.db.scalar(select(AiProviderConfig).where(AiProviderConfig.user_id == self.user.id))
        self.assertIsNotNone(config)
        self.assertEqual(config.model, "deepseek-v4-flash")
        robot = self.db.scalar(select(Robot).where(Robot.user_id == self.user.id))
        self.assertIsNotNone(robot)
        self.assertEqual(robot.config_json["model"], "deepseek-v4-flash")


if __name__ == "__main__":
    unittest.main()
