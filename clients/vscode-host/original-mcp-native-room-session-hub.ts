import { randomUUID, createHash } from "node:crypto";
import { connect } from "node:net";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatRoomCredentialStore } from "../../legacy/src/chatroom/chat-room-credentials.js";
import {
  originalRoomSessionEffectSchema, roomSessionProofSchema, roomSessionOperationSchema,
  originalRoomSessionDigest as digest, type OriginalRoomSessionEffect, type RoomSessionOperation,
} from "../../src/original-mcp-room-session-contracts.js";
import { originalRoomUserLinkIntentSchema } from "../../src/original-mcp-room-session-contracts.js";
import { describeOriginalRoomUserJoin, parseOriginalRoomUserJoinArguments } from "../../src/original-mcp-room-session-user-link-codec.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const templateSha256 = "0834131c634962e3526540eac35fdba35beb28cefa6de1f17dce8ac586e4a722";
export type CredentialStore = Pick<ChatRoomCredentialStore, "load" | "verifyHost">;
export type Retained = { ChatHub: new () => any; ChatJoinApprovalManager: new (...args: any[]) => any;
  WebSocketServer: new (...args: any[]) => any };
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path
    || stat.uid !== process.getuid!() || stat.mode & 0o077) fail("ROOM_SESSION_NATIVE_PRIVATE_DIRECTORY_REQUIRED");
}
async function watchPersistence(effect: OriginalRoomSessionEffect, input: unknown, signal: AbortSignal, revoke: () => void) {
  const descriptor = roomSessionProofSchema.parse(input);
  if (descriptor.sessionId !== effect.sessionId || descriptor.effectSha256 !== digest(effect))
    fail("ROOM_SESSION_NATIVE_PERSISTENCE_BINDING_REQUIRED");
  await privateDirectory(dirname(descriptor.socketPath));
  const node = await lstat(descriptor.socketPath);
  if (!node.isSocket() || node.uid !== process.getuid!() || node.mode & 0o077) fail("ROOM_SESSION_NATIVE_PERSISTENCE_UNSAFE");
  const socket = connect(descriptor.socketPath), operationId = randomUUID(), body = { operation: "session.watch" as const };
  await new Promise<void>((resolve, reject) => {
    let bytes = "", ready = false;
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(5000, () => socket.destroy());
    socket.once("connect", () => socket.write(JSON.stringify({
      sessionId: effect.sessionId, transportToken: descriptor.transportToken, operationId, body, requestSha256: digest(body),
    }) + "\n"));
    socket.once("close", () => {
      signal.removeEventListener("abort", abort); revoke();
      if (!ready) reject(new Error("ROOM_SESSION_NATIVE_PERSISTENCE_CLOSED"));
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      bytes += String(chunk);
      if (bytes.length > 4096) { socket.destroy(); return; }
      if (!bytes.endsWith("\n")) return;
      try {
        const value = JSON.parse(bytes);
        if (ready || value.operationId !== operationId || value.watching !== true) { socket.destroy(); return; }
        ready = true; bytes = ""; socket.setTimeout(0); resolve();
      } catch { socket.destroy(); }
    });
    if (signal.aborted) abort();
  });
  return () => socket.destroy();
}

