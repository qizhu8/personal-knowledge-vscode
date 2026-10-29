const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { launchChatProcess, getChatProcess, cancelChatProcess, cancelAllChatProcesses, readChatProcessOutput } = require("../dist/chat/chat-process-runtime");

async function wait(root, handle, predicate, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const record = getChatProcess(root, handle);
    if (predicate(record)) return record;
    await delay(30);
  }
  assert.fail(JSON.stringify(getChatProcess(root, handle)));
}
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-durable-process-"));
  try { await fn(root); }
  finally {
    const directory = path.join(root, "processes");
    for (const handle of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      const record = getChatProcess(root, handle);
      if (["launching", "running"].includes(record.state)) {
        cancelChatProcess(root, handle);
        await wait(root, handle, value => !["launching", "running"].includes(value.state));
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const spec = (root, code, timeoutSeconds = 5) => ({ program: process.execPath, arguments: ["-e", code], cwd: root, timeoutSeconds });
const terminal = record => !["launching", "running"].includes(record.state);

test("background logs preserve complete tails and exact bounded byte ranges without killing a healthy large-output process", async () => fixture(async root => {
  const record = await launchChatProcess(root, "large-output", spec(root, "process.stdout.write('HEAD'+ 'x'.repeat(40000)+'TAIL');process.stderr.write('error-tail')"));
  const done = await wait(root, record.handle, terminal);
  assert.equal(done.state, "complete");
  assert.equal(done.exitCode, 0);
  assert.equal(done.stdoutBytes, 40008);
  assert.equal(readChatProcessOutput(root, record.handle, "stdout", 40004, 100).text, "TAIL");
  const first = readChatProcessOutput(root, record.handle, "stdout", 0, 12000);
  assert.equal(first.end, 12000); assert.equal(first.more, true);
  assert.equal(readChatProcessOutput(root, record.handle, "stderr", 0, 100).text, "error-tail");
  assert.throws(() => readChatProcessOutput(root, record.handle, "stdout", 0, 12001), /12000/);
  assert.throws(() => readChatProcessOutput(root, record.handle, "stdout", 50000, 10), /beyond/);
  assert.throws(() => getChatProcess(root, "../another-chat"), /exact process handle/);
}));

test("concurrent launches, response loss and original-key recovery never repeat side effects", async () => fixture(async root => {
  const input = spec(root, "require('fs').appendFileSync('effects','once\\n');setTimeout(()=>console.log('done'),200)");
  const records = await Promise.all(Array.from({ length: 6 }, () => launchChatProcess(root, "same-command", input)));
  assert.equal(new Set(records.map(record => record.handle)).size, 1);
  const done = await wait(root, records[0].handle, terminal);
  assert.equal(done.state, "complete");
  assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), "once\n");
  const recovered = await launchChatProcess(root, "same-command", input);
  assert.equal(recovered.handle, done.handle); assert.equal(recovered.state, "complete");
  await assert.rejects(launchChatProcess(root, "same-command", { ...input, arguments: ["-e", "console.log('different')"] }), /different process inputs/);
  assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), "once\n");
}));

test("supervisor survives its launching host exit and remains queryable from a fresh host", async () => fixture(async root => {
  const runtime = require.resolve("../dist/chat/chat-process-runtime");
  const input = spec(root, "setTimeout(()=>require('fs').writeFileSync('after-host-exit','completed'),500)");
  const script = `require(${JSON.stringify(runtime)}).launchChatProcess(${JSON.stringify(root)},'host-exit',${JSON.stringify(input)}).then(record=>{console.log(record.handle);process.exit(0)}).catch(error=>{console.error(error);process.exit(1)})`;
  const launcher = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; launcher.stdout.on("data", chunk => { output += chunk; });
  const exit = await new Promise(resolve => launcher.once("close", resolve));
  assert.equal(exit, 0);
  const handle = output.trim();
  const done = await wait(root, handle, terminal);
  assert.equal(done.state, "complete");
  assert.equal(fs.readFileSync(path.join(root, "after-host-exit"), "utf8"), "completed");
  const fresh = JSON.parse(execFileSync(process.execPath, ["-e",
    `console.log(JSON.stringify(require(${JSON.stringify(runtime)}).getChatProcess(${JSON.stringify(root)},${JSON.stringify(handle)})))`], { encoding: "utf8" }));
  assert.equal(fresh.handle, handle); assert.equal(fresh.state, "complete");
}));

