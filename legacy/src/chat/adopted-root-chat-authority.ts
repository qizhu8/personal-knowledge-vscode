import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getStorePath } from "../knowledge/filestore";

type Chat = Readonly<{ namespace: string; chatId: string }>;
type ProfileBinding = Readonly<{
  root: string; workspaceId: string; actorId: string; profileId: string; sessionId?: string; chats?: readonly Chat[];
}>;
type Candidate = Readonly<Chat & { title: string }>;
type HostBinding = Readonly<{ root: string; workspaceId: string; sessionId: string; configurationFingerprint: string }>;
export interface AdoptedRootChatAuthority {
  readonly root: string; readonly workspaceId: string; readonly actorId: "local:owner";
  readonly profileId: string; readonly chats: readonly Chat[]; readonly signal: AbortSignal;
  assertCurrent(binding: ProfileBinding): void;
  dispose(): void;
}
const issuedAuthorities = new WeakMap<AdoptedRootChatAuthority, {
  hostBinding: HostBinding; hostSignal: AbortSignal; assertHostCurrent(binding: HostBinding): void;
}>();

/** Object identity, not an identifier or serialized record, ties this grant to its issuer. */
export function assertAdoptedChatAuthorityHost(authority: AdoptedRootChatAuthority, expected: {
  root: string; workspaceId: string; sessionId: string; configurationFingerprint: string;
  hostSignal: AbortSignal; assertHostCurrent(binding: HostBinding): void;
}): void {
  const issued = authority && issuedAuthorities.get(authority);
  if (!issued || issued.hostSignal !== expected.hostSignal || issued.assertHostCurrent !== expected.assertHostCurrent
    || issued.hostBinding.root !== expected.root || issued.hostBinding.workspaceId !== expected.workspaceId
    || issued.hostBinding.sessionId !== expected.sessionId
    || issued.hostBinding.configurationFingerprint !== expected.configurationFingerprint)
    throw new Error("Chat authority was not issued for this live host session.");
  authority.assertCurrent({ root: expected.root, workspaceId: expected.workspaceId, sessionId: expected.sessionId,
    actorId: "local:owner", profileId: authority.profileId, chats: authority.chats });
}

