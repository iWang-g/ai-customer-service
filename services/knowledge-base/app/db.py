from __future__ import annotations

import json
import re
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
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return default
    return default if parsed is None else parsed


def fts_terms(value: str) -> str:
    normalized = str(value or "").casefold()
    tokens = re.findall(r"[0-9a-z][0-9a-z_.-]{1,}", normalized)
    for sequence in re.findall(r"[\u4e00-\u9fff]+", normalized):
        tokens.extend(sequence[index:index + size]
                      for size in (2, 3)
                      for index in range(max(0, len(sequence) - size + 1)))
    return " ".join(dict.fromkeys(token for token in tokens if token))


def has_chunk_fts(db: sqlite3.Connection) -> bool:
    return db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_chunks_fts'"
    ).fetchone() is not None


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS knowledge_bases (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                owner_username TEXT NOT NULL DEFAULT '',
                owner_display_name TEXT NOT NULL DEFAULT '',
                is_public INTEGER NOT NULL DEFAULT 0,
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
                chunk_strategy_version TEXT NOT NULL DEFAULT 'legacy-v1',
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
                chunk_type TEXT NOT NULL DEFAULT 'prose',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                strategy_version TEXT NOT NULL DEFAULT 'legacy-v1',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                UNIQUE(document_id, chunk_index)
            );
            CREATE TABLE IF NOT EXISTS document_chunk_embeddings (
                chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
                model TEXT NOT NULL,
                dim INTEGER NOT NULL,
                vector BLOB NOT NULL,
                content_hash TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (chunk_id, model)
            );
            CREATE INDEX IF NOT EXISTS ix_qa_entries_base ON qa_entries(base_id, enabled);
            CREATE INDEX IF NOT EXISTS ix_qa_categories_base ON qa_categories(base_id, sort_order);
            CREATE INDEX IF NOT EXISTS ix_documents_base ON documents(base_id, status);
            CREATE INDEX IF NOT EXISTS ix_document_chunks_base ON document_chunks(base_id, enabled);
            CREATE INDEX IF NOT EXISTS ix_document_chunk_embeddings_model ON document_chunk_embeddings(model);
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
            "chunk_strategy_version": "TEXT NOT NULL DEFAULT 'legacy-v1'",
        }
        for name, definition in additions.items():
            if name not in existing:
                db.execute(f'ALTER TABLE documents ADD COLUMN "{name}" {definition}')

        chunk_columns = {row[1] for row in db.execute("PRAGMA table_info(document_chunks)").fetchall()}
        chunk_additions = {
            "chunk_type": "TEXT NOT NULL DEFAULT 'prose'",
            "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            "strategy_version": "TEXT NOT NULL DEFAULT 'legacy-v1'",
        }
        for name, definition in chunk_additions.items():
            if name not in chunk_columns:
                db.execute(f'ALTER TABLE document_chunks ADD COLUMN "{name}" {definition}')

        try:
            expected_fts_columns = [
                "chunk_id", "document_id", "base_id", "source_title", "title_path", "content",
                "source_title_terms", "title_path_terms", "content_terms",
            ]
            existing_fts_columns = [
                row[1] for row in db.execute("PRAGMA table_info(document_chunks_fts)").fetchall()
            ]
            if existing_fts_columns and existing_fts_columns != expected_fts_columns:
                db.execute("DROP TABLE document_chunks_fts")
            db.execute(
                """CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    document_id UNINDEXED,
                    base_id UNINDEXED,
                    source_title,
                    title_path,
                    content,
                    source_title_terms,
                    title_path_terms,
                    content_terms,
                    tokenize = 'unicode61 remove_diacritics 2'
                )"""
            )
            db.execute("DELETE FROM document_chunks_fts")
            chunk_rows = db.execute(
                """SELECT c.id, c.document_id, c.base_id, d.title, c.title_path, c.content
                FROM document_chunks c JOIN documents d ON d.id = c.document_id
                WHERE c.enabled = 1 AND d.status = 'ready'"""
            ).fetchall()
            db.executemany(
                """INSERT INTO document_chunks_fts
                (chunk_id,document_id,base_id,source_title,title_path,content,
                 source_title_terms,title_path_terms,content_terms)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                [(
                    row["id"], row["document_id"], row["base_id"], row["title"],
                    row["title_path"], row["content"],
                    fts_terms(row["title"]), fts_terms(row["title_path"]), fts_terms(row["content"]),
                ) for row in chunk_rows],
            )
        except sqlite3.OperationalError:
            db.execute("DROP TABLE IF EXISTS document_chunks_fts")

        qa_entry_columns = {row[1] for row in db.execute("PRAGMA table_info(qa_entries)").fetchall()}
        if "category_id" not in qa_entry_columns:
            db.execute("ALTER TABLE qa_entries ADD COLUMN category_id TEXT DEFAULT NULL REFERENCES qa_categories(id) ON DELETE SET NULL")
        db.execute("CREATE INDEX IF NOT EXISTS ix_qa_entries_category ON qa_entries(base_id, category_id)")

        base_columns = {row[1] for row in db.execute("PRAGMA table_info(knowledge_bases)").fetchall()}
        if "user_id" not in base_columns:
            db.execute("ALTER TABLE knowledge_bases ADD COLUMN user_id TEXT")
        if "owner_username" not in base_columns:
            db.execute("ALTER TABLE knowledge_bases ADD COLUMN owner_username TEXT NOT NULL DEFAULT ''")
        if "owner_display_name" not in base_columns:
            db.execute("ALTER TABLE knowledge_bases ADD COLUMN owner_display_name TEXT NOT NULL DEFAULT ''")
        if "is_public" not in base_columns:
            db.execute("ALTER TABLE knowledge_bases ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")
        unowned_count = int(db.execute(
            "SELECT COUNT(*) FROM knowledge_bases WHERE user_id IS NULL OR TRIM(user_id) = ''"
        ).fetchone()[0])
        if unowned_count:
            legacy_owner = get_settings().legacy_owner_user_id.strip()
            if not legacy_owner:
                raise RuntimeError(
                    "KB_LEGACY_OWNER_USER_ID is required to assign existing knowledge bases"
                )
            db.execute(
                "UPDATE knowledge_bases SET user_id = ? WHERE user_id IS NULL OR TRIM(user_id) = ''",
                (legacy_owner,),
            )
        db.execute("CREATE INDEX IF NOT EXISTS ix_knowledge_bases_user ON knowledge_bases(user_id, kind)")
        db.execute("CREATE INDEX IF NOT EXISTS ix_knowledge_bases_public ON knowledge_bases(is_public, kind)")

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
