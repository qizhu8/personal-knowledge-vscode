import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { startOriginalMcpNativeAttachmentServer } from "../../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../../dist/original-mcp-native-identity.js";
import {
  createOriginalMcpNativeChatProducerChannel, createOriginalMcpNativeChatRpcPort, waitForOriginalMcpNativeChatSupport,
} from "../../dist/original-mcp-native-chat-rpc.js";
import { originalMcpNativeRequestProtocol, parseOriginalMcpNativeRequest, originalMcpNativeResult } from "../../dist/original-mcp-native-request.js";

const hash = value => createHash("sha256").update(value).digest("hex");
/** Real socket/crypto only: this helper is NOT a native VS Code producer/permission proof. */
export async function createOriginalMcpNativeChatSessionFixture(t, { binding: changes, models, execution, apiChat, sdk, sdkStatus,
  bootstrap: createBootstrap, nativeMethods, nativeRequest }) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the isolated Linux framework.");
  assert(models && execution, "Supply the explicit fixed fixture producer ports.");
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `s-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  const owned = await lstat(directory, { bigint: true }), keys = generateKeyPairSync("ed25519");
  const profileSha256 = changes?.profileSha256 ?? hash("fixture-profile");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const activationId = randomUUID();
  const binding = { root: join(process.env.PKM_TEST_WORKSPACE, "fixture-root"), workspaceId: randomUUID(),
    planSha256: hash("fixture-plan"), catalogSha256: hash("fixture-catalogue"), profileSha256,
    payloadBuildId: hash("fixture-build"), hostEntrySha256: hash("fixture-host"), ...changes };
  const bootstrap = createBootstrap ? await createBootstrap({ directory, identity, binding }) : undefined;
  const server = bootstrap ? undefined : await startOriginalMcpNativeAttachmentServer({
    directory, identity, identitySha256: identity.sha256, binding, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 3000,
  });
  const lifetime = new AbortController(), socket = connect(join(directory, "n"));
  let input = "", producer, support, resolveAttached, requestSession;
  const attached = new Promise(resolve => { resolveAttached = resolve; });
  const send = frame => new Promise((resolve, reject) => {
    socket.write(JSON.stringify(frame) + "\n", error => error ? reject(error) : resolve());
  });
  socket.on("error", () => {});
  socket.on("close", () => lifetime.abort());
  socket.on("data", chunk => {
    input += chunk.toString("utf8");
    for (let end; (end = input.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, activationId);
        void send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        requestSession = { brokerId: frame.brokerId, activationId, identitySha256: identity.sha256, epoch: activationId, binding };
        producer = createOriginalMcpNativeChatProducerChannel({
          session: { brokerId: frame.brokerId, activationId, identitySha256: identity.sha256, epoch: activationId, binding },
          models, execution, ...(apiChat ? { apiChat } : {}), ...(sdk ? { sdk } : {}),
          ...(sdkStatus ? { sdkStatus } : {}), signal: lifetime.signal,
          assertCurrent() { if (lifetime.signal.aborted) throw new Error("Fixture signer revoked."); },
          send, close() { socket.destroy(); },
        });
        if (bootstrap) void send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol,
          session: requestSession, methods: nativeMethods, maxPacketBytes: 16384 });
        support = producer.support(); void support.catch(() => {}); resolveAttached();
      } else if (frame.type === "ping") void send({ type: "pong", nonce: frame.nonce });
      else if (bootstrap && frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, requestSession);
        void Promise.resolve(nativeRequest(request, lifetime.signal))
          .then(result => send(originalMcpNativeResult(request, result))).catch(() => socket.destroy());
      }
      else if (frame.type.startsWith("native-chat-")) {
        try { producer.receive(frame); } catch { socket.destroy(); }
      }
    }
  });
  let closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    lifetime.abort();
    try { await producer?.dispose(); } catch (error) { failures.push(error); }
    socket.destroy();
    try { if (bootstrap) await bootstrap.close(); else await server.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Owned model fixture cleanup failed; state retained.");
    const current = await lstat(directory, { bigint: true });
    assert.equal(current.ino, owned.ino); assert.equal(current.dev, owned.dev); assert.equal(current.uid, owned.uid);
    await rm(directory, { recursive: true });
  })();
  t.after(close);
  await attached;
  const host = bootstrap ? await bootstrap.complete({ enableModels: true }) : undefined;
  const session = host ? host.nativeChat.session : await server.waitForSession({ timeoutMs: 2000 });
  await waitForOriginalMcpNativeChatSupport(session, { timeoutMs: 2000 }); await support;
  return { session, activationId, binding, resource: host?.nativeChat ?? createOriginalMcpNativeChatRpcPort(session),
    producer, server, socket, close, bootstrap, host };
}
