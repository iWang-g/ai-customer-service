from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.models import User


router = APIRouter(prefix="/collector-rules", tags=["collector-rules"])

DEFAULT_PDD_RULES: dict[str, Any] = {
    "version": "2026.08.14.3",
    "platform": "pinduoduo",
    "classification": {
        "system_selectors": [".msg-system", "[class*='System']", "[data-message-type='system']"],
        "context_selectors": ["[class*='BuyerFromCard']", "[class*='UserFrom']"],
        "product_selectors": ["[class*='GoodsCard']", "[class*='goods']", "[class*='product']"],
        "order_selectors": [".order-card", ".kwaishop-cs-BizOrderCard", "[class*='OrderCard']"],
        "ignored_text_patterns": ["^没有更多了$", "^暂无更多(?:消息)?$"],
        "context_text_patterns": ["^当前用户来自.*(?:商品详情页|店铺|直播间|搜索|活动页)"],
        "product_text_patterns": ["(?:商品\\s*ID\\s*[：:]?\\s*\\d{6,}|查看商品规格)"],
        "system_text_patterns": ["(?:撤回了一条消息|邀请下单.*立即使用)$"],
    },
}


def _merge_rules(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = {**base, **override}
    result["classification"] = {
        **base.get("classification", {}),
        **(override.get("classification", {}) if isinstance(override.get("classification"), dict) else {}),
    }
    result["platform"] = "pinduoduo"
    return result


@router.get("/pinduoduo")
def pinduoduo_collector_rules(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    configured = get_settings().pdd_collector_rules_json.strip()
    if not configured:
        return DEFAULT_PDD_RULES
    try:
        override = json.loads(configured)
    except json.JSONDecodeError:
        return DEFAULT_PDD_RULES
    return _merge_rules(DEFAULT_PDD_RULES, override) if isinstance(override, dict) else DEFAULT_PDD_RULES
