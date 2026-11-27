import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { joinCompatibilityGatewayPeer, prepareCompatibilityGatewayAdmission, startOrJoinCompatibilityGateway } from "../dist/compatibility-gateway-coordination.js";
import { acquireCompatibilityGatewayCustody } from "../dist/compatibility-gateway-custody.js";
import { createNativePublicFacade } from "../dist/native-public-mcp.js";
import { compatibilityMcpFixture as fixture, compatibilityMcpValue as value } from "./compatibility-mcp-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const { acquireLinuxRootWriterFence } = createRequire(import.meta.url)("../legacy/dist/runtime/linux-root-writer-fence.js");

test("authenticated native and external peers share selection, writability, drain and honest Original attribution", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(f.target.args[0], "utf8"));
  const managedRoot = join(f.base, "live"), generation = randomUUID();
  await mkdir(managedRoot, { mode: 0o700 });
  const runtimeFile = new URL("../dist/native-public-mcp.js", import.meta.url);
  const runtimeBuild = hash(readFileSync(runtimeFile));
  const bundled = { generation, runtimeBuild, managedRoot, createFacade: createNativePublicFacade,
    assertVerified() { assert.equal(hash(readFileSync(runtimeFile)), runtimeBuild); } };
  await writeFile(join(managedRoot, "active-generation.json"),
    JSON.stringify({ schema: "pkm.mcp.lifecycle/v1", generation }), { mode: 0o600 });
  config.managedRoot = managedRoot;
  config.legacy.compatibleUpdates = false;
  config.gateway = { generation, runtimeBuild };
  const peerBinding = { originalGeneration: config.legacy.generation, originalBuild: config.legacy.runtimeBuild, bundledBuild: runtimeBuild };
  const workbenchAttribution = { schema: "pkm.mcp.attribution/v1", source: "vscode-provider", scope: "shared-host",
    hostId: randomUUID(), editorSessionId: randomUUID(), extensionHostPid: process.pid };
  const host = { workbenchAttribution, chatAttribution: { ...workbenchAttribution, source: "pkm-chat" },
    acquireLegacyFence(root) {
      const preflight = acquireLinuxRootWriterFence(root, "exclusive", 500);
      try { preflight.assertHeld(); } finally { preflight.release(); }
      return acquireLinuxRootWriterFence(root, "shared", 500);
    }, async confirm() { return true; } };
  const ownerAdmission = await prepareCompatibilityGatewayAdmission(f.root,
    () => acquireCompatibilityGatewayCustody(f.root, host.acquireLegacyFence), () => peerBinding);
  const earlyPeer = await prepareCompatibilityGatewayAdmission(f.root, async () => { throw Error("Peer must not take custody"); });
  assert.equal(earlyPeer.kind, "peer", "A window can prepare admission while the authenticated owner is still starting.");
  const privateEndpoint = JSON.parse(await readFile(join(f.root, ".pkm/state/compatibility-gateway/owner-live.json")));
  assert.equal((await fetch(`${privateEndpoint.origin}/host/probe`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  const owner = await startOrJoinCompatibilityGateway(config, bundled, host, ownerAdmission);
  const clients = [];
  let peerClosed = false, ownerClosed = false, worker;
  f.retainCleanup(async () => {
    await Promise.allSettled(clients.map(item => item.client.close()));
    if (worker && !peerClosed) {
      await rpc("close").catch(() => {});
      if (worker.connected) worker.disconnect();
    }
    if (!ownerClosed) await owner.close().catch(() => {});
  });
  const script = join(f.base, "peer.mjs");
  await writeFile(script, `
import { randomUUID } from "node:crypto";
import { joinCompatibilityGatewayPeer } from ${JSON.stringify(new URL("../dist/compatibility-gateway-coordination.js", import.meta.url).href)};
let busy = false, confirmed = true, confirmations = 0;
const workbenchAttribution = { schema:"pkm.mcp.attribution/v1",source:"vscode-provider",scope:"shared-host",
hostId:randomUUID(),editorSessionId:randomUUID(),extensionHostPid:process.pid };
const host = { workbenchAttribution,chatAttribution:{...workbenchAttribution,source:"pkm-chat"},
hasActiveChatWork:()=>busy,acquireLegacyFence(){throw Error("Peer must not acquire writer fence");},
async confirm(){confirmations++;return confirmed;} };
const peer = await joinCompatibilityGatewayPeer(${JSON.stringify(f.root)},${JSON.stringify(peerBinding)},host);
process.send({ready:true,workbench:peer.relay("workbench"),chat:peer.relay("chat"),workbenchAttribution});
process.on("message",async input=>{
try {
 let result;
 if(input.command==="busy"){busy=input.value;result={};}
 if(input.command==="confirm"){confirmed=input.value;result={};}
 if(input.command==="status")result={...await peer.status(),confirmations};
 if(input.command==="switch")result=await peer.approveSwitch(input.expected,input.target);
 if(input.command==="close"){await peer.close();result={};}
 process.send({id:input.id,result});
 if(input.command==="close")process.disconnect();
} catch(error){process.send({id:input.id,error:error.message});}
});
`);
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    worker = fork(script, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    worker.once("error", reject);
    worker.on("message", message => {
      if (message.ready) resolve(message);
      else {
        const entry = pending.get(message.id); pending.delete(message.id);
        if (message.error) entry?.reject(new Error(message.error)); else entry?.resolve(message.result);
      }
    });
  });
  function rpc(command, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      worker.send({ id, command, ...fields });
    });
  }
  const peer = await ready;
  const other = await fixture(t);
  const independent = await prepareCompatibilityGatewayAdmission(other.root,
    () => acquireCompatibilityGatewayCustody(other.root, host.acquireLegacyFence));
  assert.equal(independent.kind, "owner");
  await independent.release(true);
  async function connect(role, binding) {
    const client = new Client({ name: role, version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [new URL("../dist/compatibility-gateway-relay.js", import.meta.url).pathname],
      env: { PKM_SHARED_ORIGIN: binding.origin, PKM_SHARED_SERVICE_ID: binding.serviceId, PKM_SHARED_TOKEN: binding.token },
      stderr: "pipe" });
    const item = { client, transport };
    clients.push(item);
    await client.connect(transport);
    return item;
  }
  const ownerClients = await Promise.all(["workbench", "chat"].map(role => connect(role, owner.relay(role))));
  const peerClients = await Promise.all(["workbench", "chat"].map(role => connect(role, peer[role])));
  const call = (item, name, args = {}) => item.client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  const versions = await Promise.all([...ownerClients, ...peerClients].map(item => call(item, "check_version").then(value)));
  assert.equal(new Set(versions.map(item => item.originalConnection.instanceId)).size, 4);
  assert.deepEqual(versions.map(item => item.originalConnection.attribution.hostId),
    [workbenchAttribution.hostId, workbenchAttribution.hostId, peer.workbenchAttribution.hostId, peer.workbenchAttribution.hostId]);
  assert.match(JSON.stringify(await call(peerClients[0], "note_read", { slug: "Entry" })), /Original business content/);
  const snapshot = await owner.status();
  await rpc("busy", { value: true });
  await assert.rejects(owner.approveSwitch(snapshot, "bundled-v5"), /Outstanding work/);
  await rpc("busy", { value: false });
  await rpc("confirm", { value: false });
  assert.equal((await owner.approveSwitch(snapshot, "bundled-v5")).applied, false);
  assert.equal((await owner.status()).selectionRevision, snapshot.selectionRevision);
  await rpc("confirm", { value: true });
  const browser = await owner.bindBrowserReads();
  const peerPid = (await rpc("status")).originalConnections[0].runtime.pid;
  process.kill(peerPid, "SIGSTOP");
  const reading = call(peerClients[0], "note_read", { slug: "Entry" });
  try {
    for (let i = 0; i < 200 && !(await owner.status()).inFlight; i++) await pause(10);
    assert.equal((await owner.status()).inFlight, 1);
    await assert.rejects(owner.approveSwitch(snapshot, "bundled-v5"), /Outstanding work/);
  } finally { process.kill(peerPid, "SIGCONT"); }
  await reading;
  process.kill(peerPid, "SIGSTOP");
  const switching = rpc("switch", { expected: snapshot, target: "bundled-v5" });
  try {
    for (let i = 0; i < 200 && (await owner.status()).phase !== "draining"; i++) await pause(10);
    assert.equal((await owner.status()).phase, "draining");
    const refused = await call(ownerClients[0], "note_modify", { slug: "Entry", content: "Must not dispatch while draining" });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused), /no call dispatched/i);
  } finally { process.kill(peerPid, "SIGCONT"); }
  assert.equal((await switching).applied, true);
  assert((await rpc("status")).confirmations >= 2);
  for (const item of [...ownerClients, ...peerClients]) assert.equal(value(await call(item, "check_version")).dispatchMode, "bundled-v5");
  await assert.rejects(browser.read({ operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Entry" } }), /no longer current/);
  const cli = new Client({ name: "cli-peer", version: "1" });
  const cliTransport = new StdioClientTransport({ command: process.execPath,
    args: [new URL("../dist/compatibility-gateway-peer-cli.js", import.meta.url).pathname,
      f.root, peerBinding.originalGeneration, peerBinding.originalBuild, peerBinding.bundledBuild], stderr: "pipe" });
  clients.push({ client: cli, transport: cliTransport });
  await cli.connect(cliTransport);
  assert.equal(value(await cli.callTool({ name: "check_version", arguments: {} })).dispatchMode, "bundled-v5");
  assert.equal(value(await cli.callTool({ name: "check_version", arguments: {} })).originalConnection.attribution.source, "standalone");
  assert.equal(value(await cli.callTool({ name: "check_version", arguments: {} })).routeRuntime.participant.writable, false);
  assert.match(JSON.stringify(await cli.callTool({ name: "note_read", arguments: { slug: "Entry" } })), /Original business content/);
  assert.equal((await cli.callTool({ name: "note_modify", arguments: { slug: "Entry", content: "Denied" } })).isError, true);
  const writer = new Client({ name: "writable-external-peer", version: "1" });
  const writerTransport = new StdioClientTransport({ command: process.execPath,
    args: [new URL("../dist/compatibility-gateway-peer-cli.js", import.meta.url).pathname,
      f.root, peerBinding.originalGeneration, peerBinding.originalBuild, peerBinding.bundledBuild, "--writable"], stderr: "pipe" });
  clients.push({ client: writer, transport: writerTransport });
  let writerDiagnostic = "";
  writerTransport.stderr?.on("data", bytes => { writerDiagnostic += bytes; });
  try { await writer.connect(writerTransport); }
  catch (error) { throw new Error(`${error.message}\n${writerDiagnostic}`, { cause: error }); }
  const externalVersion = value(await writer.callTool({ name: "check_version", arguments: {} }));
  assert.equal(externalVersion.routeRuntime.participant.source, "external");
  assert.equal(externalVersion.routeRuntime.participant.writable, true);
  assert.equal(externalVersion.routeRuntime.participant.process.pid, writerTransport.pid);
  assert.deepEqual(externalVersion.originalConnection.attribution,
    { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" });
  const writerPid = JSON.parse(await readFile(join(f.managed, "instances", `${externalVersion.originalConnection.instanceId}.json`))).pid;
  process.kill(writerPid, "SIGSTOP");
  const writing = writer.callTool({ name: "capability_call", arguments: {
    operation: "mcp.tool.update_note", version: 1, arguments: { slug: "Entry", content: "Written through writable external." },
  } });
  try {
    for (let i = 0; i < 200 && !(await owner.status()).inFlight; i++) await pause(10);
    assert.equal((await owner.status()).inFlight, 1);
    await assert.rejects(owner.approveSwitch(await owner.status(), "original"), /Outstanding work/);
  } finally { process.kill(writerPid, "SIGCONT"); }
  assert.notEqual((await writing).isError, true);
  assert.match(JSON.stringify(await call(ownerClients[0], "note_read", { slug: "Entry" })), /Written through writable external/);
  await owner.approveSwitch(await owner.status(), "original");
  assert.equal(value(await cli.callTool({ name: "check_version", arguments: {} })).dispatchMode, "original");
  assert.equal(value(await writer.callTool({ name: "check_version", arguments: {} })).dispatchMode, "original");
  assert.notEqual((await writer.callTool({ name: "note_modify",
    arguments: { slug: "Entry", content: "Written through Original external." } })).isError, true);
  assert.match(JSON.stringify(await cli.callTool({ name: "note_read", arguments: { slug: "Entry" } })), /Written through Original external/);
  await writer.close();
  await cli.close();
  for (let i = 0; i < 200 && (await owner.status()).members !== 2; i++) await pause(10);
  assert.equal((await owner.status()).members, 2);
  for (const item of peerClients) await item.client.close();
  await rpc("close"); peerClosed = true;
  assert.equal((await owner.status()).members, 1);
  assert.equal(value(await call(ownerClients[0], "check_version")).dispatchMode, "original");
  await assert.rejects(f.connect(), /already held/);
  const descriptorFile = join(f.root, ".pkm/state/compatibility-gateway/owner-live.json");
  const descriptor = await readFile(descriptorFile), parsed = JSON.parse(descriptor);
  await writeFile(descriptorFile, JSON.stringify({ ...parsed, process: { ...parsed.process, startTimeTicks: "0" } }));
  await assert.rejects(prepareCompatibilityGatewayAdmission(f.root, async () => { throw Error("Must not reclaim"); }), /requires recovery/);
  await writeFile(descriptorFile, descriptor);
  const wrong = new Client({ name: "stale-cli", version: "1" });
  const wrongTransport = new StdioClientTransport({ command: process.execPath,
    args: [new URL("../dist/compatibility-gateway-peer-cli.js", import.meta.url).pathname,
      f.root, peerBinding.originalGeneration, "0".repeat(64), peerBinding.bundledBuild], stderr: "pipe" });
  clients.push({ client: wrong, transport: wrongTransport });
  await assert.rejects(wrong.connect(wrongTransport));
  for (const item of ownerClients) await item.client.close();
  await owner.close(); ownerClosed = true;

  const restrictedAdmission = await prepareCompatibilityGatewayAdmission(f.root,
    () => acquireCompatibilityGatewayCustody(f.root, host.acquireLegacyFence));
  const restricted = await startOrJoinCompatibilityGateway({ ...config, writable: false }, bundled, host, restrictedAdmission);
  let restrictedClosed = false;
  f.retainCleanup(async () => { if (!restrictedClosed) await restricted.close().catch(() => {}); });
  const standalone = { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" };
  await assert.rejects(joinCompatibilityGatewayPeer(f.root, peerBinding, {
    relayRoles: ["workbench"], externalPeer: { writable: true }, workbenchAttribution: standalone, chatAttribution: standalone,
    acquireLegacyFence() { throw Error("External must not acquire custody"); }, async confirm() { return false; },
  }), /managed owner is read-only; writable external admission was refused/);
  assert.equal((await restricted.status()).members, 1);
  await restricted.close(); restrictedClosed = true;

  const restartedAdmission = await prepareCompatibilityGatewayAdmission(f.root,
    () => acquireCompatibilityGatewayCustody(f.root, host.acquireLegacyFence));
  const restarted = await startOrJoinCompatibilityGateway(config, bundled, host, restartedAdmission);
  let restartedClosed = false;
  f.retainCleanup(async () => { if (!restartedClosed) await restarted.close().catch(() => {}); });
  const crashed = new Client({ name: "crashed-cli", version: "1" });
  const crashedTransport = new StdioClientTransport({ command: process.execPath,
    args: [new URL("../dist/compatibility-gateway-peer-cli.js", import.meta.url).pathname,
      f.root, peerBinding.originalGeneration, peerBinding.originalBuild, peerBinding.bundledBuild], stderr: "pipe" });
  clients.push({ client: crashed, transport: crashedTransport });
  await crashed.connect(crashedTransport);
  assert.equal((await restarted.status()).members, 2);
  process.kill(crashedTransport.pid, "SIGKILL"); // This fixture's own enrolled CLI, not a user process.
  let denied = false;
  for (let i = 0; i < 200 && !denied; i++) {
    try { await restarted.status(); } catch { denied = true; }
    if (!denied) await pause(10);
  }
  assert(denied, "A crashed peer must fence the shared root, not silently drop its work ledger.");
  await assert.rejects(prepareCompatibilityGatewayAdmission(f.root, async () => { throw Error("Must not reclaim"); }), /requires recovery/);
  await assert.rejects(restarted.close(), /requires explicit recovery/); restartedClosed = true;
  assert.match(await readFile(join(f.root, ".pkm/state/compatibility-gateway/owner-pending.json"), "utf8"), /custody/);
});

test("unknown/crashed owner markers never admit peers or erase restart inhibition", async t => {
  const f = await fixture(t);
  const dir = join(f.root, ".pkm/state/compatibility-gateway");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "owner.guard"), "", { mode: 0o600 });
  const config = JSON.parse(await readFile(f.target.args[0], "utf8"));
  const attribution = { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" };
  await assert.rejects(joinCompatibilityGatewayPeer(f.root, {
    originalGeneration: config.legacy.generation, originalBuild: config.legacy.runtimeBuild, bundledBuild: config.gateway.runtimeBuild,
  }, { relayRoles: ["workbench"], externalPeer: { writable: true },
    workbenchAttribution: attribution, chatAttribution: attribution,
    acquireLegacyFence() { throw Error("Must not acquire custody"); }, async confirm() { return false; } }),
  /COMPATIBILITY_OWNER_UNAVAILABLE.*no cold fallback was started/);
  assert.deepEqual(await readFile(join(dir, "owner.guard")), Buffer.alloc(0));
  const marker = join(dir, "owner-pending.json");
  await writeFile(marker, '{"unknown":"owner"}', { mode: 0o600 });
  let attempts = 0;
  await assert.rejects(prepareCompatibilityGatewayAdmission(f.root, async () => { attempts++; throw Error("Unexpected"); }), /requires recovery/);
  assert.equal(attempts, 0);
  assert.equal(await readFile(marker, "utf8"), '{"unknown":"owner"}');
});