function persistenceClient(effect: OriginalRoomSessionEffect, input: unknown, signal: AbortSignal) {
  const descriptor = roomSessionProofSchema.parse(input);
  if (descriptor.sessionId !== effect.sessionId || descriptor.effectSha256 !== digest(effect))
    fail("ROOM_SESSION_NATIVE_PERSISTENCE_BINDING_REQUIRED");
  return async (body: RoomSessionOperation, operationId = randomUUID()): Promise<any> => {
    const wire = roomSessionOperationSchema.parse(JSON.parse(JSON.stringify(body)));
    const requestSha256 = digest(wire);
    if (signal.aborted || effect.expiresAtMs <= Date.now()) fail("ROOM_SESSION_NATIVE_REVOKED");
    await privateDirectory(dirname(descriptor.socketPath));
    const node = await lstat(descriptor.socketPath);
    if (!node.isSocket() || node.uid !== process.getuid!() || node.mode & 0o077) fail("ROOM_SESSION_NATIVE_PERSISTENCE_UNSAFE");
    return new Promise((resolve, reject) => {
      const socket = connect(descriptor.socketPath);
      let bytes = Buffer.alloc(0), complete = false;
      const finish = (error?: unknown, result?: unknown) => {
        if (complete) return;
        complete = true; signal.removeEventListener("abort", aborted); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const aborted = () => finish(Object.assign(new Error("ROOM_SESSION_NATIVE_REVOKED"), { code: "ROOM_SESSION_NATIVE_REVOKED" }));
      signal.addEventListener("abort", aborted, { once: true });
      socket.setTimeout(10000, () => finish(new Error("ROOM_SESSION_NATIVE_PERSISTENCE_TIMEOUT")));
      socket.on("error", finish); socket.once("close", () => { if (!complete) finish(new Error("ROOM_SESSION_NATIVE_PERSISTENCE_CLOSED")); });
      socket.once("connect", () => socket.write(JSON.stringify({
        sessionId: descriptor.sessionId, transportToken: descriptor.transportToken, operationId, body: wire, requestSha256,
      }) + "\n"));
      socket.on("data", chunk => {
        bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        if (bytes.length > 1048576) { finish(new Error("ROOM_SESSION_NATIVE_PERSISTENCE_TOO_LARGE")); return; }
        const boundary = bytes.indexOf(10); if (boundary < 0) return;
        try {
          if (boundary !== bytes.length - 1) fail("ROOM_SESSION_NATIVE_PERSISTENCE_INVALID");
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, boundary)));
          if (value.error) throw Object.assign(new Error(value.error.code), { code: value.error.code });
          if (value.operationId !== operationId || !("result" in value)) fail("ROOM_SESSION_NATIVE_PERSISTENCE_INVALID");
          finish(undefined, value.result);
        } catch (error) { finish(error); }
      });
      if (signal.aborted) aborted();
    });
  };
}

const clientProgram = String.raw`
import asyncio,base64,hashlib,json,os,runpy,sys
directory=sys.argv[1]
sys.path.insert(0,directory)
module=runpy.run_path(os.path.join(directory,"chat_server.py.template"),run_name="native_owned_original_room_client")
def method(name):
 f=module[name];return getattr(f,"fn",f)
async def main():
 setup=json.loads(await asyncio.to_thread(sys.stdin.readline))
 assert setup["endpoint"].startswith("ws://127.0.0.1:") and module["_connections"]=={}
 def cursor():
  clients=list(module["_connections"].values());return clients[0].cursor if clients else 0
 try:
  while True:
   line=await asyncio.to_thread(sys.stdin.readline)
   if not line:break
   request=json.loads(line);before=cursor()
   try:
    tool=request["tool"];args=request["arguments"]
    assert tool in ("chat_join","chat_read","chat_post","chat_leave","chat_status")
    if tool=="chat_join":
     if request.get("userSuppliedLink"):
      assert set(args)=={"name","magic_link"}
      alias=str(args["name"] or "").strip()
      if alias:
       if alias!=setup["alias"]:raise PermissionError("participant approval required")
       try:target,room,secret,room_id=module["_parse_magic_link"](args["magic_link"])
       except ValueError:pass
       else:
        if target!=setup["endpoint"] or room_id and room_id!=setup["roomId"]:
         raise PermissionError("endpoint/source approval required")
      result=await method(tool)(**args)
     else:
      assert set(args)=={"name"} and args["name"]==setup["alias"] and not module["_connections"]
      value={"v":1,"u":setup["endpoint"]+"/"+setup["room"],"s":setup["secret"],"r":setup["roomId"]}
      payload=base64.urlsafe_b64encode(json.dumps(value,separators=(",",":")).encode()).decode().rstrip("=")
      checksum=base64.urlsafe_b64encode(hashlib.sha256(payload.encode()).digest()).decode().rstrip("=")[:16]
      result=await method(tool)(magic_link="pkchat:v1:"+payload+"."+checksum,name=args["name"])
    else:
     result=await method(tool)(**args)
    assert isinstance(result,str)
    sys.stdout.write(json.dumps({"id":request["id"],"result":result,"cursorBefore":before,"cursorAfter":cursor()})+"\n");sys.stdout.flush()
   except PermissionError:
    sys.stdout.write(json.dumps({"id":request["id"],"error":"ROOM_USER_JOIN_ENDPOINT_OR_PARTICIPANT_APPROVAL_REQUIRED"})+"\n");sys.stdout.flush()
   except Exception:
    sys.stdout.write(json.dumps({"id":request["id"],"error":"ROOM_SESSION_ORIGINAL_CLIENT_FAILED"})+"\n");sys.stdout.flush()
 finally:
  for connection in list(module["_connections"].values()):await connection.leave()
asyncio.run(main())
`;

