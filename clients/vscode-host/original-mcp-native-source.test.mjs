import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const { build } = require("esbuild");
const built = await build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-source.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "fixture-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "source-fixture-signer", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path =>
  /(?:storage|original-mcp-native-host|original-mcp-native-source-policy|retained-runtime)\.ts$/.test(path)),
"Native source UI must not import the Node Core/Storage authority.");
const { originalNativeSourceRequestDigest: digest, parseOriginalNativeSourcePayload } =
  await import("../../dist/original-mcp-native-source-contracts.js");
const yes = "Admit this exact source only";
async function fixture(t) {
  const choices = [], prompts = [], commands = new Map(), bars = [], attachment = new AbortController(), signed = new AbortController();
  const epoch = randomUUID(), session = {
    brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "a".repeat(64),
    binding: { root: "/fixture/original-source", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) },
  };
  let alive = true, trusted = true, changed, closes = 0;
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
    epoch, actorId: "mcp:external", domains: ["model-provider", "mcp-public"], configurationSha256: "1".repeat(64) };
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256, signal: signed.signal,
    assertCurrent() { if (!alive) throw new Error("Native signed owner changed."); } };
  const load = Module._load, context = { subscriptions: [] };
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "source-fixture-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return {
        StatusBarAlignment: { Left: 1 }, commands: { registerCommand(name, callback) {
          commands.set(name, callback); return { dispose() { commands.delete(name); } };
        } },
        workspace: { get isTrusted() { return trusted; }, onDidChangeWorkspaceFolders(callback) {
          changed = callback; return { dispose() {} };
        } },
        window: {
          showWarningMessage(title, options) { prompts.push({ title, detail: JSON.parse(options.detail) }); return choices.shift(); },
          showErrorMessage() {},
          createStatusBarItem() { const bar = { show() {}, dispose() { bar.disposed = true; } }; bars.push(bar); return bar; },
        },
      };
      return load.call(this, id, ...args);
    };
    const name = join(root, "clients/vscode-host", `.source-producer-memory-${randomUUID()}.cjs`), compiled = new Module(name);
    compiled.filename = name; compiled.paths = Module._nodeModulePaths(join(root, "clients/vscode-host"));
    compiled._compile(built.outputFiles[0].text, name); api = compiled.exports;
  } finally { Module._load = load; }
  const producer = await api.createOriginalMcpNativeSourceProducer(context, { session, signal: attachment.signal,
    assertCurrent() { if (!alive) throw new Error("Native signed attachment changed."); },
    async close() { closes++; attachment.abort(); },
  });
  t.after(() => producer.dispose());
  const base = { schema: "pkm.original-mcp-domain-approval-request/v1", phase: "hydrate-and-activate",
    root: binding.root, workspaceId: binding.workspaceId, custodyPlanSha256: binding.planSha256, profileSha256: binding.profileSha256,
    nativeHostReceiptSha256: digest(binding), actorId: "mcp:external" };
  const files = [{ key: "Team/Board", sha256: "2".repeat(64), sourcePath: "notes/Team/Board.assets/pkm-todo-board.json",
    notePath: "notes/Team/Board.md", noteSha256: "3".repeat(64), title: "Exact original Board" }];
  const todo = { binding, noExecution: true, request: {
    ...base, domain: "todo", files, sourceSha256: digest(files), sourceDetails: { domain: "todo", boards: 1 },
  } };
  const memory = { binding, noExecution: true, request: {
    ...base, domain: "memory", files: [{ key: "memory-original-record", sha256: "4".repeat(64), stagedPath: "/fixture/stage/record.md" }],
    sourceSha256: "5".repeat(64), sourceDetails: { domain: "memory", sourceDatabaseSha256: "6".repeat(64),
      sourceScopeSha256: "7".repeat(64), importPlanSha256: "8".repeat(64), importReceiptSha256: "9".repeat(64),
      engineIdentity: "original-engine/source-fixture", documentIdentity: "source-derived/v1", records: 1, revisions: 3 },
  } };
  const plan = { schema: "pkm.original-api-chat-source/v1", root: binding.root, workspaceId: binding.workspaceId,
    custodyPlanSha256: binding.planSha256, profileSha256: binding.profileSha256, indexPath: "/fixture/stage/chat-index.sqlite",
    indexSha256: "0".repeat(64), chats: 12, messages: 125, controls: 4,
    limits: { maxChats: 16, maxMessagesPerChat: 1000, maxMessages: 10000 } };
  const chat = { binding, noExecution: true, request: { ...plan, planSha256: digest(plan),
    phase: "admit", nativeHostReceiptSha256: digest(binding) } };
  const handle = (domain, payload, id = randomUUID(), signal = new AbortController().signal) =>
    producer.handle(`${domain}.source.approve`, payload, id, signal);
  return { producer, session, binding, todo, memory, chat, handle, choices, prompts, commands, bars, signed, attachment,
    closes: () => closes, invalidate: () => { alive = false; }, untrust: () => { trusted = false; }, changed: () => changed() };
}

