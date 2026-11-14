"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const extensionPath = process.env.PKM_TEST_NEXT_EXTENSION;
const { createNextMcpProviderRoute } = require(path.join(dist, "runtime/next-mcp-provider-route"));
const definition = (label, command, args, env, version) => ({ label, command, args, env, version });

test("isolated Next provider definition launches the verified real MCP and preserves a Note over restart",
  { skip: !extensionPath, timeout: 60000 }, async t => {
    const parent = path.resolve(".migration-test-work", `next-mcp-route-${randomUUID()}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, "workspace"), cli = path.join(extensionPath, "next-runtime/server/dist/cli.js");
    const init = spawnSync(process.execPath, [cli, "init", "--data", root], {
      cwd: parent, encoding: "utf8", timeout: 30000, env: { ...process.env, TMPDIR: parent },
    });

    assert.equal(init.status, 0, init.stderr);
    let active = true;
    const authority = { root, assertCurrent() { if (!active) throw Error("owner revoked"); } };
    const route = createNextMcpProviderRoute({ authority, extensionPath, executable: process.execPath, createDefinition: definition });
    const first = route.provideMcpServerDefinitions()[0];
    assert.strictEqual(route.resolveMcpServerDefinition(first), first);
    assert.equal(first.label, "pkm");
    assert.deepEqual(first.args, [cli, "mcp", "--data", root]);
    first.args[1] = "http";
    assert.throws(() => route.resolveMcpServerDefinition(first), /definition changed/);
    first.args[1] = "mcp";
    const connect = async () => {
      const current = route.provideMcpServerDefinitions()[0];
      route.resolveMcpServerDefinition(current);
      const transport = new StdioClientTransport({ command: current.command, args: current.args, cwd: parent,
        env: { ...process.env, ...current.env, TMPDIR: parent }, stderr: "pipe" });
      const client = new Client({ name: "private-next-provider-test", version: "1.0.0" });
      await client.connect(transport);
      return client;
    };
    let client;
    t.after(async () => { if (client) await client.close().catch(() => {}); route.dispose(); });
    client = await connect();
    const invoke = (method, operation, args) => client.callTool({ name: method, arguments: { operation, version: 1, arguments: args } });
    const created = await invoke("capability_call", "knowledge.document.create",
      { id: "route-note", title: "Route Note", content: "private provider data", operationId: randomUUID() });
    assert.equal(created.isError, false);
    assert.equal(created.structuredContent.result.revision, 1);
    await client.close(); client = undefined;
    client = await connect();
    const read = await invoke("capability_read", "knowledge.document.get", { id: "route-note" });
    assert.equal(read.isError, false);
    assert.equal(read.structuredContent.result.content, "private provider data");
    assert.throws(() => route.resolveMcpServerDefinition(first), /stale/);
    await client.close(); client = undefined;
    const original = `${root}-original`;
    fs.renameSync(root, original);
    fs.mkdirSync(root, { mode: 0o700 });
    assert.throws(() => route.provideMcpServerDefinitions(), /replaced/);
    fs.rmdirSync(root);
    fs.renameSync(original, root);
    active = false;
    assert.throws(() => route.provideMcpServerDefinitions(), /owner revoked/);
  });

test("isolated compatibility provider uses real Next MCP to write and recover a legacy Note",
  { skip: !extensionPath || !process.env.PKM_TEST_LEGACY_PYTHON, timeout: 60000 }, async t => {
    const parent = path.resolve(".migration-test-work", `next-mcp-compat-route-${randomUUID()}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, "workspace"), cli = path.join(extensionPath, "next-runtime/server/dist/cli.js");
    const python = process.env.PKM_TEST_LEGACY_PYTHON;
    const executable = process.env.PKM_TEST_ELECTRON || process.execPath;
    const init = spawnSync(process.execPath, [cli, "init", "--data", root], {
      cwd: parent, encoding: "utf8", timeout: 30000, env: { ...process.env, TMPDIR: parent },
    });
    assert.equal(init.status, 0, init.stderr);
    const route = createNextMcpProviderRoute({ authority: { root, assertCurrent() {} }, extensionPath,
      executable, profile: "legacy-compact-experimental", compatibilityPython: python,
      createDefinition: definition });
    let client;
    t.after(async () => { if (client) await client.close().catch(() => {}); route.dispose(); });
    const connect = async () => {
      const current = route.provideMcpServerDefinitions()[0];
      assert.equal(current.command, python);
      assert.match(current.version, /^[a-f0-9]{64}\.legacy-compact-experimental$/);
      assert.deepEqual(current.args, ["-B", path.join(extensionPath, "next-runtime/server/compat/legacy-compact-mcp.py"),
        "--data", root, "--node", fs.realpathSync(executable), "--allow-writes"]);
      current.args.pop();
      assert.throws(() => route.resolveMcpServerDefinition(current), /definition changed/);
      current.args.push("--allow-writes");
      route.resolveMcpServerDefinition(current);
      const transport = new StdioClientTransport({ command: current.command, args: current.args, cwd: parent,
        env: { ...process.env, ...current.env, TMPDIR: parent }, stderr: "pipe" });
      const next = new Client({ name: "private-next-legacy-provider-test", version: "1.0.0" });
      await next.connect(transport);
      return next;
    };
    const invoke = (name, operation, args) => client.callTool({ name,
      arguments: { operation, version: 1, arguments: args } });
    client = await connect();
    const created = await invoke("capability_call", "mcp.tool.add_note", {
      title: "Compatible provider", content: "created through legacy signature",
    });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.equal(JSON.parse(created.content[0].text).slug, "Compatible provider");
    await client.close(); client = undefined;
    client = await connect();
    const read = await invoke("capability_read", "mcp.tool.get_note", { slug: "Compatible provider" });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.match(read.content[0].text, /created through legacy signature/);
    await client.close(); client = undefined;
    const alias = path.join(parent, "python-link");
    fs.symlinkSync(python, alias);
    const bound = createNextMcpProviderRoute({ authority: { root, assertCurrent() {} }, extensionPath,
      executable: process.execPath, profile: "legacy-compact-experimental", compatibilityPython: alias,
      createDefinition: definition });
    t.after(() => bound.dispose());
    bound.provideMcpServerDefinitions();
    fs.renameSync(alias, `${alias}-original`);
    fs.symlinkSync(python, alias);
    assert.throws(() => bound.provideMcpServerDefinitions(), /compatibility runtime was replaced/);
  });
