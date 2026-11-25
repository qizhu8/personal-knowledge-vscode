import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyInstalledNativeScriptLifecycle, installedNativeScriptDriverContract, rotateInstalledNativeScriptEpochMarkers }
  from "./installed-native-script-lifecycle.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");

test("Script two-editor coordinator refuses invalid or mixed profiles before creating components, editor processes or markers", async t => {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { root, fixture: { nativeScript: true, port: 9222 }, editor: process.execPath, cliArgs: [],
    python: process.env.PKM_TEST_PYTHON, uiScript: resolve("clients/vscode-host/installed-ui.py"),
    nativeHome: root, stop() {}, short: root };
  await assert.rejects(verifyInstalledNativeScriptLifecycle({ ...args, fixture: {} }),
    { code: "INSTALLED_SCRIPT_LIFECYCLE_INPUT_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScriptLifecycle({ ...args, fixture: { ...args.fixture, nativeMemory: true } }),
    { code: "INSTALLED_SCRIPT_READONLY_PROFILE_REQUIRED" });
  await assert.rejects(verifyInstalledNativeScriptLifecycle({ ...args, editor: "unbound-editor" }),
    { code: "INSTALLED_SCRIPT_LIFECYCLE_INPUT_REQUIRED" });
  assert.deepEqual(await readdir(root), [], "No fallback component/editor/permission or success marker is permitted.");
});

test("Script marker rotation preserves identity records and cannot reuse stale generic editor or UI success", async t => {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "native-identity-first.json"), '{"identity":"retained"}');
  await writeFile(join(root, "electron-passed.json"), '{"passed":true,"prior":true}');
  await writeFile(join(root, "ui-passed.json"), '{"passed":true,"prior":true}');
  const archived = await rotateInstalledNativeScriptEpochMarkers({ root, mode: "deny", runId: randomUUID() });
  assert.equal(await readFile(join(archived, "electron-passed.json"), "utf8"), '{"passed":true,"prior":true}');
  assert.equal(await readFile(join(root, "native-identity-first.json"), "utf8"), '{"identity":"retained"}');
  await assert.rejects(readFile(join(root, "electron-passed.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "ui-passed.json")), { code: "ENOENT" });
});

test("Script marker rotation refuses linked generic receipts without touching the linked target", async t => {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "protected.json"), '{"unchanged":true}');
  await symlink(join(root, "protected.json"), join(root, "electron-passed.json"));
  await assert.rejects(rotateInstalledNativeScriptEpochMarkers({ root, mode: "approve", runId: randomUUID() }),
    { code: "INSTALLED_SCRIPT_OWNED_MARKER_REQUIRED" });
  assert.equal(await readFile(join(root, "protected.json"), "utf8"), '{"unchanged":true}');
});

test("Script driver marker contract rejects an unbound segment or epoch instead of reusing common mutation markers", () => {
  assert.throws(() => installedNativeScriptDriverContract("both", randomUUID()), { code: "INSTALLED_SCRIPT_EPOCH_SELECTOR_REQUIRED" });
  assert.throws(() => installedNativeScriptDriverContract("approve", "cached-epoch"), { code: "INSTALLED_SCRIPT_EPOCH_SELECTOR_REQUIRED" });
  const denied = installedNativeScriptDriverContract("deny", randomUUID());
  const approved = installedNativeScriptDriverContract("approve", randomUUID());
  assert.notEqual(denied.nativeScriptMarkers.effects, approved.nativeScriptMarkers.effects);
  assert.notEqual(denied.nativeScriptMarkers.ui, approved.nativeScriptMarkers.ui);
});
