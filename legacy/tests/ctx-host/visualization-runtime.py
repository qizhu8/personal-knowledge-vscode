"""Isolated installed-resource MCP fixture; all runs are created by real runtimes."""
import json
import platform
from pathlib import Path
import sys


extension, directory, port = sys.argv[1:]
root = Path(directory).resolve()
store = root / "knowledge"
sys.path.insert(0, str(Path(extension) / "resources"))

from fastmcp import FastMCP
from action_modules import ModuleRuntime
from action_runtime import ActionRuntime, register_action_tools
from recipe_runtime import register_recipe_tools


runtime = ModuleRuntime(store)
runtime.configure_workspace(str(root / "workspace"))


def pipeline(identifier, steps, dependencies=None):
    definition = runtime.register({
        "schema": "pkm.action.definition/v1", "action_id": identifier, "version": 1,
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
        "output_schema": {"type": "object", "properties": {"value": {}}, "required": ["value"]},
        "effects": ["pure"], "dependencies": dependencies or {},
        "examples": [{"inputs": {}}],
        "implementations": [{
            "kind": "pipeline", "platforms": [platform.system()], "steps": steps,
            "output": {"value": {"$step": steps[-1]["id"] + ".value"}},
        }],
    })
    validation = runtime.validate(identifier, definition["content_hash"])
    if not validation["ok"]:
        raise RuntimeError("VIS Action qualification failed: " + json.dumps(validation))
    return definition


child = pipeline("fixture.vis.child", [
    {"id": "before", "component": "core.constant", "inputs": {"value": "VIS_BEFORE_WAIT"}},
    {"id": "pause", "component": "core.wait", "inputs": {
        "trigger": {"kind": "event", "name": "vis-release"}}},
    {"id": "after", "component": "core.constant", "inputs": {"value": "VIS_COMPONENT_COMPLETE"}},
])
parent = pipeline("fixture.vis.parent", [
    {"id": "nested", "action_id": child["action_id"], "inputs": {}},
], {child["action_id"]: child["content_hash"]})

server = FastMCP("VIS isolated installed runtime")
register_recipe_tools(server, store)
register_action_tools(server, store, ActionRuntime(store))
(root / "vis-runtime-ready.json").write_text(json.dumps({
    "actionId": parent["action_id"], "contentHash": parent["content_hash"],
}), encoding="utf-8")
server.run(transport="http", host="127.0.0.1", port=int(port), show_banner=False)
