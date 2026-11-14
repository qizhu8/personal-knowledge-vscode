import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { initialize, Storage } from "../dist/storage.js";
import { nativeActor, openNativeRuntime } from "./native-runtime-fixtures.mjs";

const tests = dirname(fileURLToPath(import.meta.url));
const invoke = (core, operation, args, actor = nativeActor) => core.dispatch(
  operation.includes("preview") || operation === "knowledge.document.get" ? "capability_read" : "capability_call",
  { operation, version: 1, arguments: args }, actor);
const bytes = Buffer.from([0, 255, 13, 10, 128, 0, 1]);
const hash = "0".repeat(64);

async function fixture(t, area = "notes", path = "Parent/Group") {
  const root = join(tests, `.knowledge-promote-${randomUUID()}`);
  await initialize(root);
  const prefix = path.includes("/") ? "../../" : "../";
  const alpha = `---\r\n# exact comment\r\ndocumentId: promote-alpha\r\nrevision: 7\r\ntitle: "Alpha"\r\ncustom: [preserve, exact]\r\nlinks:\r\n  - target: pkm://knowledge/knowledge_000000000000000000000001\r\n    relation: references\r\n---\r\n![own](Alpha.assets/a.bin)\r\n![other](${prefix}Outside.assets/shared.bin?q=1#view)\r\n![sibling](Nested/Beta.assets/b.bin)\r\n[ordinary link](Nested/Beta.md)\r\n`;
  const beta = `---\ndocumentId: promote-beta\nrevision: 3\ntitle: Beta\n---\n![own](Beta.assets/b.bin)\n![outside](../${prefix}Outside.assets/shared.bin)\n`;
  async function put(relative, value) {
    await mkdir(dirname(join(root, area, relative)), { recursive: true });
    await writeFile(join(root, area, relative), value);
  }
  await put(`${path}/Alpha.md`, alpha);
  await put(`${path}/Alpha.assets/a.bin`, bytes);
  await put(`${path}/Nested/Beta.md`, beta);
  await put(`${path}/Nested/Beta.assets/b.bin`, bytes);
  await mkdir(join(root, area, path, "Nested/Beta.assets/empty"), { recursive: true });
  await mkdir(join(root, area, path, "Nested/empty-child"), { recursive: true });
  await put(`${path}/.gitkeep`, "original marker");
  await put("Outside.md", "---\ndocumentId: promote-outside\nrevision: 2\ntitle: Outside\n---\nOutside.\n");
  await put("Outside.assets/shared.bin", bytes);
  const sidecar = Buffer.from(`{"pinnedFolders":["${path}","${path}/Nested","Else"]}\r\n`);
  if (area === "notes") await writeFile(join(root, "notes/.pk-meta.json"), sidecar);
  let storage, runtime;
  async function open() {
    storage = await Storage.open(root, { deferRecovery: true });
    runtime = await openNativeRuntime(storage);
    return runtime.core;
  }
  async function close() {
    if (runtime) { await runtime.runtime.close(); runtime = undefined; }
    if (storage) { await storage.close(); storage = undefined; }
  }
  t.after(async () => { await close(); await rm(root, { force: true, recursive: true }); });
  function db(work) {
    const database = new DatabaseSync(join(root, "core.sqlite"));
    try { return work(database); } finally { database.close(); }
  }
  const core = await open();
  const previewArgs = { area, path, mode: "parent" };
  const preview = await invoke(core, "knowledge.folder.lifecycle.promote-preview", previewArgs);
  assert(preview.result, JSON.stringify(preview));
  const args = { operationId: randomUUID(), ...previewArgs, expectedSourceSha256: preview.result.sourceSha256,
    expectedScanRevision: preview.result.scanRevision, expectedDestinationSha256: null };
  return { root, area, path, alpha, beta, sidecar, core, args, put, open, close, db };
}

