from __future__ import annotations

import json
import os
import platform
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class ApiError(RuntimeError):
    pass


def configure_standard_streams() -> None:
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


class EventQueue:
    def __init__(self, data_dir: str, filename: str = "events.db") -> None:
        directory = Path(data_dir)
        directory.mkdir(parents=True, exist_ok=True)
        safe_filename = Path(filename).name
        self.connection = sqlite3.connect(directory / safe_filename, check_same_thread=False)
        self.lock = threading.Lock()
        with self.connection:
            self.connection.execute(
                """
                CREATE TABLE IF NOT EXISTS event_queue (
                    event_id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    synced_at REAL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                )
                """
            )
            self.connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_event_queue_pending "
                "ON event_queue (synced_at, created_at)"
            )

    def enqueue(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self.lock, self.connection:
            cursor = self.connection.execute(
                "INSERT OR IGNORE INTO event_queue (event_id, payload_json, created_at) VALUES (?, ?, ?)",
                (payload["event_id"], encoded, time.time()),
            )
            if cursor.rowcount == 0:
                existing = self.connection.execute(
                    "SELECT payload_json FROM event_queue WHERE event_id = ?",
                    (payload["event_id"],),
                ).fetchone()
                if not existing or existing[0] != encoded:
                    raise ValueError("event_id was reused with a different payload")

    def pending(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.connection.execute(
                "SELECT payload_json FROM event_queue WHERE synced_at IS NULL "
                "ORDER BY created_at LIMIT ?",
                (limit,),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def mark_synced(self, event_ids: list[str]) -> None:
        if not event_ids:
            return
        with self.lock, self.connection:
            self.connection.executemany(
                "UPDATE event_queue SET synced_at = ?, last_error = NULL WHERE event_id = ?",
                [(time.time(), event_id) for event_id in event_ids],
            )

    def mark_failed(self, event_ids: list[str], error: str) -> None:
        with self.lock, self.connection:
            self.connection.executemany(
                "UPDATE event_queue SET attempts = attempts + 1, last_error = ? WHERE event_id = ?",
                [(error[:500], event_id) for event_id in event_ids],
            )

    def counts(self) -> tuple[int, int]:
        with self.lock:
            pending = self.connection.execute(
                "SELECT COUNT(*) FROM event_queue WHERE synced_at IS NULL"
            ).fetchone()[0]
            synced = self.connection.execute(
                "SELECT COUNT(*) FROM event_queue WHERE synced_at IS NOT NULL"
            ).fetchone()[0]
        return pending, synced

    def delete_conversation_events(
        self,
        platform_account_id: str,
        conversation_external_id: str,
    ) -> int:
        deleted = 0
        with self.lock, self.connection:
            rows = self.connection.execute(
                "SELECT event_id, payload_json FROM event_queue"
            ).fetchall()
            event_ids = []
            for event_id, encoded in rows:
                try:
                    event = json.loads(encoded)
                except (TypeError, ValueError):
                    continue
                if (
                    event.get("platform_account_id") == platform_account_id
                    and event.get("conversation_external_id") == conversation_external_id
                ):
                    event_ids.append(event_id)
            if event_ids:
                self.connection.executemany(
                    "DELETE FROM event_queue WHERE event_id = ?",
                    [(event_id,) for event_id in event_ids],
                )
                deleted = len(event_ids)
        return deleted


class RpaAgent:
    def __init__(self) -> None:
        self.bridge_secret = ""
        self.api_base_url = ""
        self.access_token = ""
        self.user_id = ""
        self.app_version = "0.1.0"
        self.node_token = ""
        self.node_id: str | None = None
        self.heartbeat_interval = 30
        self.event_queue: EventQueue | None = None
        self.event_flush_lock = threading.Lock()
        self.accounts: list[dict[str, Any]] = []
        self.accounts_version = 0
        self.synced_accounts_version = -1
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.output_lock = threading.Lock()
        self.last_heartbeat = 0.0
        self.last_task_poll = 0.0
        self.fast_task_poll_until = 0.0
        self.worker: threading.Thread | None = None

    def emit(self, message_type: str, **payload: Any) -> None:
        message = {"type": message_type, "secret": self.bridge_secret, **payload}
        with self.output_lock:
            print(json.dumps(message, ensure_ascii=False), flush=True)

    def bootstrap(self, command: dict[str, Any]) -> None:
        self.bridge_secret = str(command["secret"])
        self.api_base_url = str(command["api_base_url"]).rstrip("/")
        self.access_token = str(command["access_token"])
        self.user_id = str(command["user_id"])
        self.app_version = str(command.get("app_version") or "0.1.0")
        self.event_queue = EventQueue(
            str(command["data_dir"]), str(command.get("queue_filename") or "events.db")
        )
        self.worker = threading.Thread(target=self.run_worker, name="rpa-worker", daemon=True)
        self.worker.start()
        self.emit("agent_started", pid=os.getpid())
        self.wake_event.set()

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        node_auth: bool = False,
    ) -> Any:
        token = self.node_token if node_auth else self.access_token
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.api_base_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": "AI-Customer-Service-RPA/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                content = response.read()
                return json.loads(content) if content else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise ApiError(f"HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ApiError(str(exc)) from exc

    def register(self) -> None:
        node_key = f"{self.user_id}:{platform.node()}:{hex(uuid_node())}"
        response = self.request(
            "POST",
            "/rpa/nodes/register",
            {
                "node_key": node_key,
                "hostname": socket.gethostname(),
                "machine_name": platform.node() or None,
                "supported_platforms": ["pinduoduo", "wechat", "qianniu", "douyin"],
                "app_version": self.app_version,
            },
        )
        self.node_token = response["node_token"]
        self.node_id = response["node"]["id"]
        configured = int(response.get("heartbeat_interval_seconds", 30))
        self.heartbeat_interval = max(10, min(configured, 30))
        self.last_heartbeat = time.monotonic()
        self.emit(
            "registered",
            node_id=self.node_id,
            status="online",
            heartbeat_interval_seconds=self.heartbeat_interval,
        )

    def heartbeat(self) -> None:
        self.request(
            "POST",
            "/rpa/nodes/heartbeat",
            {"status": "online", "active_platforms": self.active_platforms()},
            node_auth=True,
        )
        self.last_heartbeat = time.monotonic()
        pending, synced = self.event_queue.counts() if self.event_queue else (0, 0)
        self.emit(
            "heartbeat",
            node_id=self.node_id,
            status="online",
            pending_events=pending,
            synced_events=synced,
        )

    def sync_accounts(self) -> None:
        payloads: dict[str, list[dict[str, Any]]] = {
            "pinduoduo": [],
            "wechat": [],
            "qianniu": [],
            "douyin": [],
        }
        for account in self.accounts:
            platform_code = str(account.get("platform_code") or "pinduoduo")
            payloads.setdefault(platform_code, []).append(
                {
                    "platform_code": platform_code,
                    "local_account_id": account["id"],
                    "account_name": account.get("account_name") or account["alias"],
                    "account_alias": account["alias"],
                    "external_account_id": account.get("external_account_id"),
                    "login_status": account.get("login_status", "unknown"),
                    "archived": bool(account.get("archived")),
                    "metadata_json": {
                        "workspace_partition": account.get("partition"),
                        "paused": bool(account.get("paused")),
                        **dict(account.get("metadata_json") or {}),
                    },
                }
            )
        bindings = []
        for platform_code, payload in payloads.items():
            responses = self.request(
                "POST",
                "/rpa/platform-accounts/sync",
                {"platform_code": platform_code, "accounts": payload},
                node_auth=True,
            )
            for response in responses:
                bindings.append(
                    {
                        "platform_code": platform_code,
                        "local_account_id": response["local_account_id"],
                        "platform_account_id": response["id"],
                        "login_status": response["login_status"],
                    }
                )
        self.emit("accounts_synced", bindings=bindings)

    def active_platforms(self) -> list[str]:
        platforms = {
            str(account.get("platform_code") or "pinduoduo")
            for account in self.accounts
            if not account.get("paused") and not account.get("archived")
        }
        return [item for item in ("pinduoduo", "wechat", "qianniu", "douyin") if item in platforms]

    def flush_events(self) -> None:
        with self.event_flush_lock:
            if not self.event_queue:
                return
            events = self.event_queue.pending()
            if not events:
                return
            event_ids = [item["event_id"] for item in events]
            try:
                self.request("POST", "/rpa/events/batch", {"events": events}, node_auth=True)
                self.event_queue.mark_synced(event_ids)
                # Inbound automation creates follow-up tasks after a short debounce. Poll
                # briefly at low latency so those tasks do not wait for the idle loop.
                self.fast_task_poll_until = max(
                    self.fast_task_poll_until,
                    time.monotonic() + 8.0,
                )
                self.emit("events_synced", count=len(event_ids))
            except ApiError as exc:
                self.event_queue.mark_failed(event_ids, str(exc))
                raise

    def poll_tasks(self) -> None:
        if not self.node_token:
            return
        tasks = self.request("GET", "/rpa/tasks/pending?limit=20", node_auth=True)
        for task in tasks if isinstance(tasks, list) else []:
            self.request("POST", f"/rpa/tasks/{task['id']}/ack", {}, node_auth=True)
            self.emit("task", task=task)

    def run_worker(self) -> None:
        while not self.stop_event.is_set():
            try:
                if not self.node_token:
                    self.register()
                    self.synced_accounts_version = -1
                if self.synced_accounts_version != self.accounts_version:
                    self.sync_accounts()
                    self.synced_accounts_version = self.accounts_version
                self.flush_events()
                now = time.monotonic()
                task_poll_interval = 0.25 if now < self.fast_task_poll_until else 1.0
                if now - self.last_task_poll >= task_poll_interval:
                    self.poll_tasks()
                    self.last_task_poll = time.monotonic()
                if time.monotonic() - self.last_heartbeat >= self.heartbeat_interval:
                    self.heartbeat()
            except Exception as exc:  # noqa: BLE001
                self.emit("offline", status="offline", detail=str(exc)[:500])
                if isinstance(exc, ApiError) and "HTTP 401" in str(exc):
                    self.node_token = ""
                self.synced_accounts_version = -1
            now = time.monotonic()
            wait_seconds = 0.25 if now < self.fast_task_poll_until else 1.0
            self.wake_event.wait(wait_seconds)
            self.wake_event.clear()

    def handle(self, command: dict[str, Any]) -> None:
        if not self.bridge_secret:
            if command.get("type") != "bootstrap":
                raise ValueError("First command must be bootstrap")
            self.bootstrap(command)
            return
        if command.get("secret") != self.bridge_secret:
            raise ValueError("Invalid bridge secret")
        command_type = command.get("type")
        if command_type == "sync_accounts":
            self.accounts = list(command.get("accounts") or [])
            self.accounts_version += 1
            self.wake_event.set()
        elif command_type == "enqueue_event":
            if not self.event_queue:
                raise RuntimeError("Agent is not initialized")
            self.event_queue.enqueue(dict(command["event"]))
            self.wake_event.set()
            self.emit("event_queued", event_id=command["event"]["event_id"])
        elif command_type == "complete_task":
            self.request(
                "POST",
                f"/rpa/tasks/{command['task_id']}/complete",
                {
                    "status": command.get("status", "completed"),
                    "result_json": command.get("result_json") or {},
                    "error_message": command.get("error_message"),
                },
                node_auth=True,
            )
        elif command_type == "clear_conversation_events":
            if not self.event_queue:
                raise RuntimeError("Agent is not initialized")
            with self.event_flush_lock:
                deleted_count = self.event_queue.delete_conversation_events(
                    str(command["platform_account_id"]),
                    str(command["conversation_external_id"]),
                )
            self.emit(
                "conversation_events_cleared",
                request_id=str(command["request_id"]),
                deleted_count=deleted_count,
            )
        elif command_type == "qianniu_send_guard":
            request_id = str(command["request_id"])
            query = urllib.parse.urlencode(
                {
                    "platform_account_id": str(command["platform_account_id"]),
                    "cid": str(command["cid"]),
                }
            )
            try:
                result = self.request(
                    "GET",
                    f"/rpa/tasks/{command['task_id']}/qianniu-send-guard?{query}",
                    node_auth=True,
                )
                self.emit(
                    "qianniu_send_guard_result",
                    request_id=request_id,
                    result=result or {},
                )
            except Exception as exc:  # noqa: BLE001
                self.emit(
                    "qianniu_send_guard_result",
                    request_id=request_id,
                    error=str(exc)[:500],
                )
        elif command_type == "update_access_token":
            self.access_token = str(command["access_token"])
            self.node_token = ""
            self.wake_event.set()
        elif command_type == "shutdown":
            self.stop_event.set()
            self.wake_event.set()
        else:
            raise ValueError(f"Unsupported command: {command_type}")

    def close(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        if self.worker:
            self.worker.join(timeout=5)
        if self.node_token:
            try:
                self.request("POST", "/rpa/nodes/disconnect", {}, node_auth=True)
            except ApiError:
                pass


def uuid_node() -> int:
    import uuid

    return uuid.getnode()


def main() -> int:
    configure_standard_streams()
    agent = RpaAgent()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                agent.handle(json.loads(line))
            except Exception as exc:  # noqa: BLE001
                agent.emit("command_error", detail=str(exc)[:500])
            if agent.stop_event.is_set():
                break
    finally:
        agent.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
