const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function fixture(reply) {
  const file = path.resolve(__dirname, "../dist/runtime/background-processes.js");
  const realRequire = createRequire(file);
  const calls = [];
  const exports = {};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    exports, Buffer, process: { platform: "win32" },
    require(name) {
      if (name === "child_process") return { execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        queueMicrotask(() => callback(reply.error || null, reply.stdout || "", reply.error?.stderr || ""));
      } };
      if (name === "fs") return { ...fs, statSync: () => ({}) };
      if (name === "util") return { ...require("node:util"), promisify: fn => (...args) => new Promise((resolve, reject) => {
        fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      }) };
      return realRequire(name);
    },
  }, { filename: file });
  return { inventory: new exports.BackgroundProcessInventory(), calls };
}

test("Windows inventory narrows CIM enumeration, retains current-user ownership checks and coalesces concurrent scans", async () => {
  const row = { pid: 42, parentPid: 10, elapsedSeconds: 120, rssBytes: 4096,
    command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\PKM\\dist\\runtime\\pkm-service-entry.js" --token secret' };
  const { inventory, calls } = fixture({ stdout: JSON.stringify([row]) });
  const [first, second] = await Promise.all([inventory.snapshot(), inventory.snapshot()]);
  assert.strictEqual(first, second);
  assert.strictEqual(first, await inventory.snapshot());
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, "powershell.exe");
  assert.deepEqual(Array.from(args.slice(0, 3)), ["-NoProfile", "-NonInteractive", "-Command"]);
  const script = args[3];
  assert.match(script, /Get-CimInstance Win32_Process -Filter "Name LIKE 'python%\.exe'/);
  assert.match(script, /Invoke-CimMethod -InputObject \$_ -MethodName GetOwnerSid/);
  assert.match(script, /\$owner\.ReturnValue -ne 0.*throw/);
  assert.match(script, /\$owner\.Sid -eq \$sid/);
  assert.match(script, /Cannot determine owner of PKM process/);
  assert.match(script, /ConvertTo-Json -InputObject \$items -Compress/);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 10_000);
  assert.equal(first.processes[0].pid, 42);
  assert.equal(first.processes[0].entryPath, "C:\\PKM\\dist\\runtime\\pkm-service-entry.js");
  assert.doesNotMatch(JSON.stringify(first), /secret|--token|command/);
});

test("Windows failure stderr is bounded and partial stdout is never mistaken for a successful inventory",async()=>{
  const {inventory}=fixture({stdout:'[{"pid":42,"command":"do-not-share"}]',
    error:Object.assign(new Error("Command failed"),{code:1,stderr:"CIM diagnostic: "+"x".repeat(4000)})});
  await assert.rejects(inventory.snapshot(),failure=>{
    assert.match(failure.message,/CIM diagnostic/);
    assert(failure.message.length<2200);
    assert.doesNotMatch(failure.message,/do-not-share/);
    return true;
  });
});

test("Windows empty inventory is valid, but errors and invalid responses cannot become empty success", async () => {
  assert.equal((await fixture({ stdout: "[]" }).inventory.snapshot()).processes.length, 0);
  await assert.rejects(fixture({ stdout: "{}" }).inventory.snapshot(), /Invalid Windows process inventory/);
  await assert.rejects(fixture({ stdout: '[{"pid":"42"}]' }).inventory.snapshot(), /Invalid Windows process observation/);
  await assert.rejects(fixture({ stdout: "not JSON" }).inventory.snapshot(), /JSON|Unexpected token/);
});

for (const [name, error, expected] of [
  ["timeout", { killed: true, signal: "SIGTERM" }, /did not complete within 10s.*SIGTERM/],
  ["missing PowerShell", { code: "ENOENT" }, /powershell.exe was not found/],
  ["buffer limit", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" }, /output exceeded.*buffer limit/],
  ["CIM ownership failure", { code: 1, stderr: "Cannot determine owner of PKM process 42 (GetOwnerSid returned 2)" }, /code 1.*GetOwnerSid returned 2/],
]) {
  test(`Windows ${name} reports the actual failure instead of dumping the entire script`, async () => {
    const { inventory, calls } = fixture({ error: Object.assign(new Error("Command failed: private script"), error) });
    await assert.rejects(inventory.snapshot(), failure => {
      assert.match(failure.message, expected);
      assert.doesNotMatch(failure.message, /private script|Get-CimInstance|Command failed/);
      return true;
    });
    await assert.rejects(inventory.snapshot());
    assert.equal(calls.length, 2, "a failed scan is not cached as a successful empty inventory");
  });
}
