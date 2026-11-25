import { randomUUID, createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, rmSync, rmdirSync, fsyncSync, statfsSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { sha256 } from "./file-write.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { renameNoReplaceSync } from "./rename-no-replace.js";
import { verifyLegacyRetrievalLearning } from "./legacy-retrieval-learning.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { workspaceStoragePaths } from "./workspace-storage-paths.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const admissionLimitsSchema = z.strictObject({
  maxTotalBytes: z.number().int().positive().safe().default(8 * 1024 ** 3),
  minFreeBytes: z.number().int().nonnegative().safe().default(64 * 1024 ** 2),
});
export const originalMcpRetrievalDirectory = ".pkm-next-retrieval-models";
function modelDirectory(root: string) {
  const paths = workspaceStoragePaths(root);
  if (paths.layout === "separated") return relative(root, paths.retrievalModels);
  return readOriginalMcpJournal(root) ? originalMcpRetrievalDirectory : "packages/retrieval-models";
}
export const legacyRetrievalPackageArchitectures = [
  "dense-document", "dense-section", "hierarchical-dense-section",
  "pca-dense-document", "pca-dense-section", "hierarchical-pca-dense-section",
  "hybrid-dense-lexical-document", "hybrid-pca-dense-lexical-document",
  "late-interaction-section", "compressed-late-interaction-section",
] as const;
const fileSchema = z.strictObject({ path: z.string(), size: z.number().int().nonnegative().safe(), sha256: hashSchema,
  directory: z.literal(true).optional() });
const receiptSchema = z.strictObject({ package_id: hashSchema, actor_id: z.string().min(1), workspace_id: z.string().min(1), authority_id: z.string().min(1),
  operation_id: z.string().uuid(), manifest_json: z.string(), inventory_json: z.string(), receipt_sha256: hashSchema });
const selectionSchema = z.strictObject({ sequence: z.number().int().positive(), package_id: hashSchema.nullable(),
  actor_id: z.string().min(1), workspace_id: z.string().min(1), authority_id: z.string().min(1), learning_enabled: z.union([z.literal(0), z.literal(1)]),
  user_feedback: z.union([z.literal(0), z.literal(1)]), previous_sha256: hashSchema.nullable(), receipt_sha256: hashSchema,
  frozen_release_id: hashSchema.nullable().optional() });
const frozenSchema = z.strictObject({ selection_sha256: hashSchema, release_id: hashSchema, package_id: hashSchema,
  workspace_id: z.string().min(1), actor_id: z.string().min(1), authority_id: z.string().min(1),
  envelope_json: z.string(), receipt_sha256: hashSchema });
const lifecycleSchema = z.strictObject({
  sequence: z.number().int().positive(), package_id: hashSchema, operation_id: z.string().uuid(),
  action: z.enum(["retire", "restore"]), workspace_id: z.string().min(1), actor_id: z.string().min(1),
  authority_id: z.string().min(1), previous_sha256: hashSchema.nullable(), receipt_sha256: hashSchema,
});
const lifecycleDdl = `CREATE TABLE legacy_retrieval_model_lifecycle (
 sequence INTEGER PRIMARY KEY,package_id TEXT NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,
 workspace_id TEXT NOT NULL,actor_id TEXT NOT NULL,authority_id TEXT NOT NULL,previous_sha256 TEXT,receipt_sha256 TEXT NOT NULL);`;
const candidateSchema = z.strictObject({
  operation_id: z.string().uuid(), package_id: hashSchema, workspace_id: z.string().min(1),
  actor_id: z.string().min(1), authority_id: z.string().min(1), inventory_json: z.string(), receipt_sha256: hashSchema,
});
const candidateDdl = `CREATE TABLE legacy_retrieval_model_candidates (
 operation_id TEXT PRIMARY KEY,package_id TEXT NOT NULL,workspace_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 authority_id TEXT NOT NULL,inventory_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL);`;
export const legacyRetrievalModelReconstructionSchema = z.strictObject({
  schema: z.literal("pkm.model-reconstruction/v1"), workspaceId: z.string().min(1),
  selectionSha256: hashSchema.nullable(),
  packages: z.array(z.strictObject({
    packageId: hashSchema, manifestSha256: hashSchema, inventorySha256: hashSchema,
    totalBytes: z.number().int().nonnegative().safe(),
  })).max(4096),
  sha256: hashSchema,
});
export type LegacyRetrievalModelReconstruction = z.infer<typeof legacyRetrievalModelReconstructionSchema>;
export type ModelReconstructionManifest = LegacyRetrievalModelReconstruction;
export function parseModelReconstructionManifest(value: unknown): ModelReconstructionManifest {
  const parsed = legacyRetrievalModelReconstructionSchema.safeParse(value);
  if (!parsed.success) throw new CoreError("RECOVERY_CONFLICT", "Invalid exact-content model reconstruction manifest.");
  const { sha256: pin, ...body } = parsed.data;
  if (pin !== sha256(JSON.stringify(body))
    || parsed.data.packages.some((item, index, packages) => index > 0 && packages[index - 1]!.packageId >= item.packageId))
    throw new CoreError("RECOVERY_CONFLICT", "Model reconstruction manifest digest or canonical package membership differs.");
  return parsed.data;
}
const frozenDdl = `CREATE TABLE legacy_retrieval_frozen_releases (
 selection_sha256 TEXT PRIMARY KEY,release_id TEXT NOT NULL,package_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,authority_id TEXT NOT NULL,envelope_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL);`;
const ddl = `CREATE TABLE legacy_retrieval_models (
 package_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,workspace_id TEXT NOT NULL,authority_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
 manifest_json TEXT NOT NULL,inventory_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL);
 CREATE TABLE legacy_retrieval_model_selections (
 sequence INTEGER PRIMARY KEY,package_id TEXT,actor_id TEXT NOT NULL,workspace_id TEXT NOT NULL,authority_id TEXT NOT NULL,
 learning_enabled INTEGER NOT NULL,user_feedback INTEGER NOT NULL,previous_sha256 TEXT,receipt_sha256 TEXT NOT NULL);`;
function immutable(database: DatabaseSync, table: string) {
  for (const suffix of ["UPDATE", "DELETE"]) database.exec(immutableDdl(table, suffix));
}
function immutableDdl(table: string, suffix: string) { return `CREATE TRIGGER ${table}_no_${suffix.toLowerCase()}
    BEFORE ${suffix} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable model admission'); END;`; }
export const legacyRetrievalModelAdmissionDdl = ddl
  + ["legacy_retrieval_models", "legacy_retrieval_model_selections"]
    .flatMap(table => ["UPDATE", "DELETE"].map(suffix => immutableDdl(table, suffix))).join("\n");
export const legacyRetrievalModelOptionalSchemaGroups: readonly { ddl: string; tables: readonly string[] }[] = [
  { ddl: legacyRetrievalModelAdmissionDdl, tables: ["legacy_retrieval_models", "legacy_retrieval_model_selections"] },
  ...([
    [candidateDdl, "legacy_retrieval_model_candidates"],
    [lifecycleDdl, "legacy_retrieval_model_lifecycle"],
    [frozenDdl, "legacy_retrieval_frozen_releases"],
  ] as const).map(([ddl, table]) => ({
    ddl: ddl + ["UPDATE", "DELETE"].map(suffix => immutableDdl(table, suffix)).join("\n"),
    tables: [table],
  })),
];
function schema(database: DatabaseSync) {
  const found = ["legacy_retrieval_models", "legacy_retrieval_model_selections"]
    .map(name => !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!found.some(Boolean)) return false;
  if (!found.every(Boolean)) throw new CoreError("INVALID_WORKSPACE", "Model admission schema is incomplete.");
  for (const [table, fields] of [["legacy_retrieval_models", receiptSchema.shape], ["legacy_retrieval_model_selections", selectionSchema.shape]] as const) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(Object.keys(fields))
      && !(table === "legacy_retrieval_model_selections" && JSON.stringify(columns) === JSON.stringify(Object.keys(fields).filter(key => key !== "frozen_release_id"))))
      throw new CoreError("INVALID_WORKSPACE", "Model admission columns changed.");
    for (const suffix of ["update", "delete"]) {
      const row = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`${table}_no_${suffix}`);
      if (!String(row?.sql).includes("RAISE(ABORT,'immutable model admission')"))
        throw new CoreError("INVALID_WORKSPACE", "Model admission immutability is missing.");
    }
  }
  return true;
}
function safePath(path: string) {
  return !!path && path.length <= 4096 && !/[\\:\0]/.test(path)
    && path.split("/").every(part => !!part && part !== "." && part !== ".." && part.length <= 255);
}
function inventory(root: string, maxTotalBytes = Number.MAX_SAFE_INTEGER) {
  let parent = resolve(root);
  while (true) {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new CoreError("INVALID_DOCUMENT", "Model admission parents must be regular directories.");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const pending = [root], files: z.infer<typeof fileSchema>[] = [];
  let totalBytes = 0n;
  while (pending.length) {
    const full = pending.pop()!, stat = lstatSync(full, { bigint: true });
    const path = relative(root, full).split("\\").join("/");
    if (path && !safePath(path) || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
      throw new CoreError("INVALID_DOCUMENT", "Model packages refuse unsafe paths, links and special files.");
    if (stat.isDirectory()) {
      if (path && path !== "model" && !path.startsWith("model/"))
        throw new CoreError("INVALID_DOCUMENT", "Model package contains an unknown directory.");
      if (path) files.push({ path, size: 0, sha256: sha256("directory"), directory: true });
      for (const name of readdirSync(full)) pending.push(join(full, name));
      continue;
    }
    if (path !== "manifest.json" && !path.startsWith("model/"))
      throw new CoreError("INVALID_DOCUMENT", "Model package contains an unknown artifact.");
    totalBytes += stat.size;
    if (totalBytes > BigInt(maxTotalBytes))
      throw new CoreError("LIMIT", `Local model package exceeds the ${maxTotalBytes}-byte admission budget.`);
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
      let size = 0;
      for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) !== 0;) {
        size += count;
        if (BigInt(size) > stat.size)
          throw new CoreError("CONFLICT", "Model package grew during hashing.");
        hash.update(buffer.subarray(0, count));
      }
      const after = fstatSync(fd, { bigint: true });
      if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => stat[key as keyof typeof stat] !== after[key as keyof typeof after]))
        throw new CoreError("CONFLICT", "Model package changed during hashing.");
      files.push({ path, size, sha256: hash.digest("hex") });
    } finally { closeSync(fd); }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function assertAdmissionSpace(destination: string, copyBytes: bigint, minFreeBytes: number) {
  let parent = destination;
  while (!existsSync(parent)) parent = dirname(parent);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory())
    throw new CoreError("INVALID_DOCUMENT", "Model admission destination must have regular nonlinked parents.");
  const disk = statfsSync(parent, { bigint: true });
  if (disk.bavail * disk.bsize < copyBytes + BigInt(minFreeBytes))
    throw new CoreError("LIMIT", `Insufficient disk space for ${copyBytes} model bytes plus ${minFreeBytes} bytes of free-space headroom.`);
}
function copyAdmittedFile(source: string, target: string, file: z.infer<typeof fileSchema>) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(input, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(file.size))
      throw new CoreError("CONFLICT", "Local model source changed before copying.");
    const output = openSync(target, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(65536), hash = createHash("sha256");
      let copied = 0;
      for (let count; (count = readSync(input, buffer, 0, Math.min(buffer.length, file.size - copied + 1), null)) !== 0;) {
        copied += count;
        if (copied > file.size) throw new CoreError("CONFLICT", "Local model source grew during copying.");
        hash.update(buffer.subarray(0, count));
        for (let written = 0; written < count;) written += writeSync(output, buffer, written, count - written);
      }
      const after = fstatSync(input, { bigint: true });
      if (copied !== file.size || hash.digest("hex") !== file.sha256
        || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]))
        throw new CoreError("CONFLICT", "Local model source changed during copying.");
      fsyncSync(output);
    } finally { closeSync(output); }
  } finally { closeSync(input); }
}
function receiptDigest(value: Record<string, unknown>) {
  const { receipt_sha256: _digest, ...body } = value;
  if (body.frozen_release_id == null) delete body.frozen_release_id;
  return sha256(JSON.stringify(body));
}
function modelState(database: DatabaseSync, root: string, recover?: () => void, allowPending = false,
  reconstruction?: LegacyRetrievalModelReconstruction) {
  const directory = modelDirectory(root);
  const identity = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id;
  verifyLegacyRetrievalLearning(database, identity);
  const exists = schema(database);
  const rows = exists ? database.prepare("SELECT * FROM legacy_retrieval_models ORDER BY package_id").all().map(row => receiptSchema.parse(row)) : [];
  const selections = exists ? database.prepare("SELECT * FROM legacy_retrieval_model_selections ORDER BY sequence").all().map(row => selectionSchema.parse(row)) : [];
  const lifecycleExists = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_model_lifecycle'").get();
  const events = lifecycleExists ? database.prepare("SELECT * FROM legacy_retrieval_model_lifecycle ORDER BY sequence").all().map(row => lifecycleSchema.parse(row)) : [];
  const candidatesExist = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_model_candidates'").get();
  const candidates = candidatesExist ? database.prepare("SELECT * FROM legacy_retrieval_model_candidates ORDER BY operation_id").all().map(row => candidateSchema.parse(row)) : [];
  if (candidatesExist) {
    if (JSON.stringify(database.prepare("PRAGMA table_info(legacy_retrieval_model_candidates)").all().map(row => row.name))
      !== JSON.stringify(Object.keys(candidateSchema.shape))) throw new CoreError("INVALID_WORKSPACE", "Model candidate columns changed.");
    for (const suffix of ["update", "delete"]) {
      const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`legacy_retrieval_model_candidates_no_${suffix}`);
      if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable model admission')"))
        throw new CoreError("INVALID_WORKSPACE", "Model candidate immutability is missing.");
    }
    for (const row of candidates)
      if (row.workspace_id !== identity || row.receipt_sha256 !== receiptDigest(row))
        throw new CoreError("INVALID_WORKSPACE", "Model candidate receipt changed.");
  }
  if (lifecycleExists) {
    if (JSON.stringify(database.prepare("PRAGMA table_info(legacy_retrieval_model_lifecycle)").all().map(row => row.name))
      !== JSON.stringify(Object.keys(lifecycleSchema.shape)))
      throw new CoreError("INVALID_WORKSPACE", "Model lifecycle columns changed.");
    for (const suffix of ["update", "delete"]) {
      const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`legacy_retrieval_model_lifecycle_no_${suffix}`);
      if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable model admission')"))
        throw new CoreError("INVALID_WORKSPACE", "Model lifecycle immutability is missing.");
    }
  }
  const states = new Map<string, z.infer<typeof lifecycleSchema>>();
  let eventPrevious: string | null = null;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.previous_sha256 !== eventPrevious || event.workspace_id !== identity
      || event.receipt_sha256 !== receiptDigest(event) || !rows.some(row => row.package_id === event.package_id))
      throw new CoreError("INVALID_WORKSPACE", "Model lifecycle receipt chain changed.");
    states.set(event.package_id, event); eventPrevious = event.receipt_sha256;
  }
  const stageOperation = (row: { package_id: string; operation_id: string }) => {
    const state = states.get(row.package_id);
    return state?.action === "restore" ? state.operation_id : row.operation_id;
  };
  if (selections.at(-1)?.package_id && states.get(selections.at(-1)!.package_id!)?.action === "retire")
    throw new CoreError("INVALID_WORKSPACE", "Active model cannot be retired.");
  if (reconstruction) {
    const parsed = parseModelReconstructionManifest(reconstruction);
    const { sha256: pin, ...body } = parsed;
    if (pin !== sha256(JSON.stringify(body)) || parsed.workspaceId !== identity
      || parsed.selectionSha256 !== (selections.at(-1)?.receipt_sha256 ?? null)
      || JSON.stringify(parsed.packages) !== JSON.stringify(rows
        .filter(row => states.get(row.package_id)?.action !== "retire").map(reconstructionPackage)))
      throw new CoreError("RECOVERY_CONFLICT", "Model reconstruction manifest differs from the exact durable admissions or selection.");
  }
  const frozen = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_frozen_releases'").get()
    ? database.prepare("SELECT * FROM legacy_retrieval_frozen_releases ORDER BY selection_sha256").all().map(row => frozenSchema.parse(row)) : [];
  if (frozen.length) {
    if (JSON.stringify(database.prepare("PRAGMA table_info(legacy_retrieval_frozen_releases)").all().map(row => row.name))
      !== JSON.stringify(Object.keys(frozenSchema.shape))) throw new CoreError("INVALID_WORKSPACE", "Frozen model admission columns differ.");
    for (const suffix of ["update", "delete"]) {
      const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`legacy_retrieval_frozen_releases_no_${suffix}`);
      if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable model admission')"))
        throw new CoreError("INVALID_WORKSPACE", "Frozen model admission immutability is missing.");
    }
    for (const row of frozen) {
      const selection = selections.find(selection => selection.receipt_sha256 === row.selection_sha256);
      if (receiptDigest(row) !== row.receipt_sha256 || row.workspace_id !== identity || !selection
        || selection.frozen_release_id !== row.release_id || selection.package_id !== row.package_id || selection.actor_id !== row.actor_id || selection.authority_id !== row.authority_id
        || JSON.parse(row.envelope_json).sha256 !== row.release_id)
        throw new CoreError("INVALID_WORKSPACE", "Frozen release model/selection authority receipt differs.");
    }
  }
  if (selections.some(selection => selection.frozen_release_id
    && !frozen.some(row => row.selection_sha256 === selection.receipt_sha256 && row.release_id === selection.frozen_release_id)))
    throw new CoreError("INVALID_WORKSPACE", "Frozen model selection has no immutable release admission.");
  const known = new Set(rows.map(row => row.package_id)), pending: string[] = [], emptyStages: string[] = [], abandonedStages: string[] = [];
  for (const row of rows) {
    if (receiptDigest(row) !== row.receipt_sha256 || row.workspace_id !== identity)
      throw new CoreError("INVALID_WORKSPACE", "Model admission receipt digest or workspace differs.");
    const expected = z.array(fileSchema).parse(JSON.parse(row.inventory_json));
    const manifest = JSON.parse(row.manifest_json);
    if (!legacyRetrievalPackageArchitectures.includes(manifest.architecture) || !expected.some(file => file.path === "manifest.json"))
      throw new CoreError("INVALID_WORKSPACE", "Model admission manifest changed.");
    if (JSON.stringify(expected.filter(file => !file.directory && file.path !== "manifest.json")
      .map(file => file.path.slice("model/".length)).sort()) !== JSON.stringify(Object.keys(manifest.files).sort()))
      throw new CoreError("INVALID_WORKSPACE", "Model admission includes an unlisted artifact.");
    const state = states.get(row.package_id);
    if (state?.action === "retire" || reconstruction) continue;
    const destination = join(root, directory, row.package_id), stage = join(root, directory, `.stage-${stageOperation(row)}`, row.package_id);
    if (!existsSync(destination)) {
      if (!existsSync(stage) || JSON.stringify(inventory(stage)) !== JSON.stringify(expected))
        throw new CoreError("RECOVERY_CONFLICT", "Admitted model publication is missing or incomplete.");
      if (!recover && !allowPending) throw new CoreError("RECOVERY_REQUIRED", "Committed model package requires native publication.");
      pending.push(stage);
    } else if (JSON.stringify(inventory(destination)) !== JSON.stringify(expected))
      throw new CoreError("RECOVERY_CONFLICT", "Admitted model package membership or bytes changed.");
    const source = existsSync(destination) ? destination : stage;
    if (readFileSync(join(source, "manifest.json"), "utf8") !== row.manifest_json)
      throw new CoreError("INVALID_WORKSPACE", "Model manifest receipt bytes differ.");
  }
  let previous: string | null = null;
  selections.forEach((row, index) => {
    if (row.workspace_id !== identity || row.sequence !== index + 1 || row.previous_sha256 !== previous || receiptDigest(row) !== row.receipt_sha256
      || row.package_id && !known.has(row.package_id))
      throw new CoreError("INVALID_WORKSPACE", "Model selection chain is invalid.");
    previous = row.receipt_sha256;
  });
  const area = join(root, directory);
  if (!reconstruction && existsSync(area)) {
    const stat = lstatSync(area);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Model package root must be a regular directory.");
    const stages = new Set(rows.map(row => `.stage-${stageOperation(row)}`));
    for (const name of readdirSync(area)) {
      if (known.has(name)) {
        const child = lstatSync(join(area, name));
        if (!child.isDirectory() || child.isSymbolicLink())
          throw new CoreError("INVALID_DOCUMENT", "Model package must be a regular directory.");
        continue;
      }
      const child = lstatSync(join(area, name));
      if (!child.isDirectory() || child.isSymbolicLink())
        throw new CoreError("INVALID_DOCUMENT", "Model staging directory must be a regular directory.");
      if (!stages.has(name) && candidates.some(row => `.stage-${row.operation_id}` === name)) {
        if (!recover && !allowPending) throw new CoreError("RECOVERY_REQUIRED", "Interrupted uncommitted model candidate requires cleanup.");
        abandonedStages.push(join(area, name)); continue;
      }
      if (stages.has(name) && readdirSync(join(area, name)).length === 0) {
        if (!recover && !allowPending) throw new CoreError("RECOVERY_REQUIRED", "Native model stage cleanup requires recovery.");
        emptyStages.push(join(area, name)); continue;
      }
      if (!stages.has(name) || !pending.some(path => dirname(path) === join(area, name)))
        throw new CoreError("INVALID_DOCUMENT", "Unreceipted native model artifact.");
      if (JSON.stringify(readdirSync(join(area, name))) !== JSON.stringify([rows.find(row => `.stage-${stageOperation(row)}` === name)!.package_id]))
        throw new CoreError("INVALID_DOCUMENT", "Unknown model staging artifact.");
    }
  }
  if (recover) for (const stage of pending) {
    recover(); renameNoReplaceSync(stage, join(area, basename(stage))); rmdirSync(dirname(stage));
    const fd = openSync(area, "r");
    try { if (process.platform !== "win32") fsyncSync(fd); } finally { closeSync(fd); }
    recover();
  }
  if (recover) for (const stage of emptyStages) { recover(); rmdirSync(stage); }
  if (recover) for (const stage of abandonedStages) { recover(); rmSync(stage, { recursive: true, force: true }); }
  const retired = rows.filter(row => states.get(row.package_id)?.action === "retire").map(row => row.package_id);
  if (recover) for (const packageId of retired) {
    recover();
    rmSync(join(area, packageId), { recursive: true, force: true });
  }
  const selected = selections.at(-1), active = selected?.package_id ? rows.find(row => row.package_id === selected.package_id)! : undefined;
  const release = frozen.find(row => row.selection_sha256 === selected?.receipt_sha256);
  return { pending: [...pending, ...emptyStages, ...abandonedStages], packages: rows, retired, lifecycle: events,
    pendingCleanup: retired.filter(packageId => existsSync(join(area, packageId))), selection: selected, active: active ? {
    packageId: active.package_id, root: join(root, directory, active.package_id), manifest: JSON.parse(active.manifest_json),
    revision: selected!.receipt_sha256, actorId: selected!.actor_id, learningEnabled: selected!.learning_enabled === 1,
    userFeedback: selected!.user_feedback === 1,
    ...(release ? { frozenRelease: { releaseId: release.release_id, envelopeJson: release.envelope_json } } : {}),
  } : undefined };
}
function reconstructionPackage(row: z.infer<typeof receiptSchema>) {
  const files = z.array(fileSchema).parse(JSON.parse(row.inventory_json));
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new CoreError("LIMIT", "Model reconstruction inventory exceeds a safe byte count.");
  return { packageId: row.package_id, manifestSha256: sha256(row.manifest_json),
    inventorySha256: sha256(row.inventory_json), totalBytes };
}

