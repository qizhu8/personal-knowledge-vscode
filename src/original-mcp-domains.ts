import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy, originalMcpPrivateBytes, originalMcpPrivateTopLevels } from "./original-mcp-root-custody.js";
import { readOriginalMcpCustodyFile } from "./original-mcp-root.js";
import { readTodoBoard } from "./domain/todo-board.js";
import { decodeMarkdownPath } from "./markdown.js";
import { atomicFileCreateNoReplace } from "./file-write.js";
import { planLegacyMemoryImport, stageLegacyMemoryImport, persistLegacyMemoryImport } from "./memory-import.js";
import { persistMemoryScopeContinuity, readMemoryScopeContinuity, type MemoryScopeContinuityRequest } from "./memory-scope-continuity.js";
import { originalMcpDomainDdl, originalMcpDomainDirectory, originalMcpDomainFile, originalMcpDomainHash,
  originalMcpDomainIntentSchema, readOriginalMcpDomain, verifyOriginalMcpDomainFiles,
  originalMcpTodoSession, originalMcpWorkerSchema,
  originalMcpDomainTemporary,
  type OriginalMcpDomainIntent } from "./original-mcp-domain-state.js";
import { originalMcpSourceApprovalSchema as approvalSchema,
  type OriginalMcpDomainApprovalRequest, type OriginalMcpDomainPolicy } from "./original-mcp-source-policy-contracts.js";
import { retainOriginalMcpNativeSourceApproval, assertOriginalMcpNativeSourceApprovalCurrent,
  originalMcpNativeSourceApprovalSignal } from "./original-mcp-native-source-policy.js";
export type { OriginalMcpDomainApprovalRequest, OriginalMcpDomainPolicy } from "./original-mcp-source-policy-contracts.js";

