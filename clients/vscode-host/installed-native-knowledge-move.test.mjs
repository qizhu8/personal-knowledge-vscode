import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  installedNativeKnowledgeMovePrivacyPolicy, prepareInstalledNativeKnowledgeMoveFixture,
  verifyInstalledNativeKnowledgeMove, verifyInstalledNativeKnowledgeMoveB1, verifyInstalledNativeKnowledgeMoveRestored,
} from "./installed-native-knowledge-move.mjs";
import { installedNativeKnowledgeMoveUiProgram, startInstalledNativeKnowledgeMoveUi } from "./installed-native-knowledge-move-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing private Linux framework.");
const installed = resolve("clients/vscode-host"), python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t, privacy = installedNativeKnowledgeMovePrivacyPolicy) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const componentFixture = await recovery.createOriginalMcpColdComponentFixture(join(base, `knowledge-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(componentFixture.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(componentFixture.root, name), { mode: 0o700 });
  await writeFile(join(componentFixture.root, "notes/Entry.md"), "Original common Entry.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, "skills/Base.md"), "Original common Base.\n", { mode: 0o600 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), JSON.stringify(privacy), { mode: 0o600 });
  return componentFixture;
}
test("preparation rejects copied cold identity, wrong independent privacy and already sealed roots before original writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} });
  const args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativeKnowledgeMoveFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeKnowledgeMoveFixture(args), /independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  assert.deepEqual(await readdir(join(componentFixture.root, "skills")), ["Base.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeKnowledgeMoveFixture(args), { code: "INSTALLED_KNOWLEDGE_MOVE_PRESEAL_PREPARATION_REQUIRED" });
});
test("SHA-pinned original writer seeds disjoint pairs/private referrers without changing Entry/Base or independent privacy; fake installed effects/recovery stay closed", {
  skip: !process.env.PKM_LEGACY_VSIX && "Requires the independently pinned original package.", timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  const policyBefore = await readFile(join(componentFixture.root, ".pkm/content-privacy.json"));
  const source = await prepareInstalledNativeKnowledgeMoveFixture(args);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Original common Entry.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Original common Base.\n");
  assert.deepEqual(await readFile(join(componentFixture.root, ".pkm/content-privacy.json")), policyBefore);
  for (const area of ["notes", "skills", "papers"]) {
    assert.match(await readFile(join(componentFixture.root, area, "Private/Secret.md"), "utf8"), /\.\.\/Old\/Shared\.assets\/opaque\.bin/);
    assert.deepEqual(await readFile(join(componentFixture.root, area, "Old/Before.assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
    assert(source.files.some(file => file.path === `${area}/Old/Before.md`));
  }
  assert(source.files.some(file => file.path === "notes/Entry.md")); assert.equal(source.passed, undefined);
  const verification = { installed, sourceFixture: source, component: { fixture: componentFixture, root: componentFixture.root } };
  await assert.rejects(verifyInstalledNativeKnowledgeMove(verification), { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeKnowledgeMove({ ...verification, sourceFixture: { ...source } }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeKnowledgeMoveB1(source, { retirement: { passed: true } }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativeKnowledgeMoveRestored(source, { retirement: { passed: true }, restored: { passed: true } }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(prepareInstalledNativeKnowledgeMoveFixture(args), { code: "INSTALLED_KNOWLEDGE_MOVE_ALREADY_PREPARED" });
  assert.equal((await readdir(componentFixture.directory)).includes("native-knowledge-move-passed.json"), false);
});
test("owned modal observer compiles as Python and refuses unsafe startup without an editor or manufactured native proof", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<knowledge-move-ui>','exec')"],
    { input: installedNativeKnowledgeMoveUiProgram, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  await assert.rejects(startInstalledNativeKnowledgeMoveUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_PRIVATE_UI_REQUIRED" });
});
