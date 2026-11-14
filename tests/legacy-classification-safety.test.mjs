import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  LEGACY_CLASSIFICATION_NATIVE_CONTRACT as contract, LEGACY_CLASSIFICATION_NATIVE_DDL,
  executeNativeClassification as execute, recoverNativeClassification as recover,
  inspectNativeClassificationHistory as history,
  inspectNativeClassificationPending as pending, inspectNativeClassificationReceipt as receipt,
  scanNativeClassification as scan, validateNativeClassificationHistoryLayout as validateLayout,
} from "../dist/legacy-classification-native.js";
import { assertBatch16UnintegratedClear } from "../dist/host-composition-legacy-batch16-fence.js";
import { originalLoader } from "./host-composition-legacy-batch15-captures.mjs";

const source = originalLoader();
const original = source("src/knowledge/asset-classification.ts");
const privacy = source("src/knowledge/content-privacy.ts");
const actor = { id: "human", canWrite: true, collaborationKind: "human" };
const put = (root, path, data) => { const p = join(root, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (root, path) => readFileSync(join(root, path));

function fixture(t) {
  const folder = resolve(`next-server/.classification-safety-${randomUUID()}`);
  const root = join(folder, "root"), path = join(folder, "state.sqlite");
  mkdirSync(root, { recursive: true });
  put(root, "notes/a.md", "# A\n");
  put(root, "notes/b.md", "# B\n");
  let db = open();
  const scope = { workspaceId: "test", sourceRootId: "b".repeat(64), root };
  const state = { allowed: true, owned: true, recovery: true };
  const host = {
    assertOwnedDisposableFixture() { if (!state.owned) throw Error("owner revoked"); },
    authorize() { return state.allowed; },
    authorizeRoot(_w, _r, candidate) { return candidate === root; },
    approveRecovery() { return state.recovery; },
    previewOriginal: original.previewAssetClassification,
    assertNoOtherPending(database) { if (state.otherPending) throw Error("other pending"); assert.equal(database.isTransaction, true); },
    globalReceipt(database, id) { const row = database.prepare("SELECT fingerprint,result FROM global_receipt WHERE id=?").get(id); return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) } : null; },
    writeGlobalReceipt(database, id, fingerprint, result) { database.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(id, fingerprint, JSON.stringify(result)); },
  };
  function open() {
    const database = new DatabaseSync(path);
    database.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
    database.exec("CREATE TABLE IF NOT EXISTS global_receipt(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)");
    database.exec("CREATE VIEW IF NOT EXISTS receipts AS SELECT id AS operation_id,fingerprint,result FROM global_receipt");
    return database;
  }
  const request = () => {
    const preview = original.previewAssetClassification(root);
    return { contract, action: "apply", operationId: randomUUID(), previewId: preview.id,
      layoutSha256: scan(db, host, root).layoutSha256,
      proposalIds: ["notes/a.md", "notes/b.md"].map(asset => preview.proposals.find(p => p.type === "classification" && p.asset === asset).id) };
  };
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  return { root, scope, host, state, request, get db() { return db; }, restart() { db.close(); db = open(); } };
}
const run = (f, request) => execute(f.db, f.host, f.scope, actor, request);
const resume = (f, request) => recover(f.db, f.host, f.scope, actor, request);
const rollback = (f, apply) => ({ contract, action: "rollback", operationId: randomUUID(), applyOperationId: apply.operationId, layoutSha256: scan(f.db, f.host, f.root).layoutSha256 });

test("strict native contract is explicit and default denies original-shaped requests", t => {
  const f = fixture(t), req = f.request(), { contract: _, ...originalShape } = req;
  assert.throws(() => run(f, originalShape), /Invalid classification request/);
  assert.throws(() => execute(f.db, undefined, f.scope, actor, req), /No trusted/);
  f.state.otherPending = true;
  assert.throws(() => run(f, req), /other pending/);
  assert.equal(pending(f.db), null);
});

