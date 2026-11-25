import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { dispatchOriginalMcpTodoBasic } from "../dist/original-mcp-todo-basic.js";
import { withOriginalMcpTodoGenesisContext, originalMcpTodoGenesisAttemptProvenance } from "../dist/original-mcp-todo-genesis-native.js";
import { originalMcpTodoGenesisCustodyExceptions, assertNoPendingOriginalMcpTodoGenesis } from "../dist/original-mcp-todo-genesis.js";
import { parseOriginalMcpTodoGenesisPayload, originalMcpTodoGenesisRequestDigest as digest,
  validateOriginalMcpTodoGenesisPlan } from "../dist/original-mcp-todo-genesis-contracts.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function packet() {
  const epoch = randomUUID(), operationId = randomUUID(), brokerId = randomUUID();
  const root = "/owned/protocol-only-todo", workspaceId = randomUUID();
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root, workspaceId,
    planSha256: "a".repeat(64), profileSha256: "b".repeat(64), sourceCatalogSha256: "c".repeat(64),
    authorityId: `native-rpc:${brokerId}`, epoch, actorId: "mcp:external", domains: ["mcp-public"],
    configurationSha256: "d".repeat(64) };
  const session = { brokerId, activationId: epoch, epoch, identitySha256: "e".repeat(64), binding: {
    root, workspaceId, planSha256: binding.planSha256, profileSha256: binding.profileSha256,
    catalogSha256: binding.sourceCatalogSha256, payloadBuildId: "f".repeat(64), hostEntrySha256: "0".repeat(64),
  } };
  const descriptor = "---\ntitle: Board\n---\n", backing = '{"schema":"pkm.todo-board/v1","items":[]}\n';
  const arguments_ = { title: "Board", category: "Team" };
  const request = { schema: "pkm.original-mcp-todo-genesis-request/v1", phase: "create",
    operation: "mcp.tool.todo_board_create", operationId, actorId: "mcp:external", root, workspaceId,
    profileSha256: binding.profileSha256, custodyPlanSha256: binding.planSha256,
    catalogSha256: binding.sourceCatalogSha256, nativeHostReceiptSha256: digest(binding), nativeEpoch: epoch,
    arguments: arguments_, argumentsSha256: digest(arguments_), privacySha256: hash(""),
    selection: { boardSlug: "Team/Board", sourceId: randomUUID(), documentId: `board-${operationId}`,
      knowledgeId: `knowledge_${"1".repeat(24)}`, notePath: "notes/Team/Board.md", pairPath: "notes/Team/Board.assets",
      backingPath: "notes/Team/Board.assets/pkm-todo-board.json", canonicalBoardPath: ".pkm-next-todo/Team/Board/pkm-todo-board.json",
      descriptorSha256: hash(descriptor), backingSha256: hash(backing), layout: "pkm.original-todo-genesis/v1",
      expectedBefore: Object.fromEntries(["note", "pair", "backing", "canonicalBoard", "canonicalDirectory"]
        .map(key => [key, { state: "absent" }])),
      ancestors: [".", "notes", ".pkm-next-todo", "notes/Team", ".pkm-next-todo/Team"]
        .map((path, index) => ({ path, device: "1", inode: String(index + 1), uid: "1000", mode: 0o700 })),
    }, noExecution: true, noWorkerEnrollment: true, noReviewerDelegation: true };
  request.selection.expectedBefore.sourceIndex = "absent";
  const body = { request, descriptor, backing };
  return { session, payload: { binding, defaultDecision: "deny", request, requestSha256: digest(request) },
    plan: validateOriginalMcpTodoGenesisPlan({ ...body, planSha256: digest(body) }) };
}
async function ownedOriginal(t) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the isolated existing framework.");
  assert(process.env.PKM_TEST_PYTHON, "Use the exact business interpreter.");
  const base = resolve(".pkm-test-evidence", `native-todo-${randomUUID()}`), directory = join(base, "oracle");
  let opened;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(async () => { await opened?.owner.close(); await rm(base, { recursive: true, force: true }); });
  const oracle = pinnedOriginalKnowledgeWriterFixture({ directory,
    legacyVsix: process.env.PKM_LEGACY_VSIX, python: process.env.PKM_TEST_PYTHON });
  const root = join(directory, "library"); await mkdir(root, { mode: 0o700 });
  oracle.run(root, `store.todoBoardCreate("Team/Board", "Board", "Team"); return store.noteWorkItemsRead("Team/Board");`);
  await mkdir(join(root, ".pkm"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const paths = ["notes/Team/Board.md", "notes/Team/Board.assets/pkm-todo-board.json"];
  const before = await Promise.all(paths.map(path => readFile(join(root, path))));
  const plan = await captureOriginalMcpCustody({ root, backup: join(base, "custody"), operatorId: "native-todo-boundary-test",
    profileSha256: hash("owned-native-todo-boundary"), limits: {
      maxEntries: 1000, maxDepth: 16, maxBytes: 4_194_304, maxFileBytes: 2_097_152,
    } });
  opened = await openOriginalMcpRoot(plan);
  return { ...opened, root, oracle, async unchanged() {
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path)))), before);
  } };
}

