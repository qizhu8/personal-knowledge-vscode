import { CoreError, type Actor } from "./contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpNativeChatRpcPort } from "./original-mcp-native-chat-rpc.js";
import { readOriginalMcpApiChatBinding, assertOriginalMcpApiChatBinding } from "./original-mcp-api-chat-binding.js";
import { assertOriginalMcpDomainSession } from "./original-mcp-domains.js";
import { originalMcpDomainHash, readOriginalMcpTodoAuthority } from "./original-mcp-domain-state.js";
import { planTodo, scanBoards } from "./boards.js";
import { sha256 } from "./markdown.js";
import { todoDefinitions } from "./todo-definitions.js";
import { readOriginalMcpTodoAgentList } from "./original-mcp-todo-chat.js";
import { readOriginalMcpApiChatSourceSession, type OriginalMcpApiChatSourceSessionAuthority } from "./original-mcp-api-chat-source.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { captureOriginalTodoAssignmentSourcePins, originalTodoAssignmentBindingPins, originalTodoAssignmentRecord,
  originalTodoAssignmentAdmissionSchema, type OriginalTodoAssignmentAdmission } from "./original-mcp-todo-assignment-gate.js";
import { isOriginalTodoChatAssignment } from "./original-mcp-todo-assignment-gate.js";

export interface OriginalMcpTodoAssignmentArguments {
  board_slug: string; id: string; owner_id: string; expected_digest: string; reason: string; operationId: string;
}
export interface OriginalMcpTodoChatAssignmentGuard {
  readonly schema: "pkm.original-mcp-todo-chat-assignment-guard/v1";
  readonly root: string; readonly workspaceId: string; readonly actorId: string;
  readonly requestSha256: string; readonly operationId: string; readonly boardSlug: string;
  readonly boardDigest: string; readonly workItemId: string; readonly ownerId: string; readonly chatUrl: string;
  readonly coreSessionId: string; readonly coreRevision: number;
  readonly intentSha256: string; readonly sessionDecisionId: string; readonly workerReceiptSha256?: string;
  readonly nativeHostReceiptSha256: string; readonly sourcePlanSha256: string;
  readonly chatSourceDecisionId: string;
  readonly nativeEpoch: string; readonly nativeRequestId: string;
  readonly nativeBrokerId: string; readonly nativeActivationId: string; readonly nativeIdentitySha256: string;
  readonly ownerLease: Readonly<{ ownerId: string; fence: number }>;
  readonly expiresAtMs: number;
}
export interface OriginalMcpPreparedTodoChatAssignment {
  readonly schema: "pkm.original-mcp-todo-chat-assignment-prepared/v1";
  readonly arguments: Readonly<OriginalMcpTodoAssignmentArguments>;
  readonly guard: Readonly<OriginalMcpTodoChatAssignmentGuard>;
  readonly revocation: SharedArrayBuffer; readonly todoRevocation: SharedArrayBuffer;
  readonly chatSourceAuthority: Readonly<OriginalMcpApiChatSourceSessionAuthority>;
  readonly chatSourceRevocation: SharedArrayBuffer;
  assertCurrent(): Promise<void>;
  revoke(): void;
}
/**
 * Private storage admission. chatSourceRevocation must come from the actual source-consent
 * lifetime, not a new buffer or a socket-liveness boolean. Inside the same worker transaction,
 * compare guard.ownerLease, current Todo session/worker receipt, all revocations/deadlines,
 * and the canonical same-actor Chat id/revision before receipt replay, recovery or Board write.
 * Persist the exact guard with a pending assignment; lost runtime admission on restart grants nothing.
 */
export type OriginalMcpTodoChatAssignmentWorkerAdmission = OriginalTodoAssignmentAdmission;
const prepared = new WeakMap<object, { owner: RootOwner; host: OriginalMcpNativeHost; actor: Readonly<Actor> }>();
const definition = todoDefinitions.find(item => item.id === "todo.workitem.assign")!;
function deny(message: string): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message); }

/**
 * Prepare only. Canonical Storage consumes the private guard atomically in its worker before
 * receipt replay and publication; calling ordinary Core dispatch after this snapshot is not that gate.
 * Intercept every original-source Chat target without a native-existence fallback; other targets keep their canonical path.
 */
