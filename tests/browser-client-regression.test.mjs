// Supplementary unit regressions; visual qualification lives in batch06-browser.test.mjs.
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { ProtocolClient, OPERATIONS } from "../browser/protocol.mjs";
import { mount } from "../browser/workspace.mjs";

let fixtures;
const retainedTests = new URL("../legacy/tests/", import.meta.url).href;
const browserModules = new Map(["protocol.mjs", "workspace.mjs"].map(name => [
  `../next-server/browser/${name}`, new URL(name === "protocol.mjs"
    ? "./browser-client-protocol-fixture.mjs" : `../browser/${name}`, import.meta.url).href,
]));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = context.parentURL?.startsWith(retainedTests) && browserModules.get(specifier);
    return nextResolve(target || specifier, context);
  },
});
try {
  await import("../legacy/tests/browser-client-protocol.test.mjs");
  await import("../legacy/tests/browser-client-dom.test.mjs");
  fixtures = await import("../legacy/tests/browser-client-fixture.mjs");
} finally {
  hooks.deregister();
}

function identityFixture(pendingStorage) {
  let identity = { workspaceId: "workspace-1", actorId: "actor-1" };
  let mutate = async () => { throw new Error("response lost"); };
  let info = async () => identity;
  const bodies = [];
  const client = new ProtocolClient({
    origin: "http://127.0.0.1:1",
    pendingStorage,
    operations: { chatCreate: { operation: "chat.session.create", readOnly: false } },
    fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      let result;
      if (Object.hasOwn(body, "arguments")) {
        bodies.push(init.body);
        result = await mutate(body);
      } else if (body.operation) result = { operation: body.operation, version: 1, readOnly: false };
      else result = await info();
      return new Response(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "fixture", result }),
        { headers: { "content-type": "application/json" } });
    },
  });
  return {
    client, bodies,
    setIdentity(value) { identity = value; },
    setMutation(value) { mutate = value; },
    setInfo(value) { info = value; },
    async connect() { client.authenticate("fixture-token"); await client.bootstrap(); },
  };
}
const chatInput = () => ({ id: "chat-new", operationId: "original-operation", expectedRevision: 0, title: "New Chat" });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("native Stop keeps observing cancellation when a stale in-flight status consumes its timer", async () => {
  const source = await readFile(new URL("../browser/webview-chat.js", import.meta.url), "utf8");
  const pending = deferred(), timers = new Map(), calls = [];
  let nextTimer = 0;
  const ref = { chatId: "chat", turnId: "turn" };
  const ui = {
    nativeRef: ref, nativeStatus: "running", nativeChecking: false, nativeTimer: undefined,
    sameNative: candidate => candidate === ref,
    nativeDone: status => ["completed", "cancelled", "not-sent"].includes(status),
    caps: { nativeTranscript: false }, selectedId: "chat", turnState: {}, update() {},
    sessionStorage: { removeItem() {} }, check: { addEventListener() {} },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    call(name) { calls.push(name); return calls.length === 1 ? pending.promise : Promise.resolve({ status: "cancelled" }); },
  };
  vm.createContext(ui);
  vm.runInContext(source.slice(source.indexOf("  function applyNative("), source.indexOf("  async function startNative(")), ui);
  const runTimer = () => {
    const [id, callback] = timers.entries().next().value;
    timers.delete(id); callback();
  };
  const checking = ui.checkNative(ref);
  ui.applyNative(ref, "stop-requested");
  runTimer();
  assert.equal(timers.size, 0);
  pending.resolve({ status: "running" });
  await checking;
  assert.equal(ui.nativeStatus, "stop-requested", "A stale response must not undo Stop.");
  assert.equal(timers.size, 1, "Completion of an in-flight check must restore the consumed observation timer.");
  runTimer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.nativeStatus, "cancelled");
  assert.match(ui.turnState.textContent, /upstream cancellation is not confirmed/);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls, ["originalChatStatus", "originalChatStatus"], "Observation never replays Stop or Send.");
});

