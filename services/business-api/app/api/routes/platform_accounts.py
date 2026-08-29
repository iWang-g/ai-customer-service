from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.platform_account import (
    PlatformAccountCreate,
    PlatformAccountListResponse,
    PlatformAccountRead,
    PlatformAccountUpdate,
    ShopSummaryUpdate,
)
from app.services.platform_account_service import (
    create_or_sync_platform_account,
    deactivate_platform_account,
    get_platform_account,
    list_platform_accounts,
    update_platform_account,
    generate_shop_summary,
    update_shop_summary,
)

router = APIRouter(prefix="/platform-accounts", tags=["platform-accounts"])


@router.get("", response_model=PlatformAccountListResponse)
def list_accounts(
    platform_code: str | None = Query(default=None),
    include_inactive: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformAccountListResponse:
    return list_platform_accounts(
        db, user, platform_code=platform_code, include_inactive=include_inactive
    )


@router.post("", response_model=PlatformAccountRead, status_code=status.HTTP_201_CREATED)
def create_account(
    request: PlatformAccountCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformAccountRead:
    return PlatformAccountRead.model_validate(create_or_sync_platform_account(db, user, request))


@router.get("/{account_id}", response_model=PlatformAccountRead)
def get_account(
    account_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformAccountRead:
    return PlatformAccountRead.model_validate(get_platform_account(db, user, account_id))


@router.patch("/{account_id}", response_model=PlatformAccountRead)
def patch_account(
    account_id: str,
    request: PlatformAccountUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformAccountRead:
    return PlatformAccountRead.model_validate(update_platform_account(db, user, account_id, request))


@router.post("/{account_id}/shop-summary/generate", response_model=PlatformAccountRead)
async def generate_account_shop_summary(
    account_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformAccountRead:
    return PlatformAccountRead.model_validate(await generate_shop_summary(db, user, account_id))


@router.patch("/{account_id}/shop-summary", response_model=PlatformAccountRead)
def patch_account_shop_summary(
    account_id: str,
    request: ShopSummaryUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> PlatformAccountRead:
    return PlatformAccountRead.model_validate(
        update_shop_summary(db, user, account_id, request)
    )


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    account_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> Response:
    deactivate_platform_account(db, user, account_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