async function assertPromoted(f, core, result) {
  const parent = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  const promoted = relative => join(f.root, f.area, parent, relative);
  await assert.rejects(readdir(join(f.root, f.area, f.path)), { code: "ENOENT" });
  const alpha = await readFile(promoted("Alpha.md"), "utf8");
  const beta = await readFile(promoted("Nested/Beta.md"), "utf8");
  const oldPrefix = f.path.includes("/") ? "../../Outside.assets" : "../Outside.assets";
  const newPrefix = parent ? "../Outside.assets" : "Outside.assets";
  assert.equal(alpha, f.alpha.replace(oldPrefix, newPrefix));
  assert.equal(beta, f.beta.replace(`../${oldPrefix}`, `../${newPrefix}`));
  assert.deepEqual(await readFile(promoted("Alpha.assets/a.bin")), bytes);
  assert.deepEqual(await readFile(promoted("Nested/Beta.assets/b.bin")), bytes);
  assert.deepEqual(await readFile(join(f.root, f.area, "Outside.assets/shared.bin")), bytes);
  assert.deepEqual(await readdir(promoted("Nested/Beta.assets/empty")), []);
  assert.deepEqual(await readdir(promoted("Nested/empty-child")), []);
  if (f.area === "notes") {
    const pins = JSON.parse(await readFile(join(f.root, "notes/.pk-meta.json"), "utf8"));
    // Original repathFolderPins retains a leading slash for root-promoted descendant pins.
    assert.deepEqual(pins.pinnedFolders, [parent, `${parent}/Nested`, "Else"].filter(Boolean));
  }
  for (const [id, path, revision] of [["promote-alpha", "Alpha.md", 7], ["promote-beta", "Nested/Beta.md", 3]]) {
    const document = await invoke(core, "knowledge.document.get", { id });
    assert.equal(document.result.path, [parent, path].filter(Boolean).join("/"));
    assert.equal(document.result.revision, revision);
  }
  assert.equal(result.action, "promote-delete");
  assert.equal(result.moved, 2);
  f.db(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(f.args.operationId).n, 1);
  });
  assert.deepEqual((await invoke(core, "knowledge.folder.promote-delete", f.args)).result, result);
  const wrongActor = await invoke(core, "knowledge.folder.promote-delete", f.args, { id: "different:actor", canWrite: true });
  assert.equal(wrongActor.error.code, "CONFLICT");
}

for (const [area, path] of [["notes", "Parent/Group"], ["notes", "Group"], ["skills", "Parent/Group"], ["papers", "Parent/Group"]]) {
  test(`native ${area} parent promote-delete preserves multiple children, metadata, assets and pins (${path})`, async t => {
    const f = await fixture(t, area, path);
    const denied = await invoke(f.core, "knowledge.folder.promote-delete", f.args, { ...nativeActor, canWrite: false });
    assert.equal(denied.error.code, "ACCESS_DENIED");
    const result = await invoke(f.core, "knowledge.folder.promote-delete", f.args);
    assert(result.result, JSON.stringify(result));
    await assertPromoted(f, f.core, result.result);
  });
}

test("native pre-write collision, sidecar/source/reference CAS, unsupported modes and escaping paths are refused", async t => {
  const f = await fixture(t);
  for (const name of ["Alpha.md", "Alpha.assets", "alpha.MD", "Nested"]) {
    const target = join(f.root, "notes/Parent", name);
    await mkdir(target);
    const rejected = await invoke(f.core, "knowledge.folder.promote-delete", f.args);
    assert(["CONFLICT", "INVALID_DOCUMENT"].includes(rejected.error.code), JSON.stringify(rejected));
    assert.equal(await readFile(join(f.root, "notes/Parent/Group/Alpha.md"), "utf8"), f.alpha);
    await rm(target, { recursive: true });
  }
  for (const field of ["expectedSourceSha256", "expectedScanRevision"]) {
    assert.equal((await invoke(f.core, "knowledge.folder.promote-delete", { ...f.args, [field]: hash })).error.code, "CONFLICT");
  }
  await f.put("Parent/Group/Alpha.md", f.alpha + "External source edit.\r\n");
  assert.equal((await invoke(f.core, "knowledge.folder.promote-delete", f.args)).error.code, "CONFLICT");
  await f.put("Parent/Group/Alpha.md", f.alpha);
  await writeFile(join(f.root, "notes/.pk-meta.json"), '{"pinnedFolders":["external"]}\n');
  assert.equal((await invoke(f.core, "knowledge.folder.promote-delete", f.args)).error.code, "CONFLICT");
  await writeFile(join(f.root, "notes/.pk-meta.json"), f.sidecar);
  await f.put("Outside.md", "---\ndocumentId: promote-outside\nrevision: 2\ntitle: Changed\n---\nChanged.\n");
  assert.equal((await invoke(f.core, "knowledge.folder.promote-delete", f.args)).error.code, "CONFLICT");
  for (const args of [{ ...f.args, mode: "fallback" }, { ...f.args, path: "../outside" }, { ...f.args, fallbackGroup: "Ungrouped" }]) {
    assert.equal((await invoke(f.core, "knowledge.folder.promote-delete", args)).error.code, "INVALID_ARGUMENT");
  }
  assert.deepEqual(await readFile(join(f.root, "notes/Parent/Group/Alpha.assets/a.bin")), bytes);
  assert.deepEqual(await readFile(join(f.root, "notes/.pk-meta.json")), f.sidecar);
  f.db(db => assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 0));
});

test("a synthetic outside-root symlink is rejected without following or writing it", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside-sentinel");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.bin"), bytes);
  for (const name of ["escape", ".gitkeep"]) {
    if (name === ".gitkeep") await rm(join(f.root, "notes/Parent/Group/.gitkeep"));
    await symlink(outside, join(f.root, "notes/Parent/Group", name));
    const rejected = await invoke(f.core, "knowledge.folder.promote-delete", f.args);
    assert.equal(rejected.error.code, "INVALID_DOCUMENT");
    await rm(join(f.root, "notes/Parent/Group", name));
  }
  assert.deepEqual(await readdir(outside), ["sentinel.bin"]);
  assert.deepEqual(await readFile(join(outside, "sentinel.bin")), bytes);
  f.db(db => assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 0));
});

