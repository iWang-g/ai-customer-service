from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.db import DEFAULT_QA_CATEGORIES, init_db
from app.schemas import KnowledgeBaseCreate, QaCategoryCreate, QaEntryCreate
from app.service import create_base, create_qa_category, create_qa_entry, list_qa_categories, list_qa_entries


class QaCategoryTests(unittest.TestCase):
    user_id = "user-qa"
    def setUp(self) -> None:
        test_temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        test_temp_root.mkdir(exist_ok=True)
        self.database = test_temp_root / f"qa-categories-{uuid.uuid4().hex}.db"
        self.database_patch = patch("app.db.database_path", return_value=self.database)
        self.database_patch.start()
        init_db()
        self.base = create_base(self.user_id, KnowledgeBaseCreate(name="售前问答库", kind="qa"))

    def tearDown(self) -> None:
        self.database_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{self.database}{suffix}")
            if path.exists():
                path.unlink()

    def test_default_and_custom_categories_are_persisted(self) -> None:
        defaults = list_qa_categories(self.user_id, self.base["id"])
        self.assertEqual([item["name"] for item in defaults], list(DEFAULT_QA_CATEGORIES))
        self.assertTrue(all(item["is_builtin"] for item in defaults))

        custom = create_qa_category(self.user_id, self.base["id"], QaCategoryCreate(name="会员问题"))
        self.assertFalse(custom["is_builtin"])
        self.assertEqual(list_qa_categories(self.user_id, self.base["id"])[-1]["name"], "会员问题")

        with self.assertRaises(HTTPException) as context:
            create_qa_category(self.user_id, self.base["id"], QaCategoryCreate(name="会员问题"))
        self.assertEqual(context.exception.status_code, 409)

    def test_entries_support_category_filter_keyword_search_and_pagination(self) -> None:
        categories = {item["name"]: item for item in list_qa_categories(self.user_id, self.base["id"])}
        logistics = categories["物流问题"]
        common = categories["常见问题"]

        create_qa_entry(self.user_id, self.base["id"], QaEntryCreate(
            category_id=logistics["id"],
            question="什么时候发货？",
            keywords=["发货", "物流"],
            answer="预计今天发货。",
            weight=20,
        ))
        create_qa_entry(self.user_id, self.base["id"], QaEntryCreate(
            category_id=common["id"],
            question="营业时间是什么？",
            keywords=["营业时间"],
            answer="全天在线。",
            weight=10,
        ))
        create_qa_entry(self.user_id, self.base["id"], QaEntryCreate(
            question="这是旧数据吗？",
            answer="这是未分类兼容数据。",
        ))

        logistics_page = list_qa_entries(self.user_id, self.base["id"], logistics["id"])
        self.assertEqual(logistics_page["total"], 1)
        self.assertEqual(logistics_page["items"][0]["category"], "物流问题")

        uncategorized_page = list_qa_entries(self.user_id, self.base["id"], "uncategorized")
        self.assertEqual(uncategorized_page["total"], 1)
        self.assertEqual(uncategorized_page["items"][0]["category_id"], "")

        search_page = list_qa_entries(self.user_id, self.base["id"], keyword="营业时间")
        self.assertEqual(search_page["total"], 1)
        self.assertEqual(search_page["items"][0]["answer"], "全天在线。")

        first_page = list_qa_entries(self.user_id, self.base["id"], page=1, page_size=1)
        second_page = list_qa_entries(self.user_id, self.base["id"], page=2, page_size=1)
        self.assertEqual(first_page["pages"], 3)
        self.assertEqual(len(first_page["items"]), 1)
        self.assertEqual(second_page["page"], 2)
        self.assertNotEqual(first_page["items"][0]["id"], second_page["items"][0]["id"])

        counted = {item["name"]: item["item_count"] for item in list_qa_categories(self.user_id, self.base["id"])}
        self.assertEqual(counted["物流问题"], 1)
        self.assertEqual(counted["常见问题"], 1)

    def test_qa_keywords_are_deserialized_as_list(self) -> None:
        create_qa_entry(self.user_id, self.base["id"], QaEntryCreate(
            category="Common",
            question="Is it available?",
            keywords=["stock", "available"],
            answer="Yes.",
        ))

        page = list_qa_entries(self.user_id, self.base["id"])

        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["keywords"], ["stock", "available"])


if __name__ == "__main__":
    unittest.main()
