from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.conversation import ConversationDetailResponse, ConversationListResponse
from app.schemas.message import MessageListResponse
from app.services.message_service import clear_human_required, get_conversation, list_conversations, list_messages
from app.services.realtime import realtime_manager

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("", response_model=ConversationListResponse)
def conversations(
    platform_code: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationListResponse:
    return list_conversations(db, user, platform_code=platform_code, status_filter=status, limit=limit, offset=offset)


@router.get("/{conversation_id}", response_model=ConversationDetailResponse)
def conversation_detail(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationDetailResponse:
    return ConversationDetailResponse(conversation=get_conversation(db, user, conversation_id))


@router.post("/{conversation_id}/clear-human-required", response_model=ConversationDetailResponse)
async def clear_conversation_human_required(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationDetailResponse:
    conversation = clear_human_required(db, user, conversation_id)
    await realtime_manager.broadcast(
        user.id,
        {"type": "conversation.updated", "conversation": conversation.model_dump(mode="json")},
    )
    return ConversationDetailResponse(conversation=conversation)


@router.get("/{conversation_id}/messages", response_model=MessageListResponse)
def conversation_messages(
    conversation_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> MessageListResponse:
    return list_messages(db, user, conversation_id, limit=limit, offset=offset)
