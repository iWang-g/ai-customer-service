from __future__ import annotations

import logging

import uvicorn
from fastapi import APIRouter, FastAPI, File, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.core.config import get_settings
from app.db import init_db
from app.schemas import DocumentCreate, DocumentSearchRequest, KnowledgeBaseCreate, KnowledgeBaseUpdate, QaCategoryCreate, QaEntryCreate, QaMatchRequest
from app.service import create_base, create_document, create_qa_category, create_qa_entry, delete_base, delete_document, delete_qa_entry, get_base, get_document, get_qa_image, import_document, list_bases, list_document_chunks, list_documents, list_qa_categories, list_qa_entries, match_qa, save_qa_image, search_documents, update_base, update_qa_entry


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:9527", "http://localhost:9527", "null"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    router = APIRouter(prefix="/api/v1")

    @app.on_event("startup")
    def startup() -> None:
        logging.basicConfig(level=settings.log_level.upper())
        init_db()

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "knowledge-base"}

    @router.get("/knowledge-bases")
    def bases(kind: str | None = Query(default=None)) -> list[dict]:
        return list_bases(kind)

    @router.post("/knowledge-bases")
    def add_base(payload: KnowledgeBaseCreate) -> dict:
        return create_base(payload)

    @router.get("/knowledge-bases/{base_id}")
    def base(base_id: str) -> dict:
        value = get_base(base_id)
        if value is None:
            from fastapi import HTTPException
            raise HTTPException(404, "Knowledge base not found")
        return value

    @router.patch("/knowledge-bases/{base_id}")
    def edit_base(base_id: str, payload: KnowledgeBaseUpdate) -> dict:
        return update_base(base_id, payload)

    @router.delete("/knowledge-bases/{base_id}")
    def remove_base(base_id: str) -> dict:
        return delete_base(base_id)

    @router.get("/knowledge-bases/{base_id}/qa-entries")
    def qa_entries(
        base_id: str,
        category_id: str | None = Query(default=None),
        keyword: str = Query(default="", max_length=256),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
    ) -> dict:
        return list_qa_entries(base_id, category_id, keyword, page, page_size)

    @router.get("/knowledge-bases/{base_id}/qa-categories")
    def qa_categories(base_id: str) -> list[dict]:
        return list_qa_categories(base_id)

    @router.post("/knowledge-bases/{base_id}/qa-categories")
    def add_qa_category(base_id: str, payload: QaCategoryCreate) -> dict:
        return create_qa_category(base_id, payload)

    @router.post("/knowledge-bases/{base_id}/qa-entries")
    def add_qa(base_id: str, payload: QaEntryCreate) -> dict:
        return create_qa_entry(base_id, payload)

    @router.patch("/qa-entries/{entry_id}")
    def edit_qa(entry_id: str, payload: QaEntryCreate) -> dict:
        return update_qa_entry(entry_id, payload)

    @router.delete("/qa-entries/{entry_id}")
    def remove_qa(entry_id: str) -> dict:
        return delete_qa_entry(entry_id)

    @router.post("/qa/match")
    def qa_match(payload: QaMatchRequest) -> dict:
        return match_qa(payload)

    @router.post("/qa-assets")
    async def upload_qa_image(file: UploadFile = File(...)) -> dict:
        return save_qa_image(file.filename or "image", file.content_type or "", await file.read())

    @router.get("/qa-assets/{asset_name}")
    def qa_image(asset_name: str) -> FileResponse:
        path, media_type = get_qa_image(asset_name)
        return FileResponse(path, media_type=media_type)

    @router.post("/documents")
    def add_document(payload: DocumentCreate) -> dict:
        return create_document(payload)

    @router.get("/knowledge-bases/{base_id}/documents")
    def documents(base_id: str) -> list[dict]:
        return list_documents(base_id)

    @router.get("/documents/{document_id}")
    def document(document_id: str) -> dict:
        return get_document(document_id)

    @router.get("/documents/{document_id}/chunks")
    def document_chunks(
        document_id: str,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
    ) -> dict:
        return list_document_chunks(document_id, page, page_size)

    @router.post("/documents/import")
    async def import_document_file(base_id: str = Query(...), file: UploadFile = File(...)) -> dict:
        return import_document(base_id, file.filename or "document.txt", await file.read())

    @router.delete("/documents/{document_id}")
    def remove_document(document_id: str) -> dict:
        return delete_document(document_id)

    @router.post("/documents/search")
    def documents_search(payload: DocumentSearchRequest) -> dict:
        return search_documents(payload)

    app.include_router(router)
    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
