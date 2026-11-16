import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { originalReleaseModules } from "./legacy-release-modules.mjs";
import { readContextOriginal } from "./context-original-source-captures.mjs";
import { importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { migrationPreflight } from "../dist/migration-preflight.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { checkSourceRecords, packageRoot } from "../scripts/migration.mjs";

const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const scriptIdentity = {
  schema: "pkm.script/v1", knowledgeId: "script_0123456789abcdef01234567",
  aliases: ["pkm://scripts/Old/check.py", "pkm://script/script_fedcba9876543210fedcba98"],
};
const originalStorage = originalReleaseModules()("src/knowledge/storage.ts");
async function fixture(t) {
  const parent = resolve(import.meta.dirname, `.legacy-library-${randomUUID()}`);
  const source = join(parent, "source"), destination = join(parent, "native");
  await mkdir(join(source, "notes"), { recursive: true });
  let storage;
  t.after(async () => { await storage?.close(); await rm(parent, { recursive: true, force: true }); });
  async function put(path, bytes, mode = 0o600) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes, { mode });
    await chmod(join(source, path), mode);
  }
  return { parent, source, destination, put, async open(root = destination) {
    storage = await Storage.open(root); return storage;
  }, async close() { await storage?.close(); storage = undefined; } };
}
test("import preserves complete Prompt templates and Script identities without indexing them as Notes", async t => {
  const f = await fixture(t);
  const files = new Map([
    ["prompts/Ads/Accuracy/v9/base.jinja2", Buffer.from("BASE {{ Language }}\n")],
    ["prompts/Ads/Accuracy/v9/prompt.jinja2", Buffer.from("{# PROMPT_METADATA\ntitle: Accuracy\nnote:\nReviewed\n#}\n{% extends 'base.jinja2' %}\n")],
    ["prompts/Ads/Accuracy/v9/related/nested.txt", Buffer.from("{{ context }}\n")],
    ["prompts/Ads/Accuracy/v9/README.md", Buffer.from("---\nnot: [valid yaml\n---\nThis is a template resource, not a PKM Note.\n")],
    ["prompts/Ads/Accuracy/v10/prompt.jinja2", Buffer.from("{{ next_version }}\r\n")],
    ["prompts/Empty/.gitkeep", Buffer.alloc(0)],
    ["scripts/Tools/check.py", Buffer.from("print('retained')\r\n")],
    ["scripts/Tools/.check.py.pkm.json", Buffer.from(JSON.stringify(scriptIdentity, null, 2) + "\n")],
    ["scripts/Tools/run.sh", Buffer.from("#!/bin/sh\nprintf 'library only\\n'\n")],
    ["scripts/Tools/binary.bin", Buffer.from([0, 255, 128, 10])],
    ["scripts/README.md", Buffer.from("Script library documentation is not Markdown knowledge.\n")],
  ]);
  for (const [path, bytes] of files) await f.put(path, bytes, path.endsWith("run.sh") ? 0o751 : 0o640);
  await mkdir(join(f.source, "prompts/EmptyTask/Task/v1/empty"), { recursive: true });
  originalStorage.setStorePath(f.source);
  const originalPrompts = originalStorage.promptList();
  const originalFile = originalStorage.promptGetFile("Ads", "Accuracy", "v9", "prompt.jinja2");
  const originalVersions = originalStorage.promptGetAllVersionsOfFile("Ads", "Accuracy", "prompt.jinja2");
  const originalScripts = originalStorage.scriptList();
  const originalScript = originalStorage.scriptGet(`pkm://script/${scriptIdentity.knowledgeId}`);
  const preflight = migrationPreflight(f.source);
  assert.equal(preflight.ready, true, JSON.stringify(preflight.blockers));
  assert.equal(preflight.entries.filter(item => item.kind === "document").length, 0);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const receipt = await importLegacyWorkspace(plan, f.destination, { pythonExecutable });
  assert.equal(receipt.documentCount, 0);
  assert.equal(receipt.assetCount, files.size);
  assert.equal(receipt.totalBytes, [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
  for (const [path, bytes] of files) {
    assert.deepEqual(await readFile(join(f.source, path)), bytes);
    assert.deepEqual(await readFile(join(f.destination, path)), bytes);
  }
  assert.equal((await lstat(join(f.destination, "scripts/Tools/run.sh"))).mode & 0o777, 0o751);
  assert.equal((await lstat(join(f.destination, "prompts/EmptyTask/Task/v1/empty"))).isDirectory(), true);
  originalStorage.setStorePath(f.destination);
  assert.deepEqual(originalStorage.promptList(), originalPrompts);
  assert.deepEqual(originalStorage.promptGetFile("Ads", "Accuracy", "v9", "prompt.jinja2"), originalFile);
  assert.deepEqual(originalStorage.promptGetAllVersionsOfFile("Ads", "Accuracy", "prompt.jinja2"), originalVersions);
  assert.deepEqual(originalStorage.scriptList(), originalScripts);
  assert.deepEqual(originalStorage.scriptGet(`pkm://script/${scriptIdentity.knowledgeId}`), originalScript);
  assert.deepEqual(originalStorage.scriptGet("pkm://scripts/Old/check.py"), originalScript);
  const recovered = await recoverLegacyImportOutcome(f.destination);
  assert.equal(recovered.status, "published");
  assert.deepEqual(recovered.receipt, receipt);
  const storage = await f.open();
  const backup = join(f.parent, "backup"), restored = join(f.parent, "restored");
  await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  assert.equal((await lstat(join(backup, "scripts/Tools/run.sh"))).mode & 0o777, 0o600, "backup storage stays private and non-executable");
  const manifest = JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json"), "utf8"));
  assert.equal(manifest.files.find(file => file.path === "scripts/Tools/run.sh").mode, 0o751);
  await f.close();
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, pythonExecutable });
  await f.open(restored);
  for (const [path, bytes] of files) assert.deepEqual(await readFile(join(restored, path)), bytes);
  assert.equal((await lstat(join(restored, "scripts/Tools/run.sh"))).mode & 0o777, 0o751);
  assert.equal((await lstat(join(restored, "prompts/EmptyTask/Task/v1/empty"))).isDirectory(), true);
  originalStorage.setStorePath(restored);
  assert.deepEqual(originalStorage.promptList(), originalPrompts);
  assert.deepEqual(originalStorage.scriptGet(`pkm://script/${scriptIdentity.knowledgeId}`), originalScript);
  assert.deepEqual(originalStorage.scriptGet("pkm://scripts/Old/check.py"), originalScript);
  // The existing Prompt writer must still clone every file and preserve the source version.
  const saved = originalStorage.promptSaveVersionNote("Ads", "Accuracy", "v9", "prompt.jinja2", "Post-migration note", "v9.1");
  assert.equal(saved.meta.note, "Post-migration note");
  assert.deepEqual(await readFile(join(restored, "prompts/Ads/Accuracy/v9.1/related/nested.txt")),
    files.get("prompts/Ads/Accuracy/v9/related/nested.txt"));
  assert.deepEqual(originalStorage.promptGetFile("Ads", "Accuracy", "v9", "prompt.jinja2"), originalFile);
  assert.equal(originalStorage.scriptMove("Tools/check.py", "Moved"), true);
  assert.equal(originalStorage.scriptGet(`pkm://script/${scriptIdentity.knowledgeId}`).path, "Moved/check.py");
  assert.equal(originalStorage.scriptGet("pkm://scripts/Old/check.py").path, "Moved/check.py");
  assert.equal(originalStorage.scriptGet("pkm://scripts/Tools/check.py").path, "Moved/check.py");
});
test("library oracle uses the separately pinned original storage and locator sources", async () => {
  const provenance = JSON.parse(await readFile(join(packageRoot, "migration/legacy-batch15-provenance.json"), "utf8"));
  const sources = provenance.originalSources.filter(item =>
    ["src/knowledge/storage.ts", "src/knowledge/knowledge-locator.ts"].includes(item.path));
  assert.equal(sources.length, 2);
  const storage = sources.find(item => item.path === "src/knowledge/storage.ts");
  assert.ok(storage);
  const original = await readContextOriginal(storage.path, { sha256: storage.sha256 });
  const { hash } = await import("../scripts/migration.mjs");
  assert.equal(hash(original), storage.sha256);
  assert.deepEqual(await checkSourceRecords(sources.filter(item => item !== storage)), []);
});
test("script identity sidecars remain bound to an existing regular script and unique identities/aliases", async t => {
  for (const variant of ["orphan", "malformed", "duplicate-id", "duplicate-alias"]) {
    const f = await fixture(t);
    await f.put("scripts/Tools/check.py", "print('keep')\n");
    const identity = variant === "malformed" ? { ...scriptIdentity, knowledgeId: "bad" } : scriptIdentity;
    await f.put(`scripts/Tools/.${variant === "orphan" ? "missing" : "check"}.py.pkm.json`, JSON.stringify(identity));
    if (variant.startsWith("duplicate")) {
      await f.put("scripts/other.py", "print('other')\n");
      await f.put("scripts/.other.py.pkm.json", JSON.stringify({
        ...scriptIdentity,
        knowledgeId: variant === "duplicate-id" ? scriptIdentity.knowledgeId : "script_111111111111111111111111",
        aliases: variant === "duplicate-alias" ? scriptIdentity.aliases : [],
      }));
    }
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, false, variant);
    assert.ok(plan.blockers.some(item => item.code.startsWith("script-identity")), JSON.stringify(plan.blockers));
    await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  }
});
test("unknown hidden library files, pending state, Trash and symlinks remain explicit blockers", async t => {
  for (const path of ["scripts/.secret", "scripts/.pending.json", "prompts/Ads/.trash/deleted.txt",
    "scripts/.trash/deleted.py", "scripts/Tools/.orphan.py.pkm.json"]) {
    const f = await fixture(t);
    await f.put(path, "{}");
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, false, path);
    await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  }
  const f = await fixture(t);
  await f.put("scripts/real.py", "source");
  await symlink(join(f.source, "scripts/real.py"), join(f.source, "scripts/link.py"));
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.some(item => item.code === "symlink"));
});
test("changed Script bytes or executable permissions invalidate a prepared import", async t => {
  for (const change of ["bytes", "mode", "sidecar"]) {
    const f = await fixture(t);
    await f.put("scripts/check.sh", "#!/bin/sh\nexit 0\n", 0o750);
    await f.put("scripts/.check.sh.pkm.json", JSON.stringify(scriptIdentity));
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    if (change === "bytes") await f.put("scripts/check.sh", "changed");
    if (change === "mode") await chmod(join(f.source, "scripts/check.sh"), 0o600);
    if (change === "sidecar") await f.put("scripts/.check.sh.pkm.json", JSON.stringify({ ...scriptIdentity, aliases: [] }));
    await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable }), { code: "SOURCE_CHANGED" });
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  }
});
test("privileged library modes and case-colliding paths block rather than change meaning silently", async t => {
  const privileged = await fixture(t);
  await privileged.put("scripts/run.sh", "#!/bin/sh\nexit 0\n", 0o4750);
  const special = await planLegacyImport(privileged.source);
  assert.equal(special.ready, false);
  assert.ok(special.blockers.some(item => item.code === "library-special-permissions"));
  for (const root of ["prompts", "scripts"]) {
    const f = await fixture(t);
    await f.put(`${root}/Team/a.txt`, "first");
    await f.put(`${root}/team/a.txt`, "second");
    const plan = await planLegacyImport(f.source);
    assert.equal(plan.ready, false);
    assert.ok(plan.blockers.some(item => item.code === "portable-path-collision"));
    await assert.rejects(importLegacyWorkspace(plan, f.destination, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  }
});
test("malformed permission fields in library backup manifests never publish a restore", async t => {
  const f = await fixture(t);
  await f.put("scripts/run.sh", "#!/bin/sh\nexit 0\n", 0o751);
  const plan = await planLegacyImport(f.source);
  await importLegacyWorkspace(plan, f.destination, { pythonExecutable });
  const storage = await f.open(), backup = join(f.parent, "backup");
  await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  await f.close();
  const manifestPath = join(backup, ".pkm-workspace-backup.json");
  const original = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const invalid of [-1, 0o4755, "493", null]) {
    const manifest = structuredClone(original);
    manifest.files.find(file => file.path === "scripts/run.sh").mode = invalid;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const destination = join(f.parent, `invalid-${String(invalid)}`);
    await assert.rejects(restoreWorkspaceBackup(backup, destination, { nativeRestoreAuthority, pythonExecutable }), { code: "INVALID_MANIFEST" });
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  }
  const manifest = structuredClone(original);
  manifest.files.find(file => file.path === ".pkm-next-workspace").mode = 0o777;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreWorkspaceBackup(backup, join(f.parent, "invalid-marker"), { nativeRestoreAuthority, pythonExecutable }),
    { code: "INVALID_MANIFEST" });
});
