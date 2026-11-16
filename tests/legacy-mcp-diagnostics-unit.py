import asyncio
import importlib.util
import json
import shutil
import sys
from types import SimpleNamespace
import unittest
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "legacy/resources"))
from diagnostic_log import DiagnosticLog

spec = importlib.util.spec_from_file_location("diagnostics", root / "compat/legacy-mcp-diagnostics.py")
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)
spec = importlib.util.spec_from_file_location("active_lifecycle", root / "compat/managed_mcp_lifecycle.py")
lifecycle_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle_module)
ManagedMcpLifecycle = lifecycle_module.ManagedMcpLifecycle
from fastmcp.exceptions import ToolError


class ActiveLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = root / (".lifecycle-unit-" + uuid.uuid4().hex)
        self.generation = self.directory / "generations/first"
        self.generation.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.directory)
        self.manifest = {
            "schema": "pkm.mcp.lifecycle/v1", "managedRoot": str(self.directory),
            "generation": "first", "version": "0.1.0", "components": {"knowledge": "0.1.0"},
            "compatibility": {"protocol": "pkm.mcp.api/1", "components": {"knowledge": "0"}},
            "enabledFeatureDomains": [],
        }
        (self.generation / "manifest.json").write_text(json.dumps(self.manifest))
        self.publish("first")
        self.context = SimpleNamespace(message=SimpleNamespace(name="write"))

    def publish(self, generation):
        (self.directory / "active-generation.json").write_text(json.dumps({
            "schema": "pkm.mcp.lifecycle/v1", "generation": generation,
        }))

    async def test_default_start_idle_calls_quiesce_retirement_have_zero_registry_io(self):
        events = []
        observing = [True]
        registry = str(self.directory / "instances")

        def audit(event, arguments):
            if observing[0] and any(isinstance(value, (str, bytes))
                                    and registry in str(value) for value in arguments):
                events.append(event)

        sys.addaudithook(audit)
        try:
            guard = ManagedMcpLifecycle.from_directory(self.generation)
            self.assertFalse(hasattr(guard, "monitor"))
            retirement = asyncio.create_task(guard.wait_for_retirement())
            try:
                await asyncio.sleep(0.06)

                async def complete(context):
                    return "actual-result"

                for _ in range(3):
                    self.assertEqual(await guard.on_message(
                        self.context, lambda context: guard.on_call_tool(context, complete)), "actual-result")
                    self.assertEqual(guard.status()["inFlight"], 0)
                self.assertEqual(guard.quiesce()["phase"], "drained")
                with self.assertRaises(ToolError):
                    await guard.on_call_tool(self.context, complete)
                self.publish("second")
                await asyncio.wait_for(retirement, 2)
            finally:
                if not retirement.done():
                    retirement.cancel()
                    await asyncio.gather(retirement, return_exceptions=True)
        finally:
            observing[0] = False
        self.assertEqual(events, [], f"Unexpected diagnostic registry I/O: {events}")
        self.assertFalse((self.directory / "instances").exists())
        print("ACTIVE_LIFECYCLE_DEFAULT_REGISTRY_IO=0 (startup/idle/3 calls/status/quiesce/retirement)")

    async def test_compatible_update_stays_usable_but_maintenance_irreversibly_fences(self):
        guard = ManagedMcpLifecycle(self.manifest)
        successor = self.directory / "generations/second"
        successor.mkdir()
        (successor / "manifest.json").write_text(json.dumps({**self.manifest, "generation": "second"}))
        self.publish("second")
        self.assertTrue(guard.status()["updateAvailable"])
        self.assertTrue(guard.status()["acceptingNewCalls"])
        maintenance = self.directory / "runtime-maintenance.json"
        maintenance.write_text("{}")
        self.assertFalse(guard.status()["acceptingNewCalls"])
        maintenance.unlink()
        self.publish("first")
        self.assertFalse(guard.status()["acceptingNewCalls"])

    async def test_invalid_or_missing_control_is_never_a_verified_drain(self):
        for contents in ("{broken", "[]", None):
            guard = ManagedMcpLifecycle(self.manifest)
            control = self.directory / "active-generation.json"
            if contents is None:
                control.unlink()
            else:
                control.write_text(contents)
            status = guard.status()
            self.assertEqual(status["controlError"], "generation-control-unavailable")
            self.assertFalse(status["acceptingNewCalls"])
            self.assertFalse(status["automaticReplay"])
            self.publish("first")
            self.assertEqual(guard.status()["controlError"], "")
            self.assertFalse(guard.status()["acceptingNewCalls"])

    async def test_existing_historical_registry_is_neither_read_nor_changed(self):
        registry = self.directory / "instances"
        registry.mkdir()
        historical = {
            f"synthetic-{index:04d}.json": json.dumps({"synthetic": True, "index": index}).encode()
            for index in range(1390)
        }
        for name, contents in historical.items():
            (registry / name).write_bytes(contents)
        observed = []
        observing = [True]

        def audit(event, arguments):
            if observing[0] and any(isinstance(value, (str, bytes))
                                    and str(registry) in str(value) for value in arguments):
                observed.append(event)

        sys.addaudithook(audit)
        try:
            guard = ManagedMcpLifecycle.from_directory(self.generation)
            self.assertTrue(guard.status()["acceptingNewCalls"])
            self.assertEqual(guard.quiesce()["phase"], "drained")
            await asyncio.sleep(0.02)
        finally:
            observing[0] = False
        self.assertEqual(observed, [])
        self.assertEqual(len(historical), 1390)
        self.assertEqual({path.name: path.read_bytes() for path in registry.iterdir()}, historical)
        print("ACTIVE_LIFECYCLE_PREEXISTING_RECORDS=1390 REGISTRY_READ_SCAN_WRITE=0 unchanged=true")

    async def test_caller_cancellation_waits_for_actual_effect_and_never_replays(self):
        guard = ManagedMcpLifecycle(self.manifest, drain_seconds=0.01)
        entered, release = asyncio.Event(), asyncio.Event()
        effects = []

        async def execute(context):
            entered.set()
            await release.wait()
            effects.append("one-real-effect")

        caller = asyncio.create_task(guard.on_call_tool(self.context, execute))
        await entered.wait()
        caller.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        self.assertEqual(guard.quiesce()["inFlight"], 1)
        await asyncio.sleep(0.02)
        status = guard.status()
        self.assertEqual(status["uncertainCalls"], 1)
        self.assertEqual(status["phase"], "action-required")
        self.assertFalse(status["automaticReplay"])
        self.assertFalse(status["automaticTermination"])
        with self.assertRaises(ToolError):
            await guard.on_call_tool(self.context, execute)
        release.set()
        await asyncio.sleep(0.01)
        self.assertEqual(effects, ["one-real-effect"])
        self.assertEqual(guard.status()["inFlight"], 0)
        self.assertEqual(guard.status()["uncertainCalls"], 0)

    async def test_execution_cancellation_retains_uncertain_work_and_blocks_retirement(self):
        guard = ManagedMcpLifecycle(self.manifest, drain_seconds=0.01, poll_seconds=0.01)
        entered = asyncio.Event()
        executions = []

        async def execute(context):
            executions.append(asyncio.current_task())
            entered.set()
            await asyncio.Event().wait()

        caller = asyncio.create_task(guard.on_call_tool(self.context, execute))
        await entered.wait()
        executions[0].cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        self.publish("second")
        self.assertEqual(guard.status()["inFlight"], 1)
        self.assertEqual(guard.status()["uncertainCalls"], 1)
        retirement = asyncio.create_task(guard.wait_for_retirement())
        await asyncio.sleep(0.03)
        self.assertFalse(retirement.done())
        retirement.cancel()
        await asyncio.gather(retirement, return_exceptions=True)

    async def test_failure_is_reported_and_control_calls_do_not_count_as_work(self):
        guard = ManagedMcpLifecycle(self.manifest)

        async def fail(context):
            raise ValueError("actual tool error")

        with self.assertRaisesRegex(ValueError, "actual tool error"):
            await guard.on_call_tool(self.context, fail)
        self.assertEqual(guard.status()["inFlight"], 0)
        guard.quiesce()

        async def control(context):
            return guard.status()

        for name in ("check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"):
            status = await guard.on_call_tool(SimpleNamespace(message=SimpleNamespace(name=name)), control)
            self.assertEqual(status["phase"], "drained")
            self.assertEqual(status["inFlight"], 0)


