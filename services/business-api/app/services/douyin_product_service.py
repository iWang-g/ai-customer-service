from __future__ import annotations

import re
from datetime import timezone
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import select

from app.models import StoreProduct
from app.schemas.product import CustomerProductRead, CustomerProductsResponse


def apply_snapshot(db, account, payload, observed_at):
    from app.services.product_service import _datetime, _upsert_store_products

    if (account.platform_code != "douyin" or not account.external_account_id
            or payload.get("shop_id") != account.external_account_id or payload.get("source") != "douyin_products_v1"):
        raise HTTPException(400, "Douyin product account mismatch")
    products, page = payload.get("products"), payload.get("page_summary")
    observed = _datetime(payload.get("observed_at"))
    if (not observed or not isinstance(products, list) or not isinstance(page, dict)
            or type(page.get("page_no")) is not int or page["page_no"] != 0
            or type(page.get("page_size")) is not int or page["page_size"] != 20
            or type(page.get("total_count")) is not int or not 0 <= page["total_count"] <= 1_000_000
            or len(products) != min(page["total_count"], 20)
            or page.get("has_more") is not (page["total_count"] > len(products))
            or payload.get("collection_status") != ("success" if products else "empty")):
        raise HTTPException(400, "Invalid Douyin product first page")
    normalized = []
    ids = []
    for product in products:
        if (not isinstance(product, dict) or not isinstance(product.get("product_id"), str)
                or not re.fullmatch(r"\d{1,40}", product["product_id"])
                or product.get("goods_id") != product["product_id"]):
            raise HTTPException(400, "Invalid Douyin product ID")
        pid = product["product_id"]
        title = product.get("title")
        if title is not None and (not isinstance(title, str) or len(title) > 1000):
            raise HTTPException(400, "Invalid Douyin product title")
        price_label = product.get("price_label")
        if price_label is not None:
            if (not isinstance(price_label, str) or len(price_label) > 64
                    or re.search(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", price_label)):
                raise HTTPException(400, "Invalid Douyin display price")
            price_label = price_label.strip() or None
        image = product.get("image_url")
        if image is not None:
            try:
                if not isinstance(image, str) or len(image) > 4096:
                    raise ValueError()
                parsed = urlsplit(image)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError()
            except ValueError:
                raise HTTPException(400, "Invalid Douyin product image")
        ids.append(pid)
        normalized.append({"product_id": pid, "goods_id": pid, "title": title, "image_url": image,
                           "price_label": price_label, "source": "douyin_product_list", "raw_payload": {}})
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "Duplicate Douyin product ID")
    observed = observed.astimezone(timezone.utc)
    # Even stale snapshots must not leave unvalidated data in the RPA audit.
    payload.clear()
    payload.update({"source": "douyin_products_v1", "shop_id": account.external_account_id,
                    "observed_at": observed.isoformat(), "collection_status": "success" if ids else "empty",
                    "page_summary": {key: page[key] for key in ("page_no", "page_size", "total_count", "has_more")},
                    "products": normalized})
    metadata = dict(account.metadata_json or {})
    previous = metadata.get("store_products") or {}
    previous_time = _datetime(previous.get("observed_at"))
    if previous_time and previous_time >= observed:
        return 0
    saved = _upsert_store_products(db, account, normalized, observed, max_products=20)
    metadata["store_products"] = {
        "collection_status": "success" if ids else "empty", "collection_error": None,
        "observed_at": observed.isoformat(), "product_count": page["total_count"],
        "product_ids": ids, "has_more": page["has_more"], "source": "douyin_products_v1",
    }
    account.metadata_json = metadata
    db.add(account)
    db.flush()
    return saved


def products_response(db, conversation):
    from app.services.product_service import _datetime

    account = conversation.platform_account
    summary = (account.metadata_json or {}).get("store_products", {}) if account else {}
    if summary.get("source") != "douyin_products_v1":
        summary = {}
    ids = summary.get("product_ids", [])
    rows = list(db.scalars(select(StoreProduct).where(
        StoreProduct.user_id == conversation.user_id,
        StoreProduct.platform_account_id == conversation.platform_account_id,
        StoreProduct.goods_id.in_(ids),
    ))) if ids else []
    by_id = {row.goods_id: row for row in rows}
    return CustomerProductsResponse(
        conversation_id=conversation.id, conversation_key=conversation.external_conversation_id,
        customer_name=conversation.customer_name, method="douyin_product_list", customer_key="shop",
        collection_status=summary.get("collection_status", "not_collected"),
        observed_at=_datetime(summary.get("observed_at")), total_count=summary.get("product_count", 0),
        has_more=summary.get("has_more") is True,
        products=[CustomerProductRead.model_validate(by_id[pid]) for pid in ids if pid in by_id],
    )