test("durable pending intent survives restart; exact authenticated retry only", t => {
  const f = fixture(t), req = f.request();
  f.host.afterEffect = index => { if (!index) throw Error("injected partial"); };
  assert.throws(() => run(f, req), /injected partial/);
  assert.deepEqual(pending(f.db).request, req);
  assert.equal(receipt(f.db, req.operationId), null);
  f.restart(); delete f.host.afterEffect;
  assert.throws(() => run(f, req), /recovery required/);
  assert.throws(() => recover(f.db, f.host, f.scope, { ...actor, id: "other" }, req), /identical/);
  f.state.recovery = false;
  assert.throws(() => resume(f, req), /Recovery authority denied/);
  f.state.recovery = true;
  assert.deepEqual(resume(f, req).applied, req.proposalIds);
  assert.equal(pending(f.db), null);
});

test("stage-file crash residue remains fenced after restart without discard", t => {
  const f = fixture(t), req = f.request(), initial = read(f.root, "notes/a.md");
  f.host.afterStage = () => { throw Error("injected after stage"); };
  assert.throws(() => run(f, req), /after stage/);
  const stage = readdirSync(join(f.root, "notes")).find(name => /^\.pkm-classification-.*\.pending$/.test(name));
  assert(stage); assert.deepEqual(read(f.root, "notes/a.md"), initial); assert(pending(f.db));
  f.restart(); delete f.host.afterStage;
  assert.throws(() => resume(f, req), /Unknown or ambiguous/);
  assert(readdirSync(join(f.root, "notes")).includes(stage));
  assert(pending(f.db)); assert.equal(receipt(f.db, req.operationId), null);
});

test("global receipt collision and reused operation ID never publish", t => {
  const f = fixture(t), req = f.request();
  f.db.prepare("INSERT INTO global_receipt VALUES(?,?,?)").run(req.operationId, "0".repeat(64), "{}");
  assert.throws(() => run(f, req), /receipt mismatch/);
  assert.equal(pending(f.db), null); assert.equal(read(f.root, "notes/a.md").toString(), "# A\n");
  const next = f.request(); run(f, next);
  assert.throws(() => run(f, { ...next, proposalIds: [next.proposalIds[0]] }), /reused/);
});

test("partial rollback remains durable and resumes in original reverse order", t => {
  const f = fixture(t), apply = f.request(); run(f, apply);
  const req = rollback(f, apply);
  f.host.afterEffect = index => { if (!index) throw Error("rollback interrupted"); };
  assert.throws(() => run(f, req), /rollback interrupted/);
  assert.equal(read(f.root, "notes/b.md").toString(), "# B\n");
  assert.notEqual(read(f.root, "notes/a.md").toString(), "# A\n");
  assert.deepEqual(pending(f.db).result.applied, [...apply.proposalIds].reverse());
  f.restart(); delete f.host.afterEffect;
  assert.deepEqual(resume(f, req).applied, [...apply.proposalIds].reverse());
  assert.equal(read(f.root, "notes/a.md").toString(), "# A\n");
  assert.deepEqual(run(f, req), receipt(f.db, req.operationId).result);
});

test("actor revocation after partial publication prevents recovery and commit", t => {
  const f = fixture(t), req = f.request();
  f.host.afterEffect = () => { f.state.allowed = false; };
  assert.throws(() => run(f, req), /authority denied/);
  assert(pending(f.db)); assert.equal(receipt(f.db, req.operationId), null);
  assert.throws(() => resume(f, req), /authority denied/);
  f.state.allowed = true; delete f.host.afterEffect;
  assert.deepEqual(resume(f, req).applied, req.proposalIds);
});

