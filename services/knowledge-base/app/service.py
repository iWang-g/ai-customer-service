from __future__ import annotations

import hashlib
import io
import mimetypes
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from app.db import DEFAULT_QA_CATEGORIES, connect, dumps, loads, utc_now
from app.core.config import get_settings
from app.document_parser import ParsedDocument, chunk_text, parse_document
from app.schemas import DocumentCreate, DocumentSearchRequest, KnowledgeBaseCreate, KnowledgeBaseUpdate, QaCategoryCreate, QaEntryCreate, QaMatchRequest


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def normalize(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", text.casefold())


def asset_directory() -> Path:
    path = Path(get_settings().asset_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
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


def save_qa_image(filename: str, content_type: str, data: bytes) -> dict[str, Any]:
    allowed_types = {"image/jpeg", "image/png", "image/gif", "image/webp"}
    declared_type = content_type.casefold()
    guessed_type, _ = mimetypes.guess_type(filename)
    if declared_type not in allowed_types and (guessed_type or "").casefold() not in allowed_types:
        raise HTTPException(415, "Only JPG, PNG, GIF and WebP images are supported")

    normalized = _normalize_qa_image(data)
    asset_name = f"qa-{uuid.uuid4().hex}.png"
    (asset_directory() / asset_name).write_bytes(normalized)
    return {
        "image_url": f"/qa-assets/{asset_name}",
        "filename": filename,
        "content_type": "image/png",
        "size": len(normalized),
    }


def get_qa_image(asset_name: str) -> tuple[Path, str]:
    if Path(asset_name).name != asset_name:
        raise HTTPException(404, "Image not found")
    path = asset_directory() / asset_name
    if not path.is_file():
        raise HTTPException(404, "Image not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return path, media_type


def row_base(row: Any, count: int) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "kind": row["kind"],
        "persona": row["persona"], "enabled": bool(row["enabled"]),
        "item_count": count, "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_bases(kind: str | None = None) -> list[dict[str, Any]]:
    with connect() as db:
        query = "SELECT * FROM knowledge_bases"
        params: list[Any] = []
        if kind:
            query += " WHERE kind = ?"
            params.append(kind)
        rows = db.execute(query + " ORDER BY updated_at DESC", params).fetchall()
        result = []
        for row in rows:
            table = "qa_entries" if row["kind"] == "qa" else "documents"
            count_query = f"SELECT COUNT(*) FROM {table} WHERE base_id = ?"
            if table == "documents":
                count_query += " AND status != 'deleted'"
            count = db.execute(count_query, (row["id"],)).fetchone()[0]
            result.append(row_base(row, int(count)))
        return result


def get_base(base_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM knowledge_bases WHERE id = ?", (base_id,)).fetchone()
        if not row:
            return None
        table = "qa_entries" if row["kind"] == "qa" else "documents"
        count_query = f"SELECT COUNT(*) FROM {table} WHERE base_id = ?"
        if table == "documents":
            count_query += " AND status != 'deleted'"
        count = db.execute(count_query, (base_id,)).fetchone()[0]
        return row_base(row, int(count))


def create_base(payload: KnowledgeBaseCreate) -> dict[str, Any]:
    now = utc_now()
    base_id = new_id("kb")
    with connect() as db:
        db.execute("INSERT INTO knowledge_bases (id,name,kind,persona,created_at,updated_at) VALUES (?,?,?,?,?,?)", (base_id, payload.name.strip(), payload.kind, payload.persona.strip(), now, now))
        if payload.kind == "qa":
            for sort_order, category_name in enumerate(DEFAULT_QA_CATEGORIES):
                db.execute(
                    "INSERT INTO qa_categories (id,base_id,name,is_builtin,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                    (new_id("qac"), base_id, category_name, 1, sort_order, now, now),
                )
    return get_base(base_id)  # type: ignore[return-value]


def update_base(base_id: str, payload: KnowledgeBaseUpdate) -> dict[str, Any]:
    current = get_base(base_id)
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
    if fields:
        fields.append("updated_at = ?"); values.extend([utc_now(), base_id])
        with connect() as db:
            db.execute(f"UPDATE knowledge_bases SET {', '.join(fields)} WHERE id = ?", values)
    return get_base(base_id)  # type: ignore[return-value]


def delete_base(base_id: str) -> dict[str, Any]:
    current = get_base(base_id)
    if not current:
        raise HTTPException(404, "Knowledge base not found")
    with connect() as db:
        db.execute("DELETE FROM knowledge_bases WHERE id = ?", (base_id,))
    return current


def qa_category_dict(row: Any, item_count: int = 0) -> dict[str, Any]:
    return {
        "id": row["id"], "base_id": row["base_id"], "name": row["name"],
        "is_builtin": bool(row["is_builtin"]), "sort_order": row["sort_order"],
        "item_count": item_count, "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_qa_categories(base_id: str) -> list[dict[str, Any]]:
    base = get_base(base_id)
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


def create_qa_category(base_id: str, payload: QaCategoryCreate) -> dict[str, Any]:
    base = get_base(base_id)
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
    base_id: str,
    category_id: str | None = None,
    keyword: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    if not get_base(base_id):
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


def create_qa_entry(base_id: str, payload: QaEntryCreate) -> dict[str, Any]:
    base = get_base(base_id)
    if not base or base["kind"] != "qa":
        raise HTTPException(404, "QA knowledge base not found")
    now = utc_now(); entry_id = new_id("qa")
    with connect() as db:
        category_id, category_name = resolve_qa_category(db, base_id, payload.category_id, payload.category)
        db.execute("INSERT INTO qa_entries (id,base_id,category_id,category,question,keywords_json,answer,image_url,weight,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (entry_id, base_id, category_id, category_name, payload.question.strip(), dumps(payload.keywords), payload.answer.strip(), payload.image_url.strip(), payload.weight, 1 if payload.enabled else 0, now, now))
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, base_id))
        row = db.execute("SELECT * FROM qa_entries WHERE id = ?", (entry_id,)).fetchone()
    return qa_dict(row)


def update_qa_entry(entry_id: str, payload: QaEntryCreate) -> dict[str, Any]:
    now = utc_now()
    with connect() as db:
        current = db.execute("SELECT * FROM qa_entries WHERE id = ?", (entry_id,)).fetchone()
        if not current:
            raise HTTPException(404, "QA entry not found")
        category_id, category_name = resolve_qa_category(db, current["base_id"], payload.category_id, payload.category)
        db.execute("UPDATE qa_entries SET category_id=?,category=?,question=?,keywords_json=?,answer=?,image_url=?,weight=?,enabled=?,updated_at=? WHERE id = ?", (category_id, category_name, payload.question.strip(), dumps(payload.keywords), payload.answer.strip(), payload.image_url.strip(), payload.weight, 1 if payload.enabled else 0, now, entry_id))
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, current["base_id"]))
        row = db.execute("SELECT * FROM qa_entries WHERE id = ?", (entry_id,)).fetchone()
    return qa_dict(row)


def delete_qa_entry(entry_id: str) -> dict[str, Any]:
    with connect() as db:
        current = db.execute("SELECT * FROM qa_entries WHERE id = ?", (entry_id,)).fetchone()
        if not current:
            raise HTTPException(404, "QA entry not found")
        db.execute("DELETE FROM qa_entries WHERE id = ?", (entry_id,))
    return qa_dict(current)


def match_qa(payload: QaMatchRequest) -> dict[str, Any]:
    query = normalize(payload.query)
    base_ids = set(payload.base_ids)
    with connect() as db:
        rows = db.execute(
            """SELECT qa_entries.* FROM qa_entries
            JOIN knowledge_bases ON knowledge_bases.id = qa_entries.base_id
            WHERE qa_entries.enabled = 1 AND knowledge_bases.enabled = 1
            ORDER BY qa_entries.weight DESC, qa_entries.updated_at DESC"""
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


def create_document(payload: DocumentCreate) -> dict[str, Any]:
    base = get_base(payload.base_id)
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
            (id,base_id,title,content,status,original_filename,file_type,file_size,content_hash,error_message,chunk_count,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (doc_id, base_id, title, content, "ready", original_filename, file_type, file_size, content_hash, "", len(chunks), now, now),
        )
        for item in chunks:
            db.execute(
                """INSERT INTO document_chunks
                (id,document_id,base_id,chunk_index,title_path,content,created_at)
                VALUES (?,?,?,?,?,?,?)""",
                (new_id("chunk"), doc_id, base_id, item.index, item.title_path, item.content, now),
            )
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
        "error_message": row["error_message"] if "error_message" in row.keys() else "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def import_document(base_id: str, filename: str, data: bytes) -> dict[str, Any]:
    base = get_base(base_id)
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


def list_documents(base_id: str) -> list[dict[str, Any]]:
    base = get_base(base_id)
    if not base:
        raise HTTPException(404, "Knowledge base not found")
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM documents WHERE base_id = ? AND status != 'deleted' ORDER BY created_at DESC",
            (base_id,),
        ).fetchall()
    return [document_dict(row) for row in rows]


def delete_document(document_id: str) -> dict[str, Any]:
    now = utc_now()
    with connect() as db:
        row = db.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Document not found")
        db.execute("UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?", (now, document_id))
        db.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
        db.execute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", (now, row["base_id"]))
    return document_dict(row)


def search_documents(payload: DocumentSearchRequest) -> dict[str, Any]:
    query = payload.query.casefold()
    terms = [item for item in re.findall(r"[0-9a-zA-Z][0-9a-zA-Z_-]{1,}", query) if item]
    cjk = "".join(re.findall(r"[\u4e00-\u9fff]", query))
    terms.extend(cjk[index : index + size] for size in (2, 3) for index in range(max(0, len(cjk) - size + 1)))
    terms = list(dict.fromkeys(term for term in terms if term))
    base_ids = set(payload.base_ids)
    with connect() as db:
        rows = db.execute(
            """SELECT c.*, d.title AS source_title, d.status AS document_status
            FROM document_chunks c JOIN documents d ON d.id = c.document_id
            WHERE c.enabled = 1 AND d.status = 'ready'"""
        ).fetchall()
    results = []
    for row in rows:
        if base_ids and row["base_id"] not in base_ids:
            continue
        haystack = f"{row['source_title']} {row['title_path']} {row['content']}".casefold()
        score = sum(haystack.count(term) for term in terms)
        if score:
            results.append({"source_id": row["document_id"], "chunk_id": row["id"], "base_id": row["base_id"], "source_title": row["source_title"], "snippet": row["content"][:1200], "score": score})
    results.sort(key=lambda item: item["score"], reverse=True)
    return {"results": results[: payload.top_k], "metadata": {"mode": "keyword", "count": len(results)}}
