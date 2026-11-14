import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import {
  inspectLegacySkillLifecyclePending, legacySkillBindingSchema, legacySkillLifecycleInputSchema,
  legacySkillLifecycleOutputSchema, legacySkillLifecyclePlanHash, legacySkillManifestHash,
  prepareLegacySkillLifecycle, type LegacySkillBinding, type LegacySkillInput, type LegacySkillManifest, type LegacySkillPlan,
} from "./legacy-skill-lifecycle.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fail = (code: "ACCESS_DENIED" | "CONFLICT" | "INVALID_ARGUMENT" | "NOT_AVAILABLE", text: string): never => { throw new CoreError(code, text); };
const pinSchema = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const rootsSchema = z.strictObject({ source: pinSchema, destination: pinSchema });
type RootPin = z.infer<typeof pinSchema>;
type RootPins = z.infer<typeof rootsSchema>;
export interface LegacySkillRoots { source: string; destination: string }

/** Roots are native-granted paths, never deserialized client arguments. The
 * owner must exclude all other writers, including external filesystem writers,
 * for the full scan/stage/apply/commit and recovery lifetime. Node has no
 * descriptor-relative openat/renameat; lstat and O_NOFOLLOW alone cannot
 * defeat hostile concurrent parent-directory replacement. */
function checkedRoot(path: string): RootPin {
  if (!isAbsolute(path) || resolve(path) !== path) return fail("INVALID_ARGUMENT", "Approved roots must be normalized absolute paths.");
  const parsed = parse(path);
  let current = parsed.root;
  for (const component of path.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("CONFLICT", "Approved root has a non-directory or symbolic-link component.");
  }
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("CONFLICT", "Approved root is not a real directory.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function rootPins(roots: LegacySkillRoots): RootPins {
  const a = relative(roots.source, roots.destination), b = relative(roots.destination, roots.source);
  if (!a || !b || (!a.startsWith(`..${sep}`) && a !== ".." && !isAbsolute(a))
    || (!b.startsWith(`..${sep}`) && b !== ".." && !isAbsolute(b)))
    return fail("ACCESS_DENIED", "Approved source and destination roots must be disjoint.");
  return { source: checkedRoot(roots.source), destination: checkedRoot(roots.destination) };
}
function samePins(a: RootPins, b: RootPins) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function noSql(db: DatabaseSync) {
  if (db.isTransaction) return fail("CONFLICT", "Filesystem operations are forbidden inside SQLite transactions.");
}
function readRegular(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2_097_152) return fail("CONFLICT", "Skill authority must be a bounded, single-link regular file.");
    const bytes = readFileSync(fd);
    if (bytes.length > 2_097_152) return fail("CONFLICT", "Skill file grew beyond its bound.");
    return bytes;
  } finally { closeSync(fd); }
}
function checkedSource(root: string) {
  let parent = root;
  for (const component of ["System", "PKM"]) {
    parent = join(parent, component);
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("CONFLICT", "Skill source parent is not a real directory.");
  }
  return readRegular(join(parent, "PKM Skills.md"));
}
function fsyncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function scanTree(root: string, selectedPath: string) {
  const manifest: LegacySkillManifest = [];
  let selected: Buffer | null = null, total = 0;
  function walk(dir: string, prefix: string, depth: number) {
    if (depth > 32) return fail("CONFLICT", "Skill tree depth exceeds the boundary.");
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name, path = join(dir, name);
      if (manifest.length >= 4096) return fail("CONFLICT", "Skill tree has too many entries.");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return fail("CONFLICT", "Skill tree contains a symbolic link.");
      if (stat.isDirectory()) { manifest.push({ kind: "directory", path: rel }); walk(path, rel, depth + 1); }
      else if (stat.isFile()) {
        const bytes = readRegular(path);
        total += bytes.length;
        if (total > 16_777_216) return fail("CONFLICT", "Skill tree bytes exceed the boundary.");
        manifest.push({ kind: "file", path: rel, sha256: hash(bytes), size: bytes.length });
        if (rel === selectedPath) selected = bytes;
      } else return fail("CONFLICT", "Skill tree contains a special file.");
    }
  }
  walk(root, "", 0);
  manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  legacySkillManifestHash(manifest);
  return { manifest, selected };
}

