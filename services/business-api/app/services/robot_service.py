from __future__ import annotations

from typing import Any, Iterable

import httpx
from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import (
    AiModelCatalog,
    PlatformAccount,
    Robot,
    RobotPlatformScope,
    RobotProductKnowledgeBase,
    RobotQaKnowledgeBase,
    RobotToneKnowledgeBase,
    User,
)
from app.schemas.robot import RobotCreate, RobotPlatformScope as RobotPlatformScopeInput, RobotRead, RobotUpdate
from app.core.config import get_settings
from app.core.security import create_token
from datetime import timedelta


def _unique_ids(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value and value.strip()))


def list_robots(db: Session, user: User) -> list[Robot]:
    return list(db.scalars(select(Robot).where(Robot.user_id == user.id).order_by(Robot.updated_at.desc())).all())


def get_robot(db: Session, user: User, robot_id: str) -> Robot:
    robot = db.scalar(select(Robot).where(Robot.id == robot_id, Robot.user_id == user.id))
    if not robot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Robot not found")
    return robot


def _config_relations(config_json: dict[str, Any]) -> tuple[list[str], list[str], str | None, list[RobotPlatformScopeInput]]:
    raw_scopes = config_json.get("platform_scopes") or []
    scopes: list[RobotPlatformScopeInput] = []
    for item in raw_scopes:
        if not isinstance(item, dict) or not item.get("platform_code"):
            continue
        scopes.append(RobotPlatformScopeInput(
            platform_code=str(item["platform_code"]),
            platform_account_id=item.get("platform_account_id"),
            all_accounts=bool(item.get("all_accounts", False)),
        ))
    tone_id = config_json.get("tone_knowledge_base_id") or config_json.get("tone_base_id")
    return (
        _unique_ids(config_json.get("qa_knowledge_base_ids") or config_json.get("qa_base_ids") or []),
        _unique_ids(config_json.get("product_knowledge_base_ids") or config_json.get("product_base_ids") or []),
        str(tone_id) if tone_id else None,
        scopes,
    )


def _relation_values(db: Session, robot: Robot) -> dict[str, Any]:
    qa_ids = [item.knowledge_base_id for item in db.scalars(
        select(RobotQaKnowledgeBase).where(RobotQaKnowledgeBase.robot_id == robot.id).order_by(RobotQaKnowledgeBase.position)
    ).all()]
    product_ids = [item.knowledge_base_id for item in db.scalars(
        select(RobotProductKnowledgeBase).where(RobotProductKnowledgeBase.robot_id == robot.id).order_by(RobotProductKnowledgeBase.position)
    ).all()]
    tone = db.scalar(select(RobotToneKnowledgeBase).where(RobotToneKnowledgeBase.robot_id == robot.id))
    scopes = list(db.scalars(
        select(RobotPlatformScope).where(RobotPlatformScope.robot_id == robot.id).order_by(RobotPlatformScope.platform_code, RobotPlatformScope.created_at)
    ).all())
    return {
        "qa_knowledge_base_ids": qa_ids,
        "product_knowledge_base_ids": product_ids,
        "tone_knowledge_base_id": tone.knowledge_base_id if tone else None,
        "platform_scopes": [
            {
                "platform_code": item.platform_code,
                "platform_account_id": item.platform_account_id,
                "all_accounts": item.all_accounts,
            }
            for item in scopes
        ],
    }


def serialize_robot(db: Session, robot: Robot) -> RobotRead:
    data = {
        "id": robot.id,
        "user_id": robot.user_id,
        "name": robot.name,
        "status": robot.status,
        "enabled": robot.enabled,
        "config_json": robot.config_json,
        "created_at": robot.created_at,
        "updated_at": robot.updated_at,
    }
    data.update(_relation_values(db, robot))
    return RobotRead.model_validate(data)


def _validate_platform_scopes(
    db: Session,
    user: User,
    scopes: list[RobotPlatformScopeInput],
) -> list[RobotPlatformScopeInput]:
    account_ids = {item.platform_account_id for item in scopes if item.platform_account_id and not item.all_accounts}
    if not account_ids:
        return scopes
    accounts = list(db.scalars(
        select(PlatformAccount).where(PlatformAccount.user_id == user.id, PlatformAccount.id.in_(account_ids))
    ).all())
    found = {account.id: account for account in accounts}
    missing = account_ids - found.keys()
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Platform account not found")
    for item in scopes:
        if item.platform_account_id and not item.all_accounts:
            account = found[item.platform_account_id]
            if account.platform_code != item.platform_code:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Platform scope does not match account")
    return scopes


def _knowledge_access_token(user: User) -> str:
    settings = get_settings()
    return create_token(
        settings.jwt_secret_key,
        subject=user.id,
        token_type="access",
        expires_delta=timedelta(minutes=5),
        extra_claims={
            "username": user.username,
            "display_name": getattr(user, "display_name", "") or user.username,
            "role": user.role,
        },
    )


def _knowledge_base(user: User, base_id: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        response = httpx.get(
            f"{settings.knowledge_base_url.rstrip('/')}/api/v1/knowledge-bases/{base_id}",
            headers={"Authorization": f"Bearer {_knowledge_access_token(user)}"},
            timeout=5,
            trust_env=False,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Knowledge base service unavailable",
        ) from exc
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Knowledge base not found: {base_id}")
    try:
        response.raise_for_status()
        value = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Knowledge base service returned an invalid response",
        ) from exc
    return value if isinstance(value, dict) else {}


