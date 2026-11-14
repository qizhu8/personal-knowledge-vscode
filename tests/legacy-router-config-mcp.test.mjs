import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../dist/storage.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const originalSource = await readFile(join(repository, "src/mcp/mcp.ts"), "utf8");
const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\s+fs\.writeFileSync\(reqTxt/.exec(originalSource);
assert(match);
const originalPython = new Function("UNIFIED_MCP_VERSION", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION",
  "RECIPE_MCP_VERSION", "AGENT_SESSION_MCP_VERSION", "storeFwd", "subscriptionCacheFwd",
  "retrievalStateFwd", "environmentsRegistryFwd", "context", `return \`${match[1]}\`;`)(
  "fixture", "fixture", "fixture", "fixture", "fixture", "/unused", "/unused", "/unused", "/unused",
  { extensionPath: repository },
);
const oracle = `
import ast, json, sys, time
from pathlib import Path
from typing import Optional, List
request = json.load(sys.stdin)
tree = ast.parse(request["source"])
names = {"_router_config", "_enabled_router_solutions", "_disabled_router_response", "skill_context"}
body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
for node in body: node.decorator_list = []
namespace = dict(globals(), RETRIEVAL_STATE=Path(request["config"]).parent,
    _collect_search_invocation=lambda *args: None)
exec(compile(ast.Module(body=body, type_ignores=[]), "<original-router-consumer>", "exec"), namespace)
print(namespace["skill_context"](task="Router preservation after migration"))
`;

test("original separately selected router policy stays effective over import, restart and relocated restore", { timeout: 90_000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-router-import-mcp-"));
  let client, storage;
  t.after(async () => { try { await client?.close(); await storage?.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  const source = join(parent, "original-source"), selected = join(parent, "separately-selected-router");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(selected, { mode: 0o700 });
  const config = join(selected, "router-config.json");
  const raw = JSON.stringify({
    schema: 2, enabledSolutions: ["copilot_default"], sourcePriority: ["agent-native", "pkm-personal"],
    sources: [{ id: "pkm-personal", label: "PKM Personal", kind: "personal", detail: "Personal source" },
      { id: "agent-native", label: "Agent Native", kind: "native", detail: "Native source" }],
  }, null, 2);
  await writeFile(config, raw, { mode: 0o600 });
  const pin = async () => {
    const info = await stat(config, { bigint: true });
    return { raw: await readFile(config, "utf8"), dev: info.dev, ino: info.ino,
      mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
  };
  const before = await pin();
  const originalRaw = execFileSync("python3", ["-c", oracle], {
    input: JSON.stringify({ source: originalPython, config }), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }).trimEnd();
  const original = JSON.parse(originalRaw);
  assert.equal(original.disabled, true);
  const plan = await planLegacyImport(source, {}, { routerConfig: config });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.routerConfigPlan.destination, "knowledge-read-config/retrieval/router-config.json");
  const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const data = join(parent, "imported"), restored = join(parent, "relocated");
  await importLegacyWorkspace(plan, data, { pythonExecutable });
  for (const phase of ["imported", "restarted", "relocated"]) {
    const current = phase === "relocated" ? restored : data;
    assert.equal(await readFile(join(current, plan.routerConfigPlan.destination), "utf8"), raw);
    const managed = await legacyManagedFixture(parent);
    client = new Client({ name: `router-config-${phase}`, version: "0.1.0" });
    const transport = new StdioClientTransport({ command: "python3", args: [
      join(root, "compat/legacy-compact-mcp.py"), "--data", current, "--node", process.execPath,
      "--managed-generation", managed,
    ], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" });
    let errors = "";
    transport.stderr?.on("data", chunk => { errors += chunk; });
    try { await client.connect(transport); } catch (error) { throw new Error(errors, { cause: error }); }
    const result = await client.callTool({ name: "capability_read", arguments: {
      operation: "mcp.tool.skill_context", version: 1, arguments: { task: "Router preservation after migration" },
    } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.content[0].text, originalRaw);
    assert.deepEqual(result.structuredContent ?? JSON.parse(result.content[0].text), original);
    if (phase === "relocated") {
      await writeFile(join(current, plan.routerConfigPlan.destination), "{malformed");
      const invalid = await client.callTool({ name: "capability_read", arguments: {
        operation: "mcp.tool.skill_context", version: 1, arguments: { task: "Do not silently enable defaults" },
      } });
      assert.equal(invalid.isError, true);
      assert.match(JSON.stringify(invalid), /router|configuration/i);
      await writeFile(join(current, plan.routerConfigPlan.destination), raw);
    }
    await closeLegacyManagedFixture(client);
    client = undefined;
    if (phase === "restarted") {
      storage = await Storage.open(data);
      await createWorkspaceBackup(storage, join(parent, "backup"), {
        acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
      });
      await storage.close();
      storage = undefined;
      await restoreWorkspaceBackup(join(parent, "backup"), restored, { nativeRestoreAuthority, pythonExecutable });
    }
  }
  assert.deepEqual(await pin(), before);
});
