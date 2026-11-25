import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod";
import { legacyPrivateRootGuard } from "./legacy-effective-private-root.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { openOriginalMcpCustodyReader, verifyOriginalMcpRetirementCustody, type OriginalMcpPrepared } from "./original-mcp-root.js";
import {
  jsonDigest, originalMcpCommit, originalMcpCommitSchema, originalMcpFailure, originalMcpJournal,
  originalMcpManagedNames, originalMcpPreservedNamesForPlan, originalMcpPrivateBytes, originalMcpRollback,
  parseOriginalMcpPlan, readOriginalMcpJournal, type OriginalMcpPlan,
} from "./original-mcp-root-custody.js";
import { STORAGE_BOOTSTRAP_PROFILE_JSON } from "./storage-bootstrap-profile.js";
import { verifyLegacyRetrievalCorpus } from "./legacy-retrieval-index.js";
import { withOriginalMcpRetirementSqliteJournal } from "./original-mcp-cold-sqlite-read.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.literal("native-dogfood/v1");
const preparedSchema = z.strictObject({
  root: z.string(), workspaceId: z.string().uuid(), planSha256: digest, journalSha256: digest,
});
const b1Schema = z.strictObject({
  schema: z.literal("pkm.original-mcp-retirement-b1/v1"), scope,
  prepared: preparedSchema, backup: z.string(), profileSha256: digest,
  inventorySha256: digest, entries: z.number().int().positive(), bytes: z.number().int().nonnegative(),
  runtimeNames: z.array(z.string()).max(13), manifestSha256: digest,
});
export type OriginalMcpRetirementB1 = z.infer<typeof b1Schema>;
const ticketSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-retirement-ticket/v1"), scope,
  prepared: preparedSchema, b1: b1Schema, archive: z.string(), ticketSha256: digest,
});
export type OriginalMcpRetirementTicket = z.infer<typeof ticketSchema>;
export interface OriginalMcpRetirementOptions {
  /** Keep this exact actual cold fence across B1 capture, preparation and retirement. */
  readonly writerFence: LinuxRootWriterFence;
  readonly gitProtection?: { assertCurrent(): void };
  readonly checkpoint?: (point: "b1-durable" | "intent-durable" | "file-archived" | "completed") => void;
}
const inventoryName = "inventory.sqlite";
const marker = ".pkm-next-workspace";
const extraRuntime = new Set(["coding-process.sqlite", "coding-process.sqlite-wal", "coding-process.sqlite-shm", "coding-process.sqlite-journal",
  "core.sqlite-journal"]);
const runtimeNames = [...new Set([...originalMcpManagedNames, ...extraRuntime])].sort();
const sidecars = runtimeNames.filter(name => /sqlite-(?:wal|shm|journal)$/.test(name));
const optionalDomains = [".pkm-next-todo", ".pkm-next-memory", ".pkm-next-retrieval-models", ".pkm-action-authority",
  "coding-process.sqlite"];
const intentName = "intent.json";
const completeName = "complete.json";
const basicOperations = ["note", "skill", "research"].flatMap(kind =>
  ["create", "update"].map(action => `knowledge.${kind}.${action}`));
const inventoryRow = z.strictObject({
  path: z.string(), kind: z.enum(["file", "directory"]), identity: z.string(),
  sha256: digest.nullable(), blob: z.string().regex(/^\d{8}$/).nullable(),
  runtime: z.number().int().min(0).max(1), changed: z.number().int().min(0).max(1),
});
type Stat = Awaited<ReturnType<typeof lstat>>;
const identity = (stat: Stat) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size,
  stat.mtimeMs, stat.ctimeMs].join(":");
