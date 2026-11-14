import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const project = resolve(root, "..");
const require = createRequire(import.meta.url);
const python = execFileSync("python3", ["-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t) {
  const parent = join(root, "tests", `.managed-import-${randomUUID()}`);
  await mkdir(parent, { mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dist = join(parent, "dist");
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--outDir", dist],
    { timeout: 120000, stdio: "pipe" });
  await writeFile(join(parent, "package.json"), '{"type":"module"}');
  await cp(join(root, "compat"), join(parent, "compat"), { recursive: true });
  const source = join(parent, "source"), destination = join(parent, "destination"), legacy = join(parent, "legacy");
  for (const dir of [source, destination, legacy]) await mkdir(dir, { mode: 0o700 });
  await mkdir(join(source, "notes"));
  const note = "---\ntitle: Fixture\ndocumentId: fixture-note\nrevision: 2\n---\nFixture content\n";
  await writeFile(join(source, "notes/Fixture.md"), note);
  return { parent, dist, source, destination, legacy, note };
}
function client(dist) {
  const child = fork(join(dist, "managed-client-child.js"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const messages = [], waiters = [];
  child.on("message", value => {
    const index = waiters.findIndex(waiter => waiter.match(value));
    if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(value); }
    else messages.push(value);
  });
  const exit = new Promise(resolveExit => child.once("close", (code, signal) => resolveExit({ code, signal })));
  function receive(match) {
    const index = messages.findIndex(match);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolveMessage, reject) => {
      const waiter = { match, resolve: resolveMessage, timer: setTimeout(() => reject(new Error(`IPC response timed out; messages: ${JSON.stringify(messages)}`)), 30000) };
      waiters.push(waiter);
    });
  }
  const send = value => child.send(value);
  const request = async (type, extra = {}) => {
    const id = randomUUID();
    send({ type, id, ...extra });
    return receive(message => message.type === "result" && message.id === id);
  };
  return { child, send, receive, request, exit };
}
async function snapshot(root) {
  const files = {};
  async function walk(dir, prefix = "") {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(dir, item.name), rel);
      else files[rel] = hash(await readFile(join(dir, item.name)));
    }
  }
  await walk(root);
  return files;
}
async function waitForFile(path) {
  for (let count = 0; count < 200; count++) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error("Importer helper did not start.");
}

