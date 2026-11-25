import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  prepareInstalledNativeRecipeFixture, verifyInstalledNativeRecipe, verifyInstalledNativeRecipeRestored,
  installedNativeRecipeUiProgram,
} from "./installed-native-recipe.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run the actual cold-writer leaf checks in the existing private Linux framework.");
const installed = resolve("clients/vscode-host");
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const compiler = await import(pathToFileURL(join(installed, "next-runtime/server/dist/domain/project-recipes-workflow-contracts.js")).href);
const python = process.env.PKM_TEST_PYTHON ?? execFileSync("python3", ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `recipe-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  return value;
}
test("installed Recipe preparation rejects copied cold identities, missing/unpinned archives and already sealed roots without touching original files", async t => {
  const componentFixture = await fixture(t);
  await writeFile(join(componentFixture.root, "retain-original.txt"), "Exact disposable original bytes.", { mode: 0o600 });
  const args = { installed, componentFixture, python };
  await assert.rejects(prepareInstalledNativeRecipeFixture({ ...args, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeRecipeFixture(args), { code: "INSTALLED_RECIPE_PINNED_ORIGINAL_REQUIRED" });
  const unpinned = join(componentFixture.directory, "not-a-release.vsix");
  await writeFile(unpinned, "A filename is not provenance.", { mode: 0o600 });
  await assert.rejects(prepareInstalledNativeRecipeFixture({ ...args, legacyVsix: unpinned }),
    { code: "INSTALLED_RECIPE_ORIGINAL_PACKAGE_CHANGED" });
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeRecipeFixture(args), { code: "INSTALLED_RECIPE_PRESEAL_PREPARATION_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), ["retain-original.txt"]);
  assert.equal(await readFile(join(componentFixture.root, "retain-original.txt"), "utf8"), "Exact disposable original bytes.");
});
test("pinned original Recipe writer and real Python lifecycle oracle prepare exact source before custody, but missing actual component control cannot qualify installed execution", {
  skip: !process.env.PKM_LEGACY_VSIX && "Requires the explicit independently pinned original package.",
  timeout: 90000,
}, async t => {
  const componentFixture = await fixture(t);
  const source = await prepareInstalledNativeRecipeFixture({ installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX });
  const definitionPath = source.files.find(file => file.path.startsWith("recipes/")).path;
  const bytes = await readFile(join(componentFixture.root, definitionPath)), record = JSON.parse(bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.files.find(file => file.path === definitionPath).sha256);
  assert.equal(record.recipeId, source.recipeId); assert.equal(record.revision, source.revision);
  const compiled = compiler.compileWorkflowDefinitionV1(record.definition);
  assert.equal(compiled.ok, true); assert.equal(compiled.executableDigest, record.executableDigest);
  assert(record.definition.spec.nodes.every(node => node.kind === "pkm.step.noop/v1"));
  const args = { installed, component: { fixture: componentFixture, root: componentFixture.root }, sourceFixture: source };
  await assert.rejects(verifyInstalledNativeRecipe(args),
    { code: "INSTALLED_RECIPE_COMPONENT_RECIPE_CONTROL_AND_PUBLIC_INVOKE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeRecipe({ ...args, sourceFixture: { ...source } }),
    { code: "INSTALLED_RECIPE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeRecipeRestored(source, { retirement: {}, restored: {} }),
    { code: "INSTALLED_RECIPE_VERIFIED_EFFECTS_AND_PARENT_RECOVERY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeRecipeFixture({ installed, componentFixture, python, legacyVsix: process.env.PKM_LEGACY_VSIX }),
    { code: "INSTALLED_RECIPE_ALREADY_PREPARED" });
  assert.deepEqual(await readFile(join(componentFixture.root, definitionPath)), bytes);
  assert.equal((await readdir(componentFixture.directory)).includes("native-recipe-passed.json"), false);
});
test("Recipe modal observer parses as real Python without starting an editor or manufacturing installed proof", () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<installed-native-recipe-ui>','exec')"], {
    input: installedNativeRecipeUiProgram, stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
  });
});
