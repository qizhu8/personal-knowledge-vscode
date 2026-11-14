import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Core } from "../dist/core.js";
import {
  cleanupInterruptedLegacyImportStages, planLegacyImport, importLegacyWorkspace, recoverLegacyImportOutcome,
} from "../dist/legacy-import.js";
import { memoryScope, readMemoryRecord } from "../dist/memory.js";
import { activateMemoryScopeContinuity } from "../dist/memory-scope-continuity.js";
import { readManagedMemory } from "../dist/managed-memory-reader.js";
import { scanMarkdown } from "../dist/markdown.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsRoot, "../legacy");
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const enginePath = join(projectRoot, "../", "compute");
const cliPath = join(resolve(process.env.PKM_NEXT_SERVER_DIST ?? join(projectRoot, "../", "dist")), "cli.js");
const actor = id => ({ id, canWrite: true });
const legacyEngineFixture = String.raw`
import hashlib, json, sys
from pathlib import Path
from pkm_memory_engine import Engine

database, scopes_json = sys.argv[1:3]
scopes = json.loads(scopes_json)
sources = [{"id":"source-1","chat":"fixture-chat","revision":"turn-1","locator":"message/source-1"}]
engine = Engine(database, "legacy/account-root")
def propose(operation_id, scope, content):
    memory_id = "explicit-" + hashlib.sha256((scope + "\0" + operation_id).encode()).hexdigest()
    return engine.mutate(operation_id, "explicit_propose", {
        "id": memory_id, "scope": scope, "content": content, "sources": sources,
    })
def transition(operation_id, method, scope, memory_id, revision, content=None):
    params = {
        "id": memory_id, "scope": scope, "expected_revision": revision,
    }
    if content is not None:
        params["content"] = content
        params["sources"] = sources
    params["host_authorization"] = {
        "decision_id": "decision-" + operation_id, "actor_id": "human:legacy",
    }
    return engine.mutate(operation_id, "explicit_" + method, params)
pending = propose("proposal-pending", scopes[0], "Pending original fact.")
revised = propose("proposal-revised", scopes[0], "Original confirmed fact.")
transition("confirm-revised", "confirm", scopes[0], revised["id"], 1)
transition("revise-revised", "revise", scopes[0], revised["id"], 2, "Revised but pending.")
revoked = propose("proposal-revoked", scopes[1], "Original revoked fact.")
transition("confirm-revoked", "confirm", scopes[1], revoked["id"], 1)
transition("revoke-original", "revoke", scopes[1], revoked["id"], 2)
engine.close()
`;

async function fixture(t) {
  const parent = resolve(testsRoot, `.memory-import-${randomUUID()}`);
  const source = join(parent, "legacy-copy"), database = join(parent, "legacy-memory.sqlite3");
  const destination = join(parent, "isolated-import"), backup = join(parent, "backup"), restored = join(parent, "restored");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "notes", "legacy.md"), "---\ntitle: Legacy\ndocumentId: legacy-note\n---\nOriginal note.\n", { mode: 0o600 });
  const oldRootIdentity = createHash("sha256").update(source).digest("hex");
  const scope1 = JSON.stringify({ account: "local-owner", project: oldRootIdentity, repository: oldRootIdentity });
  const otherIdentity = createHash("sha256").update("second-original-repository").digest("hex");
  const scope2 = JSON.stringify({ account: "local-owner", project: otherIdentity, repository: otherIdentity });
  execFileSync(python, ["-c", legacyEngineFixture, database, JSON.stringify([scope1, scope2])], {
    env: { ...process.env, PYTHONPATH: enginePath },
  });
  await chmod(database, 0o600);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, source, database, destination, backup, restored, scopes: [scope1, scope2] };
}

