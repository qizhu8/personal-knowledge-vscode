import test from "node:test";
import assert from "node:assert/strict";
import { ProtocolClient, ProtocolError, LiveFeed } from "../next-server/browser/protocol.mjs";
import { syntheticServer, until } from "./browser-client-fixture.mjs";

test("shared protocol bootstraps exact contracts, reads and writes with native envelopes", async () => {
  const server = await syntheticServer();
  const client = new ProtocolClient({ origin: server.origin });
  try {
    await assert.rejects(client.bootstrap(), { code: "AUTHENTICATION_REQUIRED" });
    client.authenticate(server.token);
    assert.equal((await client.bootstrap()).name, "pkm-next");
    assert.ok(client.available("knowledgeList"));
    assert.ok(client.available("chatStart"));
    assert.equal((await client.call("knowledgeGet", { id: "doc-1" })).id, "doc-1");
    await client.call("chatCreate", { id: "chat-new", operationId: "same-operation", expectedRevision: 0, title: "New Chat" });
    const write = server.calls.find(call => call.path === "/v1/capability_call" && call.body.operation === "chat.session.create");
    assert.equal(write.path, "/v1/capability_call");
    assert.deepEqual(write.body, { operation: "chat.session.create", version: 1,
      arguments: { id: "chat-new", operationId: "same-operation", expectedRevision: 0, title: "New Chat" } });
    const read = server.calls.find(call => call.path === "/v1/capability_read" && call.body.operation === "knowledge.document.get");
    assert.equal(read.path, "/v1/capability_read");
    assert.equal(JSON.stringify(client).includes(server.token), false);
    client.disconnect();
    assert.equal(client.available("chatStart"), false);
    await assert.rejects(client.request("server_info", {}), { code: "AUTHENTICATION_REQUIRED" });
  } finally { client.dispose(); await server.close(); }
});

test("unconfigured native generation is explicitly unavailable without a write request", async () => {
  const server = await syntheticServer({ supported: new Set(["knowledge.document.list"]) });
  const client = new ProtocolClient({ origin: server.origin });
  try {
    client.authenticate(server.token);
    await client.bootstrap();
    assert.equal(client.available("chatStart"), false);
    await assert.rejects(client.call("chatStart", {}), { code: "CAPABILITY_UNAVAILABLE" });
    assert.equal(server.calls.some(call => call.path === "/v1/capability_call"), false);
  } finally { client.dispose(); await server.close(); }
});

test("host endpoint, credentials and redirects cannot be supplied by user-controlled operation mapping", async () => {
  assert.throws(() => new ProtocolClient({ origin: "https://name:password@host.invalid" }), { code: "UNSAFE_ORIGIN" });
  assert.throws(() => new ProtocolClient({ origin: "file:///etc/passwd" }), { code: "UNSAFE_ORIGIN" });
  assert.throws(() => new ProtocolClient({ origin: "http://127.0.0.1:1", operations: {
    bad: { operation: "//evil.invalid", readOnly: true },
  } }), { code: "INVALID_HOST_CONFIGURATION" });
  const old = globalThis.location;
  globalThis.location = { origin: "https://workspace.invalid" };
  try { assert.throws(() => new ProtocolClient({ origin: "https://elsewhere.invalid" }), { code: "UNSAFE_ORIGIN" }); }
  finally { if (old === undefined) delete globalThis.location; else globalThis.location = old; }
  let captured;
  const client = new ProtocolClient({ origin: "http://127.0.0.1:1", fetch: async (_, init) => {
    captured = init;
    return new Response(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "x", result: {} }), { headers: { "Content-Type": "application/json" } });
  } });
  client.authenticate("secret");
  await client.request("server_info", {});
  assert.equal(captured.redirect, "error");
  assert.equal(captured.credentials, "same-origin");
  assert.equal(captured.cache, "no-store");
  client.dispose();
});

test("transport uncertainty never retries writes; sensitive server messages are not exposed", async () => {
  let calls = 0;
  const client = new ProtocolClient({ origin: "http://127.0.0.1:1", fetch: async () => { calls++; throw new Error("SECRET"); } });
  client.authenticate("SECRET");
  await assert.rejects(client.request("capability_call", {}, undefined, true), error => {
    assert.equal(error.effect, "unknown");
    assert.equal(error.message.includes("SECRET"), false);
    return true;
  });

  assert.equal(calls, 1);
  client.dispose();
  const rejected = new ProtocolClient({ origin: "http://127.0.0.1:1", fetch: async () =>
    new Response(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "x",
      error: { code: "CONFLICT", message: "SECRET token echo", effect: "not-committed" } }), { status: 409, headers: { "Content-Type": "application/json" } }) });
  rejected.authenticate("SECRET");
  await assert.rejects(rejected.request("server_info", {}), error => error.message === "CONFLICT");
  rejected.dispose();
});

