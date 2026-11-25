import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist/cli.js");
const observer = resolve("tests/cli-startup-import-observer.mjs");
const prefix = "PKM_CLI_IMPORT ";
const imports = stderr => stderr.split("\n").filter(line => line.startsWith(prefix))
  .map(line => JSON.parse(line.slice(prefix.length)));
const environment = extra => {
  const env = { ...process.env };
  for (const name of ["PKM_NEXT_OWNER_READY_NONCE", "PKM_NEXT_TOKEN",
    "PKM_EXPERIMENTAL_SUBSCRIPTION_PROFILE", "PKM_EXPERIMENTAL_SUBSCRIPTION_HOST", "PKM_TEST_CLI_BLOCK_MODULE",
    "PKM_TEST_CLI_NATIVE_NOTES_ONLY"])
    delete env[name];
  return { ...env, ...extra };
};
const execute = (args, env = {}) => spawnSync(process.execPath, ["--import", observer, cli, ...args], {
  env: environment(env), encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
  stdio: ["pipe", "pipe", "pipe", "pipe"],
});
async function fixture(t) {
  const parent = resolve("tests", `.cli-startup-${randomUUID()}`);
  const root = resolve(parent, "workspace");
  const cleanups = [];
  await mkdir(parent, { mode: 0o700 });
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root, cleanups };
}
async function until(read) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Observed CLI startup/shutdown deadline exceeded.");
}

test("CLI input errors retain precedence without loading a runtime or acquiring a workspace", { timeout: 30_000 }, async t => {
  const { parent, root } = await fixture(t);
  const cases = [
    { args: ["mcp", "--unknown"], env: { PKM_NEXT_OWNER_READY_NONCE: "invalid" }, error: /Invalid private MCP owner readiness request/ },
    { args: ["init", "--read-only"], env: { PKM_NEXT_OWNER_READY_NONCE: "a".repeat(64) }, error: /Invalid private MCP owner readiness request/ },
    { args: ["init", "--data", root, "--data", root], error: /Duplicate option: --data/ },
    { args: ["init", "--data", root, "--read-only"], error: /Option --read-only is not supported by init/ },
    { args: ["http", "--data", root, "--experimental-trusted-actions"], error: /Trusted Actions require writable experimental legacy MCP/ },
    { args: ["http", "--data", root, "--config", "missing.json"], error: /Set PKM_NEXT_TOKEN to a random secret/ },
    { args: ["mcp", "--data", root, "--human-review", "terminal"], error: /Native host policy options require an explicit configuration/ },
  ];
  for (const { args, env, error } of cases) {
    const child = execute(args, env);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, error);
    assert.deepEqual(imports(child.stderr).map(item => item.module), ["cli.js"]);
    assert.deepEqual(await readdir(parent), []);
  }
});

test("init loads only its required graph and selected serving import failure precedes ownership", { timeout: 30_000 }, async t => {
  const { parent, root } = await fixture(t);
  const initialized = execute(["init", "--data", root]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).initialized, root);
  const loaded = imports(initialized.stderr).map(item => item.module);
  assert(loaded.includes("storage.js"));
  for (const module of ["native-runtime.js", "http.js", "mcp.js", "legacy-note-mcp.js",
    "standalone-host.js", "legacy-import-cli.js", "bundle-import-cli.js"])
    assert(!loaded.includes(module), module);
  const before = (await readdir(root)).sort();
  const modes = [
    { args: ["mcp", "--experimental-legacy-mcp", "--read-only"], module: "legacy-note-mcp.js",
      env: { PKM_NEXT_OWNER_READY_NONCE: "b".repeat(64) } },
    { args: ["http"], module: "http.js", env: { PKM_NEXT_TOKEN: "synthetic-startup-token-" + "c".repeat(32) } },
    { args: ["backup", "--destination", resolve(parent, "backup")], module: "workspace-backup.js" },
    { args: ["mcp", "--experimental-legacy-mcp", "--experimental-trusted-actions"], module: "trusted-action-host.js" },
    { args: ["mcp", "--experimental-trusted-plugins"], module: "vscode-plugin-host.js" },
    { args: ["mcp", "--experimental-legacy-mcp", "--allow-asset-classification"], module: "legacy-asset-classification.js" },
    { args: ["mcp", "--experimental-legacy-mcp", "--experimental-managed-snapshot-scheduler", "d".repeat(64)],
      module: "legacy-knowledge-snapshot-scheduler.js" },
    { args: ["mcp", "--experimental-legacy-mcp", "--native-public-mcp", "--managed-generation", parent],
      module: "native-public-mcp.js", env: { PKM_NEXT_OWNER_READY_NONCE: "e".repeat(64) } },
    { args: ["mcp", "--experimental-legacy-mcp", "--native-public-mcp", "--managed-generation", parent],
      module: "native-public-mcp-lifecycle.js", env: { PKM_NEXT_OWNER_READY_NONCE: "e".repeat(64) } },
  ];
  for (const { args, module, env } of modes) {
    const denied = execute([...args, "--data", root], { ...env, PKM_TEST_CLI_BLOCK_MODULE: module });
    assert.equal(denied.status, 1, denied.stderr);
    assert.equal(denied.stdout, "");
    assert.equal(denied.output[3], "");
    assert(denied.stderr.includes(`Selected CLI module blocked before evaluation: ${module}`), denied.stderr);
    assert(imports(denied.stderr).some(item => item.module === module && !item.ownerNoncePresent));
    assert.deepEqual((await readdir(root)).sort(), before);
    assert.deepEqual(await readdir(parent), ["workspace"]);
  }
});

