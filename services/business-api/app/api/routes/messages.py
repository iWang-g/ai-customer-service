from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.message import (
    PlatformMessageExistsResponse,
    RecordSentMessageRequest,
    RecordSentMessageResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from app.services.realtime import realtime_manager
from app.services.message_service import create_send_task, platform_message_exists, record_sent_message

router = APIRouter(prefix="/messages", tags=["messages"])


@router.get("/platform-exists", response_model=PlatformMessageExistsResponse)
def message_platform_exists(
    platform_account_id: str,
    conversation_external_id: str,
    platform_message_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformMessageExistsResponse:
    return platform_message_exists(
        db,
        user,
        platform_account_id=platform_account_id,
        conversation_external_id=conversation_external_id,
        platform_message_id=platform_message_id,
    )


@router.post("/send", response_model=SendMessageResponse)
async def send_message(
    request: SendMessageRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> SendMessageResponse:
    response = create_send_task(db, user, request)
    await realtime_manager.broadcast(
        user.id,
        {"type": "message.queued", "message": response.message.model_dump(mode="json"), "task_id": response.task_id},
    )
    return response


@router.post("/record-sent", response_model=RecordSentMessageResponse)
async def record_sent(
    request: RecordSentMessageRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> RecordSentMessageResponse:
    response = record_sent_message(db, user, request)
    await realtime_manager.broadcast(
        user.id,
        {"type": "message.sent", "message": response.message.model_dump(mode="json")},
    )
    return response
