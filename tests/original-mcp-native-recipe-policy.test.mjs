import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest } from "../dist/original-mcp-native-host.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";

const policyApi = await import(process.env.PKM_RECIPE_POLICY_MODULE || "../dist/original-mcp-native-recipe-policy.js");
const usage = await import(process.env.PKM_RECIPE_USAGE_MODULE || "../dist/original-mcp-recipe-usage.js");
const contracts = await import(process.env.PKM_RECIPE_CONTRACTS_MODULE || "../dist/original-mcp-native-recipe-contracts.js");
const hash = contracts.originalNativeRecipeDigest, limits = { maxFiles: 100, maxFileBytes: 1048576, maxTotalBytes: 1048576 };
const actor = { id: "mcp:external", canWrite: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing private Linux test framework for cold original writers.");
  const directory = resolve("tests", `.recipe-policy-${randomUUID()}`), root = join(directory, "root");
  const endpoint = resolve(`.rw-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(root, ".pkm/state/recipe-runs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "notes"), { mode: 0o700 }); mkdirSync(endpoint, { mode: 0o700 });
  writeFileSync(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal Recipe accounting.\n", { mode: 0o600 });
  writeFileSync(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const runPath = join(root, ".pkm/state/recipe-runs/recipe_run_000000000000000000000001.json");
  const run = { schema: "pkm.recipe.run/v1", runId: "recipe_run_000000000000000000000001", recipeId: "recipe_original",
    recipeName: "Original accounting", recipeRevision: 1, status: "running", nodes: {}, usage: { estimatedTokens: 12 } };
  execFileSync("python3", ["-I", "-B", "-c", `
import ast,json,os,sys,uuid
from pathlib import Path
ns={'json':json,'os':os,'uuid':uuid}
for node in ast.parse(Path(sys.argv[1]).read_text()).body:
 if isinstance(node,ast.FunctionDef) and node.name in {'_json','_atomic_write'}:
  exec(compile(ast.Module(body=[node],type_ignores=[]),sys.argv[1],'exec'),ns)
ns['_atomic_write'](Path(sys.argv[2]),json.load(sys.stdin))
`, resolve("legacy/resources/recipe_runtime.py"), runPath], { input: JSON.stringify(run) });
  const originalBytes = readFileSync(runPath);
  let opened, host, producer, server, socket, wireSession;
  t.after(async () => {
    producer?.dispose(); socket?.destroy(); await server?.close(); await host?.close(); await opened?.owner.close();
    assert.deepEqual(readFileSync(runPath), originalBytes);
    rmSync(endpoint, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true });
  });
  const profileSha256 = hash("synthetic-native-recipe-profile");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "recipe-policy-wire-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 16, maxBytes: 1048576, maxFileBytes: 1048576 } });
  opened = await openOriginalMcpRoot(plan);
  // The key/profile/native answers are explicit signer/UI doubles, not installed VS Code qualification.
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
    catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
    payloadBuildId: hash("recipe-wire-fixture-payload"), hostEntrySha256: hash("recipe-wire-fixture-host") };
  server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  socket = connect(join(endpoint, "n"));
  let buffer = "", attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const frames = [], cancellations = [], controls = { allow: true, pending: false, badDigest: false };
  const send = value => socket.write(JSON.stringify(value) + "\n");
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-cancel") cancellations.push(frame);
      else if (frame.type === "native-request") {
        frames.push(frame);
        if (frame.method === "recipe.source.approve") {
          if (!controls.pending) send(originalMcpNativeResult(frame, controls.allow ? {
            actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 60000,
            requestSha256: controls.badDigest ? "0".repeat(64) : hash(frame.payload.request),
          } : null));
        } else send(originalMcpNativeResult(frame, { decision: "approve" }));
      }
    }
  });
  await attached; wireSession = await server.waitForSession({ timeoutMs: 1000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(wireSession),
    methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(wireSession, { timeoutMs: 1000 });
  host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(wireSession));
  producer = await policyApi.createOriginalMcpNativeRecipeSourcePolicy(opened.owner, host, wireSession);
  const source = await usage.planOriginalMcpRecipeUsage(opened.owner, host, limits);
  const request = { ...source, phase: "admit", actorId: "mcp:external", epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256, noExecution: true };
  const read = (args = {}) => withOriginalMcpPublicRequest(opened.storage, host, {
    operation: "mcp.tool.recipe_usage_summary", version: 1, tool: "recipe_usage_summary", readOnly: true,
    arguments: args, argumentsDigest: hash(args),
  }, () => usage.readOriginalMcpRecipeUsage(opened.owner, host, actor, args));
  return { opened, host, producer, session: wireSession, source, request, read, frames, cancellations, controls };
}
test("actual signed socket + same RootOwner: Recipe policy brand rejects substitutes; missing lane never admits source", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.doesNotThrow(() => policyApi.assertOriginalMcpNativeRecipeSourcePolicy(f.producer.policy, f.opened.owner, f.host));
  assert.throws(() => policyApi.assertOriginalMcpNativeRecipeSourcePolicy({ ...f.producer.policy }, f.opened.owner, f.host),
    { code: "NATIVE_RECIPE_SOURCE_POLICY_REQUIRED" });
  await assert.rejects(policyApi.createOriginalMcpNativeRecipeSourcePolicy(f.opened.owner, f.host, { ...f.session }));
  await assert.rejects(f.read(), /separate Recipe source decision/);
  if (!originalMcpNativeRequestMethods.some(method => method === "recipe.source.approve")) {
    await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, f.source, f.producer.policy),
      { code: "MISSING_NATIVE_METHOD" });
    assert.equal(f.frames.filter(frame => frame.method === "recipe.source.approve").length, 0);
    const db = f.opened.storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'original_recipe_usage_%'").get().count, 0); }
    finally { db.close(); }
    await f.session.close(); assert.equal(f.producer.signal.aborted, true);
    t.diagnostic("Actual signed lane has no Recipe method: source activation correctly remains closed; no production grant is inferred.");
    return;
  }
  await usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, f.source, f.producer.policy);
  assert.equal((await f.read()).summaries[0].average_estimated_tokens_per_run, 12);
  const approval = await f.producer.policy.authorize(f.request, new AbortController().signal), parsed = { ...approval };
  policyApi.retainOriginalMcpNativeRecipeSourceApproval(approval, parsed, f.request);
  const signal = policyApi.originalMcpNativeRecipeSourceApprovalSignal(parsed);
  assert.equal(signal.aborted, false);
  f.producer.revoke(); assert.equal(signal.aborted, true);
  assert.throws(() => policyApi.assertOriginalMcpNativeRecipeSourceApprovalCurrent(parsed), /REVOKED/);
  await assert.rejects(f.read(), /source decision|REVOKED/);
  await usage.activateOriginalMcpRecipeUsage(f.opened.owner, f.host, f.producer.policy);
  assert.equal((await f.read()).ok, true);
  f.controls.allow = false;
  await assert.rejects(usage.activateOriginalMcpRecipeUsage(f.opened.owner, f.host, f.producer.policy), /denied/);
  await assert.rejects(f.read(), /source decision/);
  f.controls.allow = true; f.controls.badDigest = true;
  await assert.rejects(usage.activateOriginalMcpRecipeUsage(f.opened.owner, f.host, f.producer.policy), /DECISION_INVALID/);
  f.controls.badDigest = false;
  await usage.activateOriginalMcpRecipeUsage(f.opened.owner, f.host, f.producer.policy);
  await f.session.close(); assert.equal(f.producer.signal.aborted, true);
  await assert.rejects(f.read(), /unavailable or changed|REVOKED/);
});
test("Recipe signed producer validates full request/frame even when method is absent; cancellation cannot become consent", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const changed = { ...f.request, epoch: randomUUID() };
  await assert.rejects(f.producer.policy.authorize(changed, new AbortController().signal), /BINDING_MISMATCH/);
  const huge = structuredClone(f.request);
  huge.files = Array.from({ length: 500 }, (_, i) => ({ ...huge.files[0], path: `.pkm/state/recipe-runs/recipe_run_${i}_${"original".repeat(15)}.json` }));
  huge.runsScanned = 500; huge.limits.maxFiles = 1000; huge.sourceSha256 = hash(huge.files);
  const { phase, actorId, epoch, nativeHostReceiptSha256, noExecution, planSha256, ...body } = huge; huge.planSha256 = hash(body);
  await assert.rejects(f.producer.policy.authorize(huge, new AbortController().signal), error => error.code === "NATIVE_REQUEST_TOO_LARGE"
    && error.requiredBytes > 65536);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.producer.policy.authorize(f.request, cancelled.signal), /abort/i);
  if (!originalMcpNativeRequestMethods.some(method => method === "recipe.source.approve")) return;
  f.controls.pending = true;
  const control = new AbortController(), waiting = f.producer.policy.authorize(f.request, control.signal);
  for (let i = 0; i < 100 && !f.frames.some(frame => frame.method === "recipe.source.approve"); i++) await delay(5);
  const refused = assert.rejects(waiting, /CANCELLED/); control.abort(); await refused;
  for (let i = 0; i < 100 && !f.cancellations.length; i++) await delay(5);
  assert.equal(f.cancellations.length, 1);
  await assert.rejects(f.read(), /source decision/);
});