test("CAS rejects stale input and mixed tampered pending layouts", t => {
  const f = fixture(t), stale = f.request();
  put(f.root, "notes/a.md", "edited before admission");
  assert.throws(() => run(f, stale), /layout changed/);
  assert.equal(pending(f.db), null);
  const req = f.request();
  f.host.afterEffect = () => { put(f.root, "notes/b.md", "edited during interruption"); throw Error("injected"); };
  assert.throws(() => run(f, req), /injected/);
  delete f.host.afterEffect;
  assert.throws(() => resume(f, req), /Unknown or ambiguous/);
  assert.equal(read(f.root, "notes/b.md").toString(), "edited during interruption");
  assert(pending(f.db));
});

test("pending payload tamper and receipt write failure remain fenced", t => {
  const f = fixture(t), req = f.request();
  f.host.afterEffect = () => { throw Error("pause"); };
  assert.throws(() => run(f, req), /pause/); delete f.host.afterEffect;
  const saved = f.db.prepare("SELECT payload,payload_sha256 FROM legacy_classification_native_intent").get();
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?").run(`${saved.payload} `);
  assert.throws(() => resume(f, req), /Corrupt/);
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?").run(saved.payload, saved.payload_sha256);
  const write = f.host.writeGlobalReceipt;
  f.host.writeGlobalReceipt = (database, id, fingerprint, result) => { write(database, id, fingerprint, result); throw Error("receipt unavailable"); };
  assert.throws(() => resume(f, req), /receipt unavailable/);
  assert(pending(f.db)); assert.equal(receipt(f.db, req.operationId), null);
  assert.equal(f.host.globalReceipt(f.db, req.operationId), null);
  f.restart(); f.host.writeGlobalReceipt = write;
  assert.deepEqual(resume(f, req).applied, req.proposalIds);
});

test("rehashed malicious pending apply bytes and altered original proposal fail before further effects", t => {
  const f = fixture(t), req = f.request();
  f.host.afterEffect = index => { if (!index) throw Error("pause after first"); };
  assert.throws(() => run(f, req), /pause after first/);
  delete f.host.afterEffect;
  const saved = f.db.prepare("SELECT payload,payload_sha256 FROM legacy_classification_native_intent").get();
  const overwrite = value => {
    const text = JSON.stringify(value);
    f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?")
      .run(text, createHash("sha256").update(text).digest("hex"));
  };
  const alteredBytes = JSON.parse(saved.payload);
  alteredBytes.effects[1].after = Buffer.from("attacker-authored bytes\n").toString("base64");
  overwrite(alteredBytes);
  assert.throws(() => resume(f, req), /differs from original source semantics/);
  assert.throws(() => assertBatch16UnintegratedClear(f.db), /differs from original source semantics/);
  assert.equal(read(f.root, "notes/b.md").toString(), "# B\n");
  const alteredProposal = JSON.parse(saved.payload);
  alteredProposal.proposals[1].classification.domain = "attacker";
  overwrite(alteredProposal);
  assert.throws(() => resume(f, req), /proposal evidence/);
  assert.equal(read(f.root, "notes/b.md").toString(), "# B\n");
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?").run(saved.payload, saved.payload_sha256);
  assert.deepEqual(resume(f, req).applied, req.proposalIds);
});

test("rehashed forged non-Markdown sidecar is rejected against original proposal", t => {
  const f = fixture(t);
  put(f.root, "scripts/run.py", "print(1)\n");
  const preview = original.previewAssetClassification(f.root);
  const note = preview.proposals.find(p => p.type === "classification" && p.asset === "notes/a.md");
  const script = preview.proposals.find(p => p.type === "classification" && p.asset === "scripts/run.py");
  const req = { contract, action: "apply", operationId: randomUUID(), previewId: preview.id,
    layoutSha256: scan(f.db, f.host, f.root).layoutSha256, proposalIds: [note.id, script.id] };
  f.host.afterEffect = index => { if (!index) throw Error("pause"); };
  assert.throws(() => run(f, req), /pause/); delete f.host.afterEffect;
  const saved = f.db.prepare("SELECT payload,payload_sha256 FROM legacy_classification_native_intent").get();
  const altered = JSON.parse(saved.payload);
  altered.effects[1].after = Buffer.from('{"schema":"pkm.asset-classification/v1","asset":"attacker"}\n').toString("base64");
  const text = JSON.stringify(altered);
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?")
    .run(text, createHash("sha256").update(text).digest("hex"));
  assert.throws(() => resume(f, req), /differs from original source semantics/);
  assert.throws(() => read(f.root, script.target), { code: "ENOENT" });
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?").run(saved.payload, saved.payload_sha256);
  assert.deepEqual(resume(f, req).applied, req.proposalIds);
});