test("source decisions require three independent exact UI approvals, with no inherited model/public/worker permission", async t => {
  const f = await fixture(t);
  assert.equal(f.prompts.length, 0);
  for (const domain of ["todo", "memory", "chat"]) {
    f.choices.push(yes);
    const decision = await f.handle(domain, f[domain]);
    assert.equal(decision.actorId, "mcp:external");
    assert(decision.expiresAtMs > Date.now() && decision.expiresAtMs <= Date.now() + 300000);
    assert.deepEqual(f.prompts.at(-1).detail.request, f[domain].request);
    assert.equal(f.prompts.at(-1).detail.requestSha256, digest(f[domain]));
    assert.equal(f.prompts.at(-1).detail.noExecution, true);
  }
  assert.equal(f.prompts.length, 3);
  assert.equal(new Set(f.bars.map(bar => bar.command)).size, 3);
  f.choices.push("Deny"); assert.equal(await f.handle("memory", f.memory), null);
  assert.equal(f.bars[1].disposed, true);
  assert.notEqual(f.bars[0].disposed, true, "A Memory denial is not a Todo decision.");
});

test("source parsing rejects cross-domain grants, mismatched custody/profile/host/epoch and changed Chat capsule hashes", async t => {
  const f = await fixture(t);
  for (const field of ["root", "workspaceId", "custodyPlanSha256", "profileSha256", "nativeHostReceiptSha256"]) {
    const payload = structuredClone(f.todo);
    payload.request[field] = field === "workspaceId" ? randomUUID() : field === "root" ? "/another/root" : "0".repeat(64);
    await assert.rejects(f.handle("todo", payload), /BINDING_MISMATCH/);
  }
  await assert.rejects(f.handle("todo", { ...f.todo, noExecution: false }));
  await assert.rejects(f.handle("todo", f.memory));
  await assert.rejects(f.handle("memory", f.todo));
  await assert.rejects(f.handle("chat", { ...f.chat, request: { ...f.chat.request, messages: 999 } }), /PLAN_CHANGED/);
  await assert.rejects(f.handle("todo", { ...f.todo, binding: { ...f.binding, epoch: randomUUID() } }), /BINDING_MISMATCH/);
  assert.equal(f.prompts.length, 0);
  const empty = { ...f.memory, request: { ...f.memory.request, files: [],
    sourceDetails: { ...f.memory.request.sourceDetails, records: 0, revisions: 0 } } };
  assert.doesNotThrow(() => parseOriginalNativeSourcePayload("memory.source.approve", empty, f.session));
});

test("oversized exact Board selections refuse explicitly before UI instead of truncating source identity", async t => {
  const f = await fixture(t), payload = structuredClone(f.todo);
  payload.request.files = Array.from({ length: 200 }, (_, index) => ({
    ...payload.request.files[0], key: `Team/Board${index}`, sourcePath: `notes/Team/Board${index}.assets/pkm-todo-board.json`,
    notePath: `notes/Team/Board${index}.md`, title: "Exact board title ".repeat(100),
  }));
  payload.request.sourceDetails.boards = 200; payload.request.sourceSha256 = digest(payload.request.files);
  await assert.rejects(f.handle("todo", payload), error =>
    error.code === "NATIVE_REQUEST_TOO_LARGE" && error.requiredBytes > 65536 && /not implemented/.test(error.message));
  assert.equal(f.prompts.length, 0);
});

test("source UI revocation aborts pending approvals and closes the real signed session, not just its status bar", async t => {
  const f = await fixture(t); f.choices.push(yes); await f.handle("todo", f.todo);
  let answer; f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle("memory", f.memory), refused = assert.rejects(waiting, /CANCELLED/);
  await f.commands.get(f.bars[0].command)(); await refused;
  answer(yes);
  assert.equal(f.closes(), 1); assert.equal(f.attachment.signal.aborted, true);
  assert.equal(f.bars[0].disposed, true);
  await assert.rejects(f.handle("chat", f.chat), /CANCELLED/);
  await f.producer.revoke(); assert.equal(f.closes(), 1);
});

test("source status expires visibly without extending its grant or closing independent signed permissions", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = await fixture(t);
  f.choices.push(yes);
  const decision = await f.handle("todo", f.todo);
  assert.match(f.bars[0].tooltip, new RegExp(new Date(decision.expiresAtMs).toISOString()));
  t.mock.timers.tick(300001);
  assert.equal(f.bars[0].disposed, true);
  assert.equal(f.closes(), 0);
  assert.equal(f.attachment.signal.aborted, false);
});

test("cancellation, signed-owner change and replay discard late source approvals without producing a grant", async t => {
  const f = await fixture(t), cancelled = new AbortController();
  let answer; f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle("chat", f.chat, randomUUID(), cancelled.signal);
  const refused = assert.rejects(waiting, /CANCELLED/);
  cancelled.abort(); await refused; answer(yes);
  assert.equal(f.bars.length, 0);
  const id = randomUUID(); f.choices.push("Deny"); assert.equal(await f.handle("todo", f.todo, id), null);
  await assert.rejects(f.handle("todo", f.todo, id), /REQUEST_REPLAY/);
  let late; f.choices.push(new Promise(resolve => { late = resolve; }));
  const changed = f.handle("memory", f.memory); f.invalidate(); late(yes);
  await assert.rejects(changed, /owner changed/);
  const g = await fixture(t); g.untrust(); await assert.rejects(g.handle("todo", g.todo), /BINDING_MISMATCH/);
  g.changed(); await new Promise(resolve => setImmediate(resolve)); assert.equal(g.closes(), 1);
});
