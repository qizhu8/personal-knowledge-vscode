const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { executeMemoryOperation } = require("../dist/capabilities/memory-operations");
const { callCapabilityService } = require("../dist/capabilities/service");
const { createExplicitMemoryTools } = require("../dist/chat/explicit-memory-tools");
const { memoryCapabilities } = require("../dist/capabilities/memory-contract");
const { capabilityTools } = require("../dist/chat/capability-tools");
const { capabilityObservations } = require("../dist/capabilities/observations");
const { todoCapabilities } = require("../dist/capabilities/registry");

test("combined Todo/Memory compact schema stays below the pilot 40-percent regression threshold", () => {
  const definitions = [...todoCapabilities, ...memoryCapabilities];
  const leaves = definitions.map(operation => ({ name: operation.transportName, description: operation.description,
    parameters: operation.inputSchema, execute: async () => { throw new Error("Measurement must not execute a leaf"); } }));
  const compact = capabilityTools(leaves, definitions, true);
  const bytes = tools => Buffer.byteLength(JSON.stringify(tools.map(({ execute, ...tool }) => tool)));
  const legacyBytes = bytes(leaves), compactBytes = bytes(compact);
  assert(compactBytes < legacyBytes * 0.4);
  console.log(JSON.stringify({ pilot: "todo-and-memory-native", legacyTools: leaves.length, compactTools: compact.length,
    legacySchemaBytes: legacyBytes, compactSchemaBytes: compactBytes, measurement: "serialized fixture bytes, not provider tokens" }));
});

test("Memory receipts expose exact retrieved versions without leaking content or claiming application", () => {
  const record = { id: `explicit-${"a".repeat(64)}`, revision: 3, status: "confirmed", content: "private convention" };
  const observations = capabilityObservations({ toolCalls: [
    { id: "search", name: "capability_read", status: "complete", arguments: '{"operation":"memory.record.search","version":1}',
      result: JSON.stringify({ result: { records: [record] } }) },
    { id: "legacy", name: "memory_record_get", status: "complete", arguments: "{}", result: JSON.stringify(record) },
  ] });
  assert.equal(observations[0].memory.kind, "retrieved");
  assert.equal(observations[0].memory.application, "not-observed");
  assert.deepEqual(observations[1].memory.records, [{ id: record.id, revision: 3, status: "confirmed" }]);
  assert.equal(observations[1].operation, "memory.record.get");
  assert(!JSON.stringify(observations).includes("private convention"));
});

