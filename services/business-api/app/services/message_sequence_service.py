from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_TEMPORARY_IMAGE_QUERY_KEYS = {
    "auth_key",
    "expires",
    "signature",
    "sign",
    "token",
    "x-oss-signature",
    "x-oss-expires",
    "x-amz-signature",
    "x-amz-expires",
}
_LOCAL_OUTBOUND_SOURCES = frozenset({
    "desktop",
    "ai",
    "automation_timeout",
    "customer_outreach",
})
_INVISIBLE_TEXT_RE = re.compile(r"[\u200b-\u200d\ufeff]")
_WHITESPACE_RUN_RE = re.compile(r"\s+")


def _value(item: object, key: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(key, default)
    return getattr(item, key, default)


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def normalize_outbound_echo_text(value: Any) -> str:
    """Normalize whitespace that a platform DOM may discard around CJK text."""
    content = unicodedata.normalize("NFKC", str(value or ""))
    content = _INVISIBLE_TEXT_RE.sub("", content).strip()

    def replace_whitespace(match: re.Match[str]) -> str:
        left = content[match.start() - 1] if match.start() else ""
        right = content[match.end()] if match.end() < len(content) else ""
        left_category = unicodedata.category(left) if left else ""
        right_category = unicodedata.category(right) if right else ""
        touches_cjk = any("\u3400" <= char <= "\u9fff" for char in (left, right))
        touches_punctuation = left_category.startswith("P") or right_category.startswith("P")
        is_dom_collapsible_break = "\n" in match.group() or "\r" in match.group()
        return "" if is_dom_collapsible_break and (touches_cjk or touches_punctuation) else " "

    return _WHITESPACE_RUN_RE.sub(replace_whitespace, content)


def normalize_image_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw
    query = sorted([
        (key, item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() not in _TEMPORARY_IMAGE_QUERY_KEYS
    ])
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, urlencode(query), ""))


def message_type(item: object) -> str:
    explicit = str(_value(item, "message_type") or "").strip().lower()
    if explicit:
        return explicit
    raw_payload = _value(item, "raw_payload", {})
    if isinstance(raw_payload, Mapping):
        media_type = str(raw_payload.get("media_type") or "").strip().lower()
        if media_type:
            return media_type
    return "image" if str(_value(item, "content") or "").strip() in {"[图片]", "[image]"} else "text"


def _image_evidence(item: object) -> str:
    raw_payload = _value(item, "raw_payload", {})
    payload = raw_payload if isinstance(raw_payload, Mapping) else {}
    image_sha256 = str(
        _value(item, "image_sha256") or payload.get("image_sha256") or ""
    ).strip().lower()
    if image_sha256:
        return f"sha256:{image_sha256}"
    media_id = str(
        _value(item, "media_resource_id")
        or payload.get("media_resource_id")
        or payload.get("media_id")
        or payload.get("resource_id")
        or ""
    ).strip()
    if media_id:
        return f"media:{media_id}"
    image_url = _value(item, "image_url") or payload.get("image_url")
    normalized_url = normalize_image_url(image_url)
    return f"url:{normalized_url}" if normalized_url else "unknown"


def message_fingerprint(item: object) -> str:
    sender = str(_value(item, "sender_role") or "").strip().lower()
    kind = message_type(item)
    evidence = _image_evidence(item) if kind == "image" else normalize_text(_value(item, "content"))
    return f"{sender}|{kind}|{evidence}"


def longest_tail_overlap(history: Sequence[str], current: Sequence[str]) -> int:
    for size in range(min(len(history), len(current)), 0, -1):
        if list(history[-size:]) == list(current[:size]):
            return size
    return 0


def snapshot_payload_hash(messages: Iterable[object]) -> str:
    normalized = [
        {
            "dom_sequence": int(_value(item, "dom_sequence", index)),
            "sender_role": str(_value(item, "sender_role") or ""),
            "message_type": message_type(item),
            "content": str(_value(item, "content") or ""),
            "image_url": _value(item, "image_url"),
            "image_sha256": _value(item, "image_sha256"),
            "media_resource_id": _value(item, "media_resource_id"),
            "platform_message_id": _value(item, "platform_message_id"),
        }
        for index, item in enumerate(messages)
    ]
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class AlignmentResult:
    status: str
    method: str
    overlap_size: int
    projected_append_count: int
    append_from: int | None
    diagnostics: dict[str, Any]


def _platform_id(item: object) -> str:
    return str(_value(item, "platform_message_id") or "").strip()


