from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Literal
from app.services import qianniu_transfer_service as qn_transfer

from app.api.deps import get_current_user, get_db_session
from app.models import User, Conversation
from app.schemas.conversation import (
    ConversationDetailResponse,
    ConversationHistoryClearResponse,
    ConversationListResponse,
    ConversationSyncIssueDetailResponse,
    ConversationSyncIssueRebuildResponse,
    ConversationTestResetResponse,
)
from app.schemas.message import MessageListResponse
from app.schemas.message_notice import MessageNoticeSnapshot
from app.services.message_notice_service import list_message_notices
from app.schemas.order import CustomerOrdersResponse
from app.schemas.product import CustomerProductsResponse
from app.services.message_service import (
    clear_awaiting_reply,
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
from app.services.product_service import customer_products_response
from app.services.realtime import realtime_manager
from app.services.qianniu_send_guard import check_qianniu_send_guard

router = APIRouter(prefix="/conversations", tags=["conversations"])


class DouyinTransferBegin(BaseModel):
    auto_task_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    target_id: str = Field(pattern=r'^\d{1,40}$')
    source_id: str = Field(pattern=r'^\d{1,40}$')
    target_name: str = Field(min_length=1, max_length=128)
    reason: str = Field(default='人工转接', min_length=1, max_length=200)


class DouyinTransferFinish(BaseModel):
    operation_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    outcome: Literal['transferred', 'failed', 'confirmation_pending']
    evidence: dict = Field(default_factory=dict)
    error: str | None = Field(default=None, max_length=500)


@router.get('/douyin/send-guard/{task_id}')
def douyin_send_guard(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.douyin_transfer_service import send_guard
    return send_guard(db, user, task_id)


@router.get('/{conversation_id}/douyin/transfer-context')
def douyin_transfer_context(conversation_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.douyin_transfer_service import context
    return context(db, user, conversation_id)[1]


@router.get('/{conversation_id}/douyin/auto-transfer/{task_id}')
def douyin_auto_transfer_check(conversation_id: str, task_id: str,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.douyin_auto_transfer import check_task
    return check_task(db, user, conversation_id, task_id)


@router.post('/{conversation_id}/douyin/transfer/begin')
async def douyin_transfer_begin(conversation_id: str, body: DouyinTransferBegin,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.douyin_transfer_service import begin
    result = begin(db, user, conversation_id, body.target_id, body.target_name, body.source_id, body.reason, body.auto_task_id)
    await realtime_manager.broadcast(user.id, {'type': 'conversation.updated',
        'conversation': get_conversation(db, user, conversation_id).model_dump(mode='json')})
    return result


@router.post('/{conversation_id}/douyin/transfer/finish')
async def douyin_transfer_finish(conversation_id: str, body: DouyinTransferFinish,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.douyin_transfer_service import finish
    result = finish(db, user, conversation_id, body.operation_id, body.outcome, body.evidence, body.error)
    await realtime_manager.broadcast(user.id, {'type': 'conversation.updated',
        'conversation': get_conversation(db, user, conversation_id).model_dump(mode='json')})
    return result


@router.get('/message-notices', response_model=MessageNoticeSnapshot)
def message_notices(since: datetime, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    return list_message_notices(db, user, since)


class QianniuTransferBegin(BaseModel):
    auto_task_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    target_uid: str = Field(pattern=r'^\d{1,30}$')
    target_nick: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=200)


class QianniuTransferFinish(BaseModel):
    operation_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    outcome: Literal['transferred', 'failed', 'confirmation_pending']
    evidence: dict = Field(default_factory=dict)
    error: str | None = Field(default=None, max_length=500)


@router.get('/qianniu/send-guard')
def qianniu_send_guard(platform_account_id: str, cid: str, task_id: str | None = None,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    return check_qianniu_send_guard(db, user, platform_account_id, cid, task_id)


@router.get('/{conversation_id}/qianniu/auto-transfer/{task_id}')
def qianniu_auto_transfer_check(conversation_id: str, task_id: str,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.qianniu_auto_transfer import check_task
    return check_task(db, user, conversation_id, task_id)


@router.get('/{conversation_id}/qianniu/transfer-context')
def qianniu_transfer_context(conversation_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    return qn_transfer.context(db, user, conversation_id)[1]


@router.post('/{conversation_id}/qianniu/transfer/begin')
async def qianniu_transfer_begin(conversation_id: str, body: QianniuTransferBegin,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    result = qn_transfer.begin(db, user, conversation_id, body.target_uid, body.target_nick, body.reason, body.auto_task_id)
    await realtime_manager.broadcast(user.id, {'type': 'conversation.updated',
        'conversation': get_conversation(db, user, conversation_id).model_dump(mode='json')})
    return result


@router.post('/{conversation_id}/qianniu/transfer/finish')
async def qianniu_transfer_finish(conversation_id: str, body: QianniuTransferFinish,
        user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    result = qn_transfer.finish(db, user, conversation_id, body.operation_id, body.outcome, body.evidence, body.error)
    await realtime_manager.broadcast(user.id, {'type': 'conversation.updated',
        'conversation': get_conversation(db, user, conversation_id).model_dump(mode='json')})
    return result


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


@router.post("/{conversation_id}/clear-awaiting-reply", response_model=ConversationDetailResponse)
async def clear_conversation_awaiting_reply(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ConversationDetailResponse:
    conversation = clear_awaiting_reply(db, user, conversation_id)
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


@router.post('/{conversation_id}/orders/refresh')
def refresh_douyin_orders(conversation_id: str, user: User = Depends(get_current_user),
                          db: Session = Depends(get_db_session)) -> dict:
    from app.services.douyin_order_service import queue_refresh
    task = queue_refresh(db, user, conversation_id)
    return {'task_id': task.id}


@router.get("/{conversation_id}/products", response_model=CustomerProductsResponse)
def conversation_products(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> CustomerProductsResponse:
    return customer_products_response(db, user, conversation_id)


def _qianniu_detail_conversation(db, user, conversation_id):
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id or conversation.platform_code != "qianniu":
        raise HTTPException(404, "Qianniu conversation not found")
    return conversation


@router.get("/{conversation_id}/products/{product_id}/detail")
def conversation_product_detail(conversation_id: str, product_id: str,
    user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.qianniu_product_detail_service import saved_detail
    conversation = _qianniu_detail_conversation(db, user, conversation_id)
    return {"product_id": product_id, "platform_account_id": conversation.platform_account_id,
        "snapshot": saved_detail(db, conversation.platform_account, product_id)}


@router.post("/{conversation_id}/products/{product_id}/detail/refresh")
def refresh_conversation_product_detail(conversation_id: str, product_id: str,
    user: User = Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.qianniu_product_detail_service import queue_refresh
    conversation = _qianniu_detail_conversation(db, user, conversation_id)
    task = queue_refresh(db, user, conversation, [product_id])
    return {"task_id": task.id, "status": task.status}
