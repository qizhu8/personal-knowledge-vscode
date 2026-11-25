import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { imageSize } from "image-size";
import { validateLegacyApiChatLibrary, type LegacyApiChatLibrary } from "./legacy-api-chat-library.js";
import { inspectLegacyManagedApiChatArchive, legacyManagedApiChatRoots,
  type LegacyManagedApiChatArchive } from "./legacy-api-chat-managed-archive.js";
import { legacyPathHasNoSymlinks, legacyPrivateRootGuard, sameLegacyPrivateRoot } from "./legacy-effective-private-root.js";

type Json = Record<string, any>;
export interface LegacyApiChatEntity {
  path: string; kind: "file" | "directory"; sha256?: string; size: number; mode: number;
  device: string; inode: string; mtimeNs: string; ctimeNs: string;
}
export interface LegacyApiChatArchive {
  schema: "pkm.legacy-api-chat-archive/v1"; root: string; sourceFingerprint: string;
  paths: string[]; files: LegacyApiChatEntity[];
  chats: Array<{ namespace: string; id: string; metadata: Json; messages: Json[] }>;
  retainedBlobs: string[];
  library?: LegacyApiChatLibrary;
  managed?: LegacyManagedApiChatArchive;
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const roots = ["api-chats", "api-chat-history", "agent-groups", ...legacyManagedApiChatRoots];
const chatFields = new Set(`version revision workspaceNamespace id title customTitle paused activityBudgetBypass activityCreditLimit permissionMode permissionGrants permissionContextId lastResultId readResultId createdAt updatedAt messages queuedInputs debugRequest workGoal workGoalHistory taskContextCheckpoints memoryTasks context images includeHistory memoryPolicy modelProvider vscodeModelId vscodeModelLabel modelProfileId contextWindow maxOutputTokens progress agentContext builtinTools vscodeTools toolSelection mcpServers messageHistory workflowMode plans agentProfileId sessionId workerState workerActivity portalCommands portalTransfers`.split(" "));
const legacySharedContainers = new Set([".pkm", ".pkm/state"]);

function safeLegacyContainerMode(path: string, mode: number, uid: number): boolean {
  return legacySharedContainers.has(path) && process.getuid !== undefined && uid === process.getuid()
    && (mode & 0o7000) === 0 && (mode & 0o002) === 0;
}

export function legacyApiChatBlocked(message: string): never {
  throw Object.assign(new Error(`LEGACY_API_CHAT_BLOCKED: ${message}`), { code: "LEGACY_API_CHAT_BLOCKED" });
}
function fail(message: string): never { return legacyApiChatBlocked(message); }
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a JSON record.");
  return value as Json;
}
function parse(bytes: Buffer): Json {
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { fail("Malformed UTF-8 JSON in the original API Chat archive."); }
}
export function validateLegacyApiChatImages(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) fail("Invalid or excessive inline images.");
  for (const raw of value) {
    const image = object(raw);
    if (Object.keys(image).some(key => !["label", "mimeType", "dataBase64"].includes(key))
      || typeof image.label !== "string" || !image.label || image.label.length > 120 || /[\u0000-\u001f\u007f]/.test(image.label)
      || !["image/png", "image/jpeg"].includes(image.mimeType)
      || typeof image.dataBase64 !== "string" || image.dataBase64.length > 700_000
      || !image.dataBase64 || Buffer.from(image.dataBase64, "base64").toString("base64") !== image.dataBase64) {
      fail("Invalid bounded inline image bytes or metadata.");
    }
    const bytes = Buffer.from(image.dataBase64, "base64");
    if (bytes.length > 512 * 1024) fail("Inline image exceeds the original 512 KiB limit.");
    let dimensions: ReturnType<typeof imageSize>;
    try { dimensions = imageSize(bytes); }
    catch { fail("Invalid image data."); }
    if ((dimensions.type === "png" ? "image/png" : dimensions.type === "jpg" ? "image/jpeg" : "") !== image.mimeType
      || !dimensions.width || !dimensions.height || dimensions.width > 4096 || dimensions.height > 4096
      || dimensions.width * dimensions.height > 16_000_000)
      fail("Choose a PNG/JPEG image no larger than 4096 pixels per side and 16 megapixels.");
  }
}
function messages(value: unknown, managed = false): Json[] {
  if (!Array.isArray(value) || value.length > 10_000) fail("Invalid bounded API Chat transcript.");
  const ids = new Set<string>();
  return value.map(raw => {
    const message = object(raw);
    if (typeof message.id !== "string" || !message.id || message.id.length > 200 || ids.has(message.id)
      || !["user", "assistant"].includes(message.role) || typeof message.content !== "string"
      || !["complete", "cancelled", "failed", "interrupted", ...(managed ? ["running", "streaming"] : [])].includes(message.status)
      || !managed && message.progress?.status === "running"
      || message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.toolCalls.some((call: Json) => !call || !managed && call.status === "running"))
      || message.delegations !== undefined && (!Array.isArray(message.delegations) || message.delegations.some((item: Json) => !item || !managed && item.status === "running")))
      fail("Invalid, duplicate or active historical message.");
    ids.add(message.id);
    validateLegacyApiChatImages(message.images);
    return message;
  });
}
/** Pure per-record validation; the large source protocol supplies its own explicit streaming envelope. */
export function validateLegacyApiChatMessage(value: unknown): Json {
  return messages([value], true)[0]!;
}
export function validateLegacyApiChatMetadata(value: unknown, namespace: string, id: string): Json {
  const metadata = object(value);
  if (!/^[a-f0-9]{16}$/.test(namespace) || !uuid.test(id) || Object.keys(metadata).some(key => !chatFields.has(key))
    || metadata.id !== id || metadata.workspaceNamespace !== namespace || ![1, 2].includes(metadata.version)
    || typeof metadata.title !== "string" || metadata.title.length > 4096
    || !Number.isFinite(Date.parse(metadata.createdAt)) || !Number.isFinite(Date.parse(metadata.updatedAt))
    || !Array.isArray(metadata.context) || typeof metadata.includeHistory !== "boolean")
    fail("Unsupported original API Chat metadata identity/schema.");
  validateLegacyApiChatImages(metadata.images);
  return metadata;
}