test("generic Browser write pins survive reload without sensitive bodies, replacement dispatch or replay", async () => {
  const values = new Map(), storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  let actorId = "actor-1", writes = 0, receiptState = "unknown", forged = "";
  const token = "private-bearer-value", input = {
    id: "private-document-id", title: "private-title", content: "private-content", operationId: randomUUID(),
  };
  const create = () => new ProtocolClient({
    origin: "http://127.0.0.1:1", pendingStorage: storage,
    operations: { write: { operation: "knowledge.document.create", readOnly: false }, receiptGet: OPERATIONS.receiptGet },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/capability_call")) {
        writes++;
        const [marker] = [...values.values()].map(JSON.parse);
        assert.equal(marker.bodySha256, createHash("sha256").update(init.body).digest("hex"));
        throw new Error("Committed response lost");
      }
      let result = body.operation ? { operation: body.operation, version: 1, readOnly: body.operation === "operation.receipt.get" }
        : { workspaceId: "workspace-1", actorId };
      if (url.endsWith("/capability_read")) {
        result = { schema: "pkm.operation.receipt/v1", state: receiptState,
          ...(receiptState === "committed" ? { ...body.arguments, actorId: forged === "actor" ? "actor-2" : actorId,
            bodySha256: forged === "hash" ? "b".repeat(64) : body.arguments.bodySha256, receiptSha256: "a".repeat(64) } : {}) };
      }
      return new Response(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "fixture", result }),
        { headers: { "content-type": "application/json" } });
    },
  });
  let client = create();
  client.authenticate(token); await client.bootstrap();
  await assert.rejects(client.call("write", input), { effect: "unknown" });
  const serialized = JSON.stringify([...values.values()]);
  for (const secret of [token, input.id, input.title, input.content, '"arguments"']) assert(!serialized.includes(secret));
  assert(serialized.includes(input.operationId));
  client.dispose();
  client = create();
  try {
    client.authenticate(token); await client.bootstrap();
    assert.deepEqual(client.pendingMutations(), ["write"]);
    assert.equal(client.canRetryMutation("write"), false);
    await assert.rejects(client.call("write", { ...input, operationId: randomUUID() }), { code: "PENDING_OUTCOME_UNKNOWN" });
    assert.equal(writes, 1);
    actorId = "actor-2"; client.authenticate(token); await client.bootstrap();
    assert.deepEqual(client.pendingMutations(), []);
    actorId = "actor-1"; client.authenticate(token); await client.bootstrap();
    assert.deepEqual(client.pendingMutations(), ["write"]);
    const markerKey = [...values.keys()][0], original = values.get(markerKey);
    storage.setItem(markerKey, "{invalid");
    assert.equal(client.mutationRecovery().blocked, true);
    await assert.rejects(client.call("write", input), { code: "PENDING_OUTCOME_UNKNOWN" });
    assert.equal(writes, 1);
    storage.setItem(markerKey, original);
    for (receiptState of ["unknown", "pending"]) {
      assert.equal(await client.reconcileMutation(markerKey), receiptState);
      assert.equal(values.size, 1);
    }
    receiptState = "committed";
    for (forged of ["actor", "hash"]) {
      await assert.rejects(client.reconcileMutation(markerKey), { code: "INVALID_CONTRACT" });
      assert.equal(values.size, 1);
    }
    forged = "";
    assert.equal(await client.reconcileMutation(markerKey), "committed");
    assert.equal(values.size, 0);
    assert.deepEqual(client.pendingMutations(), []);
    assert.equal(writes, 1, "Reconciliation is a read, not a replay.");
  } finally { client.dispose(); }
});

test("durable write journal refuses unavailable/full storage and clears only an explicitly recovered receipt", async t => {
  for (const mode of ["unavailable", "full", "invalid-operation-id", "explicit-receipt"]) await t.test(mode, async () => {
    const values = new Map(), storage = {
      get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
      getItem: key => values.get(key) ?? null,
      setItem(key, value) { if (mode === "unavailable") throw new Error("Quota exceeded"); values.set(key, value); },
      removeItem: key => values.delete(key),
    };
    if (mode === "full") for (let index = 0; index < 64; index++) values.set(`pkm.pending-write.v1:${index}`, JSON.stringify({
      schema: "pkm.pending-write/v1", workspaceId: "other-workspace", actorId: "actor-1",
      operation: "knowledge.document.create", operationId: randomUUID(), bodySha256: "a".repeat(64),
    }));
    const f = identityFixture(storage), input = { ...chatInput(),
      operationId: mode === "invalid-operation-id" ? "Bearer must-not-be-persisted" : randomUUID() };
    try {
      await f.connect();
      if (mode === "explicit-receipt") {
        await assert.rejects(f.client.call("chatCreate", input), { effect: "unknown" });
        assert.equal(values.size, 1);
        f.setMutation(async body => ({ id: body.arguments.id }));
        await f.client.retryMutation("chatCreate");
        assert.equal(values.size, 0);
        assert.equal(f.bodies[0], f.bodies[1]);
        assert.deepEqual(f.client.pendingMutations(), []);
      } else {
        await assert.rejects(f.client.call("chatCreate", input), {
          code: mode === "unavailable" ? "PENDING_JOURNAL_UNAVAILABLE"
            : mode === "full" ? "PENDING_JOURNAL_FULL" : "INVALID_OPERATION_ID",
        });
        assert.equal(f.bodies.length, 0);
        assert.equal(values.size, mode === "full" ? 64 : 0);
      }
    } finally { f.client.dispose(); }
  });
});

