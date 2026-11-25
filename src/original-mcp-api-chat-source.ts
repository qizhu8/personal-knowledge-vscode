import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy, originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import { validateLegacyApiChatMessage, validateLegacyApiChatMetadata } from "./legacy-api-chat-archive.js";
import { validateLegacyApiChatLibrary } from "./legacy-api-chat-library.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalApiChatStatus } from "./domain/original-api-chat-projection.js";
import { originalApiChatSourceLimitsSchema as limitsSchema, originalApiChatSourcePlanSchema as sourcePlanSchema,
  originalMcpSourceApprovalSchema, type OriginalApiChatSourcePlan, type OriginalApiChatSourcePolicy,
  type OriginalMcpSourceApproval } from "./original-mcp-source-policy-contracts.js";
import { retainOriginalMcpNativeSourceApproval, assertOriginalMcpNativeSourceApprovalCurrent,
  originalMcpNativeSourceApprovalSignal } from "./original-mcp-native-source-policy.js";
import { originalApiChatSourceDdl as ddl, originalApiChatSourceTables as tables,
  originalApiChatImmutableSourceDdl as immutableSource, originalApiChatSourceAdmissionDdl as admissionDdl,
  verifyOriginalApiChatSourceSchema as verifySourceSchema, parseOriginalApiChatSourcePlan as parsedPlan,
  readOriginalApiChatSourceReceipt } from "./original-mcp-api-chat-schema.js";
export type { OriginalApiChatSourcePlan, OriginalApiChatSourcePolicy } from "./original-mcp-source-policy-contracts.js";

