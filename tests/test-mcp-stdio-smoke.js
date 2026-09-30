#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { builtInRecipePin } = require("../dist/workflows/project-model.js");

const repositoryRoot = path.join(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-mcp-stdio-smoke-"));

try {
  const source = fs.readFileSync(path.join(repositoryRoot, "src", "mcp.ts"), "utf8");
  const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\n\n  fs\.writeFileSync\(reqTxt/.exec(source);
  assert(match, "could not extract generated unified MCP server template");

  const moduleDirectory = path.join(root, "module");
  const store = path.join(root, "store");
  const subscriptionCache = path.join(root, "subscriptions");
  const retrievalState = path.join(root, "retrieval");
  const environmentsRegistry = path.join(root, "environments", "registry.json");
  fs.mkdirSync(moduleDirectory, { recursive: true });
  fs.mkdirSync(store, { recursive: true });

  const render = new Function(
    "UNIFIED_MCP_VERSION",
    "KNOWLEDGE_MCP_VERSION",
    "CHAT_MCP_VERSION",
    "RECIPE_MCP_VERSION",
    "AGENT_SESSION_MCP_VERSION",
    "storeFwd",
    "subscriptionCacheFwd",
    "retrievalStateFwd",
    "environmentsRegistryFwd",
    "snapshotRecipePin",
    `return \`${match[1]}\`;`,
  );
  const server = render(
    "stdio-test",
    "knowledge-test",
    "chat-test",
    "recipe-test",
    "agent-session-test",
    store.replaceAll("\\", "/"),
    subscriptionCache.replaceAll("\\", "/"),
    retrievalState.replaceAll("\\", "/"),
    environmentsRegistry.replaceAll("\\", "/"),
    builtInRecipePin("create-agent-snapshot"),
  );
  fs.writeFileSync(path.join(moduleDirectory, "server.py"), server);
  fs.writeFileSync(
    path.join(moduleDirectory, "chat_server.py"),
    fs.readFileSync(path.join(repositoryRoot, "resources", "chat_server.py.template"), "utf8")
      .replaceAll("%%CHAT_MCP_VERSION%%", "chat-test"),
  );
  for (const name of ["recipe_runtime.py", "recipe_health.py", "agent_session_runtime.py", "mcp_call_guard.py"]) {
    fs.copyFileSync(path.join(repositoryRoot, "resources", name), path.join(moduleDirectory, name));
  }

  const smokeTest = `
import asyncio
import pathlib
import sys

from fastmcp import Client
from fastmcp.client.transports import StdioTransport


async def main():
    module_directory = pathlib.Path(sys.argv[1])
    with (module_directory / "server.stderr.log").open("w", encoding="utf-8") as log:
        transport = StdioTransport(
            sys.executable,
            [str(module_directory / "server.py")],
            cwd=str(module_directory),
            log_file=log,
        )
        async with asyncio.timeout(15):
            async with Client(transport, timeout=3, init_timeout=3) as client:
                tools = await asyncio.wait_for(client.list_tools(), 3)
                by_name = {tool.name: tool for tool in tools}
                version_result = await asyncio.wait_for(client.call_tool("check_version", {}), 3)
                version = version_result.structured_content
                assert version["components"] == {
                    "knowledge": "knowledge-test",
                    "chat": "chat-test",
                    "recipes": "recipe-test",
                    "agent_sessions": "agent-session-test",
                }, version

                discovery_names = [
                    version["chat_discovery_tool"],
                    version["recipe_discovery_tool"],
                    version["agent_session_discovery_tool"],
                    version["skill_discovery_tool"],
                ]
                required_read_only = [
                    "check_version",
                    "check_chat_version",
                    *discovery_names,
                    "chat_read",
                    "chat_history",
                    "chat_standby",
                    "chat_members",
                    "chat_status",
                    "recipe_usage_summary",
                    "recipe_search",
                    "recipe_run_get",
                    "agent_session_status",
                    "agent_session_load",
                    "agent_session_snapshot_list",
                ]
                missing = sorted(set(required_read_only) - set(by_name))
                assert not missing, ("advertised tools missing from tools/list", missing)
                for name in required_read_only:
                    annotations = by_name[name].annotations
                    assert annotations is not None and annotations.readOnlyHint is True, (
                        name,
                        annotations,
                    )

                expected_component_versions = {
                    "check_chat_version": "chat-test",
                    "chat_capabilities": "chat-test",
                    "recipe_capabilities": "1.7.3",
                    "agent_session_capabilities": "1.7.6",
                }
                for name in ["check_chat_version", *discovery_names]:
                    result = await asyncio.wait_for(client.call_tool(name, {}), 3)
                    payload = result.structured_content
                    assert isinstance(payload, dict) and payload, (name, payload)
                    if name in expected_component_versions:
                        assert payload["version"] == expected_component_versions[name], (name, payload)
                    for advertised_tool in payload.get("tools", payload.get("chat_tools", [])):
                        assert advertised_tool in by_name, (name, advertised_tool)


asyncio.run(main())
`;
  const smokePath = path.join(root, "smoke.py");
  fs.writeFileSync(smokePath, smokeTest);
  execFileSync("python", [smokePath, moduleDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("MCP stdio smoke test: discovery metadata and bounded calls OK");
