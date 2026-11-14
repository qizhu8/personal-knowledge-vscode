"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createRequire } = require("node:module");
async function main() {
  const [fixture, mode, requestFile, output] = process.argv.slice(2);
  const endpoints = JSON.parse(fs.readFileSync(path.join(fixture, "native-recipe-public-endpoints.json")));
  const request = JSON.parse(fs.readFileSync(requestFile)), headers = {
    authorization: `Bearer ${endpoints.token}`, "content-type": "application/json" };
  let client, transport;
  const core = async (method, args) => {
    if (client) {
      const response = await client.callTool({ name: method, arguments: args });
      return { payload: response.structuredContent, isError: response.isError === true };
    }
    const response = await fetch(`${endpoints.http}/v1/${method}`, { method: "POST", headers, body: JSON.stringify(args) });
    const payload = await response.json(); return { payload, isError: !!payload.error, status: response.status };
  };
  try {
    if (mode === "mcp") {
      const sdk = createRequire(path.join(endpoints.extension, "next-runtime/server/package.json"));
      const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = sdk("@modelcontextprotocol/sdk/client/streamableHttp.js");
      client = new Client({ name: "actual-installed-controlled-lazy-client", version: "1" });
      transport = new StreamableHTTPClientTransport(new URL(endpoints.mcp), { requestInit: { headers } });
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.find(tool => tool.name === "capability_call").annotations.readOnlyHint, false);
    }
    const description = await core("capabilities_describe", { operation: "mcp.tool.recipe_run_get" });
    assert.equal(description.payload.result.readOnly, false);
    assert.match(description.payload.result.authorization, /fresh exact native host/);
    const args = { operation: request.operation, version: 1, arguments: request.args };
    const response = await core("capability_call", args);
    if (mode === "unapproved") {
      assert.equal(response.payload.error.code, "ACCESS_DENIED");
      fs.writeFileSync(output, JSON.stringify({ denied: true }), { mode: 0o600 }); return;
    }
    assert(!response.isError, JSON.stringify(response.payload));
    const result = mode === "mcp" ? response.payload : response.payload.result;
    assert.equal(result.schema, "pkm.recipe.api/v1", JSON.stringify(result));
    const replay = await core("capability_call", args);
    assert.equal(replay.payload.error.code, "ACCESS_DENIED", "Consumed host approval cannot be reused, even for get/receipt inspection.");
    fs.writeFileSync(output, JSON.stringify({ mode, request, result,
      getReadOnly: description.payload.result.readOnly, noAuthorityReplay: true }), { mode: 0o600 });
  } finally {
    try { await transport?.terminateSession(); }
    finally { await client?.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
