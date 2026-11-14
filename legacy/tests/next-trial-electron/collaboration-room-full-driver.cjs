"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto"), { createRequire } = require("node:module");
const vscode = require("vscode"), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.activate = async context => {
  const fixture = process.env.PKM_MEETING_INSTALLED_FIXTURE, role = process.env.PKM_COLLAB_ROLE;
  assert(fixture?.includes("/.migration-test-work/") && ["host", "guest"].includes(role));
  assert(context.globalStorageUri.fsPath.startsWith(path.join(fixture, `${role}-user/`)));
  const config = JSON.parse(fs.readFileSync(path.join(fixture, `${role}-complete-config.json`)));
  const file = path.join(fixture, `${role}-complete-state.json`), shared = path.join(fixture, "complete-original.json");
  const state = { phase: config.phase, role, extensionHostPid: process.pid, ready: false };
  const save = () => fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const until = async (check, label) => {
    for (let count = 0; count < 1800; count++) { if (await check()) return; await wait(50); }
    throw new Error("Actual installed product: " + label);
  };
  let timer, busy = false, lastAction, lastReceipt;
  try {
    const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    assert(extension && extension.extensionPath.startsWith(path.join(fixture, `${role}-extensions/`)));
    await extension.activate();
    const scope = process[Symbol.for("pkm.meeting.fixture." + fixture)];
    assert(scope?.__fixtureProductContext, "Actual product context, not a VM or rebound Manager.");
    const product = scope.__fixtureProductContext;
    const requireProduct = createRequire(path.join(extension.extensionPath, "dist/extension.js"));
    if (config.phase === "relocate") {
      const result = await vscode.commands.executeCommand("personalKnowledge.reconfigureKnowledgeRoot");
      assert.equal(result?.ok, true);
    }
    const root = requireProduct("./knowledge/filestore.js").getStorePath();
    assert.equal(root, config.oldRoot);
    const manager = scope.getChatMgr(), store = scope.currentProjectStore();
    const command = () => scope.projectCommand(store, "private-original-user-action", {});
    state.root = root;
    state.version = extension.packageJSON.version;
    state.actualProductContext = product !== context;
    state.hook = config.hook;
    if (config.phase === "seed") {
      assert.equal(product.globalState.get("chatIdentityCid"), undefined);
      const projectId = store.createProject(command(), "Original product Project").entityId;
      const threadId = store.createThread(command(), projectId, "Original product thread").entityId;
      const started = await manager.startHub(19175); assert(started.ok, started.error);
      let room;
      state.originalProjectLinkFailures = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        room = await manager.createHostedRoom(`Original product Project Room ${attempt + 1}`, undefined, { projectId, threadId });
        try {
          store.linkThreadChatroom(command(), threadId, { roomId: room.roomId, roomName: room.room, linkedAt: new Date().toISOString() });
          break;
        } catch (error) {
          if (error.code !== "chatroom-id-invalid") throw error;
          state.originalProjectLinkFailures.push({ roomId: room.roomId, code: error.code, dataPreserved: true });
          await manager.hub.adminCloseRoom(room.roomId);
          room = undefined;
        }
      }
      assert(room, "Preserved original numeric-UUID failures; no successful original association within the bounded setup.");
      const handoff = await manager.createHostedRoom("Original transcript-only takeover Room");
      await manager.hub.adminCloseRoom(handoff.roomId);
      await manager.stopHub();
      assert.equal(product.globalState.get("chatIdentityCid"), undefined,
        "Full original profile backup precedes independent Host/Guest client identities.");
      const credential = await new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)(product.secrets).load(room.roomId);
      const handoffCredential = await new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)(product.secrets).load(handoff.roomId);
      fs.writeFileSync(shared, JSON.stringify({ roomId: room.roomId, room: room.room, secret: room.secret,
        projectId, threadId, hostCredentialHash: credential.hostCredentialHash,
        handoff: { roomId: handoff.roomId, room: handoff.room, secret: handoff.secret,
          hostCredentialHash: handoffCredential.hostCredentialHash } }), { mode: 0o600 });
      state.ready = true; state.seedBeforeClientIdentity = true; save(); return;
    }
    if (config.phase === "relocate") { state.ready = true; save(); return; }
    const original = JSON.parse(fs.readFileSync(shared));
    const credentials = new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)(product.secrets);
    assert.equal((await credentials.load(original.roomId)).hostCredentialHash, original.hostCredentialHash,
      "Original full-profile backup authority; no synthetic Host secret is inserted.");
    assert.equal((await credentials.load(original.handoff.roomId)).hostCredentialHash, original.handoff.hostCredentialHash);
    state.cid = scope.getChatCid(product);
    state.project = store.list().threads.find(value => value.threadId === original.threadId);
    scope.openPanelTab(product, "portalConnections");
    let observedRoom;
    const connectedRoom = async (roomId, url, host) => {
      let found;
      await until(() => {
        found = [...manager.rooms.values()].find(value => value.roomId === roomId && value.url === url);
        return found?.client.isConnected && found.client.participantId && (!host || found.selfHost);
      }, "the exact requested Room connection and identity");
      observedRoom = found;
      manager.setActive(found.key);
      return found;
    };
    const refresh = async () => {
      if (state.expectChildCrash) {
        try { state.status = await vscode.commands.executeCommand("_personalKnowledge.nextCollaborationStatus"); }
        catch (error) { state.expectedOwnerUnavailable = error.message; }
        save(); return;
      }
      if (state.upgrade?.prepared) {
        state.status = await vscode.commands.executeCommand("_personalKnowledge.nextCollaborationStatus");
        assert.throws(() => manager.hostedRoomsForNavigation(), /revoked|changed|unavailable/);
        state.pendingReloadLegacyActionsDenied = true;
        save(); return;
      }
      const endpoint = manager.endpointStore?.list().find(value => value.root === root && !value.deleted);
      const peer = endpoint && manager.chatPortals.get(endpoint.id)?.room?.peer;
      state.endpoint = endpoint && { id: endpoint.id, paired: !!endpoint.paired,
        acceptsIncoming: endpoint.acceptsIncoming, permissions: endpoint.permissions };
      state.confirmed = !!peer?.endpointConfirmed;
      state.connected = !!(endpoint && manager.chatPortals.get(endpoint.id)?.room?.client.isConnected);
      state.pairId = peer?.binding?.pairId;
      state.invitation = endpoint && manager.portalPendingLinks.get(endpoint.id)?.link;
      state.receipt = lastReceipt && peer?.receipts.get(lastReceipt);
      state.rooms = manager.hostedRoomsForNavigation();
      state.activeRoomIds = manager.hub?.adminRooms().map(value => value.roomId) ?? [];
      state.actualActiveRoomId = manager.activeRoom?.roomId;
      state.uiCurrent = manager.activeRoom && { roomId: manager.activeRoom.roomId, room: manager.activeRoom.room,
        url: manager.activeRoom.url, connected: manager.activeRoom.client.isConnected,
        participantId: manager.activeRoom.client.participantId, selfHost: manager.activeRoom.selfHost,
        status: manager.activeRoom.status, statusDetail: manager.activeRoom.statusDetail,
        members: manager.activeRoom.members.map(member => ({ participantId: member.participantId, host: member.host })),
        messages: manager.activeRoom.messages.map(message => message.text) };
      state.uiFiles = manager.activeRoom && [...manager.activeRoom.files.values()].map(value => value.meta);
      state.uiMeetings = manager.activeRoom && manager.meetingStore?.snapshot(manager.activeRoom.roomId);
      const projects = store.list();
      state.uiProjects = { projects: projects.projects.map(value => ({ projectId: value.projectId, name: value.name })),
        threads: projects.threads.map(value => ({ threadId: value.threadId, projectId: value.projectId,
          name: value.name, chatroom: value.chatroom })) };
      state.observedRoomId = observedRoom?.roomId;
      state.joinedRooms = [...manager.rooms.values()].map(value => ({ roomId: value.roomId, room: value.room, url: value.url,
        connected: value.client.isConnected, participantId: value.client.participantId }));
      state.participantId = (observedRoom ?? manager.activeRoom)?.client.participantId;
      state.messages = (observedRoom ?? manager.activeRoom)?.messages.map(value => value.text) ?? [];
      if (config.phase !== "baseline")
        state.status = await vscode.commands.executeCommand("_personalKnowledge.nextCollaborationStatus");
      save();
    };
    const action = async input => {
      const selected = input.target === "handoff" ? original.handoff : original;
      state.actionRoomId = input.invitation?.roomId ?? selected.roomId;
      if (input.operation === "expect-child-crash") {
        state.expectChildCrash = true;
      } else if (input.operation === "observe-recovery") {
        const latest = JSON.parse(fs.readFileSync(shared));
        assert(path.resolve(state.status.root).startsWith(path.join(fixture, `${role}-user`) + path.sep));
        const database = new (require("node:sqlite").DatabaseSync)(path.join(state.status.root, "core.sqlite"), { readOnly: true });
        try {
          database.exec("PRAGMA query_only=ON");
          const row = database.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_file_recoveries'").get()
            && database.prepare("SELECT sha256 FROM next_room_file_recoveries WHERE room_id=? AND file_id=?")
              .get(latest.roomId, latest.uiFile.fileId);
          state.savedFileRecovery = row && { fileId: latest.uiFile.fileId, sha256: row.sha256 };
        } finally { database.close(); }
      } else if (input.operation === "observe-original-file") {
        const latest = JSON.parse(fs.readFileSync(shared));
        const matches = manager.activeRoom.messages.filter(value => value.file?.name === input.name);
        assert.equal(matches.length, 1);
        assert(path.resolve(input.savedPath).startsWith(fixture + path.sep));
        const bytes = fs.readFileSync(input.savedPath), metadata = matches[0].file;
        assert.equal(bytes.length, metadata.size);
        latest.uiFile = { ...metadata, savedPath: input.savedPath,
          sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex") };
        fs.writeFileSync(shared, JSON.stringify(latest), { mode: 0o600 });
        state.originalFileObserved = true;
      } else if (input.operation === "seed-editor-probe") {
        assert.equal(state.version, "4.0.22");
        const probe = { slug: "Editor Stability/Original editor probe", title: "Original editor probe",
          category: "Editor Stability", content: "Original real editor seed.\n" + "Rendered editor layout line.\n".repeat(80),
          type: "general", tags: [] };
        requireProduct("./knowledge/filestore.js").noteUpsert(probe);
        const latest = JSON.parse(fs.readFileSync(shared));
        latest.editorProbe = { slug: probe.slug, path: probe.slug + ".md", content: probe.content };
        fs.writeFileSync(shared, JSON.stringify(latest), { mode: 0o600 });
        state.editorProbeSeeded = true;
      } else if (["open-editor-probe", "observe-editor-probe"].includes(input.operation)) {
        const probe = JSON.parse(fs.readFileSync(shared)).editorProbe;
        const uri = vscode.Uri.from({ scheme: "pkm-content", authority: "notes", path: "/" + probe.path });
        if (input.operation === "open-editor-probe")
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
        const editor = vscode.window.activeTextEditor;
        assert(editor && editor.document.uri.toString() === uri.toString());
        const store = requireProduct("./knowledge/filestore.js");
        const bytes = await vscode.workspace.fs.readFile(uri);
        state.editorProbe = { uri: uri.toString(), dirty: editor.document.isDirty, text: editor.document.getText(),
          persistedContent: Buffer.from(bytes).toString("utf8"), statSize: (await vscode.workspace.fs.stat(uri)).size,
          physicalContent: store.noteGet(probe.slug).content,
          physicalRawSha256: require("node:crypto").createHash("sha256")
            .update(fs.readFileSync(path.join(root, "notes", probe.path))).digest("hex") };
      } else if (input.operation === "open-original-content-uri" || input.operation === "observe-note-editor") {
        const uri = vscode.Uri.from({ scheme: "pkm-content", authority: "notes", path: "/" + original.markdownPath });
        if (input.operation === "open-original-content-uri")
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
        const editor = vscode.window.activeTextEditor;
        assert(editor && editor.document.uri.toString() === uri.toString(), "Actual original content URI must be active.");
        state.noteEditor = { uri: uri.toString(), dirty: editor.document.isDirty, text: editor.document.getText() };
        try {
          state.noteEditor.persistedContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
          state.noteEditor.statSize = (await vscode.workspace.fs.stat(uri)).size;
        } catch (error) { state.noteEditor.readError = String(error); }
      } else if (input.operation === "observe-original-note") {
        const latest = JSON.parse(fs.readFileSync(shared));
        const note = require("./collaboration-room-note-observer.cjs")(requireProduct("./knowledge/filestore.js"), latest);
        latest.originalNote = note.content;
        latest.savedMarkdownPath = note.path;
        fs.writeFileSync(shared, JSON.stringify(latest), { mode: 0o600 });
        state.originalNoteObserved = true;
      } else if (input.operation === "observe-native-note") {
        const latest = JSON.parse(fs.readFileSync(shared));
        latest.expectedNativeNote = (await manager.meetingStore.readNote(latest.roomId, latest.meetingId)).content;
        fs.writeFileSync(shared, JSON.stringify(latest), { mode: 0o600 });
        state.nativeNoteSha256 = require("node:crypto").createHash("sha256").update(latest.expectedNativeNote).digest("hex");
      } else if (input.operation === "upgrade") {
        state.upgrade = await vscode.commands.executeCommand("personalKnowledge.upgradeCollaboration");
        assert.equal(state.upgrade.prepared, true, state.upgrade.error);
      } else if (["host", "rehost", "rehost-for-guest"].includes(input.operation)) {
        manager.setAdvertisedHost("127.0.0.1");
        const started = await manager.startHub(role === "host" ? 19175 : 19176); assert(started.ok, started.error);
        const room = await manager.rehostRoom(selected.roomId);
        manager.joinRoom({ ...room, ...(input.operation === "rehost-for-guest" ? { hostToken: undefined } : {}),
          url: started.wsUrl, user: role === "host" ? "Original Host" : "Original Guest", token: room.secret, cid: state.cid });
        const joined = await connectedRoom(selected.roomId, started.wsUrl, input.operation !== "rehost-for-guest");
        if (input.operation === "rehost-for-guest") {
          await until(() => joined.messages.some(value => value.text === "Late product history after upgrade"),
            "latest synchronized history received by the actual local Guest");
          state.localReceiverHistoryRecovered = true;
        }
        state.hosted = { roomId: room.roomId, room: room.room, url: started.wsUrl, secret: room.secret };
      } else if (input.operation === "join") {
        manager.joinRoom({ ...input.invitation, user: "Original Guest", token: input.invitation.secret, cid: state.cid });
        await connectedRoom(input.invitation.roomId, input.invitation.url, false);
      } else if (input.operation === "meeting") {
        assert(manager.send("Original product Discuss", true, "required", "discuss", ["all"]));
        await until(() => manager.meetingStore.snapshot(original.roomId).current, "original Meeting");
        const meeting = manager.meetingStore.snapshot(original.roomId).current;
        assert(manager.send("Original product opinion", true, "required", "chat", ["all"]));
        await until(() => manager.meetingStore.snapshot(original.roomId).current.revision > meeting.revision, "original opinion");
        await manager.adjournActiveMeeting(meeting.id, randomUUID(), manager.meetingStore.snapshot(original.roomId).current.revision);
        const record = manager.meetingStore.snapshot(original.roomId).history.find(value => value.id === meeting.id);
        const note = path.join(root, "notes", record.markdownPath);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(note)), edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(document.getText().length), "\nOriginal manual product Note.\n");
        assert(await vscode.workspace.applyEdit(edit)); assert(await document.save());
        Object.assign(original, { meetingId: meeting.id, markdownPath: record.markdownPath, originalNote: document.getText() });
        fs.writeFileSync(shared, JSON.stringify(original), { mode: 0o600 });
      } else if (input.operation === "command") {
        const endpoint = state.endpoint, peer = manager.chatPortals.get(endpoint.id)?.room?.peer;
        const command = requireProduct("./chatroom/portal-command.js").parsePortalCommand({
          program: "node", arguments: ["-e", input.slow
            ? `require('node:fs').appendFileSync(${JSON.stringify(path.join(fixture, "physical-slow-starts"))},'start\\n');setTimeout(()=>require('node:fs').appendFileSync(${JSON.stringify(path.join(fixture, "physical-slow-finishes"))},'finish\\n'),20000)`
            : `require('node:fs').appendFileSync(${JSON.stringify(path.join(fixture, "physical-command-runs"))},'run\\n');process.stdout.write('PRIVATE_PRODUCT_PORTAL_OK')`],
          timeoutSeconds: 30 });
        state.commandError = undefined;
        try { lastReceipt = peer.submitCommand(command); }
        catch (error) { state.commandError = error.message; }
      } else if (input.operation === "refresh") {
        await manager.startHub(role === "host" ? 19175 : 19176);
        await manager.refreshStoredRooms();
      } else if (input.operation === "force-close") {
        state.confirmedRelease = false;
        await manager.forceCloseHostedRoom(selected.roomId);
        state.confirmedRelease = true;
      } else if (input.operation === "public-force-close") {
        state.confirmedRelease = false;
        await manager.refreshStoredRooms();
        const room = manager.hostedRoomsForNavigation().find(value => value.roomId === selected.roomId);
        assert(room?.canForceClose, "The real navigation item must independently verify original Host authority.");
        await vscode.commands.executeCommand("personalKnowledge.forceCloseHostedRoom", { nodeData: room });
        await manager.refreshStoredRooms();
        assert.equal(manager.hostedRoomsForNavigation().find(value => value.roomId === selected.roomId).canRehost, true);
        state.confirmedRelease = true; state.actualPublicForceCloseCommand = true;
      } else if (input.operation === "join-only-close") {
        const probe = new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)({
          async get() { return selected.secret; },
        });
        const proof = await probe.createHostProof(selected.roomId, `force-close:${selected.roomId}`);
        const endpoint = new URL(input.url); endpoint.protocol = "http:";
        endpoint.pathname = `/api/rooms/${selected.roomId}/close`;
        const result = await fetch(endpoint, { method: "POST", headers: {
          "X-PKM-Host-Timestamp": String(proof.timestamp), "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature,
        } });
        assert.equal(result.status, 401);
        assert.equal(await result.text(), "Invalid Host proof");
        state.joinSecretHostDenied = true;
      } else if (input.operation === "old-recovery") {
        [...manager.rooms.values()].find(value => value.roomId === selected.roomId)?.client.disconnect();
        const OldClient = require(path.join(config.originalModules, "dist/chatroom/chatroom-client.js")).ChatClient;
        const messages = [];
        const client = new OldClient(new Proxy({ onHistory(value) { messages.push(...value); } },
          { get: (target, key) => target[key] ?? (() => {}) }));
        try {
          client.connect({ roomId: selected.roomId, room: selected.room, url: state.hosted.url,
            token: selected.secret, cid: state.cid, user: "Original Guest" });
          await until(() => client.isConnected && client.participantId, "unmodified original client recovery");
          state.oldRecovery = { participantId: client.participantId, history: messages.map(value => value.text) };
        } finally { client.disconnect(); }
      } else if (input.operation === "project-interrupted") {
        const threadId = store.createThread(command(), original.projectId, "New product thread").entityId;
        const room = await manager.createHostedRoom("Original product Project · New product thread", undefined,
          { projectId: original.projectId, threadId });
        state.interrupted = { threadId, roomId: room.roomId };
        assert(!store.list().threads.find(value => value.threadId === threadId).chatroom);
      } else if (input.operation === "project-resume") {
        const responses = [];
        await scope.handleMessage({ command: "threadOpenChatroom", threadId: state.interrupted.threadId }, value => responses.push(value), product);
        assert(!responses.some(value => value.command === "projectError"), JSON.stringify(responses));
        const linked = store.list().threads.find(value => value.threadId === state.interrupted.threadId).chatroom;
        assert.equal(linked.roomId, state.interrupted.roomId);
        state.projectRetrySameRoom = true;
      } else if (input.operation === "note") {
        assert.equal((await manager.meetingStore.readNote(original.roomId, original.meetingId)).content,
          JSON.parse(fs.readFileSync(shared)).expectedNativeNote ?? JSON.parse(fs.readFileSync(shared)).originalNote);
        state.manualNoteRecovered = true;
      } else if (input.operation === "leave-remote") {
        assert(!manager.hub.adminRooms().some(value => value.roomId === selected.roomId));
        const connection = [...manager.rooms.values()].find(value => value.roomId === selected.roomId);
        if (connection) await manager.closeOrLeaveRoom(connection.key);
        assert(![...manager.rooms.values()].some(value => value.roomId === selected.roomId));
        observedRoom = undefined;
        state.remoteRoomExplicitlyLeftOrAlreadyClosed = true;
      } else if (input.operation === "send") {
        const room = [...manager.rooms.values()].find(value => value.roomId === selected.roomId);
        if (room) manager.setActive(room.key);
        assert(manager.send(input.text, true, "required", "chat", ["all"]));
      } else if (input.operation === "stop") await manager.stopHub();
      else if (input.operation === "strict") {
        await vscode.workspace.getConfiguration("personalKnowledge").update("nextCollaborationStrict", true, vscode.ConfigurationTarget.Global);
      } else if (input.operation === "local-owner") {
        await vscode.workspace.getConfiguration("personalKnowledge").update("chatHubUrl", "", vscode.ConfigurationTarget.Global);
        state.oldRemoteHintExplicitlyClearedAfterConfirmedTakeover = true;
      } else throw new Error("Unknown private observation action.");
    };
    state.ready = true; await refresh();
    const previousControl = path.join(fixture, `${role}-complete-action.json`);
    if (fs.existsSync(previousControl)) lastAction = JSON.parse(fs.readFileSync(previousControl)).id;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        const control = path.join(fixture, `${role}-complete-action.json`);
        if (fs.existsSync(control)) {
          const input = JSON.parse(fs.readFileSync(control));
          if (input.id !== lastAction) {
            lastAction = input.id; state.actionError = undefined;
            state.pendingOperation = input.operation;
            state.actionStartedAt = new Date().toISOString();
            save();
            try { await action(input); } catch (error) { state.actionError = error.stack || String(error); }
            delete state.pendingOperation;
            state.completed = input.id;
          }
        }
        await refresh();
      })().catch(error => { state.error = error.stack || String(error); save(); }).finally(() => { busy = false; });
    }, 200);
    context.subscriptions.push({ dispose() { clearInterval(timer); } });
  } catch (error) { state.error = error.stack || String(error); save(); }
};