test("browser uncertainty survives disconnect and only retries under its original workspace and actor", async t => {
  for (const changed of [{ workspaceId: "workspace-2", actorId: "actor-1" },
    { workspaceId: "workspace-1", actorId: "actor-2" }]) {
    await t.test(JSON.stringify(changed), async () => {
      const f = identityFixture();
      try {
        await f.connect();
        await assert.rejects(f.client.call("chatCreate", chatInput()), { effect: "unknown" });
        f.setIdentity(changed);
        await f.connect();
        assert.deepEqual(f.client.pendingMutations(), ["chatCreate"]);
        assert.equal(f.client.canRetryMutation("chatCreate"), false);
        await assert.rejects(f.client.retryMutation("chatCreate"), { code: "RETRY_BINDING_MISMATCH" });
        await assert.rejects(f.client.call("chatCreate", { ...chatInput(), operationId: "replacement" }),
          { code: "PENDING_OUTCOME_UNKNOWN" });
        assert.equal(f.bodies.length, 1);
        f.setIdentity({ workspaceId: "workspace-1", actorId: "actor-1" });
        f.setMutation(async body => ({ id: body.arguments.id }));
        await f.connect();
        assert.equal(f.client.canRetryMutation("chatCreate"), true);
        await f.client.retryMutation("chatCreate");
        assert.equal(f.bodies[0], f.bodies[1]);
        assert.deepEqual(f.client.pendingMutations(), []);
      } finally { f.client.dispose(); }
    });
  }
});

test("browser reserves mutations before dispatch and stale successes cannot erase their uncertainty", async () => {
  const f = identityFixture(), completion = deferred();
  f.setMutation(() => completion.promise);
  try {
    await f.connect();
    const pending = f.client.call("chatCreate", chatInput());
    const rejected = assert.rejects(pending, { code: "REQUEST_ABORTED", effect: "unknown" });
    assert.deepEqual(f.client.pendingMutations(), ["chatCreate"]);
    assert.equal(f.client.canRetryMutation("chatCreate"), false);
    await assert.rejects(f.client.call("chatCreate", chatInput()), { code: "PENDING_OUTCOME_UNKNOWN" });
    await assert.rejects(f.client.retryMutation("chatCreate"), { code: "NO_RETRYABLE_OPERATION" });
    f.client.disconnect();
    await f.connect();
    assert.equal(f.client.canRetryMutation("chatCreate"), false);
    completion.resolve({ id: "late-success" });
    await rejected;
    assert.deepEqual(f.client.pendingMutations(), ["chatCreate"]);
    assert.equal(f.client.canRetryMutation("chatCreate"), true);
    f.setMutation(async body => ({ id: body.arguments.id }));
    await f.client.retryMutation("chatCreate");
    assert.equal(f.bodies[0], f.bodies[1]);
  } finally { completion.resolve({}); f.client.dispose(); }
});

test("stale browser bootstrap cannot publish capabilities or retry identity after reconnect", async () => {
  const f = identityFixture(), oldInfo = deferred();
  try {
    f.setInfo(() => oldInfo.promise);
    f.client.authenticate("old-token");
    const bootstrap = f.client.bootstrap();
    const rejected = assert.rejects(bootstrap, { code: "REQUEST_ABORTED" });
    f.setInfo(async () => ({ workspaceId: "workspace-2", actorId: "actor-2" }));
    await f.connect();
    oldInfo.resolve({ workspaceId: "workspace-1", actorId: "actor-1" });
    await rejected;
    await assert.rejects(f.client.call("chatCreate", chatInput()), { effect: "unknown" });
    f.setInfo(async () => ({ workspaceId: "workspace-1", actorId: "actor-1" }));
    await f.connect();
    assert.equal(f.client.canRetryMutation("chatCreate"), false);
  } finally { oldInfo.resolve({}); f.client.dispose(); }
});

