from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.models import Conversation, CustomerProduct, PlatformAccount, StoreProduct, User, utcnow
from app.schemas.product import CustomerProductRead, CustomerProductsResponse


COLLECTION_STATUSES = {"success", "empty", "unavailable"}
SHOP_TIMEZONE = timezone(timedelta(hours=8))
logger = logging.getLogger(__name__)


def _datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=SHOP_TIMEZONE)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=SHOP_TIMEZONE)


def _customer_key(conversation: Conversation, payload: dict[str, Any]) -> str:
    explicit = str(payload.get("customer_key") or "").strip()
    if explicit:
        return explicit[:160]
    external = str(conversation.external_conversation_id or "").strip()
    if external:
        return f"conversation:{external}"[:160]
    return f"name:{conversation.customer_name or conversation.id}"[:160]


def _text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(str(value).split()).strip()
    return cleaned[:limit] if cleaned else None


def _float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _upsert_store_products(
    db: Session,
    platform_account: PlatformAccount,
    products: list[Any],
    observed: datetime,
) -> int:
    saved_count = 0
    for item in products[:100]:
        if not isinstance(item, dict):
            continue
        platform_product_id = _text(item.get("product_id") or item.get("platform_product_id"), 128)
        goods_id = _text(item.get("goods_id") or platform_product_id, 128) or ""
        if not platform_product_id or not goods_id:
            continue
        product = db.scalar(select(StoreProduct).where(
            StoreProduct.platform_account_id == platform_account.id,
            StoreProduct.goods_id == goods_id,
        ))
        if product is None:
            product = StoreProduct(
                user_id=platform_account.user_id,
                platform_account_id=platform_account.id,
                goods_id=goods_id,
                platform_product_id=platform_product_id,
                first_observed_at=observed,
                last_observed_at=observed,
            )
        product.goods_id = goods_id
        product.platform_product_id = platform_product_id
        product.title = _text(item.get("title"), 1000)
        product.image_url = _text(item.get("image_url"), 8192)
        product.link_url = _text(item.get("link_url"), 8192)
        product.price = _float(item.get("price"))
        product.price_label = _text(item.get("price_label"), 64)
        product.quantity = _int(item.get("quantity"))
        product.sold_quantity = _int(item.get("sold_quantity"))
        product.sold_quantity_30d = _int(item.get("sold_quantity_30d"))
        product.source = _text(item.get("source"), 64)
        product.last_observed_at = observed
        product.raw_payload = item.get("raw_payload") if isinstance(item.get("raw_payload"), dict) else item
        db.add(product)
        saved_count += 1
    return saved_count


def apply_store_products_snapshot(
    db: Session,
    platform_account: PlatformAccount,
    payload: dict[str, Any],
    observed_at: datetime | None,
) -> int:
    """Persist a shop-level recommendGoods response without creating a customer conversation."""
    collection_status = str(payload.get("collection_status") or "unavailable")
    if collection_status not in COLLECTION_STATUSES:
        collection_status = "unavailable"
    observed = observed_at or _datetime(payload.get("observed_at")) or utcnow()
    products = payload.get("products") if isinstance(payload.get("products"), list) else []
    saved_count = (
        _upsert_store_products(db, platform_account, products, observed)
        if collection_status == "success"
        else 0
    )
    if collection_status == "success" and saved_count == 0:
        collection_status = "unavailable"

    page_summary = payload.get("page_summary") if isinstance(payload.get("page_summary"), dict) else {}
    try:
        total_count = max(saved_count, int(page_summary.get("total_count") or saved_count))
    except (TypeError, ValueError):
        total_count = saved_count
    account_metadata = dict(platform_account.metadata_json or {})
    account_metadata["store_products"] = {
        "collection_status": collection_status,
        "collection_error": str(payload.get("error") or "")[:128] or None,
        "observed_at": observed.isoformat(),
        "product_count": total_count,
        "has_more": page_summary.get("has_more") is True,
    }
    platform_account.metadata_json = account_metadata
    db.add(platform_account)
    db.flush()
    logger.info(
        "store products snapshot applied platform_account_id=%s collection_status=%s "
        "received_product_count=%d saved_product_count=%d has_more=%s error=%s",
        platform_account.id,
        collection_status,
        len(products),
        saved_count,
        page_summary.get("has_more") is True,
        str(payload.get("error") or "")[:128] or None,
    )
    return saved_count


def apply_products_snapshot(
    db: Session,
    conversation: Conversation,
    payload: dict[str, Any],
    observed_at: datetime | None,
) -> None:
    collection_status = str(payload.get("collection_status") or "unavailable")
    if collection_status not in COLLECTION_STATUSES:
        collection_status = "unavailable"
    observed = observed_at or _datetime(payload.get("observed_at")) or utcnow()
    customer_key = _customer_key(conversation, payload)
    products = payload.get("products") if isinstance(payload.get("products"), list) else []
    saved_count = 0
    if collection_status == "success" and conversation.platform_account is not None:
        saved_count = _upsert_store_products(db, conversation.platform_account, products, observed)

    if collection_status == "success" and saved_count == 0:
        collection_status = "unavailable"

    page_summary = payload.get("page_summary") if isinstance(payload.get("page_summary"), dict) else {}
    try:
        total_count = max(saved_count, int(page_summary.get("total_count") or saved_count))
    except (TypeError, ValueError):
        total_count = saved_count
    conversation.metadata_json = {
        **(conversation.metadata_json or {}),
        "customer_products": {
            "collection_status": collection_status,
            "collection_error": str(payload.get("error") or "")[:128] or None,
            "observed_at": observed.isoformat(),
            "customer_key": customer_key,
            "product_count": total_count,
            "has_more": page_summary.get("has_more") is True,
        },
    }
    if conversation.platform_account is not None:
        account_metadata = dict(conversation.platform_account.metadata_json or {})
        account_metadata["store_products"] = {
            "collection_status": collection_status,
            "collection_error": str(payload.get("error") or "")[:128] or None,
            "observed_at": observed.isoformat(),
            "product_count": total_count,
            "has_more": page_summary.get("has_more") is True,
        }
        conversation.platform_account.metadata_json = account_metadata
        db.add(conversation.platform_account)
    db.add(conversation)
    db.flush()
    logger.info(
        "customer products snapshot applied conversation_id=%s platform_account_id=%s "
        "collection_status=%s received_product_count=%d saved_product_count=%d has_more=%s error=%s",
        conversation.id,
        conversation.platform_account_id,
        collection_status,
        len(products),
        saved_count,
        page_summary.get("has_more") is True,
        str(payload.get("error") or "")[:128] or None,
    )


