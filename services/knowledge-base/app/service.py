from __future__ import annotations

import hashlib
import io
import mimetypes
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from app.db import DEFAULT_QA_CATEGORIES, connect, dumps, fts_terms, has_chunk_fts, loads, utc_now
from app.core.config import get_settings
from app.document_parser import CHUNK_STRATEGY_VERSION, ParsedDocument, TextChunk, chunk_text, parse_document
from app.schemas import DocumentCreate, DocumentSearchRequest, KnowledgeBaseCreate, KnowledgeBaseUpdate, QaCategoryCreate, QaEntryCreate, QaMatchRequest


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def normalize(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", text.casefold())


def asset_directory(user_id: str = "") -> Path:
    path = Path(get_settings().asset_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    if user_id:
        path = path / hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:24]
    path.mkdir(parents=True, exist_ok=True)
    return path


def _normalize_qa_image(data: bytes) -> bytes:
    if not data:
        raise HTTPException(422, "Image is empty")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Image must not exceed 10 MB")
    try:
        with Image.open(io.BytesIO(data)) as source:
            if (source.format or "").upper() not in {"JPEG", "PNG", "GIF", "WEBP"}:
                raise HTTPException(415, "Only JPG, PNG, GIF and WebP images are supported")
            source.seek(0)
            image = ImageOps.exif_transpose(source)
            image.load()
            if image.width * image.height > 40_000_000:
                raise HTTPException(413, "Image dimensions are too large")
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "transparency" in source.info else "RGB")
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True)
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(422, "Image content is invalid") from exc
    return output.getvalue()


def save_qa_image(user_id: str, filename: str, content_type: str, data: bytes) -> dict[str, Any]:
    allowed_types = {"image/jpeg", "image/png", "image/gif", "image/webp"}
    declared_type = content_type.casefold()
    guessed_type, _ = mimetypes.guess_type(filename)
    if declared_type not in allowed_types and (guessed_type or "").casefold() not in allowed_types:
        raise HTTPException(415, "Only JPG, PNG, GIF and WebP images are supported")

    normalized = _normalize_qa_image(data)
    asset_name = f"qa-{uuid.uuid4().hex}.png"
    (asset_directory(user_id) / asset_name).write_bytes(normalized)
    return {
        "image_url": f"/qa-assets/{asset_name}",
        "filename": filename,
        "content_type": "image/png",
        "size": len(normalized),
    }


