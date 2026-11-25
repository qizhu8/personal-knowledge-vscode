import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createOriginalMcpActionCustodyFixture } from "./original-mcp-action-domain-fixture.mjs";
import { openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { declareOriginalMcpActionNativeFootprint, createOriginalMcpActionNativePolicy, admitOriginalMcpActionDomain } from "../dist/original-mcp-action-domain.js";
import { createOriginalMcpActionRuntime } from "../dist/original-mcp-action-runtime.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { originalActionProgramRequest } from "../dist/original-mcp-action-program-contracts.js";

const actor = { id: "mcp:external", canWrite: true }, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const oracle = JSON.parse(await readFile(new URL("./fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"));
const code = `let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s).value;
if(v.startsWith("wait-"))await new Promise(r=>setTimeout(r,30000));
console.log(JSON.stringify({value:v==="env"?"env:"+Object.keys(process.env).sort().join(","):v+"-old-output"}))`;
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await check(); if (value) return value; await pause(10); }
  throw new Error("Canonical local Action process did not settle.");
}
// Only the native RPC operator decision is a labelled fixture. Runs, ProcessJobs,
// executable bytes, actual child effects, cancellation and ownership are production paths.
async function fixture(t) {
  const f = await createOriginalMcpActionCustodyFixture(t, { programCode: code });
  let allowed = true, trusted = true, host, policy, endpoint, decisionHook;
  const approvals = [], lifetime = new AbortController();
  const start = async () => {
    const opened = await openOriginalMcpRoot(f.plan, { prepareNative: async storage => {
      await declareOriginalMcpActionNativeFootprint(storage, f.custody);
      const epoch = randomUUID(), token = randomBytes(32).toString("hex"), sockets = new Set();
      const server = createServer(socket => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
        let text = ""; socket.setEncoding("utf8");
        socket.on("data", chunk => {
          text += chunk; if (!text.includes("\n")) return;
          socket.removeAllListeners("data");
          void (async () => {
            const input = JSON.parse(text.slice(0, text.indexOf("\n")));
            assert.equal(input.storePath, f.root); assert.equal(input.token, token);
            const base = { ok: trusted, trusted, trustEpoch: epoch };
            if (input.operation === "source_admission") {
              const request = input.sourceAdmission;
              socket.end(JSON.stringify({ ...base, sourceDecision: {
                schema: "pkm.native-action-source-decision/v1", scope: "original-action-source-state/v1",
                root: f.root, workspaceId: request.workspaceId, actorId: actor.id, profileSha256: f.plan.profileSha256,
                epoch, capsuleSha256: f.custody.capsuleSha256, requestSha256: request.requestSha256,
                decisionId: randomUUID(), expiresAtMs: Date.now() + 300000, noExecution: true,
              } }) + "\n");
            } else if (input.operation === "program_consent") {
              const request = originalActionProgramRequest.parse(input.programAdmission);
              assert.equal(request.capsuleSha256, f.custody.capsuleSha256);
              assert.equal(request.executable.sha256, f.custody.toolchains[0].sha256);
              assert.equal(request.inputSha256, originalDigest(request.request.inputs));
              assert.deepEqual(request.effects, ["pure"]);
              approvals.push(request); await decisionHook?.(request);
              socket.end(JSON.stringify({ ...base, ok: allowed && trusted, ...(allowed && trusted ? { programDecision: {
                schema: "pkm.original-mcp-local-program-decision/v1", scope: "exact-local-direct-child/v1",
                root: request.root, workspaceId: request.workspaceId, actorId: actor.id, profileSha256: request.profileSha256,
                epoch, capsuleSha256: request.capsuleSha256, runId: request.runId, requestSha256: originalDigest(request),
                executableSha256: request.executable.sha256, decisionId: randomUUID(),
                expiresAtMs: Math.min(request.deadline, Date.now() + 300000), automaticReplay: false,
              } } : {}) }) + "\n");
            } else socket.end(JSON.stringify(base) + "\n");
          })().catch(error => socket.destroy(error));
        });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      endpoint = server.address();
      await mkdir(join(f.root, ".pkm-action-authority"), { recursive: true, mode: 0o700 });
      await writeFile(join(f.root, ".pkm-action-authority/host-authority.json"), JSON.stringify({
        schema: "pkm.action.host-authority/v1", host: "127.0.0.1", port: endpoint.port, token, trust_epoch: epoch, store_path: f.root,
      }), { mode: 0o600 });
      let closing;
      const close = () => closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      })();
      storage.retainNativeCleanup({ release: close });
      host = await createOriginalMcpNativeHost(storage, {
        profileSha256: f.plan.profileSha256, sourceCatalogSha256: oracle.metadataSha256,
        authorityId: "isolated-local-program-native-rpc-fixture", epoch, signal: lifetime.signal,
        assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
        models: { configuration: {}, registryAvailability: {}, async credentialAvailable() { return false; },
          async authorizeRequest() { return false; }, transport: { supports: () => false,
            async open() { throw new Error("No model, Cosmos, credential or remote dispatch is authorized."); } } },
      });
      policy = await createOriginalMcpActionNativePolicy(storage, host, f.custody, {
        localPrograms: [{ actionId: f.old.echo.action_id, cwd: "action-sources" }],
      });
      return policy.options;
    } });
    f.cleanup.push(() => opened.owner.close());
    const full = await opened.owner.ensureFull(), adapter = await createOriginalMcpActionRuntime(opened.owner, actor, host);
    f.cleanup.push(() => adapter.close());
    await admitOriginalMcpActionDomain(opened.owner, actor, host, policy);
    const call = async (tool, args = {}) => (await adapter.invoke(tool, args)).structuredContent;
    const invoke = (value, key = value) => call("action_call", { action_id: f.old.echo.action_id, content_hash: f.old.echo.content_hash,
      inputs: { value }, idempotency_key: key });
    const jobs = () => {
      const db = opened.storage.connectNative();
      try { return db.prepare("SELECT record_json FROM runtime_process_jobs ORDER BY job_id").all().map(row => JSON.parse(row.record_json)); }
      finally { db.close(); }
    };
    return { ...opened, full, adapter, call, invoke, jobs, host, policy };
  };
  return { ...f, start, approvals, setAllowed(value) { allowed = value; }, setTrusted(value) { trusted = value; },
    setDecisionHook(value) { decisionHook = value; } };
}
async function view(running, id, state) {
  return until(async () => { const run = await running.call("action_run_get", { run_id: id }); return run.state === state && run; });
}

