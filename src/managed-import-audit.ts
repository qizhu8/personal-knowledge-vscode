import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { legacyImportPlanSchema, type LegacyImportPlan } from "./domain/legacy-import.js";
import { scanMarkdown } from "./markdown.js";
import { verifyImportedProjectEnvelope, type LegacyProjectEnvelopePlan } from "./legacy-project-envelope.js";
import { DatabaseSync } from "node:sqlite";
import { readLegacyMemoryImportReceipt } from "./memory-import.js";
import { openMemoryContinuitySnapshot, readMemoryScopeContinuity } from "./memory-scope-continuity.js";

type Entry = { kind: "file" | "directory"; identity: string; mode: number; size?: number; sha256?: string; mtimeNs: string };
type Inventory = { rootPin: string; entries: Map<string, Entry> };

async function inventory(root: string): Promise<Inventory> {
  if (resolve(root) !== root || await realpath(root) !== root) throw new Error("Imported audit root is not canonical.");
  const rootBefore = await lstat(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw new Error("Imported audit root is invalid.");
  const entries = new Map<string, Entry>();
  let total = 0;
  async function walk(directory: string, prefix: string, depth: number) {
    if (depth > 64) throw new Error("Imported audit exceeds depth limit.");
    for (const name of (await readdir(directory)).sort()) {
      if (entries.size >= 20000) throw new Error("Imported audit exceeds entry limit.");
      const path = prefix ? `${prefix}/${name}` : name, full = join(directory, name);
      const before = await lstat(full, { bigint: true });
      if (before.isSymbolicLink()) throw new Error(`Imported audit refuses link: ${path}`);
      const mode = Number(before.mode & 0o777n);
      const identity = `${before.dev}:${before.ino}:${before.ctimeNs}`;
      if (before.isDirectory()) {
        entries.set(path, { kind: "directory", identity, mode, mtimeNs: before.mtimeNs.toString() });
        await walk(full, path, depth + 1);
        const after = await lstat(full, { bigint: true });
        if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
          throw new Error(`Imported directory changed during audit: ${path}`);
      } else {
        if (!before.isFile() || before.nlink !== 1n || before.size > 268435456n || total + Number(before.size) > 1073741824)
          throw new Error(`Imported audit refuses special or oversized entry: ${path}`);
        const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await file.stat({ bigint: true });
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
            throw new Error(`Imported file changed during audit: ${path}`);
          const digest = createHash("sha256"), buffer = Buffer.alloc(65536);
          let size = 0;
          for (;;) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > Number(before.size)) throw new Error(`Imported file grew during audit: ${path}`);
            digest.update(buffer.subarray(0, bytesRead));
          }
          const after = await file.stat({ bigint: true }), current = await lstat(full, { bigint: true });
          if (BigInt(size) !== before.size || after.dev !== before.dev || after.ino !== before.ino
            || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
            || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
            || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs)
            throw new Error(`Imported file changed during audit: ${path}`);
          total += size;
          entries.set(path, { kind: "file", identity, mode, size, sha256: digest.digest("hex"), mtimeNs: before.mtimeNs.toString() });
        } finally { await file.close(); }
      }
    }
  }
  await walk(root, "", 0);
  const rootAfter = await lstat(root, { bigint: true });
  if (rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino
    || rootBefore.mtimeNs !== rootAfter.mtimeNs || rootBefore.ctimeNs !== rootAfter.ctimeNs)
    throw new Error("Imported audit root changed during inspection.");
  return { rootPin: `${rootBefore.dev}:${rootBefore.ino}:${rootBefore.mode}:${rootBefore.mtimeNs}:${rootBefore.ctimeNs}`, entries };
}

function serialized(snapshot: Inventory) {
  return JSON.stringify({ rootPin: snapshot.rootPin, entries: [...snapshot.entries] });
}

export async function captureImportedExperiment(root: string) {
  const snapshot = await inventory(root);
  return {
    full: serialized(snapshot),
    live: JSON.stringify({
      rootPin: snapshot.rootPin.split(":").slice(0, 3).join(":"),
      entries: [...snapshot.entries].filter(([path]) => !/^core\.sqlite(?:-wal|-shm)?$/.test(path)).map(([path, entry]) =>
        [path, entry.kind === "directory"
          ? { kind: entry.kind, identity: entry.identity.split(":").slice(0, 2).join(":"), mode: entry.mode }
          : entry]),
    }),
  };
}

