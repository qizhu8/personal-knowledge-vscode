import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { coreDatabaseAuxiliaryFiles, coreDatabaseFile, coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { legacyPrivateRootGuard } from "./legacy-effective-private-root.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { acquireLinuxRootWriterFence, isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import {
  assertOriginalMcpPrivacy, jsonDigest, originalMcpAuxiliaryNames, originalMcpCommit, originalMcpCommitSchema,
  originalMcpFailure, originalMcpJournal, originalMcpJournalSchema, originalMcpLimits, originalMcpManagedNames,
  originalMcpPlanSchema, originalMcpPlanV2Schema, originalMcpPreservedNamesForPlan, originalMcpPrivateBytes, readOriginalMcpJournal,
  originalMcpRollback, parseOriginalMcpPlan, requireOriginalMcpScriptCustody, originalMcpPrivateTopLevels,
  type OriginalMcpJournal, type OriginalMcpPlan,
} from "./original-mcp-root-custody.js";
import type { RootOwner, RootOwnerOptions } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { originalTrashCustodyExceptions } from "./original-native-trash-custody.js";
import { originalMcpCoreHasSqliteAuxiliaries, withOriginalMcpColdSqliteRead,
  currentOriginalMcpColdSqliteReadContext, type OriginalMcpRetirementSqliteJournalContext } from "./original-mcp-cold-sqlite-read.js";

