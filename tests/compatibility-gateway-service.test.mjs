import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compatibilityMcpFixture as fixture, compatibilityMcpValue as value } from "./compatibility-mcp-fixture.mjs";
import { inspectCompatibilityGatewayRecovery, recoverCompatibilityGateway } from "../dist/compatibility-gateway-recovery.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = promisify(execFile);
const recoveryCli = async (...args) => JSON.parse((await run(process.execPath,
  [new URL("../dist/compatibility-gateway-recovery-cli.js", import.meta.url).pathname, ...args],
  { timeout: 15_000 })).stdout);

async function windows(t) {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(f.target.args[0], "utf8"));
  const extension = join(f.base, "extension"), payload = join(extension, "next-runtime");
  await mkdir(join(extension, "dist/runtime"), { recursive: true, mode: 0o700 });
  await mkdir(join(extension, "resources"), { mode: 0o700 });
  await mkdir(join(payload, "server"), { recursive: true, mode: 0o700 });
  await symlink(new URL("../dist", import.meta.url).pathname, join(payload, "server/dist"));
  await symlink(config.supervisor.path, join(extension, "resources/next_mcp_subreaper.py"));
  await writeFile(join(extension, "dist/runtime/linux-root-writer-fence.js"),
    await readFile(new URL("../legacy/dist/runtime/linux-root-writer-fence.js", import.meta.url)), { mode: 0o600 });
  const verifier = join(extension, "dist/runtime/next-payload-verifier.js");
  // Isolated installed-payload surrogate; production uses its complete signed-by-digest inventory.
  await writeFile(verifier, `exports.verifyNextPayload=()=>(${JSON.stringify({
    root: payload, buildId: "f".repeat(64), version: "0.1.0",
  })});`, { mode: 0o600 });
  const workerFile = join(f.base, "window.cjs");
  await writeFile(workerFile, `
const fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),{randomUUID}=require("node:crypto");
const load=Module._load;
Module._load=function(name,...args){if(name==="../runtime/next-payload-verifier")return require(${JSON.stringify(verifier)});return load.call(this,name,...args);};
const {createBundledCompatibilityRoute}=require(${JSON.stringify(new URL("../legacy/dist/mcp/bundled-compatibility-route.js", import.meta.url).pathname)});
require(${JSON.stringify(new URL("../legacy/dist/mcp/mcp-attribution.js", import.meta.url).pathname)}).configureManagedMcpAttribution({
hostId:randomUUID(),editorSessionId:randomUUID(),hostSlotId:randomUUID(),extensionHostPid:process.pid});
const root=${JSON.stringify(f.root)}, identity=fs.statSync(root);
const current=()=>{const s=fs.statSync(root);if(fs.realpathSync(root)!==root||s.dev!==identity.dev||s.ino!==identity.ino)throw Error("Root changed");};
const route=createBundledCompatibilityRoute({extensionPath:${JSON.stringify(extension)},
storage:path.join(${JSON.stringify(f.base)},"control-"+process.argv[2]),root:()=>root,
managed:()=>${JSON.stringify(f.managed)},python:()=>${JSON.stringify(config.python)},assertAllowed:current,
live:{assertAdmittedRoot:current,hasActiveChatWork:()=>false,confirm:async()=>true}});
let requestId=0, progress=[];
process.on("message",async input=>{
try{
let result;
if(input.command==="launch"){const launch=await route.launch(input.role);result={command:launch.command,args:launch.args,env:launch.env};}
if(input.command==="status"){const responses=[];await route.handleSettings({command:"mcpBackendSwitchRead",requestId:++requestId},m=>responses.push(m.data));result=responses.at(-1);}
if(input.command==="progress")result=progress;
if(input.command==="switch"){const s=input.snapshot,responses=[];await route.handleSettings({command:"mcpBackendSwitchApply",requestId:++requestId,serviceId:s.serviceId,
activeGeneration:s.active.generation,selectionRevision:s.selectionRevision,generation:input.target.generation,runtimeBuild:input.target.runtimeBuild},
m=>{responses.push(m.data);if(m.data.progress)progress.push(m.data.active.phase);});result=responses.at(-1);}
if(input.command==="metadata")result=await route.managedPeerDefinition();
if(input.command==="close")await route.dispose();
process.send({id:input.id,result});
}catch(error){process.send({id:input.id,error:error.message});}
finally{if(input.command==="close")process.disconnect();}
});
route.prepareCustody().then(()=>process.send({ready:true,pid:process.pid}),error=>{
process.send({startupError:error.message});process.disconnect();});
`);
  const workers = [], clients = [];
  f.retainCleanup(async () => {
    await Promise.allSettled(clients.map(item => item.client.close()));
    for (const worker of workers) if (worker.child.connected) {
      await worker.rpc("close").catch(() => {});
      if (worker.child.connected) worker.child.disconnect();
    }
  });
  async function open(name) {
    const child = fork(workerFile, [name], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const pending = new Map();
    let diagnostic = "";
    child.stderr.on("data", bytes => { diagnostic += bytes; });
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.once("disconnect", () => {
      for (const entry of pending.values()) entry.reject(Error("Window disconnected"));
      pending.clear();
    });
    const rpc = (command, fields = {}) => new Promise((resolve, reject) => {
      if (!child.connected) { reject(Error("Window disconnected")); return; }
      const id = randomUUID(), timeout = setTimeout(() => { pending.delete(id); reject(Error(`Window request timed out: ${command}`)); }, 60_000);
      pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); },
        reject: error => { clearTimeout(timeout); reject(error); } });
      child.send({ id, command, ...fields });
    });
    const worker = { child, rpc, exited };
    workers.push(worker);
    await new Promise((resolve, reject) => {
      child.on("message", message => {
        if (message.ready) resolve();
        else if (message.startupError) {
          const directory = join(f.base, "control-" + name);
          const logs = readdirSync(directory, { recursive: true }).filter(entry => entry.endsWith("service.log"))
            .map(entry => readFileSync(join(directory, entry), "utf8"));
          reject(Error(message.startupError + "\n" + diagnostic + logs.join("\n")));
        }
        else {
          const entry = pending.get(message.id); pending.delete(message.id);
          message.error ? entry?.reject(Error(message.error + "\n" + diagnostic)) : entry?.resolve(message.result);
        }
      });
      child.once("error", reject);
      child.once("exit", () => reject(Error("Window exited during startup\n" + diagnostic)));
    });
    return worker;
  }
  async function connect(worker, role) {
    const launch = await worker.rpc("launch", { role });
    const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
    const client = new Client({ name: role, version: "1" });
    const item = { client, transport }; clients.push(item);
    await client.connect(transport);
    return item;
  }
  const call = (item, name, args = {}) => item.client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  const descriptor = () => readFile(join(f.root, ".pkm/state/compatibility-gateway/owner-live.json"), "utf8").then(JSON.parse);
  return { ...f, open, connect, call, descriptor, clients, workers };
}