test("admitted original local program executes one actual canonical ProcessJob with exact consent, empty environment and idempotent native output", async t => {
  const f = await fixture(t), running = await f.start(), lease = { ...running.owner.workspaceLease() };
  const original = await readFile(join(f.root, "actions/fixture.domain.echo.json"));
  const created = await running.invoke("actual", "one real program");
  assert.deepEqual((await view(running, created.run_id, "succeeded")).output, { value: "actual-old-output" });
  const reused = await running.invoke("actual", "one real program");
  assert.equal(reused.run_id, created.run_id); assert.equal(reused.launch_reused, true);
  assert.equal(f.approvals.length, 1);
  const jobs = await until(() => running.jobs().length === 1 && running.jobs()[0].state === "SUCCEEDED" && running.jobs());
  assert.equal(jobs[0].actorId, actor.id); assert.equal(jobs[0].effect, "completed");
  assert.equal(jobs[0].stdout, ""); assert.equal(jobs[0].stderr, "");
  const db = running.storage.connectNative();
  try {
    const receipt = JSON.parse(db.prepare("SELECT payload FROM original_mcp_action_invocations WHERE run_id=?").get(created.run_id).payload);
    assert.deepEqual(receipt.localProgram.request, f.approvals[0]);
    assert.equal(receipt.localProgram.decision.requestSha256, originalDigest(receipt.localProgram.request));
    assert.equal(receipt.localProgram.decision.executableSha256, f.custody.toolchains[0].sha256);
  } finally { db.close(); }
  const env = await running.invoke("env");
  assert.deepEqual((await view(running, env.run_id, "succeeded")).output, { value: "env:" });
  assert.equal(running.jobs().length, 2);
  const request = f.approvals[0];
  assert.equal(request.cwd.path, join(f.root, "action-sources"));
  assert.equal(request.executable.sha256, f.custody.toolchains[0].sha256);
  assert.deepEqual(request.arguments, ["-e", code]);
  assert.equal(request.authority.inheritedEnvironment, false);
  assert.deepEqual(await readFile(join(f.root, "actions/fixture.domain.echo.json")), original);
  assert.deepEqual(running.owner.workspaceLease(), lease);
});

