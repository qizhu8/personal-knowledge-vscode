const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const originalLoad = Module._load;
let createBuiltinTools;
try {
  Module._load = function (name, ...rest) {
    if (name === "vscode") return {};
    return originalLoad.call(this, name, ...rest);
  };
  ({ createBuiltinTools } = require("../dist/chat/api-chat-tools"));
} finally { Module._load = originalLoad; }
const { getChatProcess, cancelChatProcess } = require("../dist/chat/chat-process-runtime");

test("production builtin tools require explicit durable approval, survive caller cancellation and read original output from a fresh tool instance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-durable-tools-"));
  const evidence = path.join(root, "evidence");
  const host = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: "file", fsPath: root } }] },
    Uri: { file: fsPath => ({ scheme: "file", fsPath }) } };
  const permissions = [];
  const tools = approved => createBuiltinTools(["run_process", "process_get", "process_output", "process_cancel"],
    host, undefined, undefined, async (name, prompt, detail) => {
      permissions.push({ name, prompt, detail }); return approved;
    }, undefined, evidence);
  const invoke = (list, name, args, signal = new AbortController().signal) => list.find(tool => tool.name === name).execute(args, signal);
  const input = { program: process.execPath, arguments: ["-e", "setTimeout(()=>{require('fs').appendFileSync('effects','one');console.log('original-result')},300)"],
    background: true, timeoutSeconds: 5, idempotency_key: "original-command" };
  let handle;
  try {
    await assert.rejects(invoke(tools(false), "run_process", input), /declined/);
    assert(!fs.existsSync(path.join(evidence, "processes")), "Denial does not create launch intent");
    const caller = new AbortController();
    const original = JSON.parse(await invoke(tools(true), "run_process", input, caller.signal));
    handle = original.handle;
    assert.equal(permissions.at(-1).name, "run_process_background");
    assert.match(permissions.at(-1).detail, /continues after window reload\. Chat Stop or process_cancel with the original handle cancels it/);
    caller.abort();
    const fresh = tools(true);
    let terminal;
    for (let n = 0; n < 200; n++) {
      terminal = JSON.parse(await invoke(fresh, "process_get", { handle }));
      if (!["launching", "running"].includes(terminal.state)) break;
      await delay(20);
    }
    assert.equal(terminal.state, "complete");
    assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), "one");
    const output = JSON.parse(await invoke(fresh, "process_output", { handle, stream: "stdout", start: 0, length: 100 }));
    assert.equal(output.text, "original-result\n");
    const recovered = JSON.parse(await invoke(fresh, "run_process", input));
    assert.equal(recovered.handle, handle); assert.equal(recovered.state, "complete");
    assert.equal(fs.readFileSync(path.join(root, "effects"), "utf8"), "one");
    const foreground = JSON.parse(await invoke(fresh, "run_process", { program:process.execPath,
      arguments:["-e", "process.stdout.write('x'.repeat(40000)+'FOREGROUND_TAIL');process.stderr.write('diagnostic')"], timeoutSeconds:5 }));
    assert.equal(foreground.exitCode, 0);
    assert(foreground.truncated);
    assert.match(foreground.outputHandle, /^foreground_/);
    const tail = JSON.parse(await invoke(tools(true), "process_output", { handle:foreground.outputHandle, stream:"stdout", start:39990, length:100 }));
    assert.equal(tail.text, "xxxxxxxxxxFOREGROUND_TAIL");
    assert.equal(tail.state, "foreground-log", "Available logs must not fabricate a durable process/completion record");
    await assert.rejects(invoke(fresh, "process_output", { handle:foreground.outputHandle + "/../secret", stream:"stdout", start:0, length:100 }), /exact process handle/);
    await assert.rejects(invoke(fresh, "process_get", { handle:foreground.outputHandle }), /exact process handle/);
    host.workspace.isTrusted = false;
    await assert.rejects(invoke(fresh, "process_get", { handle }), /trusted/);
    host.workspace.isTrusted = true;
    await assert.rejects(invoke(fresh, "run_process", { ...input, timeoutSeconds: undefined }), /explicit timeoutSeconds/);
    const foreign = createBuiltinTools(["process_get"], host, undefined, undefined, undefined, undefined, path.join(root, "foreign-chat"));
    await assert.rejects(invoke(foreign, "process_get", { handle }), /ENOENT/);
    const foreignOutput = createBuiltinTools(["process_output"], host, undefined, undefined, undefined, undefined, path.join(root, "foreign-chat"));
    await assert.rejects(invoke(foreignOutput, "process_output", { handle:foreground.outputHandle, stream:"stdout", start:0, length:100 }), /ENOENT/);
  } finally {
    if (handle) {
      const status = getChatProcess(evidence, handle);
      if (["launching", "running"].includes(status.state)) {
        cancelChatProcess(evidence, handle);
        for (let n = 0; n < 200 && ["launching", "running"].includes(getChatProcess(evidence, handle).state); n++) await delay(20);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
