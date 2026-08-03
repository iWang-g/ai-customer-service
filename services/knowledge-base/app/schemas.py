from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


KnowledgeKind = Literal["qa", "product", "tone"]


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: KnowledgeKind
    persona: str = Field(default="", max_length=2000)


class KnowledgeBaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    persona: str | None = Field(default=None, max_length=2000)
    enabled: bool | None = None


class KnowledgeBaseRead(BaseModel):
    id: str
    name: str
    kind: KnowledgeKind
    persona: str
    enabled: bool
    item_count: int
    created_at: str
    updated_at: str


class QaEntryCreate(BaseModel):
    category_id: str = Field(default="", max_length=64)
    category: str = Field(default="", max_length=128)
    question: str = Field(min_length=1, max_length=2000)
    keywords: list[str] = Field(default_factory=list, max_length=32)
    answer: str = Field(min_length=1, max_length=10000)
    image_url: str = Field(default="", max_length=2000)
    weight: int = Field(default=10, ge=0, le=100)
    enabled: bool = True


class QaEntryRead(QaEntryCreate):
    id: str
    base_id: str
    call_count: int
    created_at: str
    updated_at: str


class QaCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class QaCategoryRead(BaseModel):
    id: str
    base_id: str
    name: str
    is_builtin: bool
    sort_order: int
    item_count: int
    created_at: str
    updated_at: str


class QaEntryPage(BaseModel):
    items: list[QaEntryRead]
    total: int
    page: int
    page_size: int
    pages: int


class QaMatchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    base_ids: list[str] = Field(default_factory=list, max_length=32)


class DocumentCreate(BaseModel):
    base_id: str
    title: str = Field(min_length=1, max_length=256)
    content: str = Field(min_length=1, max_length=500000)


class DocumentRead(BaseModel):
    id: str
    base_id: str
    title: str
    original_filename: str
    file_type: str
    file_size: int
    status: str
    chunk_count: int
    error_message: str
    created_at: str
    updated_at: str


class DocumentSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    base_ids: list[str] = Field(default_factory=list, max_length=32)
    top_k: int = Field(default=5, ge=1, le=20)