type Json = Record<string, any>;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const planned = new WeakMap<object, string>();
function fail(message: string): never { throw new CoreError("RECOVERY_REQUIRED", `ORIGINAL_API_CHAT_SOURCE_REQUIRED: ${message}`); }
function checked(storage: Storage, host: OriginalMcpNativeHost) {
  assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
  if (!journal) fail("Exact original custody is required.");
  return journal;
}
function privateStage(root: string, directory: string) {
  const rel = relative(root, directory), stat = lstatSync(directory);
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || !rel
    || !rel.startsWith(`..${sep}`) && !isAbsolute(rel) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
    fail("An independent private canonical operator staging directory is required.");
}
const json = (bytes: Buffer): Json => {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || Array.isArray(value) || typeof value !== "object") fail("Expected an original JSON record.");
  return value;
};
type Reader = Awaited<ReturnType<typeof openOriginalMcpCustodyReader>>;
async function messageBytes(reader: Reader, descriptor: Json): Promise<Buffer> {
  if (descriptor.kind === "inline") {
    const metadata = json(await reader.read(descriptor.path, 16_777_216));
    const message = metadata.messages?.[descriptor.ordinal];
    if (!message) fail("Inline source message disappeared.");
    return Buffer.from(canonicalJson(message));
  }
  if (descriptor.kind !== "segments" || !Array.isArray(descriptor.parts)
    || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > 33_554_432
    || descriptor.parts.length !== Math.ceil(descriptor.bytes / 1_048_576)) fail("Invalid bounded message descriptor.");
  const parts: Buffer[] = [];
  for (const [index, path] of descriptor.parts.entries()) {
    if (typeof path !== "string" || !/^\.pkm\/state\/api-chat-history\/[a-f0-9-]{36}\/[a-f0-9]{64}\.bin$/.test(path))
      fail("Invalid source CAS part identity.");
    const bytes = await reader.read(path, 1_048_576);
    if (sha(bytes) !== path.slice(-68, -4) || bytes.length !== Math.min(1_048_576, descriptor.bytes - index * 1_048_576))
      fail("Source message part changed.");
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}
/** Explicit streaming source envelope; does not change the small archive importer's limits or activate old control. */
export async function planOriginalMcpApiChatSource(storage: Storage, host: OriginalMcpNativeHost,
  options: { stagingDirectory: string; limits: z.infer<typeof limitsSchema> }): Promise<OriginalApiChatSourcePlan> {
  options = structuredClone(options);
  const journal = checked(storage, host), root = journal.plan.root, limits = limitsSchema.parse(options.limits);
  privateStage(root, options.stagingDirectory);
  const indexPath = join(options.stagingDirectory, "api-chat-index.sqlite");
  if (lstatSync(indexPath, { throwIfNoEntry: false })) fail("Source index publication never overwrites an existing file.");
  const index = new DatabaseSync(indexPath), reader = await openOriginalMcpCustodyReader(journal.plan);
  let chats = 0, messages = 0, controls = 0, complete = false;
  try {
    index.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;" + ddl);
    const owners = new Set<string>();
    for (const entry of reader.entries(".pkm/state/api-chats")) {
      if (entry.kind === "directory" || entry.path === ".pkm/state/api-chats/library.json") continue;
      const match = /^\.pkm\/state\/api-chats\/([a-f0-9]{16})\/([a-f0-9-]{36})\.json$/.exec(entry.path);
      if (!match || !uuid.test(match[2]!) || owners.has(match[2]!)) fail("Unknown or duplicate original Chat identity.");
      const namespace = match[1]!, id = match[2]!, raw = await reader.read(entry.path, 16_777_216);
      const metadata = validateLegacyApiChatMetadata(json(raw), namespace, id);
      owners.add(id);
      if (++chats > limits.maxChats) fail("Chat count exceeds the explicit source envelope.");
      let sequence = 0, lastAssistant: number | null = null;
      let latest: Json | undefined, awaitingResult = false, workerManager = false;
      let uncertain = !!(metadata.queuedInputs?.length
        || metadata.portalCommands?.length || metadata.portalTransfers?.length || metadata.progress?.status === "running");
      const add = async (descriptor: Json, expectedId?: string) => {
        if (++sequence > limits.maxMessagesPerChat || ++messages > limits.maxMessages) fail("Message count exceeds the explicit source envelope.");
        const bytes = await messageBytes(reader, descriptor), message = validateLegacyApiChatMessage(json(bytes));
        latest = message;
        if (message.delegations?.length) workerManager = true;
        if (message.delegations?.some((item: Json) => item.status === "running")) awaitingResult = true;
        if (expectedId !== undefined && message.id !== expectedId) fail("Original history entry identity changed.");
        if (message.role === "assistant") lastAssistant = sequence;
        if (!["complete", "cancelled", "failed", "interrupted"].includes(message.status)
          || message.progress?.status === "running" || message.toolCalls?.some((tool: Json) => ["pending", "running"].includes(tool.status)))
          uncertain = true;
        index.prepare("INSERT INTO original_api_chat_source_messages VALUES(?,?,?,?,?)")
          .run(id, sequence, message.id, canonicalJson(descriptor), sha(bytes));
      };
      if (metadata.version === 1) {
        if (!Array.isArray(metadata.messages) || metadata.messageHistory !== undefined) fail("Invalid inline original Chat.");
        for (let ordinal = 0; ordinal < metadata.messages.length; ordinal++)
          await add({ kind: "inline", path: entry.path, ordinal }, metadata.messages[ordinal]?.id);
      } else {
        const history = metadata.messageHistory;
        if (!history || history.schema !== "pkm.chat.history/v1" || !Array.isArray(history.pages)
          || !Array.isArray(metadata.messages) || metadata.messages.length || !Number.isSafeInteger(history.messageCount)
          || history.messageCount < 1 || history.messageCount > limits.maxMessagesPerChat
          || history.pages.length > Math.ceil(limits.maxMessagesPerChat / 1))
          fail("Invalid segmented original Chat index.");
        for (const page of history.pages) {
          if (!page || !digest.safeParse(page.digest).success || !Number.isSafeInteger(page.count) || page.count < 1 || page.count > 64)
            fail("Invalid original history page.");
          const path = `.pkm/state/api-chat-history/${id}/${page.digest}.bin`, bytes = await reader.read(path, 1_048_576);
          if (sha(bytes) !== page.digest) fail("Original history page digest changed.");
          const entries = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (!Array.isArray(entries) || entries.length !== page.count) fail("Original history page count changed.");
          for (const message of entries) {
            if (!message || typeof message.id !== "string" || !Array.isArray(message.parts)
              || message.parts.some((part: unknown) => !digest.safeParse(part).success)) fail("Invalid original message index.");
            await add({ kind: "segments", bytes: message.bytes,
              parts: message.parts.map((part: string) => `.pkm/state/api-chat-history/${id}/${part}.bin`) }, message.id);
          }
        }
        if (sequence !== history.messageCount) fail("Original history total changed.");
      }
      const groupId = `agent_group_${sha(JSON.stringify(["pkm", id]))}`;
      const group = json(await reader.read(`.pkm/state/agent-groups/${groupId}.json`, 1_048_576));
      if (group.schema !== "pkm.agent.group/v1" || group.groupId !== groupId || group.hostKind !== "pkm"
        || group.hostSessionId !== id) fail("Original Chat lost its exact agent-group binding.");
      let stoppedSession = false;
      if (metadata.sessionId) {
        if (!/^agent_session_[a-f0-9]{32}$/.test(metadata.sessionId)) fail("Invalid historical Task identity.");
        const session = json(await reader.read(`.pkm/state/agent-sessions/${metadata.sessionId}.json`, 16_777_216));
        if (session.schema !== "pkm.agent.session/v1" || session.sessionId !== metadata.sessionId
          || session.hostSessionId !== id || session.nativeChat?.id !== id || session.nativeChat?.workspaceNamespace !== namespace
          || !["running", "paused", "completed", "failed", "cancelled", "interrupted", "stopped"].includes(session.status))
          fail("Historical Task lost its exact Chat binding.");
        if (session.status === "running") uncertain = true;
        stoppedSession = session.status === "stopped";
      }
      if (metadata.workerState) {
        const state = metadata.workerState;
        if (!uuid.test(state.treeId) || typeof state.sleeping !== "boolean" || typeof state.stopped !== "boolean"
          || !Array.isArray(state.events)) fail("Historical worker state is malformed.");
        const tree = json(await reader.read(`.pkm/state/api-chat-worker-trees/${state.treeId}.json`, 16_777_216));
        if (tree.schema !== "pkm.chat.worker-tree/v1" || tree.id !== state.treeId || !Array.isArray(tree.slots)
          || tree.slots.length > 10_000 || (state.parentChatId === undefined ? tree.rootChatId !== id
            : !tree.slots.some((slot: Json) => slot.chatId === id && slot.receiptId === state.receiptId
              && slot.parentChatId === state.parentChatId)))
          fail("Historical worker lost its exact tree/slot identity; no worker authority was imported.");
      }
      if (["pending", "running", "waiting-input"].includes(metadata.workerActivity?.state)) uncertain = true;
      const sourceStatus = stoppedSession ? "stopped"
        : metadata.version === 2 ? metadata.messageHistory.summary?.status : originalApiChatStatus(metadata, latest, awaitingResult);
      if (!["running", "idle", "completed", "new-result", "awaiting-input", "awaiting-result", "paused", "failed", "stopped"].includes(sourceStatus))
        fail("Invalid source Chat summary status.");
      if (["running", "awaiting-input", "awaiting-result"].includes(sourceStatus)) uncertain = true;
      const summary = {
        ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
        activityCreditLimit: metadata.activityCreditLimit, activityBudgetBypass: metadata.activityBudgetBypass,
        workerManager: metadata.version === 2 ? metadata.messageHistory.summary.workerManager : workerManager,
        ...(metadata.workerState ? { workerTreeId: metadata.workerState.treeId,
          ...(metadata.workerState.parentChatId ? { workerParentChatId: metadata.workerState.parentChatId } : {}) } : {}),
        sourceAuthority: "archive_only",
      };
      index.prepare("INSERT INTO original_api_chat_source_chats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)")
        .run(namespace, id, entry.path, entry.sha256!, metadata.title, metadata.createdAt, metadata.updatedAt,
          sequence, lastAssistant, uncertain ? 1 : 0, sourceStatus, JSON.stringify(summary), "ungroup");
    }
    let library: ReturnType<typeof validateLegacyApiChatLibrary> = { version: 1, groups: [], placements: {} };
    const libraryEntry = [...reader.entries(".pkm/state/api-chats/library.json")].find(entry => entry.kind === "file");
    if (libraryEntry) library = validateLegacyApiChatLibrary(json(await reader.read(libraryEntry.path, 16_777_216)), owners);
    for (const [id, placement] of Object.entries(library.placements))
      index.prepare("UPDATE original_api_chat_source_chats SET group_id=?,trashed_at=? WHERE id=?")
        .run(placement.groupId, placement.trashedAt ?? null, id);
    index.prepare("INSERT INTO original_api_chat_source_library VALUES(1,?)").run(canonicalJson(library));
    for (const entry of reader.entries(".pkm/state/api-chat-history")) {
      if (entry.kind === "directory") continue;
      const match = /^\.pkm\/state\/api-chat-history\/([a-f0-9-]{36})\/([a-f0-9]{64})\.bin$/.exec(entry.path);
      if (!match || !owners.has(match[1]!) || entry.sha256 !== match[2]) fail("Unowned, malformed or corrupt historical CAS blob.");
    }
    for (const entry of reader.entries(".pkm/state/api-chat-control/requests")) {
      if (entry.kind === "directory") continue;
      const match = /^\.pkm\/state\/api-chat-control\/requests\/([a-f0-9-]{36})\/([a-f0-9]{64})\.json$/.exec(entry.path);
      if (!match || !uuid.test(match[1]!)) fail("Invalid original request path.");
      const record = json(await reader.read(entry.path, 1_048_576));
      if (record.schema !== "pkm.api-chat.request/v1" || record.hostId !== match[1] || record.requestId !== match[2]
        || !["queued", "running", "succeeded", "failed"].includes(record.status)
        || !["models", "tools", "list", "create", "get", "send", "cancel", "fixture-e2e", "portal"].includes(record.operation))
        fail("Invalid archived request receipt.");
      index.prepare("INSERT INTO original_api_chat_source_controls VALUES(?,?,?,?)")
        .run(match[1], match[2], entry.path, entry.sha256!); controls++;
    }
    reader.assertCurrent(); checked(storage, host);
    index.exec("COMMIT"); complete = true;
  } finally { if (index.isTransaction) index.exec("ROLLBACK"); index.close(); reader.close(); }
  if (!complete) fail("Source index is incomplete.");
  const stat = lstatSync(indexPath);
  if ((stat.mode & 0o077) !== 0) {
    // This is a newly created independent capsule, never an original file.
    const { chmodSync } = await import("node:fs"); chmodSync(indexPath, 0o600);
  }
  const body = { schema: "pkm.original-api-chat-source/v1" as const, root, workspaceId: journal.workspaceId,
    custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
    indexPath, indexSha256: sha(originalMcpPrivateBytes(indexPath, 536_870_912)), chats, messages, controls, limits };
  const plan = sourcePlanSchema.parse({ ...body, planSha256: sha(canonicalJson(body)) });
  planned.set(plan, plan.planSha256);
  return plan;
}
const sessions = new WeakMap<Storage, {
  host: OriginalMcpNativeHost; plan: OriginalApiChatSourcePlan; approval: OriginalMcpSourceApproval; expiresAtMs: number;
  revocation: SharedArrayBuffer; revoke(): void;
}>();
const cleanupBound = new WeakSet<Storage>();
function bindSourceSession(storage: Storage, host: OriginalMcpNativeHost,
  plan: OriginalApiChatSourcePlan, approval: OriginalMcpSourceApproval) {
  assertSourceDecision(storage, host, approval);
  sessions.get(storage)?.revoke();
  const revocation = new SharedArrayBuffer(4), flag = new Int32Array(revocation);
  const sourceSignal = originalMcpNativeSourceApprovalSignal(approval);
  const revoke = () => {
    Atomics.store(flag, 0, 1);
    host.signal.removeEventListener("abort", revoke); sourceSignal?.removeEventListener("abort", revoke);
  };
  host.signal.addEventListener("abort", revoke, { once: true });
  sourceSignal?.addEventListener("abort", revoke, { once: true });
  if (host.signal.aborted || sourceSignal?.aborted) revoke();
  if (!cleanupBound.has(storage)) {
    storage.retainNativeCleanup({ release: async () => { sessions.get(storage)?.revoke(); sessions.delete(storage); } });
    cleanupBound.add(storage);
  }
  sessions.set(storage, { host, plan, approval, expiresAtMs: approval.expiresAtMs, revocation, revoke });
}
function assertSourceDecision(storage: Storage, host: OriginalMcpNativeHost, approval: OriginalMcpSourceApproval) {
  checked(storage, host); assertOriginalMcpNativeSourceApprovalCurrent(approval);
  if (approval.expiresAtMs <= Date.now() || originalMcpNativeSourceApprovalSignal(approval)?.aborted)
    fail("Fresh exact source approval expired or was revoked.");
}
export async function admitOriginalMcpApiChatSource(storage: Storage, host: OriginalMcpNativeHost,
  input: OriginalApiChatSourcePlan, policy: OriginalApiChatSourcePolicy) {
  const plan = parsedPlan(input), journal = checked(storage, host);
  if (plan.root !== journal.plan.root || plan.workspaceId !== journal.workspaceId
    || plan.custodyPlanSha256 !== journal.plan.planSha256 || plan.profileSha256 !== journal.plan.profileSha256)
    fail("Source capsule belongs to another original root/profile.");
  const bytes = originalMcpPrivateBytes(plan.indexPath, 536_870_912);
  if (sha(bytes) !== plan.indexSha256) fail("Source capsule changed.");
  const request = Object.freeze(
    structuredClone({ ...plan, phase: "admit" as const, nativeHostReceiptSha256: host.receipt.receiptSha256 }));
  sessions.get(storage)?.revoke();
  const observed = await policy.authorize(request);
  const approval = originalMcpSourceApprovalSchema.safeParse(observed);
  checked(storage, host);
  if (!approval.success || approval.data.expiresAtMs <= Date.now()
    || approval.data.expiresAtMs > Date.now() + 30 * 60_000) fail("Fresh exact native source-domain approval is required.");
  const decision = approval.data;
  retainOriginalMcpNativeSourceApproval(observed, decision, "chat", request);
  await storage.withWorkspaceExclusive(() => {
    const database = storage.connectNative();
    try {
      assertSourceDecision(storage, host, decision);
      if (sha(originalMcpPrivateBytes(plan.indexPath, 536_870_912)) !== plan.indexSha256) fail("Reviewed source capsule changed.");
      const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE name='original_api_chat_source_admission'").get();
      const previous = exists ? database.prepare("SELECT * FROM original_api_chat_source_admission WHERE singleton=1").get() : undefined;
      if (previous && (previous.payload !== canonicalJson(plan) || previous.sha256 !== plan.planSha256)) fail("Another Chat source is already admitted.");
      if (!previous) {
        if (planned.get(input) !== plan.planSha256)
          fail("Initial admission requires the actual parser's branded source plan, not caller-created successful receipts.");
        const source = pathToFileURL(plan.indexPath); source.search = "?mode=ro&immutable=1";
        database.prepare("ATTACH DATABASE ? AS original_chat_source").run(source.href);
        try {
          database.exec("BEGIN IMMEDIATE;" + (exists ? "" : admissionDdl) + ddl);
          for (const table of tables) database.exec(`INSERT INTO main.${table} SELECT * FROM original_chat_source.${table}`);
          database.exec(immutableSource);
          database.prepare("INSERT INTO original_api_chat_source_admission VALUES(1,?,?,?,?)")
            .run(canonicalJson(plan), plan.planSha256, host.receipt.receiptSha256, decision.decisionId);
          assertSourceDecision(storage, host, decision);
          database.exec("COMMIT");
        } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
        finally { database.exec("DETACH DATABASE original_chat_source"); }
      }
      verifySourceSchema(database);
    } finally { database.close(); }
  });
  assertSourceDecision(storage, host, decision);
  bindSourceSession(storage, host, plan, decision);
  return { schema: "pkm.original-api-chat-source-session/v1" as const, planSha256: plan.planSha256, expiresAtMs: decision.expiresAtMs };
}
export async function activateOriginalMcpApiChatSource(storage: Storage, host: OriginalMcpNativeHost, policy: OriginalApiChatSourcePolicy) {
  const journal = checked(storage, host), db = storage.connectNative();
  let plan: OriginalApiChatSourcePlan;
  try {
    plan = readOriginalApiChatSourceReceipt(db, journal);
  } finally { db.close(); }
  const request = Object.freeze(
    structuredClone({ ...plan!, phase: "activate" as const, nativeHostReceiptSha256: host.receipt.receiptSha256 }));
  sessions.get(storage)?.revoke();
  const observed = await policy.authorize(request);
  const approval = originalMcpSourceApprovalSchema.safeParse(observed);
  checked(storage, host);
  if (!approval.success || approval.data.expiresAtMs <= Date.now() || approval.data.expiresAtMs > Date.now() + 30 * 60_000)
    fail("Fresh exact native source-domain approval is required.");
  retainOriginalMcpNativeSourceApproval(observed, approval.data, "chat", request);
  assertSourceDecision(storage, host, approval.data);
  bindSourceSession(storage, host, plan!, approval.data);
  return { schema: "pkm.original-api-chat-source-session/v1" as const, planSha256: plan!.planSha256, expiresAtMs: approval.data.expiresAtMs };
}
export function originalMcpApiChatSource(storage: Storage, host: OriginalMcpNativeHost): OriginalApiChatSourcePlan {
  checked(storage, host);
  const session = sessions.get(storage);
  if (!session || session.host !== host || session.expiresAtMs <= Date.now()
    || Atomics.load(new Int32Array(session.revocation), 0) !== 0) fail("A fresh source-domain session is required.");
  assertSourceDecision(storage, host, session.approval);
  const db = storage.connectNative();
  try {
    verifySourceSchema(db);
    const row = db.prepare("SELECT payload,sha256 FROM original_api_chat_source_admission WHERE singleton=1").get();
    if (!row || row.payload !== canonicalJson(session.plan) || row.sha256 !== session.plan.planSha256) fail("Source receipt changed.");
  } finally { db.close(); }
  return structuredClone(session.plan);
}
export function originalMcpApiChatSourceActive(storage: Storage, host: OriginalMcpNativeHost): boolean {
  const session = sessions.get(storage);
  if (!session || session.host !== host || session.expiresAtMs <= Date.now()
    || Atomics.load(new Int32Array(session.revocation), 0) !== 0) return false;
  if (originalMcpNativeSourceApprovalSignal(session.approval)?.aborted) return false;
  originalMcpApiChatSource(storage, host);
  return true;
}
export function originalMcpApiChatSourceDeadline(storage: Storage, host: OriginalMcpNativeHost): number {
  originalMcpApiChatSource(storage, host);
  return sessions.get(storage)!.expiresAtMs;
}
export type OriginalMcpApiChatSourceSessionAuthority = Readonly<OriginalMcpSourceApproval
  & Pick<OriginalApiChatSourcePlan, "root" | "workspaceId" | "custodyPlanSha256" | "profileSha256" | "planSha256">
  & { nativeHostReceiptSha256: string; epoch: string; revocation: SharedArrayBuffer }>;

/** Current source-consent evidence for a same-owner worker gate, never a new grant or a socket-liveness proxy. */
export function readOriginalMcpApiChatSourceSession(storage: Storage, host: OriginalMcpNativeHost):
  OriginalMcpApiChatSourceSessionAuthority {
  const plan = originalMcpApiChatSource(storage, host), session = sessions.get(storage)!;
  return Object.freeze({ ...session.approval, root: plan.root, workspaceId: plan.workspaceId,
    custodyPlanSha256: plan.custodyPlanSha256, profileSha256: plan.profileSha256, planSha256: plan.planSha256,
    nativeHostReceiptSha256: host.receipt.receiptSha256, epoch: host.receipt.epoch, revocation: session.revocation });
}
export async function readOriginalMcpApiChatMessage(storage: Storage, host: OriginalMcpNativeHost, chatId: string, sequence: number) {
  const plan = originalMcpApiChatSource(storage, host), journal = checked(storage, host), db = storage.connectNative();
  let row: Json | undefined;
  try { row = db.prepare("SELECT * FROM original_api_chat_source_messages WHERE chat_id=? AND sequence=?").get(chatId, sequence); }
  finally { db.close(); }
  if (!row) fail("Original Chat message was not indexed.");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const bytes = await messageBytes(reader, JSON.parse(row.descriptor));
    if (sha(bytes) !== row.sha256) fail("Original Chat message changed.");
    const message = validateLegacyApiChatMessage(json(bytes));
    if (message.id !== row.id || plan.planSha256 !== originalMcpApiChatSource(storage, host).planSha256) fail("Source identity changed.");
    return message;
  } finally { reader.close(); }
}
export async function readOriginalMcpApiChatMetadata(storage: Storage, host: OriginalMcpNativeHost, chatId: string) {
  const plan = originalMcpApiChatSource(storage, host);
  const journal = checked(storage, host), db = storage.connectNative();
  let row: Json | undefined;
  try { row = db.prepare("SELECT * FROM original_api_chat_source_chats WHERE id=?").get(chatId); }
  finally { db.close(); }
  if (!row) fail("Unknown original Chat identity.");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const bytes = await reader.read(row.metadata_path, 16_777_216);
    if (sha(bytes) !== row.metadata_sha256) fail("Source metadata changed.");
    const metadata = validateLegacyApiChatMetadata(json(bytes), row.namespace, chatId);
    if (originalMcpApiChatSource(storage, host).planSha256 !== plan.planSha256) fail("Source scope changed.");
    return metadata;
  } finally { reader.close(); }
}
export async function readOriginalMcpApiChatMessagePage(storage: Storage, host: OriginalMcpNativeHost,
  input: { chatId: string; afterSequence: number; limit: number; maximumBytes: number }) {
  input = z.strictObject({ chatId: z.string().uuid(), afterSequence: z.number().int().safe().nonnegative(),
    limit: z.number().int().min(1).max(100), maximumBytes: z.number().int().min(1).max(33_554_432) }).parse(input);
  const plan = originalMcpApiChatSource(storage, host), journal = checked(storage, host), db = storage.connectNative();
  const rows = db.prepare(`SELECT * FROM original_api_chat_source_messages WHERE chat_id=? AND sequence>?
    ORDER BY sequence LIMIT ?`).all(input.chatId, input.afterSequence, input.limit);
  db.close();
  const reader = await openOriginalMcpCustodyReader(journal.plan), items: Json[] = [];
  let bytes = 0, afterSequence = input.afterSequence;
  try {
    for (const row of rows) {
      const raw = await messageBytes(reader, JSON.parse(String(row.descriptor)));
      if (sha(raw) !== row.sha256) fail("Original history page changed.");
      if (bytes + raw.length > input.maximumBytes) {
        if (!items.length) fail("One source message exceeds the exact requested page budget; no history was omitted.");
        break;
      }
      const item = validateLegacyApiChatMessage(json(raw));
      if (item.id !== row.id) fail("Source message identity changed.");
      items.push(item); bytes += raw.length; afterSequence = Number(row.sequence);
    }
    if (originalMcpApiChatSource(storage, host).planSha256 !== plan.planSha256) fail("Source scope changed.");
    return { items, afterSequence, sourcePlanSha256: plan.planSha256 };
  } finally { reader.close(); }
}
