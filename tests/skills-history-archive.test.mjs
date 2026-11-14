import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const dist = resolve(import.meta.dirname, process.env.PKM_NEXT_SERVER_DIST ?? "../dist");
const load = path => import(pathToFileURL(join(dist, path)));
const [
  { importLegacyWorkspace, planLegacyImport },
  { auditImportedWorkspace },
  { readDocumentAssets },
  { readLibrary },
  { migrationPreflight },
  { scanMarkdown },
  { readSkills },
  { Storage },
  { createWorkspaceBackup, restoreWorkspaceBackup },
] = await Promise.all([
  load("legacy-import.js"), load("managed-import-audit.js"), load("assets.js"), load("library-reads.js"),
  load("migration-preflight.js"), load("markdown.js"), load("skills.js"), load("storage.js"), load("workspace-backup.js"),
]);

const hash = value => createHash("sha256").update(value).digest("hex");
const pythonExecutable = execFileSync("python3", ["-I", "-B", "-c", "import os,sys; print(os.path.realpath(sys.executable))"],
  { encoding: "utf8" }).trim();
const privateRoot = resolve(process.env.PKM_REHEARSAL_ROOT ?? import.meta.dirname);

async function snapshot(root) {
  const entries = {};
  async function walk(prefix) {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, stat = await lstat(join(root, path));
      assert.equal(stat.isSymbolicLink(), false, `synthetic fixture has no links: ${path}`);
      entries[path] = {
        kind: stat.isDirectory() ? "directory" : "file",
        mode: stat.mode & 0o777,
        sha256: stat.isDirectory() ? null : hash(await readFile(join(root, path))),
      };
      if (stat.isDirectory()) await walk(path);
    }
  }
  await walk("");
  return entries;
}