const pkmNames = new Set(["content-privacy.json", "knowledge-groups.json", "automation-output", "state"]);
const stateNames = new Set([
  "actions", "agent-groups", "agent-sessions", "agent-sessions-trash", "agent-snapshots",
  "api-chat-control", "api-chat-deletions", "api-chat-history", "api-chat-tool-results", "api-chat-worker-controls",
  "api-chat-worker-results", "api-chat-worker-trees", "api-chats", "diagnostics", "knowledge-deletions.json",
  "knowledge-snapshots", "knowledge-v1-migration", "mcp-usage", "project-store-migration", "project-store-repair",
  "project-store.json", "projects.json", "recipe-health.json", "recipe-runs", "recipe-store-migration", "recipe-store.json",
]);
const rowSchema = z.strictObject({
  path: z.string().min(1), kind: z.enum(["file", "directory"]),
  device: z.string(), inode: z.string(), mode: z.number().int(), uid: z.string(), gid: z.string(),
  size: z.string(), mtime: z.string(), ctime: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), blob: z.string().regex(/^\d{8}$/).nullable(),
  mutable: z.number().int().min(0).max(1),
});
type Row = z.infer<typeof rowSchema>;
const inventoryName = "inventory.sqlite";
const rootMarker = ".pkm-next-workspace";
const pin = (s: Awaited<ReturnType<typeof lstat>>): string =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
const within = (base: string, value: string) => {
  const rel = relative(base, value);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
function safePath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\")
    || path.split("/").some(part => !part || part === "." || part === ".."))
    originalMcpFailure("Custody contains an unsafe source path.");
  return join(root, ...path.split("/"));
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function writeExclusive(path: string, value: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}
async function hashFile(path: string, maximumBytes: number, destination?: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes)
    originalMcpFailure("Custody requires bounded, single-link regular source files; linked or oversized content is blocked.");
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (pin(before) !== pin(await input.stat())) originalMcpFailure("Custody source changed while opening.");
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(262_144);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) originalMcpFailure("Custody source exceeded its explicit bound during streaming.");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (output) {
        let offset = 0;
        while (offset < bytesRead) offset += (await output.write(chunk, offset, bytesRead - offset)).bytesWritten;
      }
    }
    if (bytes !== before.size || pin(before) !== pin(await input.stat()) || pin(before) !== pin(await lstat(path)))
      originalMcpFailure("Custody source changed during streaming; no successful receipt was published.");
    await output?.sync();
    return hash.digest("hex");
  } finally { await output?.close(); await input.close(); }
}
async function checkedRoot(root: string): Promise<void> {
  if (process.platform !== "linux" || resolve(root) !== root || !legacyPrivateRootGuard(root))
    originalMcpFailure("Original MCP custody requires a canonical Linux root protected by an owned private ancestor.");
}
export interface OriginalMcpFenceOptions { readonly writerFence?: LinuxRootWriterFence }
export interface OriginalMcpAdoptionOptions extends OriginalMcpFenceOptions {
  readonly checkpoint?: (point: "journal-durable" | "workspace-marker-durable" | "owner-open" | "commit-durable") => void;
  readonly prepareNative?: RootOwnerOptions["prepareNative"];
  readonly gitProtection?: { assertCurrent(): void };
}
function privateStateProtection(root: string, protection?: { assertCurrent(): void }): () => void {
  const check = protection?.assertCurrent.bind(protection);
  return () => {
    if (lstatSync(join(root, ".git"), { throwIfNoEntry: false }) && !check)
      originalMcpFailure("Git protection must be applied and retained before original-root private state is written.");
    const result = check?.() as unknown;
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
        void Promise.resolve(result).catch(() => {});
      originalMcpFailure("The private-state Git guard must be synchronous and denial-only.");
    }
  };
}
async function selectedFence(root: string, options: OriginalMcpFenceOptions): Promise<LinuxRootWriterFence> {
  const fence = options.writerFence ?? await acquireLinuxRootWriterFence(root);
  if (!isTrustedLinuxRootWriterFence(fence, root))
    originalMcpFailure("Original MCP maintenance requires its actual branded canonical Linux writer fence, not a callback or cold flag.");
  fence.assertHeld();
  return fence;
}
/** Retain this actual resource through external cold capture, custody and canonical-owner handoff. */
export async function acquireOriginalMcpRootFence(root: string): Promise<LinuxRootWriterFence> {
  await checkedRoot(root);
  const fence = await acquireLinuxRootWriterFence(root);
  try { await assertLinuxLegacyWritersQuiescent(root); return fence; }
  catch (error) { await fence.release(); throw error; }
}
async function checkedBackup(path: string): Promise<void> {
  if (resolve(path) !== path || await realpath(path) !== path)
    originalMcpFailure("Custody backup must be a canonical path.");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7077) !== 0)
    originalMcpFailure("Custody backup must remain an owned private directory.");
}
function openInventory(plan: OriginalMcpPlan): DatabaseSync {
  const url = pathToFileURL(join(plan.backup, inventoryName));
  url.search = "?immutable=1";
  return new DatabaseSync(url, { readOnly: true });
}
/** Selected domain hydration reads the sealed custody, never the tiny-fixture importer. */
export async function readOriginalMcpCustodyFile(input: OriginalMcpPlan, path: string, maximumBytes: number): Promise<Buffer> {
  const reader = await openOriginalMcpCustodyReader(input);
  try { return await reader.read(path, maximumBytes); } finally { reader.close(); }
}
/** One pinned streaming inventory connection for large, selected native source domains. */
export async function openOriginalMcpCustodyReader(input: OriginalMcpPlan) {
  const plan = parseOriginalMcpPlan(input);
  await checkedRoot(plan.root);
  const rootStat = await lstat(plan.root, { bigint: true });
  if (String(rootStat.dev) !== plan.device || String(rootStat.ino) !== plan.inode)
    originalMcpFailure("Selected custody belongs to another original root identity.");
  await checkedBackup(plan.backup);
  await checkedBackup(join(plan.backup, "blobs"));
  if (await hashFile(join(plan.backup, inventoryName), 536_870_912) !== plan.inventorySha256)
    originalMcpFailure("Selected domain custody inventory changed.");
  const inventoryPath = join(plan.backup, inventoryName), inventoryPin = pin(await lstat(inventoryPath));
  const database = openInventory(plan);
  const entryStatement = database.prepare("SELECT * FROM inventory WHERE path=?");
  let closed = false;
  const assertCurrent = () => {
    const root = lstatSync(plan.root, { bigint: true });
    if (closed || String(root.dev) !== plan.device || String(root.ino) !== plan.inode
      || pin(lstatSync(inventoryPath)) !== inventoryPin || !legacyPrivateRootGuard(plan.root))
      originalMcpFailure("The pinned original custody reader changed or closed.");
  };
  return {
    assertCurrent,
    entry(path: string): Row | undefined {
      safePath(plan.root, path); assertCurrent();
      const row = entryStatement.get(path);
      assertCurrent();
      return row ? rowSchema.parse(row) : undefined;
    },
    *entries(prefix: string): Iterable<Row> {
      safePath(plan.root, prefix); assertCurrent();
      const statement = database.prepare("SELECT * FROM inventory WHERE path=? OR substr(path,1,length(?)+1)=?||'/' ORDER BY path");
      for (const raw of statement.iterate(prefix, prefix, prefix)) {
        assertCurrent(); yield rowSchema.parse(raw);
      }
      assertCurrent();
    },
    async read(path: string, maximumBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 536_870_912)
      originalMcpFailure("Selected custody reads require an explicit bounded domain.");
    safePath(plan.root, path); assertCurrent();
    const row = database.prepare("SELECT * FROM inventory WHERE path=?").get(path) as Row | undefined;
    if (!row || row.kind !== "file" || !row.blob || !/^\d{8}$/.test(row.blob)
      || Number(row.size) > maximumBytes)
      originalMcpFailure("Selected domain source is absent or exceeds its explicit custody bound.");
    const checkAncestors = async () => {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const prefix = parts.slice(0, index).join("/");
        const expected = database.prepare("SELECT * FROM inventory WHERE path=?").get(prefix) as Row | undefined;
        const stat = await lstat(safePath(plan.root, prefix), { bigint: true });
        if (!expected || expected.kind !== "directory" || !stat.isDirectory() || stat.isSymbolicLink()
          || String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode
          || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7002n) !== 0n)
          originalMcpFailure("Selected domain source ancestor changed or became linked.");
      }
    };
    await checkAncestors();
    const source = safePath(plan.root, path), blob = join(plan.backup, "blobs", row.blob);
    if (await hashFile(source, maximumBytes) !== row.sha256 || await hashFile(blob, maximumBytes) !== row.sha256)
      originalMcpFailure("Selected domain source or its preserved bytes changed.");
    const bytes = originalMcpPrivateBytes(blob, maximumBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      originalMcpFailure("Selected domain custody changed during read.");
    await checkAncestors();
    assertCurrent();
    return bytes;
    },
    close() { if (!closed) { closed = true; database.close(); } },
  };
}
/** Serving checks only admitted public Script pins; private Script bytes and backup blobs are never opened. */
export async function verifyOriginalMcpPublicScriptCustody(root: string): Promise<void> {
  const journal = requireOriginalMcpScriptCustody(root);
  if (!journal) return;
  const plan = journal.plan, privateTopLevels = originalMcpPrivateTopLevels(root, "scripts");
  const reader = await openOriginalMcpCustodyReader(plan);
  try {
    const publicPath = (path: string) => !privateTopLevels.has(path.split("/")[1] ?? "");
    const expected = new Map([...reader.entries("scripts")].filter(row => publicPath(row.path)).map(row => [row.path, row]));
    const successors = await originalTrashCustodyExceptions(plan, path => {
      const entry = reader.entry(path);
      if (!entry) return undefined;
      const { blob: _blob, mutable: _mutable, ...row } = entry;
      return row;
    });
    for (const [path, row] of successors.controls) {
      if (path !== "scripts" && !path.startsWith("scripts/") || !publicPath(path)) continue;
      if (!row) expected.delete(path);
      else expected.set(path, { ...row, blob: null, mutable: 0 });
    }
    const found = new Set<string>();
    async function visit(path: string, depth: number): Promise<void> {
      if (!publicPath(path)) return;
      reader.assertCurrent();
      const baseline = expected.get(path);
      if (!baseline || depth > plan.limits.maxDepth)
        originalMcpFailure("Public Script membership differs from the frozen custody; explicit new custody is required.");
      let stat: BigIntStats;
      try { stat = await lstat(safePath(root, path), { bigint: true }); }
      catch { originalMcpFailure("An admitted public Script custody member is unavailable."); }
      const row: Row = {
        path, kind: stat.isDirectory() ? "directory" : "file", device: String(stat.dev), inode: String(stat.ino),
        mode: Number(stat.mode & 0o777n), uid: String(stat.uid), gid: String(stat.gid), size: String(stat.size),
        mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), sha256: null, blob: null, mutable: 0,
      };
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.isFile() && stat.nlink !== 1n
        || !equalRow(row, baseline))
        originalMcpFailure("Public Script identity or classification changed after custody capture.");
      found.add(path);
      if (stat.isDirectory()) {
        for (const name of (await readdir(safePath(root, path))).sort()) await visit(`${path}/${name}`, depth + 1);
      } else if (!baseline.sha256 || await hashFile(safePath(root, path), plan.limits.maxFileBytes) !== baseline.sha256)
        originalMcpFailure("Public Script bytes changed after custody capture.");
      reader.assertCurrent();
    }
    const scripts = lstatSync(join(root, "scripts"), { throwIfNoEntry: false });
    if (scripts) await visit("scripts", 0);
    if (found.size !== expected.size)
      originalMcpFailure("An admitted public Script custody member disappeared.");
    for (const path of found) {
      const baseline = expected.get(path)!;
      let stat: BigIntStats;
      try { stat = lstatSync(safePath(root, path), { bigint: true }); }
      catch { originalMcpFailure("An admitted public Script custody member disappeared during validation."); }
      if (String(stat.dev) !== baseline.device || String(stat.ino) !== baseline.inode
        || Number(stat.mode & 0o777n) !== baseline.mode || String(stat.uid) !== baseline.uid
        || String(stat.gid) !== baseline.gid || String(stat.size) !== baseline.size
        || String(stat.mtimeNs) !== baseline.mtime || String(stat.ctimeNs) !== baseline.ctime)
        originalMcpFailure("Public Script custody pins changed during validation.");
    }
    if (requireOriginalMcpScriptCustody(root)?.journalSha256 !== journal.journalSha256)
      originalMcpFailure("The public Script custody admission changed during validation.");
  } finally { reader.close(); }
}
async function checkLayout(root: string, allowManaged: boolean, archiveName?: string,
  additionalManagedNames: ReadonlySet<string> = new Set(),
  schema: OriginalMcpPlan["schema"] = "pkm.original-mcp-custody/v2"): Promise<string[]> {
  const auxiliary: string[] = [];
  const names = (await readdir(root)).sort();
  for (const name of names) {
    if (name === archiveName) { await checkedBackup(join(root, name)); continue; }
    if (allowManaged && (originalMcpManagedNames.has(name) || additionalManagedNames.has(name))) {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!()
        || (stat.mode & 0o7002) !== 0)
        originalMcpFailure("Original MCP managed state must be owned, safe single-link regular files.");
      continue;
    }
    if (allowManaged && name === ".pkm-next-retrieval-models" && readOriginalMcpJournal(root)) {
      await checkedBackup(join(root, name));
      const databasePath = coreDatabasePath(root), stat = await lstat(databasePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        originalMcpFailure("Native model custody requires the actual canonical database.");
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const { verifyLegacyRetrievalModels } = await import("./legacy-retrieval-model.js");
        verifyLegacyRetrievalModels(database, root);
      } finally { database.close(); }
      continue;
    }
    if (allowManaged && [".pkm-next-todo", ".pkm-next-memory"].includes(name) && readOriginalMcpJournal(root)) {
      const { verifyOriginalMcpDomainFiles } = await import("./original-mcp-domain-state.js");
      verifyOriginalMcpDomainFiles(root, name === ".pkm-next-todo" ? "todo" : "memory");
      continue;
    }
    if (allowManaged && name === ".pkm-action-authority" && readOriginalMcpJournal(root)) {
      const { verifyOriginalMcpActionNativeFootprint } = await import("./original-mcp-action-domain.js");
      if (!verifyOriginalMcpActionNativeFootprint(root))
        originalMcpFailure("Original Action native footprint requires its exact immutable custody/admission receipt.");
      continue;
    }
    if (originalMcpPreservedNamesForPlan(schema).has(name)) continue;
    if (!originalMcpAuxiliaryNames.has(name) && !/^_pre-files-backup[-_]\d[\w.-]*$/.test(name))
      originalMcpFailure("Unknown original root entries require a new explicit custody policy.");
    const stat = await lstat(join(root, name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) originalMcpFailure("Auxiliary roots must be real directories, never execution grants.");
    auxiliary.push(name);
  }
  for (const name of ["notes", ".pkm"]) {
    const stat = await lstat(join(root, name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) originalMcpFailure("Original MCP requires existing real Note and .pkm roots.");
  }
  const pkm = await readdir(join(root, ".pkm"));
  if (!pkm.includes("content-privacy.json") || pkm.some(name => !pkmNames.has(name)))
    originalMcpFailure("Unknown .pkm state requires an explicit preservation policy, not inherited authority.");
  if (pkm.includes("state")) {
    const state = await lstat(join(root, ".pkm", "state"));
    if (!state.isDirectory() || state.isSymbolicLink())
      originalMcpFailure("Original runtime state must be a real directory.");
    if ((await readdir(join(root, ".pkm", "state"))).some(name => !stateNames.has(name)))
      originalMcpFailure("Unknown original runtime state is not admitted by the MCP-only custody version.");
  }
  return auxiliary;
}
async function walkCustody(root: string, limits: OriginalMcpPlan["limits"], consume: (row: Row, full: string) => Promise<void>,
  schema: OriginalMcpPlan["schema"]) {
  let count = 0, bytes = 0;
  const privacy = JSON.parse(originalMcpPrivateBytes(join(root, ".pkm", "content-privacy.json"), 2_097_152).toString("utf8"));
  const mutable = (path: string) => {
    const [area, top] = path.split("/");
    return ["notes", "skills", "papers"].includes(area!) && top !== ".trash"
      && !(privacy.private[area!] ?? []).includes(top);
  };
  async function visit(path: string, depth: number) {
    if (++count > limits.maxEntries || depth > limits.maxDepth) originalMcpFailure("Custody inventory exceeded its explicit entry/depth bound.");
    const full = safePath(root, path), stat = await lstat(full, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.uid !== BigInt(process.getuid!())
      || (stat.mode & 0o7002n) !== 0n || stat.isFile() && stat.nlink !== 1n)
      originalMcpFailure("Preserved state contains linked, foreign-owned, special or world-writable content.");
    if (stat.isFile()) {
      bytes += Number(stat.size);
      if (bytes > limits.maxBytes || stat.size > BigInt(limits.maxFileBytes))
        originalMcpFailure("Custody inventory exceeded its explicit streaming byte bound.");
    }
    const row: Row = {
      path, kind: stat.isDirectory() ? "directory" : "file", device: String(stat.dev), inode: String(stat.ino),
      mode: Number(stat.mode & 0o777n), uid: String(stat.uid), gid: String(stat.gid), size: String(stat.size),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), sha256: null, blob: null, mutable: mutable(path) ? 1 : 0,
    };
    await consume(row, full);
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await visit(`${path}/${name}`, depth + 1);
      const after = await lstat(full, { bigint: true });
      if ([stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":")
        !== [after.dev, after.ino, after.mode, after.mtimeNs, after.ctimeNs].join(":"))
        originalMcpFailure("A preserved source directory changed while streaming.");
    }
  }
  for (const name of (await readdir(root)).sort())
    if (originalMcpPreservedNamesForPlan(schema).has(name)) await visit(name, 0);
  return { entries: count, bytes };
}
function equalRow(actual: Row, expected: Row) {
  return JSON.stringify({ ...actual, sha256: null, blob: null }) === JSON.stringify({ ...expected, sha256: null, blob: null });
}
async function verifyInventory(plan: OriginalMcpPlan, fullSource: boolean, runtime = false, archiveName?: string,
  additionalManagedNames?: ReadonlySet<string>) {
  await checkedRoot(plan.root);
  const rootStat = await lstat(plan.root, { bigint: true });
  if (String(rootStat.dev) !== plan.device || String(rootStat.ino) !== plan.inode)
    originalMcpFailure("Custody capture belongs to another original root identity.");
  await checkedBackup(plan.backup);
  await checkedBackup(join(plan.backup, "blobs"));
  if ((await readdir(plan.backup)).some(name => ![inventoryName, "blobs", "complete.json"].includes(name)))
    originalMcpFailure("Custody backup contains unknown or incomplete state.");
  if (await hashFile(join(plan.backup, inventoryName), 536_870_912) !== plan.inventorySha256)
    originalMcpFailure("Custody inventory differs from the independently retained plan.");
  const database = openInventory(plan);
  let successorManagedNames = new Set<string>();
  try {
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      originalMcpFailure("Custody inventory is corrupt.");
    let observed = 0;
    const found = new Set<string>();
    const successors = runtime ? await originalTrashCustodyExceptions(plan, path => {
      const raw = database.prepare("SELECT * FROM inventory WHERE path=?").get(path);
      if (!raw) return undefined;
      const { blob: _blob, mutable: _mutable, ...row } = rowSchema.parse(raw);
      return row;
    }) : undefined;
    successorManagedNames = successors?.managedNames ?? successorManagedNames;
    await walkCustody(plan.root, plan.limits, async (row, full) => {
      if (runtime && row.mutable) return;
      if (successors?.controls.has(row.path)) {
        const expected = successors.controls.get(row.path);
        const { blob: _blob, mutable: _mutable, ...actual } = row;
        if (!expected || JSON.stringify({ ...actual, sha256: null }) !== JSON.stringify({ ...expected, sha256: null })
          || row.kind === "file" && await hashFile(full, plan.limits.maxFileBytes) !== expected.sha256)
          originalMcpFailure("Original Trash custody successor identity or bytes changed.");
        found.add(row.path); observed++; return;
      }
      const expected = rowSchema.parse(database.prepare("SELECT * FROM inventory WHERE path=?").get(row.path));
      if (!equalRow(row, expected)) originalMcpFailure("Original source identity changed after custody capture.");
      if (fullSource && row.kind === "file" && await hashFile(full, plan.limits.maxFileBytes) !== expected.sha256)
        originalMcpFailure("Original source bytes changed after custody capture.");
      found.add(row.path);
      observed++;
    }, plan.schema);
    const expectedCount = Number(database.prepare(`SELECT count(*) AS n FROM inventory${runtime ? " WHERE mutable=0" : ""}`).get()?.n);
    if (successors?.controls.size) {
      for (const raw of database.prepare("SELECT * FROM inventory WHERE mutable=0").iterate()) {
        const row = rowSchema.parse(raw);
        if (!found.has(row.path) && successors.controls.get(row.path) !== null)
          originalMcpFailure("An unrelated immutable original source entry disappeared.");
      }
      for (const [path, row] of successors.controls)
        if (row && !found.has(path)) originalMcpFailure("A receipt-owned original Trash custody entry disappeared.");
    } else if (observed !== expectedCount) originalMcpFailure("Original source inventory changed after custody capture.");
    if (!runtime) {
      let totalBytes = 0;
      const blobs = new Set<string>();
      for (const value of database.prepare("SELECT * FROM inventory ORDER BY path").iterate()) {
        const row = rowSchema.parse(value);
        safePath(plan.root, row.path);
        if (!found.has(row.path)) originalMcpFailure("Custody source entry disappeared.");
        if (row.kind === "file") {
          if (!row.blob || await hashFile(join(plan.backup, "blobs", row.blob), plan.limits.maxFileBytes) !== row.sha256)
            originalMcpFailure("Custody backup payload changed or is incomplete.");
          totalBytes += Number(row.size);
          blobs.add(row.blob);
        }
      }
      if (observed !== plan.entries || totalBytes !== plan.bytes)
        originalMcpFailure("Custody totals do not match the retained plan.");
      const actual = await readdir(join(plan.backup, "blobs"));
      if (actual.length !== blobs.size || actual.some(name => !blobs.has(name)))
        originalMcpFailure("Custody payload inventory contains unknown or missing files.");
    }
  } finally { database.close(); }
  const managed = new Set([...(additionalManagedNames ?? []), ...successorManagedNames]);
  if (JSON.stringify(await checkLayout(plan.root, true, archiveName, managed, plan.schema)) !== JSON.stringify(plan.auxiliary))
    originalMcpFailure("Original root layout changed after custody capture.");
}