RECOMMENDATION_INTENT_WORDS = (
    "推荐",
    "款式",
    "看看",
    "还有哪些",
    "其他颜色",
    "相近",
    "商品",
    "链接",
)
RECOMMENDATION_EXCLUDE_WORDS = (
    "订单",
    "物流",
    "快递",
    "退款",
    "售后",
    "退货",
    "发货",
)


def _product_tokens(value: str) -> list[str]:
    normalized = " ".join(value.casefold().split())
    tokens = [token for token in normalized.replace("_", " ").split() if token]
    compact = "".join(char for char in normalized if not char.isspace())
    tokens.extend(compact[index:index + 2] for index in range(max(0, len(compact) - 1)))
    tokens.extend(compact[index:index + 3] for index in range(max(0, len(compact) - 2)))
    return list(dict.fromkeys(token for token in tokens if len(token) >= 2))


def match_store_products(
    db: Session,
    conversation: Conversation,
    message: str,
    *,
    limit: int = 2,
) -> list[dict[str, Any]]:
    """Match store-level products for an explicit product recommendation request."""
    if not conversation.platform_account_id or not message.strip():
        return []
    normalized = " ".join(message.casefold().split())
    if any(word in normalized for word in RECOMMENDATION_EXCLUDE_WORDS):
        return []

    products = list(db.scalars(
        select(StoreProduct)
        .where(StoreProduct.platform_account_id == conversation.platform_account_id)
        .order_by(desc(StoreProduct.last_observed_at), StoreProduct.created_at)
        .limit(200)
    ).all())
    if not products:
        return []

    message_tokens = set(_product_tokens(message))
    ranked: list[tuple[int, datetime, StoreProduct]] = []
    for product in products:
        title = str(product.title or "").strip()
        if not title or not product.goods_id or not product.platform_product_id:
            continue
        title_normalized = " ".join(title.casefold().split())
        score = 0
        if title_normalized in normalized or normalized in title_normalized:
            score += 100
        title_tokens = set(_product_tokens(title))
        score += sum(1 for token in message_tokens.intersection(title_tokens) if len(token) >= 2) * 5
        ranked.append((score, product.last_observed_at or product.created_at, product))

    if not ranked:
        return []
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    has_title_match = any(score > 0 for score, _, _ in ranked)
    has_recommendation_intent = any(word in normalized for word in RECOMMENDATION_INTENT_WORDS)
    if not has_title_match and not has_recommendation_intent:
        return []
    candidates = ranked if has_title_match else ranked[:2]
    return [
        {
            "goods_id": product.goods_id,
            "product_id": product.platform_product_id,
            "platform_product_id": product.platform_product_id,
            "title": product.title,
            "image_url": product.image_url,
            "link_url": product.link_url,
            "price": product.price,
            "price_label": product.price_label,
            "raw_payload": product.raw_payload or {},
        }
        for _, _, product in candidates[:max(1, min(limit, 2))]
    ]


def customer_products_response(
    db: Session,
    user: User,
    conversation_id: str,
) -> CustomerProductsResponse:
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    summary = (conversation.metadata_json or {}).get("customer_products")
    if not isinstance(summary, dict):
        summary = {}
    products = list(db.scalars(
        select(StoreProduct)
        .where(StoreProduct.platform_account_id == conversation.platform_account_id)
        .order_by(desc(StoreProduct.last_observed_at), StoreProduct.created_at)
    ).all()) if conversation.platform_account_id else []
    account_metadata = (
        conversation.platform_account.metadata_json
        if conversation.platform_account is not None
        else {}
    )
    store_summary = account_metadata.get("store_products") if isinstance(account_metadata, dict) else None
    if not isinstance(store_summary, dict):
        store_summary = summary
    observed_at = _datetime(store_summary.get("observed_at"))
    collection_status = str(store_summary.get("collection_status") or "not_collected")
    if collection_status not in {*COLLECTION_STATUSES, "not_collected"}:
        collection_status = "not_collected"
    collection_error = str(summary.get("collection_error") or "") or None
    return CustomerProductsResponse(
        conversation_id=conversation.id,
        conversation_key=conversation.external_conversation_id,
        customer_name=conversation.customer_name,
        collection_status=collection_status,
        collection_error=collection_error,
        observed_at=observed_at,
        customer_key="shop",
        total_count=max(int(store_summary.get("product_count") or 0), len(products)),
        has_more=store_summary.get("has_more") is True,
        products=[CustomerProductRead.model_validate(item) for item in products],
        error=collection_error,
    )
