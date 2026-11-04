const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { CapabilityRegistry, todoCapabilities, validateCapabilityInput } = require("../dist/capabilities/registry");
const { capabilityTools } = require("../dist/chat/capability-tools");
const { callCapabilityService } = require("../dist/capabilities/service");
const { capabilityObservations } = require("../dist/capabilities/observations");
const { todoApiDefinitions } = require("../dist/knowledge/todo-api-contract");
const store = require("../dist/knowledge/filestore");

test("all Todo operations have unique stable identities, original schemas and explicit leaf policies", () => {
  const registry = new CapabilityRegistry(todoCapabilities);
  assert.equal(todoCapabilities.length, todoApiDefinitions.length);
  for (const api of todoApiDefinitions) {
    const operation = todoCapabilities.find(item => item.transportName === api.name);
    assert.deepEqual(operation.inputSchema, api.parameters);
    assert.equal(operation.readOnly, api.readOnly);
    assert.equal(registry.describe(operation.id).version, 1);
    assert(operation.authorization.includes("reviewer"));
  }
  assert.equal(registry.describe("todo.workitem.create").transportName, "add_workitem");
  assert.throws(() => registry.describe("todo.workitem.exec"), { code: "NOT_AVAILABLE" });
});

test("discovery is bounded, paginated, version pinned and search returns actual schemas", () => {
  const registry = new CapabilityRegistry(todoCapabilities);
  const first = registry.discover({ path: "todo.workitem", limit: 2 });
  assert.equal(first.operations.length, 2);
  assert(first.nextOffset);
  assert(!first.operations[0].inputSchema);
  const next = registry.discover({ path: "todo.workitem", offset: first.nextOffset, limit: 2, revision: first.revision });
  assert.notEqual(next.operations[0].id, first.operations[0].id);
  const result = registry.discover({ query: "add_workitem", limit: 1 }, true);
  assert.equal(result.operations[0].id, "todo.workitem.create");
  assert(result.operations[0].inputSchema.properties.item);
  assert.throws(() => registry.discover({ limit: 11 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => registry.discover({ path: "todo/" }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => registry.discover({ revision: "0".repeat(64) }), { code: "CONFLICT" });
  assert.throws(() => registry.discover({ role: "user" }), { code: "INVALID_ARGUMENT" });
});

test("compact native tools reduce schemas, preserve selected leaves and retain exact leaf approval", async () => {
  let invoked = 0;
  const leaves = todoApiDefinitions.map(api => ({ name: api.name, description: api.description, parameters: api.parameters,
    execute: async () => { invoked++; throw new Error("Leaf approval declined"); } }));
  const compact = capabilityTools(leaves, todoCapabilities, true);
  assert.equal(compact.length, 5);
  const measure = tools => Buffer.byteLength(JSON.stringify(tools.map(({ execute, ...tool }) => tool)));
  assert(measure(compact) < measure(leaves) * 0.4, "compact tool definitions must be less than 40% of pilot legacy bytes");
  const write = compact.find(tool => tool.name === "capability_call"), read = compact.find(tool => tool.name === "capability_read");
  const args = { operation: "todo.workitem.claim", version: 1,
    arguments: { board_slug: "Board", id: "task", expected_digest: "0".repeat(64) } };
  await assert.rejects(read.execute(args, new AbortController().signal), { code: "ACCESS_DENIED" });
  assert.equal(invoked, 0);
  await assert.rejects(write.execute(args, new AbortController().signal), /Leaf approval declined/);
  assert.equal(invoked, 1);
  const selected = capabilityTools([leaves[0]], todoCapabilities, true);
  assert(!selected.some(tool => tool.name === "capability_call"));
  const describe = selected.find(tool => tool.name === "capabilities_describe");
  await assert.rejects(describe.execute({ operation: "todo.workitem.claim" }), { code: "NOT_AVAILABLE" });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(write.execute(args, cancelled.signal), { code: "CANCELLED" });
  assert.equal(invoked, 1);
  console.log(JSON.stringify({ pilotLegacySchemaBytes: measure(leaves), compactSchemaBytes: measure(compact), legacyTools: leaves.length, compactTools: compact.length }));
});

test("shared capability dispatch preserves real Todo CAS, task ownership and acceptance authority", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-capability-test-"));
  store.setStorePath(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  store.todoBoardCreate("Board", "Board", "");
  const call = (operation, args, mutation = false, actor = "mcp:external") =>
    callCapabilityService(mutation ? "call" : "read", { operation, version: 1, arguments: args }, actor);
  const board = (await call("todo.board.get", { board_slug: "Board" })).result;
  const created = (await call("todo.workitem.create", { board_slug: "Board", expected_digest: board.digest,
    item: { id: "task", title: "Task", goal: "Pilot", scope: "Test", acceptance: ["Pass"] } }, true)).result;
  await assert.rejects(call("todo.workitem.claim", { board_slug: "Board", id: "task", expected_digest: board.digest }, true), /changed|digest|conflict/i);
  const claimed = (await call("todo.workitem.claim", { board_slug: "Board", id: "task", expected_digest: created.digest }, true)).result;
  assert.equal(claimed.item.ownerId, "mcp:external");
  await assert.rejects(call("todo.workitem.accept", { board_slug: "Board", id: "task", expected_digest: claimed.digest, reason: "Self approve" }, true), /review|accept|Done/i);
  await assert.rejects(call("todo.workitem.claim", { board_slug: "Board", id: "task", expected_digest: claimed.digest }), { code: "ACCESS_DENIED" });
  await assert.rejects(callCapabilityService("read", { operation: "todo.board.get", version: 2, arguments: { board_slug: "Board" } }, "mcp:external"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => validateCapabilityInput({ actorId: "user" }, { type: "object", properties: {}, additionalProperties: false }), { code: "INVALID_ARGUMENT" });
});

test("Harness records bounded canonical invocation versions, not arbitrary supplied metadata", () => {
  const result = capabilityObservations({ toolCalls: [
    { id: "call", name: "capability_read", status: "complete", arguments: '{"operation":"todo.board.get","version":1}',
      result: JSON.stringify({ catalogRevision: "a".repeat(64), result: { privateContent: "not duplicated" } }) },
    { id: "bad", name: "capability_call", status: "failed", arguments: '{"operation":"../private","version":{"secret":"no"}}', result: '{"catalogRevision":"private"}' },
  ] });
  assert.equal(result[0].operation, "todo.board.get");
  assert.equal(result[0].catalogRevision, "a".repeat(64));
  assert.equal(result[1].operation, undefined);
  assert.equal(result[1].version, undefined);
  assert.equal(result[1].catalogRevision, undefined);
  assert(!JSON.stringify(result).includes("not duplicated"));
});
