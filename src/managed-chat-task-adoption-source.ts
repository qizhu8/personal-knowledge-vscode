import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { originalMcpPrivateBytes, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { chatSessionMessageInput } from "./chat-session-contracts.js";
import { validateLegacyApiChatMessage, validateLegacyApiChatMetadata } from "./legacy-api-chat-archive.js";
import { validWorkGoal, workGoalInputs, type ApiConversation, type ChatMessage } from "./managed-chat-task-original.js";
import { managedTaskAuthorityFailure } from "./managed-chat-task-admission.js";
import { originalManagedTaskAdoptionSource, type OriginalManagedTaskAdoptionSource } from "./managed-chat-task-adoption-contracts.js";

type Json = Record<string, any>;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const uuid = z.string().uuid();
const readOnlyHistoryTools = new Set(["get_document", "search_documents", "session_info", "report_work", "record_harness",
  "note_read", "note_list", "note_search", "skill_read", "skill_list", "skill_search", "paper_read", "paper_list", "paper_search"]);
function fail(message: string): never { return managedTaskAuthorityFailure(`ORIGINAL_TASK_ADOPTION_REQUIRED: ${message}`); }
function empty(value: unknown): boolean {
  return value === undefined || value === null || Array.isArray(value) && value.length === 0;
}
function unsupported(value: Json) {
  for (const key of ["workerState", "workerActivity", "debugRequest", "agentProfileId"])
    if (value[key] !== undefined) fail(`${key} needs a separate reviewed adoption protocol.`);
  for (const key of ["queuedInputs", "portalCommands", "portalTransfers", "images", "context", "plans",
    "taskContextCheckpoints", "workGoalHistory", "delegations", "workerEventIds", "artifactVersions"])
    if (!empty(value[key])) fail(`${key} is not ordinary text/Goal history.`);
  if (value.agentContext !== undefined && value.agentContext !== null) {
    if (typeof value.agentContext !== "object" || Array.isArray(value.agentContext)
      || Object.values(value.agentContext).some(item => !empty(item)))
      fail("Attached Agent/Memory/Skill context is not silently discarded.");
  }
  if (value.workflowMode !== undefined && value.workflowMode !== "chat") fail("Recipe/plan execution is not adopted.");
  if (value.portalReview || value.portalSource || value.progress?.status === "running") fail("A queued, portal or running context is not adopted.");
}
function title(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value))
    fail("Preserving the exact original title requires its 1–120 character identity.");
  return value;
}
function json(bytes: Buffer): Json {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || Array.isArray(value) || typeof value !== "object") fail("Original JSON object required.");
  return value;
}
export function originalManagedTaskAdoptionSourceRows(db: DatabaseSync, chatId: string) {
  const chat = db.prepare("SELECT * FROM original_api_chat_source_chats WHERE id=?").get(chatId);
  if (!chat || chat.uncertain !== 0 || chat.trashed_at !== null) fail("An exact closed non-Trash original Chat is required.");
  const messages = db.prepare("SELECT * FROM original_api_chat_source_messages WHERE chat_id=? ORDER BY sequence").all(chatId);
  if (messages.length < 1 || messages.length > 32 || messages.length !== chat.message_count)
    fail("The independently bounded adoption profile supports 1–32 complete historical messages; none are pruned.");
  return { chat, messages };
}
export function originalManagedTaskAdoptionDependencies(chat: Json, messages: Json[], metadata: Json) {
  if (!/^agent_session_[a-f0-9]{32}$/.test(metadata.sessionId)) fail("One actual original Task identity is required.");
  const paths = new Set<string>([String(chat.metadata_path), `.pkm/state/agent-sessions/${metadata.sessionId}.json`]);
  const groupId = `agent_group_${sha(JSON.stringify(["pkm", chat.id]))}`;
  paths.add(`.pkm/state/agent-groups/${groupId}.json`);
  for (const page of metadata.messageHistory?.pages ?? []) paths.add(`.pkm/state/api-chat-history/${chat.id}/${page.digest}.bin`);
  for (const row of messages) {
    const descriptor = JSON.parse(String(row.descriptor));
    if (descriptor.kind === "segments") for (const path of descriptor.parts) paths.add(path);
    else if (descriptor.kind !== "inline") fail("Unknown historical message descriptor.");
  }
  if (paths.size > 127) fail("The bounded source-pin envelope was exhausted.");
  return [...paths].sort();
}
export function projectOriginalManagedTaskAdoption(chat: Json, indexed: Json[], get: (path: string) => Buffer) {
  const metadata = validateLegacyApiChatMetadata(json(get(String(chat.metadata_path))), String(chat.namespace), String(chat.id));
  if (sha(get(String(chat.metadata_path))) !== chat.metadata_sha256) fail("The exact source metadata changed.");
  const sessionPath = `.pkm/state/agent-sessions/${metadata.sessionId}.json`, session = json(get(sessionPath));
  const groupId = `agent_group_${sha(JSON.stringify(["pkm", chat.id]))}`;
  const group = json(get(`.pkm/state/agent-groups/${groupId}.json`));
  if (session.schema !== "pkm.agent.session/v1" || session.sessionId !== metadata.sessionId || session.taskId !== metadata.sessionId
    || session.origin !== "pkm-native" || session.runtimeOwner !== "pkm" || session.hostKind !== "pkm"
    || session.hostSessionId !== chat.id || session.groupId !== groupId || group.groupId !== groupId
    || group.schema !== "pkm.agent.group/v1" || group.hostKind !== "pkm" || group.hostSessionId !== chat.id || group.deletedAt
    || !["paused", "completed", "failed", "cancelled", "interrupted", "stopped"].includes(session.status))
    fail("The original Task/Group/Chat identity is foreign, active or inconsistent.");
  if (canonicalJson(session.nativeChat) !== canonicalJson(metadata))
    fail("SOURCE_CONFLICT: metadata and Session nativeChat snapshots disagree; neither is silently selected.");
  unsupported(metadata);
  if (metadata.includeHistory !== true) fail("A disabled original history policy needs an explicit separate history-selection review.");
  title(metadata.title); title(session.task);
  if (![session.todos, session.checkpoints, session.recipeRunIds].every(value => Array.isArray(value) && value.length === 0))
    fail("Original Todo/checkpoint/Recipe state requires its own identity and evidence review.");
  if (!Array.isArray(metadata.memoryTasks) || metadata.memoryTasks.length !== 1 || metadata.memoryTasks[0]?.id !== metadata.sessionId)
    fail("Multiple/replaced original Task identities need an explicit selection protocol.");
  if (!validWorkGoal(metadata.workGoal)) fail("The original Goal identity and objective must be valid, not invented from a title.");
  const messages: Json[] = [], hashes: Array<{ id: string; sha256: string }> = [];
  let bytes = 0;
  for (const row of indexed) {
    const descriptor = JSON.parse(String(row.descriptor));
    const raw = descriptor.kind === "inline"
      ? Buffer.from(canonicalJson(metadata.messages[descriptor.ordinal]))
      : Buffer.concat(descriptor.parts.map((path: string) => get(path)));
    if (raw.length !== (descriptor.kind === "segments" ? descriptor.bytes : raw.length) || sha(raw) !== row.sha256)
      fail("An exact historical message digest changed.");
    if ((bytes += raw.length) > 131072) fail("Historical text exceeds the explicit 128 KiB adoption envelope.");
    const message = validateLegacyApiChatMessage(json(raw)); unsupported(message);
    if (!uuid.safeParse(message.id).success || message.id !== row.id || !["complete", "failed", "cancelled", "interrupted"].includes(message.status))
      fail("Preserving an uncertain or non-UUID original input/reply requires another protocol.");
    if (message.role === "user" && message.content.length > 16000) fail("An original instruction exceeds the unchanged Goal input limit.");
    const toolCalls = message.toolCalls ?? [];
    if (!Array.isArray(toolCalls) || toolCalls.length > 64) fail("Historical tool evidence exceeds its exact canonical envelope.");
    for (const tool of toolCalls) {
      if (!readOnlyHistoryTools.has(tool.name) || tool.status !== "complete" || typeof tool.arguments !== "string"
        || typeof tool.result !== "string" || tool.harnessBinding?.recipeRunId || tool.harnessBinding?.recipeStageId)
        fail("Old effects/worker/process/tool uncertainty are not reinterpreted as terminal current authority.");
      const args = JSON.parse(tool.arguments); unsupported(args);
      if (["recipeRunId", "recipeStageId", "artifactPaths", "artifactVersions"].some(key => !empty(args[key])))
        fail("Historical Recipe/file-version evidence is not adopted.");
    }
    for (const report of message.harnessReports ?? []) {
      if (report.binding?.recipeRunId || report.binding?.recipeStageId || !empty(report.artifactVersions))
        fail("Historical Harness file/Recipe authority requires a separate protocol.");
    }
    const normalized = chatSessionMessageInput.parse({
      id: message.id, role: message.role, content: message.content, status: message.status,
      ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
      ...(message.inputId === undefined ? {} : { inputId: message.inputId }),
      ...(message.model === undefined ? {} : { model: message.model }),
      ...(toolCalls.length ? { toolCalls: toolCalls.map((tool: Json) => ({
        id: tool.id, name: tool.name, arguments: tool.arguments, status: tool.status, result: tool.result,
      })) } : {}),
      contextLabels: ["Original archive history only; not a current execution receipt or permission."],
      metadata: { schema: "pkm.chat.transcript-metadata/v1",
        ...(message.progress ? { progress: message.progress } : {}),
        ...(message.harnessReports ? { harnessReports: message.harnessReports } : {}),
        ...(message.usage ? { usage: message.usage } : {}) },
    });
    messages.push(normalized); hashes.push({ id: message.id, sha256: String(row.sha256) });
  }
  const goal = metadata.workGoal;
  const original = messages.find(message => message.id === goal.inputId);
  if (!original || original.role !== "user" || original.content !== goal.objective
    || !messages.some(message => message.id === goal.attemptInputId && message.role === "user"))
    fail("The actual original Goal/input content binding is missing.");
  const inputIds = workGoalInputs({ id: String(chat.id), sessionId: metadata.sessionId, includeHistory: true,
    messages: messages as ChatMessage[], workGoal: goal } satisfies ApiConversation);
  if (inputIds.length > 63 || messages.filter(message => inputIds.includes(message.id)).some(message => message.taskId !== metadata.sessionId))
    fail("Original ordered Task input identities cannot be manufactured or reassigned.");
  return { metadata, session, messages, hashes, inputIds, sessionPath };
}