/** Snapshot all source paths, including missing canonical parents, under the
 * native exclusive-owner fence. This is inspection only; it grants no writes. */
export function scanNativeLegacySkillSource(db: DatabaseSync, assertOwner: () => void, root: string) {
  noSql(db);
  assertOwner();
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0)
    return fail("NOT_AVAILABLE", "This native Skill scanner requires Unix no-follow support.");
  const pin = checkedRoot(root);
  const tree = scanTree(root, "System/PKM/PKM Skills.md");
  for (const parent of ["System", "System/PKM"]) {
    const entry = tree.manifest.find(item => item.path === parent);
    if (entry && entry.kind !== "directory") return fail("CONFLICT", "Canonical Skill parent is not a directory.");
  }
  const sourceEntry = tree.manifest.find(item => item.path === "System/PKM/PKM Skills.md");
  if (sourceEntry && sourceEntry.kind !== "file") return fail("CONFLICT", "Canonical Skill source is not a file.");
  assertOwner();
  if (JSON.stringify(checkedRoot(root)) !== JSON.stringify(pin)) return fail("CONFLICT", "Approved Skill source root changed while scanning.");
  return { pin, source: tree.selected, manifest: tree.manifest };
}

export function scanNativeLegacySkillSourceAndTarget(db: DatabaseSync, assertOwner: () => void, roots: LegacySkillRoots) {
  noSql(db);
  assertOwner();
  const pins = rootPins(roots);
  const source = scanNativeLegacySkillSource(db, assertOwner, roots.source);
  const destination = scanTree(roots.destination, "pkm-skills/SKILL.md");
  assertOwner();
  if (!samePins(rootPins(roots), pins) || JSON.stringify(source.pin) !== JSON.stringify(pins.source))
    return fail("CONFLICT", "Approved Skill roots changed while scanning.");
  return { pins, source: source.source, sourceManifest: source.manifest,
    destination: destination.selected, destinationManifest: destination.manifest };
}

export function scanNativeLegacySkillTree(db: DatabaseSync, assertOwner: () => void, roots: LegacySkillRoots, expectedPins?: RootPins) {
  noSql(db);
  assertOwner();
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0)
    return fail("NOT_AVAILABLE", "This native Skill scanner requires Unix no-follow support.");
  const pins = rootPins(roots);
  if (expectedPins && !samePins(pins, expectedPins)) return fail("CONFLICT", "Approved Skill root identity changed.");
  const source = checkedSource(roots.source);
  const { manifest, selected: destination } = scanTree(roots.destination, "pkm-skills/SKILL.md");
  if (!samePins(rootPins(roots), pins)) return fail("CONFLICT", "Approved Skill root changed while scanning.");
  return { pins, source, destination, manifest };
}

/** Applies only an exact before-manifest plan, followed by full after scan.
 * A crash or error after staging leaves the durable fence in place. */