test("native and external capability paths share durable scoped Memory, but only real Host decisions activate or revoke it", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-cap-memory-")), other = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-cap-foreign-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  const options = { python: process.env.PKM_TEST_PYTHON || "python3", extensionRoot: path.resolve(__dirname, ".."),
    database: path.join(root, "private.sqlite3"), identity: "fixture-local-owner" };
  const scope = { options, root };
  const call = (action, operation, args, context = scope) =>
    callCapabilityService(action, { operation, version: 1, arguments: args }, "mcp:external", context);
  const sources = [{ id: "input-1", chat: "fixture-chat", revision: "a".repeat(32), locator: "message/input-1" }];
  await assert.rejects(call("call", "memory.record.propose", { content: "\u754c".repeat(2000), sources,
    operation_id: "oversized-utf8" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(call("call", "memory.record.propose", { content: "Bounded sources", operation_id: "oversized-sources",
    sources: [0, 1, 2].map(id => ({ ...sources[0], id: String(id), locator: "x".repeat(1500) })) }), { code: "INVALID_ARGUMENT" });
  const maximum = await call("call", "memory.record.propose", { content: '"'.repeat(4096), operation_id: "bounded-large-record",
    sources: [{ ...sources[0], locator: "\\".repeat(1950) }] });
  assert(Buffer.byteLength(JSON.stringify(maximum)) < 16000, "maximum content and nearly maximum escaped sources fit the actual native tool-result budget");
  const proposed = (await call("call", "memory.record.propose", { content: "Project Todos are managed in PKM.", sources, operation_id: "proposal-1" })).result;
  assert.equal(proposed.status, "pending");
  assert.deepEqual((await call("read", "memory.record.search", { query: "Todos" })).result.records, []);
  await assert.rejects(call("call", "memory.record.confirm", { id: proposed.id, expected_revision: 1, operation_id: "fake-confirm" }), { code: "NOT_AVAILABLE" });
  await assert.rejects(call("call", "memory.record.propose", { content: "Bad", sources, operation_id: "bad", userConfirmed: true }), { code: "INVALID_ARGUMENT" });
  let decisions = 0, allow = false;
  const tools = createExplicitMemoryTools({
    enabled: memoryCapabilities.map(operation => operation.transportName), context: () => scope, assertActive: () => {},
    approve: async () => true,
    authorize: async request => { decisions++; assert.equal(request.recordId, proposed.id); return allow ? { actorId: "user:local", decisionId: randomUUID() } : null; },
  });
  const compact = capabilityTools(tools, memoryCapabilities, true), mutate = compact.find(tool => tool.name === "capability_call");
  const confirmArgs = { operation: "memory.record.confirm", version: 1,
    arguments: { id: proposed.id, expected_revision: 1, operation_id: "confirm-1" } };
  await assert.rejects(mutate.execute(confirmArgs, new AbortController().signal), /authorize/);
  assert.equal(decisions, 1, "Allow All does not replace the injected human-decision boundary");
  allow = true;
  const confirmed = JSON.parse(await mutate.execute(confirmArgs, new AbortController().signal)).result;
  assert.equal(confirmed.status, "confirmed");
  await assert.rejects(call("read", "memory.record.get", { id: proposed.id }, { options, root: other }), { code: "NOT_AVAILABLE" });
  await assert.rejects(executeMemoryOperation(options, root, "memory_record_confirm", {
    id: proposed.id, expected_revision: 1, operation_id: "stale-confirm",
  }, () => ({ actorId: "user:local", decisionId: "stale-decision" })), { code: "CONFLICT" });
  const search = (await call("read", "memory.record.search", { query: "Todos" })).result.records;
  assert.equal(search[0].id, proposed.id);
  assert.equal(search[0].revision, confirmed.revision);
  assert.equal(search[0].preview, "Project Todos are managed in PKM.");
  assert.deepEqual((await call("read", "memory.record.search", { query: "Todos" }, { options, root: other })).result.records, []);
  const get = (await call("read", "memory.record.get", { id: proposed.id, revision: confirmed.revision })).result;
  assert.deepEqual(get.sources, sources, "new worker/process reads identical persisted provenance");
  const revised = await executeMemoryOperation(options, root, "memory_record_revise", { id: proposed.id,
    expected_revision: confirmed.revision, operation_id: "revise-1", content: "Project Tasks live in PKM; next-step holds assets.", sources },
    () => ({ actorId: "user:local", decisionId: "revision-decision" }));
  assert.equal(revised.status, "pending", "revised content does not inherit the earlier confirmation");
  assert.deepEqual((await call("read", "memory.record.search", { query: "Todos" })).result.records, [], "old content is not current recall");
  const reconfirmed = await executeMemoryOperation(options, root, "memory_record_confirm", { id: proposed.id,
    expected_revision: revised.revision, operation_id: "confirm-2" },
    () => ({ actorId: "user:local", decisionId: "reconfirm-decision" }));
  assert.equal((await call("read", "memory.record.search", { query: "Tasks" })).result.records[0].revision, reconfirmed.revision);
  const revoked = await executeMemoryOperation(options, root, "memory_record_revoke", { id: proposed.id,
    expected_revision: reconfirmed.revision, operation_id: "revoke-1" },
    () => ({ actorId: "user:local", decisionId: "revoke-decision" }));
  assert.equal(revoked.status, "revoked");
  assert.deepEqual((await call("read", "memory.record.search", { query: "Tasks" })).result.records, [], "fresh engine after revoke cannot revive the record");
  const audit = (await call("read", "memory.record.audit", { id: proposed.id })).result;
  assert(audit.events.length >= 4);
});
