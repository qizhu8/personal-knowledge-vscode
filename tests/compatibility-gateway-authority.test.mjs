import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startCompatibilityGatewayAuthority } from "../dist/compatibility-gateway-authority.js";
import { compatibilityMcpFixture as fixture, compatibilityMcpValue as value } from "./compatibility-mcp-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("Original ↔ bundled v5 on existing pkm relays; interrupted Original writes quarantine custody", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(f.target.args[0], "utf8"));
  async function stage() {
    const managedRoot = join(f.base, "switch-gateway-v5"), generation = randomUUID();
    await mkdir(managedRoot, { mode: 0o700 });
    const file = join(managedRoot, "gateway.mjs");
    await build({
      entryPoints: [new URL("../src/native-public-mcp.ts", import.meta.url).pathname],
      outfile: file, bundle: true, packages: "external", platform: "node", format: "esm", target: "node22",
    });
    const runtimeBuild = hash(await readFile(file));
    const { createNativePublicFacade: createFacade } = await import(pathToFileURL(file));
    await writeFile(join(managedRoot, "active-generation.json"),
      JSON.stringify({ schema: "pkm.mcp.lifecycle/v1", generation }), { mode: 0o600 });
    return { generation, runtimeBuild, managedRoot, createFacade, assertVerified() {
      if (hash(readFileSync(file)) !== runtimeBuild) throw new Error("Checksum mismatch");
    } };
  }
  const bundled = await stage();
  assert.notEqual(bundled.runtimeBuild, config.legacy.runtimeBuild);
  config.legacy.compatibleUpdates = false;
  config.managedRoot = bundled.managedRoot;
  config.gateway = { generation: bundled.generation, runtimeBuild: bundled.runtimeBuild };
  const require = createRequire(import.meta.url);
  const { acquireLinuxRootWriterFence, assertLinuxRootStillLegacyWritable } = require("../legacy/dist/runtime/linux-root-writer-fence.js");
  const workbenchAttribution = { schema: "pkm.mcp.attribution/v1", source: "vscode-provider", scope: "shared-host",
    hostId: randomUUID(), editorSessionId: randomUUID(), extensionHostPid: process.pid };
  const chatAttribution = { ...workbenchAttribution, source: "pkm-chat", scope: "chat", chatId: randomUUID() };
  let confirm = true;
  const host = { workbenchAttribution, chatAttribution, confirm: async () => confirm, acquireLegacyFence(root) {
    assertLinuxRootStillLegacyWritable(root);
    return acquireLinuxRootWriterFence(root, "shared", 500);
  } };
  const cold = await f.connect();
  await assert.rejects(startCompatibilityGatewayAuthority(config, bundled, host, "original"), /already held/);
  const coldIdentity = value(await cold.client.callTool({ name: "check_version", arguments: {} }));
  assert.equal(coldIdentity.version, "0.1.0");
  await f.close(cold.client);
  const authority = await startCompatibilityGatewayAuthority(config, bundled, host, "original");
  const owned = [];
  let closed = false;
  f.retainCleanup(async () => {
    try { await Promise.all(owned.map(client => client.close())); }
    finally { if (!closed) await authority.close(); }
  });
  const peer = `
    const { acquireCompatibilityGatewayCustody } = await import(process.argv[1]);
    const { acquireLinuxRootWriterFence } = await import(process.argv[2]);
    const custody = await acquireCompatibilityGatewayCustody(process.argv[3],
      root => acquireLinuxRootWriterFence(root, "shared", 500));
    await custody.release(true);
  `;
  const tryPeer = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", peer,
    new URL("../dist/compatibility-gateway-custody.js", import.meta.url).href,
    new URL("../legacy/dist/runtime/linux-root-writer-fence.js", import.meta.url).href, f.root],
    { timeout: 5_000 });
  await assert.rejects(tryPeer(), /already held/);
  await assert.rejects(f.connect(), /already held/);
  async function connect(name, authority) {
    const { origin, serviceId, token } = authority.relay(name);
    const client = new Client({ name, version: "1" });
    owned.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [new URL("../dist/compatibility-gateway-relay.js", import.meta.url).pathname],
      env: { PKM_SHARED_ORIGIN: origin, PKM_SHARED_SERVICE_ID: serviceId, PKM_SHARED_TOKEN: token }, stderr: "inherit",
    });
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, "pkm");
    return { client, transport, pid: transport.pid };
  }
  const clients = await Promise.all(["workbench", "chat"].map(role => connect(role, authority)));
  const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 5_000 });
  let originalInstances, relayInstances, publicTools, discovery;
  const sharedVersion = async mode => {
    const target = mode === "original" ? config.legacy : bundled;
    const versions = await Promise.all(clients.map(async ({ client, transport, pid }) => {
      const read = value(await call(client, "check_version"));
      assert.equal(transport.pid, pid);
      assert.equal(read.runtime.generation, target.generation);
      assert.equal(read.runtime.runtimeBuild, target.runtimeBuild);
      assert.equal(read.dispatchMode, mode);
      assert.equal(read.routeRuntime.generation, authority.relay("workbench").serviceId);
      assert.notEqual(read.routeRuntime.generation, read.runtime.generation);
      if (mode === "original") {
        assert.equal(read.version, config.legacy.version);
        assert.equal(read.runtime.instanceId, read.originalConnection.instanceId);
        assert.equal(read.runtime.pid, authority.status().originalConnections.find(item => item.runtime.instanceId === read.runtime.instanceId).runtime.pid);
      } else {
        assert.equal(read.version, "0.1.0");
        assert.equal(read.backend.storageEngine, "original");
        assert.equal(read.backend.runtimeBuild, config.legacy.runtimeBuild);
        assert.notEqual(read.runtime.instanceId, read.originalConnection.instanceId);
      }
      const tools = await client.listTools();
      publicTools ??= tools;
      assert.deepEqual(tools, publicTools);
      const page = value(await call(client, "capabilities_list", { path: "mcp.tool", limit: 1 }));
      discovery ??= page;
      assert.deepEqual(page, discovery);
      return read;
    }));
    assert.notEqual(versions[0].routeRuntime.instanceId, versions[1].routeRuntime.instanceId);
    assert.deepEqual(versions.map(read => read.originalConnection.attribution), [workbenchAttribution, chatAttribution]);
    const instances = versions.map(read => read.originalConnection.instanceId);
    assert.notEqual(instances[0], instances[1]);
    originalInstances ??= instances;
    assert.deepEqual(instances, originalInstances);
    relayInstances ??= versions.map(read => read.routeRuntime.instanceId);
    assert.deepEqual(versions.map(read => read.routeRuntime.instanceId), relayInstances);
    return versions.map(read => read.version);
  };
  const originalVersion = await sharedVersion("original");
  const firstObservation = authority.status();
  const browser = authority.bindBrowserReads();
  const args = { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } };
  assert.match(JSON.stringify(await browser.read(args)), /Original business content/);
  await assert.rejects(browser.read({ ...args, operation: "mcp.tool.update_note" }), /browser read grant/);
  const originalPid = authority.status().originalConnections[0].runtime.pid;
  process.kill(originalPid, "SIGSTOP");
  const pending = call(clients[0].client, "note_read", { slug: "Entry" });
  try {
    const deadline = Date.now() + 2_500;
    while (authority.status().inFlight === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(authority.status().inFlight, 1);
    await assert.rejects(authority.approveSwitch(firstObservation, "bundled-v5"), /outstanding work/);
  } finally { process.kill(originalPid, "SIGCONT"); }
  assert.match(JSON.stringify(await pending), /Original business content/);
  const artifact = join(bundled.managedRoot, "gateway.mjs"), bytes = await readFile(artifact);
  await writeFile(artifact, Buffer.concat([bytes, Buffer.from("\n// Changed after staging.\n")]));
  try { await assert.rejects(authority.approveSwitch(firstObservation, "bundled-v5"), /Checksum mismatch/); }
  finally { await writeFile(artifact, bytes); }
  assert.deepEqual(authority.status().selectionRevision, firstObservation.selectionRevision);
  confirm = false;
  assert.equal((await authority.approveSwitch(firstObservation, "bundled-v5")).applied, false);
  confirm = true;
  const originalWrite = await call(clients[0].client, "note_modify", { slug: "Entry", content: "Written through Original." });
  assert.notEqual(originalWrite.isError, true);
  await sharedVersion("original");
  await authority.approveSwitch(firstObservation, "bundled-v5");
  const v5Version = await sharedVersion("bundled-v5");
  await assert.rejects(browser.read(args), /no longer current/);
  const reboundBrowser = authority.bindBrowserReads();
  assert.match(JSON.stringify(await reboundBrowser.read(args)), /Written through Original/);
  await reboundBrowser.close();
  await assert.rejects(reboundBrowser.read(args), /no longer current/);
  assert.match(JSON.stringify(await call(clients[1].client, "capability_read", args)), /Written through Original/);
  const wrote = await call(clients[1].client, "note_modify", { slug: "Entry", content: "Written through v5." });
  assert.notEqual(wrote.isError, true, JSON.stringify(wrote));
  await authority.approveSwitch(authority.status(), "original");
  await assert.rejects(authority.approveSwitch(firstObservation, "bundled-v5"), /selection changed/);
  await sharedVersion("original");
  const canonical = await call(clients[0].client, "capability_read", args);
  const direct = await call(clients[0].client, "note_read", { slug: "Entry" });
  assert.deepEqual(direct, canonical);
  assert.match(JSON.stringify(direct), /Written through v5/);
  const denied = await call(clients[0].client, "capability_read", { ...args, operation: "mcp.tool.update_note" });
  assert.equal(denied.isError, true);
  assert.equal(value(await call(clients[1].client, "mcp_lifecycle_quiesce")).phase, "drained");
  assert.match(JSON.stringify(await call(clients[0].client, "note_read", { slug: "Entry" })), /Written through v5/);
  assert.equal(authority.status().automaticReplay, false);
  await Promise.all(clients.map(({ client }) => client.close()));
  const firstOwned = authority.status().originalConnections;
  await authority.close();
  closed = true;
  for (const { supervisorPid, runtime } of firstOwned) {
    assert.throws(() => process.kill(supervisorPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(runtime.pid, 0), { code: "ESRCH" });
  }
  const reopened = await startCompatibilityGatewayAuthority(config, bundled, host, "original");
  let quarantined = false;
  f.retainCleanup(async () => { if (!quarantined) await reopened.close(); });
  const { client } = await connect("chat", reopened);
  const lane = () => reopened.status().originalConnections.find(item => item.role === "chat");
  const pid = lane().runtime.pid;
  assert(Number.isSafeInteger(pid) && pid > 1);
  let stopped = false;
  try {
    process.kill(pid, "SIGSTOP"); stopped = true;
    const write = call(client, "note_modify", { slug: "Entry", content: "Unknown; must not replay." });
    const observe = Date.now() + 2_500;
    while (!lane().health.inFlight && Date.now() < observe) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(lane().health.inFlight, 1, "The call actually reached the Original adapter transport.");
    process.kill(pid, "SIGKILL"); stopped = false;
    assert.equal((await write).isError, true);
  } finally { if (stopped) process.kill(pid, "SIGCONT"); }
  assert.equal(reopened.status().phase, "action-required");
  assert.equal(reopened.status().uncertain, true);
  await assert.rejects(reopened.approveSwitch(reopened.status(), "bundled-v5"), /outstanding work/);
  await client.close();
  const interrupted = reopened.status().originalConnections;
  await assert.rejects(reopened.close(), /requires explicit recovery/);
  quarantined = true;
  for (const { supervisorPid, runtime } of interrupted) {
    assert.throws(() => process.kill(supervisorPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(runtime.pid, 0), { code: "ESRCH" });
  }
  await assert.rejects(tryPeer(), /requires explicit recovery/);
  await assert.rejects(f.connect(), /requires explicit recovery/);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Written through v5/);
  t.diagnostic(JSON.stringify({ workbenchAndChat: { originalVersion, v5Version }, sameRelays: true,
    modes: ["original", "bundled-v5", "original"], sameToolCatalog: true, storageMigrated: false, interrupted: "unknown-no-replay" }));
});
