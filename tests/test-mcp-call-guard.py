#!/usr/bin/env python3
import asyncio
import importlib.util
import json
import pathlib

from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "mcp_call_guard", ROOT / "resources" / "mcp_call_guard.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def error_payload(error):
    text = str(error)
    start = text.find('{"error":')
    if start < 0:
        start = text.find('{"schema":')
    return json.loads(text[start:])


async def main():
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