test("native empty-folder promotion removes only the container and repaths its Note pin", async t => {
  const f = await fixture(t);
  await rm(join(f.root, "notes/Parent/Group"), { recursive: true });
  await mkdir(join(f.root, "notes/Parent/Group"));
  const preview = await invoke(f.core, "knowledge.folder.lifecycle.promote-preview", { area: "notes", path: f.path, mode: "parent" });
  assert(preview.result, JSON.stringify(preview));
  const result = await invoke(f.core, "knowledge.folder.promote-delete", { ...f.args,
    expectedSourceSha256: preview.result.sourceSha256, expectedScanRevision: preview.result.scanRevision });
  assert.equal(result.result.moved, 0);
  await assert.rejects(readdir(join(f.root, "notes/Parent/Group")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "notes/.pk-meta.json"), "utf8")).pinnedFolders,
    ["Parent", "Parent/Nested", "Else"]);
  assert.deepEqual(await readFile(join(f.root, "notes/Outside.assets/shared.bin")), bytes);
});

test("real native journal recovers actual process crashes and move rollback", { concurrency: 8 }, async t => {
  const cases = ["asset-pair", "multi-child", "markdown-staging", "marker-removed", "container-removed", "pin-staging", "pin-published", "rollback"]
    .map(point => [point, "Parent/Group"]);
  cases.push(["markdown-staging", "Group"], ["pin-staging", "Group"], ["pin-published", "Group"]);
  await Promise.all(cases.map(([point, path]) =>
  t.test(`process interruption at ${point} (${path}) without data loss or duplicate receipts`, async t => {
    const f = await fixture(t, "notes", path);
    await f.close();
    const child = spawnSync(process.execPath, [join(tests, "knowledge-promote-crash-child.mjs"), f.root, point, JSON.stringify(f.args)],
      { encoding: "utf8", timeout: 30000 });
    if (point === "rollback") {
      assert.equal(child.status, 0, child.stderr + child.stdout);
      assert.equal(await readFile(join(f.root, "notes/Parent/Group/Alpha.md"), "utf8"), f.alpha);
      assert.deepEqual(await readFile(join(f.root, "notes/Parent/Group/Alpha.assets/a.bin")), bytes);
      await assert.rejects(readdir(join(f.root, "notes/Parent/Alpha.assets")), { code: "ENOENT" });
    } else assert.equal(child.signal, "SIGKILL", child.stderr + child.stdout);
    f.db(db => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(f.args.operationId).n, 0);
    });

    if (point !== "rollback") {
      const expiry = f.db(db => Number(db.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get().lease_until));
      await setTimeout(Math.max(0, expiry - Date.now() + 20));
    }
    const core = await f.open();
    const replay = await invoke(core, "knowledge.folder.promote-delete", f.args);
    assert(replay.result, JSON.stringify(replay));
    await assertPromoted(f, core, replay.result);
  })));
});

test("native crash recovery fences unknown asset bytes and sidecar changes before further filesystem effects", async t => {
  const f = await fixture(t);
  await f.close();
  const child = spawnSync(process.execPath, [join(tests, "knowledge-promote-crash-child.mjs"), f.root, "asset-pair", JSON.stringify(f.args)],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(child.signal, "SIGKILL", child.stderr + child.stdout);
  const expiry = f.db(db => Number(db.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get().lease_until));
  await setTimeout(Math.max(0, expiry - Date.now() + 20));
  const asset = join(f.root, "notes/Parent/Alpha.assets/a.bin");
  const unknown = Buffer.from("uncooperative external writer");
  await writeFile(asset, unknown);
  await assert.rejects(f.open(), { code: "RECOVERY_CONFLICT" });
  await f.close();
  assert.deepEqual(await readFile(asset), unknown);
  assert.equal(await readFile(join(f.root, "notes/Parent/Group/Alpha.md"), "utf8"), f.alpha);
  assert.deepEqual(await readFile(join(f.root, "notes/.pk-meta.json")), f.sidecar);
  await writeFile(asset, bytes);
  await writeFile(join(f.root, "notes/.pk-meta.json"), '{"pinnedFolders":["external-pin"]}\n');
  await assert.rejects(f.open(), { code: "RECOVERY_CONFLICT" });
  await f.close();
  assert.equal(await readFile(join(f.root, "notes/Parent/Group/Alpha.md"), "utf8"), f.alpha);
  assert.equal(await readFile(join(f.root, "notes/.pk-meta.json"), "utf8"), '{"pinnedFolders":["external-pin"]}\n');
  f.db(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(f.args.operationId).n, 0);
  });
  await writeFile(join(f.root, "notes/.pk-meta.json"), f.sidecar);
  const core = await f.open();
  const recovered = await invoke(core, "knowledge.folder.promote-delete", f.args);
  await assertPromoted(f, core, recovered.result);
});
