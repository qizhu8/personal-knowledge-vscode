import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stageCompatibilityMcp } from "../scripts/stage-compatibility-mcp.mjs";
import { compatibilityMcpFixture as fixture, compatibilityMcpValue as value } from "./compatibility-mcp-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const legacy = process.env.PKM_COMPATIBILITY_EXTENSION || resolve("../personal-knowledge-vscode");
const require = createRequire(join(legacy, "package.json"));
const python = process.env.PKM_TEST_PYTHON || require(join(legacy, "tests/dev-paths.js")).testPython;

test("v5 compatibility MCP preserves the actual original151 catalog and canonical writes without adopting the data root", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client } = await f.connect();
  const version = value(await client.callTool({ name: "check_version", arguments: {} }));
  assert.equal(version.version, "0.1.0");
  assert.equal(version.runtime.runtimeBuild, f.frozen.runtimeBuild);
  assert.equal(version.backend.storageEngine, "original");
  assert.equal(version.backend.storageMigrated, false);
  assert.equal(version.backend.version, "2.19.0");
  assert.equal(version.backend.operations, 151);
  assert.equal((await client.listTools()).tools.length, 27);
  const search = value(await client.callTool({ name: "capabilities_search", arguments: { query: "note_modify" } }));
  assert(search.operations.some(operation => operation.id === "mcp.tool.update_note"));
  const described = value(await client.callTool({ name: "capabilities_describe", arguments: { operation: "mcp.tool.action_run_cancel" } }));
  assert.equal(described.id, "mcp.tool.action_run_cancel");
  const response = await client.callTool({ name: "note_modify", arguments: { slug: "Entry", content: "Updated through the v5 original-business adapter." } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const read = await client.callTool({ name: "note_read", arguments: { slug: "Entry" } });
  assert.match(JSON.stringify(read), /Updated through the v5/);
  const canonical = await client.callTool({ name: "capability_read", arguments: {
    operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" },
  } });
  assert.deepEqual(canonical, read);
  const action = await client.callTool({ name: "capability_read", arguments: {
    operation: "mcp.tool.action_capabilities", version: 1, arguments: {},
  } });
  assert.notEqual(action.isError, true, JSON.stringify(action));
  const todo = await client.callTool({ name: "capabilities_list", arguments: { path: "todo", limit: 1 } });
  assert.notEqual(todo.isError, true, JSON.stringify(todo));
  const mutation = await client.callTool({ name: "capability_read", arguments: {
    operation: "mcp.tool.update_note", version: 1, arguments: { slug: "Entry", content: "Must not write" },
  } });
  assert.equal(mutation.isError, true);
  assert(!(await readdir(f.root)).some(name => ["core.sqlite", ".pkm-next-workspace"].includes(name)));
  await f.close(client);
  await assert.rejects(client.callTool({ name: "note_write", arguments: { title: "Not replayed" } }));
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Updated through the v5/);
});

test("Skill module preserves write/read/update/retrieve, overwrite and reconnect through the actual compatibility MCP", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client } = await f.connect();
  const name = "CompatibilityBasicSkill", marker = "compatibilityskillsentinelfresh";
  const call = async (tool, args) => {
    const result = await client.callTool({ name: tool, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return value(result);
  };
  await call("skill_write", { name, category: "Acceptance", content: `${marker} first body.`, tags: ["basic"] });
  const created = await call("skill_read", { name });
  assert.equal(created.content, `${marker} first body.`);
  await call("skill_modify", { name, content: `${marker} updated body.`, description: "Verified partial update." });
  const updated = await call("skill_read", { name });
  assert.equal(updated.content, `${marker} updated body.`);
  assert.equal(updated.description, "Verified partial update.");
  assert.equal(updated.category, "Acceptance");
  const listed = await call("skill_list", { category: "Acceptance" });
  assert(JSON.stringify(listed).includes(name), JSON.stringify(listed));
  const retrieved = await call("skill_search", { query: marker, limit: 5, route: "lexical", detail: "legacy" });
  assert(JSON.stringify(retrieved).includes(name), JSON.stringify(retrieved));
  await call("skill_write", { name, category: "Acceptance", content: `${marker} overwritten body.` });
  const overwritten = await call("skill_read", { name });
  assert.equal(overwritten.content, `${marker} overwritten body.`);
  assert.equal((await client.callTool({ name: "capability_read", arguments: {
    operation: "mcp.tool.add_skill", version: 1, arguments: { name: "ReadLaneMustNotWrite", content: "Denied." },
  } })).isError, true);
  await assert.rejects(readFile(join(f.root, "skills/ReadLaneMustNotWrite.md")), { code: "ENOENT" });
  await f.close(client);
  const reopened = await f.connect();
  const persisted = await reopened.client.callTool({ name: "skill_read", arguments: { name } });
  assert.notEqual(persisted.isError, true, JSON.stringify(persisted));
  assert.equal(value(persisted).content, `${marker} overwritten body.`);
  assert(!(await readdir(f.root)).includes("core.sqlite"), "Compatibility must preserve original storage ownership.");
  await f.close(reopened.client);
});