const importOptions = actorId => ({ pythonExecutable: python, memoryActorId: actorId });
const memoryPolicy = (fixture, actorId = "imported-owner") => ({
  memoryEngine: fixture.database, memoryActorId: actorId,
});
function originalOperation(databasePath, operationId) {
  const uri = pathToFileURL(databasePath);
  uri.searchParams.set("immutable", "1");
  const database = new DatabaseSync(uri.href, { readOnly: true });
  try {
    const row = database.prepare("SELECT result FROM operations WHERE id=?").get(operationId);
    assert(row, `Original Engine operation receipt ${operationId} exists.`);
    return JSON.parse(row.result);
  } finally { database.close(); }
}
function importedOperation(root, operationId) {
  const database = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT result FROM receipts WHERE operation_id=?").get(operationId).result; }
  finally { database.close(); }
}

test("original Engine import preserves multiple scopes, immutable lifecycle and historical receipts across restart/backup/restore", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const before = await readFile(f.database);
  const sourceStat = await lstat(f.database, { bigint: true });
  const plan = await planLegacyImport(f.source, {}, memoryPolicy(f));
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.memoryPlan.records, 3);
  assert.equal(plan.memoryPlan.scopes.length, 2);
  assert.equal(plan.memoryPlan.actorId, "imported-owner");
  const receipt = await importLegacyWorkspace(plan, f.destination, importOptions(plan.memoryPlan.actorId));
  assert.equal(receipt.memoryImport.records, 3);
  assert.equal(receipt.memoryImport.events, 7);
  assert.equal(receipt.memoryImport.operations, 7);
  assert.equal(await readFile(f.database).then(value => createHash("sha256").update(value).digest("hex")),
    createHash("sha256").update(before).digest("hex"));
  const sourceAfter = await lstat(f.database, { bigint: true });
  assert.equal(sourceAfter.dev, sourceStat.dev);
  assert.equal(sourceAfter.ino, sourceStat.ino);
  assert.equal(sourceAfter.size, sourceStat.size);
  assert.equal(sourceAfter.mtimeNs, sourceStat.mtimeNs);
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(`${f.database}${suffix}`), { code: "ENOENT" });

  const docs = scanMarkdown(f.destination).filter(item => item.record.path.startsWith("System/Memory/"));
  assert.equal(docs.length, 3);
  const records = new Map(docs.map(document => [document.record.id, readMemoryRecord(document)]));
  const pendingId = `explicit-${createHash("sha256").update(`${f.scopes[0]}\0proposal-pending`).digest("hex")}`;
  const revisedId = `explicit-${createHash("sha256").update(`${f.scopes[0]}\0proposal-revised`).digest("hex")}`;
  const revokedId = `explicit-${createHash("sha256").update(`${f.scopes[1]}\0proposal-revoked`).digest("hex")}`;
  assert.equal(records.get(pendingId).scope, f.scopes[0]);
  assert.equal(records.get(pendingId).status, "pending");
  assert.equal(records.get(revisedId).scope, f.scopes[0]);
  assert.equal(records.get(revisedId).status, "pending");
  assert.equal(records.get(revisedId).revision, 3);
  assert.equal(readMemoryRecord(docs.find(document => document.record.id === revisedId), 1).status, "superseded");
  assert.equal(readMemoryRecord(docs.find(document => document.record.id === revisedId), 2).status, "superseded");
  assert.equal(readMemoryRecord(docs.find(document => document.record.id === revisedId), 3).status, "pending");
  assert.equal(records.get(revokedId).scope, f.scopes[1]);
  assert.equal(records.get(revokedId).status, "revoked");
  assert.equal(records.get(revokedId).revision, 3);
  assert.notEqual(f.scopes[0], memoryScope(f.destination), "Import never silently rebinds source scope to the target root.");
  assert.notEqual(f.scopes[1], memoryScope(f.destination));

  let authorizations = 0;
  let storage = await Storage.open(f.destination);
  t.after(async () => { if (storage) await storage.close(); });
  let core = new Core(storage, { authorizeMemoryDecision: async () => { authorizations++; return null; } });
  const call = (operation, args, identity = "imported-owner") => core.dispatch("capability_call", {
    operation, version: 1, arguments: args,
  }, actor(identity));
  const historicalConfirm = await call("memory.record.confirm", { id: revisedId, expected_revision: 1, operation_id: "confirm-revised" });
  assert.equal(historicalConfirm.error.code, "NOT_AVAILABLE");
  assert.deepEqual(JSON.parse(importedOperation(f.destination, "confirm-revised")), {
    ...originalOperation(f.database, "confirm-revised"),
    documentSha256: records.get(revisedId).documentSha256,
  });
  assert.equal(authorizations, 0, "Historical receipt replay does not repeat or synthesize human approval.");
  const replayProposal = await call("memory.record.propose", {
    operation_id: "proposal-pending", content: "Pending original fact.",
    sources: [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }],
  });
  assert.equal(replayProposal.error.code, "NOT_AVAILABLE");
  assert.deepEqual(JSON.parse(importedOperation(f.destination, "proposal-pending")), {
    ...originalOperation(f.database, "proposal-pending"),
    documentSha256: records.get(pendingId).documentSha256,
  });
  const conflict = await call("memory.record.propose", {
    operation_id: "proposal-pending", content: "Changed input.",
    sources: [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }],
  });
  assert.equal(conflict.error.code, "CONFLICT");
  const differentActor = await call("memory.record.confirm", {
    id: revisedId, expected_revision: 1, operation_id: "confirm-revised",
  }, "different-owner");
  assert.equal(differentActor.error.code, "CONFLICT");
  assert.equal(authorizations, 0);
  const newDecision = await call("memory.record.confirm", {
    id: pendingId, expected_revision: 1, operation_id: "not-an-imported-operation",
  });
  assert.equal(newDecision.error.code, "NOT_AVAILABLE");
  assert.equal(authorizations, 0, "The old-scope record cannot be confirmed under the unrelated target scope.");
  const newProposal = await call("memory.record.propose", {
    operation_id: "new-target-proposal", content: "A new target-scoped fact.",
    sources: [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }],
  });
  assert.equal(newProposal.result.scope, memoryScope(f.destination));
  const deniedConfirmation = await call("memory.record.confirm", {
    id: newProposal.result.id, expected_revision: 1, operation_id: "new-target-confirm",
  });
  assert.equal(deniedConfirmation.error.code, "ACCESS_DENIED");
  assert.equal(authorizations, 1, "New target-scope confirmations still require a human decision.");
  const stillPending = await core.dispatch("capability_read", {
    operation: "memory.record.get", version: 1, arguments: { id: newProposal.result.id },
  }, actor("imported-owner"));
  assert.equal(stillPending.result.status, "pending");
  await storage.close();
  storage = undefined;
  storage = await Storage.open(f.destination);
  core = new Core(storage, { authorizeMemoryDecision: async () => { authorizations++; return null; } });
  const restarted = await call("memory.record.revoke", { id: revokedId, expected_revision: 2, operation_id: "revoke-original" });
  assert.equal(restarted.error.code, "NOT_AVAILABLE");
  assert.deepEqual(JSON.parse(importedOperation(f.destination, "revoke-original")), {
    ...originalOperation(f.database, "revoke-original"),
    documentSha256: records.get(revokedId).documentSha256,
  });
  assert.equal(authorizations, 1);
  assert.equal((await recoverLegacyImportOutcome(f.destination)).status, "published");

  await createWorkspaceBackup(storage, f.backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  await storage.close();
  storage = undefined;
  await restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority, pythonExecutable: python });
  const restoredStorage = await Storage.open(f.restored);
  t.after(async () => restoredStorage.close());
  const restoredCore = new Core(restoredStorage, { authorizeMemoryDecision: async () => { authorizations++; return null; } });
  const restoredReplay = await restoredCore.dispatch("capability_call", {
    operation: "memory.record.revise", version: 1, arguments: {
      id: revisedId, expected_revision: 2, operation_id: "revise-revised",
      content: "Revised but pending.", sources: [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }],
    },
  }, actor("imported-owner"));
  assert.equal(restoredReplay.error.code, "NOT_AVAILABLE");
  assert.deepEqual(JSON.parse(importedOperation(f.restored, "revise-revised")), {
    ...originalOperation(f.database, "revise-revised"),
    documentSha256: records.get(revisedId).documentSha256,
  });
  assert.equal(authorizations, 1);
  await restoredStorage.close();
});

