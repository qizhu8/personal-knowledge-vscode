import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installedNativeKnowledgeMovePrivacyPolicy } from "./installed-native-knowledge-move.mjs";
import {
  prepareInstalledNativeSharedLegacyAssetsMoveFixture, verifyInstalledNativeSharedLegacyAssetsMove,
  verifyInstalledNativeSharedLegacyAssetsMoveB1, verifyInstalledNativeSharedLegacyAssetsMoveRestored,
} from "./installed-native-shared-legacy-assets-move.mjs";
import { prepareInstalledHeldOldLegacyParser, verifyInstalledHeldOldLegacyParser } from "./installed-held-legacy-assets-parser.mjs";
import { installedNativeSharedLegacyAssetsMoveUiProgram, startInstalledNativeSharedLegacyAssetsMoveUi } from "./installed-native-shared-legacy-assets-move-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const installed = resolve("clients/vscode-host"), python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t, policy = installedNativeKnowledgeMovePrivacyPolicy) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery"); await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `shared-legacy-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(value.root, name), { mode: 0o700 });
  await writeFile(join(value.root, "notes/Entry.md"), "Common Entry.\n", { mode: 0o600 });
  await writeFile(join(value.root, "skills/Base.md"), "Common Base.\n", { mode: 0o600 });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), JSON.stringify(policy), { mode: 0o600 });
  return value;
}
test("shared preparation refuses copied cold identity, wrong privacy and sealed roots without original mutations", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} }), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeSharedLegacyAssetsMoveFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeSharedLegacyAssetsMoveFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeSharedLegacyAssetsMoveFixture(args), { code: "INSTALLED_SHARED_LEGACY_PRESEAL_REQUIRED" });
});
test("original shared oracle retains PUBLIC bytes and public/private referrers; fake installed proof and recovery stay closed", {
  skip: !process.env.PKM_LEGACY_VSIX && "Requires independently pinned original 4.0.22.", timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const privacy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const source = await prepareInstalledNativeSharedLegacyAssetsMoveFixture(args), oracle = join(componentFixture.directory, "original-shared-legacy-oracle");
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Common Entry.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Common Base.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), privacy);
  for (const path of ["notes/_assets/shared.PNG", "notes/Old/Referrer.md", "notes/Private/Secret.md"])
    assert.deepEqual(await readFile(join(oracle, path)), await readFile(join(componentFixture.root, path)));
  assert.match(await readFile(join(componentFixture.root, "notes/Private/Secret.md"), "utf8"), /\.\.\/_assets\/shared\.PNG\?private-ref=1#view/);
  assert.equal(source.sharedPublicAndPrivateReferrers, true); assert.equal(source.originalSharedCopyAndRetainObserved, true);
  assert.equal(source.passed, undefined); assert.equal(source.heldOldParserPrepared, false);
  const component = { fixture: componentFixture, root: componentFixture.root };
  await assert.rejects(verifyInstalledNativeSharedLegacyAssetsMove({ installed, component, sourceFixture: source }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeSharedLegacyAssetsMove({ installed, component, sourceFixture: { ...source } }),
    { code: "INSTALLED_SHARED_LEGACY_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeSharedLegacyAssetsMoveB1(source, { retirement: { passed: true } }),
    { code: "INSTALLED_SHARED_LEGACY_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativeSharedLegacyAssetsMoveRestored(source, { retirement: {}, restored: {} }),
    { code: "INSTALLED_SHARED_LEGACY_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(prepareInstalledNativeSharedLegacyAssetsMoveFixture(args), { code: "INSTALLED_SHARED_LEGACY_ALREADY_PREPARED" });
  assert.equal((await readdir(componentFixture.directory)).includes("native-shared-legacy-assets-move-passed.json"), false);
});
test("explicit held old-parser probe rejects incomplete pins, wrong archive hashes and copied handles without an engine", async t => {
  const value = await fixture(t), args = { directory: value.directory, python };
  assert.equal(await prepareInstalledHeldOldLegacyParser(args), undefined);
  await assert.rejects(prepareInstalledHeldOldLegacyParser({ ...args, heldOldParser: {} }),
    { code: "HELD_OLD_LEGACY_PARSER_EXACT_PIN_REQUIRED" });
  const invalid = join(value.directory, "not-old.vsix"); await writeFile(invalid, "Filename is not provenance.", { mode: 0o600 });
  await assert.rejects(prepareInstalledHeldOldLegacyParser({ ...args, heldOldParser: { vsixPath: invalid, vsixSha256: "0".repeat(64) } }),
    { code: "HELD_OLD_LEGACY_PARSER_ARCHIVE_CHANGED" });
  await assert.rejects(verifyInstalledHeldOldLegacyParser({ kind: "pkm.held-old-legacy-parser/v1" }, "{}"),
    { code: "HELD_OLD_LEGACY_PARSER_ACTUAL_PREPARATION_REQUIRED" });
  assert.equal((await readdir(value.directory)).includes("held-old-legacy-parser"), false);
});
test("eight-choice observer compiles as Python and unsafe startup refuses without an editor", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<shared-legacy-ui>','exec')"],
    { input: installedNativeSharedLegacyAssetsMoveUiProgram, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  await assert.rejects(startInstalledNativeSharedLegacyAssetsMoveUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_SHARED_LEGACY_PRIVATE_UI_REQUIRED" });
});
