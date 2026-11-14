"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const extensionPath = process.env.PKM_TEST_NEXT_EXTENSION, python = process.env.PKM_TEST_LEGACY_PYTHON;
const { createNextMcpOwnerBroker } = require(path.join(dist, "runtime/next-mcp-owner-broker"));
const { createLegacyMcpProviderOwner } = require(path.join(dist, "runtime/legacy-mcp-provider-owner"));
const { createNextMcpBrokerProvider } = require(path.join(dist, "runtime/next-mcp-broker-provider"));
const { createNextMcpProviderRoute } = require(path.join(dist, "runtime/next-mcp-provider-route"));
const { withCrossProcessLock } = require(path.join(dist, "runtime/cross-process-lock"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async fn => {
  for (let i = 0; i < 2000; i++) { if (fn()) return; await pause(10); }
  throw new Error("Timed out waiting for fixture.");
};
const identity = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid, started: fields[19], state: fields[0] };
  } catch { return undefined; }
};
const alive = expected => {
  const current = identity(expected.pid);
  return current?.started === expected.started && !["Z", "X"].includes(current.state);
};

test("owned original MCP performs real in-flight quiescence, verified tree exit and explicit re-admission",
  { skip: process.platform !== "linux" || !process.env.PKM_TEST_LEGACY_422_FIXTURE, timeout: 90000 }, async t => {
    const source = process.env.PKM_TEST_LEGACY_422_FIXTURE;
    const parent = path.resolve(".migration-test-work", `legacy-owned-broker-${randomUUID()}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, "root"), home = path.join(parent, "home"), local = path.join(parent, "local");
    const sourceNote = path.join(source, "root/notes/Reload in flight.md");
    const sourceNoteBefore = fs.existsSync(sourceNote) ? fs.readFileSync(sourceNote) : undefined;
    const copy = spawnSync("cp", ["-a", "--", path.join(source, "root"), root], { encoding: "utf8", timeout: 30000 });
    assert.equal(copy.status, 0, copy.stderr || String(copy.error));
    fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(local, { mode: 0o700 });
    fs.cpSync(path.join(source, "home/pkm-envs"), path.join(home, "pkm-envs"), { recursive: true });
    const managed = path.join(root, "mcp-server"), launcher = path.join(managed, "server.py");
    const generation = JSON.parse(fs.readFileSync(path.join(managed, "active-generation.json"))).generation;
    const manifestPath = path.join(managed, "generations", generation, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(manifest.extensionVersion, "4.0.22");
    const server = path.join(managed, "generations", generation, "server.py");
    const original = fs.readFileSync(server, "utf8");
    assert(original.includes(source));
    const rebound = original.replaceAll(source, parent);
    fs.writeFileSync(server, rebound);
    manifest.files["server.py"] = createHash("sha256").update(rebound).digest("hex");
    manifest.managedRoot = managed;
    manifest.runtimeMaintenance = path.join(home, "pkm-envs/pkm-mcp.pkm-maintenance.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const executable = path.join(home, "pkm-envs/pkm-mcp/bin/python");
    const supervisor = path.resolve("resources/next_mcp_subreaper.py");
    const brokers = [], clients = [];
    t.after(async () => {
      for (const client of clients) await client.close().catch(() => {});
      for (const broker of brokers) broker.dispose();
    });
    const start = async () => {
      const broker = await createNextMcpOwnerBroker({
        assertCurrent() {
          if (fs.realpathSync(root) !== root) throw new Error("Fixture root changed.");
        },
        launch: () => ({ command: executable, args: ["-B", supervisor, executable, "-B", launcher], cwd: managed,
          env: { HOME: home, TMPDIR: local, PYTHONDONTWRITEBYTECODE: "1", PKM_NODE_EXECUTABLE: process.execPath } }),
        async verifyOwnedDescendantsExited(child) {
          if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("Supervised legacy tree did not exit cleanly.");
        },
      });
      brokers.push(broker);
      const env = broker.definitionEnvironment();
      const client = new Client({ name: "private-owned-legacy", version: "1.0.0" });
      clients.push(client);
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [path.join(dist, "runtime/next-mcp-stdio-bridge.js")], cwd: parent,
        env: { ...process.env, ...env, HOME: home, TMPDIR: local }, stderr: "pipe" });
      await client.connect(transport);
      return { broker, client };
    };
    const result = response => response.structuredContent || JSON.parse(response.content.map(part => part.text || "").join(""));
    const first = await start();
    const initial = result(await first.client.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
    assert.equal((await first.broker.drainLegacyAndClose(async () => false)).state, "declined");
    assert.equal(first.broker.status().state, "accepting");
    let unlock, entered;
    const acquired = new Promise(resolve => { entered = resolve; });
    const held = withCrossProcessLock(path.join(root, ".pkm/state/markdown-assets.lock"), "owned legacy test", 2000, async () => {
      entered(); await new Promise(resolve => { unlock = resolve; });
    });
    await acquired;
    let writing, draining;
    try {
      writing = first.client.callTool({ name: "capability_call", arguments: { operation: "mcp.tool.add_note", version: 1,
        arguments: { title: "Owned broker Note", content: "completed before supervised exit" } } });
      await waitFor(() => first.broker.status().connection?.inFlight === 1);
      draining = first.broker.drainLegacyAndClose(async () => true);
      await waitFor(() => first.broker.status().state === "draining");
      console.log("OWNED_LEGACY_DRAINING", JSON.stringify({ at: new Date().toISOString(), generation: initial.generation,
        instanceId: initial.instanceId, inFlight: first.broker.status().connection.inFlight }));
      assert.throws(() => first.broker.definitionEnvironment(), /admission is closed/);
      await assert.rejects(first.broker.drainLegacyAndClose(async () => true), /owned legacy MCP connection/);
      await assert.rejects(first.client.callTool({ name: "mcp_lifecycle_status", arguments: {} }), /draining/);
      await pause(150);
      assert.equal(first.broker.status().state, "draining");
    } finally { unlock(); await held; }
    assert.notEqual((await writing).isError, true);
    assert.equal((await draining).state, "drained-and-stopped");
    console.log("OWNED_LEGACY_STOPPED", JSON.stringify({ at: new Date().toISOString(), instanceId: initial.instanceId }));
    await first.client.close();
    const second = await start();
    const next = result(await second.client.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
    assert.equal(next.generation, initial.generation);
    assert.notEqual(next.instanceId, initial.instanceId);
    console.log("OWNED_LEGACY_READMITTED", JSON.stringify({ at: new Date().toISOString(),
      generation: next.generation, instanceId: next.instanceId }));
    const note = await second.client.callTool({ name: "capability_read", arguments: {
      operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Owned broker Note" } } });
    assert.match(JSON.stringify(note), /completed before supervised exit/);
    assert.equal((await second.broker.drainLegacyAndClose(async () => true)).state, "drained-and-stopped");
    await second.client.close();

    const independent = new Client({ name: "independent-original-provider-client", version: "1.0.0" });
    clients.push(independent);
    await independent.connect(new StdioClientTransport({ command: executable, args: ["-B", launcher], cwd: managed,
      env: { ...process.env, HOME: home, TMPDIR: local, PYTHONDONTWRITEBYTECODE: "1", PKM_NODE_EXECUTABLE: process.execPath },
      stderr: "pipe" }));
    const independentIdentity = result(await independent.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
    const ownedConnections = [];
    const owner = await createLegacyMcpProviderOwner(async () => {
      const connection = await start();
      ownedConnections.push(connection);
      return connection.broker;
    });
    t.after(() => owner.dispose());
    const oldId = owner.status().id;
    const oldInstance = result(await ownedConnections[0].client.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
    assert.equal((await owner.retire(oldId, async () => true)).state, "drained-and-stopped");
    const newId = await owner.restart(oldId);
    assert.notEqual(newId, oldId);
    await assert.rejects(owner.retire(oldId, async () => true), /stale/);
    const newInstance = result(await ownedConnections[1].client.callTool({ name: "mcp_lifecycle_status", arguments: {} }));
    assert.notEqual(newInstance.instanceId, oldInstance.instanceId);
    assert.equal(newInstance.phase, "accepting");
    assert.equal(result(await independent.callTool({ name: "mcp_lifecycle_status", arguments: {} })).instanceId, independentIdentity.instanceId);
    assert.equal(result(await independent.callTool({ name: "capability_call", arguments: {
      operation: "mcp.tool.add_note", version: 1,
      arguments: { title: "Independent after stale retirement", content: "still accepting" },
    } })).ok, true);
    assert.equal((await owner.retire(newId, async () => true)).state, "drained-and-stopped");
    owner.seal(newId);
    await assert.rejects(owner.restart(newId), /sealed/);
    assert.equal(result(await independent.callTool({ name: "mcp_lifecycle_status", arguments: {} })).instanceId,
      independentIdentity.instanceId);
    if (process.env.PKM_TEST_LEGACY_ADOPT_AFTER_OWNER === "1") {
      const serverDist = process.env.PKM_TEST_NEXT_DIST || path.resolve("next-server/dist");
      const { prepareLegacyRootAdoptionExperimental } =
        await import(pathToFileURL(path.join(serverDist, "legacy-root-adoption.js")));
      await assert.rejects(prepareLegacyRootAdoptionExperimental(root), { code: "LEGACY_WRITERS_ACTIVE" });
      assert.equal(result(await independent.callTool({ name: "mcp_lifecycle_status", arguments: {} })).phase, "accepting");
      console.log("INDEPENDENT_ORIGINAL_CLIENT_PRESERVED", JSON.stringify({ adoptionBlocked: true, clientAccepting: true }));
    }
    await independent.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
    await independent.close();
    if (process.env.PKM_TEST_LEGACY_ADOPT_AFTER_OWNER === "1") {
      const serverDist = process.env.PKM_TEST_NEXT_DIST || path.resolve("next-server/dist");
      const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } =
        await import(pathToFileURL(path.join(serverDist, "legacy-root-adoption.js")));
      const { createNativeRuntime } = await import(pathToFileURL(path.join(serverDist, "native-runtime.js")));
      const { legacyKnowledgeWrite } = await import(pathToFileURL(path.join(serverDist, "legacy-knowledge-write.js")));
      const { legacyKnowledgeTree } = await import(pathToFileURL(path.join(serverDist, "legacy-knowledge-snapshot.js")));
      const { Storage } = await import(pathToFileURL(path.join(serverDist, "storage.js")));
      const authorityId = "isolated-owned-legacy-snapshot", allowedTools = ["knowledge_snapshot_status"];
      const snapshotAdmission = { authorityId, allowedTools, authorize: binding => binding.workspaceRoot === root
        && binding.authorityId === authorityId && binding.actorId === "mcp:external" && binding.operation === "admit"
        && binding.privateGitRoot === path.join(root, "packages/knowledge-snapshots/repository.git")
        && JSON.stringify(binding.allowedTools) === JSON.stringify(allowedTools) };
      const historyDirs = [".pkm/state/diagnostics/mcp", ".pkm/state/mcp-usage/events"];
      const history = historyDirs.flatMap(dir => fs.readdirSync(path.join(root, dir)).sort()
        .map(name => path.join(root, dir, name)));
      const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const before = history.map(hash);
      const oldNote = fs.readFileSync(path.join(root, "notes/Owned broker Note.md"));
      await prepareLegacyRootAdoptionExperimental(root, { snapshotAdmission });
      await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
      const adopted = await resumeLegacyRootAdoptionExperimental(root, { snapshotAdmission });
      assert.equal(adopted.state, "committed");
      assert.equal(adopted.qualification, "experimental-unqualified");
      assert.deepEqual(history.map(hash), before);
      assert.deepEqual(fs.readFileSync(path.join(root, "notes/Owned broker Note.md")), oldNote);
      console.log("ISOLATED_ADOPTION_COMMITTED", JSON.stringify({ at: new Date().toISOString(),
        qualification: adopted.qualification, recovered: adopted.recoveredPendingPlan }));
      let native;
      try {
        native = await createNativeRuntime({ storage: adopted.storage });
        const updated = await legacyKnowledgeWrite(native.core, adopted.storage, { id: "fixture-owner", canWrite: true }, {
          tool: "update_note", arguments: { slug: "Owned broker Note", content: "Adopted through Next after owner drain." },
        });
        assert.deepEqual(JSON.parse(updated.text), { ok: true, slug: "Owned broker Note" });
      } finally { await native?.close(); await adopted.storage.close(); }
      const reopened = await Storage.open(root);
      try {
        assert.match(legacyKnowledgeTree(root, "notes").find(entry => entry.path === "Owned broker Note.md").raw,
          /Adopted through Next after owner drain/);
      } finally { await reopened.close(); }
      assert.deepEqual(history.map(hash), before);
      if (sourceNoteBefore) assert.deepEqual(fs.readFileSync(sourceNote), sourceNoteBefore);
      console.log("ISOLATED_NEXT_REOPENED", JSON.stringify({ at: new Date().toISOString(), historyUnchanged: true }));
      console.log(`Retained owned-legacy adoption fixture: ${parent}`);
    }
  });

test("private broker connects a real stdio client, fences admission and drains a real Next write",
  { skip: process.platform !== "linux" || !extensionPath || !python, timeout: 60000 }, async t => {
    const parent = path.resolve(".migration-test-work", `next-mcp-broker-${randomUUID()}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, "workspace"), cli = path.join(extensionPath, "next-runtime/server/dist/cli.js");
    const init = spawnSync(process.execPath, [cli, "init", "--data", root], {
      cwd: parent, encoding: "utf8", timeout: 30000, env: { ...process.env, TMPDIR: parent },
    });
    assert.equal(init.status, 0, init.stderr);
    const route = createNextMcpProviderRoute({ authority: { root, assertCurrent() {} }, extensionPath,
      executable: process.execPath, profile: "legacy-compact-experimental", compatibilityPython: python,
      createDefinition: (label, command, args, env, version) => ({ label, command, args, env, version }) });
    const brokers = [], providers = [], clients = [], descendants = [], owned = [];
    t.after(async () => {
      for (const client of clients) await client.close().catch(() => {});
      for (const broker of brokers) broker.dispose();
      for (const provider of providers) provider.dispose();
      route.dispose();
      for (const process of [...owned, ...descendants]) if (alive(process)) global.process.kill(process.pid, "SIGTERM");
      await waitFor(() => [...owned, ...descendants].every(process => !alive(process)));
    });
    const start = async () => {
      let backend;
      const broker = await createNextMcpOwnerBroker({
        assertCurrent() {},
        launch() {
          const definition = route.provideMcpServerDefinitions()[0];
          return route.resolveMcpServerDefinition(definition);
        },
        async verifyOwnedDescendantsExited() {
          if (!backend) throw new Error("Missing bound backend.");
          await waitFor(() => !alive(backend));
        },
      });
      brokers.push(broker);
      const env = broker.definitionEnvironment();
      const bad = net.connect(`\0${env.PKM_NEXT_MCP_BROKER}`);
      bad.on("error", () => {});
      bad.on("connect", () => bad.write(`${"0".repeat(64)}\n`));
      await new Promise(resolve => bad.once("close", resolve));
      assert.equal(broker.status().connection, null);
      const provider = createNextMcpBrokerProvider({
        bridge: path.join(dist, "runtime/next-mcp-stdio-bridge.js"), executable: process.execPath,
        payloadVersion: JSON.parse(fs.readFileSync(path.join(extensionPath, "next-runtime/manifest.json"))).buildId,
        assertCurrent() {}, environment: () => broker.definitionEnvironment(),
        createDefinition: (label, command, args, defEnv, version) => ({ label, command, args, env: defEnv, version }),
      });
      providers.push(provider);
      const def = provider.provideMcpServerDefinitions()[0];
      def.env.PKM_NEXT_MCP_BROKER_TOKEN = "0".repeat(64);
      assert.throws(() => provider.resolveMcpServerDefinition(def), /definition changed/);
      def.env.PKM_NEXT_MCP_BROKER_TOKEN = env.PKM_NEXT_MCP_BROKER_TOKEN;
      provider.resolveMcpServerDefinition(def);
      const transport = new StdioClientTransport({ command: def.command, args: def.args, cwd: parent,
        env: { ...process.env, ...def.env, TMPDIR: parent }, stderr: "pipe" });
      const client = new Client({ name: "private-owned-broker", version: "1.0.0" });
      clients.push(client);
      await client.connect(transport);
      const ownerIdentity = identity(broker.status().connection.pid);
      assert(ownerIdentity, "Owned compatibility child must be observable.");
      owned.push(ownerIdentity);
      await waitFor(() => {
        const pid = broker.status().connection?.pid;
        if (!pid) return false;
        const ids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/);
        backend = ids.map(Number).filter(Boolean).map(identity).find(Boolean);
        return !!backend;
      });
      descendants.push(backend);
      return { broker, client, provider, env };
    };
    const first = await start();
    const firstPid = first.broker.status().connection.pid;
    const duplicate = net.connect(`\0${first.env.PKM_NEXT_MCP_BROKER}`);
    duplicate.on("error", () => {});
    duplicate.on("connect", () => duplicate.write(`${first.env.PKM_NEXT_MCP_BROKER_TOKEN}\n`));
    await new Promise(resolve => duplicate.once("close", resolve));
    assert.equal(first.broker.status().connection.pid, firstPid);
    const { DatabaseSync } = require("node:sqlite");
    const lock = new DatabaseSync(path.join(root, "core.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    let writing, draining;
    try {
      writing = first.client.callTool({ name: "capability_call", arguments: { operation: "mcp.tool.add_note", version: 1,
        arguments: { title: "Broker Note", content: "broker-drained write" } } });
      await waitFor(() => first.broker.status().connection?.inFlight === 1);
      draining = first.broker.drainAndClose();
      assert.equal(first.broker.status().state, "draining");
      assert.throws(() => first.broker.definitionEnvironment(), /admission is closed/);
      assert.throws(() => first.provider.provideMcpServerDefinitions(), /admission is closed/);
      await pause(100);
      assert.equal(first.broker.status().state, "draining");
      lock.exec("COMMIT");
    } finally { lock.close(); }
    const result = await writing;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const retired = await draining;
    assert.equal(retired.state, "stopped");
    assert.equal(retired.cutoverAuthorized, false);
    await first.client.close();
    const second = await start();
    const read = await second.client.callTool({ name: "capability_read", arguments: { operation: "mcp.tool.get_note",
      version: 1, arguments: { slug: "Broker Note" } } });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.match(read.content[0].text, /broker-drained write/);
    assert.equal((await second.broker.drainAndClose()).state, "stopped");
  });
