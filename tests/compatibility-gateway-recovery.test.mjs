import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectCompatibilityGatewayRecovery as inspect, recoverCompatibilityGateway as recover } from "../dist/compatibility-gateway-recovery.js";
import { originalMcpBrokerProcessPin } from "../dist/original-mcp-relay.js";

const require = createRequire(import.meta.url);
const { acquireLinuxRootWriterFence } = require("../legacy/dist/runtime/linux-root-writer-fence.js");

async function fixture(t, options = {}) {
  const evidence = resolve(".pkm-test-evidence");
  await mkdir(evidence, { mode: 0o700, recursive: true });
  const base = await mkdtemp(join(evidence, "manual-recovery-")), root = join(base, "library");
  await mkdir(root, { mode: 0o700 });
  const worker = join(base, "owner.mjs");
  await writeFile(worker, `
import {acquireCompatibilityGatewayCustody} from ${JSON.stringify(new URL("../dist/compatibility-gateway-custody.js", import.meta.url).href)};
process.on("message",()=>{});
const custody=await acquireCompatibilityGatewayCustody(process.argv[2],${options.admission
    ? 'async root=>{process.send({ready:true});await new Promise(()=>{});}'
    : 'root=>({root,mode:"shared",assertHeld(){},release(){}})'});
${options.operation ? `await custody.beginRecoveryEvidence("operation","test:uncertain-write");` : ""}
${options.peer ? `await custody.beginRecoveryEvidence("participant","test:peer",${JSON.stringify(originalMcpBrokerProcessPin())});` : ""}
process.on("message",async message=>{
  if(message!=="clean")return;
  try{await custody.release(true);process.send({clean:true});}
  catch(error){process.send({error:error.message});}
});
process.send({ready:true});
`);
  const child = fork(worker, [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr.on("data", bytes => { errors += bytes; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const crash = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; };
  t.after(async () => { await crash(); await rm(base, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(Error(errors)));
  });
  const directory = join(root, ".pkm/state/compatibility-gateway");
  const marker = join(directory, "owner-pending.json");
  return { root, directory, marker, crash, clean: () => new Promise(resolve => {
    child.once("message", resolve); child.send("clean");
  }) };
}

test("manual recovery refuses a live custody owner and leaves its evidence untouched", async t => {
  const f = await fixture(t);
  const before = await readFile(f.marker);
  const review = await inspect(f.root);
  assert.equal(review.recoverable, false);
  assert.equal(review.processes[0].state, "live");
  await assert.rejects(recover(f.root, review.reviewSha256), /guard.*unavailable|already held/);
  assert.deepEqual(await readFile(f.marker), before);
});

test("dead idle owner recovery archives evidence exactly once under competing confirmations", async t => {
  const f = await fixture(t);
  const before = await readFile(f.marker);
  await f.crash();
  const review = await inspect(f.root);
  assert.equal(review.recoverable, true);
  const results = await Promise.allSettled([recover(f.root, review.reviewSha256), recover(f.root, review.reviewSha256)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const receipt = results.find(result => result.status === "fulfilled").value;
  assert.deepEqual(await readFile(join(receipt.archive, "owner-pending.json")), before);
  assert.equal(JSON.parse(await readFile(join(receipt.archive, "review.json"))).automaticReplay, false);
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});

test("a live peer blocks dead-owner recovery; admitted peer identity is not silently discarded", async t => {
  const f = await fixture(t, { peer: true });
  await f.crash();
  const review = await inspect(f.root);
  assert.equal(review.recoverable, false);
  assert(review.reasons.some(reason => /test:peer: live/.test(reason)));
  await assert.rejects(recover(f.root, review.reviewSha256), /test:peer: live/);
  assert.equal((await readdir(f.directory)).some(name => name.startsWith("recovered-")), false);
});

test("uncertain operation survives dead-owner recovery refusal with actionable evidence", async t => {
  const f = await fixture(t, { operation: true });
  await f.crash();
  const review = await inspect(f.root);
  assert.equal(review.recoverable, false);
  assert.equal(review.unresolved.length, 1);
  assert.equal(JSON.parse(await readFile(review.unresolved[0].evidence)).label, "test:uncertain-write");
  await assert.rejects(recover(f.root, review.reviewSha256), /Unresolved operation.*test:uncertain-write/);
  await readFile(f.marker);
  await readFile(review.unresolved[0].evidence);
});

test("even an explicitly requested clean close cannot discard outstanding operation evidence", async t => {
  const f = await fixture(t, { operation: true });
  assert.match((await f.clean()).error, /Pending compatibility operations or participants/);
  await readFile(f.marker);
  await f.crash();
  assert.equal((await inspect(f.root)).unresolved[0].label, "test:uncertain-write");
});

test("lost predecessor admission remains an unresolved operation after the service dies", async t => {
  const f = await fixture(t, { admission: true });
  await f.crash();
  const review = await inspect(f.root);
  assert.equal(review.recoverable, false);
  assert.equal(review.unresolved[0].label, "custody:legacy-writer-admission");
  await assert.rejects(recover(f.root, review.reviewSha256), /legacy-writer-admission/);
});

test("independent native writer sessions and old uninstrumented custody cannot be silently cleared", async t => {
  const f = await fixture(t);
  await f.crash();
  await mkdir(join(f.root, ".pkm/state/managed-writer-session"), { mode: 0o700 });
  const review = await inspect(f.root);
  assert.equal(review.recoverable, false);
  await assert.rejects(recover(f.root, review.reviewSha256), /native writer-session journals/);
  const marker = JSON.parse(await readFile(f.marker));
  delete marker.recoverySchema;
  await writeFile(f.marker, JSON.stringify(marker));
  await assert.rejects(inspect(f.root), /missing\/unsupported process or recovery evidence/);
  assert.equal(JSON.parse(await readFile(f.marker)).owner, marker.owner);
});

for (const state of ["replacement-pid", "unverifiable-boot"]) {
  test(`manual recovery refuses ${state} rather than treating a failed PID probe as death`, async t => {
    const f = await fixture(t);
    await f.crash();
    const marker = JSON.parse(await readFile(f.marker));
    marker.process = originalMcpBrokerProcessPin();
    if (state === "replacement-pid") marker.process.startTimeTicks = String(BigInt(marker.process.startTimeTicks) + 1n);
    else marker.process.bootId = randomUUID();
    await writeFile(f.marker, JSON.stringify(marker));
    const review = await inspect(f.root);
    assert.equal(review.processes[0].state, state);
    await assert.rejects(recover(f.root, review.reviewSha256), new RegExp(state));
  });
}

test("review changes and a newly held root writer fence both refuse recovery", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.crash();
  const review = await inspect(f.root);
  const fence = acquireLinuxRootWriterFence(f.root, "shared", 1_000);
  try { await assert.rejects(recover(f.root, review.reviewSha256), /fence|flock/i); }
  finally { fence.release(); }
  const owner = JSON.parse(await readFile(f.marker)).owner, id = randomUUID();
  await writeFile(join(f.directory, `evidence-${owner}`, `${id}.begin.json`), JSON.stringify({
    schema: "pkm.compatibility-recovery-event/v1", owner, id, category: "operation", label: "arrived-after-inspect",
    process: originalMcpBrokerProcessPin(),
  }), { mode: 0o600 });
  await assert.rejects(recover(f.root, review.reviewSha256), /review changed/);
  assert.equal((await inspect(f.root)).recoverable, false);
});
