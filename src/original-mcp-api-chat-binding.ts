import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalMcpApiChatSource, originalMcpApiChatSourceDeadline, readOriginalMcpApiChatSourceSession,
  type OriginalMcpApiChatSourceSessionAuthority } from "./original-mcp-api-chat-source.js";
import { chatSessionRecord } from "./chat-session-contracts.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";

export interface OriginalMcpApiChatBindingSnapshot {
  readonly ownerId: string; readonly chatUrl: string; readonly coreSessionId: string; readonly coreRevision: number;
  readonly actorId: string; readonly sourcePlanSha256: string; readonly nativeHostReceiptSha256: string;
  readonly nativeEpoch: string; readonly nativeRequestId: string; readonly expiresAtMs: number;
  readonly brokerId: string; readonly activationId: string; readonly identitySha256: string; readonly signal: AbortSignal;
  readonly ownerLease: Readonly<{ ownerId: string; fence: number }>;
  readonly sourceApproval: OriginalMcpApiChatSourceSessionAuthority;
  assertCurrent(): Promise<void>;
}
const bindings = new WeakMap<object, () => void>();
function fail(): never {
  throw new CoreError("NOT_AVAILABLE",
    "ORIGINAL_CHAT_CURRENT_BINDING_REQUIRED: perform a fresh native continuation in this exact source/actor/host epoch; retained mappings are not live authority.");
}
export function assertOriginalMcpApiChatBinding(value: unknown): asserts value is OriginalMcpApiChatBindingSnapshot {
  const check = value && typeof value === "object" ? bindings.get(value) : undefined;
  if (!check) fail();
  check();
}

/** Branded read-only identity evidence; not Todo assignment, worker or atomic effect authority. */
export async function readOriginalMcpApiChatBinding(owner: RootOwner, host: OriginalMcpNativeHost,
  actorInput: Readonly<Actor>, locator: string): Promise<OriginalMcpApiChatBindingSnapshot> {
  assertRootOwner(owner);
  const actor = Object.freeze({ ...actorInput });
  if (actor.id !== "mcp:external" || actor.boardWorker) fail();
  const raw = locator.replace(/^chat:/, ""), parsed = /^pkm:\/\/chats\/([a-f0-9]{16})\/(.+)$/.exec(raw);
  const id = z.string().uuid().parse(parsed?.[2] ?? raw);
  const { storage, runtime } = await owner.ensureFull();
  assertOriginalMcpNativeHost(host, storage);
  const resource = host.nativeChat;
  if (!resource?.apiChat) fail();
  const signal = AbortSignal.any([host.signal, resource.signal]), lease = originalNativeChatDigest(owner.workspaceLease());
  const source = originalMcpApiChatSource(storage, host), expiresAtMs = originalMcpApiChatSourceDeadline(storage, host);
  const sourceApproval = readOriginalMcpApiChatSourceSession(storage, host);
  const readPins = () => {
    assertRootOwner(owner); assertOriginalMcpNativeHost(host, storage); resource.assertCurrent();
    if (signal.aborted || originalNativeChatDigest(owner.workspaceLease()) !== lease
      || originalMcpApiChatSource(storage, host).planSha256 !== source.planSha256
      || originalMcpApiChatSourceDeadline(storage, host) !== expiresAtMs || expiresAtMs <= Date.now()) fail();
    const observedSource = readOriginalMcpApiChatSourceSession(storage, host);
    if (observedSource.decisionId !== sourceApproval.decisionId
      || observedSource.revocation !== sourceApproval.revocation
      || Atomics.load(new Int32Array(sourceApproval.revocation), 0) !== 0) fail();
    const db = storage.connectNative();
    try {
      const chat = db.prepare("SELECT namespace FROM original_api_chat_source_chats WHERE id=? AND trashed_at IS NULL").get(id);
      if (!chat || parsed && parsed[1] !== chat.namespace) fail();
      for (const table of ["original_api_chat_current_chats", "original_api_chat_responses", "original_native_chat_executions"])
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail();
      const row = db.prepare(`SELECT r.request_id,r.selection,r.active,r.status,r.engine,s.epoch,s.status AS request_status,
        q.operation,q.arguments,e.plan,e.plan_sha256,e.status AS execution_status,c.model_selection
        FROM original_api_chat_current_chats c JOIN original_api_chat_responses r ON r.chat_id=c.id
        JOIN original_api_chat_request_state s ON s.request_id=r.request_id
        JOIN original_api_chat_requests q ON q.request_id=r.request_id
        JOIN original_native_chat_executions e ON e.request_id=r.request_id WHERE c.id=?`).get(id);
      if (!row || row.epoch !== host.receipt.epoch || row.request_status !== "succeeded" || row.operation !== "send"
        || row.active !== 0 || row.status !== "complete" || row.execution_status !== "complete" || row.engine !== "native-original")
        fail();
      const url = `pkm://chats/${chat.namespace}/${id}`, plan = JSON.parse(String(row.plan));
      const selection = JSON.parse(String(row.selection)), model = JSON.parse(String(row.model_selection));
      if (plan.chatUrl !== url || plan.sourcePlanSha256 !== source.planSha256 || selection.epoch !== host.receipt.epoch
        || plan.requestId !== row.request_id || originalNativeChatDigest(plan) !== row.plan_sha256
        || selection.provider !== "vscode" || originalNativeChatDigest(selection) !== originalNativeChatDigest(model)
        || !db.prepare("SELECT 1 FROM original_native_chat_inferences WHERE request_id=? AND authorized=1").get(row.request_id))
        fail();
      const prepared = db.prepare(`SELECT payload FROM original_native_chat_events
        WHERE request_id=? AND type='execution-prepared' ORDER BY sequence LIMIT 1`).get(row.request_id);
      if (!prepared || originalNativeChatDigest(JSON.parse(String(prepared.payload)).ownerLease) !== lease) fail();
      return { chatUrl: url, requestId: String(row.request_id),
        digest: originalNativeChatDigest({ row, namespace: chat.namespace }) };
    } finally { db.close(); }
  };
  const initial = readPins();
  const readSession = async () => {
    const response = await runtime.core.dispatch("capability_read",
      { operation: "chat.session.get", version: 1, arguments: { id } }, actor);
    if (response.error) fail();
    const session = chatSessionRecord.parse(response.result);
    if (session.id !== id || session.archivedAt) fail();
    return session;
  };
  const session = await readSession();
  if (readPins().digest !== initial.digest) fail();
  const check = () => { if (readPins().digest !== initial.digest) fail(); };
  const snapshot: OriginalMcpApiChatBindingSnapshot = Object.freeze({
    ownerId: `chat:${id}`, chatUrl: initial.chatUrl, coreSessionId: id, coreRevision: session.revision,
    actorId: actor.id, sourcePlanSha256: source.planSha256, nativeHostReceiptSha256: host.receipt.receiptSha256,
    nativeEpoch: host.receipt.epoch, nativeRequestId: initial.requestId, expiresAtMs, signal,
    brokerId: resource.session.brokerId, activationId: resource.session.activationId,
    identitySha256: resource.session.identitySha256,
    ownerLease: Object.freeze({ ...owner.workspaceLease() }),
    sourceApproval,
    async assertCurrent() {
      check();
      if ((await readSession()).revision !== session.revision) fail();
      check();
    },
  });
  bindings.set(snapshot, check);
  return snapshot;
}
