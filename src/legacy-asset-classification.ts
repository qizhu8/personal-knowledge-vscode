import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { legacyClassificationJournal, legacyClassificationPreview, type LegacyClassificationPreview } from "./legacy-asset-provider.js";
import { legacyClassificationSourceResult } from "./legacy-classification-command-contracts.js";
import { nativeClassificationMetadata } from "./legacy-classification-native.js";

const original = createRequire(import.meta.url)("../compat/legacy-asset-classification.cjs") as {
  preview(root: string, filesystem: unknown): LegacyClassificationPreview;
  isPrivate(root: string, asset: string, filesystem: unknown): boolean;
};
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const json = (v: unknown) => JSON.stringify(v);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const safe = z.string().min(1).max(2048).refine(v => !v.startsWith("/")
  && v.split("/").every(p => p && p !== "." && p !== ".." && !/[\\\x00-\x1f:]/.test(p)));
const tools = ["asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"] as const;
const tool = z.enum(tools);
const areas = ["skills", "notes", "scripts", "components", "actions", "recipes", "papers"];
const namespace = "packages/asset-classification";
const args = {
  asset_classify_preview: z.strictObject({}),
  asset_classify_apply: z.strictObject({ preview_id: digest, proposal_ids: z.array(digest).min(1).max(1000) }),
  asset_classify_rollback: z.strictObject({ journal_id: uuid }),
};
const invocationSchema = z.strictObject({ tool, args: z.record(z.string(), z.unknown()), operationId: uuid });
const admissionSchema = z.strictObject({
  workspaceId: z.string(), workspaceRoot: z.string(), rootPin: z.string(), actorId: z.literal("mcp:external"),
  authorityId: z.string().min(1), allowedTools: z.array(tool).min(1).refine(v => new Set(v).size === v.length),
});
type Admission = z.infer<typeof admissionSchema>;
const fileSchema = z.strictObject({ path: safe, sha256: digest, mode: z.number().int().min(0).max(0o777) });
const effectSchema = z.strictObject({ path: safe, before: z.string().nullable(), after: z.string().nullable(),
  mode: z.number().int().min(0).max(0o777) });
type Effect = z.infer<typeof effectSchema>;
const inventorySchema = z.strictObject({ files: z.array(fileSchema).max(10000), directories: z.array(safe).max(10000) });
type Inventory = z.infer<typeof inventorySchema>;
const intentSchema = z.strictObject({
  admission: admissionSchema, operationId: uuid, tool: z.enum(["asset_classify_apply", "asset_classify_rollback"]),
  args: z.record(z.string(), z.unknown()), fingerprint: digest, before: inventorySchema,
  effects: z.array(effectSchema).max(1001), cursor: z.number().int().nonnegative(),
  result: legacyClassificationSourceResult, journal: z.strictObject({ id: uuid, bytes: z.string() }).nullable(),
  preview: legacyClassificationPreview.nullable(),
});
type Intent = z.infer<typeof intentSchema>;
const ddl = `
CREATE TABLE IF NOT EXISTS legacy_asset_classification_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_asset_classification_events(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_asset_classification_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_asset_classification_admission_no_update BEFORE UPDATE ON legacy_asset_classification_admission BEGIN SELECT RAISE(ABORT,'classification admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_asset_classification_admission_no_delete BEFORE DELETE ON legacy_asset_classification_admission BEGIN SELECT RAISE(ABORT,'classification admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_asset_classification_events_no_update BEFORE UPDATE ON legacy_asset_classification_events BEGIN SELECT RAISE(ABORT,'classification event immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_asset_classification_events_no_delete BEFORE DELETE ON legacy_asset_classification_events BEGIN SELECT RAISE(ABORT,'classification event immutable'); END;`;
const eventSchema = intentSchema.omit({ before: true, effects: true, cursor: true }).extend({ previous: digest.nullable() });
export interface LegacyAssetClassificationBinding {
  workspaceId: string; workspaceRoot: string; rootPin?: string; actorId: string; authorityId: string;
  allowedTools: readonly z.infer<typeof tool>[];
}
export interface LegacyAssetClassificationHost {
  authorize(binding: Readonly<LegacyAssetClassificationBinding & { operation: string }>): boolean;
  checkpoint?(phase: string): void;
}
export interface LegacyAssetClassificationSession { close(): void }
const sessions = new WeakMap<LegacyAssetClassificationSession, Map<string, { admission: string; preview: LegacyClassificationPreview }>>();
export function createLegacyAssetClassificationSession(): LegacyAssetClassificationSession {
  const session = { close() { sessions.delete(session); } };
  sessions.set(session, new Map());
  return session;
}
function fail(code: string, message: string, unknown = false): never {
  throw new CoreError(code, message, unknown ? "unknown" : undefined);
}
function checkedRoot(root: string) {
  if (resolve(root) !== root || realpathSync(root) !== root) fail("UNSAFE_PATH", "Classification requires an exact canonical root.");
  for (let p = root;; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail("UNSAFE_PATH", "Classification roots cannot contain links.");
    if (dirname(p) === p) break;
  }
}
const pin = (root: string) => { checkedRoot(root); const s = lstatSync(root); return `${s.dev}:${s.ino}`; };
function read(path: string): Buffer {
  checkedRoot(dirname(path));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2_097_152)
    fail("UNSAFE_PATH", "Classification requires bounded, unlinked regular files.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd), value = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    const fields = ["dev", "ino", "mode", "size", "nlink", "mtimeMs", "ctimeMs"] as const;
    if ([opened, after, current].some(s => !s.isFile() || fields.some(k => s[k] !== before[k])) || value.length !== before.size)
      fail("SOURCE_CHANGED", "Classification source changed through its pinned descriptor.");
    return value;
  } finally { closeSync(fd); }
}
const maybeRead = (path: string) => lstatSync(path, { throwIfNoEntry: false }) ? read(path) : null;
const target = (asset: string) => /\.md$/i.test(asset) ? asset
  : `${asset.slice(0, asset.lastIndexOf("/") + 1)}.${asset.slice(asset.lastIndexOf("/") + 1)}.pkm-classification`;
