import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
  LEGACY_CLASSIFICATION_NATIVE_CONTRACT, LEGACY_CLASSIFICATION_NATIVE_DDL, executeNativeClassification, recoverNativeClassification,
  inspectNativeClassificationHistory, inspectNativeClassificationPending, inspectNativeClassificationReceipt, scanNativeClassification, validateNativeClassificationIntent, verifyNativeClassificationSchema,
} from "../dist/legacy-classification-native.js";
import { originalLoader } from "./host-composition-legacy-batch15-captures.mjs";

const source = originalLoader();
const original = source("src/knowledge/asset-classification.ts");
const assets = source("src/knowledge/markdown-assets.ts");
const scriptIdentity = source("src/sync/github-sync-script-identity.ts");
const storage = source("src/knowledge/storage.ts");
const { ProjectStore } = source("src/workflows/project-store.ts");
const actor = { id: "fixture-user", canWrite: true, collaborationKind: "human" };
const folder = resolve(`next-server/.classification-fixture-${process.pid}`);
const root = join(folder, "native"), oracle = join(folder, "original"), dbPath = join(folder, "journal.sqlite");
const scope = { workspaceId: "fixture", sourceRootId: "a".repeat(64), root };
const put = (base, file, content) => { const path = join(base, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const get = (base, file) => readFileSync(join(base, file));
function open() {
  const db = new DatabaseSync(dbPath);
  db.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
  db.exec("CREATE TABLE IF NOT EXISTS global_receipt (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)");
  verifyNativeClassificationSchema(db);
  return db;
}
let permit = true, fault = false, faultAt = 0;
const host = {
  assertOwnedDisposableFixture() { if (!permit) throw new Error("owner revoked"); },
  authorize() { return permit; },
  authorizeRoot(_workspace, _id, candidate) { return candidate === root; },
  approveRecovery() { return permit; },
  previewOriginal: original.previewAssetClassification,
  assertNoOtherPending() {},
  globalReceipt(db, id) { const row = db.prepare("SELECT fingerprint,result FROM global_receipt WHERE id=?").get(id); return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : null; },
  writeGlobalReceipt(db, id, fingerprint, result) { db.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(id, fingerprint, JSON.stringify(result)); },
  afterEffect(index) { if (fault && index === faultAt) throw new Error("injected post-publication fault"); },
};

test("original writer oracle, durable partial recovery and exact receipt-bound rollback", () => {
  mkdirSync(root, { recursive: true }); mkdirSync(oracle, { recursive: true });
  let db;
  try {
    let capturedScriptIdentity;
    for (const base of [root, oracle]) {
      put(base, "notes/topic.md", "\uFEFF---\r\ntitle: Topic\r\nknowledgeId: \"knowledge_0123456789abcdef01234567\"\r\n---\r\n![image](topic.assets/image.png)\r\n");
      put(base, "skills/review.md", "# Review\n![image](review.assets/image.png)\n");
      put(base, "papers/paper.md", "---\nsource_url: https://example.invalid\n---\n![image](paper.assets/image.png)\n");
      for (const [area, document] of [["notes", "topic.md"], ["skills", "review.md"], ["papers", "paper.md"]]) {
        assets.saveMarkdownAsset(base, area, document, "image.png", Buffer.from([0, 1, 2, 255]));
        assert.deepEqual(assets.ownedMarkdownAssetPaths(join(base, area), document), [document.replace(".md", ".assets/image.png")]);
      }
      put(base, "scripts/run.py", "print('hello')\n");
      if (capturedScriptIdentity) put(base, "scripts/.run.py.pkm.json", capturedScriptIdentity);
      storage.setStorePath(base);
      const script = storage.scriptGet("run.py");
      capturedScriptIdentity = get(base, scriptIdentity.syncScriptSidecarPath("scripts/run.py"));
      assert.equal(scriptIdentity.readSyncScriptIdentity(capturedScriptIdentity).knowledgeId, script.knowledgeId);
      const store = new ProjectStore(join(base, ".pkm/state"), () => "project-source-oracle", { autoMigrate: false });
      const created = store.createProject({ commandId: "classification-source-project-create", fingerprint: "classification-source-project", expectedStoreVersion: store.list().storeVersion }, "Original source project");
      assert.equal(created.entityId, "project_project-source-oracle");
      assert.equal(store.list().projects.find(project => project.projectId === created.entityId).name, "Original source project");
    }
    db = open();
    const projectBytes = get(root, ".pkm/state/projects.json");
    const preview = original.previewAssetClassification(root), otherPreview = original.previewAssetClassification(oracle);
    assert.deepEqual(preview.proposals, otherPreview.proposals);
    const selected = ["notes/topic.md", "skills/review.md", "papers/paper.md", "scripts/run.py"].map(asset => preview.proposals.find(p => p.type === "classification" && p.asset === asset));
    assert(selected.every(Boolean));
    const request = { contract: LEGACY_CLASSIFICATION_NATIVE_CONTRACT, action: "apply", operationId: randomUUID(), previewId: preview.id, layoutSha256: scanNativeClassification(db, host, root).layoutSha256, proposalIds: selected.map(p => p.id) };
    const originalResult = original.applyAssetClassification(oracle, otherPreview, request.proposalIds);
    assert.match(originalResult.journalId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(originalResult, { journalId: originalResult.journalId, applied: request.proposalIds, skipped: [] });
    fault = true;
    assert.throws(() => executeNativeClassification(db, host, scope, actor, request), /injected/);
    assert(inspectNativeClassificationPending(db));
    assert(inspectNativeClassificationHistory(db, host).pending);
    assert.throws(() => recoverNativeClassification(db, host, scope, { ...actor, id: "other" }, request), /identical/);
    permit = false;
    assert.throws(() => recoverNativeClassification(db, host, scope, actor, request));
    permit = true; fault = false;
    db.close(); db = open();
    const result = recoverNativeClassification(db, host, scope, actor, request);
    assert.deepEqual(result.applied, originalResult.applied);
    assert.equal(inspectNativeClassificationPending(db), null);
    const stored = inspectNativeClassificationReceipt(db, request.operationId);
    const journal = JSON.parse(get(oracle, `.pkm/state/asset-classification/${originalResult.journalId}.json`));
    assert.deepEqual(stored.effects.map(e => ({
      id: e.id, asset: e.asset, target: e.target, before: e.before,
      beforeHash: e.before === null ? null : createHash("sha256").update(Buffer.from(e.before, "base64")).digest("hex"),
      afterHash: createHash("sha256").update(Buffer.from(e.after, "base64")).digest("hex"), mode: e.mode,
    })), journal.entries);
    assert.throws(() => validateNativeClassificationIntent({ ...stored, effects: [{ ...stored.effects[0], target: "../escape" }, ...stored.effects.slice(1)] }), /Invalid/);
    assert.deepEqual(executeNativeClassification(db, host, scope, actor, request), result);
    assert.throws(() => executeNativeClassification(db, host, scope, actor, { ...request, proposalIds: [selected[0].id] }), /reused|mismatch/);
    for (const p of selected) assert.deepEqual(get(root, p.target), get(oracle, p.target));
    for (const file of ["notes/topic.assets/image.png", "skills/review.assets/image.png", "papers/paper.assets/image.png", "scripts/run.py", "scripts/.run.py.pkm.json"]) assert.deepEqual(get(root, file), get(oracle, file));
    assert.deepEqual(get(root, ".pkm/state/projects.json"), projectBytes);
    const script = get(root, "scripts/run.py");
    put(root, "scripts/run.py", "unapproved edit");
    assert.throws(() => executeNativeClassification(db, host, scope, actor, { contract: LEGACY_CLASSIFICATION_NATIVE_CONTRACT, action: "rollback", operationId: randomUUID(), applyOperationId: request.operationId, layoutSha256: scanNativeClassification(db, host, root).layoutSha256 }), /Applied layout changed/);
    assert.equal(inspectNativeClassificationPending(db), null);
    put(root, "scripts/run.py", script);
    const rollback = { contract: LEGACY_CLASSIFICATION_NATIVE_CONTRACT, action: "rollback", operationId: randomUUID(), applyOperationId: request.operationId, layoutSha256: scanNativeClassification(db, host, root).layoutSha256 };
    const originalRollback = original.rollbackAssetClassification(oracle, originalResult.journalId);
    assert.deepEqual(originalRollback, { journalId: originalResult.journalId, applied: [...request.proposalIds].reverse(), skipped: [] });
    const rollbackResult = executeNativeClassification(db, host, scope, actor, rollback);
    assert.deepEqual(rollbackResult.applied, originalRollback.applied);
    for (const file of ["notes/topic.md", "skills/review.md", "papers/paper.md", "scripts/run.py"]) assert.deepEqual(get(root, file), get(oracle, file));
    assert.deepEqual(get(root, ".pkm/state/projects.json"), projectBytes);
    assert.throws(() => get(root, selected[3].target), { code: "ENOENT" });
    assert.deepEqual(executeNativeClassification(db, host, scope, actor, rollback), rollbackResult);
    assert.equal(inspectNativeClassificationHistory(db, host).receipts.length, 2);
    assert.throws(() => executeNativeClassification(db, undefined, scope, actor, rollback), /owner/);
    const foreignId = randomUUID();
    db.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(foreignId, "0".repeat(64), "{}");
    assert.throws(() => executeNativeClassification(db, host, scope, actor, { ...request, operationId: foreignId }), /receipt mismatch/);
    const againPreview = original.previewAssetClassification(root);
    const again = { contract: LEGACY_CLASSIFICATION_NATIVE_CONTRACT, action: "apply", operationId: randomUUID(), previewId: againPreview.id, layoutSha256: scanNativeClassification(db, host, root).layoutSha256, proposalIds: selected.map(p => p.id) };
    fault = true;
    assert.throws(() => executeNativeClassification(db, host, scope, actor, again), /injected/);
    fault = false;
    const record = db.prepare("SELECT payload,payload_sha256 FROM legacy_classification_native_intent").get();
    db.prepare("UPDATE legacy_classification_native_intent SET payload=?").run(`${record.payload} `);
    assert.throws(() => recoverNativeClassification(db, host, scope, actor, again), /Corrupt/);
    db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?").run(record.payload, record.payload_sha256);
    const project = get(root, ".pkm/state/projects.json");
    put(root, ".pkm/state/projects.json", "tampered");
    assert.throws(() => recoverNativeClassification(db, host, scope, actor, again), /Unknown/);
    put(root, ".pkm/state/projects.json", project);
    recoverNativeClassification(db, host, scope, actor, again);
    const rollbackAgain = { contract: LEGACY_CLASSIFICATION_NATIVE_CONTRACT, action: "rollback", operationId: randomUUID(), applyOperationId: again.operationId, layoutSha256: scanNativeClassification(db, host, root).layoutSha256 };
    fault = true;
    assert.throws(() => executeNativeClassification(db, host, scope, actor, rollbackAgain), /injected/);
    fault = false; db.close(); db = open();
    assert.equal(recoverNativeClassification(db, host, scope, actor, rollbackAgain).applied.length, selected.length);
    const stale = { ...request, operationId: randomUUID() };
    put(root, "notes/topic.md", "changed");
    assert.throws(() => executeNativeClassification(db, host, scope, actor, stale), /layout/);
    mkdirSync(join(root, "scripts/.run.py.pkm-classification"));
    const collided = { ...stale, layoutSha256: scanNativeClassification(db, host, root).layoutSha256 };
    assert.throws(() => executeNativeClassification(db, host, scope, actor, collided));
    assert.equal(inspectNativeClassificationPending(db), null);
    rmSync(join(root, "scripts/.run.py.pkm-classification"), { recursive: true });
    symlinkSync("topic.md", join(root, "notes/link.md"));
    assert.throws(() => scanNativeClassification(db, host, root), /Symbolic/);
    unlinkSync(join(root, "notes/link.md"));
    linkSync(join(root, "notes/topic.md"), join(root, "notes/hardlink.md"));
    assert.throws(() => scanNativeClassification(db, host, root), /Unsupported file layout/);
    unlinkSync(join(root, "notes/hardlink.md"));
  } finally { db?.close(); rmSync(folder, { recursive: true, force: true }); }
});
