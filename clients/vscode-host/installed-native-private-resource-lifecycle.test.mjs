import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installedNativeKnowledgeMovePrivacyPolicy, installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import {
  prepareInstalledNativePrivateResourceLifecycleFixture, verifyInstalledNativePrivateResourceLifecycle,
  verifyInstalledNativePrivateResourceLifecycleB1, verifyInstalledNativePrivateResourceLifecycleRestored,
} from "./installed-native-private-resource-lifecycle.mjs";
import { installedNativePrivateResourceLifecycleUiProgram, startInstalledNativePrivateResourceLifecycleUi } from "./installed-native-private-resource-lifecycle-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
assert(process.env.PKM_LEGACY_VSIX, "Actual independently pinned oracle is mandatory; no skip.");
const installed = resolve("clients/vscode-host"), python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t, policy = installedNativeKnowledgeMovePrivacyPolicy) {
  const parent = join(homedir(), ".local/state/pkm-v5-recovery"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(parent, `private-lifecycle-${randomUUID()}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(value.root, name), { mode: 0o700 });
  await writeFile(join(value.root, "notes/Entry.md"), "Common Entry.\n", { mode: 0o600 });
  await writeFile(join(value.root, "skills/Base.md"), "Common Base.\n", { mode: 0o600 });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), JSON.stringify(policy), { mode: 0o600 });
  return value;
}
test("lifecycle preparation refuses copied identity, wrong independent privacy and post-B0 seeding; observer requires a real private driver", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativePrivateResourceLifecycleFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativePrivateResourceLifecycleFixture(args), /Independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativePrivateResourceLifecycleFixture(args), { code: "INSTALLED_PRIVATE_LIFECYCLE_PRESEAL_REQUIRED" });
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<lifecycle-ui>','exec')"],
    { input: installedNativePrivateResourceLifecycleUiProgram, timeout: 10000 });
  await assert.rejects(startInstalledNativePrivateResourceLifecycleUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_PRIVATE_LIFECYCLE_PRIVATE_UI_REQUIRED" });
});
test("original three-resource move oracle and controls are genuine, while copied installed/recovery DTOs cannot qualify cancellation or expiry", { timeout: 90000 }, async t => {
  const componentFixture = await fixture(t), policy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const source = await prepareInstalledNativePrivateResourceLifecycleFixture({ installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX });
  assert.equal(source.threeStoredPrivateResources, true); assert.equal(source.intentionalPrivateAlwaysRetainPolicyDifference, true);
  assert.equal(source.passed, undefined);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Common Entry.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Common Base.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), policy);
  for (const [index, name] of ["life-A.PNG", "life-B.BIN", "life-C.BIN"].entries()) {
    const bytes = Buffer.from(`PRIVATE_LIFECYCLE_BYTES_${index}`), target = `${u.hash(bytes).slice(0,16)}${name.slice(name.lastIndexOf(".")).toLowerCase()}`;
    assert.deepEqual(await readFile(join(componentFixture.root, "notes/Private/_assets", name)), bytes);
    assert.deepEqual(await readFile(join(componentFixture.directory, "original-private-lifecycle-oracle/notes/New/After.assets", target)), bytes);
  }
  await assert.rejects(readFile(join(componentFixture.directory, "original-private-lifecycle-oracle/notes/Private/_assets/life-B.BIN")), { code: "ENOENT" });
  await assert.rejects(verifyInstalledNativePrivateResourceLifecycle({ installed, component: { fixture: componentFixture, root: componentFixture.root }, sourceFixture: source }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateResourceLifecycle({ sourceFixture: { ...source } }),
    { code: "INSTALLED_PRIVATE_LIFECYCLE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateResourceLifecycleB1(source, { retirement: {} }), { code: "INSTALLED_PRIVATE_LIFECYCLE_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateResourceLifecycleRestored(source, { retirement: {}, restored: {} }), { code: "INSTALLED_PRIVATE_LIFECYCLE_VERIFIED_EFFECTS_REQUIRED" });
});
