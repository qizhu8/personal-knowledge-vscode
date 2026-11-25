import { createRequire } from "node:module";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Native-process fixture only: keys never leave this process; there is no VS Code/installed claim.
const config = JSON.parse(process.argv[2]), require = createRequire(import.meta.url);
const api = await import(pathToFileURL(config.api));
const { startNativeOwnedOriginalRoomSession } = require(config.native);
const retained = require(config.retained);
const { ChatRoomCredentialStore } = require(join(config.extension, "dist/chatroom/chat-room-credentials.js"));
const values = new Map(), credentials = new ChatRoomCredentialStore({
  async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); },
  async delete(key) { values.delete(key); },
});
const keys = generateKeyPairSync("ed25519");
const identity = api.originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), config.profileSha256);
const lifetime = new AbortController();
let socket, native, buffer = "", effectAllowed = true, sourceDecisionId = randomUUID(), userLinkForwards = 0;
const send = value => socket.write(JSON.stringify(value) + "\n");
async function frame(value) {
  if (value.type === "challenge") {
    const { body, message } = api.originalMcpNativeAttestationMessage(value.challenge, identity.sha256, config.activationId);
    send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
  } else if (value.type === "attached") {
    send({ type: "native-supports", protocol: api.originalMcpNativeRequestProtocol,
      session: { brokerId: value.brokerId, activationId: config.activationId, identitySha256: identity.sha256,
        epoch: config.activationId, binding: value.binding ?? config.binding },
      methods: api.originalMcpNativeRequestMethods, maxPacketBytes: 65536 });
  } else if (value.type === "ping") send({ type: "pong", nonce: value.nonce });
  else if (value.type === "native-request") {
    let result;
    if (value.method === "admission.approve" || value.method === "public.approve") {
      if (value.method === "public.approve" && value.payload.request.tool === "chat_join") {
        const args = value.payload.request.arguments;
        if ("magic_link" in args || JSON.stringify(args).includes("pkchat:v1:") || !args.user_link?.argumentsSha256)
          throw new Error("Public join approval must bind the redacted original input digest");
      }
      result = { decision: "approve" };
    }
    else if (value.method === "tool.approve") {
      if (value.payload.request.operation !== "room.session.loopback.open") throw new Error("Unexpected native effect operation");
      if (value.payload.request.readOnly !== false || value.payload.request.arguments.effect.noRemote !== true)
        throw new Error("Effect must be explicit, stateful and loopback-only");
      result = { decision: effectAllowed ? "approve" : "deny" };
    } else if (value.method === "room.source.approve")
      result = { decisionId: sourceDecisionId, expiresAtMs: Date.now() + 120000 };
    else if (value.method === "room.host.prove") {
      const { source, challenge } = value.payload;
      if (!await credentials.verifyHost(source.roomId, source.hostCredentialHash)) throw new Error("Current native Host missing");
      const proof = await credentials.createHostProof(source.roomId, api.originalNativeRoomHostPurpose(value.payload));
      result = { challenge, sourceDecisionId, sourceSha256: source.sourceSha256,
        hostParticipantId: source.hostParticipantId, hostCredentialHash: source.hostCredentialHash,
        joinSecretHash: source.joinSecretHash, proof };
    } else throw new Error(`Unexpected native method ${value.method}`);
    send(api.originalMcpNativeResult(value, result));
  }
}
async function action(value) {
  switch (value.operation) {
    case "prepare": {
      const created = await credentials.create(config.roomId, value.requestedJoinSecret);
      return { identity, hostCredentialHash: created.hostCredentialHash, joinSecretHash: created.joinSecretHash };
    }
    case "credential-facts": {
      const first = await credentials.create(randomUUID()), second = await credentials.create(randomUUID());
      return { hostBytes: Buffer.from(first.hostCredential, "base64url").length,
        joinBytes: Buffer.from(first.joinSecret, "base64url").length,
        twoGeneratedHostsDiffer: first.hostCredential !== second.hostCredential,
        twoGeneratedJoinsDiffer: first.joinSecret !== second.joinSecret };
    }
    case "attach":
      config.binding = value.binding;
      socket = connect(value.path); socket.on("error", () => {});
      socket.once("close", () => lifetime.abort());
      socket.on("data", chunk => {
        buffer += String(chunk);
        let boundary;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const value = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
          void frame(value).catch(() => { socket.destroy(); });
        }
      });
      return { connecting: true };
    case "allow-effects": effectAllowed = value.allow; return null;
    case "open":
      native = await startNativeOwnedOriginalRoomSession({
        effect: value.effect, persistence: value.persistence, credentials, retained,
        resources: { template: await readFile(join(config.extension, "resources/chat_server.py.template")),
          guard: await readFile(join(config.extension, "resources/mcp_call_guard.py")) },
        workDirectory: join(config.directory, `client-${value.effect.sessionId}`), signal: lifetime.signal,
      });
      return { endpoint: native.endpoint, kind: native.kind };
    case "call": return native.invoke(value.callId, value.call);
    case "join-user":
      userLinkForwards++; return native.invokeUserJoin(value.callId, value.arguments, value.intent);
    case "user-link-count": return { count: userLinkForwards };
    case "audit":
      return { rawKeysPresent: [...values.values()].some(secret => value.ownerBytes.includes(secret)),
        canonicalStorageLivesInOwnerOnly: true };
    case "closed-state":
      return { effectRevoked: native.signal.aborted, baseConnected: socket.readyState === "open" };
    case "revoke":
      socket.destroy(); lifetime.abort();
      await native?.close();
      return { closed: true };
    case "stop":
      lifetime.abort(); socket?.destroy(); await native?.close();
      return { stopped: true };
    default: throw new Error("Unknown fixture command");
  }
}
process.on("message", value => {
  void action(value).then(result => process.send?.({ id: value.id, result }),
    error => process.send?.({ id: value.id, error: { code: error.code || error.message || "NATIVE_FIXTURE_FAILED" } }));
});
process.once("disconnect", () => {
  lifetime.abort(); socket?.destroy();
  void Promise.resolve(native?.close()).finally(() => process.exit(0));
});
process.send?.({ ready: true });
