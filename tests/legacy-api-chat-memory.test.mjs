import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LegacyApiChatMemory } from "../dist/legacy-api-chat-memory.js";
import { boundedModelCopy, modelProviderInputSchema, validateModelToolSchema } from "../dist/domain/model-provider.js";

test("Memory catalog crosses strict real model admission without Zod callbacks or unsupported schema keys", () => {
  const tools = LegacyApiChatMemory.prototype.catalog.call({});
  const admitted = modelProviderInputSchema.parse(boundedModelCopy({
    messages: [{ role: "user", content: "Synthetic original Memory recall." }], tools,
  }));
  for (const tool of admitted.tools) {
    validateModelToolSchema(tool.parameters);
    assert.equal("operation_id" in tool.parameters.properties, false);
  }
  assert.deepEqual(admitted.tools.find(item => item.name === "memory_record_search").parameters.required, ["query"]);
});
import { Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { readMemoryScopeContinuity, continuityScope } from "../dist/memory-scope-continuity.js";
const require = createRequire(import.meta.url), project = resolve(import.meta.dirname, "../legacy");
const sha = value => createHash("sha256").update(value).digest("hex");

test("genuine old profile Memory becomes scoped native recall with exact-human revise/confirm/revoke and fresh restart admission", async t => {
  const directory = join(project, ".migration-test-work", `chat-memory-${randomUUID()}`);
  const root = join(directory, "knowledge"), profileStorage = join(directory, "profile");
  mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(profileStorage, { mode: 0o700 });
  const oldMask = process.umask(0o077);
  let memory;
  t.after(async () => { try { await memory?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  try {
    const { ApiChatStore } = require("../legacy/dist/chat/api-chat-store.js");
    const old = new ApiChatStore(join(root, ".pkm/state"), "0123456789abcdef");
    const chat = old.create(); old.startTask(chat, "Original Memory workflow"); old.save(chat);
    const fixture = await require("../legacy/tests/next-trial-electron/legacy-chat-memory-fixture.cjs").create({
      extension: project, root, profileStorage, chatId: chat.id });
    const source = readFileSync(fixture.database);
    const binding = { root, workspaceId: randomUUID(), actorId: "fresh-memory-fixture",
      sourceFingerprint: "a".repeat(64), namespace: chat.workspaceNamespace, chatId: chat.id };
    let allowRead = true, allowDecision = true;
    const options = { ...binding, profileStorage,
      authorize: async (scope, operation) => scope.namespace === binding.namespace && scope.chatId === chat.id
        && (operation === "decision" ? allowDecision : allowRead) };
    const request = { actor: "legacy-managed:fresh-memory-fixture", turnId: randomUUID(), step: 0,
      messages: [{ role: "user", content: "SATURN conventions?" }], maxInputTokens: 60000,
      maxOutputTokens: 1000, signal: new AbortController().signal };
    const quotes = context => context.messages.flatMap(message => {
      try { const data = JSON.parse(message.content); return data.schema === "pkm.chat.memory-context/v1" ? [data] : []; }
      catch { return []; }
    });
    const call = (action, args, operationId = randomUUID()) => memory.execute({ ...binding,
      turnId: request.turnId, inputId: request.turnId, taskSessionId: "native-task-extra-context" }, {
      call: { name: `memory_record_${action}`, arguments: args }, operationId, signal: request.signal });
    const read = async action => JSON.parse((await action).content);
    const adopt = async () => {
      const state = await memory.state(binding);
      return memory.action(binding, { namespace: binding.namespace, chatId: chat.id, kind: "adopt",
        expectedDigest: state.digest, operationId: randomUUID() });
    };
    const pending = async () => {
      for (let i = 0; i < 100; i++) {
        const state = await memory.state(binding);
        if (state.decisions.length) return state.decisions[0];
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("Exact native human Memory decision was not requested.");
    };
    const decide = (decision, kind = "approve") => memory.action(binding, { namespace: binding.namespace,
      chatId: chat.id, kind, expectedDigest: decision.digest, decisionId: decision.id, operationId: randomUUID() });
    memory = await LegacyApiChatMemory.open(options);
    assert.equal((await memory.state(binding)).adopted, false);
    await assert.rejects(memory.context(binding, request), /MEMORY_SCOPE_REQUIRES_FRESH_ADOPTION/);
    await assert.rejects(call("get", { id: fixture.original.id }), /MEMORY_SCOPE_REQUIRES_FRESH_ADOPTION/);
    await adopt();
    const first = await memory.context(binding, request); first.assertCurrent();
    assert.deepEqual(quotes(first).map(item => item.quotedText), [fixture.original.content]);
    assert.equal(quotes(first)[0].sourcePins[0].references[0].chat, chat.id);
    await assert.rejects(call("get", { id: fixture.foreignId }), /MEMORY_NOT_AVAILABLE/);
    await assert.rejects(call("confirm", { id: fixture.original.id, expected_revision: 2,
      host_authorization: { actor_id: "fake", decision_id: "fake" } }), /MEMORY_INVALID_ARGUMENT/);
    const replacement = { content: "SATURN updated convention: use cobalt envelopes.", sources: fixture.original.sources };
    const revising = call("revise", { id: fixture.original.id, expected_revision: 2, ...replacement });
    const review = await pending();
    assert.equal(review.request.record.content, fixture.original.content);
    assert.equal(review.request.replacement.content, replacement.content);
    await assert.rejects(decide({ ...review, digest: "0".repeat(64) }), /changed/);
    allowDecision = false; await assert.rejects(decide(review), /MEMORY_FRESH_AUTHORITY_DENIED/);
    allowDecision = true; await decide(review);
    assert.equal((await read(revising)).status, "pending");
    assert.throws(() => first.assertCurrent(), /stale/i);
    assert.deepEqual(quotes(await memory.context(binding, request)), []);
    const confirming = call("confirm", { id: fixture.original.id, expected_revision: 3 });
    await decide(await pending());
    assert.equal((await read(confirming)).revision, 4);
    assert.deepEqual(quotes(await memory.context(binding, request)).map(item => item.quotedText), [replacement.content]);
    const declined = call("revoke", { id: fixture.original.id, expected_revision: 4 });
    const rejected = assert.rejects(declined, /MEMORY_ACCESS_DENIED/);
    await decide(await pending(), "deny"); await rejected;
    assert.equal((await read(call("get", { id: fixture.original.id }))).revision, 4);
    const revoking = call("revoke", { id: fixture.original.id, expected_revision: 4 });
    await decide(await pending());
    assert.equal((await read(revoking)).current_status, "revoked");
    assert.deepEqual(quotes(await memory.context(binding, request)), []);
    const audit = await read(call("audit", { id: fixture.original.id }));
    assert.deepEqual(audit.events.map(item => item.action), ["proposed", "confirmed", "revised", "confirmed", "revoked"]);
    assert.equal(audit.events[1].actor, "user:synthetic-original");
    assert.equal(audit.events[2].actor, `user:${binding.actorId}`);
    const nativeDirectory = memory.directory;
    await memory.close(); memory = await LegacyApiChatMemory.open(options);
    assert.equal(memory.directory, nativeDirectory);
    assert.equal((await memory.state(binding)).adopted, false);
    await assert.rejects(call("get", { id: fixture.original.id }), /MEMORY_SCOPE_REQUIRES_FRESH_ADOPTION/);
    await adopt();
    assert.equal((await read(call("get", { id: fixture.original.id }))).current_status, "revoked");
    assert.deepEqual(quotes(await memory.context(binding, request)), []);
    allowRead = false;
    await assert.rejects(memory.context(binding, request), /MEMORY_FRESH_AUTHORITY_DENIED/);
    assert.deepEqual(readFileSync(fixture.database), source);
    assert.equal(sha(source), fixture.sourceSha256);
    await memory.close();
    let worker = await Storage.open(nativeDirectory);
    try {
      const database = worker.connectNative();
      let continuity;
      try { continuity = readMemoryScopeContinuity(database, await worker.workspaceId()); }
      finally { database.close(); }
      const { decisionId, expiresAtMs, ...scopeRequest } = continuity;
      const approval = { actorId: binding.actorId, decisionId: randomUUID(), expiresAtMs: Date.now() + 60000 };
      const get = () => new Core(worker).dispatch("capability_read", { operation: "memory.record.get",
        version: 1, arguments: { id: fixture.original.id } }, { id: binding.actorId, canWrite: true });
      assert.equal((await get()).error.code, "NOT_AVAILABLE");
      for (const invalid of [{ ...approval, actorId: "foreign" }, { ...approval, expiresAtMs: 1 },
        { ...approval, expiresAtMs: Date.now() + 31 * 60000 }]) {
        await assert.rejects(worker.adoptMemoryScopeContinuity(scopeRequest, invalid));
        assert.equal((await get()).error.code, "NOT_AVAILABLE");
      }
      await assert.rejects(worker.adoptMemoryScopeContinuity({ ...scopeRequest, workspaceId: randomUUID() }, approval));
      await worker.adoptMemoryScopeContinuity(scopeRequest, approval);
      assert.equal((await get()).result.current_status, "revoked");
      await worker.revokeMemoryScopeContinuity();
      assert.equal(continuityScope(nativeDirectory), undefined);
      assert.equal((await get()).error.code, "NOT_AVAILABLE");
      await worker.adoptMemoryScopeContinuity(scopeRequest, approval);
      await worker.close();
      assert.equal(continuityScope(nativeDirectory), undefined);
      worker = await Storage.open(nativeDirectory);
      assert.equal((await get()).error.code, "NOT_AVAILABLE", "A new storage worker never inherits prior scope authority.");
    } finally { await worker.close(); }
  } finally { process.umask(oldMask); }
});
