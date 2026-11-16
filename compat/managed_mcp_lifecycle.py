"""Active admission/drain state; never create or scan a diagnostic registry."""

import asyncio
import json
import os
from pathlib import Path
import re
import time
import uuid

from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware
from mcp_call_guard import LIFECYCLE_SCHEMA, managed_mcp_launch_attribution


class ManagedMcpLifecycle(Middleware):
    def __init__(self, manifest, drain_seconds=30, poll_seconds=0.25):
        self.manifest = manifest
        self.root = Path(manifest["managedRoot"])
        self.generation = manifest["generation"]
        self.instance_id = uuid.uuid4().hex
        self.attribution = managed_mcp_launch_attribution()
        self.drain_seconds = drain_seconds
        self.poll_seconds = poll_seconds
        self.in_flight = {}
        self.drain_started = None
        self.fenced = False
        self.control_error = ""
        self.superseded = False
        self.update_available = False
        self.active_messages = 0
        self.last_activity = time.monotonic()
        self.retired = False

    @classmethod
    def from_directory(cls, directory):
        manifest_path = Path(directory) / "manifest.json"
        if not manifest_path.is_file():
            return None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest.get("schema") != LIFECYCLE_SCHEMA
                or Path(directory).resolve() != (
                    Path(manifest["managedRoot"]) / "generations"
                    / manifest["generation"]).resolve()):
            raise RuntimeError("Invalid managed MCP runtime ownership.")
        return cls(manifest)

    def _refresh(self):
        try:
            baseline = json.loads((self.root / "active-generation.json").read_text(encoding="utf-8"))
            latest = self.root / "latest-generation.json"
            active = json.loads(latest.read_text(encoding="utf-8")) if latest.exists() else baseline
            if (not isinstance(baseline, dict) or not isinstance(active, dict)
                    or baseline.get("schema") != LIFECYCLE_SCHEMA
                    or not isinstance(baseline.get("generation"), str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", baseline["generation"])
                    or baseline["generation"] != active.get("generation")
                        and baseline.get("compatibilityBaseline") is not True):
                raise ValueError("Invalid compatibility baseline")
            if (active.get("schema") != LIFECYCLE_SCHEMA
                    or not isinstance(active.get("generation"), str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", active["generation"])):
                raise ValueError("Invalid active generation")
            self.superseded = active["generation"] != self.generation
            compatible = False
            if self.superseded:
                try:
                    successor = json.loads((self.root / "generations" / active["generation"]
                                            / "manifest.json").read_text(encoding="utf-8"))
                except FileNotFoundError:
                    successor = {}
                if not isinstance(successor, dict):
                    raise ValueError("Invalid successor manifest")
                contract = self.manifest.get("compatibility")
                own_domains = self.manifest.get("enabledFeatureDomains", [])
                next_domains = successor.get("enabledFeatureDomains", [])
                compatible = (isinstance(contract, dict)
                              and contract.get("protocol") == "pkm.mcp.api/1"
                              and isinstance(contract.get("components"), dict)
                              and bool(contract["components"])
                              and all(isinstance(name, str) and isinstance(major, str)
                                      and re.fullmatch(r"\d+", major)
                                      for name, major in contract["components"].items())
                              and isinstance(successor.get("compatibility"), dict)
                              and successor["compatibility"].get("protocol") == contract["protocol"]
                              and isinstance(successor["compatibility"].get("components"), dict)
                              and all(successor["compatibility"]["components"].get(name) == major
                                      for name, major in contract["components"].items())
                              and successor.get("schema") == LIFECYCLE_SCHEMA
                              and successor.get("generation") == active["generation"]
                              and isinstance(own_domains, list) and isinstance(next_domains, list)
                              and all(isinstance(domain, str) for domain in own_domains + next_domains)
                              and set(own_domains) <= set(next_domains))
            self.update_available = self.superseded and compatible
            must_fence = (self.superseded and not compatible
                          or (self.root / "runtime-maintenance.json").exists()
                          or (self.manifest.get("runtimeMaintenance")
                              and Path(self.manifest["runtimeMaintenance"]).exists()))
            self.control_error = ""
        except (OSError, ValueError):
            must_fence = True
            self.superseded = False
            self.update_available = False
            self.control_error = "generation-control-unavailable"
        if must_fence and not self.fenced:
            self.fenced = True
            self.drain_started = time.monotonic()

    def status(self):
        self._refresh()
        elapsed = 0 if self.drain_started is None else time.monotonic() - self.drain_started
        phase = "accepting"
        if self.fenced:
            phase = "drained" if not self.in_flight else (
                "action-required" if elapsed >= self.drain_seconds else "draining")
        if self.retired:
            phase = "retired"
        return {
            "schema": LIFECYCLE_SCHEMA, "generation": self.generation,
            "instanceId": self.instance_id, "pid": os.getpid(),
            "attribution": dict(self.attribution),
            "version": self.manifest["version"], "components": self.manifest["components"],
            "runtimeBuild": self.manifest.get("runtimeBuild", ""),
            "extensionVersion": self.manifest.get("extensionVersion", ""),
            "phase": phase, "acceptingNewCalls": not self.fenced,
            "inFlight": len(self.in_flight),
            "uncertainCalls": sum(call["uncertain"] for call in self.in_flight.values()),
            "drainDeadlineExceeded": bool(self.in_flight) and elapsed >= self.drain_seconds,
            "drainTimeoutSeconds": self.drain_seconds,
            "action": "none" if not self.fenced else (
                "reconnect" if not self.in_flight else "wait-or-review-uncertain-writes"),
            "automaticReplay": False, "automaticTermination": False,
            "gracefulRetirement": True,
            "updateAvailable": self.update_available,
            "compatibility": "compatible-update" if self.update_available else "current" if not self.superseded else "reconnect-required",
            "controlError": self.control_error,
        }

    def quiesce(self):
        if not self.fenced:
            self.fenced = True
            self.drain_started = time.monotonic()
        return self.status()

    async def on_message(self, context, call_next):
        self.active_messages += 1
        try:
            return await call_next(context)
        finally:
            self.active_messages -= 1
            self.last_activity = time.monotonic()

    async def wait_for_retirement(self):
        while True:
            # Only generation/maintenance controls are polled, never instance history.
            self._refresh()
            if (self.fenced and self.superseded and not self.control_error
                    and not self.in_flight and not self.active_messages
                    and time.monotonic() - self.last_activity >= 1):
                return
            await asyncio.sleep(self.poll_seconds)

    async def on_call_tool(self, context, call_next):
        self._refresh()
        name = str(getattr(context.message, "name", "") or "")
        if name in {"check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"}:
            return await call_next(context)
        if self.fenced:
            raise ToolError(json.dumps({
                "schema": LIFECYCLE_SCHEMA, "ok": False,
                "code": "managed-runtime-superseded", "retryable": False,
                "action": "reconnect-and-verify", "automaticReplay": False,
                "message": "This managed runtime no longer accepts new tools. "
                "Reconnect and verify the successor. Never replay an uncertain write automatically.",
                "runtime": self.status(),
            }, separators=(",", ":")))
        # No await between the generation fence and admission.
        call_id = uuid.uuid4().hex
        self.in_flight[call_id] = {"uncertain": False}
        execution = asyncio.create_task(call_next(context))

        def completed(task):
            self.last_activity = time.monotonic()
            if task.cancelled():
                # Cancellation cannot prove a worker thread stopped mutating files.
                if call_id in self.in_flight:
                    self.in_flight[call_id]["uncertain"] = True
                return
            self.in_flight.pop(call_id, None)
            task.exception()

        execution.add_done_callback(completed)
        try:
            return await asyncio.shield(execution)
        except asyncio.CancelledError:
            if call_id in self.in_flight:
                self.in_flight[call_id]["uncertain"] = True
            raise


async def run_managed_stdio(server, lifecycle):
    if lifecycle is None:
        await server.run_stdio_async()
        return
    import sys
    import anyio
    from mcp.server.stdio import stdio_server
    from fastmcp.server.context import reset_transport, set_transport

    class CancellableStdin:
        def __init__(self):
            self.buffer = b""
            if sys.platform == "win32":
                import ctypes
                import msvcrt
                from ctypes import wintypes
                self.handle = msvcrt.get_osfhandle(sys.stdin.fileno())
                self.peek = ctypes.WinDLL("kernel32", use_last_error=True).PeekNamedPipe
                self.peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                      wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
                self.peek.restype = wintypes.BOOL

        def __aiter__(self):
            return self

        async def read(self):
            if sys.platform == "win32":
                import ctypes
                from ctypes import wintypes
                while True:
                    available = wintypes.DWORD()
                    if not self.peek(self.handle, None, 0, None, ctypes.byref(available), None):
                        code = ctypes.get_last_error()
                        if code in {109, 232}:
                            return b""
                        raise ctypes.WinError(code)
                    if available.value:
                        break
                    await anyio.sleep(0.05)
            else:
                await anyio.wait_readable(sys.stdin.fileno())
            return os.read(sys.stdin.fileno(), 8192)

        async def __anext__(self):
            while b"\n" not in self.buffer:
                chunk = await self.read()
                if not chunk:
                    if not self.buffer:
                        raise StopAsyncIteration
                    line, self.buffer = self.buffer, b""
                    return line.decode("utf-8", errors="replace")
                self.buffer += chunk
            line, self.buffer = self.buffer.split(b"\n", 1)
            return (line + b"\n").decode("utf-8", errors="replace")

    class DrainingStdout:
        async def write(self, value):
            def write_and_flush():
                sys.stdout.buffer.write(value.encode("utf-8"))
                sys.stdout.buffer.flush()

            lifecycle.active_messages += 1
            try:
                # A retirement receipt must not cut between response write and flush.
                await anyio.to_thread.run_sync(write_and_flush)
            finally:
                lifecycle.active_messages -= 1
                lifecycle.last_activity = time.monotonic()

        async def flush(self):
            pass

    async def serve(group):
        token = set_transport("stdio")
        try:
            async with server._lifespan_manager():
                async with stdio_server(stdin=CancellableStdin(), stdout=DrainingStdout()) as (reader, writer):
                    await server._mcp_server.run(reader, writer, server._mcp_server.create_initialization_options())
        finally:
            reset_transport(token)
            group.cancel_scope.cancel()

    async with anyio.create_task_group() as group:
        group.start_soon(serve, group)
        await lifecycle.wait_for_retirement()
        group.cancel_scope.cancel()
    if lifecycle.superseded and not lifecycle.in_flight and not lifecycle.control_error:
        lifecycle.retired = True
