"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createRequire } = require("node:module");
exports.run = async ({ fixture, recipeId }) => {
  const sdk = createRequire(path.join(__dirname, "../../next-server/package.json"));
  const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = sdk("@modelcontextprotocol/sdk/client/stdio.js");
  const python = path.join(fixture, "h/pkm-envs/pkm-mcp/bin/python");
  const script = path.join(fixture, "legacy-mcp-server/server.py");
  assert(fs.existsSync(python) && fs.existsSync(script));
  const client = new Client({ name: "private-old-recipe-discovery", version: "1" });
  const transport = new StdioClientTransport({ command: python, args: ["-B", script],
    cwd: fixture, stderr: "pipe", env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) });
  try {
    await client.connect(transport);
    const advertised = (await client.listTools()).tools;
    fs.writeFileSync(path.join(fixture, "legacy-recipe-public-discovery-initial.json"),
      JSON.stringify({ advertised }), { mode: 0o600 });
    const compact = advertised.some(tool => tool.name === "capabilities_describe");
    const tools = [];
    for (const name of ["recipe_capabilities", "recipe_search", "recipe_run_start", "recipe_run_get", "recipe_run_next",
      "recipe_run_report", "recipe_create_from_skill"]) {
      const contract = compact ? await client.callTool({ name: "capabilities_describe",
        arguments: { operation: `mcp.tool.${name}` } }) : advertised.find(tool => tool.name === name);
      assert(contract && !contract.isError, name); tools.push({ name, contract });
    }
    const invoke = (name, args) => client.callTool(compact ? { name: "capability_read",
      arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args } } : { name, arguments: args });
    const capabilities = await invoke("recipe_capabilities", {});
    const search = await invoke("recipe_search", { query: "SATURN", limit: 50 });
    assert(!capabilities.isError && !search.isError);
    const text = search.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    const payload = JSON.parse(text); assert.equal(payload.schema, "pkm.recipe.api/v1"); assert.equal(payload.ok, true);
    assert(payload.candidates.some(item => item.recipe_id === recipeId), "Old MCP reads the actual original UI Recipe identity");
    const quiesced = await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
    assert(!quiesced.isError, "Drain only this owned stdio MCP before closing its transport");
    fs.writeFileSync(path.join(fixture, "legacy-recipe-public-discovery.json"),
      JSON.stringify({ kind: "actual-old-installed-stdio-mcp", recipeId, advertised, compact, tools, capabilities, search: payload,
        executionInvoked: false, ownedMcpQuiesced: true }), { mode: 0o600 });
    console.log("PASS actual old installed MCP tools/list, Recipe capabilities and genuine metadata search; no execution/get side effects requested.");
  } finally { await client.close(); }
};