function contentPath(path: string) {
  return safe.safeParse(path).success && areas.some(area => path.startsWith(`${area}/`))
    && !path.split("/").some(part => part === "System" || part === "_assets" || part.endsWith(".assets"));
}
function temporary(root: string, i: Intent, index: number) {
  return join(dirname(join(root, i.effects[index]!.path)), `.pkm-classification-${i.operationId}-${index}`);
}
function snapshot(root: string, pending?: Intent): { inventory: Inventory; images: Map<string, Buffer> } {
  checkedRoot(root);
  const files: Inventory["files"] = [], directories: string[] = [], images = new Map<string, Buffer>();
  const classificationSidecars: Array<{ path: string; assetPath: string }> = [];
  let total = 0;
  function walk(dir: string, depth: number) {
    if (depth > 32 || files.length + directories.length > 10000) fail("NOT_AVAILABLE", "Classification inventory exceeds its explicit bounds.");
    checkedRoot(dir);
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), address = relative(root, path).split("\\").join("/");
      if (!safe.safeParse(address).success) fail("UNSAFE_PATH", "Classification source has an unsafe path.");
      if (name.startsWith(".pkm-classification-")) {
        const index = pending?.effects.findIndex((_, n) => temporary(root, pending, n) === path) ?? -1;
        if (!pending || index < 0 || !read(path).equals(decode(pending.effects[index]!.after)!))
          fail("RECOVERY_CONFLICT", "Unowned classification publication stage.", true);
        continue;
      }
      const classificationSidecar = name.startsWith(".") && name.endsWith(".pkm-classification");
      if (classificationSidecar) {
        classificationSidecars.push({ path, assetPath: join(dir, name.slice(1, -".pkm-classification".length)) });
        continue;
      }
      if (name.startsWith(".") || name === "_assets" || name.endsWith(".assets") || name.endsWith(".pkm-meta.json")) continue;
      const s = lstatSync(path);
      if (s.isSymbolicLink()) fail("UNSAFE_PATH", "Classification inventory refuses linked assets.");
      if (s.isDirectory()) { directories.push(address); walk(path, depth + 1); }
      else {
        const bytes = read(path); total += bytes.length;
        if (total > 33_554_432) fail("NOT_AVAILABLE", "Classification inventory exceeds its byte bound.");
        files.push({ path: address, sha256: sha(bytes), mode: s.mode & 0o777 }); images.set(address, bytes);
      }
    }
  }
  for (const area of areas) {
    const path = join(root, area);
    if (lstatSync(path, { throwIfNoEntry: false })) { directories.push(area); walk(path, 0); }
  }
  const visibleFiles = new Set(files.map(file => file.path));
  for (const sidecar of classificationSidecars) {
    if (!visibleFiles.has(relative(root, sidecar.assetPath).split("\\").join("/"))) continue;
    const bytes = read(sidecar.path), address = relative(root, sidecar.path).split("\\").join("/");
    total += bytes.length;
    if (total > 33_554_432) fail("NOT_AVAILABLE", "Classification inventory exceeds its byte bound.");
    files.push({ path: address, sha256: sha(bytes), mode: lstatSync(sidecar.path).mode & 0o777 });
    images.set(address, bytes);
  }
  const policy = maybeRead(join(root, ".pkm/content-privacy.json"));
  if (policy) { files.push({ path: ".pkm/content-privacy.json", sha256: sha(policy), mode: lstatSync(join(root, ".pkm/content-privacy.json")).mode & 0o777 }); images.set(".pkm/content-privacy.json", policy); }
  return { inventory: { files: files.sort((a, b) => a.path < b.path ? -1 : 1), directories: directories.sort() }, images };
}
function decode(value: string | null) {
  if (value === null) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > 2_097_152) fail("RECOVERY_CONFLICT", "Invalid classification image.", true);
  return bytes;
}
function transaction<T>(storage: Storage, db: DatabaseSync, fn: () => T) {
  storage.assertWorkspaceLease();
  if (db.isTransaction) fail("CONFLICT", "Classification owns its SQL transaction.");
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); storage.assertWorkspaceLease(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function active(db: DatabaseSync): Admission | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_asset_classification_admission'").get()) return null;
  const row = db.prepare("SELECT payload,sha256 FROM legacy_asset_classification_admission WHERE singleton=1").get();
  if (!row) fail("INVALID_WORKSPACE", "Classification schema has no admitted owner.");
  if (sha(String(row.payload)) !== row.sha256) fail("INVALID_WORKSPACE", "Classification admission digest changed.");
  return admissionSchema.parse(JSON.parse(String(row.payload)));
}
const fingerprint = (admission: Admission, invocation: z.infer<typeof invocationSchema>) =>
  sha(json({ actorId: admission.actorId, tool: invocation.tool, args: invocation.args, operationId: invocation.operationId }));
