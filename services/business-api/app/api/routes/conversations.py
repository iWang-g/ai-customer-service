from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.conversation import (
    ConversationDetailResponse,
    ConversationHistoryClearResponse,
    ConversationListResponse,
    ConversationSyncIssueDetailResponse,
    ConversationSyncIssueRebuildResponse,
    ConversationTestResetResponse,
)
from app.schemas.message import MessageListResponse
from app.schemas.order import CustomerOrdersResponse
from app.services.message_service import (
    clear_human_required,
    clear_conversation_history,
    dismiss_conversation_message_sync_issue,
    get_conversation,
    get_conversation_message_sync_issue,
    list_conversations,
    list_messages,
    rebuild_conversation_message_queue,
    reset_pinduoduo_conversation_test_data,
    soft_delete_conversation,
)
from app.services.order_service import customer_orders_response
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


@router.get(
    "/{conversation_id}/message-sync-issue",
    response_model=ConversationSyncIssueDetailResponse,
)
def conversation_message_sync_issue(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationSyncIssueDetailResponse:
    return get_conversation_message_sync_issue(db, user, conversation_id)


@router.post(
    "/{conversation_id}/message-sync-issue/dismiss",
    response_model=ConversationDetailResponse,
)
async def dismiss_message_sync_issue(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationDetailResponse:
    conversation = dismiss_conversation_message_sync_issue(db, user, conversation_id)
    await realtime_manager.broadcast(
        user.id,
        {"type": "conversation.updated", "conversation": conversation.model_dump(mode="json")},
    )
    return ConversationDetailResponse(conversation=conversation)


@router.post(
    "/{conversation_id}/message-sync-issue/rebuild",
    response_model=ConversationSyncIssueRebuildResponse,
)
async def rebuild_message_queue(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationSyncIssueRebuildResponse:
    conversation, messages, deleted_counts = rebuild_conversation_message_queue(
        db,
        user,
        conversation_id,
    )
    await realtime_manager.broadcast(
        user.id,
        {
            "type": "conversation.rebuilt",
            "conversation": conversation.model_dump(mode="json"),
        },
    )
    return ConversationSyncIssueRebuildResponse(
        conversation=conversation,
        messages=messages,
        deleted_counts=deleted_counts,
    )


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


@router.post("/{conversation_id}/reset-test-data", response_model=ConversationTestResetResponse)
async def reset_conversation_test_data(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationTestResetResponse:
    conversation, deleted_counts = reset_pinduoduo_conversation_test_data(
        db,
        user,
        conversation_id,
    )
    await realtime_manager.broadcast(
        user.id,
        {"type": "conversation.reset", "conversation": conversation.model_dump(mode="json")},
    )
    return ConversationTestResetResponse(
        conversation=conversation,
        deleted_counts=deleted_counts,
    )


@router.post("/{conversation_id}/clear-history", response_model=ConversationHistoryClearResponse)
async def clear_history(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationHistoryClearResponse:
    conversation = clear_conversation_history(db, user, conversation_id)
    await realtime_manager.broadcast(
        user.id,
        {"type": "conversation.cleared", "conversation": conversation.model_dump(mode="json")},
    )
    return ConversationHistoryClearResponse(conversation=conversation)


@router.delete("/{conversation_id}", response_model=ConversationDetailResponse)
async def delete_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationDetailResponse:
    conversation = soft_delete_conversation(db, user, conversation_id)
    await realtime_manager.broadcast(
        user.id,
        {"type": "conversation.deleted", "conversation_id": conversation_id},
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


@router.get("/{conversation_id}/orders", response_model=CustomerOrdersResponse)
def conversation_orders(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> CustomerOrdersResponse:
    return customer_orders_response(db, user, conversation_id)
