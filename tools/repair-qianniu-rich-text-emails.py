from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator


EMAIL_PATTERN = re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])")


def iter_objects(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_objects(child)


def history_texts(history_dir: Path) -> dict[str, str]:
    matches: defaultdict[str, set[str]] = defaultdict(set)
    for path in sorted(history_dir.glob("*.json")):
        try:
            root = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        for item in iter_objects(root):
            message_id = item.get("messageId")
            original = item.get("originalData")
            if not isinstance(message_id, str) or not isinstance(original, dict):
                continue
            text = original.get("text")
            nodes = original.get("jsview")
            if not isinstance(text, str) or not EMAIL_PATTERN.search(text) or not isinstance(nodes, list):
                continue
            has_split_text = any(
                isinstance(node, dict)
                and node.get("type") == 0
                and isinstance(node.get("value"), dict)
                and str(node["value"].get("text") or "").endswith("@")
                for node in nodes
            )
            has_link_fragment = any(
                isinstance(node, dict)
                and node.get("type") in {1, 5}
                and isinstance(node.get("value"), dict)
                and isinstance(node["value"].get("url"), str)
                for node in nodes
            )
            if has_split_text and has_link_fragment:
                matches[message_id].add(text)
    return {message_id: next(iter(values)) for message_id, values in matches.items() if len(values) == 1}


def repair_candidates(connection: sqlite3.Connection, source_texts: dict[str, str]) -> list[dict[str, Any]]:
    if not source_texts:
        return []
    placeholders = ",".join("?" for _ in source_texts)
    rows = connection.execute(
        f"""
        SELECT m.id, m.conversation_id, m.platform_message_id, m.content, m.raw_payload,
               c.latest_message_text
        FROM messages AS m
        JOIN conversations AS c ON c.id = m.conversation_id
        WHERE c.platform_code = 'qianniu'
          AND m.platform_message_id IN ({placeholders})
        """,
        tuple(source_texts),
    ).fetchall()
    candidates: list[dict[str, Any]] = []
    for row in rows:
        raw_payload = json.loads(row["raw_payload"])
        structured = raw_payload.get("structured_payload")
        parts = structured.get("parts") if isinstance(structured, dict) else None
        if not isinstance(parts, list) or len(parts) != 2:
            continue
        text_part, unsupported_part = parts
        if not (
            isinstance(text_part, dict)
            and text_part.get("index") == 0
            and text_part.get("kind") == "text"
            and isinstance(text_part.get("text"), str)
            and text_part["text"].endswith("@")
            and isinstance(unsupported_part, dict)
            and unsupported_part.get("index") == 1
            and unsupported_part.get("kind") == "unsupported"
        ):
            continue
        full_text = source_texts[row["platform_message_id"]]
        if not full_text.startswith(text_part["text"]) or full_text == text_part["text"]:
            continue
        candidates.append({
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "platform_message_id": row["platform_message_id"],
            "old_content": row["content"],
            "full_text": full_text,
            "latest_matches_old": row["latest_message_text"] == row["content"],
            "raw_payload": raw_payload,
        })
    return sorted(candidates, key=lambda item: item["platform_message_id"])


def apply_repairs(connection: sqlite3.Connection, candidates: list[dict[str, Any]]) -> None:
    connection.execute("BEGIN IMMEDIATE")
    try:
        for item in candidates:
            raw_payload = dict(item["raw_payload"])
            structured = raw_payload.get("structured_payload")
            structured = dict(structured) if isinstance(structured, dict) else {}
            structured.update({
                "parts_complete": True,
                "parts": [{"index": 0, "kind": "text", "text": item["full_text"]}],
            })
            raw_payload.update({
                "content": item["full_text"],
                "message_type": "text",
                "display_mode": "bubble",
                "structured_payload": structured,
            })
            result = connection.execute(
                "UPDATE messages SET content = ?, raw_payload = ? WHERE id = ? AND content = ?",
                (
                    item["full_text"],
                    json.dumps(raw_payload, ensure_ascii=False, separators=(",", ":")),
                    item["id"],
                    item["old_content"],
                ),
            )
            if result.rowcount != 1:
                raise RuntimeError(f"Message changed during repair: {item['platform_message_id']}")
            if item["latest_matches_old"]:
                connection.execute(
                    "UPDATE conversations SET latest_message_text = ? WHERE id = ? AND latest_message_text = ?",
                    (item["full_text"], item["conversation_id"], item["old_content"]),
                )
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Repair verified Qianniu rich-text email projections.")
    parser.add_argument("--db", type=Path, default=Path("services/business-api/data/business-api.db"))
    parser.add_argument("--history-dir", type=Path, default=Path("qianniu-test"))
    parser.add_argument("--expected-count", type=int, default=4)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    candidates = repair_candidates(connection, history_texts(args.history_dir))
    preview = [{key: value for key, value in item.items() if key != "raw_payload"} for item in candidates]
    print(json.dumps(preview, ensure_ascii=False, indent=2))
    if len(candidates) != args.expected_count:
        raise SystemExit(f"Expected {args.expected_count} verified rows, found {len(candidates)}; no changes made.")
    if not args.apply:
        print("Dry run only. Pass --apply to create a SQLite backup and repair these rows.")
        return

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = args.db.with_name(f"{args.db.name}.before-qn-email-repair-{timestamp}.bak")
    backup = sqlite3.connect(backup_path)
    try:
        connection.backup(backup)
    finally:
        backup.close()
    apply_repairs(connection, candidates)
    print(f"Repaired {len(candidates)} rows. Backup: {backup_path}")


if __name__ == "__main__":
    main()
