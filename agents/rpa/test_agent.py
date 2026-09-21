from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from agent import EventQueue, RpaAgent


class EventQueueTests(unittest.TestCase):
    @staticmethod
    def queue() -> EventQueue:
        directory = Path(__file__).parents[2] / ".tmp" / "rpa-queue-tests"
        directory.mkdir(parents=True, exist_ok=True)
        return EventQueue(str(directory), f"{uuid4().hex}.db")

    def test_snapshot_is_replayed_until_server_acknowledges_it(self) -> None:
        queue = self.queue()
        database_path = queue.connection.execute("PRAGMA database_list").fetchone()[2]
        event = {
            "event_id": "snapshot-batch-1",
            "event_type": "message_snapshot",
            "payload_json": {"observation_id": "observation-1", "batch_index": 0},
        }
        queue.enqueue(event)
        queue.mark_failed([event["event_id"]], "offline")
        queue.connection.close()

        reopened = EventQueue(str(Path(database_path).parent), Path(database_path).name)
        self.assertEqual(reopened.pending(), [event])
        reopened.mark_synced([event["event_id"]])
        self.assertEqual(reopened.pending(), [])
        reopened.connection.close()

    def test_same_event_id_cannot_silently_replace_snapshot_payload(self) -> None:
        queue = self.queue()
        queue.enqueue({"event_id": "same", "payload_json": {"batch_index": 0}})
        queue.enqueue({"event_id": "same", "payload_json": {"batch_index": 0}})
        with self.assertRaisesRegex(ValueError, "different payload"):
            queue.enqueue({"event_id": "same", "payload_json": {"batch_index": 1}})
        queue.connection.close()

    def test_delete_conversation_events_removes_only_target_conversation(self) -> None:
        queue = self.queue()
        target = {
            "event_id": "target",
            "platform_account_id": "shop-1",
            "conversation_external_id": "customer-1",
        }
        other = {
            "event_id": "other",
            "platform_account_id": "shop-1",
            "conversation_external_id": "customer-2",
        }
        queue.enqueue(target)
        queue.enqueue(other)

        deleted = queue.delete_conversation_events("shop-1", "customer-1")

        self.assertEqual(deleted, 1)
        self.assertEqual(queue.pending(), [other])
        queue.connection.close()


class AccountSyncTests(unittest.TestCase):
    def test_accounts_are_synced_in_platform_isolated_batches(self) -> None:
        agent = RpaAgent()
        agent.accounts = [
            {
                "id": "pdd-local",
                "platform_code": "pinduoduo",
                "alias": "PDD Shop",
                "external_account_id": "pdd-1",
                "login_status": "online",
            },
            {
                "id": "wechat-local",
                "platform_code": "wechat",
                "alias": "WeChat Name",
                "external_account_id": "wechat:hash",
                "login_status": "online",
                "metadata_json": {"wechat_id": "wx-id"},
            },
            {
                "id": "qianniu-2222303856223",
                "platform_code": "qianniu",
                "alias": "千牛店铺",
                "external_account_id": "qianniu:2222303856223",
                "login_status": "online",
                "metadata_json": {"shop_uid": "2222303856223"},
            },
            {
                "id": "douyin-local", "platform_code": "douyin", "alias": "抖店测试店",
                "external_account_id": "123456", "login_status": "online",
                "metadata_json": {"workspace_only": True, "message_send_enabled": False},
            },
        ]
        requests: list[dict] = []
        emitted: list[dict] = []

        def request(_method, _path, payload, *, node_auth=False):
            requests.append({"payload": payload, "node_auth": node_auth})
            return [
                {
                    "local_account_id": item["local_account_id"],
                    "id": f"server-{item['local_account_id']}",
                    "login_status": item["login_status"],
                }
                for item in payload["accounts"]
            ]

        agent.request = request  # type: ignore[method-assign]
        agent.emit = lambda message_type, **payload: emitted.append(  # type: ignore[method-assign]
            {"type": message_type, **payload}
        )

        agent.sync_accounts()

        self.assertEqual(
            [item["payload"]["platform_code"] for item in requests],
            ["pinduoduo", "wechat", "qianniu", "douyin"],
        )
        self.assertEqual(requests[1]["payload"]["accounts"][0]["metadata_json"]["wechat_id"], "wx-id")
        self.assertEqual(requests[2]["payload"]["accounts"][0]["metadata_json"]["shop_uid"], "2222303856223")
        self.assertFalse(requests[3]["payload"]["accounts"][0]["metadata_json"]["message_send_enabled"])
        self.assertTrue(all(item["node_auth"] for item in requests))
        self.assertEqual(
            [item["platform_code"] for item in emitted[0]["bindings"]],
            ["pinduoduo", "wechat", "qianniu", "douyin"],
        )

    def test_active_platforms_are_reported_from_unarchived_accounts(self) -> None:
        agent = RpaAgent()
        agent.accounts = [
            {"id": "pdd", "platform_code": "pinduoduo", "paused": False},
            {"id": "wechat", "platform_code": "wechat", "paused": True},
            {"id": "qn", "platform_code": "qianniu", "archived": False},
            {"id": "dy", "platform_code": "douyin", "paused": False},
        ]

        self.assertEqual(agent.active_platforms(), ["pinduoduo", "qianniu", "douyin"])


class TaskPollingTests(unittest.TestCase):
    def test_flushed_inbound_events_enable_short_lived_fast_task_polling(self) -> None:
        agent = RpaAgent()
        queue = EventQueueTests.queue()
        queue.enqueue({"event_id": "incoming", "event_type": "customer_message"})
        agent.event_queue = queue
        agent.node_token = "node-token"
        requests: list[tuple[str, str]] = []
        agent.request = lambda method, path, *_args, **_kwargs: requests.append((method, path)) or []  # type: ignore[method-assign]
        agent.emit = lambda *_args, **_kwargs: None  # type: ignore[method-assign]

        with patch("agent.time.monotonic", return_value=100.0):
            agent.flush_events()

        self.assertEqual(requests, [("POST", "/rpa/events/batch")])
        self.assertEqual(agent.fast_task_poll_until, 108.0)
        self.assertEqual(queue.pending(), [])
        queue.connection.close()

    def test_qianniu_send_guard_uses_node_auth_and_returns_correlated_result(self) -> None:
        agent = RpaAgent()
        agent.bridge_secret = "bridge-secret"
        requests: list[tuple[str, str, bool]] = []
        emitted: list[dict] = []

        def request(method, path, _payload=None, *, node_auth=False):
            requests.append((method, path, node_auth))
            return {"blocked": False}

        agent.request = request  # type: ignore[method-assign]
        agent.emit = lambda message_type, **payload: emitted.append(  # type: ignore[method-assign]
            {"type": message_type, **payload}
        )

        agent.handle(
            {
                "type": "qianniu_send_guard",
                "secret": "bridge-secret",
                "request_id": "request-1",
                "task_id": "task-1",
                "platform_account_id": "account-1",
                "cid": "1.1-2.1#11001@cntaobao",
            }
        )

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0][0], "GET")
        self.assertIn("/rpa/tasks/task-1/qianniu-send-guard?", requests[0][1])
        self.assertIn("platform_account_id=account-1", requests[0][1])
        self.assertIn("cid=1.1-2.1%2311001%40cntaobao", requests[0][1])
        self.assertTrue(requests[0][2])
        self.assertEqual(
            emitted,
            [
                {
                    "type": "qianniu_send_guard_result",
                    "request_id": "request-1",
                    "result": {"blocked": False},
                }
            ],
        )

if __name__ == "__main__":
    unittest.main()
