import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installedNativeKnowledgeMovePrivacyPolicy } from "./installed-native-knowledge-move.mjs";
import {
  prepareInstalledNativePrivateInplaceFixture, verifyInstalledNativePrivateInplace,
  verifyInstalledNativePrivateInplaceB1, verifyInstalledNativePrivateInplaceRestored,
} from "./installed-native-private-inplace.mjs";
import { installedNativePrivateInplaceUiProgram, startInstalledNativePrivateInplaceUi } from "./installed-native-private-inplace-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1"); assert(process.env.PKM_LEGACY_VSIX, "Pinned oracle is mandatory; no skip.");
const installed = resolve("clients/vscode-host"), python = execFileSync(process.env.PKM_TEST_PYTHON ?? "python3",
  ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t, policy = installedNativeKnowledgeMovePrivacyPolicy) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery"); await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `private-inplace-${randomUUID()}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  for (const name of ["notes", "skills", ".pkm"]) await mkdir(join(value.root, name), { mode: 0o700 });
  await writeFile(join(value.root, "notes/Entry.md"), "Common Entry.\n", { mode: 0o600 });
  await writeFile(join(value.root, "skills/Base.md"), "Common Base.\n", { mode: 0o600 });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), JSON.stringify(policy), { mode: 0o600 });
  return value;
}
test("in-place preparation rejects copied cold identity, wrong independent privacy and post-B0 writes", async t => {
  const componentFixture = await fixture(t, { schema: 1, private: {} }), args = { installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX };
  await assert.rejects(prepareInstalledNativePrivateInplaceFixture({ ...args, componentFixture: { ...componentFixture } }), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativePrivateInplaceFixture(args), /Independently configure/);
  assert.deepEqual(await readdir(join(componentFixture.root, "notes")), ["Entry.md"]);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativePrivateInplaceFixture(args), { code: "PRIVATE_INPLACE_PRESEAL_REQUIRED" });
});
test("pinned original six same-path updates retain private resources/referrers and revision+1 per update; fake installed/restore handles stay closed", { timeout: 90000 }, async t => {
  const componentFixture = await fixture(t), source = await prepareInstalledNativePrivateInplaceFixture({ installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX });
  const oracle = join(componentFixture.directory, "original-private-inplace-oracle");
  assert.equal(source.originalSamePathDoesNotPublish, true); assert.equal(source.originalUpsertRevisionIncrementObserved, true); assert.equal(source.passed, undefined);
  assert.equal(await readFile(join(componentFixture.root, "notes/Entry.md"), "utf8"), "Common Entry.\n");
  assert.equal(await readFile(join(componentFixture.root, "skills/Base.md"), "utf8"), "Common Base.\n");
  for (const area of ["notes", "skills", "papers"]) {
    const raw = await readFile(join(oracle, area, "Old/Before.md"), "utf8");
    assert.match(raw, /^revision: 3$/m); assert(raw.includes("../%50rivate/_assets/./a.PNG?inplace=1#same"));
    assert(raw.includes("`![ignored](../Private/_assets/unreviewed.BIN)`"));
    for (const path of ["Private/Secret.md", "Private/Unreviewed.md", "Private/_assets/a.PNG", "Private/_assets/b.BIN", "Private/_assets/unreviewed.BIN"])
      assert.deepEqual(await readFile(join(oracle, area, path)), await readFile(join(componentFixture.root, area, path)));
  }
  await assert.rejects(verifyInstalledNativePrivateInplace({ installed, sourceFixture: source, component: { fixture: componentFixture, root: componentFixture.root } }),
    { code: "INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateInplace({ sourceFixture: { ...source } }), { code: "PRIVATE_INPLACE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateInplaceB1(source, { retirement: {} }), { code: "PRIVATE_INPLACE_VERIFIED_EFFECTS_REQUIRED" });
  await assert.rejects(verifyInstalledNativePrivateInplaceRestored(source, { retirement: {}, restored: {} }), { code: "PRIVATE_INPLACE_VERIFIED_EFFECTS_REQUIRED" });
});
test("eleven public-only observer compiles and rejects an unsafe driver without an editor", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<private-inplace-ui>','exec')"],
    { input: installedNativePrivateInplaceUiProgram, timeout: 10000 });
  await assert.rejects(startInstalledNativePrivateInplaceUi({ root: resolve("."), python, port: 9222 }), { code: "PRIVATE_INPLACE_UI_PROFILE_REQUIRED" });
});
