from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def merge_media_payload(previous: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """Keep completed nodes when a later history read contains only the original link."""
    old = previous.get("structured_payload") or {}
    new = incoming.get("structured_payload") or {}
    if not isinstance(new, dict) or not isinstance(new.get("parts"), list) or len(new["parts"]) > 32:
        raise HTTPException(status_code=400, detail="Invalid Qianniu message parts")
    parts_complete = new.get("parts_complete", False)
    if type(parts_complete) is not bool:
        raise HTTPException(status_code=400, detail="Invalid Qianniu message projection state")
    parts = {} if parts_complete else {
        p["index"]: dict(p)
        for p in old.get("parts", [])
        if isinstance(p, dict) and isinstance(p.get("index"), int)
    }
    for part in new["parts"]:
        if (not isinstance(part, dict) or type(part.get("index")) is not int or not 0 <= part["index"] < 32
                or part.get("kind") not in {"text", "image", "product", "unsupported"}):
            raise HTTPException(status_code=400, detail="Invalid Qianniu message node")
        prior = parts.get(part["index"], {})
        if prior and (prior.get("kind") not in {"unsupported", part["kind"]} or
                      prior.get("product_id") and prior["product_id"] != part.get("product_id")):
            continue
        parts[part["index"]] = {**prior, **{k: v for k, v in part.items() if v is not None and v != ""}}
    ordered = [parts[index] for index in sorted(parts)]
    structured = {**new, "parts": ordered} if parts_complete else {**old, **new, "parts": ordered}
    result = {**previous, **incoming, "structured_payload": structured}
    if incoming.get("message_type") == "system":
        return result
    result["content"] = "\n".join(
        "[图片]" if p["kind"] == "image" else "[商品] " + str(p.get("title") or p.get("product_id") or "")
        if p["kind"] == "product" else str(p.get("text") or "[暂不支持的消息]") for p in ordered
    )
    if len(ordered) == 1:
        first = ordered[0]
        if first["kind"] == "product":
            result["structured_payload"].update({**first, "link_url": first.get("url")})
        elif first["kind"] == "image" and first.get("url"):
            result["image_url"] = first["url"]
    return result
