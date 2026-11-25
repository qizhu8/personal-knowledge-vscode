import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { openOriginalMcpCustodyReader } from "./original-mcp-root.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";
import type { OriginalMcpNativeHostReceipt } from "./original-mcp-native-host-receipt.js";
import { readOriginalMcpRecipeHistoricalHost } from "./original-mcp-recipe-history.js";
import {
  assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, type OriginalMcpNativeHost,
} from "./original-mcp-native-host.js";
import {
  originalRecipeUsageLimits, originalRecipeUsageSource, originalRecipeSourceApproval,
  originalRecipeSourceApprovalRequest, type OriginalRecipeUsageSource,
  type OriginalRecipeSourcePolicy, type OriginalRecipeSourceApprovalRequest, type OriginalRecipeSourceApproval,
} from "./original-mcp-recipe-source-contracts.js";
import {
  retainOriginalMcpNativeRecipeSourceApproval, assertOriginalMcpNativeRecipeSourceApprovalCurrent,
  originalMcpNativeRecipeSourceApprovalSignal,
} from "./original-mcp-native-recipe-policy.js";
export * from "./original-mcp-recipe-source-contracts.js";

type Json = Record<string, any>;
type File = OriginalRecipeUsageSource["files"][number];
type Row = { path: string; record: Json | null };
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const directory = ".pkm/state/recipe-runs";
const ddl = `
CREATE TABLE original_recipe_usage_rows(ordinal INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,record TEXT NOT NULL);
CREATE TABLE original_recipe_usage_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 payload TEXT NOT NULL,sha256 TEXT NOT NULL,decision TEXT NOT NULL,host_sha256 TEXT NOT NULL);
CREATE TRIGGER original_recipe_usage_rows_no_insert BEFORE INSERT ON original_recipe_usage_rows
 BEGIN SELECT RAISE(ABORT,'original Recipe usage immutable'); END;
CREATE TRIGGER original_recipe_usage_rows_no_update BEFORE UPDATE ON original_recipe_usage_rows
 BEGIN SELECT RAISE(ABORT,'original Recipe usage immutable'); END;
CREATE TRIGGER original_recipe_usage_rows_no_delete BEFORE DELETE ON original_recipe_usage_rows
 BEGIN SELECT RAISE(ABORT,'original Recipe usage immutable'); END;
CREATE TRIGGER original_recipe_usage_admission_no_update BEFORE UPDATE ON original_recipe_usage_admission
 BEGIN SELECT RAISE(ABORT,'original Recipe usage immutable'); END;
CREATE TRIGGER original_recipe_usage_admission_no_delete BEFORE DELETE ON original_recipe_usage_admission
 BEGIN SELECT RAISE(ABORT,'original Recipe usage immutable'); END;`;