test("Note and Paper modules preserve write/read/update/list/retrieve and reconnect through actual compatibility MCP", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client } = await f.connect();
  const call = async (tool, args) => {
    const result = await client.callTool({ name: tool, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert(result.structuredContent !== undefined || result.content.some(part => part.type === "text" && part.text.length),
      `${tool} omitted its result: ${JSON.stringify(result)}`);
    return value(result);
  };
  const documents = [
    { module: "note", title: "CompatibilityBasicNote", marker: "compatibilitynotesentinel" },
    { module: "paper", title: "CompatibilityBasicPaper", marker: "compatibilitypapersentinel" },
  ];
  for (const document of documents) {
    const { module, title, marker } = document;
    const written = await call(`${module}_write`, { title, category: "Acceptance", content: `${marker} first body.`, tags: ["basic"] });
    assert.equal(written.ok, true);
    document.slug = written.slug;
    assert.equal(typeof document.slug, "string");
    const created = await call(`${module}_read`, { slug: document.slug });
    assert.equal(created.content, `${marker} first body.`);
    const retrievalKey = module === "paper" ? "compatibilitypapermetadataupdated" : marker;
    await call(`${module}_modify`, { slug: document.slug, content: `${marker} updated body.`,
      ...(module === "paper" ? { tags: [retrievalKey] } : {}) });
    const updated = await call(`${module}_read`, { slug: document.slug });
    assert.equal(updated.content, `${marker} updated body.`);
    assert.equal(updated.category, "Acceptance");
    assert(JSON.stringify(await call(`${module}_list`, {})).includes(title));
    assert(JSON.stringify(await call(`${module}_search`, { query: retrievalKey, limit: 5, route: "lexical", detail: "legacy" })).includes(title));
    if (module === "paper") {
      const direct = await f.connect(true);
      const arguments_ = { query: marker, limit: 5, route: "lexical", detail: "legacy" };
      const original = await direct.client.callTool({ name: "capability_read", arguments: {
        operation: "mcp.tool.search_papers", version: 1, arguments: arguments_,
      } });
      const facade = await client.callTool({ name: "paper_search", arguments: arguments_ });
      assert.notEqual(original.isError, true, JSON.stringify(original));
      assert.deepEqual(facade, original, "Offline Paper body-search behavior must match the actual original, not masquerade as full-text retrieval.");
      await f.close(direct.client);
    }
  }
  await f.close(client);
  const reopened = await f.connect();
  for (const { module, slug, marker } of documents) {
    const read = await reopened.client.callTool({ name: `${module}_read`, arguments: { slug } });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.equal(value(read).content, `${marker} updated body.`);
  }
  assert(!(await readdir(f.root)).includes("core.sqlite"));
  await f.close(reopened.client);
});