test("stale in-flight browser retry keeps its original body and cannot be retried concurrently", async () => {
  const f = identityFixture(), completion = deferred();
  try {
    await f.connect();
    await assert.rejects(f.client.call("chatCreate", chatInput()), { effect: "unknown" });
    f.setMutation(() => completion.promise);
    const retry = f.client.retryMutation("chatCreate");
    const rejected = assert.rejects(retry, { code: "REQUEST_ABORTED", effect: "unknown" });
    await assert.rejects(f.client.retryMutation("chatCreate"), { code: "NO_RETRYABLE_OPERATION" });
    f.setIdentity({ workspaceId: "workspace-2", actorId: "actor-1" });
    await f.connect();
    completion.resolve({ id: "late-receipt" });
    await rejected;
    assert.deepEqual(f.client.pendingMutations(), ["chatCreate"]);
    await assert.rejects(f.client.retryMutation("chatCreate"), { code: "RETRY_BINDING_MISMATCH" });
    assert.equal(f.bodies.length, 2);
    assert.equal(f.bodies[0], f.bodies[1]);
  } finally { completion.resolve({}); f.client.dispose(); }
});

test("browser bootstrap rejects missing identity instead of allowing unbound writes", async () => {
  const f = identityFixture();
  try {
    f.setInfo(async () => ({}));
    await assert.rejects(f.connect(), { code: "INVALID_CONTRACT" });
    await assert.rejects(f.client.call("chatCreate", chatInput()), { code: "CAPABILITY_UNAVAILABLE" });
    assert.equal(f.bodies.length, 0);
  } finally { f.client.dispose(); }
});

test("workspace preserves blocked uncertainty and disables retry when reconnected to another actor", async () => {
  const { fixtureDOM, field, submit, action, until } = fixtures;
  const f = identityFixture(), dom = fixtureDOM();
  const workspace = mount(dom.root, { client: f.client });
  const connect = async () => {
    field(dom.root, "Access token").value = "fixture-token";
    submit(field(dom.root, "Access token"));
    await until(() => dom.root.textContent.includes("Connected · isolated shared server"));
  };
  try {
    await connect();
    await assert.rejects(f.client.call("chatCreate", chatInput()), { effect: "unknown" });
    f.setIdentity({ workspaceId: "workspace-1", actorId: "actor-2" });
    await connect();
    assert.equal(action(dom.root, "Retry identical pending operation").hidden, false);
    assert.equal(action(dom.root, "Retry identical pending operation").disabled, true);
    assert.equal(action(dom.root, "New Chat").disabled, true);
    assert.deepEqual(f.client.pendingMutations(), ["chatCreate"]);
    assert.equal(f.bodies.length, 1);
  } finally { workspace.dispose(); }
});

