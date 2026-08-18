from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from app.db import init_db
from app.schemas import KnowledgeBaseCreate, KnowledgeBaseUpdate
from app.service import create_base, delete_base, get_base, list_bases, update_base


class ToneKnowledgeBaseTests(unittest.TestCase):
    user_id = "user-tone"
    def setUp(self) -> None:
        test_temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        test_temp_root.mkdir(exist_ok=True)
        self.database = test_temp_root / f"tone-{uuid.uuid4().hex}.db"
        self.database_patch = patch("app.db.database_path", return_value=self.database)
        self.database_patch.start()
        init_db()

    def tearDown(self) -> None:
        self.database_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{self.database}{suffix}")
            if path.exists():
                path.unlink()

    def test_tone_base_persona_is_persisted_and_updated(self) -> None:
        created = create_base(self.user_id, KnowledgeBaseCreate(
            name="亲切语气库",
            kind="tone",
            persona="亲切耐心地回答客户",
        ))
        self.assertEqual(created["kind"], "tone")
        self.assertEqual(created["persona"], "亲切耐心地回答客户")
        self.assertEqual(list_bases(self.user_id, "tone"), [created])

        updated = update_base(
            self.user_id, created["id"],
            KnowledgeBaseUpdate(name="朋友式语气库", persona="像朋友一样自然交流"),
        )
        self.assertEqual(updated["name"], "朋友式语气库")
        self.assertEqual(updated["persona"], "像朋友一样自然交流")
        self.assertEqual(get_base(self.user_id, created["id"]), updated)

        deleted = delete_base(self.user_id, created["id"])
        self.assertEqual(deleted["id"], created["id"])
        self.assertIsNone(get_base(self.user_id, created["id"]))

    def test_public_tone_base_is_read_only_for_other_users(self) -> None:
        created = create_base(
            self.user_id,
            KnowledgeBaseCreate(name="公开语气库", kind="tone", persona="友好", is_public=True),
            "tone-owner",
            "语气库作者",
        )

        visible = get_base("reader", created["id"])
        self.assertIsNotNone(visible)
        self.assertTrue(visible["read_only"])
        self.assertEqual(visible["owner_display_name"], "语气库作者")
        with self.assertRaises(Exception) as raised:
            update_base("reader", created["id"], KnowledgeBaseUpdate(name="越权修改"))
        self.assertEqual(getattr(raised.exception, "status_code", None), 404)

    def test_product_base_crud_is_persisted(self) -> None:
        created = create_base(self.user_id, KnowledgeBaseCreate(name="产品资料库", kind="product"))
        self.assertEqual(created["kind"], "product")
        self.assertEqual(created["item_count"], 0)
        self.assertEqual(list_bases(self.user_id, "product"), [created])

        updated = update_base(self.user_id, created["id"], KnowledgeBaseUpdate(name="主打产品资料库"))
        self.assertEqual(updated["name"], "主打产品资料库")

        delete_base(self.user_id, created["id"])
        self.assertEqual(list_bases(self.user_id, "product"), [])


if __name__ == "__main__":
    unittest.main()
