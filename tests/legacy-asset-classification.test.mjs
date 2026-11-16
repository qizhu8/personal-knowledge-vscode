import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initialize, Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import {
  admitLegacyAssetClassification, createLegacyAssetClassificationSession, invokeAdmittedLegacyAssetClassification,
  legacyAssetClassification, reconcileLegacyAssetClassification, verifyLegacyAssetClassification,
} from "../dist/legacy-asset-classification.js";
import { originalReleaseModules as originalLoader } from "./legacy-release-modules.mjs";

const actor = { id: "mcp:external", canWrite: true };
const put = (root, path, value) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), value); };
const tree = (root, prefix = "") => readdirSync(join(root, prefix)).sort().flatMap(name => {
  if (!prefix && ["core.sqlite", "core.sqlite-shm", "core.sqlite-wal"].includes(name)) return [];
  const p = prefix ? `${prefix}/${name}` : name, s = lstatSync(join(root, p));
  return s.isDirectory() ? tree(root, p) : [[p, s.mode & 0o777, readFileSync(join(root, p)).toString("base64")]];
});
async function fixture(t) {
  const folder = join(import.meta.dirname, `.native-classification-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  const root = await initialize(join(folder, "workspace"));
  put(root, "notes/Engineering/a.md", "\uFEFF---\r\nknowledgeId: knowledge_0123456789abcdef01234567\r\nkind: script\r\n---\r\n# Original\r\n![image](a.assets/x.png)\r\n");
  chmodSync(join(root, "notes/Engineering/a.md"), 0o640);
  put(root, "notes/Engineering/a.assets/x.png", Buffer.from([0, 255, 42]));
  put(root, "notes/Engineering/b.md", "# Original\r\n![image](a.assets/x.png)\r\n");
  put(root, "scripts/Engineering/run.py", "print('not executed')\n");
  let storage = await Storage.open(root), session = createLegacyAssetClassificationSession();
  const authority = { authorityId: "native-classification-fixture", authorize: () => true };
  await admitLegacyAssetClassification(storage, actor, authority);
  put(root, "actions/one.json", '{"actionId":"action-test","project":"Example"}\n');
  put(root, "components/one.json", '{"componentId":"component-test"}\n');
  put(root, "recipes/one.json", '{"recipeId":"recipe_test"}\n');
  put(root, "skills/Engineering/one.md", "# Skill\n");
  put(root, "papers/Engineering/one.md", "# Paper\n");
  const invoke = (tool, args = {}, operationId = randomUUID(), who = actor) =>
    invokeAdmittedLegacyAssetClassification(storage, who, { tool, args, operationId }, session);
  const direct = (tool, args, host, operationId = randomUUID()) =>
    legacyAssetClassification(storage, actor, { tool, args, operationId }, host, session);
  const oracle = join(folder, "oracle");
  cpSync(root, oracle, { recursive: true });
  const source = originalLoader()("src/knowledge/asset-classification.ts");
  async function restart() {
    session.close(); await storage.close();
    storage = await Storage.open(root); session = createLegacyAssetClassificationSession();
  }
  t.after(async () => { session.close(); await storage.close(); rmSync(folder, { recursive: true, force: true }); });
  return { root, folder, oracle, source, authority, invoke, direct, restart, get storage() { return storage; } };
}
test("native captured planner exactly matches the original seven-area source without preview effects", async t => {
  const f = await fixture(t);
  const before = tree(f.root), preview = await f.invoke("asset_classify_preview");
  assert.deepEqual(preview, f.source.previewAssetClassification(f.root));
  assert.deepEqual(tree(f.root), before);
  assert(preview.proposals.some(p => p.type === "correction"));
  for (const area of ["notes", "skills", "papers", "scripts", "components", "actions", "recipes"])
    assert(preview.proposals.some(p => p.asset.startsWith(`${area}/`)), area);
  assert(!preview.proposals.some(p => p.asset.includes(".assets/")));
  const reader = await f.invoke("asset_classify_preview", {}, randomUUID(), { ...actor, canWrite: false });
  assert.deepEqual(reader, preview);
});
test("native preview ignores source-excluded metadata and attachment trees without reading them", async t => {
  const f = await fixture(t);
  put(f.root, "notes/Engineering/a.assets/oversized.bin", Buffer.alloc(2 * 1024 * 1024 + 1, 7));
  put(f.root, "notes/Engineering/a.md.pkm-meta.json", Buffer.alloc(2 * 1024 * 1024 + 1, 9));
  put(f.root, "notes/Engineering/.hidden/oversized.bin", Buffer.alloc(2 * 1024 * 1024 + 1, 11));
  put(f.root, "notes/Engineering/.orphan.pkm-classification", Buffer.alloc(2 * 1024 * 1024 + 1, 13));
  const preview = await f.invoke("asset_classify_preview");
  assert.deepEqual(preview, f.source.previewAssetClassification(f.root));
  assert(!preview.proposals.some(p => /(?:\.assets\/|\.pkm-meta\.json$|\/\.hidden\/)/.test(p.asset)));
});
test("original metadata/journal bytes, partial skips, receipts, restart replay and rollback remain exact", async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const ids = preview.proposals.filter(p => p.asset === "notes/Engineering/a.md" || p.asset === "scripts/Engineering/run.py").map(p => p.id);
  const operationId = randomUUID(), request = { preview_id: preview.id, proposal_ids: ids };
  const value = await f.invoke("asset_classify_apply", request, operationId);
  let calls = 0;
  const crypto = await import("node:crypto");
  const oracle = originalLoader({ crypto: { ...crypto, randomUUID: () => ++calls === 2 ? value.journalId : randomUUID() } })("src/knowledge/asset-classification.ts");
  const expected = oracle.applyAssetClassification(f.oracle, { ...preview, root: f.oracle }, ids);
  assert.deepEqual(value, expected);
  for (const p of preview.proposals.filter(p => value.applied.includes(p.id))) {
    assert.deepEqual(readFileSync(join(f.root, p.target)), readFileSync(join(f.oracle, p.target)));
    assert.equal(lstatSync(join(f.root, p.target)).mode & 0o777, lstatSync(join(f.oracle, p.target)).mode & 0o777);
  }
  const journal = readFileSync(join(f.root, "packages/asset-classification", `${value.journalId}.json`));
  assert.deepEqual(journal, readFileSync(join(f.oracle, ".pkm/state/asset-classification", `${value.journalId}.json`)));
  assert.deepEqual(readFileSync(join(f.root, "notes/Engineering/a.assets/x.png")), Buffer.from([0, 255, 42]));
  await f.restart();
  assert.deepEqual(await f.invoke("asset_classify_apply", request, operationId), value);
  await assert.rejects(f.invoke("asset_classify_apply", { ...request, proposal_ids: ids.slice(1) }, operationId), /reused/);
  await assert.rejects(f.invoke("asset_classify_apply", request), /active retained preview/);
  const rollbackId = randomUUID(), rollback = await f.invoke("asset_classify_rollback", { journal_id: value.journalId }, rollbackId);
  assert.deepEqual(rollback, oracle.rollbackAssetClassification(f.oracle, value.journalId));
  await f.restart();
  assert.deepEqual(await f.invoke("asset_classify_rollback", { journal_id: value.journalId }, rollbackId), rollback);
  assert.deepEqual(readFileSync(join(f.root, "notes/Engineering/a.md")), readFileSync(join(f.oracle, "notes/Engineering/a.md")));
  assert(!existsSync(join(f.root, "scripts/Engineering/.run.py.pkm-classification")));
});
test("session cache expires FIFO, caller bodies cannot substitute for approval, and actors cannot elevate writes", async t => {
  const f = await fixture(t), first = await f.invoke("asset_classify_preview");
  const p = first.proposals.find(p => p.type === "classification");
  await assert.rejects(f.invoke("asset_classify_apply", { preview_id: first.id, proposal_ids: [p.id] }, randomUUID(), { ...actor, canWrite: false }), /host-admitted/);
  await assert.rejects(f.invoke("asset_classify_preview", {}, randomUUID(), { id: "other", canWrite: true }), /host-admitted/);
  await assert.rejects(f.invoke("asset_classify_apply", { preview_id: first.id, proposal_ids: [p.id], preview: first }), /unrecognized|Unrecognized/);
  for (let n = 0; n < 8; n++) {
    put(f.root, `notes/new-${n}.md`, `# Different ${n}\n`);
    await f.invoke("asset_classify_preview");
  }
  await assert.rejects(f.invoke("asset_classify_apply", { preview_id: first.id, proposal_ids: [p.id] }), /active retained preview/);
});
for (const phase of ["intent", "staged", "published"]) test(`classification ${phase} fault stays fenced until exact native reconciliation`, async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const p = preview.proposals.find(p => p.type === "classification" && p.asset.endsWith("a.md"));
  let fired = false;
  await assert.rejects(f.direct("asset_classify_apply", { preview_id: preview.id, proposal_ids: [p.id] }, {
    authorize: () => true, checkpoint(value) { if (!fired && value === phase) { fired = true; throw Error(`fault-${phase}`); } },
  }), new RegExp(`fault-${phase}`));
  assert(fired);
  await assert.rejects(f.invoke("asset_classify_preview"), /reconciliation/);
  const db = f.storage.connectNative();
  try { assert.throws(() => verifyLegacyAssetClassification(db, f.root), /reconciliation/); }
  finally { db.close(); }
  await f.restart();
  await assert.rejects(f.invoke("asset_classify_preview"), /reconciliation/);
  await assert.rejects(reconcileLegacyAssetClassification(f.storage, { id: "other", canWrite: true }, f.authority), /host-admitted/);
  const result = await reconcileLegacyAssetClassification(f.storage, actor, f.authority);
  assert.deepEqual(result.applied, [p.id]);
  assert.deepEqual(await f.invoke("asset_classify_preview"), f.source.previewAssetClassification(f.root));
});
test("stale assets skip exactly as original, and rollback never overwrites later human edits", async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const selections = preview.proposals.filter(p => p.type === "classification" && /[ab]\.md$/.test(p.asset));
  put(f.root, "notes/Engineering/b.md", "# Changed after preview\n");
  const result = await f.invoke("asset_classify_apply", { preview_id: preview.id, proposal_ids: selections.map(p => p.id) });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.skipped, [{ id: selections.find(p => p.asset.endsWith("b.md")).id, reason: "changed-since-preview" }]);
  put(f.root, "notes/Engineering/a.md", "# Human edit retained\n");
  const rollback = await f.invoke("asset_classify_rollback", { journal_id: result.journalId });
  assert.deepEqual(rollback.skipped, [{ id: result.applied[0], reason: "changed-since-apply" }]);
  assert.equal(readFileSync(join(f.root, "notes/Engineering/a.md"), "utf8"), "# Human edit retained\n");
});
test("staged source races never replace any target and cannot be bypassed by normal read/write calls", async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const p = preview.proposals.find(p => p.type === "classification" && p.asset.endsWith("a.md"));
  const original = readFileSync(join(f.root, p.asset));
  let raced = false;
  await assert.rejects(f.direct("asset_classify_apply", { preview_id: preview.id, proposal_ids: [p.id] }, {
    authorize: () => true, checkpoint(phase) {
      if (!raced && phase === "staged") { raced = true; put(f.root, p.asset, "# Human won source race\n"); }
    },
  }), /changed after staging/);
  assert.equal(readFileSync(join(f.root, p.asset), "utf8"), "# Human won source race\n");
  await assert.rejects(f.invoke("asset_classify_preview"), /reconciliation/);
  await assert.rejects(reconcileLegacyAssetClassification(f.storage, actor, f.authority), /CAS changed/);
  put(f.root, p.asset, original);
  assert.deepEqual((await reconcileLegacyAssetClassification(f.storage, actor, f.authority)).applied, [p.id]);
});
test("unknown journal files and changed original journal bytes are never adopted or rolled back", async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const p = preview.proposals.find(p => p.type === "classification" && p.asset.endsWith("a.md"));
  const value = await f.invoke("asset_classify_apply", { preview_id: preview.id, proposal_ids: [p.id] });
  const path = `packages/asset-classification/${value.journalId}.json`, original = readFileSync(join(f.root, path));
  put(f.root, path, "{}");
  await assert.rejects(f.invoke("asset_classify_rollback", { journal_id: value.journalId }), /not owned/);
  put(f.root, path, original);
  const foreign = `packages/asset-classification/${randomUUID()}.json`;
  put(f.root, foreign, '{"schema":1,"entries":[]}');
  await assert.rejects(f.invoke("asset_classify_preview"), /not owned/);
  rmSync(join(f.root, foreign));
  assert.equal((await f.invoke("asset_classify_rollback", { journal_id: value.journalId })).applied.length, 1);
});
test("returned preview objects cannot mutate retained native review authority", async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const p = preview.proposals.find(p => p.type === "classification" && p.asset.endsWith("a.md"));
  const expected = structuredClone(p);
  p.classification.kind = "caller-substitution";
  p.asset = "notes/Engineering/b.md";
  const result = await f.invoke("asset_classify_apply", { preview_id: preview.id, proposal_ids: [p.id] });
  assert.deepEqual(result.applied, [expected.id]);
  const bytes = readFileSync(join(f.root, expected.target), "utf8");
  assert(bytes.includes('"kind":"note"'));
  assert(!bytes.includes("caller-substitution"));
});