const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const archiveName = (expected: OriginalMcpPrepared) => `.pkm-next-original-mcp-retired-${expected.workspaceId}`;
function safePath(root: string, path: string) {
  if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path)
    || path.split("/").some(part => !part || part === "." || part === ".."))
    originalMcpFailure("Retirement inventory contains an unsafe path.");
  return join(root, ...path.split("/"));
}
function assertPrepared(plan: OriginalMcpPlan, expected: OriginalMcpPrepared) {
  const parsed = preparedSchema.parse(expected);
  if (parsed.root !== plan.root || parsed.planSha256 !== plan.planSha256)
    originalMcpFailure("Retirement requires the exact independently retained original preparation.");
}
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (resolve(path) !== path || await realpath(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid!() || stat.mode & 0o7077 || !legacyPrivateRootGuard(path))
    originalMcpFailure("Retirement requires canonical owned private backup and archive directories.");
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function durable(path: string, value: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(typeof value === "string" ? value : JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(dirname(path));
}
async function hashFile(path: string, maximumBytes: number, destination?: string): Promise<{ sha256: string; identity: string; size: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!()
    || before.mode & 0o7002 || before.size > maximumBytes)
    originalMcpFailure("Retirement requires bounded owned single-link regular files.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (identity(before) !== identity(await file.stat())) originalMcpFailure("Retirement source changed while opening.");
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(262_144);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) originalMcpFailure("Retirement source exceeded its explicit streaming bound.");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    if (bytes !== before.size || identity(before) !== identity(await file.stat()) || identity(before) !== identity(await lstat(path)))
      originalMcpFailure("Retirement source changed during streaming.");
    await output?.sync();
    return { sha256: hash.digest("hex"), identity: identity(before), size: bytes };
  } finally { await output?.close(); await file.close(); }
}
function databaseAt(path: string) {
  const url = pathToFileURL(path);
  url.search = "?immutable=1";
  return new DatabaseSync(url, { readOnly: true });
}
async function cold(plan: OriginalMcpPlan, options: OriginalMcpRetirementOptions) {
  if (process.platform !== "linux" || !legacyPrivateRootGuard(plan.root)
    || !isTrustedLinuxRootWriterFence(options.writerFence, plan.root))
    originalMcpFailure("Retirement requires the actual branded canonical Linux cold writer fence.");
  options.writerFence.assertHeld();
  if (exists(join(plan.root, ".git")) && !options.gitProtection)
    originalMcpFailure("Retirement requires retained private-state Git protection.");
  const result = options.gitProtection?.assertCurrent() as unknown;
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
      void Promise.resolve(result).catch(() => {});
    originalMcpFailure("Retirement Git protection must be synchronous and denial-only.");
  }
  await assertLinuxLegacyWritersQuiescent(plan.root);
  options.writerFence.assertHeld();
}
function assertNativeDatabase(path: string, expected: OriginalMcpPrepared) {
  const database = databaseAt(path);
  try {
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      originalMcpFailure("Retirement cannot archive a corrupt native database.");
    verifyLegacyRetrievalCorpus(database);
    const profile = JSON.parse(STORAGE_BOOTSTRAP_PROFILE_JSON) as {
      schemaSha256: string; tables: { name: string; role: string; rows?: string }[];
      derivedProfiles: { schemaSha256: string; tables: { name: string; role: string }[] }[];
    };
    const baseSchema = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE tbl_name NOT IN ('original_mcp_native_host_admissions','original_mcp_action_validation',
        'legacy_retrieval_corpus') ORDER BY name`).all();
    const profiles = [profile, ...profile.derivedProfiles].filter(item => item.schemaSha256 === jsonDigest(baseSchema));
    if (!profiles.length)
      originalMcpFailure("Native-dogfood retirement refuses an unknown or altered native database schema.");
    const known = new Set([...profile.tables, ...profile.derivedProfiles.flatMap(item => item.tables)].map(item => item.name));
    const seeds = new Map(profile.tables.filter(item => item.role === "seed").map(item => [item.name, item.rows]));
    known.add("original_mcp_native_host_admissions");
    known.add("original_mcp_action_validation");
    known.add("legacy_retrieval_corpus");
    for (const value of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()) {
      const name = String(value.name), quoted = `"${name.replaceAll('"', '""')}"`;
      if (!known.has(name))
        originalMcpFailure("Native-dogfood retirement refuses unknown tables or optional source-domain grants.");
      if (/(?:pending|intent)/.test(name) && database.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get())
        originalMcpFailure("Native-dogfood retirement refuses pending durable intents.");
      if (seeds.has(name) && JSON.stringify(database.prepare(`SELECT * FROM ${quoted}`).all()
        .map(row => JSON.stringify(row)).sort()) !== seeds.get(name))
        originalMcpFailure("Native-dogfood retirement refuses altered native schema seed state.");
      if (name.startsWith("legacy_") && name !== "legacy_retrieval_corpus"
        && !seeds.has(name) && database.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get())
        originalMcpFailure(`Native-dogfood retirement refuses optional legacy source-domain state or grants (${name}).`);
      if (!["receipts", "migration_runtime_knowledge_commits", "browser_mutation_pins", "sqlite_sequence"].includes(name)
        && profiles.every(item => item.tables.find(table => table.name === name)?.role === "empty")
        && database.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get())
        originalMcpFailure(`Native-dogfood retirement refuses state outside the shipped read/basic-write increment (${name}).`);
    }
    if (database.prepare(`SELECT 1 FROM receipts WHERE actor_id!='mcp:external'
      OR operation NOT IN (${basicOperations.map(() => "?").join(",")}) LIMIT 1`).get(...basicOperations))
      originalMcpFailure("Native-dogfood retirement refuses write receipts outside the six basic public create/update operations.");
    if (database.prepare(`SELECT 1 FROM migration_runtime_knowledge_commits AS k
      LEFT JOIN receipts AS r ON r.operation_id=k.operation_id
      WHERE r.operation_id IS NULL OR json_extract(k.request_json,'$.operation') IS NOT r.operation
        OR json_extract(k.request_json,'$.actorId') IS NOT r.actor_id
        OR json_extract(k.request_json,'$.args.operationId') IS NOT k.operation_id
        OR k.result_json IS NOT r.result OR k.workspace_id!=? LIMIT 1`).get(expected.workspaceId))
      originalMcpFailure("Native-dogfood retirement refuses unbound basic-write commit history.");
    if (database.prepare(`SELECT 1 FROM receipts AS r LEFT JOIN migration_runtime_knowledge_commits AS k
      ON k.operation_id=r.operation_id WHERE k.operation_id IS NULL LIMIT 1`).get())
      originalMcpFailure("Native-dogfood retirement refuses basic-write receipts without canonical commit history.");
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_mutation_pins'").get()) {
      const pin = z.strictObject({
        actor_id: z.literal("mcp:external"), operation_id: z.string().uuid(),
        operation: z.string().refine(value => basicOperations.includes(value)),
        body_sha256: digest, receipt_fingerprint: digest,
      });
      const receipt = database.prepare(`SELECT 1 FROM receipts
        WHERE operation_id=? AND actor_id=? AND operation=? AND fingerprint=?`);
      for (const row of database.prepare("SELECT * FROM browser_mutation_pins").iterate()) {
        const parsed = pin.safeParse(row);
        if (!parsed.success || !receipt.get(parsed.data.operation_id, parsed.data.actor_id,
          parsed.data.operation, parsed.data.receipt_fingerprint))
          originalMcpFailure("Native-dogfood retirement refuses unbound or unsettled basic-write transport pins.");
      }
    }
    for (const [table, condition] of [
      ["coding_worker_effects", "state='intent'"],
      ["coding_worker_records", "kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent'"],
    ]) if (known.has(table) && database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)
      && database.prepare(`SELECT 1 FROM "${table}" WHERE ${condition} LIMIT 1`).get())
      originalMcpFailure("Native-dogfood retirement refuses pending worker intents.");
  } finally { database.close(); }
}
async function active(plan: OriginalMcpPlan, expected: OriginalMcpPrepared, options: OriginalMcpRetirementOptions,
  preparing = false) {
  await cold(plan, options);
  assertPrepared(plan, expected);
  if (exists(join(plan.root, originalMcpRollback)) || !preparing && exists(join(plan.root, archiveName(expected))))
    originalMcpFailure("A pending rollback or retirement must resume its exact durable ticket.");
  const journal = readOriginalMcpJournal(plan.root);
  if (!journal || !same(journal.plan, plan) || journal.workspaceId !== expected.workspaceId
    || journal.journalSha256 !== expected.journalSha256)
    originalMcpFailure("Retirement preparation does not match actual original custody.");
  const workspace = JSON.parse(originalMcpPrivateBytes(join(plan.root, marker)).toString("utf8"));
  const commit = originalMcpCommitSchema.parse(JSON.parse(originalMcpPrivateBytes(join(plan.root, originalMcpCommit)).toString("utf8")));
  const { receiptSha256, ...body } = commit;
  if (workspace.schema !== "pkm.next-workspace/v2" || workspace.id !== expected.workspaceId
    || commit.journalSha256 !== expected.journalSha256 || jsonDigest(body) !== receiptSha256)
    originalMcpFailure("Retirement requires the exact committed original workspace.");
  if (sidecars.some(name => exists(join(plan.root, name))))
    originalMcpFailure("Retirement requires the actual owner closed and all SQLite sidecars reconciled.");
  if (optionalDomains.some(name => exists(join(plan.root, name))))
    originalMcpFailure("Native-dogfood retirement does not qualify optional source-domain or coding-process state.");
  await verifyOriginalMcpRetirementCustody(plan, preparing ? archiveName(expected) : undefined, extraRuntime, options.writerFence);
  assertNativeDatabase(join(plan.root, "core.sqlite"), expected);
}
const publicReceipt = z.object({
  operationId: z.string().uuid(), action: z.enum(["create", "update"]),
  area: z.enum(["notes", "skills", "papers"]), path: z.string().min(1),
  knowledgeId: z.string().min(1), sha256: digest,
});
function openCreationClaims(plan: OriginalMcpPlan, databasePath: string) {
  const database = databaseAt(databasePath);
  const policy = JSON.parse(originalMcpPrivateBytes(join(plan.root, ".pkm", "content-privacy.json"), 2_097_152).toString("utf8"));
  const address = "(json_extract(r.result,'$.area')||'/'||json_extract(r.result,'$.path'))";
  const creates = `FROM receipts AS r JOIN migration_runtime_knowledge_commits AS k ON k.operation_id=r.operation_id
    WHERE r.operation IN ('knowledge.note.create','knowledge.skill.create','knowledge.research.create')`;
  const creation = database.prepare(`SELECT r.operation,r.result ${creates} AND ${address}=?`);
  const descendant = database.prepare(`SELECT 1 ${creates} AND substr(${address},1,length(?)+1)=?||'/' LIMIT 1`);
  const latest = database.prepare(`SELECT r.operation,r.result FROM receipts AS r
    JOIN migration_runtime_knowledge_commits AS k ON k.operation_id=r.operation_id WHERE ${address}=? ORDER BY k.sequence DESC LIMIT 1`);
  const assertPublic = (path: string) => {
    safePath(plan.root, path);
    const [area, top, ...rest] = path.split("/");
    if (!["notes", "skills", "papers"].includes(area!) || [top, ...rest].some(part => part?.startsWith("."))
      || (policy.private[area!] ?? []).includes(top))
      originalMcpFailure("Native-dogfood retirement refuses new private, Trash or unknown content paths.");
  };
  const receipt = (raw: { operation?: unknown; result?: unknown }, path: string, action?: "create") => {
    const value = publicReceipt.parse(JSON.parse(String(raw.result)));
    const kind = value.area === "notes" ? "note" : value.area === "skills" ? "skill" : "research";
    if (`${value.area}/${value.path}` !== path || raw.operation !== `knowledge.${kind}.${value.action}`
      || action && value.action !== action)
      originalMcpFailure("New public content does not match its actual canonical create receipt.");
    return value;
  };
  return {
    assertPath(path: string, kind: "file" | "directory", sha256?: string | null) {
      assertPublic(path);
      if (kind === "directory") {
        if (!descendant.get(path, path))
          originalMcpFailure("Native-dogfood retirement refuses a new directory without a canonical public create.");
        return;
      }
      const created = creation.get(path), current = latest.get(path);
      if (!/\.md$/i.test(path) || !created || !current)
        originalMcpFailure("Native-dogfood retirement refuses a new file without its canonical public create.");
      const first = receipt(created, path, "create"), last = receipt(current, path);
      if (first.knowledgeId !== last.knowledgeId || last.sha256 !== sha256)
        originalMcpFailure("New public content changed outside its canonical create/update history.");
    },
    assertComplete(inventory: DatabaseSync, custody: Awaited<ReturnType<typeof openOriginalMcpCustodyReader>>) {
      for (const raw of database.prepare(`SELECT r.operation,r.result ${creates}`).iterate()) {
        const value = publicReceipt.parse(JSON.parse(String(raw.result))), path = `${value.area}/${value.path}`;
        assertPublic(path); receipt(raw, path, "create");
        const row = inventory.prepare("SELECT kind,sha256,changed FROM inventory WHERE path=? AND runtime=0").get(path);
        if (custody.entry(path) || !row || row.kind !== "file" || row.changed !== 1)
          originalMcpFailure("Canonical public creates must remain in place without replacing original custody paths.");
        this.assertPath(path, "file", String(row.sha256));
      }
    },
    close() { database.close(); },
  };
}
function assertCompatibleMarkdown(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) originalMcpFailure("Retained public edits must remain UTF-8 Markdown.");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return;
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) originalMcpFailure("Retained public Markdown has invalid metadata.");
  const metadata: unknown = document.toJS({ maxAliasCount: 0 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    originalMcpFailure("Retained public Markdown requires legacy-compatible metadata.");
  const legacy: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim(), raw = line.slice(index + 1).trim();
    if (!key) continue;
    try { legacy[key] = JSON.parse(raw); } catch { legacy[key] = raw.replace(/^["']|["']$/g, ""); }
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!same(value, legacy[key]))
      originalMcpFailure("Retained public edit is not compatible with the actual legacy4.0.22 line-metadata reader.");
  }
  if ("deleted" in metadata && metadata.deleted !== false || "documentKind" in metadata && metadata.documentKind !== "markdown")
    originalMcpFailure("Native-dogfood retirement retains only ordinary non-deleted public Markdown creates/updates.");
}
async function* originalRows(plan: OriginalMcpPlan): AsyncGenerator<{ path: string; kind: "file" | "directory" }> {
  let count = 0;
  async function* visit(path: string, depth: number): AsyncGenerator<{ path: string; kind: "file" | "directory" }> {
    if (++count > plan.limits.maxEntries || depth > plan.limits.maxDepth)
      originalMcpFailure("Retirement exceeded its original inventory entry/depth bound.");
    const stat = await lstat(safePath(plan.root, path));
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()
      || stat.uid !== process.getuid!() || stat.mode & 0o7002)
      originalMcpFailure("Retirement original inventory contains unsafe files or directories.");
    yield { path, kind: stat.isDirectory() ? "directory" : "file" };
    if (!stat.isDirectory()) return;
    const directory = await opendir(safePath(plan.root, path));
    for await (const entry of directory) yield* visit(`${path}/${entry.name}`, depth + 1);
    if (identity(stat) !== identity(await lstat(safePath(plan.root, path))))
      originalMcpFailure("Retirement original directory changed while streaming.");
  }
  for (const name of (await readdir(plan.root)).sort())
    if (originalMcpPreservedNamesForPlan(plan.schema).has(name)) yield* visit(name, 0);
}
function readB1(input: OriginalMcpRetirementB1) {
  const b1 = b1Schema.parse(input), { manifestSha256, ...body } = b1;
  if (jsonDigest(body) !== manifestSha256 || !same(JSON.parse(originalMcpPrivateBytes(join(b1.backup, "complete.json")).toString("utf8")), b1))
    originalMcpFailure("Retirement requires an independently pinned complete B1 preservation manifest.");
  return b1;
}

/**
 * Independent post-write preservation, not a legacy backup restore. Every original
 * and enumerated native file is streamed into private custody before any root move.
 * New public Markdown and its directories require the actual six-operation
 * canonical create/update history; unknown additions are not preservation grants.
 */
export async function captureOriginalMcpRetirementB1(input: OriginalMcpPlan, expected: OriginalMcpPrepared,
  request: { scope: "native-dogfood/v1"; backup: string }, options: OriginalMcpRetirementOptions): Promise<OriginalMcpRetirementB1> {
  const plan = parseOriginalMcpPlan(input);
  scope.parse(request.scope);
  await active(plan, expected, options);
  const backup = request.backup;
  const disjoint = (base: string, value: string) => {
    const rel = relative(base, value);
    return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  };
  if (resolve(backup) !== backup || !disjoint(plan.root, backup) || !disjoint(backup, plan.root)
    || !disjoint(plan.backup, backup) || !disjoint(backup, plan.backup))
    originalMcpFailure("B1 and original custody must use disjoint canonical private backup paths.");
  await privateDirectory(dirname(backup));
  await mkdir(backup, { mode: 0o700 });
  await mkdir(join(backup, "blobs"), { mode: 0o700 });
  await privateDirectory(backup);
  await durable(join(backup, ".gitignore"), "*\n");
  const path = join(backup, inventoryName);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await file.close();
  const database = new DatabaseSync(path), custody = await openOriginalMcpCustodyReader(plan);
  const claims = openCreationClaims(plan, join(plan.root, "core.sqlite"));
  let entries = 0, bytes = 0, blobs = 0, originals = 0;
  const native = runtimeNames.filter(name => exists(join(plan.root, name)));
  try {
    database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE inventory(path TEXT PRIMARY KEY,kind TEXT,identity TEXT,sha256 TEXT,blob TEXT,runtime INTEGER,changed INTEGER) STRICT;
      BEGIN IMMEDIATE;`);
    const insert = database.prepare("INSERT INTO inventory VALUES(?,?,?,?,?,?,?)");
    const capture = async (path: string, kind: "file" | "directory", runtime: number) => {
      options.writerFence.assertHeld(); custody.assertCurrent();
      const full = safePath(plan.root, path), stat = await lstat(full);
      const baseline = runtime ? undefined : custody.entry(path);
      if (baseline && baseline.kind !== kind)
        originalMcpFailure("Native-dogfood retirement refuses changed original source kinds.");
      if (baseline) originals++;
      let sha256: string | null = null, blob: string | null = null, changed = 0;
      if (kind === "file") {
        blob = String(++blobs).padStart(8, "0");
        const hashed = await hashFile(full, plan.limits.maxFileBytes, join(backup, "blobs", blob));
        sha256 = hashed.sha256; bytes += hashed.size;
        if (bytes > plan.limits.maxBytes) originalMcpFailure("B1 exceeded its explicit streaming byte bound.");
        changed = !runtime && baseline?.sha256 !== sha256 ? 1 : 0;
        if (changed) {
          if (baseline && !baseline.mutable || !/^(?:notes|skills|papers)\/.+\.md$/i.test(path) || hashed.size > 8_388_608)
            originalMcpFailure("Native-dogfood retirement retains only bounded public Markdown creates/updates.");
          assertCompatibleMarkdown(originalMcpPrivateBytes(join(backup, "blobs", blob), 8_388_608));
        }
      }
      if (!runtime && !baseline) claims.assertPath(path, kind, sha256);
      if (++entries > plan.limits.maxEntries + runtimeNames.length) originalMcpFailure("B1 exceeded its explicit entry bound.");
      insert.run(path, kind, identity(stat), sha256, blob, runtime, changed);
    };
    for await (const row of originalRows(plan)) await capture(row.path, row.kind, 0);
    if (originals !== plan.entries) originalMcpFailure("Native-dogfood retirement refuses removed original content.");
    claims.assertComplete(database, custody);
    for (const name of native) await capture(name, "file", 1);
    database.exec("COMMIT");
  } finally { claims.close(); database.close(); custody.close(); }
  await syncDirectory(join(backup, "blobs")); await syncDirectory(backup);
  const body = { schema: "pkm.original-mcp-retirement-b1/v1" as const, scope: request.scope,
    prepared: preparedSchema.parse(expected), backup, profileSha256: plan.profileSha256,
    inventorySha256: (await hashFile(path, 536_870_912)).sha256, entries, bytes, runtimeNames: native };
  const b1 = b1Schema.parse({ ...body, manifestSha256: jsonDigest(body) });
  await active(plan, expected, options);
  await durable(join(backup, "complete.json"), b1);
  await validateB1(plan, expected, b1);
  options.checkpoint?.("b1-durable");
  return b1;
}

async function validateB1(plan: OriginalMcpPlan, expected: OriginalMcpPrepared, input: OriginalMcpRetirementB1,
  archive?: string, moved: ReadonlySet<string> = new Set()) {
  await privateDirectory(b1Schema.parse(input).backup);
  const b1 = readB1(input);
  if (!same(b1.prepared, preparedSchema.parse(expected)) || b1.profileSha256 !== plan.profileSha256
    || b1.runtimeNames.some(name => !runtimeNames.includes(name) || name === originalMcpRollback)
    || new Set(b1.runtimeNames).size !== b1.runtimeNames.length
    || ![marker, originalMcpJournal, originalMcpCommit, "core.sqlite", ".pkm-next-writer-fenced.json"]
      .every(name => b1.runtimeNames.includes(name)))
    originalMcpFailure("B1 does not bind this exact committed original/native preparation.");
  for (const name of runtimeNames)
    if (exists(join(plan.root, name)) !== (b1.runtimeNames.includes(name) && !moved.has(name)))
      originalMcpFailure("B1 is stale: the enumerated native runtime files changed.");
  await privateDirectory(b1.backup); await privateDirectory(join(b1.backup, "blobs"));
  const inventoryPath = join(b1.backup, inventoryName), inventoryPin = await hashFile(inventoryPath, 536_870_912);
  if ((await readdir(b1.backup)).some(name => ![inventoryName, "blobs", "complete.json", ".gitignore"].includes(name))
    || inventoryPin.sha256 !== b1.inventorySha256)
    originalMcpFailure("B1 inventory changed or contains unknown preservation files.");
  const database = databaseAt(inventoryPath), custody = await openOriginalMcpCustodyReader(plan);
  const claims = openCreationClaims(plan, join(moved.has("core.sqlite") ? archive! : plan.root, "core.sqlite"));
  let entries = 0, bytes = 0, blobs = 0, originals = 0, observed = 0;
  try {
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") originalMcpFailure("B1 inventory is corrupt.");
    for (const raw of database.prepare("SELECT * FROM inventory ORDER BY path").iterate()) {
      const row = inventoryRow.parse(raw);
      entries++;
      if (row.runtime !== Number(b1.runtimeNames.includes(row.path))) originalMcpFailure("B1 runtime classification changed.");
      if (!row.runtime) {
        const baseline = custody.entry(row.path);
        if (baseline) {
          if (baseline.kind !== row.kind) originalMcpFailure("B1 original source kind changed.");
          originals++;
        } else claims.assertPath(row.path, row.kind, row.sha256);
      }
      const source = row.runtime && moved.has(row.path) ? safePath(archive!, row.path) : safePath(plan.root, row.path);
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || (row.kind === "directory" ? !stat.isDirectory() : !stat.isFile()))
        originalMcpFailure("B1 source shape changed.");
      // rename changes ctime; archived file bytes and remaining identity are still checked.
      if (moved.has(row.path)) {
        if (identity(stat).split(":").slice(0, -1).join(":") !== row.identity.split(":").slice(0, -1).join(":"))
          originalMcpFailure("An archived B1 file identity changed.");
      } else if (identity(stat) !== row.identity) originalMcpFailure("B1 is stale: the retained post-write source identity changed.");
      if (row.kind === "file") {
        if (!row.blob || (await hashFile(source, plan.limits.maxFileBytes)).sha256 !== row.sha256)
          originalMcpFailure("B1 is stale: retained post-write source bytes changed.");
        const payload = await hashFile(join(b1.backup, "blobs", row.blob), plan.limits.maxFileBytes);
        if (payload.sha256 !== row.sha256) originalMcpFailure("B1 preservation payload changed.");
        blobs++; bytes += payload.size;
      } else if (row.blob !== null || row.sha256 !== null || row.runtime) originalMcpFailure("Invalid B1 directory row.");
    }
    for await (const row of originalRows(plan)) {
      if (!database.prepare("SELECT 1 FROM inventory WHERE path=? AND runtime=0").get(row.path))
        originalMcpFailure("B1 is stale: an unknown original source appeared.");
      observed++;
    }
    claims.assertComplete(database, custody);
    if (originals !== plan.entries || entries !== b1.entries || entries !== observed + b1.runtimeNames.length
      || bytes !== b1.bytes || (await readdir(join(b1.backup, "blobs"))).length !== blobs)
      originalMcpFailure("B1 preservation inventory is incomplete or stale.");
  } finally { claims.close(); database.close(); custody.close(); }
  if (identity(await lstat(inventoryPath)) !== inventoryPin.identity)
    originalMcpFailure("B1 inventory identity changed during validation.");
}

/** Publishes a durable exact ticket only after independent live/B0/B1 checks. */
export async function prepareOriginalMcpRetirement(input: OriginalMcpPlan, expected: OriginalMcpPrepared,
  request: { scope: "native-dogfood/v1"; b1: OriginalMcpRetirementB1 },
  options: OriginalMcpRetirementOptions): Promise<OriginalMcpRetirementTicket> {
  const plan = parseOriginalMcpPlan(input);
  scope.parse(request.scope);
  await active(plan, expected, options, true);
  await validateB1(plan, expected, request.b1);
  const archive = join(plan.root, archiveName(expected));
  const body = { schema: "pkm.original-mcp-retirement-ticket/v1" as const, scope: request.scope,
    prepared: preparedSchema.parse(expected), b1: b1Schema.parse(request.b1), archive };
  const ticket = ticketSchema.parse({ ...body, ticketSha256: jsonDigest(body) });
  await cold(plan, options);
  if (!exists(archive)) await mkdir(archive, { mode: 0o700 });
  await privateDirectory(archive);
  if ((await readdir(archive)).some(name => ![".gitignore", intentName].includes(name)))
    originalMcpFailure("Retirement preparation contains unknown archive files.");
  if (!exists(join(archive, ".gitignore"))) await durable(join(archive, ".gitignore"), "*\n");
  if (exists(join(archive, intentName))) {
    if (!same(JSON.parse(originalMcpPrivateBytes(join(archive, intentName)).toString("utf8")), ticket))
      originalMcpFailure("Pending retirement belongs to another independently retained ticket.");
  } else await durable(join(archive, intentName), ticket);
  options.checkpoint?.("intent-durable");
  return ticket;
}

/**
 * Cold, write-preserving retirement for the explicit shipped dogfood increment,
 * not full-production parity, configuration restoration or old-source admission.
 * Existing public edits and receipt-bound public creates remain at their exact
 * paths/inodes; the result counts them separately.
 */
export async function retireOriginalMcpRoot(input: OriginalMcpPlan, expected: OriginalMcpPrepared,
  inputTicket: OriginalMcpRetirementTicket, options: OriginalMcpRetirementOptions):
  Promise<{ archive: string; ticketSha256: string; retainedPublicUpdates: number; retainedPublicCreates: number }> {
  const plan = parseOriginalMcpPlan(input), ticket = ticketSchema.parse(inputTicket);
  assertPrepared(plan, expected);
  const { ticketSha256, ...body } = ticket;
  if (jsonDigest(body) !== ticketSha256 || !same(ticket.prepared, preparedSchema.parse(expected))
    || ticket.archive !== join(plan.root, archiveName(expected)))
    originalMcpFailure("Retirement needs its exact independently retained durable ticket.");
  await cold(plan, options); await privateDirectory(ticket.archive);
  if (!same(JSON.parse(originalMcpPrivateBytes(join(ticket.archive, intentName)).toString("utf8")), ticket))
    originalMcpFailure("Retirement intent differs from the independently retained ticket.");
  const moved = new Set<string>();
  const check = async () => {
    await cold(plan, options);
    if (sidecars.some(name => exists(join(plan.root, name))) || exists(join(plan.root, originalMcpRollback))
      || optionalDomains.some(name => exists(join(plan.root, name))))
      originalMcpFailure("Retirement refuses pending rollback or reappeared SQLite sidecars.");
    moved.clear();
    for (const name of ticket.b1.runtimeNames) {
      const source = exists(join(plan.root, name)), archived = exists(join(ticket.archive, name));
      if (source === archived) originalMcpFailure("Retirement runtime location changed; no state was discarded.");
      if (archived) moved.add(name);
    }
    if ((await readdir(ticket.archive)).some(name => ![".gitignore", intentName, completeName, ...moved].includes(name)))
      originalMcpFailure("Retirement archive contains unknown files.");
    if (exists(join(ticket.archive, completeName))) {
      const completed = JSON.parse(originalMcpPrivateBytes(join(ticket.archive, completeName)).toString("utf8"));
      if (moved.size !== ticket.b1.runtimeNames.length || completed.schema !== "pkm.original-mcp-retirement-complete/v1"
        || completed.ticketSha256 !== ticketSha256)
        originalMcpFailure("Retirement completion appeared before all runtime files were archived.");
    }
    await validateB1(plan, expected, ticket.b1, ticket.archive, moved);
    if (moved.has(originalMcpJournal) && !moved.has("core.sqlite")) {
      await withOriginalMcpRetirementSqliteJournal(plan, expected, ticket, options.writerFence, context =>
        verifyOriginalMcpRetirementCustody(plan, archiveName(expected), extraRuntime, options.writerFence, context));
    } else await verifyOriginalMcpRetirementCustody(plan, archiveName(expected), extraRuntime, options.writerFence);
    assertNativeDatabase(join(moved.has("core.sqlite") ? ticket.archive : plan.root, "core.sqlite"), expected);
  };
  await check();
  // Preserve the workspace marker until the native database and custody controls
  // are archived; retire the actual legacy writer-fence marker absolutely last.
  const names = [...ticket.b1.runtimeNames].sort((a, b) => {
    const priority = (name: string) => name === ".pkm-next-writer-fenced.json" ? 2 : name === marker ? 1 : 0;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
  for (const name of names) {
    if (moved.has(name)) continue;
    await check();
    await options.writerFence.archiveFileToPrivateDirectory(join(plan.root, name), ticket.archive, name);
    await syncDirectory(plan.root); await syncDirectory(ticket.archive);
    options.checkpoint?.("file-archived");
  }
  await check();
  const database = databaseAt(join(ticket.b1.backup, inventoryName)), custody = await openOriginalMcpCustodyReader(plan);
  let retainedPublicUpdates = 0, retainedPublicCreates = 0;
  try {
    for (const row of database.prepare("SELECT path FROM inventory WHERE changed=1").iterate()) {
      if (custody.entry(String(row.path))) retainedPublicUpdates++;
      else retainedPublicCreates++;
    }
  } finally { database.close(); custody.close(); }
  const completion = { schema: "pkm.original-mcp-retirement-complete/v1", ticketSha256, retainedPublicUpdates, retainedPublicCreates };
  if (exists(join(ticket.archive, completeName))) {
    if (!same(JSON.parse(originalMcpPrivateBytes(join(ticket.archive, completeName)).toString("utf8")), completion))
      originalMcpFailure("Retirement completion differs from its durable ticket.");
  } else await durable(join(ticket.archive, completeName), completion);
  options.checkpoint?.("completed");
  return { archive: ticket.archive, ticketSha256, retainedPublicUpdates, retainedPublicCreates };
}