test("original Memory import refuses a changed source Engine before publishing", async t => {
  const f = await fixture(t);
  const plan = await planLegacyImport(f.source, {}, memoryPolicy(f));
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const before = createHash("sha256").update(await readFile(f.database)).digest("hex");
  execFileSync(python, ["-c", String.raw`
import hashlib, sys
from pkm_memory_engine import Engine
engine = Engine(sys.argv[1], "legacy/account-root")
scope = sys.argv[2]
operation_id = "external-race"
memory_id = "explicit-" + hashlib.sha256((scope + "\0" + operation_id).encode()).hexdigest()
engine.mutate(operation_id, "explicit_propose", {
    "id": memory_id, "scope": scope, "content": "External concurrent write.",
    "sources": [{"id":"source-1","chat":"fixture-chat","revision":"turn-1","locator":"message/source-1"}],
})
engine.close()
`, f.database, f.scopes[0]], { env: { ...process.env, PYTHONPATH: enginePath } });
  await assert.rejects(importLegacyWorkspace(plan, f.destination, importOptions(plan.memoryPlan.actorId)), { code: "SOURCE_CHANGED" });
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  assert.notEqual(createHash("sha256").update(await readFile(f.database)).digest("hex"), before);
});

test("public import-plan/import/import-status CLI accepts the explicit Memory snapshot and actor binding", async t => {
  const f = await fixture(t);
  const ack = "--acknowledge-quiescent-disposable-copy";
  const common = ["--source", f.source, "--memory-engine", f.database, "--memory-actor-id", "imported-owner", ack];
  const planned = JSON.parse(execFileSync(process.execPath, [cliPath, "import-plan", ...common], { encoding: "utf8" })).plan;
  assert.equal(planned.ready, true, JSON.stringify(planned.blockers));
  const imported = JSON.parse(execFileSync(process.execPath, [cliPath, "import", ...common,
    "--destination", f.destination, "--plan-sha256", planned.planSha256, "--python", python], { encoding: "utf8" })).receipt;
  assert.equal(imported.memoryImport.sourceDatabaseSha256, planned.memoryPlan.sourceSha256);
  const status = JSON.parse(execFileSync(process.execPath, [cliPath, "import-status", "--destination", f.destination], {
    encoding: "utf8",
  })).outcome;
  assert.equal(status.status, "published");
  assert.deepEqual(status.receipt, imported);
});