/** Hash-only transport metadata: never embeds local source paths, credentials or model configuration. */
export function captureLegacyRetrievalModelReconstruction(db: DatabaseSync, root: string): LegacyRetrievalModelReconstruction {
  const state = verifyLegacyRetrievalModels(db, root);
  const body = { schema: "pkm.model-reconstruction/v1" as const,
    workspaceId: JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id as string,
    selectionSha256: state.selection?.receipt_sha256 ?? null,
    packages: state.packages.filter(row => !state.retired.includes(row.package_id)).map(reconstructionPackage) };
  return legacyRetrievalModelReconstructionSchema.parse({ ...body, sha256: sha256(JSON.stringify(body)) });
}

/** Validates all durable model/learning/selection receipts without claiming binary availability. */
export function verifyLegacyRetrievalModelReconstruction(db: DatabaseSync, root: string, manifest: unknown) {
  return modelState(db, root, undefined, true, parseModelReconstructionManifest(manifest));
}

/** Restore-only composition: caller holds the private restore-stage authority, never a live-root bypass. */
export function reconstructLegacyRetrievalModels(db: DatabaseSync, root: string, manifest: unknown,
  sources: readonly { packageId: string; sourceRoot: string }[],
  options: { assertWorkspaceLease: () => void; limits?: z.input<typeof admissionLimitsSchema> }) {
  if (typeof options?.assertWorkspaceLease !== "function")
    throw new CoreError("ACCESS_DENIED", "Explicit model reconstruction stage authority is required.");
  options.assertWorkspaceLease();
  const state = verifyLegacyRetrievalModelReconstruction(db, root, manifest);
  const parsed = legacyRetrievalModelReconstructionSchema.parse(manifest);
  const limits = admissionLimitsSchema.parse(options.limits ?? {});
  const parsedSources = z.array(z.strictObject({ packageId: hashSchema, sourceRoot: z.string().min(1) })).max(4096).safeParse(sources);
  if (!parsedSources.success || parsedSources.data.length !== parsed.packages.length
    || new Set(parsedSources.data.map(source => source.packageId)).size !== parsedSources.data.length
    || parsedSources.data.some(source => !parsed.packages.some(pin => pin.packageId === source.packageId)))
    throw new CoreError("NOT_AVAILABLE", "Restore requires one explicit exact-hash local sourceRoot for every package in the model reconstruction manifest; no model download or selection clearing is permitted.");
  const totalBytes = parsed.packages.reduce((total, pin) => total + BigInt(pin.totalBytes), 0n);
  if (totalBytes > BigInt(limits.maxTotalBytes))
    throw new CoreError("LIMIT", "Model reconstruction exceeds the explicit total byte budget.");
  const directory = join(root, modelDirectory(root)), stages: string[] = [];
  assertAdmissionSpace(directory, totalBytes, limits.minFreeBytes);
  try {
    for (const pin of parsed.packages) {
      options.assertWorkspaceLease();
      const source = parsedSources.data.find(source => source.packageId === pin.packageId)!;
      if (typeof source.sourceRoot !== "string" || resolve(source.sourceRoot) !== source.sourceRoot
        || basename(source.sourceRoot) !== pin.packageId)
        throw new CoreError("INVALID_ARGUMENT", "Reconstruction sourceRoot must be the explicit absolute original package directory matching packageId.");
      const row = state.packages.find(row => row.package_id === pin.packageId)!;
      const expected = z.array(fileSchema).parse(JSON.parse(row.inventory_json));
      const before = inventory(source.sourceRoot, limits.maxTotalBytes);
      if (JSON.stringify(before) !== row.inventory_json
        || readFileSync(join(source.sourceRoot, "manifest.json"), "utf8") !== row.manifest_json)
        throw new CoreError("RECOVERY_CONFLICT", "Local model reconstruction source does not match the immutable admitted inventory and manifest hashes.");
      const destination = join(directory, pin.packageId);
      if (existsSync(destination)) {
        if (JSON.stringify(inventory(destination, limits.maxTotalBytes)) !== row.inventory_json)
          throw new CoreError("RECOVERY_CONFLICT", "Existing reconstructed model bytes differ from the immutable admission.");
        continue;
      }
      const event = state.lifecycle.filter(event => event.package_id === pin.packageId).at(-1);
      const stageParent = join(directory, `.stage-${event?.operation_id ?? row.operation_id}`);
      if (existsSync(stageParent))
        throw new CoreError("RECOVERY_CONFLICT", "An existing model reconstruction stage requires explicit restore-stage inspection before retry.");
      const stage = join(stageParent, pin.packageId);
      mkdirSync(stage, { recursive: true, mode: 0o700 }); stages.push(stageParent);
      for (const file of expected) {
        options.assertWorkspaceLease();
        const target = join(stage, file.path);
        if (file.directory) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        assertAdmissionSpace(dirname(target), BigInt(file.size), limits.minFreeBytes);
        copyAdmittedFile(join(source.sourceRoot, file.path), target, file);
      }
      if (JSON.stringify(inventory(stage, limits.maxTotalBytes)) !== row.inventory_json
        || JSON.stringify(inventory(source.sourceRoot, limits.maxTotalBytes)) !== row.inventory_json)
        throw new CoreError("RECOVERY_CONFLICT", "Local model reconstruction source or staged bytes changed during restore.");
      if (process.platform !== "win32") for (const path of [
        ...expected.filter(file => file.directory).reverse().map(file => join(stage, file.path)),
        stage, stageParent, directory, dirname(directory), root,
      ]) {
        const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    options.assertWorkspaceLease();
    recoverLegacyRetrievalModels(db, root, { assertWorkspaceLease: options.assertWorkspaceLease });
    return verifyLegacyRetrievalModels(db, root);
  } catch (error) {
    for (const stage of stages) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function recordLifecycle(database: DatabaseSync, current: ReturnType<typeof modelState>, workspaceId: string,
  actor: Actor, authorityId: string, operationId: string, activePackage: string | null, restored = false) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_model_lifecycle'").get()) {
    database.exec(lifecycleDdl); immutable(database, "legacy_retrieval_model_lifecycle");
  }
  let sequence = current.lifecycle.length, previous = current.lifecycle.at(-1)?.receipt_sha256 ?? null;
  const append = (packageId: string, action: "retire" | "restore") => {
    const event = { sequence: ++sequence, package_id: packageId, operation_id: operationId, action,
      workspace_id: workspaceId, actor_id: actor.id, authority_id: authorityId, previous_sha256: previous };
    previous = receiptDigest(event);
    database.prepare("INSERT INTO legacy_retrieval_model_lifecycle VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(event), previous);
  };
  if (restored && activePackage) append(activePackage, "restore");
  for (const row of current.packages)
    if (row.package_id !== activePackage && !current.retired.includes(row.package_id)) append(row.package_id, "retire");
}
export const verifyLegacyRetrievalModels = (db: DatabaseSync, root: string) => modelState(db, root);
export const inspectLegacyRetrievalModelRecovery = (db: DatabaseSync, root: string) => modelState(db, root, undefined, true);
export function recoverLegacyRetrievalModels(db: DatabaseSync, root: string, options: { assertWorkspaceLease: () => void }) {
  if (typeof options.assertWorkspaceLease !== "function") throw new CoreError("ACCESS_DENIED", "Native model recovery lease required.");
  return modelState(db, root, options.assertWorkspaceLease, true);
}
export async function admitLegacyRetrievalModel(storage: Storage, actor: Actor, request: {
  sourceRoot: string; packageId: string; authorityId: string; authorize: () => boolean;
  learningEnabled?: boolean; userFeedback?: boolean;
  frozenReleaseFile?: string;
  limits?: z.input<typeof admissionLimitsSchema>;
}) {
  if (!actor.canWrite || !request.authorityId || typeof request.authorize !== "function" || request.authorize() !== true)
    throw new CoreError("ACCESS_DENIED", "Explicit native local-model admission authority required.");
  const parsedLimits = admissionLimitsSchema.safeParse(request.limits === undefined ? {} : request.limits);
  if (!parsedLimits.success)
    throw new CoreError("INVALID_ARGUMENT", "Model admission limits require a positive safe maxTotalBytes and nonnegative safe minFreeBytes.");
  const limits = parsedLimits.data;
  const packageId = hashSchema.parse(request.packageId), source = resolve(request.sourceRoot);
  if (source !== request.sourceRoot || basename(source) !== packageId)
    throw new CoreError("INVALID_ARGUMENT", "Model source must be its explicit absolute original package directory.");
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const workspaceId = await storage.workspaceId();
    const db = storage.connectNative(), root = storage.workspaceRoot(), operationId = randomUUID();
    const directory = modelDirectory(root);
    let stage: string | undefined, committed = false;
    try {
      const current = verifyLegacyRetrievalModels(db, root);
      const before = inventory(source, limits.maxTotalBytes);
      const copyBytes = before.reduce((total, file) => total + BigInt(file.size), 0n);
      const existing = current.packages.find(row => row.package_id === packageId);
      const restoring = !!existing && current.retired.includes(packageId);
      if (!existing || restoring) assertAdmissionSpace(join(root, directory), copyBytes, limits.minFreeBytes);
      let frozen: { release_id: string } | undefined, envelopeJson: string | undefined;
      let frozenSnapshot: string | undefined;
      let frozenFilePin: string | undefined;
      const releasePin = () => {
        const stat = lstatSync(request.frozenReleaseFile!, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
          || realpathSync(request.frozenReleaseFile!) !== request.frozenReleaseFile)
          throw new CoreError("INVALID_DOCUMENT", "Frozen release must be a canonical regular single-link file.");
        return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
      };
      const snapshot = async () => {
        const { legacyRetrievalSources } = await import("./legacy-retrieval-index.js");
        const { legacyRetrievalSubscriptions } = await import("./legacy-retrieval-subscriptions.js");
        return legacyRetrievalSources(storage, db, await legacyRetrievalSubscriptions(root)).snapshot;
      };
      if (request.frozenReleaseFile) {
        if (resolve(request.frozenReleaseFile) !== request.frozenReleaseFile)
          throw new CoreError("INVALID_ARGUMENT", "Select an explicit absolute frozen-release file.");
        frozenFilePin = releasePin();
        envelopeJson = readFileSync(request.frozenReleaseFile, "utf8");
        const currentSnapshot = await snapshot();
        frozenSnapshot = JSON.stringify(currentSnapshot);
        frozen = z.strictObject({ release_id: hashSchema }).parse(await runLegacyMcpPython(
          fileURLToPath(new URL("../compat/legacy-retrieval-model.py", import.meta.url)), [],
          { root: source, packageId, envelopeJson, snapshot: currentSnapshot }));
      }
      const manifest = await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-retrieval-model.py", import.meta.url)), [],
        { root: source, packageId }) as Record<string, unknown>;
      if (JSON.stringify(before) !== JSON.stringify(inventory(source, limits.maxTotalBytes))) throw new CoreError("CONFLICT", "Local model source changed during validation.");
      if (!existing || restoring) {
        assertAdmissionSpace(join(root, directory), copyBytes, limits.minFreeBytes);
        db.exec("BEGIN IMMEDIATE");
        try {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_model_candidates'").get()) {
            db.exec(candidateDdl); immutable(db, "legacy_retrieval_model_candidates");
          }
          const candidate = { operation_id: operationId, package_id: packageId, workspace_id: workspaceId,
            actor_id: actor.id, authority_id: request.authorityId, inventory_json: JSON.stringify(before) };
          db.prepare("INSERT INTO legacy_retrieval_model_candidates VALUES(?,?,?,?,?,?,?)")
            .run(...Object.values(candidate), receiptDigest(candidate));
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        stage = join(root, directory, `.stage-${operationId}`, packageId);
        mkdirSync(stage, { recursive: true, mode: 0o700 });
        for (const file of before) {
          const target = join(stage, file.path);
          if (file.directory) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          assertAdmissionSpace(dirname(target), BigInt(file.size), limits.minFreeBytes);
          copyAdmittedFile(join(source, file.path), target, file);
        }
        if (JSON.stringify(before) !== JSON.stringify(inventory(source, limits.maxTotalBytes))
          || JSON.stringify(before) !== JSON.stringify(inventory(stage, limits.maxTotalBytes)))
          throw new CoreError("CONFLICT", "Local model source or staged bytes changed.");
        if (process.platform !== "win32") for (const path of [
          ...before.filter(file => file.directory).reverse().map(file => join(stage!, file.path)),
          stage, dirname(stage), dirname(dirname(stage)), join(root, dirname(directory)), root,
        ]) {
          const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
      if (request.authorize() !== true) throw new CoreError("ACCESS_DENIED", "Local model authority was revoked.");
      if (frozen && (releasePin() !== frozenFilePin || readFileSync(request.frozenReleaseFile!, "utf8") !== envelopeJson
        || JSON.stringify(await snapshot()) !== frozenSnapshot))
        throw new CoreError("CONFLICT", "Frozen release or native Skill corpus changed during admission.");
      if (JSON.stringify(before) !== JSON.stringify(inventory(source, limits.maxTotalBytes))
        || stage && JSON.stringify(before) !== JSON.stringify(inventory(stage, limits.maxTotalBytes)))
        throw new CoreError("CONFLICT", "Local model source or staged bytes changed before admission.");
      storage.assertWorkspaceLease();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!schema(db)) { db.exec(ddl); immutable(db, "legacy_retrieval_models"); immutable(db, "legacy_retrieval_model_selections"); }
        if (!existing) {
          const receipt = { package_id: packageId, actor_id: actor.id, workspace_id: workspaceId,
            authority_id: request.authorityId, operation_id: operationId,
            manifest_json: readFileSync(join(stage!, "manifest.json"), "utf8"), inventory_json: JSON.stringify(before) };
          if (JSON.stringify(JSON.parse(receipt.manifest_json)) !== JSON.stringify(manifest))
            throw new CoreError("CONFLICT", "Validated original model manifest changed.");
          db.prepare("INSERT INTO legacy_retrieval_models VALUES(?,?,?,?,?,?,?,?)")
            .run(...Object.values(receipt), receiptDigest(receipt));
        }
        if (existing && (existing.inventory_json !== JSON.stringify(before)
          || existing.manifest_json !== readFileSync(join(source, "manifest.json"), "utf8")))
          throw new CoreError("CONFLICT", "Readmitted package differs from its durable original admission.");
        const selection = { sequence: (current.selection?.sequence ?? 0) + 1, package_id: packageId, actor_id: actor.id, workspace_id: workspaceId,
          authority_id: request.authorityId, learning_enabled: request.learningEnabled ? 1 : 0,
          user_feedback: request.userFeedback ? 1 : 0, previous_sha256: current.selection?.receipt_sha256 ?? null,
          ...(frozen ? { frozen_release_id: frozen.release_id } : {}) };
        if (frozen && !db.prepare("PRAGMA table_info(legacy_retrieval_model_selections)").all().some(row => row.name === "frozen_release_id"))
          db.exec("ALTER TABLE legacy_retrieval_model_selections ADD COLUMN frozen_release_id TEXT");
        db.prepare(`INSERT INTO legacy_retrieval_model_selections
          (sequence,package_id,actor_id,workspace_id,authority_id,learning_enabled,user_feedback,previous_sha256${frozen ? ",frozen_release_id" : ""},receipt_sha256)
          VALUES(?,?,?,?,?,?,?,?,${frozen ? "?," : ""}?)`)
          .run(...Object.values(selection), receiptDigest(selection));
        if (frozen) {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_frozen_releases' AND type='table'").get()) {
            db.exec(frozenDdl); immutable(db, "legacy_retrieval_frozen_releases");
          }
          const release = { selection_sha256: receiptDigest(selection), release_id: frozen.release_id, package_id: packageId,
            workspace_id: workspaceId, actor_id: actor.id, authority_id: request.authorityId, envelope_json: envelopeJson! };
          db.prepare("INSERT INTO legacy_retrieval_frozen_releases VALUES(?,?,?,?,?,?,?,?)")
            .run(...Object.values(release), receiptDigest(release));
        }
        recordLifecycle(db, current, workspaceId, actor, request.authorityId, operationId, packageId, restoring);
        db.exec("COMMIT"); committed = true;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      recoverLegacyRetrievalModels(db, root, { assertWorkspaceLease: () => storage.assertWorkspaceLease() });
      return verifyLegacyRetrievalModels(db, root).active!;
    } catch (error) {
      if (!committed && (error as NodeJS.ErrnoException)?.code === "ENOSPC")
        throw new CoreError("LIMIT", "Insufficient disk space while staging the local model; no model admission was committed.");
      throw error;
    } finally {
      if (stage && !committed) rmSync(dirname(stage), { recursive: true, force: true });
      db.close();
    }
  });
}