/** Independent worker/Main check; source bytes and custody are checked before receipt replay and commit. */
export function assertOriginalManagedTaskAdoptionSource(db: DatabaseSync, root: string, input: unknown): OriginalManagedTaskAdoptionSource {
  const projection = originalManagedTaskAdoptionSource.parse(input), journal = readOriginalMcpJournal(root);
  if (!journal) fail("Original custody required.");
  const inventory = join(journal.plan.backup, "inventory.sqlite");
  if (sha(originalMcpPrivateBytes(inventory, 536870912)) !== journal.plan.inventorySha256) fail("Pinned custody inventory changed.");
  const snapshot = new DatabaseSync(inventory, { readOnly: true }), contents = new Map<string, Buffer>();
  try {
    const trash = `.pkm/state/agent-sessions-trash/${projection.taskId}.json`;
    if (snapshot.prepare("SELECT 1 FROM inventory WHERE path=?").get(trash)
      || lstatSync(join(root, trash), { throwIfNoEntry: false }))
      fail("An original Task in Trash cannot become current authority.");
    if (!snapshot.prepare("SELECT 1 FROM inventory WHERE path='.pkm/state/api-chats/library.json'").get()
      && lstatSync(join(root, ".pkm/state/api-chats/library.json"), { throwIfNoEntry: false }))
      fail("An unreviewed original Chat library appeared after custody.");
    for (const pin of projection.pins) {
      const expected = snapshot.prepare("SELECT kind,sha256,size FROM inventory WHERE path=?").get(pin.path);
      if (!expected || expected.kind !== "file" || expected.sha256 !== pin.sha256 || expected.size !== String(pin.bytes)) fail("Unpinned adoption source.");
      const parts = pin.path.split("/");
      if (parts.some(part => !part || part === "." || part === "..") || !pin.path.startsWith(".pkm/state/")) fail("Invalid source-relative path.");
      for (let index = 1; index < parts.length; index++) {
        const path = parts.slice(0, index).join("/"), stat = lstatSync(join(root, path), { bigint: true });
        const entry = snapshot.prepare("SELECT device,inode,kind FROM inventory WHERE path=?").get(path);
        if (!entry || entry.kind !== "directory" || String(stat.dev) !== entry.device || String(stat.ino) !== entry.inode
          || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o7002n)
          fail("Original source ancestry changed.");
      }
      const bytes = originalMcpPrivateBytes(join(root, pin.path), 1048576);
      if (sha(bytes) !== pin.sha256 || bytes.length !== pin.bytes) fail("Original adoption source changed.");
      contents.set(pin.path, bytes);
    }
    const selected = originalManagedTaskAdoptionSourceRows(db, projection.chatId), get = (path: string) => contents.get(path) ?? fail("Missing original dependency.");
    const value = projectOriginalManagedTaskAdoption(selected.chat, selected.messages, get);
    const actualPaths = originalManagedTaskAdoptionDependencies(selected.chat, selected.messages, value.metadata);
    if (snapshot.prepare("SELECT 1 FROM inventory WHERE path='.pkm/state/api-chats/library.json'").get()) actualPaths.push(".pkm/state/api-chats/library.json");
    if (canonicalJson([...new Set(actualPaths)].sort()) !== canonicalJson(projection.pins.map(pin => pin.path).sort())
      || projection.taskId !== value.metadata.sessionId || projection.namespace !== selected.chat.namespace
      || projection.metadataSha256 !== selected.chat.metadata_sha256 || projection.sessionSha256 !== sha(get(value.sessionPath))
      || projection.chatTitle !== title(value.metadata.title) || projection.taskTitle !== title(value.session.task)
      || projection.sessionStatus !== value.session.status || originalNativeChatDigest(value.hashes) !== projection.historySha256
      || canonicalJson(value.messages) !== canonicalJson(projection.messages) || canonicalJson(value.hashes) !== canonicalJson(projection.messageHashes)
      || canonicalJson(value.inputIds) !== canonicalJson(projection.sourceInputIds) || canonicalJson(value.metadata.workGoal) !== canonicalJson(projection.goal))
      fail("The reviewed adoption projection differs from actual original source.");
    return projection;
  } finally { snapshot.close(); }
}
