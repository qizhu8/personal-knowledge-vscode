"""Uniform, actionable feedback for malformed PKM MCP tool calls."""

import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from collections import OrderedDict
from pathlib import Path

from fastmcp.exceptions import ValidationError as FastMCPValidationError
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware


ERROR_SCHEMA = "pkm.mcp.tool-error/v1"
MAX_INVALID_CALL_FINGERPRINTS = 256
LIFECYCLE_SCHEMA = "pkm.mcp.lifecycle/v1"


class ManagedMcpLifecycle(Middleware):
    """Fence new calls; only retire a superseded server after real calls drain."""

    def __init__(self, manifest, drain_seconds=30, poll_seconds=0.25):
        self.manifest = manifest
        self.root = Path(manifest["managedRoot"])
        self.generation = manifest["generation"]
        self.instance_id = uuid.uuid4().hex
        self.drain_seconds = drain_seconds
        self.poll_seconds = poll_seconds
        self.in_flight = {}
        self.drain_started = None
        self.fenced = False
        self.control_error = ""
        self.registry_failed = False
        self.monitor = None
        self.superseded = False
        self.update_available = False
        self.active_messages = 0
        self.last_activity = time.monotonic()
        self.retired = False
        self.registry = self.root / "instances" / (self.instance_id + ".json")
        self.registry.parent.mkdir(parents=True, exist_ok=True)
        self._publish()

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
            superseded = (self.superseded and not compatible
                          or (self.root / "runtime-maintenance.json").exists()
                          or (self.manifest.get("runtimeMaintenance")
                              and Path(self.manifest["runtimeMaintenance"]).exists()))
            self.control_error = "instance-registry-unavailable" if self.registry_failed else ""
        except (OSError, ValueError):
            superseded = True
            self.superseded = False
            self.update_available = False
            self.control_error = "generation-control-unavailable"
        if superseded and not self.fenced:
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
        self._publish()
        return self.status()

    def _publish(self):
        payload = {**self.status(), "heartbeatAt": time.time()}
        temporary = self.registry.with_suffix(".pending")
        try:
            temporary.write_text(_json(payload) + "\n", encoding="utf-8")
            os.replace(temporary, self.registry)
        except OSError:
            # Losing lifecycle observability is not proof that a write has drained.
            self.fenced = True
            self.registry_failed = True
            self.control_error = "instance-registry-unavailable"
            if self.drain_started is None:
                self.drain_started = time.monotonic()
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    async def _watch(self):
        while True:
            await asyncio.sleep(self.poll_seconds)
            self._publish()

    async def on_message(self, context, call_next):
        if self.monitor is None or self.monitor.done():
            self.monitor = asyncio.create_task(self._watch())
        self.active_messages += 1
        try:
            return await call_next(context)
        finally:
            self.active_messages -= 1
            self.last_activity = time.monotonic()

    async def wait_for_retirement(self):
        while True:
            self._publish()
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
            self._publish()
            raise ToolError(_json({
                "schema": LIFECYCLE_SCHEMA, "ok": False,
                "code": "managed-runtime-superseded", "retryable": False,
                "action": "reconnect-and-verify", "automaticReplay": False,
                "message": "This managed runtime no longer accepts new tools. "
                "Reconnect and verify the successor. Never replay an uncertain write automatically.",
                "runtime": self.status(),
            }))
        # No await between the generation fence and admission.
        call_id = uuid.uuid4().hex
        self.in_flight[call_id] = {"uncertain": False}
        self._publish()
        execution = asyncio.create_task(call_next(context))

        def completed(task):
            self.last_activity = time.monotonic()
            if task.cancelled():
                # Runtime/transport shutdown may cancel the task while a worker
                # thread is still mutating files. This is not a drain receipt.
                if call_id in self.in_flight:
                    self.in_flight[call_id]["uncertain"] = True
                self._publish()
                return
            self.in_flight.pop(call_id, None)
            # A disconnected caller may no longer be waiting to retrieve an exception.
            task.exception()
            self._publish()

        execution.add_done_callback(completed)
        try:
            # Client cancellation is not proof that synchronous/threaded writes stopped.
            return await asyncio.shield(execution)
        except asyncio.CancelledError:
            if call_id in self.in_flight:
                self.in_flight[call_id]["uncertain"] = True
            self._publish()
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
            # A blocking stdin worker can outlive the stdio session and prevent
            # process exit. Poll only our read pipe, never cancel real tools.
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
                # Flush the complete response in one shielded operation, so
                # retirement cannot cut between a buffered write and flush.
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

    try:
        async with anyio.create_task_group() as group:
            group.start_soon(serve, group)
            await lifecycle.wait_for_retirement()
            # Admission is fenced and real executions finished. Close our own
            # transport normally; no signal, external PID, or client replay.
            group.cancel_scope.cancel()
        if lifecycle.superseded and not lifecycle.in_flight and not lifecycle.control_error:
            lifecycle.retired = True
            lifecycle._publish()
    finally:
        if lifecycle.monitor is not None:
            lifecycle.monitor.cancel()
            await asyncio.gather(lifecycle.monitor, return_exceptions=True)