test("cancelling the v5 wait cannot drop a real original write from its drain ledger or replay it", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client, transport } = await f.connect();
  const { withCrossProcessLock } = require(join(legacy, "dist/runtime/cross-process-lock.js"));
  const directory = join(f.root, ".pkm/state");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let release, entered;
  const held = new Promise(resolve => { entered = resolve; });
  const lock = withCrossProcessLock(join(directory, "markdown-assets.lock"), "isolated-gateway-write", 5000,
    async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await held;
  t.after(async () => { release(); await lock; });
  const controller = new AbortController();
  const writing = client.callTool({ name: "note_modify", arguments: { slug: "Entry", content: "One admitted original write." } },
    undefined, { signal: controller.signal });
  const cancelled = assert.rejects(writing);
  for (let i = 0; i < 100; i++) {
    const status = value(await client.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
    if (status.inFlight > 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  await cancelled;
  const draining = value(await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} }));
  assert.equal(draining.phase, "draining");
  assert.equal(draining.inFlight, 1);
  assert.equal(draining.uncertainCalls, 1);
  const child = transport._process;
  let exited = false;
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway did not finish its cancelled-write drain after EOF.")), 15000);
    child.once("close", (code, signal) => { clearTimeout(timer); exited = true; resolve({ code, signal }); });
  });
  child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(exited, false);
  release(); await lock;
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /One admitted original write/);
});

test("wrong original-business runtime pin refuses before any user mutation or v5 data initialization", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const configPath = f.target.args[0], config = JSON.parse(await readFile(configPath));
  config.legacy.runtimeBuild = "f".repeat(64);
  config.legacy.compatibleUpdates = false;
  const bytes = Buffer.from(JSON.stringify(config));
  await writeFile(configPath, bytes, { mode: 0o600 });
  f.target.args[1] = hash(bytes);
  await assert.rejects(f.connect());
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Original business content/);
  assert(!(await readdir(f.root)).includes("core.sqlite"));
});

test("native client EOF drains and exits the actual gateway and its supervised business adapter without signalling them", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client, transport } = await f.connect();
  await client.listTools();
  const child = transport._process;
  assert(child?.stdin && child.pid === transport.pid);
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway did not finish its original-adapter drain after EOF.")), 15000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("reloading a compatible original generation keeps v5 usable while reporting the actual business identity", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const before = JSON.parse(await readFile(f.target.args[0])).legacy;
  f.regenerate();
  const pointer = JSON.parse(await readFile(join(f.managed, "latest-generation.json")));
  const { client } = await f.connect();
  const version = value(await client.callTool({ name: "check_version", arguments: {} }));
  assert.notEqual(pointer.generation, before.generation);
  assert.equal(version.backend.generation, pointer.generation);
  assert.equal(version.backend.compatibleBusinessUpdates, true);
  await f.close(client);
});

test("actual original Skill create, partial modification and legacy upsert are preserved by aliases and canonical calls", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client } = await f.connect();
  const call = (name, args) => client.callTool({ name, arguments: args });
  const created = await call("skill_write", { name: "Gateway skill", description: "Initial description", content: "Initial Skill instructions." });
  assert.notEqual(created.isError, true, JSON.stringify(created));
  const read = await call("skill_read", { name: "Gateway skill" });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  assert.match(JSON.stringify(read), /Initial Skill instructions/);
  assert.deepEqual(await call("capability_read", {
    operation: "mcp.tool.get_skill", version: 1, arguments: { name: "Gateway skill" },
  }), read);
  const modified = await call("skill_modify", { name: "Gateway skill", content: "Modified Skill instructions." });
  assert.notEqual(modified.isError, true, JSON.stringify(modified));
  const after = await call("skill_read", { name: "Gateway skill" });
  assert.match(JSON.stringify(after), /Modified Skill instructions/);
  assert.match(JSON.stringify(after), /Initial description/);
  const upsert = await call("capability_call", { operation: "mcp.tool.add_skill", version: 1,
    arguments: { name: "Gateway skill", description: "Replacement description", content: "Upsert replaced Skill instructions." } });
  assert.notEqual(upsert.isError, true, JSON.stringify(upsert));
  assert.deepEqual(await call("skill_write", { name: "Gateway skill", description: "Replacement description",
    content: "Upsert replaced Skill instructions." }), upsert);
  const replaced = await call("skill_read", { name: "Gateway skill" });
  assert.match(JSON.stringify(replaced), /Upsert replaced Skill instructions/);
  assert.match(JSON.stringify(replaced), /Replacement description/);
  assert.doesNotMatch(JSON.stringify(replaced), /Initial description|Modified Skill instructions/);
  const missingAlias = await call("skill_read", { name: "Missing gateway skill" });
  assert.deepEqual(await call("capability_read", { operation: "mcp.tool.get_skill", version: 1,
    arguments: { name: "Missing gateway skill" } }), missingAlias);
  assert.match(JSON.stringify(missingAlias), /not found|不存在/i);
  for (const [name, operation] of [["skill_write", "mcp.tool.add_skill"], ["skill_modify", "mcp.tool.update_skill"]]) {
    const result = await call(name, {});
    assert.equal(result.isError, true);
    assert.deepEqual(await call("capability_call", { operation, version: 1, arguments: {} }), result);
  }
  const version = value(await call("check_version", {}));
  assert.equal(version.backend.health.phase, "accepting");
  assert.equal(version.backend.health.uncertainCalls, 0);
  assert.deepEqual(await call("skill_read", { name: "Gateway skill" }), replaced);
  await f.close(client);
});