test("read-only legacy and native public MCP preserve selected imports, fd3 readiness, reads and both shutdown paths", { timeout: 60_000 }, async t => {
  const { parent, root, cleanups } = await fixture(t);
  const generation = resolve(parent, "generations", "current");
  await mkdir(generation, { recursive: true });
  const manifest = { schema: "pkm.mcp.lifecycle/v1", managedRoot: parent, generation: "current",
    version: "0.1.0", components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [] };
  await writeFile(resolve(generation, "manifest.json"), JSON.stringify(manifest));
  await writeFile(resolve(parent, "active-generation.json"), JSON.stringify({ schema: manifest.schema, generation: "current" }));
  const initialized = execute(["init", "--data", root]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const identity = await readFile(resolve(root, ".pkm-next-workspace"), "utf8");
  await writeFile(resolve(root, "notes", "Startup.md"),
    "---\nid: startup-note\ntitle: Startup\nrevision: 1\ndeleted: false\n---\nStartup body.\n");
  const before = (await readdir(root)).sort();
  for (const [flag, module] of [["--experimental-trusted-plugins", "vscode-plugin-host.js"],
    ["--experimental-trusted-actions", "trusted-action-host.js"]]) {
    const denied = execute(["mcp", "--data", root, "--experimental-legacy-mcp", "--native-public-mcp",
      "--managed-generation", generation, flag], { PKM_TEST_CLI_BLOCK_MODULE: module });
    assert.equal(denied.status, 1, denied.stderr);
    assert.match(denied.stderr, /Selected CLI module blocked before evaluation/);
    assert.deepEqual((await readdir(root)).sort(), before, "selected advanced imports precede root ownership");
  }

  for (const shutdown of ["stdin", "signal"]) for (const native of [false, true]) {
    const nonce = randomBytes(32).toString("hex");
    const child = spawn(process.execPath, ["--import", observer, cli, "mcp", "--data", root,
      "--experimental-legacy-mcp", "--read-only",
      ...(native ? ["--native-public-mcp", "--managed-generation", generation] : [])], {
      env: environment({ PKM_NEXT_OWNER_READY_NONCE: nonce, ...(native ? { PKM_TEST_CLI_NATIVE_NOTES_ONLY: "1" } : {}) }),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", receipt = "", sequence = 0, outcome;
    const pending = new Map(), protocolErrors = [];
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        outcome = { code, signal };
        for (const { reject } of pending.values()) reject(new Error(`CLI closed: ${stderr}`));
        pending.clear();
        resolve(outcome);
      });
    });
    cleanups.push(async () => {
      if (!outcome) child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!outcome) child.kill("SIGKILL"); }, 5000);
      try { await closed; } finally { clearTimeout(timer); }
    });
    child.stderr.on("data", bytes => { stderr += bytes.toString(); });
    child.stdio[3].on("data", bytes => { receipt += bytes.toString(); });
    child.stdout.on("data", bytes => {
      stdout += bytes.toString();
      while (stdout.includes("\n")) {
        const index = stdout.indexOf("\n"), line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        let value;
        try { value = JSON.parse(line); } catch { protocolErrors.push(line); continue; }
        const request = pending.get(value.id);
        if (request) {
          pending.delete(value.id);
          if (value.error) request.reject(new Error(JSON.stringify(value.error)));
          else request.resolve(value.result);
        }
      }
    });
    const send = value => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
    const rpc = (method, params) => {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
      send({ id, method, params });
      return promise;
    };
    await until(() => {
      assert(!outcome, `CLI exited before readiness: ${stderr}`);
      return receipt.includes("\n");
    });
    assert.equal(receipt, `${nonce}\n`);
    const hello = await rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "cli-startup-boundary", version: "1.0.0" },
    });
    assert.equal(hello.serverInfo.name, "pkm-v5");
    send({ method: "notifications/initialized" });
    const listed = (await rpc("tools/list", {})).tools;
    assert(listed.some(tool => tool.name === (native ? "capability_read" : "list_notes")));
    if (native) {
      assert.equal(listed.length, 9);
      for (const version of ["1.0", "1e0"]) {
        const id = ++sequence;
        const response = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
        child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"capability_read","arguments":{"operation":"mcp.tool.get_note","version":${version},"arguments":{"slug":"Startup"}}}}\n`);
        const rejected = await response;
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, /Pin version 1/);
      }
      const version = await rpc("tools/call", { name: "check_version", arguments: {} });
      assert.equal(version.structuredContent.name, "pkm-v5");
      const pathNote = await rpc("tools/call", { name: "capability_read",
        arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Startup" } } });
      assert.equal(pathNote.isError, false, JSON.stringify(pathNote));
      assert.match(pathNote.content[0].text, /Startup body/);
      const boot = imports(stderr);
      assert(boot.some(item => item.module === "root-owner.js" && !item.ownerNoncePresent));
      for (const module of ["storage.js", "storage-worker.js", "native-runtime.js", "core.js", "markdown.js",
        "legacy-note-mcp.js", "legacy-mcp-note-policy.js"])
        assert(!boot.some(item => item.module === module), `Heavy native boot import: ${module}`);
    }
    const notes = await rpc("tools/call", native
      ? { name: "capability_read", arguments: { operation: "mcp.tool.list_notes", version: 1, arguments: { limit: 0 } } }
      : { name: "list_notes", arguments: { limit: 0 } });
    assert.notEqual(notes.isError, true, JSON.stringify(notes));
    assert.match(JSON.stringify(notes), /Startup/);
    if (native) {
      const searched = await rpc("tools/call", { name: "capability_read",
        arguments: { operation: "mcp.tool.search_notes", version: 1, arguments: { query: "Startup" } } });
      assert.equal(searched.isError, false, JSON.stringify(searched));
      assert.match(searched.content[0].text, /Startup/);
    }
    const denied = await rpc("tools/call", native
      ? { name: "capability_call", arguments: { operation: "mcp.tool.add_note", version: 1, arguments: { title: "Not authorized" } } }
      : { name: "add_note", arguments: { title: "Not authorized" } });
    assert.equal(denied.isError, true);
    const observed = imports(stderr);
    const main = observed.filter(item => item.threadId === 0);
    for (const module of ["storage.js", "native-runtime.js", "legacy-note-mcp.js", "legacy-mcp-note-policy.js"])
      assert.equal(main.some(item => item.module === module && !item.ownerNoncePresent), !native, module);
    for (const module of ["root-owner-basic-note-read.js", "fresh-note-query-model.js"])
      assert.equal(main.some(item => item.module === module && !item.ownerNoncePresent), native, module);
    for (const module of ["native-public-mcp.js", "native-public-mcp-lifecycle.js"])
      assert.equal(main.some(item => item.module === module && !item.ownerNoncePresent), native, module);
    assert.equal(observed.some(item => item.module === "storage-worker.js" && item.threadId !== 0), !native);
    for (const module of ["http.js", "mcp.js", "standalone-host.js", "host-composition-review.js",
      "legacy-import-cli.js", "bundle-import-cli.js", "legacy-knowledge-snapshot-scheduler.js",
      "trusted-action-host.js", "vscode-plugin-host.js"])
      assert(!main.some(item => item.module === module), module);
    if (shutdown === "stdin") child.stdin.end();
    else child.kill("SIGTERM");
    await until(() => outcome);
    assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
    assert.deepEqual(protocolErrors, []);
    assert.equal(stdout, "");
    assert.equal(await readFile(resolve(root, ".pkm-next-workspace"), "utf8"), identity);
  }
});
