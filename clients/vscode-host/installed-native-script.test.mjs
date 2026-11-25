import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { installedNativeScriptPrivacyPolicy, prepareInstalledNativeScriptFixture,
  verifyInstalledNativeScript, verifyInstalledNativeScriptHostDenied, verifyInstalledNativeScriptB1,
  verifyInstalledNativeScriptRestored } from "./installed-native-script.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing private framework.");
assert(process.env.PKM_TEST_PYTHON && process.env.PKM_LEGACY_VSIX, "Exact original package/interpreter are required.");
const installed = resolve("clients/vscode-host"), python = process.env.PKM_TEST_PYTHON;
const recovery = await u.load(installed, "original-mcp-component-recovery");
async function fixture(t, policy = installedNativeScriptPrivacyPolicy) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `script-helper-${randomUUID()}`));
  t.after(() => rm(value.directory, { recursive: true }));
  for (const path of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(value.root, path), { mode: 0o700 });
  await writeFile(join(value.root, "notes/Entry.md"), "---\ntitle: Entry\n---\nUnchanged common original Note.\n", { mode: 0o600 });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), JSON.stringify(policy), { mode: 0o600 });
  return value;
}

test("installed Script preparation refuses copied fixture brands, changed privacy and presealed roots before original setup", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeScriptFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeScriptFixture(args), /Parent must independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeScriptFixture(args), { code: "INSTALLED_SCRIPT_PRE_B0_REQUIRED" });
});

test("installed Script pre-B0 original reader/snapshot oracle is exact while fabricated Host, observer and B1/B0 success remain refused", {
  timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const prepared = await prepareInstalledNativeScriptFixture(args);
  assert.equal(prepared.installedReadQualified, false);
  assert.equal(prepared.heldOldParserRequested, false);
  assert.match(prepared.sourceId, /^pkm:\/\/script\/script_[a-f0-9]{24}$/);
  assert(prepared.sourceRevision.startsWith(`sha256:${prepared.rawSha256}:`));
  assert((await readFile(join(componentFixture.root, "scripts/ScriptFixture/immutable.py"), "utf8")).includes(prepared.marker));
  assert((await readFile(join(componentFixture.root, "scripts/Private/NativeSecret.py"), "utf8")).includes(prepared.privateMarker));
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "---\ntitle: Entry\n---\nUnchanged common original Note.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), privacy);
  const fake = { installed, component: { fixture: componentFixture, root: componentFixture.root }, scriptFixture: prepared };
  await assert.rejects(verifyInstalledNativeScript(fake), { code: "INSTALLED_SCRIPT_ACTUAL_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScript({ ...fake, scriptFixture: { ...prepared } }),
    { code: "INSTALLED_SCRIPT_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScript({ ...fake,
    component: { ...fake.component, invoke() {}, complete() {} },
    priorDenied: { kind: "pkm.installed-native-script-denial/v1", actualHostDenied: true, failedEpoch: randomUUID() } }),
  { code: "INSTALLED_SCRIPT_ACTUAL_DENIAL_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScriptHostDenied({ ...fake, ui: { passed: true } }),
    { code: "INSTALLED_SCRIPT_ACTUAL_OBSERVER_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScriptB1(prepared, { retirement: { passed: true }, b1: { passed: true } }),
    { code: "INSTALLED_SCRIPT_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScriptRestored(prepared, { retirement: { passed: true }, restored: { passed: true } }),
    { code: "INSTALLED_SCRIPT_VERIFIED_PHASE_REQUIRED" });
  await assert.rejects(prepareInstalledNativeScriptFixture(args), { code: "INSTALLED_SCRIPT_ALREADY_PREPARED" });
});
