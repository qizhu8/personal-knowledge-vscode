import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  startOriginalMcpNativeAttachmentServer, verifyOriginalMcpNativeAttachmentDescriptor,
  assertAuthenticatedOriginalMcpNativeSession,
} from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use the Linux framework with a private recovery workspace parent.");
process.umask(0o077);
const work = process.env.PKM_TEST_WORKSPACE;
const hash = value => createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) { if (await check()) return; await delay(5); }
  throw new Error("Owned native attachment fixture condition timed out.");
}
async function fixture(t, options = {}, bindingOverrides = {}) {
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `a-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  const owned = await lstat(directory, { bigint: true }), expectedCloseErrors = new Set(), clients = [];
  const keys = generateKeyPairSync("ed25519"), profileSha256 = hash("synthetic-profile");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const binding = { root: join(work, `synthetic-native-root-${randomUUID()}`), workspaceId: randomUUID(),
    planSha256: hash("synthetic-root-plan"), catalogSha256: hash("synthetic-catalog"), profileSha256,
    payloadBuildId: hash("synthetic-payload"), hostEntrySha256: hash("synthetic-host"), ...bindingOverrides };
  const server = await startOriginalMcpNativeAttachmentServer({ directory, identity, identitySha256: identity.sha256,
    binding, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 500, ...options });
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    try { await server.close(); } catch (error) { if (!expectedCloseErrors.has(error)) throw error; }
    const now = await lstat(directory, { bigint: true });
    assert.equal(now.dev, owned.dev); assert.equal(now.ino, owned.ino); assert.equal(now.uid, owned.uid);
    assert(!now.isSymbolicLink());
    await rm(directory, { recursive: true });
  });
  const client = async (autoPong = true) => {
    const socket = connect(server ? (await verifyOriginalMcpNativeAttachmentDescriptor(server.descriptorPath,
      server.descriptorSha256, profileSha256)).socketPath : "");
    const frames = [], waiters = [], closed = new Promise(resolve => socket.once("close", resolve));
    let pending = "";
    socket.on("error", () => { socket.destroy(); });
    const send = value => socket.write(JSON.stringify(value) + "\n");
    socket.on("data", chunk => {
      pending += chunk.toString("utf8");
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (frame.type === "ping" && autoPong) send({ type: "pong", nonce: frame.nonce });
        const found = waiters.findIndex(waiter => waiter.type === frame.type);
        if (found !== -1) { const [waiter] = waiters.splice(found, 1); clearTimeout(waiter.timer); waiter.resolve(frame); }
        else frames.push(frame);
      }
    });
    const next = type => {
      const found = frames.findIndex(frame => frame.type === type);
      if (found !== -1) return Promise.resolve(frames.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned fixture frame timeout.")), 3000);
        waiters.push({ type, resolve, timer });
      });
    };
    const result = { socket, send, next, closed };
    clients.push(result);
    return result;
  };
  const attest = (challenge, privateKey = keys.privateKey) => {
    assert.equal(challenge.brokerId, server.brokerId);
    for (const [key, value] of Object.entries(binding)) assert.equal(challenge[key], value);
    const { body, message } = originalMcpNativeAttestationMessage(challenge, identity.sha256, randomUUID());
    return { ...body, signature: sign(null, message, privateKey).toString("base64") };
  };
  return { directory, server, client, attest, identity, binding, keys, expectedCloseErrors };
}
async function authenticate(f, autoPong = true) {
  const client = await f.client(autoPong), hello = await client.next("challenge");
  const attestation = f.attest(hello.challenge);
  client.send({ type: "attestation", attestation });
  const attached = await client.next("attached"), session = await f.server.waitForSession({ timeoutMs: 2000 });
  assert.equal(session.activationId, attached.activationId);
  return { client, attached, session, attestation };
}

test("actual socket/signature authentication is identity-only and preserves the caller's canonical root fence", async t => {
  const root = join(work, `attachment-owned-root-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  const fence = await acquireLinuxRootWriterFence(root);
  t.after(async () => { await fence.release(); await rm(root, { recursive: true }); });
  const workspaceId = randomUUID(), f = await fixture(t, {}, { root, workspaceId });
  const verified = await verifyOriginalMcpNativeAttachmentDescriptor(f.server.descriptorPath, f.server.descriptorSha256, f.binding.profileSha256);
  assert.equal(verified.schema, "pkm.original-mcp-native-attachment/v1");
  assert.deepEqual(Object.keys(verified).sort(), ["binding", "brokerId", "identitySha256", "schema", "socketPath"]);
  assert.equal(verified.identitySha256, f.identity.sha256);
  assert.equal((await lstat(f.server.descriptorPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(verified.socketPath)).mode & 0o777, 0o600);
  const { client, attached, session } = await authenticate(f);
  assert.deepEqual(Object.keys(attached).sort(), ["activationId", "brokerId", "businessReady", "identitySha256", "type"]);
  assert.equal(attached.businessReady, false);
  assertAuthenticatedOriginalMcpNativeSession(session, f.binding);
  assert.throws(() => assertAuthenticatedOriginalMcpNativeSession({ ...session }), { code: "NATIVE_ATTACHMENT_SESSION_UNAUTHENTICATED" });
  assert(!("models" in session)); assert(!("storage" in session)); assert(!("approveTool" in session));
  await client.next("ping");
  fence.assertHeld();
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), { code: "BUSY" });
  await session.close();
  assert.equal(session.signal.aborted, true);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), { code: "BUSY" });
  fence.assertHeld();
});