test("unknown mutation blocks replacement and explicit retry uses identical durable operation body", async () => {
  let attempt = 0;
  const bodies = [];
  const server = await syntheticServer({ handle: (operation, args, req, res) => {
    if (operation === "chat.session.create") {
      bodies.push(args);
      attempt++;
      if (attempt === 1) { res.destroy(); return; }
      return { id: args.id, revision: 1, title: "New Chat" };
    }
  } });
  const client = new ProtocolClient({ origin: server.origin });
  try {
    client.authenticate(server.token);
    await client.bootstrap();
    const input = { id: "chat-id", operationId: "identical-op-id", expectedRevision: 0, title: "New Chat" };
    await assert.rejects(client.call("chatCreate", input), { effect: "unknown" });
    input.operationId = "changed-after-failure";
    await assert.rejects(client.call("chatCreate", input), { code: "PENDING_OUTCOME_UNKNOWN" });
    assert.equal(attempt, 1);
    assert.deepEqual(client.pendingMutations(), ["chatCreate"]);
    const recovered = await client.retryMutation("chatCreate");
    assert.equal(recovered.result.id, "chat-id");
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[1].operationId, "identical-op-id");
    assert.deepEqual(client.pendingMutations(), []);
  } finally { client.dispose(); await server.close(); }
});

test("request timeout and disposal abort pending network work", async () => {
  const signals = [];
  const client = new ProtocolClient({ origin: "http://127.0.0.1:1", timeoutMs: 10, fetch: (_, init) =>
    new Promise((_, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
  client.authenticate("secret");
  await assert.rejects(client.request("server_info", {}), { code: "REQUEST_ABORTED" });
  const pending = client.request("server_info", {});
  client.dispose();
  await assert.rejects(pending, { code: "REQUEST_ABORTED" });
  assert.ok(signals.every(signal => signal.aborted));
});

test("live poll deduplicates replay, drains pages and resumes exclusive cursor after errors", async () => {
  const events = [];
  const cursors = [];
  const statuses = [];
  let step = 0;
  const feed = new LiveFeed({
    intervalMs: 1, event: event => events.push(event.seq), status: status => statuses.push(status),
    read: async cursor => {
      cursors.push(cursor);
      step++;
      if (step === 1) return { events: [{ seq: 1, type: "worker.delivery" }], next: 1, more: true };
      if (step === 2) throw new ProtocolError("BUSY");
      return { events: [{ seq: 1, type: "worker.delivery" }, { seq: 2, type: "e2e.checked" }], next: 2, terminal: true };
    },
  });
  feed.start();
  await until(() => statuses.includes("Live updates complete"));
  assert.deepEqual(events, [1, 2]);
  assert.deepEqual(cursors, [0, 1, 1]);
  feed.dispose();
});

test("poll failure budget stops visibly, explicit reconnect retains cursor, dispose cancels pending read", async () => {
  let fail = true;
  let calls = 0;
  let signal;
  const statuses = [];
  const feed = new LiveFeed({
    intervalMs: 1, maxFailures: 2, event: () => {}, status: value => statuses.push(value),
    read: async (cursor, currentSignal) => {
      calls++; signal = currentSignal;
      if (fail) throw new Error("offline");
      return { events: [{ seq: cursor + 1, type: "result" }], next: cursor + 1, terminal: true };
    },
  });
  feed.start();
  await until(() => statuses.some(value => value.startsWith("Live updates stopped")));
  assert.equal(calls, 2);
  fail = false;
  feed.reconnect();
  await until(() => statuses.includes("Live updates complete"));
  assert.equal(feed.cursor, 1);
  assert.equal(signal.aborted, true);
  const pending = new LiveFeed({
    read: (_, currentSignal) => new Promise(() => { signal = currentSignal; }),
    event: () => {}, status: () => {},
  });
  pending.start();
  pending.dispose();
  assert.equal(signal.aborted, true);
});
