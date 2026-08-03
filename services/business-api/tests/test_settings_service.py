from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User
from app.schemas.settings import UserSettingsUpdate
from app.services.settings_service import auto_reply_enabled, read_user_settings, save_user_settings


class SettingsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="settings-user", display_name="Settings User", password_hash="not-used")
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_user_settings_default_auto_reply_off(self) -> None:
        settings = read_user_settings(self.db, self.user)

        self.assertFalse(settings.auto_reply_enabled)
        self.assertFalse(auto_reply_enabled(self.db, self.user))

    def test_user_settings_can_enable_auto_reply(self) -> None:
        saved = save_user_settings(
            self.db,
            self.user,
            UserSettingsUpdate(auto_reply_enabled=True),
        )

        self.assertTrue(saved.auto_reply_enabled)
        self.assertTrue(auto_reply_enabled(self.db, self.user))


if __name__ == "__main__":
    unittest.main()