test("normal initiating-window close and Reload preserve the independent authority, peer work and selection", { timeout: 180_000 }, async t => {
  const f = await windows(t);
  const first = await f.open("first");
  assert.equal((await first.rpc("status")).error, "notAdmitted");
  const initialInstances = existsSync(join(f.managed, "instances")) ? await readdir(join(f.managed, "instances")) : [];
  assert.equal(initialInstances.filter(name => name.endsWith(".json")).length, 0, "reservation/discovery must not launch Original");
  const daemon = await f.descriptor();
  assert.equal(daemon.independentService, true);
  assert.notEqual(daemon.process.pid, first.child.pid);
  const originalClients = await Promise.all(["workbench", "chat"].map(role => f.connect(first, role)));
  const peer = await f.open("peer");
  const peerClients = await Promise.all(["workbench", "chat"].map(role => f.connect(peer, role)));
  const before = await Promise.all(peerClients.map(item => f.call(item, "check_version").then(value)));
  assert.equal(before[0].originalConnection.attribution.extensionHostPid, peer.child.pid);
  const busyPid = before[0].runtime.pid;
  process.kill(busyPid, "SIGSTOP");
  const reading = f.call(peerClients[0], "note_read", { slug: "Entry" });
  try {
    for (let i = 0; i < 200 && !(await peer.rpc("status")).active.inFlight; i++) await pause(10);
    assert.equal((await peer.rpc("status")).active.inFlight, 1);
    await first.rpc("close");
    await first.exited;
    assert.equal((await f.descriptor()).process.pid, daemon.process.pid);
    assert.equal((await peer.rpc("status")).active.inFlight, 1, "departing window cannot drop another peer's work ledger");
  } finally { process.kill(busyPid, "SIGCONT"); }
  await Promise.all(originalClients.map(item => item.client.close()));
  assert.match(JSON.stringify(await reading), /Original business content/);
  for (let i = 0; i < peerClients.length; i++) {
    const after = value(await f.call(peerClients[i], "check_version"));
    assert.deepEqual(after.originalConnection, before[i].originalConnection);
    assert.equal(after.routeRuntime.instanceId, before[i].routeRuntime.instanceId);
    assert.equal(after.dispatchMode, "original");
  }
  const snapshot = await peer.rpc("status");
  const switched = await peer.rpc("switch", { snapshot, target: snapshot.candidates.find(item => item.mode === "bundled-v5") });
  assert((await peer.rpc("progress")).includes("draining"),
    "the correlated real drain event survives a fast handoff and is delivered before its terminal result");
  assert.equal(switched.outcome, "completed");
  for (const item of peerClients) assert.equal(value(await f.call(item, "check_version")).dispatchMode, "bundled-v5");
  const reloaded = await f.open("reloaded");
  assert.equal((await reloaded.rpc("status")).error, "notAdmitted");
  const reloadedClients = await Promise.all(["workbench", "chat"].map(role => f.connect(reloaded, role)));
  for (const item of reloadedClients) assert.equal(value(await f.call(item, "check_version")).dispatchMode, "bundled-v5");
  assert.equal((await f.descriptor()).process.pid, daemon.process.pid);
  const joining = await f.open("joining");
  const enrollment = Promise.all(["workbench", "chat"].map(role => f.connect(joining, role)));
  await pause(100);
  await Promise.all(reloadedClients.map(item => item.client.close()));
  await reloaded.rpc("close"); await reloaded.exited;
  const joiningClients = await enrollment;
  for (const item of joiningClients) assert.equal(value(await f.call(item, "check_version")).dispatchMode, "bundled-v5");
  await Promise.all(joiningClients.map(item => item.client.close()));
  await joining.rpc("close"); await joining.exited;
  const v5 = await peer.rpc("status");
  assert.equal((await peer.rpc("switch", { snapshot: v5, target: v5.candidates.find(item => item.mode === "original") })).outcome, "completed");
  assert.match(JSON.stringify(await f.call(peerClients[0], "note_read", { slug: "Entry" })), /Original business content/);
  await Promise.all(peerClients.map(item => item.client.close()));
  await peer.rpc("close"); await peer.exited;
  assert.equal(existsSync(join(f.root, ".pkm/state/compatibility-gateway/owner-pending.json")), false,
    "only the independent owner's confirmed final drain releases its durable custody marker");
});