export function applyNativeLegacySkillPlan(db: DatabaseSync, assertOwner: () => void, roots: LegacySkillRoots, pins: RootPins, plan: LegacySkillPlan): void {
  noSql(db);
  assertOwner();
  const before = scanNativeLegacySkillTree(db, assertOwner, roots, pins);
  const inspected = inspectLegacySkillLifecyclePending(plan, legacySkillLifecyclePlanHash(plan), before.source, before.destination, before.manifest);
  if (inspected.state === "after" && plan.input.manifestSha256 === plan.result.manifestSha256) return;
  if (inspected.state !== "before") return fail("CONFLICT", "Skill destination is not in the approved before state.");
  const directory = join(roots.destination, "pkm-skills"), destination = join(directory, "SKILL.md");
  assertOwner();
  if (plan.afterContent !== null) {
    if (!before.manifest.some(entry => entry.path === "pkm-skills")) { mkdirSync(directory, { mode: 0o700 }); fsyncDirectory(roots.destination); }
    const temporary = join(directory, `.pkm-skill-${plan.input.operationId}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeFileSync(fd, plan.afterContent, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    // The exclusive native owner is the required CAS fence across this rename.
    renameSync(temporary, destination);
    fsyncDirectory(directory);
  } else if (before.destination !== null) {
    unlinkSync(destination);
    fsyncDirectory(directory);
    if (!plan.afterManifest.some(entry => entry.path === "pkm-skills")) { rmdirSync(directory); fsyncDirectory(roots.destination); }
  }
  const after = scanNativeLegacySkillTree(db, assertOwner, roots, pins);
  if (hash(after.source) !== plan.input.sourceSha256 || legacySkillManifestHash(after.manifest) !== plan.result.manifestSha256
    || (after.destination === null ? null : hash(after.destination)) !== plan.result.destinationSha256)
    return fail("CONFLICT", "Skill after-state differs from the approved whole manifest.");
}

export const LEGACY_SKILL_NATIVE_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS legacy_skill_native_intent (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL, plan_json TEXT NOT NULL, plan_sha256 TEXT NOT NULL, roots_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_skill_native_receipt (
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, binding_json TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_skill_native_receipt_no_update BEFORE UPDATE ON legacy_skill_native_receipt
BEGIN SELECT RAISE(ABORT, 'Skill receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_native_receipt_no_delete BEFORE DELETE ON legacy_skill_native_receipt
BEGIN SELECT RAISE(ABORT, 'Skill receipt is immutable'); END;`;

/** Run migration and schema validation inside the sole host migration transaction. */
export function initializeNativeLegacySkillJournal(db: DatabaseSync) {
  if (!db.isTransaction) return fail("CONFLICT", "Skill schema migration requires the host transaction.");
  db.exec(LEGACY_SKILL_NATIVE_JOURNAL_DDL);
  validateNativeLegacySkillJournalSchema(db);
}
export function validateNativeLegacySkillJournalSchema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(LEGACY_SKILL_NATIVE_JOURNAL_DDL);
    const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('legacy_skill_native_intent','legacy_skill_native_receipt','legacy_skill_native_receipt_no_update','legacy_skill_native_receipt_no_delete') ORDER BY name";
    if (JSON.stringify(db.prepare(sql).all()) !== JSON.stringify(expected.prepare(sql).all()))
      return fail("CONFLICT", "Skill journal schema differs from the exact expected DDL.");
  } finally { expected.close(); }
}
function intentHash(planJson: string, rootsJson: string, fingerprint: string) {
  return hash(JSON.stringify({ planJson, rootsJson, fingerprint }));
}

/** Callbacks execute synchronously inside SQL transactions except assertOwner
 * and authorize. They must not touch the filesystem or perform asynchronous work.
 * Fingerprints must be computed by the host over the full authenticated
 * workspace, binding, operation and input; never use caller-supplied values.
 * Global replay/commit use the shared receipt namespace; assertNoOtherPending
 * must check every unrelated journal under the same immediate transaction. */
export interface LegacySkillNativeAuthority {
  assertOwner(): void;
  authorize(actor: Readonly<Actor>, binding: LegacySkillBinding, action: LegacySkillInput["action"]): boolean;
  authorizeRoots(binding: LegacySkillBinding, roots: Readonly<LegacySkillRoots>): boolean;
  approveRetry(actor: Readonly<Actor>, plan: LegacySkillPlan): boolean;
  assertNoOtherPending(db: DatabaseSync): void;
  globalReceipt(db: DatabaseSync, operationId: string): { fingerprint: string; result: unknown } | null;
  writeGlobalReceipt(db: DatabaseSync, operationId: string, fingerprint: string, result: unknown): void;
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return fail("CONFLICT", "Skill journal requires its own immediate transaction.");
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function authorize(host: LegacySkillNativeAuthority, actor: Actor, binding: LegacySkillBinding, action: LegacySkillInput["action"]) {
  if (!actor?.id || !actor.canWrite || actor.id !== binding.actorId) return fail("ACCESS_DENIED", "Skill actor is not approved.");
  let allowed = false;
  try { allowed = host.authorize(actor, binding, action) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Skill policy denied this operation.");
}
function authorizeRoots(host: LegacySkillNativeAuthority, binding: LegacySkillBinding, roots: LegacySkillRoots) {
  let allowed = false;
  try { allowed = host.authorizeRoots(binding, roots) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Native Skill roots are not approved for this binding.");
}
function receipt(db: DatabaseSync, host: LegacySkillNativeAuthority, operationId: string, fingerprint: string, binding: LegacySkillBinding) {
  const global = host.globalReceipt(db, operationId);
  const local = db.prepare("SELECT fingerprint,binding_json,result_json FROM legacy_skill_native_receipt WHERE operation_id=?").get(operationId) as Record<string, string> | undefined;
  if (!global && !local) return null;
  if (!global || !local || global.fingerprint !== fingerprint || local.fingerprint !== fingerprint
    || local.binding_json !== JSON.stringify(binding)) return fail("CONFLICT", "Skill operation ID or receipt conflicts.");
  let localValue: unknown;
  try { localValue = JSON.parse(local.result_json!); } catch { return fail("CONFLICT", "Invalid Skill receipt."); }
  const result = legacySkillLifecycleOutputSchema.safeParse(localValue);
  if (!result.success || result.data.operationId !== operationId || JSON.stringify(global.result) !== JSON.stringify(result.data))
    return fail("CONFLICT", "Global and Skill receipts differ.");
  return result.data;
}
function pending(db: DatabaseSync) {
  return db.prepare("SELECT operation_id,fingerprint,plan_json,plan_sha256,roots_json FROM legacy_skill_native_intent WHERE singleton=1").get() as Record<string, string> | undefined;
}
function commit(db: DatabaseSync, host: LegacySkillNativeAuthority, plan: LegacySkillPlan, fingerprint: string, pins: RootPins) {
  host.assertOwner();
  transaction(db, () => {
    host.assertNoOtherPending(db);
    const row = pending(db);
    if (!row || row.operation_id !== plan.input.operationId || row.fingerprint !== fingerprint
      || row.plan_json !== JSON.stringify(plan) || row.roots_json !== JSON.stringify(pins)
      || row.plan_sha256 !== intentHash(row.plan_json, row.roots_json, fingerprint)
      || receipt(db, host, plan.input.operationId, fingerprint, plan.binding))
      return fail("CONFLICT", "Skill intent or receipt changed before commit.");
    host.writeGlobalReceipt(db, plan.input.operationId, fingerprint, plan.result);
    db.prepare("INSERT INTO legacy_skill_native_receipt VALUES(?,?,?,?)")
      .run(plan.input.operationId, fingerprint, JSON.stringify(plan.binding), JSON.stringify(plan.result));
    db.prepare("DELETE FROM legacy_skill_native_intent WHERE singleton=1").run();
  });
}
export function executeNativeLegacySkillLifecycle(db: DatabaseSync, host: LegacySkillNativeAuthority, roots: LegacySkillRoots, actor: Actor, bindingValue: unknown, inputValue: unknown, fingerprint: string) {
  const binding = legacySkillBindingSchema.safeParse(bindingValue), input = legacySkillLifecycleInputSchema.safeParse(inputValue);
  if (!binding.success || !input.success || !/^[a-f0-9]{64}$/.test(fingerprint)) return fail("INVALID_ARGUMENT", "Invalid Skill lifecycle request.");
  authorize(host, actor, binding.data, input.data.action);
  authorizeRoots(host, binding.data, roots);
  host.assertOwner();
  const replay = transaction(db, () => {
    const previous = receipt(db, host, input.data.operationId, fingerprint, binding.data);
    if (previous) return previous;
    if (pending(db)) return fail("CONFLICT", "A Skill intent is pending.");
    host.assertNoOtherPending(db);
    return null;
  });
  if (replay) {
    if (replay.action !== input.data.action) return fail("CONFLICT", "Replayed Skill action differs.");
    return replay;
  }
  host.assertOwner();
  const scan = scanNativeLegacySkillTree(db, () => host.assertOwner(), roots);
  const plan = prepareLegacySkillLifecycle(binding.data, input.data, scan.source, scan.destination, scan.manifest);
  host.assertOwner();
  transaction(db, () => {
    host.assertNoOtherPending(db);
    if (pending(db) || receipt(db, host, input.data.operationId, fingerprint, binding.data)) return fail("CONFLICT", "Skill admission changed.");
    const planJson = JSON.stringify(plan), rootsJson = JSON.stringify(scan.pins);
    db.prepare("INSERT INTO legacy_skill_native_intent VALUES(1,?,?,?,?,?)").run(input.data.operationId, fingerprint,
      planJson, intentHash(planJson, rootsJson, fingerprint), rootsJson);
  });
  host.assertOwner();
  applyNativeLegacySkillPlan(db, () => host.assertOwner(), roots, scan.pins, plan);
  commit(db, host, plan, fingerprint, scan.pins);
  return plan.result;
}

export function recoverNativeLegacySkillLifecycle(db: DatabaseSync, host: LegacySkillNativeAuthority, roots: LegacySkillRoots, actor: Actor, operationId: string, fingerprint: string) {
  if (!z.string().uuid().safeParse(operationId).success || !/^[a-f0-9]{64}$/.test(fingerprint)) return fail("INVALID_ARGUMENT", "Invalid Skill recovery request.");
  host.assertOwner();
  const row = transaction(db, () => { host.assertNoOtherPending(db); return pending(db); });
  if (!row || row.operation_id !== operationId || row.fingerprint !== fingerprint) return fail("CONFLICT", "Recovery must match the pending Skill operation.");
  if (row.plan_sha256 !== intentHash(row.plan_json!, row.roots_json!, fingerprint))
    return fail("CONFLICT", "Skill intent or root binding changed.");
  let raw: unknown, rootsValue: unknown;
  try { raw = JSON.parse(row.plan_json!); rootsValue = JSON.parse(row.roots_json!); } catch { return fail("CONFLICT", "Malformed Skill intent."); }
  const pins = rootsSchema.safeParse(rootsValue);
  const binding = z.object({ binding: legacySkillBindingSchema }).safeParse(raw);
  const input = z.object({ input: legacySkillLifecycleInputSchema }).safeParse(raw);
  if (!pins.success || !binding.success || !input.success || input.data.input.operationId !== operationId)
    return fail("CONFLICT", "Malformed Skill intent identity.");
  authorize(host, actor, binding.data.binding, input.data.input.action);
  authorizeRoots(host, binding.data.binding, roots);
  host.assertOwner();
  const scan = scanNativeLegacySkillTree(db, () => host.assertOwner(), roots, pins.data);
  // The only supported non-empty before projection is the exact current rendering.
  const tentative = prepareLegacySkillLifecycle(binding.data.binding, { ...input.data.input, action: "inject", destinationSha256: null, manifestSha256: legacySkillManifestHash([]) }, scan.source, null, []);
  const before = input.data.input.destinationSha256 === null ? null : Buffer.from(tentative.afterContent!);
  const inspected = inspectLegacySkillLifecyclePending(raw, legacySkillLifecyclePlanHash(raw as LegacySkillPlan), scan.source, before, scan.manifest);
  let allowed = false;
  try { allowed = host.approveRetry(actor, inspected.plan) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Skill recovery was not explicitly approved.");
  const observed = scan.destination === null ? null : hash(scan.destination);
  const expected = inspected.state === "before" ? inspected.plan.input.destinationSha256 : inspected.plan.result.destinationSha256;
  if (observed !== expected) return fail("CONFLICT", "Skill destination bytes differ from pending state.");
  host.assertOwner();
  if (inspected.state === "before") applyNativeLegacySkillPlan(db, () => host.assertOwner(), roots, pins.data, inspected.plan);
  commit(db, host, inspected.plan, fingerprint, pins.data);
  return inspected.plan.result;
}
