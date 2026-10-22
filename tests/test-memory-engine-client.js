const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { MemoryEngineClient } = require("../dist/memory/memory-engine-client");

test("Host client calls real isolated Python module and preserves state across worker restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-client-"));
  const options = {
    extensionRoot: path.resolve(__dirname, ".."),
    python: process.env.PYTHON || "python3",
    database: path.join(directory, "memory.sqlite3"),
    identity: "fixture-account/root",
  };
  let client;
  try {
    client = await MemoryEngineClient.open(options);
    const result = await client.request({
      method: "create", operationId: "create-problem", params: { piece: "problem", label: "问题" },
    });
    assert.deepEqual(result, { piece: "problem", revision: 0 });
    await assert.rejects(client.request({
      method: "create", operationId: "create-problem", params: { piece: "other", label: "Conflict" },
    }), /reused/);
    await client.request({
      method: "append", operationId: "append", params: {
        piece: "problem", statement_id: "statement", expected_revision: 0, body: "保持上下文",
        sources: [{ id: "source", chat: "pkm://chats/fixture/chat", revision: "r1", locator: "message#0:6" }],
      },
    });
    const [snapshot, sources] = await Promise.all([
      client.request({ method: "read", params: { piece_id: "problem" } }),
      client.request({ method: "sources", params: { statement_id: "statement" } }),
    ]);
    assert.equal(snapshot.statements[0].body, "保持上下文");
    assert.equal(sources[0].locator, "message#0:6");
    await client.close();
    await assert.rejects(client.request({ method: "capabilities" }), /closed/);
    client = await MemoryEngineClient.open(options);
    assert.equal((await client.request({ method: "read", params: { piece_id: "problem" } })).piece.revision, 1);
    await assert.rejects(MemoryEngineClient.open({ ...options, identity: "wrong-root" }), /identity mismatch|exited/);
    assert.equal((await client.request({ method: "capabilities" })).protocol, 1);
  } finally {
    if (client) await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Host client reports missing interpreter and launch timeout without fallback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-errors-"));
  try {
    const options = {
      extensionRoot: path.resolve(__dirname, ".."), database: path.join(directory, "memory.sqlite3"), identity: "fixture",
    };
    await assert.rejects(MemoryEngineClient.open({
      ...options, python: path.join(directory, "missing-python"),
    }), /launch failed/);
    await assert.rejects(MemoryEngineClient.open({
      ...options, python: process.env.PYTHON || "python3", timeoutMs: 1,
    }), /timed out/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows ANSI console code pages cannot crash the Memory Engine on non-ASCII replies", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-cp1252-"));
  const original = process.env.PYTHONIOENCODING;
  process.env.PYTHONIOENCODING = "cp1252";
  let client;
  try {
    client = await MemoryEngineClient.open({ extensionRoot: path.resolve(__dirname, ".."), python: process.env.PYTHON || "python3",
      database: path.join(directory, "memory.sqlite3"), identity: "fixture-account/cp1252" });
    await client.request({ method: "create", operationId: "create-cn", params: { piece: "cn", label: "中文记忆" } });
    const snapshot = await client.request({ method: "read", params: { piece_id: "cn" } });
    assert.match(JSON.stringify(snapshot), /中文记忆/);
    assert.equal(client.healthy, true);
  } finally {
    if (original === undefined) delete process.env.PYTHONIOENCODING; else process.env.PYTHONIOENCODING = original;
    await client?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Memory Engine crash diagnostics lead with the real exception instead of runpy frames", () => {
  const { memoryEngineDiagnostic } = require("../dist/memory/memory-engine-client");
  const stderr = "Traceback (most recent call last):\r\n  File \"<string>\", line 1, in <module>\r\n  File \"<frozen runpy>\", line 229, in run_module\r\n"
    + "UnicodeEncodeError: 'charmap' codec can't encode characters in position 118-119\r\n";
  assert.match(memoryEngineDiagnostic(stderr), /^UnicodeEncodeError: 'charmap'/);
});

test("the Memory Engine protocol writer is UTF-8 even when launched outside the Host's UTF-8 environment", () => {
  const { spawnSync } = require("node:child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-raw-"));
  try {
    const result = spawnSync(process.env.PYTHON || "python3", ["-u", "-c",
      "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pkm_memory_engine',run_name='__main__')",
      path.resolve(__dirname, "..", "modules", "pkm-memory-engine", "src"), "--database", path.join(directory, "m.sqlite3"), "--identity", "raw"],
    { input: JSON.stringify({ protocol: 1, id: "x", method: "read", params: { "记忆": 1 } }) + "\n",
      env: { ...process.env, PYTHONIOENCODING: "cp1252", PYTHONUTF8: "0" } });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.match(result.stdout.toString("utf8"), /记忆/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