test("actual canonical Todo and Memory discovery, harmless reads and worker authority retain original envelopes", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client } = await f.connect(), { client: original } = await f.connect(true);
  const call = (client, name, args) => client.callTool({ name, arguments: args });
  for (const path of ["todo", "memory"]) {
    const listed = await call(client, "capabilities_list", { path, limit: 10 });
    assert.notEqual(listed.isError, true, JSON.stringify(listed));
    assert.deepEqual(listed, await call(original, "capabilities_list", { path, limit: 10 }));
    const page = value(listed);
    assert(page.operations.length > 0, JSON.stringify(page));
    t.diagnostic(`${path} operations in first discovery page: ${page.operations.map(item => item.id).join(", ")}`);
    const operationId = path === "todo" ? "todo.board.list" : "memory.record.search";
    for (const item of page.operations.filter(item => item.id === operationId)) {
      const described = await call(client, "capabilities_describe", { operation: item.id });
      assert.deepEqual(described, await call(original, "capabilities_describe", { operation: item.id }));
      const args = { operation: item.id, version: 1, arguments: path === "todo" ? {} : { query: "isolated-gateway-query" } };
      const read = await call(client, "capability_read", args);
      assert.notEqual(read.isError, true, JSON.stringify(read));
      assert.deepEqual(read, await call(original, "capability_read", args));
      assert.equal(value(read).operation, item.id);
      const tokenArgs = { ...args, worker_token: "invalid-isolated-worker-token" };
      const tokenRead = await call(client, "capability_read", tokenArgs);
      assert.deepEqual(tokenRead, await call(original, "capability_read", tokenArgs));
      assert.equal(tokenRead.isError, true, JSON.stringify(tokenRead));
    }
  }
  const withToken = { operation: "mcp.tool.get_board", version: 1, arguments: { board_slug: "missing-gateway-board" },
    worker_token: "invalid-isolated-worker-token" };
  const denied = await call(client, "capability_read", withToken);
  assert.equal(denied.isError, true, JSON.stringify(denied));
  assert.deepEqual(denied, await call(original, "capability_read", withToken));
  const nested = { ...withToken, worker_token: null, arguments: { ...withToken.arguments, worker_token: withToken.worker_token } };
  assert.deepEqual(await call(client, "capability_read", nested), denied);
  const conflict = await call(client, "capability_read", { ...withToken,
    arguments: { ...withToken.arguments, worker_token: "different-worker-token" } });
  assert.equal(conflict.isError, true);
  assert.match(JSON.stringify(conflict), /Conflicting worker tokens/);
  const unsupported = await call(client, "capability_read", { ...withToken, operation: "mcp.tool.get_skill",
    arguments: { name: "Missing gateway skill" } });
  assert.equal(unsupported.isError, true);
  assert.match(JSON.stringify(unsupported), /no worker_token argument/);
  await f.close(client); await f.close(original);
});

