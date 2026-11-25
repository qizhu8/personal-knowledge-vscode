import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import * as statusRoom from "./installed-native-room.mjs";
import {
  prepareInstalledNativeRoomLiveCredentials, installedNativeRoomLiveCallerEnvironment,
  observeInstalledNativeRoomLiveActivation, prepareInstalledNativeRoomLiveFixture,
  verifyInstalledNativeRoomLive, verifyInstalledNativeRoomLiveRestored, installedNativeRoomLiveUiSteps,
} from "./installed-native-room-live.mjs";
import { installedNativeRoomLiveUiProgram, startInstalledNativeRoomLiveUi } from "./installed-native-room-live-ui.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run fixture helper checks in the existing private Linux framework.");
const python = execFileSync("python3", ["-I", "-B", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const legacyVsix = process.env.PKM_LEGACY_VSIX || resolve("../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
async function fixture(t) {
  const directory = resolve(".migration-test-work", `installed-room-live-check-${randomUUID()}`);
  const root = join(directory, `.installed-host-${randomUUID()}`), installed = join(root, "x/pkm-nonproduction.pkm-v5-0.1.0");
  await mkdir(join(installed, "dist"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Exact build bytes as a guard input only, not a CLI installation or an acceptance receipt.
  await copyFile(resolve("clients/vscode-host/package.json"), join(installed, "package.json"));
  await copyFile(resolve("clients/vscode-host/dist/extension.cjs"), join(installed, "dist/extension.cjs"));
  return { root, installed };
}
test("live preparation blocks an unavailable original requested-input observer before any editor or key access", async t => {
  const f = await fixture(t);
  if (statusRoom.installedNativeRoomRequestedCredentialProtocol !== "pkm.installed-native-room-requested-credential/v1") {
    await assert.rejects(prepareInstalledNativeRoomLiveCredentials({ ...f, legacyVsix }),
      { code: "INSTALLED_ROOM_LIVE_REQUESTED_SECRET_OBSERVER_UPGRADE_REQUIRED" });
    assert.deepEqual(await readdir(f.root), ["x"]);
    assert.throws(() => observeInstalledNativeRoomLiveActivation(f),
      { code: "INSTALLED_ROOM_LIVE_REQUESTED_SECRET_OBSERVER_UPGRADE_REQUIRED" });
  } else {
    const value = await prepareInstalledNativeRoomLiveCredentials({ ...f, legacyVsix });
    const transient = installedNativeRoomLiveCallerEnvironment(value), raw = Object.values(transient)[0];
    assert.equal(createHash("sha256").update(raw).digest("hex"), value.requestedJoinSecretSha256);
    assert(!JSON.stringify(value).includes(raw));
    assert(!(await readFile(join(f.root, "native-room-credential-intent.json"), "utf8")).includes(raw));
    assert.equal((await readdir(f.root)).includes("native-room-created-credentials.json"), false);
  }
});
test("copied intent/resource/recovery DTOs and supplied success-like callbacks cannot qualify the installed live leaf", async () => {
  assert.throws(() => installedNativeRoomLiveCallerEnvironment({ kind: "pkm.installed-native-room-live-credentials/v1" }),
    { code: "INSTALLED_ROOM_LIVE_ACTUAL_CREDENTIAL_PREPARATION_REQUIRED" });
  await assert.rejects(prepareInstalledNativeRoomLiveFixture({ credentialPreparation: {} }),
    { code: "INSTALLED_ROOM_LIVE_ACTUAL_CREDENTIAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeRoomLive({ sourceFixture: {}, component: { passed: true, roomLive: () => true } }),
    { code: "INSTALLED_ROOM_LIVE_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeRoomLiveRestored({}, { retirement: { passed: true }, restored: { passed: true } }),
    { code: "INSTALLED_ROOM_LIVE_ACTUAL_PREPARATION_REQUIRED" });
});
test("the live UI plan requires separate explicit effects and forbids Host reproof inside a current effect", () => {
  const steps = installedNativeRoomLiveUiSteps();
  const hosts = steps.flatMap(step => (step.dialogs || []).filter(dialog => dialog.kind === "host").map(() => step));
  assert.deepEqual(hosts.map(step => step.stage), ["native-room-live-open-deny","native-room-live-open-flow",
    "native-room-live-open-expiry","native-room-live-open-revoke"]);
  const networks = steps.flatMap(step => (step.dialogs || []).filter(dialog => dialog.kind === "network").map(() => step.session));
  assert.deepEqual(networks, ["flow","expiry","revoke"]);
  assert(steps.some(step => step.stage === "native-room-live-refuse-final" && step.kind === "quiet"));
  assert(steps.some(step => step.stage === "native-room-live-expired-refusal" && step.kind === "quiet"));
  assert(steps.findIndex(step => step.stage === "native-room-live-expired-refusal")
    < steps.findIndex(step => step.stage === "native-room-live-open-revoke"));
  assert.equal(steps.filter(step => step.kind === "revoke").length, 1);
  assert(steps.some(step => step.stage === "native-room-live-join-flow-replay"
    && step.dialogs.some(dialog => dialog.title.includes("chat_join"))));
  assert(!JSON.stringify(steps).includes("pkchat:v1:"));
});
test("the owned actual-renderer driver compiles without launching an editor, and unsafe startup is rejected", async () => {
  execFileSync(python, ["-I", "-B", "-c", "import sys;compile(sys.stdin.read(),'<installed-room-live-ui>','exec')"],
    { input: installedNativeRoomLiveUiProgram, timeout: 10000, stdio: ["pipe","pipe","pipe"] });
  await assert.rejects(startInstalledNativeRoomLiveUi({ root: resolve("."), python, port: 9222 }),
    { code: "INSTALLED_ROOM_LIVE_PRIVATE_DRIVER_REQUIRED" });
});
