import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";
import { reopenInstalledNativeTodoRecovery, verifyInstalledNativeTodoRecoveryEpoch,
  closeInstalledNativeTodoRecoveryEpoch } from "./installed-native-todo-recovery.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
function inside(root, path) {
  const member = relative(root, path);
  return !!member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member);
}
async function safeFile(root, path) {
  if (!inside(root, path) || await realpath(path) !== path) fail("TODO_RECOVERY_OWNED_FILE_REQUIRED");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1)
    fail("TODO_RECOVERY_OWNED_FILE_REQUIRED");
  return stat;
}
function track(child, label) {
  const done = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => code === 0 && signal === null ? resolve(0)
      : reject(new Error(`${label} exited ${code}/${signal}`)));
  });
  void done.catch(() => {}); return done;
}
async function rotate(root, decision, runId) {
  const directory = join(root, `todo-recovery-${decision}-${runId}-previous`); await mkdir(directory, { mode: 0o700 });
  const rotated = [];
  for (const name of ["electron-passed.json", "ui-stage.json", "ui-passed.json", "ui-cold-passed.json"]) {
    const path = join(root, name);
    try { await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await safeFile(root, path); const sha256 = u.hash(await readFile(path));
    await rename(path, join(directory, name)); rotated.push({ name, sha256 });
  }
  await writeFile(join(directory, "rotation.json"), JSON.stringify({ decision, runId, rotated }), { mode: 0o600, flag: "wx" });
  return { directory, rotated };
}
/** No first-editor shutdown is inferred here: strict inventories must prove it before either fresh epoch. */
export async function verifyInstalledNativeTodoRecoveryLifecycle({
  root, fixture, installed, payloadBuildId, sourceFixture, first, editor, cliArgs, env, short, python, uiScript, nativeHome, stop,
}) {
  await u.privateDirectory(root, "TODO_RECOVERY_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || fixture?.root !== root
    || fixture.coldComponent?.root !== sourceFixture?.root || !isAbsolute(installed ?? "") || !isAbsolute(editor ?? "")
    || !isAbsolute(python ?? "") || !isAbsolute(uiScript ?? "") || !isAbsolute(nativeHome ?? "") || !isAbsolute(short ?? "")
    || !Array.isArray(cliArgs) || cliArgs.some(value => typeof value !== "string") || typeof stop !== "function"
    || !/^[a-f0-9]{64}$/.test(payloadBuildId ?? "") || !Number.isSafeInteger(fixture.port) || fixture.port < 1 || fixture.port > 65535)
    fail("TODO_RECOVERY_COORDINATOR_BINDING_REQUIRED");
  const home = await lstat(nativeHome);
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid() || home.mode & 0o002
    || await realpath(nativeHome) !== nativeHome) fail("TODO_RECOVERY_ACTUAL_HOME_REQUIRED");
  assert.deepEqual(first, JSON.parse(await readFile(join(root, "native-identity-first.json"))));
  await safeFile(root, first.result.path);
  const identity = JSON.parse(first.publicRecord);
  (await u.load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(identity, first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  const proof = JSON.parse(await readFile(join(root, "native-identity-passed.json")));
  assert.equal(proof.passed, true); assert.equal(proof.realInstalledExtension, true); assert.equal(proof.identitySha256, first.result.sha256);
  assert.equal(JSON.parse(await readFile(join(root, "electron-passed.json"))).passed, true);
  assert.equal(JSON.parse(await readFile(join(root, "ui-cold-passed.json"))).passed, true);
  const hostEntrySha256 = u.hash(await readFile(join(installed, "dist/extension.cjs")));
  const inventory = await u.load(installed, "linux-legacy-writer-quiescence");
  const decisions = [], rotations = [], strictQuiescence = {}, endpoints = [], failures = [];
  let epoch, app, generic, appDone, genericDone, deadline;
  async function quiescent(phase) {
    const reports = [], until = Date.now() + 10000; let consecutive = 0;
    while (Date.now() < until) {
      const report = await inventory.inspectLinuxLegacyWriterQuiescence(sourceFixture.root); reports.push(report);
      consecutive = report.blockers.length === 0 && report.allowedExtensionHostPids.length === 0 ? consecutive + 1 : 0;
      await writeFile(join(root, `native-todo-recovery-${phase}-quiescence.json`),
        JSON.stringify({ stableRequired: 3, zeroAllowedExtensionHostsRequired: true, reports }), { mode: 0o600 });
      if (consecutive === 3) { strictQuiescence[phase] = reports; return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail("TODO_RECOVERY_NOT_QUIESCENT");
  }
  async function progress(stage) {
    for (const name of ["progress.json", "ui-progress.json"])
      await writeFile(join(root, name), JSON.stringify({ stage }), { mode: 0o600 });
  }
  try {
    for (const decision of ["deny", "approve"]) {
      await quiescent(`${decision}-before-reopen`);
      const runId = randomUUID(); rotations.push(await rotate(root, decision, runId));
      const directory = join(nativeHome, `.tg-ipc-${randomUUID().slice(0, 8)}`);
      if (Buffer.byteLength(join(directory, "n")) >= 108) fail("TODO_RECOVERY_IPC_PATH_TOO_LONG");
      await mkdir(directory, { mode: 0o700 }); await u.privateDirectory(directory, "TODO_RECOVERY_PRIVATE_IPC_REQUIRED");
      endpoints.push({ directory, pin: await lstat(directory) });
      epoch = await reopenInstalledNativeTodoRecovery({ installed, sourceFixture,
        attachment: { directory, identity, identitySha256: first.result.sha256, payloadBuildId, hostEntrySha256 } });
      const bootstrap = epoch.bootstrap;
      await writeFile(join(dirname(first.result.path), "original-mcp-native-bootstrap.json"), JSON.stringify({
        schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath: bootstrap.attachmentDescriptorPath,
        descriptorSha256: bootstrap.attachmentDescriptorSha256, profileSha256: first.result.profileSha256,
      }), { mode: 0o600 });
      const epochFixture = { ...fixture, nativeOriginalTodoRecoveryEpoch: decision, nativeTodoRecoveryRunId: runId,
        coldComponent: { ...fixture.coldComponent, root: bootstrap.root } };
      const path = join(root, `native-todo-recovery-${decision}-${runId}-fixture.json`);
      await writeFile(path, JSON.stringify(epochFixture), { mode: 0o600, flag: "wx" });
      await progress(`native-todo-recovery-${decision}-attach`);
      const started = Date.now();
      app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`,
        "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--skip-welcome",
        "--skip-release-notes", "--password-store=basic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
        `--remote-debugging-port=${fixture.port}`, "--remote-allow-origins=http://127.0.0.1"],
      { env: { ...env, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(epochFixture) }, stdio: "inherit" });
      appDone = track(app, `Todo recovery ${decision} editor`);
      generic = spawn(python, ["-B", uiScript, path], { env, stdio: "inherit" });
      genericDone = track(generic, `Todo recovery ${decision} generic UI`);
      const currentApp = app, currentUi = generic;
      deadline = setTimeout(() => { void stop(currentApp); void stop(currentUi); }, 180000);
      const work = (async () => {
        const evidence = await verifyInstalledNativeTodoRecoveryEpoch({ root, installed, sourceFixture, epoch,
          decision, runId, python, env, port: fixture.port, timeoutMs: 120000 });
        await closeInstalledNativeTodoRecoveryEpoch(epoch); epoch = undefined;
        await writeFile(join(root, `native-todo-recovery-${decision}-effects.json`), JSON.stringify({
          passed: true, decision, runId, sourceRoot: bootstrap.root, epochClosed: true, evidence,
        }), { mode: 0o600, flag: "wx" });
        await progress(`native-todo-recovery-${decision}-complete`); return evidence;
      })();
      void work.catch(() => { void stop(currentApp); void stop(currentUi); });
      const settled = await Promise.allSettled([work, appDone, genericDone]); clearTimeout(deadline); deadline = undefined;
      const rejected = settled.filter(value => value.status === "rejected").map(value => value.reason);
      if (rejected.length) throw new AggregateError(rejected, `Todo ${decision} editor lifetime failed.`);
      const effects = JSON.parse(await readFile(join(root, `native-todo-recovery-${decision}-effects.json`)));
      const genericProof = JSON.parse(await readFile(join(root, `ui-todo-recovery-${decision}-passed.json`)));
      for (const value of [effects, genericProof]) {
        assert.equal(value.passed, true); assert.equal(value.decision, decision); assert.equal(value.runId, runId);
        assert.equal(value.sourceRoot, bootstrap.root);
      }
      assert.equal(effects.epochClosed, true);
      const driver = await safeFile(root, join(root, "electron-passed.json"));
      assert(driver.mtimeMs >= started); assert.equal(JSON.parse(await readFile(join(root, "electron-passed.json"))).passed, true);
      assert.equal(currentApp.exitCode, 0); assert.equal(currentUi.exitCode, 0);
      decisions.push({ decision, runId, evidence: settled[0].value, effects, genericUi: genericProof });
      app = generic = undefined; appDone = genericDone = undefined;
      await quiescent(`${decision}-after-close`);
    }
  } catch (error) {
    failures.push(error);
    await writeFile(join(root, "native-todo-recovery-runner-failure.json"), JSON.stringify({
      passed: false, code: error.code ?? "TODO_RECOVERY_LIFECYCLE_FAILED", message: error.message,
      retainedSourceRoot: sourceFixture.root, noReplayPermitted: true,
    }), { mode: 0o600 }).catch(value => failures.push(value));
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const close of [() => generic ? stop(generic) : undefined, () => app ? stop(app) : undefined,
      async () => { if (epoch) { await closeInstalledNativeTodoRecoveryEpoch(epoch); epoch = undefined; } }]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    for (const result of await Promise.allSettled([...(appDone ? [appDone] : []), ...(genericDone ? [genericDone] : [])]))
      if (result.status === "rejected") failures.push(result.reason);
    if (!epoch) for (const { directory, pin } of endpoints) {
      try {
        const current = await lstat(directory);
        assert.equal(current.dev, pin.dev); assert.equal(current.ino, pin.ino); assert.equal(current.uid, pin.uid);
        await rm(directory, { recursive: true });
      } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw Object.assign(new AggregateError(failures, "Todo recovery lifecycle failed; owned Root and evidence retained."),
    { code: "TODO_RECOVERY_LIFECYCLE_FAILED" });
  return { passed: true, decisions, rotations, strictQuiescence, sameRetainedB0AndCustody: true,
    freshWholeEditorEpochs: 2, installedRecoveryQualified: true, b1AndRestoredQualified: false, fullCutoverQualified: false };
}
