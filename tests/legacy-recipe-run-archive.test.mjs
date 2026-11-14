import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";

const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual original VSIX.";
test("actual original runtime definition/input/receipt/result/progress/usage bytes recover through pure SDK MCP and HTTP and survive native restart without replay", { skip, timeout: 60000 }, async t => {
  const prepared = prepare(), before = capture(prepared.originalRoot);
  let env = await open(prepared, { library: true, publicApi: true });
  let client, mcp, http;
  t.after(async () => {
    try { await client?.close(); await mcp?.close();
      if (http) { http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); }
      await env?.close(); assert.deepEqual(capture(prepared.originalRoot), before);
    } finally { fs.rmSync(prepared.base, { recursive: true, force: true }); }
  });
  const actor = { id: env.actorId, canWrite: false, recipeProtocol: true }, token = randomUUID();
  mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, actor, token);
  http = await (await load("http")).startHttp(env.runtime.core, token, actor, 0);
  client = new Client({ name: "original-history-reader", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const archiveBefore = capture(path.join(env.root, "recipe-usage-reads"));
  const state = await env.authority.state(env.binding);
  const completed = state.originalRuns.find(run => run.runId === env.evidence.completedRunId);
  const args = { runId: completed.runId, expectedSha256: completed.sha256 };
  const response = await client.callTool({ name: "capability_read", arguments: {
    operation: "recipe.history.get", version: 1, arguments: args } });
  assert(!response.isError, JSON.stringify(response));
  const historical = response.structuredContent.result;
  const originalRaw = fs.readFileSync(path.join(prepared.originalRoot, ".pkm/state/recipe-runs", `${completed.runId}.json`), "utf8");
  assert.equal(historical.raw, originalRaw);
  const { readOriginalRecipeRun } = await load("legacy-recipe-run-archive");
  assert.throws(() => readOriginalRecipeRun(prepared.originalRoot, completed.runId, completed.sha256),
    "A Recipe-only source may not impersonate a complete verified legacy UI bootstrap.");
  assert.deepEqual(historical.record, JSON.parse(originalRaw));
  assert.equal(historical.record.nodes.inspect.result.sha256, prepared.evidence.inputSha256);
  assert(Object.keys(historical.record.receipts).length > 2);
  assert.equal(historical.ownership, "unattributed-original-record");
  const unknown = state.originalRuns.find(run => run.runId === env.evidence.unknownRunId);
  const read = async values => {
    const response = await fetch(`${http.url}/v1/capability_read`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "recipe.history.get", version: 1, arguments: values }) });
    return response.json();
  };
  const pending = await read({ runId: unknown.runId, expectedSha256: unknown.sha256 });
  assert(!pending.error, JSON.stringify(pending));
  assert.equal(pending.result.originalState, "running");
  assert.equal(pending.result.record.status, "running", "Original bytes are not silently rewritten.");
  assert.equal(pending.result.state, "unknown");
  assert.equal(pending.result.replay, "never");
  assert.equal(pending.result.execution, "historical-only");
  assert((await read({ ...args, expectedSha256: "0".repeat(64) })).error);
  assert((await read({ ...args, runId: "../outside" })).error);
  const denied = await env.runtime.core.dispatch("capability_read", {
    operation: "recipe.history.get", version: 1, arguments: args }, { ...actor, id: randomUUID() });
  assert.equal(denied.error.code, "NOT_AVAILABLE");
  assert.deepEqual(env.runtime.services.workflow.list(env.actorId), []);
  assert.deepEqual(capture(path.join(env.root, "recipe-usage-reads")), archiveBefore);
  await client.close(); client = undefined; await mcp.close(); mcp = undefined;
  http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); http = undefined;
  await env.close(); env = await open(prepared, { library: true, publicApi: true });
  const reopened = await env.runtime.core.dispatch("capability_read", {
    operation: "recipe.history.get", version: 1, arguments: args }, actor);
  assert(!reopened.error, JSON.stringify(reopened));
  assert.equal(reopened.result.raw, originalRaw);
  assert.deepEqual(env.runtime.services.workflow.list(env.actorId), []);
  assert.deepEqual(capture(path.join(env.root, "recipe-usage-reads")), archiveBefore);
});