test("explicit cancellation, approved deadline and failed executable retain distinct terminal evidence", async () => fixture(async root => {
  const cancelled = await launchChatProcess(root, "cancel", spec(root, "setInterval(()=>console.log('alive'),100)", 10));
  await wait(root, cancelled.handle, record => record.state === "running");
  const requested = cancelChatProcess(root, cancelled.handle);
  assert.match(requested.detail, /not yet confirmed/);
  assert.equal((await wait(root, cancelled.handle, terminal)).state, "cancelled");
  const timeout = await launchChatProcess(root, "timeout", spec(root, "setInterval(()=>{},100)", 1));
  assert.equal((await wait(root, timeout.handle, terminal)).state, "timed-out");
  const failed = await launchChatProcess(root, "missing", { ...spec(root, ""), program: path.join(root, "no-executable") });
  const failure = await wait(root, failed.handle, terminal);
  assert.equal(failure.state, "failed"); assert.match(failure.detail, /launch failed/);
}));

test("Chat Stop cancels every running background process of that Chat and skips finished ones", async () => fixture(async root => {
  assert.deepEqual(cancelAllChatProcesses(path.join(root, "absent")), { cancelled: [], errors: [] });
  const first = await launchChatProcess(root, "stop-a", spec(root, "setInterval(()=>{},100)", 10));
  const second = await launchChatProcess(root, "stop-b", spec(root, "setInterval(()=>{},100)", 10));
  const done = await launchChatProcess(root, "stop-done", spec(root, "0"));
  await wait(root, done.handle, terminal);
  await wait(root, first.handle, record => record.state === "running");
  await wait(root, second.handle, record => record.state === "running");
  const result = cancelAllChatProcesses(root);
  assert.deepEqual(result.cancelled.sort(), [first.handle, second.handle].sort());
  assert.deepEqual(result.errors, []);
  assert.equal((await wait(root, first.handle, terminal)).state, "cancelled");
  assert.equal((await wait(root, second.handle, terminal)).state, "cancelled");
  assert.equal(getChatProcess(root, done.handle).state, "complete");
}));

test("deferred Stop cleanup skips processes created after the click", async () => fixture(async root => {
  const older = await launchChatProcess(root, "before-stop", spec(root, "setInterval(()=>{},100)", 10));
  await wait(root, older.handle, record => record.state === "running");
  const stoppedAt = Date.now();
  await delay(5);
  const newer = await launchChatProcess(root, "after-stop", spec(root, "setInterval(()=>{},100)", 10));
  await wait(root, newer.handle, record => record.state === "running");
  const result = cancelAllChatProcesses(root, stoppedAt);
  assert.deepEqual(result, { cancelled: [older.handle], errors: [] });
  assert.equal((await wait(root, older.handle, terminal)).state, "cancelled");
  assert.equal(getChatProcess(root, newer.handle).state, "running");
}));

test("stale receipts stay unknown, cannot be signalled by historical PID and cannot auto-relaunch", async () => fixture(async root => {
  const input = spec(root, "require('fs').appendFileSync('once','x')");
  const original = await launchChatProcess(root, "stale", input);
  await wait(root, original.handle, terminal);
  const filename = path.join(root, "processes", original.handle, "record.json");
  const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
  fs.writeFileSync(filename, JSON.stringify({ ...raw, state: "running", updatedAt: Date.now() - 20000, runnerPid: process.pid, childPid: process.pid }));
  assert.equal(getChatProcess(root, original.handle).state, "unknown");
  assert.throws(() => cancelChatProcess(root, original.handle), /historical PID/);
  assert.equal((await launchChatProcess(root, "stale", input)).state, "unknown");
  assert.equal(fs.readFileSync(path.join(root, "once"), "utf8"), "x");
}));