test("warm capabilities_search latency compares this gateway with the direct actual original service on one isolated fixture", { timeout: 120000 }, async t => {
  const f = await fixture(t), { client } = await f.connect(), { client: original } = await f.connect(true);
  const times = { gateway: [], original: [] };
  const search = client => client.callTool({ name: "capabilities_search", arguments: { query: "get_skill", limit: 1 } });
  for (let i = 0; i < 5; i++) { await search(client); await search(original); }
  for (let i = 0; i < 40; i++) {
    for (const [label, target] of i % 2 ? [["original", original], ["gateway", client]] : [["gateway", client], ["original", original]]) {
      const start = performance.now(), response = await search(target);
      times[label].push(performance.now() - start);
      assert.notEqual(response.isError, true);
      assert.equal(value(response).operations[0].id, "mcp.tool.get_skill");
    }
  }
  const metrics = Object.fromEntries(Object.entries(times).map(([label, samples]) => {
    samples.sort((a, b) => a - b);
    return [label, { samples: samples.length, p50Ms: +samples[Math.ceil(samples.length * .5) - 1].toFixed(3),
      p95Ms: +samples[Math.ceil(samples.length * .95) - 1].toFixed(3) }];
  }));
  t.diagnostic(`warm capabilities_search/get_skill, alternating same-fixture stdio, startup excluded: ${JSON.stringify(metrics)}`);
  await f.close(client); await f.close(original);
});

test("incompatible component version refuses even when same-version original generation reloads are allowed", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const { client: original } = await f.connect(true);
  const originalLifecycle = async () => value(await original.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
  const before = await originalLifecycle();
  assert.equal(before.acceptingNewCalls, true);
  const path = f.target.args[0], config = JSON.parse(await readFile(path));
  assert.equal(config.legacy.compatibleUpdates, true);
  const component = Object.keys(config.legacy.components)[0];
  assert(component);
  config.legacy.components[component] = "999.0.0";
  const bytes = Buffer.from(JSON.stringify(config));
  await writeFile(path, bytes, { mode: 0o600 });
  f.target.args[1] = hash(bytes);
  await assert.rejects(f.connect(), /COMPATIBILITY_ADAPTER_IDENTITY_MISMATCH/);
  const after = await originalLifecycle();
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(after.acceptingNewCalls, true);
  const read = await original.callTool({ name: "get_note", arguments: { slug: "Entry" } });
  assert.notEqual(read.isError, true);
  assert.match(JSON.stringify(read), /Original business content/);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Original business content/);
  assert(!(await readdir(f.root)).includes("core.sqlite"));
  await f.close(original);
});