def get_qa_image(user_id: str, asset_name: str) -> tuple[Path, str]:
    if Path(asset_name).name != asset_name:
        raise HTTPException(404, "Image not found")
    owner_user_id = ""
    with connect() as db:
        row = db.execute(
            """SELECT b.user_id FROM qa_entries q
            JOIN knowledge_bases b ON b.id = q.base_id
            WHERE q.image_url = ? AND (b.user_id = ? OR b.is_public = 1)
            LIMIT 1""",
            (f"/qa-assets/{asset_name}", user_id),
        ).fetchone()
        if row:
            owner_user_id = row["user_id"]
    if not owner_user_id:
        raise HTTPException(404, "Image not found")
    path = asset_directory(owner_user_id) / asset_name
    if not path.is_file() and user_id == get_settings().legacy_owner_user_id.strip():
        path = asset_directory() / asset_name
    if not path.is_file():
        raise HTTPException(404, "Image not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return path, media_type


def row_base(row: Any, count: int, viewer_user_id: str) -> dict[str, Any]:
    is_owner = row["user_id"] == viewer_user_id
    return {
        "id": row["id"], "name": row["name"], "kind": row["kind"],
        "persona": row["persona"], "enabled": bool(row["enabled"]),
        "is_public": bool(row["is_public"]), "owner_user_id": row["user_id"],
        "owner_username": row["owner_username"] or row["user_id"],
        "owner_display_name": row["owner_display_name"] or row["owner_username"] or row["user_id"],
        "is_owner": is_owner, "read_only": not is_owner,
        "item_count": count, "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_bases(user_id: str, kind: str | None = None) -> list[dict[str, Any]]:
    with connect() as db:
        query = "SELECT * FROM knowledge_bases WHERE (user_id = ? OR is_public = 1)"
        params: list[Any] = [user_id]
        if kind:
            query += " AND kind = ?"
            params.append(kind)
        rows = db.execute(query + " ORDER BY updated_at DESC", params).fetchall()
        result = []
        for row in rows:
            table = "qa_entries" if row["kind"] == "qa" else "documents"
            count_query = f"SELECT COUNT(*) FROM {table} WHERE base_id = ?"
            if table == "documents":
                count_query += " AND status != 'deleted'"
            count = db.execute(count_query, (row["id"],)).fetchone()[0]
            result.append(row_base(row, int(count), user_id))
        return result


def get_base(user_id: str, base_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute(
            "SELECT * FROM knowledge_bases WHERE id = ? AND (user_id = ? OR is_public = 1)",
            (base_id, user_id),
        ).fetchone()
        if not row:
            return None
        table = "qa_entries" if row["kind"] == "qa" else "documents"
        count_query = f"SELECT COUNT(*) FROM {table} WHERE base_id = ?"
        if table == "documents":
            count_query += " AND status != 'deleted'"
        count = db.execute(count_query, (base_id,)).fetchone()[0]
        return row_base(row, int(count), user_id)


def get_owned_base(user_id: str, base_id: str) -> dict[str, Any] | None:
    value = get_base(user_id, base_id)
    return value if value and value["is_owner"] else None


def create_base(
    user_id: str,
    payload: KnowledgeBaseCreate,
    owner_username: str = "",
    owner_display_name: str = "",
) -> dict[str, Any]:
    now = utc_now()
    base_id = new_id("kb")
    with connect() as db:
        db.execute("INSERT INTO knowledge_bases (id,user_id,owner_username,owner_display_name,is_public,name,kind,persona,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (base_id, user_id, owner_username or user_id, owner_display_name or owner_username or user_id, 1 if payload.is_public else 0, payload.name.strip(), payload.kind, payload.persona.strip(), now, now))
        if payload.kind == "qa":
            for sort_order, category_name in enumerate(DEFAULT_QA_CATEGORIES):
                db.execute(
                    "INSERT INTO qa_categories (id,base_id,name,is_builtin,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                    (new_id("qac"), base_id, category_name, 1, sort_order, now, now),
                )
    return get_base(user_id, base_id)  # type: ignore[return-value]


def update_base(user_id: str, base_id: str, payload: KnowledgeBaseUpdate) -> dict[str, Any]:
    current = get_owned_base(user_id, base_id)
    if not current:
        raise HTTPException(404, "Knowledge base not found")
    fields: list[str] = []
    values: list[Any] = []
    if payload.name is not None:
        fields.append("name = ?"); values.append(payload.name.strip())
    if payload.persona is not None:
        fields.append("persona = ?"); values.append(payload.persona.strip())
    if payload.enabled is not None:
        fields.append("enabled = ?"); values.append(1 if payload.enabled else 0)
    if payload.is_public is not None:
        fields.append("is_public = ?"); values.append(1 if payload.is_public else 0)
    if fields:
        fields.append("updated_at = ?"); values.extend([utc_now(), base_id])
        with connect() as db:
            db.execute(f"UPDATE knowledge_bases SET {', '.join(fields)} WHERE id = ? AND user_id = ?", [*values[:-1], base_id, user_id])
    return get_base(user_id, base_id)  # type: ignore[return-value]


def delete_base(user_id: str, base_id: str) -> dict[str, Any]:
    current = get_owned_base(user_id, base_id)
    if not current:
        raise HTTPException(404, "Knowledge base not found")
    with connect() as db:
        if has_chunk_fts(db):
            db.execute("DELETE FROM document_chunks_fts WHERE base_id = ?", (base_id,))
        db.execute("DELETE FROM knowledge_bases WHERE id = ? AND user_id = ?", (base_id, user_id))
    return current


def qa_category_dict(row: Any, item_count: int = 0) -> dict[str, Any]:
    return {
        "id": row["id"], "base_id": row["base_id"], "name": row["name"],
        "is_builtin": bool(row["is_builtin"]), "sort_order": row["sort_order"],
        "item_count": item_count, "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_qa_categories(user_id: str, base_id: str) -> list[dict[str, Any]]:
    base = get_base(user_id, base_id)
    if not base or base["kind"] != "qa":
        raise HTTPException(404, "QA knowledge base not found")
    with connect() as db:
        rows = db.execute(
            """SELECT qa_categories.*, COUNT(qa_entries.id) AS item_count
            FROM qa_categories
            LEFT JOIN qa_entries ON qa_entries.category_id = qa_categories.id
            WHERE qa_categories.base_id = ?
            GROUP BY qa_categories.id
            ORDER BY qa_categories.sort_order, qa_categories.created_at""",
            (base_id,),
        ).fetchall()
        return [qa_category_dict(row, int(row["item_count"])) for row in rows]


def create_qa_category(user_id: str, base_id: str, payload: QaCategoryCreate) -> dict[str, Any]:
    base = get_owned_base(user_id, base_id)
    if not base or base["kind"] != "qa":
        raise HTTPException(404, "QA knowledge base not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Category name is required")
    now = utc_now()
    with connect() as db:
        existing = db.execute(
            "SELECT * FROM qa_categories WHERE base_id = ? AND name = ? COLLATE NOCASE",
            (base_id, name),
        ).fetchone()
        if existing:
            raise HTTPException(409, "Category already exists")
        sort_order = int(db.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM qa_categories WHERE base_id = ?",
            (base_id,),
        ).fetchone()[0])
        category_id = new_id("qac")
        db.execute(
            "INSERT INTO qa_categories (id,base_id,name,is_builtin,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
            (category_id, base_id, name, 0, sort_order, now, now),
        )
        row = db.execute("SELECT * FROM qa_categories WHERE id = ?", (category_id,)).fetchone()
    return qa_category_dict(row)


def list_qa_entries(
    user_id: str,
    base_id: str,
    category_id: str | None = None,
    keyword: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    if not get_base(user_id, base_id):
        raise HTTPException(404, "Knowledge base not found")
    with connect() as db:
        conditions = ["base_id = ?"]
        params: list[Any] = [base_id]
        if category_id == "uncategorized":
            conditions.append("category_id IS NULL")
        elif category_id:
            category = db.execute(
                "SELECT id FROM qa_categories WHERE id = ? AND base_id = ?",
                (category_id, base_id),
            ).fetchone()
            if not category:
                raise HTTPException(404, "QA category not found")
            conditions.append("category_id = ?")
            params.append(category_id)
        normalized_keyword = keyword.strip()
        if normalized_keyword:
            conditions.append("(question LIKE ? OR answer LIKE ? OR keywords_json LIKE ?)")
            term = f"%{normalized_keyword}%"
            params.extend([term, term, term])
        where = " AND ".join(conditions)
        total = int(db.execute(f"SELECT COUNT(*) FROM qa_entries WHERE {where}", params).fetchone()[0])
        pages = max(1, (total + page_size - 1) // page_size)
        safe_page = min(page, pages)
        rows = db.execute(
            f"SELECT * FROM qa_entries WHERE {where} ORDER BY weight DESC, updated_at DESC LIMIT ? OFFSET ?",
            [*params, page_size, (safe_page - 1) * page_size],
        ).fetchall()
        return {"items": [qa_dict(row) for row in rows], "total": total, "page": safe_page, "page_size": page_size, "pages": pages}


def qa_dict(row: Any) -> dict[str, Any]:
    return {"id": row["id"], "base_id": row["base_id"], "category_id": row["category_id"] or "", "category": row["category"], "question": row["question"], "keywords": loads(row["keywords_json"], []), "answer": row["answer"], "image_url": row["image_url"], "weight": row["weight"], "call_count": row["call_count"], "enabled": bool(row["enabled"]), "created_at": row["created_at"], "updated_at": row["updated_at"]}


def resolve_qa_category(db: Any, base_id: str, category_id: str, category_name: str) -> tuple[str | None, str]:
    if category_id:
        row = db.execute(
            "SELECT id,name FROM qa_categories WHERE id = ? AND base_id = ?",
            (category_id, base_id),
        ).fetchone()
        if not row:
            raise HTTPException(422, "QA category does not belong to this knowledge base")
        return row["id"], row["name"]
    name = category_name.strip()
    if not name:
        return None, ""
    row = db.execute(
        "SELECT id,name FROM qa_categories WHERE base_id = ? AND name = ? COLLATE NOCASE",
        (base_id, name),
    ).fetchone()
    if row:
        return row["id"], row["name"]
    now = utc_now()
    category_id = new_id("qac")
    sort_order = int(db.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM qa_categories WHERE base_id = ?",
        (base_id,),
    ).fetchone()[0])
    db.execute(
        "INSERT INTO qa_categories (id,base_id,name,is_builtin,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        (category_id, base_id, name, 0, sort_order, now, now),
    )
    return category_id, name


def create_qa_entry(user_id: str, base_id: str, payload: QaEntryCreate) -> dict[str, Any]:
    base = get_owned_base(user_id, base_id)
    if not base or base["kind"] != "qa":
        raise HTTPException(404, "QA knowledge base not found")
    now = utc_now(); entry_id = new_id("qa")
    with connect() as db:
        category_id, category_name = resolve_qa_category(db, base_id, payload.category_id, payload.category)
        db.execute("INSERT INTO qa_entries (id,base_id,category_id,category,question,keywords_json,answer,image_url,weight,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (entry_id, base_id, category_id, category_name, payload.question.strip(), dumps(payload.keywords), payload.answer.strip(), payload.image_url.strip(), payload.weight, 1 if payload.enabled else 0, now, now))
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, base_id))
        row = db.execute("SELECT * FROM qa_entries WHERE id = ?", (entry_id,)).fetchone()
    return qa_dict(row)


def update_qa_entry(user_id: str, entry_id: str, payload: QaEntryCreate) -> dict[str, Any]:
    now = utc_now()
    with connect() as db:
        current = db.execute(
            """SELECT qa_entries.* FROM qa_entries
            JOIN knowledge_bases ON knowledge_bases.id = qa_entries.base_id
            WHERE qa_entries.id = ? AND knowledge_bases.user_id = ?""",
            (entry_id, user_id),
        ).fetchone()
        if not current:
            raise HTTPException(404, "QA entry not found")
        category_id, category_name = resolve_qa_category(db, current["base_id"], payload.category_id, payload.category)
        db.execute("UPDATE qa_entries SET category_id=?,category=?,question=?,keywords_json=?,answer=?,image_url=?,weight=?,enabled=?,updated_at=? WHERE id = ?", (category_id, category_name, payload.question.strip(), dumps(payload.keywords), payload.answer.strip(), payload.image_url.strip(), payload.weight, 1 if payload.enabled else 0, now, entry_id))
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, current["base_id"]))
        row = db.execute("SELECT * FROM qa_entries WHERE id = ?", (entry_id,)).fetchone()
    return qa_dict(row)


def delete_qa_entry(user_id: str, entry_id: str) -> dict[str, Any]:
    with connect() as db:
        current = db.execute(
            """SELECT qa_entries.* FROM qa_entries
            JOIN knowledge_bases ON knowledge_bases.id = qa_entries.base_id
            WHERE qa_entries.id = ? AND knowledge_bases.user_id = ?""",
            (entry_id, user_id),
        ).fetchone()
        if not current:
            raise HTTPException(404, "QA entry not found")
        db.execute("DELETE FROM qa_entries WHERE id = ?", (entry_id,))
    return qa_dict(current)


def match_qa(user_id: str, payload: QaMatchRequest) -> dict[str, Any]:
    query = normalize(payload.query)
    base_ids = set(payload.base_ids)
    with connect() as db:
        rows = db.execute(
            """SELECT qa_entries.* FROM qa_entries
            JOIN knowledge_bases ON knowledge_bases.id = qa_entries.base_id
            WHERE qa_entries.enabled = 1 AND knowledge_bases.enabled = 1
              AND (knowledge_bases.user_id = ? OR knowledge_bases.is_public = 1)
            ORDER BY qa_entries.weight DESC, qa_entries.updated_at DESC"""
            , (user_id,)
        ).fetchall()
        filtered = [row for row in rows if not base_ids or row["base_id"] in base_ids]

        # Exact questions always take precedence; weight decides between matches in each phase.
        matched_row = next((row for row in filtered if normalize(row["question"]) == query), None)
        match_type = "exact"
        if matched_row is None:
            matched_row = next(
                (
                    row
                    for row in filtered
                    if any(
                        keyword and keyword in query
                        for keyword in (normalize(str(item)) for item in loads(row["keywords_json"], []))
                    )
                ),
                None,
            )
            match_type = "keyword"

        if matched_row is None:
            return {"matched": False, "match_type": "none", "score": 0.0, "entry": None}

        db.execute("UPDATE qa_entries SET call_count = call_count + 1 WHERE id = ?", (matched_row["id"],))
        updated = db.execute("SELECT * FROM qa_entries WHERE id = ?", (matched_row["id"],)).fetchone()
        return {
            "matched": True,
            "match_type": match_type,
            "score": 1.0,
            "entry": qa_dict(updated),
        }


def create_document(user_id: str, payload: DocumentCreate) -> dict[str, Any]:
    base = get_owned_base(user_id, payload.base_id)
    if not base or base["kind"] != "product":
        raise HTTPException(404, "Product knowledge base not found")
    return _persist_document(
        base_id=payload.base_id,
        title=payload.title.strip(),
        content=payload.content,
        original_filename=payload.title.strip(),
        file_type="text",
        file_size=len(payload.content.encode("utf-8")),
    )


def _persist_document(
    *,
    base_id: str,
    title: str,
    content: str,
    original_filename: str,
    file_type: str,
    file_size: int,
) -> dict[str, Any]:
    content = content.strip()
    if not content:
        raise HTTPException(400, "Document has no text content")
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    now = utc_now()
    with connect() as db:
        existing = db.execute(
            "SELECT * FROM documents WHERE base_id = ? AND content_hash = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1",
            (base_id, content_hash),
        ).fetchone()
        if existing:
            return {**document_dict(existing), "duplicate": True}
        doc_id = new_id("doc")
        chunks = chunk_text(content)
        db.execute(
            """INSERT INTO documents
            (id,base_id,title,content,status,original_filename,file_type,file_size,content_hash,error_message,chunk_count,chunk_strategy_version,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (doc_id, base_id, title, content, "ready", original_filename, file_type, file_size, content_hash, "", len(chunks), CHUNK_STRATEGY_VERSION, now, now),
        )
        _insert_document_chunks(db, doc_id, base_id, title, chunks, now)
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, base_id))
        row = db.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    return {**document_dict(row), "duplicate": False}


def document_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "base_id": row["base_id"],
        "title": row["title"],
        "original_filename": row["original_filename"] if "original_filename" in row.keys() else row["title"],
        "file_type": row["file_type"] if "file_type" in row.keys() else "text",
        "file_size": int(row["file_size"] or 0) if "file_size" in row.keys() else 0,
        "status": row["status"],
        "chunk_count": int(row["chunk_count"] or 0) if "chunk_count" in row.keys() else 0,
        "chunk_strategy_version": row["chunk_strategy_version"] if "chunk_strategy_version" in row.keys() else "legacy-v1",
        "error_message": row["error_message"] if "error_message" in row.keys() else "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def import_document(user_id: str, base_id: str, filename: str, data: bytes) -> dict[str, Any]:
    base = get_owned_base(user_id, base_id)
    if not base or base["kind"] != "product":
        raise HTTPException(404, "Product knowledge base not found")
    try:
        parsed: ParsedDocument = parse_document(filename, data)
        title = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        return _persist_document(
            base_id=base_id,
            title=title,
            content=parsed.text,
            original_filename=title,
            file_type=parsed.file_type,
            file_size=len(data),
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def list_documents(user_id: str, base_id: str) -> list[dict[str, Any]]:
    base = get_base(user_id, base_id)
    if not base:
        raise HTTPException(404, "Knowledge base not found")
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM documents WHERE base_id = ? AND status != 'deleted' ORDER BY created_at DESC",
            (base_id,),
        ).fetchall()
    return [document_dict(row) for row in rows]


def get_document(user_id: str, document_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            """SELECT documents.* FROM documents
            JOIN knowledge_bases ON knowledge_bases.id = documents.base_id
            WHERE documents.id = ? AND documents.status != 'deleted'
              AND (knowledge_bases.user_id = ? OR knowledge_bases.is_public = 1)""",
            (document_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    return {**document_dict(row), "content": row["content"]}


def list_document_chunks(user_id: str, document_id: str, page: int = 1, page_size: int = 50) -> dict[str, Any]:
    offset = (page - 1) * page_size
    with connect() as db:
        document = db.execute(
            """SELECT documents.id FROM documents
            JOIN knowledge_bases ON knowledge_bases.id = documents.base_id
            WHERE documents.id = ? AND documents.status != 'deleted'
              AND (knowledge_bases.user_id = ? OR knowledge_bases.is_public = 1)""",
            (document_id, user_id),
        ).fetchone()
        if not document:
            raise HTTPException(404, "Document not found")
        total = int(db.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE document_id = ?",
            (document_id,),
        ).fetchone()[0])
        rows = db.execute(
            """SELECT id, document_id, base_id, chunk_index, title_path, content,
                   chunk_type, metadata_json, strategy_version, enabled, created_at
            FROM document_chunks
            WHERE document_id = ?
            ORDER BY chunk_index
            LIMIT ? OFFSET ?""",
            (document_id, page_size, offset),
        ).fetchall()
    return {
        "items": [
            {
                "id": row["id"],
                "document_id": row["document_id"],
                "base_id": row["base_id"],
                "chunk_index": int(row["chunk_index"]),
                "title_path": row["title_path"],
                "content": row["content"],
                "chunk_type": row["chunk_type"],
                "metadata": loads(row["metadata_json"], {}),
                "strategy_version": row["strategy_version"],
                "enabled": bool(row["enabled"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


def delete_document(user_id: str, document_id: str) -> dict[str, Any]:
    now = utc_now()
    with connect() as db:
        row = db.execute(
            """SELECT documents.* FROM documents
            JOIN knowledge_bases ON knowledge_bases.id = documents.base_id
            WHERE documents.id = ? AND knowledge_bases.user_id = ?""",
            (document_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Document not found")
        db.execute("UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?", (now, document_id))
        if has_chunk_fts(db):
            db.execute("DELETE FROM document_chunks_fts WHERE document_id = ?", (document_id,))
        db.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, row["base_id"]))
    return document_dict(row)


def _insert_document_chunks(
    db: Any,
    document_id: str,
    base_id: str,
    source_title: str,
    chunks: list[TextChunk],
    created_at: str,
) -> None:
    for item in chunks:
        chunk_id = new_id("chunk")
        metadata = item.metadata or {}
        db.execute(
            """INSERT INTO document_chunks
            (id,document_id,base_id,chunk_index,title_path,content,chunk_type,metadata_json,strategy_version,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                chunk_id, document_id, base_id, item.index, item.title_path, item.content,
                item.chunk_type, dumps(metadata), CHUNK_STRATEGY_VERSION, created_at,
            ),
        )
        if has_chunk_fts(db):
            db.execute(
                """INSERT INTO document_chunks_fts
                (chunk_id,document_id,base_id,source_title,title_path,content,
                 source_title_terms,title_path_terms,content_terms)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    chunk_id, document_id, base_id, source_title, item.title_path, item.content,
                    fts_terms(source_title), fts_terms(item.title_path), fts_terms(item.content),
                ),
            )


def reprocess_document(user_id: str, document_id: str) -> dict[str, Any]:
    now = utc_now()
    with connect() as db:
        row = db.execute(
            """SELECT documents.* FROM documents
            JOIN knowledge_bases ON knowledge_bases.id = documents.base_id
            WHERE documents.id = ? AND documents.status != 'deleted'
              AND knowledge_bases.user_id = ?""",
            (document_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Document not found")
        chunks = chunk_text(row["content"])
        if has_chunk_fts(db):
            db.execute("DELETE FROM document_chunks_fts WHERE document_id = ?", (document_id,))
        db.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
        _insert_document_chunks(db, row["id"], row["base_id"], row["title"], chunks, now)
        db.execute(
            """UPDATE documents SET chunk_count = ?, chunk_strategy_version = ?,
               error_message = '', status = 'ready', updated_at = ? WHERE id = ?""",
            (len(chunks), CHUNK_STRATEGY_VERSION, now, document_id),
        )
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, row["base_id"]))
        updated = db.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    return document_dict(updated)


def _keyword_candidates(db: Any, user_id: str, payload: DocumentSearchRequest) -> list[dict[str, Any]]:
    query = payload.query.casefold()
    terms = [item for item in re.findall(r"[0-9a-zA-Z][0-9a-zA-Z_-]{1,}", query) if item]
    cjk = "".join(re.findall(r"[\u4e00-\u9fff]", query))
    terms.extend(cjk[index : index + size] for size in (2, 3) for index in range(max(0, len(cjk) - size + 1)))
    terms = list(dict.fromkeys(term for term in terms if term))
    base_ids = set(payload.base_ids)
    rows = db.execute(
        """SELECT c.*, d.title AS source_title, d.status AS document_status
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        JOIN knowledge_bases b ON b.id = c.base_id
        WHERE c.enabled = 1 AND d.status = 'ready' AND (b.user_id = ? OR b.is_public = 1)""",
        (user_id,),
    ).fetchall()
    results: list[dict[str, Any]] = []
    for row in rows:
        if base_ids and row["base_id"] not in base_ids:
            continue
        haystack = f"{row['source_title']} {row['title_path']} {row['content']}".casefold()
        score = sum(haystack.count(term) for term in terms)
        if score:
            results.append({"row": row, "rank": float(score)})
    results.sort(key=lambda item: item["rank"], reverse=True)
    return results


def _fts_candidates(db: Any, user_id: str, payload: DocumentSearchRequest) -> list[dict[str, Any]]:
    tokens = fts_terms(payload.query).split()
    if not tokens or not has_chunk_fts(db):
        return []
    match_query = " OR ".join(f'"{token.replace(chr(34), chr(34) * 2)}"' for token in tokens[:64])
    conditions = ["c.enabled = 1", "d.status = 'ready'", "(b.user_id = ? OR b.is_public = 1)"]
    parameters: list[Any] = [match_query, user_id]
    if payload.base_ids:
        placeholders = ",".join("?" for _ in payload.base_ids)
        conditions.append(f"c.base_id IN ({placeholders})")
        parameters.extend(payload.base_ids)
    rows = db.execute(
        f"""SELECT c.*, d.title AS source_title,
               bm25(document_chunks_fts, 0.0, 0.0, 0.0, 6.0, 4.0, 1.0, 6.0, 4.0, 1.0) AS bm25_score
        FROM document_chunks_fts
        JOIN document_chunks c ON c.id = document_chunks_fts.chunk_id
        JOIN documents d ON d.id = c.document_id
        JOIN knowledge_bases b ON b.id = c.base_id
        WHERE document_chunks_fts MATCH ? AND {' AND '.join(conditions)}
        ORDER BY bm25_score ASC
        LIMIT ?""",
        (*parameters, max(payload.top_k * 6, 20)),
    ).fetchall()
    return [{"row": row, "rank": abs(float(row["bm25_score"]))} for row in rows]


def _expanded_snippet(db: Any, row: Any, reserved_chunk_ids: set[str]) -> tuple[str, list[str]]:
    neighbors = db.execute(
        """SELECT id, chunk_index, title_path, content FROM document_chunks
        WHERE document_id = ? AND enabled = 1 AND chunk_index BETWEEN ? AND ?
        ORDER BY chunk_index""",
        (row["document_id"], max(0, int(row["chunk_index"]) - 1), int(row["chunk_index"]) + 1),
    ).fetchall()
    selected = []
    total_length = 0
    for neighbor in neighbors:
        if neighbor["id"] != row["id"] and neighbor["title_path"] != row["title_path"]:
            continue
        if neighbor["id"] != row["id"] and neighbor["id"] in reserved_chunk_ids:
            continue
        content = str(neighbor["content"] or "").strip()
        if not content:
            continue
        if selected and total_length + len(content) > 1600:
            continue
        selected.append(neighbor)
        total_length += len(content)
    if not any(item["id"] == row["id"] for item in selected):
        selected = [row]
    chunk_ids = [item["id"] for item in selected]
    snippet_parts: list[str] = []
    for item in selected:
        content = str(item["content"] or "").strip()
        if content and not any(content in existing or existing in content for existing in snippet_parts):
            snippet_parts.append(content)
    return "\n".join(snippet_parts)[:1800], chunk_ids


def search_documents(user_id: str, payload: DocumentSearchRequest) -> dict[str, Any]:
    with connect() as db:
        mode = "fts5_bm25"
        try:
            candidates = _fts_candidates(db, user_id, payload)
        except sqlite3.OperationalError:
            candidates = []
        if not candidates:
            mode = "keyword"
            candidates = _keyword_candidates(db, user_id, payload)

        results: list[dict[str, Any]] = []
        reserved_chunk_ids: set[str] = set()
        for candidate in candidates:
            row = candidate["row"]
            if row["id"] in reserved_chunk_ids:
                continue
            snippet, context_chunk_ids = _expanded_snippet(db, row, reserved_chunk_ids)
            if not snippet:
                continue
            reserved_chunk_ids.update(context_chunk_ids)
            results.append({
                "source_id": row["document_id"],
                "chunk_id": row["id"],
                "context_chunk_ids": context_chunk_ids,
                "base_id": row["base_id"],
                "source_title": row["source_title"],
                "title_path": row["title_path"],
                "chunk_type": row["chunk_type"],
                "snippet": snippet,
                "score": round(float(candidate["rank"]), 6),
            })
            if len(results) >= payload.top_k:
                break
    return {
        "results": results,
        "metadata": {
            "mode": mode,
            "candidate_count": len(candidates),
            "count": len(results),
            "chunk_strategy_version": CHUNK_STRATEGY_VERSION,
        },
    }