/**
 * Native-process data adapter, not an authority factory. The Core endpoint requires its independently
 * approved branded effect grant. No key or Hub/worker object is returned to the owner.
 */
export async function startNativeOwnedOriginalRoomSession(options: {
  effect: OriginalRoomSessionEffect; persistence: unknown; credentials: CredentialStore; retained: Retained;
  resources: { template: Buffer; guard: Buffer }; workDirectory: string; signal: AbortSignal;
}) {
  const effect = originalRoomSessionEffectSchema.parse(options.effect), lifetime = new AbortController();
  Object.freeze(effect.selection); Object.freeze(effect);
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  function current() { if (signal.aborted || effect.expiresAtMs <= Date.now()) fail("ROOM_SESSION_NATIVE_REVOKED"); }
  current();
  if (sha(options.resources.template) !== templateSha256) fail("ROOM_SESSION_PINNED_ORIGINAL_CLIENT_REQUIRED");
  const credentials = await options.credentials.load(effect.roomId);
  if (!credentials || !await options.credentials.verifyHost(effect.roomId, effect.hostCredentialHash)
    || credentials.hostCredentialHash !== effect.hostCredentialHash || credentials.joinSecretHash !== effect.joinSecretHash)
    fail("ROOM_SESSION_CURRENT_NATIVE_CREDENTIALS_REQUIRED");
  await mkdir(options.workDirectory, { mode: 0o700 });
  await privateDirectory(options.workDirectory);
  if ((await readdir(options.workDirectory)).length) fail("ROOM_SESSION_FRESH_CLIENT_DIRECTORY_REQUIRED");
  for (const [name, bytes] of [["chat_server.py.template", options.resources.template], ["mcp_call_guard.py", options.resources.guard]] as const)
    await writeFile(join(options.workDirectory, name), bytes, { mode: 0o600, flag: "wx" });
  const rpc = persistenceClient(effect, options.persistence, signal);
  const hub = new options.retained.ChatHub();
  for (const name of ["onConnection", "onMessage", "finishJoin", "rehostRoom", "stop"])
    if (typeof hub[name] !== "function") fail("ROOM_SESSION_RETAINED_HUB_ABI_REQUIRED");
  let roomName = "", stopped = false, closing: Promise<void> | undefined;
  const persistence = {
    async identityState() { return rpc({ operation: "identity.read" }); },
    async requestJoin(_roomId: string, request: any) { return rpc({ operation: "join.request", request }); },
    async resolveJoin(_roomId: string, resolution: any) { return rpc({ operation: "join.resolve", resolution }); },
    async releaseAlias(_roomId: string, participantId: string, at: number, alias?: string) {
      return rpc({ operation: "alias.release", participantId, at, ...(alias ? { alias } : {}) });
    },
    async forgetParticipant(_roomId: string, participantId: string, at: number) {
      return rpc({ operation: "participant.forget", participantId, at });
    },
    async append(_roomId: string, message: any) { return rpc({ operation: "message.append", message: JSON.parse(JSON.stringify(message)) }); },
    async closeRoom() { return rpc({ operation: "room.close" }); },
    async dispose() {},
  };
  hub.persistence = persistence;
  hub.lifecycle = {
    persistence,
    async listStoredRooms() {
      return [{ roomId: effect.roomId, roomName, canRehost: true }];
    },
    async rehostRoom() {
      const room = await rpc({ operation: "room.activate" }); roomName = room.roomName;
      if ((room.hostParticipantId ?? null) !== effect.hostParticipantId) fail("ROOM_SESSION_HOST_IDENTITY_CONFLICT");
      current(); return { ...room, joinSecret: credentials.joinSecret };
    },
    publishActiveDescriptor() {},
    async deactivateRoom() { await persistence.closeRoom(); },
    async dispose() { await persistence.closeRoom(); },
  };
  hub.approvals = new options.retained.ChatJoinApprovalManager(persistence,
    (_room: string, participantId: string) => [...hub.conns.values()].some((client: any) =>
      client.joined && client.participantId === participantId));
  // Only the original automatic-new path is allowed. Core rejects reused IDs/CIDs before any membership commit.
  const finishJoin = hub.finishJoin.bind(hub);
  hub.finishJoin = (connection: any, ...args: any[]) => {
    connection.temporary = true;
    return finishJoin(connection, ...args);
  };
  hub.setAdvertisedHost("127.0.0.1");
  const server = createServer((_request, response) => { response.writeHead(403); response.end(); });
  const sockets = new options.retained.WebSocketServer({ server, maxPayload: 65536 });
  const connections = new Set<any>();
  sockets.on("connection", (socket: any, request: any) => {
    try {
      current();
      if (stopped || request.socket.remoteAddress !== "127.0.0.1" || request.url !== "/" || connections.size >= 1) {
        socket.close(); return;
      }
      connections.add(socket); socket.once("close", () => connections.delete(socket)); hub.onConnection(socket);
    } catch { socket.close(); }
  });
  hub.http = server; hub.wss = sockets; hub._port = effect.selection.port;
  let worker: ReturnType<typeof spawn> | undefined, workerDone: Promise<void> | undefined, stopWatch: (() => void) | undefined;
  const pending = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
  let buffer = "", invocation: Promise<unknown> = Promise.resolve();
  async function close() {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      try { await rpc({ operation: "room.close" }); } catch { /* Core's denial-only close owns cleanup after revocation. */ }
      worker?.stdin?.end();
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const timer = setTimeout(() => worker?.kill("SIGTERM"), 3000); timer.unref();
        const force = setTimeout(() => worker?.kill("SIGKILL"), 5000); force.unref();
        try { await workerDone; } finally { clearTimeout(timer); clearTimeout(force); }
      }
      for (const request of pending.values()) request.reject(new Error("ROOM_SESSION_NATIVE_CLOSED"));
      pending.clear();
      for (const socket of connections) socket.terminate();
      try { await hub.stop(); } catch (error) {
        if (!signal.aborted && effect.expiresAtMs > Date.now()) throw error;
      } finally {
        try { sockets.close(); } catch { /* Already closed by the retained Hub. */ }
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        lifetime.abort();
        stopWatch?.();
        signal.removeEventListener("abort", revoked);
      }
    })();
    return closing;
  }
  const revoked = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", revoked, { once: true });
  try {
    stopWatch = await watchPersistence(effect, options.persistence, signal, () => lifetime.abort());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(effect.selection.port, "127.0.0.1", resolve); });
    current(); await hub.rehostRoom(effect.roomId); current();
    worker = spawn("python3", ["-I", "-B", "-u", "-c", clientProgram, options.workDirectory], {
      cwd: options.workDirectory, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const child = worker;
    workerDone = new Promise<void>(resolve => child.once("close", () => {
      for (const request of pending.values()) request.reject(new Error("ROOM_SESSION_ORIGINAL_CLIENT_CLOSED"));
      pending.clear(); resolve();
    }));
    child.on("error", () => { for (const request of pending.values()) request.reject(new Error("ROOM_SESSION_ORIGINAL_CLIENT_UNAVAILABLE")); });
    child.stdin!.on("error", () => {});
    child.stderr!.resume();
    child.stdout!.on("data", chunk => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > 65536) { void close(); return; }
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        try {
          const result = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
          const request = pending.get(result.id); if (!request) fail("ROOM_SESSION_ORIGINAL_CLIENT_INVALID");
          pending.delete(result.id);
          if (result.error) request.reject(new Error(result.error)); else request.resolve(result);
        } catch { void close(); return; }
      }
    });
    child.stdin!.write(JSON.stringify({ endpoint: effect.endpoint, room: roomName, roomId: effect.roomId,
      secret: credentials.joinSecret, alias: effect.selection.alias }) + "\n");
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Native Room open/cleanup failed; retain its Core receipts."); }
    throw error;
  }
  const timer = setTimeout(() => { void close(); }, Math.max(0, effect.expiresAtMs - Date.now())); timer.unref();
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  async function invoke(callId: string, call: any, transient?: { magic_link: string; name: string }) {
    const parsed = roomSessionOperationSchema.parse({ operation: "client.begin", callId, call });
    if (parsed.operation !== "client.begin") fail("ROOM_SESSION_CLIENT_CALL_REQUIRED");
    const run = invocation.then(async () => {
      current(); if (stopped) fail("ROOM_SESSION_NATIVE_CLOSED");
      const before = await rpc(parsed);
      if (before.replayed) {
        if (typeof before.result !== "string") fail("ROOM_SESSION_ORIGINAL_CLIENT_INVALID");
        return Object.freeze({ result: before.result });
      }
      if (parsed.call.tool === "chat_join" && parsed.call.userLink && !transient)
        fail("ROOM_USER_JOIN_TRANSIENT_LINK_REQUIRED");
      const value = await new Promise<any>((resolve, reject) => {
        pending.set(callId, { resolve, reject });
        const packet = transient
          ? { id: callId, tool: "chat_join", arguments: transient, userSuppliedLink: true }
          : { id: callId, ...parsed.call };
        worker!.stdin!.write(JSON.stringify(packet) + "\n");
        transient = undefined;
      });
      current();
      if (typeof value.result !== "string" || !Number.isSafeInteger(value.cursorBefore) || !Number.isSafeInteger(value.cursorAfter))
        fail("ROOM_SESSION_ORIGINAL_CLIENT_INVALID");
      if (parsed.call.tool === "chat_leave") {
        const end = Date.now() + 3000;
        for (;;) {
          const state = await rpc({ operation: "room.snapshot" });
          if (!state.identity.aliases.some((alias: any) => alias.alias === effect.selection.alias && !alias.releasedAt)) break;
          if (Date.now() >= end) fail("ROOM_SESSION_LEAVE_NOT_PERSISTED");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      await rpc({ operation: "client.complete", callId, result: value.result,
        cursorBefore: value.cursorBefore, cursorAfter: value.cursorAfter });
      return Object.freeze({ result: value.result });
    });
    invocation = run.catch(() => {}); return run;
  }
  async function invokeUserJoin(callId: string, input: unknown, expectedIntent: unknown) {
    current();
    const args = parseOriginalRoomUserJoinArguments(input), call = describeOriginalRoomUserJoin(effect, args);
    const expected = originalRoomUserLinkIntentSchema.safeParse(expectedIntent);
    if (!expected.success || digest(expected.data) !== digest(call.userLink)) fail("ROOM_USER_JOIN_INTENT_CHANGED");
    return invoke(callId, call, args);
  }
  return Object.freeze({ kind: "pkm.native-owned-original-room-session/v1" as const, effect,
    invoke, invokeUserJoin, close, signal, endpoint: effect.endpoint });
}
