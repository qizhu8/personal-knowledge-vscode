import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";
import type { OriginalMcpNativeHostReceipt } from "./original-mcp-native-host-receipt.js";
import { readOriginalMcpRecipeHistoricalHost } from "./original-mcp-recipe-history.js";
import {
  originalRecipeTerminalSource, originalRecipeTerminalApprovalRequest, originalRecipeSourceApproval,
  type OriginalRecipeTerminalSource, type OriginalRecipeSourceApproval, type OriginalRecipeSourceApprovalRequest,
  type OriginalRecipeSourcePolicy,
} from "./original-mcp-recipe-source-contracts.js";
import {
  assertOriginalMcpNativeRecipeSourcePolicy, retainOriginalMcpNativeRecipeSourceApproval,
  assertOriginalMcpNativeRecipeSourceApprovalCurrent, originalMcpNativeRecipeSourceApprovalSignal,
} from "./original-mcp-native-recipe-policy.js";
import {
  originalRecipeRunGetInput, originalRecipeRunIdentity, originalRecipeResponseDetail,
  parseOriginalTerminalRecipeRecord, projectOriginalTerminalRecipeRun,
} from "./original-mcp-recipe-terminal-projection.js";

type Json = Record<string, any>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ddl = `CREATE TABLE original_recipe_terminal_sources(
 run_id TEXT PRIMARY KEY,source TEXT NOT NULL,raw TEXT NOT NULL,decision TEXT NOT NULL);
 CREATE TRIGGER original_recipe_terminal_sources_no_update BEFORE UPDATE ON original_recipe_terminal_sources
 BEGIN SELECT RAISE(ABORT,'original Recipe terminal source immutable'); END;
 CREATE TRIGGER original_recipe_terminal_sources_no_delete BEFORE DELETE ON original_recipe_terminal_sources
 BEGIN SELECT RAISE(ABORT,'original Recipe terminal source immutable'); END;`;
