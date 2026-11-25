import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalNativeSourceRequestDigest, type OriginalNativeSourceSession } from "../../src/original-mcp-native-source-contracts.js";
import { originalSubscriptionReadMethod, originalSubscriptionReadDecision,
  parseOriginalSubscriptionReadPayload } from "../../src/original-mcp-subscription-contracts.js";
import { originalSubscriptionProfileMethod, parseOriginalSubscriptionProfilePayload } from "../../src/original-mcp-subscription-profile-contracts.js";
import { captureCurrentSubscriptionManifest, readCurrentSubscriptionFile, originalCurrentSubscriptionDirectory } from "../../src/original-mcp-subscription-profile-files.js";
import { verifyOriginalCurrentSubscriptionCorpus } from "../../src/original-mcp-subscription-current-corpus.js";

/** Source-only five-minute consent binds the entire current native member/provider/key/corpus snapshot, not account identity. */
export async function createOriginalMcpNativeSubscriptionProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeSourceSession; signal: AbortSignal; assertCurrent(): void; close(): Promise<void>;
}) {
  const signer = await originalMcpNativeSigner(context), seen = new Set<string>();
  const profileGrants = new Map<string, { decisionId: string; sourceSha256: string; actorId: "mcp:external"; expiresAtMs: number }>();
  let disposed = false, busy = false;
  const current = (signal?: AbortSignal) => {
    options.assertCurrent(); signer.assertCurrent();
    if (disposed || options.signal.aborted || signer.signal.aborted || signal?.aborted || !vscode.workspace.isTrusted
      || options.session.activationId !== signer.activationId || options.session.epoch !== signer.activationId
      || options.session.identitySha256 !== signer.identity.sha256
      || options.session.binding.profileSha256 !== signer.identity.profileSha256
      || options.session.binding.payloadBuildId !== signer.payloadBuildId
      || options.session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      throw Object.assign(new Error("NATIVE_SUBSCRIPTION_DENIED"), { code: "NATIVE_SUBSCRIPTION_DENIED" });
  };
  const revoke = () => { disposed = true; void options.close().catch(() => {}); };
  const workspace = vscode.workspace.onDidChangeWorkspaceFolders(revoke);
  const command = vscode.commands.registerCommand(`personalKnowledge.revokeNativeSubscriptions.${options.session.activationId}`, revoke);
  const dispose = () => { disposed = true; workspace.dispose(); command.dispose(); };
  options.signal.addEventListener("abort", dispose, { once: true });
  context.subscriptions.push({ dispose });
  return Object.freeze({
    methods: [originalSubscriptionReadMethod, originalSubscriptionProfileMethod] as const, dispose,
    async handleProfile(value: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      if (busy || seen.has(requestId) || seen.size >= 4096) throw new Error("NATIVE_SUBSCRIPTION_REQUEST_REPLAY");
      const payload = parseOriginalSubscriptionProfilePayload(structuredClone(value), options.session);
      seen.add(requestId); busy = true;
      try {
        const capture = () => captureCurrentSubscriptionManifest({
          profile: context.globalStorageUri.fsPath, root: options.session.binding.root,
          workspaceId: options.session.binding.workspaceId, profileSha256: options.session.binding.profileSha256,
          identitySha256: options.session.identitySha256, nativeEpoch: options.session.activationId,
          nativePublicKey: signer.identity.publicKey,
        });
        const manifest = capture();
        if (payload.expectedHead && manifest.head !== payload.expectedHead) throw new Error("NATIVE_SUBSCRIPTION_SOURCE_CHANGED");
        let decision = profileGrants.get(manifest.head);
        if (!decision || decision.expiresAtMs <= Date.now()) {
          if (payload.expectedHead) throw new Error("NATIVE_SUBSCRIPTION_SOURCE_EXPIRED");
          const label = "Enroll only this current native profile source";
          const answer = await vscode.window.showWarningMessage("Enroll this exact current native Subscription profile?", {
            modal: true, detail: JSON.stringify({ manifest,
              permission: "Only this fixed v5 profile's current public subscriber state and pinned cache are enrolled under this original Root and native epoch. No legacy profile/history, private-key import, account grant, or arbitrary file read." }, null, 2),
          }, label, "Deny");
          current(signal);
          if (answer !== label || capture().head !== manifest.head) throw new Error("NATIVE_SUBSCRIPTION_SOURCE_DENIED");
          decision = { actorId: "mcp:external", decisionId: randomUUID(), sourceSha256: manifest.head, expiresAtMs: Date.now() + 300000 };
          if (profileGrants.size >= 128) profileGrants.clear();
          profileGrants.set(manifest.head, decision);
        }
        const protectedMaterial = new Map<string, string>();
        try {
          for (const member of manifest.state.subscriptions) {
            const githubTarget = member.source?.credentialTargetId || member.source?.targetId;
            const secretId = member.secretProtected ? `personalKnowledge.subscription.${member.nodeId}.${member.shareId}.secret`
              : githubTarget ? `personalKnowledge.githubSync.vscode.${githubTarget}` : undefined;
            if (secretId) {
              const value = await context.secrets.get(secretId);
              if (!value) throw new Error("NATIVE_SUBSCRIPTION_KEY_UNAVAILABLE");
              if (member.secretProtected) protectedMaterial.set(member.id, value);
            }
          }
          verifyOriginalCurrentSubscriptionCorpus(manifest, manifest.files.map(pin => {
            const bytes = readCurrentSubscriptionFile(manifest.profile, `${originalCurrentSubscriptionDirectory}/${pin.path}`, pin.size);
            if (!bytes) throw new Error("NATIVE_SUBSCRIPTION_CORPUS_INVALID");
            return { ...pin, bytes };
          }), protectedMaterial);
        } finally { protectedMaterial.clear(); }
        current(signal);
        if (capture().head !== manifest.head || decision.expiresAtMs <= Date.now()) throw new Error("NATIVE_SUBSCRIPTION_SOURCE_CHANGED");
        return { manifest, decision };
      } finally { busy = false; }
    },
    async handle(value: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      if (busy || seen.has(requestId) || seen.size >= 4096) throw new Error("NATIVE_SUBSCRIPTION_REQUEST_REPLAY");
      const payload = parseOriginalSubscriptionReadPayload(structuredClone(value), options.session);
      seen.add(requestId); busy = true;
      try {
        const label = "Read this exact current subscription source";
        const answer = await vscode.window.showWarningMessage("Allow this bounded current Subscription read?", {
          modal: true, detail: JSON.stringify({ tool: payload.tool, arguments: payload.arguments, source: payload.source,
            root: payload.binding.root, epoch: payload.binding.epoch,
            permission: "Read only this current membership/provider/key/revision/corpus snapshot. No signing, account credentials, historical profile/cache access, or future corpus approval. Revocation closes the signed native attachment." }, null, 2),
        }, label, "Deny");
        current(signal);
        if (answer !== label) return null;
        return originalSubscriptionReadDecision.parse({ actorId: "mcp:external", decisionId: randomUUID(),
          sourceSha256: originalNativeSourceRequestDigest(payload.source), argumentsSha256: payload.argumentsSha256,
          expiresAtMs: Date.now() + 300000 });
      } finally { busy = false; }
    },
  });
}
