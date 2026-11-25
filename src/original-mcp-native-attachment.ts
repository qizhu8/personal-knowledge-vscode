import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync, realpathSync } from "node:fs";
import { chmod, lstat, open, readdir, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  OriginalMcpNativeChallenges, verifyOriginalMcpNativeIdentity,
  type OriginalMcpNativeBinding, type OriginalMcpNativeIdentity,
} from "./original-mcp-native-identity.js";
import { bindOriginalMcpNativeRequestTransport } from "./original-mcp-native-request.js";
import { bindOriginalMcpNativeChatTransport } from "./original-mcp-native-chat-rpc.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const canonicalPath = z.string().max(4096).refine(value =>
  isAbsolute(value) && resolve(value) === value && value !== sep && !/[\u0000-\u001f]/.test(value));
const bindingSchema = z.strictObject({
  root: canonicalPath, workspaceId: uuid, planSha256: digest, catalogSha256: digest,
  profileSha256: digest, payloadBuildId: digest, hostEntrySha256: digest,
});
const descriptorSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-attachment/v1"), brokerId: uuid,
  socketPath: canonicalPath, identitySha256: digest, binding: bindingSchema,
});
export type OriginalMcpNativeAttachmentDescriptor = Readonly<z.infer<typeof descriptorSchema>>;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const uid = () => BigInt(process.getuid!());
const statPin = (s: { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint;
  size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
function attachmentError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function fail(code: string): never { throw attachmentError(code); }
function aggregate(errors: unknown[]): AggregateError {
  return Object.assign(new AggregateError(errors, "Native attachment cleanup failed."),
    { code: "NATIVE_ATTACHMENT_CLEANUP_FAILED" });
}
const noPrimary = Symbol("no-primary");
async function withCleanup<T>(run: () => Promise<T>, cleanup: (() => void | Promise<void>)[]): Promise<T> {
  let value!: T, primary: unknown = noPrimary;
  try { value = await run(); } catch (error) { primary = error; }
  const errors: unknown[] = primary === noPrimary ? [] : [primary];
  for (const close of cleanup) await attempt(errors, close);
  if (errors.length > (primary === noPrimary ? 0 : 1)) throw aggregate(errors);
  if (primary !== noPrimary) throw primary;
  return value;
}
async function attempt(errors: unknown[], action: () => void | Promise<void>) {
  try { await action(); } catch (error) { errors.push(error); }
}
function directory(path: string) {
  canonicalPath.parse(path);
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o002) fail("NATIVE_ATTACHMENT_UNSAFE_DIRECTORY");
  }
  const stat = lstatSync(path, { bigint: true });
  if (realpathSync(path) !== path || stat.uid !== uid() || (stat.mode & 0o7777n) !== 0o700n)
    fail("NATIVE_ATTACHMENT_UNSAFE_DIRECTORY");
  return stat;
}
function privateDescriptor(path: string, independentSha256: string) {
  canonicalPath.parse(path); digest.parse(independentSha256);
  directory(dirname(path));
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== uid()
    || (before.mode & 0o7777n) !== 0o600n || before.size > 16384n) fail("NATIVE_ATTACHMENT_DESCRIPTOR_UNSAFE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let primary: unknown = noPrimary;
  try {
    if (statPin(before) !== statPin(fstatSync(fd, { bigint: true }))) fail("NATIVE_ATTACHMENT_DESCRIPTOR_CHANGED");
    const bytes = readFileSync(fd);
    if (hash(bytes) !== independentSha256 || BigInt(bytes.length) !== before.size
      || statPin(before) !== statPin(fstatSync(fd, { bigint: true }))
      || statPin(before) !== statPin(lstatSync(path, { bigint: true }))) fail("NATIVE_ATTACHMENT_DESCRIPTOR_CHANGED");
    const descriptor = descriptorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (dirname(descriptor.socketPath) !== dirname(path)) fail("NATIVE_ATTACHMENT_DESCRIPTOR_UNSAFE");
    const socket = lstatSync(descriptor.socketPath, { bigint: true });
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid() || (socket.mode & 0o7777n) !== 0o600n)
      fail("NATIVE_ATTACHMENT_SOCKET_UNSAFE");
    return { descriptor, descriptorPin: statPin(before), socketPin: statPin(socket) };
  } catch (error) { primary = error; throw error; }
  finally {
    try { closeSync(fd); } catch (error) { throw aggregate(primary === noPrimary ? [error] : [primary, error]); }
  }
}