test("isolated managed Room uses the workspace owner and inherited Host authority", { timeout: 180000 }, async t => {
  const f = await setup(t), c = client(f.dist), fixture = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
  t.after(() => { if (c.child.connected) c.send({ type: "close" }); });
  const ts = require("typescript"), esbuild = require("esbuild");
  const legacyDirectory = join(f.parent, "legacy-files"), legacy = join(legacyDirectory, "legacy-source");
  await mkdir(join(legacy, "dist"), { recursive: true });
  await writeFile(join(legacyDirectory, "package.json"), '{"type":"commonjs"}');
  for (const name of ["chat-persistence", "chat-persistence-worker"]) {
    const source = await readFile(join(project, "src/chatroom", `${name}.ts`), "utf8");
    await writeFile(join(legacy, name === "chat-persistence" ? "dist" : "", `${name}.js`),
      ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
    await cp(join(project, "node_modules/sql.js/dist", name), join(legacyDirectory, name));
  const bundle = join(f.dist, "legacy-chatroom-retained.cjs");
  esbuild.buildSync({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatClient} from "./src/chatroom/chatroom-client";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {ChatRoomCredentialStore} from "./src/chatroom/chat-room-credentials";
    export {attachNextRoomHostBridge} from "./src/chatroom/next-room-host-bridge";
    export {WebSocketServer} from "ws";`, resolveDir: project },
    bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
  const retained = require(bundle), values = new Map(), secrets = {
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  const credentials = await new retained.ChatRoomCredentialStore(secrets).create(fixture.roomId);
  await fixture.create({ extension: legacy, root: f.source, credentials, hostParticipantId: "historic-human" });
  const { inspectLegacyChatroomParticipants } = await import(join(f.dist, "legacy-chatroom-continuation.js"));
  const historic = inspectLegacyChatroomParticipants(f.source, fixture.roomId);
  assert(historic.pendingJoins.some(item => item.clientKey === "historic-client-1" && item.participantId === "historic-agent"));
  const older = join(f.parent, "older-closed-copy");
  await mkdir(older, { mode: 0o700 });
  await cp(join(f.source, "chatrooms"), join(older, "chatrooms"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const oldDatabase = new DatabaseSync(join(older, "chatrooms", fixture.roomId, "chatroom.db"));
  try { oldDatabase.exec("ALTER TABLE pending_joins DROP COLUMN client_key"); } finally { oldDatabase.close(); }
  const olderJoins = inspectLegacyChatroomParticipants(older, fixture.roomId).pendingJoins;
  assert.equal(olderJoins.length, historic.pendingJoins.length);
  assert(olderJoins.every(item => item.clientKey === ""));
  assert.equal((await c.request("room-inspect", { roomId: fixture.roomId })).error, "BUSY_OR_INVALID");
  c.send({ type: "start", directory: f.destination, legacyRoot: f.legacy });
  const ready = await c.receive(message => message.type === "ready");
  const workspace = join(f.destination, "workspace");
  assert.equal((await c.request("room-import-private", { source: f.legacy, roomId: fixture.roomId })).error, "ROOM_UNAVAILABLE");
  await chmod(f.source, 0o755);
  assert.equal((await c.request("room-import-private", { source: f.source, roomId: fixture.roomId })).error, "ROOM_UNAVAILABLE");
  await chmod(f.source, 0o700);
  assert.equal((await c.request("room-import-private", { source: f.source, roomId: fixture.roomId })).result.roomId, fixture.roomId);
  const binding = (await c.request("room-inspect", { roomId: fixture.roomId })).result;
  assert.equal(binding.actorId, "local:owner");
  assert.equal(binding.workspaceId, ready.workspaceId);
  assert.equal(binding.root, workspace);
  let allowed = true;
  const bridge = retained.attachNextRoomHostBridge({ child: c.child, secrets, binding, authorized: () => allowed });
  const denied = await c.request("room-open", { roomId: fixture.roomId, session: bridge.session,
    binding: { ...binding, actorId: "mcp:external" }, legacyReconnect: "proof-required" });
  assert.equal(denied.error, "ROOM_UNAVAILABLE");
  const opened = await c.request("room-open", { roomId: fixture.roomId, session: bridge.session, binding,
    legacyReconnect: "proof-required" });
  assert.equal(opened.result?.authority, "verified-legacy-host-credential", JSON.stringify(opened));
  const host = new retained.ChatClient({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {} });
  host.connect({ ...opened.result, roomId: fixture.roomId, token: opened.result.secret, user: "Host", cid: "host" });
  for (let count = 0; count < 200 && !host.isConnected; count++) await new Promise(done => setTimeout(done, 25));
  assert.equal(host.isConnected, true);
  assert.equal(host.participantId, "historic-human");
  const historicSocket = new (require("ws"))(opened.result.url);
  t.after(() => historicSocket.terminate());
  await new Promise((resolve, reject) => { historicSocket.once("open", resolve); historicSocket.once("error", reject); });
  const historicRejected = new Promise((resolve, reject) => {
    historicSocket.on("message", data => {
      const frame = JSON.parse(String(data));
      if (frame.t === "error") resolve(frame.code);
      if (frame.t === "join.ready") reject(new Error("Historical client ID was silently promoted."));
    });
    historicSocket.once("error", reject);
  });
  historicSocket.send(JSON.stringify({ t: "join", room: opened.result.room, roomId: fixture.roomId,
    token: opened.result.secret, user: "Historic Agent", cid: "historic-client-1" }));
  assert.equal(await historicRejected, "participant-proof-required");
  historicSocket.terminate();
  host.disconnect();
  assert.equal((await c.request("room-close")).result.closed, true);
  allowed = false; bridge.close();
  c.send({ type: "close" });
  await c.receive(message => message.type === "closed");
  assert.deepEqual(await c.exit, { code: 0, signal: null });

  const packagedExtension = join(f.parent, "packaged-extension"), second = join(f.parent, "second-private-trial");
  await mkdir(packagedExtension, { mode: 0o700 });
  await mkdir(second, { mode: 0o700 });
  await cp(join(project, "package.json"), join(packagedExtension, "package.json"));
  require("../legacy/scripts/next-rehearsal-runtime.js").stage(join(packagedExtension, "next-runtime"), { production: true });
  const parentBundle = join(f.parent, "actual-managed-client.cjs");
  esbuild.buildSync({ entryPoints: [join(project, "src/runtime/next-managed-client.ts")], bundle: true,
    platform: "node", format: "cjs", outfile: parentBundle, logLevel: "silent" });
  const { NextManagedClient } = require(parentBundle);
  const actual = new NextManagedClient();
  t.after(() => actual.isStopped() ? undefined : actual.close());
  await actual.start(packagedExtension, second, await import("node:fs/promises").then(fs => fs.realpath(process.execPath)), f.legacy);
  await assert.rejects(actual.copyIsolatedRoom(f.legacy, fixture.roomId), /outside the current Knowledge Root/);
  await actual.copyIsolatedRoom(f.source, fixture.roomId);
  await assert.rejects(actual.copyIsolatedRoom(f.source, fixture.roomId), /outcome unknown/);
  let trusted = true;
  const actualOpened = await actual.openIsolatedRoom(fixture.roomId, secrets, () => trusted);
  const actualHost = new retained.ChatClient({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {} });
  actualHost.connect({ ...actualOpened, token: actualOpened.secret, user: "Host", cid: "host" });
  for (let count = 0; count < 200 && !actualHost.isConnected; count++) await new Promise(done => setTimeout(done, 25));
  assert.equal(actualHost.isConnected, true);
  assert.equal(actualHost.participantId, "historic-human");
  trusted = false;
  for (let count = 0; count < 200 && actualHost.isConnected; count++) await new Promise(done => setTimeout(done, 25));
  assert.equal(actualHost.isConnected, false, "Lost extension authority must drain the Room.");
  actualHost.disconnect();
  await actual.closeIsolatedRoom();
  trusted = true;
  const rehosted = await actual.openIsolatedRoom(fixture.roomId, secrets, () => trusted, "new-identity");
  const again = new retained.ChatClient({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {} });
  t.after(() => again.disconnect());
  again.connect({ ...rehosted, token: rehosted.secret, user: "Host", cid: "host" });
  for (let count = 0; count < 200 && !again.isConnected; count++) await new Promise(done => setTimeout(done, 25));
  assert.equal(again.isConnected, true);
  assert.equal(again.participantId, "historic-human");
  const joinLegacy = async user => {
    const peer = new retained.ChatClient({ onStatus() {}, onMessage() {}, onHistory() {}, onPresence() {}, onFileComplete() {} });
    t.after(() => peer.disconnect());
    peer.connect({ url: rehosted.url, room: rehosted.room, roomId: fixture.roomId, token: rehosted.secret,
      user, cid: "historic-client-1" });
    for (let count = 0; count < 200 && !peer.isConnected; count++) await new Promise(done => setTimeout(done, 25));
    assert.equal(peer.isConnected, true);
    return peer;
  };
  const oldPeer = await joinLegacy("Legacy Peer");
  const firstPeer = oldPeer.participantId;
  assert.notEqual(firstPeer, "historic-agent");
  oldPeer.disconnect();
  const oldReconnect = await joinLegacy("Legacy Peer Again");
  assert.notEqual(oldReconnect.participantId, firstPeer);
  assert.notEqual(oldReconnect.participantId, "historic-agent");
  oldReconnect.disconnect();
  const socket = new (require("ws"))(rehosted.url);
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const rejected = new Promise((resolve, reject) => {
    socket.on("message", data => {
      const frame = JSON.parse(String(data));
      if (frame.t === "error") resolve(frame.code);
      if (frame.t === "join.ready") reject(new Error("Legacy mode must not grant Host identity."));
    });
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ t: "join", room: rehosted.room, roomId: fixture.roomId, token: rehosted.secret,
    user: "Impostor", cid: "historic-client-0" }));
  assert.equal(await rejected, "host-proof-required");
  socket.terminate();
  again.disconnect();
  await actual.closeIsolatedRoom();
  await actual.close();
});

test("private child plans, imports, reconciles and reads using a side-effect-free reader", { timeout: 180000 }, async t => {
  const f = await setup(t), c = client(f.dist);
  t.after(() => { if (c.child.connected) c.send({ type: "close" }); });
  c.send({ type: "start-import", source: f.source, parent: f.destination, legacyRoot: f.legacy, python, acknowledge: true });
  const plan = await c.receive(message => message.type === "import-plan");
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.target, join(f.destination, "workspace"));
  assert.equal((await c.request("confirm-import", { planSha256: "0".repeat(64) })).error, "BUSY_OR_INVALID");
  const imported = await c.request("confirm-import", { planSha256: plan.planSha256 });
  assert.equal(imported.result.outcome.status, "published");
  assert.equal(imported.result.receipt.fingerprint, plan.fingerprint);
  assert.equal((await c.request("confirm-import", { planSha256: plan.planSha256 })).error, "BUSY_OR_INVALID");
  assert.equal((await c.request("import-status")).result.outcome.status, "published");
  const before = await snapshot(plan.target);
  const attached = await c.request("attach-import");
  assert.equal(attached.result.readOnly, true);
  assert.equal(attached.result.audit.schema, "pkm.import-byte-audit/v1");
  assert.equal(attached.result.audit.documents, 1);
  assert.equal(attached.result.audit.planSha256, plan.planSha256);
  assert.match(attached.result.workspaceId, /^[a-f0-9-]{36}$/);
  const list = await c.request("invoke", { operation: "list", args: {} });
  assert.equal(list.result.result.items[0].id, "fixture-note");
  const get = await c.request("invoke", { operation: "get", args: { id: "fixture-note" } });
  assert.equal(get.result.result.content, "Fixture content\n");
  assert.equal((await c.request("invoke", { operation: "create", args: {} })).error, "BUSY_OR_INVALID");
  await writeFile(join(plan.target, "notes/Fixture.md"), `${f.note}unexpected write`);
  assert.equal((await c.request("invoke", { operation: "get", args: { id: "fixture-note" } })).error, "OUTCOME_UNKNOWN");
  await writeFile(join(plan.target, "notes/Fixture.md"), f.note);
  const invalidated = await c.request("invoke", { operation: "get", args: { id: "fixture-note" } });
  assert.equal(invalidated.error, "OUTCOME_UNKNOWN");
  assert.match(invalidated.message, /previously failed/);
  c.send({ type: "close" });
  await c.receive(message => message.type === "closed");
  assert.deepEqual(await c.exit, { code: 0, signal: null });
  assert.deepEqual(await snapshot(plan.target), before);
  assert.equal(await readFile(join(f.source, "notes/Fixture.md"), "utf8"), f.note);
});

test("published status cannot bypass file audit when imported resources are missing or changed", { timeout: 180000 }, async t => {
  const f = await setup(t), c = client(f.dist);
  t.after(() => { if (c.child.connected) c.send({ type: "close" }); });
  await mkdir(join(f.source, "notes/Fixture.assets"));
  const asset = Buffer.from([0, 255, 17, 128]);
  await writeFile(join(f.source, "notes/Fixture.assets/image.bin"), asset);
  const { serializeTodoBoard } = await import(join(f.dist, "domain/todo-board.js"));
  const board = serializeTodoBoard([], {});
  await writeFile(join(f.source, "notes/Board.md"), "---\ntitle: Board\ndocumentId: fixture-board\ndocumentKind: todo-board\n---\n");
  await mkdir(join(f.source, "notes/Board.assets"));
  await writeFile(join(f.source, "notes/Board.assets/pkm-todo-board.json"), board);
  const approvedPlan = JSON.parse(execFileSync(process.execPath, [join(f.dist, "cli.js"), "import-plan", "--source", f.source,
    "--acknowledge-quiescent-disposable-copy"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).plan;
  c.send({ type: "start-import", source: f.source, parent: f.destination, legacyRoot: f.legacy, python, acknowledge: true });
  const plan = await c.receive(message => message.type === "import-plan");
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal((await c.request("confirm-import", { planSha256: plan.planSha256 })).result.outcome.status, "published");
  const image = join(plan.target, "notes/Fixture.assets/image.bin");
  await writeFile(image, Buffer.from([42]));
  assert.equal((await c.request("import-status")).result.outcome.status, "published");
  const denied = await c.request("attach-import");
  assert.equal(denied.error, "OUTCOME_UNKNOWN");
  assert.match(denied.message, /audit.*mismatch/);
  await rm(image);
  assert.equal((await c.request("import-status")).result.outcome.status, "published");
  assert.match((await c.request("attach-import")).message, /audit.*missing/);
  await writeFile(image, asset);
  await writeFile(join(plan.target, "notes/extra.md"), "unexpected");
  assert.match((await c.request("attach-import")).message, /unplanned file/);
  await rm(join(plan.target, "notes/extra.md"));
  await symlink(join(f.source, "notes/Fixture.md"), join(plan.target, "notes/linked.md"));
  assert.match((await c.request("attach-import")).message, /refuses link/);
  await rm(join(plan.target, "notes/linked.md"));
  const oversized = join(plan.target, "notes/oversized.bin");
  await writeFile(oversized, "");
  await truncate(oversized, 268435457);
  assert.match((await c.request("attach-import")).message, /oversized entry/);
  await rm(oversized);
  const { auditImportedWorkspace } = await import(join(f.dist, "managed-import-audit.js"));
  await assert.rejects(auditImportedWorkspace(plan.target, { ...approvedPlan, projectEnvelopePlan: {} }), /transformed or authority-dependent/);
  const attached = await c.request("attach-import");
  assert.equal(attached.result.readOnly, true);
  assert.equal(attached.result.audit.documents, 2);
  assert.equal(attached.result.audit.files, 4);
  assert.equal(await readFile(join(plan.target, "boards/Board/pkm-todo-board.json"), "utf8"), board);
  const { bindImportedReadOnlyHost } = await import(join(f.dist, "managed-client-host.js"));
  let release, entered, checks = 0, drained = false;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const guardedHost = bindImportedReadOnlyHost(plan.target, attached.result.workspaceId, async () => {
    if (++checks === 2) { entered(); await gate; throw new Error("Post-read audit failure"); }
  });
  const readDenied = assert.rejects(guardedHost.invoke("get", { id: "fixture-note" }), /Post-read audit failure/);
  await started;
  const closing = guardedHost.close().then(() => { drained = true; });
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  assert.equal(drained, false);
  await assert.rejects(guardedHost.invoke("get", { id: "fixture-note" }), /closed/);
  release();
  await Promise.all([closing, readDenied]);
  assert.equal(checks, 2);
  const database = join(plan.target, "core.sqlite");
  const originalDatabase = await readFile(database);
  await writeFile(database, Buffer.concat([originalDatabase, Buffer.from("external change")]));
  const changedDatabase = await c.request("invoke", { operation: "get", args: { id: "fixture-note" } });
  assert.equal(changedDatabase.error, "OUTCOME_UNKNOWN");
  assert.equal(changedDatabase.result, undefined);
  await writeFile(database, originalDatabase);
  c.send({ type: "close" });
  await c.receive(message => message.type === "closed");
  assert.equal((await c.exit).code, 0);
  assert.deepEqual(await readFile(join(f.source, "notes/Fixture.assets/image.bin")), asset);
});

test("isolated experiment requires approval and persistent capability; writes survive restart and reject CAS/tamper/crash", { timeout: 180000 }, async t => {
  const f = await setup(t), c = client(f.dist);
  const children = [c];
  t.after(() => { for (const value of children) if (value.child.connected) value.send({ type: "close" }); });
  c.send({ type: "start-import", source: f.source, parent: f.destination, legacyRoot: f.legacy, python, acknowledge: true });
  const plan = await c.receive(message => message.type === "import-plan");
  assert.equal((await c.request("confirm-import", { planSha256: plan.planSha256 })).result.outcome.status, "published");
  const attached = await c.request("attach-import");
  const prepared = (await c.request("prepare-import-write")).result;
  assert.equal(prepared.scope, "isolated_experiment");
  assert.equal(prepared.writerCoverage.external, "unknown");
  const approval = { authorizationDigest: prepared.authorizationDigest, confirmTarget: plan.target, acknowledgeIsolatedExperiment: true };
  assert.equal((await c.request("enable-import-write", { ...approval, acknowledgeIsolatedExperiment: false })).error, "BUSY_OR_INVALID");
  assert.equal((await c.request("enable-import-write", { ...approval, authorizationDigest: "0".repeat(64) })).error, "BUSY_OR_INVALID");
  assert.equal((await c.request("enable-import-write", { ...approval, confirmTarget: f.source })).error, "BUSY_OR_INVALID");
  assert.equal((await c.request("invoke", { operation: "create", args: {} })).error, "BUSY_OR_INVALID");
  const enabled = await c.request("enable-import-write", approval);
  assert.equal(enabled.result.readOnly, false, JSON.stringify(enabled));
  assert.equal(enabled.result.workspaceId, attached.result.workspaceId);
  const credential = enabled.result.credential;
  assert.match(credential.capability, /^[a-f0-9]{64}$/);
  assert.equal((await c.request("enable-import-write", approval)).error, "BUSY_OR_INVALID");
  const bindingPath = join(f.destination, ".pkm-isolated-experiment.json");
  assert.equal((await readFile(bindingPath, "utf8")).includes(credential.capability), false);
  const created = await c.request("invoke", { operation: "create", args: { id: "isolated-created",
    operationId: randomUUID(), area: "notes", path: "Experiments/Created.md", title: "Isolated", content: "Synthetic only\n" } });
  assert.equal(created.result.result.content, "Synthetic only\n", JSON.stringify(created));
  const original = (await c.request("invoke", { operation: "get", args: { id: "fixture-note" } })).result.result;
  const updateArgs = { id: original.id, operationId: randomUUID(), expectedRevision: original.revision,
    expectedSha256: original.sha256, title: original.title, content: "Updated isolated content\n" };
  const updated = await c.request("invoke", { operation: "update", args: updateArgs });
  assert.equal(updated.result.result.content, updateArgs.content, JSON.stringify(updated));
  const conflict = await c.request("invoke", { operation: "update", args: { ...updateArgs, operationId: randomUUID() } });
  assert.equal(conflict.result.error.code, "CONFLICT");
  const { Storage } = await import(join(f.dist, "storage.js"));
  await assert.rejects(Storage.open(plan.target), /Another process currently owns/);
  c.send({ type: "close" });
  await c.receive(message => message.type === "closed");
  assert.equal((await c.exit).code, 0);
  assert.equal(JSON.parse(await readFile(bindingPath, "utf8")).state, "clean");
  const intactBinding = await readFile(bindingPath, "utf8");
  await writeFile(bindingPath, JSON.stringify({ ...JSON.parse(intactBinding), actorId: `experiment:${randomUUID()}` }));
  const alteredBinding = client(f.dist); children.push(alteredBinding);
  alteredBinding.send({ type: "start-import-write", ...credential, acknowledgeIsolatedExperiment: true });
  assert.match((await alteredBinding.receive(message => message.type === "startup-error")).message, /authorization binding changed/);
  await alteredBinding.exit;
  await writeFile(bindingPath, intactBinding);
  await chmod(bindingPath, 0o644);
  const publicBinding = client(f.dist); children.push(publicBinding);
  publicBinding.send({ type: "start-import-write", ...credential, acknowledgeIsolatedExperiment: true });
  assert.match((await publicBinding.receive(message => message.type === "startup-error")).message, /private and owner-bound/);
  await publicBinding.exit;
  await chmod(bindingPath, 0o600);

  const bad = client(f.dist); children.push(bad);
  bad.send({ type: "start-import-write", parent: credential.parent, capability: "0".repeat(64), acknowledgeIsolatedExperiment: true });
  assert.match((await bad.receive(message => message.type === "startup-error")).message, /capability rejected/);
  await bad.exit;
  assert.equal(JSON.parse(await readFile(bindingPath, "utf8")).state, "clean");

  const restarted = client(f.dist); children.push(restarted);
  restarted.send({ type: "start-import-write", ...credential, acknowledgeIsolatedExperiment: true });
  const ready = await restarted.receive(message => message.type === "ready" || message.type === "startup-error");
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  assert.equal(ready.workspaceId, attached.result.workspaceId);
  assert.equal(ready.scope, "isolated_experiment");
  const reread = await restarted.request("invoke", { operation: "get", args: { id: original.id } });
  assert.equal(reread.result.result.content, updateArgs.content);
  assert.equal((await restarted.request("invoke", { operation: "get", args: { id: "isolated-created" } })).result.result.content, "Synthetic only\n");
  assert.equal((await restarted.request("invoke", { operation: "update", args: { ...updateArgs, operationId: randomUUID() } })).result.error.code, "CONFLICT");
  restarted.send({ type: "close" });
  await restarted.receive(message => message.type === "closed");
  assert.equal((await restarted.exit).code, 0);
  const targetNote = join(plan.target, "notes/Fixture.md");
  const preserved = await readFile(targetNote);
  await writeFile(targetNote, "external change");
  const tampered = client(f.dist); children.push(tampered);
  tampered.send({ type: "start-import-write", ...credential, acknowledgeIsolatedExperiment: true });
  assert.match((await tampered.receive(message => message.type === "startup-error")).message, /changed since clean close/);
  await tampered.exit;
  await writeFile(targetNote, preserved);
  const reverted = client(f.dist); children.push(reverted);
  reverted.send({ type: "start-import-write", ...credential, acknowledgeIsolatedExperiment: true });
  assert.match((await reverted.receive(message => message.type === "startup-error")).message, /changed since clean close/);
  await reverted.exit;
  // Independent synthetic imports exercise active tampering and process death.
  for (const mode of ["tamper", "binding", "crash"]) {
    const source2 = join(f.parent, `source-${mode}`), parent2 = join(f.parent, `destination-${mode}`);
    await mkdir(join(source2, "notes"), { recursive: true, mode: 0o700 });
    await mkdir(parent2, { mode: 0o700 });
    await writeFile(join(source2, "notes/Fixture.md"), f.note);
    const crash = client(f.dist); children.push(crash);
    crash.send({ type: "start-import", source: source2, parent: parent2, legacyRoot: f.legacy, python, acknowledge: true });
    const crashPlan = await crash.receive(message => message.type === "import-plan");
    await crash.request("confirm-import", { planSha256: crashPlan.planSha256 });
    await crash.request("attach-import");
    const crashPrepared = (await crash.request("prepare-import-write")).result;
    const crashEnabled = await crash.request("enable-import-write", { authorizationDigest: crashPrepared.authorizationDigest,
      confirmTarget: crashPlan.target, acknowledgeIsolatedExperiment: true });
    assert.equal(crashEnabled.result.readOnly, false);
    if (mode !== "crash") {
      if (mode === "tamper") await writeFile(join(crashPlan.target, "notes/Fixture.md"), "unexpected external writer");
      else {
        const path = join(parent2, ".pkm-isolated-experiment.json");
        await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), actorId: `experiment:${randomUUID()}` }));
      }
      const denied = await crash.request("invoke", { operation: "update", args: { ...updateArgs, operationId: randomUUID() } });
      assert.equal(denied.error, "OUTCOME_UNKNOWN");
      assert.equal(denied.result, undefined);
      assert.equal((await crash.request("invoke", { operation: "get", args: { id: original.id } })).error, "OUTCOME_UNKNOWN");
      crash.send({ type: "close" });
      await crash.receive(message => message.type === "close-error");
    } else crash.child.kill("SIGKILL");
    await crash.exit;
    const afterCrash = client(f.dist); children.push(afterCrash);
    afterCrash.send({ type: "start-import-write", ...crashEnabled.result.credential, acknowledgeIsolatedExperiment: true });
    assert.match((await afterCrash.receive(message => message.type === "startup-error")).message,
      mode === "binding" ? /authorization binding changed/ : /unclean sessions/);
    await afterCrash.exit;
    assert.equal(await readFile(join(source2, "notes/Fixture.md"), "utf8"), f.note);
  }
  assert.equal(await readFile(join(f.source, "notes/Fixture.md"), "utf8"), f.note);
});

test("blocked and changed plans never publish and cannot be replayed", { timeout: 180000 }, async t => {
  const f = await setup(t);
  await writeFile(join(f.source, "notes/.unsupported"), "do not omit");
  const blocked = client(f.dist);
  t.after(() => { if (blocked.child.connected) blocked.send({ type: "close" }); });
  blocked.send({ type: "start-import", source: f.source, parent: f.destination, legacyRoot: f.legacy, python, acknowledge: true });
  const plan = await blocked.receive(message => message.type === "import-plan");
  assert.equal(plan.ready, false);
  assert(plan.blockers.length);
  assert.equal((await blocked.request("confirm-import", { planSha256: plan.planSha256 })).error, "BUSY_OR_INVALID");
  blocked.send({ type: "close" });
  await blocked.receive(message => message.type === "closed");
  assert.equal((await blocked.exit).code, 0);
  await rm(join(f.source, "notes/.unsupported"));
  const changed = client(f.dist);
  t.after(() => { if (changed.child.connected) changed.send({ type: "close" }); });
  changed.send({ type: "start-import", source: f.source, parent: f.destination, legacyRoot: f.legacy, python, acknowledge: true });
  const ready = await changed.receive(message => message.type === "import-plan");
  await writeFile(join(f.source, "notes/Fixture.md"), `${f.note}changed`);
  assert.equal((await changed.request("confirm-import", { planSha256: ready.planSha256 })).error, "OUTCOME_UNKNOWN");
  assert.equal((await changed.request("confirm-import", { planSha256: ready.planSha256 })).error, "BUSY_OR_INVALID");
  assert.notEqual((await changed.request("import-status")).result.outcome.status, "published");
  assert.equal((await changed.request("attach-import")).error, "BUSY_OR_INVALID");
  assert.deepEqual(await readdir(f.destination), []);
  changed.send({ type: "close" });
  await changed.receive(message => message.type === "closed");
  assert.equal((await changed.exit).code, 0);
  const occupied = join(f.parent, "occupied");
  await mkdir(occupied, { mode: 0o700 });
  await writeFile(join(occupied, "workspace"), "existing data");
  const rejected = client(f.dist);
  rejected.send({ type: "start-import", source: f.source, parent: occupied, legacyRoot: f.legacy, python, acknowledge: true });
  assert.match((await rejected.receive(message => message.type === "startup-error")).message, /empty and private/);
  assert.equal((await rejected.exit).code, 1);
  assert.equal(await readFile(join(occupied, "workspace"), "utf8"), "existing data");
  const link = join(f.parent, "linked-source");
  await symlink(f.source, link);
  const linked = client(f.dist);
  linked.send({ type: "start-import", source: link, parent: f.destination, legacyRoot: f.legacy, python, acknowledge: true });
  await linked.receive(message => message.type === "startup-error");
  assert.equal((await linked.exit).code, 1);
});

test("close waits for an in-flight importer and a crashed import is never replayed", { timeout: 180000 }, async t => {
  const f = await setup(t), c = client(f.dist);
  t.after(() => { if (c.child.connected) c.send({ type: "close" }); });
  const helper = join(f.parent, "python-helper"), ready = join(f.parent, "helper-started"), gate = join(f.parent, "helper-release");
  await writeFile(helper, `#!/usr/bin/python3
import os, time
with open(${JSON.stringify(ready)}, "w") as f: f.write(str(os.getppid()))
while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.05)
os._exit(7)
`);
  await chmod(helper, 0o700);
  c.send({ type: "start-import", source: f.source, parent: f.destination, legacyRoot: f.legacy, python: helper, acknowledge: true });
  const plan = await c.receive(message => message.type === "import-plan");
  assert.equal(plan.ready, true);
  const requestId = randomUUID();
  c.send({ type: "confirm-import", id: requestId, planSha256: plan.planSha256 });
  await waitForFile(ready);
  c.send({ type: "close" });
  const premature = await Promise.race([c.exit.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 250))]);
  assert.equal(premature, false, "close must wait for the real importer process");
  await writeFile(gate, "release");
  const outcome = await c.receive(message => message.type === "result" && message.id === requestId);
  assert.equal(outcome.error, "OUTCOME_UNKNOWN");
  await c.receive(message => message.type === "closed");
  assert.deepEqual(await c.exit, { code: 0, signal: null });
  const target2 = join(f.parent, "target2"), ready2 = join(f.parent, "started2"), gate2 = join(f.parent, "release2");
  await mkdir(target2, { mode: 0o700 });
  const helper2 = join(f.parent, "python-helper2");
  await writeFile(helper2, `#!/usr/bin/python3
import os, time
with open(${JSON.stringify(ready2)}, "w") as f: f.write(str(os.getppid()))
while not os.path.exists(${JSON.stringify(gate2)}): time.sleep(0.05)
os._exit(7)
`);
  await chmod(helper2, 0o700);
  const crashed = client(f.dist);
  t.after(() => { if (crashed.child.connected) crashed.send({ type: "close" }); });
  crashed.send({ type: "start-import", source: f.source, parent: target2, legacyRoot: f.legacy, python: helper2, acknowledge: true });
  const readyPlan = await crashed.receive(message => message.type === "import-plan");
  const crashId = randomUUID();
  crashed.send({ type: "confirm-import", id: crashId, planSha256: readyPlan.planSha256 });
  const cliPid = Number(await waitForFile(ready2));
  assert(Number.isSafeInteger(cliPid) && cliPid > 1);
  process.kill(cliPid, "SIGKILL");
  await writeFile(gate2, "release");
  assert.equal((await crashed.receive(message => message.type === "result" && message.id === crashId)).error, "OUTCOME_UNKNOWN");
  assert.equal((await crashed.request("confirm-import", { planSha256: readyPlan.planSha256 })).error, "BUSY_OR_INVALID");
  assert.notEqual((await crashed.request("import-status")).result.outcome.status, "published");
  crashed.send({ type: "close" });
  await crashed.receive(message => message.type === "closed");
  assert.equal((await crashed.exit).code, 0);
  assert.equal(await readFile(join(f.source, "notes/Fixture.md"), "utf8"), f.note);
});
