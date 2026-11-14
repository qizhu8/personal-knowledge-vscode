#!/usr/bin/env python3
import asyncio
import importlib.util
import json
import pathlib
import tempfile
from types import SimpleNamespace

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "mcp_call_guard", ROOT / "resources" / "mcp_call_guard.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
LOG_SPEC = importlib.util.spec_from_file_location(
    "diagnostic_log", ROOT / "resources" / "diagnostic_log.py")
LOG_MODULE = importlib.util.module_from_spec(LOG_SPEC)
LOG_SPEC.loader.exec_module(LOG_MODULE)


async def assert_diagnostics():
    with tempfile.TemporaryDirectory() as directory:
        log = LOG_MODULE.DiagnosticLog(directory)
        middleware = MODULE.McpDiagnosticsMiddleware(log, wait_seconds=0.01)
        context = SimpleNamespace(
            message=SimpleNamespace(name="test_tool", arguments={"token": "private-argument"}),
            fastmcp_context=SimpleNamespace(session_id="private-transport", request_id="private-request"))

        async def complete(call_context):
            assert log.latest(1)[0]["event"] == "mcp.call.started"
            return "private-result"

        assert await middleware.on_call_tool(context, complete) == "private-result"
        records = log.latest(10)
        assert [entry["event"] for entry in records] == ["mcp.call.started", "mcp.call.returned"]
        assert records[0]["callId"] == records[1]["callId"]

        async def fail(call_context):
            raise RuntimeError("private-error")

        try:
            await middleware.on_call_tool(context, fail)
            raise AssertionError("Exception was swallowed")
        except RuntimeError:
            pass
        assert log.latest(1)[0]["event"] == "mcp.call.failed"

        waiting = asyncio.Event()
        original_record = log.record

        def observe(event, **fields):
            original_record(event, **fields)
            if event == "mcp.call.waiting":
                waiting.set()

        log.record = observe

        async def block(call_context):
            await asyncio.Event().wait()

        task = asyncio.create_task(middleware.on_call_tool(context, block))
        await asyncio.wait_for(waiting.wait(), 1)
        task.cancel()
        try:
            await task
            raise AssertionError("Cancellation was swallowed")
        except asyncio.CancelledError:
            pass
        assert log.latest(1)[0]["event"] == "mcp.call.cancelled"
        assert "private-" not in json.dumps(log.latest(100))


def error_payload(error):
    text = str(error)
    start = text.find('{"error":')
    if start < 0:
        start = text.find('{"schema":')
    return json.loads(text[start:])


async def main():
    await assert_diagnostics()
    calls = []
    mcp = FastMCP("call-guard-test")

    @mcp.tool()
    def guarded_tool(required_value: str, optional_count: int = 1):
        calls.append((required_value, optional_count))
        return {"ok": True}

    mcp.add_middleware(MODULE.McpCallGuardMiddleware(mcp))

    async with Client(mcp) as client:
        malformed = {"serverName": "pkm", "toolName": "guarded_tool"}
        for attempt in (1, 2, 3):
            try:
                await client.call_tool("guarded_tool", malformed)
                raise AssertionError("Malformed tool call unexpectedly executed.")
            except ToolError as error:
                payload = error_payload(error)
                detail = payload["error"]
                assert payload["schema"] == "pkm.mcp.tool-error/v1"
                assert detail["code"] == (
                    "repeated-invalid-tool-call" if attempt > 2
                    else "invalid-tool-arguments")
                assert detail["retryable"] is False
                assert detail["tool"] == "guarded_tool"
                if attempt <= 2:
                    assert detail["receivedFields"] == ["serverName", "toolName"]
                    assert detail["unexpectedFields"] == ["serverName", "toolName"]
                    assert detail["missingFields"] == ["required_value"]
                    assert detail["requiredFields"] == ["required_value"]
                    assert detail["allowedFields"] == ["optional_count", "required_value"]
                    assert detail["exampleArguments"] == {"required_value": "<required>"}
                else:
                    assert detail["blocked"] is True
                assert detail["attemptCount"] == attempt
                assert detail["loopDetected"] is (attempt > 1)
                assert detail["action"] == (
                    "stop-and-correct" if attempt > 1 else "correct-arguments")
        assert calls == []

        result = await client.call_tool("guarded_tool", {
            "required_value": "valid",
            "optional_count": 2,
        })
        assert json.loads(result.content[0].text)["ok"] is True
        assert calls == [("valid", 2)]


if __name__ == "__main__":
    asyncio.run(main())
