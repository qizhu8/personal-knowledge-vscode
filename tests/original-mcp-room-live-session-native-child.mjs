import { createRequire } from "node:module";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Native-only synthetic fixture realm, not a VS Code API substitute or installed acceptance.
const config = JSON.parse(process.argv[2]), require = createRequire(import.meta.url);
const api = await import(pathToFileURL(config.api));
const { startNativeOwnedOriginalRoomSession } = require(config.native), retained = require(config.retained);
const { ChatRoomCredentialStore } = require(join(config.extension, "dist/chatroom/chat-room-credentials.js"));
const values = new Map(), credentials = new ChatRoomCredentialStore({
  async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); },
  async delete(key) { values.delete(key); },
});
const keys = generateKeyPairSync("ed25519");
const identity = api.originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), config.profileSha256);
const lifetime = new AbortController(), pending = new Map(), controls = { holdOpen: false, holdNextInvoke: false, denyPublic: false };
let socket, native, buffer = "", joins = 0, closeCalls = 0, publicCalls = 0;
const sourceDecisionId = randomUUID(), send = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); };
const event = (name, value = {}) => process.send?.({ event: name, ...value });
const waitAbort = signal => new Promise((_resolve, reject) => {
  const abort = () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
});
async function request(frame) {
  const controller = new AbortController(); pending.set(frame.requestId, controller);
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  try {
    let result;
    switch (frame.method) {
      case "admission.approve": result = { decision: "approve" }; break;
      case "public.approve": {
        publicCalls++;
        const approval = frame.payload.request;
        if (approval.tool === "chat_join" && ("magic_link" in approval.arguments
          || JSON.stringify(approval.arguments).includes("pkchat:v1:") || !approval.arguments.user_link?.argumentsSha256))
          throw new Error("Unredacted public join approval");
        result = { decision: controls.denyPublic ? "deny" : "approve" }; controls.denyPublic = false;
        break;
      }
      case "tool.approve":
        if (frame.payload.request.operation !== "room.session.loopback.open") throw new Error("Wrong fixture effect");
        result = { decision: "approve" }; break;
      case "room.source.approve": result = { decisionId: sourceDecisionId, expiresAtMs: Date.now() + 120000 }; break;
      case "room.host.prove": {
        const { source, challenge } = frame.payload;
        if (!await credentials.verifyHost(source.roomId, source.hostCredentialHash)) throw new Error("Native Host missing");
        result = { challenge, sourceDecisionId, sourceSha256: source.sourceSha256,
          hostParticipantId: source.hostParticipantId, hostCredentialHash: source.hostCredentialHash, joinSecretHash: source.joinSecretHash,
          proof: await credentials.createHostProof(source.roomId, api.originalNativeRoomHostPurpose(frame.payload)) };
        break;
      }
      case "room.session.open": {
        event("open-request");
        if (controls.holdOpen) await waitAbort(signal);
        const { effect, persistence } = frame.payload;
        native = await startNativeOwnedOriginalRoomSession({ effect, persistence, credentials, retained,
          resources: { template: await readFile(join(config.extension, "resources/chat_server.py.template")),
            guard: await readFile(join(config.extension, "resources/mcp_call_guard.py")) },
          workDirectory: join(config.directory, `client-${effect.sessionId}`), signal });
        result = { sessionId: effect.sessionId, effectSha256: api.originalRoomSessionDigest(effect),
          endpoint: effect.endpoint, alias: effect.selection.alias, expiresAtMs: effect.expiresAtMs };
        break;
      }
      case "room.session.join":
        joins++; result = await native.invokeUserJoin(frame.payload.callId, frame.payload.arguments, frame.payload.intent); break;
      case "room.session.invoke":
        result = await native.invoke(frame.payload.callId, frame.payload.call);
        if (controls.holdNextInvoke) {
          controls.holdNextInvoke = false;
          event("invoke-committed", { tool: frame.payload.call.tool });
          await waitAbort(signal);
        }
        break;
      case "room.session.close":
        closeCalls++; await native?.close(); result = { closed: true }; break;
      default: throw new Error("Unsupported fixture method");
    }
    send(api.originalMcpNativeResult(frame, result));
  } catch (error) {
    send(api.originalMcpNativeErrorResult(frame, error.code === "CANCELLED" || signal.aborted
      ? "NATIVE_REQUEST_CANCELLED" : "NATIVE_HANDLER_FAILED"));
  } finally { pending.delete(frame.requestId); }
}
async function frame(value) {
  if (value.type === "challenge") {
    const { body, message } = api.originalMcpNativeAttestationMessage(value.challenge, identity.sha256, config.activationId);
    send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
  } else if (value.type === "attached")
    send({ type: "native-supports", protocol: api.originalMcpNativeRequestProtocol,
      session: { brokerId: value.brokerId, activationId: config.activationId, identitySha256: identity.sha256,
        epoch: config.activationId, binding: config.binding }, methods: api.originalMcpNativeRequestMethods, maxPacketBytes: 65536 });
  else if (value.type === "ping") send({ type: "pong", nonce: value.nonce });
  else if (value.type === "native-cancel") pending.get(value.requestId)?.abort();
  else if (value.type === "native-request") void request(value);
}
async function action(value) {
  switch (value.operation) {
    case "prepare": {
      const created = await credentials.create(config.roomId, value.userSecret);
      return { identity, hostCredentialHash: created.hostCredentialHash, joinSecretHash: created.joinSecretHash };
    }
    case "attach":
      config.binding = value.binding; socket = connect(value.path); socket.on("error", () => {});
      socket.once("close", () => lifetime.abort());
      socket.on("data", chunk => {
        buffer += String(chunk); let boundary;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const value = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
          void frame(value).catch(() => socket.destroy());
        }
      });
      return null;
    case "controls": Object.assign(controls, value.controls); return null;
    case "stats": return { joins, closeCalls, publicCalls, baseConnected: socket.readyState === "open" };
    default: throw new Error("Unknown native fixture control");
  }
}
process.on("message", value => { void action(value).then(result => process.send?.({ id: value.id, result }),
  () => process.send?.({ id: value.id, error: "NATIVE_FIXTURE_CONTROL_FAILED" })); });
process.once("disconnect", () => {
  lifetime.abort(); socket?.destroy(); void Promise.resolve(native?.close()).finally(() => process.exit(0));
});
process.send?.({ ready: true });
