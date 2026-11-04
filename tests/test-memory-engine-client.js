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

test("Explicit Memory service binds scope and requires Host authorization for state transitions", async () => {
  const { ExplicitMemoryService } = require("../dist/memory/explicit-memory-service");
  const { MemoryEngineRequestError } = require("../dist/memory/memory-engine-client");
  const directory = fs.mkdtempSync(path.join(__dirname, ".explicit-memory-service-"));
  const options = {
    extensionRoot: path.resolve(__dirname, ".."),
    python: process.env.PYTHON || "python3",
    database: path.join(directory, "memory.sqlite3"),
    identity: "fixture-account/root",
  };
  const scope = { account: "account-1", project: "project-1", repository: "repo-1" };
  const sources = [{ id: "source-1", chat: "pkm://chats/chat-1", revision: "turn-3", locator: "message#3:1-9" }];
  const oversizedSources = Array.from({ length: 3 }, (_, index) => ({
    id: `source-${index}`, chat: "pkm://chats/chat-1", revision: "turn-3", locator: "x".repeat(1500),
  }));
  let allowed = false;
  let client;
  try {
    client = await MemoryEngineClient.open(options);
    const service = new ExplicitMemoryService(client, scope, request => {
      assert.deepEqual(request.scope, scope);
      return allowed
        ? { decisionId: `host-${request.operationId}`, actorId: "native-user-1" }
        : null;
    });
    await assert.rejects(service.propose({ content: "Large references.", sources: oversizedSources }),
      /exceed 4096 UTF-8 bytes in total/);
    const proposal = { content: "Remember the SQLite decision.", sources, status: "confirmed" };
    const pending = await service.propose(proposal, { operationId: "proposal-op-1" });
    assert.deepEqual(await service.propose(proposal, { operationId: "proposal-op-1" }), pending);
    assert.equal(pending.status, "pending");
    assert.equal(pending.sources[0].locator, sources[0].locator);
    assert.deepEqual(await service.search("SQLite"), []);
    await assert.rejects(service.confirm(pending.id, pending.revision), /Host did not authorize/);
    await assert.rejects(service.revise(pending.id, pending.revision, {
      content: "Updated note.", sources: oversizedSources,
    }), /exceed 4096 UTF-8 bytes in total/);
    assert.equal((await service.get(pending.id)).status, "pending");

    allowed = true;
    const confirmed = await service.confirm(pending.id, pending.revision, { operationId: "confirm-op-1" });
    assert.deepEqual(await service.confirm(pending.id, pending.revision, { operationId: "confirm-op-1" }), confirmed);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.revision, 2);
    await assert.rejects(service.confirm(pending.id, pending.revision), error =>
      error instanceof MemoryEngineRequestError && error.code === "CONFLICT" &&
      /Stale explicit-memory revision/.test(error.message));
    await assert.rejects(service.get("missing-record"), error =>
      error instanceof MemoryEngineRequestError && error.code === "NOT_AVAILABLE");
    assert.equal((await service.search("SQLite"))[0].id, pending.id);

    const revised = await service.revise(pending.id, confirmed.revision, {
      content: "Remember the SQLite WAL decision.", sources,
    });
    assert.equal(revised.status, "pending");
    assert.deepEqual(await service.search("SQLite"), []);
    const confirmedRevision = await service.confirm(revised.id, revised.revision);
    const revoked = await service.revoke(confirmedRevision.id, confirmedRevision.revision);
    assert.equal(revoked.status, "revoked");
    assert.deepEqual(await service.search("SQLite"), []);
    assert.deepEqual((await service.audit(pending.id)).events.map(event => event.action),
      ["proposed", "confirmed", "revised", "confirmed", "revoked"]);

    await client.close();
    client = await MemoryEngineClient.open(options);
    const restarted = new ExplicitMemoryService(client, scope, () =>
      ({ decisionId: "unused", actorId: "native-user-1" }));
    assert.equal((await restarted.get(pending.id)).status, "revoked");
    assert.deepEqual(await restarted.search("SQLite"), []);
    const otherScope = new ExplicitMemoryService(client, { ...scope, repository: "other-repo" },
      () => ({ decisionId: "unused", actorId: "native-user-1" }));
    await assert.rejects(otherScope.get(pending.id), /not found/);
  } finally {
    if (client) await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