test("fault-injected adapter exit fences new work and retains unknown writes without replay or false drain", { timeout: 120000 }, async t => {
  const f = await fixture(t), config = JSON.parse(await readFile(f.target.args[0]));
  const entry = join(f.base, "adapter-api.mjs");
  await build({ entryPoints: [resolve("src/compatibility-mcp.ts")], outfile: entry,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning",
    banner: { js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);' } });
  const { connectCompatibilityMcp } = await import(pathToFileURL(entry).href);
  const launcher = join(f.base, "fault-adapter.py"), marker = join(f.base, "admitted-writes");
  await writeFile(launcher, `
import json, os, sys
legacy = json.loads(${JSON.stringify(JSON.stringify(config.legacy))})
runtime = {"generation": legacy["generation"], "runtimeBuild": legacy["runtimeBuild"], "instanceId": "fault-fixture",
           "phase": "accepting", "acceptingNewCalls": True, "inFlight": 0, "uncertainCalls": 0}
revision = "a" * 64
names = ["capabilities_list", "capabilities_search", "capabilities_describe", "capabilities_inventory",
         "capability_read", "capability_call", "check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"]
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    if method == "initialize":
        result = {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}},
                  "serverInfo": {"name": "fault-fixture-not-business-evidence", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": name, "inputSchema": {"type": "object"}} for name in names]}
    elif method == "tools/call":
        name, args = params["name"], params.get("arguments", {})
        if name == "check_version":
            payload = {"version": legacy["version"], "components": legacy["components"], "runtime": runtime}
        elif name == "capabilities_list":
            payload = {"revision": revision, "total": 2, "offset": 0, "nextOffset": None,
                       "operations": [{"id": "mcp.tool.fixture_read"}, {"id": "mcp.tool.fixture_write"}]}
        elif name == "capabilities_describe":
            operation = args["operation"]
            payload = {"id": operation, "version": 1, "transportName": operation.removeprefix("mcp.tool."),
                       "description": "Fault injection only", "readOnly": operation.endswith("_read"),
                       "revision": revision, "inputSchema": {"type": "object"}, "outputSchema": None}
        elif name in ["capability_call", "capability_read"]:
            if name == "capability_call":
                with open(${JSON.stringify(marker)}, "a") as out:
                    out.write("admitted\\n")
            os._exit(0)
        else:
            raise RuntimeError("Unexpected fault-fixture control call")
        result = {"content": [{"type": "text", "text": json.dumps(payload)}], "structuredContent": payload, "isError": False}
    else:
        raise RuntimeError("Unexpected fault-fixture method")
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
`);
  config.legacy.launcher = { path: launcher, sha256: hash(await readFile(launcher)) };
  for (const write of [false, true]) {
    const adapter = await connectCompatibilityMcp(config), pid = adapter.adapterPid;
    let fenced = false;
    adapter.onFailure(() => { fenced = true; });
    await assert.rejects(adapter.backend.invoke("original_mcp_public", {
      tool: write ? "fixture_write" : "fixture_read", arguments: {},
    }));
    assert.equal(fenced, true);
    assert.deepEqual(adapter.identity.health, {
      phase: "unavailable", inFlight: 0, uncertainCalls: Number(write), automaticReplay: false,
    });
    await assert.rejects(adapter.backend.invoke("original_mcp_public", { tool: "fixture_write", arguments: {} }),
      /COMPATIBILITY_ADAPTER_UNAVAILABLE/);
    await assert.rejects(adapter.close(), write ? /COMPATIBILITY_ADAPTER_EXIT_UNKNOWN/ : /COMPATIBILITY_ADAPTER_EXITED_BEFORE_DRAIN/);
    await assert.rejects(adapter.close(), write ? /COMPATIBILITY_ADAPTER_EXIT_UNKNOWN/ : /COMPATIBILITY_ADAPTER_EXITED_BEFORE_DRAIN/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  assert.equal(await readFile(marker, "utf8"), "admitted\n");
});

test("signals received during actual original adapter startup request one graceful drain instead of abandoning the child", { timeout: 120000 }, async t => {
  const f = await fixture(t), path = f.target.args[0], config = JSON.parse(await readFile(path));
  const supervisor = join(f.base, "signal-during-startup.py");
  await writeFile(supervisor, `import os, runpy, signal\nos.kill(os.getppid(), signal.SIGTERM)\nos.kill(os.getppid(), signal.SIGINT)\nrunpy.run_path(${JSON.stringify(config.supervisor.path)}, run_name="__main__")\n`);
  config.supervisor = { path: supervisor, sha256: hash(await readFile(supervisor)) };
  const bytes = Buffer.from(JSON.stringify(config));
  await writeFile(path, bytes, { mode: 0o600 });
  f.target.args[1] = hash(bytes);
  const transport = new StdioClientTransport({ command: f.target.command.path,
    args: [f.target.entry.path, ...f.target.args], cwd: f.stage, env: { ...process.env }, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr.on("data", bytes => { diagnostics += bytes; });
  await transport.start();
  const child = transport._process;
  assert(child);
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup signal drain timed out: ${diagnostics}`)), 15000);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(await exited, { code: 0, signal: null }, diagnostics);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Original business content/);
});

test("a failed private stage removes only its newly created partial runtime", { timeout: 120000 }, async t => {
  const f = await fixture(t), extension = join(f.base, "incomplete-extension"), destination = join(f.base, "failed-stage");
  await mkdir(extension, { mode: 0o700 });
  await symlink(join(legacy, "dist"), join(extension, "dist"));
  await assert.rejects(stageCompatibilityMcp({ extension, knowledgeRoot: f.root, managedRoot: f.managed, python, destination }),
    { code: "ENOENT" });
  await assert.rejects(readdir(destination), { code: "ENOENT" });
  assert((await readdir(f.stage)).includes("target.json"));
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Original business content/);
  await assert.rejects(stageCompatibilityMcp({ extension: legacy, knowledgeRoot: f.root,
    managedRoot: f.managed, python, destination: f.stage }), { code: "EEXIST" });
  assert((await readdir(f.stage)).includes("target.json"));
});
