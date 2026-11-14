"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createRequire } = require("node:module");
exports.run = async ({ fixture }) => {
  const sdk = createRequire(path.join(__dirname, "../../next-server/package.json"));
  const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = sdk("@modelcontextprotocol/sdk/client/stdio.js");
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture, "controlled-lazy-recipe-evidence.json")));
  const client = new Client({ name: "actual-old-controlled-lazy-comparison", version: "1" });
  const transport = new StdioClientTransport({ command: path.join(fixture, "h/pkm-envs/pkm-mcp/bin/python"),
    args: ["-B", path.join(fixture, "legacy-mcp-server/server.py")], cwd: fixture, stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) });
  const trace = [], effects = () => fs.existsSync(evidence.effects) ? fs.readFileSync(evidence.effects, "utf8").trim().split("\n").length : 0;
  const call = async (name, args, readOnly = false) => {
    const response = await client.callTool({ name: readOnly ? "capability_read" : "capability_call",
      arguments: { operation: `mcp.tool.recipe_run_${name}`, version: 1, arguments: args } });
    assert(!response.isError, JSON.stringify(response));
    const payload = JSON.parse(response.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
    assert.equal(payload.schema, "pkm.recipe.api/v1", JSON.stringify(payload));
    trace.push({ name, args, payload }); return payload;
  };
  const poll = async (id, predicate) => {
    for (let i = 0; i < 100; i++) {
      const value = await call("get", { run_id: id }, true);
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Actual old background result did not settle.");
  };
  try {
    await client.connect(transport);
    const contracts = {};
    for (const name of ["start", "get", "next", "progress"]) {
      const response = await client.callTool({ name: "capabilities_describe",
        arguments: { operation: `mcp.tool.recipe_run_${name}` } });
      assert(!response.isError, JSON.stringify(response)); contracts[name] = response;
    }
    const args = { recipe_id: evidence.recipeId, command_id: "installed-original-lazy", inputs_json: '{"mode":"complete"}' };
    const started = await call("start", args); assert.equal(started.ok, true);
    await call("get", { run_id: started.run_id }, true);
    assert.equal(effects(), 0);
    const first = await call("next", { run_id: started.run_id, command_id: "old-first" });
    const read = await poll(started.run_id, value => value.current_result.counts.succeeded === 1);
    assert.equal(read.current_result.counts.pending, 1); assert.equal(effects(), 1);
    const replay = await call("next", { run_id: started.run_id, command_id: "old-first" });
    assert.equal(replay.replayed, true); assert.equal(replay.version, first.version);
    const conflict = await call("next", { run_id: started.run_id, command_id: "old-first", detail: "full" });
    assert.equal(conflict.error.code, "recipe-run-next-failed"); assert.match(conflict.error.message, /reused/);
    await call("next", { run_id: started.run_id, command_id: "old-second" });
    assert.equal((await poll(started.run_id, value => value.status === "completed")).status, "completed");
    const held = await call("start", { ...args, command_id: "installed-original-cancel", inputs_json: '{"mode":"hold"}' });
    await call("next", { run_id: held.run_id, command_id: "old-hold" });
    for (let i = 0; i < 100 && effects() < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(effects(), 3);
    await call("progress", { run_id: held.run_id, node_id: "first", command_id: "old-cancel",
      progress_json: '{"cancellationRequested":true}' });
    const cancelled = await poll(held.run_id, value => value.status === "failed");
    assert.equal(cancelled.current_result.completed_nodes[0].result.cancelled, true);
    const quiesced = await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
    assert(!quiesced.isError);
    fs.writeFileSync(path.join(fixture, "actual-installed-old-lazy-evidence.json"), JSON.stringify({
      kind: "actual-old-vsix-private-profile-managed-mcp", recipeId: evidence.recipeId, contracts, trace,
      effects: effects(), cancelledStatus: cancelled.status, ownedMcpQuiesced: true,
      adoptionAttempted: false, executionComparisonOnly: true,
    }), { mode: 0o600 });
    console.log("PASS actual old installed profile managed MCP lazy start/get inert, explicit next, original receipt/conflict and progress cancellation→failed; this execution profile is NOT adopted.");
  } finally { await client.close(); }
};