export async function prepareOriginalMcpTodoChatAssignment(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, input: unknown): Promise<OriginalMcpPreparedTodoChatAssignment> {
  actor = Object.freeze({ ...actor, ...(actor.boardWorker ? { boardWorker: Object.freeze({ ...actor.boardWorker }) } : {}) });
  const args = Object.freeze(definition.input.parse(structuredClone(input)) as OriginalMcpTodoAssignmentArguments);
  if (actor.canWrite !== true || actor.id === "mcp:external" && actor.boardWorker
    || actor.id !== "mcp:external" && !actor.boardWorker)
    throw new CoreError("ACCESS_DENIED", "Original Chat assignment requires the authenticated manager or a freshly authenticated exact Board worker.");
  if (!/^chat:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.owner_id))
    throw new CoreError("NOT_AVAILABLE", "This private consumer is only for original Chat targets; ordinary native assignment is unchanged.");
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull(), root = storage.workspaceRoot();
  assertOriginalMcpDomainSession(storage, host, "todo");
  const authority = readOriginalMcpTodoAuthority(root, actor.id, args.board_slug);
  if (authority.nativeHostReceiptSha256 !== host.receipt.receiptSha256)
    deny("Todo source authority belongs to a different native Host.");
  if (actor.boardWorker && (actor.boardWorker.boardSlug !== args.board_slug || actor.boardWorker.digest !== args.expected_digest))
    throw new CoreError("ACCESS_DENIED", "The worker's authenticated Board snapshot does not match this assignment.");
  const binding = await readOriginalMcpApiChatBinding(owner, host, actor, args.owner_id.slice("chat:".length));
  assertOriginalMcpApiChatBinding(binding);
  if (binding.ownerId !== args.owner_id || binding.coreSessionId !== args.owner_id.slice("chat:".length) || binding.actorId !== actor.id)
    deny("The live binding must preserve the exact original Chat UUID and authenticated actor.");
  assertOriginalMcpNativeChatRpcPort(host.nativeChat);
  const native = host.nativeChat!.session;
  const chatSource = readOriginalMcpApiChatSourceSession(storage, host);
  if (chatSource.actorId !== actor.id || chatSource.planSha256 !== binding.sourcePlanSha256
    || chatSource.nativeHostReceiptSha256 !== host.receipt.receiptSha256 || chatSource.epoch !== binding.nativeEpoch)
    deny("The original Chat binding and current source consent must have the same actor, source and native Host epoch.");
  const guard: OriginalMcpTodoChatAssignmentGuard = Object.freeze({
    schema: "pkm.original-mcp-todo-chat-assignment-guard/v1" as const,
    root, workspaceId: host.receipt.workspaceId, actorId: actor.id,
    requestSha256: originalMcpDomainHash({ operation: "todo.workitem.assign", version: 1, actor, arguments: args }),
    operationId: args.operationId, boardSlug: args.board_slug, boardDigest: args.expected_digest,
    workItemId: args.id, ownerId: binding.ownerId, chatUrl: binding.chatUrl,
    coreSessionId: binding.coreSessionId, coreRevision: binding.coreRevision,
    intentSha256: authority.intentSha256, sessionDecisionId: authority.sessionDecisionId,
    ...(authority.workerReceiptSha256 ? { workerReceiptSha256: authority.workerReceiptSha256 } : {}),
    nativeHostReceiptSha256: binding.nativeHostReceiptSha256, sourcePlanSha256: binding.sourcePlanSha256,
    chatSourceDecisionId: chatSource.decisionId,
    nativeEpoch: binding.nativeEpoch, nativeRequestId: binding.nativeRequestId,
    nativeBrokerId: native.brokerId, nativeActivationId: native.activationId, nativeIdentitySha256: native.identitySha256,
    ownerLease: Object.freeze({ ...binding.ownerLease }),
    expiresAtMs: Math.min(authority.expiresAtMs, binding.expiresAtMs, chatSource.expiresAtMs),
  });
  const revocation = new SharedArrayBuffer(4), flag = new Int32Array(revocation);
  let revoked = false;
  const signals = [host.signal, binding.signal];
  const revoke = () => {
    revoked = true; Atomics.store(flag, 0, 1);
    for (const signal of signals) signal.removeEventListener("abort", revoke);
  };
  for (const signal of signals) {
    signal.addEventListener("abort", revoke, { once: true });
    if (signal.aborted) revoke();
  }
  const result: OriginalMcpPreparedTodoChatAssignment = Object.freeze({
    schema: "pkm.original-mcp-todo-chat-assignment-prepared/v1" as const, arguments: args, guard,
    revocation, todoRevocation: authority.revocation, chatSourceAuthority: chatSource, chatSourceRevocation: chatSource.revocation, revoke,
    async assertCurrent() {
      try {
        if (revoked || Atomics.load(flag, 0) !== 0 || guard.expiresAtMs <= Date.now()
          || Atomics.load(new Int32Array(chatSource.revocation), 0) !== 0)
          deny("The prepared original Chat assignment expired or was revoked; no effect was dispatched.");
        assertRootOwner(owner); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
        assertOriginalMcpDomainSession(storage, host, "todo");
        const currentSource = readOriginalMcpApiChatSourceSession(storage, host);
        if (currentSource.decisionId !== chatSource.decisionId || currentSource.revocation !== chatSource.revocation)
          deny("A new Chat source consent cannot be inherited by an older prepared assignment.");
        assertOriginalMcpApiChatBinding(binding);
        const pendingDb = storage.connectNative();
        let ownedPending = false;
        try {
          const record = originalTodoAssignmentRecord(pendingDb, args.operationId);
          const pending = pendingDb.prepare("SELECT * FROM pending_todo WHERE operation_id=?").get(args.operationId);
          if (record && pending && record.guard_sha256 === sha256(String(record.guard_json))) {
            const owned = JSON.parse(String(record.guard_json)), { revocation: _revocation, ...sourceIdentity } = chatSource;
            ownedPending = originalMcpDomainHash(owned.guard) === originalMcpDomainHash(guard)
              && originalMcpDomainHash(owned.actor) === originalMcpDomainHash(actor)
              && originalMcpDomainHash(owned.source) === originalMcpDomainHash(sourceIdentity)
              && owned.bindingSha256 === originalTodoAssignmentBindingPins(pendingDb, guard)
              && originalMcpDomainHash(owned.sourcePins) === originalMcpDomainHash(captureOriginalTodoAssignmentSourcePins(root, pendingDb, binding.coreSessionId))
              && pending.operation === "todo.workitem.assign" && pending.actor_id === actor.id
              && pending.before_sha256 === guard.boardDigest && pending.result === record.result_json
              && sha256(String(pending.after_json)) === record.after_sha256;
          }
        } finally { pendingDb.close(); }
        if (!ownedPending) {
          const directory = await readOriginalMcpTodoAgentList(owner, host, actor, {
            board_slug: args.board_slug, query: args.owner_id, limit: 100,
          });
          if (!directory.items.some(item => item.id === binding.ownerId && item.chatUrl === binding.chatUrl))
            deny("The exact original Chat source/Trash directory changed before assignment preparation.");
        }
        await binding.assertCurrent();
        await storage.withWorkspaceExclusive(() => {
          assertOriginalMcpDomainSession(storage, host, "todo");
          const db = storage.connectNative();
          try {
            const current = readOriginalMcpTodoAuthority(root, actor.id, args.board_slug, db);
            if (current.intentSha256 !== authority.intentSha256 || current.sessionDecisionId !== authority.sessionDecisionId
              || current.nativeHostReceiptSha256 !== authority.nativeHostReceiptSha256
              || current.workerReceiptSha256 !== authority.workerReceiptSha256 || current.revocation !== authority.revocation)
              deny("Fresh Todo manager/worker authority changed; a retained prepared request cannot inherit it.");
            const board = scanBoards(root, db).get(args.board_slug);
            const record = originalTodoAssignmentRecord(db, args.operationId);
            if (record && record.guard_sha256 === sha256(String(record.guard_json))) {
              const owned = JSON.parse(String(record.guard_json));
              const request = { operation: "todo.workitem.assign", args: { ...args }, actorId: actor.id,
                ...(actor.boardWorker ? { boardWorker: actor.boardWorker } : {}) };
              const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(args.operationId);
              const pending = db.prepare("SELECT * FROM pending_todo WHERE operation_id=?").get(args.operationId);
              const { revocation: _revocation, ...sourceIdentity } = chatSource;
              if (record.request_json === canonicalJson(request)) {
                if (originalMcpDomainHash(owned.guard) === originalMcpDomainHash(guard)
                  && originalMcpDomainHash(owned.actor) === originalMcpDomainHash(actor)
                  && originalMcpDomainHash(owned.source) === originalMcpDomainHash(sourceIdentity)
                  && owned.bindingSha256 === originalTodoAssignmentBindingPins(db, guard)
                  && originalMcpDomainHash(owned.sourcePins) === originalMcpDomainHash(captureOriginalTodoAssignmentSourcePins(root, db, binding.coreSessionId))
                  && ((receipt && receipt.fingerprint === record.fingerprint && receipt.actor_id === actor.id
                    && receipt.operation === "todo.workitem.assign" && JSON.parse(String(receipt.result)).digest === record.after_sha256)
                    || (pending && pending.fingerprint === record.fingerprint && pending.actor_id === actor.id
                      && pending.operation === "todo.workitem.assign" && sha256(String(pending.after_json)) === record.after_sha256))) return;
              }
            }
            if (!board || sha256(board.raw) !== args.expected_digest)
              throw new CoreError("CONFLICT", "The exact Board digest changed before original Chat assignment.");
            const plan = planTodo(root, { operation: "todo.workitem.assign", actorId: actor.id, args: { ...args },
              ...(actor.boardWorker ? { boardWorker: actor.boardWorker } : {}) }, () => [{
              hostSessionId: binding.coreSessionId, title: binding.ownerId, chatUrl: binding.chatUrl,
            }], db);
            if (!plan.write || plan.write.before !== guard.boardDigest)
              deny("The canonical Todo domain did not prepare this exact Board assignment.");
          } finally { db.close(); }
        });
        await binding.assertCurrent();
        if (revoked || guard.expiresAtMs <= Date.now() || Atomics.load(new Int32Array(authority.revocation), 0) !== 0
          || Atomics.load(new Int32Array(chatSource.revocation), 0) !== 0)
          deny("Native assignment authority changed while the read-only preconditions were checked.");
      } catch (error) { revoke(); throw error; }
    },
  });
  prepared.set(result, { owner, host, actor });
  try { await result.assertCurrent(); return result; }
  catch (error) { revoke(); throw error; }
}