function continuityFixture({ unavailable = [], lostStart = false } = {}) {
  const calls = [], turns = [], receipts = new Map(), records = new Map(["a", "b"].map(id =>
    [id, { id, title: `Chat ${id}`, revision: 1, transcript: [] }]));
  const supported = Object.fromEntries(Object.entries(OPERATIONS).filter(([key]) =>
    key.startsWith("chat") && !unavailable.includes(key)));
  let eventFailures = false, beforeMessages;
  const complete = (turn, status = "completed", output = "Durable answer") => {
    Object.assign(turn, { status, output, revision: turn.revision + 1 });
    const record = records.get(turn.sessionId);
    record.transcript.push({ role: "assistant", content: output, status: status === "completed" ? "complete" : status });
    record.revision++;
  };
  const client = new ProtocolClient({
    origin: "http://127.0.0.1:1", operations: supported,
    fetch: async (_, init) => {
      const body = JSON.parse(init.body), args = body.arguments;
      calls.push(body);
      let result, error;
      if (!body.operation) result = { workspaceId: "continuity", actorId: "owner" };
      else if (!args) {
        const operation = Object.values(supported).find(item => item.operation === body.operation);
        if (operation) result = { ...operation, version: 1 };
        else error = { code: "NOT_FOUND", effect: "not-committed" };
      }
      else {
        const record = records.get(args.sessionId ?? args.id);
        switch (body.operation) {
          case "chat.session.list": result = { items: [...records.values()], nextCursor: null }; break;
          case "chat.session.get": result = { ...record }; break;
          case "chat.session.messages":
            await beforeMessages?.(args);
            result = { items: record.transcript, hasMore: false, nextCursor: "end" }; break;
          case "chat.turn.list": {
            const all = turns.filter(turn => turn.sessionId === args.sessionId);
            const index = args.after ? all.findIndex(turn => turn.id === args.after) + 1 : 0;
            result = { items: all.slice(index, index + 1), next: index + 1 < all.length ? all[index].id : null };
            break;
          }
          case "chat.turn.start": {
            if (receipts.has(args.id)) { result = receipts.get(args.id); break; }
            assert.equal(args.expectedSessionRevision, record.revision);
            assert.equal(args.messages.length, 1);
            assert.equal(args.messages[0].role, "user");
            record.transcript.push({ ...args.messages[0], status: "complete" });
            record.revision++;
            result = { id: args.id, sessionId: args.sessionId, status: "model", revision: 1, output: "Partial" };
            turns.push(result);
            receipts.set(args.id, structuredClone(result));
            if (lostStart) { lostStart = false; throw new Error("lost receipt"); }
            break;
          }
          case "chat.turn.get": result = turns.find(turn => turn.id === args.id); break;
          case "chat.turn.events":
            if (eventFailures) throw new Error("connection lost");
            result = { events: [], next: null }; break;
          case "chat.turn.cancel":
            result = turns.find(turn => turn.id === args.id);
            complete(result, "cancelled", "Partial");
            break;
          default: error = { code: "NOT_AVAILABLE", effect: "not-committed" };
        }
      }
      return new Response(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "continuity", ...(error ? { error } : { result }) }),
        { headers: { "content-type": "application/json" } });
    },
  });
  const dom = fixtures.fixtureDOM(), workspace = mount(dom.root, { client, intervalMs: 1 });
  return {
    ...dom, calls, turns, records, complete, client,
    setEventFailures(value) { eventFailures = value; },
    setBeforeMessages(value) { beforeMessages = value; },
    async connect() {
      fixtures.field(dom.root, "Access token").value = "fixture-token";
      fixtures.submit(fixtures.field(dom.root, "Access token"));
      await fixtures.until(() => fixtures.action(dom.root, "Chat a"));
    },
    async select(id = "a") {
      fixtures.click(fixtures.action(dom.root, `Chat ${id}`));
      await fixtures.until(() => fixtures.action(dom.root, "Reconnect updates").disabled === false);
    },
    async send(content) {
      fixtures.field(dom.root, "Message").value = content;
      fixtures.submit(fixtures.field(dom.root, "Message"));
      await fixtures.until(() => turns.some(turn => turn.messages?.[0]?.content === content) ||
        calls.some(call => call.operation === "chat.turn.start" && call.arguments?.messages[0].content === content));
    },
    messages() { return fixtures.field(dom.root, "Messages").children.map(item => item.textContent); },
    close() { workspace.dispose(); },
  };
}

test("Chat submits only the new user with server revision, reattaches and renders terminal transcript exactly once", async () => {
  const f = continuityFixture();
  try {
    f.records.get("a").transcript.push({ role: "assistant", content: "Recorded prior context", status: "complete" });
    await f.connect(); await f.select();
    await f.send("First input");
    await fixtures.until(() => f.messages().some(message => message.includes("Partial")));
    assert.equal(fixtures.action(f.root, "Send").disabled, true);
    const start = f.calls.find(call => call.operation === "chat.turn.start" && call.arguments);
    assert.equal(start.arguments.expectedSessionRevision, 1);
    assert.equal(start.arguments.expectedRevision, 0);
    assert.deepEqual(start.arguments.messages, [{ role: "user", content: "First input" }]);
    await f.select("b"); await f.select("a");
    assert.equal(f.messages().filter(message => message.includes("First input")).length, 1);
    assert.equal(f.messages().filter(message => message.includes("Partial")).length, 1);
    f.complete(f.turns[0]);
    await fixtures.until(() => fixtures.action(f.root, "Send").disabled === false);
    assert.deepEqual(f.messages(), ["assistant · completeRecorded prior context", "user · completeFirst input", "assistant · completeDurable answer"]);
    await f.send("Second input");
    await fixtures.until(() => f.turns.length === 2);
    const second = f.calls.filter(call => call.operation === "chat.turn.start" && call.arguments)[1];
    assert.equal(second.arguments.expectedSessionRevision, 3);
    assert.deepEqual(second.arguments.messages, [{ role: "user", content: "Second input" }]);
    await fixtures.until(() => fixtures.action(f.root, "Cancel turn").disabled === false);
    fixtures.click(fixtures.action(f.root, "Cancel turn"));
    await fixtures.until(() => f.root.textContent.includes("Turn cancelled"));
    assert.equal(fixtures.action(f.root, "Cancel turn").disabled, true);
    assert.equal(f.messages().filter(message => message.includes("Partial")).length, 1);
    assert(f.calls.some(call => call.operation === "chat.turn.list" && call.arguments?.after === f.turns[0].id));
    assert.equal(f.calls.some(call => call.operation === "chat.session.append"), false);
  } finally { f.close(); }
});