class PaginationTest(unittest.TestCase):
    def setUp(self):
        self.directory = root / (".diagnostics-unit-" + uuid.uuid4().hex)
        self.directory.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.directory)
        self.log = DiagnosticLog(self.directory, max_rows=3, chunk_rows=1)

    def test_rollover_stable_cursor_and_expiry(self):
        for value in range(3):
            self.log.record("call", value=value)
        first = diagnostics.page(self.log, 1, None)
        self.assertEqual(first["records"][0]["value"], 2)
        self.log.record("call", value=3)
        second = diagnostics.page(self.log, 1, first["next_cursor"])
        self.assertEqual(second["records"][0]["value"], 1)
        self.assertEqual(diagnostics.page(self.log, 1, second["next_cursor"])["records"][0]["value"], 0)
        for value in range(4, 9):
            self.log.record("call", value=value)
        with self.assertRaisesRegex(ValueError, "expired"):
            diagnostics.page(self.log, 1, first["next_cursor"])
        latest = diagnostics.page(self.log, 3, None)
        self.assertEqual([item["value"] for item in latest["records"]], [8, 7, 6])
        self.assertIsNone(latest["next_cursor"])

    def test_reject_foreign_and_malformed_cursors(self):
        self.log.record("call")
        for cursor in ["different:1:0:0", f"{self.log.writer_id}:99:1:0", "1" * 1000]:
            with self.assertRaises(ValueError):
                diagnostics.page(self.log, 1, cursor)

    def test_history_append_stable_and_changed_prefix_rejected(self):
        log = DiagnosticLog(self.directory)
        for value in range(3):
            log.record("call", value=value)
        first = diagnostics.history_page(self.directory, log.writer_id, 1)
        log.record("call", value=3)
        second = diagnostics.history_page(self.directory, log.writer_id, 1, first["next_cursor"])
        self.assertEqual(second["records"][0]["value"], 1)
        path = next(self.directory.glob(f"{log.writer_id}.*.jsonl"))
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b'"value":0', b'"value":9'))
        with self.assertRaisesRegex(ValueError, "changed"):
            diagnostics.history_page(self.directory, log.writer_id, 1, second["next_cursor"])

    def test_history_denies_links_missing_chunks_and_bad_cursors(self):
        log = DiagnosticLog(self.directory)
        log.record("call")
        page = diagnostics.history_page(self.directory, log.writer_id, 1)
        self.assertIsNone(page["next_cursor"])
        path = next(self.directory.glob(f"{log.writer_id}.*.jsonl"))
        target = self.directory / "target"
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            diagnostics.history_page(self.directory, log.writer_id)
        path.unlink()
        target.rename(path)
        with self.assertRaises(ValueError):
            diagnostics.history_page(self.directory, log.writer_id, cursor="bad")
        path.rename(self.directory / f"{log.writer_id}.0000000001.jsonl")
        (self.directory / f"{log.writer_id}.0000000003.jsonl").write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "missing"):
            diagnostics.history_page(self.directory, log.writer_id)

    def test_writer_inventory_revision(self):
        self.log.record("call")
        first = diagnostics.writers(self.directory, limit=1)
        DiagnosticLog(self.directory).record("call")
        with self.assertRaisesRegex(ValueError, "changed"):
            diagnostics.writers(self.directory, offset=1, revision=first["revision"])

    def test_history_crosses_real_chunk_boundary(self):
        log = DiagnosticLog(self.directory)
        for value in range(1003):
            log.record("call", value=value)
        first = diagnostics.history_page(self.directory, log.writer_id, 5)
        self.assertEqual([row["value"] for row in first["records"]], [1002, 1001, 1000, 999, 998])
        next_page = diagnostics.history_page(self.directory, log.writer_id, 2, first["next_cursor"])
        self.assertEqual([row["value"] for row in next_page["records"]], [997, 996])
        oldest = self.directory / f"{log.writer_id}.0000000000.jsonl"
        oldest.unlink()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            diagnostics.history_page(self.directory, log.writer_id, 2, first["next_cursor"])


if __name__ == "__main__":
    unittest.main()