test("rehashed disconnected pending rollback is fenced before restoration", t => {
  const f = fixture(t), apply = f.request();
  run(f, apply);
  const req = rollback(f, apply);
  f.host.afterEffect = index => { if (!index) throw Error("partial rollback"); };
  assert.throws(() => run(f, req), /partial rollback/);
  delete f.host.afterEffect;
  const row = f.db.prepare("SELECT payload,payload_sha256 FROM legacy_classification_native_intent").get();
  const forged = JSON.parse(row.payload);
  forged.effects[1].after = Buffer.from("forged rollback\n").toString("base64");
  const text = JSON.stringify(forged);
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?")
    .run(text, createHash("sha256").update(text).digest("hex"));
  assert.throws(() => resume(f, req), /rollback history is disconnected/);
  assert.throws(() => assertBatch16UnintegratedClear(f.db), /rollback history is disconnected/);
  assert.notEqual(read(f.root, "notes/a.md").toString(), "# A\n");
  f.db.prepare("UPDATE legacy_classification_native_intent SET payload=?,payload_sha256=?").run(row.payload, row.payload_sha256);
  assert.deepEqual(resume(f, req).applied, [...apply.proposalIds].reverse());
});

test("rehashed forged committed receipt is rejected despite matching global result", t => {
  const f = fixture(t), req = f.request(); run(f, req);
  const saved = f.db.prepare("SELECT payload,payload_sha256 FROM legacy_classification_native_receipt WHERE operation_id=?").get(req.operationId);
  const forged = JSON.parse(saved.payload);
  forged.effects[0].after = Buffer.from("forged committed bytes").toString("base64");
  const text = JSON.stringify(forged);
  f.db.exec("DROP TRIGGER legacy_classification_native_receipt_no_update");
  f.db.prepare("UPDATE legacy_classification_native_receipt SET payload=?,payload_sha256=? WHERE operation_id=?")
    .run(text, createHash("sha256").update(text).digest("hex"), req.operationId);
  f.db.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
  assert.throws(() => history(f.db, f.host), /differs from original source semantics/);
  assert.throws(() => assertBatch16UnintegratedClear(f.db), /differs from original source semantics/);
  assert.throws(() => run(f, req), /differs from original source semantics/);
  f.db.exec("DROP TRIGGER legacy_classification_native_receipt_no_update");
  f.db.prepare("UPDATE legacy_classification_native_receipt SET payload=?,payload_sha256=? WHERE operation_id=?")
    .run(saved.payload, saved.payload_sha256, req.operationId);
  f.db.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
  assert.equal(history(f.db, f.host).receipts.length, 1);
  assert.throws(() => assertBatch16UnintegratedClear(f.db), error => error.code === "RECOVERY_AUTHORITY_REQUIRED");
});

test("ordered authenticated apply and rollback history matches live full layout after restart", t => {
  const f = fixture(t);
  const check = () => validateLayout(history(f.db, f.host), { workspaceId: f.scope.workspaceId, sourceRootId: f.scope.sourceRootId }, scan(f.db, f.host, f.root));
  assert.deepEqual(check(), { status: "untracked", appliedEffects: null });
  const one = f.request();
  one.proposalIds = [one.proposalIds[0]];
  one.operationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  run(f, one);
  const two = f.request();
  two.proposalIds = [two.proposalIds[1]];
  two.operationId = "00000000-0000-4000-8000-000000000001";
  run(f, two);
  assert.deepEqual(history(f.db, f.host).receipts.map(i => i.request.operationId), [one.operationId, two.operationId]);
  assert.deepEqual(check(), { status: "committed", appliedEffects: null });
  const undo = rollback(f, two); run(f, undo);
  f.restart();
  assert.deepEqual(check(), { status: "committed", appliedEffects: null });
  put(f.root, "notes/b.md", "external edit");
  assert.throws(check, /Current layout differs/);
});

