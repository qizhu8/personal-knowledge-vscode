import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { ChatMemoryWorker, ComputeError } from "../dist/compute/chat-memory-worker.js";

const root = fileURLToPath(new URL("../", import.meta.url));
// Test-only discovery; production always receives an explicit executable path.
const python = process.env.COMPUTE_TEST_PYTHON || execFileSync(process.platform === "win32" ? "python" : "python3",
  ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8", cwd: root, env: { ...process.env, TMPDIR: join(root, "tests"), TEMP: join(root, "tests"), TMP: join(root, "tests") },
  }).trim();
const unix = process.platform !== "win32";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const piece = { piece: "topic-1", label: "SQLite computation", kind: "topic", scope: "fixture-chat" };
async function fixture(t, overrides = {}) {
  const directory = join(root, "tests", `.compute-fixture-${randomUUID()}`);
  const runtimeDirectory = join(directory, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const options = { python, runtimeDirectory, database: join(runtimeDirectory, "chat-runtime.sqlite3"),
    identity: "disposable-compute-fixture", ...overrides };
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, options, async open(extra = {}) {
    const client = await ChatMemoryWorker.open({ ...options, ...extra });
    clients.push(client);
    return client;
  } };
}
function error(code, outcome) {
  return value => value instanceof ComputeError && value.code === code && (!outcome || value.outcome === outcome);
}
async function fakeInterpreter(f, body) {
  const path = join(f.directory, "fixture-python");
  await writeFile(path, `#!${python}\nimport json,sys,time,signal,sqlite3\nidentity=sys.argv[sys.argv.index("--identity")+1]\ndatabase=sys.argv[sys.argv.index("--database")+1]\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}
const READY = `ready={"type":"ready","protocol":1,"adapter":"pkm-next-chat-compute/1","module":"pkm-memory-engine","policy":"pkm-memory-policy/1","schema":2,"identity":identity,"storage":"worker-owned-runtime-sqlite","explicit_memory":"node-markdown","capabilities":{"module":"pkm-memory-engine","policy":"pkm-memory-policy/1","protocol":1,"schema":2,"identity":identity}}
print(json.dumps(ready),flush=True)`;

test("captured Python package/provenance are byte-identical and reproducible after relocation", async () => {
  const manifest = join(root, "migration/compute-provenance.json");
  const before = await readFile(manifest);
  const result = execFileSync(process.execPath, [join(root, "scripts/capture-compute.mjs"), "--check"], {
    encoding: "utf8", cwd: join(root, "tests"),
  });
  assert.match(result, /4 byte-identical files/);
  assert.deepEqual(await readFile(manifest), before);
});

test("persistent ready handshake, mutation, reads, bounded domain API and SQLite ownership", async t => {
  const f = await fixture(t), client = await f.open();
  assert.equal(client.healthy, true);
  assert.equal(client.ready.identity, f.options.identity);
  assert.equal(client.ready.storage, "worker-owned-runtime-sqlite");
  assert.equal(client.ready.explicit_memory, "node-markdown");
  assert.equal(client.ready.capabilities.model_calls, "caller-executed");
  assert.equal(client.request, undefined);
  assert.equal(client.explicit_propose, undefined);
  const pid = client.processId;
  const created = await client.createPiece("create-1", piece);
  assert.deepEqual(await client.createPiece("create-1", piece), created);
  await assert.rejects(client.createPiece("create-1", { ...piece, label: "Different" }), error("CONFLICT", "rejected"));
  await client.appendStatement("append-1", { piece: piece.piece, statement_id: "s-1", expected_revision: 0,
    body: "中文 and emoji 🧠 round-trip", status: "observation",
    sources: [{ id: "source-1", chat: "fixture-chat", revision: "turn-1", locator: "message/user-1" }] });
  const page = await client.readPiece({ piece_id: piece.piece });
  assert.equal(page.statements[0].body, "中文 and emoji 🧠 round-trip");
  assert.equal((await client.listPieces({ scope: piece.scope, kind: "topic" })).length, 1);
  assert.equal((await client.overview({ scope: piece.scope })).topics.length, 1);
  assert.equal(client.processId, pid);
  assert.deepEqual(client.ready, client.ready);
  await client.close();
  const db = new DatabaseSync(f.options.database);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM explicit_memories").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM statements").get().n, 1);
  } finally { db.close(); }
});

test("graceful close drains the active request, refuses unsent work, and explicitly reopens durable runtime state", async t => {
  const f = await fixture(t), client = await f.open();
  const firstPid = client.processId;
  const active = client.createPiece("create-1", piece);
  const queued = client.createPiece("queued-create", { ...piece, piece: "never-submitted" });
  const rejected = assert.rejects(queued, error("CLOSED", "not-submitted"));
  await Promise.all([active, rejected, client.close(), client.close()]);
  assert.equal(client.state, "closed");
  assert.equal(client.processId, undefined);
  await assert.rejects(client.usage(), error("NOT_READY", "not-submitted"));
  await Promise.all([client.reopen(), client.reopen()]);
  assert.notEqual(client.processId, firstPid);
  assert.equal((await client.listPieces({ scope: piece.scope, kind: "topic" })).length, 1);
  await client.close();
  await client.reopen();
  assert.equal((await client.readPiece({ piece_id: piece.piece })).piece.id, piece.piece);
});

test("policy model steps and turn receipts persist across process restart without automatic resume", async t => {
  const f = await fixture(t), client = await f.open();
  const begun = await client.beginTurn({ scope: piece.scope, turn: "turn-1", input: { id: "user-1", text: "Discuss SQLite" } });
  assert.equal(begun.status, "model");
  assert.equal(begun.request.purpose, "intent");
  await client.close();
  await client.reopen();
  const receipt = await client.turnReceipt({ turn: "turn-1" });
  assert.equal(receipt.turn, "turn-1");
  assert.equal(receipt.calls.length, 1);
  assert.partialDeepStrictEqual(receipt.accounting, {
    schema: "pkm.memory.turn-accounting/v1", calls: 1, reportedCalls: 0, unreportedCalls: 1,
    timedCalls: 0, untimedCalls: 1, pendingCalls: 1, failedCalls: 0, cancelledCalls: 0,
    credits: { status: "not-reported", reportedCalls: 0, totalCalls: 1 },
  });
  assert.equal(receipt.accounting.reportedUsage, undefined);
  assert.equal(receipt.accounting.observedDurationMs, undefined);
  const usage = { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 3, copilotNanoAiu: 123_456_789 };
  const accounting = { schema: "pkm.memory.model-accounting/v1", modelId: "http:fixture-memory",
    provider: "http", durationMs: 12, timeoutMs: 1000, maxOutputTokens: 400, thinkingBudget: 2048 };
  const continued = await client.continueTurn({ turn: "turn-1",
    output: JSON.stringify({ focus: ["new:1"], related: [],
      new: [{ key: "new:1", label: "SQLite", parent: null }], reason: "Discuss SQLite" }), usage, accounting });
  assert.equal(continued.status, "ready");
  const committed = await client.commitTurn({ turn: "turn-1",
    user: { id: "user-1", text: "Discuss SQLite" }, assistant: { id: "assistant-1", text: "Acknowledged" } });
  assert.equal(committed.status, "model");
  assert.equal(committed.request.purpose, "extract");
  const pending = await client.turnReceipt({ turn: "turn-1" });
  assert.equal(pending.accounting.pendingCalls, 1);
  assert.deepEqual(pending.calls[0].usage, usage);
  assert.deepEqual(pending.calls[0].accounting, accounting);
  await client.close();
  await client.reopen();
  assert.deepEqual(await client.turnReceipt({ turn: "turn-1" }), pending);
  const extracted = await client.continueTurn({ turn: "turn-1", output: '{"statements":[]}' });
  assert.equal(extracted.status, "done");
  const done = await client.turnReceipt({ turn: "turn-1" });
  assert.equal(done.phase, "done");
  assert.partialDeepStrictEqual(done.accounting, {
    schema: "pkm.memory.turn-accounting/v1", calls: 2, reportedCalls: 1, unreportedCalls: 1,
    timedCalls: 1, untimedCalls: 1, pendingCalls: 0, failedCalls: 0, cancelledCalls: 0,
    reportedUsage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 3 },
    observedDurationMs: 12,
    credits: { source: "provider.copilot_usage.total_nano_aiu", status: "partial",
      reportedCalls: 1, totalCalls: 2, totalNanoAiu: "123456789", credits: "0.123456789" },
  });
  await client.close();
  await client.reopen();
  assert.deepEqual(await client.turnReceipt({ turn: "turn-1" }), done);
});

test("real worker preserves failed and cancelled unreported accounting across restart", async t => {
  const f = await fixture(t), client = await f.open();
  for (const status of ["failed", "cancelled"]) {
    const turn = `turn-${status}`;
    await client.beginTurn({ scope: `${piece.scope}/${status}`, turn, input: { id: `user-${status}`, text: "Discuss SQLite" } });
    if (status === "failed") await client.continueTurn({ turn, error: "Synthetic provider failure" });
    else await client.abortTurn({ turn, error: "Synthetic cancellation" });
    const receipt = await client.turnReceipt({ turn });
    assert.equal(receipt.calls[0].status, status);
    assert.partialDeepStrictEqual(receipt.accounting, {
      calls: 1, reportedCalls: 0, unreportedCalls: 1, timedCalls: 0, untimedCalls: 1, pendingCalls: 0,
      failedCalls: status === "failed" ? 1 : 0, cancelledCalls: status === "cancelled" ? 1 : 0,
      credits: { status: "not-reported", reportedCalls: 0, totalCalls: 1 },
    });
    assert.equal(receipt.accounting.reportedUsage, undefined);
    assert.equal(receipt.accounting.observedDurationMs, undefined);
    await client.close();
    await client.reopen();
    assert.deepEqual(await client.turnReceipt({ turn }), receipt);
  }
});

test("worker rejects wrong identities/schema without replacing SQLite and reports bounded stderr", async t => {
  const f = await fixture(t), client = await f.open();
  await client.createPiece("create-1", piece);
  await client.close();
  await assert.rejects(f.open({ identity: "wrong-partition", maxStderrBytes: 512 }), value => {
    assert(value instanceof ComputeError);
    assert.match(value.diagnostics, /identity mismatch/);
    assert(Buffer.byteLength(value.diagnostics) <= 515);
    return true;
  });
  await client.reopen();
  assert.equal((await client.readPiece({ piece_id: piece.piece })).piece.id, piece.piece);
  await client.close();
  const db = new DatabaseSync(f.options.database);
  db.exec("PRAGMA user_version=999");
  db.close();
  await assert.rejects(f.open(), value => {
    assert.match(value.diagnostics, /Unsupported memory schema 999/);
    return true;
  });
});

test("configuration rejects paths, symlinks, non-finite requests, and invalid limits before submission", async t => {
  const f = await fixture(t);
  for (const extra of [{ python: "python3" }, { database: join(f.directory, "outside.sqlite3") },
    { maxPendingRequests: 0 }, { maxRequestBytes: MAX_SAFE_INTEGER }, { requestTimeoutMs: NaN }]) {
    await assert.rejects(f.open(extra), error("INVALID_ARGUMENT"));
  }
  const client = await f.open();
  await assert.rejects(client.enforceCapacity({ max_bytes: Infinity }), error("INVALID_ARGUMENT", "not-submitted"));
  await client.close();
  if (unix) {
    await symlink(f.options.database, join(f.options.runtimeDirectory, "linked.sqlite3"));
    await assert.rejects(f.open({ database: join(f.options.runtimeDirectory, "linked.sqlite3") }), error("INVALID_ARGUMENT"));
    const link = join(f.directory, "linked-runtime");
    await symlink(f.options.runtimeDirectory, link);
    await assert.rejects(f.open({ runtimeDirectory: link, database: join(link, "database.sqlite3") }), error("INVALID_ARGUMENT"));
  }
});
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

test("launch failures are diagnosed, and concurrent close cancels explicit reopen without leaking a child", async t => {
  const f = await fixture(t);
  await assert.rejects(f.open({ python: join(f.directory, "missing-python") }), error("LAUNCH_FAILED", "not-submitted"));
  const client = await f.open();
  await client.close();
  const opening = client.reopen(), closing = client.close();
  await assert.rejects(opening, error("CLOSED", "not-submitted"));
  await closing;
  assert.equal(client.state, "closed");
  assert.equal(client.processId, undefined);
  await client.reopen();
  assert.equal(client.healthy, true);
});

test("unsupported Python is rejected at startup, before initializing runtime SQLite", { skip: !unix }, async t => {
  const f = await fixture(t);
  const executable = await fakeInterpreter(f, `import runpy
sys.version_info=(3,9,0)
sys.argv=[${JSON.stringify(join(root, "compute/worker.py"))}]+sys.argv[1:]
runpy.run_path(sys.argv[0],run_name="__main__")`);
  await assert.rejects(f.open({ python: executable }), value => {
    assert.equal(value.code, "PROCESS_EXIT");
    assert.match(value.diagnostics, /Python 3.10 or newer is required/);
    return true;
  });
  await assert.rejects(readFile(f.options.database), { code: "ENOENT" });
});

test("request/count/aggregate queue limits reject locally while worker remains healthy", async t => {
  const f = await fixture(t), client = await f.open({ maxRequestBytes: 512, maxPendingRequests: 1 });
  await assert.rejects(client.createPiece("huge", { ...piece, label: "x".repeat(1000) }), error("REQUEST_LIMIT", "not-submitted"));
  const active = client.createPiece("create-1", piece);
  await assert.rejects(client.usage(), error("QUEUE_LIMIT", "not-submitted"));
  await active;
  assert.equal(client.healthy, true);
  const byteBounded = await f.open({ database: join(f.options.runtimeDirectory, "other.sqlite3"), maxQueuedBytes: 256 });
  await assert.rejects(byteBounded.createPiece("huge", { ...piece, label: "x".repeat(500) }), error("QUEUE_LIMIT", "not-submitted"));
  assert.equal(byteBounded.healthy, true);
});

test("real process death rejects active mutation as unknown and queued mutation as unsent; explicit restart never replays", { skip: !unix }, async t => {
  const f = await fixture(t), client = await f.open();
  await client.createPiece("create-1", piece);
  process.kill(client.processId, "SIGSTOP");
  const active = client.createPiece("uncertain", { ...piece, piece: "uncertain-piece" });
  const queued = client.createPiece("unsent", { ...piece, piece: "unsent-piece" });
  const checks = [assert.rejects(active, error("PROCESS_EXIT", "unknown")),
    assert.rejects(queued, error("PROCESS_EXIT", "not-submitted"))];
  process.kill(client.processId, "SIGKILL");
  await Promise.all(checks);
  assert.equal(client.healthy, false);
  await assert.rejects(client.usage(), error("NOT_READY"));
  await client.reopen();
  assert.deepEqual((await client.listPieces({ scope: piece.scope, kind: "topic" })).map(p => p.id), [piece.piece]);
});

test("request timeout kills/reaps an actual stopped worker; no mutation retry", { skip: !unix }, async t => {
  const f = await fixture(t), client = await f.open({ requestTimeoutMs: 60, closeTimeoutMs: 100 });
  process.kill(client.processId, "SIGSTOP");
  const pid = client.processId;
  await assert.rejects(client.createPiece("uncertain", piece), error("REQUEST_TIMEOUT", "unknown"));
  await client.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await client.reopen();
  assert.equal((await client.listPieces({ scope: piece.scope, kind: "topic" })).length, 0);
});

test("close deadline bounds a stuck process and preserves uncertain vs not-submitted outcomes", { skip: !unix }, async t => {
  const f = await fixture(t), client = await f.open({ requestTimeoutMs: 3000, closeTimeoutMs: 50 });
  process.kill(client.processId, "SIGSTOP");
  const active = client.createPiece("uncertain", piece);
  const queued = client.createPiece("unsent", { ...piece, piece: "queued" });
  const checks = [assert.rejects(active, error("CLOSE_TIMEOUT", "unknown")), assert.rejects(queued, error("CLOSED", "not-submitted"))];
  await Promise.all([client.close(), ...checks]);
  assert.equal(client.state, "closed");
  await client.reopen();
  assert.equal((await client.listPieces({ scope: piece.scope, kind: "topic" })).length, 0);
});

test("real captured worker response limit terminates transport with diagnostics; no fabricated receipt", async t => {
  const f = await fixture(t), client = await f.open({ maxResponseBytes: 1024 });
  await client.createPiece("create-1", { ...piece, label: "x".repeat(900) });
  await assert.rejects(client.overview({ scope: piece.scope }), error("PROCESS_EXIT", "read-only"));
  assert.match(client.diagnostics, /response exceeded configured byte limit/);
  await client.close();
  const reopened = await f.open();
  assert.equal((await reopened.readPiece({ piece_id: piece.piece })).piece.label.length, 900);
});

test("fault subprocesses: absent/bad ready, malformed JSON, wrong identity, oversized stdout, bounded stderr", { skip: !unix }, async t => {
  for (const [name, body, code, options] of [
    ["absent ready", "time.sleep(5)", "STARTUP_TIMEOUT", { startupTimeoutMs: 100 }],
    ["wrong handshake", `${READY.replace('"identity":identity', '"identity":"wrong"')}\ntime.sleep(5)`, "PROTOCOL_ERROR", {}],
    ["bad json", `${READY}\nsys.stdin.readline()\nprint("{",flush=True)\ntime.sleep(5)`, "PROTOCOL_ERROR", {}],
    ["unknown id", `${READY}\nsys.stdin.readline()\nprint(json.dumps({"id":"wrong","ok":True,"result":{}}),flush=True)\ntime.sleep(5)`, "PROTOCOL_ERROR", {}],
    ["oversized stdout", `${READY}\nsys.stdin.readline()\nsys.stdout.write("x"*10000);sys.stdout.flush()\ntime.sleep(5)`, "RESPONSE_LIMIT", { maxResponseBytes: 1024 }],
    ["stderr tail", `${READY}\nsys.stdin.readline()\nsys.stderr.write("x"*10000+"TAIL-DIAGNOSTIC");sys.stderr.flush()\ntime.sleep(.1)\nraise RuntimeError("fixture failure")`, "PROCESS_EXIT", { maxStderrBytes: 256 }],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t), executable = await fakeInterpreter(f, body);
      if (code === "STARTUP_TIMEOUT" || name === "wrong handshake") {
        await assert.rejects(f.open({ python: executable, ...options }), error(code));
      } else {
        const client = await f.open({ python: executable, ...options });
        await assert.rejects(client.createPiece("fixture", piece), error(code, "unknown"));
        await client.close();
        if (name === "stderr tail") {
          assert(Buffer.byteLength(client.diagnostics) <= 256);
          assert.match(client.diagnostics, /fixture failure/);
        }
      }
    });
  }
});

test("committed-but-unacknowledged fixture mutation remains unknown and is never automatically replayed", { skip: !unix }, async t => {
  const f = await fixture(t);
  const executable = await fakeInterpreter(f, `${READY}
db=sqlite3.connect(database)
db.execute("CREATE TABLE IF NOT EXISTS attempts(n INTEGER)")
request=json.loads(sys.stdin.readline())
db.execute("INSERT INTO attempts VALUES(1)");db.commit();db.close()
sys.exit(42)`);
  const client = await f.open({ python: executable });
  await assert.rejects(client.createPiece("uncertain", piece), error("PROCESS_EXIT", "unknown"));
  await client.close();
  await client.reopen();
  await sleep(50);
  const db = new DatabaseSync(f.options.database);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM attempts").get().n, 1); }
  finally { db.close(); }
});

test("restricted Python entrypoint rejects explicit-memory and arbitrary methods on private stdio", async t => {
  const f = await fixture(t);
  const child = spawn(python, ["-I", "-S", "-B", "-u", join(root, "compute/worker.py"),
    "--database", f.options.database, "--identity", f.options.identity,
    "--max-request-bytes", "8192", "--max-response-bytes", "8192"], {
    cwd: f.options.runtimeDirectory, env: { TMPDIR: f.options.runtimeDirectory }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "close");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exit; });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  for (const [index, method] of ["explicit_propose", "explicit_get", "exec", "__dict__"].entries()) {
    child.stdin.write(JSON.stringify({ protocol: 1, id: String(index), method, operation_id: "blocked", params: {} }) + "\n");
  }
  child.stdin.end();
  assert.deepEqual(await exit, [0, null], stderr);
  const responses = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(responses[0].type, "ready");
  assert(responses.slice(1).every(reply => !reply.ok && reply.error.code === "ACCESS_DENIED"));
});

test("generated wrapper and captured package parse with the explicitly selected test interpreter", async () => {
  const paths = ["worker.py", ...["__init__.py", "__main__.py", "engine.py", "memory.py"].map(name => `pkm_memory_engine/${name}`)];
  execFileSync(python, ["-I", "-S", "-B", "-c",
    "import ast,pathlib,sys; [ast.parse(pathlib.Path(p).read_text(encoding='utf-8'),filename=p) for p in sys.argv[1:]]",
    ...paths.map(path => join(root, "compute", path))], {
    cwd: root, env: { TMPDIR: join(root, "tests") },
  });
  const provenance = JSON.parse(await readFile(join(root, "migration/compute-provenance.json"), "utf8"));
  assert.equal(provenance.files.length, 4);
  assert.equal(dirname(fileURLToPath(new URL("../compute/worker.py", import.meta.url))), join(root, "compute"));
});
