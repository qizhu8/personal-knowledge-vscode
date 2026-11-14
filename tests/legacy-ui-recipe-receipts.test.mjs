import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { load, capture, open } from "./legacy-api-chat-recipes-fixtures.mjs";

const source = process.env.PKM_TEST_LEGACY_RECIPE_PROFILE;
const skip = !source && "Requires an actual closed synthetic installed original Recipe profile.";
const require = createRequire(import.meta.url);
function original() {
  assert(fs.realpathSync(source).startsWith(path.resolve(".migration-test-work") + path.sep));
  const state = path.join(source, "knowledge/.pkm/state");
  const read = name => JSON.parse(fs.readFileSync(path.join(state, name)));
  const current = read("projects.json"), control = read("project-store.json");
  return { current, control, baseline: read(`project-store-migration/backups/${control.migration.sourceDigest}.projects.json`) };
}
function clone(t, cleanup = true) {
  original();
  const base = path.resolve(`.migration-test-work/recipe-receipt-${randomUUID()}`), root = path.join(base, "knowledge");
  fs.mkdirSync(base, { mode: 0o700 });
  fs.cpSync(path.join(source, "knowledge"), root, { recursive: true });
  if (cleanup) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}
test("actual old Recipe receipts live in canonical control, not retained envelope; preserve exact cutover backup", { skip }, async () => {
  const { current, control, baseline } = original();
  const { validateLegacyRecipeReceiptEvolution } = await load("legacy-ui-recipe-receipts");
  assert.deepEqual(current.payload.receipts, []);
  assert.equal(control.receipts[0].operation, "recipe-create");
  assert.notEqual(current.digest, control.migration.sourceDigest);
  const evidence = validateLegacyRecipeReceiptEvolution(current, control, baseline);
  assert.equal(evidence.baselineDigest, baseline.digest);
  assert.deepEqual(evidence.receipts, control.receipts);
});
test("unknown, damaged, duplicate and cross-domain receipt histories remain closed", { skip }, async () => {
  const { validateLegacyRecipeReceiptEvolution } = await load("legacy-ui-recipe-receipts");
  const cases = [
    ({ control }) => { control.receipts[0].operation = "skill-restore"; },
    ({ control }) => { control.receipts[1].commandId = control.receipts[0].commandId; },
    ({ control }) => { control.receipts[1].storeVersion++; },
    ({ control }) => { control.receipts[0].unexpected = true; },
    ({ control }) => { control.migration.sourceDigest = "0".repeat(64); },
    ({ current }) => { current.payload.state.recipes.at(-1).revision++; },
    ({ baseline }) => { baseline.payload.state.audit.push({ event: "unknown" }); },
    ({ current }) => { current.payload.receipts.push({ operation: "unknown" }); },
    ({ current }) => { current.payload.state.projects[0].name = "forged non-Recipe domain"; },
    ({ current }) => { current.payload.state.recipes[0].description += " forged built-in"; },
    ({ current }) => { current.payload.state.recipes.at(-1).unrecognizedIntent = true; },
  ];
  for (const change of cases) {
    const data = structuredClone(original()); change(data);
    for (const envelope of [data.current, data.baseline])
      envelope.digest = createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
    assert.throws(() => validateLegacyRecipeReceiptEvolution(data.current, data.control, data.baseline));
  }
});
test("real original Recipe/run/health archive passes; unknown files, pending health and resealed corruption do not", { skip }, async t => {
  const { root } = clone(t);
  const { inspectLegacyUiBootstrapCompatibility } = await load("legacy-ui-bootstrap-compatibility");
  const proof = inspectLegacyUiBootstrapCompatibility(root);
  assert.equal(proof.project.counts.recipes, original().current.payload.state.recipes.length);
  assert(proof.files.some(file => file.path === ".pkm/state/recipe-health.json"));
  const state = path.join(root, ".pkm/state"), health = path.join(state, "recipe-health.json");
  const bytes = fs.readFileSync(health), value = JSON.parse(bytes);
  value.candidateRequests.push({ state: "pending" });
  fs.writeFileSync(health, JSON.stringify(value)); assert.throws(() => inspectLegacyUiBootstrapCompatibility(root));
  fs.writeFileSync(health, bytes);
  const lock = path.join(state, "recipe-runs/unknown.lock");
  fs.writeFileSync(lock, "unknown owner", { mode: 0o600 });
  assert.throws(() => inspectLegacyUiBootstrapCompatibility(root)); fs.unlinkSync(lock);
  const run = fs.readdirSync(path.join(state, "recipe-runs")).find(name => name.endsWith(".json"));
  const file = path.join(state, "recipe-runs", run), raw = fs.readFileSync(file), changed = JSON.parse(raw);
  changed.unrecognizedIntent = true;
  fs.writeFileSync(file, JSON.stringify(changed)); assert.throws(() => inspectLegacyUiBootstrapCompatibility(root));
  fs.writeFileSync(file, raw); assert(inspectLegacyUiBootstrapCompatibility(root));
  const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
  const forgedHealth = JSON.parse(bytes), receipt = Object.values(forgedHealth.receipts)[0];
  const completedFile = path.join(state, "recipe-runs", `${receipt.runId}.json`);
  const completedBytes = fs.readFileSync(completedFile), completed = JSON.parse(completedBytes);
  completed.usage.records[0].unrecognizedIntent = true;
  fs.writeFileSync(completedFile, JSON.stringify(completed));
  assert.throws(() => inspectLegacyUiBootstrapCompatibility(root));
  fs.writeFileSync(completedFile, completedBytes);
  receipt.cost.unknown.unrecognizedAuthority = true;
  const { receiptDigest: oldDigest, evidenceRef: _oldRef, ...body } = receipt;
  receipt.receiptDigest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  receipt.evidenceRef = `pkm://recipe-health/${receipt.receiptDigest}`;
  const resealed = JSON.parse(completedBytes);
  resealed.healthReceipt.receiptDigest = receipt.receiptDigest;
  resealed.healthReceipt.evidenceRef = receipt.evidenceRef;
  for (const aggregate of forgedHealth.aggregates)
    for (const evidence of aggregate.recentEvidence)
      if (evidence.evidenceRef === `pkm://recipe-health/${oldDigest}`) evidence.evidenceRef = receipt.evidenceRef;
  fs.writeFileSync(health, JSON.stringify(forgedHealth));
  fs.writeFileSync(completedFile, JSON.stringify(resealed));
  assert.throws(() => inspectLegacyUiBootstrapCompatibility(root));
  fs.writeFileSync(health, bytes); fs.writeFileSync(completedFile, completedBytes);
  assert(inspectLegacyUiBootstrapCompatibility(root));
  fs.mkdirSync(path.join(root, "recipes"), { mode: 0o700 });
  assert.throws(() => inspectLegacyUiBootstrapCompatibility(root), /Mixed original ProjectStore/);
});
test("actual same copied root adopts original library without filesystem projection, executes native IO and restarts without replay", { skip, timeout: 60000 }, async t => {
  const { base, root } = clone(t, false), before = capture(root);
  let env;
  t.after(async () => { try { await env?.close(); } finally { fs.rmSync(base, { recursive: true, force: true }); } });
  const nonce = randomUUID();
  fs.writeFileSync(path.join(base, "in-place-fixture-token"), nonce, { mode: 0o600 });
  fs.writeFileSync(path.join(base, "native-ui-fixture-token"), nonce, { mode: 0o600 });
  fs.mkdirSync(path.join(base, "workspace"), { mode: 0o700 });
  fs.copyFileSync(path.join(source, "workspace/recipe-input.txt"), path.join(base, "workspace/recipe-input.txt"));
  const evidence = JSON.parse(fs.readFileSync(path.join(source, "original-recipe-evidence.json")));
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption");
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: base, root, nonce }));
  const adopted = await resumeLegacyRootAdoptionExperimental(root, options({ fixture: base, root, nonce, workspaceId: prepared.workspaceId }));
  await adopted.storage.close();
  assert(!fs.existsSync(path.join(root, "recipes")), "Do not fabricate a canonical filesystem projection.");
  const config = { base, fixture: base, nonce, root, originalRoot: root, evidence,
    actorId: randomUUID(), chatId: randomUUID(), sourceFingerprint: "a".repeat(64) };
  env = await open(config, { library: true });
  const initial = await env.authority.state(env.binding);
  assert(initial.recipes.some(item => item.recipeId === evidence.recipeId && item.available));
  assert.equal(initial.originalRuns.find(run => run.runId === evidence.unknownRunId).state, "unknown");
  assert.equal(initial.originalRuns.find(run => run.runId === evidence.completedRunId).name, "SATURN trusted original Recipe");
  const created = await env.authority.create(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    expectedDigest: initial.digest, operationId: randomUUID(), recipeId: evidence.recipeId, inputs: { mode: "complete" } });
  let state;
  for (let index = 0; index < 300; index++) {
    state = await env.authority.state(env.binding);
    if (state.runs.find(run => run.runId === created.runId)?.state === "succeeded") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state.runs.find(run => run.runId === created.runId).state, "succeeded");
  assert.equal(fs.readFileSync(env.effects, "utf8").trim().split("\n").length, 1);
  const authorIdentity = { namespace: env.binding.namespace, chatId: env.binding.chatId };
  const editor = await env.authority.editor(env.binding, { ...authorIdentity, recipeId: evidence.recipeId, copy: true });
  const draft = editor.recipe;
  const fields = Object.fromEntries(["name", "category", "description", "definition", "metadata", "methodology",
    "editorLayout", "nodeBindings"].filter(key => key in draft).map(key => [key, draft[key]]));
  fields.name = "Actually persisted same-root library";
  const authored = await env.authority.saveLibrary(env.binding, { ...authorIdentity, operationId: randomUUID(),
    recipeId: draft.recipeId, expectedRevision: 0, expectedDigest: editor.digest, fields });
  assert.equal(authored.recipe.revision, 1);
  const originalEditor = await env.authority.editor(env.binding, { ...authorIdentity, recipeId: evidence.recipeId });
  const originalFields = { ...fields, name: originalEditor.recipe.name, description: "Native overlay preserves original identity." };
  const revised = await env.authority.saveLibrary(env.binding, { ...authorIdentity, operationId: randomUUID(),
    recipeId: evidence.recipeId, expectedRevision: originalEditor.recipe.revision,
    expectedDigest: originalEditor.digest, fields: originalFields });
  assert.equal(revised.recipe.knowledgeId, originalEditor.recipe.knowledgeId);
  assert.deepEqual(revised.recipe.aliases, originalEditor.recipe.aliases);
  assert.equal(revised.recipe.revision, originalEditor.recipe.revision + 1);
  await env.close(); env = await open(config, { library: true });
  const reopened = await env.authority.editor(env.binding, { ...authorIdentity, recipeId: draft.recipeId });
  assert.equal(reopened.recipe.name, fields.name); assert.equal(reopened.recipe.revision, 1);
  assert(!fs.existsSync(path.join(root, "recipes")), "Native authored rows are not fake filesystem projections.");
  assert.equal((await env.authority.state(env.binding)).runs[0].state, "succeeded");
  assert.equal(fs.readFileSync(env.effects, "utf8").trim().split("\n").length, 1);
  const after = capture(root);
  for (const [file, pin] of Object.entries(before)) if (pin.at(-1) !== null)
    assert.deepEqual(after[file], pin, `Original source file changed: ${file}`);
});
