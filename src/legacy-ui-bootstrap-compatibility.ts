import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectLegacyApiChatArchive, type LegacyApiChatEntity } from "./legacy-api-chat-archive.js";
import { legacyManagedApiChatRoots } from "./legacy-api-chat-managed-archive.js";
import { inspectLegacyUiRetiredState } from "./legacy-ui-retired-state.js";
import { legacyProjectDomainDigest, parseLegacyProjectControl } from "./legacy-control-import.js";
import { validateProjectRecipeExport } from "./import-parity-project.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { validateRecipeRecord } from "./domain/project-recipes-storage-rules.js";
import { inspectLegacyUiDeletionJournal, legacyUiDeletionJournalPath, type LegacyUiDeletionJournalSummary } from "./legacy-ui-deletion-journal.js";
import { validateLegacyRecipeRunArchive, validateLegacyRecipeHealthArchive } from "./legacy-ui-recipe-receipts.js";
import { legacyPathHasNoSymlinks, legacyPrivateRootGuard, sameLegacyPrivateRoot, type LegacyPrivateRootGuard } from "./legacy-effective-private-root.js";

export interface LegacyUiBootstrapCompatibility {
  schema: "pkm.legacy-ui-bootstrap-compatibility/v1";
  root: string;
  sourceFingerprint: string;
  privateRootGuard?: LegacyPrivateRootGuard;
  files: LegacyApiChatEntity[];
  knowledgeDeletions?: LegacyUiDeletionJournalSummary;
  project: {
    rootId: string; storeVersion: number; sourceDigest: string; canonicalDigest: string;
    orderedReceiptSha256: string;
    counts: { projects: number; threads: number; ganttTasks: number; collaborationTasks: number; recipes: number };
  };
  components: {
    project: "verified-cutover";
    recipes: "validated-preserved-envelope";
    actions: "blocked-no-workers";
    telemetry: "paired-completed";
    knowledgeDeletions?: "validated-preserved-original-sync-only";
  };
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "LEGACY_UI_COMPATIBILITY_BLOCKED" });
}
function pinnedBytes(root: string, file: LegacyApiChatEntity): Buffer {
  if (file.kind !== "file" || !file.sha256) fail("A compatibility source must have an exact file digest.");
  const path = join(root, file.path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || String(opened.dev) !== file.device || String(opened.ino) !== file.inode
      || Number(opened.size) !== file.size || String(opened.mtimeNs) !== file.mtimeNs || String(opened.ctimeNs) !== file.ctimeNs)
      fail("Compatibility file identity changed before reading.");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (after.ctimeNs !== opened.ctimeNs || after.mtimeNs !== opened.mtimeNs || after.size !== opened.size
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.ctimeNs !== opened.ctimeNs || current.mtimeNs !== opened.mtimeNs || current.size !== opened.size
      || bytes.length !== file.size || hash(bytes) !== file.sha256)
      fail("Compatibility bytes changed during reading.");
    return bytes;
  } finally { closeSync(fd); }
}

/**
 * A completed legacy cutover is not a pending intent. Accept it only after the
 * original envelope, backup, canonical control and actual tree agree. No legacy
 * writer is invoked, no marker is removed, and blocked Actions gain no authority.
 */
