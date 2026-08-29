from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.core.config import Settings
from app.db import init_db
from app.db import connect
from app.document_parser import CHUNK_STRATEGY_VERSION, chunk_text
from app.schemas import DocumentCreate, DocumentSearchRequest, KnowledgeBaseCreate
from app.service import create_base, create_document, delete_document, get_document, list_document_chunks, rebuild_document_embeddings, reprocess_document, search_documents


class ProductDocumentTests(unittest.TestCase):
    user_id = "user-product"
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

    def embedding_settings(self) -> Settings:
        return Settings(
            KB_DATABASE_PATH=str(self.database),
            KB_EMBEDDING_ENABLED=True,
            KB_EMBEDDING_MODEL="test-embedding",
            KB_VECTOR_SEARCH_ENABLED=True,
            KB_VECTOR_MIN_SCORE=0.8,
            KB_VECTOR_CANDIDATE_LIMIT=20,
            KB_HYBRID_FTS_LIMIT=20,
            KB_HYBRID_RRF_K=60,
        )

    @staticmethod
    def fake_embeddings(texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            if any(term in text for term in ("蓝牙", "移动设备", "手机")):
                vectors.append([1.0, 0.0, 0.0])
            elif any(term in text for term in ("手洗", "机洗", "洗衣机", "晾干")):
                vectors.append([0.0, 1.0, 0.0])
            elif any(term in text for term in ("质保", "保修", "故障")):
                vectors.append([0.0, 0.0, 1.0])
            else:
                vectors.append([0.0, 0.0, 0.0])
        return vectors

    def test_embedding_table_is_created(self) -> None:
        with connect() as db:
            table = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_chunk_embeddings'"
            ).fetchone()
            self.assertIsNotNone(table)

    def test_document_detail_and_chunks_return_processed_content(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="产品资料库", kind="product"))
        content = "# 产品参数\n\n" + ("键盘支持三模连接。" * 100)
        created = create_document(self.user_id, DocumentCreate(base_id=base["id"], title="键盘资料", content=content))

        detail = get_document(self.user_id, created["id"])
        self.assertEqual(detail["content"], content)
        self.assertGreater(detail["chunk_count"], 1)

        first_page = list_document_chunks(self.user_id, created["id"], page=1, page_size=1)
        self.assertEqual(first_page["total"], detail["chunk_count"])
        self.assertEqual(first_page["page_size"], 1)
        self.assertEqual(len(first_page["items"]), 1)
        self.assertEqual(first_page["items"][0]["chunk_index"], 0)
        self.assertEqual(first_page["items"][0]["title_path"], "产品参数")
        self.assertEqual(first_page["items"][0]["strategy_version"], CHUNK_STRATEGY_VERSION)
        self.assertEqual(detail["chunk_strategy_version"], CHUNK_STRATEGY_VERSION)
        self.assertTrue(first_page["items"][0]["enabled"])

        second_page = list_document_chunks(self.user_id, created["id"], page=2, page_size=1)
        self.assertEqual(second_page["items"][0]["chunk_index"], 1)

    def test_deleted_document_detail_is_not_available(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="产品资料库", kind="product"))
        created = create_document(self.user_id, DocumentCreate(base_id=base["id"], title="键盘资料", content="支持 USB 连接"))
        delete_document(self.user_id, created["id"])

        for read in (get_document, list_document_chunks):
            with self.assertRaises(HTTPException) as raised:
                read(self.user_id, created["id"])
            self.assertEqual(raised.exception.status_code, 404)

    def test_structured_chunking_preserves_heading_path_and_table_rows(self) -> None:
        content = """# 键盘 K1

## 连接方式

键盘支持蓝牙连接。也支持 2.4G 接收器连接。还支持 USB 有线连接。

## 产品参数

轴体 | 青轴
续航 | 80 小时
重量 | 780 克
"""
        chunks = chunk_text(content, target_chars=18, max_chars=45, overlap_chars=8)
        self.assertTrue(any(item.title_path == "键盘 K1 > 连接方式" for item in chunks))
        parameter_chunks = [item for item in chunks if item.title_path.endswith("产品参数")]
        self.assertTrue(parameter_chunks)
        self.assertTrue(all(item.chunk_type == "table" for item in parameter_chunks))
        self.assertTrue(all(item.content not in {"还支持 USB 有线连接。"} for item in chunks))
        parameter_text = "\n".join(item.content for item in parameter_chunks)
        self.assertEqual(parameter_text.count("轴体 | 青轴"), 1)
        self.assertEqual(parameter_text.count("续航 | 80 小时"), 1)

    def test_search_prefers_title_and_expands_adjacent_same_section(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="键盘产品库", kind="product"))
        content = """# Aurora K9

## 连接方式

Aurora K9 支持蓝牙连接，首次配对请长按 Fn 加数字一。

蓝牙配对完成后，指示灯会停止闪烁并保持常亮。

如果搜索不到设备，请先关闭旧设备的蓝牙连接后重试。

## 售后政策

商品提供一年质保，非人为故障可以申请检测。
"""
        with patch(
            "app.service.get_settings",
            return_value=Settings(KB_EMBEDDING_ENABLED=False, KB_VECTOR_SEARCH_ENABLED=False),
        ):
            created = create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="Aurora K9 使用说明", content=content),
            )
            result = search_documents(
                self.user_id,
                DocumentSearchRequest(query="Aurora K9 蓝牙怎么配对", base_ids=[base["id"]], top_k=3),
            )
        self.assertTrue(result["results"])
        first = result["results"][0]
        self.assertEqual(first["source_id"], created["id"])
        self.assertIn("连接方式", first["title_path"])
        self.assertIn("首次配对", first["snippet"])
        self.assertGreaterEqual(len(first["context_chunk_ids"]), 1)
        with connect() as db:
            fts_enabled = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_chunks_fts'"
            ).fetchone() is not None
        self.assertEqual(result["metadata"]["mode"], "fts5_bm25" if fts_enabled else "keyword")

    def test_document_import_creates_embeddings_when_enabled(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="语义产品库", kind="product"))
        with (
            patch("app.service.get_settings", return_value=self.embedding_settings()),
            patch("app.service.embed_texts", side_effect=self.fake_embeddings),
        ):
            created = create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="蓝牙说明", content="支持蓝牙连接移动设备。"),
            )

        with connect() as db:
            chunk_count = db.execute(
                "SELECT COUNT(*) FROM document_chunks WHERE document_id = ?",
                (created["id"],),
            ).fetchone()[0]
            embedding_count = db.execute(
                "SELECT COUNT(*) FROM document_chunk_embeddings WHERE model = ?",
                ("test-embedding",),
            ).fetchone()[0]
        self.assertEqual(embedding_count, chunk_count)

    def test_vector_search_matches_semantic_query_without_literal_overlap(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="语义检索库", kind="product"))
        with (
            patch("app.service.get_settings", return_value=self.embedding_settings()),
            patch("app.service.embed_texts", side_effect=self.fake_embeddings),
        ):
            created = create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="连接方式", content="支持蓝牙连接移动设备。"),
            )
            create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="清洗说明", content="不建议机洗，建议手洗后自然晾干。"),
            )
            result = search_documents(
                self.user_id,
                DocumentSearchRequest(query="能连手机吗", base_ids=[base["id"]], top_k=3),
            )

        self.assertTrue(result["results"])
        self.assertEqual(result["results"][0]["source_id"], created["id"])
        self.assertEqual(result["metadata"]["mode"], "vector")
        self.assertEqual(result["metadata"]["vector_candidate_count"], 1)

    def test_hybrid_search_preserves_keyword_match(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="混合检索库", kind="product"))
        with (
            patch("app.service.get_settings", return_value=self.embedding_settings()),
            patch("app.service.embed_texts", side_effect=self.fake_embeddings),
        ):
            created = create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="Aurora K9 连接方式", content="支持蓝牙连接移动设备。"),
            )
            result = search_documents(
                self.user_id,
                DocumentSearchRequest(query="Aurora K9 能连手机吗", base_ids=[base["id"]], top_k=3),
            )

        self.assertTrue(result["results"])
        self.assertEqual(result["results"][0]["source_id"], created["id"])
        self.assertEqual(result["metadata"]["mode"], "hybrid")
        self.assertGreater(result["metadata"]["fts_candidate_count"], 0)
        self.assertGreater(result["metadata"]["vector_candidate_count"], 0)

    def test_search_falls_back_when_embedding_unavailable(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="降级产品库", kind="product"))
        create_document(
            self.user_id,
            DocumentCreate(base_id=base["id"], title="质保说明", content="商品提供一年质保，非人为故障可以申请检测。"),
        )
        settings = self.embedding_settings()
        with (
            patch("app.service.get_settings", return_value=settings),
            patch("app.service.embed_texts", return_value=[]),
        ):
            result = search_documents(
                self.user_id,
                DocumentSearchRequest(query="质保", base_ids=[base["id"]], top_k=3),
            )

        self.assertTrue(result["results"])
        self.assertIn(result["metadata"]["mode"], {"fts5_bm25", "keyword"})
        self.assertEqual(result["metadata"]["vector_candidate_count"], 0)

    def test_rebuild_document_embeddings_backfills_existing_chunks(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="回填向量库", kind="product"))
        created = create_document(
            self.user_id,
            DocumentCreate(base_id=base["id"], title="蓝牙说明", content="支持蓝牙连接移动设备。"),
        )
        with connect() as db:
            db.execute("DELETE FROM document_chunk_embeddings")
        with (
            patch("app.service.get_settings", return_value=self.embedding_settings()),
            patch("app.service.embed_texts", side_effect=self.fake_embeddings),
        ):
            result = rebuild_document_embeddings(document_id=created["id"])

        self.assertEqual(result["document_count"], 1)
        self.assertEqual(result["before_count"], 0)
        self.assertEqual(result["after_count"], 1)
        self.assertEqual(result["created_count"], 1)

    def test_reprocess_rebuilds_embeddings_and_delete_removes_them(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="重建向量库", kind="product"))
        with (
            patch("app.service.get_settings", return_value=self.embedding_settings()),
            patch("app.service.embed_texts", side_effect=self.fake_embeddings),
        ):
            created = create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="蓝牙说明", content="支持蓝牙连接移动设备。"),
            )
            with connect() as db:
                before = db.execute("SELECT COUNT(*) FROM document_chunk_embeddings").fetchone()[0]
            reprocess_document(self.user_id, created["id"])
            with connect() as db:
                after = db.execute("SELECT COUNT(*) FROM document_chunk_embeddings").fetchone()[0]
            delete_document(self.user_id, created["id"])
            with connect() as db:
                deleted = db.execute("SELECT COUNT(*) FROM document_chunk_embeddings").fetchone()[0]

        self.assertGreater(before, 0)
        self.assertEqual(after, before)
        self.assertEqual(deleted, 0)

    def test_user_isolation_applies_to_vector_candidates(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="私有语义库", kind="product"))
        with (
            patch("app.service.get_settings", return_value=self.embedding_settings()),
            patch("app.service.embed_texts", side_effect=self.fake_embeddings),
        ):
            create_document(
                self.user_id,
                DocumentCreate(base_id=base["id"], title="蓝牙说明", content="支持蓝牙连接移动设备。"),
            )
            result = search_documents(
                "another-user",
                DocumentSearchRequest(query="能连手机吗", base_ids=[base["id"]], top_k=3),
            )

        self.assertEqual(result["results"], [])
        self.assertEqual(result["metadata"]["vector_candidate_count"], 0)

    def test_legacy_document_can_be_reprocessed_by_owner(self) -> None:
        base = create_base(self.user_id, KnowledgeBaseCreate(name="重处理产品库", kind="product"))
        created = create_document(
            self.user_id,
            DocumentCreate(base_id=base["id"], title="旧文档", content="# 参数\n\n支持三模连接。"),
        )
        with connect() as db:
            db.execute(
                "UPDATE documents SET chunk_strategy_version = 'legacy-v1' WHERE id = ?",
                (created["id"],),
            )
            db.execute(
                "UPDATE document_chunks SET strategy_version = 'legacy-v1' WHERE document_id = ?",
                (created["id"],),
            )
        updated = reprocess_document(self.user_id, created["id"])
        self.assertEqual(updated["chunk_strategy_version"], CHUNK_STRATEGY_VERSION)
        chunks = list_document_chunks(self.user_id, created["id"])["items"]
        self.assertTrue(chunks)
        self.assertTrue(all(item["strategy_version"] == CHUNK_STRATEGY_VERSION for item in chunks))

        with self.assertRaises(HTTPException) as raised:
            reprocess_document("another-user", created["id"])
        self.assertEqual(raised.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
