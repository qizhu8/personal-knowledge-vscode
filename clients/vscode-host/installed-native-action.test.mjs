import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareInstalledNativeActionFixture, captureInstalledNativeActionCustody,
  composeInstalledNativeActionFixture, verifyInstalledNativeAction, closeInstalledNativeActionFixture,
  verifyInstalledNativeActionRestored, installedNativeActionUiScript, bootstrapInstalledNativeActionComponent,
  preserveInstalledNativeActionB1, prepareInstalledNativeActionProgramFixture, verifyInstalledNativeActionProgram,
  verifyInstalledNativeActionProgramRestored, installedNativeActionProgramUiScript } from "./installed-native-action.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private Linux framework.");
const installed = resolve("clients/vscode-host"), recovery = await import(pathToFileURL(
  join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `i-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true }));
  return value;
}

test("installed Action preparation never mutates a cold root with copied fixture identity, missing release archive, or unpinned writer bytes", async t => {
  const componentFixture = await fixture(t);
  const original = join(componentFixture.root, "retain-original.txt");
  await writeFile(original, "Retain exact disposable original bytes.", { mode: 0o600 });
  const before = await readFile(original);
  await assert.rejects(prepareInstalledNativeActionFixture({ installed, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeActionProgramFixture({ installed, componentFixture: { ...componentFixture } }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(prepareInstalledNativeActionFixture({ installed, componentFixture }),
    { code: "INSTALLED_ACTION_PINNED_ORIGINAL_WRITER_REQUIRED" });
  const unpinned = join(componentFixture.directory, "not-an-original-writer.vsix");
  await writeFile(unpinned, "No archive can be accepted by filename or claimed provenance.", { mode: 0o600 });
  await assert.rejects(prepareInstalledNativeActionFixture({ installed, componentFixture, legacyVsix: unpinned }),
    { code: "INSTALLED_ACTION_ORIGINAL_WRITER_CHANGED" });
  await assert.rejects(prepareInstalledNativeActionProgramFixture({ installed, componentFixture, legacyVsix: unpinned }),
    { code: "INSTALLED_ACTION_ORIGINAL_WRITER_CHANGED" });
  assert.deepEqual(await readdir(componentFixture.root), ["retain-original.txt"]);
  assert.deepEqual(await readFile(original), before);
});

test("Action installed hooks reject serialized preparation/composition and cannot manufacture source authority or B1 success", async t => {
  const componentFixture = await fixture(t);
  const sourceFixture = { kind: "pkm.installed-native-action-fixture/v1", root: componentFixture.root,
    actionId: "fixture.installed.native-pure", contentHash: "a".repeat(64), profileSha256: "b".repeat(64) };
  await assert.rejects(captureInstalledNativeActionCustody({ sourceFixture, custody: {}, writerFence: {} }),
    { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(composeInstalledNativeActionFixture({ sourceFixture, storage: {}, host: {}, session: {},
    approve: () => true, authorize: () => true }), { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(bootstrapInstalledNativeActionComponent({ sourceFixture, attachment: {},
    approve: () => true }), { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeAction({ sourceFixture, component: { root: componentFixture.root } }),
    { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(closeInstalledNativeActionFixture(sourceFixture), { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeActionRestored(sourceFixture, { restoredRoot: componentFixture.root,
    archive: componentFixture.root }), { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeActionProgram({ sourceFixture, component: { root: componentFixture.root,
    localPrograms: [{ actionId: sourceFixture.actionId, cwd: "unsealed" }] } }),
    { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeActionProgramRestored(sourceFixture, { restoredRoot: componentFixture.root,
    archive: componentFixture.root }), { code: "INSTALLED_ACTION_ACTUAL_COLD_FIXTURE_REQUIRED" });
  await assert.rejects(preserveInstalledNativeActionB1({ fixture: componentFixture, closed: true }),
    { code: "INSTALLED_ACTION_CONFIRMED_EFFECTS_AND_CLOSE_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
});

test("native Action CDP observer parses as real Python without launching an editor or emitting installed-proof artifacts", () => {
  for (const input of [installedNativeActionUiScript, installedNativeActionProgramUiScript])
    execFileSync(process.env.PKM_TEST_PYTHON ?? "python3", ["-I", "-B", "-c",
      "import sys; compile(sys.stdin.read(), '<installed-native-action-observer>', 'exec')"], {
      input, stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
    });
});