test("a crashed independent authority is never replaced or replayed by a native window", { timeout: 90_000 }, async t => {
  const f = await windows(t);
  const first = await f.open("crash");
  const clients = await Promise.all(["workbench", "chat"].map(role => f.connect(first, role)));
  const daemon = await f.descriptor();
  process.kill(daemon.process.pid, "SIGKILL"); // This test's own independently launched authority.
  for (let i = 0; i < 200; i++) {
    const result = await first.rpc("status");
    if (result.error === "loadingFailed") break;
    await pause(10);
  }
  assert.equal((await first.rpc("status")).error, "loadingFailed");
  await assert.rejects(f.open("must-not-take-over"), /requires recovery/);
  assert.equal(JSON.parse(await readFile(join(f.root, ".pkm/state/compatibility-gateway/owner-live.json"))).process.pid, daemon.process.pid);
  assert(existsSync(join(f.root, ".pkm/state/compatibility-gateway/owner-pending.json")));
  const denied = await f.call(clients[0], "note_modify", { slug: "Entry", content: "Must not replay" }).catch(() => ({ isError: true }));
  assert.equal(denied.isError, true);
  assert.match(await readFile(join(f.root, "notes/Entry.md"), "utf8"), /Original business content/);
});

test("manual crash review preserves evidence, refuses live peers, and permits explicit restart plus both dispatch modes", { timeout: 180_000 }, async t => {
  const f = await windows(t);
  const first = await f.open("manual-crash");
  const clients = await Promise.all(["workbench", "chat"].map(role => f.connect(first, role)));
  assert.match(JSON.stringify(await f.call(clients[0], "note_read", { slug: "Entry" })), /Original business content/);
  const daemon = await f.descriptor();
  process.kill(daemon.process.pid, "SIGKILL");
  let live;
  for (let i = 0; i < 200; i++) {
    live = await inspectCompatibilityGatewayRecovery(f.root);
    if (live.processes[0].state === "dead") break;
    await pause(25);
  }
  assert.equal(live.processes[0].state, "dead");
  assert.equal(live.recoverable, false, "still-live native peer must be explicitly closed");
  assert(live.reasons.some(reason => /peer:.*live/.test(reason)));
  await assert.rejects(recoverCompatibilityGateway(f.root, live.reviewSha256), /live/);
  await Promise.all(clients.map(item => item.client.close()));
  await first.rpc("close").catch(() => {});
  await first.exited;
  const review = await recoveryCli("inspect", f.root);
  assert.equal(review.recoverable, true, JSON.stringify(review.reasons));
  const recovered = await recoveryCli("recover", f.root, "--confirm", review.reviewSha256);
  assert.equal(JSON.parse(await readFile(join(recovered.archive, "owner-live.json"))).process.pid, daemon.process.pid);
  assert.equal(JSON.parse(await readFile(join(recovered.archive, "owner-pending.json"))).owner, review.owner);
  const restarted = await f.open("manual-restarted");
  const active = await Promise.all(["workbench", "chat"].map(role => f.connect(restarted, role)));
  assert.notEqual((await f.descriptor()).serviceId, daemon.serviceId);
  assert.equal(value(await f.call(active[0], "check_version")).dispatchMode, "original");
  assert.match(JSON.stringify(await f.call(active[0], "note_read", { slug: "Entry" })), /Original business content/);
  const original = await restarted.rpc("status");
  assert.equal((await restarted.rpc("switch", { snapshot: original,
    target: original.candidates.find(item => item.mode === "bundled-v5") })).outcome, "completed");
  for (const item of active) assert.equal(value(await f.call(item, "check_version")).dispatchMode, "bundled-v5");
  assert.match(JSON.stringify(await f.call(active[0], "note_read", { slug: "Entry" })), /Original business content/);
  const bundled = await restarted.rpc("status");
  assert.equal((await restarted.rpc("switch", { snapshot: bundled,
    target: bundled.candidates.find(item => item.mode === "original") })).outcome, "completed");
  await Promise.all(active.map(item => item.client.close()));
  await restarted.rpc("close"); await restarted.exited;
  assert.equal(existsSync(join(f.root, ".pkm/state/compatibility-gateway/owner-pending.json")), false);
  t.diagnostic(JSON.stringify({ manualRecovery: "inspect->confirmed-recover->restart", markerArchived: true,
    descriptorArchived: true, originalNoteRead: true, modes: ["original", "bundled-v5", "original"],
    automaticReplay: recovered.automaticReplay }));
});