/** Storage-only conversion: caller-created DTOs or replacement buffers never enter the worker channel. */
export async function readOriginalMcpTodoAssignmentAdmission(value: unknown, owner: RootOwner): Promise<OriginalTodoAssignmentAdmission> {
  const scope = value && typeof value === "object" ? prepared.get(value) : undefined;
  if (!scope || scope.owner !== owner) deny("Only the actual prepared assignment can enter canonical Storage.");
  const actual = value as OriginalMcpPreparedTodoChatAssignment;
  await actual.assertCurrent();
  const { storage } = await owner.ensureFull(), db = storage.connectNative();
  try {
    const source = readOriginalMcpApiChatSourceSession(storage, scope.host);
    if (source.revocation !== actual.chatSourceRevocation || source.decisionId !== actual.guard.chatSourceDecisionId)
      deny("The actual source revocation resource changed before Storage admission.");
    return originalTodoAssignmentAdmissionSchema.parse({
      schema: "pkm.original-mcp-todo-assignment-storage/v1", actor: scope.actor, arguments: { ...actual.arguments },
      guard: actual.guard, revocation: actual.revocation, todoRevocation: actual.todoRevocation,
      chatSourceRevocation: source.revocation, chatSourceAuthority: source,
      bindingSha256: originalTodoAssignmentBindingPins(db, actual.guard),
      sourcePins: captureOriginalTodoAssignmentSourcePins(storage.workspaceRoot(), db, actual.guard.coreSessionId),
    });
  } finally { db.close(); }
}