/** Scoped in-process byte comparison; not writer exclusion, authentication or protected-lineage proof. */
export async function auditImportedWorkspace(root: string, approvedPlan: LegacyImportPlan) {
  const plan = legacyImportPlanSchema.parse(approvedPlan);
  const envelope = plan.projectEnvelopePlan as LegacyProjectEnvelopePlan | undefined;
  const envelopeControl = ".pkm/state/project-store.json";
  if (!plan.ready || ["statePlan", "trashPlan", "recipeTrashPlan",
    "routerConfigPlan", "retrievalHistoryPlan"].some(key => (plan as Record<string, unknown>)[key] !== undefined)
    || envelope && (envelope.schema !== "pkm.legacy-project-envelope-plan/v1" || !Array.isArray(envelope.projectionFiles))
    || plan.entries.some(entry => !entry.destination && !(envelope && entry.source === envelopeControl && entry.kind === "asset")))
    throw new Error("Imported audit cannot verify transformed or authority-dependent state; read-only attach is blocked.");
  const initial = await inventory(root);
  const archive = initial.entries.get("legacy-code-archive");
  if (archive && (archive.kind !== "directory" || archive.mode !== 0o700))
    throw new Error("Imported inert code archive must remain a protected 0700 directory.");
  const mapped = new Set<string>();
  let memoryDocumentCount = 0;
  if (plan.memoryPlan) {
    if ((initial.entries.get("core.sqlite-wal")?.size ?? 0) !== 0 || initial.entries.has("core.sqlite-journal"))
      throw new Error("Imported Memory audit requires a closed checkpointed database.");
    const marker = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8"));
    const database = openMemoryContinuitySnapshot(root);
    try {
      const receipt = readLegacyMemoryImportReceipt(database, marker.id);
      const binding = readMemoryScopeContinuity(database, marker.id);
      if (!receipt || receipt.sourceDatabaseSha256 !== plan.memoryPlan.sourceSha256
        || receipt.engineIdentity !== plan.memoryPlan.engineIdentity || receipt.actorId !== plan.memoryPlan.actorId
        || JSON.stringify(receipt.scopes) !== JSON.stringify(plan.memoryPlan.scopes)
        || (["records", "revisions", "events", "operations"] as const).some(key =>
          receipt[key] !== plan.memoryPlan![key])
        || plan.memoryPlan.continuityScopeSha256 && (!binding || binding.schema !== "pkm.memory-scope-continuity/v2"
          || binding.importPlanSha256 !== plan.planSha256
          || binding.sourceScopeSha256 !== plan.memoryPlan.continuityScopeSha256)) {
        throw new Error("Imported Memory provenance differs from the exact host plan.");
      }
      for (const document of receipt.documents) {
        const path = document.path, observed = initial.entries.get(path);
        if (!observed || observed.sha256 !== document.sha256 || mapped.has(path))
          throw new Error("Imported Memory document differs from its native receipt.");
        mapped.add(path);
      }
      memoryDocumentCount = receipt.documents.length;
    } finally { database.close(); }
  }
  const mappedLibraryDirectories = new Set(plan.entries
    .filter(entry => entry.kind === "directory" && entry.destination
      && /^(prompts|scripts|legacy-code-archive)(\/|$)/.test(entry.destination))
    .map(entry => entry.destination!));
  if (plan.skillsHistoryArchive) {
    const historyRoot = initial.entries.get("legacy-code-archive/skills-history");
    if (!historyRoot || historyRoot.kind !== "directory" || historyRoot.mode !== 0o700)
      throw new Error("Imported Skills history archive must remain a protected 0700 directory.");
    mappedLibraryDirectories.add("legacy-code-archive/skills-history");
  }
  if ([...mappedLibraryDirectories].some(path => path.startsWith("legacy-code-archive/")))
    mappedLibraryDirectories.add("legacy-code-archive");
  for (const entry of plan.entries) {
    if (!entry.destination) continue; // Only the verified envelope control is admitted above.
    const path = entry.destination!, observed = initial.entries.get(path);
    if (!observed || observed.kind !== (entry.kind === "directory" ? "directory" : "file"))
      throw new Error(`Imported audit missing or wrong-kind path: ${path}`);
    if (entry.mode !== undefined && entry.mode !== observed.mode)
      throw new Error(`Imported audit mode mismatch: ${path}`);
    if (entry.kind !== "directory") {
      mapped.add(path);
      if (entry.sha256 !== observed.sha256 || entry.size !== observed.size
        || entry.mode !== undefined && entry.mode !== observed.mode
        || entry.mtimeNs !== undefined && entry.mtimeNs !== observed.mtimeNs)
        throw new Error(`Imported audit byte or metadata mismatch: ${path}`);
    }
  }
  if (envelope) {
    const marker = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8"));
    if ((initial.entries.get("core.sqlite-wal")?.size ?? 0) !== 0 || initial.entries.has("core.sqlite-journal"))
      throw new Error("Imported audit requires a closed checkpointed Project envelope database.");
    const database = new DatabaseSync(":memory:");
    try {
      // Immutable attachment avoids SQLite read-only WAL/SHM and metadata writes.
      database.prepare("ATTACH DATABASE ? AS imported").run(`${pathToFileURL(join(root, "core.sqlite")).href}?mode=ro&immutable=1`);
      verifyImportedProjectEnvelope(database, marker.id, envelope);
    }
    finally { database.close(); }
    for (const projected of envelope.projectionFiles) {
      const bytes = Buffer.from(projected.base64, "base64");
      if (projected.path === envelopeControl) {
        const control = plan.entries.filter(entry => !entry.destination && entry.source === envelopeControl);
        if (control.length !== 1 || control[0]!.sha256 !== projected.sha256 || control[0]!.size !== bytes.length)
          throw new Error("Imported audit Project control plan differs from its envelope.");
      } else {
        const observed = initial.entries.get(projected.path);
        if (!observed || observed.kind !== "file" || observed.sha256 !== projected.sha256 || observed.size !== bytes.length
          || !mapped.has(projected.path)) throw new Error(`Imported audit Project/Recipe projection mismatch: ${projected.path}`);
      }
    }
  }
  const generated = new Set([".pkm-next-workspace", "core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]);
  for (const [path, entry] of initial.entries) {
    if (entry.kind === "directory" && /^(prompts|scripts|legacy-code-archive)(\/|$)/.test(path)
      && !mappedLibraryDirectories.has(path))
      throw new Error(`Imported audit found an unplanned library directory: ${path}`);
    if (entry.kind === "file" && !mapped.has(path) && !generated.has(path))
      throw new Error(`Imported audit found an unplanned file: ${path}`);
  }
  const documents = scanMarkdown(root);
  for (const entry of plan.entries.filter(entry => entry.kind === "document")) {
    const document = documents.find(({ record }) => `${record.area}/${record.path}` === entry.destination);
    if (!document || document.record.id !== entry.documentId || document.record.sha256 !== entry.sha256)
      throw new Error(`Imported audit document identity mismatch: ${entry.destination}`);
  }
  if (documents.length !== plan.entries.filter(entry => entry.kind === "document").length + memoryDocumentCount)
    throw new Error("Imported audit document count differs from the plan.");
  const baseline = serialized(initial);
  let invalidated = false;
  async function assertUnchanged() {
    if (invalidated) throw new Error("Imported file audit previously failed; close and investigate, do not replay.");
    try {
      if (serialized(await inventory(root)) !== baseline)
        throw new Error("Imported workspace changed after its file audit; close and investigate, do not replay.");
    } catch (error) { invalidated = true; throw error; }
  }
  await assertUnchanged();
  return {
    summary: Object.freeze({ schema: "pkm.import-byte-audit/v1" as const, planSha256: plan.planSha256,
      documents: documents.length, files: mapped.size, scope: "mapped-files-and-document-identities" as const,
      ...(envelope ? { projectEnvelope: "original-bytes-control-projections-and-ordered-receipts" as const } : {}),
      externalWriters: "unknown" as const, cutoverAuthorized: false as const }),
    assertUnchanged,
  };
}