export const originalMcpRecipeUsageDdl = ddl;
const plans = new WeakMap<object, { owner: RootOwner; host: OriginalMcpNativeHost; planSha256: string; rows: Row[] }>();
type Session = {
  host: OriginalMcpNativeHost; source: OriginalRecipeUsageSource; policy: OriginalRecipeSourcePolicy;
  request: OriginalRecipeSourceApprovalRequest; approval: OriginalRecipeSourceApproval;
};
const sessions = new WeakMap<Storage, Session>();
const retained = new WeakSet<Storage>();
function fail(message: string): never {
  throw new CoreError("ACCESS_DENIED", `ORIGINAL_RECIPE_SOURCE_REQUIRED: ${message}`);
}
async function scope(owner: RootOwner, host: OriginalMcpNativeHost) {
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull();
  assertOriginalMcpNativeHost(host, storage); owner.assertWorkspaceLease();
  const journal = assertOriginalMcpPrivacy(owner.workspaceRoot());
  if (!journal || !host.receipt.domains.includes("mcp-public")) fail("Exact original custody and public native host are required.");
  return { storage, journal };
}
function verifySchema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_recipe_usage_%' ORDER BY name";
  try {
    expected.exec(ddl);
    if (canonicalJson(db.prepare(query).all()) !== canonicalJson(expected.prepare(query).all()))
      fail("Source schema or immutable protections changed.");
  } finally { expected.close(); }
}
function checkPlan(source: OriginalRecipeUsageSource) {
  const { planSha256, ...body } = source;
  if (digest(body) !== planSha256 || digest(source.files) !== source.sourceSha256
    || source.runsScanned !== Math.min(source.files.length, 5000)) fail("Source plan changed.");
}
function matchesSource(source: OriginalRecipeUsageSource, binding: OriginalMcpNativeHostReceipt) {
  checkPlan(source);
  if (source.root !== binding.root || source.workspaceId !== binding.workspaceId
    || source.custodyPlanSha256 !== binding.planSha256 || source.profileSha256 !== binding.profileSha256)
    fail("Source belongs to another root, custody or native profile.");
}
function names(root: string): string[] {
  const path = join(root, directory), stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Original run directory changed.");
  return readdirSync(path).filter(name => /^recipe_run_.*\.json$/.test(name));
}
function checkMembership(source: OriginalRecipeUsageSource) {
  const current = names(source.root), selected = new Set(current);
  if (current.length !== source.files.length || source.files.some(file => !selected.has(file.path.slice(directory.length + 1))))
    fail("Original run membership changed.");
  for (const file of source.files) {
    const stat = lstatSync(join(source.root, file.path), { bigint: true });
    if (stat.isSymbolicLink() || (file.kind === "file" ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
      || String(stat.mtimeNs) !== file.mtime || String(stat.size) !== file.size)
      fail("Original run ordering or source identity changed.");
  }
}
async function checkBytes(source: OriginalRecipeUsageSource, owner: RootOwner, host: OriginalMcpNativeHost, signal?: AbortSignal) {
  const { journal } = await scope(owner, host);
  matchesSource(source, host.receipt); checkMembership(source);
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    for (const file of source.files.slice(0, source.runsScanned)) {
      signal?.throwIfAborted(); host.signal.throwIfAborted();
      if (file.kind === "file") await reader.read(file.path, source.limits.maxFileBytes);
    }
    reader.assertCurrent(); checkMembership(source);
  } finally { reader.close(); }
}

