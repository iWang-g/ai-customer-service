from __future__ import annotations

import logging

import uvicorn
from fastapi import APIRouter, Depends, FastAPI, File, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.core.config import get_settings
from app.auth import CurrentUser, current_user, current_user_id
from app.db import init_db
from app.schemas import DocumentCreate, DocumentSearchRequest, KnowledgeBaseCreate, KnowledgeBaseUpdate, QaCategoryCreate, QaEntryCreate, QaMatchRequest
from app.service import create_base, create_document, create_qa_category, create_qa_entry, delete_base, delete_document, delete_qa_entry, get_base, get_document, get_qa_image, import_document, list_bases, list_document_chunks, list_documents, list_qa_categories, list_qa_entries, match_qa, reprocess_document, save_qa_image, search_documents, update_base, update_qa_entry


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user_id)])

    @app.on_event("startup")
    def startup() -> None:
        logging.basicConfig(level=settings.log_level.upper())
        init_db()

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "knowledge-base"}

    @router.get("/knowledge-bases")
    def bases(kind: str | None = Query(default=None), user_id: str = Depends(current_user_id)) -> list[dict]:
        return list_bases(user_id, kind)

    @router.post("/knowledge-bases")
    def add_base(payload: KnowledgeBaseCreate, user: CurrentUser = Depends(current_user)) -> dict:
        return create_base(user.id, payload, user.username, user.display_name)

    @router.get("/knowledge-bases/{base_id}")
    def base(base_id: str, user_id: str = Depends(current_user_id)) -> dict:
        value = get_base(user_id, base_id)
        if value is None:
            from fastapi import HTTPException
            raise HTTPException(404, "Knowledge base not found")
        return value

    @router.patch("/knowledge-bases/{base_id}")
    def edit_base(base_id: str, payload: KnowledgeBaseUpdate, user_id: str = Depends(current_user_id)) -> dict:
        return update_base(user_id, base_id, payload)

    @router.delete("/knowledge-bases/{base_id}")
    def remove_base(base_id: str, user_id: str = Depends(current_user_id)) -> dict:
        return delete_base(user_id, base_id)

    @router.get("/knowledge-bases/{base_id}/qa-entries")
    def qa_entries(
        base_id: str,
        category_id: str | None = Query(default=None),
        keyword: str = Query(default="", max_length=256),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
        user_id: str = Depends(current_user_id),
    ) -> dict:
        return list_qa_entries(user_id, base_id, category_id, keyword, page, page_size)

    @router.get("/knowledge-bases/{base_id}/qa-categories")
    def qa_categories(base_id: str, user_id: str = Depends(current_user_id)) -> list[dict]:
        return list_qa_categories(user_id, base_id)

    @router.post("/knowledge-bases/{base_id}/qa-categories")
    def add_qa_category(base_id: str, payload: QaCategoryCreate, user_id: str = Depends(current_user_id)) -> dict:
        return create_qa_category(user_id, base_id, payload)

    @router.post("/knowledge-bases/{base_id}/qa-entries")
    def add_qa(base_id: str, payload: QaEntryCreate, user_id: str = Depends(current_user_id)) -> dict:
        return create_qa_entry(user_id, base_id, payload)

    @router.patch("/qa-entries/{entry_id}")
    def edit_qa(entry_id: str, payload: QaEntryCreate, user_id: str = Depends(current_user_id)) -> dict:
        return update_qa_entry(user_id, entry_id, payload)

    @router.delete("/qa-entries/{entry_id}")
    def remove_qa(entry_id: str, user_id: str = Depends(current_user_id)) -> dict:
        return delete_qa_entry(user_id, entry_id)

    @router.post("/qa/match")
    def qa_match(payload: QaMatchRequest, user_id: str = Depends(current_user_id)) -> dict:
        return match_qa(user_id, payload)

    @router.post("/qa-assets")
    async def upload_qa_image(file: UploadFile = File(...), user_id: str = Depends(current_user_id)) -> dict:
        return save_qa_image(user_id, file.filename or "image", file.content_type or "", await file.read())

    @router.get("/qa-assets/{asset_name}")
    def qa_image(asset_name: str, user_id: str = Depends(current_user_id)) -> FileResponse:
        path, media_type = get_qa_image(user_id, asset_name)
        return FileResponse(path, media_type=media_type)

    @router.post("/documents")
    def add_document(payload: DocumentCreate, user_id: str = Depends(current_user_id)) -> dict:
        return create_document(user_id, payload)

    @router.get("/knowledge-bases/{base_id}/documents")
    def documents(base_id: str, user_id: str = Depends(current_user_id)) -> list[dict]:
        return list_documents(user_id, base_id)

    @router.get("/documents/{document_id}")
    def document(document_id: str, user_id: str = Depends(current_user_id)) -> dict:
        return get_document(user_id, document_id)

    @router.get("/documents/{document_id}/chunks")
    def document_chunks(
        document_id: str,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
        user_id: str = Depends(current_user_id),
    ) -> dict:
        return list_document_chunks(user_id, document_id, page, page_size)

    @router.post("/documents/import")
    async def import_document_file(base_id: str = Query(...), file: UploadFile = File(...), user_id: str = Depends(current_user_id)) -> dict:
        return import_document(user_id, base_id, file.filename or "document.txt", await file.read())

    @router.delete("/documents/{document_id}")
    def remove_document(document_id: str, user_id: str = Depends(current_user_id)) -> dict:
        return delete_document(user_id, document_id)

    @router.post("/documents/{document_id}/reprocess")
    def reprocess_document_chunks(document_id: str, user_id: str = Depends(current_user_id)) -> dict:
        return reprocess_document(user_id, document_id)

    @router.post("/documents/search")
    def documents_search(payload: DocumentSearchRequest, user_id: str = Depends(current_user_id)) -> dict:
        return search_documents(user_id, payload)

    app.include_router(router)
    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