type Domain = "todo" | "memory";
type Approval = z.infer<typeof approvalSchema>;
const live = new WeakMap<Storage, Map<Domain, {
  host: OriginalMcpNativeHost; intentSha256: string; approval: Approval; revoke(): void; revoked(): boolean;
}>>();
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message); }
function checked(storage: Storage, host: OriginalMcpNativeHost) {
  assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  const journal = assertOriginalMcpPrivacy(storage.workspaceRoot());
  if (!journal || !host.receipt.domains.includes("mcp-public")) fail("The exact original-root/native public host is required.");
  return journal;
}
async function approve(storage: Storage, host: OriginalMcpNativeHost, domain: Domain, phase: OriginalMcpDomainApprovalRequest["phase"],
  sourceSha256: string, files: OriginalMcpDomainIntent["files"], sourceDetails: OriginalMcpDomainIntent["sourceDetails"],
  policy: OriginalMcpDomainPolicy): Promise<Approval> {
  const journal = checked(storage, host);
  const request = Object.freeze({
    schema: "pkm.original-mcp-domain-approval-request/v1", domain, phase,
    root: storage.workspaceRoot(), workspaceId: journal.workspaceId,
    custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
    nativeHostReceiptSha256: host.receipt.receiptSha256, sourceSha256, actorId: "mcp:external",
    files: Object.freeze(files.map(item => Object.freeze({ ...item }))),
    sourceDetails: Object.freeze({ ...sourceDetails }),
  });
  const decision = await policy.authorize(request);
  checked(storage, host);
  const approval = approvalSchema.safeParse(decision);
  if (!approval.success || approval.data.expiresAtMs <= Date.now() || approval.data.expiresAtMs > Date.now() + 30 * 60_000)
    fail("A fresh bounded native UI decision for this exact source domain is required.");
  retainOriginalMcpNativeSourceApproval(decision, approval.data, domain, request);
  return approval.data;
}
function assertFresh(storage: Storage, host: OriginalMcpNativeHost, approval: Approval) {
  checked(storage, host);
  assertOriginalMcpNativeSourceApprovalCurrent(approval);
  if (approval.expiresAtMs <= Date.now()) fail("The native source-domain decision expired; no further publication was made.");
}
function ensureDirectory(root: string, parts: string[]) {
  let directory = root;
  for (const part of parts) {
    const parent = directory; directory = join(directory, part);
    if (!lstatSync(directory, { throwIfNoEntry: false })) {
      mkdirSync(directory, { mode: 0o700 });
      const fd = openSync(parent, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
      fail("Native domain directories must be owned private real directories.");
  }
}
function persistIntent(storage: Storage, host: OriginalMcpNativeHost, domain: Domain, sourceSha256: string,
  files: OriginalMcpDomainIntent["files"], sourceDetails: OriginalMcpDomainIntent["sourceDetails"],
  approval: Approval): OriginalMcpDomainIntent {
  assertFresh(storage, host, approval);
  const journal = checked(storage, host), root = storage.workspaceRoot(), db = storage.connectNative();
  try {
    const existing = readOriginalMcpDomain(root, domain, db);
    if (existing) {
      if (existing.intent.sourceSha256 !== sourceSha256
        || originalMcpDomainHash(existing.intent.files.map(({ stagedPath: _stage, ...item }) => item))
          !== originalMcpDomainHash(files.map(({ stagedPath: _stage, ...item }) => item))
        || originalMcpDomainHash(existing.intent.sourceDetails) !== originalMcpDomainHash(sourceDetails))
        fail("The pending or committed original domain has a different exact source; it cannot be overwritten.");
      return existing.intent;
    }
    if (lstatSync(join(root, originalMcpDomainDirectory(domain)), { throwIfNoEntry: false }))
      fail("An unowned native domain directory already exists; preserve it for reconciliation.");
    const body = {
      schema: "pkm.original-mcp-domain-intent/v1" as const, domain, root, workspaceId: journal.workspaceId,
      custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
      nativeHostReceiptSha256: host.receipt.receiptSha256, sourceSha256, ...approval, files, sourceDetails,
    };
    const intent = originalMcpDomainIntentSchema.parse({ ...body, intentSha256: originalMcpDomainHash(body) });
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_domain_intents'").get()) db.exec(originalMcpDomainDdl);
      db.prepare("INSERT INTO original_mcp_domain_intents VALUES(?,?,?)")
        .run(domain, canonicalJson(intent), intent.intentSha256);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return intent;
  } finally { db.close(); }
}
function publish(storage: Storage, host: OriginalMcpNativeHost, intent: OriginalMcpDomainIntent,
  files: Map<string, Buffer>, approval: Approval) {
  const root = storage.workspaceRoot();
  assertFresh(storage, host, approval);
  ensureDirectory(root, [originalMcpDomainDirectory(intent.domain)]);
  verifyOriginalMcpDomainFiles(root, intent.domain);
  for (const item of intent.files) {
    assertFresh(storage, host, approval);
    if (intent.domain === "todo") ensureDirectory(root, [originalMcpDomainDirectory("todo"), ...item.key.split("/")]);
    const destination = originalMcpDomainFile(root, intent.domain, item.key);
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      if (bytesHash(originalMcpPrivateBytes(destination, 536_870_912)) !== item.sha256)
        fail("Domain publication will not overwrite conflicting native bytes.");
      continue;
    }
    const bytes = files.get(item.key);
    if (!bytes || bytesHash(bytes) !== item.sha256) fail("Staged native domain bytes changed.");
    atomicFileCreateNoReplace(destination, bytes, originalMcpDomainTemporary(intent.intentSha256));
  }
  for (const temporary of verifyOriginalMcpDomainFiles(root, intent.domain)) {
    assertFresh(storage, host, approval);
    unlinkSync(temporary);
    const fd = openSync(dirname(temporary), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
async function activate(storage: Storage, host: OriginalMcpNativeHost, domain: Domain, approval: Approval) {
  assertFresh(storage, host, approval);
  const root = storage.workspaceRoot(), state = readOriginalMcpDomain(root, domain);
  if (!state?.committed) fail("Native domain publication is not committed.");
  verifyOriginalMcpDomainFiles(root, domain);
  live.get(storage)?.get(domain)?.revoke();
  const revocation = new SharedArrayBuffer(4), flag = new Int32Array(revocation);
  const sourceSignal = originalMcpNativeSourceApprovalSignal(approval);
  const revoke = () => {
    Atomics.store(flag, 0, 1);
    host.signal.removeEventListener("abort", revoke); sourceSignal?.removeEventListener("abort", revoke);
  };
  host.signal.addEventListener("abort", revoke, { once: true });
  sourceSignal?.addEventListener("abort", revoke, { once: true });
  if (host.signal.aborted || sourceSignal?.aborted) revoke();
  try {
    if (domain === "todo") {
      await storage.adoptOriginalMcpTodoSession({ ...approval, intentSha256: state.intent.intentSha256,
        nativeHostReceiptSha256: host.receipt.receiptSha256, revocation });
    } else {
      const db = storage.connectNative();
      let request: MemoryScopeContinuityRequest;
      try {
        const binding = readMemoryScopeContinuity(db, state.intent.workspaceId);
        if (!binding || binding.schema !== "pkm.memory-scope-continuity/v2") fail("The exact imported Memory continuity receipt is required.");
        const { decisionId: _decision, expiresAtMs: _expiry, ...identity } = binding;
        request = identity;
      } finally { db.close(); }
      await storage.adoptMemoryScopeContinuity(request!, approval, revocation);
    }
    assertFresh(storage, host, approval);
  } catch (error) { revoke(); throw error; }
  let domains = live.get(storage);
  if (!domains) { domains = new Map(); live.set(storage, domains); }
  domains.set(domain, { host, intentSha256: state.intent.intentSha256, approval, revoke,
    revoked: () => Atomics.load(flag, 0) !== 0 });
  return { schema: "pkm.original-mcp-domain-session/v1" as const, domain,
    intentSha256: state.intent.intentSha256, expiresAtMs: approval.expiresAtMs };
}
export interface OriginalMcpTodoWorkerPolicy {
    authorize(request: Readonly<{
      schema: "pkm.original-mcp-todo-worker-request/v1"; root: string; workspaceId: string;
      nativeHostReceiptSha256: string; intentSha256: string; boardSlug: string;
      actorId: string; tokenSha256: string; boardDigest: string;
    }>): Promise<{ actorId: string; decisionId: string; expiresAtMs: number } | null>;
  }
  /** New token only; preserved legacy tokens/hashes are never an enrollment input or proof. */
export async function enrollOriginalMcpTodoWorker(storage: Storage, host: OriginalMcpNativeHost,
    input: { boardSlug: string; actorId: string }, policy: OriginalMcpTodoWorkerPolicy) {
    input = { ...input };
    assertOriginalMcpDomainSession(storage, host, "todo");
    if (!/^external:(?:copilot|claude|other):[a-zA-Z0-9_-]{1,80}$/.test(input.actorId))
      fail("A bounded explicit external worker identity is required.");
    const root = storage.workspaceRoot(), state = readOriginalMcpDomain(root, "todo")!, session = originalMcpTodoSession(root);
    if (!state.intent.files.some(item => item.key === input.boardSlug)) fail("Worker enrollment requires an admitted exact Board.");
    const token = randomBytes(32).toString("hex"), tokenSha256 = bytesHash(Buffer.from(token));
    const board = originalMcpPrivateBytes(originalMcpDomainFile(root, "todo", input.boardSlug), 2_097_152);
    const boardDigest = bytesHash(board);
    const observed = await policy.authorize(Object.freeze({
      schema: "pkm.original-mcp-todo-worker-request/v1", root, workspaceId: state.intent.workspaceId,
      nativeHostReceiptSha256: host.receipt.receiptSha256, intentSha256: state.intent.intentSha256,
      boardSlug: input.boardSlug, actorId: input.actorId, tokenSha256, boardDigest,
    }));
    assertOriginalMcpDomainSession(storage, host, "todo");
    const parsed = originalMcpWorkerSchema.pick({ actorId: true, decisionId: true, expiresAtMs: true }).safeParse(observed);
    if (!parsed.success) fail("A typed native worker decision is required.");
    const decision = parsed.data;
    if (decision.actorId !== input.actorId || !decision.decisionId || decision.decisionId.length > 256
      || !Number.isSafeInteger(decision.expiresAtMs) || decision.expiresAtMs <= Date.now()
      || decision.expiresAtMs > session.expiresAtMs)
      fail("A fresh exact Board/worker native decision within the current Todo session is required.");
    return storage.withWorkspaceExclusive(async () => {
      assertOriginalMcpDomainSession(storage, host, "todo");
      const now = originalMcpTodoSession(root);
      if (now.decisionId !== session.decisionId || now.nativeHostReceiptSha256 !== host.receipt.receiptSha256
        || decision.expiresAtMs <= Date.now()
        || bytesHash(originalMcpPrivateBytes(originalMcpDomainFile(root, "todo", input.boardSlug), 2_097_152)) !== boardDigest)
        fail("Worker enrollment changed during exact native review.");
      const body = { schema: "pkm.original-mcp-todo-worker/v1" as const, intentSha256: state.intent.intentSha256,
        nativeHostReceiptSha256: host.receipt.receiptSha256, sessionDecisionId: session.decisionId,
        boardSlug: input.boardSlug, actorId: input.actorId, tokenSha256, decisionId: decision.decisionId,
        expiresAtMs: decision.expiresAtMs };
      const worker = originalMcpWorkerSchema.parse({ ...body, receiptSha256: originalMcpDomainHash(body) });
      const db = storage.connectNative();
      try { db.prepare("INSERT INTO original_mcp_domain_workers VALUES(?,?)").run(worker.receiptSha256, canonicalJson(worker)); }
      finally { db.close(); }
      await storage.adoptOriginalMcpTodoWorker(worker.receiptSha256);
      assertOriginalMcpDomainSession(storage, host, "todo");
      return { token, receiptSha256: worker.receiptSha256, expiresAtMs: worker.expiresAtMs };
    });
  }
export function assertOriginalMcpDomainSession(storage: Storage, host: OriginalMcpNativeHost, domain: Domain): void {
  checked(storage, host);
  const session = live.get(storage)?.get(domain), state = readOriginalMcpDomain(storage.workspaceRoot(), domain);
  if (!session || session.host !== host || session.revoked() || !state?.committed || session.intentSha256 !== state.intent.intentSha256
    || session.approval.expiresAtMs <= Date.now())
    fail(domain === "todo" ? "ORIGINAL_BOARD_AND_WORKER_REBIND_REQUIRED: fresh exact native Todo source admission is required."
      : "ORIGINAL_MEMORY_SCOPE_ADMISSION_REQUIRED: fresh exact native Memory source/actor continuity admission is required.");
  assertOriginalMcpNativeSourceApprovalCurrent(session.approval);
}
export async function activateOriginalMcpDomain(storage: Storage, host: OriginalMcpNativeHost, domain: Domain,
  policy: OriginalMcpDomainPolicy) {
  const root = checked(storage, host).plan.root, state = readOriginalMcpDomain(root, domain);
  if (!state?.committed) fail("An independently completed typed source hydration is required before reactivation.");
  const approval = await approve(storage, host, domain, "activate", state.intent.sourceSha256, state.intent.files, state.intent.sourceDetails, policy);
  return storage.withWorkspaceExclusive(() => activate(storage, host, domain, approval));
}
export async function hydrateOriginalMcpTodo(storage: Storage, host: OriginalMcpNativeHost,
  slugs: readonly string[], policy: OriginalMcpDomainPolicy) {
  const journal = checked(storage, host), files: OriginalMcpDomainIntent["files"] = [], bytes = new Map<string, Buffer>();
  if (!slugs.length || slugs.length > 1024 || new Set(slugs).size !== slugs.length) fail("Select a bounded unique original Board source set.");
  for (const key of [...slugs].sort()) {
    if (!key.split("/").every(part => !!part && !part.startsWith(".") && !/[\\:\u0000-\u001f]/u.test(part))
      || originalMcpPrivateTopLevels(journal.plan.root, "notes").has(key.split("/")[0]!))
      fail("Private or unsafe original Boards require a separate native private-data admission.");
    const sourcePath = `notes/${key}.assets/pkm-todo-board.json`, notePath = `notes/${key}.md`;
    const board = await readOriginalMcpCustodyFile(journal.plan, sourcePath, 2_097_152);
    const note = await readOriginalMcpCustodyFile(journal.plan, notePath, 1_048_576);
    readTodoBoard(board.toString("utf8"));
    const title = decodeMarkdownPath(note.toString("utf8"), `${key}.md`).record.title;
    files.push({ key, sourcePath, notePath, noteSha256: bytesHash(note), sha256: bytesHash(board), title }); bytes.set(key, board);
  }
  const sourceSha256 = originalMcpDomainHash(files);
  const sourceDetails = { domain: "todo" as const, boards: files.length };
  const approval = await approve(storage, host, "todo", "hydrate-and-activate", sourceSha256, files, sourceDetails, policy);
  return storage.withWorkspaceExclusive(async () => {
    assertFresh(storage, host, approval);
    // Repeat selected-source verification after the native UI await and before any journal write.
    for (const item of files) {
      if (bytesHash(await readOriginalMcpCustodyFile(journal.plan, item.sourcePath!, 2_097_152)) !== item.sha256
        || bytesHash(await readOriginalMcpCustodyFile(journal.plan, item.notePath!, 1_048_576)) !== item.noteSha256)
        fail("Original Board/Note source changed during native review.");
    }
    const intent = persistIntent(storage, host, "todo", sourceSha256, files, sourceDetails, approval);
    const existing = readOriginalMcpDomain(journal.plan.root, "todo");
    if (!existing?.committed) {
      policy.checkpoint?.("intent-durable");
      publish(storage, host, intent, bytes, approval);
      policy.checkpoint?.("files-durable");
      const db = storage.connectNative();
      try { assertFresh(storage, host, approval); db.prepare("INSERT INTO original_mcp_domain_commits VALUES('todo',?)").run(intent.intentSha256); }
      finally { db.close(); }
    }
    return activate(storage, host, "todo", approval);
  });
}
export async function hydrateOriginalMcpMemory(storage: Storage, host: OriginalMcpNativeHost,
  options: { sourceSnapshot: string; sourceScopeSha256: string; stagingDirectory: string }, policy: OriginalMcpDomainPolicy) {
  options = { ...options };
  const journal = checked(storage, host), root = journal.plan.root, stage = resolve(options.stagingDirectory);
  const rel = relative(root, stage);
  if (stage !== options.stagingDirectory || realpathSync(stage) !== stage || !isAbsolute(stage)
    || !rel || !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    fail("Memory staging must be a separate private operator-owned directory outside the original root.");
  const stageStat = lstatSync(stage);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || stageStat.uid !== process.getuid?.() || (stageStat.mode & 0o7077) !== 0)
    fail("Memory staging must be an existing private owned directory.");
  const plan = await planLegacyMemoryImport(options.sourceSnapshot, root, "mcp:external", options.sourceScopeSha256);
  const staged = await stageLegacyMemoryImport(plan, stage, { documentIdentity: "source-derived/v1" }), files: OriginalMcpDomainIntent["files"] = [];
  const bytes = new Map<string, Buffer>();
  for (const item of staged.receipt.documents) {
    const raw = readFileSync(join(stage, item.path));
    if (bytesHash(raw) !== item.sha256) fail("Staged Memory differs from the real importer receipt.");
    files.push({ key: item.id, sha256: item.sha256, stagedPath: join(stage, item.path) }); bytes.set(item.id, raw);
  }
  const sourceSha256 = originalMcpDomainHash({ plan, receipt: staged.receipt });
  const sourceDetails = { domain: "memory" as const, sourceDatabaseSha256: plan.sourceSha256,
    documentIdentity: "source-derived/v1" as const,
    sourceScopeSha256: options.sourceScopeSha256, importPlanSha256: plan.planSha256,
    importReceiptSha256: staged.receipt.receiptSha256, engineIdentity: plan.engineIdentity, records: plan.records, revisions: plan.revisions };
  const approval = await approve(storage, host, "memory", "hydrate-and-activate", sourceSha256, files, sourceDetails, policy);
  return storage.withWorkspaceExclusive(async () => {
    const current = await planLegacyMemoryImport(options.sourceSnapshot, root, "mcp:external", options.sourceScopeSha256);
    if (current.planSha256 !== plan.planSha256) fail("Memory source changed during native review.");
    const intent = persistIntent(storage, host, "memory", sourceSha256, files, sourceDetails, approval);
    if (!readOriginalMcpDomain(root, "memory")?.committed) {
      policy.checkpoint?.("intent-durable");
      publish(storage, host, intent, bytes, approval);
      policy.checkpoint?.("files-durable");
      const db = storage.connectNative();
      try {
        assertFresh(storage, host, approval); db.exec("BEGIN IMMEDIATE");
        persistLegacyMemoryImport(db, journal.workspaceId, staged);
        const scope = plan.scopes.find(value => bytesHash(Buffer.from(value)) === options.sourceScopeSha256);
        if (!scope) fail("Exact source Memory scope selection is required.");
        persistMemoryScopeContinuity(db, { schema: "pkm.memory-scope-continuity/v2", workspaceId: journal.workspaceId,
          scope, sourceScopeSha256: options.sourceScopeSha256, sourceDatabaseSha256: plan.sourceSha256,
          importPlanSha256: plan.planSha256, importReceiptSha256: staged.receipt.receiptSha256, ...approval });
        db.prepare("INSERT INTO original_mcp_domain_commits VALUES('memory',?)").run(intent.intentSha256);
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      finally { db.close(); }
    }
    return activate(storage, host, "memory", approval);
  });
}
