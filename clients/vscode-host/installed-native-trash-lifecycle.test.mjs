import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  installedNativeTrashLifecyclePrivacyPolicy,
  prepareInstalledNativeTrashLifecycleFixture, verifyInstalledNativeTrashLifecycle,
  verifyInstalledNativeTrashLifecycleB1, verifyInstalledNativeTrashLifecycleRestored,
  createInstalledNativeTrashLifecycleFaultController, installedNativeTrashLifecycleFaultInjector,
  verifyInstalledNativeTrashLifecyclePending, reopenInstalledNativeTrashLifecycleRecovery,
  closeInstalledNativeTrashLifecycleRecoveryEpoch,
} from "./installed-native-trash-lifecycle.mjs";
import { installedNativeTrashLifecycleUiProgram, startInstalledNativeTrashLifecycleUi } from "./installed-native-trash-lifecycle-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import { installedNativeTrashLifecycleRecoveryUiProgram, startInstalledNativeTrashLifecycleRecoveryUi } from "./installed-native-trash-lifecycle-recovery-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the real isolated framework.");
assert(process.env.PKM_LEGACY_VSIX, "Pinned original package required; no skipped qualification.");
const installed = resolve("clients/vscode-host"), recovery = await u.load(installed, "original-mcp-component-recovery");
const python = execFileSync(process.env.PKM_TEST_PYTHON ?? "/home/yuwang8/pkm-envs/personal-knowledge-vscode-dev/bin/python",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
async function fixture(t, privacy = installedNativeTrashLifecyclePrivacyPolicy) {
  const f = await recovery.createOriginalMcpColdComponentFixture(join(homedir(), ".local/state/pkm-v5-recovery", `trash-lifecycle-${randomUUID()}`));
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(f.root, name), { mode: 0o700 });
  await writeFile(join(f.root, "notes/Entry.md"), "Original common Entry.\n", { mode: 0o600 });
  await writeFile(join(f.root, "skills/Base.md"), "Original common Base.\n", { mode: 0o600 });
  await writeFile(join(f.root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
  return f;
}
test("lifecycle preparation rejects copied identities, independent-privacy changes and sealed roots before original seeding", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeTrashLifecycleFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTrashLifecycleFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeTrashLifecycleFixture(args), { code: "INSTALLED_TRASH_LIFECYCLE_PRE_B0_REQUIRED" });
});
test("original shared-private fixtures and retained readonly bucket are exact; fabricated installed/recovery claims remain closed", {
  timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const prepared = await prepareInstalledNativeTrashLifecycleFixture(args);
  assert.equal(prepared.owner.revision, 2); assert.equal(prepared.passed, undefined);
  assert.equal(prepared.pendingRecoveryQualified, false); assert.equal(prepared.oldReadonlyBucketRestoreQualified, false);
  assert.deepEqual(await readFile(join(componentFixture.root, "notes/TrashLifecycle/Owner.assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
  assert.match(await readFile(join(componentFixture.root, "notes/Private/TrashLifecycleReferrer.md"), "utf8"),
    /\.\.\/TrashLifecycle\/Shared\.assets\/opaque\.bin/);
  assert(prepared.files.some(file => file.path === `notes/.trash/${prepared.priorEntryId}/payload`));
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), privacy);
  const verification = { installed, sourceFixture: prepared, component: { fixture: componentFixture, root: componentFixture.root } };
  await assert.rejects(verifyInstalledNativeTrashLifecycle(verification), { code: "INSTALLED_TRASH_LIFECYCLE_ACTUAL_CANONICAL_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrashLifecycle({ ...verification, sourceFixture: { ...prepared } }),
    { code: "INSTALLED_TRASH_LIFECYCLE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrashLifecycleB1(prepared, { retirement: { passed: true } }),
    { code: "INSTALLED_TRASH_LIFECYCLE_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrashLifecycleRestored(prepared, { retirement: { passed: true }, restored: { passed: true } }),
    { code: "INSTALLED_TRASH_LIFECYCLE_VERIFIED_PHASE_REQUIRED" });
  const controller = await createInstalledNativeTrashLifecycleFaultController(prepared);
  const before = await u.files(componentFixture.root);
  installedNativeTrashLifecycleFaultInjector(controller)("move-0");
  assert.deepEqual(await u.files(componentFixture.root), before, "Unarmed fault callbacks are inert and cannot invent pending state.");
  assert.throws(() => installedNativeTrashLifecycleFaultInjector({ ...controller }), { code: "INSTALLED_TRASH_ACTUAL_FAULT_CONTROLLER_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTrashLifecyclePending({ ...verification, faultController: controller }),
    { code: "INSTALLED_TRASH_LIFECYCLE_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(reopenInstalledNativeTrashLifecycleRecovery({ installed, sourceFixture: prepared, attachment: {} }),
    { code: "INSTALLED_TRASH_RECOVERY_SAME_CANDIDATE_ORDER_REQUIRED" });
  await assert.rejects(closeInstalledNativeTrashLifecycleRecoveryEpoch({ kind: "pkm.installed-native-trash-recovery-epoch/v1" }),
    { code: "INSTALLED_TRASH_ACTUAL_RECOVERY_EPOCH_REQUIRED" });
});
test("new lifecycle observer compiles and unsafe UI paths cannot create actual transport or installed evidence", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<trash-lifecycle-ui>','exec')"],
    { input: installedNativeTrashLifecycleUiProgram, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
  await assert.rejects(startInstalledNativeTrashLifecycleUi({ root: resolve("."), python, port: 9222, runId: randomUUID() }),
    { code: "INSTALLED_TRASH_LIFECYCLE_PRIVATE_UI_REQUIRED" });
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<trash-recovery-ui>','exec')"],
    { input: installedNativeTrashLifecycleRecoveryUiProgram, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
  await assert.rejects(startInstalledNativeTrashLifecycleRecoveryUi({ root: resolve("."), python, port: 9222, runId: randomUUID() }),
    { code: "INSTALLED_TRASH_RECOVERY_PRIVATE_UI_REQUIRED" });
});