test("crashing with an admitted Original write retains an unresolved operation and refuses manual recovery", { timeout: 90_000 }, async t => {
  const f = await windows(t);
  const first = await f.open("uncertain-crash");
  const clients = await Promise.all(["workbench", "chat"].map(role => f.connect(first, role)));
  const original = value(await f.call(clients[0], "check_version"));
  const daemon = await f.descriptor(), runtimePid = original.runtime.pid;
  process.kill(runtimePid, "SIGSTOP");
  const writing = f.call(clients[0], "note_modify", { slug: "Entry", content: "Unknown crash write outcome" })
    .catch(() => ({ isError: true }));
  try {
    for (let i = 0; i < 200 && !(await first.rpc("status")).active?.inFlight; i++) await pause(10);
    assert.equal((await first.rpc("status")).active.inFlight, 1);
    process.kill(daemon.process.pid, "SIGKILL");
  } finally {
    try { process.kill(runtimePid, "SIGCONT"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  assert.equal((await writing).isError, true);
  await Promise.all(clients.map(item => item.client.close()));
  await first.rpc("close").catch(() => {}); await first.exited;
  const review = await recoveryCli("inspect", f.root);
  assert.equal(review.recoverable, false);
  assert(review.unresolved.some(item => item.label === "relay:workbench:note_modify"));
  await assert.rejects(recoveryCli("recover", f.root, "--confirm", review.reviewSha256), /Unresolved operation.*note_modify/);
  for (const item of review.unresolved) await readFile(item.evidence);
  assert(existsSync(join(f.root, ".pkm/state/compatibility-gateway/owner-pending.json")));
});
