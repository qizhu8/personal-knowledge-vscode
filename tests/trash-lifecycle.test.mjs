import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync,
  truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  deserializeTrashLifecyclePlan, executeTrashLifecycle, planTrashLifecycle, planTrashRestore,
  previewTrashLifecycle, serializeTrashLifecyclePlan, trashLifecycleDefinitions, trashLifecycleLayout,
  trashLifecycleLimits,
} from "../dist/trash-lifecycle.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";
import { checkCaptureRecords, packageRoot } from "../scripts/migration.mjs";
import { trashLifecycleOriginalRules } from "../dist/domain/trash-lifecycle-original.js";
import { trashLifecycleTransportFixture } from "./trash-lifecycle-fixture.mjs";

const tests = dirname(fileURLToPath(import.meta.url));
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
function fixture(t, kind = "document", area = "notes", container = "Team") {
  const root = join(tests, `.trash-lifecycle-${randomUUID()}`);
  mkdirSync(join(root, area, ".trash"), { recursive: true });
  if (area !== "notes") mkdirSync(join(root, "notes"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = kind === "document" ? `${container}/One.md` : container;
  const one = "---\r\n# Preserve comment\r\ndocumentId: trash-one\r\nknowledgeId: knowledge_000000000000000000000001\r\nrevision: 7\r\ncustom: [keep, exact]\r\naliases: [note:old-name]\r\n---\r\n![paired](One.assets/bytes.bin?q=1#view)\r\n";
  const two = "---\ndocumentId: trash-two\nrevision: 3\n---\n![nested](One.assets/bytes.bin)\n";
  const bytes = Buffer.from([255, 0, 128, 13, 10, 9, 0]);
  function put(relative, content, targetArea = area) {
    const full = join(root, targetArea, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  put(`${container}/One.md`, one); put(`${container}/One.assets/bytes.bin`, bytes);
  mkdirSync(join(root, area, container, "One.assets/empty"));
  if (kind === "folder") { put(`${container}/Two.md`, two); put(`${container}/One.assets/empty/.gitkeep`, ""); }
  put("Outside.md", "---\ndocumentId: outside\nrevision: 1\n---\nOutside.\n", "notes");
  const args = { area, path, kind };
  function preview() { return previewTrashLifecycle(root, args); }
  function plan(overrides = {}) {
    const p = preview();
    return planTrashLifecycle(root, "test:owner", { ...args, operationId: randomUUID(),
      expectedTreeSha256: p.treeSha256, expectedScanRevision: p.scanRevision, ...overrides });
  }
  let locked = false, failCommit = false, failPersist = false;
  const receipts = [], syncChanges = [];
  const journal = join(root, "host-intent.json");
  const host = {
    withWriterLock(fn) { assert.equal(locked, false); locked = true; try { return fn(); } finally { locked = false; } },
    persistIntent(_id, json) {
      assert.equal(locked, true);
      if (failPersist) throw new Error("persist failed");
      writeFileSync(journal, json, { flag: "wx" });
      const fd = openSync(journal, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    },
    readIntent(id) {
      try { const json = readFileSync(journal, "utf8"); return JSON.parse(json).operationId === id ? json : undefined; }
      catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
    },
    commitAtomic(p, result, changes) {
      assert.equal(locked, true);
      assert.equal(host.readIntent(p.operationId), serializeTrashLifecyclePlan(p));
      if (failCommit) throw new Error("commit interrupted");
      // The host supplies this transaction; this disposable fixture asserts its exact bundle.
      receipts.push(result); syncChanges.push(changes); unlinkSync(journal);
    },
  };
  function restore(original) {
    const pins = scanMarkdown(root).map(d => ({ id: d.record.id, area: d.record.area, path: d.record.path,
      revision: d.record.revision, sha256: d.record.sha256 }));
    return planTrashRestore(root, "test:owner", original, {
      operationId: randomUUID(), entryId: original.entryId, expectedScanRevision: sha256(JSON.stringify(pins)),
    });
  }
  return { root, area, path, one, two, bytes, put, preview, plan, host, restore, receipts, syncChanges, journal,
    failCommit(value) { failCommit = value; }, failPersist(value) { failPersist = value; } };
}

for (const [kind, area] of [["document", "notes"], ["folder", "notes"], ["document", "skills"], ["folder", "papers"]]) {
  test(`actual ${area} ${kind} recoverable trash/restore preserves bytes, identity, revision and sync paths`, t => {
    const f = fixture(t, kind, area), p = f.plan();
    assert.deepEqual(deserializeTrashLifecyclePlan(serializeTrashLifecyclePlan(p)), p);
    const result = executeTrashLifecycle(f.root, p, f.host);
    assert.equal(result.action, "trash");
    assert.equal(scanMarkdown(f.root).some(d => d.record.id === "trash-one"), false);
    const bucket = join(f.root, area, ".trash", p.entryId);
    const content = readFileSync(join(bucket, "payload", ...(kind === "folder" ? ["One.md"] : [])), "utf8");
    assert.equal(content, f.one);
    assert.deepEqual(readFileSync(join(bucket, kind === "folder" ? "payload/One.assets" : "assets", "bytes.bin")), f.bytes);
    const metadata = JSON.parse(readFileSync(join(bucket, "metadata.json"), "utf8"));
    assert.equal(metadata.originalPath, f.path);
    assert.equal(metadata.name, kind === "folder" ? "Team" : area === "skills" ? "One" : "One.md");
    assert.equal(metadata.assetsPath, kind === "document" ? "Team/One.assets" : undefined);
    const paths = f.syncChanges[0].removed.map(p => p.path);
    assert(paths.includes(`${area}/Team/One.md`));
    assert(paths.includes(`${area}/Team/One.assets/bytes.bin`));
    assert(!paths.some(path => path.endsWith("/.gitkeep")));
    assert(f.syncChanges[0].removed.every(entry => entry.deletedAt === p.deletedAt));
    const restore = f.restore(p);
    executeTrashLifecycle(f.root, restore, f.host);
    assert.equal(readFileSync(join(f.root, area, "Team/One.md"), "utf8"), f.one);
    assert.deepEqual(readFileSync(join(f.root, area, "Team/One.assets/bytes.bin")), f.bytes);
    const doc = scanMarkdown(f.root).find(d => d.record.id === "trash-one");
    assert.equal(doc.record.revision, 7);
    assert.equal(doc.metadata.get("knowledgeId"), "knowledge_000000000000000000000001");
    assert.deepEqual(f.syncChanges[1].restored.sort(), paths.sort());
    assert.equal(f.receipts.length, 2);
    assert.throws(() => readFileSync(join(bucket, "metadata.json")), { code: "ENOENT" });
  });
}
test("original numeric-hex Trash identity is journal-owned, recoverable and byte-preserving on restore", t => {
  const f = fixture(t), p = f.plan({ entryIdFormat: "original" });
  assert.match(p.entryId, /^[0-9]+-[a-f0-9]{10}$/);
  assert.notEqual(p.entryId, p.operationId);
  assert.equal(p.entryId.split("-")[0], String(Date.parse(p.deletedAt)));
  f.failCommit(true);
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), /commit interrupted/);
  const persisted = deserializeTrashLifecyclePlan(readFileSync(f.journal, "utf8"));
  assert.equal(persisted.entryId, p.entryId);
  f.failCommit(false);
  executeTrashLifecycle(f.root, persisted, f.host, true);
  assert.equal(f.receipts[0].entryId, p.entryId);
  const metadata = JSON.parse(readFileSync(join(f.root, "notes/.trash", p.entryId, "metadata.json"), "utf8"));
  assert.equal(metadata.id, p.entryId);
  executeTrashLifecycle(f.root, f.restore(p), f.host);
  assert.equal(readFileSync(join(f.root, "notes/Team/One.md"), "utf8"), f.one);
  assert.deepEqual(readFileSync(join(f.root, "notes/Team/One.assets/bytes.bin")), f.bytes);
  assert.throws(() => serializeTrashLifecyclePlan({ ...p, entryId: "1-0123456789" }), /timestamp/);
  assert.throws(() => f.plan({ entryIdFormat: "unknown" }), /Invalid trash operation/);
});
test("intent is persisted under host lock before any effects; commit interruption recovers exact after phase", t => {
  const f = fixture(t), p = f.plan();
  f.failPersist(true);
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), /persist failed/);
  assert.equal(readFileSync(join(f.root, "notes/Team/One.md"), "utf8"), f.one);
  f.failPersist(false); f.failCommit(true);
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), /commit interrupted/);
  assert.equal(f.host.readIntent(p.operationId), serializeTrashLifecyclePlan(p));
  f.failCommit(false);
  executeTrashLifecycle(f.root, deserializeTrashLifecyclePlan(readFileSync(f.journal, "utf8")), f.host, true);
  assert.equal(f.receipts.length, 1);
});
test("paired partial interruption accepts only assets-first prefix and recovers both trash and restore", t => {
  const f = fixture(t), p = f.plan();
  f.host.withWriterLock(() => f.host.persistIntent(p.operationId, serializeTrashLifecyclePlan(p)));
  const bucket = join(f.root, "notes/.trash", p.entryId);
  mkdirSync(bucket);
  writeFileSync(join(bucket, "metadata.json"), JSON.stringify({
    id: p.entryId, kind: "item", name: "One.md", originalPath: p.path, deletedAt: p.deletedAt, assetsPath: "Team/One.assets",
  }, null, 2) + "\n");
  renameSync(join(f.root, "notes/Team/One.assets"), join(bucket, "assets"));
  executeTrashLifecycle(f.root, p, f.host, true);
  const restore = f.restore(p);
  f.host.withWriterLock(() => f.host.persistIntent(restore.operationId, serializeTrashLifecyclePlan(restore)));
  renameSync(join(bucket, "assets"), join(f.root, "notes/Team/One.assets"));
  executeTrashLifecycle(f.root, restore, f.host, true);
  assert.equal(readFileSync(join(f.root, "notes/Team/One.md"), "utf8"), f.one);
});
test("restore after-effects and cleanup interruption can be recovered without rollback", t => {
  const f = fixture(t), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  const restore = f.restore(p);
  f.failCommit(true);
  assert.throws(() => executeTrashLifecycle(f.root, restore, f.host), /commit interrupted/);
  f.failCommit(false);
  executeTrashLifecycle(f.root, restore, f.host, true);
  assert.equal(f.receipts.length, 2);
});
test("outside encoded resource references fail closed for document and folder", t => {
  for (const kind of ["document", "folder"]) {
    const f = fixture(t, kind);
    f.put("Outside.md", "---\ndocumentId: outside\n---\n![shared](Team/One.assets/%62ytes.bin?view=1#x)\n", "notes");
    assert.throws(() => f.plan(), code("CONFLICT"));
  }
});
test("source CAS, outside reference CAS and inode replacement pins reject before effects", t => {
  const f = fixture(t), p = f.plan();
  assert.throws(() => f.plan({ expectedTreeSha256: "0".repeat(64) }), code("CONFLICT"));
  f.put("Outside.md", "---\ndocumentId: outside\nrevision: 2\n---\nChanged.\n", "notes");
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), code("RECOVERY_CONFLICT"));
  const newer = f.plan();
  renameSync(join(f.root, "notes/Team/One.assets/bytes.bin"), join(f.root, "held-byte-file"));
  f.put("Team/One.assets/bytes.bin", f.bytes);
  assert.throws(() => executeTrashLifecycle(f.root, newer, f.host), code("RECOVERY_CONFLICT"));
  assert.deepEqual(readFileSync(join(f.root, "held-byte-file")), f.bytes);
});
test("restore target collision preserves both colliding bytes and trash history", t => {
  const f = fixture(t), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  f.put("Team/One.md", "---\ndocumentId: collision\n---\nDo not overwrite.\n");
  assert.throws(() => f.restore(p), code("CONFLICT"));
  assert.match(readFileSync(join(f.root, "notes/Team/One.md"), "utf8"), /Do not overwrite/);
  assert.equal(readFileSync(join(f.root, "notes/.trash", p.entryId, "payload"), "utf8"), f.one);
});
test("unknown recovery tree, missing journal, tampered metadata and out-of-order prefix never roll back", t => {
  const f = fixture(t), p = f.plan();
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host, true), code("RECOVERY_CONFLICT"));
  f.failCommit(true);
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), /commit interrupted/);
  const bucket = join(f.root, "notes/.trash", p.entryId);
  writeFileSync(join(bucket, "assets/unknown.bin"), "Unknown");
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host, true), code("RECOVERY_CONFLICT"));
  assert.equal(readFileSync(join(bucket, "assets/unknown.bin"), "utf8"), "Unknown");
  unlinkSync(join(bucket, "assets/unknown.bin"));
  writeFileSync(join(bucket, "metadata.json"), "{}\n");
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host, true), code("RECOVERY_CONFLICT"));
  assert.equal(readFileSync(join(bucket, "payload"), "utf8"), f.one);
});
test("new paired assets cannot be smuggled into a no-assets intent", t => {
  const f = fixture(t);
  rmSync(join(f.root, "notes/Team/One.assets"), { recursive: true });
  const p = f.plan();
  f.put("Team/One.assets/new.bin", "Unknown");
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), code("RECOVERY_CONFLICT"));
});
test("Board/memory/System descriptors, symlinks and legacy assets are refused", t => {
  for (const extra of ["documentKind: todo-board", "memory: {}"]) {
    const f = fixture(t);
    f.put("Team/One.md", `---\ntitle: Keep\ndocumentId: trash-one\n${extra}\n---\nContent.\n`);
    assert.throws(() => f.plan(), error => ["ACCESS_DENIED", "UNSUPPORTED_OPERATION"].includes(error.code));
  }
  const f = fixture(t);
  symlinkSync(join(f.root, "notes/Outside.md"), join(f.root, "notes/Team/One.assets/link"));
  assert.throws(() => f.plan(), code("INVALID_DOCUMENT"));
  unlinkSync(join(f.root, "notes/Team/One.assets/link"));
  mkdirSync(join(f.root, "notes/_assets"));
  assert.throws(() => f.plan(), code("UNSUPPORTED_OPERATION"));
  assert.throws(() => previewTrashLifecycle(f.root, { area: "notes", path: "System", kind: "folder" }), code("INVALID_ARGUMENT"));
});
for (const area of ["notes", "skills", "papers"]) test(`path-derived ${area} identity and exact original bytes survive Trash and original-path restore`, t => {
  const f = fixture(t, "document", area), raw = "---\n# Original comment\ntitle: Keep\nhistory: [{event: original}]\n---\nContent.\n";
  f.put("Team/One.md", raw);
  const before = scanMarkdown(f.root).find(document => document.record.area === area && document.record.path === "Team/One.md");
  assert.equal(before.metadata.get("documentId"), undefined);
  const plan = f.plan({ entryIdFormat: "original" });
  assert.equal(plan.documentPins[0].id, before.record.id);
  executeTrashLifecycle(f.root, plan, f.host);
  const restored = f.restore(plan);
  executeTrashLifecycle(f.root, restored, f.host);
  assert.equal(readFileSync(join(f.root, area, "Team/One.md"), "utf8"), raw);
  const after = scanMarkdown(f.root).find(document => document.record.area === area && document.record.path === "Team/One.md");
  assert.equal(after.record.id, before.record.id);
  assert.equal(after.metadata.get("documentId"), undefined);
  assert.equal(after.record.revision, before.record.revision);
});
test("portable paths and depth are enforced while large trash payloads remain accepted", t => {
  const f = fixture(t);
  for (const path of ["../notes", "", "/", ".trash", "Team/CON.md", "Team\\One.md", "Team/One.assets"]) {
    assert.throws(() => previewTrashLifecycle(f.root, { area: "notes", path, kind: "folder" }), code("INVALID_ARGUMENT"));
  }
  f.put("Team/One.assets/huge.bin", "");
  truncateSync(join(f.root, "notes/Team/One.assets/huge.bin"), 16 * 1024 * 1024 + 1);
  assert(f.plan());
  unlinkSync(join(f.root, "notes/Team/One.assets/huge.bin"));
  truncateSync(join(f.root, "notes/Team/One.md"), 1_048_577);
  assert(f.plan());
  mkdirSync(join(f.root, "notes/Team/One.assets", ...Array(34).fill("deep")), { recursive: true });
  assert.throws(() => f.plan(), code("INVALID_WORKSPACE"));
});
test("strict journal rejects unknown fields, forged move routes, omitted Markdown pins and root paths", t => {
  const f = fixture(t), p = f.plan();
  for (const change of [
    x => { x.unknown = true; },
    x => { x.path = "../notes"; },
    x => { x.moves[1].originalPath = "Other.md"; },
    x => { x.documentPins = []; },
    x => { x.moves[0].entries[1].path = "../escape"; },
  ]) {
    const copy = structuredClone(p); change(copy);
    assert.throws(() => deserializeTrashLifecyclePlan(JSON.stringify(copy)), code("INVALID_WORKSPACE"));
  }
  assert.throws(() => deserializeTrashLifecyclePlan("{"), code("INVALID_WORKSPACE"));
});
test("payload-first interruption and destination symlink collision never move or overwrite assets", t => {
  const f = fixture(t), p = f.plan();
  f.host.withWriterLock(() => f.host.persistIntent(p.operationId, serializeTrashLifecyclePlan(p)));
  const bucket = join(f.root, "notes/.trash", p.entryId);
  mkdirSync(bucket);
  renameSync(join(f.root, "notes/Team/One.md"), join(bucket, "payload"));
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host, true), code("RECOVERY_CONFLICT"));
  assert.deepEqual(readFileSync(join(f.root, "notes/Team/One.assets/bytes.bin")), f.bytes);
  assert.equal(readFileSync(join(bucket, "payload"), "utf8"), f.one);
});
test("restore collisions appearing after planning preserve committed trash and external destination", t => {
  const f = fixture(t), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  const restore = f.restore(p);
  symlinkSync(join(f.root, "notes/Outside.md"), join(f.root, "notes/Team/One.md"));
  assert.throws(() => executeTrashLifecycle(f.root, restore, f.host), code("INVALID_DOCUMENT"));
  assert.equal(readFileSync(join(f.root, "notes/.trash", p.entryId, "payload"), "utf8"), f.one);
  assert.match(readFileSync(join(f.root, "notes/Outside.md"), "utf8"), /Outside/);
});
test("after-phase same-byte inode replacement and unknown bucket files retain pending intent", t => {
  const f = fixture(t), p = f.plan();
  f.failCommit(true);
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host), /commit interrupted/);
  const bucket = join(f.root, "notes/.trash", p.entryId);
  writeFileSync(join(bucket, "unexpected"), "Never delete");
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host, true), code("RECOVERY_CONFLICT"));
  assert.equal(readFileSync(join(bucket, "unexpected"), "utf8"), "Never delete");
  unlinkSync(join(bucket, "unexpected"));
  renameSync(join(bucket, "payload"), join(f.root, "held-payload"));
  writeFileSync(join(bucket, "payload"), f.one);
  assert.throws(() => executeTrashLifecycle(f.root, p, f.host, true), code("RECOVERY_CONFLICT"));
  assert.equal(readFileSync(join(f.root, "held-payload"), "utf8"), f.one);
  assert.equal(f.host.readIntent(p.operationId), serializeTrashLifecyclePlan(p));
});
test("restore rejects active same identity and same knowledge identity under a different alias", t => {
  for (const identity of ["documentId: trash-one", "documentId: other\nknowledgeId: knowledge_000000000000000000000001"]) {
    const f = fixture(t), p = f.plan();
    executeTrashLifecycle(f.root, p, f.host);
    f.put("Conflicting.md", `---\n${identity}\n---\nNew document.\n`);
    assert.throws(() => f.restore(p), error => ["CONFLICT", "RECOVERY_CONFLICT"].includes(error.code));
    assert.equal(readFileSync(join(f.root, "notes/.trash", p.entryId, "payload"), "utf8"), f.one);
  }
});
test("unqualified trash roots remain rejected without provisioning storage", t => {
  const f = fixture(t), p = f.plan();
  rmSync(join(f.root, "notes/.trash"), { recursive: true });
  assert.throws(() => f.plan(), code("INVALID_WORKSPACE"));
  mkdirSync(join(f.root, "notes/.trash"));
  executeTrashLifecycle(f.root, p, f.host);
});
test("restore recreates missing parents only after the exact durable intent", t => {
  const f = fixture(t), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  rmSync(join(f.root, "notes/Team"), { recursive: true });
  const restore = f.restore(p);
  assert.throws(() => readFileSync(join(f.root, "notes/Team/One.md")), { code: "ENOENT" });
  f.failPersist(true);
  assert.throws(() => executeTrashLifecycle(f.root, restore, f.host), /persist failed/);
  assert.throws(() => readFileSync(join(f.root, "notes/Team")), { code: "ENOENT" });
  f.failPersist(false);
  executeTrashLifecycle(f.root, restore, f.host);
  assert.equal(readFileSync(join(f.root, "notes/Team/One.md"), "utf8"), f.one);
  assert.deepEqual(readFileSync(join(f.root, "notes/Team/One.assets/bytes.bin")), f.bytes);
  assert.equal(f.receipts.length, 2);
});
for (const area of ["notes", "skills", "papers"]) {
  for (const kind of ["document", "folder"]) {
    test(`${area}/${kind} restores nested missing parents and recovers after SQL interruption`, t => {
      const f = fixture(t, kind, area, "Missing/Deep/Team"), p = f.plan();
      executeTrashLifecycle(f.root, p, f.host);
      rmSync(join(f.root, area, "Missing"), { recursive: true });
      const restore = f.restore(p);
      assert.equal(fs.existsSync(join(f.root, area, "Missing")), false);
      f.failCommit(true);
      assert.throws(() => executeTrashLifecycle(f.root, restore, f.host), /commit interrupted/);
      assert.equal(readFileSync(join(f.root, area, "Missing/Deep/Team/One.md"), "utf8"), f.one);
      assert.equal(f.host.readIntent(restore.operationId), serializeTrashLifecyclePlan(restore));
      f.failCommit(false);
      executeTrashLifecycle(f.root, restore, f.host, true);
      assert.deepEqual(readFileSync(join(f.root, area, "Missing/Deep/Team/One.assets/bytes.bin")), f.bytes);
      assert.equal(f.receipts.length, 2);
      assert.equal(f.host.readIntent(restore.operationId), undefined);
    });
  }
}
test("parent creation interruption retains intent and resumes from an existing empty prefix", t => {
  const f = fixture(t, "document", "notes", "Missing/Deep/Team"), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  rmSync(join(f.root, "notes/Missing"), { recursive: true });
  const restore = f.restore(p), mkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = function(path, ...args) {
      if (path === join(f.root, "notes/Missing/Deep")) throw Object.assign(new Error("synthetic mkdir denial"), { code: "EACCES" });
      return mkdir(path, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => executeTrashLifecycle(f.root, restore, f.host), { code: "EACCES" });
  } finally { fs.mkdirSync = mkdir; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(join(f.root, "notes/Missing")), true);
  assert.equal(fs.existsSync(join(f.root, "notes/Missing/Deep")), false);
  assert.equal(f.host.readIntent(restore.operationId), serializeTrashLifecyclePlan(restore));
  assert.equal(readFileSync(join(f.root, "notes/.trash", p.entryId, "payload"), "utf8"), f.one);
  executeTrashLifecycle(f.root, restore, f.host, true);
  assert.equal(readFileSync(join(f.root, "notes/Missing/Deep/Team/One.md"), "utf8"), f.one);
});
test("recovery resumes assets-first restore after creating missing parents", t => {
  const f = fixture(t, "document", "notes", "Missing/Deep/Team"), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  rmSync(join(f.root, "notes/Missing"), { recursive: true });
  const restore = f.restore(p);
  f.host.withWriterLock(() => f.host.persistIntent(restore.operationId, serializeTrashLifecyclePlan(restore)));
  mkdirSync(join(f.root, "notes/Missing/Deep/Team"), { recursive: true });
  renameSync(join(f.root, "notes/.trash", p.entryId, "assets"), join(f.root, "notes/Missing/Deep/Team/One.assets"));
  executeTrashLifecycle(f.root, restore, f.host, true);
  assert.equal(readFileSync(join(f.root, "notes/Missing/Deep/Team/One.md"), "utf8"), f.one);
  assert.deepEqual(readFileSync(join(f.root, "notes/Missing/Deep/Team/One.assets/bytes.bin")), f.bytes);
});
for (const collision of ["file", "symlink"]) {
  test(`restore refuses a ${collision} parent before planning or after intent without writing through it`, t => {
    const f = fixture(t, "document", "notes", "Missing/Deep/Team"), p = f.plan();
    executeTrashLifecycle(f.root, p, f.host);
    rmSync(join(f.root, "notes/Missing"), { recursive: true });
    const outside = join(f.root, "outside-directory");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "never modify");
    const install = () => collision === "file" ? writeFileSync(join(f.root, "notes/Missing"), "external parent")
      : symlinkSync(outside, join(f.root, "notes/Missing"));
    install();
    assert.throws(() => f.restore(p), code("INVALID_DOCUMENT"));
    unlinkSync(join(f.root, "notes/Missing"));
    const restore = f.restore(p);
    f.host.withWriterLock(() => f.host.persistIntent(restore.operationId, serializeTrashLifecyclePlan(restore)));
    install();
    assert.throws(() => executeTrashLifecycle(f.root, restore, f.host, true), code("INVALID_DOCUMENT"));
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "never modify");
    assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
    assert.equal(readFileSync(join(f.root, "notes/.trash", p.entryId, "payload"), "utf8"), f.one);
    assert.equal(f.host.readIntent(restore.operationId), serializeTrashLifecyclePlan(restore));
  });
}
test("restore does not recreate an absent allowlisted area root", t => {
  const f = fixture(t, "document", "skills"), p = f.plan();
  executeTrashLifecycle(f.root, p, f.host);
  rmSync(join(f.root, "skills/Team"), { recursive: true });
  const restore = f.restore(p);
  f.host.withWriterLock(() => f.host.persistIntent(restore.operationId, serializeTrashLifecyclePlan(restore)));
  renameSync(join(f.root, "skills"), join(f.root, "retained-skills"));
  assert.throws(() => executeTrashLifecycle(f.root, restore, f.host, true), code("INVALID_WORKSPACE"));
  assert.equal(fs.existsSync(join(f.root, "skills")), false);
  assert.equal(readFileSync(join(f.root, "retained-skills/.trash", p.entryId, "payload"), "utf8"), f.one);
});
test("transport fixture freezes dedicated IDs and schemas without duplicate generic operations", () => {
  const fixture = trashLifecycleTransportFixture;
  assert(Object.isFrozen(fixture)); assert(Object.isFrozen(fixture.ids));
  assert.deepEqual(trashLifecycleDefinitions.map(d => d.id), fixture.ids);
  assert.deepEqual(trashLifecycleDefinitions.map(d => d.readOnly), fixture.readOnly);
  assert.deepEqual(Object.keys(trashLifecycleDefinitions[1].input.shape), fixture.moveKeys);
  assert.deepEqual(Object.keys(trashLifecycleDefinitions[2].input.shape), fixture.restoreKeys);
  assert.deepEqual(Object.keys(trashLifecycleDefinitions[1].output.shape), fixture.resultKeys);
  assert(!trashLifecycleDefinitions.some(d => fixture.forbidden.includes(d.id)));
  assert(Object.isFrozen(trashLifecycleLayout));
  assert.deepEqual(trashLifecycleLayout.directories, ["notes/.trash", "skills/.trash", "papers/.trash"]);
});
test("public preview and operation result satisfy frozen strict transport schemas", t => {
  const f = fixture(t);
  assert(trashLifecycleDefinitions[0].output.safeParse(f.preview()).success);
  const result = executeTrashLifecycle(f.root, f.plan(), f.host);
  assert(trashLifecycleDefinitions[1].output.safeParse(result).success);
  assert.equal(trashLifecycleDefinitions[1].output.safeParse({ ...result, unknown: true }).success, false);
});
test("captured original rules have verified roots/hashes and repeated captures are deterministic", async () => {
  const provenancePath = join(packageRoot, "migration/trash-lifecycle-provenance.json");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
  assert.match(trashLifecycleOriginalRules["src/knowledge/filestore.ts"].moveMarkdownPair, /assetsSource/);
  assert.match(trashLifecycleOriginalRules["src/knowledge/knowledge-deletion-journal.ts"].withKnowledgeDeletionJournal, /write\(root, change\(before\)\)/);
  const before = sha256(readFileSync(provenancePath));
  const capture = join(packageRoot, "src/domain/trash-lifecycle-original.ts");
  const originalHash = sha256(readFileSync(capture));
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ["scripts/capture-trash-lifecycle.mjs"], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(sha256(readFileSync(provenancePath)), before);
    assert.equal(sha256(readFileSync(capture)), originalHash);
  }
});