test("wrong signatures, cross-connection proofs and replay never authenticate; a fresh epoch revokes its predecessor", async t => {
  const f = await fixture(t);
  const wrong = await f.client(), hello = await wrong.next("challenge");
  wrong.send({ type: "attestation", attestation: f.attest(hello.challenge, generateKeyPairSync("ed25519").privateKey) });
  await wrong.closed;
  const first = await authenticate(f);
  const cross = await f.client(); await cross.next("challenge");
  cross.send({ type: "attestation", attestation: first.attestation });
  await cross.closed;
  first.session.assertCurrent();
  const second = await authenticate(f);
  await until(() => first.session.signal.aborted);
  assert.throws(() => first.session.assertCurrent());
  second.session.assertCurrent();
  assert.equal(second.session.signal.aborted, false);
});

test("connection/frame bounds and business-RPC rejection do not mint permissions or take down the listener", async t => {
  const f = await fixture(t, { maxConnections: 1, maxPacketBytes: 1024, handshakeTimeoutMs: 500 });
  const first = await f.client(); await first.next("challenge");
  const extra = await f.client(); await extra.closed;
  first.send({ type: "capability_call", operation: "anything" });
  await first.closed;
  const oversized = await f.client(); await oversized.next("challenge");
  oversized.socket.write("x".repeat(1025));
  await oversized.closed;
  await assert.rejects(f.server.waitForSession({ timeoutMs: 30 }), { code: "NATIVE_ATTACHMENT_WAIT_TIMEOUT" });
  const authenticated = await authenticate(f);
  authenticated.client.send({ type: "native-approved-model", allowed: true });
  await until(() => authenticated.session.signal.aborted);
  assert.throws(() => authenticated.session.assertCurrent());
});

test("missed heartbeat and disconnect synchronously revoke session liveness and dispose wait cancellation", async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 30, heartbeatTimeoutMs: 70 });
  const { session } = await authenticate(f, false);
  await until(() => session.signal.aborted);
  assert.equal(session.signal.reason.code, "NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT");
  assert.equal(session.signal.reason.timeoutMs, 70);
  assert(session.signal.reason.elapsedMs >= session.signal.reason.timeoutMs);
  assert(session.signal.reason.ownerTimerOvershootMs >= 0);
  assert.throws(() => session.assertCurrent());
  const controller = new AbortController();
  const waiting = assert.rejects(f.server.waitForSession({ timeoutMs: 2000, signal: controller.signal }),
    { code: "NATIVE_ATTACHMENT_WAIT_ABORTED" });
  controller.abort(); await waiting;
  await f.server.close();
  await assert.rejects(f.server.waitForSession(), { code: "NATIVE_ATTACHMENT_CLOSED" });
});

test("wall-clock adjustments do not revoke a live authenticated heartbeat before its monotonic deadline", async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 30, heartbeatTimeoutMs: 500 });
  const { client, session } = await authenticate(f);
  await client.next("ping");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 120000);
  try {
    session.assertCurrent();
    assert.equal(session.signal.aborted, false);
  } finally { t.mock.restoreAll(); }
  await client.next("ping");
  session.assertCurrent();
});

test("descriptor/profile pins and changed control files fail closed with observable cleanup failure", async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 30 });
  await assert.rejects(verifyOriginalMcpNativeAttachmentDescriptor(f.server.descriptorPath, "0".repeat(64), f.binding.profileSha256));
  await assert.rejects(verifyOriginalMcpNativeAttachmentDescriptor(f.server.descriptorPath, f.server.descriptorSha256, "0".repeat(64)),
    { code: "NATIVE_ATTACHMENT_PROFILE_MISMATCH" });
  const { session } = await authenticate(f);
  const failure = assert.rejects(f.server.closed, error => {
    assert(error instanceof AggregateError); assert.equal(error.code, "NATIVE_ATTACHMENT_CLEANUP_FAILED");
    f.expectedCloseErrors.add(error);
    return true;
  });
  await writeFile(f.server.descriptorPath, '{"changed":true}\n', { mode: 0o600 });
  await failure;
  assert.equal(session.signal.aborted, true);
  assert.throws(() => session.assertCurrent());
  assert.equal(await readFile(f.server.descriptorPath, "utf8"), '{"changed":true}\n', "Unknown replacement control is retained.");
});

test("unsafe linked or nonprivate endpoint directories are refused before listening", async t => {
  const f = await fixture(t);
  const other = join(work, `linked-native-${randomUUID()}`);
  await symlink(f.directory, other);
  t.after(() => rm(other));
  const options = { identity: f.identity, identitySha256: f.identity.sha256, binding: f.binding };
  await assert.rejects(startOriginalMcpNativeAttachmentServer({ ...options, directory: other }),
    { code: "NATIVE_ATTACHMENT_UNSAFE_DIRECTORY" });
  const nonprivate = join(work, `nonprivate-native-${randomUUID()}`);
  await mkdir(nonprivate, { mode: 0o755 }); await chmod(nonprivate, 0o755);
  t.after(() => rm(nonprivate, { recursive: true }));
  await assert.rejects(startOriginalMcpNativeAttachmentServer({ ...options, directory: nonprivate }),
    { code: "NATIVE_ATTACHMENT_UNSAFE_DIRECTORY" });
});