test("Skills Trash, markers and unmanaged files remain inert through import, read, backup and restore", { timeout: 240000 }, async t => {
  const root = join(privateRoot, `synthetic-skills-history-${randomUUID()}`);
  const source = join(root, "legacy-root"), imported = join(root, "imported"), backup = join(root, "backup"), restored = join(root, "restored");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(source, "skills/Category/Skill.assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(source, "skills/.trash/deep/empty"), { recursive: true, mode: 0o700 });
  await mkdir(join(source, "skills/Category"), { recursive: true, mode: 0o700 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const skill = Buffer.from(
    "---\r\n title: Example Skill\r\n name: Example Skill\r\n description: synthetic\r\n documentId: skill-example\r\n revision: 3\r\n deleted: false\r\n---\r\nBody remains readable.\r\n![asset](Skill.assets/payload.bin)\r\n",
  );
  const asset = Buffer.from([0, 255, 13, 10, 128, 65]);
  const trashMarkdown = Buffer.from("historical Markdown is opaque\r\n");
  const trashBinary = Buffer.from([255, 0, 19, 10, 128]);
  const unmanaged = Buffer.from([0, 1, 255, 128, 10]);
  const originals = new Map([
    ["skills/Category/Skill.md", skill],
    ["skills/Category/Skill.assets/payload.bin", asset],
    ["skills/.trash/deleted.md", trashMarkdown],
    ["skills/.trash/deep/deleted.bin", trashBinary],
    ["skills/.gitkeep", Buffer.alloc(0)],
    ["skills/Category/.gitkeep", Buffer.alloc(0)],
    ["skills/Category/opaque.bin", unmanaged],
  ]);
  const archivedOriginals = new Map([...originals].filter(([path]) =>
    path.includes("/.trash/") || path.endsWith("/.gitkeep") || path.endsWith("/opaque.bin")));
  for (const [path, bytes] of originals) {
    const full = join(source, path);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, bytes, { mode: path.endsWith("opaque.bin") ? 0o751 : 0o640 });
    await chmod(full, path.endsWith("opaque.bin") ? 0o751 : 0o640);
  }
  for (const [path, mode] of [
    ["skills", 0o750], ["skills/Category", 0o750], ["skills/.trash", 0o775],
    ["skills/.trash/deep", 0o710], ["skills/.trash/deep/empty", 0o711],
  ]) await chmod(join(source, path), mode);

  const sourceBefore = await snapshot(source);
  const preflight = migrationPreflight(source);
  assert.equal(preflight.ready, true, JSON.stringify(preflight.blockers));
  for (const path of [
    "skills/.trash", "skills/.trash/deep", "skills/.trash/deep/empty",
    "skills/.trash/deleted.md", "skills/.trash/deep/deleted.bin", "skills/.gitkeep",
    "skills/Category/.gitkeep", "skills/Category/opaque.bin",
  ]) {
    const item = preflight.entries.find(entry => entry.path === path);
    assert(item, `preflight inventory includes ${path}`);
    assert.notEqual(item.mode, undefined, `preflight captures ordinary mode for ${path}`);
  }
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.skillsHistoryArchive.disposition, "opaque-inert-history");
  assert.equal(plan.skillsHistoryArchive.fileCount, 5);
  assert.equal(plan.skillsHistoryArchive.directoryCount, 6);
  assert.equal(plan.skillsHistoryArchive.totalBytes,
    trashMarkdown.length + trashBinary.length + unmanaged.length);
  const historyEntries = plan.entries.filter(entry => entry.destination?.startsWith("legacy-code-archive/skills-history/"));
  assert.equal(historyEntries.filter(entry => entry.kind === "asset").length, 5);
  assert(historyEntries.some(entry => entry.source === "skills/.trash/deep/empty" && entry.kind === "directory"));
  assert(historyEntries.some(entry => entry.source === "skills/Category/opaque.bin" && entry.kind === "asset" && entry.mode === 0o751));

  const receipt = await importLegacyWorkspace(plan, imported, { pythonExecutable });
  assert.deepEqual(receipt.skillsHistoryArchive, plan.skillsHistoryArchive);
  assert(receipt.archivedDirectories.some(item => item.path === "legacy-code-archive/skills-history" && item.mode === 0o700));
  for (const [path, bytes] of archivedOriginals) {
    const archived = join(imported, "legacy-code-archive/skills-history", path);
    assert.deepEqual(await readFile(archived), bytes);
    assert.equal((await lstat(archived)).mode & 0o777, sourceBefore[path].mode);
  }
  assert.equal((await lstat(join(imported, "legacy-code-archive/skills-history/skills/.trash/deep/empty"))).mode & 0o777,
    sourceBefore["skills/.trash/deep/empty"].mode);
  for (const path of ["skills/.trash", "skills/.gitkeep", "skills/Category/.gitkeep", "skills/Category/opaque.bin"])
    await assert.rejects(lstat(join(imported, path)), { code: "ENOENT" });

  const markdown = scanMarkdown(imported);
  assert.deepEqual(markdown.map(item => item.record.path), ["Category/Skill.md"]);
  const read = readSkills(imported, markdown, { operation: "knowledge.skill.get", args: { name: "Example Skill" } });
  assert.equal(read.item.documentId, "skill-example");
  assert.equal(read.item.content, "Body remains readable.\r\n![asset](Skill.assets/payload.bin)\r\n");
  const assetList = readDocumentAssets(imported, markdown[0], {
    operation: "knowledge.asset.list", args: { offset: 0, limit: 10 },
  });
  assert.equal(assetList.total, 1);
  assert.equal(assetList.items[0].path, "Category/Skill.assets/payload.bin");
  const assetRead = readDocumentAssets(imported, markdown[0], {
    operation: "knowledge.asset.get", args: {
      path: assetList.items[0].path, expectedDigest: assetList.items[0].digest,
      expectedDocumentSha256: markdown[0].record.sha256, offset: 0, length: 64,
    },
  });
  assert.deepEqual(Buffer.from(assetRead.data, "base64"), asset);
  for (const area of ["prompts", "scripts", "packages", "actions", "components", "action-module-sets", "action-state"]) {
    const listing = readLibrary(imported, {
      operation: "knowledge.library.list", args: { area, offset: 0, limit: 100 },
    });
    assert.equal(listing.items.some(item => item.path.includes("skills-history")), false);
  }
  await auditImportedWorkspace(imported, plan);
  assert.deepEqual(await snapshot(source), sourceBefore);

  let storage = await Storage.open(imported);
  await storage.close();
  storage = await Storage.open(imported);
  try {
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable });
  await auditImportedWorkspace(restored, plan);
  const restoredMarkdown = scanMarkdown(restored);
  const restoredSkill = readSkills(restored, restoredMarkdown, {
    operation: "knowledge.skill.get", args: { id: "skill-example" },
  });
  assert.equal(restoredSkill.item.content, read.item.content);
  for (const [path, bytes] of archivedOriginals) {
    const archived = join(restored, "legacy-code-archive/skills-history", path);
    assert.deepEqual(await readFile(archived), bytes);
    assert.equal((await lstat(archived)).mode & 0o777, sourceBefore[path].mode);
  }
  assert.deepEqual(await snapshot(source), sourceBefore);

  const unsafeSource = join(root, "unsafe-legacy-root"), unsafeTarget = join(root, "unsafe-import");
  await mkdir(join(unsafeSource, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(unsafeSource, "skills/.trash"), { recursive: true, mode: 0o700 });
  await writeFile(join(unsafeSource, "skills/.trash/target.bin"), Buffer.from([1, 2, 3]));
  await symlink("target.bin", join(unsafeSource, "skills/.trash/link.bin"));
  const unsafePlan = await planLegacyImport(unsafeSource);
  assert.equal(unsafePlan.ready, false);
  assert(unsafePlan.blockers.some(item => item.code === "symlink"));
  await assert.rejects(importLegacyWorkspace(unsafePlan, unsafeTarget, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
  await assert.rejects(lstat(unsafeTarget), { code: "ENOENT" });
});
