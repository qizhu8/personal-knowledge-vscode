import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const project = path.resolve(new URL("../legacy", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const roomId = "original-room-123";
const notePath = "Chatroom Meetings/Original Room/timestamp.md";
const renamedPath = "Chatroom Meetings/Original Room/Original title.md";
const markdown = `---\nschema: "pkm.knowledge/v1"\nknowledgeId: "knowledge_0123456789abcdef01234567"\nrevision: 1\naliases: ["note:Chatroom Meetings/Original Room/timestamp","note:Chatroom Meetings/Original Room/Original title"]\ntitle: "Original title"\n---\nPreserved actual saved Note.\n`;

async function fixture(t) {
  const directory = path.join(project, ".migration-test-work", `meeting-note-alias-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(project, "../node_modules"), path.join(directory, "node_modules"), "dir");
  require("esbuild").buildSync({
    stdin: { contents: `export {inspectRetainedMeetingSource} from ${JSON.stringify(
      process.env.PKM_ROOM_MEETING_SOURCE || "./next-server/src/next-room-meeting-source",
    )};`, resolveDir: project },
    bundle: true, platform: "node", format: "esm", packages: "external",
    outfile: path.join(directory, "source.mjs"), logLevel: "silent",
  });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "root");
  const canonical = path.join(root, "chatrooms", roomId, "meetings/canonical.json");
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, "notes", notePath)), { recursive: true });
  fs.writeFileSync(canonical, JSON.stringify({ schema: 1, meetings: [{
    id: "original-meeting-123", roomId, markdownPath: notePath, status: "adjourned",
    startedAt: "2026-11-14T16:24:05.504Z", revision: 3, topics: [], events: [],
  }] }));
  const module = await import(pathToFileURL(path.join(directory, "source.mjs")));
  return { root, canonical, inspect: () => module.inspectRetainedMeetingSource(root, roomId) };
}

test("ordinary saved title rename resolves its validated legacy alias without rewriting canonical or Note bytes", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "notes", renamedPath), markdown);
  const canonical = fs.readFileSync(f.canonical);
  const result = f.inspect();
  assert.equal(result.notes[0].path, notePath);
  assert.equal(result.notes[0].body, markdown);
  assert.deepEqual(fs.readFileSync(f.canonical), canonical);
  assert.equal(fs.readFileSync(path.join(f.root, "notes", renamedPath), "utf8"), markdown);
  assert.equal(fs.existsSync(path.join(f.root, "notes", notePath)), false);
});

test("an existing canonical Note remains authoritative despite an alias copy", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "notes", notePath), "Original direct bytes.");
  fs.writeFileSync(path.join(f.root, "notes", renamedPath), markdown);
  assert.equal(f.inspect().notes[0].body, "Original direct bytes.");
});

test("missing, invalid, ambiguous or linked saved Notes cannot replace a canonical Note", async t => {
  const f = await fixture(t), saved = path.join(f.root, "notes", renamedPath);
  assert.throws(f.inspect, /ENOENT/);
  fs.writeFileSync(saved, markdown.replace("knowledge_0123456789abcdef01234567", "unverified-id"));
  assert.throws(f.inspect, /ENOENT/);
  fs.writeFileSync(saved, markdown);
  const other = path.join(path.dirname(saved), "Other title.md");
  fs.writeFileSync(other, markdown);
  assert.throws(f.inspect, /ambiguous/i);
  fs.unlinkSync(other);
  fs.renameSync(saved, path.join(f.root, "preserved.md"));
  fs.symlinkSync(path.join(f.root, "preserved.md"), saved);
  assert.throws(f.inspect, /link|regular/i);
});

test("two canonical Meetings cannot share one resolved alias Note", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "notes", renamedPath), markdown);
  const state = JSON.parse(fs.readFileSync(f.canonical, "utf8"));
  state.meetings.unshift({ ...state.meetings[0], id: "other-meeting-123", markdownPath: renamedPath });
  fs.writeFileSync(f.canonical, JSON.stringify(state));
  assert.throws(f.inspect, /share a resolved Note/);
});
