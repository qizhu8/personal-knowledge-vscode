import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { installedNativeTodoGenesisPrivacyPolicy, prepareInstalledNativeTodoGenesisFixture,
  verifyInstalledNativeTodoGenesis, verifyInstalledNativeTodoGenesisB1,
  verifyInstalledNativeTodoGenesisRestored } from "./installed-native-todo-genesis.mjs";
import { installedNativeTodoGenesisUiProgram, startInstalledNativeTodoGenesisUi } from "./installed-native-todo-genesis-ui.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing isolated framework.");
assert(process.env.PKM_TEST_PYTHON, "Use the exact selected interpreter.");
const installed = resolve("clients/vscode-host"), python = process.env.PKM_TEST_PYTHON;
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t, privacy = installedNativeTodoGenesisPrivacyPolicy) {
  const parent = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const componentFixture = await recovery.createOriginalMcpColdComponentFixture(join(parent, `todo-prep-${randomUUID()}`));
  t.after(() => rm(componentFixture.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(componentFixture.root, name), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Entry.md"), "COMMON_ENTRY_UNCHANGED", { mode: 0o600 });
  await writeFile(join(componentFixture.root, "skills/Base.md"), "COMMON_BASE_UNCHANGED", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
  return componentFixture;
}
test("Todo installed preparation rejects copied identity, wrong independent privacy and already sealed roots before original writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeTodoGenesisFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTodoGenesisFixture(args), /Parent must configure independent Todo privacy/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeTodoGenesisFixture(args), { code: "INSTALLED_TODO_GENESIS_PRE_B0_REQUIRED" });
});
test("Pinned Original22 preparation creates an existing public category but no Board, preserves controls and refuses manufactured installed or recovery proof", { timeout: 90000 }, async t => {
  assert(process.env.PKM_LEGACY_VSIX, "The independently pinned original archive is mandatory; never skip.");
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const source = await prepareInstalledNativeTodoGenesisFixture(args);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "COMMON_ENTRY_UNCHANGED");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "COMMON_BASE_UNCHANGED");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), privacy);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes/Team")), ["TodoGenesisCategoryEntry.md"]);
  for (const path of Object.values(source.paths)) await assert.rejects(readFile(join(componentFixture.root, path)), { code: "ENOENT" });
  assert.equal(source.passed, undefined);
  await assert.rejects(verifyInstalledNativeTodoGenesis({ installed, sourceFixture: { ...source } }),
    { code: "INSTALLED_TODO_GENESIS_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoGenesis({ installed, sourceFixture: source,
    component: { fixture: componentFixture, root: "foreign-root" } }),
  { code: "INSTALLED_TODO_GENESIS_SAME_PREPARED_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoGenesis({ installed, sourceFixture: source,
    component: { fixture: componentFixture, root: componentFixture.root } }),
  { code: "INSTALLED_TODO_GENESIS_REAL_ALIAS_FACADE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoGenesisB1(source, { retirement: { passed: true } }),
    { code: "INSTALLED_TODO_GENESIS_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoGenesisRestored(source, { retirement: {}, restored: {} }),
    { code: "INSTALLED_TODO_GENESIS_VERIFIED_EFFECTS_REQUIRED" });
});
test("Todo observer Python compiles and rejects unsafe startup without an editor or manufactured native grant", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<todo-genesis-ui>','exec')"],
    { input: installedNativeTodoGenesisUiProgram, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  await assert.rejects(startInstalledNativeTodoGenesisUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_TODO_GENESIS_PRIVATE_UI_REQUIRED" });
});
