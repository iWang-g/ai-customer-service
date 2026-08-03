from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db_session
from app.models import User
from app.schemas.analytics import DashboardAnalytics
from app.services.analytics_service import get_dashboard_analytics

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/dashboard", response_model=DashboardAnalytics)
def dashboard(
    start_date: date = Query(...),
    end_date: date = Query(...),
    timezone: str = Query(default="Asia/Shanghai", max_length=64),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> DashboardAnalytics:
    return get_dashboard_analytics(db, user, start_date, end_date, timezone)