export function inspectLegacyUiBootstrapCompatibility(root: string): LegacyUiBootstrapCompatibility | undefined {
  const retired = inspectLegacyUiRetiredState(root);
  if (!retired) return undefined;
  if (retired.recipeEvolution && lstatSync(join(root, "recipes"), { throwIfNoEntry: false }))
    fail("Mixed original ProjectStore and filesystem Recipe authorities require explicit reconciliation.");
  const known = new Set(["actions", "api-chats", "api-chat-history", "agent-groups", "diagnostics", "mcp-usage",
    "project-store-migration", "project-store.json", "projects.json", "knowledge-deletions.json"]);
  if (retired.recipeEvolution) { known.add("recipe-runs"); known.add("recipe-health.json"); }
  if (legacyManagedApiChatRoots.some(name => readdirSync(join(root, ".pkm/state")).includes(name))) {
    if (!inspectLegacyApiChatArchive(root)?.managed) fail("Original managed Chat state has no exact archive receipt.");
    for (const name of legacyManagedApiChatRoots) known.add(name);
  }
  const unknown = readdirSync(join(root, ".pkm/state")).find(name => !known.has(name));
  if (unknown) fail(`Unknown or pending original state requires original-writer reconciliation: .pkm/state/${unknown}`);
  const files = new Map(retired.files.map(file => [file.path, file]));
  const rootGuard = retired.privateRootGuard ?? legacyPrivateRootGuard(root);
  let usesPrivateRootGuard = !!retired.privateRootGuard;
  let total = 0;
  function walk(relative: string, depth = 0): void {
    if (depth > 32 || files.size >= 20_000) fail("Project tree exceeds its bounded compatibility limits.");
    const path = join(root, relative), before = lstatSync(path, { bigint: true });
    const sharedProjectDirectory = before.isDirectory() && (relative === "project" || relative.startsWith("project/"));
    const needsGuard = (Number(before.mode) & 0o077) !== 0;
    if (needsGuard && rootGuard && sharedProjectDirectory && (Number(before.mode) & 0o7002) === 0)
      usesPrivateRootGuard = true;
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())
      || (Number(before.mode) & 0o7000) !== 0
      || needsGuard && !(rootGuard && sharedProjectDirectory && (Number(before.mode) & 0o002) === 0)
      || before.uid !== BigInt(process.getuid!()) || !legacyPathHasNoSymlinks(root, relative)
      || before.isFile() && (before.nlink !== 1n || before.size > 2_097_152n))
      fail("Canonical Project tree must be private, owned and free of aliases or special files.");
    const file: LegacyApiChatEntity = { path: relative, kind: before.isDirectory() ? "directory" : "file",
      mode: Number(before.mode & 0o777n), size: Number(before.size), device: String(before.dev), inode: String(before.ino),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
    if (before.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(`${relative}/${name}`, depth + 1);
    } else {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino) fail("Project file identity changed.");
        const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
          || BigInt(bytes.length) !== before.size) fail("Project file changed during compatibility inspection.");
        total += bytes.length;
        if (total > 67_108_864) fail("Project tree exceeds 64 MiB.");
        file.sha256 = hash(bytes);
      } finally { closeSync(fd); }
    }
    files.set(relative, file);
  }
  walk("project");
  const archivedRuns = new Map<string, Record<string, any>>();
  if (retired.recipeEvolution && lstatSync(join(root, ".pkm/state/recipe-runs"), { throwIfNoEntry: false })) {
    walk(".pkm/state/recipe-runs");
    for (const [path, file] of files) if (path.startsWith(".pkm/state/recipe-runs/")) {
      if (file.kind !== "file" || !/^recipe_run_[a-f0-9]{24}\.json$/.test(path.split("/").at(-1)!))
        fail("Unknown or locked original Recipe run must remain blocked.");
      try {
        const value = JSON.parse(pinnedBytes(root, file).toString("utf8"));
        validateLegacyRecipeRunArchive(value, path.split("/").at(-1)!); archivedRuns.set(value.runId, value);
      }
      catch { fail("Malformed or unsupported original Recipe run archive."); }
    }
  }
  if (retired.recipeEvolution && lstatSync(join(root, ".pkm/state/recipe-health.json"), { throwIfNoEntry: false })) {
    walk(".pkm/state/recipe-health.json");
    try { validateLegacyRecipeHealthArchive(JSON.parse(pinnedBytes(root, files.get(".pkm/state/recipe-health.json")!).toString("utf8")), archivedRuns); }
    catch { fail("Malformed, unpaired or pending original Recipe health archive."); }
  } else if ([...archivedRuns.values()].some(run => run.status === "completed")) fail("Completed original Recipe has no health archive.");
  let knowledgeDeletions: LegacyUiDeletionJournalSummary | undefined;
  if (readdirSync(join(root, ".pkm/state")).includes("knowledge-deletions.json")) {
    walk(legacyUiDeletionJournalPath);
    try { knowledgeDeletions = inspectLegacyUiDeletionJournal(root, pinnedBytes(root, files.get(legacyUiDeletionJournalPath)!)); }
    catch (error) { fail(`Original knowledge deletion journal cannot be preserved safely: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const entries = [...files.values()];
  const source = JSON.parse(pinnedBytes(root, files.get(".pkm/state/projects.json")!).toString("utf8"));
  const state = source.payload.state;
  const summary = validateProjectRecipeExport(root, entries.filter(file => file.path === "project" || file.path.startsWith("project/"))
    .map(file => ({ source: file.path, kind: file.kind, size: file.size })));
  for (const field of ["projects", "threads", "ganttTasks", "collaborationTasks"] as const) {
    const id = { projects: "projectId", threads: "threadId", ganttTasks: "taskId", collaborationTasks: "collaborationId" }[field];
    const sorted = (records: Array<Record<string, unknown>>) => [...records].sort((a, b) => String(a[id]).localeCompare(String(b[id])));
    if (canonicalJson(sorted(summary[field])) !== canonicalJson(sorted(state[field])))
      fail(`Canonical ${field} differ from the retained legacy envelope; an old-writer conflict cannot be reconciled automatically.`);
  }
  const control = parseLegacyProjectControl(pinnedBytes(root, files.get(".pkm/state/project-store.json")!), summary);
  const canonicalDigest = legacyProjectDomainDigest({ ...summary, rootId: state.rootId, storeVersion: source.storeVersion });
  if (control.rootId !== state.rootId || control.storeVersion !== source.storeVersion
    || control.canonicalDigest !== canonicalDigest || control.control.migration?.canonicalDigest !== canonicalDigest
    || control.control.migration?.sourceDigest !== (retired.recipeEvolution?.baselineDigest ?? source.digest)
    || control.control.migration?.phase !== "cutover"
    || canonicalJson(control.receipts) !== canonicalJson(retired.recipeEvolution?.receipts ?? source.payload.receipts))
    fail("Canonical Project control, migration and ordered receipts disagree with the original envelope.");
  for (const recipe of state.recipes) {
    try { validateRecipeRecord(recipe); }
    catch { fail("Preserved built-in Recipe fails the captured native workflow contract."); }
  }
  for (const file of entries) {
    const after = lstatSync(join(root, file.path), { bigint: true });
    if (String(after.dev) !== file.device || String(after.ino) !== file.inode || Number(after.size) !== file.size
      || String(after.mtimeNs) !== file.mtimeNs || String(after.ctimeNs) !== file.ctimeNs
      || file.sha256 && hash(pinnedBytes(root, file)) !== file.sha256)
      fail("Original compatibility source changed during inspection.");
  }
  const ordered = entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (usesPrivateRootGuard && (!rootGuard || !sameLegacyPrivateRoot(root, rootGuard)))
    fail("The private legacy root changed during compatibility inspection.");
  const project = { rootId: state.rootId, storeVersion: source.storeVersion, sourceDigest: source.digest, canonicalDigest,
    orderedReceiptSha256: hash(canonicalJson(control.receipts)),
    counts: { projects: summary.projects.length, threads: summary.threads.length, ganttTasks: summary.ganttTasks.length,
      collaborationTasks: summary.collaborationTasks.length, recipes: state.recipes.length } };
  return { schema: "pkm.legacy-ui-bootstrap-compatibility/v1", root, files: ordered,
    ...(knowledgeDeletions ? { knowledgeDeletions } : {}),
    ...(usesPrivateRootGuard ? { privateRootGuard: rootGuard } : {}),
    sourceFingerprint: hash(canonicalJson({ files: ordered, project,
      ...(usesPrivateRootGuard ? { privateRootGuard: rootGuard } : {}) })), project,
    components: { project: "verified-cutover", recipes: "validated-preserved-envelope", actions: "blocked-no-workers", telemetry: "paired-completed",
      ...(knowledgeDeletions ? { knowledgeDeletions: "validated-preserved-original-sync-only" as const } : {}) } };
}

export const legacyUiBootstrapCompatibilityDdl = `
  CREATE TABLE IF NOT EXISTS legacy_ui_bootstrap_compatibility(
    workspace_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
    original_projects BLOB NOT NULL CHECK(typeof(original_projects)='blob')
  );
`;
export function recordLegacyUiBootstrapCompatibility(
  db: DatabaseSync, workspaceId: string, expected: LegacyUiBootstrapCompatibility,
): void {
  if (!db.isTransaction) fail("Compatibility admission requires the native migration transaction.");
  const actual = inspectLegacyUiBootstrapCompatibility(expected.root);
  if (!actual || canonicalJson(actual) !== canonicalJson(expected)) fail("Compatibility source differs from its prepared journal.");
  db.exec(legacyUiBootstrapCompatibilityDdl);
  const payload = canonicalJson(expected), bytes = pinnedBytes(expected.root, expected.files.find(file => file.path === ".pkm/state/projects.json")!);
  const existing = db.prepare("SELECT payload,payload_sha256,original_projects FROM legacy_ui_bootstrap_compatibility WHERE workspace_id=?").get(workspaceId);
  if (existing) {
    if (existing.payload !== payload || existing.payload_sha256 !== hash(payload)
      || !Buffer.from(existing.original_projects as Uint8Array).equals(bytes)) fail("Existing compatibility receipt conflicts with recovery.");
    return;
  }
  db.prepare("INSERT INTO legacy_ui_bootstrap_compatibility VALUES(?,?,?,?)").run(workspaceId, payload, hash(payload), bytes);
}

export function verifyLegacyUiBootstrapCompatibility(
  db: DatabaseSync, workspaceId: string, expected: LegacyUiBootstrapCompatibility, allowMissing = false,
): void {
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='legacy_ui_bootstrap_compatibility' ORDER BY type,name";
  const objects = db.prepare(query).all();
  if (!objects.length && allowMissing) return;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(legacyUiBootstrapCompatibilityDdl);
    if (canonicalJson(objects) !== canonicalJson(reference.prepare(query).all()))
      fail("Compatibility receipt schema differs from the native fixed DDL.");
  } finally { reference.close(); }
  const rows = db.prepare("SELECT * FROM legacy_ui_bootstrap_compatibility").all();
  if (!rows.length && allowMissing) return;
  const row = rows[0], payload = canonicalJson(expected);
  const actual = inspectLegacyUiBootstrapCompatibility(expected.root);
  if (rows.length !== 1 || row.workspace_id !== workspaceId || row.payload !== payload || row.payload_sha256 !== hash(payload)
    || !actual || canonicalJson(actual) !== payload
    || !Buffer.from(row.original_projects as Uint8Array).equals(pinnedBytes(expected.root, expected.files.find(file => file.path === ".pkm/state/projects.json")!)))
    fail("Compatibility receipt or original Project/Recipe state requires exact recovery.");
}
