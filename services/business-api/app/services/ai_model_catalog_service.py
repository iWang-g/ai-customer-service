from __future__ import annotations

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.models import AiModelCatalog, AiProviderConfig, Robot


SUPPORTED_AI_MODELS = ("deepseek-v4-flash", "deepseek-v4-pro")
SUPPORTED_AI_MODEL_SET = frozenset(SUPPORTED_AI_MODELS)
DEFAULT_AI_MODEL = SUPPORTED_AI_MODELS[0]


def remove_unsupported_models(db: Session) -> None:
    db.execute(delete(AiModelCatalog).where(AiModelCatalog.model_id.not_in(SUPPORTED_AI_MODEL_SET)))
    db.execute(update(AiProviderConfig).where(
        AiProviderConfig.model == "deepseek-chat"
    ).values(model=DEFAULT_AI_MODEL))
    for robot in db.scalars(select(Robot).where(Robot.config_json["model"].as_string() == "deepseek-chat")):
        robot.config_json = {**robot.config_json, "model": DEFAULT_AI_MODEL}
    db.flush()


def supported_model_ids(values: object) -> list[str]:
    if not isinstance(values, list):
        return []
    returned = {
        str(item.get("id") or "").strip()
        for item in values
        if isinstance(item, dict)
    }
    return [model_id for model_id in SUPPORTED_AI_MODELS if model_id in returned]