def _validate_knowledge_bases(user: User, qa_ids: list[str], product_ids: list[str], tone_id: str | None) -> None:
    expected = {
        **{base_id: "qa" for base_id in _unique_ids(qa_ids)},
        **{base_id: "product" for base_id in _unique_ids(product_ids)},
    }
    if tone_id and tone_id.strip():
        expected[tone_id.strip()] = "tone"
    for base_id, expected_kind in expected.items():
        value = _knowledge_base(user, base_id)
        if value.get("kind") != expected_kind:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Knowledge base {base_id} must be of kind {expected_kind}",
            )
        if not value.get("enabled", False):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Knowledge base is disabled: {base_id}",
            )


def _validate_model(db: Session, config: dict[str, Any]) -> None:
    model_id = str(config.get("model") or "").strip()
    if not model_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请选择机器人模型")
    if db.scalar(select(AiModelCatalog.id).limit(1)) is None:
        return
    row = db.scalar(select(AiModelCatalog).where(
        AiModelCatalog.model_id == model_id,
        AiModelCatalog.available.is_(True),
    ))
    if row is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"AI 模型当前不可用：{model_id}")


def replace_robot_relations(
    db: Session,
    user: User,
    robot: Robot,
    *,
    qa_ids: list[str],
    product_ids: list[str],
    tone_id: str | None,
    scopes: list[RobotPlatformScopeInput],
) -> None:
    scopes = _validate_platform_scopes(db, user, scopes)
    _validate_knowledge_bases(user, qa_ids, product_ids, tone_id)
    db.execute(delete(RobotQaKnowledgeBase).where(RobotQaKnowledgeBase.robot_id == robot.id))
    db.execute(delete(RobotProductKnowledgeBase).where(RobotProductKnowledgeBase.robot_id == robot.id))
    db.execute(delete(RobotToneKnowledgeBase).where(RobotToneKnowledgeBase.robot_id == robot.id))
    db.execute(delete(RobotPlatformScope).where(RobotPlatformScope.robot_id == robot.id))
    for position, knowledge_base_id in enumerate(_unique_ids(qa_ids)):
        db.add(RobotQaKnowledgeBase(robot_id=robot.id, knowledge_base_id=knowledge_base_id, position=position))
    for position, knowledge_base_id in enumerate(_unique_ids(product_ids)):
        db.add(RobotProductKnowledgeBase(robot_id=robot.id, knowledge_base_id=knowledge_base_id, position=position))
    if tone_id and tone_id.strip():
        db.add(RobotToneKnowledgeBase(robot_id=robot.id, knowledge_base_id=tone_id.strip()))
    for item in scopes:
        db.add(RobotPlatformScope(
            robot_id=robot.id,
            platform_code=item.platform_code.strip(),
            platform_account_id=None if item.all_accounts else item.platform_account_id,
            all_accounts=item.all_accounts,
        ))
    robot.config_json = {
        **(robot.config_json if isinstance(robot.config_json, dict) else {}),
        "qa_knowledge_base_ids": _unique_ids(qa_ids),
        "product_knowledge_base_ids": _unique_ids(product_ids),
        "tone_knowledge_base_id": tone_id.strip() if tone_id else None,
        "platform_scopes": [item.model_dump() for item in scopes],
    }
    db.add(robot)
    db.commit()


def create_robot(db: Session, user: User, request: RobotCreate) -> Robot:
    config = request.config_json if isinstance(request.config_json, dict) else {}
    _validate_model(db, config)
    qa_ids = request.qa_knowledge_base_ids or _config_relations(config)[0]
    product_ids = request.product_knowledge_base_ids or _config_relations(config)[1]
    tone_id = request.tone_knowledge_base_id or _config_relations(config)[2]
    scopes = request.platform_scopes or _config_relations(config)[3]
    robot = Robot(user_id=user.id, name=request.name.strip(), enabled=request.enabled, status="offline", config_json=config)
    db.add(robot)
    db.flush()
    replace_robot_relations(db, user, robot, qa_ids=qa_ids, product_ids=product_ids, tone_id=tone_id, scopes=scopes)
    db.refresh(robot)
    return robot


def update_robot(db: Session, user: User, robot_id: str, request: RobotUpdate) -> Robot:
    robot = get_robot(db, user, robot_id)
    if request.name is not None:
        robot.name = request.name.strip()
    if request.enabled is not None:
        robot.enabled = request.enabled
    if request.status is not None:
        robot.status = request.status
    if request.config_json is not None:
        _validate_model(db, request.config_json)
        robot.config_json = request.config_json
    relation_fields = {"qa_knowledge_base_ids", "product_knowledge_base_ids", "tone_knowledge_base_id", "platform_scopes"}
    if relation_fields.intersection(request.model_fields_set):
        current = _relation_values(db, robot)
        qa_ids = request.qa_knowledge_base_ids if "qa_knowledge_base_ids" in request.model_fields_set else current["qa_knowledge_base_ids"]
        product_ids = request.product_knowledge_base_ids if "product_knowledge_base_ids" in request.model_fields_set else current["product_knowledge_base_ids"]
        tone_id = request.tone_knowledge_base_id if "tone_knowledge_base_id" in request.model_fields_set else current["tone_knowledge_base_id"]
        scopes = request.platform_scopes if "platform_scopes" in request.model_fields_set else [RobotPlatformScopeInput.model_validate(item) for item in current["platform_scopes"]]
        db.add(robot)
        db.flush()
        replace_robot_relations(db, user, robot, qa_ids=qa_ids or [], product_ids=product_ids or [], tone_id=tone_id, scopes=scopes or [])
    else:
        db.add(robot)
        db.commit()
    db.refresh(robot)
    return robot


def delete_robot(db: Session, user: User, robot_id: str) -> None:
    robot = get_robot(db, user, robot_id)
    db.delete(robot)
    db.commit()
