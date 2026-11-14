import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";
const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual pinned original VSIX.";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (core, actor, operation, args, write = false) => core.dispatch(write ? "capability_call" : "capability_read",
  { operation, version: 1, arguments: args }, actor);

test("real MCP HTTP and canonical/old Workbench HTTP share native SQL definitions and exact one-shot genuine execution; restart never replays", { skip, timeout: 60000 }, async t => {
  const prepared = prepare(), before = capture(prepared.originalRoot);
  let env = await open(prepared, { library: true, publicApi: true }), mcp, http, client;
  t.after(async () => {
    await client?.close(); await mcp?.close();
    if (http) { http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); }
    await env.close(); assert.deepEqual(capture(prepared.originalRoot), before);
    fs.rmSync(prepared.base, { recursive: true, force: true });
  });
  const actor = { id: prepared.actorId, canWrite: true, recipeProtocol: true }, token = randomUUID();
  const defaultCore = new (await load("core")).Core(env.storage);
  assert.equal((await defaultCore.dispatch("capabilities_describe",
    { operation: "mcp.tool.recipe_search" }, actor)).error.code, "NOT_FOUND");
  const draft = await env.authority.editor(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    recipeId: prepared.evidence.recipeId, copy: true });
  const fields = Object.fromEntries(["name", "category", "description", "definition", "metadata", "editorLayout", "nodeBindings", "methodology"]
    .filter(key => key in draft.recipe).map(key => [key, draft.recipe[key]]));
  fields.name = "Public native library"; fields.editorLayout = { nodePositions: {},
    boundaryPositions: { input: { x: 5, y: 7 } } };
  fields.nodeBindings = [{ nodeId: prepared.evidence.definition.spec.nodes[0].nodeId, bindings: [] }];
  let saved = await env.authority.saveLibrary(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    operationId: randomUUID(), expectedDigest: draft.digest, recipeId: draft.recipe.recipeId, expectedRevision: 0, fields });
  const { legacyRecipeHttp } = await load("legacy-recipe-http"), { startHttp } = await load("http");
  http = await startHttp(env.runtime.core, token, actor, 0, undefined, legacyRecipeHttp({
    core: env.runtime.core, actor, recipeId: () => saved.recipe.recipeId, scope: env.binding }));
  mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, actor, token);
  client = new Client({ name: "actual-native-recipe-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools(); assert(tools.tools.some(tool => tool.name === "recipe_search"));
  assert(!tools.tools.some(tool => tool.name === "recipe_run_start"));
  const search = await client.callTool({ name: "recipe_search", arguments: { query: fields.name } });
  assert.equal(search.structuredContent.candidates[0].recipe_id, saved.recipe.recipeId);
  const compact = await client.callTool({ name: "capability_read", arguments: { operation: "mcp.tool.recipe_search",
    version: 1, arguments: { query: fields.name } } });
  assert.deepEqual(compact.structuredContent, search.structuredContent);
  assert.deepEqual(JSON.parse(compact.content.find(item => item.type === "text").text), search.structuredContent);
  const mapping = await call(env.runtime.core, actor, "mcp.tool.recipe_capabilities", {});
  assert.equal(mapping.result.nativeLibrary.authority, "same-root-native-sqlite");
  assert(mapping.result.legacyRecipeToolsNotProvided.includes("recipe_run_get"));
  const second = new Client({ name: "independent-second-recipe-client", version: "1" });
  try {
    await second.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    assert((await second.listTools()).tools.some(tool => tool.name === "recipe_search"));
  } finally { await second.close(); }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let response = await fetch(`${http.url}/api/recipe`, { headers });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).recipe, saved.recipe);
  assert.equal((await fetch(`${http.url}/api/recipe`)).status, 401);
  assert.equal((await fetch(`${http.url}/api/recipe`, { headers: { ...headers, origin: "http://untrusted.invalid" } })).status, 403);
  response = await fetch(`${http.url}/api/recipe`, { method: "PUT", headers,
    body: JSON.stringify({ ...saved.recipe, revision: 0 }) });
  assert.equal(response.status, 409);
  response = await fetch(`${http.url}/api/recipe`, { method: "PUT", headers, body: JSON.stringify(saved.recipe) });
  assert.equal(response.status, 503, "HTTP bearer alone cannot save definitions");
  const list = await call(env.runtime.core, actor, "project.recipe.list", {});
  const compiled = await call(env.runtime.core, actor, "workflow.definition.compile", { source: {
    kind: "recipe", recipeId: saved.recipe.recipeId, expectedRevision: 1,
    expectedExecutableDigest: saved.recipe.executableDigest, snapshotRevision: list.result.snapshotRevision } });
  assert.equal(compiled.result.source.kind, "recipe"); assert.equal(compiled.result.source.recipeId, saved.recipe.recipeId);
  const state = await env.authority.state(env.binding);
  const args = { namespace: env.binding.namespace, chatId: env.binding.chatId, operationId: randomUUID(),
    expectedDigest: state.digest, recipeId: saved.recipe.recipeId, inputs: { mode: "complete" } };
  assert.equal((await call(env.runtime.core, actor, "recipe.runtime.start", args, true)).error.code, "ACCESS_DENIED");
  assert.equal((await call(env.runtime.core, { id: randomUUID(), canWrite: true }, "project.recipe.get",
    { id: saved.recipe.recipeId })).error.code, "NOT_AVAILABLE");
  assert.equal((await call(env.runtime.core, actor, "workflow.executor.get", {})).error.code, "NOT_AVAILABLE");
  assert.equal((await call(env.runtime.core, actor, "knowledge.note.list", {})).error.code, "NOT_AVAILABLE");
  assert.equal((await env.runtime.core.dispatch("capabilities_describe", { operation: "project.recipe.bundle.get" }, actor)).error.code, "NOT_FOUND");
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args });
  saved = await env.authority.saveLibrary(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    operationId: randomUUID(), expectedDigest: state.digest, recipeId: saved.recipe.recipeId, expectedRevision: 1,
    fields: { ...fields, description: "Changed after an exact native public decision." } });
  assert.equal((await call(env.runtime.core, actor, "recipe.runtime.start", args, true)).error.code, "CONFLICT");
  assert(!fs.existsSync(env.effects));
  args.operationId = randomUUID(); args.expectedDigest = (await env.authority.state(env.binding)).digest;
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args });
  assert.equal((await call(env.runtime.core, actor, "recipe.runtime.start", { ...args, inputs: { mode: "held" } }, true)).error.code, "ACCESS_DENIED");
  const started = await client.callTool({ name: "capability_call", arguments: { operation: "recipe.runtime.start", version: 1, arguments: args } });
  assert(!started.isError, JSON.stringify(started));
  const runId = started.structuredContent.result.runId;
  let done;
  for (let i = 0; i < 200; i++) {
    const read = await fetch(`${http.url}/v1/capability_read`, { method: "POST", headers,
      body: JSON.stringify({ operation: "recipe.runtime.get", version: 1, arguments: { runId } }) });
    done = (await read.json()).result;
    if (done.state === "succeeded") break;
    await wait(20);
  }
  assert.equal(done.state, "succeeded");
  assert.equal(fs.readFileSync(env.effects, "utf8").trim().split("\n").length, 1);
  assert.equal((await call(env.runtime.core, actor, "recipe.runtime.start", args, true)).error.code, "ACCESS_DENIED");
  await client.close(); client = undefined; await mcp.close(); mcp = undefined;
  http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); http = undefined;
  await env.close(); env = await open(prepared, { library: true, publicApi: true });
  const reopened = await call(env.runtime.core, actor, "project.recipe.get", { id: saved.recipe.recipeId });
  assert.deepEqual(reopened.result.item, saved.recipe);
  assert.equal((await call(env.runtime.core, actor, "recipe.runtime.get", { runId })).result.state, "succeeded");
  assert.equal((await call(env.runtime.core, actor, "recipe.runtime.start", args, true)).error.code, "ACCESS_DENIED");
  assert.equal(fs.readFileSync(env.effects, "utf8").trim().split("\n").length, 1);
});

