import { createHash } from "node:crypto";
type Json = Record<string, any>;
export const legacyManagedApiChatRoots = ["agent-sessions", "api-chat-worker-trees", "api-chat-worker-results", "api-chat-control"];
export interface LegacyManagedApiChatArchive {
  authority: "archive_only";
  sessions: Json[];
  trees: Json[];
  results: Json[];
  controls: Json[];
  uncertainChats: string[];
  uncertainControls: string[];
}
interface Reader {
  names: readonly string[];
  chats: Array<{ id: string; namespace: string; metadata: Json; messages: Json[] }>;
  list(path: string): string[];
  read(path: string, directory?: boolean, maximum?: number): Buffer;
  parse(bytes: Buffer): Json;
  validateMessages(value: unknown): Json[];
  fail(message: string): never;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sessionId = /^agent_session_[a-f0-9]{32}$/;
const uuidValue = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

/** Original task/worker/control bytes are evidence, never PID, permission, queue or execution authority. */
export function inspectLegacyManagedApiChatArchive(reader: Reader): LegacyManagedApiChatArchive | undefined {
  const { names, chats, list, read, parse } = reader;
  function fail(message: string): never { return reader.fail(message); }
  const managed = chats.some(chat => chat.metadata.sessionId || chat.metadata.workerState || chat.metadata.workerActivity);
  if (!managed && !legacyManagedApiChatRoots.some(name => names.includes(name))) return undefined;
  const archive: LegacyManagedApiChatArchive = {
    authority: "archive_only", sessions: [], trees: [], results: [], controls: [], uncertainChats: [], uncertainControls: [],
  };
  const owners = new Map(chats.map(chat => [chat.id, chat]));
  const uncertain = new Set<string>();
  const record = (value: unknown): Json => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Invalid managed archive record.");
    return value as Json;
  };
  const jsonFiles = (directory: string, identity: RegExp): Json[] => {
    if (!names.includes(directory)) return [];
    return list(`.pkm/state/${directory}`).map(name => {
      if (!name.endsWith(".json") || !identity.test(name.slice(0, -5))) return fail(`Unknown managed control: ${directory}/${name}`);
      return { name: name.slice(0, -5), value: parse(read(`.pkm/state/${directory}/${name}`)) };
    });
  };
  for (const { name, value } of jsonFiles("agent-sessions", sessionId)) {
    const owner = owners.get(value.hostSessionId), native = record(value.nativeChat);
    if (value.schema !== "pkm.agent.session/v1" || value.sessionId !== name || value.taskId !== name
      || value.origin !== "pkm-native" || value.runtimeOwner !== "pkm" || value.hostKind !== "pkm"
      || !owner || native.version !== 1 || native.id !== owner.id || native.sessionId !== name
      || value.groupId !== `agent_group_${createHash("sha256").update(JSON.stringify(["pkm", value.hostSessionId])).digest("hex")}`
      || native.workspaceNamespace !== owner.namespace || typeof value.task !== "string"
      || !["running", "paused", "completed", "failed", "cancelled", "interrupted", "stopped"].includes(value.status)
      || !Array.isArray(value.todos) || !Array.isArray(value.recipeRunIds) || !Array.isArray(value.checkpoints)
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)))
      fail("Unsupported, foreign-host or unowned original managed Task Session.");
    reader.validateMessages(native.messages);
    if (value.status === "running") uncertain.add(owner.id);
    archive.sessions.push(value);
  }
  const sessions = new Map(archive.sessions.map(value => [value.sessionId, value]));
  for (const chat of chats) {
    const metadata = chat.metadata;
    if (metadata.sessionId !== undefined && (typeof metadata.sessionId !== "string" || !sessionId.test(metadata.sessionId)
      || sessions.get(metadata.sessionId)?.hostSessionId !== chat.id)) fail("Chat Task has no matching original Session.");
    if (metadata.memoryTasks !== undefined) {
      if (!Array.isArray(metadata.memoryTasks)) fail("Invalid original Chat Task history.");
      for (const task of metadata.memoryTasks) {
        record(task);
        if (typeof task.id !== "string" || sessions.get(task.id)?.hostSessionId !== chat.id)
          fail("Original Chat Task history has no owned Session.");
      }
    }
    for (const key of ["queuedInputs", "portalCommands", "portalTransfers"]) if (metadata[key] !== undefined) {
      if (!Array.isArray(metadata[key]) || metadata[key].length > 1000) fail("Invalid bounded archived Chat queue.");
      metadata[key].forEach(record);
      if (metadata[key].length) uncertain.add(chat.id);
    }
    if (metadata.workerActivity !== undefined && metadata.workerState === undefined) fail("Worker activity has no original tree binding.");
    if (metadata.progress?.status === "running" || chat.messages.some(message => ["streaming", "running"].includes(message.status)
      || message.progress?.status === "running"
      || message.toolCalls?.some((call: Json) => ["pending", "running"].includes(call.status))
      || message.delegations?.some((item: Json) => ["pending", "running"].includes(item.status))))
      uncertain.add(chat.id);
  }
  for (const { name, value } of jsonFiles("api-chat-worker-results", uuid)) {
    const chat = record(value.chat), state = record(chat.workerState);
    if (value.schema !== "pkm.chat.worker-result/v1" || value.receiptId !== name
      || !uuidValue(value.managerChatId) || !uuidValue(chat.id) || chat.version !== 1
      || !/^[a-f0-9]{16}$/.test(chat.workspaceNamespace) || typeof chat.title !== "string"
      || state.receiptId !== name || state.parentChatId !== value.managerChatId || !uuidValue(state.treeId)
      || !Number.isFinite(Date.parse(value.archivedAt))) fail("Invalid original archived worker result.");
    reader.validateMessages(chat.messages);
    archive.results.push(value);
  }
  const results = new Map(archive.results.map(value => [value.receiptId, value]));
  const treeMap = new Map<string, Json>();
  for (const { name, value } of jsonFiles("api-chat-worker-trees", uuid)) {
    if (value.schema !== "pkm.chat.worker-tree/v1" || value.id !== name || !owners.has(value.rootChatId)
      || !Array.isArray(value.slots) || value.slots.length > 10000
      || value.approvedQuota !== undefined && (!Number.isSafeInteger(value.approvedQuota)
        || value.approvedQuota < 0 || value.approvedQuota > 1000))
      fail("Invalid or unowned original worker tree.");
    const receipts = new Set<string>(), children = new Set<string>();
    for (const raw of value.slots) {
      const slot = record(raw);
      if (!uuidValue(slot.receiptId) || !uuidValue(slot.chatId) || !uuidValue(slot.parentChatId)
        || slot.chatId === value.rootChatId || slot.chatId === slot.parentChatId
        || receipts.has(slot.receiptId) || !slot.released && children.has(slot.chatId)
        || slot.temporary !== undefined && typeof slot.temporary !== "boolean"
        || slot.released !== undefined && typeof slot.released !== "boolean"
        || typeof slot.title !== "string" || !Array.isArray(slot.writeScope) || !Array.isArray(slot.resources))
        fail("Invalid or duplicate original worker slot.");
      receipts.add(slot.receiptId);
      if (!slot.released) children.add(slot.chatId);
      const result = results.get(slot.receiptId), live = owners.get(slot.chatId);
      if (result && (result.chat.id !== slot.chatId || result.managerChatId !== slot.parentChatId
        || result.chat.workerState.treeId !== name)) fail("Original worker result disagrees with its exact slot.");
      if (!live && !result || live && result) uncertain.add(value.rootChatId);
      if (live && live.metadata.workerState?.receiptId === slot.receiptId
        && (live.metadata.workerState.treeId !== name || live.metadata.workerState.parentChatId !== slot.parentChatId))
        fail("Live worker disagrees with its original slot.");
      if (live && !slot.released && live.metadata.workerState?.receiptId !== slot.receiptId) uncertain.add(value.rootChatId);
    }
    const historicalIds = new Set(value.slots.map((slot: Json) => slot.chatId));
    const byId = new Map<string, Json>(value.slots.filter((slot: Json) => !slot.released).map((slot: Json) => [slot.chatId, slot]));
    for (const slot of value.slots.filter((slot: Json) => !slot.released)) {
      const seen = new Set<string>([slot.chatId]);
      let parent = slot.parentChatId;
      while (parent !== value.rootChatId) {
        if (seen.has(parent) || !historicalIds.has(parent)) fail("Cyclic or foreign original worker ancestry.");
        if (!byId.has(parent)) break;
        seen.add(parent); parent = byId.get(parent)!.parentChatId;
      }
    }
    treeMap.set(name, value); archive.trees.push(value);
  }
  for (const result of archive.results) {
    const tree = treeMap.get(result.chat.workerState.treeId);
    if (!tree?.slots.some((slot: Json) => slot.receiptId === result.receiptId && slot.chatId === result.chat.id))
      fail("Archived worker has no matching original tree slot.");
  }
  for (const chat of chats) if (chat.metadata.workerState !== undefined) {
    const state = record(chat.metadata.workerState), tree = treeMap.get(state.treeId);
    if (!tree || typeof state.sleeping !== "boolean" || typeof state.stopped !== "boolean" || !Array.isArray(state.events))
      fail("Chat has no matching original worker tree.");
    if (state.parentChatId === undefined && tree.rootChatId !== chat.id) fail("Worker manager identity mismatch.");
    if (state.parentChatId !== undefined && !tree.slots.some((slot: Json) =>
      slot.chatId === chat.id && slot.receiptId === state.receiptId && slot.parentChatId === state.parentChatId))
      fail("Worker has no matching original slot.");
    if (chat.metadata.workerActivity !== undefined) {
      const activity = record(chat.metadata.workerActivity);
      if (!["pending", "running", "waiting-input", "completed", "failed", "interrupted", "cancelled"].includes(activity.state)
        || activity.treeId !== state.treeId || activity.receiptId !== state.receiptId
        || activity.managerChatId !== state.parentChatId) fail("Invalid original worker activity binding.");
      if (["pending", "running", "waiting-input"].includes(activity.state)) uncertain.add(chat.id);
    }
  }
  if (names.includes("api-chat-control")) {
    const control = ".pkm/state/api-chat-control";
    for (const name of list(control)) {
      if (!["hosts", "requests"].includes(name)) fail("Unknown original API Chat control subtree.");
      for (const entry of list(`${control}/${name}`)) {
        if (name === "hosts") {
          if (!entry.endsWith(".json") || !uuid.test(entry.slice(0, -5))) fail("Invalid archived API host name.");
          const value = parse(read(`${control}/hosts/${entry}`, false, 262144));
          if (value.schema !== "pkm.api-chat.host/v1" || value.hostId !== entry.slice(0, -5)
            || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isFinite(value.updatedAt)
            || !Array.isArray(value.operations) || typeof value.portalRequestDirectory !== "string") fail("Invalid archived API host.");
          archive.controls.push(value);
        } else {
          if (!uuid.test(entry)) fail("Invalid original request host directory.");
          for (const file of list(`${control}/requests/${entry}`)) {
            if (!/^[a-f0-9]{64}\.json$/.test(file)) fail("Unknown original API request file.");
            const value = parse(read(`${control}/requests/${entry}/${file}`, false, 262144));
            if (value.schema !== "pkm.api-chat.request/v1" || value.hostId !== entry || `${value.requestId}.json` !== file
              || !["models", "tools", "list", "create", "get", "send", "cancel", "fixture-e2e", "portal"].includes(value.operation)
              || !["queued", "running", "succeeded", "failed"].includes(value.status)) fail("Invalid archived API request.");
            record(value.arguments);
            if (["queued", "running"].includes(value.status)) {
              archive.uncertainControls.push(value.requestId);
              if (["send", "create", "portal", "fixture-e2e"].includes(value.operation)) {
                const target = value.arguments.id ?? value.arguments.chatId;
                if (typeof target === "string" && owners.has(target)) uncertain.add(target);
                else for (const chat of chats)
                  if (chat.metadata.sessionId || chat.metadata.workerState) uncertain.add(chat.id);
              }
            }
            archive.controls.push(value);
          }
        }
      }
    }
  }
  archive.uncertainChats = [...uncertain].sort();
  return archive;
}
