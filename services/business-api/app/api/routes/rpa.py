from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_rpa_node, get_current_user, get_db_session, get_settings_dep
from app.core.config import Settings
from app.models import Message, MessageObservation, RpaNode, RpaTask, User
from app.schemas.rpa import (
    MessageObservationRead,
    NodeHeartbeatRequest,
    NodeRegisterRequest,
    NodeRegisterResponse,
    PlatformAccountSyncRequest,
    RpaEventBatchCreate,
    RpaEventCreate,
    RpaEventRead,
    RpaNodeRead,
    RpaTaskRead,
    TaskAckResponse,
    TaskCompleteRequest,
)
from app.schemas.platform_account import PlatformAccountRead
from app.services.rpa_service import (
    acknowledge_task,
    complete_task,
    create_event,
    create_events_batch,
    disconnect_node,
    get_or_create_desktop_ingest_node,
    get_pending_tasks,
    heartbeat_node,
    maybe_queue_entry_welcome,
    register_node,
    select_inbound_reply_source,
)
from app.services.platform_account_service import sync_platform_accounts_for_node
from app.services.realtime import realtime_manager
from app.services.automation_service import inbound_reply_debounce_seconds, schedule_debounced_inbound_reply
from app.services.settings_service import auto_reply_enabled
from app.services.qianniu_transfer_notice import is_transfer_reply_source
from app.services.qianniu_send_guard import check_qianniu_send_guard

router = APIRouter(prefix="/rpa", tags=["rpa"])


def _schedule_inbound_reply(
    db: Session,
    user: User,
    request: RpaEventCreate,
    source_message: Message,
    source_event_id: str,
) -> None:
    if request.event_type not in {"customer_message", "message_received", "message_snapshot"}:
        return
    if source_message.sender_role != "customer" and not is_transfer_reply_source(source_message):
        return
    maybe_queue_entry_welcome(db, user, source_message)
    if not auto_reply_enabled(db, user):
        return
    schedule_debounced_inbound_reply(
        user.id,
        source_message.conversation_id,
        source_message.id,
        source_event_id,
        delay_seconds=inbound_reply_debounce_seconds(source_message),
    )


@router.get("/nodes", response_model=list[RpaNodeRead])
def list_nodes(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> list[RpaNodeRead]:
    from sqlalchemy import select

    nodes = db.scalars(select(RpaNode).where(RpaNode.user_id == user.id)).all()
    return [RpaNodeRead.model_validate(node) for node in nodes]


@router.post("/nodes/register", response_model=NodeRegisterResponse)
def register(
    request: NodeRegisterRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings_dep),
) -> NodeRegisterResponse:
    return register_node(db, settings, user, request)


