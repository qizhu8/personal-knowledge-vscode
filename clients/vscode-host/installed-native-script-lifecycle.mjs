import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  installedNativeScriptPrivacyPolicy, prepareInstalledNativeScriptFixture, verifyInstalledNativeScriptHostDenied,
  verifyInstalledNativeScript, verifyInstalledNativeScriptB1, verifyInstalledNativeScriptRestored,
} from "./installed-native-script.mjs";
import { startInstalledNativeScriptUi, stageInstalledNativeScriptHost } from "./installed-native-script-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

export const installedNativeScriptEpochMarkerSchema = "pkm.installed-native-script-epoch-effects/v1";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function childResult(child, name) {
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null
      ? resolve({ code, signal }) : reject(new Error(`${name} exited ${code}/${signal}`)));
  });
  void done.catch(() => {});
  return done;
}
function filename(mode, runId, suffix) { return `native-script-${mode}-${runId}-${suffix}.json`; }
export function installedNativeScriptDriverContract(mode, runId) {
  if (!["deny", "approve"].includes(mode) || !/^[a-f0-9-]{36}$/.test(runId))
    fail("INSTALLED_SCRIPT_EPOCH_SELECTOR_REQUIRED");
  return Object.freeze({
    nativeScriptSegment: mode, nativeScriptEpochRunId: runId,
    nativeScriptMarkers: Object.freeze({ attach: `native-script-${mode}-attached.json`,
      effects: `native-script-${mode}-effects.json`, ui: `ui-native-script-${mode}-passed.json` }),
  });
}
export async function rotateInstalledNativeScriptEpochMarkers({ root, mode, runId }) {
  installedNativeScriptDriverContract(mode, runId);
  await u.privateDirectory(root, "INSTALLED_SCRIPT_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))) fail("INSTALLED_SCRIPT_PRIVATE_DRIVER_REQUIRED");
  const directory = join(root, filename(mode, runId, "prior-markers").replace(/\.json$/, ""));
  const members = [];
  for (const name of ["electron-passed.json", "ui-stage.json", "ui-passed.json", "ui-cold-passed.json",
    `native-script-${mode}-attached.json`, `native-script-${mode}-effects.json`, `ui-native-script-${mode}-passed.json`]) {
    let stat;
    try { stat = await lstat(join(root, name)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid())
      fail("INSTALLED_SCRIPT_OWNED_MARKER_REQUIRED");
    members.push(name);
  }
  await mkdir(directory, { mode: 0o700 });
  for (const name of members) await rename(join(root, name), join(directory, name));
  return directory;
}
async function waitJson(path, { timeoutMs = 120000, check = () => {} } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    check();
    try {
      const value = JSON.parse(await readFile(path));
      if (value.failed || value.passed === false) throw new Error(`Script lifecycle marker failed: ${path}`);
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(25);
  }
  throw new Error(`Script lifecycle marker timed out: ${path}`);
}
function checkMarker(value, epoch) {
  assert.equal(value.segment, epoch.mode); assert.equal(value.passed, true);
  assert.equal(value.runId, epoch.runId);
  assert.equal(value.sourceRoot, epoch.component.root);
}

/**
 * Two whole-editor lifetimes in one coordinator process. Generic UI owns Attach only;
 * this module owns actual Script Host observers, component close, and typed B1/B0 calls.
 */
export async function verifyInstalledNativeScriptLifecycle({ root, fixture, installed, payloadBuildId,
  editor, cliArgs, env, short, python, uiScript, nativeHome, stop, timeoutMs = 180000 }) {
  if (fixture?.nativeScript !== true || !isAbsolute(editor ?? "") || !isAbsolute(python ?? "")
    || !isAbsolute(uiScript ?? "") || !isAbsolute(nativeHome ?? "") || !Array.isArray(cliArgs)
    || typeof stop !== "function" || !Number.isSafeInteger(fixture.port) || fixture.port < 1 || fixture.port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    fail("INSTALLED_SCRIPT_LIFECYCLE_INPUT_REQUIRED");
  for (const key of ["nativeMemory", "nativeTodoAssignment", "nativeManagedTask", "nativePrivateResourceRecovery", "nativeOriginalTrash"])
    if (fixture[key]) fail("INSTALLED_SCRIPT_READONLY_PROFILE_REQUIRED");
  await u.privateDirectory(root, "INSTALLED_SCRIPT_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))) fail("INSTALLED_SCRIPT_PRIVATE_DRIVER_REQUIRED");
  const first = await waitJson(join(root, "native-identity-first.json"));
  const member = relative(root, first.result?.path ?? "");
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || await realpath(first.result.path) !== first.result.path)
    fail("INSTALLED_SCRIPT_ENROLLED_PROFILE_REQUIRED");
  const identity = await u.load(installed, "original-mcp-native-identity");
  identity.verifyOriginalMcpNativeIdentity(JSON.parse(first.publicRecord), first.result.sha256, first.result.profileSha256);
  assert.equal(await readFile(first.result.path, "utf8"), first.publicRecord);
  const api = await u.load(installed, "original-mcp-cold-component");
  const inventory = await u.load(installed, "linux-legacy-writer-quiescence");
  const hostEntrySha256 = u.hash(await readFile(join(installed, "dist/extension.cjs")));
  const previousHome = process.env.HOME, epochs = [], quiescence = {}, failures = [];
  let ticket, passed = false, evidence, bootstrapPath;
  const limits = { maxEntries: 30000, maxDepth: 32, maxBytes: 1073741824, maxFileBytes: 536870912 };
  async function progress(stage) {
    const bytes = JSON.stringify({ stage });
    await writeFile(join(root, "progress.json"), bytes, { mode: 0o600 });
    await writeFile(join(root, "ui-progress.json"), bytes, { mode: 0o600 });
  }
  async function rotateMarkers(epoch) {
    epoch.rotatedMarkers = await rotateInstalledNativeScriptEpochMarkers({ root, mode: epoch.mode, runId: epoch.runId });
  }
  async function cold(epoch, phase) {
    const reports = [], until = Date.now() + 10000;
    let consecutive = 0;
    while (Date.now() < until) {
      const report = await inventory.inspectLinuxLegacyWriterQuiescence(epoch.componentFixture.root);
      reports.push(report);
      await writeFile(join(root, filename(epoch.mode, epoch.runId, `${phase}-quiescence`)), JSON.stringify({
        stableRequired: 3, reports, scope: "Unchanged strict Linux inventory; no ignored or terminated blocker",
      }), { mode: 0o600 });
      consecutive = report.blockers.length || report.allowedExtensionHostPids.length ? 0 : consecutive + 1;
      if (consecutive === 3) {
        quiescence[`${epoch.mode}-${phase}`] = { stableRequired: 3, reports };
        return;
      }
      await delay(100);
    }
    await inventory.assertLinuxLegacyWritersQuiescent(epoch.componentFixture.root);
    throw new Error(`Script ${epoch.mode}/${phase} strict inventories did not stabilize.`);
  }
  async function create(mode) {
    const base = join(nativeHome, ".local/state/pkm-v5-recovery");
    await mkdir(base, { recursive: true, mode: 0o700 });
    await u.privateDirectory(base, "INSTALLED_SCRIPT_PRIVATE_RECOVERY_BASE_REQUIRED");
    const epoch = { mode, runId: randomUUID(), componentFixture:
      await api.createOriginalMcpColdComponentFixture(join(base, `native-script-${mode}-${randomUUID()}`)),
      componentClosed: false, editorExited: false, uiExited: false };
    epochs.push(epoch);
    await cold(epoch, "preparation");
    for (const path of ["notes", "skills", "papers", ".pkm"])
      await mkdir(join(epoch.componentFixture.root, path), { recursive: true, mode: 0o700 });
    await writeFile(join(epoch.componentFixture.root, "notes/Entry.md"), "---\ntitle: Entry\n---\nReadonly Script lifecycle authority.\n", { mode: 0o600 });
    await writeFile(join(epoch.componentFixture.root, "skills/Base.md"), "---\nname: Base\n---\nReadonly original Base Skill.\n", { mode: 0o600 });
    await writeFile(join(epoch.componentFixture.root, ".pkm/content-privacy.json"),
      JSON.stringify(installedNativeScriptPrivacyPolicy), { mode: 0o600 });
    epoch.scriptFixture = await prepareInstalledNativeScriptFixture({ installed, componentFixture: epoch.componentFixture,
      legacyVsix: fixture.legacyVsix, python, heldOldScriptParser: mode === "approve" ? fixture.heldOldScriptParser : undefined });
    await cold(epoch, "b0");
    epoch.endpoint = join(nativeHome, `.ns-${randomUUID().slice(0, 8)}`);
    await mkdir(epoch.endpoint, { mode: 0o700 });
    epoch.component = await api.bootstrapOriginalMcpColdComponent(epoch.componentFixture, {
      operatorId: `installed-frozen-script-${mode}`, profileSha256: first.result.profileSha256, limits,
      attachment: { directory: epoch.endpoint, identity: JSON.parse(first.publicRecord), identitySha256: first.result.sha256,
        payloadBuildId, hostEntrySha256 },
    });
    bootstrapPath = join(dirname(first.result.path), "original-mcp-native-bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify({ schema: "pkm.original-mcp-native-bootstrap/v1",
      descriptorPath: epoch.component.attachmentDescriptorPath, descriptorSha256: epoch.component.attachmentDescriptorSha256,
      profileSha256: first.result.profileSha256 }), { mode: 0o600 });
    return epoch;
  }
  async function run(epoch, priorDenied) {
    const contract = installedNativeScriptDriverContract(epoch.mode, epoch.runId);
    const currentFixture = { ...fixture, ...contract, nativeSkillBasic: false,
      coldComponent: { root: epoch.component.root } };
    const path = join(root, filename(epoch.mode, epoch.runId, "fixture"));
    await writeFile(path, JSON.stringify(currentFixture), { mode: 0o600 });
    await rotateMarkers(epoch);
    await progress("native-cold-attach");
    epoch.app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--skip-welcome",
      "--skip-release-notes", "--password-store=basic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
      `--remote-debugging-port=${fixture.port}`, "--remote-allow-origins=http://127.0.0.1"],
    { env: { ...env, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(currentFixture) }, stdio: "inherit" });
    epoch.appDone = childResult(epoch.app, `${epoch.mode} editor`);
    epoch.genericUi = spawn(python, ["-B", uiScript, path], { env, stdio: "inherit" });
    epoch.uiDone = childResult(epoch.genericUi, `${epoch.mode} generic UI`);
    const checkChildren = () => {
      if (epoch.app.exitCode !== null || epoch.app.signalCode !== null
        || epoch.genericUi.exitCode !== null || epoch.genericUi.signalCode !== null)
        throw new Error("Editor/UI exited before this epoch's verified closed marker.");
    };
    const timer = setTimeout(() => {
      epoch.app.kill("SIGTERM"); epoch.genericUi.kill("SIGTERM");
    }, timeoutMs);
    try {
      const attach = await waitJson(join(root, contract.nativeScriptMarkers.attach), { timeoutMs, check: checkChildren });
      checkMarker(attach, epoch); assert.equal(attach.actualAttachConsent, true);
      epoch.observer = await startInstalledNativeScriptUi({ root, python, env, port: fixture.port, mode: epoch.mode,
        runId: epoch.runId, priorDenied, timeoutMs: Math.min(timeoutMs, 120000) });
      await epoch.observer.ready;
      await stageInstalledNativeScriptHost(epoch.observer, { stage: `native-script-host-${epoch.mode}`, installed, component: epoch.component });
      const result = epoch.mode === "deny"
        ? await verifyInstalledNativeScriptHostDenied({ installed, component: epoch.component,
          scriptFixture: epoch.scriptFixture, ui: epoch.observer })
        : await (async () => {
          const host = await epoch.component.complete();
          return verifyInstalledNativeScript({ root, installed, component: epoch.component, host,
            scriptFixture: epoch.scriptFixture, payloadBuildId, ui: epoch.observer, priorDenied });
        })();
      await epoch.component.close(); epoch.componentClosed = true;
      await writeFile(join(root, contract.nativeScriptMarkers.effects), JSON.stringify({
        schema: installedNativeScriptEpochMarkerSchema, runId: epoch.runId, segment: epoch.mode,
        sourceRoot: epoch.component.root, passed: true, epochVerified: true, componentClosed: true,
        actualInstalledScriptRead: epoch.mode === "approve",
        ...(epoch.mode === "deny" ? { hostDenied: true, failedEpoch: result.failedEpoch }
          : { scriptReadsVerified: true, approvedEpoch: result.approvedContext.epoch }),
      }), { mode: 0o600, flag: "wx" });
      await progress(`native-script-${epoch.mode}-effects-complete`);
      const generic = await waitJson(join(root, contract.nativeScriptMarkers.ui), { timeoutMs });
      checkMarker(generic, epoch); assert.equal(generic.actualNativeUi, true);
      await Promise.all([epoch.appDone, epoch.uiDone, epoch.observer.done]);
      assert.equal(epoch.app.exitCode, 0); assert.equal(epoch.genericUi.exitCode, 0);
      const driver = await waitJson(join(root, "electron-passed.json"), { timeoutMs });
      assert.equal(driver.passed, true, "This editor's fresh driver receipt must exist after rotation.");
      epoch.editorExited = true; epoch.uiExited = true; epoch.effects = result;
      return result;
    } finally { clearTimeout(timer); await epoch.observer?.stop(); }
  }
  try {
    process.env.HOME = nativeHome;
    const denied = await create("deny"), priorDenied = await run(denied);
    await cold(denied, "editor-closed");
    await rotateMarkers({ mode: "approve", runId: randomUUID() });
    const approved = await create("approve"), reads = await run(approved, priorDenied);
    await cold(approved, "b1");
    ticket = await api.preserveOriginalMcpColdComponentB1(approved.component);
    const b1 = Object.freeze({ kind: ticket.kind, b1Path: ticket.b1Path, b1Sha256: ticket.b1Sha256,
      entries: ticket.entries, bytes: ticket.bytes, sqliteChecks: ticket.sqliteChecks });
    const retirement = await api.retireOriginalMcpColdComponent(ticket); ticket = undefined;
    const preserved = await verifyInstalledNativeScriptB1(approved.scriptFixture, { retirement, b1 });
    const restored = await api.restoreOriginalMcpColdComponentB0(retirement);
    const restoration = await verifyInstalledNativeScriptRestored(approved.scriptFixture, { retirement, b1, restored });
    evidence = { passed: true, scope: "Two genuine installed editor lifetimes in disposable frozen Script fixtures",
      nativeScript: reads, denial: { actualHostDenied: priorDenied.actualHostDenied, failedEpoch: priorDenied.failedEpoch,
        deniedRoot: priorDenied.deniedRoot }, actualEditorExitedBeforeNextEpoch: true,
      actualEditorExitedBeforeB1: true, epochMarkersVerified: true, coldQuiescence: quiescence,
      editorExitCodes: { deny: denied.app.exitCode, approve: approved.app.exitCode },
      genericUiExitCodes: { deny: denied.genericUi.exitCode, approve: approved.genericUi.exitCode },
      currentPlan: approved.component.custody, b1, scriptPreservation: preserved, scriptRestoration: restoration,
      oldParserProof: reads.heldOldParser, noCommonNoteSkillMutationPrelude: true,
      actualProfileOrKeyringRestored: false, fullCutoverQualified: false };
    evidence.coldQuiescence = { ...quiescence, preparation: quiescence["approve-preparation"],
      b0: quiescence["approve-b0"], b1: quiescence["approve-b1"] };
    passed = true;
    return evidence;
  } catch (error) {
    failures.push(error);
    await writeFile(join(root, "native-script-lifecycle-failed.json"), JSON.stringify({
      passed: false, failed: true, error: String(error), epochs: epochs.map(epoch => ({ segment: epoch.mode,
        runId: epoch.runId, directory: epoch.componentFixture.directory, endpoint: epoch.endpoint,
        componentClosed: epoch.componentClosed, editorExitCode: epoch.app?.exitCode, uiExitCode: epoch.genericUi?.exitCode })),
      coldQuiescence: quiescence, retainedForRecovery: true, fullCutoverQualified: false,
    }), { mode: 0o600 });
    throw error;
  } finally {
    for (const epoch of [...epochs].reverse()) {
      for (const close of [() => epoch.observer?.stop(), () => stop(epoch.genericUi), () => stop(epoch.app),
        async () => { if (epoch.component && !epoch.componentClosed) { await epoch.component.close(); epoch.componentClosed = true; } }])
        try { await close(); } catch (error) { failures.push(error); }
    }
    try { await ticket?.close(); } catch (error) { failures.push(error); }
    if (passed && !failures.length) {
      try {
        for (const epoch of epochs) {
          assert.equal(epoch.componentClosed, true); assert.equal(epoch.editorExited, true); assert.equal(epoch.uiExited, true);
        }
        if (bootstrapPath) {
          const pointer = JSON.parse(await readFile(bootstrapPath)), last = epochs.at(-1).component;
          assert.equal(pointer.descriptorPath, last.attachmentDescriptorPath);
          assert.equal(pointer.descriptorSha256, last.attachmentDescriptorSha256);
          await rm(bootstrapPath);
        }
        for (const epoch of epochs) {
          if (epoch.endpoint) await rm(epoch.endpoint, { recursive: true });
          await rm(epoch.componentFixture.directory, { recursive: true });
        }
      } catch (error) { failures.push(error); }
    }
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (passed && !failures.length)
      await writeFile(join(root, "native-script-lifecycle-passed.json"), JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
    if (!passed || failures.length)
      await writeFile(join(root, "native-script-lifecycle-failed.json"), JSON.stringify({
        passed: false, failed: true, errors: failures.map(error => String(error)), cleanupUnconfirmed: true,
        epochs: epochs.map(epoch => ({ segment: epoch.mode, runId: epoch.runId,
          directory: epoch.componentFixture.directory, endpoint: epoch.endpoint, componentClosed: epoch.componentClosed,
          editorExitCode: epoch.app?.exitCode, genericUiExitCode: epoch.genericUi?.exitCode })),
        retainedForRecovery: true, fullCutoverQualified: false,
      }), { mode: 0o600 });
    if (failures.length > (passed ? 0 : 1)) throw new AggregateError(failures, "Script lifecycle cleanup failed; retain private evidence.");
  }
}
