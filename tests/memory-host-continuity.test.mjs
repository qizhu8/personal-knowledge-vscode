import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, rm, readFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManagedMemory } from "../dist/managed-memory-reader.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(process.env.PKM_NEXT_SERVER_DIST ?? join(root, "dist"));
const require = createRequire(import.meta.url);
const { MemoryMigrationAuthority } = require("../legacy/dist/runtime/memory-migration-authority.js");
const sha = value => createHash("sha256").update(value).digest("hex");
const python = realpathSync(execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim());
const sources = [{ id: "s", chat: "c", revision: "r", locator: "l" }];

async function fixture(t) {
  const directory = join(root, "tests", `.memory-host-${randomUUID()}`);
  const source = join(directory, "copy"), parent = join(directory, "target"), legacy = join(directory, "unused-root");
  await Promise.all([source, parent, legacy].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await mkdir(join(source, "notes"));
  await writeFile(join(source, "notes", "n.md"), "---\ntitle: Synthetic\n---\nSynthetic only.\n");
  const database = join(directory, "closed.sqlite"), scope = JSON.stringify({ account: "original", project: "synthetic-project", repository: "synthetic-repo" });
  const foreign = JSON.stringify({ account: "foreign", project: "foreign", repository: "foreign" });
  const id = `explicit-${sha(`${scope}\0proposal`)}`;
  execFileSync(python, ["-I", "-c", `
import json,sys,hashlib
sys.path.insert(0,sys.argv[1])
from pkm_memory_engine import Engine
e=Engine(sys.argv[2],"synthetic-engine")
for scope,op in [(sys.argv[3],"proposal"),(sys.argv[4],"foreign")]:
 i="explicit-"+hashlib.sha256((scope+"\\0"+op).encode()).hexdigest()
 e.mutate(op,"explicit_propose",{"id":i,"scope":scope,"content":"Synthetic original fact","sources":json.loads(sys.argv[5])})
 e.mutate(op+"-confirm","explicit_confirm",{"id":i,"scope":scope,"expected_revision":1,"host_authorization":{"decision_id":"original-human","actor_id":"human:original"}})
e.close()
`, join(root, "compute"), database, scope, foreign, JSON.stringify(sources)]);
  const original = await readFile(database);
  const child = fork(join(dist, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" } });
  const queued = [], waiting = [];
  child.on("message", message => {
    const index = waiting.findIndex(item => item.matches(message));
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message); else queued.push(message);
  });
  const receive = matches => new Promise((resolveMessage, reject) => {
    const index = queued.findIndex(matches);
    if (index >= 0) { resolveMessage(queued.splice(index, 1)[0]); return; }
    const timer = setTimeout(() => reject(Error("Private host response timed out")), 15_000);
    waiting.push({ matches, resolve: value => { clearTimeout(timer); resolveMessage(value); } });
  });
  const call = async message => {
    const id = randomUUID(); child.send({ ...message, id });
    return receive(value => value.type === "result" && value.id === id);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once("exit", resolveExit));
      if (child.connected) child.send({ type: "close" }, () => {});
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  child.send({ type: "start-import", source, parent, legacyRoot: legacy, python, memoryEngine: database, acknowledge: true });
  const initial = await receive(value => value.type === "import-plan" || value.type === "startup-error");
  assert.equal(initial.ready, true, JSON.stringify(initial));
  assert.equal(initial.memoryPlan.actorId, "local:owner");
  const selected = await call({ type: "select-memory-scope", sourceScopeSha256: sha(scope) });
  assert(!selected.error, JSON.stringify(selected));
  const plan = selected.result.plan;
  return { directory, child, call, receive, scope, foreign, id, plan, database, original };
}

test("private real host requires exact one-scope approval; preserves reads/receipts and denies restart/restore activation", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const imported = f.call({ type: "confirm-import", planSha256: f.plan.planSha256 });
  const approval = await f.receive(value => value.type === "memory-scope-approval-request");
  const authority = new MemoryMigrationAuthority(() => true);
  const expected = { target: f.plan.target, actorId: "local:owner", scope: f.scope,
    sourceDatabaseSha256: f.plan.memoryPlan.sourceSha256, importPlanSha256: f.plan.planSha256 };
  assert.equal(await new MemoryMigrationAuthority(() => false).authorize(approval.envelope, expected, async () => true), null);
  assert.equal(await authority.authorize({ ...approval.envelope, target: "/different-target" }, expected, async () => true), null);
  assert.equal(await authority.authorize(approval.envelope, { ...expected, workspaceId: randomUUID() }, async () => true), null);
  for (const [field, value] of [["actorId", "other"], ["scope", f.foreign], ["sourceDatabaseSha256", "0".repeat(64)], ["importPlanSha256", "0".repeat(64)]]) {
    assert.equal(await authority.authorize({ ...approval.envelope, request: { ...approval.envelope.request, [field]: value } }, expected,
      async () => { throw Error("Must not prompt for mismatched evidence"); }), null);
  }
  const grant = await authority.authorize(approval.envelope, expected, async request => {
    assert.equal(request.scope, f.scope);
    assert.equal(request.workspaceId, approval.envelope.request.workspaceId);
    return true;
  });
  assert(grant);
  assert.equal(await authority.authorize(approval.envelope, expected, async () => true), null);
  f.child.send({ type: "memory-scope-approval-result", approvalId: approval.approvalId, approval: grant });
  const outcome = await imported;
  assert(!outcome.error, JSON.stringify(outcome));
  const receipt = outcome.result.receipt;
  assert.equal(receipt.memoryScopeContinuity.scope, f.scope);
  assert.equal(receipt.memoryScopeContinuity.importReceiptSha256, receipt.memoryImport.receiptSha256);
  const attached = await f.call({ type: "attach-import" });
  assert(!attached.error, JSON.stringify(attached));
  const invoke = async (operation, args) => f.call({ type: "invoke", operation, args });
  assert.equal((await invoke("memory-get", { id: f.id })).result.scope, f.scope);
  assert.equal((await invoke("memory-search", { query: "Synthetic" })).result.records[0].id, f.id);
  assert.equal((await invoke("memory-audit", { id: f.id })).result.events[1].decision_id, "original-human");
  const replay = { operation: "memory.record.propose", arguments: { content: "Synthetic original fact", sources, operation_id: "proposal" } };
  assert.equal((await invoke("memory-replay", replay)).result.status, "pending");
  assert.equal((await invoke("memory-replay", { ...replay, arguments: { ...replay.arguments, content: "changed" } })).error, "CONFLICT");
  assert.equal((await invoke("memory-get", { id: `explicit-${sha(`${f.foreign}\0foreign`)}` })).error, "NOT_AVAILABLE");
  assert.deepEqual(await readFile(f.database), f.original);
  await assert.rejects(readManagedMemory(f.plan.target, "memory-get", { id: f.id }), { code: "NOT_AVAILABLE" },
    "Another native process does not inherit the child host session.");
  const storage = await Storage.open(f.plan.target);
  const backup = join(f.directory, "backup"), restored = join(f.directory, "restored");
  try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
  finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable: python });
  await assert.rejects(readManagedMemory(restored, "memory-get", { id: f.id }), { code: "NOT_AVAILABLE" });
});

