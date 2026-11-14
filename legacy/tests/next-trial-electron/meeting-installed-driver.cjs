"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const vscode = require("vscode");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash("sha256").update(text).digest("hex");

exports.activate = async context => {
  const fixture = process.env.PKM_MEETING_INSTALLED_FIXTURE;
  if (!fixture || !fixture.includes(`${path.sep}.migration-test-work${path.sep}`)
    || fs.realpathSync(fixture) !== fixture
    || !context.globalStorageUri.fsPath.startsWith(path.join(fixture, "host-user") + path.sep))
    throw new Error("Meeting driver requires its own private fixture/profile.");
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8"));
  const stateFile = path.join(fixture, "meeting-state.json");
  const emit = (event, data = {}) => fs.appendFileSync(path.join(fixture, "host-events.jsonl"),
    JSON.stringify({ event, phase: config.phase, ...data }) + "\n", { mode: 0o600 });
  const until = async (check, label) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (await check()) return; await wait(30); }
    throw new Error(`Meeting driver timed out: ${label}`);
  };
  let manager, registration, storage, guest;
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  if (!extension || !fs.realpathSync(extension.extensionPath).startsWith(path.join(fixture, "host-extensions") + path.sep))
    throw new Error("Meeting product must be installed in the private extension directory.");
  try {
    await extension.activate();
    const requireProduct = createRequire(path.join(extension.extensionPath, "dist/extension.js"));
    const actualScope = process[Symbol.for("pkm.meeting.fixture." + fixture)];
    assert(actualScope, "The actual activated product module must supply its scope, not a cold duplicate require.");
    const scope = Object.fromEntries(Object.entries(actualScope));
    const productContext = scope.__fixtureProductContext;
    assert(productContext?.secrets && productContext !== context, "Use the actual product SecretStorage namespace.");
    emit("product-activated", { version: extension.packageJSON.version, extensionHostPid: process.pid,
      node: process.versions.node, classSha256: config.classSha256 });
    const actualExport = name => scope[name] ?? Object.values(scope).find(value => value && typeof value[name] === "function")?.[name];
    const joinDiscussRecipient = async (room, url) => {
      const Client = actualExport("ChatClient");
      assert.equal(typeof Client, "function");
      guest = new Client({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {},
        onRejected(code, message) { emit("guest-rejected", { code, message }); } });
      guest.connect({ room: room.room, roomId: room.roomId, url, user: `Private ${config.phase} Guest`,
        token: room.secret, cid: `meeting-fixture-${config.phase}`, kind: "human" });
      await until(() => guest.isConnected, "actual installed Discuss recipient");
      emit("discuss-recipient-connected", { participantId: guest.participantId, client: "actual installed protocol class, not a second Code profile" });
    };
    if (config.phase === "baseline") {
      manager = scope.getChatMgr();
      manager.setAdvertisedHost("127.0.0.1");
      const started = await manager.startHub(0);
      assert(started.ok, started.error);
      const room = await manager.createHostedRoom("Original private Meeting", "synthetic-meeting-secret");
      const cid = scope.getChatCid(productContext);
      manager.joinRoom({ ...room, url: started.wsUrl, user: "Original private Host", token: room.secret, cid });
      await until(() => manager.activeRoom?.selfHost && manager.activeRoom.client.isConnected, "original Host identity and ready transport");
      const participantId = manager.activeRoom.client.participantId;
      await joinDiscussRecipient(room, started.wsUrl);
      assert(manager.send("Original installation Discuss topic", true, "required", "discuss", ["all"]));
      await until(() => manager.meetingStore.snapshot(room.roomId).current, "original Discuss reducer");
      const meeting = manager.meetingStore.snapshot(room.roomId).current;
      manager.send("Original installation recorded opinion", true, "required", "chat", ["all"]);
      await until(() => manager.meetingStore.snapshot(room.roomId).current.revision > meeting.revision, "original opinion");
      const current = manager.meetingStore.snapshot(room.roomId).current;
      await manager.adjournActiveMeeting(meeting.id, randomUUID(), current.revision);
      const record = manager.meetingStore.snapshot(room.roomId).history.find(item => item.id === meeting.id);
      const note = path.join(config.oldRoot, "notes", record.markdownPath);
      assert(note.startsWith(path.join(config.oldRoot, "notes") + path.sep));
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(note));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, document.positionAt(document.getText().length), "\nOriginal private manual Note edit.\n");
      assert(await vscode.workspace.applyEdit(edit));
      assert(await document.save());
      const text = document.getText();
      assert.match(text, /Original private manual Note edit/);
      const CredentialStore = requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore;
      const credentials = await new CredentialStore(productContext.secrets).load(room.roomId);
      assert(credentials?.hostCredential);
      await manager.dispose(); manager = undefined;
      fs.writeFileSync(stateFile, JSON.stringify({ roomId: room.roomId, meetingId: meeting.id, cid, participantId,
        markdownPath: record.markdownPath, goldenNote: text, originalSnapshot: scope.getChatMgr().meetingStore.snapshot(room.roomId),
        baselineExtensionHostPid: process.pid }, null, 2), { mode: 0o600 });
      emit("phase-complete", { noteSha256: hash(text), realProductSecretStorage: true });
      return;
    }
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const native = await import(pathToFileURL(path.join(fixture, "native/native.mjs")));
    const CredentialStore = requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore;
    const credentials = new CredentialStore(productContext.secrets);
    assert(await credentials.load(state.roomId), "Original product profile credentials survived installation/restart.");
    let allowed = true;
    const privateAdmission = {
      profile: productContext.secrets, credentials,
      assertAuthority() {
        if (!allowed || config.nextRoot !== path.join(fixture, "next-root")) throw new Error("Private Meeting actor revoked.");
      },
      async authorize(binding) {
        assert.equal(binding.root, config.nextRoot);
        assert.equal(binding.sourceRoot, config.oldRoot);
        assert.equal(binding.roomId, state.roomId);
        if (binding.operation !== "admit") return allowed;
        const choice = await vscode.window.showWarningMessage(
          "Admit this exact retained Room and its private Meeting Notes?",
          { modal: true, detail: `Room: ${state.roomId}\nOriginal: ${config.oldRoot}\nTarget: ${config.nextRoot}\n`
            + `Meeting fingerprint: ${binding.meetingHash}\nOriginal files and manual annotations are preserved. `
            + "Private Note copies never enter the public Notes library. This is not production root adoption." },
          "Admit Room and Private Notes");
        return choice === "Admit Room and Private Notes" && allowed;
      },
    };
    if (config.phase === "owned-conflict") {
      await assert.rejects(native.openPrivateRoomAdmissions({ ...privateAdmission, root: config.nextRoot }), /Original Room\/Note source changed/);
      assert.equal(fs.readFileSync(path.join(config.oldRoot, "notes", state.markdownPath), "utf8"), state.conflictOriginalNote);
      const area = path.join(config.nextRoot, ".pkm-room-admission");
      const intent = fs.readdirSync(area)[0];
      const notes = path.join(area, intent, "notes");
      assert.equal(fs.readFileSync(path.join(notes, fs.readdirSync(notes)[0]), "utf8"), state.goldenNote);
      assert.equal(fs.readdirSync(path.join(config.nextRoot, "notes")).length, 0);
      emit("actual-code-conflict-recovery-refused", { originalUserEditPreserved: true, privatePriorTextPreserved: true,
        nativeWorkerNotStarted: true, publicNoteCopies: false });
      emit("phase-complete");
      return;
    }
    if (config.phase === "owned-first") {
      storage = await native.Storage.open(config.nextRoot, { deferRecovery: true });
      await native.admitPrivateRoom({ ...privateAdmission, storage, sourceRoot: config.oldRoot, roomId: state.roomId });
      emit("exact-private-room-note-admission", { publicNoteCopies: false, originalManualBytesRetained: true });
      const savedIndex = JSON.parse(await productContext.secrets.get(`personalKnowledge.next.privateRoomAdmission.v1.${await storage.workspaceId()}`));
      const intent = path.join(config.nextRoot, ".pkm-room-admission", savedIndex.entries[0].plan.intentId);
      emit("admission-digest-readback", { profileStageHash: savedIndex.entries[0].stageHash,
        immutableProfileStageHash: await productContext.secrets.get(
          `personalKnowledge.next.privateRoomAdmissionStage.v1.${await storage.workspaceId()}.${savedIndex.entries[0].plan.intentId}`),
        diskStageHash: hash(JSON.stringify(JSON.parse(fs.readFileSync(path.join(intent, "staged.json"), "utf8")))),
        profileEntries: savedIndex.entries.length });
    } else storage = await native.openPrivateRoomAdmissions({ ...privateAdmission, root: config.nextRoot });
    const workspaceId = await storage.workspaceId();
    const retained = {
      ChatHub: actualExport("ChatHub"),
      ChatJoinApprovalManager: actualExport("ChatJoinApprovalManager") ?? requireProduct("./chatroom/chat-join-approval.js").ChatJoinApprovalManager,
      MeetingStateStore: actualExport("MeetingStateStore"),
      WebSocketServer: requireProduct("ws").WebSocketServer,
    };
    assert(Object.values(retained).every(value => typeof value === "function"));
    const ownerModule = Object.values(scope).find(value => typeof value?.registerAdoptedRoomHostOwner === "function");
    assert(ownerModule, "The installed class and registration must share the actual selected-owner module.");
    registration = ownerModule.registerAdoptedRoomHostOwner({
      root: config.nextRoot, workspaceId, qualification: "new-next-workspace",
      assertAuthority() { if (!allowed) throw new Error("Private Meeting actor revoked."); storage.assertWorkspaceLease(); },
      createHub(ui, selected) { return native.createNextRoomUiHub({ ...ui, storage, workspaceId, credentials, retained,
        qualification: "new-next-workspace", assertAuthority() { selected(); if (!allowed) throw new Error("Private Meeting actor revoked."); } }); },
    });
    for (const [name, value] of Object.entries(scope)) {
      if (name === "getStorePath") scope[name] = () => config.nextRoot;
      else if (value && typeof value.getStorePath === "function")
        scope[name] = { ...value, getStorePath: () => config.nextRoot };
    }
    const classSource = fs.readFileSync(path.join(fixture, "installed-manager-class.js"), "utf8");
    assert.equal(hash(classSource), config.classSha256);
    const Manager = vm.compileFunction(`return (${classSource});`, Object.keys(scope))(...Object.values(scope));
    manager = new Manager();
    assert.equal(typeof manager.requireHub().meetingStore?.readNote, "function",
      "The actual selected owner, not a legacy filesystem fallback, must supply the installed store.");
    manager.setAdvertisedHost("127.0.0.1");
    manager.configurePersistence(path.join(config.nextRoot, "chatrooms"), "private-installed-profile", productContext.secrets);
    await manager.refreshStoredRooms();
    emit("host-policy-ready", { workspaceId, explicitHeldStorageOwner: true, productionAdoption: false });
    const started = await manager.startHub(0);
    assert(started.ok, started.error);
    const reopened = await manager.rehostRoom(state.roomId);
    manager.joinRoom({ ...reopened, url: started.wsUrl, user: "Original private Host", token: reopened.secret, cid: state.cid });
    await until(() => manager.activeRoom?.selfHost && manager.activeRoom.client.isConnected, "installed original Host rehost and ready transport");
    assert.equal(manager.activeRoom.client.participantId, state.participantId, "Actual original Host identity must be preserved.");
    assert.deepEqual(manager.meetingStore.snapshot(state.roomId),
      config.phase === "owned-restart" ? state.afterStop : state.originalSnapshot);
    assert.equal((await manager.meetingStore.readNote(state.roomId, state.meetingId)).content, state.goldenNote);
    assert(await manager.openActiveMeetingNote(state.meetingId));
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.scheme, "pkm-room-meeting");
    assert.equal(editor.document.getText(), state.goldenNote);
    // Extension edit APIs can mutate virtual buffers; exercise the user's typing command instead.
    await vscode.commands.executeCommand("type", { text: "UNAUTHORIZED EDIT\n" });
    assert.equal(editor.document.getText(), state.goldenNote, "Actual virtual Note editor must reject user typing.");
    assert.equal(editor.document.isDirty, false);
    assert.equal((await manager.meetingStore.readNote(state.roomId, state.meetingId)).content, state.goldenNote);
    emit("readonly-note-open", { scheme: editor.document.uri.scheme, noteSha256: hash(editor.document.getText()),
      userTypingRejected: true, extensionBufferEditAPIsNotQualified: true });
    const saved = await credentials.load(state.roomId);
    await credentials.delete(state.roomId);
    try { await assert.rejects(manager.meetingStore.readNote(state.roomId, state.meetingId), /credentials|Host|authorize/i); }
    finally {
      await productContext.secrets.store(`personalKnowledge.chatroom.${state.roomId}.host`, saved.hostCredential);
      await productContext.secrets.store(`personalKnowledge.chatroom.${state.roomId}.join`, saved.joinSecret);
    }
    allowed = false;
    try { await assert.rejects(manager.meetingStore.readNote(state.roomId, state.meetingId), /revoked/); }
    finally { allowed = true; }
    emit("live-authority-and-secret-rejections", { legacyCredentialsRestored: true });
    const pinKey = `personalKnowledge.next.privateRoomAdmission.v1.${workspaceId}`;
    const pin = await productContext.secrets.get(pinKey);
    assert(pin);
    await productContext.secrets.delete(pinKey);
    try { await assert.rejects(manager.meetingStore.readNote(state.roomId, state.meetingId), /profile authorization was removed/); }
    finally { await productContext.secrets.store(pinKey, pin); }
    emit("independent-private-profile-pin-rejection");
    if (config.phase === "owned-first") {
      await joinDiscussRecipient(reopened, started.wsUrl);
      let snapshot = manager.meetingStore.snapshot(state.roomId);
      await manager.mutateMeetingTrash("trash", state.meetingId, randomUUID(), snapshot.history[0].revision);
      await until(() => /Meeting Note unavailable/.test(editor.document.getText()), "actual open editor Trash refresh");
      snapshot = manager.meetingStore.snapshot(state.roomId);
      await manager.mutateMeetingTrash("restore", state.meetingId, randomUUID(), snapshot.trash[0].revision);
      await until(() => editor.document.getText() === state.goldenNote, "actual open editor Restore refresh");
      manager.send("Installed Next Discuss; normal Host shutdown must adjourn", true, "required", "discuss", ["all"]);
      await until(() => manager.meetingStore.snapshot(state.roomId).current, "installed Next Discuss");
      const currentId = manager.meetingStore.snapshot(state.roomId).current.id;
      await manager.dispose();
      state.afterStop = manager.meetingStore.snapshot(state.roomId);
      assert.equal(state.afterStop.current, null);
      assert(state.afterStop.history.some(meeting => meeting.id === currentId));
      state.firstExtensionHostPid = process.pid;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
      manager = undefined;
      emit("normal-host-shutdown-adjourned");
    } else {
      assert.notEqual(process.pid, state.firstExtensionHostPid);
      emit("actual-code-restart-restored", { originalIdentityCidPreserved: true,
        previousExtensionHostPid: state.firstExtensionHostPid, extensionHostPid: process.pid });
      await manager.dispose(); manager = undefined;
    }
    await registration.dispose(); registration = undefined;
    await storage.close(); storage = undefined;
    if (config.phase === "owned-restart") {
      const original = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(config.oldRoot, "notes", state.markdownPath)));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(original.uri, original.positionAt(original.getText().length), "\nLater original user edit; preserve both versions on recovery conflict.\n");
      assert(await vscode.workspace.applyEdit(edit));
      assert(await original.save());
      state.conflictOriginalNote = original.getText();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
      emit("actual-original-user-edit-before-conflict-restart", { noteSha256: hash(state.conflictOriginalNote) });
    }
    emit("phase-complete", { realProductSecretStorage: true, ordinaryProductionEntry: false });
  } catch (error) {
    const room = manager?.activeRoom;
    if (room) emit("room-diagnostic", {
      roomId: room.roomId, participantId: room.client.participantId,
      status: room.status, connected: room.client.isConnected, selfHost: room.selfHost,
      messages: room.messages.slice(-8).map(({ text, mode, system }) => ({ text, mode, system })),
      meetingStoreFields: Object.keys(manager.meetingStore ?? {}),
      snapshot: manager.meetingStore?.snapshot(room.roomId),
    });
    emit("driver-failed", { message: error.stack || String(error) });
  }
  finally {
    guest?.disconnect();
    try { await manager?.dispose(); } catch (error) { emit("cleanup-error", { message: String(error) }); }
    try { await registration?.dispose(); } catch (error) { emit("cleanup-error", { message: String(error) }); }
    try { await storage?.close(); } catch (error) { emit("cleanup-error", { message: String(error) }); }
  }
};
