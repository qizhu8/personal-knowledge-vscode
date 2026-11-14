import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const file = fileURLToPath(import.meta.url), mode = process.argv[2], directory = process.argv[3];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Boundary fixture timed out.");
    await delay(5);
  }
}
const state = pid => readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0];
const tree = `
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const [root, depth = "0"] = process.argv.slice(2);
writeFileSync(join(root, "pid-" + depth), String(process.pid));
if (+depth === 0) process.stdout.write("retained-before-crash");
if (+depth < 2) spawn(process.execPath, [process.argv[1], root, String(+depth + 1)], {stdio:"ignore"});
setInterval(() => appendFileSync(join(root, "tick-" + depth), "x"), 20);
`;
const escape = `
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const [root, role] = process.argv.slice(2);
writeFileSync(join(root, "pid-" + role), String(process.pid));
if (role === "parent") spawn(process.execPath, [process.argv[1], root, "escaped"], {detached:true, stdio:"ignore"}).unref();
if (role === "short-parent") {
  spawn(process.execPath, [process.argv[1], root, "escaped"], {detached:true, stdio:"inherit"}).unref();
  setTimeout(() => process.exit(0), 150);
}
setInterval(() => appendFileSync(join(root, "tick-" + role), "x"), 20);
`;

function legacySupervisor() {
  const require = createRequire(import.meta.url), ts = require("typescript");
  const legacyRoot = join(directory, "legacy-compiled");
  mkdirSync(join(legacyRoot, "chat"), { recursive: true }); mkdirSync(join(legacyRoot, "runtime"));
  writeFileSync(join(legacyRoot, "package.json"), '{"type":"commonjs"}');
  for (const relative of ["chat/chat-process-runtime", "runtime/cross-process-lock"]) {
    const source = readFileSync(resolve("..", "src", relative + ".ts"), "utf8");
    let output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    if (relative === "chat/chat-process-runtime") {
      const needle = 'await new Promise((resolve, reject) => {\n            worker.once("spawn", resolve);';
      assert(output.includes(needle));
      output = output.replace(needle, `exports.__fixtureWorker = worker;\n        ${needle}`);
    }
    writeFileSync(join(legacyRoot, relative + ".js"), output);
  }
  return require(join(legacyRoot, "chat/chat-process-runtime.js"));
}

async function legacyOwnerFailure() {
  const script = join(directory, "tree.mjs"), legacyRoot = join(directory, "old");
  mkdirSync(legacyRoot); writeFileSync(script, tree);
  const legacy = legacySupervisor();
  const job = await legacy.launchChatProcess(legacyRoot, randomUUID(), {
    program: process.execPath, arguments: [script, directory], cwd: directory, timeoutSeconds: 30,
  });
  await until(() => [0, 1, 2].every(n => existsSync(join(directory, `tick-${n}`))));
  const pids = [0, 1, 2].map(n => Number(readFileSync(join(directory, `pid-${n}`))));
  await until(() => legacy.getChatProcess(legacyRoot, job.handle).state === "running");
  legacy.pauseChatProcess(legacyRoot, job.handle);
  await until(() => legacy.getChatProcess(legacyRoot, job.handle).state === "paused");
  await until(() => pids.every(pid => state(pid) === "T"));
  const worker = legacy.__fixtureWorker;
  assert(worker && worker.exitCode === null && worker.signalCode === null);
  const exited = once(worker, "exit"); assert(worker.kill("SIGKILL")); await exited;
  assert.match(legacy.readChatProcessOutput(legacyRoot, job.handle, "stdout", 0, 100).text, /retained-before-crash/);
  await until(() => legacy.getChatProcess(legacyRoot, job.handle).state === "unknown", 12000);
  for (const pid of pids) assert.equal(state(pid), "T");
  assert.throws(() => legacy.cancelChatProcess(legacyRoot, job.handle), /stale|unknown/i);
}

