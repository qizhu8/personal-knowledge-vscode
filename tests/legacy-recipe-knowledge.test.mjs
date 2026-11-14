import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";

const require = createRequire(import.meta.url);
const helper = require("../legacy/tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs");
const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual original VSIX.";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash("sha256").update(text).digest("hex");
async function setup(t, enabled = true, driftAfterFirst = false) {
  const prepared = prepare(), observed = [];
  let documents = [], env, trusted, before;
  t.after(async () => { try { await env?.close(); if (before) assert.deepEqual(capture(prepared.originalRoot), before); }
    finally { fs.rmSync(prepared.base, { recursive: true, force: true }); } });
  const evidence = helper.create({ fixture: prepared.fixture, root: prepared.originalRoot,
    extension: process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION });
  const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
  const note = { title: "Bound", type: "general", category: "", tags: [], content: "Bound Note.\n" };
  const skill = { name: "Proof", description: "", category: "Testing", tags: [], content: "Bound Skill.\n" };
  const { ProjectStore } = require(path.join(process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, "dist/workflows/project-store.js"));
  const store = new ProjectStore(path.join(prepared.originalRoot, ".pkm/state"));
  store.updateRecipe({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: store.list().storeVersion },
    evidence.recipeId, { name: evidence.recipe.name, category: evidence.recipe.category,
      description: evidence.recipe.description, definition: evidence.definition, nodeBindings: [{ nodeId: "first", bindings: [
      { bindingId: "note", kind: "note", knowledgeId: "Bound", contentHash: hash(canonicalJson(note)), usage: "reference" },
      { bindingId: "skill", kind: "skill", knowledgeId: "Testing/Proof", contentHash: hash(canonicalJson(skill)), usage: "required" },
    ] }] });
  prepared.additionalRecipes = [store.list().recipes.find(item => item.recipeId === evidence.recipeId)];
  before = capture(prepared.originalRoot);
  const { decodeMarkdown, scanMarkdown } = await load("markdown");
  const noteRaw = "---\ntitle: Bound\ntype: general\ntags: []\n---\nBound Note.\n";
  const skillRaw = "---\nname: Proof\ndescription: \"\"\ntags: []\n---\nBound Skill.\n";
  const documentIds = [];
  env = await open(prepared, { library: true, publicApi: true,
    ...(enabled ? { knowledgeDocuments: () => documents } : {}),
    ...(enabled === "indexed" ? { knowledgeDocumentIds: documentIds } : {}),
    beforeStorageOpen(root) {
      fs.mkdirSync(path.join(root, "notes"), { recursive: true });
      fs.mkdirSync(path.join(root, "skills/Testing"), { recursive: true });
      fs.writeFileSync(path.join(root, "notes/Bound.md"), noteRaw, { mode: 0o600 });
      fs.writeFileSync(path.join(root, "skills/Testing/Proof.md"), skillRaw, { mode: 0o600 });
      documents = [decodeMarkdown("bound_note", noteRaw, "Bound.md", "notes"),
        decodeMarkdown("bound_skill", skillRaw, "Testing/Proof.md", "skills")];
      documentIds.push(...scanMarkdown(root).map(item => item.record.id));
    },
    recipeAdapters: ({ binding, canonicalJson }) => {
      trusted = helper.adapter({ fixture: prepared.fixture, actorId: binding.actorId, canonicalJson });
      return Object.fromEntries(Object.entries(trusted.adapters).map(([key, adapter]) => [key, { ...adapter,
        async execute(invocation, context) {
          observed.push(invocation.recipeKnowledge);
          const result = await adapter.execute(invocation, context);
          if (driftAfterFirst && invocation.node.nodeId === "first")
            fs.appendFileSync(path.join(prepared.root, "notes/Bound.md"), "Changed after the first real command effect.\n");
          return result;
        },
      }]));
    } });
  return { env, evidence, observed, note, skill, trusted };
}
function start(env, evidence, state) {
  return { namespace: env.binding.namespace, chatId: env.binding.chatId, operationId: randomUUID(),
    recipeId: evidence.recipeId, expectedDigest: state.digest, inputs: { mode: "complete", literal: evidence.literal } };
}
test("original ProjectStore Note/Skill bindings become pinned data-only SQL context and real command execution over SDK MCP and HTTP", { skip, timeout: 90000 }, async t => {
  const { env, evidence, observed, note, skill } = await setup(t, "indexed");
  const sourceCatalog = await env.authority.catalog(env.binding);
  const original = sourceCatalog.recipes.find(item => item.recipeId === evidence.recipeId);
  const resolved = env.authority.resolveRecipe({ kind: "recipe", recipeId: evidence.recipeId,
    expectedRevision: original.revision, expectedExecutableDigest: original.executableDigest,
    snapshotRevision: sourceCatalog.snapshotRevision });
  assert.equal(resolved.recipeKnowledge.knowledge.length, 2);
  const state = await env.authority.state(env.binding), row = state.recipes.find(item => item.recipeId === evidence.recipeId);
  assert.equal(row.available, true);
  assert.equal(row.recipeKnowledge.executionAuthority, false);
  assert.deepEqual(row.recipeKnowledge.knowledge.map(item => item.document).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [note, skill].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const actor = { id: env.actorId, canWrite: true, recipeProtocol: true }, token = randomUUID();
  const mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, actor, token);
  const http = await (await load("http")).startHttp(env.runtime.core, token, actor, 0);
  const client = new Client({ name: "bound-actual-recipe", version: "1" });
  t.after(async () => { await client.close(); await mcp.close(); http.server.closeAllConnections();
    await new Promise(resolve => http.server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const snapshot = await env.authority.catalog(env.binding);
  const compiled = await client.callTool({ name: "capability_read", arguments: { operation: "workflow.definition.compile", version: 1,
    arguments: { source: { kind: "recipe", recipeId: evidence.recipeId, expectedRevision: original.revision,
      expectedExecutableDigest: original.executableDigest, snapshotRevision: snapshot.snapshotRevision } } } });
  assert(!compiled.isError, JSON.stringify(compiled));
  assert.equal(compiled.structuredContent.result.bindings.knowledge, 2);
  const input = start(env, evidence, state);
  const noApproval = await client.callTool({ name: "capability_call", arguments: {
    operation: "recipe.runtime.start", version: 1, arguments: input } });
  assert(noApproval.isError, "Knowledge read authority is not an executable grant.");
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: input });
  const response = await fetch(`${http.url}/v1/capability_call`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "recipe.runtime.start", version: 1, arguments: input }) });
  const result = await response.json(); assert(!result.error, JSON.stringify(result));
  for (let i = 0; i < 500 && observed.length < 2; i++) await wait(10);
  for (let i = 0; i < 500 && env.runtime.services.workflow.get(env.actorId, result.result.runId).state !== "succeeded"; i++) await wait(10);
  assert.equal(env.runtime.services.workflow.get(env.actorId, result.result.runId).state, "succeeded");
  assert.equal(observed[0].knowledge.length, 2);
  assert.equal(observed[1].knowledge.length, 0, "A Step receives only its own pinned bindings.");
  assert.equal(fs.readFileSync(evidence.effects, "utf8").trim().split("\n").length, 2);
  assert(observed.every(item => item.executionAuthority === false));
});
test("Knowledge drift after a real first command effect prevents the dependent Step from claiming or executing", { skip, timeout: 60000 }, async t => {
  const { env, evidence, observed } = await setup(t, "indexed", true);
  const state = await env.authority.state(env.binding), input = start(env, evidence, state);
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: input });
  const response = await env.runtime.core.dispatch("capability_call", {
    operation: "recipe.runtime.start", version: 1, arguments: input },
    { id: env.actorId, canWrite: true, recipeProtocol: true });
  assert(!response.error, JSON.stringify(response));
  for (let i = 0; i < 500 && !fs.existsSync(evidence.effects); i++) await wait(10);
  for (let i = 0; i < 500 && env.runtime.services.workflow.get(env.actorId, response.result.runId).nodes[0].state !== "unknown"; i++) await wait(10);
  await wait(200);
  const run = env.runtime.services.workflow.get(env.actorId, response.result.runId);
  assert.equal(run.nodes[0].state, "unknown", "Effect acknowledged after scope drift must not be presented as a fresh known result.");
  assert.equal(run.nodes[0].effect, "unknown");
  assert.equal(run.nodes[1].effect, "not-started");
  assert.equal(observed.length, 1);
  assert.equal(fs.readFileSync(evidence.effects, "utf8").trim().split("\n").length, 1);
});
test("existing documents index admits only exact host document IDs, rejects stale indexed bytes and symlink replacement before claim", { skip, timeout: 60000 }, async t => {
  const { env, evidence, observed } = await setup(t, "indexed");
  const state = await env.authority.state(env.binding);
  assert.equal(state.recipes.find(item => item.recipeId === evidence.recipeId).available, true);
  assert.equal((await env.authority.documents(env.binding)).length, 2);
  const input = start(env, evidence, state);
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: input });
  const file = path.join(env.root, "notes/Bound.md"), raw = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, "Unindexed change.\n");
  await assert.rejects(env.authority.documents(env.binding), /indexed bytes/);
  let result = await env.runtime.core.dispatch("capability_call", {
    operation: "recipe.runtime.start", version: 1, arguments: input },
    { id: env.actorId, canWrite: true, recipeProtocol: true });
  assert(result.error);
  fs.writeFileSync(file, raw);
  const outside = path.join(env.base, "outside.md"); fs.writeFileSync(outside, raw, { mode: 0o600 });
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  await assert.rejects(env.authority.documents(env.binding));
  assert.equal(observed.length, 0);
  assert.equal(env.runtime.services.workflow.list(env.actorId).length, 0);
  assert(!fs.existsSync(evidence.effects));
  const database = env.storage.connectNative();
  try {
    const { readIndexedRecipeKnowledgeDocuments } = await load("recipe-knowledge-reader");
    assert.throws(() => readIndexedRecipeKnowledgeDocuments({ root: env.root, database,
      documentIds: ["not_explicitly_present"], assertLease: () => env.storage.assertWorkspaceLease() }), /host-approved/);
  } finally { database.close(); }
});
test("missing knowledge authority and changed original Note bytes fail before effects; cached documents cannot authorize stale content", { skip, timeout: 60000 }, async t => {
  const disabled = await setup(t, false);
  let state = await disabled.env.authority.state(disabled.env.binding);
  assert.equal(state.recipes.find(item => item.recipeId === disabled.evidence.recipeId).available, false);
  assert.equal(disabled.env.publicRecipes.available("project.recipe.bundle.get"), false);
  await assert.rejects(disabled.env.authority.create(disabled.env.binding, start(disabled.env, disabled.evidence, state)), /qualified/);
  const { env, evidence, observed } = await setup(t);
  state = await env.authority.state(env.binding);
  const input = start(env, evidence, state);
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: input });
  fs.appendFileSync(path.join(env.root, "notes/Bound.md"), "Changed after approval.\n");
  const actor = { id: env.actorId, canWrite: true, recipeProtocol: true };
  const response = await env.runtime.core.dispatch("capability_call", {
    operation: "recipe.runtime.start", version: 1, arguments: input }, actor);
  assert(response.error);
  assert.equal(observed.length, 0);
  assert(!fs.existsSync(evidence.effects));
  assert.equal(env.runtime.services.workflow.list(env.actorId).length, 0);
});