export async function assertOriginalMcpPreparedTodoChatAssignment(value: unknown, owner: RootOwner,
  host: OriginalMcpNativeHost): Promise<void> {
  const scope = value && typeof value === "object" ? prepared.get(value) : undefined;
  if (!scope || scope.owner !== owner || scope.host !== host)
    deny("A genuine prepared same-owner original Todo Chat assignment is required; JSON copies are not authority.");
  await (value as OriginalMcpPreparedTodoChatAssignment).assertCurrent();
}

/** Fixed parent mutation hook, after canonical validation/principal authentication. Never fall back for an original source ID. */
export async function dispatchOriginalMcpTodoChatAssignment(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, input: unknown): Promise<Record<string, unknown> | undefined> {
  const args = definition.input.parse(structuredClone(input)) as OriginalMcpTodoAssignmentArguments;
  const { storage } = await owner.ensureFull(), db = storage.connectNative();
  try {
    if (!isOriginalTodoChatAssignment(storage.workspaceRoot(), db, { operation: "todo.workitem.assign", args: { ...args }, actorId: actor.id }))
      return undefined;
  } finally { db.close(); }
  const candidate = await prepareOriginalMcpTodoChatAssignment(owner, host, actor, args);
  return definition.output.parse(await storage.requestOriginalMcpTodoChatAssignment(candidate)) as Record<string, unknown>;
}
