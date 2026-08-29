from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, PlatformAccount, PlatformPhraseSnapshot, User
from app.api.routes.platform_phrases import PlatformPhraseNormalizeRequest, _sanitize_model_items
from app.api.routes.platform_phrases import (
    PlatformPhraseSnapshotUpsertRequest,
    get_platform_phrase_cache,
    upsert_platform_phrase_cache,
)


class PlatformPhraseNormalizeRequestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(
            username="platform-phrases",
            display_name="Platform Phrases",
            password_hash="not-used",
        )
        self.db.add(self.user)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_nullable_phrase_fields_are_normalized_to_empty_strings(self) -> None:
        request = PlatformPhraseNormalizeRequest.model_validate({
            "platform": "pinduoduo",
            "source": "personal",
            "records": [{
                "source_id": None,
                "category": None,
                "quick_key": None,
                "content": "hello",
                "images": [{"url": None}],
            }],
        })

        record = request.records[0]
        self.assertEqual(record.source_id, "")
        self.assertEqual(record.category, "")
        self.assertEqual(record.quick_key, "")
        self.assertEqual(record.content, "hello")
        self.assertEqual(record.images[0].url, "")

    def test_existing_categories_are_accepted(self) -> None:
        request = PlatformPhraseNormalizeRequest.model_validate({
            "platform": "pinduoduo",
            "source": "team",
            "existing_categories": ["常见问题", "定制需求"],
            "records": [{"source_id": "pdd-team:1", "content": "hello"}],
        })

        self.assertEqual(request.existing_categories, ["常见问题", "定制需求"])

    def test_model_output_must_contain_complete_ai_fields(self) -> None:
        request = PlatformPhraseNormalizeRequest.model_validate({
            "platform": "pinduoduo",
            "source": "team",
            "records": [
                {
                    "source_id": "pdd-team:1",
                    "category": "原始分类",
                    "content": "原始答案",
                    "images": [{"url": "https://example.com/image.png"}],
                },
            ],
        })

        drafts = _sanitize_model_items(request.records, {
            "items": [{
                "source_id": "pdd-team:1",
                "category": "定制需求",
                "question": "可以做定制吗？",
                "keywords": ["定制需求", "定制图片"],
                "answer": "润色后的答案",
            }],
        })

        self.assertEqual(len(drafts), 1)
        self.assertEqual(drafts[0].category, "定制需求")
        self.assertEqual(drafts[0].image_url, "https://example.com/image.png")

        incomplete = _sanitize_model_items(request.records, {
            "items": [{
                "source_id": "pdd-team:1",
                "category": "定制需求",
                "question": "可以做定制吗？",
                "keywords": [],
                "answer": "润色后的答案",
            }],
        })
        self.assertEqual(incomplete, [])

    def test_model_output_can_keep_valid_partial_items(self) -> None:
        request = PlatformPhraseNormalizeRequest.model_validate({
            "platform": "pinduoduo",
            "source": "team",
            "records": [
                {"source_id": "pdd-team:1", "content": "原始答案 1"},
                {"source_id": "pdd-team:2", "content": "原始答案 2"},
            ],
        })

        drafts = _sanitize_model_items(request.records, {
            "items": [
                {
                    "source_id": "pdd-team:1",
                    "category": "定制需求",
                    "question": "可以做定制吗？",
                    "keywords": ["定制图片", "来图定制"],
                    "answer": "润色后的答案",
                },
                {
                    "source_id": "pdd-team:2",
                    "category": "定制需求",
                    "question": "能定制吗？",
                    "keywords": [],
                    "answer": "润色后的答案",
                },
            ],
        })

        self.assertEqual(len(drafts), 1)
        self.assertEqual(drafts[0].source_id, "pdd-team:1")

    def test_phrase_snapshot_can_be_upserted_and_read_by_local_account_id(self) -> None:
        account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="local-1",
            account_name="枕梦次元",
            account_alias="枕梦次元",
            is_active=True,
            login_status="online",
        )
        self.db.add(account)
        self.db.flush()

        saved = upsert_platform_phrase_cache(
            PlatformPhraseSnapshotUpsertRequest.model_validate({
                "source": "team",
                "local_account_id": "local-1",
                "records": [{
                    "source_id": "pdd-team:1",
                    "category": "常用",
                    "quick_key": "尺码",
                    "content": "35 到 60 厘米可选",
                }],
                "raw_count": 1,
            }),
            self.user,
            self.db,
        )

        self.assertEqual(saved.local_account_id, "local-1")
        self.assertEqual(saved.record_count, 1)
        self.assertEqual(self.db.query(PlatformPhraseSnapshot).count(), 1)

        cached = get_platform_phrase_cache("team", None, "local-1", self.user, self.db)
        self.assertIsNotNone(cached.item)
        self.assertEqual(cached.item.records[0].content, "35 到 60 厘米可选")


if __name__ == "__main__":
    unittest.main()
