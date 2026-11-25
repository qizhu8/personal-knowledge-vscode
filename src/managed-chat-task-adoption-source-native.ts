import { createHash } from "node:crypto";
import type { Storage } from "./storage.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalMcpApiChatSource, readOriginalMcpApiChatSourceSession } from "./original-mcp-api-chat-source.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { originalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-contracts.js";
import { managedTaskAuthorityFailure } from "./managed-chat-task-admission.js";
import { originalManagedTaskAdoptionDependencies, originalManagedTaskAdoptionSourceRows,
  projectOriginalManagedTaskAdoption } from "./managed-chat-task-adoption-source.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Source data only. Possessing or copying this projection never grants Core adoption or execution. */
export async function readOriginalManagedTaskAdoptionSource(storage: Storage, host: OriginalMcpNativeHost, chatId: string) {
  const source = originalMcpApiChatSource(storage, host), grant = readOriginalMcpApiChatSourceSession(storage, host);
  const journal = readOriginalMcpJournal(storage.workspaceRoot());
  if (!journal) managedTaskAuthorityFailure("Original custody required.");
  const db = storage.connectNative(), selected = (() => {
    try { return originalManagedTaskAdoptionSourceRows(db, chatId); } finally { db.close(); }
  })();
  const reader = await openOriginalMcpCustodyReader(journal.plan), contents = new Map<string, Buffer>();
  try {
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await reader.read(String(selected.chat.metadata_path), 1048576)));
    for (const path of originalManagedTaskAdoptionDependencies(selected.chat, selected.messages, metadata))
      contents.set(path, await reader.read(path, 1048576));
    const libraryPath = ".pkm/state/api-chats/library.json";
    if (reader.entry(libraryPath)) contents.set(libraryPath, await reader.read(libraryPath, 1048576));
    const value = projectOriginalManagedTaskAdoption(selected.chat, selected.messages,
      path => contents.get(path) ?? managedTaskAuthorityFailure("Missing original dependency."));
    const projection = originalManagedTaskAdoptionSource.parse({
      schema: "pkm.chat.original-task-adoption-source/v1", chatId, namespace: selected.chat.namespace,
      taskId: value.metadata.sessionId, chatTitle: value.metadata.title, taskTitle: value.session.task,
      sessionStatus: value.session.status, metadataSha256: selected.chat.metadata_sha256,
      sessionSha256: sha(contents.get(value.sessionPath)!), historySha256: originalNativeChatDigest(value.hashes),
      goal: value.metadata.workGoal, sourceInputIds: value.inputIds, messages: value.messages, messageHashes: value.hashes,
      pins: [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })).sort((a, b) => a.path.localeCompare(b.path)),
    });
    const now = readOriginalMcpApiChatSourceSession(storage, host);
    if (now.decisionId !== grant.decisionId || now.revocation !== grant.revocation
      || originalMcpApiChatSource(storage, host).planSha256 !== source.planSha256)
      managedTaskAuthorityFailure("Source authority changed during bounded projection.");
    return projection;
  } finally { reader.close(); }
}
