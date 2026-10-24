#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repositoryRoot = path.resolve(process.env.PKM_TEST_EXTENSION_PATH || path.join(__dirname, ".."));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-mcp-stdio-smoke-"));

try {
  const source = fs.readFileSync(path.join(repositoryRoot,
    process.env.PKM_TEST_EXTENSION_PATH ? "dist/mcp/mcp.js" : "src/mcp/mcp.ts"), "utf8");
  const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\s+fs\.writeFileSync\(reqTxt/.exec(source);
  assert(match, "could not extract generated unified MCP server template");
  const componentVersions = Object.fromEntries(["RECIPE_MCP_VERSION", "AGENT_SESSION_MCP_VERSION"].map(name => {
    const version = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`).exec(source);
    assert(version, `could not extract ${name}`);
    return [name, version[1]];
  }));

  const moduleDirectory = path.join(root, "module");
  const store = path.join(root, "store");
  const subscriptionCache = path.join(root, "subscriptions");
  const retrievalState = path.join(root, "retrieval");
  const environmentsRegistry = path.join(root, "environments", "registry.json");
  fs.mkdirSync(moduleDirectory, { recursive: true });
  fs.mkdirSync(store, { recursive: true });

  const render = new Function(
    "exports",
    "UNIFIED_MCP_VERSION",
    "KNOWLEDGE_MCP_VERSION",
    "CHAT_MCP_VERSION",
    "RECIPE_MCP_VERSION",
    "AGENT_SESSION_MCP_VERSION",
    "storeFwd",
    "subscriptionCacheFwd",
    "retrievalStateFwd",
    "environmentsRegistryFwd",
    "context",
    `return \`${match[1]}\`;`,
  );
  const server = render(
    { UNIFIED_MCP_VERSION: "stdio-test" },
    "stdio-test",
    "knowledge-test",
    "chat-test",
    "recipe-test",
    "agent-session-test",
    store.replaceAll("\\", "/"),
    subscriptionCache.replaceAll("\\", "/"),
    retrievalState.replaceAll("\\", "/"),
    environmentsRegistry.replaceAll("\\", "/"),
    { extensionPath: repositoryRoot },
  );
  fs.writeFileSync(path.join(moduleDirectory, "server.py"), server);
  fs.writeFileSync(
    path.join(moduleDirectory, "chat_server.py"),
    fs.readFileSync(path.join(repositoryRoot, "resources", "chat_server.py.template"), "utf8")
      .replaceAll("%%CHAT_MCP_VERSION%%", "chat-test"),
  );
  for (const name of ["recipe_runtime.py", "action_runtime.py", "action_modules.py", "action_authoring.py", "action_monitoring.py", "action_azuredevops.py", "action_run_store.py", "action_recovery.py", "action_components.py", "recipe_health.py", "agent_session_runtime.py", "api_chat_control.py", "mcp_call_guard.py", "diagnostic_log.py"]) {
    fs.copyFileSync(path.join(repositoryRoot, "resources", name), path.join(moduleDirectory, name));
  }
  for (const name of ["knowledge_recovery.py", "knowledge_mutations.py", "knowledge_mutations.js", "knowledge_snapshots.py", "asset_classification.py", "asset_classification.js"]) {
    fs.copyFileSync(path.join(repositoryRoot, "resources", name), path.join(moduleDirectory, name));
  }

  const smokeTest = `
import asyncio
import ast
import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import types
import uuid
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastmcp import Client
from fastmcp.exceptions import ToolError
from fastmcp.client.transports import StdioTransport


def verify_module_usage(module_directory):
  store = module_directory.parent / "store"
  helper_names = {"_now", "_tool_domain", "_plain_value", "_usage_metrics", "_active_todo_attribution",
          "_increment_usage_bucket", "_record_todo_usage", "_record_tool_usage"}
  server_ast = ast.parse((module_directory / "server.py").read_text(encoding="utf-8"))
  helpers = ast.Module(body=[node for node in server_ast.body if isinstance(node, ast.FunctionDef) and node.name in helper_names], type_ignores=[])
  namespace = {**globals(), "STORE":store, "_COLLECTOR_SESSION_ID":"usage-test", "_SKILL_ROUTER_TOOLS":set()}
  exec(compile(helpers, "generated-usage-helpers", "exec"), namespace)
  assert namespace["_tool_domain"]("api_chat_send") == "automation"
  assert namespace["_tool_domain"]("action_call") == "automation"
  session_id, todo_id, run_id = "agent_session_usage", "todo_usage", "recipe_run_usage"
  sessions = store / ".pkm" / "state" / "agent-sessions"
  runs = store / ".pkm" / "state" / "recipe-runs"
  (sessions / "active").mkdir(parents=True)
  runs.mkdir(parents=True)
  (sessions / (session_id + ".json")).write_text(json.dumps({"schema":"pkm.agent.session/v1", "sessionId":session_id,
    "recipeRunIds":[run_id], "todos":[{"todoId":todo_id,"status":"running"}]}))
  (runs / (run_id + ".json")).write_text(json.dumps({"schema":"pkm.recipe.run/v1", "runId":run_id,"nodes":{"first":{},"second":{}}}))
  transport_key = hashlib.sha256(b"usage-transport").hexdigest()
  (sessions / "active" / (transport_key + ".json")).write_text(json.dumps({"sessionId":session_id}))
  context = types.SimpleNamespace(fastmcp_context=types.SimpleNamespace(session_id="usage-transport"))
  attribution = namespace["_active_todo_attribution"](context, {"run_id":run_id,"node_id":"first"})
  assert attribution.get("recipeRunId") == run_id and attribution.get("nodeId") == "first", attribution
  for success in [True,False]:
    namespace["_record_tool_usage"]("recipe_run_progress", {"run_id":run_id,"node_id":"first"}, {}, 4, success, attribution)
  unassigned = namespace["_active_todo_attribution"](context, {"run_id":"recipe_run_foreign","node_id":"first"})
  assert "recipeRunId" not in unassigned
  assert "nodeId" not in namespace["_active_todo_attribution"](context, {"run_id":run_id,"node_id":"missing"})
  namespace["_record_tool_usage"]("get_note", {}, {}, 2, True, unassigned)
  aggregate = json.loads((store / ".pkm" / "state" / "mcp-usage" / "todos" / session_id / (todo_id + ".json")).read_text())
  assert aggregate["calls"] == 3 and len(aggregate["modules"]) == 1, aggregate
  module = aggregate["modules"][run_id + ":first"]
  assert module["calls"] == 2 and module["successes"] == 1 and module["estimatedTokens"] > 0, module
  events = [json.loads(filename.read_text()) for filename in (store / ".pkm" / "state" / "mcp-usage" / "events").glob("*.json")]
  assert sum(event.get("nodeId") == "first" for event in events) == 2, events


class RetrievalBridge:
    def __enter__(self):
        self.calls = []
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                assert self.headers["X-PKM-Retrieval-Token"] == "local-stdio-fixture"
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append((self.path, data))
                status = 200
                if self.path == "/search":
                    model = data["route"] in {"semantic", "dual"}
                    result = {"ok": True, "hits": [], "model_invoked": model,
                        "retrieval_id": "stdio-receipt" if model else None,
                        "adaptive": {"applied": False, "original_count": data.get("output_limit", data["limit"]), "returned_count": 0}}
                elif data["retrieval_id"] == "expired":
                    status, result = 404, {"ok": False, "error": "Unknown or expired receipt"}
                elif not data["complete"]:
                    status, result = 400, {"ok": False, "error": "Complete relevance judgments required"}
                else:
                    result = {"ok": True, "recall": 1.0}
                encoded = json.dumps(result).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        state = pathlib.Path(sys.argv[1]).parent / "retrieval"
        state.mkdir()
        (state / "worker.json").write_text(json.dumps({"port": self.server.server_port, "token": "local-stdio-fixture"}))
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        assert not self.thread.is_alive()


async def main(bridge):
    module_directory = pathlib.Path(sys.argv[1])
    verify_module_usage(module_directory)
    sys.path.insert(0, str(module_directory))
    from action_modules import ModuleRuntime
    fixture = ModuleRuntime(module_directory.parent / "store")
    workspace = module_directory.parent / "action-workspace"
    workspace.mkdir()
    fixture.configure_workspace(str(workspace))
    assert fixture.validate("core.date.parse", fixture.definition("core.date.parse")["content_hash"])["ok"]
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
                feedback = by_name["retrieval_feedback"]
                assert feedback.annotations.readOnlyHint is False
                assert feedback.inputSchema["properties"]["complete"]["default"] is False
                for route in ["semantic", "dual", "lexical"]:
                    search = (await client.call_tool("search_knowledge", {"query": "fixture", "limit": 3,
                        "route": route, "capability_source_ids": ["source-0"]})).structured_content
                    path, payload = bridge.calls[-1]
                    assert path == "/search" and payload["limit"] == 15
                    assert payload["scope"]["source_ids"] == ["source-0"]
                    if route != "lexical":
                        assert payload["output_limit"] == 3
                        assert search["retrieval_id"] == "stdio-receipt" and search["model_invoked"] is True
                        assert search["adaptive"]["original_count"] == 3
                    else:
                        assert "output_limit" not in payload and search["model_invoked"] is False
                incomplete = (await client.call_tool("retrieval_feedback", {
                    "retrieval_id": "stdio-receipt", "relevant_source_ids": ["source-0"]})).structured_content
                assert incomplete["ok"] is False and "Complete" in incomplete["error"]
                assert bridge.calls[-1][1]["complete"] is False
                trained = (await client.call_tool("retrieval_feedback", {
                    "retrieval_id": "stdio-receipt", "relevant_source_ids": ["source-0"], "complete": True})).structured_content
                assert trained == {"ok": True, "recall": 1.0}
                assert bridge.calls[-1] == ("/retrieval-feedback", {"retrieval_id": "stdio-receipt",
                    "relevant_source_ids": ["source-0"], "complete": True})
                expired = (await client.call_tool("retrieval_feedback", {
                    "retrieval_id": "expired", "relevant_source_ids": [], "complete": True})).structured_content
                assert expired["ok"] is False and "expired" in expired["error"]
                assert {"knowledge_recovery_preview", "knowledge_recovery_apply", "knowledge_snapshot_create",
                    "knowledge_snapshot_status", "knowledge_snapshot_configure",
                    "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply",
                    "knowledge_file_trash", "asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"} <= set(by_name)
                cas_note = (await client.call_tool("add_note", {"title": "CAS Trash", "content": "Reviewed original"})).structured_content
                store = module_directory.parent / "store"
                note_file = store / "notes" / (cas_note["slug"] + ".md")
                reviewed_bytes = note_file.read_bytes()
                reviewed_digest = hashlib.sha256(reviewed_bytes).hexdigest()
                classification = (await client.call_tool("asset_classify_preview", {})).structured_content
                proposal = next(p for p in classification["proposals"] if p["type"] == "classification"
                    and p["asset"] == "notes/" + cas_note["slug"] + ".md")
                assert note_file.read_bytes() == reviewed_bytes, "classification preview must not write"
                applied = (await client.call_tool("asset_classify_apply", {
                    "preview_id": classification["id"], "proposal_ids": [proposal["id"]]})).structured_content
                assert applied["applied"] == [proposal["id"]]
                assert b"pkmClassification:" in note_file.read_bytes()
                restored = (await client.call_tool("asset_classify_rollback", {
                    "journal_id": applied["journalId"]})).structured_content
                assert restored["applied"] == [proposal["id"]]
                assert note_file.read_bytes() == reviewed_bytes

                note_file.write_bytes(reviewed_bytes + b"changed during approval")
                try:
                    await client.call_tool("knowledge_file_trash",
                        {"area": "notes", "path": note_file.relative_to(store / "notes").as_posix(), "expected_sha256": reviewed_digest})
                    raise AssertionError("Changed source was moved to Trash")
                except ToolError:
                    pass
                assert note_file.read_bytes() == reviewed_bytes + b"changed during approval"
                note_file.write_bytes(reviewed_bytes)
                cas_result = (await client.call_tool("knowledge_file_trash", {"area": "notes",
                    "path": note_file.relative_to(store / "notes").as_posix(), "expected_sha256": reviewed_digest})).structured_content
                assert cas_result["ok"] and not note_file.exists(), cas_result
                assert (store / "notes" / ".trash" / cas_result["trash"]["id"] / "payload").read_bytes() == reviewed_bytes
                for area, name, create, remove, identity in [
                    ("notes", "MCP Trash Note", "add_note", "delete_note", "slug"),
                    ("skills", "MCP Trash Skill", "add_skill", "delete_skill", "name"),
                    ("papers", "MCP Trash Paper", "add_paper", "delete_paper", "slug")]:
                    payload = {"title" if area != "skills" else "name": name, "content": "Keep original bytes"}
                    created = (await client.call_tool(create, payload)).structured_content
                    key = created.get(identity, name)
                    result = (await client.call_tool(remove, {identity: key})).structured_content
                    assert result["ok"] and result.get("trash"), result
                    trash = module_directory.parent / "store" / area / ".trash" / result["trash"]["id"]
                    assert (trash / "payload").exists() and (trash / "metadata.json").exists()
                journal = json.loads((module_directory.parent / "store" / ".pkm" / "state" / "knowledge-deletions.json").read_text())
                assert len(journal["records"]) >= 3
                programmable_chat_tools = {"api_chat_capabilities", "api_chat_models", "api_chat_list", "api_chat_create",
                  "api_chat_send", "api_chat_get", "api_chat_cancel", "api_chat_request_get"}
                assert programmable_chat_tools <= set(by_name)
                assert {"action_retrieve", "action_call", "action_run_get", "action_run_cancel"} <= set(by_name)
                assert {"action_templates", "action_template_create", "action_run_wait", "action_cosmos_configure"} <= set(by_name)
                templates = (await client.call_tool("action_templates", {})).structured_content
                assert {"wait", "wait-five-minutes", "user-input", "chatroom-alias", "poll", "monitor", "azuredevops-pipeline-status"} == {item["template_id"] for item in templates["templates"]}
                assert by_name["action_run_events"].annotations.readOnlyHint is True
                assert {"action_validation_enqueue", "action_validation_status", "action_validation_cancel", "action_validation_resume",
                    "action_module_sets", "action_module_set_load", "action_module_set_import", "action_module_set_export",
                    "action_module_set_remove", "action_implementation_select", "action_graph_check", "action_graph_save"} <= set(by_name)
                assert by_name["action_retrieve"].annotations.readOnlyHint is True
                assert by_name["action_call"].annotations.readOnlyHint is False
                assert by_name["action_module_sets"].annotations.readOnlyHint is True
                assert by_name["action_graph_check"].annotations.readOnlyHint is True
                assert by_name["action_definition_check"].annotations.readOnlyHint is True
                capabilities = (await client.call_tool("action_capabilities", {})).structured_content
                assert capabilities["authoring"]["implementation_kinds"] == ["program", "pipeline", "mcp"]
                assert "caller shell" in capabilities["execution_host"]["filesystem"]
                example = capabilities["authoring"]["examples"]["cli"]
                checked = (await client.call_tool("action_definition_check", {"definition": example})).structured_content
                assert checked["ok"] and checked["persisted"] is False and checked["executed"] is False, checked
                example["implementations"][0]["kind"] = "python"
                checked = (await client.call_tool("action_definition_check", {"definition": example})).structured_content
                assert checked["ok"] is False and checked["diagnostics"][0]["allowed_values"] == ["program", "pipeline", "mcp"], checked
                assert (await client.call_tool("action_module_sets", {})).structured_content["module_sets"] == []
                assert (await client.call_tool("action_validation_status", {})).structured_content["jobs"] == []
                block = (await client.call_tool("action_get", {"action_id": "core.date.parse"})).structured_content
                graph = {"action_id": "stdio.graph.add", "name": "Stdio graph", "nodes": [
                  {"id": "date", "action_id": block["action_id"], "content_hash": block["content_hash"], "parameters": {"value": "2026-10-08"}}], "edges": []}
                assert (await client.call_tool("action_graph_check", {"graph": graph})).structured_content["implementations"][0]["kind"] == "pipeline"
                assert (await client.call_tool("action_graph_save", {"graph": graph})).structured_content["display_name"] == "Stdio graph"
                actions = (await client.call_tool("action_retrieve", {"task": "cosmos directory list"})).structured_content
                assert not any(candidate["action_id"].startswith("cosmos.") for candidate in actions["candidates"])
                assert actions["selected_action_id"] is None
                action_capabilities = (await client.call_tool("action_capabilities", {})).structured_content
                assert action_capabilities["enabled_platform_actions"] == []
                assert not any(name.startswith("cosmos.") for name in action_capabilities["builtins"])
                assert {"core.constant", "core.lookup", "core.file-path", "core.if-else", "core.switch", "core.for", "core.while", "core.user-action", "core.poll"} <= {item["action_id"] for item in action_capabilities["basic_components"]}
                chat_capabilities = await client.call_tool("api_chat_capabilities", {})
                assert chat_capabilities.structured_content["hosts"] == []
                assert chat_capabilities.structured_content["schema_version"] == "1.0.0"
                version_result = await asyncio.wait_for(client.call_tool("check_version", {}), 3)
                version = version_result.structured_content
                assert version["components"] == {
                    "knowledge": "knowledge-test",
                    "chat": "chat-test",
                    "recipes": "recipe-test",
                    "agent_sessions": "agent-session-test",
                }, version

                assert "diagnostics_latest" in by_name
                assert by_name["diagnostics_latest"].annotations.readOnlyHint is True
                for name in ["search_skills", "search_notes", "search_research", "search_scripts"]:
                  assert name in by_name, ("knowledge search missing", name)
                  properties = by_name[name].inputSchema["properties"]
                  assert {"query", "limit", "detail"} <= set(properties), (name, properties)
                  assert properties["limit"]["default"] == 20, (name, properties)
                  assert properties["detail"]["default"] == "legacy", (name, properties)
                  assert by_name[name].annotations.readOnlyHint is True, name
                for name in ["get_knowledge", "get_skill", "get_note", "get_research", "get_script"]:
                  assert name in by_name, ("knowledge read missing", name)
                  assert "id" in by_name[name].inputSchema["properties"], name
                  assert by_name[name].annotations.readOnlyHint is True, name
                diagnostics = await client.call_tool("diagnostics_latest", {"limit": 100})
                records = diagnostics.structured_content["records"]
                version_records = [entry for entry in records if entry.get("tool") == "check_version"]
                assert [entry["event"] for entry in version_records] == ["mcp.call.started", "mcp.call.returned"], records
                assert version_records[0]["callId"] == version_records[1]["callId"]
                assert diagnostics.structured_content["max_rows"] == 100000
                assert diagnostics.structured_content["dropped_records"] == 0
                try:
                  await client.call_tool("diagnostics_latest", {"limit": 100001})
                  raise AssertionError("Unbounded diagnostic query was accepted")
                except ToolError:
                  pass

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
                    "agent_session_snapshot_list",
                    "agent_session_snapshot_read",
                    "api_chat_capabilities",
                    "api_chat_models",
                    "api_chat_list",
                    "api_chat_get",
                    "api_chat_request_get",
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
                    "recipe_capabilities": ${JSON.stringify(componentVersions.RECIPE_MCP_VERSION)},
                    "agent_session_capabilities": ${JSON.stringify(componentVersions.AGENT_SESSION_MCP_VERSION)},
                }
                for name in ["check_chat_version", *discovery_names]:
                    result = await asyncio.wait_for(client.call_tool(name, {}), 3)
                    payload = result.structured_content
                    assert isinstance(payload, dict) and payload, (name, payload)
                    if name in expected_component_versions:
                        assert payload["version"] == expected_component_versions[name], (name, payload)
                    for advertised_tool in payload.get("tools", payload.get("chat_tools", [])):
                        assert advertised_tool in by_name, (name, advertised_tool)


with RetrievalBridge() as bridge:
    asyncio.run(main(bridge))
`;
  const smokePath = path.join(root, "smoke.py");
  fs.writeFileSync(smokePath, smokeTest);
  execFileSync(process.env.PYTHON || "python", [smokePath, moduleDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("MCP stdio smoke test: discovery metadata and bounded calls OK");