test("pending prefix validator detects unknown, reversed and tampered states", t => {
  const f = fixture(t), req = f.request();
  f.host.afterEffect = index => { if (!index) throw Error("injected partial"); };
  assert.throws(() => run(f, req), /injected partial/); delete f.host.afterEffect;
  const h = history(f.db, f.host), live = scan(f.db, f.host, f.root);
  const scope = { workspaceId: f.scope.workspaceId, sourceRootId: f.scope.sourceRootId };
  assert.deepEqual(validateLayout(h, scope, live), { status: "pending", appliedEffects: 1 });
  const altered = structuredClone(h);
  altered.pending.effects[1].after = Buffer.from("forged").toString("base64");
  assert.throws(() => validateLayout(altered, scope, live), /differs from original source semantics/);
  const wrongPin = { ...live, pin: { ...live.pin, ino: "0" } };
  assert.throws(() => validateLayout(h, scope, wrongPin), /scope, root or operation ID/);
  put(f.root, "notes/b.md", "unknown");
  assert.throws(() => validateLayout(h, scope, scan(f.db, f.host, f.root)), /Unknown or ambiguous/);
});

test("pending prefix validator distinguishes untouched, fully applied and partial rollback", t => {
  const f = fixture(t), scope = { workspaceId: f.scope.workspaceId, sourceRootId: f.scope.sourceRootId };
  const check = () => validateLayout(history(f.db, f.host), scope, scan(f.db, f.host, f.root));
  const req = f.request(), owner = f.host.assertOwnedDisposableFixture;
  f.host.assertOwnedDisposableFixture = () => {
    owner();
    if (pending(f.db)) throw Error("injected before first effect");
  };
  assert.throws(() => run(f, req), /injected before first effect/);
  f.host.assertOwnedDisposableFixture = owner;
  assert.deepEqual(check(), { status: "pending", appliedEffects: 0 });
  const write = f.host.writeGlobalReceipt;
  f.host.writeGlobalReceipt = () => { throw Error("receipt unavailable"); };
  assert.throws(() => resume(f, req), /receipt unavailable/);
  assert.deepEqual(check(), { status: "pending", appliedEffects: 2 });
  f.host.writeGlobalReceipt = write; resume(f, req);
  const undo = rollback(f, req);
  f.host.afterEffect = index => { if (!index) throw Error("rollback interrupted"); };
  assert.throws(() => run(f, undo), /rollback interrupted/);
  delete f.host.afterEffect; f.restart();
  assert.deepEqual(check(), { status: "pending", appliedEffects: 1 });
  resume(f, undo);
  assert.deepEqual(check(), { status: "committed", appliedEffects: null });
});

test("ordered history rejects disconnected successive commits and reversed order", t => {
  const f = fixture(t), first = f.request();
  first.proposalIds = [first.proposalIds[0]]; run(f, first);
  put(f.root, "unrelated.txt", "external edit");
  const second = f.request(); second.proposalIds = [second.proposalIds[1]]; run(f, second);
  const h = history(f.db, f.host), live = scan(f.db, f.host, f.root);
  const scope = { workspaceId: f.scope.workspaceId, sourceRootId: f.scope.sourceRootId };
  assert.throws(() => validateLayout(h, scope, live), /layouts are disconnected/);
  assert.throws(() => validateLayout({ ...h, receipts: [...h.receipts].reverse() }, scope, live), /layouts are disconnected/);
});

