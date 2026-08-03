from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.core.config import get_settings


DEFAULT_QA_CATEGORIES = (
    "常见问题",
    "商品问题",
    "规格参数",
    "价格优惠",
    "下单支付",
    "物流问题",
    "售后退款",
    "发票问题",
    "其他",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def database_path() -> Path:
    path = Path(get_settings().database_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(database_path())
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS knowledge_bases (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('qa', 'product', 'tone')),
                persona TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS qa_entries (
                id TEXT PRIMARY KEY,
                base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
                category TEXT NOT NULL DEFAULT '',
                question TEXT NOT NULL,
                keywords_json TEXT NOT NULL DEFAULT '[]',
                answer TEXT NOT NULL,
                image_url TEXT NOT NULL DEFAULT '',
                weight INTEGER NOT NULL DEFAULT 10,
                call_count INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS qa_categories (
                id TEXT PRIMARY KEY,
                base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
                name TEXT NOT NULL COLLATE NOCASE,
                is_builtin INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(base_id, name)
            );
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ready',
                original_filename TEXT NOT NULL DEFAULT '',
                file_type TEXT NOT NULL DEFAULT '',
                file_size INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                chunk_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS document_chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                title_path TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                UNIQUE(document_id, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS ix_qa_entries_base ON qa_entries(base_id, enabled);
            CREATE INDEX IF NOT EXISTS ix_qa_categories_base ON qa_categories(base_id, sort_order);
            CREATE INDEX IF NOT EXISTS ix_documents_base ON documents(base_id, status);
            CREATE INDEX IF NOT EXISTS ix_document_chunks_base ON document_chunks(base_id, enabled);
            """
        )
        existing = {row[1] for row in db.execute("PRAGMA table_info(documents)").fetchall()}
        additions = {
            "original_filename": "TEXT NOT NULL DEFAULT ''",
            "file_type": "TEXT NOT NULL DEFAULT ''",
            "file_size": "INTEGER NOT NULL DEFAULT 0",
            "content_hash": "TEXT NOT NULL DEFAULT ''",
            "error_message": "TEXT NOT NULL DEFAULT ''",
            "chunk_count": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, definition in additions.items():
            if name not in existing:
                db.execute(f'ALTER TABLE documents ADD COLUMN "{name}" {definition}')

        qa_entry_columns = {row[1] for row in db.execute("PRAGMA table_info(qa_entries)").fetchall()}
        if "category_id" not in qa_entry_columns:
            db.execute("ALTER TABLE qa_entries ADD COLUMN category_id TEXT DEFAULT NULL REFERENCES qa_categories(id) ON DELETE SET NULL")
        db.execute("CREATE INDEX IF NOT EXISTS ix_qa_entries_category ON qa_entries(base_id, category_id)")

        now = utc_now()
        qa_base_ids = [row[0] for row in db.execute("SELECT id FROM knowledge_bases WHERE kind = 'qa'").fetchall()]
        for base_id in qa_base_ids:
            for sort_order, category_name in enumerate(DEFAULT_QA_CATEGORIES):
                db.execute(
                    "INSERT OR IGNORE INTO qa_categories (id,base_id,name,is_builtin,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                    (f"qac-{uuid.uuid4().hex[:16]}", base_id, category_name, 1, sort_order, now, now),
                )

            legacy_categories = db.execute(
                "SELECT DISTINCT TRIM(category) FROM qa_entries WHERE base_id = ? AND TRIM(category) != ''",
                (base_id,),
            ).fetchall()
            next_sort_order = len(DEFAULT_QA_CATEGORIES)
            for row in legacy_categories:
                category_name = row[0]
                db.execute(
                    "INSERT OR IGNORE INTO qa_categories (id,base_id,name,is_builtin,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                    (f"qac-{uuid.uuid4().hex[:16]}", base_id, category_name, 0, next_sort_order, now, now),
                )
                next_sort_order += 1
            db.execute(
                """UPDATE qa_entries
                SET category_id = (
                    SELECT qa_categories.id FROM qa_categories
                    WHERE qa_categories.base_id = qa_entries.base_id
                      AND qa_categories.name = TRIM(qa_entries.category)
                )
                WHERE base_id = ? AND category_id IS NULL AND TRIM(category) != ''""",
                (base_id,),
            )
