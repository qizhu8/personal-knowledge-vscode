const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ChatMemoryService, chatMemoryScope } = require("../dist/memory/chat-memory-service");

// Scripted memory model with the same contract as modules/pkm-memory-engine/tests/fake_model.py.
function scriptedModel(log, fail = new Set()) {
  return async request => {
    log.push(request.purpose);
    if (fail.has(request.purpose)) throw new Error(`scripted ${request.purpose} failure`);
    const user = request.messages.at(-1).content;
    if (request.purpose === "intent") {
      const data = JSON.parse(user);
      const skills = data.topics.find(topic => topic.label.includes("Skill"));
      if (skills && /上面|Skill/.test(data.current_input)) return { text: JSON.stringify({ focus: [skills.alias] }) };
      const label = data.current_input.includes("Skill") ? "Skill review" : data.current_input.slice(0, 30);
      return { text: JSON.stringify({ focus: ["new:1"], new: [{ key: "new:1", label }] }), usage: { inputTokens: 10, outputTokens: 5 } };
    }
    if (request.purpose === "extract") {
      const data = JSON.parse(user);
      return { text: JSON.stringify({ statements: [{ topic: "T1", text: data.assistant.slice(0, 300), status: "proposal" }] }) };
    }
    return { text: user.slice(0, 400) };
  };
}

test("Chat memory service restores an earlier long answer for a later reference and survives a worker restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-memory-"));
  const service = new ChatMemoryService({
    extensionRoot: path.resolve(__dirname, ".."), python: process.env.PYTHON || "python3",
    database: path.join(directory, "memory.sqlite3"), identity: "fixture/root",
  });
  const scope = chatMemoryScope("0123456789abcdef", "chat-1");
  const log = [];
  const signal = new AbortController().signal;
  const longAnswer = `Skill review design: ${"separate trigger rules from descriptions and add validation. ".repeat(60)}`;
  const turns = [
    ["u1", "帮我review一下这个Skill的设计", "a1", longAnswer],
    ["u2", "周末去哪里徒步比较好", "a2", "可以去山里徒步。"],
  ];
  try {
    for (const [userId, userText, assistantId, assistantText] of turns) {
      const prepared = await service.prepare(scope, userId, { id: userId, text: userText }, [], 50_000, scriptedModel(log), signal);
      assert.equal(prepared.receipt.schema, "pkm.memory.turn-receipt/v1");
      await service.commit(scope, userId, { id: userId, role: "user", text: userText }, { id: assistantId, role: "assistant", text: assistantText },
        scriptedModel(log), signal, 64 * 1024 * 1024);
    }
    assert.ok(log.includes("intent") && log.includes("extract"));

    const recent = [{ id: "u2", role: "user", text: turns[1][1] }, { id: "a2", role: "assistant", text: turns[1][3] }];
    const prepared = await service.prepare(scope, "u3", { id: "u3", text: "上面说的Skill这个问题再展开一下" }, recent, 50_000, scriptedModel(log), signal);
    const earlier = prepared.blocks.find(block => block.kind === "earlier-message");
    assert.ok(earlier, JSON.stringify(prepared.blocks.map(block => block.kind)));
    assert.match(earlier.text, /separate trigger rules/);
    assert.ok(prepared.blocks.some(block => block.kind === "focus-topic"));

    const read = await service.read(scope, prepared.focus[0]);
    assert.equal(read.piece, prepared.focus[0]);
    await assert.rejects(service.read(chatMemoryScope("0123456789abcdef", "chat-2"), prepared.focus[0]), /scope|not found|unknown/i);

    // A crashed worker is replaced on the next call; durable state survives.
    const client = await service.client;
    client.child.kill("SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 100));
    const overview = await service.overview(scope);
    assert.ok(overview.topics.length >= 2, JSON.stringify(overview));

    // Model failure is visible in the receipt but never blocks the Chat turn.
    const failed = await service.prepare(scope, "u4", { id: "u4", text: "another question" }, recent, 50_000, scriptedModel(log, new Set(["intent"])), signal);
    assert.equal(failed.receipt.intent.status, "fallback");

    await service.forget(scope);
    assert.equal((await service.overview(scope)).topics.length, 0);
  } finally {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