test("Chat reconnect recovers live read failure, lost start receipts and interrupted server observations without replay", async () => {
  const f = continuityFixture({ lostStart: true });
  try {
    await f.connect(); await f.select();
    await f.send("Uncertain input");
    await fixtures.until(() => f.root.textContent.includes("outcome unknown"));
    f.setEventFailures(true);
    fixtures.click(fixtures.action(f.root, "Reconnect updates"));
    await fixtures.until(() => f.root.textContent.includes("Live updates stopped"));
    assert.equal(f.messages().filter(message => message.includes("Uncertain input")).length, 1);
    f.setEventFailures(false);
    f.complete(f.turns[0], "interrupted", "Server interrupted observation");
    fixtures.click(fixtures.action(f.root, "Reconnect updates"));
    await fixtures.until(() => f.root.textContent.includes("Turn interrupted"));
    assert.equal(f.messages().filter(message => message.includes("Server interrupted observation")).length, 1);
    assert.equal(f.calls.filter(call => call.operation === "chat.turn.start" && call.arguments).length, 1);
    assert.deepEqual(f.client.pendingMutations(), ["chatStart"]);
    assert.equal(fixtures.action(f.root, "Send").disabled, true);
    await f.select("b");
    await f.select("a");
    assert.equal(f.messages().length, 2);
    fixtures.click(fixtures.action(f.root, "Retry identical pending operation"));
    await fixtures.until(() => f.client.pendingMutations().length === 0 && fixtures.action(f.root, "Send").disabled === false);
    assert.equal(fixtures.field(f.root, "Message").value, "");
    assert.equal(f.turns.length, 1);
    assert.equal(f.messages().length, 2);
    const starts = f.calls.filter(call => call.operation === "chat.turn.start" && call.arguments);
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[0], starts[1]);
  } finally { f.close(); }
});

test("Chat discards stale session reads and retries a transcript that changed while loading", async () => {
  const f = continuityFixture(), old = deferred();
  try {
    f.records.get("a").transcript.push({ role: "user", content: "Only a", status: "complete" });
    f.setBeforeMessages(async args => { if (args.id === "a") await old.promise; });
    await f.connect();
    fixtures.click(fixtures.action(f.root, "Chat a"));
    await fixtures.until(() => f.calls.some(call => call.operation === "chat.session.messages" && call.arguments?.id === "a"));
    await f.select("b");
    old.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(f.messages(), []);
    let changed = false;
    f.setBeforeMessages(async () => {
      if (changed) return;
      changed = true;
      f.records.get("a").revision++;
      f.records.get("a").transcript.push({ role: "assistant", content: "Concurrent durable observation", status: "complete" });
    });
    await f.select("a");
    assert.equal(f.messages().filter(message => message.includes("Concurrent durable observation")).length, 1);
    assert.equal(fixtures.action(f.root, "Send").disabled, false);
  } finally { old.resolve(); f.close(); }
});