async function controllerFailure(ownerDeath = false) {
  const dist = resolve("dist"), groupFile = join(directory, "fixture-linux-process-group.mjs");
  let groupSource = readFileSync(join(dist, "linux-process-group.js"), "utf8");
  const needle = 'if (!["pause", "resume", "cancel"].includes(message?.type) || !Number.isSafeInteger(message.id))';
  assert.equal(groupSource.split(needle).length, 3);
  groupSource = groupSource.replace(needle,
    `if (process.argv[2] === "--guardian" && message?.type === "fixture-crash-controller") { if (!anchor?.kill("SIGKILL")) throw new Error("fixture controller unavailable"); return; }
    if (message?.type === "fixture-crash-owner") {
      if (process.argv[2] === "--guardian") anchor?.send(message);
      else if (process.argv[2] === "--anchor" && !anchor?.kill("SIGKILL")) throw new Error("fixture owner unavailable");
      return;
    }\n    ${needle}`);
  const ownerNeedle = "function lifecycleOwner() {";
  assert(groupSource.includes(ownerNeedle));
  groupSource = `import { writeFileSync as fixtureWrite } from "node:fs";\n${groupSource.replace(ownerNeedle,
    `${ownerNeedle}\nprocess.on("exit", () => fixtureWrite(${JSON.stringify(join(directory, "owner-exited"))}, "exited"));`)}`;
  writeFileSync(groupFile, groupSource);
  let runtimeSource = readFileSync(join(dist, "runtime-process.js"), "utf8");
  for (const name of ["runtime-process-contracts.js", "runtime-process-store.js"]) {
    runtimeSource = runtimeSource.replaceAll(`"./${name}"`, `"${pathToFileURL(join(dist, name)).href}"`);
  }
  runtimeSource = runtimeSource.replaceAll('"./linux-process-group.js"', '"./fixture-linux-process-group.mjs"');
  const runtimeFile = join(directory, "fixture-runtime-process.mjs");
  writeFileSync(runtimeFile, runtimeSource);
  const { RuntimeProcessService, RuntimeProcessStore } = await import(pathToFileURL(runtimeFile).href);
  const db = new DatabaseSync(join(directory, "process.sqlite")), script = join(directory, "tree.mjs");
  writeFileSync(script, tree);
  const options = {
    repositoryFactory: (owner, capacity) => new RuntimeProcessStore(db, owner, capacity),
    adapters: [{ id: "fixture", executable: process.execPath, cwd: directory,
      processScope: "linux-process-group", arguments: () => [script, directory] }],
    authorizeLaunch: async () => true, limits: { graceMs: 100 },
  };
  const service = new RuntimeProcessService(options);
  const job = await service.launch({ actorId: "alice", operationId: randomUUID(), adapterId: "fixture", input: {} });
  await until(() => [0, 1, 2].every(n => existsSync(join(directory, `tick-${n}`))));
  const pids = [0, 1, 2].map(n => Number(readFileSync(join(directory, `pid-${n}`))));
  await assert.rejects(service.pause("bob", job.jobId), { code: "NOT_FOUND" });
  await service.pause("alice", job.jobId);
  await until(() => pids.every(pid => state(pid) === "T"));
  const guardian = service.tasks.get(job.jobId).group.child;
  guardian.send({ type: ownerDeath ? "fixture-crash-owner" : "fixture-crash-controller" });
  const result = await service.wait("alice", job.jobId);
  assert.equal(result.state, "INTERRUPTED"); assert.equal(result.effect, "unknown");
  assert.equal(result.reason, "supervisor-error");
  assert.match(Buffer.from(result.stdout, "base64").toString(), /retained-before-crash/);
  if (ownerDeath) {
    for (const pid of pids) assert.equal(state(pid), "T");
    assert.equal(existsSync(join(directory, "owner-exited")), false);
  } else {
    await until(() => pids.every(pid => {
      try { return state(pid) === "Z"; }
      catch (error) { if (error.code === "ENOENT") return true; throw error; }
    }));
    await until(() => existsSync(join(directory, "owner-exited")));
  }
  await service.close({ drainMs: 0 });
  const reopened = new RuntimeProcessService(options);
  assert.equal(reopened.status("alice", job.jobId).state, "INTERRUPTED");
  await reopened.close({ drainMs: 0 });
  db.close();
}

