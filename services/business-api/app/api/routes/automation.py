from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.automation import ReplyRunRequest, ReplyRunResponse, TestReplyRequest
from app.services.automation_service import run_reply, run_test_reply

router = APIRouter(prefix="/automation", tags=["automation"])


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
