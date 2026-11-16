"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { createWorkspace } = require("./workspace.cjs");
const { reference } = require("./report.cjs");

async function runSupervised(plan, options) {
  if (process.platform !== "linux" || process.getuid() === 0)
    throw new Error("Supervised test execution requires non-admin Linux; native Windows/macOS gates remain separate.");
  const workspace = createWorkspace(options.repositoryRoot, options.temporaryParent);
  const metadata = {
    workspace: workspace.record, coordinatorPid: process.pid, repositoryRoot: options.repositoryRoot, profile: plan.profile,
    fingerprint: plan.fingerprint, selected: plan.entries.length,
    recovery: path.join(__dirname, "recover.cjs"), reportDirectory: options.reportDirectory,
  };
  let result, buffer = "", stderr = "", ready = false, requestedStop = false, protocolError;
  const decoder = new StringDecoder("utf8");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn("/usr/bin/python3", ["-I", "-B", path.join(__dirname, "supervise.py"), JSON.stringify(metadata),
    process.execPath, path.join(__dirname, "worker.cjs")], { stdio: ["pipe", "pipe", "pipe"], cwd: options.repositoryRoot, env: environment });
  child.stdout.on("data", chunk => {
    try {
      buffer += decoder.write(chunk);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        if (message.type === "ready") { ready = true; if (requestedStop) child.kill("SIGTERM"); }
        else if (message.type === "event") options.onEvent?.(message.event);
        else if (message.type === "result") result = message;
        else throw new Error(`Unknown supervisor message: ${message.type}`);
      }
      if (Buffer.byteLength(buffer) > 65536) throw new Error("Supervisor output message exceeds 64 KiB.");
    } catch (error) { protocolError = error; stop(); }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
  const stop = () => { requestedStop = true; if (ready) child.kill("SIGTERM"); };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  child.stdin.on("error", error => { stderr = `${stderr}\nWorker input failed: ${error.message}`.slice(-16384); });
  const { signal, onEvent, ...serializable } = options;
  child.stdin.end(JSON.stringify({ plan, options: serializable, workspace: workspace.record }));
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (protocolError) throw protocolError;
    if (buffer.trim()) throw new Error("Incomplete supervisor output message.");
    if (!result) throw new Error(`Test worker interrupted (exit ${code}); ${stderr.trim()}`);
    if (code !== 0 && result.summary.successful) throw new Error(`Test supervisor failed after worker success: ${stderr.trim()}`);
    return { summary: result.summary, report: result.report, taskReferences: plan.entries.map(entry => reference(entry.name)) };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    if (!child.pid) workspace.cleanup();
  }
}

module.exports = { runSupervised };