/** Explicit user approval for a single Chat, within one already-authorized host session. */
export async function requestAdoptedRootChatAuthority(context: vscode.ExtensionContext, options: {
  root: string;
  workspaceId: string;
  sessionId: string;
  configurationFingerprint: string;
  candidates: readonly Candidate[];
  hostSignal: AbortSignal;
  assertHostCurrent(binding: HostBinding): void;
}): Promise<AdoptedRootChatAuthority | undefined> {
  if (!options || typeof options.root !== "string" || !path.isAbsolute(options.root)
    || path.resolve(options.root) !== options.root || !/^[a-f0-9-]{36}$/.test(options.workspaceId)
    || !/^[a-f0-9-]{36}$/.test(options.sessionId) || !/^[a-f0-9]{64}$/.test(options.configurationFingerprint)
    || !options.hostSignal || typeof options.assertHostCurrent !== "function"
    || !Array.isArray(options.candidates) || !options.candidates.length || options.candidates.length > 10_000)
    throw new Error("Chat approval requires an authenticated host and explicit Chat candidates.");
  const root = options.root, workspaceId = options.workspaceId, profilePath = context.globalStorageUri.fsPath;
  const hostSignal = options.hostSignal, assertHostCurrent = options.assertHostCurrent;
  const hostBinding: HostBinding = Object.freeze({ root, workspaceId, sessionId: options.sessionId,
    configurationFingerprint: options.configurationFingerprint });
  if (!path.isAbsolute(profilePath) || path.resolve(profilePath) !== profilePath
    || profilePath === root || profilePath.startsWith(root + path.sep))
    throw new Error("Chat approval requires a separate canonical profile.");
  const identity = (directory: string) => {
    const info = fs.lstatSync(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory)
      throw new Error("Chat approval root or profile is unavailable.");
    return info;
  };
  const rootIdentity = identity(root), profileIdentity = identity(profilePath);
  const candidates = options.candidates.map(item => {
    if (!item || !/^[a-f0-9]{16}$/.test(item.namespace) || !/^[a-f0-9-]{36}$/.test(item.chatId)
      || typeof item.title !== "string" || item.title.length > 4096)
      throw new Error("Chat approval candidates are invalid.");
    return Object.freeze({ namespace: item.namespace, chatId: item.chatId, title: item.title });
  });
  if (new Set(candidates.map(chat => `${chat.namespace}:${chat.chatId}`)).size !== candidates.length)
    throw new Error("Chat approval candidates are ambiguous.");
  const controller = new AbortController(), profileId = randomUUID();
  let watch: ReturnType<typeof setInterval> | undefined;
  const revoke = () => {
    if (watch) { clearInterval(watch); watch = undefined; }
    controller.abort();
  };
  const subscriptions: vscode.Disposable[] = [];
  const dispose = () => {
    revoke();
    hostSignal.removeEventListener("abort", revoke);
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
  };
  const check = () => {
    if (controller.signal.aborted || hostSignal.aborted || !vscode.workspace.isTrusted
      || getStorePath() !== root || context.globalStorageUri.fsPath !== profilePath)
      throw new Error("Chat approval host or profile is unavailable.");
    const before = identity(root), profile = identity(profilePath);
    if (before.dev !== rootIdentity.dev || before.ino !== rootIdentity.ino
      || profile.dev !== profileIdentity.dev || profile.ino !== profileIdentity.ino)
      throw new Error("Chat approval root or profile identity changed.");
    const result = (assertHostCurrent as (binding: HostBinding) => unknown)(hostBinding);
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function")
        void Promise.resolve(result).catch(() => {});
      throw new Error("Chat host fence must synchronously return undefined.");
    }
    if (controller.signal.aborted || hostSignal.aborted || !vscode.workspace.isTrusted
      || getStorePath() !== root || context.globalStorageUri.fsPath !== profilePath)
      throw new Error("Chat approval host or profile is unavailable.");
    const after = identity(root), profileAfter = identity(profilePath);
    if (after.dev !== rootIdentity.dev || after.ino !== rootIdentity.ino
      || profileAfter.dev !== profileIdentity.dev || profileAfter.ino !== profileIdentity.ino)
      throw new Error("Chat approval root or profile identity changed.");
  };
  try {
    hostSignal.addEventListener("abort", revoke, { once: true });
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(revoke));
    subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("personalKnowledge")) revoke(); }));
    subscriptions.push(context.secrets.onDidChange(revoke));
    check();
    watch = setInterval(() => { try { check(); } catch { revoke(); } }, 250);
    watch.unref();
    const items = candidates.map(chat => Object.freeze({ label: chat.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160) || "Untitled Chat",
      description: `${chat.namespace}/${chat.chatId}`, chat }));
    const selected = await vscode.window.showQuickPick(items, {
      title: "Choose one original Chat for this owner session", ignoreFocusOut: true,
    });
    check();
    if (!selected) { dispose(); return undefined; }
    if (!items.includes(selected)) throw new Error("Chat selection is not from this host.");
    const chat = selected.chat;
    const answer = await vscode.window.showWarningMessage("Allow this owner to access the selected original Chat?",
      { modal: true, detail: `Knowledge Root: ${root}\nProfile: ${profilePath}\nChat: ${selected.label}\nChat ID: ${chat.namespace}/${chat.chatId}\n`
        + `Owner session: ${hostBinding.sessionId}\nConfiguration SHA-256: ${hostBinding.configurationFingerprint}\n`
        + "This approval is limited to this session and Chat. It does not authorize root migration. Model and process permissions remain separate." },
      "Allow Selected Chat");
    check();
    if (answer !== "Allow Selected Chat") { dispose(); return undefined; }
    const chats: readonly Chat[] = Object.freeze([Object.freeze({ namespace: chat.namespace, chatId: chat.chatId })]);
    const authority = Object.freeze({
      root, workspaceId, actorId: "local:owner" as const, profileId, chats, signal: controller.signal,
      assertCurrent(binding: ProfileBinding) {
        check();
        if (!binding || binding.root !== root || binding.workspaceId !== workspaceId
          || binding.actorId !== "local:owner" || binding.profileId !== profileId
          || "sessionId" in binding && binding.sessionId !== hostBinding.sessionId
          || "chats" in binding && (!Array.isArray(binding.chats) || binding.chats.length !== 1
            || binding.chats[0]?.namespace !== chat.namespace || binding.chats[0]?.chatId !== chat.chatId))
          throw new Error("Chat profile authority does not match the approved selection.");
        check();
      },
      dispose,
    });
    context.subscriptions.push(authority);
    issuedAuthorities.set(authority, { hostBinding, hostSignal, assertHostCurrent });
    return authority;
  } catch (error) {
    dispose();
    throw error;
  }
}