async function detachedDescendants() {
  const script = join(directory, "escape.mjs"), oldRoot = join(directory, "old"), nextRoot = join(directory, "next");
  writeFileSync(script, escape); mkdirSync(oldRoot); mkdirSync(nextRoot);
  const legacy = legacySupervisor();
  const legacyJob = await legacy.launchChatProcess(oldRoot, randomUUID(), {
    program: process.execPath, arguments: [script, oldRoot, "parent"], cwd: directory, timeoutSeconds: 30,
  });
  await until(() => ["parent", "escaped"].every(role => existsSync(join(oldRoot, `tick-${role}`))));
  await until(() => legacy.getChatProcess(oldRoot, legacyJob.handle).state === "running");
  legacy.pauseChatProcess(oldRoot, legacyJob.handle);
  await until(() => legacy.getChatProcess(oldRoot, legacyJob.handle).state === "paused");
  await delay(80);
  const oldParent = readFileSync(join(oldRoot, "tick-parent")).length;
  const oldEscaped = readFileSync(join(oldRoot, "tick-escaped")).length;
  await delay(150);
  assert.equal(readFileSync(join(oldRoot, "tick-parent")).length, oldParent);
  assert(readFileSync(join(oldRoot, "tick-escaped")).length > oldEscaped);
  legacy.resumeChatProcess(oldRoot, legacyJob.handle);
  await until(() => legacy.getChatProcess(oldRoot, legacyJob.handle).state === "running");
  await until(() => readFileSync(join(oldRoot, "tick-parent")).length > oldParent);
  legacy.pauseChatProcess(oldRoot, legacyJob.handle);
  await until(() => legacy.getChatProcess(oldRoot, legacyJob.handle).state === "paused");
  legacy.cancelChatProcess(oldRoot, legacyJob.handle);
  await until(() => legacy.getChatProcess(oldRoot, legacyJob.handle).state === "cancelled");
  const escapedAfterStop = readFileSync(join(oldRoot, "tick-escaped")).length;
  await delay(100);
  assert(readFileSync(join(oldRoot, "tick-escaped")).length > escapedAfterStop);

  const { RuntimeProcessService, RuntimeProcessStore } = await import("../dist/runtime-process.js");
  const db = new DatabaseSync(join(directory, "next.sqlite"));
  const service = new RuntimeProcessService({
    repositoryFactory: (owner, capacity) => new RuntimeProcessStore(db, owner, capacity),
    adapters: [{ id: "fixture", executable: process.execPath, cwd: directory,
      processScope: "linux-process-group", arguments: () => [script, nextRoot, "parent"] }],
    authorizeLaunch: async () => true, limits: { graceMs: 100 },
  });
  const job = await service.launch({ actorId: "alice", operationId: randomUUID(), adapterId: "fixture", input: {} });
  await until(() => ["parent", "escaped"].every(role => existsSync(join(nextRoot, `tick-${role}`))));
  await service.pause("alice", job.jobId);
  await delay(80);
  const nextParent = readFileSync(join(nextRoot, "tick-parent")).length;
  const nextEscaped = readFileSync(join(nextRoot, "tick-escaped")).length;
  await delay(150);
  assert.equal(readFileSync(join(nextRoot, "tick-parent")).length, nextParent);
  assert(readFileSync(join(nextRoot, "tick-escaped")).length > nextEscaped);
  await service.resume("alice", job.jobId);
  await until(() => readFileSync(join(nextRoot, "tick-parent")).length > nextParent);
  await service.pause("alice", job.jobId);
  await service.cancel("alice", job.jobId);
  const cancelled = await service.wait("alice", job.jobId);
  assert(["CANCELLED", "INTERRUPTED"].includes(cancelled.state));
  assert.equal(cancelled.effect, "unknown");
  const nextAfterStop = readFileSync(join(nextRoot, "tick-escaped")).length;
  await delay(100);
  assert(readFileSync(join(nextRoot, "tick-escaped")).length > nextAfterStop);
  await service.close({ drainMs: 0 }); db.close();

  const heldRoot = join(directory, "held"), heldDb = new DatabaseSync(join(directory, "held.sqlite"));
  mkdirSync(heldRoot);
  const held = new RuntimeProcessService({
    repositoryFactory: (owner, capacity) => new RuntimeProcessStore(heldDb, owner, capacity),
    adapters: [{ id: "fixture", executable: process.execPath, cwd: directory,
      processScope: "linux-process-group", arguments: () => [script, heldRoot, "short-parent"] }],
    authorizeLaunch: async () => true, limits: { graceMs: 100 },
  });
  const heldJob = await held.launch({ actorId: "alice", operationId: randomUUID(), adapterId: "fixture", input: {} });
  const heldResult = await held.wait("alice", heldJob.jobId);
  assert.equal(heldResult.state, "INTERRUPTED");
  assert.equal(heldResult.reason, "supervisor-error");
  assert.equal(heldResult.effect, "unknown");
  assert(existsSync(join(heldRoot, "tick-escaped")));
  await held.close({ drainMs: 0 }); heldDb.close();
}

if (mode === "--controller" || mode === "--owner-death" || mode === "--legacy-owner-death" || mode === "--detached") {
  const watchdog = setTimeout(() => process.exit(1), 18000);
  await (mode === "--detached" ? detachedDescendants()
    : mode === "--legacy-owner-death" ? legacyOwnerFailure() : controllerFailure(mode === "--owner-death"));
  clearTimeout(watchdog);
  process.stdout.write("BOUNDARY_VERIFIED\n");
} else {
  for (const [label, childMode] of [
    ["controller SIGKILL while paused cleans the owned group and reports UNKNOWN", "--controller"],
    ["lifecycle owner SIGKILL while paused remains UNKNOWN and may leave the group stopped", "--owner-death"],
    ["legacy supervisor SIGKILL while paused leaves the group stopped and becomes UNKNOWN", "--legacy-owner-death"],
    ["ordinary detached subprocess escapes both legacy and native process groups", "--detached"],
  ]) {
    test(label, { skip: process.platform !== "linux", timeout: 20000 }, async t => {
      const root = resolve("tests", `.group-boundary-${randomUUID()}`);
      mkdirSync(root, { mode: 0o700 });
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const isolated = spawn("unshare", ["-Urnmpf", "--mount-proc", process.execPath, file, childMode, root],
        { stdio: ["ignore", "pipe", "pipe"] });
      t.after(() => { if (isolated.exitCode === null && isolated.signalCode === null) isolated.kill("SIGKILL"); });
      let stdout = "", stderr = "";
      isolated.stdout.on("data", chunk => { stdout += chunk; });
      isolated.stderr.on("data", chunk => { stderr += chunk; });
      const [code] = await once(isolated, "close");
      assert.equal(code, 0, stderr); assert.match(stdout, /BOUNDARY_VERIFIED/);
    });
  }
}
