import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installedNativeKnowledgeMovePrivacyPolicy } from "./installed-native-knowledge-move.mjs";
import {
  prepareInstalledNativeLegacyAssetsMoveFixture, verifyInstalledNativeLegacyAssetsMove,
  verifyInstalledNativeLegacyAssetsMoveB1, verifyInstalledNativeLegacyAssetsMoveRestored,
} from "./installed-native-legacy-assets-move.mjs";
import { installedNativeLegacyAssetsMoveUiProgram, startInstalledNativeLegacyAssetsMoveUi } from "./installed-native-legacy-assets-move-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
const installed = resolve("clients/vscode-host"), python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, policy = installedNativeKnowledgeMovePrivacyPolicy) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery"); await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `legacy-assets-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(value.root, name), { mode: 0o700 });
  await writeFile(join(value.root, "notes/Entry.md"), "Common original Entry.\n", { mode: 0o600 });
  await writeFile(join(value.root, "skills/Base.md"), "Common original Base.\n", { mode: 0o600 });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), JSON.stringify(policy), { mode: 0o600 });
  return value;
}
test("legacy preparation rejects copied identity, wrong independent privacy and sealed roots before original effects", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeLegacyAssetsMoveFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeLegacyAssetsMoveFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeLegacyAssetsMoveFixture(args), { code: "INSTALLED_LEGACY_ASSETS_PRESEAL_REQUIRED" });
});
test("actual original seed/oracle proves digest targets, parser forms and public shared COPY+RETAIN without granting native shared parity or fake recovery", {
  skip: !process.env.PKM_LEGACY_VSIX && "Requires independently pinned original 4.0.22.", timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const policy = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const source = await prepareInstalledNativeLegacyAssetsMoveFixture(args);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Common original Entry.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Common original Base.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), policy);
  const oracle = join(componentFixture.directory, "original-legacy-assets-oracle");
  for (const area of ["notes", "skills", "papers"]) {
    assert.deepEqual(await readFile(join(componentFixture.root, area, "_assets/a.PNG")), Buffer.from([255, 0, 128, 9]));
    assert.deepEqual(await readFile(join(oracle, area, "New", `${area === "skills" ? "Before" : "After"}.assets`, source.targets.png)),
      Buffer.from([255, 0, 128, 9]));
    const raw = await readFile(join(oracle, area, `New/${area === "skills" ? "Before" : "After"}.md`), "utf8");
    assert(raw.includes(`.assets/${source.targets.png}?html=1#image`));
    assert(raw.includes(`.assets/${source.targets.bin}?definition=1#doc`));
    assert(raw.includes("`![ignored](../_assets/a.PNG)`"));
    assert(!(await readFile(join(componentFixture.root, area, "Private/Secret.md"), "utf8")).includes("![shared]"));
  }
  assert.equal(source.targets.png, `${hash(Buffer.from([255, 0, 128, 9])).slice(0, 16)}.png`);
  assert.equal(source.originalSharedCopyAndRetainObserved, true); assert.equal(source.passed, undefined);
  assert.deepEqual(await readFile(join(oracle, "notes/_assets/shared.PNG")), Buffer.from([70, 71, 72, 73]));
  assert.deepEqual(await readFile(join(oracle, "notes/New/SharedAfter.assets", source.targets.shared)), Buffer.from([70, 71, 72, 73]));
  const component = { fixture: componentFixture, root: componentFixture.root };
  await assert.rejects(verifyInstalledNativeLegacyAssetsMove({ installed, component, sourceFixture: source }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeLegacyAssetsMove({ installed, component, sourceFixture: { ...source } }),
    { code: "INSTALLED_LEGACY_ASSETS_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeLegacyAssetsMoveB1(source, { retirement: { passed: true } }),
    { code: "INSTALLED_LEGACY_ASSETS_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativeLegacyAssetsMoveRestored(source, { retirement: {}, restored: {} }),
    { code: "INSTALLED_LEGACY_ASSETS_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(prepareInstalledNativeLegacyAssetsMoveFixture(args), { code: "INSTALLED_LEGACY_ASSETS_ALREADY_PREPARED" });
  assert.equal((await readdir(componentFixture.directory)).includes("native-legacy-assets-move-passed.json"), false);
});
test("seven-dialog observer compiles without an editor and refuses unsafe startup", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<legacy-assets-ui>','exec')"],
    { input: installedNativeLegacyAssetsMoveUiProgram, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  await assert.rejects(startInstalledNativeLegacyAssetsMoveUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_PRIVATE_UI_REQUIRED" });
});
