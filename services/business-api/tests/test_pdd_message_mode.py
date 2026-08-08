from __future__ import annotations

import unittest

from app.core.config import Settings
from app.models import PlatformAccount, User
from app.services.pdd_message_mode import pdd_message_write_mode


class PddMessageModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.user = User(id="user-1", username="mode", password_hash="unused")
        self.account = PlatformAccount(
            id="account-1",
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            account_name="Shop",
            metadata_json={},
        )

    def settings(self, **overrides: object) -> Settings:
        values = {
            "PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED": False,
            **overrides,
        }
        return Settings(_env_file=None, **values)

    def test_default_mode_is_disabled(self) -> None:
        self.assertEqual(
            pdd_message_write_mode(self.settings()),
            "disabled",
        )

    def test_global_switch_enables_every_shop(self) -> None:
        self.assertEqual(
            pdd_message_write_mode(
                self.settings(PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED=True),
            ),
            "snapshot",
        )

    def test_shop_metadata_cannot_opt_out_of_platform_switch(self) -> None:
        self.account.metadata_json = {"pdd_message_snapshot_write_enabled": False}
        self.assertEqual(
            pdd_message_write_mode(
                self.settings(PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED=True),
            ),
            "snapshot",
        )

    def test_switch_off_disables_message_writes(self) -> None:
        self.assertEqual(
            pdd_message_write_mode(self.settings()),
            "disabled",
        )


if __name__ == "__main__":
    unittest.main()
