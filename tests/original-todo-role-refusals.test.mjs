import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { originalTodoRoleDigest as digest, originalTodoRolePins, parseOriginalTodoRolePayload,
  parseOriginalTodoRoleDecision } from "../dist/original-mcp-todo-role-contracts.js";
import { readOriginalTodoRoleAdmission, createOriginalNativeTodoRoles } from "../dist/original-mcp-todo-role-native.js";
import { OriginalTodoRoleGate } from "../dist/original-mcp-todo-role-gate.js";
import { withinOriginalTodoRoleScope, readOriginalTodoRoleScope } from "../dist/original-mcp-todo-role-scope.js";
import { startInstalledNativeTodoRoleObserver } from "../clients/vscode-host/installed-native-todo-role-ui.mjs";

function untrustedRequest() {
  const epoch = randomUUID(), brokerId = randomUUID(), chatId = randomUUID();
  const session = { brokerId, activationId: epoch, epoch, identitySha256: "a".repeat(64), binding: {
    root: "/pkm-v5-disposable-synthetic-role-refusal", workspaceId: randomUUID(), planSha256: "b".repeat(64),
    profileSha256: "c".repeat(64), catalogSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64),
  } };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256,
    profileSha256: session.binding.profileSha256, sourceCatalogSha256: session.binding.catalogSha256,
    authorityId: `native-rpc:${brokerId}`, epoch, actorId: "mcp:external",
    domains: ["model-provider", "tool-approval", "mcp-public", "api-chat-native"], configurationSha256: "1".repeat(64) };
  const request = { schema: "pkm.original-native-todo-role-request/v1", role: "worker", root: binding.root,
    workspaceId: binding.workspaceId, custodyPlanSha256: binding.planSha256, profileSha256: binding.profileSha256,
    catalogSha256: binding.sourceCatalogSha256, nativeHostReceiptSha256: digest(binding), nativeEpoch: epoch,
    nativeBrokerId: brokerId, nativeIdentitySha256: session.identitySha256, ownerLease: { ownerId: randomUUID(), fence: 1 },
    boardSlug: "Synthetic/RoleRefusal", workItemId: "role-refusal", boardDigest: "2".repeat(64),
    intentSha256: "3".repeat(64), todoDecisionId: randomUUID(), chatSourcePlanSha256: "4".repeat(64),
    chatSourceDecisionId: randomUUID(), expiresAtMs: Date.now() + 60000, actorId: `chat:${chatId}`, chatId,
    chatUrl: `pkm://chats/1234567890abcdef/${chatId}`, chatRevision: 1, bindingRequestId: "5".repeat(64),
    bindingSha256: "6".repeat(64), requestId: "7".repeat(64), planSha256: "8".repeat(64),
    modelId: "untrusted-model-identity", selectionId: randomUUID() };
  const payload = { binding, request };
  const pins = Object.fromEntries(Object.keys(originalTodoRolePins.shape).map(key => [key, request[key]]));
  const workerProof = { requestId: request.requestId, planSha256: request.planSha256, operationId: randomUUID(),
    actorId: request.actorId, decisionId: randomUUID(), requestSha256: "9".repeat(64) };
  // Hypothetical untrusted request data only. No canonical role result or human grant is created.
  const item = { id: request.workItemId, state: "Done", evidence: ["untrusted-input-is-not-live-evidence"], ownerId: request.actorId };
  const human = { binding, request: { ...pins, schema: "pkm.original-native-todo-human-request/v1",
    actorId: "user:local", operationId: randomUUID(), item, itemSha256: digest(item), worker: workerProof,
    reviewer: { ...workerProof, actorId: `chat:${randomUUID()}`, operationId: randomUUID() } } };
  return { payload, human, session };
}

test("role payloads refuse wrong Chat/root/profile/custody/native owner and expired or traversing scope", () => {
  const f = untrustedRequest();
  for (const [key, value] of [["root", "/other-root"], ["profileSha256", "0".repeat(64)],
    ["custodyPlanSha256", "0".repeat(64)], ["nativeHostReceiptSha256", "0".repeat(64)],
    ["actorId", `chat:${randomUUID()}`], ["expiresAtMs", Date.now() - 1], ["expiresAtMs", Date.now() + 600000],
    ["boardSlug", "../Private/Board"]]) {
    assert.throws(() => parseOriginalTodoRolePayload("todo.role.approve",
      { ...f.payload, request: { ...f.payload.request, [key]: value } }, f.session), undefined, key);
  }
  assert.throws(() => parseOriginalTodoRolePayload("todo.role.approve", f.payload,
    { ...f.session, brokerId: randomUUID() }));
  assert.throws(() => parseOriginalTodoRolePayload("todo.human.accept", {
    ...f.human, request: { ...f.human.request, item: { ...f.human.request.item, acceptanceDecision: { decision: "accepted" } } },
  }, f.session));
});

