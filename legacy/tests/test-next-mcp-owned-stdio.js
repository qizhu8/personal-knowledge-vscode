"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Duplex, PassThrough } = require("node:stream");
const { ownNextMcpStdio } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/next-mcp-owned-stdio"));
const { createNextMcpProviderRoute } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/next-mcp-provider-route"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async fn => {
  for (let i = 0; i < 2000; i++) { if (fn()) return; await pause(10); }
  throw new Error("Timed out waiting for fixture.");
};

function fixture(verifyDescendants = async () => {}, assertAdmission = () => {}) {
  const directory = path.resolve(".migration-test-work", `next-mcp-owner-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = path.join(directory, "written");
  const script = `
    const fs = require("node:fs");
    const readline = require("node:readline");
    let request;
    readline.createInterface({input:process.stdin}).on("line", line => {
      const m = JSON.parse(line);
      if (m.method === "hold") { request = m; process.send("held"); }
      else if (m.method === "ping") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:"pong"})+"\\n");
      else if (m.method === "challenge") {
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:"challenge",method:"elicitation/create",params:{}})+"\\n");
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:"pending"})+"\\n");
      }
    }).on("close", () => process.exit(0));
    process.on("message", m => {
      if (m === "release") {
        fs.writeFileSync(process.argv[1], "completed write");
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:"committed"})+"\\n");
      } else if (m === "crash") process.exit(7);
    });
  `;
  const child = spawn(process.execPath, ["-e", script, output], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const toOwner = new PassThrough(), fromOwner = new PassThrough();
  const stream = Duplex.from({ readable: toOwner, writable: fromOwner });
  const messages = [];
  let buffer = "";
  fromOwner.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line) messages.push(JSON.parse(line));
  });
  const write = message => toOwner.write(`${JSON.stringify(message)}\n`);
  const owner = ownNextMcpStdio(child, verifyDescendants, assertAdmission);
  owner.attach(stream);
  return { child, owner, stream, messages, write, output };
}

test("owned MCP drains the exact child and rejects new work while preserving an in-flight write", async () => {
  const f = fixture();
  const held = new Promise(resolve => f.child.once("message", resolve));
  f.write({ jsonrpc: "2.0", id: 1, method: "hold" });
  await held;
  assert.equal(f.owner.status().inFlight, 1);
  let closed = false;
  const drain = f.owner.drainAndClose().then(value => { closed = true; return value; });
  assert.equal(f.owner.status().state, "draining");
  f.write({ jsonrpc: "2.0", id: 2, method: "ping" });
  await waitFor(() => f.messages.some(message => message.id === 2));
  assert.equal(f.messages.find(message => message.id === 2).error.code, -32000);
  assert.equal(closed, false);
  assert.throws(() => f.owner.attach(Duplex.from({ readable: new PassThrough(), writable: new PassThrough() })), /admission/);
  f.child.send("release");
  assert.deepEqual(await drain, { state: "stopped", pid: f.child.pid, cutoverAuthorized: false });
  assert.equal(fs.readFileSync(f.output, "utf8"), "completed write");
  assert.equal(f.messages.find(message => message.id === 1).result, "committed");
  assert.equal(f.owner.status().state, "stopped");
});

test("unexpected exit during an in-flight request makes retirement unknown", async () => {
  const f = fixture();
  const held = new Promise(resolve => f.child.once("message", resolve));
  f.write({ jsonrpc: "2.0", id: 7, method: "hold" });
  await held;
  const drain = f.owner.drainAndClose();
  f.child.send("crash");
  await assert.rejects(drain, /exit was not a verified drained exit/);
  assert.equal(f.owner.status().state, "unknown");
  assert.equal(f.stream.destroyed, true);
  assert.equal(fs.existsSync(f.output), false);
});

test("unexpected child exit closes the transport even before a drain is requested", async () => {
  const f = fixture();
  const held = new Promise(resolve => f.child.once("message", resolve));
  f.write({ jsonrpc: "2.0", id: 9, method: "hold" });
  await held;
  f.child.send("crash");
  await waitFor(() => f.stream.destroyed);
  assert.equal(f.owner.status().state, "unknown");
  await assert.rejects(f.owner.drainAndClose(), /not ready to drain/);
});

test("a stalled in-flight request makes bounded drain unknown, without killing the child", async () => {
  const f = fixture();
  const held = new Promise(resolve => f.child.once("message", resolve));
  f.write({ jsonrpc: "2.0", id: 10, method: "hold" });
  await held;
  await assert.rejects(f.owner.drainAndClose(100), /timed out/);
  assert.equal(f.owner.status().state, "unknown");
  assert.equal(f.child.exitCode, null);
  assert.equal(f.stream.destroyed, true);
  const exited = new Promise(resolve => f.child.once("close", resolve));
  f.child.kill("SIGTERM");
  await exited;
});

test("aborted owned lifecycle control makes the outcome unknown and cannot authorize exit", async () => {
  const f = fixture();
  const abort = new AbortController();
  const control = f.owner.callLegacyLifecycleTool("mcp_lifecycle_quiesce", abort.signal);
  f.owner.beginDrain();
  abort.abort();
  await assert.rejects(control, /outcome is unknown/);
  assert.equal(f.owner.status().state, "unknown");
  await assert.rejects(f.owner.drainAndClose(), /not ready to drain/);
  const exited = new Promise(resolve => f.child.once("close", resolve));
  f.child.kill("SIGTERM");
  await exited;
});

test("drain waits for server-initiated requests and permits their response", async () => {
  const f = fixture();
  f.write({ jsonrpc: "2.0", id: 8, method: "challenge" });
  await waitFor(() => f.messages.some(message => message.id === 8) && f.owner.status().inFlight === 0);
  assert.equal(f.owner.status().serverRequests, 1);
  let closed = false;
  const draining = f.owner.drainAndClose().then(value => { closed = true; return value; });
  await pause(30);
  assert.equal(closed, false);
  f.write({ jsonrpc: "2.0", id: "challenge", result: { action: "decline" } });
  assert.deepEqual(await draining, { state: "stopped", pid: f.child.pid, cutoverAuthorized: false });
});

test("successful child exit cannot authorize retirement without descendant exit evidence", async () => {
  const f = fixture(async () => { throw new Error("backend exit unknown"); });
  await assert.rejects(f.owner.drainAndClose(), /descendant exit could not be verified/);
  assert.equal(f.owner.status().state, "unknown");
  assert.equal(f.stream.destroyed, true);
});

test("revoked authority rejects subsequent work without dispatching it", async () => {
  let allowed = true;
  const f = fixture(async () => {}, () => { if (!allowed) throw new Error("revoked"); });
  allowed = false;
  f.write({ jsonrpc: "2.0", id: 8, method: "ping" });
  await waitFor(() => f.messages.some(message => message.id === 8));
  assert.match(f.messages[0].error.message, /authority is unavailable/);
  assert.equal(f.owner.status().state, "unknown");
  const exited = new Promise(resolve => f.child.once("close", resolve));
  f.child.kill("SIGTERM");
  await exited;
});

test("the owner retires the real Next compatibility subprocess and preserves a Note across restart",
  { skip: !process.env.PKM_TEST_NEXT_EXTENSION || !process.env.PKM_TEST_LEGACY_PYTHON, timeout: 60000 }, async t => {
    const extensionPath = process.env.PKM_TEST_NEXT_EXTENSION, python = process.env.PKM_TEST_LEGACY_PYTHON;
    const parent = path.resolve(".migration-test-work", `next-mcp-owned-real-${randomUUID()}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, "workspace"), cli = path.join(extensionPath, "next-runtime/server/dist/cli.js");
    const init = spawnSync(process.execPath, [cli, "init", "--data", root], {
      cwd: parent, encoding: "utf8", timeout: 30000, env: { ...process.env, TMPDIR: parent },
    });
    assert.equal(init.status, 0, init.stderr);
    const route = createNextMcpProviderRoute({ authority: { root, assertCurrent() {} }, extensionPath,
      executable: process.execPath, profile: "legacy-compact-experimental", compatibilityPython: python,
      createDefinition: (label, command, args, env, version) => ({ label, command, args, env, version }) });
    const children = [], descendants = [];
    const processIdentity = pid => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        return { pid, started: fields[19], state: fields[0] };
      } catch { return undefined; }
    };
    const sameProcess = identity => {
      const current = processIdentity(identity.pid);
      return current?.started === identity.started && !["Z", "X"].includes(current.state);
    };
    t.after(async () => {
      route.dispose();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve() : new Promise(resolve => child.once("close", resolve))));
      for (const identity of descendants) if (sameProcess(identity)) process.kill(identity.pid, "SIGTERM");
    });
    const connect = async () => {
      const def = route.provideMcpServerDefinitions()[0];
      route.resolveMcpServerDefinition(def);
      const child = spawn(def.command, def.args, { cwd: parent, env: { ...process.env, ...def.env, TMPDIR: parent },
        stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      let stderr = "";
      child.stderr.on("data", bytes => { stderr += bytes.toString(); });
      const toOwner = new PassThrough(), fromOwner = new PassThrough();
      let backend;
      const owner = ownNextMcpStdio(child, async () => {
        if (process.platform !== "linux") throw new Error("No verified descendant observer.");
        if (!backend) throw new Error("No bound Next backend process.");
        await waitFor(() => !sameProcess(backend));
      });
      owner.attach(Duplex.from({ readable: toOwner, writable: fromOwner }));
      const messages = [];
      let buffer = "";
      fromOwner.on("data", bytes => {
        buffer += bytes;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) if (line) messages.push(JSON.parse(line));
      });
      const request = async (id, method, params) => {
        toOwner.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        await waitFor(() => messages.some(message => message.id === id) || owner.status().state === "unknown");
        const reply = messages.find(message => message.id === id);
        assert(reply, stderr);
        assert.equal(reply.error, undefined, JSON.stringify(reply));
        return reply.result;
      };
      await request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "private-owned-next", version: "1" } });
      toOwner.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      if (process.platform === "linux") {
        await waitFor(() => {
          const ids = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/);
          backend = ids.map(Number).filter(Number.isSafeInteger).filter(Boolean).map(processIdentity).find(Boolean);
          return !!backend;
        });
        descendants.push(backend);
      }
      return { owner, child, request, backend };
    };
    const first = await connect();
    const { DatabaseSync } = require("node:sqlite");
    const lock = new DatabaseSync(path.join(root, "core.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    let added, retirement;
    try {
      const writing = first.request(2, "tools/call", { name: "capability_call",
        arguments: { operation: "mcp.tool.add_note", version: 1,
          arguments: { title: "Owned route", content: "same root after exact child exit" } } });
      await waitFor(() => first.owner.status().inFlight === 1);
      let drained = false;
      retirement = first.owner.drainAndClose().then(value => { drained = true; return value; });
      await pause(150);
      assert.equal(drained, false);
      lock.exec("COMMIT");
      added = await writing;
    } finally { lock.close(); }
    assert.notEqual(added.isError, true, JSON.stringify(added));
    assert.equal(JSON.parse(added.content[0].text).slug, "Owned route");
    assert.deepEqual(await retirement, { state: "stopped", pid: first.child.pid, cutoverAuthorized: false });
    const second = await connect();
    const read = await second.request(2, "tools/call", { name: "capability_read",
      arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Owned route" } } });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.match(read.content[0].text, /same root after exact child exit/);
    assert.deepEqual(await second.owner.drainAndClose(), { state: "stopped", pid: second.child.pid, cutoverAuthorized: false });
  });