/** Read-only public binding verification; no root/Storage access or authority is minted. */
export async function verifyOriginalMcpNativeAttachmentDescriptor(path: string, independentSha256: string,
  profileSha256: string) {
  digest.parse(profileSha256);
  const { descriptor } = privateDescriptor(path, independentSha256);
  if (descriptor.binding.profileSha256 !== profileSha256) fail("NATIVE_ATTACHMENT_PROFILE_MISMATCH");
  return Object.freeze({ ...descriptor, binding: Object.freeze({ ...descriptor.binding }) });
}

export interface AuthenticatedOriginalMcpNativeSession {
  readonly kind: "pkm.authenticated-native-producer/v1";
  readonly brokerId: string;
  readonly activationId: string;
  readonly identitySha256: string;
  readonly binding: Readonly<OriginalMcpNativeBinding>;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  close(): Promise<void>;
}
const authenticated = new WeakMap<object, { assertCurrent(): void; binding: OriginalMcpNativeBinding }>();

/** Identity/connection liveness only; never model, tool, worker or old-state permission. */
export function assertAuthenticatedOriginalMcpNativeSession(value: unknown, binding?: OriginalMcpNativeBinding):
  asserts value is AuthenticatedOriginalMcpNativeSession {
  const state = value && typeof value === "object" ? authenticated.get(value) : undefined;
  if (!state || binding && JSON.stringify(bindingSchema.parse(binding)) !== JSON.stringify(state.binding))
    fail("NATIVE_ATTACHMENT_SESSION_UNAUTHENTICATED");
  state.assertCurrent();
}

