"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");

exports.activate = async context => {
  const vscode = require("vscode"), fixture = process.env.PKM_MEETING_INSTALLED_FIXTURE;
  const role = process.env.PKM_DUAL_PORTAL_ROLE;
  if (!fixture || !["host", "guest"].includes(role)
    || !context.globalStorageUri.fsPath.startsWith(path.join(fixture, `${role}-user`) + path.sep))
    throw new Error("Dual Portal driver requires its exact isolated profile.");
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8"));
  const root = role === "host" ? config.nextRoot : config.guestNextRoot;
  const stateFile = path.join(fixture, `${role}-portal-ui-state.json`);
  const emit = (event, data = {}) => fs.appendFileSync(path.join(fixture, "host-events.jsonl"),
    JSON.stringify({ phase: config.phase, role, event, ...data }) + "\n", { mode: 0o600 });
  let storage, registration, manager, panel, timer, endpoint, roomInfo, lastReceipt, ownedHub, historyProxy;
  let live = true, busy = false, cutHistory = true, historySequence = 0;
  const historyClients = [], proxySockets = new Set();
  const state = { ready: false, role, runs: 0, extensionHostPid: process.pid };
  const writeState = () => fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  try {
    const product = vscode.extensions.getExtension("Uone.personal-knowledge");
    assert(fs.realpathSync(product.extensionPath).startsWith(path.join(fixture, `${role}-extensions`) + path.sep));
    await product.activate();
    const scope = process[Symbol.for("pkm.meeting.fixture." + fixture)];
    assert(scope, "Do not cold-require a separate product owner registry.");
    const globals = Object.fromEntries(Object.entries(scope)), productContext = scope.__fixtureProductContext;
    assert(productContext !== context && productContext.secrets);
    const actual = name => scope[name] ?? Object.values(scope).find(value => typeof value?.[name] === "function")?.[name];
    const requireProduct = createRequire(path.join(product.extensionPath, "dist/extension.js"));
    const commands = requireProduct("./chatroom/portal-command.js");
    const native = await import(pathToFileURL(path.join(fixture, "native/native.mjs")));
    storage = await native.Storage.open(root, { deferRecovery: true });
    const workspaceId = await storage.workspaceId();
    const credentials = new (requireProduct("./chatroom/chat-room-credentials.js").ChatRoomCredentialStore)(productContext.secrets);
    const statusFile = path.join(fixture, "remote-room-status.json");
    registration = actual("registerAdoptedRoomHostOwner")({ root, workspaceId, qualification: "new-next-workspace",
      assertAuthority() { if (!live) throw new Error("Dual Portal owner revoked."); storage.assertWorkspaceLease(); },
      createHub(ui, selected) {
        return ownedHub = native.createNextRoomUiHub({ ...ui, storage, workspaceId, credentials, qualification: "new-next-workspace",
          ...(config.liveHistory && role === "host" ? { historyExport: true } : {}),
          retained: { ChatHub: actual("ChatHub"), ChatJoinApprovalManager: actual("ChatJoinApprovalManager")
            ?? requireProduct("./chatroom/chat-join-approval.js").ChatJoinApprovalManager,
            WebSocketServer: requireProduct("ws").WebSocketServer },
          assertAuthority() { selected(); if (!live) throw new Error("Dual Portal owner revoked."); },
          ...(role === "guest" ? { remoteRooms: { ...(config.liveHistory ? { synchronizeHistory: true } : {}), async resolve(id) {
            if (!roomInfo || id !== roomInfo.definition.roomId || !fs.existsSync(statusFile)) return undefined;
            return JSON.parse(fs.readFileSync(statusFile, "utf8"));
          } } } : {}),
          portal: {
            async authorize(input) {
              if (input.root !== root) return false;
              if (input.operation !== "command") return true;
              const answer = await vscode.window.showWarningMessage("Admit this exact private Portal command?",
                { modal: true, detail: `Request ${input.detail.requestId}\nPer-command workspace-owner approval, separate from saved local permissions.` },
                "Admit command once", "Deny command");
              emit("owner-command-decision", { accepted: answer === "Admit command once" });
              return answer === "Admit command once";
            },
            async executeCommand(input) {
              state.runs++; writeState();
              return commands.executePortalCommand(path.join(productContext.globalStorageUri.fsPath, "portal-processes", input.contextId),
                `${input.pairId}:${input.requestId}`, input.command, input.defaultCwd, input.signal);
            },
          },
        });
      },
    });
    for (const [name, value] of Object.entries(globals)) {
      if (name === "getStorePath") globals[name] = () => root;
      else if (value && typeof value.getStorePath === "function") globals[name] = { ...value, getStorePath: () => root };
    }
    const classSource = fs.readFileSync(path.join(fixture, `${role}-installed-manager-class.js`), "utf8");
    const Manager = vm.compileFunction(`return (${classSource});`, Object.keys(globals))(...Object.values(globals));
    manager = new Manager();
    manager.push = () => {};
    manager.setAdvertisedHost("127.0.0.1");
    manager.configurePersistence(path.join(root, "chatrooms"), `dual-private-${role}`, productContext.secrets);
    manager.configurePortalJournal(productContext.workspaceState);
    manager.configurePersistentPortals(productContext);
    panel = vscode.window.createWebviewPanel("privatePortalJourney", `Private Portal · ${role}`, vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true });
    const renderer = fs.readFileSync(path.join(fixture, "portal-renderer.js"), "utf8");
    panel.webview.html = `<!doctype html><html><body><div id="detail"></div><hr>
      <button data-test-action="command">Submit private remote command</button>
      <button data-test-action="create-room">Create private Host Room</button>
      <button data-test-action="admit-host">Admit private test Host credential</button>
      <button data-test-action="force-close">Force Close Host…</button>
      <button data-test-action="sync-history">Pull live private history</button>
      <button data-test-action="late-history">Commit new message and recover private network</button>
      <button data-test-action="rehost-history">Rehost latest history here</button>
      <button data-test-action="revoke">Revoke selected owner</button>
      <script>const bridge=acquireVsCodeApi();const state={tab:'portalConnections'};
      const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const helpText=en=>en;const problemGuidanceHtml=message=>'<p>'+esc(message)+'</p>';
      const ask=(command,data={})=>bridge.postMessage({command,...data});
      ${renderer.replaceAll("</script", "<\\/script")}
      document.querySelectorAll('[data-test-action]').forEach(button=>button.onclick=()=>ask(button.dataset.testAction));
      window.addEventListener('message',e=>{if(e.data.command==='snapshot')portalConnectionsOnSnapshot(e.data.data)});
      ask('portalConnections');</script></body></html>`;
    const operations = { portalEndpointCreate: "create", portalEndpointPair: "pair", portalEndpointConnect: "connect",
      portalEndpointDisconnect: "disconnect", portalEndpointPermissions: "permissions", portalEndpointRemove: "remove" };
    const refresh = async () => {
      endpoint = manager.endpointStore?.list().find(item => item.root === root && !item.deleted);
      state.endpointId = endpoint?.id;
      state.endpoint = endpoint && { paired: !!endpoint.paired, acceptsIncoming: endpoint.acceptsIncoming,
        permissions: endpoint.permissions, revision: endpoint.revision };
      const peer = endpoint && manager.chatPortals.get(endpoint.id)?.room?.peer;
      state.connected = !!(endpoint && manager.chatPortals.get(endpoint.id)?.room?.client.isConnected);
      state.confirmed = !!peer?.endpointConfirmed;
      state.pairId = peer?.binding?.pairId;
      if (lastReceipt) state.receipt = peer?.receipts.get(lastReceipt);
      if (role === "host" && roomInfo && live) {
        const db = storage.connectNative();
        try {
          const record = db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomInfo.definition.roomId);
          const status = { state: JSON.parse(record.state_json).state === "stored" ? "released" : "active",
            activeUrl: roomInfo.historyUrl || roomInfo.url, workspaceId, sourceFingerprint: roomInfo.definition.sourceFingerprint };
          fs.writeFileSync(`${statusFile}.part`, JSON.stringify(status), { mode: 0o600 });
          fs.renameSync(`${statusFile}.part`, statusFile);
          state.roomStatus = status.state;
        } finally { db.close(); }
      }
      if (live) {
        await manager.refreshStoredRooms();
        state.rooms = manager.hostedRoomsForNavigation();
        await panel.webview.postMessage({ command: "snapshot", data: manager.portalConnectionHistory() });
      }
      writeState();
    };
    const untilHistory = async check => {
      for (let count = 0; count < 320; count++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error("Installed live history condition timed out.");
    };
    const roomState = () => {
      const db = storage.connectNative();
      try { return JSON.parse(db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomInfo.definition.roomId).state_json); }
      finally { db.close(); }
    };
    const makeHistoryClient = async (label, url, onHistory = () => {}) => {
      const Client = requireProduct("./chatroom/chatroom-client.js").ChatClient;
      const client = new Client(new Proxy({ onHistory }, { get: (target, key) => target[key] ?? (() => {}) }));
      historyClients.push(client);
      client.connect({ url, room: roomInfo.definition.name, roomId: roomInfo.definition.roomId,
        user: label, cid: label, token: roomInfo.credentials.joinSecret });
      await untilHistory(() => client.isConnected && client.participantId);
      return client;
    };
    const appendHistory = async text => {
      assert(historyClients[0].sendText(text, undefined, "none", "chat", ["live-reader"]));
      await untilHistory(() => roomState().messages.some(message => message.content === text));
    };
    if (config.liveHistory && role === "guest" && fs.existsSync(path.join(fixture, "private-room-handoff.json"))) {
      const saved = JSON.parse(fs.readFileSync(path.join(fixture, "private-room-handoff.json"), "utf8"));
      if (native.inspectNativeRoom(storage, saved.definition.roomId)) {
        assert(await credentials.verifyHost(saved.definition.roomId, saved.definition.hostCredentialHash));
        roomInfo = saved;
        const db = storage.connectNative();
        try { state.restoredHistoryCursor = db.prepare("SELECT length(data) AS bytes FROM next_room_history_incoming WHERE room_id=?")
          .get(saved.definition.roomId)?.bytes; } finally { db.close(); }
      }
    }
    panel.webview.onDidReceiveMessage(async message => {
      if (busy) return;
      busy = true;
      try {
        if (operations[message.command]) {
          await manager.managePersistentEndpoint(productContext, operations[message.command], message.endpointId);
          await refresh();
          if (role === "host" && message.command === "portalEndpointPair") {
            const invitation = manager.portalPendingLinks.get(endpoint.id);
            assert(invitation?.link);
            fs.writeFileSync(path.join(fixture, "portal-invitation.json"), JSON.stringify({ link: invitation.link }), { mode: 0o600 });
            emit("pairing-code-created", { linkSha256: digest(invitation.link) });
          }
        } else if (message.command === "command") {
          const peer = manager.chatPortals.get(endpoint.id)?.room?.peer;
          const command = commands.parsePortalCommand({ program: "node", arguments: ["-e", "process.stdout.write('PRIVATE_PORTAL_OK')"],
            timeoutSeconds: 15 });
          try { lastReceipt = peer.submitCommand(command); state.commandError = undefined; }
          catch (error) { state.commandError = error.message; emit("remote-command-rejected-before-execution", { reason: error.message }); }
        } else if (message.command === "create-room") {
          const created = await manager.createHostedRoom("Private foreign Host");
          const secret = await credentials.load(created.roomId);
          roomInfo = { definition: native.inspectNativeRoom(storage, created.roomId), credentials: secret,
            url: `ws://127.0.0.1:${manager.hubPort}` };
          if (config.liveHistory) {
            const http = require("node:http"), net = require("node:net"), targetPort = manager.hubPort;
            historyProxy = http.createServer((request, response) => {
              const chunks = [];
              request.on("data", chunk => chunks.push(chunk));
              request.on("end", () => {
                const bytes = Buffer.concat(chunks);
                if (request.url.endsWith("/history") && cutHistory && JSON.parse(bytes).offset > 0) {
                  response.destroy(); return;
                }
                const upstream = http.request({ hostname: "127.0.0.1", port: targetPort,
                  path: request.url, method: request.method, headers: request.headers }, incoming => {
                  response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
                });
                upstream.on("error", () => response.destroy()); upstream.end(bytes);
              });
            });
            historyProxy.on("upgrade", (request, socket, head) => {
              const upstream = net.connect(targetPort, "127.0.0.1", () => {
                upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`
                  + Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n\r\n");
                if (head.length) upstream.write(head);
                socket.pipe(upstream); upstream.pipe(socket);
              });
              for (const stream of [socket, upstream]) {
                proxySockets.add(stream); stream.on("close", () => proxySockets.delete(stream));
                stream.on("error", () => { socket.destroy(); upstream.destroy(); });
              }
            });
            await new Promise(resolve => historyProxy.listen(0, "127.0.0.1", resolve));
            roomInfo.historyUrl = `ws://127.0.0.1:${historyProxy.address().port}`;
            await makeHistoryClient("live-author", roomInfo.url);
            const reader = await makeHistoryClient("live-reader", roomInfo.url);
            roomInfo.readerId = reader.participantId;
            for (let index = 0; index < 10; index++) await appendHistory(`Installed live message ${index}: ${"x".repeat(5000)}`);
            state.liveMessages = roomState().messages.length;
          }
          fs.writeFileSync(path.join(fixture, "private-room-handoff.json"), JSON.stringify(roomInfo), { mode: 0o600 });
          emit("fresh-private-room-created", { roomId: created.roomId });
        } else if (message.command === "admit-host") {
          roomInfo = JSON.parse(fs.readFileSync(path.join(fixture, "private-room-handoff.json"), "utf8"));
          const answer = await vscode.window.showWarningMessage("Admit this synthetic private Host credential?",
            { modal: true, detail: "Fixture-only out-of-band owner bootstrap between two isolated profiles, not a join link or production adoption." },
            "Admit private test Host");
          if (answer === "Admit private test Host") {
            const id = roomInfo.definition.roomId;
            assert.equal(await productContext.secrets.get(`personalKnowledge.chatroom.${id}.host`), undefined);
            await productContext.secrets.store(`personalKnowledge.chatroom.${id}.host`, roomInfo.credentials.hostCredential);
            await productContext.secrets.store(`personalKnowledge.chatroom.${id}.join`, roomInfo.credentials.joinSecret);
            native.createNativeRoom(storage, roomInfo.definition);
            emit("private-host-bootstrap-admitted", { roomId: id, productionAdoption: false });
          }
        } else if (message.command === "sync-history") {
          await ownedHub.start(0);
          try {
            state.historyReceipt = await ownedHub.syncRemoteRoomHistory(roomInfo.definition.roomId);
            state.liveMessages = roomState().messages.length;
            emit("installed-live-history-received", { receipt: state.historyReceipt, messages: state.liveMessages });
          } catch (error) {
            const db = storage.connectNative();
            try { state.interruptedHistoryBytes = db.prepare("SELECT length(data) AS bytes FROM next_room_history_incoming WHERE room_id=?")
              .get(roomInfo.definition.roomId)?.bytes; } finally { db.close(); }
            if (state.interruptedHistoryBytes !== 32768 || !/fetch failed|socket|network/i.test(error.message)) throw error;
            assert.equal(roomState().messages.length, 0);
            emit("installed-history-network-interrupted", { durableBytes: state.interruptedHistoryBytes, publishedMessages: 0 });
          }
        } else if (message.command === "late-history") {
          cutHistory = false;
          await appendHistory(`Installed post-checkpoint live message ${++historySequence}`);
          state.liveMessages = roomState().messages.length;
        } else if (message.command === "rehost-history") {
          const restored = await ownedHub.rehostRoom(roomInfo.definition.roomId), baseline = [];
          const reader = await makeHistoryClient("live-reader", restored.url, messages => baseline.push(...messages));
          await untilHistory(() => baseline.length === 12);
          assert.equal(reader.participantId, roomInfo.readerId);
          assert.equal(baseline.at(-1).text, "Installed post-checkpoint live message 2");
          state.rehostedLatestHistory = true;
          state.liveMessages = roomState().messages.length;
          await ownedHub.adminCloseRoom(roomInfo.definition.roomId);
          state.normalRehostCloseCompleted = true;
        } else if (message.command === "force-close") {
          await refresh();
          const room = state.rooms.find(item => item.canForceClose);
          assert(room, "Only a verified independently selected foreign Host may be force-closed.");
          const answer = await vscode.window.showWarningMessage(
            `Force the active Host to close “${room.roomName}”? Connected participants will be disconnected. History and Room credentials are preserved so you can Rehost it here.`,
            { modal: true, detail: `Active endpoint: ${room.activeUrl}` }, "Force Close Host");
          if (answer === "Force Close Host") {
            await manager.forceCloseHostedRoom(room.roomId);
            emit("foreign-host-release-confirmed", { roomId: room.roomId });
            state.forceClosePassed = true;
            if (config.liveHistory) {
              assert.equal(roomState().messages.length, 12);
              assert.equal(roomState().messages.at(-1).content, "Installed post-checkpoint live message 2");
              state.finalClosedHistoryMessages = roomState().messages.length;
            }
          }
        } else if (message.command === "revoke") {
          live = false;
          await registration.dispose(); registration = undefined;
          state.revoked = true;
          assert.throws(() => manager.portalPreflight(), /revoked/);
          state.revokedPortalEntryDenied = true;
          emit("selected-owner-revoked", { newPortalEntryDenied: true });
        }
        await refresh();
        state.lastAction = message.command;
        emit("ui-action-complete", { action: message.command });
      } catch (error) {
        state.error = error.stack || String(error);
        emit("ui-action-failed", { action: message.command, message: state.error });
        writeState();
      } finally { busy = false; }
    });
    state.ready = true; writeState();
    timer = setInterval(() => { if (!busy) void refresh().catch(error => { state.refreshError = error.message; writeState(); }); }, 250);
    await refresh();
    emit("driver-ready", { actualProductContext: true, qualification: "explicit private owner + reused original renderer in fixture panel",
      version: product.packageJSON.version, rendererSha256: digest(renderer) });
  } catch (error) {
    state.error = error.stack || String(error); writeState();
    emit("driver-failed", { message: state.error }); throw error;
  }
  exports.deactivate = async () => {
    if (timer) clearInterval(timer);
    for (const client of historyClients) client.disconnect();
    for (const socket of proxySockets) socket.destroy();
    if (historyProxy) { historyProxy.closeAllConnections(); historyProxy.close(); }
    panel?.dispose();
    await manager?.dispose().catch(() => {});
    await registration?.dispose().catch(() => {});
    await storage?.close();
  };
};