test("Chat keeps reconnect available when a failed turn's terminal transcript refresh is unavailable", async () => {
  const f = continuityFixture();
  try {
    await f.connect(); await f.select(); await f.send("Rejected model input");
    await fixtures.until(() => f.messages().some(message => message.includes("Partial")));
    f.setBeforeMessages(async () => { throw new Error("transcript unavailable"); });
    f.turns[0].failure = "MODEL_AUTHENTICATION";
    f.complete(f.turns[0], "failed", "");
    await fixtures.until(() => f.root.textContent.includes("Live updates stopped"));
    assert.equal(fixtures.action(f.root, "Send").disabled, true);
    assert.equal(fixtures.action(f.root, "Reconnect updates").disabled, false);
    f.setBeforeMessages(undefined);
    fixtures.click(fixtures.action(f.root, "Reconnect updates"));
    await fixtures.until(() => fixtures.action(f.root, "Send").disabled === false);
    assert(f.root.textContent.includes("Turn failed · MODEL_AUTHENTICATION"));
    assert.deepEqual(f.messages(), ["user · completeRejected model input", "assistant · failed"]);
  } finally { f.close(); }
});

test("Chat cannot generate without continuity reads or a configured model and never invents model choices", async () => {
  for (const unavailable of [["chatTurns"], ["chatStart"]]) {
    const f = continuityFixture({ unavailable });
    try {
      await f.connect();
      fixtures.click(fixtures.action(f.root, "Chat a"));
      await fixtures.until(() => f.root.textContent.includes(unavailable[0] === "chatTurns" ? "Chat continuity capability unavailable" : "model/provider not configured or authorized"));
      assert.equal(fixtures.action(f.root, "Send").disabled, true);
      assert.equal(f.root.querySelectorAll("select").length, 0);
      assert.equal(f.calls.some(call => call.operation === "chat.turn.start" && call.arguments), false);
    } finally { f.close(); }
  }
});

test("real Chromium reloads server Chat, reattaches active output, cancels and preserves exactly-once transcripts", { timeout: 30_000 }, async () => {
  const f = continuityFixture(), assets = new Map();
  const scratch = `.browser-chat-runtime-${randomUUID()}`;
  for (const name of await readdir(new URL("../browser/", import.meta.url))) {
    if (/\.(mjs|css|html)$/.test(name)) assets.set(`/${name}`, await readFile(new URL(`../browser/${name}`, import.meta.url)));
  }
  assets.set("/shared-managed-client.mjs", await readFile(new URL("../dist/shared-managed-client.js", import.meta.url)));
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/v1/")) {
        if (req.headers.authorization !== "Bearer browser-fixture") { res.writeHead(401); res.end(); return; }
        let body = "";
        for await (const bytes of req) body += bytes;
        const response = await f.client.fetch("http://fixture/v1", { body });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      } else {
        const name = req.url === "/" ? "/index.html" : req.url;
        const asset = assets.get(name);
        res.writeHead(asset ? 200 : 404, { "content-type": name.endsWith(".mjs") ? "text/javascript" :
          name.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" });
        res.end(asset);
      }
    } catch { res.writeHead(500); res.end(); }
  });
  let child;
  try {
    await mkdir(scratch);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url)).status, 200);
    child = spawn(process.env.PYTHON ?? "python", ["-B", new URL("./batch06-browser-qualification.py", import.meta.url).pathname],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMPDIR: resolve(scratch), TEMP: resolve(scratch), TMP: resolve(scratch) } });
    let output = "", diagnostics = "", released = false;
    child.stdout.on("data", data => {
      output += data.toString();
      if (!released && output.includes("CHAT_ACTIVE_REATTACHED")) { released = true; f.complete(f.turns[0]); }
    });
    child.stderr.on("data", data => { diagnostics += data.toString(); });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 25_000);
    child.stdin.end(JSON.stringify({ url, token: "browser-fixture", root: ".", chat: true }) + "\n");
    let exit;
    try { [exit] = await once(child, "close"); }
    finally { clearTimeout(deadline); }
    assert.equal(exit, 0, diagnostics);
    assert.match(output, /CHAT_CONTINUITY_VERIFIED/);
    const starts = f.calls.filter(call => call.operation === "chat.turn.start" && call.arguments);
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map(call => call.arguments.messages),
      [[{ role: "user", content: "First browser input" }], [{ role: "user", content: "Second browser input" }]]);
    assert.deepEqual(starts.map(call => call.arguments.expectedSessionRevision), [1, 3]);
    assert.deepEqual(f.turns.map(turn => turn.status), ["completed", "cancelled"]);
    assert.equal(f.records.get("a").transcript.length, 4);
    assert.equal(f.calls.some(call => call.operation === "chat.session.append"), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
