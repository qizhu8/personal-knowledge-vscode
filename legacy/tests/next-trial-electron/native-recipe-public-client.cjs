"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createRequire } = require("node:module");
async function main() {
  const [fixture, mode, revisionText, requestFile, output] = process.argv.slice(2);
  const endpoints = JSON.parse(fs.readFileSync(path.join(fixture, "native-recipe-public-endpoints.json")));
  const state = JSON.parse(fs.readFileSync(path.join(fixture, "native-library-ui-state.json")));
  const revision = Number(revisionText), request = requestFile !== "-" ? JSON.parse(fs.readFileSync(requestFile)) : undefined;
  const headers = { authorization: `Bearer ${endpoints.token}`, "content-type": "application/json" };
  let client;
  const invoke = async (operation, args, write = false) => {
    if (client) {
      const response = await client.callTool({ name: write ? "capability_call" : "capability_read",
        arguments: { operation, version: 1, arguments: args } });
      return !response.isError && operation.startsWith("mcp.tool.recipe_")
        ? { result: response.structuredContent } : response.structuredContent;
    }
    const response = await fetch(`${endpoints.http}/v1/${write ? "capability_call" : "capability_read"}`,
      { method: "POST", headers, body: JSON.stringify({ operation, version: 1, arguments: args }) });
    return response.json();
  };
  try {
    const discovery = [];
    if (mode.includes("mcp")) {
      const sdk = createRequire(path.join(endpoints.extension, "next-runtime/server/package.json"));
      const { Client } = sdk("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = sdk("@modelcontextprotocol/sdk/client/streamableHttp.js");
      client = new Client({ name: "actual-installed-recipe-public-client", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoints.mcp), { requestInit: { headers } }));
      const tools = await client.listTools();
      assert(tools.tools.some(tool => tool.name === "recipe_search"));
      assert(!tools.tools.some(tool => tool.name === "recipe_run_start"), "Never alias full-graph execution to legacy lazy start");
      discovery.push(...tools.tools.map(tool => tool.name));
      const searched = await client.callTool({ name: "recipe_search", arguments: { query: "SATURN native authored library" } });
      assert(searched.structuredContent.candidates.some(row => row.recipe_id === state.recipeId));
    }
    const list = await invoke("project.recipe.list", {});
    const compact = await invoke("mcp.tool.recipe_search", { query: "SATURN native authored library" });
    assert(compact.result.candidates.some(row => row.recipe_id === state.recipeId));
    const mapping = await invoke("mcp.tool.recipe_capabilities", {});
    assert.equal(mapping.result.nativeLibrary.authority, "same-root-native-sqlite");
    assert(mapping.result.legacyRecipeToolsNotProvided.includes("recipe_run_get"));
    assert(!list.error, JSON.stringify(list));
    assert(list.result.items.some(row => row.recipeId === state.recipeId && row.revision === revision));
    const read = await invoke("project.recipe.get", { id: state.recipeId, expectedRevision: revision,
      snapshotRevision: list.result.snapshotRevision });
    assert(!read.error, JSON.stringify(read)); assert.equal(read.result.item.knowledgeId, state.knowledgeId);
    assert.deepEqual(read.result.item.aliases, state.aliases);
    const compiled = await invoke("workflow.definition.compile", { source: { kind: "recipe", recipeId: state.recipeId,
      expectedRevision: revision, expectedExecutableDigest: read.result.item.executableDigest,
      snapshotRevision: list.result.snapshotRevision } });
    assert(!compiled.error, JSON.stringify(compiled));
    assert.equal(compiled.result.source.kind, "recipe"); assert.equal(compiled.result.source.recipeId, state.recipeId);
    assert.equal((await invoke("project.recipe.get", { id: state.recipeId, expectedRevision: revision + 1 })).error.code, "CONFLICT");
    let response = await fetch(`${endpoints.http}/api/recipe`, { headers });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).recipe, read.result.item);
    assert.equal((await fetch(`${endpoints.http}/api/recipe`)).status, 401);
    response = await fetch(`${endpoints.http}/api/recipe`, { method: "PUT", headers,
      body: JSON.stringify({ ...read.result.item, revision: revision - 1 }) });
    assert.equal(response.status, 409);
    response = await fetch(`${endpoints.http}/api/validate`, { method: "POST", headers,
      body: JSON.stringify({ definition: read.result.item.definition }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).nodeCount, 2);
    const digest = (await invoke("recipe.library.state", {})).result.digest;
    assert.equal((await invoke("knowledge.note.list", {})).error.code, "NOT_AVAILABLE");
    assert.equal((await invoke("workflow.executor.get", {})).error.code, "NOT_AVAILABLE");
    const denied = { ...request?.args, operationId: require("node:crypto").randomUUID(),
      namespace: request?.args.namespace || state.publicRequests?.[0]?.args.namespace,
      chatId: request?.args.chatId || state.publicRequests?.[0]?.args.chatId,
      expectedDigest: digest, recipeId: state.recipeId, inputs: { mode: "complete" } };
    assert.equal((await invoke("recipe.runtime.start", denied, true)).error.code, "ACCESS_DENIED");
    let runId;
    if (!mode.startsWith("read-")) {
      assert(request && request.operation === "recipe.runtime.start");
      assert.equal((await invoke(request.operation, { ...request.args, inputs: { mode: "held" } }, true)).error.code, "ACCESS_DENIED");
      const started = await invoke(request.operation, request.args, true);
      assert(!started.error, JSON.stringify(started)); runId = started.result.runId;
      for (let i = 0; i < 200; i++) {
        const run = await invoke("recipe.runtime.get", { runId });
        if (run.result?.state === "succeeded") break;
        if (i === 199) throw Error(JSON.stringify(run));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal((await invoke(request.operation, request.args, true)).error.code, "ACCESS_DENIED");
    } else {
      for (const id of state.publicRunIds || [])
        assert.equal((await invoke("recipe.runtime.get", { runId: id })).result.state, "succeeded");
      for (const prior of state.publicRequests || [])
        assert.equal((await invoke(prior.operation, prior.args, true)).error.code, "ACCESS_DENIED");
    }
    fs.writeFileSync(output, JSON.stringify({ kind: "actual-installed-public-recipe-protocol", mode,
      recipeId: state.recipeId, knowledgeId: state.knowledgeId, revision, runId, tools: discovery,
      pureRead: mode.startsWith("read-"), deniedWithoutFreshAuthority: true,
      compilerSourceKind: compiled.result.source.kind, snapshotRevision: list.result.snapshotRevision,
      legacyLazyExecutionAliased: false }), { mode: 0o600 });
  } finally { await client?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
