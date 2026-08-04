from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.db import init_db
from app.schemas import DocumentCreate, KnowledgeBaseCreate
from app.service import create_base, create_document, delete_document, get_document, list_document_chunks


class ProductDocumentTests(unittest.TestCase):
    def setUp(self) -> None:
        test_temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        test_temp_root.mkdir(exist_ok=True)
        self.database = test_temp_root / f"product-document-{uuid.uuid4().hex}.db"
        self.database_patch = patch("app.db.database_path", return_value=self.database)
        self.database_patch.start()
        init_db()

    def tearDown(self) -> None:
        self.database_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{self.database}{suffix}")
            if path.exists():
                path.unlink()

    def test_document_detail_and_chunks_return_processed_content(self) -> None:
        base = create_base(KnowledgeBaseCreate(name="产品资料库", kind="product"))
        content = "# 产品参数\n\n" + ("键盘支持三模连接。" * 100)
        created = create_document(DocumentCreate(base_id=base["id"], title="键盘资料", content=content))

        detail = get_document(created["id"])
        self.assertEqual(detail["content"], content)
        self.assertGreater(detail["chunk_count"], 1)

        first_page = list_document_chunks(created["id"], page=1, page_size=1)
        self.assertEqual(first_page["total"], detail["chunk_count"])
        self.assertEqual(first_page["page_size"], 1)
        self.assertEqual(len(first_page["items"]), 1)
        self.assertEqual(first_page["items"][0]["chunk_index"], 0)
        self.assertEqual(first_page["items"][0]["title_path"], "产品参数")
        self.assertTrue(first_page["items"][0]["enabled"])

        second_page = list_document_chunks(created["id"], page=2, page_size=1)
        self.assertEqual(second_page["items"][0]["chunk_index"], 1)

    def test_deleted_document_detail_is_not_available(self) -> None:
        base = create_base(KnowledgeBaseCreate(name="产品资料库", kind="product"))
        created = create_document(DocumentCreate(base_id=base["id"], title="键盘资料", content="支持 USB 连接"))
        delete_document(created["id"])

        for read in (get_document, list_document_chunks):
            with self.assertRaises(HTTPException) as raised:
                read(created["id"])
            self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