export const originalMcpRecipeTerminalDdl = ddl;
const planned = new WeakMap<object, { owner: RootOwner; host: OriginalMcpNativeHost; digest: string; raw: string }>();
type Session = {
  host: OriginalMcpNativeHost; source: OriginalRecipeTerminalSource;
  approval: OriginalRecipeSourceApproval; request: OriginalRecipeSourceApprovalRequest; policy: OriginalRecipeSourcePolicy;
};
const sessions = new WeakMap<Storage, Map<string, Session>>();
const cleanups = new WeakSet<Storage>();
function fail(message: string): never { throw new CoreError("ACCESS_DENIED", `ORIGINAL_RECIPE_TERMINAL_SOURCE_REQUIRED: ${message}`); }
async function scope(owner: RootOwner, host: OriginalMcpNativeHost) {
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull();
  owner.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  const journal = assertOriginalMcpPrivacy(owner.workspaceRoot());
  if (!journal || !host.receipt.domains.includes("mcp-public")) fail("Actual original custody and current public host are required.");
  return { storage, journal };
}
function checkPlan(source: OriginalRecipeTerminalSource, receipt: OriginalMcpNativeHostReceipt) {
  source = originalRecipeTerminalSource.parse(source);
  const { planSha256, ...body } = source;
  if (digest(body) !== planSha256 || source.sourcePath !== `.pkm/state/recipe-runs/${source.runId}.json`
    || source.bytes > source.maxFileBytes || source.root !== receipt.root || source.workspaceId !== receipt.workspaceId
    || source.custodyPlanSha256 !== receipt.planSha256 || source.profileSha256 !== receipt.profileSha256)
    fail("Selected finalized source/identity/root/profile/custody changed.");
}
function parse(raw: string, runId: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("Original Recipe source is not valid JSON."); }
  return parseOriginalTerminalRecipeRecord(runId, value);
}
async function bytes(owner: RootOwner, host: OriginalMcpNativeHost, source: OriginalRecipeTerminalSource, signal?: AbortSignal) {
  const { journal } = await scope(owner, host); checkPlan(source, host.receipt);
  signal?.throwIfAborted(); host.signal.throwIfAborted();
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const raw = await reader.read(source.sourcePath, source.maxFileBytes);
    if (raw.length !== source.bytes || sha(raw) !== source.sourceSha256) fail("Selected finalized source bytes changed.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw), record = parse(text, source.runId);
    if (digest(record) !== source.recordSha256 || record.status !== source.status) fail("Finalized source record changed.");
    reader.assertCurrent(); signal?.throwIfAborted(); await scope(owner, host);
    return { text, record };
  } finally { reader.close(); }
}
function schema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_recipe_terminal_%' ORDER BY name";
  try {
    expected.exec(ddl);
    if (canonicalJson(db.prepare(query).all()) !== canonicalJson(expected.prepare(query).all())) fail("Immutable terminal source schema changed.");
  } finally { expected.close(); }
}
/** An exact historical run selection is distinct from aggregate-usage source admission. */
export async function planOriginalMcpRecipeTerminal(owner: RootOwner, host: OriginalMcpNativeHost,
  input: { runId: string; expectedSha256: string; maxFileBytes: number }) {
  const runId = originalRecipeRunIdentity.parse(input.runId), { journal } = await scope(owner, host);
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || !Number.isSafeInteger(input.maxFileBytes)
    || input.maxFileBytes < 1 || input.maxFileBytes > 16_777_216)
    throw new CoreError("INVALID_ARGUMENT", "An exact original Recipe SHA-256 and bounded read budget are required.");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    const sourcePath = `.pkm/state/recipe-runs/${runId}.json`, raw = await reader.read(sourcePath, input.maxFileBytes);
    if (sha(raw) !== input.expectedSha256) throw new CoreError("CONFLICT", "Original Recipe differs from the independently selected SHA-256.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw), record = parse(text, runId);
    const body = { schema: "pkm.original-recipe-terminal-source/v1" as const, root: journal.plan.root, workspaceId: journal.workspaceId,
      custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256, runId, sourcePath,
      sourceSha256: sha(raw), recordSha256: digest(record), bytes: raw.length, maxFileBytes: input.maxFileBytes,
      status: record.status as "completed" | "failed", noExecution: true as const };
    const source = originalRecipeTerminalSource.parse({ ...body, planSha256: digest(body) });
    reader.assertCurrent(); await scope(owner, host);
    planned.set(source, { owner, host, digest: source.planSha256, raw: text });
    return source;
  } finally { reader.close(); }
}
function current(storage: Storage, host: OriginalMcpNativeHost, runId: string) {
  assertOriginalMcpNativeHost(host, storage);
  const session = sessions.get(storage)?.get(runId);
  if (!session || session.host !== host || session.approval.expiresAtMs <= Date.now()) fail("A new separate selected-run source decision is required.");
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(session.approval);
  session.policy.assertCurrent(session.request); checkPlan(session.source, host.receipt);
  return session;
}
async function approve(owner: RootOwner, host: OriginalMcpNativeHost, source: OriginalRecipeTerminalSource,
  policy: OriginalRecipeSourcePolicy, phase: "admit" | "activate", signal?: AbortSignal) {
  const { storage } = await scope(owner, host);
  // Unlike the historical usage embedding fixture port, terminal result access requires the actual signed policy brand.
  assertOriginalMcpNativeRecipeSourcePolicy(policy, owner, host);
  sessions.get(storage)?.delete(source.runId); checkPlan(source, host.receipt);
  const request = originalRecipeTerminalApprovalRequest.parse({ ...source, phase, actorId: "mcp:external",
    epoch: host.receipt.epoch, nativeHostReceiptSha256: host.receipt.receiptSha256 });
  const cancelled = AbortSignal.any([policy.signal, host.signal, ...(signal ? [signal] : [])]);
  cancelled.throwIfAborted();
  const observed = await policy.authorize(request, cancelled);
  cancelled.throwIfAborted(); assertOriginalMcpNativeRecipeSourcePolicy(policy, owner, host);
  if (!observed) fail("Separate current finalized-run source approval was denied.");
  const approval = originalRecipeSourceApproval.parse(observed);
  retainOriginalMcpNativeRecipeSourceApproval(observed, approval, request);
  if (!originalMcpNativeRecipeSourceApprovalSignal(approval) || approval.requestSha256 !== digest(request)
    || approval.expiresAtMs <= Date.now() || approval.expiresAtMs > Date.now() + 300000)
    fail("An actual exact signed selected-run source decision is required.");
  await bytes(owner, host, source, cancelled);
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval); cancelled.throwIfAborted();
  return { storage, request, approval };
}
function bind(storage: Storage, session: Session) {
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(session.approval);
  let map = sessions.get(storage);
  if (!map) { map = new Map(); sessions.set(storage, map); }
  map.set(session.source.runId, session);
  const signal = originalMcpNativeRecipeSourceApprovalSignal(session.approval)!;
  const revoke = () => {
    if (sessions.get(storage)?.get(session.source.runId) === session) sessions.get(storage)?.delete(session.source.runId);
  };
  signal.addEventListener("abort", revoke, { once: true }); if (signal.aborted) revoke();
  if (!cleanups.has(storage)) {
    cleanups.add(storage);
    storage.retainNativeCleanup({ release() { sessions.delete(storage); } });
  }
}
function persisted(storage: Storage, host: OriginalMcpNativeHost, runId: string) {
  const db = storage.connectNative();
  try {
    schema(db);
    const row = db.prepare("SELECT source,raw FROM original_recipe_terminal_sources WHERE run_id=?").get(runId);
    if (typeof row?.source !== "string" || typeof row.raw !== "string") fail("No immutable selected-run admission exists.");
    const source = originalRecipeTerminalSource.parse(JSON.parse(row.source)); checkPlan(source, host.receipt);
    if (source.runId !== runId || sha(Buffer.from(row.raw)) !== source.sourceSha256
      || Buffer.byteLength(row.raw) !== source.bytes || digest(parse(row.raw, runId)) !== source.recordSha256)
      fail("Stored terminal run or source identity changed.");
    return { source, raw: row.raw };
  } finally { db.close(); }
}
export async function verifyOriginalMcpRecipeTerminalReadState(db: DatabaseSync, journal: OriginalMcpJournal) {
  schema(db);
  const rows = db.prepare("SELECT * FROM original_recipe_terminal_sources LIMIT 4097").all();
  if (!rows.length || rows.length > 4096) fail("Historical selected-run membership is incomplete or exceeds its envelope.");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    for (const row of rows) {
      const source = originalRecipeTerminalSource.parse(JSON.parse(String(row.source)));
      const host = readOriginalMcpRecipeHistoricalHost(db, journal, source, String(row.decision));
      checkPlan(source, host);
      if (row.run_id !== source.runId || row.source !== canonicalJson(source) || typeof row.raw !== "string"
        || sha(Buffer.from(row.raw)) !== source.sourceSha256 || Buffer.byteLength(row.raw) !== source.bytes
        || digest(parse(row.raw, source.runId)) !== source.recordSha256)
        fail("Historical selected-run payload or identity changed.");
      const actual = await reader.read(source.sourcePath, source.maxFileBytes);
      if (sha(actual) !== source.sourceSha256 || actual.length !== source.bytes) fail("Historical selected-run source bytes changed.");
    }
    reader.assertCurrent();
  } finally { reader.close(); }
}
export async function admitOriginalMcpRecipeTerminal(owner: RootOwner, host: OriginalMcpNativeHost,
  source: OriginalRecipeTerminalSource, policy: OriginalRecipeSourcePolicy, signal?: AbortSignal) {
  const plan = planned.get(source);
  if (!plan || plan.owner !== owner || plan.host !== host || plan.digest !== source.planSha256)
    fail("Admission requires the actual exact same-owner selected-run planner.");
  const original = source; source = structuredClone(source);
  const { storage, request, approval } = await approve(owner, host, source, policy, "admit", signal);
  await storage.withWorkspaceExclusive(() => {
    assertOriginalMcpNativeHost(host, storage); assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval); signal?.throwIfAborted();
    const db = storage.connectNative();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'original_recipe_terminal_%'").get()) {
        schema(db);
        if (db.prepare("SELECT 1 FROM original_recipe_terminal_sources WHERE run_id=?").get(source.runId))
          fail("This selected terminal source is already sealed; activate it with a new separate decision.");
      } else db.exec(ddl);
      db.prepare("INSERT INTO original_recipe_terminal_sources VALUES(?,?,?,?)")
        .run(source.runId, canonicalJson(source), plan.raw, canonicalJson(approval));
      assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval); signal?.throwIfAborted(); storage.assertWorkspaceLease();
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  });
  bind(storage, { host, source, policy, request, approval }); planned.delete(original);
  return structuredClone(source);
}
export async function activateOriginalMcpRecipeTerminal(owner: RootOwner, host: OriginalMcpNativeHost,
  runId: string, policy: OriginalRecipeSourcePolicy, signal?: AbortSignal) {
  originalRecipeRunIdentity.parse(runId);
  const { storage } = await scope(owner, host), { source } = persisted(storage, host, runId);
  const { request, approval } = await approve(owner, host, source, policy, "activate", signal);
  persisted(storage, host, runId);
  bind(storage, { host, source, policy, request, approval });
  return structuredClone(source);
}
export async function readOriginalMcpRecipeTerminal(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, input: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
  const { storage } = await scope(owner, host);
  if (actor.id !== "mcp:external" || actor.boardWorker || !originalMcpPublicRequestMatches(storage, host, {
    operation: "mcp.tool.recipe_run_get", version: 1, tool: "recipe_run_get", readOnly: true,
    arguments: input, argumentsDigest: digest(input),
  })) fail("This exact actor-owned original public run inspection was not approved.");
  const parsed = originalRecipeRunGetInput.parse(input);
  let detail: string;
  try {
    detail = originalRecipeResponseDetail(parsed.detail);
    if (!originalRecipeRunIdentity.safeParse(parsed.run_id).success) throw new Error("Invalid Recipe run identity.");
  } catch (error) {
    return { schema: "pkm.recipe.api/v1", ok: false,
      error: { code: "recipe-run-get-failed", message: error instanceof Error ? error.message : "Invalid Recipe read." } };
  }
  const session = current(storage, host, parsed.run_id);
  const cancelled = AbortSignal.any([host.signal, session.policy.signal,
    originalMcpNativeRecipeSourceApprovalSignal(session.approval)!, ...(signal ? [signal] : [])]);
  cancelled.throwIfAborted();
  const fresh = await bytes(owner, host, session.source, cancelled), stored = persisted(storage, host, parsed.run_id);
  if (fresh.text !== stored.raw) fail("Original finalized run differs from its immutable admission.");
  current(storage, host, parsed.run_id); cancelled.throwIfAborted();
  try { return projectOriginalTerminalRecipeRun(fresh.record, detail as "compact" | "full"); }
  catch (error) {
    return { schema: "pkm.recipe.api/v1", ok: false,
      error: { code: "recipe-run-get-failed", message: error instanceof Error ? error.message : "Invalid finalized Recipe." } };
  }
}
