from __future__ import annotations

import json
import os
import time
from pathlib import Path

from smoke_phase_b import free_port, request_json, start_api, stop_process, wait_for_api


ROOT = Path(__file__).resolve().parents[1]
SMOKE_DIR = ROOT / "agents" / "rpa" / "smoke-data"


def remove_files(prefix: str) -> None:
    for target in SMOKE_DIR.glob(f"{prefix}*.db*"):
        try:
            target.unlink(missing_ok=True)
        except PermissionError:
            pass


def event(
    *,
    event_id: str,
    dedup_key: str,
    event_type: str,
    account_id: str,
    conversation_id: str,
    message_id: str | None = None,
    content: str = "请问有货吗？",
) -> dict:
    return {
        "event_id": event_id,
        "dedup_key": dedup_key,
        "event_type": event_type,
        "platform_code": "pinduoduo",
        "platform_account_id": account_id,
        "platform_message_id": message_id,
        "conversation_external_id": conversation_id,
        "received_at": "2026-07-28T08:00:00Z",
        "payload_json": {
            "customer_name": "同名买家",
            "title": "同名买家",
            "content": content,
            "unread_count": 2,
            "sender_role": "customer",
            "message_type": "text",
        },
    }


def main() -> int:
    run_id = f"{os.getpid()}-{time.time_ns()}"
    prefix = f"phase-c-{run_id}"
    database_path = SMOKE_DIR / f"{prefix}.db"
    remove_files(prefix)
    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    api_base = f"{origin}/api/v1"
    api = start_api(port, database_path)
    try:
        wait_for_api(origin, api)
        auth = request_json(
            api_base,
            "POST",
            "/auth/register",
            {
                "username": f"phase-c-{run_id}"[:64],
                "display_name": "阶段 C 验收用户",
                "password": "phase-c-password",
            },
        )
        token = auth["access_token"]
        registered = request_json(
            api_base,
            "POST",
            "/rpa/nodes/register",
            {
                "node_key": f"phase-c-node-{run_id}",
                "hostname": "phase-c-smoke",
                "supported_platforms": ["pinduoduo"],
                "app_version": "phase-c",
            },
            token=token,
        )
        node_token = registered["node_token"]
        accounts = request_json(
            api_base,
            "POST",
            "/rpa/platform-accounts/sync",
            {
                "accounts": [
                    {
                        "local_account_id": "33333333-3333-4333-8333-333333333333",
                        "account_name": "阶段 C 店铺 A",
                        "account_alias": "拼多多店铺 3",
                        "login_status": "online",
                    },
                    {
                        "local_account_id": "44444444-4444-4444-8444-444444444444",
                        "account_name": "阶段 C 店铺 B",
                        "account_alias": "阶段 C 手工别名 B",
                        "login_status": "online",
                    },
                ]
            },
            token=node_token,
        )
        account_a, account_b = (item["id"] for item in accounts)
        shared_conversation = "shared-buyer-id"
        shared_message = "shared-platform-message-id"
        events = [
            event(
                event_id="phase-c-snapshot-a",
                dedup_key=f"pinduoduo:{account_a}:{shared_conversation}:snapshot:v1",
                event_type="conversation_snapshot",
                account_id=account_a,
                conversation_id=shared_conversation,
            ),
            event(
                event_id="phase-c-message-a",
                dedup_key=f"pinduoduo:{account_a}:{shared_conversation}:message:{shared_message}",
                event_type="message_received",
                account_id=account_a,
                conversation_id=shared_conversation,
                message_id=shared_message,
            ),
            event(
                event_id="phase-c-message-b",
                dedup_key=f"pinduoduo:{account_b}:{shared_conversation}:message:{shared_message}",
                event_type="message_received",
                account_id=account_b,
                conversation_id=shared_conversation,
                message_id=shared_message,
            ),
        ]
        events[1]["payload_json"].update(
            {
                "content": "later-message",
                "platform_sent_at": "2026-07-23T08:17:38Z",
                "observed_at": "2026-07-28T08:00:00Z",
                "snapshot_id": "snapshot-ordering",
                "snapshot_sequence": 1,
                "time_group_index": 0,
                "time_label": "2026-07-23 16:17:38",
                "has_explicit_time": True,
            }
        )
        events[2]["payload_json"].update(
            {
                "platform_sent_at": "2026-07-23T08:17:38Z",
                "observed_at": "2026-07-28T08:00:00Z",
                "snapshot_id": "snapshot-account-b",
                "snapshot_sequence": 0,
                "time_group_index": 0,
                "has_explicit_time": True,
            }
        )
        earlier_message = event(
            event_id="phase-c-message-a-earlier",
            dedup_key=f"pinduoduo:{account_a}:{shared_conversation}:message:v2:earlier",
            event_type="message_received",
            account_id=account_a,
            conversation_id=shared_conversation,
            message_id="account-a-earlier-message",
            content="earlier-message",
        )
        earlier_message["payload_json"].update(
            {
                "platform_sent_at": "2026-07-23T08:17:38Z",
                "observed_at": "2026-07-28T08:00:00Z",
                "snapshot_id": "snapshot-ordering",
                "snapshot_sequence": 0,
                "time_group_index": 0,
                "has_explicit_time": False,
            }
        )
        events.append(earlier_message)
        request_json(api_base, "POST", "/rpa/events/batch", {"events": events}, token=node_token)

        replay = event(
            event_id="phase-c-message-a-replay",
            dedup_key=events[1]["dedup_key"],
            event_type="message_received",
            account_id=account_a,
            conversation_id=shared_conversation,
            message_id=shared_message,
        )
        request_json(api_base, "POST", "/rpa/events", replay, token=node_token)
        same_message_new_event = event(
            event_id="phase-c-message-a-new-event",
            dedup_key=f"phase-c-different-dedup-{run_id}",
            event_type="message_received",
            account_id=account_a,
            conversation_id=shared_conversation,
            message_id=shared_message,
        )
        request_json(api_base, "POST", "/rpa/events", same_message_new_event, token=node_token)

        conversations = request_json(api_base, "GET", "/conversations?limit=100", token=token)
        assert conversations["meta"]["total"] == 2
        assert {item["platform_account_id"] for item in conversations["items"]} == {
            account_a,
            account_b,
        }
        assert {item["platform_name"] for item in conversations["items"]} == {"拼多多"}
        assert {item["shop_name"] for item in conversations["items"]} == {
            "阶段 C 店铺 A",
            "阶段 C 手工别名 B",
        }
        message_totals = []
        for conversation in conversations["items"]:
            messages = request_json(
                api_base,
                "GET",
                f"/conversations/{conversation['id']}/messages?limit=100",
                token=token,
            )
            message_totals.append(messages["meta"]["total"])
            if conversation["platform_account_id"] == account_a:
                assert [item["platform_message_id"] for item in messages["items"]] == [
                    "account-a-earlier-message",
                    shared_message,
                ]
                assert [item["snapshot_sequence"] for item in messages["items"]] == [0, 1]
                assert all(item["platform_sent_at"] for item in messages["items"])
        assert sorted(message_totals) == [1, 2]

        print(
            json.dumps(
                {
                    "status": "passed",
                    "platform_accounts": 2,
                    "isolated_conversations": 2,
                    "messages": sum(message_totals),
                },
                ensure_ascii=False,
            )
        )
        return 0
    finally:
        stop_process(api)
        remove_files(prefix)


if __name__ == "__main__":
    raise SystemExit(main())
