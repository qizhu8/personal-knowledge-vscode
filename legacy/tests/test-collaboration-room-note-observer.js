"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const observe = require(process.env.PKM_ROOM_NOTE_OBSERVER_MODULE || "./next-trial-electron/collaboration-room-note-observer.cjs");
const original = { markdownPath: "Chatroom Meetings/Room/timestamp.md" };
const note = { slug: "Chatroom Meetings/Room/Actual title", aliases: ["note:Chatroom Meetings/Room/timestamp"],
  content: "Exact editor input, without the added physical Knowledge header.", knowledgeId: "knowledge_0123456789abcdef01234567" };

test("original observation follows the saved legacy alias and reads product content rather than raw metadata", () => {
  const result = observe({ noteList: () => [note] }, original);
  assert.equal(result.path, "Chatroom Meetings/Room/Actual title.md");
  assert.equal(result.content, note.content);
  assert.equal(original.markdownPath, "Chatroom Meetings/Room/timestamp.md");
});

test("missing or ambiguous original Note aliases fail instead of selecting a title match", () => {
  assert.throws(() => observe({ noteList: () => [] }, original), /Exactly one/);
  assert.throws(() => observe({ noteList: () => [note, { ...note, slug: "Chatroom Meetings/Room/Duplicate" }] }, original), /Exactly one/);
});

test("a moved or escaping alias cannot substitute a Note from another collection", () => {
  assert.throws(() => observe({ noteList: () => [{ ...note, slug: "Other/Actual title" }] }, original), /Meeting collection/);
  assert.throws(() => observe({ noteList: () => [{ ...note, slug: "Chatroom Meetings/Room/../Other" }] }, original), /portable/);
});
