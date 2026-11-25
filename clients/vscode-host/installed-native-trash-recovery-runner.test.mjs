import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyInstalledNativeTrashRecoveryLifecycle } from "./installed-native-trash-recovery-runner.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing private isolated framework.");
async function fixture(t) {
  const root = resolve(".pkm-test-evidence", `.installed-host-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("recovery runner refuses a mismatched driver/source binding before markers, epoch creation or process launch", async t => {
  const root = await fixture(t), before = await readdir(root);
  let stopped = false;
  await assert.rejects(verifyInstalledNativeTrashRecoveryLifecycle({
    root, fixture: { root: `${root}/other` }, installed: root, payloadBuildId: "0".repeat(64),
    sourceFixture: { root: `${root}/library` }, editor: process.execPath, cliArgs: [], python: process.execPath,
    uiScript: join(root, "unused.py"), short: root, nativeHome: root, stop() { stopped = true; },
  }), { code: "TRASH_RECOVERY_COORDINATOR_BINDING_REQUIRED" });
  assert.deepEqual(await readdir(root), before); assert.equal(stopped, false);
});
test("actual 0755 home is not treated as a grant or rejected as private; foreign identity pointers stop before rotation/launch", async t => {
  const root = await fixture(t), home = join(root, "actual-home");
  await mkdir(home, { mode: 0o755 });
  const first = { publicRecord: "{}", result: { path: resolve("clients/vscode-host/foreign-identity.json"),
    sha256: "0".repeat(64), profileSha256: "0".repeat(64) } };
  await writeFile(join(root, "native-identity-first.json"), JSON.stringify(first), { mode: 0o600 });
  const before = (await readdir(root)).sort();
  await assert.rejects(verifyInstalledNativeTrashRecoveryLifecycle({
    root, fixture: { root, port: 9222, coldComponent: { root: `${root}/library` } }, installed: root,
    payloadBuildId: "0".repeat(64), sourceFixture: { root: `${root}/library` }, first,
    editor: process.execPath, cliArgs: [], env: {}, short: root, python: process.execPath,
    uiScript: join(root, "unused.py"), nativeHome: home, stop() { throw new Error("No process exists to stop"); },
  }), { code: "TRASH_RECOVERY_ACTUAL_IDENTITY_PATH_REQUIRED" });
  assert.deepEqual((await readdir(root)).sort(), before);
});