export async function selectLegacyRetrievalModel(storage: Storage, actor: Actor, request: {
  packageId: string | null; authorityId: string; authorize: () => boolean; learningEnabled?: boolean; userFeedback?: boolean;
}) {
  if (!actor.canWrite || !request.authorityId || typeof request.authorize !== "function" || request.authorize() !== true)
    throw new CoreError("ACCESS_DENIED", "Explicit native local-model selection authority required.");
  if (request.packageId !== null) hashSchema.parse(request.packageId);
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const db = storage.connectNative();
    try {
      const current = verifyLegacyRetrievalModels(db, storage.workspaceRoot());
      if (!current.packages.length || request.packageId !== null && !current.packages.some(row => row.package_id === request.packageId))
        throw new CoreError("NOT_FOUND", "Model selection must reference an admitted native package.");
      if (request.packageId && current.retired.includes(request.packageId))
        throw new CoreError("NOT_AVAILABLE", "Retired model bytes require explicit verified source readmission; history is not a binary backup.");
      if (request.authorize() !== true) throw new CoreError("ACCESS_DENIED", "Local model selection authority was revoked.");
      const selection = { sequence: (current.selection?.sequence ?? 0) + 1, package_id: request.packageId, actor_id: actor.id,
        workspace_id: await storage.workspaceId(), authority_id: request.authorityId, learning_enabled: request.learningEnabled ? 1 : 0,
        user_feedback: request.userFeedback ? 1 : 0, previous_sha256: current.selection?.receipt_sha256 ?? null };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO legacy_retrieval_model_selections
          (sequence,package_id,actor_id,workspace_id,authority_id,learning_enabled,user_feedback,previous_sha256,receipt_sha256)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(...Object.values(selection), receiptDigest(selection));
        recordLifecycle(db, current, selection.workspace_id, actor, request.authorityId, randomUUID(), request.packageId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return recoverLegacyRetrievalModels(db, storage.workspaceRoot(), { assertWorkspaceLease: () => storage.assertWorkspaceLease() });
    } finally { db.close(); }
  });
}
