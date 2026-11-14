import { test } from "node:test";
import assert from "node:assert/strict";
import { createTodoApi } from "../dist/domain/todo-api.js";

test("Board discovery scans beyond 1000 Notes and returns large pages with a warning instead of rejecting them", () => {
  const notes = Array.from({ length: 1105 }, (_, index) => ({
    slug: `Board-${index}`,
    title: `Board ${index} ${"x".repeat(3000)}`,
    count: 0,
    digest: "a".repeat(64),
  }));
  let scannedLimit;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    const api = createTodoApi({
      noteGet: slug => ({ title: slug, documentKind: "todo-board" }),
      noteWorkItemsRead: () => ({ digest: "a".repeat(64), items: [] }),
      noteWorkItemNotes: (_query, limit) => {
        scannedLimit = limit;
        return { notes, truncated: false };
      },
      noteWorkItemCommand: () => { throw new Error("not used"); },
      listChats: () => [],
    });

    const result = api.callTodoApi("list_boards", { limit: 100 }, "user:owner");
    assert.equal(scannedLimit, Number.MAX_SAFE_INTEGER);
    assert.equal(result.total, notes.length);
    assert.equal(result.items.length, 100);
    assert(Buffer.byteLength(JSON.stringify(result), "utf8") > 256_000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /returning the complete result without truncation/);
  } finally {
    console.warn = originalWarn;
  }
});
