import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-recipe.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "explicit-ui-signer-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "recipe-signer-double", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path =>
  /(?:storage|core|root-owner|original-mcp-native-host|original-mcp-native-request|original-mcp-native-recipe-policy)\.ts$/.test(path)),
"Recipe UI's bundled pure DTOs must not import Node Core, Storage or source authority.");
const yes = "Admit this exact Recipe source only";
async function fixture(t) {
  const choices = [], prompts = [], bars = [], commands = new Map(), attachment = new AbortController(), signerLife = new AbortController();
  const epoch = randomUUID(), session = { brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "a".repeat(64),
    binding: { root: "/synthetic/recipe-source", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) } };
  let alive = true, trusted = true, closes = 0, changed;
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256, signal: signerLife.signal,
    assertCurrent() { if (!alive) throw new Error("Recipe signer double no longer owns this activation."); } };
  const load = Module._load, context = { subscriptions: [] };
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "recipe-signer-double") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return {
        StatusBarAlignment: { Left: 1 },
        commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name); } }; } },
        workspace: { get isTrusted() { return trusted; }, onDidChangeWorkspaceFolders(callback) { changed = callback; return { dispose() {} }; } },
        window: {
          showWarningMessage(title, options) { prompts.push({ title, detail: JSON.parse(options.detail) }); return choices.shift(); },
          showErrorMessage() {},
          createStatusBarItem() { const bar = { show() {}, dispose() { bar.disposed = true; } }; bars.push(bar); return bar; },
        },
      };
      return load.call(this, id, ...args);
    };
    const name = join(root, "clients/vscode-host", `.recipe-producer-memory-${randomUUID()}.cjs`), compiled = new Module(name);
    compiled.filename = name; compiled.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
    compiled._compile(built.outputFiles[0].text, name); api = compiled.exports;
  } finally { Module._load = load; }
  const contracts = await import(process.env.PKM_RECIPE_CONTRACTS_MODULE || "../../dist/original-mcp-native-recipe-contracts.js");
  const hash = contracts.originalNativeRecipeDigest;
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
    epoch, actorId: "mcp:external", domains: ["model-provider", "mcp-public"], configurationSha256: "1".repeat(64) };
  const files = [{ path: ".pkm/state/recipe-runs/recipe_run_original.json", kind: "file", sha256: "2".repeat(64), mtime: "1000", size: "100" }];
  const source = { schema: "pkm.original-recipe-usage-source/v1", root: binding.root, workspaceId: binding.workspaceId,
    custodyPlanSha256: binding.planSha256, profileSha256: binding.profileSha256, sourceSha256: hash(files),
    rowsSha256: "3".repeat(64), files, runsScanned: 1, limits: { maxFiles: 1000, maxFileBytes: 1048576, maxTotalBytes: 16777216 } };
  const payload = { binding, noExecution: true, request: { ...source, planSha256: hash(source), phase: "admit",
    actorId: "mcp:external", epoch, nativeHostReceiptSha256: hash(binding), noExecution: true } };
  const producer = await api.createOriginalMcpNativeRecipeProducer(context, { session, signal: attachment.signal,
    assertCurrent() { if (!alive) throw new Error("Recipe attachment double changed."); },
    async close() { closes++; attachment.abort(); } });
  t.after(() => producer.dispose());
  const handle = (value = payload, id = randomUUID(), signal = new AbortController().signal) =>
    producer.handle("recipe.source.approve", value, id, signal);
  const repin = value => {
    const { phase, actorId, epoch, nativeHostReceiptSha256, noExecution, planSha256, ...source } = value.request;
    value.request.sourceSha256 = hash(value.request.files);
    value.request.planSha256 = hash({ ...source, sourceSha256: value.request.sourceSha256 });
    return value;
  };
  return { producer, handle, payload, choices, prompts, bars, commands, attachment, signerLife, hash, repin,
    closes: () => closes, invalidate: () => { alive = false; }, untrust: () => { trusted = false; }, changed: () => changed() };
}
test("explicit UI/signer doubles: Recipe approval binds the entire source request and imports no other source/execution permission", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.producer.methods, ["recipe.source.approve"]); assert.equal(f.prompts.length, 0);
  f.choices.push(yes);
  const result = await f.handle();
  assert.equal(result.actorId, "mcp:external"); assert.equal(result.requestSha256, f.hash(f.payload.request));
  assert(result.expiresAtMs > Date.now() && result.expiresAtMs <= Date.now() + 300000);
  assert.deepEqual(f.prompts[0].detail.request, f.payload.request);
  assert.equal(f.prompts[0].detail.noExecution, true);
  f.choices.push("Deny"); assert.equal(await f.handle(), null);
  assert.equal(f.bars[0].disposed, true);
});
test("Recipe DTO/parser refuses changed custody/profile/epoch/digests/selection and oversized whole frames before UI", async t => {
  const f = await fixture(t);
  for (const [field, value] of [["root", "/other"], ["workspaceId", randomUUID()], ["profileSha256", "0".repeat(64)],
    ["custodyPlanSha256", "0".repeat(64)], ["epoch", randomUUID()], ["nativeHostReceiptSha256", "0".repeat(64)]]) {
    const payload = structuredClone(f.payload); payload.request[field] = value;
    await assert.rejects(f.handle(payload), /BINDING_MISMATCH/);
  }
  await assert.rejects(f.handle({ ...f.payload, noExecution: false }));
  await assert.rejects(f.handle({ ...f.payload, request: { ...f.payload.request, rowsSha256: "0".repeat(64) } }), /PLAN_CHANGED/);
  const duplicate = structuredClone(f.payload); duplicate.request.files.push(duplicate.request.files[0]); duplicate.request.runsScanned = 2;
  await assert.rejects(f.handle(f.repin(duplicate)), /SELECTION_INVALID/);
  const huge = structuredClone(f.payload);
  huge.request.files = Array.from({ length: 600 }, (_, i) => ({
    ...huge.request.files[0], path: `.pkm/state/recipe-runs/recipe_run_${i}_${"original-source".repeat(10)}.json`,
  })); huge.request.runsScanned = 600;
  await assert.rejects(f.handle(f.repin(huge)), error => error.code === "NATIVE_REQUEST_TOO_LARGE"
    && error.requiredBytes > 65536 && /not implemented/.test(error.message));
  assert.equal(f.prompts.length, 0);
});
test("actual close callback in UI double revokes the attachment and aborts pending Recipe approval, not just its status bar", async t => {
  const f = await fixture(t);
  f.choices.push(yes); await f.handle();
  let answer; f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle(), refused = assert.rejects(waiting, /CANCELLED/);
  await f.commands.get(f.bars[0].command)(); await refused; answer(yes);
  assert.equal(f.attachment.signal.aborted, true); assert.equal(f.producer.signal.aborted, true); assert.equal(f.closes(), 1);
  assert.equal(f.bars[0].disposed, true);
  await f.producer.revoke(); assert.equal(f.closes(), 1);
});
test("Recipe UI rejects cancellation, replay and stale signer", async t => {
  const f = await fixture(t), cancelled = new AbortController();
  let answer; f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle(f.payload, randomUUID(), cancelled.signal), refused = assert.rejects(waiting, /CANCELLED/);
  cancelled.abort(); await refused; answer(yes); assert.equal(f.bars.length, 0);
  const id = randomUUID(); f.choices.push("Deny"); await f.handle(f.payload, id);
  await assert.rejects(f.handle(f.payload, id), /REQUEST_REPLAY/);
  let late; f.choices.push(new Promise(resolve => { late = resolve; }));
  const stale = f.handle(); f.invalidate(); late(yes); await assert.rejects(stale, /signer double/);
  const g = await fixture(t); g.untrust(); await assert.rejects(g.handle(), /BINDING_MISMATCH/);
  const h = await fixture(t); h.changed(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.closes(), 1);
});
test("Recipe UI expiry removes only its indicator and never renews its bounded source decision", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = await fixture(t);
  f.choices.push(yes);
  const approval = await f.handle(), expiresAtMs = approval.expiresAtMs;
  t.mock.timers.tick(300001);
  assert.equal(f.bars[0].disposed, true); assert.equal(approval.expiresAtMs, expiresAtMs);
  assert.equal(f.closes(), 0); assert.equal(f.attachment.signal.aborted, false);
});
test("finalized-run source has its own exact UI request; usage consent cannot be relabeled as terminal access", async t => {
  const f = await fixture(t), usage = f.payload.request;
  const source = { schema: "pkm.original-recipe-terminal-source/v1", root: usage.root, workspaceId: usage.workspaceId,
    custodyPlanSha256: usage.custodyPlanSha256, profileSha256: usage.profileSha256, runId: "recipe_run_done",
    sourcePath: ".pkm/state/recipe-runs/recipe_run_done.json", sourceSha256: "1".repeat(64), bytes: 100,
    maxFileBytes: 1048576, status: "completed", recordSha256: "2".repeat(64), noExecution: true };
  const request = { ...source, planSha256: f.hash(source), phase: "admit", actorId: "mcp:external", epoch: usage.epoch,
    nativeHostReceiptSha256: usage.nativeHostReceiptSha256 };
  const payload = { binding: f.payload.binding, request, noExecution: true };
  f.choices.push(yes);
  const approval = await f.handle(payload);
  assert.equal(approval.requestSha256, f.hash(request));
  assert.match(f.prompts[0].title, /finalized original Recipe run/);
  assert.match(f.prompts[0].detail.permission, /No usage grant is inherited/);
  assert.equal(f.prompts[0].detail.request.runId, "recipe_run_done");
  assert.match(f.bars[0].tooltip, /Finalized historical run recipe_run_done/);
  await assert.rejects(f.handle({ ...f.payload, request: { ...usage, schema: source.schema } }));
  const wrongPath = { ...source, sourcePath: ".pkm/state/recipe-runs/recipe_run_other.json" };
  await assert.rejects(f.handle({ ...payload, request: { ...request, ...wrongPath, planSha256: f.hash(wrongPath) } }), /SELECTION_INVALID/);
  const changed = { ...request, sourceSha256: "3".repeat(64) };
  await assert.rejects(f.handle({ ...payload, request: changed }), /PLAN_CHANGED/);
});
test("Library source consent is explicit about external-report authority and never inherits usage/terminal or process execution", async t => {
  const f = await fixture(t), existing = f.payload.request;
  const files = [
    { path: ".pkm/state/recipe-store.json", sha256: "1".repeat(64), bytes: 12, pin: "exact-control-pin", authority: "sealed-custody" },
    { path: "recipes/Uncategorized/Original.recipe_original.json", sha256: "2".repeat(64), bytes: 123,
      pin: "exact-canonical-source-pin", authority: "independent-canonical" },
  ];
  const source = { schema: "pkm.original-recipe-library-source/v1", root: existing.root, workspaceId: existing.workspaceId,
    custodyPlanSha256: existing.custodyPlanSha256, profileSha256: existing.profileSha256, files, sourceSha256: f.hash(files),
    recipeId: "recipe_original", revision: 3, executableDigest: "3".repeat(64), recordSha256: "4".repeat(64),
    nodeIds: ["first", "second"], maxFileBytes: 1048576, protocol: "controlled-external-report/v1",
    effects: ["caller-reported-result-only"], noExecution: true };
  const request = { ...source, planSha256: f.hash(source), phase: "admit", actorId: "mcp:external", epoch: existing.epoch,
    nativeHostReceiptSha256: existing.nativeHostReceiptSha256 };
  const payload = { binding: f.payload.binding, noExecution: true, request };
  f.choices.push(yes);
  const result = await f.handle(payload);
  assert.equal(result.requestSha256, f.hash(request));
  assert.match(f.prompts[0].title, /original Recipe library source/);
  assert.match(f.prompts[0].detail.permission, /each original lifecycle request needs its own current public approval/);
  assert.match(f.prompts[0].detail.permission, /Usage and terminal grants enable none/);
  assert.match(f.bars[0].tooltip, /Controlled external-report Library recipe_original@3/);
  const forged = { ...source, effects: ["automatic-model-execution"] };
  await assert.rejects(f.handle({ ...payload, request: { ...request, ...forged, planSha256: f.hash(forged) } }));
  const alias = structuredClone(source); alias.files[1].path = "recipes/../outside.json"; alias.sourceSha256 = f.hash(alias.files);
  await assert.rejects(f.handle({ ...payload, request: { ...request, ...alias, planSha256: f.hash(alias) } }), /SELECTION_INVALID/);
});