function authorize(admission: Admission, root: string, actor: Actor, host: LegacyAssetClassificationHost, operation: string) {
  if (actor.id !== admission.actorId || actor.boardWorker || operation !== "asset_classify_preview" && !actor.canWrite
    || root !== admission.workspaceRoot || pin(root) !== admission.rootPin
    || !["admit", "reconcile"].includes(operation) && !admission.allowedTools.some(t => t === operation)
    || typeof host?.authorize !== "function" || host.authorize(Object.freeze({ ...admission, operation })) !== true)
    fail("ACCESS_DENIED", "Exact host-admitted classification actor, root and tool authority are required.");
}
function noOtherPending(db: DatabaseSync) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = String(row.name);
    if (name === "legacy_asset_classification_intent") continue;
    if (/^(?:pending_|legacy_.*_intent$)|_intents$|_pending$|journal/i.test(name)
      && db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
      fail("RECOVERY_REQUIRED", "Another durable workspace effect must be reconciled first.", true);
  }
}
function readIntent(db: DatabaseSync): Intent | null {
  const row = db.prepare("SELECT payload,sha256 FROM legacy_asset_classification_intent WHERE singleton=1").get();
  if (!row) return null;
  if (sha(String(row.payload)) !== row.sha256) fail("RECOVERY_CONFLICT", "Classification intent changed.", true);
  const i = intentSchema.parse(JSON.parse(String(row.payload)));
  if (i.cursor > i.effects.length || i.fingerprint !== fingerprint(i.admission, i)
    || i.effects.some(e => !contentPath(e.path) && e.path !== `${namespace}/${i.result.journalId}.json`))
    fail("RECOVERY_CONFLICT", "Classification intent authority differs.", true);
  for (const effect of i.effects) { decode(effect.before); decode(effect.after); }
  if (new Set(i.effects.map(e => e.path)).size !== i.effects.length)
    fail("RECOVERY_CONFLICT", "Classification intent repeats a target.", true);
  if (i.tool === "asset_classify_apply") {
    const request = args.asset_classify_apply.parse(i.args);
    if (!i.preview || i.preview.id !== request.preview_id || sha(json(i.preview.proposals)) !== request.preview_id
      || i.preview.root !== i.admission.workspaceRoot || request.proposal_ids.some(id => !i.preview!.proposals.some(p => p.id === id)))
      fail("RECOVERY_CONFLICT", "Classification intent preview evidence changed.", true);
    const journal = i.journal ? legacyClassificationJournal.parse(JSON.parse(decode(i.journal.bytes)!.toString())) : { schema: 1, entries: [] };
    if (i.journal && (i.journal.id !== i.result.journalId || i.effects[0]?.path !== `${namespace}/${i.journal.id}.json`
      || i.effects[0]?.before !== null || i.effects[0]?.after !== i.journal.bytes)
      || json(journal.entries.map(e => e.id)) !== json(i.result.applied)
      || i.effects.length !== journal.entries.length + (i.journal ? 1 : 0))
      fail("RECOVERY_CONFLICT", "Classification journal and result evidence differ.", true);
    for (const [index, e] of journal.entries.entries()) {
      const p = i.preview.proposals.find(p => p.id === e.id), effect = i.effects[index + 1];
      if (!p || p.type !== "classification" || !request.proposal_ids.includes(e.id) || !effect
        || p.asset !== e.asset || p.target !== e.target || p.target !== target(p.asset)
        || i.before.files.find(f => f.path === p.asset)?.sha256 !== p.hash || p.targetHash !== e.beforeHash
        || (decode(e.before) ? sha(decode(e.before)!) : null) !== e.beforeHash
        || effect.path !== e.target || effect.before !== e.before || effect.mode !== e.mode)
        fail("RECOVERY_CONFLICT", "Classification proposal no longer binds its before image.", true);
      const derived = p.asset === p.target ? nativeClassificationMetadata(decode(e.before)!, p.classification)
        : Buffer.from(JSON.stringify({ schema: "pkm.asset-classification/v1", asset: p.locator, classification: p.classification }, null, 2) + "\n");
      if (sha(derived) !== e.afterHash || derived.toString("base64") !== effect.after)
        fail("RECOVERY_CONFLICT", "Classification effect differs from exact original metadata semantics.", true);
    }
  } else {
    if (i.preview !== null || i.journal !== null || args.asset_classify_rollback.parse(i.args).journal_id !== i.result.journalId)
      fail("RECOVERY_CONFLICT", "Classification rollback evidence differs.", true);
    const apply = events(db).find(e => e.tool === "asset_classify_apply" && e.journal?.id === i.result.journalId);
    if (!apply?.journal) fail("RECOVERY_CONFLICT", "Classification rollback has no original native journal.", true);
    const entries = legacyClassificationJournal.parse(JSON.parse(decode(apply.journal.bytes)!.toString())).entries;
    for (const effect of i.effects) {
      const entry = entries.find(e => e.target === effect.path);
      if (!entry || effect.after !== entry.before || effect.mode !== entry.mode || sha(decode(effect.before)!) !== entry.afterHash)
        fail("RECOVERY_CONFLICT", "Classification rollback differs from original journal bytes.", true);
    }
  }
  return i;
}
function events(db: DatabaseSync) {
  let previous: string | null = null;
  return db.prepare("SELECT * FROM legacy_asset_classification_events ORDER BY sequence").all().map(row => {
    if (sha(String(row.payload)) !== row.sha256) fail("INVALID_WORKSPACE", "Classification event digest changed.");
    const event = eventSchema.parse(JSON.parse(String(row.payload)));
    if (event.previous !== previous || event.operationId !== row.operation_id || event.fingerprint !== fingerprint(event.admission, event))
      fail("INVALID_WORKSPACE", "Classification event chain changed.");
    previous = String(row.sha256);
    return event;
  });
}
export function verifyLegacyAssetClassification(db: DatabaseSync, root: string, allowPending = false) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'legacy_asset_classification_*' ORDER BY name").all();
  const admission = active(db);
  if (!objects.length) {
    if (Number(db.prepare("PRAGMA user_version").get()?.user_version) === 28)
      fail("INVALID_WORKSPACE", "Schema28 requires its native classification authority.");
    if (lstatSync(join(root, namespace), { throwIfNoEntry: false }))
      fail("INVALID_WORKSPACE", "Unadmitted classification state cannot be adopted.");
    return;
  }
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(ddl);
    if (json(objects) !== json(expected.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'legacy_asset_classification_*' ORDER BY name").all()))
      fail("INVALID_WORKSPACE", "Classification DDL differs from its fixed owner.");
  } finally { expected.close(); }
  if (!admission || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 28
    || admission.workspaceId !== JSON.parse(read(join(root, ".pkm-next-workspace")).toString()).id)
    fail("INVALID_WORKSPACE", "Classification requires its schema28 workspace owner.");
  const history = events(db), pending = readIntent(db), journals = new Map<string, string>();
  for (const event of history) {
    if (json(event.admission) !== json(admission)) fail("INVALID_WORKSPACE", "Classification event admission changed.");
    if (event.journal) journals.set(event.journal.id, event.journal.bytes);
    const receipt = db.prepare("SELECT actor_id,operation,fingerprint,result FROM receipts WHERE operation_id=?").get(event.operationId);
    if (!receipt || receipt.actor_id !== admission.actorId || receipt.operation !== event.tool || receipt.fingerprint !== event.fingerprint
      || receipt.result !== json(event.result)) fail("INVALID_WORKSPACE", "Classification global receipt differs.");
  }
  if (pending && json(pending.admission) !== json(admission)) fail("RECOVERY_CONFLICT", "Classification pending admission changed.", true);
  if (pending && !allowPending) fail("RECOVERY_REQUIRED", "Classification mutation requires exact native host reconciliation.", true);
  const folder = join(root, namespace);
  if (lstatSync(folder, { throwIfNoEntry: false })) {
    checkedRoot(folder);
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const staged = pending?.effects.findIndex((_, n) => temporary(root, pending, n) === path) ?? -1;
      if (staged >= 0 && read(path).equals(decode(pending!.effects[staged]!.after)!)) continue;
      const id = name.replace(/\.json$/, ""), value = read(path);
      const allowed = journals.get(id) ?? (pending?.journal?.id === id ? pending.journal.bytes : undefined);
      if (!name.endsWith(".json") || !allowed || value.toString("base64") !== allowed)
        fail("RECOVERY_CONFLICT", "Classification journal is not owned by exact native evidence.", true);
      journals.delete(id);
    }
  }
  if (journals.size) fail("RECOVERY_CONFLICT", "Classification journal evidence is missing.", true);
}
export async function admitLegacyAssetClassification(storage: Storage, actor: Actor, request: {
  authorityId: string; authorize: LegacyAssetClassificationHost["authorize"]; allowedTools?: z.infer<typeof tool>[];
}) {
  if (!actor.canWrite || actor.id !== "mcp:external" || actor.boardWorker || !request.authorityId?.trim())
    fail("ACCESS_DENIED", "Classification admission requires the fixed native host principal.");
  const root = storage.workspaceRoot();
  const proposed = { workspaceId: await storage.workspaceId(), workspaceRoot: root, actorId: actor.id,
    authorityId: request.authorityId, allowedTools: [...(request.allowedTools ?? tools)] };
  if (typeof request.authorize !== "function" || request.authorize(Object.freeze({ ...proposed, operation: "admit" })) !== true)
    fail("ACCESS_DENIED", "Explicit native classification approval is required.");
  return storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative();
    try {
      verifyLegacyAssetClassification(db, root);
      const existing = active(db);
      if (existing) {
        authorize(existing, root, actor, request, "admit");
        if (existing.authorityId !== request.authorityId || json(existing.allowedTools) !== json(proposed.allowedTools))
          fail("CONFLICT", "Classification admission is immutable.");
        return { workspaceId: existing.workspaceId };
      }
      noOtherPending(db);
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (![23, 24, 25, 26, 27].includes(version)) fail("INVALID_WORKSPACE", "Classification cannot downgrade or adopt an unsupported schema.");
      const admission = admissionSchema.parse({ ...proposed, rootPin: pin(root) });
      transaction(storage, db, () => {
        authorize(admission, root, actor, request, "admit");
        db.exec(ddl);
        db.exec("PRAGMA user_version=28");
        const payload = json(admission);
        db.prepare("INSERT INTO legacy_asset_classification_admission VALUES(1,?,?)").run(payload, sha(payload));
      });
      return { workspaceId: admission.workspaceId };
    } finally { db.close(); }
  });
}
function projectedFilesystem(root: string, state: ReturnType<typeof snapshot>) {
  const dirs = new Set(["", ...state.inventory.directories, ".pkm"]);
  const address = (path: string) => {
    const value = relative(root, path).split("\\").join("/");
    if (value && !safe.safeParse(value).success) fail("UNSAFE_PATH", "Captured classification cannot read outside its pinned inventory.");
    return value;
  };
  const stat = (path: string) => {
    const p = address(path), data = state.images.get(p);
    if (!dirs.has(p) && !data) throw Object.assign(new Error("Missing projected classification file."), { code: "ENOENT" });
    return { isSymbolicLink: () => false, isDirectory: () => dirs.has(p), isFile: () => !!data, size: data?.length ?? 0 };
  };
  return {
    realpathSync(path: string) { if (path !== root) fail("UNSAFE_PATH", "Captured classification root changed."); return root; },
    existsSync(path: string) { const p = address(path); return dirs.has(p) || state.images.has(p); },
    lstatSync: stat, statSync: stat,
    readFileSync(path: string, encoding?: string) {
      const value = state.images.get(address(path));
      if (!value) throw Object.assign(new Error("Missing projected classification file."), { code: "ENOENT" });
      return encoding ? value.toString("utf8") : Buffer.from(value);
    },
    readdirSync(path: string) {
      const p = address(path), children = [...dirs, ...state.images.keys()]
        .filter(v => v && dirname(v) === (p || "."));
      return [...new Set(children)].map(v => ({ name: basename(v), ...stat(join(root, v)) }));
    },
  };
}
function plan(root: string, admission: Admission, invocation: z.infer<typeof invocationSchema>, state: ReturnType<typeof snapshot>,
  preview: LegacyClassificationPreview | undefined, history: ReturnType<typeof events>): Intent {
  const effects: Effect[] = [], result: z.infer<typeof legacyClassificationSourceResult> = { journalId: randomUUID(), applied: [], skipped: [] };
  let journal: Intent["journal"] = null;
  if (invocation.tool === "asset_classify_apply") {
    const request = args.asset_classify_apply.parse(invocation.args);
    if (!preview || preview.id !== request.preview_id || preview.root !== root || sha(json(preview.proposals)) !== preview.id
      || request.proposal_ids.some(id => !preview.proposals.some(p => p.id === id)))
      fail("INVALID_ARGUMENT", "An active retained preview and its explicit approved proposal IDs are required.");
    const entries: z.infer<typeof legacyClassificationJournal>["entries"] = [];
    for (const id of [...new Set(request.proposal_ids)]) {
      const p = preview.proposals.find(p => p.id === id)!;
      const skip = (reason: z.infer<typeof legacyClassificationSourceResult>["skipped"][number]["reason"]) => result.skipped.push({ id, reason });
      if (p.type !== "classification") { skip("review-only"); continue; }
      if (!contentPath(p.asset) || !contentPath(p.target) || p.target !== target(p.asset)) { skip("unsafe-or-unavailable"); continue; }
      if (original.isPrivate(root, p.asset, projectedFilesystem(root, state))) { skip("privacy-changed-since-preview"); continue; }
      const asset = state.images.get(p.asset), before = state.images.get(p.target) ?? null;
      if (!asset || sha(asset) !== p.hash || (before ? sha(before) : null) !== p.targetHash) { skip("changed-since-preview"); continue; }
      try {
        const after = p.target === p.asset ? nativeClassificationMetadata(asset, p.classification)
          : Buffer.from(JSON.stringify({ schema: "pkm.asset-classification/v1", asset: p.locator, classification: p.classification }, null, 2) + "\n");
        const mode = state.inventory.files.find(f => f.path === p.target)?.mode ?? 0o600;
        entries.push({ id, asset: p.asset, target: p.target, before: before?.toString("base64") ?? null,
          beforeHash: p.targetHash, afterHash: sha(after), mode });
        effects.push({ path: p.target, before: before?.toString("base64") ?? null, after: after.toString("base64"), mode });
        result.applied.push(id);
      } catch { skip("unsafe-or-unavailable"); }
    }
    if (entries.length) {
      const bytes = Buffer.from(json({ schema: 1, entries }));
      journal = { id: result.journalId, bytes: bytes.toString("base64") };
      effects.unshift({ path: `${namespace}/${result.journalId}.json`, before: null, after: journal.bytes, mode: 0o600 });
    }
  } else {
    const request = args.asset_classify_rollback.parse(invocation.args);
    result.journalId = request.journal_id;
    const apply = history.find(e => e.tool === "asset_classify_apply" && e.journal?.id === request.journal_id);
    if (!apply?.journal) fail("NOT_AVAILABLE", "Rollback requires an actor-bound native original journal.");
    const raw = read(join(root, namespace, `${request.journal_id}.json`));
    if (raw.toString("base64") !== apply.journal.bytes) fail("CONFLICT", "Original rollback journal changed.");
    const parsed = legacyClassificationJournal.parse(JSON.parse(raw.toString("utf8")));
    for (const item of [...parsed.entries].reverse()) {
      const before = state.images.get(item.target) ?? null, current = before ? sha(before) : null;
      if (current === item.beforeHash) { result.skipped.push({ id: item.id, reason: "already-restored-or-not-written" }); continue; }
      if (current !== item.afterHash) { result.skipped.push({ id: item.id, reason: "changed-since-apply" }); continue; }
      effects.push({ path: item.target, before: before!.toString("base64"), after: item.before, mode: item.mode });
      result.applied.push(item.id);
    }
  }
  return intentSchema.parse({ admission, ...invocation, fingerprint: fingerprint(admission, invocation), before: state.inventory,
    effects, cursor: 0, result, journal, preview: invocation.tool === "asset_classify_apply" ? preview : null });
}
function currentInventory(i: Intent, cursor = i.cursor): Inventory {
  const value = structuredClone(i.before);
  for (const e of i.effects.slice(0, cursor)) {
    if (e.path.startsWith(`${namespace}/`)) continue;
    value.files = value.files.filter(f => f.path !== e.path);
    if (e.after !== null) value.files.push({ path: e.path, sha256: sha(decode(e.after)!), mode: e.mode });
  }
  value.files.sort((a, b) => a.path < b.path ? -1 : 1);
  return value;
}
function sameImage(root: string, e: Effect, image: string | null) {
  const bytes = maybeRead(join(root, e.path));
  return (bytes?.toString("base64") ?? null) === image && (!bytes || (lstatSync(join(root, e.path)).mode & 0o777) === e.mode);
}
function persist(storage: Storage, db: DatabaseSync, i: Intent) {
  const payload = json(i);
  transaction(storage, db, () => db.prepare("UPDATE legacy_asset_classification_intent SET payload=?,sha256=? WHERE singleton=1").run(payload, sha(payload)));
}
function resume(storage: Storage, db: DatabaseSync, actor: Actor, host: LegacyAssetClassificationHost, i: Intent) {
  const root = storage.workspaceRoot();
  for (; i.cursor < i.effects.length;) {
    authorize(i.admission, root, actor, host, i.tool);
    noOtherPending(db);
    const effect = i.effects[i.cursor]!, scan = snapshot(root, i).inventory;
    const before = json(currentInventory(i)), after = json(currentInventory(i, i.cursor + 1));
    if (![before, after].includes(json(scan))) fail("SOURCE_CHANGED", "Classification source CAS changed; exact host reconciliation is required.", true);
    if (!sameImage(root, effect, effect.after)) {
      if (json(scan) !== before || !sameImage(root, effect, effect.before))
        fail("RECOVERY_CONFLICT", "Classification target is neither its exact before nor after image.", true);
      const path = join(root, effect.path), stage = temporary(root, i, i.cursor);
      if (effect.path.startsWith(`${namespace}/`)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      checkedRoot(dirname(path));
      const bytes = decode(effect.after);
      if (bytes === null) { unlinkSync(path); }
      else {
        const existing = maybeRead(stage);
        if (existing && !existing.equals(bytes)) fail("RECOVERY_CONFLICT", "Classification stage changed.", true);
        if (!existing) {
          const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, bytes); fchmodSync(fd, effect.mode); fsyncSync(fd); } finally { closeSync(fd); }
        }
        host.checkpoint?.("staged");
        if (!sameImage(root, effect, effect.before) || json(snapshot(root, i).inventory) !== before)
          fail("SOURCE_CHANGED", "Classification source changed after staging; no target replaced.", true);
        storage.assertWorkspaceLease();
        renameSync(stage, path);
      }
      const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      host.checkpoint?.("published");
    }
    const stage = temporary(root, i, i.cursor);
    if (lstatSync(stage, { throwIfNoEntry: false })) {
      if (!read(stage).equals(decode(effect.after)!)) fail("RECOVERY_CONFLICT", "Classification residual stage changed.", true);
      unlinkSync(stage);
    }
    i.cursor++; persist(storage, db, i);
  }
  authorize(i.admission, root, actor, host, i.tool);
  if (json(snapshot(root, i).inventory) !== json(currentInventory(i))) fail("SOURCE_CHANGED", "Classification final inventory differs.", true);
  transaction(storage, db, () => {
    noOtherPending(db);
    const last = db.prepare("SELECT sha256 FROM legacy_asset_classification_events ORDER BY sequence DESC LIMIT 1").get();
    const { before: _, effects: __, cursor: ___, ...record } = i;
    const payload = json({ ...record, previous: last?.sha256 ?? null });
    db.prepare("INSERT INTO legacy_asset_classification_events(operation_id,payload,sha256) VALUES(?,?,?)").run(i.operationId, payload, sha(payload));
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(i.operationId, i.fingerprint, json(i.result), actor.id, i.tool, new Date().toISOString());
    db.prepare("DELETE FROM legacy_asset_classification_intent WHERE singleton=1").run();
  });
  return i.result;
}
export async function legacyAssetClassification(storage: Storage, actor: Actor, value: z.infer<typeof invocationSchema>,
  host: LegacyAssetClassificationHost, session: LegacyAssetClassificationSession) {
  const invocation = invocationSchema.parse(value);
  args[invocation.tool].parse(invocation.args);
  return storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative(), root = storage.workspaceRoot();
    try {
      verifyLegacyAssetClassification(db, root);
      const admission = active(db);
      if (!admission) fail("ACCESS_DENIED", "Classification tools have no explicit native host admission.");
      authorize(admission, root, actor, host, invocation.tool);
      noOtherPending(db);
      const history = events(db), retry = history.find(e => e.operationId === invocation.operationId);
      if (retry) {
        if (retry.fingerprint !== fingerprint(admission, invocation)) fail("CONFLICT", "Classification operation ID was reused.");
        return retry.result;
      }
      if (db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(invocation.operationId))
        fail("CONFLICT", "Classification operation ID belongs to another workspace command.");
      const cache = sessions.get(session);
      if (!cache) fail("ACCESS_DENIED", "Classification preview session has ended.");
      const state = snapshot(root);
      if (invocation.tool === "asset_classify_preview") {
        const preview = legacyClassificationPreview.parse(original.preview(root, projectedFilesystem(root, state)));
        if (json(snapshot(root).inventory) !== json(state.inventory)) fail("SOURCE_CHANGED", "Classification source changed during preview.");
        if (cache.size >= 8) cache.delete(cache.keys().next().value!);
        cache.set(preview.id, { admission: json(admission), preview: structuredClone(preview) });
        return preview;
      }
      const retained = invocation.tool === "asset_classify_apply" ? cache.get(String(invocation.args.preview_id)) : undefined;
      if (retained && retained.admission !== json(admission)) fail("ACCESS_DENIED", "Classification preview admission changed.");
      const i = plan(root, admission, invocation, state, retained?.preview, history);
      if (json(snapshot(root).inventory) !== json(state.inventory)) fail("SOURCE_CHANGED", "Classification source changed before intent admission.");
      transaction(storage, db, () => {
        const payload = json(i);
        db.prepare("INSERT INTO legacy_asset_classification_intent VALUES(1,?,?)").run(payload, sha(payload));
      });
      host.checkpoint?.("intent");
      return resume(storage, db, actor, host, i);
    } finally { db.close(); }
  });
}
export async function invokeAdmittedLegacyAssetClassification(storage: Storage, actor: Actor,
  invocation: z.infer<typeof invocationSchema>, session: LegacyAssetClassificationSession) {
  const approved = await storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative();
    try { verifyLegacyAssetClassification(db, storage.workspaceRoot()); return active(db); }
    finally { db.close(); }
  });
  if (!approved) fail("ACCESS_DENIED", "Classification tools have no explicit native host admission.");
  return legacyAssetClassification(storage, actor, invocation, {
    authorize: binding => { const { operation, ...admission } = binding; return json(admission) === json(approved) && approved.allowedTools.some(t => t === operation); },
  }, session);
}
export async function reconcileLegacyAssetClassification(storage: Storage, actor: Actor, host: LegacyAssetClassificationHost) {
  return storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative();
    try {
      verifyLegacyAssetClassification(db, storage.workspaceRoot(), true);
      const admission = active(db);
      if (!admission) fail("ACCESS_DENIED", "Classification reconciliation requires its original admitted host.");
      authorize(admission, storage.workspaceRoot(), actor, host, "reconcile");
      const i = readIntent(db);
      return i ? resume(storage, db, actor, host, i) : null;
    } finally { db.close(); }
  });
}