/**
 * Explicitly bounded archive-only state custody. Auxiliary tool environments/builds
 * are untouched, untrusted, unbacked and never execution authority in this path.
 */
export async function captureOriginalMcpCustody(request: {
  root: string; backup: string; operatorId: string; profileSha256: string;
  limits: OriginalMcpPlan["limits"]; preserveOpaquePrompts?: true;
}, options: OriginalMcpFenceOptions = {}): Promise<OriginalMcpPlan> {
  const limits = originalMcpLimits.parse(request.limits);
  const custodySchema = request.preserveOpaquePrompts === true ? "pkm.original-mcp-custody/v3" : "pkm.original-mcp-custody/v2";
  originalMcpPlanV2Schema.shape.operatorId.parse(request.operatorId);
  originalMcpPlanV2Schema.shape.profileSha256.parse(request.profileSha256);
  await checkedRoot(request.root);
  if (resolve(request.backup) !== request.backup || within(request.root, request.backup) || within(request.backup, request.root))
    originalMcpFailure("Original and custody backup roots must be disjoint canonical paths.");
  await checkedRoot(dirname(request.backup));
  const fence = await selectedFence(request.root, options);
  try {
    await assertLinuxLegacyWritersQuiescent(request.root);
    const auxiliary = await checkLayout(request.root, false, undefined, undefined, custodySchema);
    const privacyBytes = originalMcpPrivateBytes(join(request.root, ".pkm", "content-privacy.json"), 2_097_152);
    const { validatePrivacyPolicy } = await import("./legacy-content-privacy.js");
    validatePrivacyPolicy(privacyBytes);
    const policy = JSON.parse(privacyBytes.toString("utf8"));
    if (Object.values(policy.private).some(values => (values as string[]).some(value =>
      value !== value.trim() || /[/\\]/.test(value) || value === "." || value === "..")))
      originalMcpFailure("Original privacy entries require exact, unambiguous top-level names.");
    const { scanMarkdown } = await import("./markdown-read.js");
    if (!scanMarkdown(request.root).length)
      originalMcpFailure("Original MCP custody requires valid authoritative Note, Skill or Paper content.");
    const privacySha256 = createHash("sha256").update(privacyBytes).digest("hex");
    await mkdir(request.backup, { mode: 0o700 });
    await checkedBackup(request.backup);
    await mkdir(join(request.backup, "blobs"), { mode: 0o700 });
    const databasePath = join(request.backup, inventoryName);
    const file = await open(databasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
    const database = new DatabaseSync(databasePath);
    let totals: { entries: number; bytes: number };
    try {
      database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE inventory(path TEXT PRIMARY KEY,kind TEXT,device TEXT,inode TEXT,mode INTEGER,uid TEXT,gid TEXT,
          size TEXT,mtime TEXT,ctime TEXT,sha256 TEXT,blob TEXT,mutable INTEGER) STRICT; BEGIN IMMEDIATE;`);
      const insert = database.prepare("INSERT INTO inventory VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
      let blobs = 0;
      totals = await walkCustody(request.root, limits, async (row, full) => {
        fence.assertHeld();
        if (row.kind === "file") {
          row.blob = String(++blobs).padStart(8, "0");
          row.sha256 = await hashFile(full, limits.maxFileBytes, join(request.backup, "blobs", row.blob));
        }
        insert.run(...Object.values(row));
      }, custodySchema);
      database.exec("COMMIT");
    } finally { database.close(); }
    await syncDirectory(join(request.backup, "blobs"));
    await syncDirectory(request.backup);
    const root = await lstat(request.root, { bigint: true });
    const body = {
      schema: custodySchema, root: request.root, device: String(root.dev), inode: String(root.ino),
      operatorId: request.operatorId, profileSha256: request.profileSha256, backup: request.backup,
      inventorySha256: await hashFile(databasePath, 536_870_912), privacySha256, ...totals!, limits, auxiliary,
    };
    const plan = originalMcpPlanSchema.parse({ ...body, planSha256: jsonDigest(body) });
    await verifyInventory(plan, true);
    await assertLinuxLegacyWritersQuiescent(request.root);
    fence.assertHeld();
    await writeExclusive(join(request.backup, "complete.json"), plan);
    return plan;
  } finally { if (!options.writerFence) await fence.release(); }
}

export async function verifyOriginalMcpCustody(input: OriginalMcpPlan): Promise<OriginalMcpPlan> {
  const plan = parseOriginalMcpPlan(input);
  const { planSha256, ...body } = plan;
  if (jsonDigest(body) !== planSha256
    || JSON.stringify(JSON.parse(originalMcpPrivateBytes(join(plan.backup, "complete.json")).toString("utf8"))) !== JSON.stringify(plan))
    originalMcpFailure("Only a complete independently pinned custody capture can prepare original-root admission.");
  await verifyInventory(plan, true);
  return plan;
}

/** Retirement may retain public edits, but must independently verify every immutable original and B0 payload. */
export async function verifyOriginalMcpRetirementCustody(input: OriginalMcpPlan, archiveName?: string,
  additionalManagedNames: ReadonlySet<string> = new Set(), writerFence?: LinuxRootWriterFence,
  retirementJournal?: OriginalMcpRetirementSqliteJournalContext): Promise<void> {
  const plan = parseOriginalMcpPlan(input);
  if (JSON.stringify(JSON.parse(originalMcpPrivateBytes(join(plan.backup, "complete.json")).toString("utf8"))) !== JSON.stringify(plan))
    originalMcpFailure("Retirement requires the exact complete independently retained original custody.");
  if (lstatSync(coreDatabasePath(plan.root), { throwIfNoEntry: false })) {
    if (!writerFence) originalMcpFailure("Retirement custody requires its actual cold writer fence.");
    await withOriginalMcpColdSqliteRead(plan, writerFence,
      () => verifyInventory(plan, true, true, archiveName, additionalManagedNames), retirementJournal);
  } else await verifyInventory(plan, true, true, archiveName, additionalManagedNames);
  const database = openInventory(plan);
  try {
    let entries = 0, bytes = 0, blobs = 0;
    for (const raw of database.prepare("SELECT * FROM inventory ORDER BY path").iterate()) {
      const row = rowSchema.parse(raw);
      entries++;
      if (row.kind !== "file") continue;
      if (!row.blob || await hashFile(join(plan.backup, "blobs", row.blob), plan.limits.maxFileBytes) !== row.sha256)
        originalMcpFailure("Retirement original custody backup payload changed.");
      bytes += Number(row.size); blobs++;
    }
    if (entries !== plan.entries || bytes !== plan.bytes || (await readdir(join(plan.backup, "blobs"))).length !== blobs)
      originalMcpFailure("Retirement original custody inventory is incomplete or contains unknown payloads.");
  } finally { database.close(); }
}

export async function validateOriginalMcpWorkspace(root: string, token?: string, writerFence?: LinuxRootWriterFence): Promise<string> {
  await checkedRoot(root);
  if (lstatSync(join(root, originalMcpRollback), { throwIfNoEntry: false }))
    originalMcpFailure("Original MCP rollback is incomplete; no owner or workers may start.");
  const journal = assertOriginalMcpPrivacy(root);
  if (!journal) originalMcpFailure("Original MCP root has no custody journal.");
  const marker = JSON.parse(originalMcpPrivateBytes(join(root, rootMarker)).toString("utf8"));
  if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== journal.workspaceId)
    originalMcpFailure("Original MCP workspace identity differs from its durable custody plan.");
  const commitPath = join(root, originalMcpCommit);
  if (lstatSync(commitPath, { throwIfNoEntry: false })) {
    const commit = originalMcpCommitSchema.parse(JSON.parse(originalMcpPrivateBytes(commitPath).toString("utf8")));
    const { receiptSha256, ...body } = commit;
    if (commit.journalSha256 !== journal.journalSha256 || jsonDigest(body) !== receiptSha256)
      originalMcpFailure("Original MCP commit differs from its custody journal.");
  } else if (token !== journal.token) originalMcpFailure("Interrupted original MCP admission requires exact offline resume.");
  if (lstatSync(coreDatabasePath(root), { throwIfNoEntry: false }) && !originalMcpCoreHasSqliteAuxiliaries(root)
    && !currentOriginalMcpColdSqliteReadContext(journal.plan)) {
    const fence = writerFence ?? await acquireOriginalMcpRootFence(root);
    try { await withOriginalMcpColdSqliteRead(journal.plan, fence, () => verifyInventory(journal.plan, false, true)); }
    finally { if (!writerFence) await fence.release(); }
  } else await verifyInventory(journal.plan, false, true);
  return root;
}

export interface OriginalMcpPrepared {
  readonly root: string; readonly workspaceId: string; readonly planSha256: string; readonly journalSha256: string;
}
async function prepareLocked(plan: OriginalMcpPlan, fence: LinuxRootWriterFence, protect: () => void): Promise<OriginalMcpJournal> {
  if (lstatSync(join(plan.root, originalMcpRollback), { throwIfNoEntry: false }))
    originalMcpFailure("An interrupted original MCP rollback must finish before admission can resume.");
  const prior = readOriginalMcpJournal(plan.root);
  if (prior) {
    if (JSON.stringify(prior.plan) !== JSON.stringify(plan)) originalMcpFailure("Pending original MCP adoption belongs to another independently retained plan.");
    const verify = () => verifyInventory(plan, true, !!lstatSync(join(plan.root, originalMcpCommit), { throwIfNoEntry: false }));
    if (lstatSync(coreDatabasePath(plan.root), { throwIfNoEntry: false }) && !originalMcpCoreHasSqliteAuxiliaries(plan.root))
      await withOriginalMcpColdSqliteRead(plan, fence, verify);
    else await verify();
    return prior;
  }
  await checkLayout(plan.root, false, undefined, undefined, plan.schema);
  await verifyOriginalMcpCustody(plan);
  const body = { schema: plan.schema === "pkm.original-mcp-custody/v3" ? "pkm.original-mcp-root/v3" as const : plan.schema === "pkm.original-mcp-custody/v2"
    ? "pkm.original-mcp-root/v2" as const : "pkm.original-mcp-root/v1" as const,
    token: randomUUID(), workspaceId: randomUUID(), plan };
  const journal = originalMcpJournalSchema.parse({ ...body, journalSha256: jsonDigest(body) });
  fence.assertHeld();
  await assertLinuxLegacyWritersQuiescent(plan.root);
  protect();
  await writeExclusive(join(plan.root, originalMcpJournal), journal);
  assertOriginalMcpPrivacy(plan.root);
  return journal;
}
function prepared(journal: OriginalMcpJournal): OriginalMcpPrepared {
  return { root: journal.plan.root, workspaceId: journal.workspaceId,
    planSha256: journal.plan.planSha256, journalSha256: journal.journalSha256 };
}
export async function prepareOriginalMcpRoot(input: OriginalMcpPlan, options: OriginalMcpAdoptionOptions = {}): Promise<OriginalMcpPrepared> {
  const plan = parseOriginalMcpPlan(input), fence = await selectedFence(plan.root, options);
  try {
    const protect = privateStateProtection(plan.root, options.gitProtection);
    protect();
    await assertLinuxLegacyWritersQuiescent(plan.root);
    const journal = await prepareLocked(plan, fence, protect);
    options.checkpoint?.("journal-durable");
    protect();
    await ensureMarker(journal);
    options.checkpoint?.("workspace-marker-durable");
    return prepared(journal);
  } finally { if (!options.writerFence) await fence.release(); }
}
async function ensureMarker(journal: OriginalMcpJournal) {
  const path = join(journal.plan.root, rootMarker);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    const marker = JSON.parse(originalMcpPrivateBytes(path).toString("utf8"));
    if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== journal.workspaceId)
      originalMcpFailure("An existing workspace marker does not belong to original MCP recovery.");
    return;
  }
  await writeExclusive(path, { schema: "pkm.next-workspace/v2", id: journal.workspaceId });
}

/** Every owner start is cold-gated. Warm clients must attach to this actual owner through an authenticated broker. */
export async function openOriginalMcpRoot(input: OriginalMcpPlan, options: OriginalMcpAdoptionOptions = {}): Promise<OriginalMcpPrepared & { owner: RootOwner; storage: Storage }> {
  const plan = parseOriginalMcpPlan(input);
  let fence: LinuxRootWriterFence | undefined = await selectedFence(plan.root, options);
  let owner: RootOwner | undefined;
  try {
    const protect = privateStateProtection(plan.root, options.gitProtection);
    protect();
    await assertLinuxLegacyWritersQuiescent(plan.root);
    const journal = await prepareLocked(plan, fence, protect);
    options.checkpoint?.("journal-durable");
    protect();
    await ensureMarker(journal);
    options.checkpoint?.("workspace-marker-durable");
    const { RootOwner } = await import("./root-owner.js");
    owner = await RootOwner.acquire(plan.root, { writerFence: fence, originalMcpToken: journal.token,
      ...(options.prepareNative ? { prepareNative: options.prepareNative } : {}), assertPrivateStateProtection: protect });
    fence = undefined;
    const { Storage } = await import("./storage.js");
    const storage = await Storage.attach(owner, { deferRecovery: options.prepareNative !== undefined });
    protect();
    options.checkpoint?.("owner-open");
    await verifyInventory(plan, false, true);
    await assertLinuxLegacyWritersQuiescent(plan.root);
    protect();
    if (!lstatSync(join(plan.root, originalMcpCommit), { throwIfNoEntry: false })) {
      const body = { schema: "pkm.original-mcp-root-commit/v1" as const, journalSha256: journal.journalSha256,
        databaseSha256: await hashFile(coreDatabasePath(plan.root), 536_870_912) };
      await writeExclusive(join(plan.root, originalMcpCommit), { ...body, receiptSha256: jsonDigest(body) });
    }
    options.checkpoint?.("commit-durable");
    return { ...prepared(journal), owner, storage };
  } catch (error) { await owner?.close(); throw error; }
  finally { if (!options.writerFence) await fence?.release(); }
}

const rollbackIntentSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-rollback/v1"),
  prepared: z.strictObject({ root: z.string(), workspaceId: z.string().uuid(),
    planSha256: z.string(), journalSha256: z.string() }),
  files: z.array(z.strictObject({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(5),
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * Unchanged-source rollback never rewrites an original inode. All native state,
 * including B1 SQLite state, is archived, not deleted. Changed original content
 * requires separately captured B1 plus an explicit restore/rebind protocol.
 */
export async function rollbackOriginalMcpRoot(input: OriginalMcpPlan, expected: OriginalMcpPrepared,
  options: { checkpoint?: (point: "intent" | "file-archived" | "completed") => void;
    gitProtection?: { assertCurrent(): void } } = {}): Promise<{ archive: string }> {
  const plan = parseOriginalMcpPlan(input);
  if (expected.root !== plan.root || expected.planSha256 !== plan.planSha256
    || !z.string().uuid().safeParse(expected.workspaceId).success)
    originalMcpFailure("Rollback needs the independently retained exact original MCP preparation.");
  const fence = await acquireLinuxRootWriterFence(plan.root);
  try {
    const protect = privateStateProtection(plan.root, options.gitProtection);
    protect();
    if ([".pkm-next-retrieval-models", ".pkm-next-todo", ".pkm-next-memory", ".pkm-action-authority"]
      .some(name => lstatSync(join(plan.root, name), { throwIfNoEntry: false })))
      originalMcpFailure("Native private model/domain state requires independent B1 preservation and explicit engine retirement; unchanged-source rollback will not discard it.");
    await assertLinuxLegacyWritersQuiescent(plan.root);
    const archiveName = `.pkm-next-original-mcp-rollback-${expected.workspaceId}`;
    await verifyInventory(plan, true, false, archiveName);
    protect();
    const archive = join(plan.root, archiveName);
    const intentPath = join(archive, "intent.json");
    let intent: z.infer<typeof rollbackIntentSchema>;
    if (lstatSync(intentPath, { throwIfNoEntry: false })) {
      await checkedBackup(archive);
      intent = rollbackIntentSchema.parse(JSON.parse(originalMcpPrivateBytes(intentPath).toString("utf8")));
      const { intentSha256, ...body } = intent;
      if (jsonDigest(body) !== intentSha256 || JSON.stringify(intent.prepared) !== JSON.stringify(expected))
        originalMcpFailure("Rollback archive belongs to another independently retained preparation.");
    } else {
      const journal = readOriginalMcpJournal(plan.root);
      if (!journal || JSON.stringify(prepared(journal)) !== JSON.stringify(expected))
        originalMcpFailure("Rollback does not match the durable original MCP custody journal.");
      for (const name of coreDatabaseAuxiliaryFiles)
        if (lstatSync(join(plan.root, name), { throwIfNoEntry: false }))
          originalMcpFailure("Close the real owner and reconcile all SQLite sidecars before rollback.");
      await mkdir(archive, { mode: 0o700 });
      await checkedBackup(archive);
      const ignore = await open(join(archive, ".gitignore"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await ignore.writeFile("*\n"); await ignore.sync(); } finally { await ignore.close(); }
      const files = [];
      for (const name of [rootMarker, originalMcpJournal, originalMcpCommit, coreDatabaseFile, ".pkm-next-writer-fenced.json"])
        if (lstatSync(join(plan.root, name), { throwIfNoEntry: false }))
          files.push({ name, sha256: await hashFile(join(plan.root, name), 536_870_912) });
      const body = { schema: "pkm.original-mcp-rollback/v1" as const, prepared: expected, files };
      intent = rollbackIntentSchema.parse({ ...body, intentSha256: jsonDigest(body) });
      await writeExclusive(intentPath, intent);
    }
    const names = [rootMarker, originalMcpJournal, originalMcpCommit, coreDatabaseFile, ".pkm-next-writer-fenced.json"];
    if (intent.files.some(file => !names.includes(file.name)) || new Set(intent.files.map(file => file.name)).size !== intent.files.length)
      originalMcpFailure("Rollback archive contains an invalid managed-file inventory.");
    const completedPath = join(archive, "complete.json");
    if (lstatSync(completedPath, { throwIfNoEntry: false })) {
      const value = JSON.parse(originalMcpPrivateBytes(completedPath).toString("utf8"));
      if (value.intentSha256 !== intent.intentSha256) originalMcpFailure("Rollback completion differs from its durable intent.");
    }
    if (lstatSync(join(plan.root, rootMarker), { throwIfNoEntry: false })) {
      fence.renameNoReplaceWithinRoot(join(plan.root, rootMarker), join(plan.root, originalMcpRollback));
      await syncDirectory(plan.root);
      options.checkpoint?.("intent");
    }
    for (const file of [...intent.files].sort((a, b) => Number(a.name === rootMarker) - Number(b.name === rootMarker))) {
      const source = join(plan.root, file.name === rootMarker ? originalMcpRollback : file.name);
      const target = join(archive, file.name);
      const inSource = !!lstatSync(source, { throwIfNoEntry: false }), inArchive = !!lstatSync(target, { throwIfNoEntry: false });
      if (inSource === inArchive || await hashFile(inSource ? source : target, 536_870_912) !== file.sha256)
        originalMcpFailure("Rollback managed-file location or bytes changed; nothing was discarded.");
      if (!inSource) continue;
      for (const name of coreDatabaseAuxiliaryFiles)
        if (lstatSync(join(plan.root, name), { throwIfNoEntry: false })) originalMcpFailure("SQLite sidecars reappeared during rollback.");
      await verifyInventory(plan, true, false, archiveName);
      await assertLinuxLegacyWritersQuiescent(plan.root);
      fence.assertHeld();
      await fence.archiveFileToPrivateDirectory(source, archive, file.name);
      await syncDirectory(plan.root);
      await syncDirectory(archive);
      options.checkpoint?.("file-archived");
    }
    if (!lstatSync(completedPath, { throwIfNoEntry: false }))
      await writeExclusive(completedPath, { schema: "pkm.original-mcp-rollback-complete/v1", intentSha256: intent.intentSha256 });
    options.checkpoint?.("completed");
    return { archive };
  } finally { await fence.release(); }
}
