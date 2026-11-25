import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

test("actual canonical Storage worker refuses copied role and generic Chat commands on a fresh pinned Original root", { timeout: 120000 }, async t => {
  const evidenceRoot = process.env.PKM_TODO_ROLE_PRIVATE_EVIDENCE_ROOT ?? process.env.PKM_TEST_WORKSPACE;
  assert(evidenceRoot, "An explicit private evidence directory or canonical owned test workspace is mandatory.");
  assert(process.env.PKM_LEGACY_VSIX, "The independently pinned Original22 oracle is mandatory.");
  const directory = join(resolve(evidenceRoot), `native-todo-role-worker-refusal-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const root = join(directory, "pkm-v5-disposable-role-refusal"); await mkdir(root, { mode: 0o700 });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory, legacyVsix: process.env.PKM_LEGACY_VSIX, python: "python3" });
  const initial = writer.run(root, `
    process.umask(0o077);
    store.todoBoardCreate("Synthetic/RoleRefusal","RoleRefusal","Synthetic");
    store.noteWorkItemCommand("Synthetic/RoleRefusal",store.noteWorkItemsRead("Synthetic/RoleRefusal").digest,{action:"create",item:{
      id:"role-refusal",title:"No implicit role grant",goal:"Refuse generic Chat access",scope:"Disposable refusal only",
      acceptance:["No role/human/model success"],state:"Planning",evidence:[]}}, {id:"user:local",role:"user"});
    return store.noteWorkItemsRead("Synthetic/RoleRefusal");
  `);
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const originalBoard = await readFile(join(root, "notes/Synthetic/RoleRefusal.assets/pkm-todo-board.json"));
  const custody = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "native-todo-role-refusal-only", profileSha256: "a".repeat(64),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 8_388_608, maxFileBytes: 2_097_152 } });
  const opened = await openOriginalMcpRoot(custody);
  t.after(() => opened.owner.close());
  await opened.owner.ensureFull();
  const state = () => {
    const db = opened.storage.connectNative();
    try { return {
      receipts: db.prepare("SELECT * FROM receipts").all(), pending: db.prepare("SELECT * FROM pending_todo").all(),
      roleTables: db.prepare("SELECT name FROM sqlite_master WHERE name='original_native_todo_role_effects'").all(),
      modelTables: db.prepare("SELECT name FROM sqlite_master WHERE name='original_native_chat_executions'").all(),
    }; } finally { db.close(); }
  };
  const before = state();
  await assert.rejects(opened.storage.requestOriginalTodoRole({ kind: "tool", payload: { actorId: `chat:${randomUUID()}` } }), /genuine exact native/);
  const actorId = `chat:${randomUUID()}`;
  await assert.rejects(opened.storage.request({ operation: "todo.workitem.claim", actorId,
    args: { board_slug: "Synthetic/RoleRefusal", id: "role-refusal", expected_digest: initial.digest, operationId: randomUUID() } }),
  /Generic requests and receipt copies cannot acquire a Todo role/);
  assert.deepEqual(state(), before);
  assert.deepEqual(await readFile(join(root, "notes/Synthetic/RoleRefusal.assets/pkm-todo-board.json")), originalBoard);
  assert.equal(JSON.parse(originalBoard).items[0].state, "Planning");
  await writeFile(join(directory, "refusal-evidence.json"), JSON.stringify({
    passed: true, actualCanonicalWorker: true, originalPackageSha256: writer.originalPackageSha256,
    copiedGrantRefused: true, genericChatRefusedBeforeReceiptOrPublication: true,
    modelExecuted: false, roleResultProduced: false, humanDecisionProduced: false, boardUnchanged: true,
  }), { mode: 0o600, flag: "wx" });
});
