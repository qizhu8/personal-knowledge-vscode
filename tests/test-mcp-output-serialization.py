#!/usr/bin/env python3
import argparse
import asyncio
import importlib.util
import json
import pathlib
import tempfile

import yaml
from fastmcp import Client, FastMCP
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "session_output_probe", ROOT / "resources" / "agent_session_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


def text_size(text):
    return len(text.encode("utf-8"))


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokens", action="store_true",
                        help="Estimate text tokens with tiktoken; not Copilot billing measurements")
    args = parser.parse_args()
    encodings = {}
    if args.tokens:
        import tiktoken
        encodings = {name: tiktoken.get_encoding(name)
                     for name in ("cl100k_base", "o200k_base")}
    measurements = []
    with tempfile.TemporaryDirectory(prefix="pkm-output-probe-") as temporary:
        server = FastMCP("pkm-output-probe")
        RUNTIME.register_agent_session_tools(server, pathlib.Path(temporary))

        @server.tool(output_schema=None)
        def single_representation(payload: dict, format: str = "json") -> ToolResult:
            if format == "yaml":
                text = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
            elif format == "json":
                text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            else:
                raise ValueError("format must be json or yaml")
            return ToolResult(content=[TextContent(type="text", text=text)])

        async with Client(server) as client:
            definitions = {tool.name: tool for tool in await client.list_tools()}
            assert definitions["single_representation"].outputSchema is None
            assert definitions["agent_session_status"].outputSchema is not None
            unmanaged = await client.call_tool_mcp("agent_session_status", {})
            await client.call_tool("agent_session_start", {
                "task": "Output serialization experiment", "command_id": "output-probe-start"})
            todos = [{"title": "Task {}".format(index),
                      "details": "Verify contracts, preserve recovery identity, and record validation evidence."}
                     for index in range(100)]
            await client.call_tool("agent_session_todo_append", {
                "todos_json": json.dumps(todos), "command_id": "output-probe-append"})
            await client.call_tool("agent_session_todo_next", {"command_id": "output-probe-next"})
            compact = await client.call_tool_mcp("agent_session_status", {})
            full = await client.call_tool_mcp("agent_session_status", {"detail": "full"})
            for name, baseline in (("unmanaged", unmanaged), ("compact-100-todos", compact),
                                   ("full-100-todos", full)):
                payload = baseline.structuredContent
                assert isinstance(payload, dict)
                assert json.loads(baseline.content[0].text) == payload
                results = {}
                for format in ("json", "yaml"):
                    result = await client.call_tool_mcp("single_representation", {
                        "payload": payload, "format": format})
                    assert not result.isError
                    assert result.structuredContent is None
                    assert len(result.content) == 1
                    text = result.content[0].text
                    restored = yaml.safe_load(text) if format == "yaml" else json.loads(text)
                    assert restored == payload
                    results[format] = {
                        "text_bytes": text_size(text),
                        "wire_bytes": text_size(result.model_dump_json(exclude_none=True)),
                    }
                    if encodings:
                        results[format]["estimated_text_tokens"] = {
                            name: len(encoding.encode(text, disallowed_special=()))
                            for name, encoding in encodings.items()
                        }
                measurements.append({
                    "case": name,
                    "baseline_text_bytes": text_size(baseline.content[0].text),
                    "baseline_wire_bytes": text_size(baseline.model_dump_json(exclude_none=True)),
                    "single_json": results["json"],
                    "single_yaml": results["yaml"],
                })
            tricky = {"date": "2026-10-02", "boolean": "false", "null": "null",
                      "multiline": "first\nsecond", "markup": "</pre><script>text</script>",
                      "nested": {"empty": [], "flag": False, "nothing": None}}
            result = await client.call_tool_mcp("single_representation", {"payload": tricky, "format": "yaml"})
            assert yaml.safe_load(result.content[0].text) == tricky
    print(json.dumps({"status": "passed", "measurement": "UTF-8 bytes and optional text-token estimates, not Copilot billing",
                      "measurements": measurements}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())