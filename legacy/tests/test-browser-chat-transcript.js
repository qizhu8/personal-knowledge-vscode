const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserChatTranscriptReader } = require("../dist/chat/browser-chat-transcript");

const grant = { actorId: "browser", workspaceRoot: "/fixture", generation: "g1", chatHostId: "00000000-0000-0000-0000-000000000001" };
const chatId = "00000000-0000-0000-0000-000000000002";
const message = (role, content) => ({ id: content, role, content, status: "complete", toolCalls: [{ secret: true }] });

test("transcript cursors grant only the reviewed snapshot and expose no tool evidence", async () => {
  const messages = [message("user", "question"), message("assistant", "answer")];
  let allowed = true, prompts = 0;
  const read = createBrowserChatTranscriptReader(grant, {
    assertCurrent() { if (!allowed) throw Error("revoked"); },
    async load() { return { title: "Test", messages }; },
    async confirm() { prompts++; return true; },
  });
  const first = await read(grant, { chatId, limit: 1 });
  await assert.rejects(read({ ...grant, actorId: "other" }, { chatId, cursor: first.nextCursor }), /not available/);
  const second = await read(grant, { chatId, cursor: first.nextCursor });
  assert.deepEqual([...first.messages, ...second.messages], messages.map(({ id, role, content, status }) => ({ id, role, content, status })));
  assert.equal(prompts, 1);
  messages.push(message("user", "new turn"));
  await assert.rejects(read(grant, { chatId, cursor: first.nextCursor }), /not available/);
  allowed = false;
  await assert.rejects(read(grant, { chatId, cursor: first.nextCursor }), /revoked/);
});

test("decline or revoke during native consent releases no transcript", async () => {
  let allowed = true;
  const read = createBrowserChatTranscriptReader(grant, {
    assertCurrent() { if (!allowed) throw Error("revoked"); },
    async load() { return { title: "Test", messages: [message("user", "secret")] }; },
    async confirm() { return false; },
  });
  await assert.rejects(read(grant, { chatId }), /not available/);
  const revoke = createBrowserChatTranscriptReader(grant, {
    assertCurrent() { if (!allowed) throw Error("revoked"); },
    async load() { return { title: "Test", messages: [message("user", "secret")] }; },
    async confirm() { allowed = false; return true; },
  });
  await assert.rejects(revoke(grant, { chatId }), /revoked/);
});