test("explicit host session serves exact original Memory without giving restart, MCP or restore an inherited grant", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const scopeDigest = createHash("sha256").update(f.scopes[0]).digest("hex");
  const pendingId = `explicit-${createHash("sha256").update(`${f.scopes[0]}\0proposal-pending`).digest("hex")}`;
  const foreignId = `explicit-${createHash("sha256").update(`${f.scopes[1]}\0proposal-revoked`).digest("hex")}`;
  const foreignConfirmedId = `explicit-${createHash("sha256").update(`${f.scopes[1]}\0foreign-confirmed`).digest("hex")}`;
  const foreignPendingId = `explicit-${createHash("sha256").update(`${f.scopes[1]}\0foreign-pending`).digest("hex")}`;
  execFileSync(python, ["-c", String.raw`
import sys
from pkm_memory_engine import Engine
engine = Engine(sys.argv[1], "legacy/account-root")
engine.mutate("confirm-searchable", "explicit_confirm", {
  "id":sys.argv[2], "scope":sys.argv[3], "expected_revision":1,
  "host_authorization":{"decision_id":"original-human","actor_id":"human:legacy"},
})
engine.mutate("foreign-confirmed", "explicit_propose", {
  "id":sys.argv[4], "scope":sys.argv[5], "content":"Original foreign confirmed fact.",
  "sources":[{"id":"source-1","chat":"fixture-chat","revision":"turn-1","locator":"message/source-1"}],
})
engine.mutate("foreign-confirmed-decision", "explicit_confirm", {
  "id":sys.argv[4], "scope":sys.argv[5], "expected_revision":1,
  "host_authorization":{"decision_id":"foreign-human","actor_id":"human:foreign"},
})
engine.mutate("foreign-pending", "explicit_propose", {
  "id":sys.argv[6], "scope":sys.argv[5], "content":"Original foreign pending fact.",
  "sources":[{"id":"source-1","chat":"fixture-chat","revision":"turn-1","locator":"message/source-1"}],
})
engine.close()
`, f.database, pendingId, f.scopes[0], foreignConfirmedId, f.scopes[1], foreignPendingId], { env: { ...process.env, PYTHONPATH: enginePath } });
  const originalBytes = await readFile(f.database);
  const plan = await planLegacyImport(f.source, {}, {
    ...memoryPolicy(f, "local:owner"), memoryContinuityScopeSha256: scopeDigest,
  });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const invalidScopePlan = await planLegacyImport(f.source, {}, {
    ...memoryPolicy(f, "local:owner"), memoryContinuityScopeSha256: "f".repeat(64),
  });
  assert.equal(invalidScopePlan.ready, false);
  await assert.rejects(importLegacyWorkspace(plan, f.destination, importOptions("local:owner")), { code: "AUTHORITY_REQUIRED" });
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  await assert.rejects(importLegacyWorkspace(plan, f.destination, {
    ...importOptions("local:owner"),
    authorizeMemoryScopeContinuity: () => ({ actorId: "different-owner", decisionId: "wrong-actor" }),
  }), { code: "AUTHORITY_REQUIRED" });
  let approvedRequest;
  const receipt = await importLegacyWorkspace(plan, f.destination, {
    ...importOptions("local:owner"),
    authorizeMemoryScopeContinuity(request) {
      assert(Object.isFrozen(request));
      assert.equal(request.scope, f.scopes[0]);
      assert.equal(request.actorId, "local:owner");
      assert.equal(request.sourceScopeSha256, scopeDigest);
      assert.match(request.workspaceId, /^[0-9a-f-]{36}$/);
      approvedRequest = request;
      return { actorId: request.actorId, decisionId: "native-explicit-continuity", expiresAtMs: Date.now() + 60_000 };
    },
  });
  assert.equal(receipt.memoryScopeContinuity.importReceiptSha256, receipt.memoryImport.receiptSha256);
  assert.equal(receipt.memoryScopeContinuity.workspaceId, approvedRequest.workspaceId);
  assert.notEqual(memoryScope(f.destination), f.scopes[0]);
  activateMemoryScopeContinuity(f.destination, receipt.memoryScopeContinuity);
  assert.equal(memoryScope(f.destination), f.scopes[0]);
  assert.deepEqual(await readFile(f.database), originalBytes);
  const foreignReceiptBytes = importedOperation(f.destination, "foreign-pending");
  const sourceReference = [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }];
  assert.equal((await readManagedMemory(f.destination, "memory-get", { id: pendingId })).scope, f.scopes[0]);
  for (const id of [foreignId, foreignConfirmedId, foreignPendingId])
    await assert.rejects(readManagedMemory(f.destination, "memory-get", { id }), { code: "NOT_AVAILABLE" });
  assert.deepEqual((await readManagedMemory(f.destination, "memory-search", { query: "original" })).records.map(record => record.id), [pendingId]);
  assert.equal((await readManagedMemory(f.destination, "memory-audit", { id: pendingId })).events[1].decision_id, "original-human");
  assert.equal((await readManagedMemory(f.destination, "memory-replay", {
    operation: "memory.record.propose",
    arguments: { content: "Pending original fact.", sources: sourceReference, operation_id: "proposal-pending" },
  })).status, "pending");
  const originalNow = Date.now;
  try {
    Date.now = () => receipt.memoryScopeContinuity.expiresAtMs + 1;
    await assert.rejects(readManagedMemory(f.destination, "memory-get", { id: pendingId }), { code: "NOT_AVAILABLE" });
  } finally { Date.now = originalNow; }
  let storage = await Storage.open(f.destination);
  await createWorkspaceBackup(storage, f.backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  await storage.close();
  await restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority, pythonExecutable: python });
  assert.notEqual(memoryScope(f.restored), f.scopes[0]);
  await assert.rejects(readManagedMemory(f.restored, "memory-get", { id: pendingId }), { code: "NOT_AVAILABLE" });
  for (const root of [f.destination, f.restored]) {
    const client = new Client({ name: "memory-continuity-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [cliPath, "mcp", "--data", root], stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const invoke = async (action, args, write = false) => {
        const response = await client.callTool({ name: write ? "capability_call" : "capability_read",
          arguments: { operation: `memory.record.${action}`, version: 1, arguments: args } });
        return response.structuredContent;
      };
      assert.equal((await invoke("get", { id: pendingId })).error.code, "NOT_AVAILABLE");
      assert.deepEqual((await invoke("search", { query: "original" })).result.records, []);
      assert.equal((await invoke("audit", { id: pendingId })).error.code, "NOT_AVAILABLE");
      assert.equal((await invoke("get", { id: foreignId })).error.code, "NOT_AVAILABLE");
      assert.equal((await invoke("get", { id: foreignConfirmedId })).error.code, "NOT_AVAILABLE");
      assert.equal((await invoke("propose", {
        content: "Pending original fact.", sources: sourceReference, operation_id: "proposal-pending",
      }, true)).error.code, "NOT_AVAILABLE");
      for (const [operation_id, content] of [
        ["foreign-pending", "Original foreign pending fact."],
        ["foreign-confirmed", "Original foreign confirmed fact."],
        ["proposal-revoked", "Original revoked fact."],
      ]) {
        assert.equal((await invoke("propose", { content, sources: sourceReference, operation_id }, true)).error.code, "NOT_AVAILABLE");
        assert.equal((await invoke("propose", {
          content: "Selected collision attempt.", sources: sourceReference, operation_id,
        }, true)).error.code, "CONFLICT");
      }
      assert.equal(importedOperation(root, "foreign-pending"), foreignReceiptBytes);
    } finally { await client.close(); }
  }
  const database = new DatabaseSync(join(f.restored, "core.sqlite"));
  try {
    const row = database.prepare("SELECT binding_json FROM legacy_memory_scope_continuity").get();
    const changed = { ...JSON.parse(row.binding_json), actorId: "different-owner" };
    const json = JSON.stringify(changed);
    database.prepare("UPDATE legacy_memory_scope_continuity SET binding_json=?,binding_sha256=?").run(json,
      createHash("sha256").update(json).digest("hex"));
  } finally { database.close(); }
  assert.throws(() => memoryScope(f.restored), { code: "INVALID_WORKSPACE" },
    "Even a self-consistent binding hash cannot substitute a different actor/import authority.");
});