@router.post("/nodes/heartbeat")
def heartbeat(
    request: NodeHeartbeatRequest,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> dict[str, str]:
    heartbeat_node(db, node, request)
    return {"status": "ok"}


@router.post("/nodes/disconnect")
def disconnect(node=Depends(get_current_rpa_node), db: Session = Depends(get_db_session)) -> dict[str, str]:
    disconnect_node(db, node)
    return {"status": "ok"}


@router.post("/platform-accounts/sync", response_model=list[PlatformAccountRead])
async def sync_platform_accounts(
    request: PlatformAccountSyncRequest,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> list[PlatformAccountRead]:
    user = db.get(User, node.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    accounts = sync_platform_accounts_for_node(
        db, user, node, request.accounts, platform_code=request.platform_code
    )
    response = [PlatformAccountRead.model_validate(account) for account in accounts]
    await realtime_manager.broadcast(
        user.id,
        {
            "type": "rpa.platform_accounts.synced",
            "accounts": [item.model_dump(mode="json") for item in response],
        },
    )
    return response


@router.post("/events", response_model=RpaEventRead)
async def ingest_event(
    request: RpaEventCreate,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> RpaEventRead:
    user = db.get(User, node.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    event, messages, _ = create_event(db, user, node, request)
    source_message = select_inbound_reply_source(db, request, messages)
    if source_message is not None:
        _schedule_inbound_reply(db, user, request, source_message, event.id)
    await realtime_manager.broadcast(
        user.id,
        {"type": "rpa.event", "event": RpaEventRead.model_validate(event).model_dump(mode="json")},
    )
    return RpaEventRead.model_validate(event)


@router.post("/events/batch", response_model=list[RpaEventRead])
async def ingest_batch(
    request: RpaEventBatchCreate,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> list[RpaEventRead]:
    user = db.get(User, node.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    events, reply_sources, affected_conversations = create_events_batch(db, user, node, request.events)
    for item, source_message, source_event_id in reply_sources:
        _schedule_inbound_reply(db, user, item, source_message, source_event_id)
    await realtime_manager.broadcast(
        user.id,
        {
            "type": "rpa.events.batch",
            "events": [item.model_dump(mode="json") for item in events],
            "affected_conversations": affected_conversations,
            "appended_message_count": sum(
                item.get("appended_message_count", 0) for item in affected_conversations
            ),
        },
    )
    return events


@router.post("/events/desktop-batch", response_model=list[RpaEventRead])
async def ingest_desktop_batch(
    request: RpaEventBatchCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> list[RpaEventRead]:
    node = get_or_create_desktop_ingest_node(db, user)
    events, reply_sources, affected_conversations = create_events_batch(db, user, node, request.events)
    for item, source_message, source_event_id in reply_sources:
        _schedule_inbound_reply(db, user, item, source_message, source_event_id)
    await realtime_manager.broadcast(
        user.id,
        {
            "type": "rpa.events.batch",
            "events": [item.model_dump(mode="json") for item in events],
            "affected_conversations": affected_conversations,
            "appended_message_count": sum(
                item.get("appended_message_count", 0) for item in affected_conversations
            ),
        },
    )
    return events


@router.get("/message-observations", response_model=list[MessageObservationRead])
def list_message_observations(
    platform_account_id: str | None = Query(default=None),
    conversation_external_id: str | None = Query(default=None),
    alignment_status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> list[MessageObservationRead]:
    from sqlalchemy import desc, select

    statement = select(MessageObservation).where(MessageObservation.user_id == user.id)
    if platform_account_id:
        statement = statement.where(
            MessageObservation.platform_account_id == platform_account_id
        )
    if conversation_external_id:
        statement = statement.where(
            MessageObservation.conversation_external_id == conversation_external_id
        )
    if alignment_status:
        statement = statement.where(MessageObservation.alignment_status == alignment_status)
    observations = db.scalars(
        statement.order_by(desc(MessageObservation.collected_at)).limit(limit)
    ).all()
    return [MessageObservationRead.model_validate(item) for item in observations]


@router.get("/tasks/pending", response_model=list[RpaTaskRead])
def pending_tasks(
    limit: int = Query(default=50, ge=1, le=200),
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> list[RpaTaskRead]:
    return [RpaTaskRead.model_validate(task) for task in get_pending_tasks(db, node, limit=limit)]


@router.post("/tasks/{task_id}/ack", response_model=TaskAckResponse)
async def ack_task(
    task_id: str,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> TaskAckResponse:
    task = db.get(RpaTask, task_id)
    if not task or task.user_id != node.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if task.node_id and task.node_id != node.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Task belongs to another node")
    if task.node_id is None:
        task.node_id = node.id
    updated = RpaTaskRead.model_validate(acknowledge_task(db, task))
    await realtime_manager.broadcast(
        node.user_id,
        {"type": "rpa.task.acknowledged", "task": updated.model_dump(mode="json")},
    )
    return TaskAckResponse(task=updated)


@router.get("/tasks/{task_id}/qianniu-send-guard")
def qianniu_task_send_guard(
    task_id: str,
    platform_account_id: str,
    cid: str,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> dict[str, bool]:
    task = db.get(RpaTask, task_id)
    if not task or task.user_id != node.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if task.node_id != node.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Task belongs to another node")
    user = db.get(User, node.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return check_qianniu_send_guard(db, user, platform_account_id, cid, task_id)


@router.post('/tasks/{task_id}/pdd-execution-guard')
def pdd_execution_guard(task_id: str, user=Depends(get_current_user), db: Session = Depends(get_db_session)):
    from app.services.pdd_auto_transfer import validate
    return validate(db, user, db.get(RpaTask, task_id))


@router.post("/tasks/{task_id}/complete", response_model=TaskAckResponse)
async def complete_task_route(
    task_id: str,
    request: TaskCompleteRequest,
    node=Depends(get_current_rpa_node),
    db: Session = Depends(get_db_session),
) -> TaskAckResponse:
    task = db.get(RpaTask, task_id)
    if not task or task.user_id != node.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if task.node_id and task.node_id != node.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Task belongs to another node")
    if task.node_id is None:
        task.node_id = node.id
    updated = RpaTaskRead.model_validate(complete_task(db, task, request))
    await realtime_manager.broadcast(
        node.user_id,
        {"type": "rpa.task.completed", "task": updated.model_dump(mode="json")},
    )
    if ((task.platform_code == 'douyin' and (task.payload_json or {}).get('douyin_auto_operation_id'))
            or (task.platform_code == 'qianniu' and (task.payload_json or {}).get('qianniu_auto_operation_id'))
            or (task.platform_code == 'pinduoduo' and (task.payload_json or {}).get('pdd_auto_operation_id'))):
        from app.services.message_service import get_conversation
        await realtime_manager.broadcast(node.user_id, {'type': 'conversation.updated',
            'conversation': get_conversation(db, db.get(User, node.user_id), task.conversation_id).model_dump(mode='json')})
    return TaskAckResponse(task=updated)
