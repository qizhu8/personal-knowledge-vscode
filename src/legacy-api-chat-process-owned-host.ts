import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { readLegacyChatSource, type LegacyChatSource } from "./legacy-api-chat-source.js";
import { LegacyApiChatProcesses, type LegacyChatOriginalEvidenceSource, type LegacyChatProcessScope } from "./legacy-api-chat-process.js";
import { createLegacyChatProcessApprovalBridge, type LegacyChatProcessPolicy } from "./legacy-api-chat-process-approval.js";
import { LegacyChatProcessApprovalUi } from "./legacy-api-chat-process-approval-ui.js";
import { startLegacyApiChatUiHost } from "./legacy-api-chat-ui-host.js";

export class OwnedChatStartupCleanupError extends Error {
  constructor(readonly startupError: unknown, readonly cleanupError: unknown) {
    super("Selected Chat startup failed and its child cleanup is unconfirmed; keep the Storage owner fenced.");
  }
}

/** Explicit composition by a Storage-owning host; it does not authorize or perform root adoption. */
export async function createOwnedLegacyChatProcessHost(options: {
  storage: Storage; actorId: string; database: DatabaseSync; captureDirectory: string;
  chatSource?: LegacyChatSource;
  originalEvidence?: LegacyChatOriginalEvidenceSource;
  commands: ConstructorParameters<typeof LegacyApiChatProcesses>[0]["commands"];
  previousOwnerId?: string;
  assertCurrent(): void;
  policy(binding: LegacyChatProcessScope): Promise<LegacyChatProcessPolicy>;
  remember(binding: LegacyChatProcessScope, scope: string, choice: "approve" | "allow-all"): Promise<void>;
}) {
  const workspaceRoot = options.storage.workspaceRoot(), workspaceId = await options.storage.workspaceId();
  const archive = readLegacyChatSource(options.storage, options.chatSource);
  if (!archive || !options.actorId) throw new Error("Owned Chat requires an exact original Chat archive and actor.");
  const root = archive.root, sourceFingerprint = archive.sourceFingerprint;
  const assertCurrent = () => {
    options.assertCurrent();
    options.storage.assertWorkspaceLease();
    if (options.storage.workspaceRoot() !== workspaceRoot
      || readLegacyChatSource(options.storage, options.chatSource)?.sourceFingerprint !== sourceFingerprint)
      throw new Error("Owned Chat source or workspace changed.");
  };
  const assertOwner = (binding: LegacyChatProcessScope) => {
    assertCurrent();
    if (binding.root !== root || binding.workspaceId !== workspaceId || binding.actorId !== options.actorId
      || binding.sourceFingerprint !== sourceFingerprint)
      throw new Error("Chat process owner binding changed.");
  };
  assertCurrent();
  const ui = new LegacyChatProcessApprovalUi({ assertOwner, policy: options.policy, remember: options.remember });
  const authorize = createLegacyChatProcessApprovalBridge({
    assertOwner, policy: options.policy, requestPermission: ui.requestPermission, confirmLocalStop: ui.confirmLocalStop,
  });
  try {
    const processes = new LegacyApiChatProcesses({
      database: options.database, captureDirectory: options.captureDirectory, root, workspaceId, actorId: options.actorId,
      sourceFingerprint, commands: options.commands, previousOwnerId: options.previousOwnerId, assertOwner: assertCurrent, authorize,
      originalEvidence: options.originalEvidence,
      readOriginalEvidence: root === workspaceRoot,
    });
    return { processes, processApprovalUi: ui };
  } catch (error) { ui.close(); throw error; }
}

/**
 * Explicit live-Storage composition only. The caller must fence the selected
 * owner and supply Chat/profile admission; this does not adopt a root.
 */
export async function startOwnedLegacyChatProcessUiHost(options: {
  owner: Parameters<typeof createOwnedLegacyChatProcessHost>[0];
  chat: Pick<Parameters<typeof startLegacyApiChatUiHost>[0], "chats" | "authorize" | "provider" | "managed">;
}) {
  if (!options.chat.managed) throw new Error("Owned process UI requires a managed Chat host.");
  const check = () => {
    options.owner.assertCurrent();
    options.owner.storage.assertWorkspaceLease();
  };
  check();
  const owned = await createOwnedLegacyChatProcessHost(options.owner);
  let host: Awaited<ReturnType<typeof startLegacyApiChatUiHost>> | undefined;
  try {
    check();
    const managed = options.chat.managed;
    host = await startLegacyApiChatUiHost({
      ...options.chat, storage: options.owner.storage, actorId: options.owner.actorId, chatSource: options.owner.chatSource,
      authorize: async binding => {
        check(); const allowed = await options.chat.authorize(binding); check(); return allowed;
      },
      managed: { ...managed, authorize: async binding => {
        check(); const allowed = await managed.authorize(binding); check(); return allowed;
      }, ...(managed.authorizeQueue ? { authorizeQueue: async binding => {
        check(); const allowed = await managed.authorizeQueue!(binding); check(); return allowed;
      } } : {}) },
      ...owned,
    });
    check();
    return { ...host, ...owned };
  } catch (error) {
    try {
      if (host) await host.close();
      else { owned.processApprovalUi.close(); await owned.processes.close(); }
    } catch (cleanupError) {
      throw new OwnedChatStartupCleanupError(error, cleanupError);
    }
    throw error;
  }
}
