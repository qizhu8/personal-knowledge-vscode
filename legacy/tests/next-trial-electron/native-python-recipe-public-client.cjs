"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createRequire } = require("node:module");
async function main() {
  const [fixture, mode, requestFile, output] = process.argv.slice(2);
  const endpoints = JSON.parse(fs.readFileSync(path.join(fixture, "native-recipe-public-endpoints.json")));
  const state = JSON.parse(fs.readFileSync(path.join(fixture, "native-python-recipe-ui-state.json")));
  const request = JSON.parse(fs.readFileSync(requestFile));
  const headers = { authorization: `Bearer ${endpoints.token}`, "content-type": "application/json" };
  let client;
  try {
    if (mode.includes("mcp")) {
      const sdk = createRequire(path.join(endpoints.extension, "next-runtime/server/package.json"));
      const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = sdk("@modelcontextprotocol/sdk/client/streamableHttp.js");
      client = new Client({ name: "installed-genuine-next-python-recipe", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoints.mcp), { requestInit: { headers } }));
      assert((await client.listTools()).tools.some(tool => tool.name === "recipe_search"));
    }
    const invoke = async (operation, args, write = false) => {
      if (client) return (await client.callTool({ name: write ? "capability_call" : "capability_read",
        arguments: { operation, version: 1, arguments: args } })).structuredContent;
      return (await fetch(`${endpoints.http}/v1/${write ? "capability_call" : "capability_read"}`,
        { method: "POST", headers, body: JSON.stringify({ operation, version: 1, arguments: args }) })).json();
    };
    const listing = await invoke("project.recipe.list", {});
    assert(!listing.error, JSON.stringify(listing));
    const recipe = await invoke("project.recipe.get", { id: state.recipeId, snapshotRevision: listing.result.snapshotRevision });
    assert.equal(recipe.result.item.knowledgeId, state.knowledgeId);
    assert.deepEqual(recipe.result.item.aliases, state.aliases);
    const compiled = await invoke("workflow.definition.compile", { source: {
      kind: "recipe", recipeId: state.recipeId, expectedRevision: recipe.result.item.revision,
      expectedExecutableDigest: recipe.result.item.executableDigest, snapshotRevision: listing.result.snapshotRevision } });
    assert.equal(compiled.result.source.kind, "recipe");
    assert.equal((await invoke("workflow.executor.get", {})).error.code, "NOT_AVAILABLE");
    const runId = `recipe_native_${request.args.operationId.replaceAll("-", "")}`;
    let response, run;
    if (mode.startsWith("read-")) {
      response = await invoke("recipe.runtime.get", { runId });
      assert(!response.error, JSON.stringify(response)); run = response.result;
      assert.equal((await invoke(request.operation, request.args, true)).error.code, "ACCESS_DENIED");
    } else {
      response = await invoke(request.operation, request.args, true);
      if (mode.startsWith("deny-")) assert(response.error, JSON.stringify(response));
      else {
        assert(!response.error, JSON.stringify(response));
        assert.equal(response.result.runId, runId);
        if (!mode.includes("start-only")) {
          for (let i = 0; i < 400; i++) {
            run = (await invoke("recipe.runtime.get", { runId })).result;
            if (run?.state === "succeeded") break;
            if (i === 399) throw Error(JSON.stringify(run));
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          assert.equal((await invoke(request.operation, request.args, true)).error.code, "ACCESS_DENIED");
        }
      }
    }
    fs.writeFileSync(output, JSON.stringify({ mode, runId, source: compiled.result.source,
      sqlRecipe: recipe.result.item, response, run, publicActorCannotInvokeGeneralWorkflow: true }), { mode: 0o600 });
  } finally { await client?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