test("Memory continuity CLI can plan a scope but cannot manufacture trusted-host ownership", async t => {
  const f = await fixture(t);
  const digest = createHash("sha256").update(f.scopes[0]).digest("hex");
  const common = ["--source", f.source, "--memory-engine", f.database, "--memory-actor-id", "local:owner",
    "--memory-continuity-scope-sha256", digest, "--acknowledge-quiescent-disposable-copy"];
  const plan = JSON.parse(execFileSync(process.execPath, [cliPath, "import-plan", ...common], { encoding: "utf8" })).plan;
  assert.equal(plan.memoryPlan.continuityScopeSha256, digest);
  assert.throws(() => execFileSync(process.execPath, [cliPath, "import", ...common,
    "--destination", f.destination, "--plan-sha256", plan.planSha256, "--python", python], { encoding: "utf8" }),
  /trusted native host must approve Memory scope continuity/);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("an original scope equal to the destination path scope still cannot manufacture imported ownership", async t => {
  const f = await fixture(t);
  const identity = createHash("sha256").update(f.destination).digest("hex");
  const scope = JSON.stringify({ account: "local-owner", project: identity, repository: identity });
  const id = `explicit-${createHash("sha256").update(`${scope}\0target-scope`).digest("hex")}`;
  const sources = [{ id: "s", chat: "c", revision: "r", locator: "l" }];
  execFileSync(python, ["-c", `
import json,sys
from pkm_memory_engine import Engine
e=Engine(sys.argv[1],"legacy/account-root")
e.mutate("target-scope","explicit_propose",{"id":sys.argv[3],"scope":sys.argv[2],"content":"Synthetic matching path","sources":json.loads(sys.argv[4])})
e.mutate("target-confirm","explicit_confirm",{"id":sys.argv[3],"scope":sys.argv[2],"expected_revision":1,"host_authorization":{"decision_id":"original","actor_id":"human:original"}})
e.close()
`, f.database, scope, id, JSON.stringify(sources)], { env: { ...process.env, PYTHONPATH: enginePath } });
  const plan = await planLegacyImport(f.source, {}, memoryPolicy(f, "local:owner"));
  await importLegacyWorkspace(plan, f.destination, importOptions("local:owner"));
  const storage = await Storage.open(f.destination);
  try {
    const core = new Core(storage);
    const call = (action, args, write = false) => core.dispatch(write ? "capability_call" : "capability_read", {
      operation: `memory.record.${action}`, version: 1, arguments: args,
    }, actor("local:owner"));
    assert.equal((await call("get", { id })).error.code, "NOT_AVAILABLE");
    assert.deepEqual((await call("search", { query: "Synthetic matching" })).result.records, []);
    assert.equal((await call("propose", { content: "Synthetic matching path", sources, operation_id: "target-scope" }, true)).error.code, "NOT_AVAILABLE");
  } finally { await storage.close(); }
});

test("original Memory import rejects inconsistent operation receipts atomically", async t => {
  const f = await fixture(t);
  const database = new DatabaseSync(f.database);
  try {
    database.prepare("UPDATE explicit_memory_events SET decision_id=? WHERE operation_id=?")
      .run("unverifiable-decision", "confirm-revised");
  } finally { database.close(); }
  const plan = await planLegacyImport(f.source, {}, memoryPolicy(f));
  assert.equal(plan.ready, false);
  assert(plan.blockers.some(blocker => blocker.code === "memory-invalid_engine"),
    JSON.stringify(plan.blockers));
  await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable: python }), { code: "IMPORT_BLOCKED" });
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("process interruption after staged Memory receipt is recovered as unpublished without losing receipt evidence",
  { timeout: 120_000, skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    const sourceBytes = await readFile(f.database);
    const script = join(f.parent, "interrupt-import.mjs");
    const importUrl = pathToFileURL(join(testsRoot, "../dist/legacy-import.js")).href;
    await writeFile(script, `
import { planLegacyImport, importLegacyWorkspace } from ${JSON.stringify(importUrl)};
const [source, database, destination, python] = process.argv.slice(2);
const actorId = "imported-owner";
const plan = await planLegacyImport(source, {}, { memoryEngine: database, memoryActorId: actorId });
if (!plan.ready) process.exit(2);
await importLegacyWorkspace(plan, destination, {
  pythonExecutable: python,
  memoryActorId: actorId,
  nativePublishNoReplace() {
    process.kill(process.pid, "SIGKILL");
    return new Promise(resolve => setTimeout(resolve, 10_000));
  },
});
`);
    assert.throws(() => execFileSync(process.execPath, [script, f.source, f.database, f.destination, python]),
      error => error.signal === "SIGKILL");
    const recovered = await recoverLegacyImportOutcome(f.destination);
    assert.equal(recovered.status, "not-published");
    assert.equal(recovered.receipt.memoryImport.operations, 7);
    assert.equal(recovered.receipt.memoryImport.records, 3);
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
    assert.deepEqual(await readFile(f.database), sourceBytes);
    const cleanup = await cleanupInterruptedLegacyImportStages(f.destination);
    assert.equal(cleanup.removed.length, 1);
    assert.equal(cleanup.retained.length, 0);
    assert.equal((await recoverLegacyImportOutcome(f.destination)).status, "not-published");
  });

test("Memory source changed during exact native scope approval discards stage and never publishes", async t => {
  const f = await fixture(t);
  const plan = await planLegacyImport(f.source, {}, {
    ...memoryPolicy(f), memoryContinuityScopeSha256: createHash("sha256").update(f.scopes[0]).digest("hex"),
  });
  await assert.rejects(importLegacyWorkspace(plan, f.destination, {
    ...importOptions("imported-owner"),
    authorizeMemoryScopeContinuity(request) {
      execFileSync(python, ["-c", String.raw`
import sys, sqlite3
database = sqlite3.connect(sys.argv[1])
database.execute("UPDATE operations SET request_hash=? WHERE id=?", ("0"*64, "proposal-pending"))
database.commit()
database.close()
`, f.database]);
      return { actorId: request.actorId, decisionId: "approved-before-source-race", expiresAtMs: Date.now() + 60_000 };
    },
  }), { code: "SOURCE_CHANGED" });
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("router config source changed during native Memory approval discards the composed import without publishing", async t => {
  const f = await fixture(t);
  const routerConfig = join(f.parent, "router-config.json");
  const raw = JSON.stringify({ schema: 2, enabledSolutions: ["copilot_default"],
    sourcePriority: ["pkm-personal", "agent-native"], sources: [
      { id: "pkm-personal", label: "Personal", kind: "personal", detail: "Personal" },
      { id: "agent-native", label: "Native", kind: "native", detail: "Native" },
    ] });
  await writeFile(routerConfig, raw, { mode: 0o600 });
  const plan = await planLegacyImport(f.source, {}, {
    ...memoryPolicy(f), routerConfig,
    memoryContinuityScopeSha256: createHash("sha256").update(f.scopes[0]).digest("hex"),
  });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await assert.rejects(importLegacyWorkspace(plan, f.destination, {
    ...importOptions("imported-owner"),
    async authorizeMemoryScopeContinuity(request) {
      await writeFile(routerConfig, raw.replace('"copilot_default"', '"copilot_default","l1_online"'));
      return { actorId: request.actorId, decisionId: "native-router-race", expiresAtMs: Date.now() + 60_000 };
    },
  }), { code: "SOURCE_CHANGED" });
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("without native continuity external MCP cannot replay any imported scope, including after restart and relocated restore", async t => {
  const f = await fixture(t);
  const plan = await planLegacyImport(f.source, {}, memoryPolicy(f, "local:owner"));
  await importLegacyWorkspace(plan, f.destination, importOptions("local:owner"));
  const retained = ["proposal-pending", "proposal-revoked"].map(id => importedOperation(f.destination, id));
  const storage = await Storage.open(f.destination);
  try {
    await createWorkspaceBackup(storage, f.backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority, pythonExecutable: python });
  for (const root of [f.destination, f.destination, f.restored]) {
    const client = new Client({ name: "inactive-memory-receipt-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [cliPath, "mcp", "--data", root], stderr: "pipe",
    });
    try {
      await client.connect(transport);
      for (const [index, [operation_id, content]] of [
        ["proposal-pending", "Pending original fact."], ["proposal-revoked", "Original revoked fact."],
      ].entries()) {
        const response = await client.callTool({ name: "capability_call", arguments: {
          operation: "memory.record.propose", version: 1, arguments: {
            operation_id, content,
            sources: [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/source-1" }],
          },
        } });
        assert.equal(response.structuredContent.error.code, "NOT_AVAILABLE");
        assert.equal(response.structuredContent.result, undefined);
        assert.equal(importedOperation(root, operation_id), retained[index]);
      }
    } finally { await client.close(); }
  }
});
