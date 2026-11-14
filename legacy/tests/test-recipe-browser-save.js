const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const http = require("node:http"), crypto = require("node:crypto"), ts = require("typescript");
const compiled = path.resolve(process.env.PKM_TEST_RECIPE_EDITOR_DIST || "dist");
const legacy = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;
const skip = !legacy && "Requires the actual pinned old VSIX extension.";
function declaration(source, name) {
  const tree = ts.createSourceFile("extension.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const item = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(item, `Actual extension function missing: ${name}`);
  return item.getText(tree);
}
async function router(t, extension, store, recipeId) {
  const source = fs.readFileSync(path.join(extension, "extension.js"), "utf8");
  const timers = [], servers = []; let url;
  const old = name => require(path.join(legacy, "dist/workflows", name));
  const context = vm.createContext({
    Buffer, URL, crypto_1: crypto, currentProjectStore: () => store,
    workflow_contracts_1: old("workflow-contracts.js"), project_model_1: old("project-model.js"),
    canonicalJson: old("workflow-contracts.js").canonicalJson,
    recipe_editor_update_1: require(path.join(compiled, "workflows/recipe-editor-update.js")),
    http: { createServer: (...args) => { const server = http.createServer(...args); servers.push(server); return server; } },
    externalUrlHost: () => "127.0.0.1",
    vscode: { Uri: { parse: value => value }, env: { openExternal: async value => { url = value; return true; } } },
    setTimeout: (...args) => { const timer = setTimeout(...args); timers.push(timer); return timer; },
  });
  t.after(async () => {
    timers.forEach(clearTimeout);
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  vm.runInContext(["projectCommand", "hydrateRecipeNodeBindings", "authorizeEphemeralBrowserRequest", "readBrowserJson", "browserJson", "openRecipeEditorInBrowser"]
    .map(name => declaration(source, name)).join("\n"), context);
  assert.equal(await context.openRecipeEditorInBrowser(recipeId), true);
  const parsed = new URL(url);
  const endpoint = `${parsed.origin}/api/recipe${parsed.search}`;
  return { get: () => fetch(endpoint), put: value => fetch(endpoint, { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify(value) }) };
}
function fixture(t) {
  const base = path.resolve(`.migration-test-work/recipe-save-${crypto.randomUUID()}`), root = path.join(base, "knowledge");
  fs.mkdirSync(path.join(base, "workspace"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(base, "native-ui-fixture-token"), crypto.randomUUID(), { mode: 0o600 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const evidence = require("./next-trial-electron/legacy-recipe-fixture.cjs").create({ extension: legacy, root, fixture: base });
  const { ProjectStore } = require(path.join(legacy, "dist/workflows/project-store.js"));
  return { evidence, store: new ProjectStore(path.join(root, ".pkm/state")) };
}
test("independent actual old HTTP router rejects its valid API-created Recipe missing optional methodology: pre-existing Save bug", { skip }, async t => {
  const { evidence, store } = fixture(t);
  const server = await router(t, path.join(legacy, "dist"), store, evidence.recipeId);
  const body = (await (await server.get()).json()).recipe;
  assert(!("methodology" in body));
  assert(require(path.join(legacy, "dist/workflows/workflow-contracts.js")).compileWorkflowDefinitionV1(body.definition).ok);
  const response = await server.put({ ...body, description: "Valid original browser save." });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Unsupported canonical JSON type: undefined");
  assert.equal((await (await server.get()).json()).recipe.revision, evidence.recipeRevision);
});
test("fixed actual HTTP producer saves the same old Recipe; revision CAS and malformed definition remain closed", { skip }, async t => {
  const { evidence, store } = fixture(t);
  const server = await router(t, compiled, store, evidence.recipeId);
  const body = (await (await server.get()).json()).recipe;
  const response = await server.put({ ...body, description: "Saved through the corrected actual route." });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = (await response.json()).recipe;
  assert.equal(saved.revision, evidence.recipeRevision + 1);
  assert.equal(saved.executableDigest, evidence.recipeExecutableDigest);
  assert.equal((await server.put(body)).status, 409);
  assert.equal((await server.put({ ...saved, definition: null })).status, 400);
  const { definition: _definition, ...missing } = saved;
  assert.equal((await server.put(missing)).status, 400);
  assert.equal((await (await server.get()).json()).recipe.revision, saved.revision);
});