/** Capture precisely the original newest-5000 scan, including corrupt records in runs_scanned. */
export async function planOriginalMcpRecipeUsage(owner: RootOwner, host: OriginalMcpNativeHost,
  input: Parameters<typeof originalRecipeUsageLimits.parse>[0]): Promise<OriginalRecipeUsageSource> {
  const limits = originalRecipeUsageLimits.parse(input), { journal } = await scope(owner, host);
  const reader = await openOriginalMcpCustodyReader(journal.plan), files: File[] = [], rows: Row[] = [];
  let bytes = 0;
  try {
    // Python's stable mtime sort preserves original directory enumeration for equal timestamps.
    for (const name of names(journal.plan.root)) {
      const path = `${directory}/${name}`, entry = reader.entry(path);
      if (!entry) fail("A run was added after cold custody capture.");
      if (files.length >= limits.maxFiles) throw new CoreError("RESOURCE_LIMIT", "Original Recipe source exceeds the explicit file envelope.");
      bytes += Number(entry.size);
      if (Number(entry.size) > limits.maxFileBytes || bytes > limits.maxTotalBytes)
        throw new CoreError("RESOURCE_LIMIT", "Original Recipe source exceeds the explicit byte envelope.");
      files.push({ path, kind: entry.kind, sha256: entry.sha256, mtime: entry.mtime, size: entry.size });
    }
    files.sort((a, b) => Number(b.mtime) / 1e9 - Number(a.mtime) / 1e9);
    for (const file of files.slice(0, 5000)) {
      let record: Json | null = null;
      if (file.kind === "file") {
        const raw = await reader.read(file.path, limits.maxFileBytes);
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          if (value && typeof value === "object" && !Array.isArray(value) && (value as Json).schema === "pkm.recipe.run/v1")
            record = value as Json;
        } catch { /* The original usage getter skips unreadable JSON and unsupported run schemas. */ }
      }
      rows.push({ path: file.path, record });
    }
    reader.assertCurrent();
  } finally { reader.close(); }
  const body = {
    schema: "pkm.original-recipe-usage-source/v1" as const, root: journal.plan.root, workspaceId: journal.workspaceId,
    custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
    sourceSha256: digest(files), rowsSha256: digest(rows), files, runsScanned: rows.length, limits,
  };
  const source = originalRecipeUsageSource.parse({ ...body, planSha256: digest(body) });
  await checkBytes(source, owner, host);
  plans.set(source, { owner, host, planSha256: source.planSha256, rows });
  return source;
}
function checkPolicy(policy: OriginalRecipeSourcePolicy, request: OriginalRecipeSourceApprovalRequest) {
  if (!policy || policy.signal?.aborted || typeof policy.assertCurrent !== "function" || typeof policy.authorize !== "function")
    fail("An independently current Recipe source approval port is required.");
  const result = policy.assertCurrent(structuredClone(request)) as unknown;
  if (result !== undefined) {
    if (result && typeof result === "object" && "then" in result) void Promise.resolve(result).catch(() => {});
    fail("Source authority checks must be synchronous and denial-only.");
  }
  if (policy.signal.aborted) fail("Recipe source approval was revoked.");
}
function pinPolicy(policy: OriginalRecipeSourcePolicy): OriginalRecipeSourcePolicy {
  if (!policy || !(policy.signal instanceof AbortSignal) || typeof policy.assertCurrent !== "function"
    || typeof policy.authorize !== "function") fail("An independently current Recipe source approval port is required.");
  return Object.freeze({ signal: policy.signal, assertCurrent: policy.assertCurrent.bind(policy), authorize: policy.authorize.bind(policy) });
}
async function decide(source: OriginalRecipeUsageSource, owner: RootOwner, host: OriginalMcpNativeHost,
  policy: OriginalRecipeSourcePolicy, phase: "admit" | "activate", signal?: AbortSignal) {
  const { storage } = await scope(owner, host);
  sessions.delete(storage);
  matchesSource(source, host.receipt);
  const request = originalRecipeSourceApprovalRequest.parse({
    ...source, phase, actorId: "mcp:external", epoch: host.receipt.epoch,
    nativeHostReceiptSha256: host.receipt.receiptSha256, noExecution: true,
  });
  checkPolicy(policy, request);
  const cancellation = AbortSignal.any([host.signal, policy.signal, ...(signal ? [signal] : [])]);
  cancellation.throwIfAborted();
  const observed = await policy.authorize(structuredClone(request), cancellation);
  cancellation.throwIfAborted(); checkPolicy(policy, request);
  if (!observed) fail("Separate current Recipe source approval was denied.");
  const approval = originalRecipeSourceApproval.parse(observed);
  retainOriginalMcpNativeRecipeSourceApproval(observed, approval, request);
  if (approval.requestSha256 !== digest(request) || approval.expiresAtMs <= Date.now()
    || approval.expiresAtMs > Date.now() + 300_000) fail("Source decision does not match this exact request or bounded lifetime.");
  await checkBytes(source, owner, host, cancellation);
  cancellation.throwIfAborted(); checkPolicy(policy, request);
  return { storage, request, approval };
}
function bind(storage: Storage, host: OriginalMcpNativeHost, source: OriginalRecipeUsageSource,
  policy: OriginalRecipeSourcePolicy, request: OriginalRecipeSourceApprovalRequest, approval: OriginalRecipeSourceApproval) {
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval);
  const session = { host, source: structuredClone(source), policy, request, approval };
  sessions.set(storage, session);
  const signal = originalMcpNativeRecipeSourceApprovalSignal(approval);
  const revoke = () => { if (sessions.get(storage) === session) sessions.delete(storage); };
  signal?.addEventListener("abort", revoke, { once: true });
  if (signal?.aborted) revoke();
  if (!retained.has(storage)) {
    retained.add(storage);
    storage.retainNativeCleanup({ release() { sessions.delete(storage); } });
  }
}
export async function admitOriginalMcpRecipeUsage(owner: RootOwner, host: OriginalMcpNativeHost,
  source: OriginalRecipeUsageSource, policy: OriginalRecipeSourcePolicy, signal?: AbortSignal) {
  const prepared = plans.get(source);
  if (!prepared || prepared.owner !== owner || prepared.host !== host) fail("Admission requires the actual same-owner source planner.");
  checkPlan(source);
  if (prepared.planSha256 !== source.planSha256 || digest(prepared.rows) !== source.rowsSha256) fail("Planned source or rows changed.");
  const plannedSource = source;
  source = structuredClone(source);
  policy = pinPolicy(policy);
  const { storage, request, approval } = await decide(source, owner, host, policy, "admit", signal);
  await storage.withWorkspaceExclusive(() => {
    assertOriginalMcpNativeHost(host, storage); checkPolicy(policy, request); signal?.throwIfAborted(); checkMembership(source);
    if (approval.expiresAtMs <= Date.now()) fail("Recipe source decision expired before publication.");
    const db = storage.connectNative();
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'original_recipe_usage_%'").get())
        fail("An admitted source already exists; activate it with a new separate source decision.");
      db.exec("BEGIN IMMEDIATE");
      // Insert before the immutable row-insert trigger is published, in the same transaction.
      const [tables, protections] = ddl.split("CREATE TRIGGER original_recipe_usage_rows_no_insert");
      db.exec(tables!);
      for (const [ordinal, row] of prepared.rows.entries())
        db.prepare("INSERT INTO original_recipe_usage_rows VALUES(?,?,?)").run(ordinal, row.path, canonicalJson(row.record));
      db.prepare("INSERT INTO original_recipe_usage_admission VALUES(1,?,?,?,?)")
        .run(canonicalJson(source), source.planSha256, canonicalJson(approval), host.receipt.receiptSha256);
      db.exec(`CREATE TRIGGER original_recipe_usage_rows_no_insert${protections}`);
      checkPolicy(policy, request); assertOriginalMcpNativeHost(host, storage); signal?.throwIfAborted(); checkMembership(source);
      assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  });
  bind(storage, host, source, policy, request, approval); plans.delete(plannedSource);
  return structuredClone(source);
}
function persisted(storage: Storage) {
  const db = storage.connectNative();
  try { return readOriginalMcpRecipeUsageMetadata(db); }
  finally { db.close(); }
}
export function readOriginalMcpRecipeUsageMetadata(db: DatabaseSync) {
  verifySchema(db);
  const receipt = db.prepare("SELECT * FROM original_recipe_usage_admission WHERE singleton=1").get();
  if (typeof receipt?.payload !== "string") fail("No immutable Recipe source admission.");
  const source = originalRecipeUsageSource.parse(JSON.parse(receipt.payload)); checkPlan(source);
  if (receipt.sha256 !== source.planSha256) fail("Damaged source admission.");
  const rows = db.prepare("SELECT path,record FROM original_recipe_usage_rows ORDER BY ordinal").all()
    .map(row => ({ path: String(row.path), record: JSON.parse(String(row.record)) as Json | null }));
  if (digest(rows) !== source.rowsSha256 || rows.length !== source.runsScanned
    || rows.some((row, index) => row.path !== source.files[index]?.path)) fail("Damaged source accounting rows.");
  return { source, rows };
}
export async function verifyOriginalMcpRecipeUsageReadState(db: DatabaseSync, journal: OriginalMcpJournal) {
  const { source, rows } = readOriginalMcpRecipeUsageMetadata(db);
  const receipt = db.prepare("SELECT * FROM original_recipe_usage_admission").all();
  if (receipt.length !== 1 || receipt[0]!.payload !== canonicalJson(source))
    fail("Ambiguous or noncanonical historical source admission.");
  const host = readOriginalMcpRecipeHistoricalHost(db, journal, source,
    String(receipt[0]!.decision), String(receipt[0]!.host_sha256));
  matchesSource(source, host); checkMembership(source);
  const ordinals = db.prepare("SELECT ordinal,record FROM original_recipe_usage_rows ORDER BY ordinal").all();
  if (ordinals.some((row, i) => row.ordinal !== i || row.record !== canonicalJson(rows[i]!.record)))
    fail("Historical source accounting order or bytes changed.");
  const reader = await openOriginalMcpCustodyReader(journal.plan);
  try {
    for (const [i, file] of source.files.slice(0, source.runsScanned).entries()) {
      let actual: Json | null = null;
      if (file.kind === "file") {
        const raw = await reader.read(file.path, source.limits.maxFileBytes);
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          if (value && typeof value === "object" && !Array.isArray(value) && (value as Json).schema === "pkm.recipe.run/v1")
            actual = value as Json;
        } catch { /* The original accounting skips corrupt or unsupported records. */ }
      }
      if (canonicalJson(actual) !== canonicalJson(rows[i]!.record)) fail("Historical accounting differs from its actual custody source.");
    }
    reader.assertCurrent();
  } finally { reader.close(); }
}
export async function activateOriginalMcpRecipeUsage(owner: RootOwner, host: OriginalMcpNativeHost,
  policy: OriginalRecipeSourcePolicy, signal?: AbortSignal) {
  const { storage } = await scope(owner, host), { source } = persisted(storage);
  policy = pinPolicy(policy);
  const { request, approval } = await decide(source, owner, host, policy, "activate", signal);
  persisted(storage);
  bind(storage, host, source, policy, request, approval);
  return structuredClone(source);
}
export function revokeOriginalMcpRecipeUsage(storage: Storage) { sessions.delete(storage); }
function current(storage: Storage, host: OriginalMcpNativeHost) {
  assertOriginalMcpNativeHost(host, storage);
  const session = sessions.get(storage);
  if (!session || session.host !== host || session.approval.expiresAtMs <= Date.now()) fail("A new separate Recipe source decision is required.");
  assertOriginalMcpNativeRecipeSourceApprovalCurrent(session.approval);
  checkPolicy(session.policy, session.request); matchesSource(session.source, host.receipt);
  return session;
}
const int = (value: unknown = 0): number => {
  const parsed = typeof value === "boolean" ? Number(value) : typeof value === "number" ? Math.trunc(value)
    : typeof value === "string" && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error("Original Recipe accounting exceeds the native exact-integer envelope.");
  return parsed;
};
const add = (a: number, b: number) => int(a + b);
const order = (a: string, b: string) => {
  const left = Array.from(a, c => c.codePointAt(0)!), right = Array.from(b, c => c.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
};
function groups(rows: Row[], recipeId: string, limit: number) {
  const result = new Map<string, Json>();
  for (const { record: run } of rows) {
    if (!run || recipeId && run.recipeId !== recipeId) continue;
    const id = String(run.recipeId || ""), revision = run.recipeRevision ?? null, key = canonicalJson([id, revision]);
    if (typeof revision === "number") int(revision);
    let group = result.get(key);
    if (!group) {
      group = { recipe_id: id, recipe_name: Array.from(String(run.recipeName || id)).slice(0, 256).join(""),
        revision, run_count: 0, measured_tokens: 0, estimated_tokens: 0, runs_with_measured_usage: 0,
        runs_with_unknown_usage: 0, retries: 0, failures: 0, failed_runs: 0 };
      result.set(key, group);
    }
    const usage = run.usage || {}, measured = usage.measuredTokens || {}, hasMeasured = int(usage.measuredReports ?? 0) > 0;
    const failures = new Set<string>(), collect = (nodes: Json, fallback: unknown = 1) => {
      for (const [id, node] of Object.entries(nodes) as [string, Json][])
        if (node.state === "failed") failures.add(canonicalJson([id, int(node.attempt ?? fallback)]));
    };
    collect(run.nodes || {});
    for (const loop of Object.values(run.loops || {}) as Json[])
      for (const iteration of loop.history || []) collect(iteration.nodes || {}, iteration.iteration ?? 1);
    group.run_count++;
    group.measured_tokens = add(group.measured_tokens, int(measured.total_tokens ?? 0));
    group.estimated_tokens = add(group.estimated_tokens, int(usage.estimatedTokens ?? 0));
    group.runs_with_measured_usage += Number(hasMeasured);
    group.runs_with_unknown_usage += Number(!hasMeasured || int(usage.unknownModelCalls ?? 0) > 0);
    group.retries = add(group.retries, Object.values(run.nodeAttemptCounts || {}).reduce<number>(
      (sum, count) => add(sum, Math.max(0, int(count) - 1)), 0));
    group.failures = add(group.failures, failures.size);
    group.failed_runs += Number(run.status === "failed");
  }
  for (const group of result.values()) {
    group.average_measured_tokens_per_run = roundAverage(group.measured_tokens, group.run_count);
    group.average_estimated_tokens_per_run = roundAverage(group.estimated_tokens, group.run_count);
    delete group.measured_tokens; delete group.estimated_tokens;
  }
  return [...result.values()].sort((a, b) => b.run_count - a.run_count
    || order(a.recipe_id, b.recipe_id) || order(a.revision === null ? "None" : String(a.revision), b.revision === null ? "None" : String(b.revision))).slice(0, limit);
}
function roundAverage(total: number, runs: number) {
  // Match Python round(float, 2), including half-even ties, rather than Math.round.
  const value = total / runs, buffer = Buffer.alloc(8);
  if (value === 0) return 0;
  buffer.writeDoubleBE(value);
  const bits = buffer.readBigUInt64BE(), exponent = Number((bits >> 52n) & 2047n) - 1023 - 52;
  let numerator = ((bits & ((1n << 52n) - 1n)) | (1n << 52n)) * 100n;
  const denominator = exponent < 0 ? 1n << BigInt(-exponent) : 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || remainder * 2n === denominator && rounded % 2n) rounded++;
  return Number(rounded) / 100 * (value < 0 ? -1 : 1);
}