def _platform_anchor(
    history: Sequence[object],
    current: Sequence[object],
    history_fingerprints: Sequence[str],
    current_fingerprints: Sequence[str],
) -> tuple[int, int, dict[str, Any]] | None:
    history_ids = [_platform_id(item) for item in history]
    current_ids = [_platform_id(item) for item in current]
    history_counts = Counter(value for value in history_ids if value)
    current_counts = Counter(value for value in current_ids if value)
    candidates: list[tuple[int, int, int, dict[str, Any]]] = []

    for current_index, platform_id in enumerate(current_ids):
        if not platform_id or history_counts[platform_id] != 1 or current_counts[platform_id] != 1:
            continue
        history_index = history_ids.index(platform_id)
        offset = history_index - current_index
        mapped_start = max(0, -offset)
        mapped_end = min(len(current), len(history) - offset)
        if mapped_end <= mapped_start or mapped_end + offset != len(history):
            continue

        matching_context = 0
        contradictory_context = 0
        # Only the anchored suffix must agree; the visible prefix may be a
        # disconnected virtual-list window and is not used as queue evidence.
        for candidate_index in range(current_index, mapped_end):
            historical_index = candidate_index + offset
            same_fingerprint = (
                current_fingerprints[candidate_index] == history_fingerprints[historical_index]
            )
            outbound_echo_match = _compatible_outbound_echo_pair(
                history[historical_index],
                current[candidate_index],
            )
            same_unique_id = bool(
                current_ids[candidate_index]
                and current_ids[candidate_index] == history_ids[historical_index]
                and history_counts[current_ids[candidate_index]] == 1
                and current_counts[current_ids[candidate_index]] == 1
            )
            if same_fingerprint or outbound_echo_match:
                matching_context += 1
            elif not same_unique_id:
                contradictory_context += 1
        if matching_context < 2 or contradictory_context:
            continue
        overlap = mapped_end - current_index
        diagnostics = {
            "anchor_platform_message_id": platform_id,
            "anchor_history_index": history_index,
            "anchor_current_index": current_index,
            "matching_context": matching_context,
        }
        candidates.append((overlap, mapped_end, current_index, diagnostics))

    if not candidates:
        return None
    overlap, append_from, _current_index, diagnostics = max(candidates)
    return overlap, append_from, diagnostics


def _compatible_outbound_echo_pair(history_item: object, current_item: object) -> bool:
    if str(_value(history_item, "sender_role") or "").strip().lower() != "agent":
        return False
    if str(_value(current_item, "sender_role") or "").strip().lower() != "agent":
        return False
    if str(_value(history_item, "source") or "").strip() not in _LOCAL_OUTBOUND_SOURCES:
        return False
    history_type = message_type(history_item)
    if history_type != message_type(current_item):
        return False
    if history_type == "image":
        # Pinduoduo uploads local reply images to its CDN, so the DOM URL cannot
        # identify the original local asset. The anchored position supplies the
        # identity; this exception remains limited to unbound local outbound images.
        return not _platform_id(history_item)
    if history_type != "text":
        return False
    return normalize_outbound_echo_text(
        _value(history_item, "content")
    ) == normalize_outbound_echo_text(_value(current_item, "content"))


def align_message_sequences(
    history: Sequence[object],
    current: Sequence[object],
) -> AlignmentResult:
    if not history:
        return AlignmentResult(
            status="bootstrap",
            method="empty_history",
            overlap_size=0,
            projected_append_count=len(current),
            append_from=0,
            diagnostics={},
        )
    if not current:
        return AlignmentResult(
            status="duplicate",
            method="empty_snapshot",
            overlap_size=0,
            projected_append_count=0,
            append_from=None,
            diagnostics={},
        )

    history_fingerprints = [message_fingerprint(item) for item in history]
    current_fingerprints = [message_fingerprint(item) for item in current]
    overlap = longest_tail_overlap(history_fingerprints, current_fingerprints)
    if overlap:
        projected = len(current) - overlap
        return AlignmentResult(
            status="aligned" if projected else "duplicate",
            method="content_overlap",
            overlap_size=overlap,
            projected_append_count=projected,
            append_from=overlap if projected else None,
            diagnostics={},
        )

    anchor = _platform_anchor(history, current, history_fingerprints, current_fingerprints)
    if anchor:
        overlap, append_from, diagnostics = anchor
        projected = len(current) - append_from
        return AlignmentResult(
            status="aligned" if projected else "duplicate",
            method="platform_id_anchor",
            overlap_size=overlap,
            projected_append_count=projected,
            append_from=append_from if projected else None,
            diagnostics=diagnostics,
        )

    return AlignmentResult(
        status="unaligned",
        method="none",
        overlap_size=0,
        projected_append_count=0,
        append_from=None,
        diagnostics={
            "history_tail_fingerprints": history_fingerprints[-5:],
            "current_head_fingerprints": current_fingerprints[:5],
        },
    )