test("native local recipe_search matches actual old Python ranking, task-contract fallback, no-match and errors", { skip }, async t => {
  const env = prepare(); t.after(() => fs.rmSync(env.base, { recursive: true, force: true }));
  const { searchLocalRecipes } = await load("legacy-recipe-search");
  const records = [env.evidence.recipe, { ...structuredClone(env.evidence.recipe), recipeId: "recipe_family",
    name: "Family fallback", methodology: { family: "review", phase: "execute", abstract: false } }];
  const input = path.join(env.base, "search-oracle.json");
  const source = path.join(process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, "resources/recipe_runtime.py");
  const cases = [{ query: records[0].name }, { query: "inspect" }, { category: "Synthetic" },
    { query: "not-observed", task_contract_json: '{"family":"review"}' }, { query: "not-observed" },
    { query: "PUBLIC", limit: -1 }, { task_contract_json: "[]" }];
  for (const value of cases) {
    const args = { query: "", category: "", project_id: "", limit: 10, task_contract_json: "{}", ...value };
    fs.writeFileSync(input, JSON.stringify({ records, args }), { mode: 0o600 });
    const oracle = spawnSync("python3", ["-c", `
import ast,json,sys
c=json.load(open(sys.argv[2])); tree=ast.parse(open(sys.argv[1]).read())
ns={'API_SCHEMA':'pkm.recipe.api/v1','json':json,'_project_recipes':lambda _:c['records'],'_subscribed_recipes':lambda _:[]}
for node in tree.body:
 if isinstance(node,ast.FunctionDef) and node.name in {'_json','_response','_recipe_summary','_search','_parse_json'}:exec(compile(ast.Module(body=[node],type_ignores=[]),sys.argv[1],'exec'),ns)
a=c['args']
try: print(ns['_search']('',a['query'],a['category'],a['project_id'],a['limit'],ns['_parse_json'](a['task_contract_json'],'task_contract_json')))
except Exception as error: print(ns['_response'](ok=False,error={'code':'recipe-search-failed','message':str(error)}))
`, source, input], { encoding: "utf8" });
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.deepEqual(searchLocalRecipes(records, args), JSON.parse(oracle.stdout));
  }
});

