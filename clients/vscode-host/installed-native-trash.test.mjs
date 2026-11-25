import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import {
  installedNativeTrashPrivacyPolicy, installedNativeTrashCanonicalRequest, prepareInstalledNativeTrashFixture,
  verifyInstalledNativeTrash, verifyInstalledNativeTrashB1, verifyInstalledNativeTrashRestored,
} from "./installed-native-trash.mjs";
import { installedNativeTrashUiProgram, startInstalledNativeTrashUi } from "./installed-native-trash-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the real isolated framework.");
assert(process.env.PKM_LEGACY_VSIX, "The pinned original package is mandatory; no skipped qualification.");
const installed = resolve("clients/vscode-host");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "/home/yuwang8/pkm-envs/personal-knowledge-vscode-dev/bin/python",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await u.load(installed, "original-mcp-component-recovery");
async function fixture(t, privacy = installedNativeTrashPrivacyPolicy) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  const componentFixture = await recovery.createOriginalMcpColdComponentFixture(join(base, `trash-helper-${randomUUID()}`));
  t.after(() => rm(componentFixture.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(componentFixture.root, name), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Entry.md"), "Original common Note.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, "skills/Base.md"), "Original common Skill.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
  return componentFixture;
}
test("Trash preparation rejects copied identities, altered independent privacy and presealed fixtures without original writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeTrashFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTrashFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeTrashFixture(args), { code: "INSTALLED_TRASH_PRE_B0_REQUIRED" });
});
test("original-only pre-B0 Note/pair/readonly bucket preparation is exact, while fabricated installed/B1/B0 success stays closed", {
  timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const prepared = await prepareInstalledNativeTrashFixture(args);
  assert.equal(prepared.original.revision, 2);
  assert.equal(prepared.passed, undefined); assert.equal(prepared.originalReadonlyBucketRestoreQualified, false);
  assert.deepEqual(await readFile(join(componentFixture.root, "notes/TrashFixture/Owner.assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
  assert.deepEqual(await readFile(join(componentFixture.root, "notes/.trash", prepared.priorEntryId, "assets/prior.bin")), Buffer.from([11, 12, 13]));
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Original common Note.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Original common Skill.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), privacy);
  const verification = { installed, sourceFixture: prepared, component: { fixture: componentFixture, root: componentFixture.root } };
  await assert.rejects(verifyInstalledNativeTrash(verification), { code: "INSTALLED_TRASH_ACTUAL_CANONICAL_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrash({ ...verification, sourceFixture: { ...prepared } }),
    { code: "INSTALLED_TRASH_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrashB1(prepared, { retirement: { passed: true } }),
    { code: "INSTALLED_TRASH_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrashRestored(prepared, { retirement: { passed: true }, restored: { passed: true } }),
    { code: "INSTALLED_TRASH_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTrashFixture(args), { code: "INSTALLED_TRASH_ALREADY_PREPARED" });
  const request = installedNativeTrashCanonicalRequest("knowledge.trash.restore", {
    operationId: randomUUID(), entryId: prepared.priorEntryId, expectedScanRevision: "0".repeat(64),
  });
  assert.equal(request.name, "legacy_capability_call"); assert.equal(request.input.args.operation, "knowledge.trash.restore");
  assert.throws(() => installedNativeTrashCanonicalRequest("knowledge.trash.empty", {}), { code: "INSTALLED_TRASH_CANONICAL_OPERATION_REQUIRED" });
});
test("new Trash observer Python compiles and unsafe startup cannot manufacture rendered or installed evidence", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<installed-trash-ui>','exec')"],
    { input: installedNativeTrashUiProgram, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
  await assert.rejects(startInstalledNativeTrashUi({ root: resolve("."), python, port: 9222, runId: randomUUID() }),
    { code: "INSTALLED_TRASH_PRIVATE_UI_REQUIRED" });
});
