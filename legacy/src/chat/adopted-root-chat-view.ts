import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { getStorePath } from "../knowledge/filestore";
import { createSelectedOwnerChatViewBackend } from "./selected-owner-chat-ui";
import type { OwnedChatViewBackend } from "./api-chat-shell";

type Binding = Readonly<{
  root: string; workspaceId: string; actorId: "local:owner"; profileId: string; sessionId: string;
}>;
type SessionBinding = Binding & Readonly<{ endpoint: string; bearer: string; sourceFingerprint: string }>;

/** Capabilities supplied by a trusted embedding, not by an IPC request or a stored marker. */
export interface AdoptedRootChatViewAuthority {
  root: string;
  workspaceId: string;
  profileId: string;
  sessionId: string;
  sourceFingerprint: string;
  endpoint: string;
  bearer: string;
  session: { signal: AbortSignal; assertCurrent(binding: SessionBinding): void; revokeChat(): Promise<void> };
  profile: { signal: AbortSignal; assertCurrent(binding: Binding): void };
}

function fence(callback: () => void): void {
  const result = (callback as () => unknown)();
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function")
      void Promise.resolve(result).catch(() => {});
    throw new Error("Chat authority fence must synchronously return undefined.");
  }
}

/** Integrates a previously authorized same-root Chat owner with the ordinary shell. */
export async function createAdoptedRootChatViewBackend(context: vscode.ExtensionContext,
  authority: AdoptedRootChatViewAuthority, loadSignal: AbortSignal): Promise<OwnedChatViewBackend> {
  if (!authority || !path.isAbsolute(authority.root) || path.resolve(authority.root) !== authority.root
    || !/^[a-f0-9-]{36}$/.test(authority.workspaceId) || !/^[a-f0-9-]{36}$/.test(authority.sessionId)
    || typeof authority.profileId !== "string" || !authority.profileId || authority.profileId.length > 512
    || !authority.session?.signal || typeof authority.session.assertCurrent !== "function"
    || typeof authority.session.revokeChat !== "function" || !authority.profile?.signal
    || typeof authority.profile.assertCurrent !== "function" || !loadSignal)
    throw new Error("Adopted Chat view authority is unavailable.");
  const root = authority.root;
  const before = fs.lstatSync(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(root) !== root)
    throw new Error("Adopted Chat root is unavailable.");
  const binding: Binding = Object.freeze({ root, workspaceId: authority.workspaceId, actorId: "local:owner",
    profileId: authority.profileId, sessionId: authority.sessionId });
  const sessionBinding: SessionBinding = Object.freeze({ ...binding, endpoint: authority.endpoint,
    bearer: authority.bearer, sourceFingerprint: authority.sourceFingerprint });
  const session = authority.session, profile = authority.profile;
  const connection = AbortSignal.any([session.signal, profile.signal, loadSignal]);
  let fenced = false, draining: Promise<void> | undefined;
  const checkRoot = () => {
    if (fenced || connection.aborted || getStorePath() !== root || fs.realpathSync(root) !== root)
      throw new Error("Adopted Chat view authority is unavailable.");
    const current = fs.lstatSync(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino)
      throw new Error("Adopted Chat root identity changed.");
  };
  const check = () => {
    checkRoot();
    fence(() => session.assertCurrent(sessionBinding));
    fence(() => profile.assertCurrent(binding));
    checkRoot();
  };
  const drain = () => {
    fenced = true;
    if (!draining) draining = Promise.resolve().then(async () => {
      const result: unknown = await session.revokeChat();
      if (result !== undefined) throw new Error("Adopted Chat drain outcome is unknown.");
    }).catch(error => {
      draining = undefined;
      throw error;
    });
    return draining;
  };
  check();
  return createSelectedOwnerChatViewBackend(context, {
    binding: { nonce: binding.sessionId, root, workspaceId: binding.workspaceId, actorId: binding.actorId,
      sourceFingerprint: sessionBinding.sourceFingerprint, endpoint: sessionBinding.endpoint, bearer: sessionBinding.bearer },
    connection, assertCurrent: check, drain,
  });
}
