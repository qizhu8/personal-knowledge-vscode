const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-probe-cache-"));
const log = path.join(runtime, "calls.log");
const settings = { mcpRuntimePath: runtime, mcpPythonPath: "" };
const load = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? { workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) } } : load.call(this, name, ...args);
};
const mcp = require("../dist/mcp/mcp");
Module._load = load;

// A fake interpreter that records each probe and is deliberately slow, like a cold Windows Python.
const python = path.join(runtime, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
fs.mkdirSync(path.dirname(python), { recursive: true });
fs.writeFileSync(python, `#!/bin/sh\necho "$2" | cut -c1-20 >> "${log}"\nsleep 0.3\necho 3.11.9\n`, { mode: 0o755 });
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

test("Python runtime probes are cached and the async warm-up never blocks the Extension Host thread", { skip: process.platform === "win32" }, async () => {
  mcp.invalidateMcpPythonProbes();
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  const status = await mcp.mcpRuntimeStatusAsync();
  clearInterval(ticker);
  assert.equal(status.healthy, true);
  assert.equal(status.version, "3.11.9");
  assert(ticks >= 10, `event loop kept running during ~600 ms of probes (ticks=${ticks})`);
  assert.equal(calls().length, 2, "one version probe and one import probe");
  const started = Date.now();
  assert.equal(mcp.mcpRuntimeStatus().healthy, true);
  assert.equal(mcp.validateMcpPython(python).version, "3.11.9");
  assert(Date.now() - started < 100, "synchronous callers read the warm cache");
  assert.equal(calls().length, 2);
  const [first, second] = await Promise.all([mcp.mcpRuntimeStatusAsync(), mcp.mcpRuntimeStatusAsync()]);
  assert.equal(first, second);
  assert.equal(calls().length, 2);
  mcp.invalidateMcpPythonProbes();
  mcp.mcpRuntimeStatus();
  assert.equal(calls().length, 4, "explicit invalidation (runtime repair) probes again");
});

test.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
