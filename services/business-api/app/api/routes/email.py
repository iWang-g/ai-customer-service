from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.email import (
    EmailConfigRead,
    EmailConfigUpdate,
    EmailTemplateCreate,
    EmailTemplateRead,
    EmailTemplateUpdate,
    EmailTestRequest,
    EmailTestResponse,
)
from app.services.email_service import (
    create_template,
    delete_template,
    get_config,
    list_templates,
    save_config,
    test_send,
    update_template,
)


router = APIRouter(prefix="/email", tags=["email"])


@router.get("/config", response_model=EmailConfigRead)
def read_email_config(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> EmailConfigRead:
    return get_config(db, user)


@router.put("/config", response_model=EmailConfigRead)
def write_email_config(
    request: EmailConfigUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> EmailConfigRead:
    return save_config(db, user, request)


@router.post("/test", response_model=EmailTestResponse)
def test_email_config(
    request: EmailTestRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> EmailTestResponse:
    return test_send(db, user, request.to_email, request.template_id)


@router.get("/templates", response_model=list[EmailTemplateRead])
def read_email_templates(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> list[EmailTemplateRead]:
    return list_templates(db, user)


@router.post("/templates", response_model=EmailTemplateRead, status_code=status.HTTP_201_CREATED)
def add_email_template(
    request: EmailTemplateCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> EmailTemplateRead:
    return create_template(db, user, request)


@router.patch("/templates/{template_id}", response_model=EmailTemplateRead)
def edit_email_template(
    template_id: str,
    request: EmailTemplateUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> EmailTemplateRead:
    return update_template(db, user, template_id, request)


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_email_template(
    template_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> Response:
    delete_template(db, user, template_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
