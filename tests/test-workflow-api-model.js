#!/usr/bin/env node
const assert = require("assert");
const {
  DEFAULT_MAX_PAGE_SIZE,
  DEFAULT_MAX_PAYLOAD_BYTES,
  WORKFLOW_OPERATION_REGISTRY,
  WORKFLOW_REQUEST_SCHEMA,
  WORKFLOW_RESPONSE_SCHEMA,
  WorkflowApiError,
  createWorkflowDispatcher,
  decodeEventCursor,
  encodeEventCursor,
  negotiateCapabilities,
  requestFingerprint,
  workflowMcpToolDescriptors
} = require("../dist/workflows/api-model.js");

const actor = { actorId: "actor-1", roles: ["operator"] };
const client = { clientId: "client-1", version: "2.8.0", capabilities: ["events", "unknown", "events"] };
const scope = { rootId: "root-1", projectScopeId: "project-1" };
let serial = 0;
const request = (operationId, overrides = {}) => ({
  schema: WORKFLOW_REQUEST_SCHEMA,
  requestId: `request-${++serial}`,
  operationId,
  operationMajor: 1,
  actor,
  client,
  scope,
  parameters: {},
  ...overrides
});
const grantFor = capability => [{ grantId: `grant-${capability}`, version: 3, capabilities: [capability] }];
const mutation = (operationId, capability, parameters = {}, overrides = {}) => request(operationId, {
  parameters,
  commandId: `command-${serial}`,
  capabilityGrants: grantFor(capability),
  expectedVersions: { [capability]: 1 },
  ...overrides
});
const assertError = async (promise, code) => {
  const response = await promise;
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.error.code, code);
  assert.deepStrictEqual(response.redactionSummary, { redactedCount: 0, reasons: [] });
  assert.strictEqual(response.replayed, false);
  return response;
};

