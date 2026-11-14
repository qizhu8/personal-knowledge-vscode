import { createLegacyChatPrivateSnapshot, reopenLegacyChatPrivateSnapshot } from "./legacy-api-chat-private-snapshot.js";
import { startSelectedOwnerChatProcessHost } from "./legacy-api-chat-selected-owner.js";
import { createSelectedChatProfilePolicy } from "./selected-chat-profile-policy.js";
import type { ManagedClientHost } from "./managed-client-host.js";
import type { SelectedWorkspaceOwner } from "./standalone-host.js";

type PolicyOptions = Parameters<typeof createSelectedChatProfilePolicy>[0];
type HostOptions = Parameters<typeof startSelectedOwnerChatProcessHost>[0];
type SelectedOwner = HostOptions["selected"];
type SnapshotOptions = {
  connection: AbortSignal;
  sourceRoot: string;
  privateParent: string;
  recovery?: { root: string; sourceFingerprint: string };
  profile: Omit<PolicyOptions["profile"], "sourceRoot">;
  commands: PolicyOptions["commands"];
  owner: Omit<HostOptions["owner"], "chatSource" | "commands" | "policy" | "remember">;
  chat: HostOptions["chat"];
  onCloseError(error: unknown): void;
};

/**
 * Compose an explicitly selected managed owner with a privately copied Chat
 * archive. The embedding owns the live profile, model, approval and command
 * authority; copying does not establish a legacy writer fence or cutover.
 */
export async function startSelectedOwnerSnapshotChat(options: SnapshotOptions & { selected: SelectedOwner }) {
  if (!options.selected || options.connection.aborted || !options.profile?.id
    || options.profile.workspaceId !== options.selected.workspaceId || options.profile.actorId !== options.selected.actorId
    || typeof options.profile.assertCurrent !== "function" || typeof options.profile.policy !== "function"
    || typeof options.profile.remember !== "function")
    throw new Error("Live managed Chat selection is unavailable.");
  const { selected } = options;
  selected.assertCurrent();
  const initialCheck = options.profile.assertCurrent() as unknown;
  if (initialCheck !== undefined) {
    if (initialCheck && (typeof initialCheck === "object" || typeof initialCheck === "function")
      && typeof (initialCheck as { then?: unknown }).then === "function")
      void Promise.resolve(initialCheck).catch(() => {});
    throw new Error("Chat profile fence must be synchronous.");
  }
  selected.assertCurrent();
  if (options.connection.aborted || options.profile.workspaceId !== selected.workspaceId
    || options.profile.actorId !== selected.actorId)
    throw new Error("Chat profile identity changed before copying.");
  const snapshot = options.recovery
    ? reopenLegacyChatPrivateSnapshot(options.sourceRoot, options.recovery.root, options.recovery.sourceFingerprint)
    : createLegacyChatPrivateSnapshot(options.sourceRoot, options.privateParent);
  const policy = createSelectedChatProfilePolicy({
    selected, connection: options.connection, archive: snapshot, commands: options.commands,
    profile: {
      get id() { return options.profile.id; },
      get workspaceId() { return options.profile.workspaceId; },
      get actorId() { return options.profile.actorId; },
      sourceRoot: snapshot.root,
      assertCurrent: () => options.profile.assertCurrent(),
      policy: binding => options.profile.policy(binding),
      remember: (binding, scope, choice, assertCommitCurrent) => options.profile.remember(binding, scope, choice, assertCommitCurrent),
    },
  });
  const host = await startSelectedOwnerChatProcessHost({
    selected, connection: options.connection, assertProfile: policy.assertProfile, chat: options.chat,
    owner: { ...options.owner, chatSource: policy.chatSource, commands: policy.commands,
      policy: policy.policy, remember: policy.remember },
    onCloseError: options.onCloseError,
  });
  return { ...host, snapshotRoot: snapshot.root, get disconnectTask() { return host.disconnectTask; } };
}

export async function startManagedClientSnapshotChat(options: SnapshotOptions & {
  managed: ManagedClientHost;
  selection: SelectedWorkspaceOwner;
}) {
  if (!options.managed.selectedOwnerContext) throw new Error("Live managed Chat selection is unavailable.");
  if (!options.profile?.id || options.profile.workspaceId !== options.selection?.workspaceId
    || options.profile.actorId !== options.selection.actorId)
    throw new Error("Live managed Chat selection is unavailable.");
  return startSelectedOwnerSnapshotChat({ ...options, selected: options.managed.selectedOwnerContext(options.selection) });
}
