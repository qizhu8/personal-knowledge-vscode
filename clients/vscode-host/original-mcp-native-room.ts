import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { ChatRoomCredentialStore } from "../../legacy/src/chatroom/chat-room-credentials.js";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalMcpNativeRoomStatusAvailable, readOriginalMcpNativeRoomStatus } from "./original-mcp-native-room-status.js";
import {
  originalNativeRoomMethods, originalNativeRoomSessionSchema, originalNativeRoomResultSchemas,
  parseOriginalNativeRoomPayload, assertOriginalNativeRoomPacketBudget, originalNativeRoomHostPurpose,
  originalNativeRoomStatusPurpose, originalNativeRoomDigest,
  type OriginalNativeRoomMethod, type OriginalNativeRoomSession, type OriginalNativeRoomSource,
} from "../../src/original-mcp-native-room-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const sourceLabel = "Admit this private Room source only", hostLabel = "Verify current Room Host";
const statusLabel = "Read this exact Room client status";
export async function createOriginalMcpNativeRoomProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeRoomSession; signal: AbortSignal; assertCurrent(): void; close(): Promise<void>;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = originalNativeRoomSessionSchema.parse(structuredClone(options.session));
  const methods = Object.freeze(originalNativeRoomMethods.filter(method =>
    method !== "room.status.read" || originalMcpNativeRoomStatusAvailable(context.extensionPath)));
  const credentials = new ChatRoomCredentialStore(context.secrets);
  const lifetime = new AbortController(), retired = new Set<string>(), pending = new Set<string>();
  const decisions = new Map<string, { source: OriginalNativeRoomSource; decisionId: string; expiresAtMs: number }>();
  const verifications = new Map<string, { challenge: string; sourceDecisionId: string; expiresAtMs: number }>();
  const bars = new Map<string, vscode.StatusBarItem>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  const commands: vscode.Disposable[] = [];
  let terminal = false, closing: Promise<void> | undefined;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (terminal || options.signal.aborted || signer.signal.aborted || signal?.aborted) fail("NATIVE_ROOM_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("NATIVE_ROOM_BINDING_MISMATCH");
  }
  function forget(roomId: string) {
    decisions.delete(roomId); verifications.delete(roomId); bars.get(roomId)?.dispose(); bars.delete(roomId);
    clearTimeout(timers.get(roomId)); timers.delete(roomId);
  }
  function retire() {
    if (terminal) return;
    terminal = true; lifetime.abort();
    for (const roomId of [...decisions.keys()]) forget(roomId);
    commands.forEach(command => command.dispose()); workspaceChange.dispose(); secretChange.dispose();
    options.signal.removeEventListener("abort", dispose); signer.signal.removeEventListener("abort", dispose);
  }
  function revoke() { retire(); return closing ??= Promise.resolve().then(() => options.close()); }
  function dispose() {
    void revoke().catch(() => vscode.window.showErrorMessage(
      "PKM Room revocation could not confirm signed attachment shutdown. Disconnect the native session; no new Room authority was granted."));
  }
  const workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(dispose);
  const secretChange = context.secrets.onDidChange(event => {
    for (const roomId of decisions.keys()) {
      if (event.key === `personalKnowledge.chatroom.${roomId}.host`
        || event.key === `personalKnowledge.chatroom.${roomId}.join`) { dispose(); break; }
    }
  });
  const commandName = `personalKnowledge.revokeNativeRoom.${session.activationId}.${session.brokerId}`;
  current();
  commands.push(vscode.commands.registerCommand(commandName, revoke));
  options.signal.addEventListener("abort", dispose, { once: true }); signer.signal.addEventListener("abort", dispose, { once: true });
  context.subscriptions.push({ dispose });
  async function prompt(title: string, detail: object, label: string, signal: AbortSignal) {
    current(signal);
    const work = vscode.window.showWarningMessage(title, { modal: true, detail: JSON.stringify(detail, null, 2) }, label, "Deny");
    const answer = await new Promise<string | undefined>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("NATIVE_ROOM_CANCELLED"), { code: "NATIVE_ROOM_CANCELLED" }));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
    current(signal); return answer === label;
  }
  async function handle(method: OriginalNativeRoomMethod, value: unknown, requestId: string, signal: AbortSignal) {
    current(signal);
    if (!methods.includes(method)) fail("MISSING_NATIVE_METHOD");
    const payload = parseOriginalNativeRoomPayload(method, structuredClone(value), session);
    originalNativeRoomSessionSchema.shape.activationId.parse(requestId);
    assertOriginalNativeRoomPacketBudget(method, payload, session, requestId);
    if (retired.has(requestId)) fail("NATIVE_ROOM_REQUEST_REPLAY");
    if (retired.size >= 4096) fail("NATIVE_ROOM_REQUEST_LEDGER_FULL");
    const roomId = payload.source.roomId;
    if (pending.has(roomId)) fail("NATIVE_ROOM_BUSY");
    if (!decisions.has(roomId) && new Set([...decisions.keys(), ...pending]).size >= 32) fail("NATIVE_ROOM_SELECTION_LIMIT");
    retired.add(requestId); pending.add(roomId);
    const combined = AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]);
    try {
      if (method === "room.source.approve") {
        forget(roomId);
        if (!await prompt("Admit this exact original private Room source?", {
          session, source: payload.source, noExecution: true,
          permission: "Private source/Meeting Note custody and participant history only. No public Note projection, model, tools, network hosting, participant reassignment, old client ID, old Host token or credential grant. Revocation closes this signed native session.",
        }, sourceLabel, combined)) return null;
        const decision = { decisionId: randomUUID(), expiresAtMs: Date.now() + 300000 };
        decisions.set(roomId, { source: payload.source, ...decision });
        const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
        bar.text = "$(shield) PKM private Room"; bar.command = commandName;
        bar.tooltip = `${payload.source.roomName}\n${session.binding.root}\nPrivate source only; click to revoke the signed session.`;
        bars.set(roomId, bar); bar.show();
        const timer = setTimeout(() => forget(roomId), 300000); timer.unref(); timers.set(roomId, timer);
        return originalNativeRoomResultSchemas["room.source.approve"].parse(decision);
      }
      if (!("sourceDecisionId" in payload)) fail("NATIVE_ROOM_SOURCE_REQUIRED");
      const admission = decisions.get(roomId);
      if (!admission || admission.decisionId !== payload.sourceDecisionId || admission.expiresAtMs <= Date.now()
        || admission.source.sourceSha256 !== payload.source.sourceSha256) fail("NATIVE_ROOM_SOURCE_REQUIRED");
      async function currentCredentials() {
        current(combined);
        if (!await credentials.verifyHost(roomId, payload.source.hostCredentialHash)) fail("NATIVE_ROOM_CURRENT_PROFILE_HOST_REQUIRED");
        const loaded = await credentials.load(roomId);
        if (!loaded || loaded.hostCredentialHash !== payload.source.hostCredentialHash
          || loaded.joinSecretHash !== payload.source.joinSecretHash) fail("NATIVE_ROOM_CURRENT_PROFILE_CREDENTIALS_CHANGED");
        current(combined);
      }
      if (method === "room.status.read") {
        const request = parseOriginalNativeRoomPayload("room.status.read", payload, session);
        const verified = verifications.get(roomId); verifications.delete(roomId);
        if (!verified || verified.challenge !== request.hostChallenge || verified.sourceDecisionId !== request.sourceDecisionId
          || verified.expiresAtMs <= Date.now()) fail("NATIVE_ROOM_CURRENT_HOST_GRANT_REQUIRED");
        const verificationCurrent = () => {
          current(combined);
          if (verified.expiresAtMs <= Date.now()) fail("NATIVE_ROOM_CURRENT_HOST_GRANT_REQUIRED");
        };
        await currentCredentials();
        if (!await prompt("Read this exact original Room client status?", {
          session, source: request.source, sourceDecisionId: request.sourceDecisionId, hostChallenge: request.hostChallenge,
          operation: request.operation, arguments: request.arguments, argumentsSha256: request.argumentsSha256,
          noNetwork: true, noRehost: true, noParticipantChange: true,
          permission: "Execute only the pinned original chat_status producer. No client is joined or restored; the current status-only producer has no active identities. A named lookup returns the original no-joined-identity error. Host/join secrets stay native; this does not authorize network, hosting, identity reassignment or any other tool.",
        }, statusLabel, combined)) return null;
        await currentCredentials(); verificationCurrent();
        const result = await readOriginalMcpNativeRoomStatus(context.extensionPath, request.arguments, combined);
        await currentCredentials(); verificationCurrent();
        if (decisions.get(roomId) !== admission || admission.expiresAtMs <= Date.now()) fail("NATIVE_ROOM_SOURCE_REQUIRED");
        const purpose = originalNativeRoomStatusPurpose(request, result);
        const signed = await credentials.createHostProof(roomId, purpose);
        if (!await credentials.verifyHostProof(roomId, request.source.hostCredentialHash, purpose, signed))
          fail("NATIVE_ROOM_CURRENT_PROFILE_HOST_REQUIRED");
        await currentCredentials(); verificationCurrent();
        return originalNativeRoomResultSchemas["room.status.read"].parse({
          challenge: request.challenge, hostChallenge: request.hostChallenge, sourceDecisionId: request.sourceDecisionId,
          sourceSha256: request.source.sourceSha256, argumentsSha256: request.argumentsSha256,
          resultSha256: originalNativeRoomDigest(result), result, proof: signed,
        });
      }
      const request = parseOriginalNativeRoomPayload("room.host.prove", payload, session);
      verifications.delete(roomId);
      async function proof() {
        await currentCredentials();
        const purpose = originalNativeRoomHostPurpose(request);
        const signed = await credentials.createHostProof(roomId, purpose);
        if (!await credentials.verifyHostProof(roomId, request.source.hostCredentialHash, purpose, signed))
          fail("NATIVE_ROOM_CURRENT_PROFILE_HOST_REQUIRED");
        await currentCredentials(); return signed;
      }
      await proof();
      if (!await prompt("Verify current native-profile Room Host custody?", {
        session, source: request.source, sourceDecisionId: request.sourceDecisionId, challenge: request.challenge,
        noExecution: true,
        permission: "Verify current profile Host and join credential hashes against this exact original owner/participant source. Secrets remain in native SecretStorage. This is not permission to rehost, join, rotate credentials, publish Notes, or reuse an old Host token.",
      }, hostLabel, combined)) return null;
      const signed = await proof();
      if (decisions.get(roomId) !== admission || admission.expiresAtMs <= Date.now()) fail("NATIVE_ROOM_SOURCE_REQUIRED");
      verifications.set(roomId, { challenge: request.challenge, sourceDecisionId: admission.decisionId,
        expiresAtMs: Math.min(admission.expiresAtMs, signed.timestamp + 30000, Date.now() + 30000) });
      return originalNativeRoomResultSchemas["room.host.prove"].parse({
        challenge: request.challenge, sourceDecisionId: admission.decisionId, sourceSha256: request.source.sourceSha256,
        hostParticipantId: request.source.hostParticipantId, hostCredentialHash: request.source.hostCredentialHash,
        joinSecretHash: request.source.joinSecretHash, proof: signed,
      });
    } finally { pending.delete(roomId); }
  }
  return Object.freeze({ methods, signal: lifetime.signal, handle, revoke, dispose });
}