(async () => {
  assert.strictEqual(DEFAULT_MAX_PAYLOAD_BYTES, 256 * 1024);
  assert.strictEqual(DEFAULT_MAX_PAGE_SIZE, 100);
  assert.strictEqual(WORKFLOW_RESPONSE_SCHEMA, "pkm.workflow.response/v1");
  const ids = WORKFLOW_OPERATION_REGISTRY.map(item => item.operationId);
  [
    "definition.publish", "run.create", "run.get", "run.control", "assignment.offer", "assignment.claim", "assignment.decline",
    "lease.heartbeat", "lease.renew", "lease.release", "evidence.register", "evidence.get", "gate.decide", "archive",
    "migration", "repair", "operation.get", "operation.wait", "operation.cancel", "events.list"
  ].forEach(id => assert(ids.includes(id), id));
  assert.strictEqual(new Set(ids).size, ids.length);
  assert(WORKFLOW_OPERATION_REGISTRY.every(item => item.operationMajor === 1));
  assert(Object.isFrozen(WORKFLOW_OPERATION_REGISTRY));

  const baseFingerprintRequest = request("run.get", {
    parameters: { z: 2, a: [true, null] },
    referencedObjectDigests: { definition: "sha256:def" },
    expectedVersions: { run: 4 },
    capabilityGrants: [
      { grantId: "z", version: 2, capabilities: ["run"] },
      { grantId: "a", version: 1, capabilities: ["read"] }
    ],
    trace: { id: "trace-1" }, deadline: "soon", bearer: "secret"
  });
  const fingerprint = requestFingerprint(baseFingerprintRequest);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.strictEqual(requestFingerprint({ ...baseFingerprintRequest, requestId: "other", actor: { actorId: "other", roles: [] }, client: { ...client, clientId: "other" }, trace: "changed", deadline: "later", bearer: "other", capabilityGrants: [...baseFingerprintRequest.capabilityGrants].reverse() }), fingerprint);
  for (const changed of [
    { operationId: "evidence.get" }, { operationMajor: 2 }, { scope: { ...scope, rootId: "other" } },
    { scope: { ...scope, projectScopeId: "other" } }, { parameters: { a: 2 } },
    { referencedObjectDigests: { definition: "sha256:other" } }, { expectedVersions: { run: 5 } },
    { capabilityGrants: [{ grantId: "a", version: 2, capabilities: [] }] }
  ]) assert.notStrictEqual(requestFingerprint({ ...baseFingerprintRequest, ...changed }), fingerprint);
  assert.strictEqual(requestFingerprint(request("run.get")), requestFingerprint(request("run.get", { referencedObjectDigests: {}, expectedVersions: {}, capabilityGrants: [] })));
  const duplicateGrantIds = request("run.get", { capabilityGrants: [{ grantId: "same", version: 2, capabilities: [] }, { grantId: "same", version: 1, capabilities: [] }] });
  assert.strictEqual(requestFingerprint(duplicateGrantIds), requestFingerprint({ ...duplicateGrantIds, capabilityGrants: [...duplicateGrantIds.capabilityGrants].reverse() }));

  assert.deepStrictEqual(negotiateCapabilities(client.capabilities, ["events", "runs"]), { accepted: ["events"], unavailable: ["unknown"] });
  assert(Object.isFrozen(negotiateCapabilities([], [])));
  assert.throws(() => encodeEventCursor(0, 0), error => error instanceof WorkflowApiError && error.code === "cursor-invalid");
  assert.throws(() => encodeEventCursor(1, -1), error => error.code === "cursor-invalid");
  const cursor = encodeEventCursor(3, 9);
  assert.deepStrictEqual(decodeEventCursor(cursor), { authEpoch: 3, afterSequence: 9 });
  for (const invalid of ["%%%", Buffer.from("{}").toString("base64url"), Buffer.from('{"authEpoch":1,"afterSequence":0,"x":1}').toString("base64url"), Buffer.from('{"authEpoch":0,"afterSequence":0}').toString("base64url"), Buffer.from('{"authEpoch":1,"afterSequence":-1}').toString("base64url")]) {
    assert.throws(() => decodeEventCursor(invalid), error => error.code === "cursor-invalid");
  }

  let authEpoch = 7;
  let runGetCalls = 0;
  const future = "2099-01-01T00:00:00.000Z";
  const events = [
    { sequence: 1, resourceId: "visible-1", payload: { secret: false } },
    { sequence: 2, resourceId: "hidden", payload: { secret: true } },
    { sequence: 3, resourceId: "visible-2", payload: { secret: false } }
  ];
  const dispatcher = createWorkflowDispatcher({
    supportedCapabilities: ["events", "runs"],
    authEpoch: () => authEpoch,
    authorizeEvent: (_actor, _scope, event) => event.resourceId !== "hidden",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    maxPayloadBytes: 1024,
    maxPageSize: 2,
    handlers: {
      "run.get": async (_request, context) => { runGetCalls += 1; return { found: true, fingerprint: context.fingerprint, kind: context.descriptor.kind }; },
      "definition.publish": req => ({ published: req.parameters }),
      "events.list": () => ({ events }),
      archive: () => ({ operationRecordId: "op-archive", creatorOperationId: "archive", creatorOperationMajor: 1, state: "running", retainedUntil: future })
    }
  });

  const negotiated = await dispatcher.dispatch(request("capability.negotiate"));
  assert.strictEqual(negotiated.ok, true);
  assert.deepStrictEqual(negotiated.result, { accepted: ["events"], unavailable: ["unknown"] });
  const runGet = await dispatcher.dispatch(request("run.get"));
  assert.deepStrictEqual(runGet.result.found, true);
  assert.strictEqual(runGet.result.kind, "query");
  assert.strictEqual(runGetCalls, 1);

  await assertError(dispatcher.dispatch(request("private.delete", { commandId: "private" })), "operation-not-found");
  await assertError(dispatcher.dispatch(request("run.get", { operationMajor: 2 })), "operation-not-found");
  await assertError(dispatcher.dispatch(request("evidence.get")), "handler-unavailable");
  const internal = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, handlers: { "run.get": () => { throw new Error("secret details"); } } });
  const internalFailure = await assertError(internal.dispatch(request("run.get")), "internal-error");
  assert.strictEqual(internalFailure.error.message, "Workflow operation failed.");
  assert.strictEqual(internalFailure.error.retryable, true);
  const absentRequest = await internal.dispatch(undefined);
  assert.deepStrictEqual({ requestId: absentRequest.requestId, operationId: absentRequest.operationId, operationMajor: absentRequest.operationMajor }, { requestId: "", operationId: "", operationMajor: 0 });
  const oversizedResponse = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, maxPayloadBytes: 1000, handlers: { "run.get": () => ({ text: "x".repeat(2000) }) } });
  const oversizedFailure = await assertError(oversizedResponse.dispatch(request("run.get")), "payload-too-large");
  assert.strictEqual(oversizedFailure.error.details.direction, "response");
  const invalidResponse = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, handlers: { "run.get": () => undefined } });
  await assertError(invalidResponse.dispatch(request("run.get")), "response-invalid");

  const publishBase = mutation("definition.publish", "definition", { name: "flow" });
  const published = await dispatcher.dispatch(publishBase);
  assert.strictEqual(published.ok, true);
  assert.strictEqual(published.replayed, false);
  const replay = await dispatcher.dispatch({ ...publishBase, requestId: "retry-request", trace: "different", bearer: "rotated" });
  assert.strictEqual(replay.ok, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.requestId, "retry-request");
  await assertError(dispatcher.dispatch({ ...publishBase, requestId: "conflict", parameters: { name: "changed" } }), "command-conflict");
  await assertError(dispatcher.dispatch(request("definition.publish", { capabilityGrants: grantFor("definition"), expectedVersions: { definition: 1 } })), "command-required");
  await assertError(dispatcher.dispatch(request("definition.publish", { commandId: "missing-cap", expectedVersions: { definition: 1 } })), "capability-required");
  await assertError(dispatcher.dispatch(request("definition.publish", { commandId: "missing-version", capabilityGrants: grantFor("definition") })), "expected-version-required");
  await assertError(dispatcher.dispatch(request("definition.publish", { commandId: "bad-version", capabilityGrants: grantFor("definition"), expectedVersions: { definition: -1 } })), "expected-version-required");

  const archived = await dispatcher.dispatch(mutation("archive", "target"));
  assert.strictEqual(archived.result.operationRecordId, "op-archive");
  dispatcher.deprecate("archive", 1);
  await assertError(dispatcher.dispatch(mutation("archive", "target", {}, { commandId: "after-deprecation" })), "operation-not-found");
  const operationGet = await dispatcher.dispatch(request("operation.get", { parameters: { operationRecordId: "op-archive" } }));
  assert.strictEqual(operationGet.result.state, "running");
  const operationWait = await dispatcher.dispatch(request("operation.wait", { parameters: { operationRecordId: "op-archive" } }));
  assert.strictEqual(operationWait.result.creatorOperationId, "archive");
  const cancelRequest = mutation("operation.cancel", "operation", { operationRecordId: "op-archive" });
  const cancelled = await dispatcher.dispatch(cancelRequest);
  assert.strictEqual(cancelled.result.state, "cancelled");
  const cancelledAgain = await dispatcher.dispatch(mutation("operation.cancel", "operation", { operationRecordId: "op-archive" }, { commandId: "cancel-again" }));
  assert.strictEqual(cancelledAgain.result.state, "cancelled");
  await assertError(dispatcher.dispatch(request("operation.get", { parameters: {} })), "operation-record-invalid");
  await assertError(dispatcher.dispatch(request("operation.get", { parameters: { operationRecordId: "missing" } })), "operation-record-not-found");

  dispatcher.putOperation({ operationRecordId: "terminal", creatorOperationId: "migration", creatorOperationMajor: 1, state: "succeeded", retainedUntil: future, result: 42 });
  const terminalCancel = await dispatcher.dispatch(mutation("operation.cancel", "operation", { operationRecordId: "terminal" }, { commandId: "terminal-cancel" }));
  assert.strictEqual(terminalCancel.result.state, "succeeded");
  dispatcher.putOperation({ operationRecordId: "failed", creatorOperationId: "repair", creatorOperationMajor: 1, state: "failed", retainedUntil: future });
  dispatcher.putOperation({ operationRecordId: "expired", creatorOperationId: "repair", creatorOperationMajor: 1, state: "pending", retainedUntil: "2020-01-01T00:00:00.000Z" });
  await assertError(dispatcher.dispatch(request("operation.get", { parameters: { operationRecordId: "expired" } })), "operation-record-not-found");
  const defaultClock = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, handlers: {} });
  defaultClock.putOperation({ operationRecordId: "default-clock", creatorOperationId: "repair", creatorOperationMajor: 1, state: "running", retainedUntil: future });
  assert.strictEqual((await defaultClock.dispatch(request("operation.get", { parameters: { operationRecordId: "default-clock" } }))).result.state, "running");
  assert.strictEqual((await defaultClock.dispatch(mutation("operation.cancel", "operation", { operationRecordId: "default-clock" }, { commandId: "default-clock-cancel" }))).result.state, "cancelled");
  assert.throws(() => dispatcher.putOperation({ operationRecordId: "", creatorOperationId: "repair", creatorOperationMajor: 1, state: "pending", retainedUntil: future }), error => error.code === "handler-contract");
  assert.throws(() => dispatcher.putOperation({ operationRecordId: "bad-date", creatorOperationId: "repair", creatorOperationMajor: 1, state: "pending", retainedUntil: "bad" }), error => error.code === "handler-contract");
  assert.throws(() => dispatcher.putOperation({ operationRecordId: "bad-state", creatorOperationId: "repair", creatorOperationMajor: 1, state: "other", retainedUntil: future }), error => error.code === "handler-contract");

  const eventPage = await dispatcher.dispatch(request("events.list", { pagination: { limit: 2 } }));
  assert.deepStrictEqual(eventPage.result.events.map(event => event.resourceId), ["visible-1"]);
  assert.deepStrictEqual(eventPage.redactionSummary, { redactedCount: 1, reasons: ["not-authorized"] });
  assert.deepStrictEqual(decodeEventCursor(eventPage.result.nextCursor), { authEpoch: 7, afterSequence: 2 });
  const secondPage = await dispatcher.dispatch(request("events.list", { pagination: { limit: 2, cursor: eventPage.result.nextCursor } }));
  assert.deepStrictEqual(secondPage.result.events.map(event => event.resourceId), ["visible-2"]);
  assert.strictEqual(secondPage.result.nextCursor, undefined);
  assert.deepStrictEqual(secondPage.redactionSummary, { redactedCount: 0, reasons: [] });
  authEpoch = 8;
  await assertError(dispatcher.dispatch(request("events.list", { pagination: { limit: 2, cursor: eventPage.result.nextCursor } })), "cursor-auth-epoch-stale");

  const badEvents = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, handlers: { "events.list": () => ({ nope: true }) } });
  await assertError(badEvents.dispatch(request("events.list")), "handler-contract");
  const defaultPage = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, handlers: { "events.list": () => ({ events: [] }) } });
  assert.strictEqual((await defaultPage.dispatch(request("events.list"))).ok, true);

  for (const malformed of [
    { schema: "wrong" }, { requestId: " " }, { operationId: " " }, { operationMajor: 0 },
    { actor: { actorId: "", roles: [] } }, { client: { ...client, clientId: "" } }, { client: { ...client, version: "" } },
    { scope: { ...scope, rootId: "" } }, { scope: { ...scope, projectScopeId: "" } }
  ]) await assertError(dispatcher.dispatch({ ...request("run.get"), ...malformed }), malformed.schema ? "schema-unsupported" : malformed.actor ? "actor-invalid" : malformed.client ? "client-invalid" : malformed.scope ? "scope-invalid" : "request-invalid");
  await assertError(dispatcher.dispatch(request("run.get", { parameters: undefined })), "request-invalid");
  await assertError(dispatcher.dispatch(request("run.get", { parameters: { text: "x".repeat(2000) } })), "payload-too-large");
  for (const limit of [0, 3, 1.5]) await assertError(dispatcher.dispatch(request("events.list", { pagination: { limit } })), "pagination-invalid");

  const invalidLong = createWorkflowDispatcher({ supportedCapabilities: [], authEpoch: () => 1, authorizeEvent: () => true, handlers: { migration: () => ({ operationRecordId: "m", creatorOperationId: "repair", creatorOperationMajor: 1, state: "pending", retainedUntil: future }) } });
  await assertError(invalidLong.dispatch(mutation("migration", "target")), "handler-contract");

  const descriptors = workflowMcpToolDescriptors();
  assert.strictEqual(descriptors.length, WORKFLOW_OPERATION_REGISTRY.length);
  assert.strictEqual(descriptors.find(tool => tool.name === "run_get").annotations.readOnlyHint, true);
  assert.strictEqual(descriptors.find(tool => tool.name === "archive").annotations.destructiveHint, true);
  assert.strictEqual(descriptors.find(tool => tool.name === "operation_cancel").annotations.destructiveHint, true);
  assert.strictEqual(descriptors.find(tool => tool.name === "definition_publish").annotations.destructiveHint, false);
  assert(descriptors.every(tool => tool.annotations.idempotentHint && tool.inputSchema.additionalProperties === false && Object.isFrozen(tool)));
  assert.deepStrictEqual(workflowMcpToolDescriptors([]), []);

  console.log("workflow API model test: canonical envelopes, registry, replay, streams, operations, and MCP descriptors OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