test("actual legacy HTTP PUT preserves identity/CAS and commits SQL before a lost acknowledgment; bearer alone never supplies the separate host decision", { skip, timeout: 60000 }, async t => {
  const prepared = prepare(); let fault = false, approvals = 0, expected;
  const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
  const env = await open(prepared, { library: true,
    libraryFault(point) { if (fault && point === "after-commit") throw Error("Invalid authority/source changed after actual COMMIT."); },
    publicApi: { authorizeMutation: async request => {
      if (!expected || request.operation !== "recipe.library.save" || request.actor.id !== prepared.actorId
        || request.args.expectedRevision !== 1 || request.args.recipeId !== expected.recipeId
        || request.args.namespace !== expected.namespace || request.args.chatId !== expected.chatId
        || request.args.expectedDigest !== expected.digest
        || canonicalJson(request.args.fields) !== canonicalJson(expected.fields)) return false;
      approvals++; expected = undefined; return true;
    } } });
  let http;
  t.after(async () => {
    if (http) { http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); }
    await env.close(); fs.rmSync(prepared.base, { recursive: true, force: true });
  });
  const draft = await env.authority.editor(env.binding, { namespace: env.binding.namespace,
    chatId: env.binding.chatId, recipeId: prepared.evidence.recipeId, copy: true });
  const fields = Object.fromEntries(["name", "category", "description", "definition", "metadata", "editorLayout", "nodeBindings", "methodology"]
    .filter(key => key in draft.recipe).map(key => [key, draft.recipe[key]]));
  const created = await env.authority.saveLibrary(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    operationId: randomUUID(), expectedDigest: draft.digest, recipeId: draft.recipe.recipeId, expectedRevision: 0, fields });
  const { legacyRecipeHttp } = await load("legacy-recipe-http"), { startHttp } = await load("http");
  const token = randomUUID(), actor = { id: prepared.actorId, canWrite: true, recipeProtocol: true };
  http = await startHttp(env.runtime.core, token, actor, 0, undefined, legacyRecipeHttp({
    core: env.runtime.core, actor, recipeId: () => created.recipe.recipeId, scope: env.binding }));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const changed = { ...created.recipe, name: "HTTP separately approved save" };
  let response = await fetch(`${http.url}/api/recipe`, { method: "PUT", headers, body: JSON.stringify(changed) });
  assert.equal(response.status, 403); assert.equal(approvals, 0);
  expected = { recipeId: created.recipe.recipeId, namespace: env.binding.namespace, chatId: env.binding.chatId,
    digest: (await env.authority.state(env.binding)).digest,
    fields: Object.fromEntries(["name", "category", "description", "definition", "metadata", "editorLayout", "nodeBindings", "methodology"]
      .filter(key => key in changed).map(key => [key, changed[key]])) };
  fault = true;
  response = await fetch(`${http.url}/api/recipe`, { method: "PUT", headers, body: JSON.stringify(changed) });
  assert.equal(response.status, 500); assert.equal((await response.json()).effect, "unknown");
  assert.equal(approvals, 1);
  response = await fetch(`${http.url}/api/recipe`, { headers });
  const saved = (await response.json()).recipe;
  assert.equal(saved.revision, 2); assert.equal(saved.name, changed.name);
  assert.equal(saved.knowledgeId, created.recipe.knowledgeId); assert.deepEqual(saved.aliases, created.recipe.aliases);
  response = await fetch(`${http.url}/api/recipe`, { method: "PUT", headers, body: JSON.stringify(changed) });
  assert.equal(response.status, 409); assert.equal(approvals, 1);
});
