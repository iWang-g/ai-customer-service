from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import PlatformAccount, RpaNode, User
from app.schemas.common import PageMeta
from app.schemas.platform_account import (
    PlatformAccountCreate,
    PlatformAccountListResponse,
    PlatformAccountRead,
    PlatformAccountUpdate,
)
from app.schemas.rpa import PlatformAccountSyncItem


def list_platform_accounts(
    db: Session,
    user: User,
    *,
    platform_code: str | None = None,
    include_inactive: bool = False,
) -> PlatformAccountListResponse:
    stmt = select(PlatformAccount).where(PlatformAccount.user_id == user.id)
    if platform_code:
        stmt = stmt.where(PlatformAccount.platform_code == platform_code)
    if not include_inactive:
        stmt = stmt.where(PlatformAccount.is_active.is_(True))
    items = list(db.scalars(stmt.order_by(PlatformAccount.created_at)).all())
    return PlatformAccountListResponse(
        items=[PlatformAccountRead.model_validate(item) for item in items],
        meta=PageMeta(total=len(items), limit=len(items), offset=0),
    )


def get_platform_account(db: Session, user: User, account_id: str) -> PlatformAccount:
    account = db.get(PlatformAccount, account_id)
    if not account or account.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Platform account not found")
    return account


def create_or_sync_platform_account(
    db: Session,
    user: User,
    request: PlatformAccountCreate,
) -> PlatformAccount:
    _validate_node_ownership(db, user, request.last_rpa_node_id)
    account = db.scalar(
        select(PlatformAccount).where(
            and_(
                PlatformAccount.user_id == user.id,
                PlatformAccount.platform_code == request.platform_code,
                PlatformAccount.local_account_id == request.local_account_id,
            )
        )
    )
    if account is None:
        account = PlatformAccount(
            user_id=user.id,
            platform_code=request.platform_code,
            platform_name="拼多多",
            local_account_id=request.local_account_id,
            account_name=request.account_name.strip(),
            account_alias=(request.account_alias or request.account_name).strip(),
            external_account_id=request.external_account_id,
            name_source="workspace",
            is_active=True,
            login_status=request.login_status,
            last_seen_at=utcnow() if request.login_status == "online" else None,
            last_rpa_node_id=request.last_rpa_node_id,
            metadata_json=request.metadata_json,
        )
    else:
        account.account_name = request.account_name.strip()
        account.account_alias = (request.account_alias or request.account_name).strip()
        account.external_account_id = request.external_account_id or account.external_account_id
        account.login_status = request.login_status
        account.last_rpa_node_id = request.last_rpa_node_id or account.last_rpa_node_id
        account.is_active = True
        account.metadata_json = {**account.metadata_json, **request.metadata_json}
        if request.login_status == "online":
            account.last_seen_at = utcnow()
    db.add(account)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该拼多多店铺已绑定到当前账号",
        ) from exc
    db.refresh(account)
    return account


def update_platform_account(
    db: Session,
    user: User,
    account_id: str,
    request: PlatformAccountUpdate,
) -> PlatformAccount:
    account = get_platform_account(db, user, account_id)
    _validate_node_ownership(db, user, request.last_rpa_node_id)
    updates = request.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if field == "metadata_json" and value is not None:
            account.metadata_json = {**account.metadata_json, **value}
        else:
            setattr(account, field, value)
    if request.login_status == "online":
        account.last_seen_at = utcnow()
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def deactivate_platform_account(db: Session, user: User, account_id: str) -> None:
    account = get_platform_account(db, user, account_id)
    account.is_active = False
    account.login_status = "offline"
    db.add(account)
    db.commit()


def sync_platform_accounts_for_node(
    db: Session,
    user: User,
    node: RpaNode,
    items: list[PlatformAccountSyncItem],
) -> list[PlatformAccount]:
    local_ids = {item.local_account_id for item in items}
    existing = db.scalars(
        select(PlatformAccount).where(
            and_(
                PlatformAccount.user_id == user.id,
                PlatformAccount.platform_code == "pinduoduo",
                PlatformAccount.local_account_id.is_not(None),
            )
        )
    ).all()
    for account in existing:
        if account.local_account_id not in local_ids:
            account.is_active = False
            account.login_status = "offline"
            db.add(account)
    db.commit()

    synced: list[PlatformAccount] = []
    for item in items:
        account = create_or_sync_platform_account(
            db,
            user,
            PlatformAccountCreate(
                platform_code="pinduoduo",
                local_account_id=item.local_account_id,
                account_name=item.account_name,
                account_alias=item.account_alias,
                external_account_id=item.external_account_id,
                login_status=item.login_status,
                last_rpa_node_id=node.id,
                metadata_json=item.metadata_json,
            ),
        )
        account.is_active = not item.archived
        if item.archived:
            account.login_status = "offline"
        db.add(account)
        db.commit()
        db.refresh(account)
        synced.append(account)
    return synced


def _validate_node_ownership(db: Session, user: User, node_id: str | None) -> None:
    if not node_id:
        return
    node = db.get(RpaNode, node_id)
    if not node or node.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RPA node not found")
