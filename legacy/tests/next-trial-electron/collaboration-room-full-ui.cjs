"use strict";
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const sha = value => createHash("sha256").update(value).digest("hex");

module.exports = ({ fixture, env, until, read, action, report, beforeUi, afterUi, observeOriginalNoteSave }) => {
  const child = spawn(env.PKM_ROOM_UI_PYTHON || process.env.PKM_ROOM_UI_PYTHON || "python3", [path.join(__dirname, "collaboration-room-user-ui.py"), "--fixture", fixture,
    "--host-cdp", "http://127.0.0.1:19173", "--guest-cdp", "http://127.0.0.1:19174"],
  { cwd: fixture, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const results = new Map();
  let exited;
  child.once("error", error => { exited = error.message; });
  child.once("exit", (code, signal) => { exited = `${code ?? signal}`; });
  child.stderr.on("data", bytes => fs.appendFileSync(path.join(fixture, "actual-room-python-ui.log"), bytes, { mode: 0o600 }));
  readline.createInterface({ input: child.stdout }).on("line", line => {
    try {
      const value = JSON.parse(line); results.set(value.id, value);
      fs.appendFileSync(path.join(fixture, "actual-room-ui-results.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600 });
    }
    catch { exited = "Invalid renderer service response."; }
  });
  const perform = async (role, operation, extra = {}) => {
    if (operation !== "disconnect") await beforeUi(role);
    const id = randomUUID();
    try {
      child.stdin.write(JSON.stringify({ id, role, operation, ...extra }) + "\n");
      await until(() => { if (exited) throw new Error(`Actual Python renderer exited: ${exited}`);
        return results.has(id); }, `actual ${role} ${operation}`, 90000);
      const result = results.get(id); results.delete(id);
      report.actualRoomUi ??= []; report.actualRoomUi.push(result);
      assert.equal(result.errorType, undefined, `Actual renderer ${role}/${operation}: ${result.errorType}`);
      return result;
    } finally {
      if (operation !== "disconnect") {
        const disconnectId = randomUUID();
        child.stdin.write(JSON.stringify({ id: disconnectId, role, operation: "disconnect" }) + "\n");
        await until(() => results.has(disconnectId) || exited, "Python CDP actor disconnect", 15000);
        results.delete(disconnectId);
        await afterUi(role);
      }
    }
  };
  const original = () => JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json")));
  const openPrimary = role => perform(role, "room-action", { section: "hosted", room: original().room, label: "Open" });
  const editNote = async (role, content, native = true) => {
    await openPrimary(role);
    await perform(role, "meeting-summary");
    await until(() => read(role).uiMeetings?.history?.some(value => value.id === original().meetingId), "observed actual Meeting history");
    const meeting = read(role).uiMeetings.history.find(value => value.id === original().meetingId);
    await perform(role, "meeting-select", { title: meeting.title });
    await perform(role, "meeting-open-note");
    if (!native) await perform(role, "note-open-content-editor");
    await perform(role, "workbench-edit-save", { value: content });
    await until(async () => {
      await action(role, native ? "observe-native-note" : "observe-original-note");
      return original()[native ? "expectedNativeNote" : "originalNote"] === content;
    }, "actual editor save reached the owned Note");
  };
  const basic = async phase => {
    const name = `${phase} actual button Room ${randomUUID()}`, secret = randomBytes(18).toString("base64url");
    await perform("host", "host", { room: name, name: "Original Host", port: 19175, secret });
    await until(() => read("host").uiCurrent?.room === name && read("host").uiCurrent.selfHost, "actual Host form creates a Room");
    const hosted = read("host").uiCurrent, guestBefore = read("guest").uiCurrent?.participantId;
    await perform("guest", "join-wrong-secret", { room: hosted.room, url: hosted.url,
      name: "Original Guest", secret: "deliberately-wrong-private-fixture-secret" });
    const inRoom = value => value.roomId === hosted.roomId || value.room === hosted.room && value.url === hosted.url;
    await until(() => !read("guest").joinedRooms?.some(value => inRoom(value) && value.connected),
      "wrong-secret actual join is not connected");
    await perform("guest", "join", { room: hosted.room, url: hosted.url, name: "Original Guest", secret });
    await until(() => {
      const guest = read("guest").uiCurrent, host = read("host").uiCurrent;
      return guest?.connected && guest.room === hosted.room && guest.url === hosted.url
        && host?.roomId === hosted.roomId
        && host.members?.some(member => member.participantId === guest.participantId && !member.host);
    }, "actual Guest joins the Host's observed Room and presence");
    const guestId = read("guest").uiCurrent.participantId;
    await perform("guest", "assert-no-moderation");
    for (const mode of ["announce", "ask", "discuss"]) {
      const text = `${phase} actual ${mode} message`;
      await perform("host", "send", { mode, text });
      await until(() => read("guest").uiCurrent?.messages.includes(text), `actual ${mode} message delivered`);
    }
    await perform("guest", "leave");
    await until(() => !read("guest").joinedRooms?.some(value => inRoom(value) && value.connected), "actual Guest leaves");
    await perform("host", "leave");
    await until(() => !read("host").activeRoomIds.includes(hosted.roomId), "actual Host closes Room");
    await perform("host", "room-action", { section: "hosted", room: name, label: "Rehost" });
    await until(() => read("host").uiCurrent?.roomId === hosted.roomId && read("host").uiCurrent.selfHost, "actual Rehost button");
    await perform("guest", "join", { room: hosted.room, url: read("host").uiCurrent.url, name: "Original Guest", secret });
    await until(() => read("guest").uiCurrent?.connected && read("guest").uiCurrent.room === hosted.room
      && read("host").uiCurrent?.members?.some(member => member.participantId === read("guest").uiCurrent.participantId),
    "actual historical Guest rejoins with Host presence");
    assert.equal(read("guest").uiCurrent.participantId, guestId);
    await perform("guest", "leave"); await perform("host", "leave");
    report.actualBasicRooms ??= [];
    report.actualBasicRooms.push({ phase, roomId: hosted.roomId, guestId, guestBefore, unchangedRejoinIdentity: true });
    const project = `${phase} actual Project ${randomUUID()}`, thread = `${phase} actual Thread`;
    await perform("host", "project-create");
    await perform("host", "modal", { title: "New Project", choice: "Create", value: project });
    await until(() => read("host").uiProjects?.projects.some(value => value.name === project), "actual New Project button");
    await perform("host", "project-open", { name: project });
    let linked = false;
    for (let attempt = 0; attempt < (phase === "original-4.0.22" ? 20 : 1); attempt++) {
      const attemptThread = `t${String(attempt).padStart(2, "0")} ${thread}`;
      await perform("host", "project-thread-create");
      await perform("host", "modal", { title: "New Thread", choice: "Create", value: attemptThread });
      await until(() => read("host").uiProjects?.threads.some(value => value.name === attemptThread), "actual New Thread button");
      const before = new Set(read("host").activeRoomIds);
      const outcome = await perform("host", "project-thread-open", { name: attemptThread });
      if (outcome.projectError) {
        assert.equal(phase, "original-4.0.22", "Next product association failures must not be retried as old-oracle defects.");
        assert.equal(outcome.projectError, "Chatroom identity is invalid.");
        await until(() => read("host").activeRoomIds.some(id => !before.has(id)), "original failed association retained its new Room");
        const retainedRoomIds = read("host").activeRoomIds.filter(id => !before.has(id));
        assert.equal(retainedRoomIds.length, 1);
        assert.match(retainedRoomIds[0], /^[0-9][0-9a-f]{7}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert(!read("host").uiProjects.threads.find(value => value.name === attemptThread).chatroom);
        report.actualOriginalProjectRejections ??= [];
        report.actualOriginalProjectRejections.push({ thread: attemptThread, retainedRoomIds, error: outcome.projectError,
          evidence: `actual-project-rejection-${outcome.id}.png`, noDeletionOrIdRewrite: true });
        continue;
      }
      await until(() => read("host").uiProjects.threads.some(value => value.name === attemptThread && value.chatroom)
        && read("host").uiCurrent?.selfHost, "actual Thread Open chatroom association");
      linked = true;
      break;
    }
    assert(linked, "No successful original Thread association within bounded real-UI attempts; failed Threads/Rooms remain preserved.");
    await openPrimary("host");
  };
  return {
    perform, editNote, openPrimary,
    async originalRound() {
      await basic("original-4.0.22");
      await editNote("host", original().originalNote + "\nSaved by the actual original Workbench editor.\n", false);
      await observeOriginalNoteSave();
      await openPrimary("host"); await perform("guest", "assert-no-room-action", { label: "Recover saved file…" });
      const input = path.join(fixture, "actual-original-shared.bin"), bytes = randomBytes(110000);
      fs.writeFileSync(input, bytes, { mode: 0o600 });
      await perform("host", "share-file");
      await perform("host", "workbench-file", { title: "Share to room", value: input });
      await until(() => read("guest").uiFiles?.some(value => value.name === path.basename(input)), "actual original Share File received");
      const savedPath = path.join(fixture, "actual-original-guest-saved.bin");
      await perform("guest", "save-file", { name: path.basename(input) });
      await perform("guest", "workbench-file", { title: "Save shared file", value: savedPath });
      await until(() => fs.existsSync(savedPath), "actual original Guest Save writes bytes");
      assert.equal(sha(fs.readFileSync(savedPath)), sha(bytes));
      await action("host", "observe-original-file", { name: path.basename(input), savedPath });
      report.actualOriginalSavedFile = { bytes: bytes.length, sha256: sha(bytes), actualSaveDialog: true };
    },
    async nativeRound() {
      await basic("selected-next");
      await openPrimary("host");
      await perform("host", "recover-saved-file");
      await perform("host", "workbench-pick", { choice: original().uiFile.name });
      await perform("host", "workbench-file", { title: "Select saved attachment bytes", value: original().uiFile.savedPath });
      await until(async () => {
        const observed = await action("host", "observe-recovery");
        return observed.savedFileRecovery?.sha256 === original().uiFile.sha256;
      }, "explicit recovery completed without a new offer");
      await editNote("host", original().originalNote + "\nNative actual Workbench saved Note.\n" + "Preserved manual bytes.\n".repeat(4096));
    },
    async disconnect(role) { if (!exited) await perform(role, "disconnect"); },
    async close() {
      child.stdin.end();
      for (let count = 0; count < 50 && !exited; count++) await new Promise(resolve => setTimeout(resolve, 100));
      if (!exited) child.kill("SIGTERM");
      for (let count = 0; count < 50 && !exited; count++) await new Promise(resolve => setTimeout(resolve, 100));
      if (!exited) child.kill("SIGKILL");
      await new Promise(resolve => { if (exited) resolve(); else child.once("exit", resolve); });
    },
  };
};