class McpDiagnosticsMiddleware(Middleware):
    def __init__(self, log, wait_seconds=30):
        self.log = log
        self.wait_seconds = wait_seconds

    async def on_call_tool(self, context, call_next):
        started = time.perf_counter()
        call_id = uuid.uuid4().hex
        message = getattr(context, "message", None)
        fastmcp_context = getattr(context, "fastmcp_context", None)
        tool_name = str(getattr(message, "name", "") or "")
        if not tool_name or len(tool_name) > 80 or not all(
                character.isascii() and (character.isalnum() or character == "_")
                for character in tool_name):
            tool_name = "invalid-tool-name"
        fields = {
            "callId": call_id,
            "tool": tool_name,
            "transportId": hashlib.sha256(str(getattr(fastmcp_context, "session_id", "") or "").encode()).hexdigest()[:24],
            "requestId": hashlib.sha256(str(getattr(fastmcp_context, "request_id", "") or "").encode()).hexdigest()[:24],
        }
        self.log.record("mcp.call.started", **fields)

        async def record_waiting():
            while True:
                await asyncio.sleep(self.wait_seconds)
                self.log.record("mcp.call.waiting", **fields,
                                durationMs=round((time.perf_counter() - started) * 1000))

        watchdog = asyncio.create_task(record_waiting())
        try:
            result = await call_next(context)
        except BaseException as error:
            self.log.record(
                "mcp.call.cancelled" if isinstance(error, asyncio.CancelledError) else "mcp.call.failed",
                **fields, durationMs=round((time.perf_counter() - started) * 1000),
                errorType=type(error).__name__)
            raise
        else:
            self.log.record("mcp.call.returned", **fields,
                            durationMs=round((time.perf_counter() - started) * 1000))
            return result
        finally:
            watchdog.cancel()
            try:
                await watchdog
            except asyncio.CancelledError:
                pass


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _placeholder(schema):
    if "default" in schema:
        return schema["default"]
    schema_type = schema.get("type")
    if schema_type == "array":
        return []
    if schema_type == "object":
        return {}
    if schema_type in {"integer", "number"}:
        return 0
    if schema_type == "boolean":
        return False
    return "<required>"


def _argument_contract(tool):
    schema = tool.parameters if tool is not None and isinstance(tool.parameters, dict) else {}
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = [
        str(name) for name in (schema.get("required") or [])
        if str(name) in properties
    ]
    return {
        "allowedFields": sorted(str(name) for name in properties),
        "requiredFields": required,
        "exampleArguments": {
            name: _placeholder(properties[name])
            for name in required
        },
    }


class McpCallGuardMiddleware(Middleware):
    def __init__(self, server):
        self.server = server
        self.invalid_calls = OrderedDict()

    def _fingerprint(self, context, tool_name, arguments):
        fastmcp_context = context.fastmcp_context
        transport_id = str(getattr(fastmcp_context, "session_id", "") or "unknown")
        return hashlib.sha256(
            (transport_id + "\0" + tool_name + "\0" + _json(arguments)).encode("utf-8")
        ).hexdigest()

    def _record_invalid_call(self, context, tool_name, arguments):
        fingerprint = self._fingerprint(
            context, tool_name, arguments)
        count = int(self.invalid_calls.pop(fingerprint, 0)) + 1
        self.invalid_calls[fingerprint] = count
        while len(self.invalid_calls) > MAX_INVALID_CALL_FINGERPRINTS:
            self.invalid_calls.popitem(last=False)
        return count

    async def on_call_tool(self, context, call_next):
        message = context.message
        tool_name = str(getattr(message, "name", "") or "")
        arguments = getattr(message, "arguments", None)
        arguments = arguments if isinstance(arguments, dict) else {}
        fingerprint = self._fingerprint(context, tool_name, arguments)
        previous_attempts = int(self.invalid_calls.get(fingerprint, 0))
        if previous_attempts >= 2:
            self.invalid_calls.move_to_end(fingerprint)
            self.invalid_calls[fingerprint] = previous_attempts + 1
            raise FastMCPValidationError(_json({
                "schema": ERROR_SCHEMA,
                "ok": False,
                "error": {
                    "code": "repeated-invalid-tool-call",
                    "category": "caller",
                    "retryable": False,
                    "tool": tool_name,
                    "message": "This unchanged invalid call is blocked. Correct its arguments before retrying.",
                    "attemptCount": previous_attempts + 1,
                    "loopDetected": True,
                    "blocked": True,
                    "action": "stop-and-correct",
                },
            }))
        try:
            return await call_next(context)
        except FastMCPValidationError as error:
            if ERROR_SCHEMA in str(error):
                raise
            tool = await self.server.get_tool(tool_name)
            attempt_count = self._record_invalid_call(
                context, tool_name, arguments)
            contract = _argument_contract(tool)
            received_fields = sorted(str(name) for name in arguments)
            unexpected_fields = [
                name for name in received_fields
                if name not in contract["allowedFields"]
            ]
            missing_fields = [
                name for name in contract["requiredFields"]
                if name not in arguments
            ]
            repeated = attempt_count > 1
            payload = {
                "schema": ERROR_SCHEMA,
                "ok": False,
                "error": {
                    "code": "invalid-tool-arguments",
                    "category": "caller",
                    "retryable": False,
                    "tool": tool_name,
                    "message": (
                        "This identical invalid tool call was already rejected. "
                        "Stop retrying it unchanged and correct the arguments."
                        if repeated else
                        "Tool arguments do not match the advertised schema. "
                        "Correct the arguments before calling the tool again."
                    ),
                    "receivedFields": received_fields,
                    "unexpectedFields": unexpected_fields,
                    "missingFields": missing_fields,
                    **contract,
                    "attemptCount": attempt_count,
                    "loopDetected": repeated,
                    "action": "stop-and-correct" if repeated else "correct-arguments",
                },
            }
            raise FastMCPValidationError(_json(payload)) from error
