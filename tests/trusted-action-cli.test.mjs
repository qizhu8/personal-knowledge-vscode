import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AutomaticActionTrustAuthority } from "../legacy/src/runtime/action-trust-authority.ts";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { until } from "./batch07-cli-fixtures.mjs";

const build = resolve(process.env.PKM_ACTION_BUILD ?? resolve(import.meta.dirname, "../dist"));
const { initialize } = await import(`${build}/storage.js`);
const { ActionRuntime } = await import(`${build}/action-runtime.js`);
const { builtinActionDefinitions } = await import(`${build}/domain/action-compiler-validation.js`);

test("production CLI starts trusted program Actions without a command allowlist and drains on revoke", { timeout: 30000 }, async t => {
  const root = resolve(import.meta.dirname, `.trusted-action-cli-${randomUUID()}`);
  const backup = `${root}-backup`;
  await initialize(root);
  let authority, client, releaseConsent;
  t.after(async () => {
    releaseConsent?.();
    try { await client?.close(); } finally {
      try { await authority?.dispose(); } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(backup, { recursive: true, force: true });
      }
    }
  });
  chmodSync(root, 0o700);
  let allowed = true, consentCalls = 0, approvalError, waitForConsent = false, waitingForConsent = 0;
  let pipelineComponents = ["core.constant", "core.math-expression"], pipelineSteps = 3;
  const consentReleases = [];
  releaseConsent = () => { for (const release of consentReleases.splice(0)) release(); };
  const createAuthority = () => new AutomaticActionTrustAuthority({
    storePath: () => root, nativeEndpoint: true, isTrusted: () => true, enabled: () => true,
    prepare: async () => { throw new Error("Function check must not run"); },
    authorizeEffects: async (_id, _hash, context) => {
      consentCalls++;
      if (context.kind === "pipeline") {
        assert.deepEqual(context.components, pipelineComponents);
        assert.equal(context.stepCount, pipelineSteps);
      } else assert.equal(context.program, process.execPath);
      assert.match(context.inputDigest, /^[a-f0-9]{64}$/);
      if (approvalError) throw approvalError;
      if (waitForConsent) {
        waitingForConsent++;
        await new Promise(resolve => { consentReleases.push(resolve); });
      }
      return allowed;
    },
  });
  authority = createAuthority();
  await authority.start();
  const start = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(build, "cli.js"), "mcp", "--data", root, "--experimental-legacy-mcp", "--experimental-trusted-actions"],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    client = new Client({ name: "production-action-cli-test", version: "1.0.0" });
    try { await client.connect(transport); } catch (error) { throw new Error(`CLI startup failed: ${stderr}`, { cause: error }); }
  };
  await start();
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === "action_call"));
  const trustStatus = await client.callTool({ name: "action_trust_status", arguments: {} });
  assert.equal(trustStatus.structuredContent.value.actorId, "mcp:external");
  assert.equal(trustStatus.structuredContent.value.trustedWorkspace, true);
  const definition = { dependencies: {}, casts: {}, ...structuredClone(original.example) };
  definition.implementations[0].program = process.execPath;
  definition.implementations[0].args = ["-e", "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({value:JSON.parse(s).value+'-result'}))"];
  const submit = value => client.callTool({ name: "legacy_action_write", arguments: {
    tool: "action_register", arguments: { definition: value },
  } });
  const proposalResult = await submit(definition);
  assert.notEqual(proposalResult.isError, true, JSON.stringify(proposalResult));
  const proposal = proposalResult.structuredContent.value;
  assert.equal(proposal.state, "automatically_admitted");
  assert.equal(proposal.callable, true);
  const call = (key, inputs = { value: "hello" }) => client.callTool({ name: "action_call", arguments: {
    action_id: proposal.action_id, content_hash: proposal.content_hash, idempotency_key: key, inputs,
  } });
  const invocation = await call("first");
  assert.notEqual(invocation.isError, true, JSON.stringify(invocation));
  const runId = invocation.structuredContent.value.runId;
  const readRun = async id => {
    const result = await client.callTool({ name: "legacy_action_read", arguments: {
      tool: "action_run_get", arguments: { run_id: id },
    } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent.value;
  };
  const successful = await until(() => readRun(runId), run => run.state === "succeeded");
  assert.deepEqual(successful.output, { value: "hello-result" });
  assert.equal(Object.hasOwn(successful, "inputs"), false);
  assert.equal(Object.hasOwn(successful, "stdout"), false);
  assert.equal(Object.hasOwn(successful, "environment"), false);
  await client.close();
  client = undefined;
  await authority.dispose();
  authority = createAuthority();
  await authority.start();
  await start();
  assert.deepEqual((await readRun(runId)).output, { value: "hello-result" },
    "Owned output survives a clean CLI and authority restart with a new trust epoch.");
  const dbForCorruption = new DatabaseSync(resolve(root, "core.sqlite"));
  const originalSnapshot = dbForCorruption.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
    .get("mcp:external", runId).snapshot;
  const replaceSnapshot = snapshot => dbForCorruption.prepare("UPDATE action_runtime_runs SET snapshot=? WHERE actor_id=? AND run_id=?")
    .run(snapshot, "mcp:external", runId);
  try {
    for (const corrupt of [
      snapshot => { delete snapshot.nodes[0].outputs; },
      snapshot => {
        snapshot.nodes[0].outputs = { value: 42 };
        snapshot.definition.output_schema = { type: "object" };
      },
      snapshot => { snapshot.nodes[0].outputs = { value: "x".repeat(70000) }; },
    ]) {
      const snapshot = JSON.parse(originalSnapshot);
      corrupt(snapshot);
      replaceSnapshot(JSON.stringify(snapshot));
      const response = await client.callTool({ name: "legacy_action_read", arguments: {
        tool: "action_run_get", arguments: { run_id: runId },
      } });
      assert.equal(response.isError, true, "Missing, invalid or oversized stored results fail closed.");
      assert.equal(Object.hasOwn(response.structuredContent?.value ?? {}, "output"), false);
    }
  } finally {
    replaceSnapshot(originalSnapshot);
    dbForCorruption.close();
  }
  assert.deepEqual((await readRun(runId)).output, { value: "hello-result" });
  assert.notEqual((await submit(definition)).isError, true, "Re-admit the revision before new calls.");
  assert.equal(consentCalls, 1);
  const counts = () => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return ["native_action_automatic_calls", "action_runtime_runs", "action_runtime_receipts", "runtime_process_jobs"]
      .map(table => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n)); }
    finally { db.close(); }
  };
  const beforeDenials = counts();
  assert.equal((await call("bad-input", { value: 42 })).isError, true);
  assert.equal(consentCalls, 1);
  allowed = false;
  const denied = await call("denied");
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /ACTION_EFFECT_CONSENT_REQUIRED/);
  assert.equal(consentCalls, 2);
  assert.deepEqual(counts(), beforeDenials);
  allowed = true;
  approvalError = new Error("consent-service-unavailable");
  const unavailable = await call("unavailable");
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable), /consent-service-unavailable/);
  assert.deepEqual(counts(), beforeDenials);
  approvalError = undefined;
  const missing = structuredClone(definition);
  missing.action_id = "example.missing.program";
  missing.implementations[0].program = "pkm-missing-runtime-fixture";
  const missingResult = await submit(missing);
  assert.equal(missingResult.isError, true);
  assert.match(JSON.stringify(missingResult), /program is unavailable/i);
  assert.deepEqual(counts(), beforeDenials);
  const unsupported = structuredClone(definition);
  unsupported.action_id = "example.unsupported.protocol";
  unsupported.implementations[0].build = { program: process.execPath, args: [], source_files: ["source"], outputs: ["output"] };
  const unsupportedResult = await submit(unsupported);
  assert.equal(unsupportedResult.isError, true);
  assert.match(JSON.stringify(unsupportedResult), /private .pkm-action-sources directory/i);
  assert.deepEqual(counts(), beforeDenials);
  const numeric = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false };
  const pipeline = {
    schema: "pkm.action.definition/v1", action_id: "example.unsupported.pipeline", version: 1,
    description: "An unsupported pipeline.", input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: numeric, effects: ["pure"],
    implementations: [{ kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
      steps: [{ id: "constant", component: "core.constant", inputs: { value: 1 }, output_schema: numeric }],
      output: { value: { $step: "constant.value" } } }],
  };
  const pipelineResult = await submit(pipeline);
  assert.equal(pipelineResult.isError, true);
  assert.match(JSON.stringify(pipelineResult), /explicit JavaScript core.constant, core.math-expression, core.cast and core.lookup/i);
  assert.deepEqual(counts(), beforeDenials);
  const purePipeline = structuredClone(pipeline);
  purePipeline.action_id = "example.pure.calculation";
  purePipeline.input_schema = { type: "object", properties: { left: { type: "number" }, right: { type: "number" } },
    required: ["left", "right"], additionalProperties: false };
  purePipeline.implementations[0].steps = [
    { id: "left", component: "core.constant", implementation: "javascript",
      inputs: { value: { $input: "left" } }, output_schema: numeric },
    { id: "right", component: "core.constant", implementation: "javascript",
      inputs: { value: { $input: "right" } }, output_schema: numeric },
    { id: "math", component: "core.math-expression", implementation: "javascript",
      inputs: { expression: "{0} x {1} + {2} * log {3}", input_0: { $step: "left.value" },
        input_1: { $step: "right.value" }, input_2: 4, input_3: Math.E }, output_schema: numeric },
  ];
  purePipeline.implementations[0].output = { value: { $step: "math.value" } };
  const pureResult = await submit(purePipeline);
  assert.notEqual(pureResult.isError, true, JSON.stringify(pureResult));
  assert.equal(pureResult.structuredContent.value.callable, true);
  const invokePipeline = (registered, idempotencyKey, inputs = { left: 2, right: 3 }) => client.callTool({ name: "action_call", arguments: {
    action_id: registered.action_id, content_hash: registered.content_hash,
    idempotency_key: idempotencyKey, inputs,
  } });
  const beforePureDenied = counts();
  allowed = false;
  assert.equal((await invokePipeline(pureResult.structuredContent.value, "pure-denied")).isError, true);
  allowed = true;
  assert.deepEqual(counts(), beforePureDenied, "Pure pipeline denial publishes no run, receipt or job.");
  const pureCall = await invokePipeline(pureResult.structuredContent.value, "pure-success");
  assert.notEqual(pureCall.isError, true, JSON.stringify(pureCall));
  const pureRunId = pureCall.structuredContent.value.runId;
  const pureRun = await until(() => readRun(pureRunId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.equal(pureRun.state, "succeeded", JSON.stringify(pureRun));
  assert.deepEqual(pureRun.output, { value: 10 });
  assert.equal(Object.hasOwn(pureRun, "inputs"), false);
  const foreignDatabase = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
  const foreignRuntime = new ActionRuntime(foreignDatabase, {
    workspaceRoot: root, adapters: {}, initialized: true, deferRecovery: true,
  });
  try {
    assert.throws(() => foreignRuntime.getOwnedResult("mcp:other", pureRunId, purePipeline),
      error => error.code === "NOT_FOUND");
  } finally { await foreignRuntime.close(); foreignDatabase.close(); }
  await client.close();
  client = undefined;
  await start();
  assert.deepEqual((await readRun(pureRunId)).output, { value: 10 }, "Owned pipeline result survives restart.");
  const brokenPipeline = structuredClone(purePipeline);
  brokenPipeline.action_id = "example.pure.invalid-math";
  brokenPipeline.implementations[0].steps[2].inputs.expression = "{0} / 0";
  const brokenRegistered = await submit(brokenPipeline);
  assert.notEqual(brokenRegistered.isError, true, JSON.stringify(brokenRegistered));
  const brokenCall = await invokePipeline(brokenRegistered.structuredContent.value, "pure-invalid-math");
  assert.notEqual(brokenCall.isError, true, JSON.stringify(brokenCall));
  const brokenRun = await until(() => readRun(brokenCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.notEqual(brokenRun.state, "succeeded");
  assert.equal(Object.hasOwn(brokenRun, "output"), false);
  const invalidOutput = structuredClone(purePipeline);
  invalidOutput.action_id = "example.pure.invalid-output";
  invalidOutput.implementations[0].output = { value: "not-a-number" };
  const invalidOutputRegistered = await submit(invalidOutput);
  assert.notEqual(invalidOutputRegistered.isError, true, JSON.stringify(invalidOutputRegistered));
  const invalidOutputCall = await invokePipeline(invalidOutputRegistered.structuredContent.value, "pure-invalid-output");
  assert.notEqual(invalidOutputCall.isError, true, JSON.stringify(invalidOutputCall));
  const invalidOutputRun = await until(() => readRun(invalidOutputCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.notEqual(invalidOutputRun.state, "succeeded");
  assert.equal(Object.hasOwn(invalidOutputRun, "output"), false);
  const castLookup = structuredClone(purePipeline);
  castLookup.action_id = "example.pure.lookup-cast";
  castLookup.input_schema = { type: "object", properties: { dictionary: { type: "object" }, key: { type: "string" } },
    required: ["dictionary", "key"], additionalProperties: false };
  castLookup.implementations[0].steps = [
    { id: "lookup", component: "core.lookup", implementation: "javascript",
      inputs: { dictionary: { $input: "dictionary" }, key: { $input: "key" } },
      output_schema: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false } },
    { id: "cast", component: "core.cast", implementation: "javascript",
      inputs: { value: { $step: "lookup.value" }, target_type: "integer", trim: true }, output_schema: numeric },
  ];
  castLookup.implementations[0].output = { value: { $step: "cast.value" } };
  const castRegistered = await submit(castLookup);
  assert.notEqual(castRegistered.isError, true, JSON.stringify(castRegistered));
  pipelineComponents = ["core.lookup", "core.cast"]; pipelineSteps = 2;
  const callCast = async (id, inputs) => {
    const called = await invokePipeline(castRegistered.structuredContent.value, id, inputs);
    assert.notEqual(called.isError, true, JSON.stringify(called));
    return until(() => readRun(called.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  };
  const castRun = await callCast("cast-lookup", { dictionary: { amount: " 42 " }, key: "amount" });
  assert.equal(castRun.state, "succeeded", JSON.stringify(castRun));
  assert.deepEqual(castRun.output, { value: 42 });
  assert.equal((await callCast("lookup-missing", { dictionary: {}, key: "missing" })).state, "failed");
  assert.equal((await callCast("cast-invalid", { dictionary: { amount: "1.5" }, key: "amount" })).state, "failed");
  const unsafeCast = await callCast("cast-unsafe", { dictionary: { amount: "9007199254740992" }, key: "amount" });
  assert.equal(unsafeCast.state, "failed");
  assert.equal(unsafeCast.nodes.find(node => node.node_id === "cast").reason, "ACTION_COMPONENT_UNSUPPORTED");
  const unsafeLookup = await callCast("lookup-unsafe", { dictionary: { amount: 9007199254740992 }, key: "amount" });
  assert.equal(unsafeLookup.state, "failed");
  assert.equal(unsafeLookup.nodes.find(node => node.node_id === "lookup").reason, "ACTION_COMPONENT_UNSUPPORTED");
  assert.equal((await invokePipeline(castRegistered.structuredContent.value, "lookup-bad-schema",
    { dictionary: 3, key: "amount" })).isError, true);
  const fallback = structuredClone(castLookup);
  fallback.action_id = "example.pure.lookup-default";
  fallback.implementations[0].steps[0].inputs.default = "7";
  const fallbackRegistered = await submit(fallback);
  assert.notEqual(fallbackRegistered.isError, true, JSON.stringify(fallbackRegistered));
  const fallbackCall = await invokePipeline(fallbackRegistered.structuredContent.value, "lookup-default",
    { dictionary: {}, key: "missing" });
  assert.notEqual(fallbackCall.isError, true, JSON.stringify(fallbackCall));
  const fallbackRun = await until(() => readRun(fallbackCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.deepEqual(fallbackRun.output, { value: 7 });

  const provenance = structuredClone(castLookup);
  provenance.action_id = "example.pure.ambiguous-number-string";
  provenance.output_schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
  provenance.implementations[0].steps[1].inputs.target_type = "string";
  provenance.implementations[0].steps[1].output_schema = provenance.output_schema;
  const provenanceRegistered = await submit(provenance);
  assert.notEqual(provenanceRegistered.isError, true, JSON.stringify(provenanceRegistered));
  const provenanceCall = await invokePipeline(provenanceRegistered.structuredContent.value, "cast-ambiguous",
    { dictionary: { n: 1 }, key: "n" });
  const provenanceRun = await until(() => readRun(provenanceCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.equal(provenanceRun.state, "failed");
  assert.equal(provenanceRun.nodes.find(node => node.node_id === "cast").reason, "ACTION_COMPONENT_UNSUPPORTED");
  const nestedCall = await invokePipeline(provenanceRegistered.structuredContent.value, "cast-ambiguous-structure",
    { dictionary: { n: [1] }, key: "n" });
  const nestedRun = await until(() => readRun(nestedCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.equal(nestedRun.state, "failed");
  assert.equal(nestedRun.nodes.find(node => node.node_id === "cast").reason, "ACTION_COMPONENT_UNSUPPORTED");
  pipelineComponents = ["core.constant", "core.math-expression"]; pipelineSteps = 3;

  const beforeBuiltinConsent = consentCalls;
  let builtinRunId, builtinRegistration;
  for (const [id, vectors] of [
    ["core.cast.string-to-float", [[{ value: "3.25" }, 3.25], [{ value: " 1.5e2 ", trim: true }, 150]]],
  ]) {
    const canonical = builtinActionDefinitions().get(id);
    const authored = Object.fromEntries(Object.entries(canonical).filter(([key]) =>
      !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
    const overridden = { ...structuredClone(authored), description: "Not the canonical builtin" };
    assert.equal((await submit(overridden)).isError, true, "Reserved builtins cannot be overridden.");
    assert.equal((await submit({ ...authored, action_id: "core.cast.not-packaged" })).isError, true,
      "Other reserved builtin definitions are not admitted.");
    assert.equal((await submit({ ...authored, content_hash: canonical.content_hash })).isError, true,
      "Caller-supplied identity is not registration authority.");
    const registered = await submit(authored);
    assert.notEqual(registered.isError, true, JSON.stringify(registered));
    assert.equal(registered.structuredContent.value.callable, true);
    builtinRegistration = registered.structuredContent.value;
    assert.equal((await invokePipeline({ ...registered.structuredContent.value, content_hash: "0".repeat(64) },
      `${id}-wrong-hash`, vectors[0][0])).isError, true);
    assert.equal((await invokePipeline(registered.structuredContent.value, `${id}-bad-type`, { value: 42 })).isError, true);
    for (const [index, [inputs, expected]] of vectors.entries()) {
      const called = await invokePipeline(registered.structuredContent.value, `${id}-${index}`, inputs);
      assert.notEqual(called.isError, true, JSON.stringify(called));
      builtinRunId = called.structuredContent.value.runId;
      const result = await until(() => readRun(builtinRunId),
        value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
      assert.equal(result.state, "succeeded", JSON.stringify(result));
      assert.deepEqual(result.output, { value: expected });
    }
    for (const [label, inputs, reason] of [
      ["bad", { value: " 1.5 " }], ["negative-zero", { value: "-0.0" }, "ACTION_COMPONENT_UNSUPPORTED"],
      ["unicode-trim", { value: "\ufeff1", trim: true }, "ACTION_COMPONENT_UNSUPPORTED"],
      ["underflow", { value: "1e-999" }], ["overflow", { value: "1e999" }],
    ]) {
      const called = await invokePipeline(registered.structuredContent.value, `${id}-${label}`, inputs);
      assert.notEqual(called.isError, true, JSON.stringify(called));
      const result = await until(() => readRun(called.structuredContent.value.runId),
        value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
      assert.equal(result.state, "failed", JSON.stringify(result));
      assert.equal(Object.hasOwn(result, "output"), false);
      if (reason) assert.equal(result.nodes[0].reason, reason);
    }
    const integerBuiltin = builtinActionDefinitions().get("core.cast.string-to-integer");
    assert.equal((await submit(Object.fromEntries(Object.entries(integerBuiltin).filter(([key]) =>
      !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key))))).isError, true,
    "An unsafe-integer builtin schema cannot be admitted after JSON number precision is lost.");
  }
  assert.equal(consentCalls, beforeBuiltinConsent, "Pure builtins do not invent process consent.");
  const builtinDb = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
  const otherActorRuntime = new ActionRuntime(builtinDb, { workspaceRoot: root, adapters: {}, initialized: true, deferRecovery: true });
  try { assert.throws(() => otherActorRuntime.getOwnedResult("mcp:other", builtinRunId, {}),
    error => error.code === "NOT_FOUND"); }
  finally { await otherActorRuntime.close(); builtinDb.close(); }
  const pinnedDb = new DatabaseSync(resolve(root, "core.sqlite"));
  const builtinSnapshot = pinnedDb.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
    .get("mcp:external", builtinRunId).snapshot;
  try {
    const altered = JSON.parse(builtinSnapshot);
    altered.adapters.action.authorizationDigest = "0".repeat(64);
    pinnedDb.prepare("UPDATE action_runtime_runs SET snapshot=? WHERE actor_id=? AND run_id=?")
      .run(JSON.stringify(altered), "mcp:external", builtinRunId);
    const result = await client.callTool({ name: "legacy_action_read", arguments: {
      tool: "action_run_get", arguments: { run_id: builtinRunId },
    } });
    assert.equal(result.isError, true, "Owned output requires the exact canonical builtin adapter pin.");
  } finally {
    pinnedDb.prepare("UPDATE action_runtime_runs SET snapshot=? WHERE actor_id=? AND run_id=?")
      .run(builtinSnapshot, "mcp:external", builtinRunId);
    pinnedDb.close();
  }
  await client.close();
  client = undefined;
  await start();
  assert.deepEqual((await readRun(builtinRunId)).output, { value: 150 },
    "Canonical builtin owned output survives a CLI restart.");
  for (const [label, expression, vectors] of [
    ["whole", "round({0})", [[2.5, 2], [-1.5, -2], [-2.5, -2]]],
    ["fractional", "round({0}, 2)", [[2.675, 2.68], [-2.675, -2.68], [1.234, 1.23]]],
    ["tens", "round({0}, -1)", [[125, 120], [-125, -120], [135, 140]]],
    ["literal", "round(-2.675, 2)", [[0, -2.68]]],
  ]) {
    const round = structuredClone(purePipeline);
    round.action_id = `example.pure.round-${label}`;
    round.implementations[0].steps[2].inputs = { expression, input_0: { $step: "left.value" } };
    const registered = await submit(round);
    assert.notEqual(registered.isError, true, JSON.stringify(registered));
    for (const [input, expected] of vectors) {
      const called = await invokePipeline(registered.structuredContent.value, `round-${label}-${input}`, { left: input, right: 0 });
      assert.notEqual(called.isError, true, JSON.stringify(called));
      const result = await until(() => readRun(called.structuredContent.value.runId),
        value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
      assert.equal(result.state, "succeeded", JSON.stringify(result));
      assert.deepEqual(result.output, { value: expected }, `${expression}: ${input}`);
    }
  }
  const dynamicRound = structuredClone(purePipeline);
  dynamicRound.action_id = "example.pure.dynamic-round";
  dynamicRound.input_schema.properties.expression = { type: "string" };
  dynamicRound.input_schema.required.push("expression");
  dynamicRound.implementations[0].steps[2].inputs = {
    expression: { $input: "expression" }, input_0: { $step: "left.value" }, input_1: { $step: "right.value" },
  };
  const dynamicRegistered = await submit(dynamicRound);
  assert.notEqual(dynamicRegistered.isError, true, JSON.stringify(dynamicRegistered));
  const dynamicCall = await invokePipeline(dynamicRegistered.structuredContent.value, "round-dynamic-precision",
    { left: 2.675, right: 2, expression: "round({0}, {1})" });
  assert.notEqual(dynamicCall.isError, true, JSON.stringify(dynamicCall));
  const dynamicRun = await until(() => readRun(dynamicCall.structuredContent.value.runId),
    value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
  assert.equal(dynamicRun.state, "failed");
  assert.equal(dynamicRun.nodes.find(node => node.node_id === "math").reason, "ACTION_COMPONENT_UNSUPPORTED");
  assert.equal(Object.hasOwn(dynamicRun, "output"), false);
  for (const [name, mutate] of [
    ["cycle", value => { value.implementations[0].steps[0].inputs.value = { $step: "math.value" }; }],
    ["effect", value => { value.effects = ["local-write"]; }],
    ["python", value => { delete value.implementations[0].steps[2].implementation; }],
    ["expression", value => { value.implementations[0].output = { value: { $op: "add", args: [1, 2] } }; }],
    ["round", value => { value.implementations[0].steps[2].inputs.expression = "round({0}, {1})"; }],
    ["round-composed", value => { value.implementations[0].steps[2].inputs.expression = "1 + round({0}, 2)"; }],
    ["round-float-precision", value => { value.implementations[0].steps[2].inputs.expression = "round({0}, 2.0)"; }],
  ]) {
    const invalid = structuredClone(purePipeline);
    invalid.action_id = `example.pure.${name}`;
    mutate(invalid);
    const rejected = await submit(invalid);
    assert.equal(rejected.isError, true, `${name}: ${JSON.stringify(rejected)}`);
  }
  let successfulProtocolRun;
  for (const [name, code, expectedState, reason, effects] of [
    ["success", "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({ok:true,output:{remote_id:JSON.parse(s).value,pipeline_id:'42',observed_at:'2026-01-01T00:00:00+00:00',url:'https://example.invalid/build/42',status:'inProgress',result:null,terminal:false,tasks:[{name:'build',state:'inProgress',result:null}]}}))", "succeeded"],
    ["malformed", "console.log(JSON.stringify({output:{value:'no-ok',terminal:false}}))", "unknown", "ACTION_RESULT_PROTOCOL_INVALID"],
    ["missing", "console.log(JSON.stringify({ok:true}))", "unknown", "ACTION_RESULT_PROTOCOL_INVALID"],
    ["failure", "console.log(JSON.stringify({ok:false,failure:{code:'not_found',message:'private-failure-message',blocked:true}}))", "failed", "ACTION_RESULT_REPORTED_BLOCKED"],
    ["write-failure", "console.log(JSON.stringify({ok:false,failure:{code:'failed',message:'private-failure-message'}}))", "unknown", "ACTION_RESULT_REPORTED_FAILURE", ["local-write"]],
    ["bad-failure", "console.log(JSON.stringify({ok:false,failure:{code:'missing-message'}}))", "unknown", "ACTION_RESULT_PROTOCOL_INVALID"],
    ["invalid-output", "console.log(JSON.stringify({ok:true,output:{value:42,terminal:false}}))", "unknown", "ACTION_RESULT_PROTOCOL_INVALID"],
    ["extra-envelope", "console.log(JSON.stringify({ok:true,output:{value:'x',terminal:false},progress:5}))", "unknown", "ACTION_RESULT_PROTOCOL_INVALID"],
    ["oversize", "console.log(JSON.stringify({ok:true,output:{value:'x'.repeat(70000),terminal:false}}))", "unknown", "ACTION_RESULT_PROTOCOL_OVERSIZED"],
    ["artifact", "console.log(JSON.stringify({ok:true,output:{value:'x',terminal:false,nested:{artifact_id:'artifact_00000000000000000000000000000000'}}}))", "unknown", "ACTION_RESULT_ARTIFACT_UNSUPPORTED"],
    ["artifacts-envelope", "console.log(JSON.stringify({ok:true,output:{value:'x',terminal:false},artifacts:[]}))", "unknown", "ACTION_RESULT_ARTIFACT_UNSUPPORTED"],
  ]) {
    const protocol = structuredClone(definition);
    protocol.action_id = `example.protocol.${name}`;
    protocol.effects = effects ?? ["pure"];
    protocol.output_schema = { type: "object", properties: {
      remote_id: { type: "string" }, pipeline_id: { type: "string" }, observed_at: { type: "string" },
      url: { type: "string" }, status: { type: "string" }, result: { type: ["string", "null"] },
      terminal: { type: "boolean" }, tasks: { type: "array" },
    }, required: ["remote_id", "pipeline_id", "observed_at", "url", "status", "result", "terminal", "tasks"],
    additionalProperties: false };
    protocol.implementations[0].result_protocol = "pkm.action.result/v1";
    protocol.implementations[0].args = ["-e", code];
    const registered = await submit(protocol);
    assert.notEqual(registered.isError, true, JSON.stringify(registered));
    assert.equal(registered.structuredContent.value.callable, true);
    if (name === "success") {
      const before = counts();
      allowed = false;
      const deniedProtocol = await client.callTool({ name: "action_call", arguments: {
        action_id: registered.structuredContent.value.action_id,
        content_hash: registered.structuredContent.value.content_hash,
        idempotency_key: "protocol-denied", inputs: { value: "hello" },
      } });
      allowed = true;
      assert.equal(deniedProtocol.isError, true);
      assert.match(JSON.stringify(deniedProtocol), /ACTION_EFFECT_CONSENT_REQUIRED/);
      assert.deepEqual(counts(), before, "Denied protocol calls publish no run or receipt.");
    }
    const accepted = await client.callTool({ name: "action_call", arguments: {
      action_id: registered.structuredContent.value.action_id,
      content_hash: registered.structuredContent.value.content_hash,
      idempotency_key: `protocol-${name}`, inputs: { value: "hello" },
    } });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const result = await until(() => readRun(accepted.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
    assert.equal(result.state, expectedState, name);
    if (expectedState === "succeeded") {
      assert.deepEqual(result.output, { remote_id: "hello", pipeline_id: "42", observed_at: "2026-01-01T00:00:00+00:00",
        url: "https://example.invalid/build/42", status: "inProgress", result: null, terminal: false,
        tasks: [{ name: "build", state: "inProgress", result: null }] },
        "A successful query can report a nonterminal remote run.");
      successfulProtocolRun = accepted.structuredContent.value.runId;
    } else {
      assert.equal(result.nodes[0].reason, reason, name);
      assert.equal(Object.hasOwn(result, "output"), false);
      assert.doesNotMatch(JSON.stringify(result), /private-failure-message/);
    }
  }
  const artifactInput = structuredClone(definition);
  artifactInput.action_id = "example.protocol.artifact-input";
  artifactInput.input_schema = { type: "object", properties: {
    item: { type: "object", properties: { artifact_id: { type: "string" } }, required: ["artifact_id"] },
  }, required: ["item"], additionalProperties: false };
  artifactInput.implementations[0].result_protocol = "pkm.action.result/v1";
  const artifactProposal = await submit(artifactInput);
  assert.notEqual(artifactProposal.isError, true, JSON.stringify(artifactProposal));
  const beforeArtifact = counts(), beforeArtifactConsent = consentCalls;
  const artifactCall = await client.callTool({ name: "action_call", arguments: {
    action_id: artifactProposal.structuredContent.value.action_id,
    content_hash: artifactProposal.structuredContent.value.content_hash,
    idempotency_key: "artifact-input", inputs: { item: { artifact_id: "artifact_00000000000000000000000000000000" } },
  } });
  assert.equal(artifactCall.isError, true);
  assert.match(JSON.stringify(artifactCall), /Managed Action artifact inputs are unavailable/);
  assert.equal(consentCalls, beforeArtifactConsent);
  assert.deepEqual(counts(), beforeArtifact);
  for (const [name, code] of [
    ["invalid", "console.log(JSON.stringify({value:42}))"],
    ["oversized", "console.log(JSON.stringify({value:'x'.repeat(70000)}))"],
  ]) {
    const bad = structuredClone(definition);
    bad.action_id = `example.${name}.output`;
    bad.implementations[0].args = ["-e", code];
    const badProposal = await submit(bad);
    assert.notEqual(badProposal.isError, true, JSON.stringify(badProposal));
    const accepted = await client.callTool({ name: "action_call", arguments: {
      action_id: badProposal.structuredContent.value.action_id,
      content_hash: badProposal.structuredContent.value.content_hash,
      idempotency_key: name, inputs: { value: "hello" },
    } });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const result = await until(() => readRun(accepted.structuredContent.value.runId),
      value => ["succeeded", "failed", "cancelled", "unknown"].includes(value.state));
    assert.notEqual(result.state, "succeeded");
    assert.equal(Object.hasOwn(result, "output"), false);
  }
  const slow = structuredClone(definition);
  slow.version++;
  slow.implementations[0].result_protocol = "pkm.action.result/v1";
  slow.implementations[0].args = ["-e", "setTimeout(()=>console.log(JSON.stringify({ok:true,output:{value:'late'}})),30000)"];
  const slowResult = await submit(slow);
  assert.notEqual(slowResult.isError, true, JSON.stringify(slowResult));
  const slowProposal = slowResult.structuredContent.value;
  assert.equal(slowProposal.state, "automatically_admitted");
  const slowCall = await client.callTool({ name: "action_call", arguments: {
    action_id: slowProposal.action_id, content_hash: slowProposal.content_hash,
    idempotency_key: "running-before-revoke", inputs: { value: "hello" },
  } });
  assert.notEqual(slowCall.isError, true, JSON.stringify(slowCall));
  const job = await until(() => {
    const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
    try { return db.prepare("SELECT record_json FROM runtime_process_jobs WHERE state='RUNNING'").get(); }
    finally { db.close(); }
  }, value => !!value && Number.isInteger(JSON.parse(value.record_json).pid));
  const pid = JSON.parse(job.record_json).pid;
  assert.ok(Number.isInteger(pid));
  const beforeRevocation = counts();
  waitForConsent = true;
  const pendingCall = client.callTool({ name: "action_call", arguments: {
    action_id: slowProposal.action_id, content_hash: slowProposal.content_hash,
    idempotency_key: "pending-when-revoked", inputs: { value: "hello" },
  } });
  const pendingPureCall = invokePipeline(pureResult.structuredContent.value, "pure-pending-when-revoked");
  await until(() => waitingForConsent, value => value === 2);
  const revoked = await client.callTool({ name: "action_trust_revoke", arguments: {} });
  assert.notEqual(revoked.isError, true, JSON.stringify(revoked));
  assert.equal(revoked.structuredContent.value.trustedWorkspace, false);
  releaseConsent();
  assert.equal((await pendingCall).isError, true);
  assert.equal((await pendingPureCall).isError, true);
  const afterRevocation = counts();
  assert.deepEqual([afterRevocation[0], afterRevocation[1], afterRevocation[3]],
    [beforeRevocation[0], beforeRevocation[1], beforeRevocation[3]]);
  assert.equal((await call("revoked")).isError, true);
  assert.equal((await invokePipeline(builtinRegistration, "builtin-revoked", { value: "1.5" })).isError, true);
  assert.deepEqual((await readRun(pureRunId)).output_availability, { state: "blocked", reason: "ACCESS_DENIED" });
  assert.deepEqual((await readRun(builtinRunId)).output_availability, { state: "blocked", reason: "ACCESS_DENIED" });
  assert.deepEqual((await readRun(successfulProtocolRun)).output_availability,
    { state: "blocked", reason: "ACCESS_DENIED" });
  const withheld = await readRun(runId);
  assert.equal(Object.hasOwn(withheld, "output"), false, "Revoked trust cannot release stored outputs.");
  assert.deepEqual(withheld.output_availability, { state: "blocked", reason: "ACCESS_DENIED" });
  await until(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  }, value => value === true);
  const cancelled = await until(() => readRun(slowCall.structuredContent.value.runId),
    value => ["cancelled", "unknown", "failed"].includes(value.state));
  assert.equal(Object.hasOwn(cancelled, "output"), false);
  await client.close();
  client = undefined;
  const db = new DatabaseSync(resolve(root, "core.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT closed FROM runtime_process_owner").get().closed, 1); }
  finally { db.close(); }
  const plainTransport = new StdioClientTransport({
    command: process.execPath, args: [resolve(build, "cli.js"), "mcp", "--data", root, "--experimental-legacy-mcp"],
    stderr: "pipe",
  });
  client = new Client({ name: "production-action-default-test", version: "1.0.0" });
  await client.connect(plainTransport);
  assert.equal((await client.listTools()).tools.some(tool => tool.name === "action_call"), false);
  await client.close();
  client = undefined;
  execFileSync(process.execPath, [resolve(build, "cli.js"), "backup", "--data", root, "--destination", backup], {
    stdio: "pipe", timeout: 15000,
  });
  assert.equal(existsSync(resolve(backup, ".pkm-action-authority")), false);
});
