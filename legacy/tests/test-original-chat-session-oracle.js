"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

test("original 4.0.22 retains completed Task Sessions and their own harness history", t => {
  const project = path.resolve(__dirname, "..");
  const installed = path.join(project, ".migration-test-work/root-upgrade-validation/installed-6c4415d4-335c-4584-afec-8a4f5056d48f/extensions/uone.personal-knowledge-4.0.22");
  const vsix = path.join(project, "personal-knowledge-4.0.22.vsix");
  if (!fs.existsSync(vsix) || !fs.existsSync(path.join(installed, "dist/chat/api-chat-store.js"))) {
    t.skip("Requires the verified private original 4.0.22 installation and VSIX."); return;
  }
  assert.equal(createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  assert.deepEqual(fs.readFileSync(path.join(installed, "dist/chat/api-chat-store.js")),
    execFileSync("unzip", ["-p", vsix, "extension/dist/chat/api-chat-store.js"]));
  assert.equal(require(path.join(installed, "package.json")).version, "4.0.22");
  const { ApiChatStore, apiChatSessionHarnessSnapshot } = require(path.join(installed, "dist/chat/api-chat-store.js"));
  const root = path.join(project, ".migration-test-work", `original-session-oracle-${randomUUID()}`);
  const state = path.join(root, ".pkm/state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const store = new ApiChatStore(state, "0123456789abcdef");
  const chat = store.create(), sessions = [];
  for (const [title, marker] of [["First original task", "FIRST_TASK_INPUT"], ["Second original task", "SECOND_TASK_INPUT"]]) {
    store.startTask(chat, title);
    const id = chat.sessionId;
    chat.messages.push({ id: randomUUID(), role: "user", status: "complete", taskId: id, content: marker });
    store.save(chat);
    store.completeTask(chat);
    const record = JSON.parse(fs.readFileSync(path.join(state, "agent-sessions", `${id}.json`), "utf8"));
    const harness = apiChatSessionHarnessSnapshot(record, id, state);
    assert.equal(record.status, "completed");
    assert.equal(record.nativeChat.sessionId, id);
    assert.equal(harness.sessionId, id);
    assert.equal(harness.currentProblem, marker);
    sessions.push(id);
  }
  const reopened = store.load(chat.id, false);
  assert.equal(reopened.sessionId, undefined);
  assert.deepEqual(reopened.memoryTasks.map(task => task.id), sessions);
  reopened.messages.push({ id: randomUUID(), role: "user", status: "complete", content: "ORDINARY_AFTER_TASK" });
  store.save(reopened);
  assert.equal(store.load(chat.id, false).messages.at(-1).taskId, undefined);
  store.startTask(reopened, "Next original task");
  assert.notEqual(reopened.sessionId, sessions[0]);
  assert.notEqual(reopened.sessionId, sessions[1]);
  assert.deepEqual(reopened.memoryTasks.map(task => task.id).slice(0, 2), sessions);
  assert(reopened.messages.some(message => message.content === "ORDINARY_AFTER_TASK"));
});
