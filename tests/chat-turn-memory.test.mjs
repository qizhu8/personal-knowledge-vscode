import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryContextService } from "../dist/memory-context.js";
import { createChatTurnMemoryAdmission } from "../dist/chat-turn-adapters.js";
import { chatTurnFixture, chatTurnInput } from "./chat-turn-fixtures.mjs";

test("native memory prompt admission uses actual memory service and fences stale epochs before model dispatch", async t => {
  const binding = { actorId: "memory-actor", namespace: "synthetic", chatId: "synthetic-session",
    historyRevision: "history:1", memoryRevision: "memory:1" };
  let live = binding, modelCalls = 0;
  const memory = new MemoryContextService({
    readBinding: () => live,
    async readMemory() {
      return { status: "available", records: [], chats: [{
        id: binding.chatId, actorId: binding.actorId, namespace: binding.namespace,
        title: "Synthetic only", createdAt: new Date().toISOString(), includeHistory: false, messages: [],
      }] };
    },
  });
  const input = chatTurnInput();
  const context = await memory.assemble({
    binding, query: "Synthetic question", inputBudget: 60000,
    requiredMessages: [{ role: "user", content: "Synthetic question" }],
  });
  assert.equal(context.status, "ready");
  const admission = createChatTurnMemoryAdmission(binding.actorId, input.id, context);
  const f = chatTurnFixture({
    admitPrompt: admission.admitPrompt,
    model: { available: true, async *stream() {
      modelCalls++;
      yield { type: "text", text: "Synthetic answer" };
      yield { type: "finish", reason: "stop" };
    } },
  });
  t.after(() => f.db.close());
  live = { ...binding, historyRevision: "history:2" };
  f.service.start(binding.actorId, { ...input, messages: admission.messages });
  const result = await f.service.settled(binding.actorId, input.id);
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "MEMORY_CONTEXT_STALE");
  assert.equal(modelCalls, 0);
  assert.throws(() => createChatTurnMemoryAdmission(binding.actorId, input.id, {
    status: "unavailable", reason: "Synthetic source unavailable",
  }), /MEMORY_UNAVAILABLE/);
});
