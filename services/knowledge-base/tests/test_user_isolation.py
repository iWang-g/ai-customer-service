from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import jwt
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.db import init_db
from app.main import create_app
from app.schemas import DocumentCreate, KnowledgeBaseCreate, KnowledgeBaseUpdate, QaEntryCreate
from app.service import create_base, create_document, create_qa_entry, get_base, get_document, list_bases, match_qa, update_base
from app.schemas import QaMatchRequest


class KnowledgeBaseUserIsolationTests(unittest.TestCase):
    secret = "test-secret-for-knowledge-isolation-123456"

    def setUp(self) -> None:
        test_temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        test_temp_root.mkdir(exist_ok=True)
        self.database = test_temp_root / f"isolation-{uuid.uuid4().hex}.db"
        self.database_patch = patch("app.db.database_path", return_value=self.database)
        self.database_patch.start()
        init_db()

    def tearDown(self) -> None:
        self.database_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{self.database}{suffix}")
            if path.exists():
                path.unlink()

    def token(self, user_id: str) -> str:
        now = datetime.now(timezone.utc)
        return jwt.encode(
            {"sub": user_id, "typ": "access", "iat": now, "exp": now + timedelta(minutes=5)},
            self.secret,
            algorithm="HS256",
        )

    def test_service_functions_hide_bases_qa_and_documents_from_other_users(self) -> None:
        qa_base = create_base("user-a", KnowledgeBaseCreate(name="A QA", kind="qa"))
        create_qa_entry("user-a", qa_base["id"], QaEntryCreate(question="专属问题", answer="专属回答"))
        product_base = create_base("user-a", KnowledgeBaseCreate(name="A Product", kind="product"))
        document = create_document(
            "user-a",
            DocumentCreate(base_id=product_base["id"], title="私有资料", content="仅用户 A 可见"),
        )

        self.assertEqual(len(list_bases("user-a")), 2)
        self.assertEqual(list_bases("user-b"), [])
        self.assertFalse(match_qa("user-b", QaMatchRequest(query="专属问题")).get("matched"))
        with self.assertRaises(Exception) as raised:
            get_document("user-b", document["id"])
        self.assertEqual(getattr(raised.exception, "status_code", None), 404)

    def test_http_api_requires_token_and_returns_404_for_cross_user_base(self) -> None:
        base = create_base("user-a", KnowledgeBaseCreate(name="A Tone", kind="tone"))
        settings = Settings(JWT_SECRET_KEY=self.secret)
        with patch("app.auth.get_settings", return_value=settings):
            client = TestClient(create_app())
            self.assertEqual(client.get("/api/v1/knowledge-bases").status_code, 401)
            response = client.get(
                f"/api/v1/knowledge-bases/{base['id']}",
                headers={"Authorization": f"Bearer {self.token('user-b')}"},
            )
            self.assertEqual(response.status_code, 404)

    def test_public_base_is_readable_but_not_editable_by_another_user(self) -> None:
        base = create_base(
            "user-a",
            KnowledgeBaseCreate(name="Shared Tone", kind="tone", persona="友好", is_public=True),
            "owner-a",
            "用户 A",
        )

        visible = get_base("user-b", base["id"])
        self.assertIsNotNone(visible)
        self.assertTrue(visible["read_only"])
        self.assertEqual(visible["owner_display_name"], "用户 A")
        self.assertIn(base["id"], {item["id"] for item in list_bases("user-b")})
        with self.assertRaises(Exception) as raised:
            update_base("user-b", base["id"], KnowledgeBaseUpdate(name="Hijacked"))
        self.assertEqual(getattr(raised.exception, "status_code", None), 404)


if __name__ == "__main__":
    unittest.main()