function classificationEvidence(storage) {
  const db = storage.connectNative();
  try {
    return {
      admission: db.prepare("SELECT * FROM legacy_asset_classification_admission").all(),
      events: db.prepare("SELECT * FROM legacy_asset_classification_events ORDER BY sequence").all(),
      intent: db.prepare("SELECT * FROM legacy_asset_classification_intent").all(),
      receipts: db.prepare("SELECT * FROM receipts ORDER BY operation_id").all(),
    };
  } finally { db.close(); }
}
async function restoredClassification(f) {
  const backup = join(f.folder, "backup"), root = join(f.folder, "restored");
  let held = false;
  await createWorkspaceBackup(f.storage, backup, {
    async acquireQuiescence() {
      assert.equal(held, false);
      held = true;
      return { assertHeld() { assert(held); }, release() { held = false; } };
    },
  });
  await restoreWorkspaceBackup(backup, root, { nativeRestoreAuthority });
  return { root, storage: await Storage.open(root), session: createLegacyAssetClassificationSession() };
}
async function classifiedNote(f) {
  const preview = await f.invoke("asset_classify_preview");
  const proposal = preview.proposals.find(p => p.type === "classification" && p.asset.endsWith("a.md"));
  const operationId = randomUUID(), args = { preview_id: preview.id, proposal_ids: [proposal.id] };
  return { operationId, args, result: await f.invoke("asset_classify_apply", args, operationId) };
}
test("same-root explicit restart admission preserves immutable evidence and original journal ownership", async t => {
  const f = await fixture(t), applied = await classifiedNote(f);
  const before = classificationEvidence(f.storage), files = tree(f.root);
  await f.restart();
  await admitLegacyAssetClassification(f.storage, actor, f.authority);
  assert.deepEqual(classificationEvidence(f.storage), before);
  assert.deepEqual(tree(f.root), files);
  assert.deepEqual(await f.invoke("asset_classify_apply", applied.args, applied.operationId), applied.result);
  assert.deepEqual((await f.invoke("asset_classify_rollback", { journal_id: applied.result.journalId })).applied, applied.result.applied);
});
test("relocated workspace backup metadata and journals cannot admit preview, replay or rollback", async t => {
  const f = await fixture(t), applied = await classifiedNote(f), restored = await restoredClassification(f);
  try {
    assert.equal(await restored.storage.workspaceId(), await f.storage.workspaceId());
    const before = classificationEvidence(restored.storage), files = tree(restored.root);
    assert.deepEqual(before, classificationEvidence(f.storage));
    for (const [tool, args, operationId] of [
      ["asset_classify_preview", {}, randomUUID()],
      ["asset_classify_apply", applied.args, applied.operationId],
      ["asset_classify_rollback", { journal_id: applied.result.journalId }, randomUUID()],
    ]) await assert.rejects(invokeAdmittedLegacyAssetClassification(restored.storage, actor,
      { tool, args, operationId }, restored.session), { code: "ACCESS_DENIED" });
    await assert.rejects(reconcileLegacyAssetClassification(restored.storage, actor, f.authority), { code: "ACCESS_DENIED" });
    assert.deepEqual(classificationEvidence(restored.storage), before);
    assert.deepEqual(tree(restored.root), files);
    assert.deepEqual(await f.invoke("asset_classify_apply", applied.args, applied.operationId), applied.result);
  } finally { restored.session.close(); await restored.storage.close(); }
});
test("relocated explicit current-root opt-in stays denied instead of rewriting immutable admission or journals", async t => {
  const f = await fixture(t);
  await classifiedNote(f);
  const restored = await restoredClassification(f);
  try {
    const before = classificationEvidence(restored.storage), files = tree(restored.root), bindings = [];
    const workspaceId = await restored.storage.workspaceId();
    await assert.rejects(admitLegacyAssetClassification(restored.storage, actor, {
      authorityId: f.authority.authorityId,
      authorize(binding) {
        bindings.push(binding);
        return binding.actorId === actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === restored.root && binding.operation === "admit";
      },
    }), { code: "ACCESS_DENIED" });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].workspaceRoot, restored.root);
    const db = restored.storage.connectNative();
    try {
      const admission = before.admission[0];
      assert.throws(() => db.prepare("UPDATE legacy_asset_classification_admission SET payload=? WHERE singleton=1")
        .run(admission.payload), /classification admission immutable/);
      assert.throws(() => db.prepare("DELETE FROM legacy_asset_classification_admission WHERE singleton=1").run(),
        /classification admission immutable/);
    } finally { db.close(); }
    assert.deepEqual(classificationEvidence(restored.storage), before);
    assert.deepEqual(tree(restored.root), files);
  } finally { restored.session.close(); await restored.storage.close(); }
});
test("admission rejects mismatched actors, stale-root approval and tool authority without changing evidence", async t => {
  const f = await fixture(t), before = classificationEvidence(f.storage);
  for (const who of [{ ...actor, id: "other" }, { ...actor, canWrite: false }, { ...actor, boardWorker: true }])
    await assert.rejects(admitLegacyAssetClassification(f.storage, who, f.authority), { code: "ACCESS_DENIED" });
  await assert.rejects(admitLegacyAssetClassification(f.storage, actor, {
    ...f.authority, authorize: binding => binding.workspaceRoot === f.oracle,
  }), { code: "ACCESS_DENIED" });
  await assert.rejects(admitLegacyAssetClassification(f.storage, actor, {
    ...f.authority, allowedTools: ["asset_classify_preview"],
  }), { code: "CONFLICT" });
  await assert.rejects(admitLegacyAssetClassification(f.storage, actor, {
    ...f.authority, authorityId: "different-authority",
  }), { code: "CONFLICT" });
  assert.deepEqual(classificationEvidence(f.storage), before);
});
for (const phase of ["intent", "staged", "published"]) test(`relocated ${phase} intent cannot transfer recovery authority`, async t => {
  const f = await fixture(t), preview = await f.invoke("asset_classify_preview");
  const proposal = preview.proposals.find(p => p.type === "classification" && p.asset.endsWith("a.md"));
  let fired = false;
  await assert.rejects(f.direct("asset_classify_apply", { preview_id: preview.id, proposal_ids: [proposal.id] }, {
    authorize: () => true,
    checkpoint(value) { if (!fired && value === phase) { fired = true; throw new Error(`relocate-${phase}`); } },
  }), new RegExp(`relocate-${phase}`));
  assert(fired);
  const root = join(f.folder, "interrupted-copy");
  await f.storage.close();
  cpSync(f.root, root, { recursive: true });
  await f.restart();
  const files = tree(root);
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(tree(root), files);
  assert.deepEqual((await reconcileLegacyAssetClassification(f.storage, actor, f.authority)).applied, [proposal.id]);
});