/** Closed original API Chat state only. Unknown state siblings remain the adoption core's responsibility. */
export function inspectLegacyApiChatArchive(root: string): LegacyApiChatArchive | undefined {
  if (resolve(root) !== root || realpathSync(root) !== root) fail("Canonical absolute root required.");
  const state = join(root, ".pkm/state");
  if (!lstatSync(state, { throwIfNoEntry: false })) return undefined;
  const entities = new Map<string, LegacyApiChatEntity>(), bytes = new Map<string, Buffer>();
  const privateRoot = legacyPrivateRootGuard(root);
  let usesPrivateRoot = false;
  const controlDirectory = /^\.pkm\/state\/api-chat-control(?:\/(?:hosts|requests)(?:\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?)?$/;
  const privatePaths = privateRoot ? [root, ...(privateRoot.ancestors ?? []).map(item => item.path)].map(path => {
    const stat = lstatSync(path, { bigint: true });
    return { path, device: stat.dev, inode: stat.ino, ctime: stat.ctimeNs };
  }) : [];
  let total = 0;
  function read(relative: string, directory = false, maximum = 16_777_216): Buffer {
    const file = join(root, relative), before = lstatSync(file, { bigint: true });
    const guardedControl = directory && controlDirectory.test(relative) && !!privateRoot
      && (Number(before.mode) & 0o7002) === 0 && legacyPathHasNoSymlinks(root, relative);
    if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n)
      || (Number(before.mode) & 0o7000) !== 0
      || process.platform !== "win32" && (
        process.getuid && Number(before.uid) !== process.getuid()
        || (Number(before.mode) & 0o077) !== 0
          && !(directory && safeLegacyContainerMode(relative, Number(before.mode), Number(before.uid))) && !guardedControl
      )) fail(`Unsafe private archive entity: ${relative}`);
    if (guardedControl && (Number(before.mode) & 0o077) !== 0) usesPrivateRoot = true;
    let data = Buffer.alloc(0);
    if (!directory) {
      if (before.size > BigInt(maximum)) fail("API Chat entity exceeds its bounded size.");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1n) fail("Archive identity changed.");
        data = readFileSync(fd);
        const after = fstatSync(fd, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || data.length !== Number(before.size)) fail("Archive changed during read.");
      } finally { closeSync(fd); }
      total += data.length;
      if (total > 134_217_728) fail("API Chat archive exceeds 128 MiB.");
      bytes.set(relative, data);
    }
    const entity: LegacyApiChatEntity = { path: relative, kind: directory ? "directory" : "file",
      size: Number(before.size), mode: Number(before.mode) & 0o777, device: String(before.dev), inode: String(before.ino),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), ...(!directory ? { sha256: hash(data) } : {}) };
    entities.set(relative, entity);
    if (entities.size > 4096) fail("API Chat archive exceeds 4096 entities.");
    return data;
  }
  read(".pkm", true); read(".pkm/state", true);
  const names = readdirSync(state);
  if (!roots.some(name => names.includes(name))) return undefined;
  function list(relative: string) { read(relative, true); return readdirSync(join(root, relative)).sort(); }
  const chats: LegacyApiChatArchive["chats"] = [], referenced = new Set<string>(), retainedBlobs: string[] = [];
  const owners = new Set<string>();
  const api = ".pkm/state/api-chats", history = ".pkm/state/api-chat-history", groups = ".pkm/state/agent-groups";
  const controlOnly = !names.includes("api-chats") && names.includes("api-chat-control")
    && roots.every(name => name === "api-chat-control" || !names.includes(name));
  if (!names.includes("api-chats") && !controlOnly) fail("API Chat history/group state without its owner Chat.");
  for (const namespace of names.includes("api-chats") ? list(api) : []) {
    if (namespace === "library.json") continue;
    if (!/^[a-f0-9]{16}$/.test(namespace)) fail("Unknown API Chat namespace, live lock or library control requires its dedicated receipt.");
    for (const name of list(`${api}/${namespace}`)) {
      const id = name.replace(/\.json$/, "");
      if (name !== `${id}.json` || !uuid.test(id) || owners.has(id)) fail("Invalid or duplicate owner Chat.");
      const metadata = parse(read(`${api}/${namespace}/${name}`));
      const managed = metadata.sessionId !== undefined || metadata.workerState !== undefined || metadata.workerActivity !== undefined;
      if (Object.keys(metadata).some(key => !chatFields.has(key)) || metadata.id !== id
        || metadata.workspaceNamespace !== namespace || ![1,2].includes(metadata.version)
        || typeof metadata.title !== "string" || metadata.title.length > 4096
        || !Number.isFinite(Date.parse(metadata.createdAt)) || !Number.isFinite(Date.parse(metadata.updatedAt))
        || !Array.isArray(metadata.context) || typeof metadata.includeHistory !== "boolean"
        || !managed && (metadata.progress?.status === "running" || metadata.queuedInputs?.length
          || metadata.portalCommands?.length || metadata.portalTransfers?.length)) fail("Unsupported schema, active or independently owned API Chat controls.");
      validateLegacyApiChatImages(metadata.images);
      owners.add(id);
      chats.push({ namespace, id, metadata, messages: [] });
      if (chats.length > 128) fail("More than 128 ordinary API Chats require a separately bounded receipt.");
    }
  }
  if (!chats.length && !controlOnly) fail("An empty API Chat control tree has no ordinary Chat receipt.");
  const library = names.includes("api-chats") && readdirSync(join(root, api)).includes("library.json")
    ? validateLegacyApiChatLibrary(parse(read(`${api}/library.json`)), owners) : undefined;
  if (names.includes("api-chat-history")) for (const id of list(history)) {
    if (!uuid.test(id) || !owners.has(id)) fail("Segment directory has no valid owner Chat.");
    for (const name of list(`${history}/${id}`)) {
      const sha = name.replace(/\.bin$/, "");
      if (name !== `${sha}.bin` || !digest.test(sha) || hash(read(`${history}/${id}/${name}`, false, 1_048_576)) !== sha)
        fail("Unknown or corrupt historical CAS blob.");
    }
  }
  function segment(id: string, sha: unknown) {
    if (typeof sha !== "string" || !digest.test(sha)) fail("Invalid history segment reference.");
    const file = `${history}/${id}/${sha}.bin`, data = bytes.get(file);
    if (!data) fail("Missing referenced history segment.");
    referenced.add(file); return data;
  }
  for (const chat of chats) {
    const { metadata, id } = chat;
    const managed = metadata.sessionId !== undefined || metadata.workerState !== undefined || metadata.workerActivity !== undefined;
    if (metadata.version === 1) {
      if (metadata.messageHistory !== undefined) fail("Inline Chat cannot carry a segmented index.");
      chat.messages = messages(metadata.messages, managed);
    } else {
      const index = object(metadata.messageHistory);
      if (index.schema !== "pkm.chat.history/v1" || !Array.isArray(metadata.messages) || metadata.messages.length
        || !Number.isSafeInteger(index.messageCount) || index.messageCount < 1 || index.messageCount > 10_000
        || !Array.isArray(index.pages) || index.pages.length > 157 || !index.summary
        || !["idle","completed","new-result","awaiting-input","awaiting-result","paused","failed","stopped",
          ...(managed ? ["running"] : [])].includes(index.summary.status)
        || (managed ? typeof index.summary.workerManager !== "boolean" : index.summary.workerManager !== false))
        fail("Invalid or active segmented history index.");
      const decoded: Json[] = [], decodedIds = new Set<string>();
      let decodedBytes = 0;
      for (const rawPage of index.pages) {
        const page = object(rawPage);
        if (!Number.isSafeInteger(page.count) || page.count < 1 || page.count > 64) fail("Invalid history page count.");
        let entries: any;
        try { entries = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(segment(id, page.digest))); }
        catch { fail("Invalid UTF-8 history index page."); }
        if (!Array.isArray(entries) || entries.length !== page.count) fail("Invalid history page.");
        for (const rawEntry of entries) {
          const entry = object(rawEntry);
          if (typeof entry.id !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 33_554_432
            || !Array.isArray(entry.parts) || entry.parts.length !== Math.ceil(entry.bytes / 1_048_576)) fail("Invalid message segment index.");
          decodedBytes += entry.bytes;
          if (decodedBytes > 67_108_864 || decodedIds.has(entry.id)) fail("Repeated identity or transcript exceeding 64 MiB.");
          decodedIds.add(entry.id);
          const data = Buffer.concat(entry.parts.map((sha: unknown, i: number) => {
            const part = segment(id, sha);
            if (part.length !== Math.min(1_048_576, entry.bytes - i * 1_048_576)) fail("Invalid message part length.");
            return part;
          }));
          const message = parse(data);
          if (message.id !== entry.id) fail("History message identity mismatch.");
          decoded.push(message);
        }
      }
      if (decoded.length !== index.messageCount) fail("History count mismatch.");
      chat.messages = messages(decoded, managed);
    }
  }
  if (!names.includes("agent-groups") && !controlOnly) fail("Missing original ordinary API Chat group records.");
  const groupNames = names.includes("agent-groups") ? list(groups) : [];
  const expected = new Set(chats.map(chat => `agent_group_${hash(JSON.stringify(["pkm", chat.id]))}.json`));
  if (groupNames.length !== expected.size || groupNames.some(name => !expected.has(name))) fail("Unknown, orphan or missing ordinary Chat group.");
  for (const name of groupNames) {
    const group = parse(read(`${groups}/${name}`));
    if (Object.keys(group).some(key => !["schema","groupId","hostKind","hostSessionId","title","createdAt","updatedAt"].includes(key))
      || group.schema !== "pkm.agent.group/v1" || group.hostKind !== "pkm" || !owners.has(group.hostSessionId)
      || name !== `${group.groupId}.json` || group.groupId !== `agent_group_${hash(JSON.stringify(["pkm", group.hostSessionId]))}`
      || typeof group.title !== "string" || !Number.isFinite(Date.parse(group.createdAt)) || !Number.isFinite(Date.parse(group.updatedAt)))
      fail("Invalid ordinary Chat group record.");
  }
  const managed = inspectLegacyManagedApiChatArchive({ names, chats, list, read, parse,
    validateMessages: value => messages(value, true), fail });
  if (usesPrivateRoot && managed?.controls.length) fail("Shared-mode original control directories must contain no records.");
  for (const file of bytes.keys()) if (file.startsWith(`${history}/`) && !referenced.has(file)) retainedBlobs.push(file);
  const files = [...entities.values()].sort((a,b) => a.path.localeCompare(b.path));
  for (const entity of files) {
    const stat = lstatSync(join(root, entity.path), { bigint: true });
    if (String(stat.dev) !== entity.device || String(stat.ino) !== entity.inode || Number(stat.mode & 0o777n) !== entity.mode
      || Number(stat.size) !== entity.size || String(stat.mtimeNs) !== entity.mtimeNs || String(stat.ctimeNs) !== entity.ctimeNs)
      fail("API Chat entities changed during graph verification.");
  }
  if (usesPrivateRoot && (!privateRoot || !sameLegacyPrivateRoot(root, privateRoot)
    || privatePaths.some(item => {
      const stat = lstatSync(item.path, { bigint: true, throwIfNoEntry: false });
      return !stat || stat.dev !== item.device || stat.ino !== item.inode || stat.ctimeNs !== item.ctime;
    }))) fail("Private ancestor changed during API Chat archive verification.");
  // Parent directory identity is rechecked above, but not pinned: adoption legitimately adds core-owned siblings.
  const pinned = files.filter(entity => entity.path !== ".pkm" && entity.path !== ".pkm/state");
  return { schema: "pkm.legacy-api-chat-archive/v1", root, files: pinned, paths: pinned.map(entity => entity.path),
    sourceFingerprint: hash(JSON.stringify({ root, files: pinned, ...(usesPrivateRoot ? {
      privateRootGuard: privateRoot, ancestorCtimes: privatePaths.slice(1).map(item => ({ path: item.path, ctime: String(item.ctime) })),
    } : {}) })),
    chats, retainedBlobs: retainedBlobs.sort(),
    ...(library ? { library } : {}), ...(managed ? { managed } : {}) };
}
