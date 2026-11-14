"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const extensionPath = process.env.PKM_TEST_NEXT_EXTENSION;
const python = process.env.PKM_TEST_LEGACY_PYTHON;
const providers = new Map(), commands = new Map();
const api = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  McpStdioServerDefinition: class { constructor(label, command, args, env, version) {
    Object.assign(this, { label, command, args, env, version });
  } },
  lm: { registerMcpServerDefinitionProvider(id, provider) {
    providers.set(id, provider); return { dispose() { providers.delete(id); } };
  } },
  commands: { registerCommand(id, handler) {
    commands.set(id, handler); return { dispose() { commands.delete(id); } };
  } },
};
const load = Module._load;
Module._load = function (request, ...args) {
  if (request === "vscode") return api;
  return load.call(this, request, ...args);
};
const { registerPrivateNextMcp } = require(path.join(dist, "runtime/next-mcp-private-activation"));
Module._load = load;

test("private activation is absent by default and rejects an overlapping original root", async () => {
  const previous = process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE;
  delete process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE;
  try {
    const context = { subscriptions: [] };
    await registerPrivateNextMcp(context, () => { throw Error("not called"); }, () => { throw Error("not called"); });
    assert.equal(context.subscriptions.length, 0);
    const parent = path.resolve(".migration-test-work", `next-private-overlap-${randomUUID()}`);
    const workspace = path.join(parent, "workspace");
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE = workspace;
    await assert.rejects(registerPrivateNextMcp(context, () => parent, () => ""), /separate from the original root/);
    assert.equal(context.subscriptions.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE;
    else process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE = previous;
  }
});

test("private activation binds a separate pinned workspace and rejects root changes",
  { skip: !extensionPath || !python, timeout: 60000 }, async t => {
    const parent = path.resolve(".migration-test-work", `next-private-activation-${randomUUID()}`);
    const old = path.join(parent, "old"), next = path.join(parent, "next"), root = path.join(next, "workspace");
    fs.mkdirSync(old, { recursive: true, mode: 0o700 });
    fs.mkdirSync(next, { mode: 0o700 });
    const cli = path.join(extensionPath, "next-runtime/server/dist/cli.js");
    const storage = path.join(extensionPath, "next-runtime/server/dist/storage.js");
    const env = { ...process.env, TMPDIR: parent };
    const init = spawnSync(process.execPath, [cli, "init", "--data", root], { env, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    fs.chmodSync(root, 0o700);
    const create = spawnSync(process.execPath, ["-e",
      "import(process.argv[1]).then(async s => { const db = await s.Storage.open(process.argv[2]); await db.close(); }).catch(e => { console.error(e); process.exitCode = 1; });",
      storage, root], { env, encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);
    const previous = process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE;
    process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE = root;
    const context = { extensionPath, subscriptions: [] };
    t.after(() => {
      for (const subscription of context.subscriptions) subscription.dispose();
      if (previous === undefined) delete process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE;
      else process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE = previous;
    });
    let legacy = old;
    await registerPrivateNextMcp(context, () => legacy, () => python);
    await assert.rejects(registerPrivateNextMcp({ extensionPath, subscriptions: [] }, () => legacy, () => python),
      error => error.code === "EEXIST");
    const provider = providers.get("personalKnowledge.nextPrivate");
    const definition = provider.provideMcpServerDefinitions()[0];
    assert.equal(definition.label, "pkm-next-private");
    assert.equal(commands.get("_personalKnowledge.privateNextMcpStatus")().cutoverAuthorized, false);
    await assert.rejects(commands.get("_personalKnowledge.privateNextMcpRestart")(), /verified owned-tree exit/);
    const connect = async () => {
      const current = provider.provideMcpServerDefinitions()[0];
      provider.resolveMcpServerDefinition(current);
      const transport = new StdioClientTransport({ command: current.command, args: current.args, cwd: parent,
        env: { ...process.env, ...current.env, TMPDIR: parent }, stderr: "pipe" });
      const client = new Client({ name: "private-owned-activation", version: "1.0.0" });
      await client.connect(transport);
      return client;
    };
    let client = await connect();
    t.after(async () => { if (client) await client.close().catch(() => {}); });
    const { DatabaseSync } = require("node:sqlite");
    const lock = new DatabaseSync(path.join(root, "core.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    let writing, draining;
    try {
      writing = client.callTool({ name: "capability_call", arguments: { operation: "mcp.tool.add_note", version: 1,
        arguments: { title: "Supervised Note", content: "in-flight before restart" } } });
      for (let i = 0; i < 2000; i++) {
        if (commands.get("_personalKnowledge.privateNextMcpStatus")().connection?.inFlight === 1) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(commands.get("_personalKnowledge.privateNextMcpStatus")().connection?.inFlight, 1);
      draining = commands.get("_personalKnowledge.privateNextMcpDrain")();
      assert.equal(commands.get("_personalKnowledge.privateNextMcpStatus")().state, "draining");
      await assert.rejects(commands.get("_personalKnowledge.privateNextMcpRestart")(), /verified owned-tree exit/);
      lock.exec("COMMIT");
    } finally { lock.close(); }
    assert.notEqual((await writing).isError, true);
    assert.equal((await draining).state, "stopped");
    await client.close(); client = undefined;
    assert.deepEqual(await commands.get("_personalKnowledge.privateNextMcpRestart")(),
      { state: "accepting", cutoverAuthorized: false });
    client = await connect();
    const read = await client.callTool({ name: "capability_read", arguments: {
      operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Supervised Note" } } });
    assert.notEqual(read.isError, true);
    assert.match(read.content[0].text, /in-flight before restart/);
    assert.equal((await commands.get("_personalKnowledge.privateNextMcpDrain")()).state, "stopped");
    await client.close(); client = undefined;
    const finalDefinition = provider.provideMcpServerDefinitions;
    legacy = root;
    assert.throws(() => finalDefinition(), /binding changed/);
    legacy = old;
    fs.renameSync(old, `${old}-original`);
    fs.mkdirSync(old, { mode: 0o700 });
    assert.throws(() => finalDefinition(), /binding changed/);
  });