test("separate native process consent denial or source mutation before acceptance publishes no Run or ProcessJob", async t => {
  const f = await fixture(t), running = await f.start();
  f.setAllowed(false);
  await assert.rejects(running.invoke("denied"), /ACTION_LOCAL_PROGRAM_CONSENT_REQUIRED/);
  assert.deepEqual(running.jobs(), []);
  f.setAllowed(true); f.setDecisionHook(request => { request.executable.sha256 = "0".repeat(64); });
  await assert.rejects(running.invoke("wrong toolchain decision"), /NATIVE_ACTION_PROGRAM_BINDING_MISMATCH/);
  assert.deepEqual(running.jobs(), []);
  f.setDecisionHook(() => writeFile(join(f.root, "action-sources/proof.txt"), "changed after native review", { mode: 0o600 }));
  await assert.rejects(running.invoke("changed"), /changed|CHANGED|RECOVERY_CONFLICT/i);
  assert.deepEqual(running.jobs(), []);
  const db = running.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 3); }
  finally { db.close(); }
});

test("started local program cancellation and native revocation stop only owned children and retain uncertain receipts without retry", async t => {
  const f = await fixture(t), running = await f.start();
  const first = await running.invoke("wait-cancel");
  await until(() => running.jobs().some(job => job.state === "RUNNING"));
  await running.call("action_run_cancel", { run_id: first.run_id });
  await view(running, first.run_id, "outcome_unknown");
  await until(() => running.jobs()[0].state === "CANCELLED");
  assert.equal(running.jobs()[0].effect, "unknown");
  assert.equal((await running.invoke("wait-cancel")).run_id, first.run_id);
  assert.equal(running.jobs().length, 1);
  const second = await running.invoke("wait-revoke");
  await until(() => running.jobs().filter(job => job.state === "RUNNING").length === 1);
  const database = running.storage.connectNative();
  let snapshot;
  try { snapshot = JSON.parse(database.prepare("SELECT snapshot FROM action_runtime_runs WHERE run_id=?").get(second.run_id).snapshot); }
  finally { database.close(); }
  const unapproved = await running.full.runtime.core.dispatch("capability_call", { operation: "action.runtime.create", version: 1,
    arguments: { operationId: randomUUID(), runId: `action_run_${randomUUID().replaceAll("-", "")}`, source: snapshot.sourceSnapshot,
      expectedDefinitionDigest: f.old.echo.content_hash, deadline: Date.now() + 30000, inputs: snapshot.inputs } }, actor);
  assert.equal(unapproved.error?.code, "FORBIDDEN", "An active approved program Run cannot lend authority to another Core create.");
  f.setTrusted(false);
  await until(() => running.jobs().every(job => job.state === "CANCELLED"));
  await assert.rejects(running.invoke("must-not-start"), /NATIVE_TRUST_REQUIRED|SOURCE_ADMISSION_REQUIRED/);
  assert.equal(running.jobs().length, 2);
  await until(() => {
    const db = running.storage.connectNative();
    try { return JSON.parse(db.prepare("SELECT snapshot FROM action_runtime_runs WHERE run_id=?").get(second.run_id).snapshot).state === "unknown"; }
    finally { db.close(); }
  });
});

test("real owner restart preserves program output/uncertainty without restoring native process grants or replaying children", async t => {
  const f = await fixture(t), first = await f.start();
  const done = await first.invoke("persisted"), waiting = await view(first, done.run_id, "succeeded");
  assert.deepEqual(waiting.output, { value: "persisted-old-output" });
  const started = await first.invoke("wait-owner-close");
  await until(() => first.jobs().some(job => job.state === "RUNNING"));
  await first.adapter.close(); await first.owner.close();
  const second = await f.start();
  const prior = await second.invoke("persisted"), uncertain = await second.invoke("wait-owner-close");
  assert.equal(prior.run_id, done.run_id); assert.equal(prior.launch_reused, true);
  assert.deepEqual(prior.output, { value: "persisted-old-output" });
  assert.equal(uncertain.run_id, started.run_id); assert.equal(uncertain.state, "outcome_unknown");
  assert.equal(f.approvals.length, 2);
  assert.equal(second.jobs().length, 2);
  assert(second.jobs().every(job => !["RUNNING", "QUEUED"].includes(job.state)));
  assert.deepEqual(await readFile(join(f.root, ".pkm/state/actions/settings.json")), f.oldSettings);
});
