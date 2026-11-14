import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = resolve(new URL("../legacy", import.meta.url).pathname);
const build = resolve(process.env.PKM_ROOM_RECOVERY_BUILD || join(project, "../dist"));
const fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
const esbuild = require("esbuild");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("Room-only recovery preserves credentialed identity and fences other workspace authority", async t => {
  const directory = join(project, ".migration-test-work", `room-recovery-${randomUUID()}`);
  const parent = join(directory, "trial"), root = join(parent, "workspace"), legacyRoot = join(directory, "legacy");
  const extension = join(directory, "old-source"), bundle = join(directory, "test-bridge.cjs");
  for (const dir of [parent, legacyRoot, join(extension, "dist")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ts = require("typescript");
  for (const name of ["chat-persistence", "chat-persistence-worker"])
    writeFileSync(join(extension, name === "chat-persistence" ? "dist" : "", `${name}.js`),
      ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
    copyFileSync(join(project, "node_modules/sql.js/dist", name), join(directory, name));
  esbuild.buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
    export {NextRoomResumeStore} from "./src/chatroom/next-room-resume-store";
    export {attachNextRoomHostBridge} from "./src/chatroom/next-room-host-bridge";
    export {saveRoomRecoveryPin,loadRoomRecoveryPin,assertRoomRecoveryPin} from "./src/chatroom/next-room-recovery";`,
    resolveDir: project }, bundle: true, platform: "node", format: "cjs", packages: "external",
    outfile: bundle, logLevel: "silent" });
  if (!existsSync(join(build, "legacy-chatroom-retained.cjs"))) esbuild.buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {WebSocketServer} from "ws";`, resolveDir: project }, bundle: true, platform: "node", format: "cjs",
    outfile: join(build, "legacy-chatroom-retained.cjs"), logLevel: "silent" });
  const bridgeModule = require(bundle), values = new Map(), children = new Set();
  const secrets = { async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const credentials = await new bridgeModule.ChatRoomCredentialStore(secrets).create(fixture.roomId);
  const { initialize, Storage } = await import(pathToFileURL(join(build, "storage.js")));
  const { inspectLegacyChatroomArchive } = await import(pathToFileURL(join(build, "legacy-chatroom-continuation.js")));
  await initialize(root);
  let storage = await Storage.open(root, { deferRecovery: true }), peer;
  const workspaceId = await storage.workspaceId();
  await fixture.create({ extension, root, credentials, hostParticipantId: "historic-human" });
  const binding = { root, workspaceId, actorId: "local:owner", roomId: fixture.roomId,
    sourceFingerprint: inspectLegacyChatroomArchive(root, fixture.roomId).sourceFingerprint, operation: "reopen" };
  await bridgeModule.saveRoomRecoveryPin(secrets, binding, legacyRoot);
  const pin = await bridgeModule.loadRoomRecoveryPin(secrets, parent, legacyRoot);
  await storage.close(); storage = undefined;
  await assert.rejects(Storage.open(root, { deferRecovery: true }), /adoption journal/);
  await assert.rejects(Storage.openPrivateRoomRecovery(root, fixture.roomId, "0".repeat(64)), /adoption journal/);
  t.after(async () => {
    peer?.disconnect();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGTERM"); await exited;
      }
    }
    await storage?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const hostKey = `personalKnowledge.chatroom.${fixture.roomId}.host`;
  const oldHost = values.get(hostKey);
  const pinKey = "personalKnowledge.next.isolatedRoomRecovery.v1", savedPin = values.get(pinKey);
  values.delete(pinKey);
  assert.equal(await bridgeModule.loadRoomRecoveryPin(secrets, parent, legacyRoot), undefined);
  values.set(pinKey, savedPin);
  values.set(hostKey, "wrong");
  await assert.rejects(bridgeModule.loadRoomRecoveryPin(secrets, parent, legacyRoot), /credential/);
  values.set(hostKey, oldHost);
  const marker = join(root, ".pkm-next-workspace");
  renameSync(marker, `${marker}.saved`);
  writeFileSync(marker, readFileSync(`${marker}.saved`));
  assert.throws(() => bridgeModule.assertRoomRecoveryPin(pin, legacyRoot), /changed/);
  rmSync(marker); renameSync(`${marker}.saved`, marker);
  assert.equal(await bridgeModule.loadRoomRecoveryPin(secrets, join(directory, "other"), legacyRoot), undefined);
  bridgeModule.assertRoomRecoveryPin(pin, legacyRoot);

  const listen = createServer();
  await new Promise(resolve => listen.listen(0, "127.0.0.1", resolve));
  const port = listen.address().port;
  await new Promise(resolve => listen.close(resolve));
  async function spawnHost() {
    const child = fork(join(build, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.add(child); child.once("exit", () => children.delete(child));
    const messages = [];
    child.on("message", message => messages.push(message));
    async function take(predicate, label, timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        const startupError = messages.find(message => message.type === "startup-error");
        if (startupError) throw new Error(`Child startup failed: ${startupError.message}`);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before ${label}`);
        await wait(10);
      }
      throw new Error(`Timed out: ${label}`);
    }
    const request = async value => {
      const id = randomUUID();
      child.send({ ...value, id });
      return take(message => message.type === "result" && message.id === id, value.type);
    };
    child.send({ type: "start-room-recovery", pin, legacyRoot });
    return { child, take, request };
  }
  const resume = new bridgeModule.NextRoomResumeStore(secrets);
  let approvals = 0;
  for (let round = 0; round < 4; round++) {
    const host = await spawnHost();
    assert.deepEqual(await host.take(message => message.type === "ready", "ready"),
      { type: "ready", workspaceId, roomOnly: true });
    const denied = await host.request({ type: "invoke", operation: "list", args: {} });
    assert.equal(denied.error, "BUSY_OR_INVALID");
    const copyDenied = await host.request({ type: "room-import-private", roomId: fixture.roomId, source: legacyRoot });
    assert.equal(copyDenied.error, "BUSY_OR_INVALID");
    const foreign = await host.request({ type: "room-inspect", roomId: "different-room" });
    assert(foreign.error);
    const inspected = await host.request({ type: "room-inspect", roomId: fixture.roomId });
    assert.deepEqual(inspected.result, binding);
    const bridge = bridgeModule.attachNextRoomHostBridge({ child: host.child, secrets, binding,
      authorized: () => true, approveParticipant: async () => { approvals++; return true; } });
    const opened = await host.request({ type: "room-open", roomId: fixture.roomId, binding, session: bridge.session,
      legacyReconnect: "host-approval", port });
    assert.equal(opened.result.authority, "verified-legacy-host-credential");
    let saved = false, status = "", rejection = "";
    if (round !== 3) {
      peer = new bridgeModule.ChatClient({ onStatus(value, detail) { status = `${value} ${detail || ""}`; },
        onRejected(code, message) { rejection = `${code}: ${message}`; }, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {},
        loadResumeCredential: (roomId, url, cid, room) => roomId ? resume.load(roomId, url, cid) : resume.loadByName(room, url, cid),
        async onResumeCredential(value, room) { await resume.save(value, room); saved = true; } });
      peer.connect({ url: opened.result.url, room: opened.result.room, roomId: fixture.roomId, user: "Historic Agent",
        cid: "historic-client-1", kind: "agent", token: opened.result.secret });
    }
    const deadline = Date.now() + 10000;
    while ((!peer.isConnected || round === 0 && !saved) && Date.now() < deadline) await wait(10);
    assert(peer.isConnected && (round !== 0 || saved), `round ${round}: status=${status}, rejection=${rejection}, approvals=${approvals}`);
    assert.equal(peer.participantId, "historic-agent");
    assert.equal(approvals, 1, "private resume proof avoids repeat approval after a host restart");
    if (round === 1) {
      const competing = await spawnHost();
      const failure = await competing.take(message => message.type === "startup-error", "competing lease", 40000);
      assert(failure.message);
    }
    if (round === 2) {
      const exited = new Promise(resolve => host.child.once("exit", resolve));
      host.child.kill("SIGKILL");
      await exited;
      bridge.close();
      const until = Date.now() + 10000;
      while (peer.isConnected && Date.now() < until) await wait(10);
      assert(!peer.isConnected, "Guest observes the killed child before automatic retry");
      continue;
    }
    peer.disconnect();
    const closed = await host.request({ type: "room-close" });
    assert.equal(closed.result.closed, true);
    bridge.close();
    const exited = new Promise(resolve => host.child.once("exit", resolve));
    host.child.send({ type: "close" });
    await exited;
  }
  rmSync(join(root, "chatrooms", fixture.roomId, "chatroom.db"));
  const changed = await spawnHost();
  const failure = await changed.take(message => message.type === "startup-error", "changed archive");
  assert(failure.message);
});