for (const mode of ["missing", "cancel", "wrong-actor", "expired"]) {
  test(`private real host refuses ${mode} Memory admission without publishing`, { timeout: 60_000 }, async t => {
    const f = await fixture(t);
    const imported = f.call({ type: "confirm-import", planSha256: f.plan.planSha256 });
    const request = await f.receive(value => value.type === "memory-scope-approval-request");
    const authority = new MemoryMigrationAuthority(() => true);
    const approval = mode === "cancel" ? await authority.authorize(request.envelope, {
      target: f.plan.target, actorId: "local:owner", scope: f.scope,
      sourceDatabaseSha256: f.plan.memoryPlan.sourceSha256, importPlanSha256: f.plan.planSha256,
    }, async () => false) : mode === "wrong-actor" || mode === "expired"
      ? { actorId: mode === "wrong-actor" ? "other" : "local:owner", decisionId: randomUUID(),
        expiresAtMs: Date.now() + (mode === "expired" ? -1000 : 60_000) } : null;
    f.child.send({ type: "memory-scope-approval-result", approvalId: request.approvalId, approval });
    assert((await imported).error);
    assert.notEqual((await f.call({ type: "import-status" })).result.outcome.status, "published");
    await assert.rejects(lstat(f.plan.target), { code: "ENOENT" });
  });
}
