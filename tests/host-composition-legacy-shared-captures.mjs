import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { CoreError } from "../dist/contracts.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { at, hash, payloadFixture, sourceOracle, snapshotOriginalSource } from "./legacy-snapshot-restore-captures.mjs";
import { originalCapture, actor, human, item, markdown, at as inlineAt } from "./legacy-inline-note-captures.mjs";
export { at, hash, sourceOracle, originalCapture, actor, human, item, markdown };

export const call = (core, operation, args, who = human) => core.dispatch(
  operation === "agent.snapshot.restore-get" || operation === "legacy.note.workitems.read" ? "capability_read" : "capability_call",
  { operation, version: 1, arguments: args }, who,
);
// This publisher is deliberately limited to one disposable test parent and absent destinations.
// Production callers still need atomic no-replace host publication; the existing default is unchanged.
export function fixturePublisher(parent) {
  return async (stage, target) => {
    assert.equal(dirname(stage), parent); assert.equal(dirname(target), parent);
    await assert.rejects(lstat(target), { code: "ENOENT" });
    await rename(stage, target);
  };
}
export function originalSnapshotWriter() {
  sourceOracle();
  const require = createRequire(import.meta.url), module = { exports: {} };
  let source = snapshotOriginalSource("src/agent-sessions/agent-snapshots.ts");
  const marker = 'createHash("sha256").update("uone", "utf8").digest()';
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, "Buffer.alloc(32, 7)");
  class PinnedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return Date.parse(at); }
  }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Buffer, Date: PinnedDate,
    require: id => {
      if (id === "../chat/chat-history-storage") return {
        ChatHistoryStorage: class { constructor() { throw new Error("Packed Chat history is outside this synthetic snapshot fixture."); } },
      };
      assert.ok(["crypto", "fs", "path"].includes(id), `Unexpected original snapshot dependency: ${id}`);
      return require(id);
    },
  });
  return module.exports;
}
export async function sharedFixture(t, mutatePayload) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.batch14-shared-${randomUUID()}`);
  const source = join(parent, "original"), root = join(parent, "native");
  await mkdir(join(source, "notes"), { recursive: true });
  await writeFile(join(source, "notes/Original.md"), markdown);
  await mkdir(join(source, "notes/Original.assets"));
  await writeFile(join(source, "notes/Original.assets/evidence.txt"), "untouched byte evidence");
  const payload = payloadFixture();
  mutatePayload?.(payload);
  await mkdir(join(source, ".pkm/state/agent-sessions"), { recursive: true });
  await mkdir(join(source, ".pkm/state/recipe-runs"));
  await writeFile(join(source, ".pkm/state/agent-sessions", `${payload.session.sessionId}.json`), JSON.stringify(payload.session));
  for (const run of payload.recipeRuns)
    await writeFile(join(source, ".pkm/state/recipe-runs", `${run.runId}.json`), JSON.stringify(run));
  const created = originalSnapshotWriter().createAgentSnapshot(source, payload.session.sessionId);
  const snapshotId = created.snapshot.snapshotId;
  const snapshotPath = join(source, ".pkm/state/agent-snapshots", `${snapshotId}.json`);
  const ciphertext = await readFile(snapshotPath), snapshot = JSON.parse(ciphertext);
  const captured = sourceOracle().decrypt(snapshot);
  await rm(join(source, ".pkm/state/agent-sessions"), { recursive: true });
  await rm(join(source, ".pkm/state/recipe-runs"), { recursive: true });
  const state = { approved: true, safe: true, epoch: "batch14-native-epoch", focus: true, revoked: false, keyCalls: 0 };
  const authority = {
    epoch: async () => state.epoch,
    key: async () => { state.keyCalls++; return Buffer.alloc(32, 7); },
  };
  const plan = await planLegacyImport(source, {}, { snapshotAuthority: authority });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const publish = fixturePublisher(parent);
  const receipt = await importLegacyWorkspace(plan, root, { snapshotAuthority: authority, nativePublishNoReplace: publish });
  let storage, runtime, database;
  const binding = {
    actorId: human.id, nativeOwnerId: "batch14-reviewed-native-owner",
    snapshotReceiptId: receipt.receiptSha256, cipherSha256: hash(ciphertext), keyEpoch: state.epoch,
    sourceIdentity: plan.fingerprint, snapshotId, sourceSessionId: snapshot.sourceSessionId,
    sourceHostSessionId: snapshot.sourceHostSessionId, targetWorkspaceId: JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8")).id,
    targetSessionId: "agent_session_batch14_target", targetChatId: "chat_batch14_target",
    policySha256: hash(JSON.stringify(captured)), restoredAt: at, expiresAt: Date.now() + 3_600_000,
  };
  const inlinePolicy = {
    admissions: [{ slug: "Original", sourceMarkdownDigest: hash(markdown) }],
    authorize: who => !state.revoked && who.id === human.id && who.collaborationKind === "human" ? { id: who.id, role: "user" }
      : !state.revoked && who.id === actor.id && who.collaborationKind === "agent" ? { id: who.id, role: "worker" } : undefined,
    now: () => inlineAt,
    assertFocus: async () => { if (database) assert.equal(database.isTransaction, false); if (!state.focus) throw new CoreError("CONFLICT", "Another task owns native workspace focus."); },
    assertNoLegacySyncEffects: async () => { if (database) assert.equal(database.isTransaction, false); },
  };
  const pausedPolicy = {
    receiptSha256: receipt.receiptSha256,
    bindingForActor: who => who.id === human.id && who.collaborationKind === "human" && !state.revoked ? structuredClone(binding) : undefined,
    epoch: authority.epoch, key: authority.key,
    approve: async () => { assert.equal(database.isTransaction, false); return state.approved && !state.revoked; },
    validateSafeState: async (_binding, value) => state.safe && isDeepStrictEqual(value, captured),
    assertBinding: value => {
      if (state.revoked || JSON.stringify(value) !== JSON.stringify(binding))
        throw new CoreError("ACCESS_DENIED", "Native approval/target revoked.");
    },
  };
  const f = {
    parent, source, root, plan, receipt, ciphertext, snapshot, captured, state, binding, inlinePolicy, pausedPolicy, publish, nativeOptions: {},
    get storage() { return storage; }, get runtime() { return runtime; },
    get database() { return database; },
    restoreArgs: () => ({ opId: randomUUID(), snapshotReceiptId: receipt.receiptSha256, cipherSha256: hash(ciphertext) }),
    read: () => readFile(join(root, "notes/Original.md"), "utf8"),
    async open(path = root) {
      storage = await Storage.open(path);
      runtime = await createNativeRuntime({ storage, pausedSnapshots: pausedPolicy, legacyInlineNotes: inlinePolicy, ...this.nativeOptions });
      database = storage.connectNative();
      return runtime;
    },
    async close() {
      if (database) { database.close(); database = undefined; }
      if (runtime) { await runtime.close(); runtime = undefined; }
      if (storage) { await storage.close(); storage = undefined; }
    },
    async restart(path = root) { await this.close(); return this.open(path); },
  };
  t.after(async () => { await f.close(); await rm(parent, { recursive: true, force: true }); });
  await f.open();
  return f;
}
export async function transports(t, core, who = human) {
  const token = "batch14-synthetic-transport-authorization-0000000000";
  const http = await startHttp(core, token, who, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(core, who, serverTransport);
  const client = new Client({ name: "batch14-native-qualified", version: "1" });
  await client.connect(clientTransport);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await client.close(); await mcp.close();
    await new Promise((resolve, reject) => { http.server.close(error => error ? reject(error) : resolve()); http.server.closeAllConnections(); });
  };
  t.after(close);
  return {
    async http(operation, args, method = "capability_call") {
      const response = await fetch(`${http.url}/v1/${method}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ operation, version: 1, arguments: args }),
      });
      return response.json();
    },
    async mcp(operation, args, method = "capability_call") {
      return (await client.callTool({ name: method, arguments: { operation, version: 1, arguments: args } })).structuredContent;
    },
    close,
  };
}
