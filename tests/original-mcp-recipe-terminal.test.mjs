import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest } from "../dist/original-mcp-native-host.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { createOriginalMcpNativeRecipeSourcePolicy } from "../dist/original-mcp-native-recipe-policy.js";
import { originalNativeRecipeDigest as digest } from "../dist/original-mcp-native-recipe-contracts.js";
import { planOriginalMcpRecipeUsage, admitOriginalMcpRecipeUsage } from "../dist/original-mcp-recipe-usage.js";
import { planOriginalMcpRecipeTerminal, admitOriginalMcpRecipeTerminal, activateOriginalMcpRecipeTerminal,
  readOriginalMcpRecipeTerminal } from "../dist/original-mcp-recipe-terminal.js";

const actor = { id: "mcp:external", canWrite: false };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const runtime = resolve("legacy/resources/recipe_runtime.py");
const oracle = `
import ast,contextlib,datetime,hashlib,json,os,sys,time,uuid
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text())
ns=dict(globals(),API_SCHEMA='pkm.recipe.api/v1',RUN_SCHEMA='pkm.recipe.run/v1',
 TERMINAL_NODE_STATES={'succeeded','failed','skipped'},
 MEASURED_TOKEN_FIELDS=('input_tokens','output_tokens','cached_input_tokens','reasoning_tokens','total_tokens'),
 COMMAND_NODE_KIND='pkm.step.command/v1',SCRIPT_NODE_KIND='pkm.step.script/v1',
 PIPELINE_NODE_KIND='pkm.step.pipeline/v1')
names={'_json','_response','_atomic_write','_response_detail','_run_paths','_file_lock','_load_run',
 '_execution_kind','_sync_commands','_sync_subflows','_advance','_skip_unselected_nodes','_current_result',
 '_materialize_runtime_action','_materialize_subflow_action','_finalize_terminal_run','_usage_summary',
 '_empty_token_totals','_run_response'}
for node in tree.body:
 if isinstance(node,ast.FunctionDef) and node.name in names:
  exec(compile(ast.Module(body=[node],type_ignores=[]),sys.argv[1],'exec'),ns)
request=json.load(sys.stdin)
if request.get('write'):
 for run in request['runs']:
  ns['_atomic_write'](Path(request['root'])/'.pkm/state/recipe-runs'/(run['runId']+'.json'),run)
else:
 register=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='register_recipe_tools')
 getter=next(node for node in register.body if isinstance(node,ast.FunctionDef) and node.name=='recipe_run_get')
 getter.decorator_list=[]
 ns.update(store=Path(request['root']),environments_registry=None)
 exec(compile(ast.Module(body=[getter],type_ignores=[]),sys.argv[1],'exec'),ns)
 print(json.dumps([json.loads(ns['recipe_run_get'](**args)) for args in request['calls']],ensure_ascii=False))
`;
async function fixture(t) {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Original cold writer fixtures require the existing private Linux framework.");
  const base = resolve("tests", `.recipe-terminal-${randomUUID()}`), root = join(base, "root"),
    endpoint = join(homedir(), ".local/state/pkm-v5-recovery", `rt-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(root, ".pkm/state/recipe-runs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "notes"), { mode: 0o700 }); mkdirSync(endpoint, { mode: 0o700 });
  writeFileSync(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal terminal Recipe fixture.\n", { mode: 0o600 });
  writeFileSync(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const make = (name, status = "completed") => ({
    schema: "pkm.recipe.run/v1", runId: `recipe_run_${name}`, status, version: 7, recipeId: "recipe_original",
    recipeRevision: 3, executableDigest: "retained-original-digest", definition: { schema: "pkm.workflow.definition/v1", spec: {
      inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
        { nodeId: "optional", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      outputs: {}, completion: { requiredNodes: ["work"] },
    } },
    nodes: { optional: { state: "skipped", outcome: "not-selected" }, work: { state: status === "failed" ? "failed" : "succeeded",
      result: { text: "工作", unsafeReference: "file:///never-dereference-terminal-result" },
      error: status === "failed" ? "original failure" : "", completedAt: "2026-01-01T00:00:00Z" } },
    loops: { retained: { iteration: 2 } }, healthReceipt: { recorded: true },
    automation: { status }, terminalAt: "2026-01-01T00:00:00Z",
    usage: { measuredTokens: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }, estimatedTokens: 10, unknownModelCalls: 1,
      derivedCosts: { "😀": 1, "Ａ": 2, USD: 17 }, providers: ["provider"], models: ["model"],
      protocolPayloadEstimate: { estimatedTokens: 9 }, reportedAttempts: 2, records: [{ attempt: 1 }], recordsTruncated: 3 },
  });
  const completed = make("done"), failed = make("failed", "failed"), active = make("active", "running"),
    unfinalized = { ...make("unfinalized"), healthReceipt: null }, emptyHealth = { ...make("emptyhealth"), healthReceipt: {} },
    mismatch = make("mismatch"), external = make("external");
  active.nodes.work = { state: "running", background: { state: "running", resultPath: "/never-open-command-result" } };
  mismatch.runId = "recipe_run_wrong";
  external.nodes.work.background = { resultPath: "/never-open-completed-command-result" };
  const runs = [completed, failed, active, unfinalized, emptyHealth, external];
  execFileSync("python3", ["-I", "-B", "-c", oracle, runtime], { input: JSON.stringify({ root, write: true, runs }) });
  writeFileSync(join(root, ".pkm/state/recipe-runs/recipe_run_mismatch.json"), JSON.stringify(mismatch), { mode: 0o600 });
  const paths = [...runs.map(run => run.runId), "recipe_run_mismatch"].map(id => `.pkm/state/recipe-runs/${id}.json`);
  const before = paths.map(path => [path, readFileSync(join(root, path))]);
  const calls = ["recipe_run_done", "recipe_run_failed"].flatMap(run_id =>
    [{ run_id }, { run_id, detail: "compact" }, { run_id, detail: " FULL " }, { run_id, detail: "" }]);
  calls.push({ run_id: "recipe_run_done", detail: "verbose" }, { run_id: "../bad" });
  const expected = JSON.parse(execFileSync("python3", ["-I", "-B", "-c", oracle, runtime], {
    input: JSON.stringify({ root, calls }), encoding: "utf8" }));
  assert.equal(expected[0].ok, true, JSON.stringify(expected[0]));
  assert.equal(expected[4].ok, true, JSON.stringify(expected[4]));
  for (const [path, raw] of before) assert.deepEqual(readFileSync(join(root, path)), raw, "The original terminal getter must leave source bytes unchanged.");
  const profileSha256 = digest("synthetic-profile-finalized-recipe");
  const plan = await captureOriginalMcpCustody({ root, backup: join(base, "custody"), operatorId: "recipe-terminal-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 16, maxBytes: 1048576, maxFileBytes: 1048576 } });
  let opened, host, producer, server, socket, session;
  const controls = { allow: true, hold: false, badDigest: false }, frames = [];
  const close = async () => {
    producer?.dispose(); socket?.destroy(); await server?.close(); await host?.close(); await opened?.owner.close();
  };
  t.after(async () => { await close(); for (const [path, raw] of before) assert.deepEqual(readFileSync(join(root, path)), raw);
    rmSync(base, { recursive: true, force: true }); rmSync(endpoint, { recursive: true, force: true }); });
  async function reopen() {
    opened = await openOriginalMcpRoot(plan);
    // Explicit signer/UI doubles over the actual authenticated socket and actual RootOwner/Core.
    const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
      createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
    const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
      payloadBuildId: digest("terminal-fixture-payload"), hostEntrySha256: digest("terminal-fixture-host") };
    server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
      binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
    socket = connect(join(endpoint, "n"));
    let buffer = "", attachedResolve;
    const attached = new Promise(resolve => { attachedResolve = resolve; }), send = value => socket.write(JSON.stringify(value) + "\n");
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8"); let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (frame.type === "challenge") {
          const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
          send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
        } else if (frame.type === "attached") attachedResolve();
        else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
        else if (frame.type === "native-request") {
          frames.push(frame);
          if (frame.method === "recipe.source.approve") {
            if (!controls.hold) send(originalMcpNativeResult(frame, controls.allow ? { actorId: "mcp:external",
              decisionId: randomUUID(), expiresAtMs: Date.now() + 60000,
              requestSha256: controls.badDigest ? "0".repeat(64) : digest(frame.payload.request) } : null));
          } else send(originalMcpNativeResult(frame, { decision: "approve" }));
        }
      }
    });
    await attached; session = await server.waitForSession({ timeoutMs: 1000 });
    send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
      methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
    await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
    host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
    producer = await createOriginalMcpNativeRecipeSourcePolicy(opened.owner, host, session);
  }
  await reopen();
  const selection = runId => ({ runId, expectedSha256: sha(readFileSync(join(root, `.pkm/state/recipe-runs/${runId}.json`))), maxFileBytes: 1048576 });
  const read = (input, principal = actor, signal) => withOriginalMcpPublicRequest(opened.storage, host, {
    operation: "mcp.tool.recipe_run_get", version: 1, tool: "recipe_run_get", readOnly: true,
    arguments: input, argumentsDigest: digest(input),
  }, () => readOriginalMcpRecipeTerminal(opened.owner, host, principal, input, signal), signal);
  return { root, calls, expected, read, selection, close, reopen, controls, frames,
    get opened() { return opened; }, get host() { return host; }, get producer() { return producer; }, get session() { return session; } };
}
test("exact terminal run reads require fresh independent signed source consent, match the real original getter, and never autoplay/reconcile", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const usageSource = await planOriginalMcpRecipeUsage(f.opened.owner, f.host, { maxFiles: 100, maxFileBytes: 1048576, maxTotalBytes: 1048576 });
  await admitOriginalMcpRecipeUsage(f.opened.owner, f.host, usageSource, f.producer.policy);
  await assert.rejects(f.read({ run_id: "recipe_run_done" }), /separate selected-run source decision/);
  const source = await planOriginalMcpRecipeTerminal(f.opened.owner, f.host, f.selection("recipe_run_done"));
  await assert.rejects(admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, structuredClone(source), f.producer.policy), /same-owner/);
  await assert.rejects(admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, source, { ...f.producer.policy }), /POLICY_REQUIRED/);
  await admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, source, f.producer.policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor, originalMcpHost: f.host });
  try {
    const response = await backend.invoke("original_mcp_public", { tool: "recipe_run_get", arguments: f.calls[0] });
    assert.deepEqual(response.structuredContent, f.expected[0]);
  } finally { await backend.close(); }
  for (let i = 0; i < 4; i++) assert.deepEqual(await f.read(f.calls[i]), f.expected[i]);
  await assert.rejects(f.read({ run_id: "recipe_run_failed" }), /separate selected-run source decision/);
  const failed = await planOriginalMcpRecipeTerminal(f.opened.owner, f.host, f.selection("recipe_run_failed"));
  await admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, failed, f.producer.policy);
  await assert.rejects(f.read({ run_id: "recipe_run_done" }), /selected-run source decision|REVOKED/);
  for (let i = 4; i < 8; i++) assert.deepEqual(await f.read(f.calls[i]), f.expected[i]);
  await activateOriginalMcpRecipeTerminal(f.opened.owner, f.host, "recipe_run_done", f.producer.policy);
  for (let i = 8; i < f.calls.length; i++) assert.deepEqual(await f.read(f.calls[i]), f.expected[i]);
  await assert.rejects(f.read({ run_id: "recipe_run_done" }, { id: "another-actor", canWrite: false }), /actor-owned/);
  await assert.rejects(readOriginalMcpRecipeTerminal(f.opened.owner, f.host, actor, { run_id: "recipe_run_done" }), /public run inspection/);
  const db = f.opened.storage.connectNative();
  try { assert.throws(() => db.exec("UPDATE original_recipe_terminal_sources SET raw='{}'"), /immutable/); }
  finally { db.close(); }
  f.producer.revoke();
  await assert.rejects(f.read({ run_id: "recipe_run_done" }), /selected-run source decision|REVOKED/);
  await f.close(); await f.reopen();
  await assert.rejects(f.read({ run_id: "recipe_run_done" }), /selected-run source decision/);
  await activateOriginalMcpRecipeTerminal(f.opened.owner, f.host, "recipe_run_done", f.producer.policy);
  assert.deepEqual(await f.read({ run_id: "recipe_run_done" }), f.expected[0]);
  assert(f.frames.some(frame => frame.method === "recipe.source.approve"
    && frame.payload.request.schema === "pkm.original-recipe-terminal-source/v1"));
  await f.session.close();
  await assert.rejects(f.read({ run_id: "recipe_run_done" }), /unavailable or changed|REVOKED/);
});
test("terminal source refuses unsafe live/health/identity continuations and cancellation/denial cannot publish a source", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const id of ["active", "unfinalized", "emptyhealth", "mismatch", "external"])
    await assert.rejects(planOriginalMcpRecipeTerminal(f.opened.owner, f.host, f.selection(`recipe_run_${id}`)), /BLOCKED:/);
  await assert.rejects(planOriginalMcpRecipeTerminal(f.opened.owner, f.host,
    { ...f.selection("recipe_run_done"), expectedSha256: "0".repeat(64) }), /selected SHA-256/);
  const source = await planOriginalMcpRecipeTerminal(f.opened.owner, f.host, f.selection("recipe_run_done"));
  f.controls.allow = false;
  await assert.rejects(admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, source, f.producer.policy), /denied/);
  f.controls.allow = true; f.controls.hold = true;
  const control = new AbortController(), count = f.frames.length;
  const waiting = admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, source, f.producer.policy, control.signal);
  const refused = assert.rejects(waiting, /CANCELLED|abort/i);
  for (let i = 0; i < 100 && f.frames.length === count; i++) await new Promise(resolve => setTimeout(resolve, 5));
  control.abort(); await refused;
  let db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'original_recipe_terminal_%'").get().count, 0); }
  finally { db.close(); }
  f.controls.hold = false;
  await admitOriginalMcpRecipeTerminal(f.opened.owner, f.host, source, f.producer.policy);
  const path = join(f.root, ".pkm/state/recipe-runs/recipe_run_done.json"), raw = readFileSync(path);
  try { writeFileSync(path, raw.toString().replace("工作", "source-drift")); await assert.rejects(f.read({ run_id: source.runId }), /changed/); }
  finally { writeFileSync(path, raw); }
});
