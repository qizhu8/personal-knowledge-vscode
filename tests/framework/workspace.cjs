"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const REPORT_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 16 * 1024;

function outsideCheckout(repositoryRoot, directory) {
  const root = fs.realpathSync(repositoryRoot);
  const target = fs.realpathSync(directory);
  const relative = path.relative(root, target);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    throw new Error("Test data must be outside the checkout.");
  return target;
}

function createWorkspace(repositoryRoot, parent = os.tmpdir()) {
  parent = outsideCheckout(repositoryRoot, parent);
  const directory = fs.mkdtempSync(path.join(parent, "pkm-test-"));
  fs.chmodSync(directory, 0o700);
  const token = randomUUID();
  const identity = fs.lstatSync(directory);
  fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ token }), { flag: "wx", mode: 0o600 });
  const record = { directory, token, dev: identity.dev, ino: identity.ino, uid: identity.uid };
  const workspace = restoreWorkspace(record);
  for (const name of ["tmp", "upper", "overlay-work"])
    fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  return workspace;
}

function registerWorkspace(record) {
  if (process.env.PKM_TEST_SUPERVISOR_FD)
    fs.writeSync(Number(process.env.PKM_TEST_SUPERVISOR_FD), JSON.stringify({ type: "workspace", record }) + "\n");
}

function restoreWorkspace(record) {
  const { directory, token } = record;
  if (!path.isAbsolute(directory) || typeof token !== "string" || !token.length
      || !["dev", "ino", "uid"].every(key => Number.isSafeInteger(record[key])))
    throw new Error("Invalid test workspace identity.");
  const identity = { dev: record.dev, ino: record.ino, uid: record.uid };
  let active = false;
  function validate() {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino
        || stat.uid !== identity.uid || (process.getuid && stat.uid !== process.getuid())
        || JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")).token !== token)
      throw new Error(`Workspace ownership changed; refusing cleanup: ${directory}`);
  }
  validate();
  registerWorkspace(record);
  return {
    directory, token, record: Object.freeze({ ...record }), validate,
    start() {
      if (active) throw new Error("Workspace already has an active test process.");
      active = true;
    },
    stopped() { active = false; },
    cleanup() {
      if (active) throw new Error(`Cannot remove an active test workspace: ${directory}`);
      validate();
      function prepare(entry) {
        const info = fs.lstatSync(entry);
        if (info.dev !== identity.dev || info.uid !== identity.uid)
          throw new Error(`Foreign filesystem or owner in test workspace: ${entry}`);
        if (!info.isDirectory() || info.isSymbolicLink()) return;
        // Permission-denied fixtures must remain locked until assertions and process shutdown finish.
        if ((info.mode & 0o700) !== 0o700) fs.chmodSync(entry, info.mode | 0o700);
        for (const name of fs.readdirSync(entry)) prepare(path.join(entry, name));
      }
      prepare(directory);
      fs.rmSync(directory, { recursive: true });
    },
  };
}

function writeFailure(repositoryRoot, report, reportDirectory) {
  const id = createHash("sha256").update(fs.realpathSync(repositoryRoot)).digest("hex").slice(0, 12);
  const directory = reportDirectory || process.env.PKM_TEST_REPORTS
    || path.join(os.homedir(), ".cache", "pkm-tests", id);
  let ancestor = path.resolve(directory);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  outsideCheckout(repositoryRoot, ancestor);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  outsideCheckout(repositoryRoot, directory);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Report directory must not be a symlink.");
  const bounded = { ...report };
  for (const key of ["error", "cleanupError"]) if (bounded[key]) bounded[key] = bounded[key].slice(0, 4096);
  let text = JSON.stringify(bounded, null, 2) + "\n";
  while (Buffer.byteLength(text) > REPORT_LIMIT) {
    const key = bounded.stdout.length >= bounded.stderr.length ? "stdout" : "stderr";
    if (!bounded[key].length) throw new Error("Failure metadata exceeds the report size limit.");
    const length = Math.floor(bounded[key].length / 2);
    bounded[key] = length ? bounded[key].slice(-length) : "";
    text = JSON.stringify(bounded, null, 2) + "\n";
  }
  const temporary = path.join(directory, `failure-${randomUUID()}.tmp`);
  const destination = path.join(directory, "last-failure.json");
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}

