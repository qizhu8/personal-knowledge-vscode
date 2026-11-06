import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { resultEnvelope } from "../dist/contracts.js";

const cli = resolve("dist/cli.js");
const executeFile = promisify(execFile);
const token = randomUUID() + randomUUID();
const owner = { id: "local:owner", canWrite: true };
const reader = { id: "local:reader", canWrite: false };
const invoke = (operation, args) => ({ operation, version: 1, arguments: args });
const cleanups = new WeakMap();
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "pkm-next-"));
  const actions = [];
  cleanups.set(t, actions);
  t.after(async () => {
    try { for (const action of actions.reverse()) await action(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  const directory = join(parent, "workspace");
  await initialize(directory);
  return { parent, directory };
}
async function httpProcess(t, directory, extra = []) {
  const child = spawn(process.execPath, [cli, "http", "--data", directory, ...extra], {
    env: { ...process.env, PKM_NEXT_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  cleanups.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  const url = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Server readiness timeout: ${diagnostics}`)); }, 10000);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.ready) { clearTimeout(timeout); resolve(message.url); }
      } catch (error) { clearTimeout(timeout); reject(error); }
    });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${diagnostics}`)); });
  });
  const call = async (method, input, headers = {}) => {
    const response = await fetch(`${url}/v1/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  return { child, url, call };
}

test("workspace initialization refuses existing/legacy directories and never imports old data", async t => {
  const { parent, directory } = await fixture(t);
  await assert.rejects(initialize(directory), /EEXIST/);
  const legacy = join(parent, "legacy");
  await mkdir(legacy); await writeFile(join(legacy, "note.md"), "untouched");
  await assert.rejects(Storage.open(legacy), /isolated/);
  assert.equal(await readFile(join(legacy, "note.md"), "utf8"), "untouched");
  assert.deepEqual(await readdir(legacy), ["note.md"]);
  const linked = join(parent, "linked");
  await symlink(directory, linked, "dir");
  await assert.rejects(Storage.open(linked), /symlinks/);
});

test("Core applies strict schemas, actor authority, CAS, receipt identity, trash and revision-pinned pages", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory); cleanups.get(t).push(() => storage.close());
  const core = new Core(storage);
  const execute = (method, args, actor = owner) => core.dispatch(method, args, actor);
  const create = invoke("knowledge.document.create", { id: "a", operationId: randomUUID(), title: "First", content: "body" });
  assert.equal((await execute("capability_call", create, reader)).error.code, "ACCESS_DENIED");
  assert.equal((await execute("capability_read", create)).error.code, "ACCESS_DENIED");
  assert.equal((await execute("capability_call", { ...create, arguments: { ...create.arguments, ownerId: "fake" } })).error.code, "INVALID_ARGUMENT");
  assert.equal((await execute("capability_call", create)).result.revision, 1);
  assert.equal((await execute("capability_call", create)).result.revision, 1);
  assert.equal((await execute("capability_call", { ...create, arguments: { ...create.arguments, content: "different" } })).error.code, "CONFLICT");
  const listing = await execute("capability_read", invoke("knowledge.document.list", { limit: 1 }));
  const updates = await Promise.all(["one", "two"].map(content => execute("capability_call",
    invoke("knowledge.document.update", { id: "a", operationId: randomUUID(), expectedRevision: 1, title: "First", content }))));
  assert.equal(updates.filter(result => result.result).length, 1);
  assert.equal(updates.filter(result => result.error?.code === "CONFLICT").length, 1);
  assert.equal((await execute("capability_read", invoke("knowledge.document.list", { workspaceRevision: listing.result.workspaceRevision }))).error.code, "CONFLICT");
  const trash = await execute("capability_call", invoke("knowledge.document.trash", { id: "a", operationId: randomUUID(), expectedRevision: 2 }));
  assert.equal(trash.result.deleted, true);
  assert.equal((await execute("capability_read", invoke("knowledge.document.list", {}))).result.total, 0);
  const restored = await execute("capability_call", invoke("knowledge.document.restore", { id: "a", operationId: randomUUID(), expectedRevision: 3 }));
  assert.equal(restored.result.revision, 4);
  assert.equal(restored.result.deleted, false);
  const available = await execute("capabilities_search", {}, reader);
  assert.equal(available.result.items.length, 2);
  assert(available.result.items.every(item => item.readOnly));
  assert.equal((await execute("capabilities_search", { revision: "0".repeat(64) })).error.code, "CONFLICT");
  assert.equal((await execute("capabilities_describe", { operation: create.operation }, reader)).error.code, "NOT_FOUND");
});

test("real HTTP and MCP share contracts and persisted state across processes and restart", { timeout: 30000 }, async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  assert.equal((await http.call("server_info", {})).status, 200);
  assert.equal((await http.call("server_info", {}, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await http.call("server_info", {}, { origin: "https://untrusted.example" })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = request(`${http.url}/v1/server_info`, { method: "POST", headers: {
      host: "other.example", authorization: `Bearer ${token}`, "content-type": "application/json",
    } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end("{}");
  });
  assert.equal(invalidHost, 403);
  const create = invoke("knowledge.document.create", { id: "shared", operationId: randomUUID(), title: "Shared", content: "Persisted" });
  const created = await http.call("capability_call", create);
  assert.equal(created.status, 200);
  assert(resultEnvelope.safeParse(created.body).success);
  assert(resultEnvelope.safeParse((await http.call("server_info", {}, { authorization: "Bearer wrong" })).body).success);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--data", directory], stderr: "pipe" });
  const client = new Client({ name: "next-server-test", version: "1.0.0" });
  cleanups.get(t).push(() => client.close());
  await client.connect(transport);
  const mcpCall = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const envelope = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert(resultEnvelope.safeParse(envelope).success);
    return envelope;
  };
  assert.equal((await client.listTools()).tools.length, 5);
  const read = invoke("knowledge.document.get", { id: "shared" });
  assert.deepEqual((await mcpCall("capability_read", read)).result, created.body.result);
  const contract = { operation: "knowledge.document.update" };
  assert.deepEqual((await mcpCall("capabilities_describe", contract)).result, (await http.call("capabilities_describe", contract)).body.result);
  const competing = await Promise.all([
    http.call("capability_call", invoke("knowledge.document.update", { id: "shared", operationId: randomUUID(), expectedRevision: 1, title: "HTTP", content: "HTTP update" })).then(result => result.body),
    mcpCall("capability_call", invoke("knowledge.document.update", { id: "shared", operationId: randomUUID(), expectedRevision: 1, title: "MCP", content: "MCP update" })),
  ]);
  assert.equal(competing.filter(result => result.result).length, 1);
  assert.equal(competing.filter(result => result.error?.code === "CONFLICT").length, 1);
  assert.deepEqual((await mcpCall("capability_call", create)).result, created.body.result, "replay across transport returns the original receipt, not another write");
  const final = (await mcpCall("capability_read", read)).result;
  await client.close();
  http.child.kill("SIGTERM");
  assert.deepEqual(await once(http.child, "exit"), [0, null], "SIGTERM must drain and exit cleanly");
  const restarted = await httpProcess(t, directory);
  assert.deepEqual((await restarted.call("capability_read", read)).body.result, final);
  assert.deepEqual((await restarted.call("capability_call", create)).body.result, created.body.result);
  const readOnly = await httpProcess(t, directory, ["--read-only"]);
  assert.equal((await readOnly.call("capability_call", create)).status, 403);
  assert.equal((await readOnly.call("capabilities_search", {})).body.result.total, 2);
});

test("HTTP rejects malformed/oversized inputs without committing", async t => {
  const { directory } = await fixture(t);
  const http = await httpProcess(t, directory);
  for (const [body, contentType, status] of [
    ["{", "application/json", 400],
    ["{}", "text/plain", 400],
    [JSON.stringify({ padding: "x".repeat(131073) }), "application/json", 413],
  ]) {
    const response = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": contentType }, body,
    });
    assert.equal(response.status, status);
    const envelope = await response.json();
    assert(resultEnvelope.safeParse(envelope).success);
    assert.equal(envelope.error.effect, "not-committed");
  }
  const invalid = await http.call("capability_call", invoke("knowledge.document.create", {
    id: "../escape", operationId: randomUUID(), title: "Bad", content: "no",
  }));
  assert.equal(invalid.body.error.code, "INVALID_ARGUMENT");
  assert.equal((await http.call("capability_read", invoke("knowledge.document.list", {}))).body.result.total, 0);
});

test("bounded worker queue drains on shutdown and the Core event loop remains responsive during a database lock", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory); cleanups.get(t).push(() => storage.close());
  const core = new Core(storage);
  await core.dispatch("capability_call", invoke("knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "original" }), owner);
  const db = new DatabaseSync(join(directory, "core.sqlite")); cleanups.get(t).push(() => db.close());
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = core.dispatch("capability_call", invoke("knowledge.document.update", {
      id: "a", operationId: randomUUID(), expectedRevision: 1, title: "A", content: "updated",
    }), owner);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await core.dispatch("server_info", {}, owner)).result.name, "pkm-next");
    db.exec("COMMIT");
    assert.equal((await update).result.revision, 2);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  const requests = Array.from({ length: 40 }, () => storage.request({ operation: "knowledge.document.get", args: { id: "a" }, actorId: owner.id }));
  const outcomes = Promise.allSettled(requests);
  await storage.close();
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 32);
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(rejected.length, 8);
  assert(rejected.every(result => result.reason.code === "BUSY" && result.reason.effect === "not-committed"));
  await assert.rejects(storage.request({ operation: "knowledge.document.get", args: { id: "a" }, actorId: owner.id }), /closed/);
});

test("pagination is deterministic, bounded and metadata-only; replay survives later writes and actor changes are rejected", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory); cleanups.get(t).push(() => storage.close());
  const core = new Core(storage);
  const execute = (method, args, actor = owner) => core.dispatch(method, args, actor);
  const first = invoke("knowledge.document.create", { id: "a", operationId: randomUUID(), title: "A", content: "secret" });
  await execute("capability_call", first);
  await execute("capability_call", invoke("knowledge.document.create", { id: "b", operationId: randomUUID(), title: "B", content: "secret" }));
  const page = (await execute("capability_read", invoke("knowledge.document.list", { limit: 1 }))).result;
  assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, "a");
  assert(!Object.hasOwn(page.items[0], "content"));
  const next = (await execute("capability_read", invoke("knowledge.document.list", { limit: 1, offset: page.nextOffset, workspaceRevision: page.workspaceRevision }))).result;
  assert.equal(next.items[0].id, "b"); assert.equal(next.nextOffset, null);
  assert.equal((await execute("capability_call", first)).result.revision, 1);
  assert.equal((await execute("capability_call", first, { id: "different-owner", canWrite: true })).error.code, "CONFLICT");
  assert.equal((await execute("capability_read", invoke("knowledge.document.list", { limit: 101 }))).error.code, "INVALID_ARGUMENT");
});

test("unsupported database versions fail at startup without silently downgrading", async t => {
  const { directory } = await fixture(t);
  const db = new DatabaseSync(join(directory, "core.sqlite"));
  db.exec("PRAGMA user_version=999"); db.close();
  await assert.rejects(Storage.open(directory), /Unsupported workspace database version/);
  const check = new DatabaseSync(join(directory, "core.sqlite"));
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 999);
  check.close();
});

test("shutdown drains a pending write and its receipt survives a fresh worker", async t => {
  const { directory } = await fixture(t);
  const storage = await Storage.open(directory);
  const request = {
    operation: "knowledge.document.create",
    args: { id: "during-shutdown", operationId: randomUUID(), title: "Shutdown", content: "committed" },
    actorId: owner.id,
  };
  const pendingWrite = storage.request(request);
  await Promise.all([storage.close(), storage.close()]);
  const committed = await pendingWrite;
  assert.equal(committed.revision, 1);
  const reopened = await Storage.open(directory);
  cleanups.get(t).push(() => reopened.close());
  assert.deepEqual(await reopened.request(request), committed);
});

test("read-only MCP exposes only read tools and rejects write attempts", async t => {
  const { directory } = await fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, "mcp", "--data", directory, "--read-only"], stderr: "pipe",
  });
  const client = new Client({ name: "read-only-test", version: "1.0.0" });
  cleanups.get(t).push(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 4);
  assert(tools.every(tool => tool.annotations.readOnlyHint && tool.outputSchema));
  const denied = await client.callTool({ name: "capability_call", arguments: invoke("knowledge.document.create", {
    id: "denied", operationId: randomUUID(), title: "Denied", content: "must not write",
  }) });
  assert.equal(denied.isError, true);
  const result = await client.callTool({ name: "capabilities_search", arguments: {} });
  assert.equal(result.structuredContent.result.total, 2);
  assert(result.structuredContent.result.items.every(item => item.readOnly));
});

test("committed writes and receipts recover after an abrupt HTTP process exit", async t => {
  const { directory } = await fixture(t);
  const first = await httpProcess(t, directory);
  const create = invoke("knowledge.document.create", {
    id: "crash-recovery", operationId: randomUUID(), title: "Recover", content: "WAL committed",
  });
  const committed = await first.call("capability_call", create);
  assert.equal(committed.status, 200);
  first.child.kill("SIGKILL");
  assert.equal((await once(first.child, "exit"))[1], "SIGKILL");
  const restarted = await httpProcess(t, directory);
  assert.deepEqual((await restarted.call("capability_read", invoke("knowledge.document.get", { id: "crash-recovery" }))).body.result, committed.body.result);
  assert.deepEqual((await restarted.call("capability_call", create)).body.result, committed.body.result);
});

test("CLI initializes only a new workspace and rejects insecure startup before opening storage", async t => {
  const { parent } = await fixture(t);
  const directory = join(parent, "cli-workspace");
  const initialized = await executeFile(process.execPath, [cli, "init", "--data", directory]);
  assert.equal(JSON.parse(initialized.stdout).initialized, directory);
  await assert.rejects(executeFile(process.execPath, [cli, "init", "--data", directory]), /EEXIST/);
  await assert.rejects(executeFile(process.execPath, [cli, "http", "--data", directory], {
    env: { ...process.env, PKM_NEXT_TOKEN: "" },
  }), /PKM_NEXT_TOKEN/);
  assert.deepEqual(await readdir(directory), [".pkm-next-workspace"], "invalid transport config must not open/create the database");
});
