"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto"), { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const childProcess = require("node:child_process");

async function journey(t, { native = false, errors = [], note = false, roundNote = false, observationFailure = false } = {}) {
  const fixture = path.resolve(".migration-test-work", `room-ui-retry-unit-${randomUUID()}`);
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.mkdirSync(fixture, { mode: 0o700 });
  const originalFile = path.join(fixture, "complete-original.json");
  fs.writeFileSync(originalFile, JSON.stringify({ room: "original-primary", meetingId: "meeting-fixture",
    originalNote: "Before", expectedNativeNote: "Before" }));
  const host = { activeRoomIds: [], uiProjects: { projects: [], threads: [] } };
  const guest = { uiCurrent: { participantId: "previous-room-guest" }, joinedRooms: [] };
  const actions = [], report = {};
  const derivedRoomNames = new Set();
  let room, thread, project, opened = 0, contentEditorOpened = false, editedContent;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(bytes, encoding, done) {
      const a = JSON.parse(bytes.toString()); actions.push(a);
      const result = { id: a.id, role: a.role, operation: a.operation, clicked: true };
      if (a.operation === "host") {
        room = a.room; host.activeRoomIds = ["basic-room"];
        host.uiCurrent = { roomId: "basic-room", room, url: "ws://127.0.0.1:19175", selfHost: true, members: [] };
      } else if (a.operation === "join") {
        guest.uiCurrent = { room, url: host.uiCurrent.url, participantId: "new-room-guest", connected: true, messages: [] };
        guest.joinedRooms = [guest.uiCurrent];
        host.uiCurrent.members = [{ participantId: guest.uiCurrent.participantId, host: false }];
      } else if (a.operation === "send") guest.uiCurrent.messages.push(a.text);
      else if (a.operation === "leave") {
        if (a.role === "guest") guest.uiCurrent.connected = false;
        else host.activeRoomIds = [];
      } else if (a.operation === "room-action" && a.label === "Rehost") host.activeRoomIds = ["basic-room"];
      else if (a.operation === "modal" && a.title === "New Project") {
        project = a.value; host.uiProjects.projects.push({ name: a.value });
      }
      else if (a.operation === "modal" && a.title === "New Thread") {
        thread = { name: a.value }; host.uiProjects.threads.push(thread);
      } else if (a.operation === "project-thread-open") {
        const error = errors[opened++];
        const derivedName = Array.from(`${project} · ${thread.name}`).slice(0, 80).join("");
        if (derivedRoomNames.has(derivedName)) {
          result.projectError = `A Room named "${derivedName}" already exists. Rehost the stored Room instead.`;
          child.stdout.write(JSON.stringify(result) + "\n"); done(); return;
        }
        derivedRoomNames.add(derivedName);
        const roomId = `${opened.toString(16).padStart(8, "0")}-1234-1234-1234-123456789abc`;
        host.activeRoomIds.push(roomId);
        if (error) result.projectError = error;
        else thread.chatroom = { roomId };
      } else if (a.operation === "meeting-summary" && note) {
        host.uiMeetings = { history: [{ id: "meeting-fixture", title: "Meeting fixture" }] };
      } else if (a.operation === "note-open-content-editor") contentEditorOpened = true;
      else if (a.operation === "workbench-edit-save" && note) {
        if (!native && !contentEditorOpened) result.errorType = "OriginalContentEditorNotOpened";
        else editedContent = a.value;
      } else if (a.operation === "share-file" && roundNote) result.errorType = "AfterNoteBoundary";
      else if (a.operation === "meeting-summary" || a.operation === "recover-saved-file") result.errorType = "AfterBasicBoundary";
      child.stdout.write(JSON.stringify(result) + "\n"); done();
    },
    final(done) { child.emit("exit", 0); done(); },
  });
  const spawn = t.mock.method(childProcess, "spawn", () => child);
  const modulePath = require.resolve(process.env.PKM_ROOM_UI_RETRY_MODULE || "./next-trial-electron/collaboration-room-full-ui.cjs");
  delete require.cache[modulePath];
  const ui = require(modulePath)({ fixture, env: {}, report, read: role => role === "host" ? host : guest,
    action: async (role, operation) => {
      const original = JSON.parse(fs.readFileSync(originalFile));
      original[operation === "observe-native-note" ? "expectedNativeNote" : "originalNote"] = editedContent;
      fs.writeFileSync(originalFile, JSON.stringify(original));
    },
    beforeUi: async () => {}, afterUi: async () => {},
    observeOriginalNoteSave: async () => {
      assert(editedContent, "The read-only UI failure observation must follow persistent Note bytes.");
      actions.push({ operation: "observe-original-ui-save-failure" });
      if (observationFailure) throw new Error("Original UI failure observation rejected.");
    },
    until: async check => {
      for (let i = 0; i < 50; i++) {
        if (await check()) return;
        await new Promise(resolve => setImmediate(resolve));
      }
      throw new Error("Unit observer did not reach the expected state.");
    } });
  let failure;
  try { await (note && !roundNote ? ui.editNote("host", "Edited fixture Note\n", native) : native ? ui.nativeRound() : ui.originalRound()); }
  catch (error) { failure = error; }
  finally {
    await ui.close(); delete require.cache[modulePath]; spawn.mock.restore();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  return { failure, host, report, actions, opened, derivedRoomNames };
}

