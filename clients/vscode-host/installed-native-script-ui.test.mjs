import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { installedNativeScriptUiProgram, startInstalledNativeScriptUi, stageInstalledNativeScriptHost,
  assertInstalledNativeScriptUi } from "./installed-native-script-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");

test("Script Host observer Python compiles while unsafe startup and fabricated observer stages cannot manufacture rendered approval", async () => {
  execFileSync(process.env.PKM_TEST_PYTHON, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<installed-script-ui>','exec')"],
    { input: installedNativeScriptUiProgram, timeout: 10000, stdio: "pipe" });
  await assert.rejects(startInstalledNativeScriptUi({ root: resolve("."), python: process.env.PKM_TEST_PYTHON, port: 9222,
    runId: "12345678-1234-1234-1234-123456789abc" }), { code: "INSTALLED_SCRIPT_PRIVATE_UI_REQUIRED" });
  assert.throws(() => assertInstalledNativeScriptUi({ passed: true }, resolve(".")), { code: "INSTALLED_SCRIPT_ACTUAL_OBSERVER_REQUIRED" });
  await assert.rejects(stageInstalledNativeScriptHost({ root: resolve("."), runId: "12345678-1234-1234-1234-123456789abc" },
    { stage: "native-script-host-approve", component: { passed: true } }), { code: "INSTALLED_SCRIPT_ACTUAL_OBSERVER_REQUIRED" });
});

test("Script approval segment rejects absent or fabricated prior denial before connecting to a renderer", async t => {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { root, python: process.env.PKM_TEST_PYTHON, port: 9222, runId: randomUUID() };
  await assert.rejects(startInstalledNativeScriptUi(args), { code: "INSTALLED_SCRIPT_UI_MODE_REQUIRED" });
  for (const priorDenied of [undefined, { kind: "pkm.installed-native-script-denial/v1", failedEpoch: randomUUID(), actualHostDenied: true }])
    await assert.rejects(startInstalledNativeScriptUi({ ...args, mode: "approve", priorDenied }), { code: "INSTALLED_SCRIPT_ACTUAL_DENIAL_REQUIRED" });
  assert.deepEqual(await readdir(root), [], "No renderer connection or evidence file may be manufactured.");
});
