import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startLegacyApiChatUiHost } from "../dist/legacy-api-chat-ui-host.js";
import { createLegacyApiChatLocalProvider } from "../dist/legacy-api-chat-local-provider.js";
const require = createRequire(import.meta.url), project = resolve(new URL("../legacy", import.meta.url).pathname);
const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");

test("private UI host authenticates the exact actor, serves original PNG/history and publishes only durable HTTP effects", async t => {
  const directory = join(project, ".migration-test-work", `api-ui-host-${randomUUID()}`), root = join(directory, "knowledge");
  let storage, native, ui, calls = 0, closeAttempts = 0;
  let releaseProvider, started;
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  const providerStarted = new Promise(resolve => { started = resolve; });
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer private-ui-test");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert(JSON.stringify(body.messages[0]).includes(`data:image/png;base64,${fixture.image.dataBase64}`));
      assert.equal(body.messages.at(-1).content[0].text, "Actual UI continuation.");
      assert(JSON.stringify(body.messages.at(-1)).includes(`data:image/png;base64,${fixture.image.dataBase64}`));
      calls++;
      started();
      await providerGate;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"DURABLE_UI_HTTP_RESPONSE"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  t.after(async () => {
    releaseProvider();
    try { await ui?.close(); } finally {
      try { await native?.close(); } finally {
        await storage?.close();
        await new Promise(resolve => provider.close(resolve));
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  let descriptor;
  const mask = process.umask(0o077);
  try {
    descriptor = fixture.create({ extension: project, root });
    mkdirSync(join(root, "notes"), { mode: 0o700 });
    writeFileSync(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic UI root.\n", { mode: 0o600 });
  } finally { process.umask(mask); }
  const source = join(descriptor.state, "api-chats", fixture.namespace, `${descriptor.inline}.json`);
  const originalHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const nonce = randomUUID(), actorId = randomUUID();
  writeFileSync(join(directory, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce }));
  storage = (await resumeLegacyRootAdoptionExperimental(root, options({ fixture: directory, root, nonce, workspaceId: prepared.workspaceId }))).storage;
  native = await createNativeRuntime({ storage, workspaceId: await storage.workspaceId() });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const identity = { namespace: fixture.namespace, chatId: descriptor.inline };
  ui = await startLegacyApiChatUiHost({ storage, actorId, chats: [identity],
    processes: { async close() { if (++closeAttempts === 1) throw new Error("Drain not confirmed."); } },
    authorize: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
    authorizeLibrary: async binding => binding.actorId === actorId && binding.workspaceId === prepared.workspaceId,
    provider: createLegacyApiChatLocalProvider({ endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      apiKey: "private-ui-test", model: "synthetic-ui" }),
  });
  const rpc = (input, headers = {}) => fetch(`${ui.endpoint}/rpc`, { method: "POST",
    headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json", ...headers },
    body: JSON.stringify(input) });
  assert.equal((await rpc({ method: "list" }, { authorization: "Bearer forbidden" })).status, 403);
  assert.equal((await rpc({ method: "list" }, { "x-pkm-native-actor": randomUUID() })).status, 403);
  assert.equal((await rpc({ method: "list" }, { origin: "http://127.0.0.1" })).status, 400);
  assert.equal((await rpc({ method: "history", ...identity, chatId: descriptor.segmented })).status, 409);
  const status = (await (await rpc({ method: "status" })).json()).value;
  assert.equal(status.root, root); assert.equal(status.actorId, actorId);
  assert.equal(status.workspaceId, prepared.workspaceId);
  const before = (await (await rpc({ method: "history", ...identity })).json()).value;
  assert.deepEqual(before.messages[0].images, [fixture.image]);
  assert.deepEqual(before.pending, []);
  const request = { method: "continue", ...identity, operationId: randomUUID(), expectedRevision: 0,
    text: "Actual UI continuation.", images: [fixture.image] };
  const listed = (await (await rpc({ method: "list" })).json()).value;
  assert.equal(listed[0].groupId, "ungroup");
  assert.equal(status.library, true);
  const libraryMove = { method: "library-mutate", input: { kind: "move-named",
    chatId: descriptor.inline, name: "Native HTTP Library", expectedRevision: 0, operationId: randomUUID() } };
  const moved = (await (await rpc(libraryMove)).json()).value;
  assert.equal(moved.revision, 1);
  assert.deepEqual((await (await rpc(libraryMove)).json()).value, moved);
  assert.equal((await (await rpc({ method: "list" })).json()).value[0].groupId, moved.state.groups[0].id);
  assert.equal((await rpc({ ...libraryMove, input: { ...libraryMove.input,
    chatId: descriptor.segmented, operationId: randomUUID(), expectedRevision: 1 } })).status, 409);
  const continuing = rpc(request);
  await providerStarted;
  try {
    const heartbeat = await fetch(`${ui.endpoint}/rpc`, { method: "POST", signal: AbortSignal.timeout(1500),
      headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify({ method: "status" }) });
    assert.equal(heartbeat.status, 200, "Host health must remain responsive during a real provider request.");
  } finally { releaseProvider(); }
  const result = (await (await continuing).json()).value;
  assert.equal(result.text, "DURABLE_UI_HTTP_RESPONSE");
  assert.deepEqual((await (await rpc(request)).json()).value, result);
  assert.equal(calls, 1);
  const history = (await (await rpc({ method: "history", ...identity })).json()).value;
  assert.equal(history.messages.at(-2).submissionId, request.operationId);
  assert.equal(history.messages.at(-1).inputId, history.messages.at(-2).id);
  assert.equal(history.messages.at(-1).content, result.text);
  assert.equal(history.revision, 1);
  assert.deepEqual(history.pending, []);
  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), originalHash);
  await assert.rejects(ui.close(), /Drain not confirmed/);
  assert.equal((await rpc({ method: "status" })).status, 403);
  await ui.close();
  assert.equal(closeAttempts, 2);
});