export interface OriginalMcpNativeAttachmentOptions {
  directory: string;
  identity: OriginalMcpNativeIdentity;
  identitySha256: string;
  binding: OriginalMcpNativeBinding;
  maxConnections?: number;
  maxPacketBytes?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

/** Private bounded identity transport. It neither opens a root nor exposes business RPC. */
export async function startOriginalMcpNativeAttachmentServer(options: OriginalMcpNativeAttachmentOptions) {
  if (process.platform !== "linux") fail("NATIVE_ATTACHMENT_LINUX_REQUIRED");
  const binding = Object.freeze(bindingSchema.parse(options.binding));
  const identity = verifyOriginalMcpNativeIdentity(options.identity, options.identitySha256, binding.profileSha256);
  const root = options.directory, rootIdentity = directory(root);
  if ((await readdir(root)).length) fail("NATIVE_ATTACHMENT_DIRECTORY_NOT_EMPTY");
  const socketPath = join(root, "n"), descriptorPath = join(root, "native-attachment.json");
  if (Buffer.byteLength(socketPath) > 103) fail("NATIVE_ATTACHMENT_SOCKET_PATH_LIMIT");
  const integer = (value: number | undefined, fallback: number, minimum: number, maximum: number) => {
    const chosen = value ?? fallback;
    if (!Number.isInteger(chosen) || chosen < minimum || chosen > maximum) fail("NATIVE_ATTACHMENT_LIMIT_INVALID");
    return chosen;
  };
  const maximumConnections = integer(options.maxConnections, 4, 1, 8);
  const maximumPacket = integer(options.maxPacketBytes, 16384, 1024, 65536);
  const handshakeTimeout = integer(options.handshakeTimeoutMs, 60000, 50, 60000);
  const heartbeatInterval = integer(options.heartbeatIntervalMs, 15000, 20, 60000);
  const heartbeatTimeout = integer(options.heartbeatTimeoutMs, 10000, 20, 60000);
  const issuer = new OriginalMcpNativeChallenges(identity, options.identitySha256, binding);
  const connections = new Set<Socket>(), active = new Map<Socket, { revoke(): void }>();
  const pending = new Set<{ resolve(value: AuthenticatedOriginalMcpNativeSession): void; reject(error: unknown): void; dispose(): void }>();
  let current: AuthenticatedOriginalMcpNativeSession | undefined;
  let closing = false, closePromise: Promise<void> | undefined;
  let descriptorPin: string | undefined, socketPin: string | undefined, descriptorSha256 = "";
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((ready, reject) => { resolveClosed = ready; rejectClosed = reject; });
  void closed.catch(() => { /* The same rejected lifecycle promise remains observable by the owner. */ });
  const listener = createServer(socket => {
    if (closing || connections.size >= maximumConnections) { socket.destroy(); return; }
    connections.add(socket);
    socket.on("error", () => { socket.destroy(); });
    socket.once("close", () => { connections.delete(socket); active.get(socket)?.revoke(); active.delete(socket); });
    let bytes = Buffer.alloc(0), session: AuthenticatedOriginalMcpNativeSession | undefined;
    let challengeSha256 = "", ping: string | undefined, pingDeadline = 0, pingSentAt = 0;
    let heartbeat: NodeJS.Timeout | undefined;
    let pingTimer: NodeJS.Timeout | undefined;
    let nativeFrame: ((value: unknown) => void) | undefined;
    let nativeChatFrame: ((value: unknown) => void) | undefined;
    const timeout = setTimeout(() => rejectConnection(attachmentError("NATIVE_ATTACHMENT_HANDSHAKE_TIMEOUT")), handshakeTimeout);
    const controller = new AbortController();
    const rejectConnection = (reason: unknown = attachmentError("NATIVE_ATTACHMENT_SESSION_REVOKED")) => {
      clearTimeout(timeout); if (heartbeat) clearInterval(heartbeat); if (pingTimer) clearTimeout(pingTimer);
      if (current === session) current = undefined;
      controller.abort(reason); socket.destroy();
    };
    const heartbeatFailure = () => {
      const now = performance.now();
      return Object.assign(attachmentError("NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT"), {
        timeoutMs: heartbeatTimeout, elapsedMs: now - pingSentAt,
        ownerTimerOvershootMs: Math.max(0, now - pingDeadline),
      });
    };
    const expireHeartbeat = () => {
      if (!ping || controller.signal.aborted) return;
      const remaining = pingDeadline - performance.now();
      if (remaining > 0) { pingTimer = setTimeout(expireHeartbeat, Math.ceil(remaining)); return; }
      rejectConnection(heartbeatFailure());
    };
    active.set(socket, { revoke: rejectConnection });
    const send = (value: unknown) => {
      try { socket.write(JSON.stringify(value) + "\n", error => { if (error) rejectConnection(); }); }
      catch { rejectConnection(); }
    };
    const assertCurrent = () => {
      try {
        assertControls();
        if (ping && performance.now() > pingDeadline) throw heartbeatFailure();
        if (closing || controller.signal.aborted || socket.destroyed || current !== session)
          fail("NATIVE_ATTACHMENT_SESSION_REVOKED");
      } catch (error) { rejectConnection(error); throw error; }
    };
    socket.on("data", chunk => {
      const input = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      let offset = 0;
      while (offset < input.length) {
        const end = input.indexOf(10, offset), boundary = end === -1 ? input.length : end;
        if (bytes.length + boundary - offset + 1 > maximumPacket) { rejectConnection(); return; }
        bytes = Buffer.concat([bytes, input.subarray(offset, boundary)]);
        if (end === -1) return;
        const line = bytes; bytes = Buffer.alloc(0); offset = end + 1;
        try {
          assertControls();
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          if (!session) {
            const frame = z.strictObject({ type: z.literal("attestation"),
              attestation: z.strictObject({ schema: z.literal("pkm.original-mcp-native-attestation/v1"),
                identitySha256: digest, activationId: uuid, challengeSha256: digest, signature: z.string().max(128) }) }).parse(value);
            if (frame.attestation.challengeSha256 !== challengeSha256) fail("NATIVE_ATTACHMENT_CHALLENGE_MISMATCH");
            const proof = issuer.consume(frame.attestation);
            clearTimeout(timeout);
            if (current) for (const [other, state] of active) if (other !== socket) state.revoke();
            session = Object.freeze({
              kind: "pkm.authenticated-native-producer/v1" as const, brokerId: issuer.brokerId,
              activationId: proof.activationId, identitySha256: proof.identitySha256, binding,
              signal: controller.signal, assertCurrent,
              async close() {
                rejectConnection();
                if (!socket.closed) await new Promise<void>(ready => socket.once("close", ready));
              },
            });
            current = session;
            authenticated.set(session, { assertCurrent, binding });
            nativeFrame = bindOriginalMcpNativeRequestTransport(session, {
              maximumBytes: maximumPacket, revoke: rejectConnection,
              send(value) {
                assertCurrent();
                const bytes = JSON.stringify(value) + "\n";
                if (Buffer.byteLength(bytes) > maximumPacket) fail("NATIVE_REQUEST_TOO_LARGE");
                if (socket.writableLength + Buffer.byteLength(bytes) > maximumPacket * 16) fail("NATIVE_REQUEST_BACKPRESSURE");
                send(value);
              },
            });
            nativeChatFrame = bindOriginalMcpNativeChatTransport(session, {
              maximumBytes: maximumPacket, revoke: rejectConnection,
              async send(value) {
                assertCurrent();
                const frame = JSON.stringify(value) + "\n";
                if (Buffer.byteLength(frame) > maximumPacket || socket.writableLength + Buffer.byteLength(frame) > maximumPacket * 16)
                  fail("NATIVE_CHAT_BACKPRESSURE");
                await new Promise<void>((ready, reject) => {
                  socket.write(frame, error => { if (error) reject(error); else ready(); });
                });
                assertCurrent();
              },
            });
            send({ type: "attached", brokerId: issuer.brokerId, ...proof, businessReady: false });
            for (const waiter of pending) { waiter.dispose(); waiter.resolve(session); }
            pending.clear();
            heartbeat = setInterval(() => {
              try {
                assertCurrent();
                if (ping) return;
                ping = randomBytes(24).toString("base64url"); pingSentAt = performance.now();
                pingDeadline = pingSentAt + heartbeatTimeout;
                pingTimer = setTimeout(expireHeartbeat, heartbeatTimeout);
                send({ type: "ping", nonce: ping });
              } catch { rejectConnection(); }
            }, heartbeatInterval);
          } else {
            assertCurrent();
            if (value && typeof value === "object" && "type" in value && typeof value.type === "string"
              && value.type.startsWith("native-chat-")) {
              nativeChatFrame!(value); continue;
            }
            if (value && typeof value === "object" && "type" in value
              && ["native-supports", "native-result"].includes(String(value.type))) {
              nativeFrame!(value); continue;
            }
            const frame = z.strictObject({ type: z.literal("pong"), nonce: z.string().max(64) }).parse(value);
            if (!ping || frame.nonce.length !== ping.length
              || !timingSafeEqual(Buffer.from(frame.nonce), Buffer.from(ping))) fail("NATIVE_ATTACHMENT_PONG_MISMATCH");
            ping = undefined; pingDeadline = 0;
            if (pingTimer) clearTimeout(pingTimer);
          }
        } catch (error) { rejectConnection(error); return; }
      }
    });
    try {
      const challenge = issuer.issue(); challengeSha256 = hash(JSON.stringify(challenge));
      send({ type: "challenge", challenge });
    } catch { rejectConnection(); }
  });
  let monitor: NodeJS.Timeout | undefined;
  const fatal = (error: unknown) => { void close(error).catch(() => { /* Exposed through closed/close; no success-shaped fallback. */ }); };
  listener.on("error", error => { if (descriptorPin) fatal(error); });
  function assertControls() {
    const now = directory(root);
    if ([now.dev, now.ino].join(":") !== [rootIdentity.dev, rootIdentity.ino].join(":")) fail("NATIVE_ATTACHMENT_DIRECTORY_CHANGED");
    const verified = privateDescriptor(descriptorPath, descriptorSha256);
    if (verified.descriptorPin !== descriptorPin || verified.socketPin !== socketPin) fail("NATIVE_ATTACHMENT_CONTROL_CHANGED");
  }
  async function close(primary?: unknown): Promise<void> {
    return closePromise ??= (async () => {
      closing = true; if (monitor) clearInterval(monitor); issuer.close();
      const errors: unknown[] = primary === undefined ? [] : [primary];
      for (const waiter of pending) { waiter.dispose(); waiter.reject(Object.assign(new Error("Native attachment closed."), { code: "NATIVE_ATTACHMENT_CLOSED" })); }
      pending.clear();
      for (const state of active.values()) await attempt(errors, state.revoke);
      for (const socket of connections) await attempt(errors, () => { socket.destroy(); });
      await attempt(errors, () => new Promise<void>((ready, reject) => {
        if (!listener.listening) { ready(); return; }
        listener.close(error => error ? reject(error) : ready());
      }));
      if (!listener.listening) {
        let safeDirectory = false;
        await attempt(errors, () => {
          const current = directory(root);
          if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) fail("NATIVE_ATTACHMENT_DIRECTORY_CHANGED");
          safeDirectory = true;
        });
        if (!safeDirectory) { const error = aggregate(errors); rejectClosed(error); throw error; }
        if (descriptorPin) await attempt(errors, async () => {
          const stat = await lstat(descriptorPath, { bigint: true }).catch(error => { if (error.code !== "ENOENT") throw error; });
          if (!stat) return;
          if (statPin(stat) !== descriptorPin)
            fail("NATIVE_ATTACHMENT_DESCRIPTOR_CHANGED");
          await unlink(descriptorPath);
        });
        if (socketPin) await attempt(errors, async () => {
          const stat = await lstat(socketPath, { bigint: true }).catch(error => { if (error.code !== "ENOENT") throw error; });
          if (!stat) return;
          if (statPin(stat) !== socketPin) fail("NATIVE_ATTACHMENT_SOCKET_CHANGED");
          await unlink(socketPath);
        });
        await attempt(errors, async () => {
          const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await withCleanup(() => handle.sync(), [() => handle.close()]);
        });
      }
      if (errors.length) { const error = aggregate(errors); rejectClosed(error); throw error; }
      resolveClosed();
    })();
  }
  try {
    await new Promise<void>((ready, reject) => {
      const refused = (error: Error) => { listener.removeListener("listening", accepted); reject(error); };
      const accepted = () => { listener.removeListener("error", refused); ready(); };
      listener.once("error", refused); listener.once("listening", accepted); listener.listen(socketPath);
    });
    await chmod(socketPath, 0o600);
    socketPin = statPin(await lstat(socketPath, { bigint: true }));
    const descriptor: OriginalMcpNativeAttachmentDescriptor = Object.freeze({
      schema: "pkm.original-mcp-native-attachment/v1", brokerId: issuer.brokerId, socketPath,
      identitySha256: options.identitySha256, binding,
    });
    const bytes = Buffer.from(JSON.stringify(descriptor) + "\n");
    const handle = await open(descriptorPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await withCleanup(async () => { await handle.writeFile(bytes); await handle.sync(); }, [() => handle.close()]);
    descriptorSha256 = hash(bytes); descriptorPin = statPin(await lstat(descriptorPath, { bigint: true }));
    assertControls();
    monitor = setInterval(() => { try { assertControls(); } catch (error) { fatal(error); } }, heartbeatInterval);
    return Object.freeze({
      descriptorPath, descriptorSha256, brokerId: issuer.brokerId, closed, close: () => close(),
      async waitForSession(input: { timeoutMs?: number; signal?: AbortSignal } = {}) {
        if (closing) fail("NATIVE_ATTACHMENT_CLOSED");
        assertControls();
        if (current) { current.assertCurrent(); return current; }
        if (pending.size >= 32) fail("NATIVE_ATTACHMENT_WAIT_BUSY");
        const timeoutMs = integer(input.timeoutMs, 60000, 1, 300000);
        return new Promise<AuthenticatedOriginalMcpNativeSession>((ready, reject) => {
          const rejectWait = (code: string) => { waiter.dispose(); pending.delete(waiter); reject(Object.assign(new Error(code), { code })); };
          const timer = setTimeout(() => rejectWait("NATIVE_ATTACHMENT_WAIT_TIMEOUT"), timeoutMs);
          const aborted = () => rejectWait("NATIVE_ATTACHMENT_WAIT_ABORTED");
          const waiter = { resolve: ready, reject, dispose() { clearTimeout(timer); input.signal?.removeEventListener("abort", aborted); } };
          pending.add(waiter); input.signal?.addEventListener("abort", aborted, { once: true });
          if (input.signal?.aborted) aborted();
        });
      },
    });
  } catch (error) {
    await close(error);
    throw error;
  }
}
