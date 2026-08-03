from __future__ import annotations

import json
import os
import queue
from contextlib import nullcontext
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "services" / "business-api"
AGENT_PATH = ROOT / "agents" / "rpa" / "agent.py"
SMOKE_DIR = ROOT / "agents" / "rpa" / "smoke-data"


def free_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def request_json(
    base_url: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    token: str | None = None,
) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{base_url}{path}", data=body, method=method, headers=headers
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        content = response.read()
        return json.loads(content) if content else None


def start_api(port: int, database_path: Path) -> subprocess.Popen[str]:
    env = {
        **os.environ,
        "DATABASE_URL": f"sqlite:///{database_path.as_posix()}",
        "SEED_DEMO_DATA": "false",
        "DEFAULT_ADMIN_USERNAME": "phase-b-admin",
        "DEFAULT_ADMIN_PASSWORD": "phase-b-password",
    }
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--app-dir",
            str(API_DIR),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


def wait_for_api(
    base_url: str, process: subprocess.Popen[str] | None = None, timeout: float = 15
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request_json(base_url, "GET", "/healthz")
            return
        except (urllib.error.URLError, TimeoutError):
            if process and process.poll() is not None:
                stderr = process.stderr.read() if process.stderr else ""
                raise RuntimeError(f"业务 API 启动失败: {stderr[-4000:]}")
            time.sleep(0.1)
    raise RuntimeError("业务 API 启动超时")


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
    close_process_streams(process)


def close_process_streams(process: subprocess.Popen[str]) -> None:
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream and not stream.closed:
            stream.close()


def send_command(process: subprocess.Popen[str], payload: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
    process.stdin.flush()


def remove_smoke_files(directory: Path) -> None:
    for target in directory.glob("phase-b-*.db*"):
        try:
            target.unlink(missing_ok=True)
        except PermissionError:
            # Windows may retain a short-lived SQLite/Defender handle. A later run cleans it.
            pass


def main() -> int:
    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    api_base = f"{origin}/api/v1"
    secret = "phase-b-smoke-secret"
    run_id = f"{os.getpid()}-{time.time_ns()}"

    with nullcontext(str(SMOKE_DIR)) as temp:
        temp_path = Path(temp)
        database_path = temp_path / f"phase-b-api-{run_id}.db"
        queue_filename = f"phase-b-events-{run_id}.db"
        remove_smoke_files(temp_path)
        api = start_api(port, database_path)
        agent: subprocess.Popen[str] | None = None
        try:
            wait_for_api(origin, api)
            auth = request_json(
                api_base,
                "POST",
                "/auth/register",
                {
                    "username": "phase-b-user",
                    "display_name": "阶段 B 验收用户",
                    "password": "phase-b-password",
                },
            )
            token = auth["access_token"]
            user_id = auth["user"]["id"]

            agent = subprocess.Popen(
                [sys.executable, "-u", str(AGENT_PATH)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                cwd=ROOT,
            )
            messages: queue.Queue[dict[str, Any]] = queue.Queue()

            def read_agent() -> None:
                assert agent is not None and agent.stdout is not None
                for line in agent.stdout:
                    if line.strip():
                        messages.put(json.loads(line))

            threading.Thread(target=read_agent, daemon=True).start()
            send_command(
                agent,
                {
                    "type": "bootstrap",
                    "secret": secret,
                    "api_base_url": api_base,
                    "access_token": token,
                    "user_id": user_id,
                    "data_dir": str(temp_path),
                    "queue_filename": queue_filename,
                },
            )
            send_command(
                agent,
                {
                    "type": "sync_accounts",
                    "secret": secret,
                    "accounts": [
                        {
                            "id": "11111111-1111-4111-8111-111111111111",
                            "alias": "验收店铺 A",
                            "partition": "persist:phase-b-a",
                            "paused": False,
                            "login_status": "online",
                        },
                        {
                            "id": "22222222-2222-4222-8222-222222222222",
                            "alias": "验收店铺 B",
                            "partition": "persist:phase-b-b",
                            "paused": False,
                            "login_status": "login_required",
                        },
                    ],
                },
            )

            bindings = None
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                message = messages.get(timeout=max(0.1, deadline - time.monotonic()))
                if message["type"] == "accounts_synced" and len(message["bindings"]) == 2:
                    bindings = message["bindings"]
                    break
            if not bindings:
                raise AssertionError("两个店铺未完成服务端绑定")

            accounts = request_json(
                api_base,
                "GET",
                "/platform-accounts?platform_code=pinduoduo",
                token=token,
            )
            assert accounts["meta"]["total"] == 2
            assert {item["login_status"] for item in accounts["items"]} == {
                "online",
                "login_required",
            }
            other_auth = request_json(
                api_base,
                "POST",
                "/auth/register",
                {
                    "username": "phase-b-other-user",
                    "display_name": "隔离验收用户",
                    "password": "phase-b-password",
                },
            )
            other_accounts = request_json(
                api_base,
                "GET",
                "/platform-accounts?platform_code=pinduoduo",
                token=other_auth["access_token"],
            )
            assert other_accounts["meta"]["total"] == 0
            nodes = request_json(api_base, "GET", "/rpa/nodes", token=token)
            assert len(nodes) == 1 and nodes[0]["status"] == "online"

            platform_account_id = bindings[0]["platform_account_id"]
            stop_process(api)
            send_command(
                agent,
                {
                    "type": "enqueue_event",
                    "secret": secret,
                    "event": {
                        "event_id": "phase-b-offline-event",
                        "dedup_key": "phase-b-offline-event",
                        "event_type": "account_status_changed",
                        "platform_code": "pinduoduo",
                        "platform_account_id": platform_account_id,
                        "payload_json": {"login_status": "online"},
                    },
                },
            )
            time.sleep(1)
            with sqlite3.connect(temp_path / queue_filename) as connection:
                pending = connection.execute(
                    "SELECT COUNT(*) FROM event_queue WHERE synced_at IS NULL"
                ).fetchone()[0]
            assert pending == 1

            api = start_api(port, database_path)
            wait_for_api(origin, api)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                try:
                    message = messages.get(timeout=max(0.1, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if message["type"] == "events_synced":
                    break
            else:
                raise AssertionError("离线事件未在网络恢复后补传")

            with sqlite3.connect(database_path) as connection:
                uploaded = connection.execute(
                    "SELECT COUNT(*) FROM rpa_events WHERE event_id = ?",
                    ("phase-b-offline-event",),
                ).fetchone()[0]
            assert uploaded == 1

            send_command(agent, {"type": "shutdown", "secret": secret})
            agent.wait(timeout=8)
            close_process_streams(agent)
            agent = None
            nodes = request_json(api_base, "GET", "/rpa/nodes", token=token)
            assert nodes[0]["status"] == "offline"

            print(
                json.dumps(
                    {
                        "status": "passed",
                        "platform_accounts": accounts["meta"]["total"],
                        "rpa_nodes": len(nodes),
                        "offline_events_replayed": uploaded,
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        finally:
            if agent and agent.poll() is None:
                try:
                    send_command(agent, {"type": "shutdown", "secret": secret})
                    agent.wait(timeout=3)
                    close_process_streams(agent)
                except Exception:
                    agent.kill()
            stop_process(api)
            remove_smoke_files(temp_path)


if __name__ == "__main__":
    raise SystemExit(main())
