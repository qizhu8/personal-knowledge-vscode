import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { coreDatabaseAuxiliaryFiles, coreDatabaseFile, coreDatabaseSidecarFiles, coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { legacyPrivateRootGuard, sameLegacyPrivateRoot } from "./legacy-effective-private-root.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertOriginalMcpPrivacy, jsonDigest, originalMcpJournal, originalMcpJournalSchema, originalMcpPrivateBytes,
  parseOriginalMcpPlan, readOriginalMcpJournal, type OriginalMcpPlan } from "./original-mcp-root-custody.js";
import { STORAGE_BOOTSTRAP_PROFILE_JSON } from "./storage-bootstrap-profile.js";
import type { OriginalMcpPrepared } from "./original-mcp-root.js";
import type { OriginalMcpRetirementTicket } from "./original-mcp-retirement.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { verifyOriginalMcpOptionalSchemaGroup } from "./original-mcp-sqlite-schema.js";
import { verifyOriginalApiChatOptionalReadSchema } from "./original-mcp-api-chat-schema.js";

export interface OriginalMcpColdSqliteReadContext { readonly kind: "pkm.original-mcp-cold-sqlite-read/v1" }
export interface OriginalMcpRetirementSqliteJournalContext { readonly kind: "pkm.original-mcp-retirement-sqlite-journal/v1" }
export interface OriginalMcpSqliteReadDatabase {
  prepare(sql: string): {
    get(...parameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...parameters: SQLInputValue[]): Array<Record<string, SQLOutputValue>>;
    iterate(...parameters: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
  };
}
interface State {
  root: string; planSha256: string; fence: LinuxRootWriterFence; database: DatabaseSync;
  reader: OriginalMcpSqliteReadDatabase; active: boolean; assertCurrent(): void; close(): void;
}
const contexts = new WeakMap<object, State>(), current = new AsyncLocalStorage<OriginalMcpColdSqliteReadContext>();
const retirementJournals = new WeakMap<object, { root: string; planSha256: string; fence: LinuxRootWriterFence;
  active: boolean; assertCurrent(): void }>();
const maximumDatabaseBytes = 536_870_912;
const auxiliaryNames = coreDatabaseAuxiliaryFiles;
const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink,
  stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
function fail(message: string, uncertain = false): never {
  throw new CoreError("RECOVERY_REQUIRED", message, uncertain ? "unknown" : "not-committed");
}
/** Archived control authority exists only for the exact held retirement and its independently retained B1. */
export async function withOriginalMcpRetirementSqliteJournal<T>(input: OriginalMcpPlan, expected: OriginalMcpPrepared,
  ticket: OriginalMcpRetirementTicket, fence: LinuxRootWriterFence,
  work: (context: OriginalMcpRetirementSqliteJournalContext) => Promise<T>): Promise<T> {
  const plan = parseOriginalMcpPlan(input), { ticketSha256, ...ticketBody } = ticket;
  if (!isTrustedLinuxRootWriterFence(fence, plan.root)) fail("Archived journal reading requires the actual retirement fence.");
  fence.assertHeld(); await assertLinuxLegacyWritersQuiescent(plan.root); fence.assertHeld();
  const archive = join(plan.root, `.pkm-next-original-mcp-retired-${expected.workspaceId}`);
  if (ticket.schema !== "pkm.original-mcp-retirement-ticket/v1" || ticket.scope !== "native-dogfood/v1"
    || ticketSha256 !== jsonDigest(ticketBody) || ticket.archive !== archive
    || expected.root !== plan.root || expected.planSha256 !== plan.planSha256
    || ["root", "workspaceId", "planSha256", "journalSha256"].some(key =>
      ticket.prepared[key as keyof OriginalMcpPrepared] !== expected[key as keyof OriginalMcpPrepared]
      || ticket.b1.prepared[key as keyof OriginalMcpPrepared] !== expected[key as keyof OriginalMcpPrepared]))
    fail("Archived journal requires the exact retained retirement ticket, B1 and preparation.");
  const privateDirectory = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!())
      || stat.mode & 0o7077n || realpathSync(path) !== path || !legacyPrivateRootGuard(path))
      fail("Archived journal evidence must remain in actual owned private directories.");
  };
  privateDirectory(archive); privateDirectory(ticket.b1.backup); privateDirectory(join(ticket.b1.backup, "blobs"));
  const { manifestSha256, ...b1Body } = ticket.b1;
  if (manifestSha256 !== jsonDigest(b1Body)
    || JSON.stringify(JSON.parse(originalMcpPrivateBytes(join(ticket.b1.backup, "complete.json")).toString("utf8"))) !== JSON.stringify(ticket.b1)
    || JSON.stringify(JSON.parse(originalMcpPrivateBytes(join(archive, "intent.json")).toString("utf8"))) !== JSON.stringify(ticket))
    fail("Archived journal B1/retirement manifests changed.");
  const archivePin = identity(lstatSync(archive, { bigint: true }));
  const path = join(archive, originalMcpJournal), bytes = originalMcpPrivateBytes(path), pin = identity(lstatSync(path, { bigint: true }));
  const journal = originalMcpJournalSchema.parse(JSON.parse(bytes.toString("utf8"))), { journalSha256, ...journalBody } = journal;
  if (journalSha256 !== jsonDigest(journalBody) || journalSha256 !== expected.journalSha256
    || journal.workspaceId !== expected.workspaceId || JSON.stringify(journal.plan) !== JSON.stringify(plan))
    fail("Archived original journal version, digest or exact plan changed.");
  const inventoryPath = join(ticket.b1.backup, "inventory.sqlite"), inventoryBytes = originalMcpPrivateBytes(inventoryPath, maximumDatabaseBytes);
  if (createHash("sha256").update(inventoryBytes).digest("hex") !== ticket.b1.inventorySha256)
    fail("Archived journal requires the independently retained exact B1 inventory.");
  const inventory = new DatabaseSync(inventoryPath, { readOnly: true });
  try {
    const row = inventory.prepare("SELECT * FROM inventory WHERE path=?").get(originalMcpJournal);
    const stat = lstatSync(path);
    const movedIdentity = [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs].join(":");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!row || row.kind !== "file" || row.runtime !== 1 || row.sha256 !== sha256
      || String(row.identity).split(":").slice(0, -1).join(":") !== movedIdentity || !/^\d{8}$/.test(String(row.blob))
      || createHash("sha256").update(originalMcpPrivateBytes(join(ticket.b1.backup, "blobs", String(row.blob)))).digest("hex") !== sha256)
      fail("Archived journal does not match its B1 identity, raw bytes and sealed payload.");
  } finally { inventory.close(); }
  const value = Object.freeze({ kind: "pkm.original-mcp-retirement-sqlite-journal/v1" as const });
  const state = { root: plan.root, planSha256: plan.planSha256, fence, active: true, assertCurrent() {
    fence.assertHeld();
    privateDirectory(archive);
    const root = lstatSync(plan.root, { bigint: true });
    if (!state.active || String(root.dev) !== plan.device || String(root.ino) !== plan.inode
      || identity(lstatSync(archive, { bigint: true })) !== archivePin
      || lstatSync(join(plan.root, originalMcpJournal), { throwIfNoEntry: false })
      || identity(lstatSync(path, { bigint: true })) !== pin || !originalMcpPrivateBytes(path).equals(bytes)
      || createHash("sha256").update(originalMcpPrivateBytes(join(plan.root, ".pkm/content-privacy.json"), 2_097_152)).digest("hex") !== plan.privacySha256)
      fail("The held retirement's archived original journal or Root privacy changed.");
  } };
  retirementJournals.set(value, state);
  try { state.assertCurrent(); return await work(value); } finally { state.active = false; }
}
function assertArchivedRetirementJournal(value: OriginalMcpRetirementSqliteJournalContext,
  plan: OriginalMcpPlan, fence: LinuxRootWriterFence) {
  const state = retirementJournals.get(value);
  if (!state || state.root !== plan.root || state.planSha256 !== plan.planSha256 || state.fence !== fence)
    fail("Archived journal access requires its genuine same-retirement context.");
  state.assertCurrent();
}
export function originalMcpCoreHasSqliteAuxiliaries(root: string): boolean {
  return auxiliaryNames.some(name => !!lstatSync(join(root, name), { throwIfNoEntry: false }))
    || readdirSync(root).some(name => name.startsWith(`${coreDatabaseFile}-mj`));
}
export function originalMcpCoreHasRollbackJournal(root: string): boolean {
  return !!lstatSync(`${coreDatabasePath(root)}-journal`, { throwIfNoEntry: false })
    || readdirSync(root).some(name => name.startsWith(`${coreDatabaseFile}-mj`));
}
function stateFor(value: OriginalMcpColdSqliteReadContext, plan: OriginalMcpPlan): State {
  const state = contexts.get(value);
  if (!state || !state.active || state.root !== plan.root || state.planSha256 !== plan.planSha256)
    fail("A genuine active same-root cold SQLite read context is required.");
  state.assertCurrent(); return state;
}
export function currentOriginalMcpColdSqliteReadContext(plan: OriginalMcpPlan) {
  const value = current.getStore();
  if (!value) return undefined;
  stateFor(value, plan); return value;
}
export function originalMcpColdSqliteReadDatabase(value: OriginalMcpColdSqliteReadContext,
  plan: OriginalMcpPlan): OriginalMcpSqliteReadDatabase {
  return stateFor(value, plan).reader;
}
async function validateOptionalReadSchema(database: DatabaseSync, root: string,
  schema: Array<Record<string, SQLOutputValue>>): Promise<Set<string>> {
  const { originalMcpDomainDdl, readOriginalMcpDomain, originalMcpWorkerSchema, originalMcpDomainHash } = await import("./original-mcp-domain-state.js");
  const { legacyMemoryImportDdl } = await import("./memory-import.js");
  const { memoryScopeContinuityDdl, readMemoryScopeContinuity } = await import("./memory-scope-continuity.js");
  const { legacyRetrievalModelOptionalSchemaGroups, verifyLegacyRetrievalModels } = await import("./legacy-retrieval-model.js");
  const domainNames = ["original_mcp_domain_intents", "original_mcp_domain_commits", "original_mcp_domain_workers"];
  const memoryNames = ["legacy_memory_imports", "legacy_memory_import_operations", "legacy_memory_scope_continuity"];
  const modelNames = legacyRetrievalModelOptionalSchemaGroups.flatMap(group => [...group.tables]);
  const verified = new Set<string>();
  const present = (names: string[]) => schema.some(row => names.includes(String(row.tbl_name)));
  const verifyGroup = (ddl: string, names: string[]) => {
    for (const name of verifyOriginalMcpOptionalSchemaGroup(schema, ddl, names)) verified.add(name);
  };
  const journal = readOriginalMcpJournal(root);
  const { verifyOriginalMcpHistoricalReadSchema } = await import("./original-mcp-historical-read-schema.js");
  for (const name of await verifyOriginalMcpHistoricalReadSchema(database, schema, journal)) verified.add(name);
  if (present(["action_runtime_selections"])) {
    const { actionRuntimeSelectionDdl, readActionImplementationSelections } = await import("./action-runtime-selection.js");
    verifyGroup(actionRuntimeSelectionDdl, ["action_runtime_selections"]);
    const selections = readActionImplementationSelections(database);
    if (!journal || selections.length > 4096 || selections.some(item => item.actorId !== "mcp:external"))
      fail("Historical Action preferences require exact original custody and the public native actor.");
  }
  for (const name of verifyOriginalApiChatOptionalReadSchema(database, schema, journal)) verified.add(name);
  const { ORIGINAL_RECOVERY_PHASE1_DDL, verifyOriginalRecoveryState } = await import("./original-knowledge-recovery-state.js");
  const recoveryNames = ["original_native_recovery_intents", "original_native_recovery_commits"];
  if (present(recoveryNames)) {
    verifyGroup(ORIGINAL_RECOVERY_PHASE1_DDL, recoveryNames);
    verifyOriginalRecoveryState(database, root);
  }
  let memory: ReturnType<typeof readOriginalMcpDomain>;
  if (present(domainNames)) {
    verifyGroup(originalMcpDomainDdl, domainNames);
    if (!journal) fail("Optional original domains require the actual live-location custody journal.");
    const todo = readOriginalMcpDomain(root, "todo", database);
    memory = readOriginalMcpDomain(root, "memory", database);
    if (!todo && !memory) fail("Optional domain DDL is not an authenticated source receipt.");
    const allowed = [todo?.intent.domain, memory?.intent.domain].filter(Boolean);
    if (database.prepare("SELECT domain FROM original_mcp_domain_intents").all().some(row => !allowed.includes(row.domain as "todo" | "memory")))
      fail("Cold native SQLite read refuses unknown optional domain intents.");
    if (database.prepare("SELECT domain FROM original_mcp_domain_commits").all().some(row => !allowed.includes(row.domain as "todo" | "memory")))
      fail("Cold native SQLite read refuses orphan optional domain commitments.");
    for (const row of database.prepare("SELECT receipt_sha256,payload FROM original_mcp_domain_workers").all()) {
      const worker = originalMcpWorkerSchema.parse(JSON.parse(String(row.payload))), { receiptSha256, ...body } = worker;
      const hostRow = database.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?").get(worker.nativeHostReceiptSha256);
      const host = hostRow ? JSON.parse(String(hostRow.payload)) : undefined;
      const { receiptSha256: hostSha256, ...hostBody } = host ?? {};
      if (!todo?.committed || row.receipt_sha256 !== receiptSha256 || originalMcpDomainHash(body) !== receiptSha256
        || row.payload !== canonicalJson(worker) || worker.intentSha256 !== todo.intent.intentSha256
        || !todo.intent.files.some(file => file.key === worker.boardSlug)
        || !host || hostSha256 !== worker.nativeHostReceiptSha256 || originalMcpDomainHash(hostBody) !== hostSha256
        || host.root !== root || host.workspaceId !== journal.workspaceId || host.planSha256 !== journal.plan.planSha256
        || host.profileSha256 !== journal.plan.profileSha256)
        fail("Cold native SQLite read refuses unbound historical worker receipts.");
    }
  }
  if (present(memoryNames)) {
    verifyGroup(legacyMemoryImportDdl + ";" + memoryScopeContinuityDdl, memoryNames);
    if (!journal || !memory || memory.intent.sourceDetails.domain !== "memory")
      fail("Optional Memory import schema requires its actual original-domain source receipt.");
    const continuity = readMemoryScopeContinuity(database, journal.workspaceId);
    if (!continuity || continuity.schema !== "pkm.memory-scope-continuity/v2"
      || continuity.actorId !== memory.intent.actorId
      || continuity.importPlanSha256 !== memory.intent.sourceDetails.importPlanSha256
      || continuity.sourceScopeSha256 !== memory.intent.sourceDetails.sourceScopeSha256
      || continuity.importReceiptSha256 !== memory.intent.sourceDetails.importReceiptSha256)
      fail("Optional Memory continuity is not bound to this exact source/domain/workspace.");
  }
  if (present(modelNames)) {
    for (const group of legacyRetrievalModelOptionalSchemaGroups) if (present([...group.tables])) {
      let ddl = group.ddl;
      if (group.tables.includes("legacy_retrieval_model_selections")
        && database.prepare("PRAGMA table_info(legacy_retrieval_model_selections)").all()
          .some(row => row.name === "frozen_release_id")) {
        if (!present(["legacy_retrieval_frozen_releases"]))
          fail("Frozen model selection schema requires its actual immutable release journal.");
        ddl += ";ALTER TABLE legacy_retrieval_model_selections ADD COLUMN frozen_release_id TEXT;";
      }
      verifyGroup(ddl, [...group.tables]);
    }
    const models = verifyLegacyRetrievalModels(database, root);
    if (!models.packages.length) fail("Optional retrieval model DDL requires real validated package admission receipts.");
  }
  return verified;
}
async function validateNativeReadSchema(database: DatabaseSync, root: string) {
  if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
    fail("Cold native SQLite read refuses corrupt data.");
  const profile = JSON.parse(STORAGE_BOOTSTRAP_PROFILE_JSON) as {
    schemaSha256: string; derivedProfiles: { schemaSha256: string }[];
  };
  const schema = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE tbl_name NOT IN ('original_mcp_native_host_admissions','original_mcp_action_validation','legacy_retrieval_corpus')
    ORDER BY name`).all();
  if (![profile, ...profile.derivedProfiles].some(item => item.schemaSha256 === jsonDigest(schema))) {
    const verified = await validateOptionalReadSchema(database, root, schema);
    const canonical = schema.filter(row => !verified.has(String(row.name)));
    if (![profile, ...profile.derivedProfiles].some(item => item.schemaSha256 === jsonDigest(canonical)))
      fail("Cold native SQLite read refuses an unknown or altered canonical schema.");
  }
  const owner = database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
  if (owner && Number(owner.lease_until) !== 0)
    fail("Cold native SQLite read requires the canonical owner explicitly closed, not merely expired.");
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_process_owner'").get()
    && database.prepare("SELECT 1 FROM runtime_process_owner WHERE closed=0 LIMIT 1").get())
    fail("Cold native SQLite read refuses unreconciled process owners.");
  // Intent rows are read evidence, never recovery authority; retirement applies its stricter empty-state gate.
}
/** Only the trusted cold coordinator's actual fence can authorize this short, SELECT-only metadata read lease. */
export async function withOriginalMcpColdSqliteRead<T>(input: OriginalMcpPlan, fence: LinuxRootWriterFence,
  work: (context: OriginalMcpColdSqliteReadContext) => Promise<T>,
  retirementJournal?: OriginalMcpRetirementSqliteJournalContext): Promise<T> {
  const plan = parseOriginalMcpPlan(input), root = plan.root;
  if (!isTrustedLinuxRootWriterFence(fence, root)) fail("Cold SQLite read requires the actual same-root Linux writer fence.");
  fence.assertHeld(); await assertLinuxLegacyWritersQuiescent(root); fence.assertHeld();
  const guard = legacyPrivateRootGuard(root);
  if (retirementJournal) assertArchivedRetirementJournal(retirementJournal, plan, fence);
  else {
    const journal = assertOriginalMcpPrivacy(root);
    if (!journal || journal.plan.planSha256 !== plan.planSha256)
      fail("Cold SQLite read requires the exact original journal and private root protection.");
  }
  if (!guard) fail("Cold SQLite read requires exact private root protection.");
  if (originalMcpCoreHasSqliteAuxiliaries(root))
    fail("Cold SQLite read requires initially absent WAL, SHM, rollback and master journals.");
  const path = coreDatabasePath(root), before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || before.mode & 0o7002n || before.size > BigInt(maximumDatabaseBytes))
    fail("Cold SQLite read requires bounded owned native database files that are safe single-link regular files.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = () => {
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before) || identity(lstatSync(path, { bigint: true })) !== identity(before))
      fail("Cold native database identity changed.", true);
    const result = createHash("sha256"), buffer = Buffer.allocUnsafe(262144);
    let position = 0;
    while (position < Number(before.size)) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (!count) fail("Cold native database size changed.", true);
      result.update(buffer.subarray(0, count)); position += count;
    }
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before) || identity(lstatSync(path, { bigint: true })) !== identity(before))
      fail("Cold native database changed while hashing.", true);
    return result.digest("hex");
  };
  let database: DatabaseSync | undefined, state: State | undefined;
  let sha256: string | undefined;
  const auxiliaryPins = new Map<string, string>();
  const assertPhysical = () => {
    fence.assertHeld();
    if (retirementJournal) assertArchivedRetirementJournal(retirementJournal, plan, fence);
    if (!sameLegacyPrivateRoot(root, guard) || hash() !== sha256) fail("Cold native SQLite root, hash or identity changed.", true);
    for (const name of coreDatabaseSidecarFiles) {
      const stat = lstatSync(join(root, name), { bigint: true, throwIfNoEntry: false });
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
        || stat.mode & 0o7002n || name.endsWith("-wal") && stat.size !== 0n || name.endsWith("-shm") && stat.size !== 32768n)
        fail("Cold SQLite read encountered unowned or nonempty auxiliary state.", true);
      const pin = [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size].join(":");
      if (auxiliaryPins.has(name) && auxiliaryPins.get(name) !== pin)
        fail("Cold SQLite read auxiliary identity changed.", true);
      auxiliaryPins.set(name, pin);
    }
    if (lstatSync(`${coreDatabasePath(root)}-journal`, { throwIfNoEntry: false })
      || readdirSync(root).some(name => name.startsWith(`${coreDatabaseFile}-mj`)))
      fail("Cold SQLite read encountered a rollback journal.", true);
  };
  const close = () => {
    if (state) state.active = false;
    try {
      if (database?.isTransaction) database.exec("ROLLBACK");
    } finally {
      try { database?.close(); }
      finally {
        try {
          fence.assertHeld();
          if (retirementJournal) assertArchivedRetirementJournal(retirementJournal, plan, fence);
          if (database && (!sameLegacyPrivateRoot(root, guard) || hash() !== sha256 || originalMcpCoreHasSqliteAuxiliaries(root)))
            fail("Cold native SQLite close did not preserve main data and reconcile only its own metadata.", true);
        } finally { closeSync(fd); }
      }
    }
  };
  try {
    sha256 = hash();
    if (originalMcpCoreHasSqliteAuxiliaries(root)) fail("SQLite auxiliary state appeared before cold read.", true);
    database = new DatabaseSync(path);
    database.exec("PRAGMA query_only=ON; BEGIN;");
    database.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    assertPhysical();
    if (database.prepare("PRAGMA query_only").get()?.query_only !== 1) fail("Cold SQLite read did not enable query-only mode.");
    await validateNativeReadSchema(database, root);
    assertPhysical();
    const value = Object.freeze({ kind: "pkm.original-mcp-cold-sqlite-read/v1" as const });
    state = { root, planSha256: plan.planSha256, fence, database, active: true, assertCurrent: assertPhysical, close,
      reader: Object.freeze({ prepare(sql: string) {
        if (!state!.active || !/^\s*SELECT\b/i.test(sql) || sql.includes("\0") || Buffer.byteLength(sql) > 1_048_576)
          fail("Cold SQLite read exposes SELECT statements only, never write capabilities.");
        assertPhysical();
        const statement = database!.prepare(sql);
        return Object.freeze({
          get: (...args: SQLInputValue[]) => { assertPhysical(); return statement.get(...args); },
          all: (...args: SQLInputValue[]) => { assertPhysical(); return statement.all(...args); },
          iterate: (...args: SQLInputValue[]) => {
            assertPhysical();
            return (function* () { for (const row of statement.iterate(...args)) { assertPhysical(); yield row; } })();
          },
        });
      } }) };
    contexts.set(value, state);
    return await current.run(value, () => work(value));
  } catch (error) {
    if (error instanceof CoreError) throw error;
    console.error("PKM cold native SQLite inspection failed:", error);
    throw new CoreError("RECOVERY_REQUIRED", "Cold native SQLite inspection failed; preserve the database for reconciliation.", "unknown");
  } finally {
    try { close(); }
    catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("RECOVERY_REQUIRED", "Cold native SQLite cleanup could not be verified; preserve its state.", "unknown");
    }
  }
}
