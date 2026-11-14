import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectLegacyApiChatArchive, type LegacyApiChatArchive } from "./legacy-api-chat-archive.js";
import { legacyManagedApiChatRoots } from "./legacy-api-chat-managed-archive.js";
import { inspectLegacyManagedWriterSession, type LegacyManagedWriterSession } from "./legacy-managed-writer-session.js";
import { inspectLegacyUiBootstrapCompatibility, type LegacyUiBootstrapCompatibility } from "./legacy-ui-bootstrap-compatibility.js";

const privacyTypes = new Set([
  "skills", "notes", "papers", "prompts", "packages", "servers", "scripts", "recipes", "actions", "action-module-sets",
]);
const maximumPrivacyBytes = 2 * 1024 * 1024;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export interface LegacyRootPkmPrivacyState {
  schema: "pkm.legacy-root-pkm-privacy/v1";
  privacySha256: string;
  privacySize: number;
  privacyMode: number;
  hasActionsLease: boolean;
  emptyActionSettingsSha256?: string;
  apiChatArchive?: Pick<LegacyApiChatArchive, "sourceFingerprint" | "files">;
  managedWriterSession?: LegacyManagedWriterSession;
  uiBootstrap?: LegacyUiBootstrapCompatibility;
}

function fail(path: string, message: string): never {
  throw Object.assign(new Error(message), { code: "PKM_STATE_UNSUPPORTED", path });
}

function regularFile(path: string, maxBytes: number): { bytes: Buffer; mode: number; uid: number; specialBits: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    fail(path, "The original .pkm privacy file or Action lease must be a bounded, unlinked regular file.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mode !== before.mode || opened.uid !== before.uid) {
      fail(path, "Original .pkm state changed while opening.");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd), current = lstatSync(path);
    if (bytes.length !== before.size || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mode !== before.mode || after.uid !== before.uid
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mode !== before.mode || current.uid !== before.uid
      || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
      fail(path, "Original .pkm state changed while reading.");
    }
    return { bytes, mode: before.mode & 0o777, uid: before.uid, specialBits: before.mode & 0o7000 };
  } finally { closeSync(fd); }
}

function requireDirectory(path: string, privateDirectory = false): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(path, "Original .pkm state directories must be real directories.");
  if (privateDirectory && process.platform !== "win32") {
    const sharedContainer = path.endsWith(".pkm") || path.endsWith(join(".pkm", "state"));
    const legacyMode = sharedContainer && process.getuid !== undefined && stat.uid === process.getuid()
      && (stat.mode & 0o7000) === 0 && (stat.mode & 0o002) === 0;
    if (process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 && !legacyMode) {
      fail(path, "Original private .pkm state directories must be owned and inaccessible to group/other, except for the two legacy-created container directories.");
    }
  }
}

export function validatePrivacyPolicy(bytes: Buffer): void {
  let state: unknown;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(".pkm/content-privacy.json", "Original content privacy must remain valid UTF-8 JSON."); }
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !("schema" in state) || state.schema !== 1
    || !("private" in state) || !state.private || typeof state.private !== "object" || Array.isArray(state.private)) {
    fail(".pkm/content-privacy.json", "Only the original schema-1 content privacy policy is supported by this slice.");
  }
  if (Object.keys(state).some(key => key !== "schema" && key !== "private")) {
    fail(".pkm/content-privacy.json", "Original content privacy has unsupported schema-1 fields.");
  }
  for (const [type, values] of Object.entries(state.private)) {
    if (!privacyTypes.has(type) || !Array.isArray(values)
      || values.some(value => typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) {
      fail(".pkm/content-privacy.json", "Original content privacy contains an unsupported type or non-array policy.");
    }
  }
}

