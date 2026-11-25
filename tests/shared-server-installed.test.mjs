import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
const require = createRequire(import.meta.url);

test("installed shared-server package keeps one owner across status queries, multiple MCP clients and a cold restart", {
  timeout: 120000,
}, async t => {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the mandatory private-overlay framework.");
  const directory = resolve("tests", `.shared-server-installed-${randomUUID()}`);
  const socketDirectory = resolve(`.b-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(socketDirectory, { mode: 0o700 });
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Installed server cleanup is unconfirmed; fixture retained.");
    await rm(directory, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  });
  const payload = join(directory, "payload");
  require("../scripts/stage-runtime.cjs").stage(payload, { production: true });
  const manifest = JSON.parse(await readFile(join(payload, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, "pkm.next-payload/v1");
  assert.equal(manifest.buildId, hash(JSON.stringify(manifest.files)));
  for (const name of ["server-status", "original-mcp-broker", "original-mcp-broker-cli", "original-mcp-relay", "original-mcp-relay-cli"])
    assert(manifest.files[`server/dist/${name}.js`], `Installed payload must include ${name}.`);
  const runtimeRoot = join(payload, "server");
  const load = name => import(pathToFileURL(join(runtimeRoot, "dist", `${name}.js`)).href);
  const { acquireOriginalMcpRootFence, captureOriginalMcpCustody } = await load("original-mcp-root");
  const { acquireLinuxRootWriterFence } = await load("linux-root-writer-fence");
  const { pinOriginalMcpBrokerFile, originalMcpRelayLaunch, readOriginalMcpBrokerDescriptor, originalMcpBrokerAuthLine }
    = await load("original-mcp-relay");
  const root = join(directory, "root");
  for (const name of ["notes/Private", "skills", "papers", ".pkm/state/actions"])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const note = "---\ntitle: Entry\n---\nInstalled server status control.\n";
  await writeFile(join(root, "notes/Entry.md"), note, { mode: 0o600 });
  await writeFile(join(root, "notes/Private/Secret.md"), "Never publish installedprivatesentinel.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Private"] } }), { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/settings.json"), '{"configured":"not activated"}', { mode: 0o600 });
  const fence = await acquireOriginalMcpRootFence(root);
  let plan;
  try {
    plan = await captureOriginalMcpCustody({
      root, backup: join(directory, "custody"), operatorId: "isolated-package-operator",
      profileSha256: hash("isolated-shared-server-package-profile"),
      limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 },
    }, { writerFence: fence });
  } finally { await fence.release(); }
  const node = pinOriginalMcpBrokerFile(await realpath(process.execPath));
  const relay = pinOriginalMcpBrokerFile(join(runtimeRoot, "dist/original-mcp-relay-cli.js"));
  const lifecycle = {
    schema: "pkm.mcp.lifecycle/v1", managedRoot: directory, generation: "installed-status",
    version: "0.1.0", runtimeBuild: manifest.buildId,
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [],
  };
  await writeFile(join(directory, "active-generation.json"),
    JSON.stringify({ schema: lifecycle.schema, generation: lifecycle.generation }), { mode: 0o600 });
  const request = {
    schema: "pkm.original-mcp-broker-request/v1", plan, directory: socketDirectory,
    runtime: { node: { path: node.path, sha256: node.sha256 }, relay: { path: relay.path, sha256: relay.sha256 },
      buildSha256: manifest.buildId },
    manifest: lifecycle,
    authorization: { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.operatorId,
      profileSha256: plan.profileSha256, planSha256: plan.planSha256, acceptedScope: "knowledge-content-only/v1", writable: false },
  };
  const requestPath = join(directory, "request.json"), bytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, bytes, { mode: 0o600 });
  const env = { ...process.env, HOME: directory, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_PATH; delete env.NODE_OPTIONS;
  async function start() {
    const child = spawn(node.path, [join(runtimeRoot, "dist/original-mcp-broker-cli.js"),
      "serve", "--request", requestPath, "--pin", hash(bytes)],
    { cwd: directory, env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", ready = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-8192); });
    child.stdio[3].on("data", bytes => { ready += bytes; });
    const exited = once(child, "close");
    void exited.catch(() => {});
    let stopped = false;
    const close = async () => {
      if (stopped) return;
      let timer;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }
      try {
        const [code, signal] = await exited;
        assert.equal(signal, null, stderr); assert.equal(code, 0, stderr);
        assert.equal(stdout, "", "Readiness and secrets must use the inherited private pipe.");
        stopped = true;
      } finally { clearTimeout(timer); }
    };
    cleanup.push(close);
    const deadline = Date.now() + 15000;
    while (!ready.includes("\n") && child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await sleep(20);
    assert(ready.includes("\n"), `Packaged server did not become ready: ${stderr}`);
    return { ...JSON.parse(ready), close };
  }
  async function status(server, pin = server.descriptorSha256) {
    const { stdout } = await execute(node.path, [relay.path, "status", "--descriptor", server.descriptorPath, "--pin", pin],
      { cwd: directory, env, timeout: 10000, maxBuffer: 16384 });
    return JSON.parse(stdout);
  }
  async function client(server) {
    const launch = originalMcpRelayLaunch(server.descriptorPath, server.descriptorSha256);
    assert.equal(launch.args[0], relay.path);
    const wire = new StdioClientTransport({ ...launch, cwd: directory, env, stderr: "pipe" });
    const client = new Client({ name: "installed-shared-server-client", version: "1" });
    cleanup.push(() => client.close());
    await client.connect(wire);
    return client;
  }
  const server = await start(), initial = await status(server);
  assert.equal(initial.runtimeBuild, manifest.buildId);
  assert.equal(initial.phase, "accepting"); assert.equal(initial.clients, 0);
  assert.equal(initial.writable, false); assert.equal(initial.handoff.available, false);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), { code: "BUSY" });
  const [a, b] = await Promise.all([client(server), client(server)]);
  const connected = await status(server);
  assert.equal(connected.clients, 2); assert.equal(connected.instanceId, initial.instanceId);
  const descriptor = readOriginalMcpBrokerDescriptor(server.descriptorPath, server.descriptorSha256).descriptor;
  assert(!JSON.stringify(connected).includes(descriptor.token));
  const unauthorized = connect(descriptor.socket.path), responses = [];
  unauthorized.on("data", bytes => responses.push(bytes));
  unauthorized.setTimeout(3000, () => unauthorized.destroy(new Error("Invalid-token connection was not rejected.")));
  const rejected = once(unauthorized, "close");
  void rejected.catch(() => {});
  try {
    await once(unauthorized, "connect");
    unauthorized.write(originalMcpBrokerAuthLine({ ...descriptor, token: "0".repeat(64) }, server.descriptorSha256, true));
    await rejected;
    assert.equal(Buffer.concat(responses).length, 0);
  } finally { unauthorized.destroy(); }
  const read = await b.callTool({ name: "capability_read",
    arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } } });
  assert.equal(read.isError, false); assert.match(JSON.stringify(read), /Installed server status control/);
  assert.doesNotMatch(JSON.stringify(read), /installedprivatesentinel/);
  await assert.rejects(status(server, "0".repeat(64)), error => {
    assert.equal(error.stdout, ""); return true;
  });
  await a.close(); await b.close(); await server.close();
  await assert.rejects(status(server));
  const released = await acquireLinuxRootWriterFence(root, 1000);
  await released.release();
  const restarted = await start(), next = await status(restarted);
  assert.equal(next.workspaceId, initial.workspaceId);
  assert.notEqual(next.instanceId, initial.instanceId);
  assert.equal(next.runtimeBuild, manifest.buildId); assert.equal(next.clients, 0);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), { code: "BUSY" });
  await restarted.close();
  assert.equal(await readFile(join(root, "notes/Entry.md"), "utf8"), note);
  assert.equal(await readFile(join(root, "notes/Private/Secret.md"), "utf8"), "Never publish installedprivatesentinel.\n");
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, "notes/Private/Secret.md"))).mode & 0o777, 0o600);
  for (const [name, digest] of Object.entries(manifest.files)) {
    const path = join(payload, name);
    assert.equal(await realpath(path), path);
    assert((await lstat(path)).isFile());
    assert.equal(hash(await readFile(path)), digest, `Installed package changed: ${name}`);
  }
  t.diagnostic(JSON.stringify({ scope: "isolated installed unpacked Linux server package; not VSIX/native-profile or production acceptance",
    buildId: manifest.buildId, packageFiles: Object.keys(manifest.files).length, clients: 2, coldRestarts: 1 }));
});

test("installed shared-server package remains observable while an admitted native write drains", {
  timeout: 120000,
}, async t => {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the mandatory private-overlay framework.");
  const directory = resolve("tests", `.shared-server-drain-${randomUUID()}`);
  const socketDirectory = resolve(`.b-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(socketDirectory, { mode: 0o700 });
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  });
  const payload = join(directory, "payload");
  require("../scripts/stage-runtime.cjs").stage(payload, { production: true });
  const manifest = JSON.parse(await readFile(join(payload, "manifest.json"), "utf8"));
  const runtimeRoot = join(payload, "server");
  const load = name => import(pathToFileURL(join(runtimeRoot, "dist", `${name}.js`)).href);
  const { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot } = await load("original-mcp-root");
  const { createOriginalMcpNativeHost } = await load("original-mcp-native-host");
  const { originalPublicMcpContracts } = await load("native-public-original-mcp-contracts");
  const { pinOriginalMcpBrokerFile, originalMcpRelayLaunch } = await load("original-mcp-relay");
  const { startOriginalMcpNativeBroker } = await load("original-mcp-broker");
  const root = join(directory, "root");
  for (const name of ["notes/Private", "skills", "papers", ".pkm/state/actions"])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const original = "---\ntitle: Entry\nrevision: 1\n---\nBefore drained update.\n";
  await writeFile(join(root, "notes/Entry.md"), original, { mode: 0o600 });
  await writeFile(join(root, "notes/Private/Secret.md"), "Never publish drainprivatesentinel.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Private"] } }), { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/settings.json"), '{"configured":"not activated"}', { mode: 0o600 });
  const fence = await acquireOriginalMcpRootFence(root);
  let plan;
  try {
    plan = await captureOriginalMcpCustody({
      root, backup: join(directory, "custody"), operatorId: "isolated-package-drain-operator",
      profileSha256: hash("isolated-shared-server-drain-profile"),
      limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 },
    }, { writerFence: fence });
  } finally { await fence.release(); }
  const node = pinOriginalMcpBrokerFile(await realpath(process.execPath));
  const relay = pinOriginalMcpBrokerFile(join(runtimeRoot, "dist/original-mcp-relay-cli.js"));
  const runtime = { node: { path: node.path, sha256: node.sha256 },
    relay: { path: relay.path, sha256: relay.sha256 }, buildSha256: manifest.buildId };
  const managedRoot = join(directory, "managed");
  await mkdir(managedRoot, { mode: 0o700 });
  const lifecycle = { schema: "pkm.mcp.lifecycle/v1", managedRoot, generation: "installed-drain",
    version: "0.1.0", runtimeBuild: manifest.buildId,
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [] };
  await writeFile(join(managedRoot, "active-generation.json"),
    JSON.stringify({ schema: lifecycle.schema, generation: lifecycle.generation }), { mode: 0o600 });
  const activeFence = await acquireOriginalMcpRootFence(root);
  const opened = await openOriginalMcpRoot(plan, { writerFence: activeFence });
  const lifetime = new AbortController();
  let release, entered;
  const barrier = new Promise(ready => { release = ready; });
  const admission = new Promise(ready => { entered = ready; });
  const nativeHost = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256: plan.profileSha256,
    sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "isolated-installed-drain-profile", epoch: "isolated-installed-drain-epoch",
    signal: lifetime.signal, assertCurrent() {}, async authorizeAdmission() { return true; },
    async authorizePublic() { entered(); await barrier; return true; },
    models: {
      configuration: {}, registryAvailability: {}, async credentialAvailable() { return false; },
      async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { throw new Error("No model transport selected."); } },
    },
  });
  const server = await startOriginalMcpNativeBroker({
    plan, writerFence: activeFence, directory: socketDirectory, runtime, manifest: lifecycle,
    authorization: { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: plan.operatorId,
      profileSha256: plan.profileSha256, planSha256: plan.planSha256,
      acceptedScope: "native-dogfood/v1", writable: true },
    owner: opened.owner, storage: opened.storage, nativeHost,
  });
  t.after(async () => {
    release();
    await server.stop().catch(() => {});
    await nativeHost.close().catch(() => {});
    await opened.owner.close().catch(() => {});
    await activeFence.release().catch(() => {});
  });
  const descriptor = { descriptorPath: server.descriptorPath, descriptorSha256: server.descriptorSha256 };
  const relayLaunch = originalMcpRelayLaunch(descriptor.descriptorPath, descriptor.descriptorSha256);
  const client = new Client({ name: "installed-native-drain-client", version: "1" });
  const wire = new StdioClientTransport({ ...relayLaunch, cwd: directory, env: process.env, stderr: "pipe" });
  await client.connect(wire);
  const writing = client.callTool({ name: "note_modify",
    arguments: { slug: "Entry", content: "Admitted package write drained successfully.\n" } });
  await admission;
  const status = async () => {
    const { stdout: text } = await execute(node.path,
      [relay.path, "status", "--descriptor", descriptor.descriptorPath, "--pin", descriptor.descriptorSha256],
      { cwd: directory, env: process.env, timeout: 3000, maxBuffer: 16384 });
    return JSON.parse(text);
  };
  const admitted = await status();
  assert.equal(admitted.inFlight, 1);
  assert.equal(admitted.phase, "accepting");
  const closing = server.stop();
  await sleep(50);
  const draining = await status();
  assert.equal(admitted?.phase, "accepting", "The write must be admitted before shutdown starts.");
  assert.equal(draining.phase, "draining");
  assert.equal(draining.inFlight, 1);
  assert.equal(draining.clients, 1);
  release();
  const reply = await writing;
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.match(JSON.stringify(reply), /Entry/);
  await closing;
  await client.close();
  assert.equal(server.serverStatus().phase, "closed");
  const updated = await readFile(join(root, "notes/Entry.md"), "utf8");
  assert.match(updated, /title: Entry\nrevision: 2\n/);
  assert.match(updated, /Admitted package write drained successfully\./);
  assert.equal(await readFile(join(root, "notes/Private/Secret.md"), "utf8"),
    "Never publish drainprivatesentinel.\n");
  t.diagnostic(JSON.stringify({ scope: "isolated staged-package native broker integration; synthetic admission only, not VSIX/native-profile or production",
    buildId: manifest.buildId, finalPhase: draining.phase, clients: draining.clients, inFlight: draining.inFlight }));
});