test("Todo genesis Source parser binds exact epoch, absent targets, public layout and actor without granting creation authority", () => {
  const f = packet();
  assert.deepEqual(parseOriginalMcpTodoGenesisPayload(f.payload, f.session), f.payload);
  for (const mutate of [
    p => { p.request.nativeEpoch = randomUUID(); },
    p => { p.request.selection.notePath = "notes/Other/Board.md"; },
    p => { p.request.selection.expectedBefore.pair = { state: "present", sha256: hash("occupied") }; },
    p => { p.request.actorId = "user:local"; },
    p => { p.request.worker_token = "copied-old-token"; },
    p => { p.request.reviewerIds = ["mcp:external"]; },
  ]) {
    const changed = structuredClone(f.payload); mutate(changed);
    changed.requestSha256 = digest(changed.request);
    assert.throws(() => parseOriginalMcpTodoGenesisPayload(changed, f.session));
  }
  const hidden = structuredClone(f.payload);
  hidden.request.arguments = { title: "Board", category: ".hidden" };
  hidden.request.argumentsSha256 = digest(hidden.request.arguments); hidden.requestSha256 = digest(hidden.request);
  assert.throws(() => parseOriginalMcpTodoGenesisPayload(hidden, f.session));
});

test("Todo Original basic IDs refuse a real original Root without signed Host/source enrollment and preserve its Note pair", { timeout: 120000 }, async t => {
  const f = await ownedOriginal(t), actor = { id: "mcp:external", canWrite: true };
  const operations = ["get_board", "get_workitem", "list_boards", "list_workitems", "list_workitem_history",
    "list_board_changes", "add_workitem", "update_workitem", "claim_workitem", "change_workitem_state", "note_work_items"];
  const catalog = originalPublicMcpContracts();
  for (const tool of operations) {
    assert(catalog.contracts.some(contract => contract.id === `mcp.tool.${tool}`));
    await assert.rejects(dispatchOriginalMcpTodoBasic(f.owner, undefined, actor, tool,
      { board_slug: "Team/Board", id: "not-created" }), { code: "ACCESS_DENIED" });
    await f.unchanged();
  }
  t.diagnostic(`Refusal-only original IDs: ${operations.map(tool => `mcp.tool.${tool}`).join(",")}; no signed producer/source grant, no writes or Native success claimed.`);
});

test("Todo copied genesis and pending JSON grant no opaque authority or footprint without the actual canonical compound intent", { timeout: 120000 }, async t => {
  const f = await ownedOriginal(t), protocol = packet();
  let effects = 0;
  await assert.rejects(withOriginalMcpTodoGenesisContext({ kind: "pkm.original-mcp-todo-genesis-port/v1" },
    { title: "NotCreated" }, async () => { effects++; }), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.throws(() => originalMcpTodoGenesisAttemptProvenance(
    { kind: "pkm.original-mcp-todo-genesis-attempt/v1" }, f.storage, protocol.plan), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.equal(effects, 0);
  const db = f.storage.connectNative();
  try {
    const before = originalMcpTodoGenesisCustodyExceptions(f.root, db);
    assert.equal(before.files.size + before.directories.size + before.temporaries.size, 0);
    const copied = { request: protocol.plan.request, decision: { decision: "approve", actorId: "mcp:external",
      decisionId: randomUUID(), operationId: protocol.plan.request.operationId, epoch: protocol.plan.request.nativeEpoch,
      expiresAtMs: Date.now() + 60000, requestSha256: digest(protocol.plan.request) } };
    db.prepare("INSERT INTO original_todo_genesis_pending VALUES(?,?,?,?,?)").run(
      protocol.plan.request.operationId, JSON.stringify(protocol.plan), JSON.stringify(copied),
      "0".repeat(64), JSON.stringify(copied));
    assert.throws(() => originalMcpTodoGenesisCustodyExceptions(f.root, db), { code: "RECOVERY_CONFLICT" });
    assert.throws(() => assertNoPendingOriginalMcpTodoGenesis(db), { code: "RECOVERY_AUTHORITY_REQUIRED" });
    db.prepare("DELETE FROM original_todo_genesis_pending WHERE operation_id=?").run(protocol.plan.request.operationId);
    assert.equal(originalMcpTodoGenesisCustodyExceptions(f.root, db).temporaries.size, 0);
  } finally { db.close(); }
  await f.unchanged();
  t.diagnostic("Copied protocol JSON was deliberately rejected, never treated as a genuine decision/receipt. Genesis remains unqualified until method26 + exact source merge + custody integration.");
});
