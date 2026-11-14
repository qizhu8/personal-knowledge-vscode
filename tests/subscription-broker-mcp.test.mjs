import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";

test("packaged compact MCP exposes native local share markers to a new workspace", { timeout: 60_000 }, async t => {
  const parent = resolve(`.subscription-broker-mcp-${randomUUID()}`);
  const data = join(parent, "workspace");
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await initialize(data);
  const statePath = join(data, "subscriptions", "subscriptions.json");
  const state = {
    schema: 1, nodeId: "fixture-node", subscriptions: [],
    shares: [{ shareId: "fixture-share", name: "Fixture", published: false,
      summary: { shareId: "fixture-share" }, contentTypes: ["notes"],
      folders: { notes: ["Team"] }, secretSalt: "DO-NOT-EXPOSE" }],
  };
  const client = new Client({ name: "subscription-marker-wrapper-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.env.PKM_TEST_PYTHON || "python3",
    args: [resolve("compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe",
  });
  let errors = "";
  transport.stderr?.on("data", chunk => { errors += chunk; });
  try {
    try { await client.connect(transport); } catch (error) { throw new Error(errors, { cause: error }); }
    const operation = "mcp.tool.subscription_broker_share_markers";
    const describe = await client.callTool({ name: "capabilities_describe", arguments: { operation } });
    assert.notEqual(describe.isError, true, JSON.stringify(describe));
    const invoke = arguments_ => client.callTool({ name: "capability_read", arguments: { operation, version: 1, arguments: arguments_ } });
    const args = { type: "notes", items: [{ slug: "note-1", category: "Team/One" }, { slug: "note-2", category: "Private" }] };
    const empty = await invoke(args);
    assert.notEqual(empty.isError, true, JSON.stringify(empty));
    const emptyValue = empty.structuredContent ?? JSON.parse(empty.content[0].text);
    assert.deepEqual(emptyValue.items, {});
    await mkdir(join(data, "subscriptions"));
    await writeFile(statePath, JSON.stringify(state));
    const response = await invoke(args);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const value = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.deepEqual(value.items["note-1"].brokers, [{ id: "fixture-share", name: "Fixture", published: false }]);
    assert.equal(value.items["note-2"], undefined);
    assert.equal(JSON.stringify(response).includes("DO-NOT-EXPOSE"), false);
    const stale = await invoke({ ...args, expectedRevision: "0".repeat(64) });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /REVISION_CONFLICT/);
    await writeFile(statePath, JSON.stringify({ ...state, shares: [{ shareId: "fixture-share", summary: { shareId: "fixture-share" } }] }));
    const incomplete = await invoke(args);
    assert.equal(incomplete.isError, true);
    assert.match(JSON.stringify(incomplete), /INVALID_DATA/);
    await writeFile(statePath, "not json");
    const malformed = await invoke(args);
    assert.equal(malformed.isError, true);
    assert.match(JSON.stringify(malformed), /INVALID_DATA/);
  } finally { await client.close(); }
});
