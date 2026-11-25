import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import {
  reopenInstalledNativeTrashLifecycleRecovery, verifyInstalledNativeTrashLifecycleRecoveryEpoch,
  closeInstalledNativeTrashLifecycleRecoveryEpoch,
} from "./installed-native-trash-lifecycle.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

function fail(code, detail = code) { throw Object.assign(new Error(detail), { code }); }
function inside(root, path) {
  const member = relative(root, path);
  return !!member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member);
}
async function safeFile(root, path) {
  if (!inside(root, path) || await realpath(path) !== path) fail("TRASH_RECOVERY_OWNED_FILE_REQUIRED");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1)
    fail("TRASH_RECOVERY_OWNED_FILE_REQUIRED");
  return stat;
}
async function waitJson(path, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(path)); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail("TRASH_RECOVERY_EVIDENCE_TIMEOUT", `Recovery evidence timed out: ${path}`);
}
function track(child, label) {
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null ? resolve(0)
      : reject(Object.assign(new Error(`${label} exited ${code}/${signal}`), { code: "TRASH_RECOVERY_PROCESS_FAILED", exitCode: code, signal })));
  });
  void done.catch(() => {});
  return done;
}
const rotatable = [
  "electron-passed.json", "ui-stage.json", "ui-passed.json",
  "ui-cold-passed.json",
  "native-trash-recovery-deny-effects.json", "native-trash-recovery-approve-effects.json",
  "ui-trash-recovery-deny-passed.json", "ui-trash-recovery-approve-passed.json",
];
async function rotateMarkers(root, decision, runId) {
  const archive = join(root, `trash-recovery-${decision}-${runId}-previous`);
  await mkdir(archive, { mode: 0o700 });
  const files = [];
  for (const name of rotatable) {
    const source = join(root, name);
    let stat;
    try { stat = await lstat(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await safeFile(root, source);
    const bytes = await readFile(source);
    await u.absent(join(archive, name), "TRASH_RECOVERY_MARKER_ARCHIVE_COLLISION");
    await rename(source, join(archive, name));
    files.push({ name, sha256: u.hash(bytes), previousInode: stat.ino });
  }
  await writeFile(join(archive, "rotation.json"), JSON.stringify({ decision, runId, files }), { mode: 0o600, flag: "wx" });
  return { archive, files };
}
/** Two actual editor lifetimes only. Parent must have verified pending effects and closed the first complete lifetime. */
export async function verifyInstalledNativeTrashRecoveryLifecycle({
  root, fixture, installed, payloadBuildId, sourceFixture, first,
  editor, cliArgs, env, short, python, uiScript, nativeHome, stop,
}) {
  await u.privateDirectory(root, "TRASH_RECOVERY_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(root.split(sep).at(-1)) || fixture?.root !== root
    || !isAbsolute(installed ?? "") || !isAbsolute(editor ?? "") || !isAbsolute(python ?? "")
    || !isAbsolute(uiScript ?? "") || !isAbsolute(nativeHome ?? "") || !isAbsolute(short ?? "")
    || !Array.isArray(cliArgs) || cliArgs.some(arg => typeof arg !== "string") || typeof stop !== "function"
    || !/^[a-f0-9]{64}$/.test(payloadBuildId ?? "") || !sourceFixture?.root
    || fixture.coldComponent?.root !== sourceFixture.root || !Number.isSafeInteger(fixture.port) || fixture.port < 1 || fixture.port > 65535)
    fail("TRASH_RECOVERY_COORDINATOR_BINDING_REQUIRED");
  const home = await lstat(nativeHome);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid() || home.mode & 0o002
    || await realpath(nativeHome) !== nativeHome) fail("TRASH_RECOVERY_ACTUAL_HOME_REQUIRED");
  const diskFirst = JSON.parse(await readFile(join(root, "native-identity-first.json")));
  assert.deepEqual(first, diskFirst, "The actual first installed enrollment record must be retained.");
  if (!inside(root, first.result?.path ?? "") || await realpath(first.result.path) !== first.result.path)
    fail("TRASH_RECOVERY_ACTUAL_IDENTITY_PATH_REQUIRED");
  await safeFile(root, first.result.path);
  const identity = JSON.parse(first.publicRecord);
  (await u.load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(identity, first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  const firstProof = JSON.parse(await readFile(join(root, "native-identity-passed.json")));
  assert.equal(firstProof.passed, true); assert.equal(firstProof.realInstalledExtension, true);
  assert.equal(firstProof.identitySha256, first.result.sha256);
  const priorDriver = JSON.parse(await readFile(join(root, "electron-passed.json")));
  const priorUi = JSON.parse(await readFile(join(root, "ui-cold-passed.json")));
  assert.equal(priorDriver.passed, true); assert.equal(priorUi.passed, true);
  const hostEntrySha256 = u.hash(await readFile(join(installed, "dist/extension.cjs")));
  const inventory = await u.load(installed, "linux-legacy-writer-quiescence");
  const strictQuiescence = {}, decisions = [], editorExitCodes = [], genericUiExitCodes = [], rotations = [], endpoints = [];
  let app, ui, epoch, deadline, appDone, uiDone, completed;
  const failures = [];
  const quiescent = async phase => {
    const reports = [], until = Date.now() + 10000;
    let consecutive = 0;
    while (Date.now() < until) {
      const report = await inventory.inspectLinuxLegacyWriterQuiescence(sourceFixture.root);
      reports.push(report);
      consecutive = report.blockers.length === 0 && report.allowedExtensionHostPids.length === 0 ? consecutive + 1 : 0;
      await writeFile(join(root, `native-trash-recovery-${phase}-quiescence.json`), JSON.stringify({
        scope: "strict original guard; no ignored or terminated unrelated processes",
        stableRequired: 3, zeroAllowedExtensionHostsRequired: true, reports,
      }), { mode: 0o600 });
      if (consecutive === 3) { strictQuiescence[phase] = { stableRequired: 3, reports }; return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail("TRASH_RECOVERY_NOT_QUIESCENT", `Recovery ${phase} requires three consecutive zero-blocker/zero-allowed-host inventories.`);
  };
  const progress = async stage => {
    const bytes = JSON.stringify({ stage });
    await writeFile(join(root, "progress.json"), bytes, { mode: 0o600 });
    await writeFile(join(root, "ui-progress.json"), bytes, { mode: 0o600 });
  };
  try {
    for (const decision of ["deny", "approve"]) {
      await quiescent(`${decision}-before-reopen`);
      const runId = randomUUID();
      rotations.push(await rotateMarkers(root, decision, runId));
      const directory = join(nativeHome, `.tr-ipc-${randomUUID().slice(0, 8)}`);
      if (Buffer.byteLength(join(directory, "n")) >= 108) fail("TRASH_RECOVERY_IPC_PATH_TOO_LONG");
      await mkdir(directory, { mode: 0o700 }); endpoints.push(directory);
      await u.privateDirectory(directory, "TRASH_RECOVERY_PRIVATE_IPC_REQUIRED");
      epoch = await reopenInstalledNativeTrashLifecycleRecovery({
        installed, sourceFixture,
        attachment: { directory, identity, identitySha256: first.result.sha256, payloadBuildId, hostEntrySha256 },
      });
      const bootstrap = epoch.bootstrap;
      await writeFile(join(dirname(first.result.path), "original-mcp-native-bootstrap.json"), JSON.stringify({
        schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath: bootstrap.attachmentDescriptorPath,
        descriptorSha256: bootstrap.attachmentDescriptorSha256, profileSha256: first.result.profileSha256,
      }), { mode: 0o600 });
      const epochFixture = { ...fixture, nativeOriginalTrashRecoveryEpoch: decision, nativeTrashRecoveryRunId: runId,
        coldComponent: { ...fixture.coldComponent, root: bootstrap.root } };
      const path = join(root, `native-trash-recovery-${decision}-${runId}-fixture.json`);
      await writeFile(path, JSON.stringify(epochFixture), { mode: 0o600, flag: "wx" });
      await progress(`native-trash-recovery-${decision}-attach`);
      const startedAt = Date.now();
      app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`,
        "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates",
        "--skip-welcome", "--skip-release-notes", "--password-store=basic",
        "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
        `--remote-debugging-port=${fixture.port}`, "--remote-allow-origins=http://127.0.0.1"], {
        env: { ...env, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(epochFixture) }, stdio: "inherit",
      });
      appDone = track(app, `Trash recovery ${decision} editor`);
      ui = spawn(python, ["-B", uiScript, path], { env, stdio: "inherit" });
      uiDone = track(ui, `Trash recovery ${decision} generic UI`);
      const currentApp = app, currentUi = ui;
      deadline = setTimeout(() => { void stop(currentApp); void stop(currentUi); }, 180000);
      const work = (async () => {
        const evidence = await verifyInstalledNativeTrashLifecycleRecoveryEpoch({
          root, installed, sourceFixture, epoch, decision, python, env, port: fixture.port, timeoutMs: 120000,
        });
        await closeInstalledNativeTrashLifecycleRecoveryEpoch(epoch); epoch = undefined;
        const receipt = { passed: true, decision, runId, sourceRoot: bootstrap.root, epochClosed: true };
        await writeFile(join(root, `native-trash-recovery-${decision}-effects.json`), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
        await progress(`native-trash-recovery-${decision}-complete`);
        return evidence;
      })();
      void work.catch(() => { void stop(currentApp); void stop(currentUi); });
      const results = await Promise.allSettled([work, appDone, uiDone]);
      clearTimeout(deadline); deadline = undefined;
      const rejected = results.filter(value => value.status === "rejected").map(value => value.reason);
      if (rejected.length) throw new AggregateError(rejected, `Trash recovery ${decision} lifetime failed.`);
      assert.equal(currentApp.exitCode, 0); assert.equal(currentUi.exitCode, 0);
      const effectsPath = join(root, `native-trash-recovery-${decision}-effects.json`);
      const uiPath = join(root, `ui-trash-recovery-${decision}-passed.json`);
      const effect = await waitJson(effectsPath), generic = await waitJson(uiPath);
      for (const evidence of [effect, generic]) {
        assert.equal(evidence.passed, true); assert.equal(evidence.decision, decision); assert.equal(evidence.runId, runId);
        assert.equal(evidence.sourceRoot, bootstrap.root);
      }
      assert.equal(effect.epochClosed, true);
      const driverStat = await safeFile(root, join(root, "electron-passed.json"));
      assert(driverStat.mtimeMs >= startedAt, "A fresh actual driver receipt is required for this editor lifetime.");
      assert.equal(JSON.parse(await readFile(join(root, "electron-passed.json"))).passed, true);
      decisions.push({ decision, runId, sourceRoot: bootstrap.root, effects: effect, ui: generic,
        evidence: results[0].value });
      editorExitCodes.push(0); genericUiExitCodes.push(0); app = ui = undefined;
      await quiescent(`${decision}-after-close`);
    }
    completed = { passed: true, decisions, editorExitCodes, genericUiExitCodes, strictQuiescence,
      rotations, sameRetainedB0AndCustody: true, fullCutoverQualified: false };
  } catch (error) {
    failures.push(error);
    await writeFile(join(root, "native-trash-recovery-runner-failure.json"), JSON.stringify({
      passed: false, code: error.code ?? "TRASH_RECOVERY_LIFECYCLE_FAILED", message: error.message,
      retainedSourceRoot: sourceFixture.root,
    }), { mode: 0o600 }).catch(writeError => failures.push(writeError));
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const close of [() => ui ? stop(ui) : undefined, () => app ? stop(app) : undefined,
      async () => { if (epoch) { await closeInstalledNativeTrashLifecycleRecoveryEpoch(epoch); epoch = undefined; } }]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (app || ui) {
      const ended = await Promise.allSettled([...(appDone ? [appDone] : []), ...(uiDone ? [uiDone] : [])]);
      for (const value of ended) if (value.status === "rejected") failures.push(value.reason);
    }
    if (!epoch) for (const directory of endpoints) {
      try { await rm(directory, { recursive: true }); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw Object.assign(new AggregateError(failures, "Trash recovery lifecycle failed; Root and evidence retained."),
    { code: "TRASH_RECOVERY_LIFECYCLE_FAILED" });
  return completed;
}
