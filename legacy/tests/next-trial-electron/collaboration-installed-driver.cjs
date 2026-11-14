"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const vscode = require("vscode");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.activate = async context => {
  const fixture = process.env.PKM_MEETING_INSTALLED_FIXTURE, role = process.env.PKM_COLLAB_ROLE;
  assert(fixture?.includes(`${path.sep}.migration-test-work${path.sep}`) && ["host", "guest"].includes(role));
  assert(context.globalStorageUri.fsPath.startsWith(path.join(fixture, `${role}-user`) + path.sep));
  const config = JSON.parse(fs.readFileSync(path.join(fixture, `${role}-collab-config.json`)));
  const events = path.join(fixture, `${role}-collab-events.jsonl`), stateFile = path.join(fixture, "production-state.json");
  const emit = (event, data = {}) => fs.appendFileSync(events, JSON.stringify({ phase: config.phase, event, ...data }) + "\n", { mode: 0o600 });
  const until = async (check, label) => {
    const end = Date.now() + 90000;
    while (Date.now() < end) { if (await check()) return; await wait(50); }
    throw new Error("Actual installed Collaboration timeout: " + label);
  };
  try {
    const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    assert(extension && fs.realpathSync(extension.extensionPath).startsWith(path.join(fixture, `${role}-extensions`) + path.sep));
    await extension.activate();
    const scope = process[Symbol.for("pkm.meeting.fixture." + fixture)];
    assert(scope?.__fixtureProductContext, "Read the actually activated product; no VM rebound or injected owner.");
    const product = scope.__fixtureProductContext, manager = scope.getChatMgr(), cid = scope.getChatCid(product);
    const requireProduct = createRequire(path.join(extension.extensionPath, "dist/extension.js"));
    const originalRoot = requireProduct("./knowledge/filestore.js").getStorePath();
    assert.equal(originalRoot, config.oldRoot);
    emit("activated", { version: extension.packageJSON.version, extensionHostPid: process.pid,
      actualProductContext: product !== context, originalRoot, installed: config.installed,
      originalCompiledSha256: config.originalCompiledSha256, observationOnlyHook: config.privateObserverHook });
    await vscode.commands.executeCommand("personalKnowledge.openChatroom");
    const readState = () => JSON.parse(fs.readFileSync(stateFile));
    if (role === "guest") {
      const sourceFile = config.phase === "baseline" ? stateFile : path.join(fixture, `${config.phase}-host.json`);
      await until(() => fs.existsSync(sourceFile), "real Host invitation");
      const invitation = JSON.parse(fs.readFileSync(sourceFile)), state = readState();
      if (config.phase !== "baseline") {
        const status = await vscode.commands.executeCommand("_personalKnowledge.nextCollaborationStatus");
        assert.equal(status.route, "legacy", "Unselected upgraded profile keeps its original route.");
      }
      manager.joinRoom({ roomId: invitation.roomId, room: invitation.room, url: invitation.url,
        user: "Original Guest", token: invitation.secret, cid });
      await until(() => manager.activeRoom?.client.isConnected && manager.activeRoom.client.participantId, "real Guest join");
      const participantId = manager.activeRoom.client.participantId;
      if (config.phase !== "baseline") {
        const original = JSON.parse(fs.readFileSync(path.join(fixture, "baseline-guest.json")));
        assert.equal(participantId, original.participantId);
        assert.equal(cid, original.cid);
        await until(() => manager.activeRoom.messages.some(message => message.text === "Original installation recorded opinion"), "original network history");
        if (config.phase === "native-restart")
          await until(() => manager.activeRoom.messages.some(message => message.text === "Native write after the actual profile upgrade"), "latest persisted native message");
      }
      fs.writeFileSync(path.join(fixture, `${config.phase}-guest.json`), JSON.stringify({ cid, participantId,
        latestHistory: manager.activeRoom.messages.map(message => message.text), actualClient: true }), { mode: 0o600 });
      emit("phase-complete", { participantId, cidPreserved: config.phase !== "baseline",
        defaultLegacyRoute: config.phase !== "baseline" });
      return;
    }
    if (config.phase === "baseline") {
      manager.setAdvertisedHost("127.0.0.1");
      const started = await manager.startHub(0); assert(started.ok, started.error);
      const room = await manager.createHostedRoom("Original production recovery");
      manager.joinRoom({ ...room, url: started.wsUrl, user: "Original Host", token: room.secret, cid });
      await until(() => manager.activeRoom?.selfHost && manager.activeRoom.client.isConnected, "original Host");
      const state = { ...room, url: started.wsUrl, cid, participantId: manager.activeRoom.client.participantId };
      delete state.hostToken;
      fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      await until(() => fs.existsSync(path.join(fixture, "baseline-guest.json")), "original second Code profile");
      assert(manager.send("Original installation Discuss topic", true, "required", "discuss", ["all"]));
      await until(() => manager.meetingStore.snapshot(room.roomId).current, "original Meeting reducer");
      const meeting = manager.meetingStore.snapshot(room.roomId).current;
      assert(manager.send("Original installation recorded opinion", true, "required", "chat", ["all"]));
      await until(() => manager.meetingStore.snapshot(room.roomId).current.revision > meeting.revision, "original opinion");
      await manager.adjournActiveMeeting(meeting.id, randomUUID(), manager.meetingStore.snapshot(room.roomId).current.revision);
      const record = manager.meetingStore.snapshot(room.roomId).history.find(value => value.id === meeting.id);
      const note = path.join(config.oldRoot, "notes", record.markdownPath);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(note)), edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(document.getText().length), "\nOriginal manual Note edit must survive installation.\n");
      assert(await vscode.workspace.applyEdit(edit)); assert(await document.save());
      const ordinaryNote = path.join(config.oldRoot, "notes/Independent original Note.md");
      await vscode.workspace.fs.writeFile(vscode.Uri.file(ordinaryNote), Buffer.from("# Independent original Note\n\nOriginal file route remains available.\n"));
      await manager.stopHub();
      const credentials = await new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)(product.secrets).load(room.roomId);
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, meetingId: meeting.id, markdownPath: record.markdownPath,
        originalNote: document.getText(), ordinaryNote, hostCredentialHash: credentials.hostCredentialHash,
        originalSnapshot: manager.meetingStore.snapshot(room.roomId) }), { mode: 0o600 });
      emit("phase-complete", { originalHostParticipantId: state.participantId, actualProductSecretStorage: true,
        originalMeetingId: meeting.id, manualNoteSha256: createHash("sha256").update(document.getText()).digest("hex") });
      return;
    }
    const state = readState();
    const credentials = await new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)(product.secrets).load(state.roomId);
    assert.equal(credentials.hostCredentialHash, state.hostCredentialHash, "Original Host credential survives actual install; never copied by bootstrap.");
    if (config.phase === "prepare") {
      const before = await vscode.commands.executeCommand("_personalKnowledge.nextCollaborationStatus");
      assert.equal(before.route, "legacy");
      const prepared = await vscode.commands.executeCommand("personalKnowledge.upgradeCollaboration");
      assert.equal(prepared.prepared, true, prepared.error);
      emit("phase-complete", { realUpgradeCommand: true, originalHostSecretStorage: true,
        workspaceId: prepared.workspaceId, sameRootAdoption: prepared.sameRootAdoption });
      return;
    }
    const status = await vscode.commands.executeCommand("_personalKnowledge.nextCollaborationStatus");
    assert.equal(status.route, "next-collaboration", status.error);
    assert.equal(status.sourceRoot, config.oldRoot);
    assert(status.root.startsWith(product.globalStorageUri.fsPath + path.sep));
    assert.notEqual(status.root, path.join(fixture, "next-root"), "No fixture bootstrap root is used.");
    assert.equal((await manager.meetingStore.readNote(state.roomId, state.meetingId)).content, state.originalNote);
    assert.deepEqual(manager.meetingStore.snapshot(state.roomId), state.originalSnapshot);
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(state.ordinaryNote))).getText(),
      "# Independent original Note\n\nOriginal file route remains available.\n");
    manager.setAdvertisedHost("127.0.0.1");
    const started = await manager.startHub(0); assert(started.ok, started.error);
    const room = await manager.rehostRoom(state.roomId);
    manager.joinRoom({ ...room, url: started.wsUrl, user: "Original Host", token: room.secret, cid });
    await until(() => manager.activeRoom?.selfHost && manager.activeRoom.client.isConnected, "restored real Host");
    assert.equal(manager.activeRoom.client.participantId, state.participantId);
    fs.writeFileSync(path.join(fixture, `${config.phase}-host.json`), JSON.stringify({ ...room, url: started.wsUrl }), { mode: 0o600 });
    await until(() => fs.existsSync(path.join(fixture, `${config.phase}-guest.json`)), "restored original Guest");
    if (config.phase === "native-first") {
      assert(manager.send("Native write after the actual profile upgrade", true, "required", "chat", ["all"]));
      await until(() => manager.activeRoom.messages.some(message => message.text === "Native write after the actual profile upgrade"), "native durable message");
    }
    assert.equal(await manager.openActiveMeetingNote(state.meetingId), true);
    await manager.stopHub();
    emit("phase-complete", { status, originalHostIdPreserved: true, originalMeetingAndManualNotePreserved: true,
      normalNoteFileRoutePreserved: true, originalGuestRestored: true, nativeRestart: config.phase === "native-restart" });
  } catch (error) {
    emit("driver-failed", { message: error.stack || String(error) });
  }
};
