from __future__ import annotations

import unittest
from pathlib import Path
from uuid import uuid4

from agent import EventQueue


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


if __name__ == "__main__":
    unittest.main()
