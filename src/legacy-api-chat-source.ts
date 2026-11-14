import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Storage } from "./storage.js";
import { inspectLegacyApiChatArchive } from "./legacy-api-chat-archive.js";

/** Separate read-only Chat source bound by an owning host, never an adoption or evidence grant. */
export type LegacyChatSource = { root: string; assertCurrent(): void };

export function readLegacyChatSource(storage: Storage, source?: LegacyChatSource) {
  storage.assertWorkspaceLease();
  source?.assertCurrent();
  const root = source?.root ?? storage.workspaceRoot();
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error("Chat source root is not canonical.");
  const archive = inspectLegacyApiChatArchive(root);
  source?.assertCurrent();
  storage.assertWorkspaceLease();
  return archive;
}
