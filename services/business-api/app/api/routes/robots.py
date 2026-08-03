import httpx
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.core.config import get_settings
from app.models import Robot, RobotProductKnowledgeBase, RobotQaKnowledgeBase, RobotToneKnowledgeBase, User
from app.schemas.robot import RobotCreate, RobotRead, RobotUpdate
from app.services.robot_service import create_robot, delete_robot, get_robot, list_robots, serialize_robot, update_robot

router = APIRouter(prefix="/robots", tags=["robots"])


@router.get("/knowledge-base-usage/{knowledge_base_id}")
def knowledge_base_usage(
    knowledge_base_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> dict:
    robot_ids = set()
    for relation in (RobotQaKnowledgeBase, RobotProductKnowledgeBase, RobotToneKnowledgeBase):
        robot_ids.update(
            row[0] for row in db.query(relation.robot_id).filter(
                relation.knowledge_base_id == knowledge_base_id
            ).all()
        )
    robots = list(
        db.query(Robot)
        .filter(Robot.user_id == user.id, Robot.id.in_(robot_ids))
        .order_by(Robot.name)
        .all()
    ) if robot_ids else []
    return {
        "knowledge_base_id": knowledge_base_id,
        "in_use": bool(robots),
        "robots": [{"id": robot.id, "name": robot.name} for robot in robots],
    }


@router.delete("/knowledge-bases/{knowledge_base_id}")
def delete_unused_knowledge_base(
    knowledge_base_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> dict:
    usage = knowledge_base_usage(knowledge_base_id, user, db)
    if usage["in_use"]:
        names = "、".join(robot["name"] for robot in usage["robots"])
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"该知识库正被机器人“{names}”使用，请先解除绑定",
        )
    settings = get_settings()
    try:
        response = httpx.delete(
            f"{settings.knowledge_base_url.rstrip('/')}/api/v1/knowledge-bases/{knowledge_base_id}",
            timeout=5,
            trust_env=False,
        )
        response.raise_for_status()
        value = response.json()
    except httpx.HTTPStatusError as exc:
        detail = "Knowledge base deletion failed"
        try:
            detail = str(exc.response.json().get("detail") or detail)
        except (ValueError, AttributeError):
            pass
        raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Knowledge base service unavailable",
        ) from exc
    return value if isinstance(value, dict) else {"id": knowledge_base_id}


@router.get("", response_model=list[RobotRead])
def list_robot_configs(user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> list[RobotRead]:
    return [serialize_robot(db, robot) for robot in list_robots(db, user)]


@router.post("", response_model=RobotRead, status_code=status.HTTP_201_CREATED)
def add_robot(request: RobotCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> RobotRead:
    return serialize_robot(db, create_robot(db, user, request))


@router.get("/{robot_id}", response_model=RobotRead)
def read_robot(robot_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> RobotRead:
    return serialize_robot(db, get_robot(db, user, robot_id))


@router.patch("/{robot_id}", response_model=RobotRead)
def patch_robot(robot_id: str, request: RobotUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> RobotRead:
    return serialize_robot(db, update_robot(db, user, robot_id, request))


@router.delete("/{robot_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_robot(robot_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db_session)) -> Response:
    delete_robot(db, user, robot_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
