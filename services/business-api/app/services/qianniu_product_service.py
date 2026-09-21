from __future__ import annotations

import re
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import select

from app.models import StoreProduct
from app.schemas.product import CustomerProductRead, CustomerProductsResponse


def apply_snapshot(db, account, payload, observed_at):
    from app.services.product_service import _datetime, _upsert_store_products

    uid = str((account.metadata_json or {}).get("shop_uid") or "")
    local_uid = str(account.local_account_id or "").removeprefix("qianniu-")
    uid = uid or local_uid
    if (account.platform_code != "qianniu" or not uid.isdigit() or payload.get("shop_uid") != uid
            or (local_uid.isdigit() and local_uid != uid) or payload.get("source") != "qianniu_products_v1"):
        raise HTTPException(400, "Qianniu product account mismatch")
    products = payload.get("products")
    page = payload.get("page_summary") or {}
    observed = _datetime(payload.get("observed_at"))
    if (not observed or not isinstance(products, list) or len(products) > 5000 or not isinstance(page, dict) or
            page.get("has_more") is not False or type(page.get("total_count")) is not int or
            page["total_count"] != len(products) or payload.get("collection_status") != ("success" if products else "empty")):
        raise HTTPException(400, "Incomplete Qianniu product snapshot")
    observed = observed.astimezone(timezone.utc)
    ids = []
    for product in products:
        if (not isinstance(product, dict) or not isinstance(product.get("product_id"), str) or
                not re.fullmatch(r"\d{1,30}", product["product_id"]) or
                product.get("goods_id") != product["product_id"] or not isinstance(product.get("title"), str) or
                not product["title"].strip()):
            raise HTTPException(400, "Invalid Qianniu product")
        ids.append(product["product_id"])
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Duplicate Qianniu product")
    metadata = dict(account.metadata_json or {})
    previous = metadata.get("store_products") or {}
    previous_time = _datetime(previous.get("observed_at"))
    if previous_time and previous_time >= observed:
        return 0
    count = _upsert_store_products(db, account, products, observed, max_products=5000)
    metadata["store_products"] = {
        "collection_status": "success" if products else "empty", "collection_error": None,
        "observed_at": observed.isoformat(), "product_count": count, "has_more": False,
        "product_ids": ids, "source": "qianniu_products_v1",
    }
    account.metadata_json = metadata
    db.add(account)
    db.flush()
    return count


def products_response(db, conversation):
    from app.services.product_service import _datetime

    account = conversation.platform_account
    summary = (account.metadata_json or {}).get("store_products", {}) if account else {}
    ids = summary.get("product_ids", [])
    rows = list(db.scalars(select(StoreProduct).where(
        StoreProduct.user_id == conversation.user_id,
        StoreProduct.platform_account_id == conversation.platform_account_id,
        StoreProduct.goods_id.in_(ids),
    ))) if ids else []
    by_id = {row.goods_id: row for row in rows}
    products = []
    for pid in ids:
        if pid not in by_id:
            continue
        product = CustomerProductRead.model_validate(by_id[pid])
        # Detailed SKU sets are read on demand, not with every sidebar list load.
        product.raw_payload = {key: value for key, value in product.raw_payload.items() if key != 'qianniu_detail'}
        products.append(product)
    return CustomerProductsResponse(
        conversation_id=conversation.id, conversation_key=conversation.external_conversation_id,
        customer_name=conversation.customer_name, method="qianniu_onsale", customer_key="shop",
        collection_status=summary.get("collection_status", "not_collected"),
        observed_at=_datetime(summary.get("observed_at")), total_count=len(ids), has_more=False,
        products=products,
    )