export function inspectLegacyRootPkmPrivacyState(root: string): LegacyRootPkmPrivacyState | undefined {
  if (resolve(root) !== root || realpathSync(root) !== root) fail(".", "Legacy root must be canonical and contain no symlink aliases.");
  const pkm = join(root, ".pkm");
  let pkmStat;
  try { pkmStat = lstatSync(pkm); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!pkmStat.isDirectory() || pkmStat.isSymbolicLink()) fail(".pkm", "Original .pkm state must be a real directory.");
  requireDirectory(pkm, true);
  const pkmNames = readdirSync(pkm).sort();
  if (!pkmNames.includes("content-privacy.json") || pkmNames.some(name => name !== "content-privacy.json" && name !== "state")) {
    fail(".pkm", "This bounded slice requires the original content-privacy.json and rejects unknown .pkm state.");
  }
  const policy = regularFile(join(pkm, "content-privacy.json"), maximumPrivacyBytes);
  if (process.platform !== "win32" && ((policy.mode & 0o077) !== 0
    || process.getuid && policy.uid !== process.getuid())) {
    fail(".pkm/content-privacy.json", "Original content privacy must remain private and owned by the current user.");
  }
  validatePrivacyPolicy(policy.bytes);

  let hasActionsLease = false;
  let emptyActionSettingsSha256: string | undefined;
  let uiBootstrap: LegacyUiBootstrapCompatibility | undefined;
  let apiChat: LegacyApiChatArchive | undefined;
  let managedWriterSession: LegacyManagedWriterSession | undefined;
  try { apiChat = inspectLegacyApiChatArchive(root); }
  catch (error) {
    const statePath = join(pkm, "state");
    const managedRoot = legacyManagedApiChatRoots.find(name => lstatSync(join(statePath, name), { throwIfNoEntry: false }));
    if (managedRoot && error instanceof Error && "code" in error && error.code === "LEGACY_API_CHAT_BLOCKED")
      fail(`.pkm/state/${managedRoot}`, `Original managed Chat archive requires a valid dedicated adoption receipt: ${error.message}`);
    throw error;
  }
  if (pkmNames.includes("state")) {
    const statePath = join(pkm, "state");
    requireDirectory(statePath, true);
    const stateNames = readdirSync(statePath).sort();
    if (stateNames.includes("managed-writer-session")) {
      managedWriterSession = inspectLegacyManagedWriterSession(root);
    }
    if (stateNames.some(name => ["projects.json", "project-store.json", "project-store-migration"].includes(name))) {
      try { uiBootstrap = inspectLegacyUiBootstrapCompatibility(root); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "LEGACY_UI_RETIRED_STATE_BLOCKED")
          fail(`.pkm/state/${stateNames.find(name => ["projects.json", "project-store.json", "project-store-migration"].includes(name))}`,
            `Original project state requires a valid adoption receipt: ${error.message}`);
        throw error;
      }
    }
    const compatible = new Set(uiBootstrap?.files.filter(file => file.path.startsWith(".pkm/state/"))
      .map(file => file.path.slice(".pkm/state/".length).split("/")[0]));
    if (apiChat?.managed?.authority === "archive_only") {
      for (const name of legacyManagedApiChatRoots) {
        if (apiChat.files.some(file => file.path === `.pkm/state/${name}` && file.kind === "directory"))
          compatible.add(name);
      }
    }
    const unsupported = stateNames.find(name => !["actions", "api-chats", "api-chat-history", "agent-groups"].includes(name)
      && !(name === "managed-writer-session" && managedWriterSession) && !compatible.has(name));
    if (unsupported) {
      fail(`.pkm/state/${unsupported}`, "Original .pkm runtime state requires its dedicated adoption receipt.");
    }
    if (stateNames.includes("actions") && !uiBootstrap) {
      const actionsPath = join(statePath, "actions");
      requireDirectory(actionsPath, true);
      const actionNames = readdirSync(actionsPath).sort();
      if (actionNames.some(name => name !== "mutation-lease" && name !== "settings.json")) {
        fail(".pkm/state/actions", "Non-empty legacy Action state has no verified in-place state receipt and cannot be activated.");
      }
      if (uiBootstrap) hasActionsLease = true;
      if (actionNames.includes("settings.json")) {
        const path = join(actionsPath, "settings.json"), settings = regularFile(path, 1024 * 1024);
        if (process.platform !== "linux" || settings.specialBits !== 0 || (settings.mode & 0o077) !== 0
          || process.getuid === undefined || settings.uid !== process.getuid())
          fail(".pkm/state/actions/settings.json", "Original Action settings must be private, owned and non-special.");
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(settings.bytes)); }
        catch { fail(".pkm/state/actions/settings.json", "Original Action settings must be valid UTF-8 JSON."); }
        if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).sort().join("\0") !== ["toolchains", "workspace_roots"].join("\0")
          || Object.values(value).some(item => !item || typeof item !== "object"
            || Array.isArray(item) || Object.keys(item).length !== 0))
          fail(".pkm/state/actions/settings.json", "Configured Action authority requires its own migration receipt.");
        emptyActionSettingsSha256 = sha256(settings.bytes);
      }
      if (actionNames.includes("mutation-lease")) {
        const lease = regularFile(join(actionsPath, "mutation-lease"), 0);
        if (lease.bytes.length !== 0) fail(".pkm/state/actions/mutation-lease", "The original Action mutation lease must be empty.");
        hasActionsLease = true;
      }
    }
  }
  return {
    schema: "pkm.legacy-root-pkm-privacy/v1",
    privacySha256: sha256(policy.bytes),
    privacySize: policy.bytes.length,
    privacyMode: policy.mode,
    hasActionsLease,
    ...(emptyActionSettingsSha256 ? { emptyActionSettingsSha256 } : {}),
    ...(apiChat ? { apiChatArchive: { sourceFingerprint: apiChat.sourceFingerprint, files: apiChat.files } } : {}),
    ...(managedWriterSession ? { managedWriterSession } : {}),
    ...(uiBootstrap ? { uiBootstrap } : {}),
  };
}
