import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildHostConfigOptions, hostConfigByteLimit } from "../dist/host-config.js";
import { ModelProviderService } from "../dist/model-provider.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { initialize, Storage } from "../dist/storage.js";
import { chatTurnInput } from "./chat-turn-fixtures.mjs";
import { hostConfigFixture } from "./host-config-fixtures.mjs";

const actor = { id: "synthetic-host-actor", canWrite: true };
const invoke = (operation, args) => ({ operation, version: 1, arguments: args });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("configured host executes a real native Chat and approval chain with an injected synthetic fetch", async t => {
  const f = hostConfigFixture();
  const options = f.build();
  assert.equal(f.factoryCalls, 0);
  assert.deepEqual(f.resolutions, []);
  const root = join(dirname(fileURLToPath(import.meta.url)), `.host-config-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({ storage, ...options });
  t.after(async () => { await runtime.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  const input = chatTurnInput();
  assert.equal((await runtime.core.dispatch("capability_call", invoke("chat.turn.start", input), actor)).result.id, input.id);
  let turn;
  for (let count = 0; count < 500; count++) {
    turn = (await runtime.core.dispatch("capability_read", invoke("chat.turn.get", { id: input.id }), actor)).result;
    if (["completed", "failed", "cancelled", "unknown"].includes(turn.status)) break;
    await tick();
  }
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  assert.equal(turn.output, "Synthetic answer.");
  assert.equal(f.requests.length, 2);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.authorizations.length, 1);
  assert.equal(f.authorizations[0].readOnly, false);
  assert.equal(f.reviews[0].record.tool, "knowledge.document.create");
  assert.equal(f.requests[0].init.redirect, "error");
  assert.equal(f.requests[0].init.headers.get("authorization"), "Bearer synthetic-host-credential");
  const document = await runtime.core.dispatch("capability_read", invoke("knowledge.document.get", { id: "host-config-document" }), actor);
  assert.equal(document.result.content, "Synthetic content.");
  const catalog = await options.modelConfig.catalog();
  assert(!JSON.stringify(catalog).includes("synthetic-host-credential"));
  assert(!JSON.stringify(catalog).includes(f.config.secretRef));
  assert(!JSON.stringify(catalog).includes(f.config.endpoint));
});

test("configuration is strict, bounded, and requires independent authority and in-process dependencies", () => {
  const f = hostConfigFixture();
  const invalid = [
    { schema: "unknown" }, { secretRef: undefined }, { secretRef: "raw-token" }, { token: "secret" },
    { model: "" }, { model: "another-model" }, { provider: "vscode" }, { contextWindow: 128 },
    { maxOutputTokens: 16384 }, { includeUsage: undefined }, { tools: [] },
    { tools: ["knowledge.document.create", "knowledge.document.create"] },
    { tools: ["chat.turn.start"] }, { tools: ["memory.record.confirm"] },
    { tools: ["process.execute"] }, { tools: ["knowledge.document.get"] },
    { endpoint: "http://synthetic.invalid/v1" }, { endpoint: "https://user:pass@synthetic.invalid/v1" },
    { endpoint: "https://synthetic.invalid/v1?token=leak" }, { endpoint: "https://else.invalid/v1" },
    { endpoint: "https://synthetic.invalid/v1#fragment" }, { apiVersion: "2024-06-01" },
  ];
  for (const change of invalid) {
    const config = { ...f.config, ...change };
    assert.throws(() => buildHostConfigOptions(JSON.stringify(config), f.dependencies), /Invalid native host configuration/);
  }
  f.dependencies.policy.allowedTools.push("knowledge.skill.routing.prompt", "memory.record.confirm");
  for (const operation of ["knowledge.skill.routing.prompt", "memory.record.confirm"]) {
    assert.throws(() => buildHostConfigOptions(JSON.stringify({ ...f.config, tools: [operation] }), f.dependencies),
      /Invalid native host configuration/);
  }
  for (const key of ["reviewer", "authorizeTool", "fetchFactory", "resolveSecret", "policy"]) {
    assert.throws(() => buildHostConfigOptions(JSON.stringify(f.config), { ...f.dependencies, [key]: undefined }), /Invalid native host configuration/);
  }
  assert.throws(() => buildHostConfigOptions("x".repeat(hostConfigByteLimit + 1), f.dependencies), /Invalid native host configuration/);
  assert.throws(() => buildHostConfigOptions("{", f.dependencies), /Invalid native host configuration/);
  assert.equal(f.factoryCalls, 0);
  assert.deepEqual(f.resolutions, []);
});

test("loopback cleartext is opt-in and redirect, cancellation, model and provider restrictions fail closed", async () => {
  const f = hostConfigFixture({ endpoint: "http://127.0.0.1:1234/v1" });
  f.dependencies.policy.allowedEndpoints = [f.config.endpoint];
  assert.throws(() => f.build(), /Invalid native host configuration/);
  f.dependencies.policy.allowInsecureLoopback = true;
  const options = f.build();
  let networkCalls = 0;
  f.dependencies.fetchFactory = () => async () => { networkCalls++; return new Response(null, { status: 302, headers: { location: "https://other.invalid" } }); };
  const payload = { model: "synthetic-model", messages: [], stream: true, max_tokens: 10 };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(options.providerTransport.open({ provider: "openai-compatible", payload, signal: controller.signal }), { code: "cancelled" });
  assert.equal(networkCalls, 0);
  await assert.rejects(options.providerTransport.open({ provider: "openai-compatible", payload: { ...payload, model: "other" }, signal: new AbortController().signal }), { code: "configuration-unavailable" });
  await assert.rejects(options.providerTransport.open({ provider: "azure-openai", payload, signal: new AbortController().signal }), { code: "configuration-unavailable" });
  await assert.rejects(options.providerTransport.open({ provider: "openai-compatible", payload, signal: new AbortController().signal }), { code: "transport-error" });
  assert.equal(networkCalls, 1);
});

test("Azure configuration uses the selected deployment and API version without exposing its key", async () => {
  const f = hostConfigFixture({ provider: "azure-openai", apiVersion: "2025-01-01" });
  f.dependencies.policy.allowedProviders = ["azure-openai"];
  let request;
  f.dependencies.fetchFactory = () => async (url, init) => {
    request = { url, init };
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const options = f.build();
  const body = await options.providerTransport.open({
    provider: "azure-openai", payload: { model: "synthetic-model", messages: [], stream: true, max_tokens: 10 },
    signal: new AbortController().signal,
  });
  await body.cancel();
  assert.equal(request.url, "https://synthetic.invalid/v1/openai/deployments/synthetic-model/chat/completions?api-version=2025-01-01");
  assert.equal(request.init.headers.get("api-key"), "synthetic-host-credential");
  assert.equal(request.init.headers.get("authorization"), null);
  assert(!JSON.stringify(await options.modelConfig.catalog()).includes("synthetic-host-credential"));
});

test("native authorization denies an otherwise approved mutation", async t => {
  const f = hostConfigFixture();
  f.dependencies.authorizeTool = async () => false;
  const root = join(dirname(fileURLToPath(import.meta.url)), `.host-config-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({ storage, ...f.build() });
  t.after(async () => { await runtime.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  const input = chatTurnInput();
  await runtime.core.dispatch("capability_call", invoke("chat.turn.start", input), actor);
  let turn;
  for (let count = 0; count < 500; count++) {
    turn = (await runtime.core.dispatch("capability_read", invoke("chat.turn.get", { id: input.id }), actor)).result;
    if (["completed", "failed", "cancelled", "unknown"].includes(turn.status)) break;
    await tick();
  }
  assert(["completed", "failed"].includes(turn.status));
  const document = await runtime.core.dispatch("capability_read", invoke("knowledge.document.get", { id: "host-config-document" }), actor);
  assert.equal(document.error.code, "NOT_FOUND");
});

test("cancelled Chat cannot execute a late native approval", async t => {
  const f = hostConfigFixture();
  let finishDecision, enterReview, reviewed;
  const pendingReview = new Promise(resolve => { enterReview = resolve; });
  const decision = new Promise(resolve => { finishDecision = resolve; });
  f.dependencies.reviewer = async request => { reviewed = request; enterReview(); return decision; };
  const root = join(dirname(fileURLToPath(import.meta.url)), `.host-config-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({ storage, ...f.build() });
  t.after(async () => { finishDecision(null); await runtime.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  const input = chatTurnInput();
  await runtime.core.dispatch("capability_call", invoke("chat.turn.start", input), actor);
  await pendingReview;
  const pending = (await runtime.core.dispatch("capability_read", invoke("chat.turn.get", { id: input.id }), actor)).result;
  const cancelled = await runtime.core.dispatch("capability_call", invoke("chat.turn.cancel", {
    id: input.id, expectedRevision: pending.revision, operationId: randomUUID(),
  }), actor);
  assert.equal(cancelled.result.status, "cancelled");
  finishDecision({ actorId: reviewed.actorId, decisionId: randomUUID(), decision: "approve" });
  await tick();
  assert.equal(f.authorizations.length, 0);
  assert.equal(f.requests.length, 1);
  const document = await runtime.core.dispatch("capability_read", invoke("knowledge.document.get", { id: "host-config-document" }), actor);
  assert.equal(document.error.code, "NOT_FOUND");
});

test("credential and transport failures are sanitized and missing credentials do not send", async () => {
  const f = hostConfigFixture();
  f.dependencies.resolveSecret = async () => { throw new Error("sensitive-secret-should-not-leak"); };
  const options = f.build();
  const provider = new ModelProviderService({ modelConfig: options.modelConfig, transport: options.providerTransport });
  const events = provider.stream({ messages: [{ role: "user", content: "Hello" }], signal: new AbortController().signal });
  await assert.rejects(async () => { for await (const _event of events) {} }, error => {
    assert.equal(error.code, "configuration-unavailable");
    assert(!String(error).includes("sensitive-secret"));
    return true;
  });
  assert.equal(f.factoryCalls, 0);
  f.dependencies.resolveSecret = async () => "sensitive-host-credential";
  f.dependencies.fetchFactory = () => async () => { throw new Error("sensitive-host-credential"); };
  await assert.rejects(options.providerTransport.open({
    provider: "openai-compatible",
    payload: { model: "synthetic-model", messages: [], stream: true, max_tokens: 10 },
    signal: new AbortController().signal,
  }), error => {
    assert.equal(error.code, "transport-error");
    assert(!String(error).includes("sensitive-host-credential"));
    return true;
  });
});
