const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { execFileSync } = require("child_process");
const { DiagnosticLog } = require("../dist/runtime/diagnostic-log");
const { ExtensionHostRegistry, loadedExtensionBuild, readInstalledExtensionBuild } = require("../dist/runtime/extension-host-runtime");
const { randomUUID } = require("crypto");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-diagnostic-"));
try {
  const first = new DiagnosticLog(directory, 10, 3);
  const second = new DiagnosticLog(directory, 10, 3);
  second.record("second");
  for (let index = 0; index < 100; index += 1) first.record("test", { index, message: "multi\nline" });
  assert.deepStrictEqual(first.latest(10).map(entry => entry.index), Array.from({ length: 10 }, (_, index) => index + 90));
  assert.deepStrictEqual(first.latest(2).map(entry => entry.index), [98, 99]);
  assert.strictEqual(second.latest(1)[0].event, "second");
  assert(fs.readdirSync(directory).filter(filename => filename.startsWith(first.writerId)).length <= 5);
  assert.throws(() => first.latest(11), RangeError);
  assert.throws(() => first.latest(0), RangeError);
  assert.throws(() => first.latest(1.5), RangeError);
  const exported = execFileSync(process.env.PYTHON || "python3", [
    path.join(__dirname, "..", "resources", "diagnostic_log.py"),
    "--directory", directory, "--writer", first.writerId, "--latest", "10",
  ], { encoding: "utf8" }).trim().split("\n").map(line => JSON.parse(line));
  assert.deepStrictEqual(exported.map(entry => entry.index), first.latest(10).map(entry => entry.index));

  const blocked = path.join(directory, "not-a-directory");
  fs.writeFileSync(blocked, "blocked");
  const unavailable = new DiagnosticLog(blocked);
  assert.doesNotThrow(() => unavailable.record("lost"));
  fs.rmSync(blocked);
  unavailable.record("recovered");
  assert.strictEqual(unavailable.latest(1)[0].dropped, 1);
  if (process.platform !== "win32") {
    const filename = fs.readdirSync(blocked)[0];
    assert.strictEqual(fs.statSync(path.join(blocked, filename)).mode & 0o777, 0o600);
  }

  const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const loggerSource = extension.slice(extension.indexOf('type LogLevel ='), extension.indexOf('\nconst log = new Logger();'));
  assert(loggerSource.includes("class Logger"));
  let now = 0;
  let heartbeat;
  let disposed = false;
  const sandbox = {
    DiagnosticLog, loadedExtensionBuild, path, process, performance: { now: () => now },
    vscode: {
      window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
      workspace: { getConfiguration: () => ({ get: () => "info" }) },
    },
    setInterval: callback => { heartbeat = callback; return { unref() {} }; },
    clearInterval: () => { disposed = true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(`${loggerSource}\nglobalThis.TestLogger = Logger;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  const logger = new sandbox.TestLogger();
  const context = { globalStorageUri: { fsPath: directory }, subscriptions: [] };
  logger.init(context);
  logger.info("test operation");
  now = 70_000;
  heartbeat();
  assert(logger.fileLog.latest(10).some(entry => entry.event === "host.heartbeat" && entry.delayMs === 10_000));
  assert(logger.fileLog.latest(10).some(entry => entry.event === "extension.log" && entry.message.includes("delayed")));
  assert.strictEqual(fs.existsSync(path.join(directory, "personal-knowledge.log")), false);
  context.subscriptions[0].dispose();
  assert(disposed);
  assert.strictEqual(logger.fileLog.latest(1)[0].event, "host.stopped");
  let clock = 1000;
  const runtimeDirectory = path.join(directory, "hosts");
  const oldBuild = "a".repeat(64), targetBuild = "b".repeat(64);
  const installation = path.join(directory, "installation");
  const oldPath = path.join(installation, "pkm-3.2.13"), newPath = path.join(installation, "pkm-3.2.14");
  for (const [filename, version, buildId] of [[oldPath, "3.2.13", oldBuild], [newPath, "3.2.14", targetBuild]]) {
    fs.mkdirSync(path.join(filename, "dist"), { recursive: true });
    fs.writeFileSync(path.join(filename, "dist", "build-info.json"), JSON.stringify({ schema: "pkm.extension-build/v1", version, buildId, builtAt: "fixture" }));
  }
  fs.writeFileSync(path.join(installation, "extensions.json"), JSON.stringify([{ identifier: { id: "uone.personal-knowledge" }, version: "3.2.14", location: { scheme: "file", path: newPath } }]));
  assert.strictEqual(readInstalledExtensionBuild(oldPath, "Uone.personal-knowledge").buildId, targetBuild, "Old hosts must resolve the newly installed version directory");
  fs.writeFileSync(path.join(installation, "extensions.json"), "{broken");
  assert.strictEqual(readInstalledExtensionBuild(oldPath, "uone.personal-knowledge"), undefined, "Do not guess the target from version directories");
  fs.rmSync(path.join(installation, "extensions.json"));
  assert.strictEqual(readInstalledExtensionBuild(oldPath, "uone.personal-knowledge").buildId, oldBuild);
  const identity = (slotId, buildId, scope = "installed") => ({ hostId: randomUUID(), slotId, scope, pid: process.pid, version: "3.2.13", buildId, builtAt: "fixture", vscodeVersion: "1.90.0" });
  const firstHost = new ExtensionHostRegistry(runtimeDirectory, identity("window-1", oldBuild), () => clock);
  const secondHost = new ExtensionHostRegistry(runtimeDirectory, identity("window-2", oldBuild), () => clock);
  const developmentHost = new ExtensionHostRegistry(runtimeDirectory, identity("development", targetBuild, "development"), () => clock);
  firstHost.heartbeat(false); secondHost.heartbeat(true); developmentHost.heartbeat(false);
  assert.strictEqual(firstHost.hosts().length, 2);
  firstHost.requestReload(targetBuild);
  assert.strictEqual(firstHost.poll(oldBuild, false), false, "Do not reload into the wrong installed build");
  assert.strictEqual(firstHost.poll(targetBuild, false), true);
  assert.strictEqual(firstHost.poll(targetBuild, false), false, "Do not replay a reload request");
  assert.strictEqual(secondHost.poll(targetBuild, true), false);
  assert.strictEqual(firstHost.progress().pending.length, 2, "Sending or accepting reload is not verification");
  assert.throws(() => secondHost.requestReload(targetBuild), /already pending/);
  firstHost.dispose();
  const successor = new ExtensionHostRegistry(runtimeDirectory, identity("window-1", targetBuild), () => clock);
  successor.heartbeat(false);
  assert.strictEqual(successor.progress().verified.length, 0, "Loading a new build is not proof that background migrations finished");
  successor.heartbeat(false, "ready", "failed");
  assert.strictEqual(successor.progress().verified.length, 0, "Failed migrations must never acknowledge a successful upgrade");
  successor.heartbeat(false, "ready", "ready");
  assert.strictEqual(successor.progress().verified.length, 1);
  successor.heartbeat(false, "ready", "pending");
  assert.strictEqual(successor.progress().verified.length, 0, "An old ack cannot verify a successor whose readiness regressed");
  successor.heartbeat(false, "ready", "ready");
  assert.strictEqual(successor.poll(targetBuild, false), false, "New hosts must not enter a reload loop");
  assert.strictEqual(secondHost.poll(targetBuild, false), true, "Busy hosts can reload once idle");
  clock += 301_000;
  assert.strictEqual(successor.progress(), undefined);
  assert.strictEqual(successor.hosts().length, 0, "Stale heartbeats are not online hosts");
  console.log("Diagnostic logs: bounded tail, writer isolation, validation and disk failure OK");
  console.log("Host coordination: installation isolation, busy deferral, build verification, successor acknowledgement and expiry OK");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}