test("original writer exact result shape, skips, collision and rollback history", t => {
  const f = fixture(t);
  put(f.root, "notes/c.md", "---\nkind: script\n---\n# C\n");
  put(f.root, "scripts/run.py", "print(1)\n");
  const preview = original.previewAssetClassification(f.root);
  const select = asset => preview.proposals.find(p => p.type === "classification" && p.asset === asset);
  const a = select("notes/a.md"), b = select("notes/b.md"), script = select("scripts/run.py");
  const correction = preview.proposals.find(p => p.type === "correction" && p.asset === "notes/c.md");
  put(f.root, a.asset, "changed after preview");
  mkdirSync(join(f.root, script.target));
  const result = original.applyAssetClassification(f.root, preview, [correction.id, a.id, script.id, b.id, b.id]);
  assert.match(result.journalId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result, { journalId: result.journalId, applied: [b.id], skipped: [
    { id: correction.id, reason: "review-only" }, { id: a.id, reason: "changed-since-preview" }, { id: script.id, reason: "unsafe-or-unavailable" },
  ] });
  const journal = JSON.parse(read(f.root, `.pkm/state/asset-classification/${result.journalId}.json`));
  assert.equal(journal.schema, 1); assert.deepEqual(journal.entries.map(e => e.id), [b.id]);
  put(f.root, b.asset, "edited after apply");
  assert.deepEqual(original.rollbackAssetClassification(f.root, result.journalId), { journalId: result.journalId, applied: [], skipped: [{ id: b.id, reason: "changed-since-apply" }] });
  put(f.root, b.asset, Buffer.from(journal.entries[0].before, "base64"));
  assert.deepEqual(original.rollbackAssetClassification(f.root, result.journalId), { journalId: result.journalId, applied: [], skipped: [{ id: b.id, reason: "already-restored-or-not-written" }] });
  assert.throws(() => original.rollbackAssetClassification(f.root, "not-a-journal-id"), /Invalid classification journal ID/);
  assert.throws(() => original.applyAssetClassification(f.root, preview, []), /Explicit proposal IDs/);
});

test("strict native rejects mixed review-only selection while original returns ordered skip and success", t => {
  const f = fixture(t);
  put(f.root, "notes/c.md", "---\nkind: script\n---\n# C\n");
  const preview = original.previewAssetClassification(f.root);
  const valid = preview.proposals.find(p => p.type === "classification" && p.asset === "notes/a.md");
  const review = preview.proposals.find(p => p.type === "correction" && p.asset === "notes/c.md");
  const req = { contract, action: "apply", operationId: randomUUID(), previewId: preview.id,
    layoutSha256: scan(f.db, f.host, f.root).layoutSha256, proposalIds: [valid.id, review.id] };
  assert.throws(() => run(f, req), /Only original classification proposals/);
  assert.equal(pending(f.db), null); assert.equal(read(f.root, "notes/a.md").toString(), "# A\n");
  const result = original.applyAssetClassification(f.root, preview, req.proposalIds);
  assert.deepEqual(result, { journalId: result.journalId, applied: [valid.id], skipped: [{ id: review.id, reason: "review-only" }] });
});

test("original writer reports privacy changed after preview without applying the private item", t => {
  const f = fixture(t), preview = original.previewAssetClassification(f.root);
  const a = preview.proposals.find(p => p.type === "classification" && p.asset === "notes/a.md");
  const b = preview.proposals.find(p => p.type === "classification" && p.asset === "notes/b.md");
  privacy.setPrivacyStoreRoot(f.root);
  privacy.setTopLevelPrivacy("notes", "a.md", true);
  const result = original.applyAssetClassification(f.root, preview, [a.id, b.id]);
  assert.deepEqual(result, { journalId: result.journalId, applied: [b.id], skipped: [{ id: a.id, reason: "privacy-changed-since-preview" }] });
  assert.equal(read(f.root, "notes/a.md").toString(), "# A\n");
});