/** Original JSON result, never a retained Python engine or an execution-capable run getter. */
export async function readOriginalMcpRecipeUsage(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, input: Record<string, unknown>, signal?: AbortSignal) {
  const { storage } = await scope(owner, host);
  if (actor.id !== "mcp:external" || actor.boardWorker || !originalMcpPublicRequestMatches(storage, host, {
    operation: "mcp.tool.recipe_usage_summary", version: 1, tool: "recipe_usage_summary", readOnly: true,
    arguments: input, argumentsDigest: digest(input),
  }))
    fail("This exact actor-owned public read is not currently approved.");
  const session = current(storage, host);
  signal?.throwIfAborted();
  await checkBytes(session.source, owner, host, signal);
  signal?.throwIfAborted(); current(storage, host);
  const { rows } = persisted(storage), recipeId = input.recipe_id ?? "", limit = input.limit ?? 50;
  let response: Json;
  try {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("limit must be an integer from 1 to 100.");
    if (typeof recipeId !== "string" || Array.from(recipeId).length > 256)
      throw new Error("recipe_id must be a string no longer than 256 characters.");
    response = { schema: "pkm.recipe.api/v1", ok: true, summaries: groups(rows, recipeId, limit),
      runs_scanned: session.source.runsScanned, scan_truncated: session.source.files.length > session.source.runsScanned,
      accounting: "one-run-per-recipe-revision; child-runs-are-not-rolled-up" };
  } catch (error) {
    response = { schema: "pkm.recipe.api/v1", ok: false,
      error: { code: "recipe-usage-summary-failed", message: error instanceof Error ? error.message : "Invalid original usage." } };
  }
  current(storage, host);
  return response;
}
