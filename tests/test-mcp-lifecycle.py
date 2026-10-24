#!/usr/bin/env python3
"""Real stdio/FastMCP concurrency regression tests; all fixtures stay under tests/."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

from fastmcp import Client
from fastmcp.client.transports import StdioTransport
from fastmcp.exceptions import ToolError
import mcp.types as mcp_types


ROOT = Path(__file__).resolve().parents[1]
HELPERS = Path(os.environ.get("PKM_MCP_LIFECYCLE_EXTENSION_ROOT", str(ROOT))) / "resources"
sys.path.insert(0, str(HELPERS))
from mcp_call_guard import ManagedMcpLifecycle
SERVER = '''
import asyncio, json, os, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from fastmcp import FastMCP
from mcp_call_guard import ManagedMcpLifecycle
root, generation = Path(sys.argv[2]), sys.argv[3]
manifest = {"schema": "pkm.mcp.lifecycle/v1", "managedRoot": str(root),
    "generation": generation, "version": "2.18.0", "components": {"knowledge": "1.6.0"}}
if (root / "compatibility.json").is_file():
    manifest["compatibility"] = json.loads((root / "compatibility.json").read_text())
    manifest["enabledFeatureDomains"] = ["knowledge", "automation"]
lifecycle = ManagedMcpLifecycle(manifest, drain_seconds=0.15, poll_seconds=0.02)
server = FastMCP("managed-lifecycle-fixture")
server.add_middleware(lifecycle)

@server.tool()
def mcp_lifecycle_status() -> dict:
    return lifecycle.status()

@server.tool()
async def read() -> dict:
    return {"ok": True, "generation": generation}

@server.tool()
async def write(key: str) -> dict:
    (root / (key + ".started")).write_text("started")
    while not (root / (key + ".release")).exists():
        await asyncio.sleep(0.01)
    with (root / "writes").open("a") as stream:
        stream.write(key + "\\n")
    return {"ok": True}

@server.tool()
async def fail() -> dict:
    raise ValueError("fixture failure")

@server.tool()
def sync_write(key: str, response_bytes: int = 0) -> dict:
    (root / (key + ".started")).write_text("started")
    while not (root / (key + ".release")).exists():
        time.sleep(0.01)
    with (root / "writes").open("a") as stream:
        stream.write(key + "\\n")
    return {"ok": True, "payload": "x" * response_bytes}

if sys.argv[4] == "retire":
    from mcp_call_guard import run_managed_stdio
    asyncio.run(run_managed_stdio(server, lifecycle))
else:
    server.run()
'''


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix=".mcp-lifecycle-", dir=ROOT / "tests")
        self.root = Path(self.fixture.name)
        self.server = self.root / "fixture.py"
        self.server.write_text(SERVER, encoding="utf-8")
        self.clients = []
        self.logs = []
        self.publish("first")

    async def asyncTearDown(self):
        for client in reversed(self.clients):
            await client.__aexit__(None, None, None)
            await client.close()
        for log in self.logs:
            log.close()
        self.fixture.cleanup()

    def publish(self, generation):
        pending = self.root / "active.pending"
        pending.write_text(json.dumps({"schema": "pkm.mcp.lifecycle/v1", "generation": generation}))
        os.replace(pending, self.root / "active-generation.json")

    async def connect(self, generation, retire=False, helpers=HELPERS):
        log = (self.root / f"{generation}-{len(self.clients)}.stderr").open("w")
        self.logs.append(log)
        transport = StdioTransport(sys.executable, [str(self.server), str(helpers),
            str(self.root), generation, "retire" if retire else "observe"], cwd=str(self.root), log_file=log,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        client = Client(transport, timeout=5)
        await client.__aenter__()
        self.clients.append(client)
        return client

    async def wait_file(self, name):
        async with asyncio.timeout(4):
            while not (self.root / name).exists():
                await asyncio.sleep(0.01)

    async def wait_exit(self, pid):
        for _ in range(200):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            await asyncio.sleep(0.02)
        records = [json.loads(file.read_text()) for file in (self.root / "instances").glob("*.json")]
        stat = Path(f"/proc/{pid}/stat")
        self.fail(f"Managed fixture PID {pid} did not exit: {records}; process state: {stat.read_text() if stat.exists() else 'unavailable'}")

    async def status(self, client):
        return (await client.call_tool("mcp_lifecycle_status", {})).structured_content

    async def assert_fenced(self, client, tool="read", arguments=None):
        with self.assertRaises(ToolError) as rejected:
            await client.call_tool(tool, arguments or {})
        self.assertIn("managed-runtime-superseded", str(rejected.exception))
        self.assertIn('"automaticReplay":false', str(rejected.exception))

    def publish_compatible(self, components=None, domains=None):
        contract = {"protocol": "pkm.mcp.api/1", "components": {"knowledge": "1"}}
        (self.root / "compatibility.json").write_text(json.dumps(contract))
        successor = self.root / "generations" / "second"
        successor.mkdir(parents=True, exist_ok=True)
        (successor / "manifest.json").write_text(json.dumps({
            "schema": "pkm.mcp.lifecycle/v1", "generation": "second", "version": "99.0.0",
            "compatibility": {**contract, "components": components or contract["components"]},
            "enabledFeatureDomains": domains if domains is not None else ["knowledge", "automation"],
        }))

    async def test_compatible_update_keeps_old_session_and_writes_usable(self):
        self.publish_compatible()
        client = await self.connect("first", retire=True)
        pending = asyncio.create_task(client.call_tool("write", {"key": "compatible"}))
        await self.wait_file("compatible.started")
        self.publish("second")
        self.assertEqual((await client.call_tool("read", {})).structured_content["generation"], "first")
        current = await self.status(client)
        self.assertEqual(current["phase"], "accepting")
        self.assertTrue(current["updateAvailable"])
        self.assertTrue(current["acceptingNewCalls"])
        (self.root / "compatible.release").touch()
        await pending
        await asyncio.sleep(1.2)
        self.assertEqual((await client.call_tool("read", {})).structured_content["generation"], "first")
        self.assertEqual((self.root / "writes").read_text().splitlines(), ["compatible"])

    async def test_changed_api_or_removed_domain_still_fences(self):
        for components, domains in [({"knowledge": "2"}, None), (None, ["knowledge"])]:
            with self.subTest(components=components, domains=domains):
                self.publish("first")
                self.publish_compatible(components, domains)
                client = await self.connect("first")
                self.publish("second")
                await self.assert_fenced(client)

    @unittest.skipUnless(os.environ.get("PKM_LEGACY_MCP_EXTENSION_ROOT"), "requires a previous installed runtime")
    async def test_real_legacy_lifecycle_survives_compatible_latest_pointer(self):
        self.publish_compatible()
        helpers = Path(os.environ["PKM_LEGACY_MCP_EXTENSION_ROOT"]) / "resources"
        client = await self.connect("first", helpers=helpers)
        (self.root / "latest-generation.json").write_text(json.dumps({
            "schema": "pkm.mcp.lifecycle/v1", "generation": "second"}))
        self.assertEqual((await client.call_tool("read", {})).structured_content["generation"], "first")
        self.assertTrue((await self.status(client))["acceptingNewCalls"])

    async def test_concurrent_calls_multi_window_drain_and_successor(self):
        first, other_window = await self.connect("first"), await self.connect("first")
        write_a = asyncio.create_task(first.call_tool("write", {"key": "a"}))
        write_b = asyncio.create_task(first.call_tool("write", {"key": "b"}))
        await self.wait_file("a.started")
        await self.wait_file("b.started")
        self.assertEqual((await self.status(first))["inFlight"], 2)
        self.publish("second")
        await self.assert_fenced(first)
        await self.assert_fenced(other_window, "write", {"key": "never"})
        self.assertFalse((self.root / "never.started").exists())
        self.assertEqual((await self.status(first))["phase"], "draining")
        self.assertEqual((await self.status(other_window))["phase"], "drained")
        successor = await self.connect("second")
        self.assertEqual((await successor.call_tool("read", {})).structured_content["generation"], "second")
        await asyncio.sleep(0.2)
        timed_out = await self.status(first)
        self.assertEqual(timed_out["phase"], "action-required")
        self.assertEqual(timed_out["inFlight"], 2)
        self.assertFalse(timed_out["automaticTermination"])
        (self.root / "a.release").touch()
        await write_a
        self.assertEqual((await self.status(first))["inFlight"], 1)
        (self.root / "b.release").touch()
        await write_b
        self.assertEqual((await self.status(first))["phase"], "drained")
        self.assertEqual((self.root / "writes").read_text().splitlines(), ["a", "b"])
        # Republishing an older pointer cannot resurrect an already fenced process.
        self.publish("first")
        await self.assert_fenced(first)
        self.assertEqual((await self.status(first))["phase"], "drained")

    async def test_cancelled_write_stays_inflight_until_actual_completion(self):
        client = await self.connect("first", retire=True)
        pid = (await self.status(client))["pid"]
        request_id = client.session._request_id
        pending = asyncio.create_task(client.call_tool("write", {"key": "uncertain"}))
        await self.wait_file("uncertain.started")
        await client.session.send_notification(mcp_types.ClientNotification(
            mcp_types.CancelledNotification(params=mcp_types.CancelledNotificationParams(
                requestId=request_id, reason="caller cancelled; outcome is uncertain"))))
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.publish("second")
        async with asyncio.timeout(3):
            while (await self.status(client))["uncertainCalls"] != 1:
                await asyncio.sleep(0.01)
        self.assertEqual((await self.status(client))["inFlight"], 1)
        await asyncio.sleep(0.3)
        os.kill(pid, 0)
        await self.assert_fenced(client, "write", {"key": "replayed"})
        (self.root / "uncertain.release").touch()
        await self.wait_file("writes")
        async with asyncio.timeout(3):
            while (await self.status(client))["inFlight"]:
                await asyncio.sleep(0.01)
        self.assertEqual((self.root / "writes").read_text(), "uncertain\n")
        self.assertFalse((self.root / "replayed.started").exists())
        await self.wait_exit(pid)

    async def test_invalid_pointer_cannot_authorize_automatic_retirement(self):
        client = await self.connect("first", retire=True)
        pid = (await self.status(client))["pid"]
        (self.root / "active-generation.json").write_text("{broken")
        await self.assert_fenced(client)
        await asyncio.sleep(1.2)
        os.kill(pid, 0)
        self.assertEqual((await self.status(client))["controlError"], "generation-control-unavailable")

    async def test_failure_and_missing_generation_fail_closed(self):
        client = await self.connect("first")
        with self.assertRaises(ToolError):
            await client.call_tool("fail", {})
        self.assertEqual((await self.status(client))["inFlight"], 0)
        (self.root / "active-generation.json").write_text("{broken")
        await self.assert_fenced(client)
        status = await self.status(client)
        self.assertEqual(status["controlError"], "generation-control-unavailable")
        self.assertEqual(status["phase"], "drained")
        self.publish("first")
        await self.assert_fenced(client)

    async def test_sync_write_cancel_does_not_fake_thread_completion(self):
        client = await self.connect("first")
        request_id = client.session._request_id
        pending = asyncio.create_task(client.call_tool("sync_write", {"key": "threaded"}))
        await self.wait_file("threaded.started")
        await client.session.send_notification(mcp_types.ClientNotification(
            mcp_types.CancelledNotification(params=mcp_types.CancelledNotificationParams(
                requestId=request_id, reason="uncertain threaded write"))))
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.publish("second")
        async with asyncio.timeout(3):
            while (await self.status(client))["uncertainCalls"] != 1:
                await asyncio.sleep(0.01)
        await asyncio.sleep(0.2)
        self.assertEqual((await self.status(client))["phase"], "action-required")
        self.assertEqual((await self.status(client))["inFlight"], 1)
        (self.root / "threaded.release").touch()
        async with asyncio.timeout(3):
            while (await self.status(client))["inFlight"]:
                await asyncio.sleep(0.01)
        self.assertEqual((self.root / "writes").read_text(), "threaded\n")

    async def test_maintenance_fences_every_connection_without_killing(self):
        first, second = await self.connect("first"), await self.connect("first")
        (self.root / "runtime-maintenance.json").write_text("{}")
        await self.assert_fenced(first)
        await self.assert_fenced(second)
        (self.root / "runtime-maintenance.json").unlink()
        await self.assert_fenced(first)

    async def test_executor_cancellation_is_not_a_drain_receipt(self):
        lifecycle = ManagedMcpLifecycle({
            "schema": "pkm.mcp.lifecycle/v1", "managedRoot": str(self.root),
            "generation": "first", "version": "2.18.0", "components": {},
        })
        entered = asyncio.Event()
        execution = []

        async def call_next(context):
            execution.append(asyncio.current_task())
            entered.set()
            await asyncio.Event().wait()

        pending = asyncio.create_task(lifecycle.on_call_tool(
            SimpleNamespace(message=SimpleNamespace(name="write")), call_next))
        await entered.wait()
        execution[0].cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.publish("second")
        status = lifecycle.status()
        self.assertEqual(status["inFlight"], 1)
        self.assertEqual(status["uncertainCalls"], 1)
        self.assertEqual(status["phase"], "draining")

    async def test_superseded_idle_process_exits_but_current_process_stays(self):
        old = await self.connect("first", retire=True)
        old_pid = (await self.status(old))["pid"]
        self.publish("second")
        successor = await self.connect("second", retire=True)
        await self.wait_exit(old_pid)
        self.assertEqual((await successor.call_tool("read", {})).structured_content["generation"], "second")
        records = [json.loads(file.read_text()) for file in (self.root / "instances").glob("*.json")]
        self.assertTrue(any(record["pid"] == old_pid and record["phase"] == "retired" for record in records))

    async def test_retirement_waits_for_real_write_and_returns_result_before_exit(self):
        old = await self.connect("first", retire=True)
        pid = (await self.status(old))["pid"]
        write = asyncio.create_task(old.call_tool("sync_write", {"key": "retiring", "response_bytes": 1024 * 1024}))
        await self.wait_file("retiring.started")
        self.publish("second")
        await asyncio.sleep(0.3)
        os.kill(pid, 0)
        self.assertEqual((await self.status(old))["inFlight"], 1)
        (self.root / "retiring.release").touch()
        reply = (await write).structured_content
        self.assertTrue(reply["ok"])
        self.assertEqual(len(reply["payload"]), 1024 * 1024, "retirement must preserve the entire large response")
        await self.wait_exit(pid)
        self.assertEqual((self.root / "writes").read_text(), "retiring\n")


if __name__ == "__main__":
    unittest.main()
