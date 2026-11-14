import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { githubSyncLocalSnapshotMatches, githubSyncManagedContent } from "../dist/domain/sync-apply-original.js";

test("captured original content preserves bytes outside recipe metadata", () => {
  const bytes = Buffer.from("\uFEFFfirst\r\nsecond\n");
  assert.equal(githubSyncManagedContent("notes", bytes), bytes);
  assert(githubSyncLocalSnapshotMatches(bytes, Buffer.from("planned"), bytes));
  assert(!githubSyncLocalSnapshotMatches(Buffer.from("base"), Buffer.from("planned"), Buffer.from("external")));
});

test("original guarded pull assertion retains exact selected bytes", () => {
  const directory = mkdtempSync(resolve("tests", ".sync-apply-original-"));
  const fs = { readFileSync };
  const path = { join };
  const store = directory;
  const relative = "notes/source.md";
  const expected = Buffer.from("\uFEFFfirst\nremote edited\n");
  try {
    mkdirSync(join(store, "notes"), { recursive: true });
    writeFileSync(join(store, relative), expected);
      assert(fs.readFileSync(path.join(store, relative)).equals(expected));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