test("storage hard-limit is independent of display budget and cancellation terminates descendants", async () => fixture(async root => {
  const overflowing = await launchChatProcess(root, "storage-limit", spec(root,
    "const chunk=Buffer.alloc(1024*1024,120);function write(){while(process.stdout.write(chunk)){}process.stdout.once('drain',write)}write()"));
  const overflow = await wait(root, overflowing.handle, terminal);
  assert.equal(overflow.state, "output-limit");
  assert.equal(overflow.stdoutBytes + overflow.stderrBytes, 64 * 1024 * 1024);
  if (process.platform !== "win32") {
    const code = "require('child_process').spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync('descendant-effect','BAD'),2500)\"],{stdio:'inherit'});setInterval(()=>{},100)";
    const tree = await launchChatProcess(root, "cancel-tree", spec(root, code));
    await wait(root, tree.handle, value => value.state === "running");
    await delay(200);
    cancelChatProcess(root, tree.handle);
    assert.equal((await wait(root, tree.handle, terminal)).state, "cancelled");
    await delay(2700);
    assert.equal(fs.existsSync(path.join(root, "descendant-effect")), false);
  }
}));

test("escaped log bytes fit the actual tool-result envelope and exact continuation retains all evidence", async () => fixture(async root => {
  const record = await launchChatProcess(root, "escaped", spec(root, "process.stdout.write(Buffer.alloc(24000,0))"));
  await wait(root, record.handle, terminal);
  let offset = 0;
  while (offset < 24000) {
    const result = readChatProcessOutput(root, record.handle, "stdout", offset, 12000);
    assert(JSON.stringify(result).length <= 15000);
    assert(result.end > offset);
    assert.equal(result.text, "\0".repeat(result.end - offset));
    offset = result.end;
  }
  assert.equal(offset, 24000);
}));

test("cancellation escalates for descendants with closed pipes after the direct child exits", { skip:process.platform === "win32" }, async () => fixture(async root => {
  const descendant = "process.on('SIGTERM',()=>{});require('fs').writeFileSync('closed-pipes-ready','ready');setTimeout(()=>require('fs').writeFileSync('closed-pipes-effect','BAD'),2500)";
  const tree = await launchChatProcess(root, "closed-pipes", spec(root,
    `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},100)`));
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(root, "closed-pipes-ready")); attempt++) await delay(20);
  assert(fs.existsSync(path.join(root, "closed-pipes-ready")));
  cancelChatProcess(root, tree.handle);
  assert.equal((await wait(root, tree.handle, terminal)).state, "cancelled");
  await delay(2700);
  assert.equal(fs.existsSync(path.join(root, "closed-pipes-effect")), false);
}));

test("process evidence survives transient Windows rename denials and still reports persistent failures", () => {
  const { writeChatProcessRecord } = require("../dist/chat/chat-process-runtime");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-process-record-"));
  const original = fs.renameSync;
  try {
    const handle = "process_" + "a".repeat(64);
    const record = { schema:"pkm.chat.process/v1", handle, spec:spec(root, ""), state:"running", createdAt:Date.now(), updatedAt:Date.now(), stdoutBytes:0, stderrBytes:0 };
    let denials = 3;
    fs.renameSync = (...args) => {
      if (denials-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code:"EPERM" });
      return original(...args);
    };
    writeChatProcessRecord(root, record);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "record.json"), "utf8")).state, "running");
    fs.renameSync = () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code:"EPERM" }); };
    assert.throws(() => writeChatProcessRecord(root, { ...record, state:"complete" }), /EPERM/);
    assert.deepEqual(fs.readdirSync(root), ["record.json"], "temporary evidence files are removed after a failed replacement");
  } finally {
    fs.renameSync = original;
    fs.rmSync(root, { recursive:true, force:true });
  }
});
