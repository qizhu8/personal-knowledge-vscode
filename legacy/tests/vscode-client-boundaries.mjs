import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { VscodeClient } from "../next-server/clients/vscode/client.ts";
import { ChatActivity, ManagerActivity } from "../next-server/clients/vscode/activity.ts";
import { registerCommands } from "../next-server/clients/vscode/index.ts";
import { httpCall, invocation, managerActor, nativeWorkspace } from "../next-server/tests/batch06-manager-fixtures.mjs";

test("wrong workspace fails closed; abort marks exact edit uncertain and a failed retry retains it", async t => {
  const f = await nativeWorkspace(t);
  const authenticatedActor = { ...managerActor };
  const url = await f.listen(authenticatedActor);
  const workspaceId = await f.storage.workspaceId();
  let mode = "normal";
  let entered;
  const host = {
    secrets: { get: async () => f.bearer },
    attestServer: async (_origin, info) => ({ serverId: info.serverId, workspaceId: info.workspaceId,
      actorId: info.actorId, protocolVersion: info.protocolVersion }),
    async fetch(url, init) {
      if (mode === "hold" && url.endsWith("/capability_call")) {
        entered();
        await new Promise(resolve => init.signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("aborted");
      }
      if (mode === "busy" && url.endsWith("/capability_call")) {
        return new Response(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "test",
          error: { code: "BUSY", effect: "not-committed" } }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return fetch(url, init);
    },
  };
  const wrong = new VscodeClient(host, { origin: url, secretKey: "token", expectedWorkspaceId: "different" });
  await assert.rejects(wrong.connect(), { code: "WORKSPACE_BINDING_MISMATCH" });
  assert.equal(wrong.state().status, "error");
  wrong.dispose();
  const client = new VscodeClient(host, { origin: url, secretKey: "token", expectedWorkspaceId: workspaceId });
  t.after(() => client.dispose());
  await client.connect();
  assert.equal(JSON.stringify(client).includes(f.bearer), false);
  const id = "abort-document";
  assert.equal((await httpCall(url, f.bearer, "capability_call", invocation("knowledge.document.create",
    { id, operationId: randomUUID(), title: "test", content: "unchanged" }))).status, 200);
  const document = await client.knowledgeGet({ id });
  const operationId = randomUUID();
  const ready = new Promise(resolve => { entered = resolve; });
  mode = "hold";
  const pending = client.knowledgeEdit({ id, operationId, expectedRevision: document.revision,
    expectedSha256: document.sha256, title: "updated", content: "updated" });
  await ready;
  client.disconnect();
  await assert.rejects(pending, { code: "REQUEST_ABORTED", effect: "unknown" });
  assert.deepEqual(client.state().pending, [operationId]);
  mode = "normal";
  authenticatedActor.id = "other-actor";
  await client.connect();
  await assert.rejects(client.retryMutation(operationId), { code: "RETRY_BINDING_MISMATCH" });
  assert.deepEqual(client.state().pending, [operationId]);
  authenticatedActor.id = managerActor.id;
  await client.connect();
  mode = "busy";
  await assert.rejects(client.retryMutation(operationId), { code: "BUSY" });
  assert.deepEqual(client.state().pending, [operationId]);
  mode = "normal";
  assert.equal((await client.retryMutation(operationId)).content, "updated");
  assert.deepEqual(client.state().pending, []);
});

test("activity gap and invalid cursor states are observable without hiding early results", async () => {
  const manager = new ManagerActivity({
    async managerEvents() { return { schema: "pkm.manager.progress.events/v1", runId: "run", nextSeq: 3,
      nextCursor: "cursor123", hasMore: false, gaps: [{ fromSeq: 1, toSeq: 1 }],
      events: [{ sequence: 2, eventId: "x", kind: "result", result: { verificationStatus: "pending" } }] }; },
  }, "run");
  const result = await manager.next();
  assert.equal(result.gap, true);
  assert.equal(result.events[0].result.verificationStatus, "pending");
  const chat = new ChatActivity({ async chatEvents() { return { next: null, events: [{ sequence: 2, type: "delta" }] }; } }, "turn");
  assert.equal((await chat.next()).gap, true);
  const invalid = new ManagerActivity({ async managerEvents() {
    return { schema: "pkm.manager.progress.events/v1", runId: "other", events: [], nextSeq: 0,
      nextCursor: "cursor123", hasMore: false, gaps: [] };
  } }, "run");
  await assert.rejects(invalid.next(), { code: "INVALID_CURSOR" });
});

test("native review command is host-only and disposal does not cancel server work", async () => {
  const registered = new Map();
  let review = 0;
  const hooks = registerCommands({ registerCommand(id, handler) {
    registered.set(id, handler); return { dispose() { registered.delete(id); } };
  } }, { async connect() {}, disconnect() {}, async openHumanReview() { review++; } });
  await registered.get("pkm.next.openHumanReview")();
  assert.equal(review, 1);
  hooks.dispose();
  assert.equal(registered.size, 0);
});
