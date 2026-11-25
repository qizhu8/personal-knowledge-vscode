import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalNativeSyncMethod, parseOriginalNativeSyncPayload } from "../../src/original-mcp-native-sync-contracts.js";
import { originalNativeActionSession } from "../../src/original-mcp-native-action-contracts.js";

export async function createOriginalMcpNativeSyncProducer(context: vscode.ExtensionContext, options: {
  session: unknown; signal: AbortSignal; assertCurrent(): void;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = originalNativeActionSession.parse(options.session);
  let closed = false;
  const current = (signal: AbortSignal) => {
    signer.assertCurrent(); options.assertCurrent();
    if (closed || signal.aborted || options.signal.aborted || signer.signal.aborted
      || signer.activationId !== session.activationId || signer.identity.sha256 !== session.identitySha256
      || signer.identity.profileSha256 !== session.binding.profileSha256
      || signer.payloadBuildId !== session.binding.payloadBuildId || signer.hostEntrySha256 !== session.binding.hostEntrySha256)
      throw new Error("NATIVE_SYNC_SESSION_REVOKED");
  };
  return Object.freeze({
    methods: Object.freeze([originalNativeSyncMethod]),
    async handle(method: string, value: unknown, _requestId: string, signal: AbortSignal) {
      current(signal);
      if (method !== originalNativeSyncMethod) throw new Error("MISSING_NATIVE_METHOD");
      const payload = parseOriginalNativeSyncPayload(value, options.session);
      if (payload.binding.epoch !== signer.activationId || payload.binding.profileSha256 !== signer.identity.profileSha256)
        throw new Error("NATIVE_SYNC_CURRENT_PROFILE_REQUIRED");
      const affirmative = payload.request.operation === "sync.apply" ? "Apply this exact inert Sync plan" : "Review this exact Sync source";
      const answer = await vscode.window.showWarningMessage("Approve current PKM asset Sync source?", {
        modal: true, detail: JSON.stringify({
          ...payload.binding, ...payload.request, requestSha256: payload.requestSha256,
          permission: "Only this exact current source corpus and selected typed identities. Private metadata is included only when explicitly shown. Bytes remain inert: no Script execution, package install, server enablement, Action/Recipe execution, SDK/session history import, credential export or remote publication is granted. Preview approval never grants Apply; each call is separately reviewed.",
        }, null, 2),
      }, "Deny", affirmative);
      current(signal);
      if (answer !== affirmative) return null;
      return { decision: "approve" as const, actorId: "mcp:external" as const, decisionId: randomUUID(),
        requestSha256: payload.requestSha256, epoch: signer.activationId, expiresAtMs: Date.now() + 120000 };
    },
    dispose() { closed = true; },
  });
}