async function executeSuite(suite, options) {
  const { repositoryRoot, temporaryParent, reportDirectory, signal } = options;
  const timeoutMs = options.timeoutMs ?? suite.timeoutMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Test timeout must be a positive integer.");
  const started = Date.now();
  const workspace = options.workspace || createWorkspace(repositoryRoot, temporaryParent);
  const result = {
    suite: suite.name, scope: "isolated fixture regression, not production or native upgrade acceptance",
    status: "failed", outcome: "failed", code: null, signal: null, timedOut: false,
    workspace: workspace.directory, cleaned: false, stdout: "", stderr: "",
  };
  let child, timer, force;
  try {
    if (process.platform !== "linux") { result.outcome = "blocked"; throw new Error("Isolated test runs currently require Linux; no uncontained fallback."); }
    if (signal?.aborted) { result.outcome = "cancelled"; throw new Error("Test run cancelled before launch."); }
    options.preparedWorkspace?.validate();
    for (const file of suite.requires || []) {
      if (!fs.existsSync(path.join(repositoryRoot, file))
          && !(options.preparedWorkspace && fs.existsSync(path.join(options.preparedWorkspace.directory, "upper", file)))) {
        result.outcome = "blocked";
        throw new Error(`Missing prerequisite ${file}; run the documented build/setup first.`);
      }
    }
    workspace.start();
    const inheritedEnvironment = { ...process.env, ...options.environment };
    delete inheritedEnvironment.NODE_TEST_CONTEXT;
    const command = [...suite.command];
    if (path.basename(command[0]).replace(/\.exe$/, "") === "node" && command.includes("--test")
        && !command.some(argument => argument.startsWith("--test-reporter")))
      command.splice(1, 0, "--test-reporter=tap");
    child = spawn("/usr/bin/python3", [
      "-I", "-B", path.join(__dirname, "isolate.py"), "--checkout", repositoryRoot, "--", ...command,
    ], {
      cwd: repositoryRoot,
      env: {
        ...inheritedEnvironment,
        PKM_TEST_SUPERVISOR_FD: "",
        PKM_TEST_COORDINATOR_PID: String(process.pid),
        PKM_TEST_WORKSPACE: workspace.directory, PKM_TEST_WORKSPACE_TOKEN: workspace.token,
        PKM_TEST_SUBSCRIPTION_RAM: suite.fixtures?.subscriptionRam ? "1" : "",
        PKM_TEST_PREPARED_ROOT: options.preparedWorkspace?.directory || "",
        PKM_TEST_PREPARED_TOKEN: options.preparedWorkspace?.token || "",
        TMPDIR: path.join(workspace.directory, "tmp"), TMP: path.join(workspace.directory, "tmp"),
        TEMP: path.join(workspace.directory, "tmp"), PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), tapFailures = Buffer.alloc(0);
    const decoder = new StringDecoder("utf8");
    let pending = "", capturingFailure = false;
    const tail = (previous, chunk) => Buffer.from(Buffer.concat([previous, chunk]).subarray(-OUTPUT_LIMIT));
    child.stdout.on("data", chunk => {
      stdout = tail(stdout, chunk);
      if (tapFailures.length >= 4096) return;
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (/^\s*not ok \d+(?:\s|$)/.test(line)) capturingFailure = true;
        if (capturingFailure)
          tapFailures = Buffer.from(Buffer.concat([tapFailures, Buffer.from(line + "\n")]).subarray(0, 4096));
        if (/^\s*\.\.\.\s*$/.test(line)) capturingFailure = false;
        if (tapFailures.length >= 4096) { pending = ""; break; }
      }
      pending = pending.slice(-OUTPUT_LIMIT);
    });
    child.stderr.on("data", chunk => { stderr = tail(stderr, chunk); });
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    signal?.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, termination) => { result.code = code; result.signal = termination; resolve(); });
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", stop);
      result.stdout = stdout.toString("utf8");
      result.stderr = stderr.toString("utf8");
      result.tapFailures = tapFailures.toString("utf8");
    }
    workspace.stopped();
    if (signal?.aborted) { result.outcome = "cancelled"; throw new Error("Test run cancelled."); }
    if (result.timedOut) { result.outcome = "timed_out"; throw new Error(`Test exceeded its ${timeoutMs}ms deadline.`); }
    if (result.code !== 0) throw new Error(`Test exited with ${result.code ?? result.signal}.`);
    result.status = "passed";
    result.outcome = "passed";
  } catch (error) {
    result.error = error.message;
    if (!child?.pid) workspace.stopped();
  } finally {
    if (options.retainSuccessfulWorkspace && result.status === "passed") result.retainedForPlan = true;
    else {
      try { workspace.cleanup(); result.cleaned = true; }
      catch (error) { result.cleanupError = error.message; result.status = "failed"; result.outcome = "cleanup_error"; }
    }
    result.durationMs = Date.now() - started;
  }
  if (result.status !== "passed" && !options.aggregateReport) result.report = writeFailure(repositoryRoot, result, reportDirectory);
  return result;
}

module.exports = { createWorkspace, restoreWorkspace, executeSuite, outsideCheckout };