test("Original numeric rejection retains its unlinked Thread/Room and uses a distinct real-UI Thread attempt", async t => {
  const result = await journey(t, { errors: ["Chatroom identity is invalid."] });
  assert.match(result.failure.message, /AfterBasicBoundary/);
  assert.equal(result.opened, 2);
  assert.equal(result.report.actualOriginalProjectRejections.length, 1);
  assert.equal(result.host.uiProjects.threads[0].chatroom, undefined);
  assert(result.host.uiProjects.threads[1].chatroom);
  assert.notEqual(result.host.uiProjects.threads[0].name, result.host.uiProjects.threads[1].name);
  assert.equal(result.derivedRoomNames.size, 2);
  assert(result.host.activeRoomIds.includes(result.report.actualOriginalProjectRejections[0].retainedRoomIds[0]));
});

test("Next numeric-looking association errors are not retried as original defects", async t => {
  const result = await journey(t, { native: true, errors: ["Chatroom identity is invalid."] });
  assert.match(result.failure.message, /Next product association failures/);
  assert.equal(result.opened, 1);
  assert.equal(result.report.actualOriginalProjectRejections, undefined);
});

test("Unrelated original errors fail without creating another Thread", async t => {
  const result = await journey(t, { errors: ["Unrelated association failure"] });
  assert.doesNotMatch(result.failure.message, /AfterBasicBoundary/);
  assert.equal(result.opened, 1);
  assert.equal(result.host.uiProjects.threads.length, 1);
  assert.equal(result.report.actualOriginalProjectRejections, undefined);
});

test("Original retry exhaustion is bounded and preserves all rejected data", async t => {
  const result = await journey(t, { errors: Array(20).fill("Chatroom identity is invalid.") });
  assert.match(result.failure.message, /No successful original Thread association within bounded/);
  assert.equal(result.opened, 20);
  assert.equal(result.report.actualOriginalProjectRejections.length, 20);
  assert.equal(result.host.uiProjects.threads.length, 20);
  assert(result.host.uiProjects.threads.every(value => !value.chatroom));
  assert.equal(result.host.activeRoomIds.length, 20);
  assert.equal(result.derivedRoomNames.size, 20);
});

test("Original detailed Note uses its Edit Content UI before the real editor save", async t => {
  const result = await journey(t, { note: true });
  assert.equal(result.failure, undefined);
  const operations = result.actions.map(value => value.operation);
  assert(operations.indexOf("meeting-open-note") < operations.indexOf("note-open-content-editor"));
  assert(operations.indexOf("note-open-content-editor") < operations.indexOf("workbench-edit-save"));
});

test("Selected Core Note does not route through the old retained Note's Edit Content action", async t => {
  const result = await journey(t, { note: true, native: true });
  assert.equal(result.failure, undefined);
  assert(!result.actions.some(value => value.operation === "note-open-content-editor"));
  assert(result.actions.some(value => value.operation === "workbench-edit-save"));
});

test("Full original journey records the UI save failure after persisted bytes and before attachment actions", async t => {
  const result = await journey(t, { note: true, roundNote: true });
  assert.match(result.failure.message, /AfterNoteBoundary/);
  const operations = result.actions.map(value => value.operation);
  assert(operations.indexOf("workbench-edit-save") < operations.indexOf("observe-original-ui-save-failure"));
  assert(operations.indexOf("observe-original-ui-save-failure") < operations.indexOf("share-file"));
});

test("An unverified original UI failure stops the full journey before attachment actions", async t => {
  const result = await journey(t, { note: true, roundNote: true, observationFailure: true });
  assert.match(result.failure.message, /Original UI failure observation rejected/);
  assert(!result.actions.some(value => value.operation === "share-file"));
});
