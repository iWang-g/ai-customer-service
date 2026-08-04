from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.monitoring import MonitoringEventList, MonitoringLogList, MonitoringOverview
from app.services.monitoring_service import get_overview, list_logs, list_recent_events


router = APIRouter(prefix="/monitoring", tags=["monitoring"])


@router.get("/overview", response_model=MonitoringOverview)
def monitoring_overview(
    model: str | None = Query(default=None, max_length=128),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> MonitoringOverview:
    return get_overview(db, user, model)


@router.get("/logs", response_model=MonitoringLogList)
def monitoring_logs(
    type: str = Query(default="all", pattern="^(all|reply|token)$"),
    limit: int = Query(default=100, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> MonitoringLogList:
    return list_logs(db, user, type, limit)


@router.get("/events", response_model=MonitoringEventList)
def monitoring_events(
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> MonitoringEventList:
    return list_recent_events(db, user, limit)