test("copied capsules and fabricated decisions never enter canonical role/human Storage", async () => {
  const f = untrustedRequest(), owner = {}, storage = {};
  for (const input of [null, {}, f.payload, f.human, structuredClone(f.payload), { decision: "approve" }])
    await assert.rejects(readOriginalTodoRoleAdmission(input, owner, storage), /genuine exact native/);
  await assert.rejects(createOriginalNativeTodoRoles(owner, {}, {}));
  for (const change of [{ actorId: `chat:${randomUUID()}` }, { expiresAtMs: Date.now() - 1 },
    { requestSha256: "0".repeat(64) }, { epoch: randomUUID() }]) {
    assert.throws(() => parseOriginalTodoRoleDecision("todo.role.approve", {
      schema: "pkm.original-native-todo-role-decision/v1", actorId: f.payload.request.actorId,
      decisionId: randomUUID(), requestSha256: digest(f.payload), epoch: f.session.epoch,
      expiresAtMs: Date.now() + 10000, ...change,
    }, f.payload));
  }
});

test("generic parent calls cannot manufacture the canonical worker role bracket or effect admission", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('unchanged'); BEGIN IMMEDIATE");
    assert.throws(() => withinOriginalTodoRoleScope(db, {
      root: "/pkm-v5-disposable-synthetic-role-refusal", actorId: `chat:${randomUUID()}`, boardSlug: "Synthetic/RoleRefusal",
    }, () => db.exec("DELETE FROM sentinel")), /canonical private worker transaction/);
    assert.equal(readOriginalTodoRoleScope("/pkm-v5-disposable-synthetic-role-refusal", db, "user:local"), undefined);
    const gate = new OriginalTodoRoleGate("/pkm-v5-disposable-synthetic-role-refusal", db, () => assert.fail("No Chat authority may be read."));
    assert.throws(() => gate.admit({ kind: "human", decision: "approve" }, {}), /canonical private Storage worker/);
    assert.equal(db.prepare("SELECT value FROM sentinel").get().value, "unchanged");
    db.exec("ROLLBACK");
  } finally { db.close(); }
});
test("role DOM observer refuses an ordinary checkout before launching any browser or UI child", async () => {
  await assert.rejects(startInstalledNativeTodoRoleObserver({
    root: resolve("."), python: process.execPath, env: {}, port: 1, timeoutMs: 1000,
  }), /PRIVATE_OBSERVER_REQUIRED/);
});

const require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-todo-role.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "deny-only-signer-double", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "deny-only-role-signer", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path => /(?:storage|original-mcp-native-host|original-mcp-todo-role-native)\.ts$/.test(path)));
async function deniedProducer(t) {
  const f = untrustedRequest(), choices = [], reasons = [], prompts = [], lifetime = new AbortController();
  const signer = { activationId: f.session.activationId, signal: lifetime.signal,
    identity: { sha256: f.session.identitySha256, profileSha256: f.session.binding.profileSha256 },
    payloadBuildId: f.session.binding.payloadBuildId, hostEntrySha256: f.session.binding.hostEntrySha256, assertCurrent() {} };
  const module = new Module(resolve("clients/vscode-host/.todo-role-denial-memory.cjs"));
  module.filename = module.id;
  module.require = name => name === "deny-only-role-signer" ? { originalMcpNativeSigner: async () => signer }
    : name === "vscode" ? { StatusBarAlignment: { Left: 1 },
      commands: { registerCommand: () => ({ dispose() {} }) },
      workspace: { isTrusted: true, onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
      window: {
        showWarningMessage(title, options, ...buttons) { prompts.push({ title, detail: JSON.parse(options.detail), buttons }); return choices.shift(); },
        showInputBox() { return reasons.shift(); },
        createStatusBarItem() { assert.fail("A denied/cancelled request cannot produce a live role status control."); },
      } } : require(name);
  module._compile(built.outputFiles[0].text, module.filename);
  const producer = await module.exports.createOriginalMcpNativeTodoRoleProducer({ subscriptions: [] }, {
    session: f.session, signal: lifetime.signal, assertCurrent() {}, async close() { lifetime.abort(); },
  });
  t.after(() => producer.dispose());
  return { ...f, producer, choices, reasons, prompts, handle: (method, payload, id = randomUUID(), signal = lifetime.signal) =>
    producer.handle(method, payload, id, signal) };
}
test("native Todo role and human UI default Deny, unrelated approval labels and dismissal produce no grants", async t => {
  const f = await deniedProducer(t);
  for (const choice of ["Deny", "Approve this request", undefined]) {
    f.choices.push(choice);
    assert.equal(await f.handle("todo.role.approve", f.payload), null);
    assert.equal(f.prompts.at(-1).buttons[0], "Deny");
    f.choices.push(choice);
    assert.equal(await f.handle("todo.human.accept", f.human), null);
    assert.equal(f.prompts.at(-1).buttons[0], "Deny");
  }
});
test("late consent, cancelled reason entry and replay cannot produce a role result or human acceptance", async t => {
  const f = await deniedProducer(t), cancel = new AbortController();
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const pending = f.handle("todo.role.approve", f.payload, randomUUID(), cancel.signal);
  cancel.abort(); await assert.rejects(pending, /CANCELLED/); answer("Grant this exact Todo role");
  f.choices.push("Accept this exact reviewed workitem"); f.reasons.push(undefined);
  assert.equal(await f.handle("todo.human.accept", f.human), null);
  const id = randomUUID(); f.choices.push("Deny");
  assert.equal(await f.handle("todo.role.approve", f.payload, id), null);
  await assert.rejects(f.handle("todo.role.approve", f.payload, id), /CANCELLED/);
});
