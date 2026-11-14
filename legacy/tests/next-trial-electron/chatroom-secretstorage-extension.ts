import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { fork, ChildProcess } from "child_process";
import { ChatRoomCredentialStore } from "../../src/chatroom/chat-room-credentials";
import { ChatClient } from "../../src/chatroom/chatroom-client";
import { attachNextRoomHostBridge } from "../../src/chatroom/next-room-host-bridge";
import { NextRoomResumeStore } from "../../src/chatroom/next-room-resume-store";
import { registerNextManagedTrial } from "../../src/ui/next-managed-trial";
import { parseChatMagicLink } from "../../src/chatroom/chat-magic-link";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const fixture = process.env.PKM_ROOM_SECRET_FIXTURE!;
  const project = process.env.PKM_ROOM_SECRET_PROJECT!;
  const marker = path.join(fixture, "result.json");
  let child: ChildProcess | undefined, closeBridge: (() => void) | undefined, client: ChatClient | undefined;
  const peers: ChildProcess[] = [];
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    if (!fixture || path.resolve(fixture) !== fixture || fs.realpathSync(fixture) !== fixture
      || path.dirname(context.extensionPath) !== fixture
      || !fs.realpathSync(context.globalStorageUri.fsPath).startsWith(path.join(fixture, "user") + path.sep))
      throw new Error("Private Room profile binding denied.");
    const root = path.join(fixture, "knowledge"), extension = path.join(fixture, "legacy-source");
    const roomFixture = require(path.join(project, "tests/next-trial-electron/chatroom-live-fixture.cjs"));
    const store = new ChatRoomCredentialStore(context.secrets);
    const resumeStore = new NextRoomResumeStore(context.secrets);
    const syntheticResume = { roomId: roomFixture.roomId, url: "ws://127.0.0.1:12345", clientId: "private-fixture",
      participantId: "fixture-participant", secret: "a".repeat(43) };
    await resumeStore.save(syntheticResume);
    if ((await resumeStore.load(syntheticResume.roomId, syntheticResume.url, syntheticResume.clientId))?.secret !== syntheticResume.secret
      || await resumeStore.load(syntheticResume.roomId, "ws://127.0.0.1:12346", syntheticResume.clientId))
      throw new Error("VS Code participant credential endpoint binding failed.");
    await resumeStore.delete(syntheticResume.roomId, syntheticResume.url, syntheticResume.clientId);
    const credentials = await store.create(roomFixture.roomId);
    if (!await store.verifyHost(roomFixture.roomId, credentials.hostCredentialHash))
      throw new Error("VS Code SecretStorage did not retain the Host credential.");
    child = fork(path.join(project, "next-server/tests/legacy-chatroom-host-ipc-child.mjs"),
      [root, path.join(fixture, "retained.cjs")], { execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const inbox: any[] = [];
    child.on("message", message => inbox.push(message));
    const take = async (type: string) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const index = inbox.findIndex(message => message.type === type);
        if (index >= 0) return inbox.splice(index, 1)[0];
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Room child exited before ${type}.`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Room child timed out before ${type}.`);
    };
    const ready = await take("ready");
    await roomFixture.create({ extension, root, credentials, hostParticipantId: "historic-human" });
    const { inspectLegacyChatroomArchive } = await import(
      path.join(project, "next-server/dist/legacy-chatroom-continuation.js"));
    const binding = { root, workspaceId: ready.workspaceId, actorId: "local:owner" as const, roomId: roomFixture.roomId,
      sourceFingerprint: inspectLegacyChatroomArchive(root, roomFixture.roomId).sourceFingerprint, operation: "reopen" as const };
    let allowed = true;
    const bridge = attachNextRoomHostBridge({ child, secrets: context.secrets, binding, authorized: () => allowed });
    closeBridge = bridge.close;
    child.send({ type: "configure", session: bridge.session, binding });
    await take("configured");
    child.send({ type: "probe", binding });
    const probe = await take("probe-result");
    if (probe.allowed || probe.hasCredentials) throw new Error("Foreign actor reached the VS Code credential bridge.");
    child.send({ type: "reopen", roomId: roomFixture.roomId });
    const { result } = await take("opened");
    if (result.authority !== "verified-legacy-host-credential" || result.secret !== credentials.joinSecret)
      throw new Error("Room Host credential binding failed.");
    client = new ChatClient({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {} });
    client.connect({ url: result.url, room: result.room, roomId: roomFixture.roomId, user: "Host",
      cid: "private-vscode-host", token: result.secret, hostToken: result.hostToken });
    const deadline = Date.now() + 10_000;
    while (!client.isConnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (!client.isConnected || client.participantId !== "historic-human") throw new Error("Real Room Host did not reconnect.");
    allowed = false; await take("drained");
    try { await fetch(result.url.replace("ws:", "http:")); throw new Error("Revoked Room listener remained live."); }
    catch (error) { if ((error as Error).message === "Revoked Room listener remained live.") throw error; }
    client.disconnect(); client = undefined;

    const copyParent = path.join(fixture, "private-room-copy"), source = path.join(copyParent, "source");
    const trial = path.join(fixture, "managed-trial"), legacyRoot = path.join(fixture, "other-legacy");
    for (const dir of [copyParent, source, trial, legacyRoot]) fs.mkdirSync(dir, { mode: 0o700 });
    fs.cpSync(path.join(root, "chatrooms"), path.join(source, "chatrooms"), { recursive: true });
    const sourceDb = path.join(source, "chatrooms", roomFixture.roomId, "chatroom.db");
    const original = fs.readFileSync(sourceDb);
    const dialogs = [trial, process.env.PKM_ROOM_SECRET_NODE!, source], picks = [
      "Host an isolated legacy Room", "Copy and host a private Room",
      "Require participant credential to restore an identity", "Send message", "Stop Host",
      "Host an isolated legacy Room", "Rehost a Room already copied into this trial",
      "Allow legacy clients as a new identity on each reconnect", "Stop Host",
      "Host an isolated legacy Room", "Rehost a Room already copied into this trial",
      "Approve legacy participant identity recovery", "Copy local Magic Link", "Review participant approvals",
      "Send message", "Stop Host",
      "Host an isolated legacy Room", "Rehost a Room already copied into this trial",
      "Approve legacy participant identity recovery", "Copy local Magic Link", "Stop Host",
    ], inputs = [roomFixture.roomId, "@all private managed host action", roomFixture.roomId, roomFixture.roomId,
      "7345", "@all real isolated peer message", roomFixture.roomId, "7345"];
    const errors: string[] = [], restore: (() => void)[] = [];
    let notification = false, guest: ChildProcess | undefined, guestOptions: any, guestInbox: any[] = [];
    const wait = async (check: () => boolean, label: string) => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error(`Timed out: ${label}.`);
    };
    const launchGuest = () => {
      guestInbox = [];
      guest = fork(path.join(project, "tests/next-trial-electron/chatroom-secretstorage-peer.cjs"),
        [path.join(fixture, "retained.cjs"), path.join(fixture, "participant-secrets.json")],
        { execPath: process.env.PKM_ROOM_SECRET_NODE!, env: { ...process.env },
          stdio: ["ignore", "ignore", "ignore", "ipc"] });
      peers.push(guest);
      guest.on("message", item => guestInbox.push(item));
      guest.send({ type: "connect", options: guestOptions });
    };
    const stopGuest = async () => {
      const process = guest!;
      const exited = new Promise<void>(resolve => process.once("exit", () => resolve()));
      process.send!({ type: "stop" });
      await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Peer did not exit.")), 5000))]);
      guest = undefined;
    };
    const replace = (name: keyof typeof vscode.window, value: any) => {
      const object = vscode.window as any, previous = object[name];
      object[name] = value;
      if (object[name] !== value) throw new Error(`Cannot instrument ${name}.`);
      restore.push(() => { object[name] = previous; });
    };
    try {
      replace("showOpenDialog", async () => [vscode.Uri.file(dialogs.shift()!)]);
      replace("showQuickPick", async () => {
        const pick = picks.shift();
        if (pick === "Review participant approvals") {
          const invite = parseChatMagicLink(await vscode.env.clipboard.readText());
          const address = new URL(invite.url);
          guestOptions = { url: `${address.protocol}//${address.host}`, room: decodeURIComponent(address.pathname.slice(1)),
            token: invite.secret };
          launchGuest();
          await wait(() => guestInbox.some(item => item.type === "pending") && notification, "real participant pending approval");
        } else if (pick === "Send message" && guest) {
          await wait(() => guestInbox.some(item => item.type === "connected") && guestInbox.some(item => item.type === "saved"),
            "approved participant and stored credential");
          const connected = guestInbox.find(item => item.type === "connected");
          if (connected.participantId !== "historic-agent" || !guestInbox.some(item => item.type === "history" && item.ids.includes("history-agent")))
            throw new Error("Historical participant or history was not restored.");
          await stopGuest();
          launchGuest();
          await wait(() => guestInbox.some(item => item.type === "connected"), "participant restart with stored credential");
          if (guestInbox.some(item => item.type === "pending") || guestInbox.find(item => item.type === "connected").participantId !== "historic-agent")
            throw new Error("Participant restart did not reuse the original identity automatically.");
        } else if (pick === "Stop Host" && guest) {
          await wait(() => guestInbox.some(item => item.type === "message"), "message to the restarted peer");
          await stopGuest();
        } else if (pick === "Stop Host" && guestOptions) {
          const invite = parseChatMagicLink(await vscode.env.clipboard.readText());
          const address = new URL(invite.url);
          if (`${address.protocol}//${address.host}` !== guestOptions.url)
            throw new Error("Rehost changed the participant credential endpoint.");
          guestOptions.token = invite.secret;
          launchGuest();
          await wait(() => guestInbox.some(item => item.type === "connected"), "participant reconnect after Host rehost");
          if (guestInbox.some(item => item.type === "pending") || guestInbox.find(item => item.type === "connected").participantId !== "historic-agent")
            throw new Error("Host rehost did not restore the original participant automatically.");
          await stopGuest();
        }
        return pick;
      });
      replace("showInputBox", async () => inputs.shift());
      const realWarning = vscode.window.showWarningMessage.bind(vscode.window);
      replace("showWarningMessage", async (message: string, ...args: any[]) => message === "Restore this historical participant identity?"
        ? (realWarning as any)(message, ...args) : message.startsWith("Create a disposable") ? "Create Trial" : "Host Isolated Room");
      replace("showInformationMessage", async (message: string) => {
        if (message.includes("requests identity recovery")) notification = true;
        return undefined;
      });
      replace("showErrorMessage", async (message: string) => { errors.push(message); });
      registerNextManagedTrial(context, () => legacyRoot);
      await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
      await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
      await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
      await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
      await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    } finally { while (restore.length) restore.pop()!(); }
    if (errors.length || dialogs.length || picks.length || inputs.length)
      throw new Error(`Managed Room action failed: ${JSON.stringify({ errors, dialogs, picks, inputs })}`);
    const copied = fs.readFileSync(path.join(trial, "workspace", "chatrooms", roomFixture.roomId, "chatroom.db"));
    if (!copied.equals(original) || !fs.readFileSync(sourceDb).equals(original))
      throw new Error("Isolated Room copy changed the archived bytes.");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(path.join(trial, "workspace", "core.sqlite"), { readOnly: true });
    try {
      const row = database.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomFixture.roomId);
      if (!row || !JSON.parse(row.state_json).messages.some((message: any) => message.content === "@all private managed host action"))
        throw new Error("The managed Room Host action did not persist its message.");
    } finally { database.close(); }
    fs.writeFileSync(marker, JSON.stringify({ passed: true, realSecretStorage: true, realExtensionHost: true,
      hostCredentialAndActorVerified: true, roomDrainedOnRevocation: true, managedTrialAction: true,
      originalParticipantRecovery: true }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(marker, JSON.stringify({ passed: false, error: (error as Error).message }), { flag: "wx", mode: 0o600 });
  } finally {
    for (const peer of peers) if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGTERM");
    client?.disconnect();
    closeBridge?.();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
