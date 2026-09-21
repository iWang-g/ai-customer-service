from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User, RpaTask
from app.services.douyin_automation import task_block_reason
from app.schemas.automation import ReplyRunRequest, ReplyRunResponse, TestReplyRequest
from app.services.automation_service import run_reply, run_test_reply

router = APIRouter(prefix="/automation", tags=["automation"])


@router.get("/douyin-tasks/{task_id}/validate")
def validate_douyin_task(task_id: str, user: User = Depends(get_current_user),
                        db: Session = Depends(get_db_session)) -> dict:
    task = db.get(RpaTask, task_id)
    if not task or task.user_id != user.id:
        raise HTTPException(status_code=404, detail="Task not found")
    if (task.platform_code != "douyin" or task.task_type != "send_message"
        or (task.payload_json or {}).get("source") != "automation"
        or task.status != "confirmation_pending"):
        return {"allowed": False, "reason": "发送任务已失效"}
    reason = task_block_reason(db, task)
    if not reason and task.node_id != task.conversation.platform_account.last_rpa_node_id:
        reason = "店铺已切换到其他节点"
    return {"allowed": reason is None, "reason": reason}


@router.post("/reply", response_model=ReplyRunResponse)
async def run_automation_reply(
    request: ReplyRunRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ReplyRunResponse:
    result = await run_reply(db, user, request)
    return ReplyRunResponse.model_validate(result)


@router.post("/test-reply", response_model=ReplyRunResponse)
async def run_test_automation_reply(
    request: TestReplyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> ReplyRunResponse:
    result = await run_test_reply(db, user, request)
    return ReplyRunResponse.model_validate(result)
