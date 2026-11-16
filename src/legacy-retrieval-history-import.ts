import { createHash } from "node:crypto";
import { lstat, realpath, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { inspectLegacyCacheFile } from "./legacy-subscription-cache-import.js";
import { legacyLearningStateSchema, validateLegacyRetrievalLearningSnapshot, type LegacyLearningState } from "./legacy-retrieval-learning.js";
import { resourcePath } from "./document-path.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { upgradeLegacyRetrievalLearningSnapshot, type legacyRetrievalLearningUpgradeSchema } from "./legacy-retrieval-learning-upgrade.js";
import {
  legacyRetrievalHistorySourceSchema, legacyRetrievalHistoryPlanSchema,
  type LegacyRetrievalHistorySource, type LegacyRetrievalHistoryPlan,
} from "./domain/legacy-retrieval-history-import-contracts.js";
export {
  legacyRetrievalHistorySourceSchema, legacyRetrievalHistoryPlanSchema,
  type LegacyRetrievalHistorySource, type LegacyRetrievalHistoryPlan,
} from "./domain/legacy-retrieval-history-import-contracts.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const columns = {
  settings: ["key", "value"],
  models: ["context", "package", "corpus", "route", "slope", "bias", "threshold", "samples", "safe_streak",
    "weights", "revision", "model_labels", "user_labels", "prequential"],
  calls: ["id", "receipt", "context", "milliseconds", "returned", "candidates", "cut", "eligible", "recall",
    "label_digest", "success", "labels", "provenance", "version", "query_features", "brier", "log_loss", "query_key", "judged"],
  query_judgments: ["context", "query_key", "receipt", "call_id", "candidates", "query_features", "labels", "label_digest", "version"],
} as const;
const columnTypes = {
  settings: ["TEXT", "TEXT"],
  models: ["TEXT", "TEXT", "TEXT", "TEXT", "REAL", "REAL", "REAL", "INTEGER", "INTEGER",
    "TEXT", "INTEGER", "INTEGER", "INTEGER", "TEXT"],
  calls: ["INTEGER", "TEXT", "TEXT", "REAL", "INTEGER", "TEXT", "INTEGER", "INTEGER", "REAL",
    "TEXT", "INTEGER", "TEXT", "TEXT", "INTEGER", "TEXT", "REAL", "REAL", "TEXT", "TEXT"],
  query_judgments: ["TEXT", "TEXT", "TEXT", "INTEGER", "TEXT", "TEXT", "TEXT", "TEXT", "INTEGER"],
} as const;
const columnDefaults: Record<string, Record<string, string>> = {
  models: { weights: "'[]'", revision: "0", model_labels: "0", user_labels: "0", prequential: "'{}'" },
  calls: { version: "0", query_features: "'[]'" },
};
export interface LegacyRetrievalHistoryApprovalRequest {
  actorId: string; workspaceId: string; sourceSha256: string; historyPlanSha256: string;
  selectedPackageId: string | null; currentCorpusSha256: string;
}
export type LegacyRetrievalHistoryAuthorizer = (request: Readonly<LegacyRetrievalHistoryApprovalRequest>) =>
  Promise<{ actorId: string; decisionId: string }> | { actorId: string; decisionId: string };

async function pin(source: string) {
  if (!isAbsolute(source) || resolve(source) !== source || !source.endsWith(`${sep}retrieval-learning.sqlite3`)) {
    throw new CoreError("UNSAFE_PATH", "Select an absolute closed original retrieval-learning.sqlite3 snapshot.");
  }
  let path: string = sep;
  for (const component of source.slice(sep.length).split(sep)) {
    path = join(path, component);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (path === source ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      throw new CoreError("UNSAFE_PATH", "Original learner snapshot refuses linked or non-regular paths.");
    }
  }
  if (await realpath(source) !== source) throw new CoreError("UNSAFE_PATH", "Original learner snapshot must be canonical.");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(`${source}${suffix}`);
      throw new CoreError("UNQUIESCENT_SOURCE", "Original learner snapshot has SQLite sidecars; close and checkpoint its disposable copy.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const stat = await lstat(source, { bigint: true });
  const bytes = await inspectLegacyCacheFile(source);
  const after = await lstat(source, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key =>
    stat[key as keyof typeof stat] !== after[key as keyof typeof after])) {
    throw new CoreError("SOURCE_CHANGED", "Original learner snapshot changed while hashing.");
  }
  return { sourceDatabase: source, ...bytes, device: String(stat.dev), inode: String(stat.ino),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}

/** Source is immutable; predecessor normalization invokes original initialization only in memory. */
export async function inspectLegacyRetrievalHistory(source: string): Promise<{
  source: LegacyRetrievalHistorySource; state: LegacyLearningState;
}> {
  const before = await pin(source);
  const url = pathToFileURL(source);
  url.searchParams.set("mode", "ro"); url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url.href, { readOnly: true, enableForeignKeyConstraints: false });
  let state: LegacyLearningState;
  const profile: z.infer<typeof legacyRetrievalLearningUpgradeSchema>["columns"] = { settings: [], models: [], calls: [], query_judgments: [] };
  let raw: z.infer<typeof legacyRetrievalLearningUpgradeSchema>["tables"];
  try {
    if (db.prepare("PRAGMA integrity_check").all().some(row => Object.values(row)[0] !== "ok")) {
      throw new CoreError("INVALID_DOCUMENT", "Original learner snapshot failed SQLite integrity verification.");
    }
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const missingQueryTable = !objects.some(item => item.type === "table" && item.name === "query_judgments");
    if (missingQueryTable && (db.prepare("PRAGMA table_info(models)").all().length !== 9
      || db.prepare("PRAGMA table_info(calls)").all().length !== 11)) {
      throw new CoreError("UNKNOWN_STATE", "A missing original judgment table requires the exact original base learner schema.");
    }
    const expectedIndexes = new Set(["sqlite_autoindex_settings_1", "sqlite_autoindex_models_1",
      "sqlite_autoindex_calls_1", ...(missingQueryTable ? [] : ["sqlite_autoindex_query_judgments_1"])]);
    for (const item of objects) {
      if (item.type === "table" && (Object.hasOwn(columns, String(item.name)) || item.name === "sqlite_sequence")) continue;
      if (item.type === "index" && expectedIndexes.has(String(item.name)) && item.sql === null) continue;
      throw new CoreError("UNKNOWN_STATE", "Original learner snapshot contains unsupported tables, indexes, views or triggers.");
    }
    if (JSON.stringify(objects.filter(item => item.type === "index").map(item => item.name).sort())
      !== JSON.stringify([...expectedIndexes].sort())) throw new CoreError("UNKNOWN_STATE", "Original learner uniqueness indexes differ.");
    for (const [name, expected] of Object.entries(columns)) {
      if (name === "query_judgments" && missingQueryTable) continue;
      const info = db.prepare(`PRAGMA table_info(${name})`).all();
      const extended = db.prepare(`PRAGMA table_xinfo(${name})`).all();
      const primary = name === "settings" ? ["key"] : name === "models" ? ["context"]
        : name === "calls" ? ["id"] : ["context", "query_key"];
      const unique = name === "calls" ? ["receipt"] : primary;
      const uniqueInfo = db.prepare(`PRAGMA index_info(sqlite_autoindex_${name}_1)`).all();
      const minimum = name === "models" ? 9 : name === "calls" ? 11 : expected.length;
      if (info.length < minimum || info.length > expected.length
        || extended.length !== info.length
        || JSON.stringify(info.map(row => row.name)) !== JSON.stringify(expected.slice(0, info.length))
        || info.some((row, index) => {
          const defaultValue = columnDefaults[name]?.[String(row.name)] ?? null;
          const notNull = name === "query_judgments" || name === "settings" && row.name === "value" || defaultValue !== null;
          return row.type !== columnTypes[name as keyof typeof columnTypes][index]
            || Number(row.notnull) !== Number(notNull) || row.dflt_value !== defaultValue;
        })
        || JSON.stringify(uniqueInfo.map(row => row.name)) !== JSON.stringify(unique)
        || JSON.stringify(info.filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => row.name)) !== JSON.stringify(primary)) {
        throw new CoreError("UNKNOWN_STATE", "Original learner requires its exact base schema and ordered original column additions.");
      }
      profile[name as keyof typeof profile] = info.map(row => String(row.name));
    }
    const sequences = db.prepare("SELECT name,seq FROM sqlite_sequence").all();
    const lastId = Number(db.prepare("SELECT coalesce(max(id),0) last FROM calls").get()!.last);
    if (sequences.some(row => row.name !== "calls" || Number(row.seq) !== lastId)
      || lastId > 0 && sequences.length !== 1) {
      throw new CoreError("UNKNOWN_STATE", "Original learner sequence requires an explicit adapter before changing future call identities.");
    }
    raw = {
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all().map(Object.values),
      models: db.prepare("SELECT * FROM models ORDER BY context").all().map(Object.values),
      calls: db.prepare("SELECT * FROM calls ORDER BY id").all().map(Object.values),
      query_judgments: missingQueryTable ? [] : db.prepare("SELECT * FROM query_judgments ORDER BY context,query_key").all().map(Object.values),
    } as typeof raw;
    const settings = new Map(raw.settings.map(row => [row[0], row[1]]));
    if (settings.size !== raw.settings.length || !/^[a-f0-9]{64}$/.test(String(settings.get("salt")))
      || !["true", "false"].includes(String(settings.get("enabled")))
      || [...settings.keys()].some(key => !["salt", "enabled", "online_learning_opt_in_version", "learner_version"].includes(String(key)))
      || settings.has("online_learning_opt_in_version") && settings.get("online_learning_opt_in_version") !== "1"
      || settings.has("learner_version") && settings.get("learner_version") !== "2") {
      throw new CoreError("UNKNOWN_STATE", "Original learner settings require their exact supported versions and salt.");
    }
  } finally { db.close(); }
  const current = Object.entries(columns).every(([name, expected]) =>
    JSON.stringify(profile[name as keyof typeof profile]) === JSON.stringify(expected))
    && raw.settings.length === 4;
  state = current ? validateLegacyRetrievalLearningSnapshot(legacyLearningStateSchema.parse(raw))
    : await upgradeLegacyRetrievalLearningSnapshot({ columns: profile, tables: raw });
  const after = await pin(source);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new CoreError("SOURCE_CHANGED", "Original learner snapshot changed during immutable inspection.");
  const counts = { settings: state.settings.length, models: state.models.length,
    calls: state.calls.length, query_judgments: state.query_judgments.length };
  return { source: legacyRetrievalHistorySourceSchema.parse({ schema: "pkm.legacy-retrieval-history-source/v1",
    ...before, stateSha256: hash(JSON.stringify(state)), rawStateSha256: hash(JSON.stringify(raw)), schemaProfile: profile, counts }), state };
}

export async function planLegacyRetrievalHistory(stateRoot: string, actorId: string): Promise<LegacyRetrievalHistoryPlan> {
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || !actorId.trim()) throw new CoreError("UNSAFE_PATH", "Select an explicit original state snapshot and trusted actor.");
  const inspected = await inspectLegacyRetrievalHistory(join(stateRoot, "retrieval-learning.sqlite3"));
  const names = (await readdir(stateRoot)).sort();
  if (names.some(name => !["retrieval-learning.sqlite3", "solution-selection.json", "solutions", "serving-release.json"].includes(name))) {
    throw new CoreError("UNKNOWN_STATE", "Original retrieval state snapshot contains unsupported metrics, pending state or other files.");
  }
  const files: LegacyRetrievalHistoryPlan["files"] = [], directories: string[] = [];
  let selectedPackageId: string | null = null;
  if (names.includes("solution-selection.json")) {
    const path = join(stateRoot, "solution-selection.json"), pin = await inspectLegacyCacheFile(path);
    const bytes = await readFile(path);
    if (hash(bytes.toString("utf8")) !== pin.sha256 || bytes.length !== pin.size) throw new CoreError("SOURCE_CHANGED", "Original selection changed during inspection.");
    const value = z.strictObject({ schema: z.literal(1), package_id: z.string().regex(/^[a-f0-9]{64}$/).nullable() })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    selectedPackageId = value.package_id;
    files.push({ path: "solution-selection.json", ...pin });
  }
  const packageIds = new Set<string>();
  const folded = new Set<string>();
  async function walk(path: string) {
    if (!resourcePath.safeParse(path).success || folded.has(path.normalize("NFC").toLowerCase())) {
      throw new CoreError("UNSAFE_PATH", "Original model package paths must be portable and collision-free.");
    }
    folded.add(path.normalize("NFC").toLowerCase());
    const full = join(stateRoot, path), stat = await lstat(full);
    if (await realpath(full) !== full || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
      throw new CoreError("UNSAFE_PATH", "Original model package snapshot refuses links and special files.");
    }
    const parts = path.split("/");
    if (parts.length >= 2 && !/^[a-f0-9]{64}$/.test(parts[1]!)) throw new CoreError("UNKNOWN_STATE", "Unknown original model package identity.");
    if (parts.length === 2) packageIds.add(parts[1]!);
    if (stat.isDirectory()) {
      if (parts.length === 3 && parts[2] !== "model") throw new CoreError("UNKNOWN_STATE", "Unknown original model package directory.");
      directories.push(path);
      for (const name of (await readdir(full)).sort()) await walk(`${path}/${name}`);
    } else {
      if (parts.length < 3 || parts.length === 3 && parts[2] !== "manifest.json"
        || parts.length > 3 && parts[2] !== "model") throw new CoreError("UNKNOWN_STATE", "Unknown original model package file.");
      files.push({ path, ...await inspectLegacyCacheFile(full) });
    }
  }
  if (names.includes("solutions")) await walk("solutions");
  if (selectedPackageId && !packageIds.has(selectedPackageId)) throw new CoreError("INVALID_DOCUMENT", "Original selection refers to a missing model package.");
  for (const id of packageIds) if (!files.some(file => file.path === `solutions/${id}/manifest.json`)) {
    throw new CoreError("INVALID_DOCUMENT", "Original model package has no manifest.");
  }
  for (const packageId of packageIds) {
    await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-retrieval-model.py", import.meta.url)), [],
      { root: join(stateRoot, "solutions", packageId), packageId });
  }
  let frozenRelease: LegacyRetrievalHistoryPlan["frozenRelease"];
  if (names.includes("serving-release.json")) {
    if (!selectedPackageId) throw new CoreError("UNKNOWN_STATE", "A frozen release requires its exact explicitly selected original package.");
    const path = join(stateRoot, "serving-release.json"), pin = await inspectLegacyCacheFile(path);
    const bytes = await readFile(path);
    if (hash(bytes.toString("utf8")) !== pin.sha256 || bytes.length !== pin.size) {
      throw new CoreError("SOURCE_CHANGED", "Original frozen release changed during inspection.");
    }
    const envelopeJson = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const envelope = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
      release: z.object({ schema: z.literal("pkm.skill-serving/v1"), config: z.object({ model: z.string() }) }) })
      .parse(JSON.parse(envelopeJson));
    const originalModelPath = join(stateRoot, "solutions", selectedPackageId, "model");
    if (envelope.release.config.model !== originalModelPath) {
      throw new CoreError("UNKNOWN_STATE", "Frozen release model must match the exact selected original package; inactive or external releases require separate approval.");
    }
    const validated = z.strictObject({ release_id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(
      await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-retrieval-model.py", import.meta.url)), [],
        { root: join(stateRoot, "solutions", selectedPackageId), packageId: selectedPackageId, envelopeJson }));
    if (validated.release_id !== envelope.sha256) throw new CoreError("INVALID_DOCUMENT", "Original frozen release identity differs.");
    frozenRelease = { sha256: pin.sha256, releaseId: validated.release_id, packageId: selectedPackageId, originalModelPath };
    files.push({ path: "serving-release.json", ...pin });
  }
  for (const file of files) {
    const current = await inspectLegacyCacheFile(join(stateRoot, file.path));
    if (current.sha256 !== file.sha256 || current.size !== file.size) throw new CoreError("SOURCE_CHANGED", "Original model or selection changed during validation.");
  }
  if (JSON.stringify((await inspectLegacyRetrievalHistory(inspected.source.sourceDatabase)).source) !== JSON.stringify(inspected.source)) {
    throw new CoreError("SOURCE_CHANGED", "Original learner changed during model snapshot validation.");
  }
  const body = { schema: "pkm.legacy-retrieval-history-import/v1" as const, stateRoot, actorId,
    source: inspected.source, selectedPackageId, files, directories, ...(frozenRelease ? { frozenRelease } : {}) };
  return legacyRetrievalHistoryPlanSchema.parse({ ...body, planSha256: hash(JSON.stringify(body)) });
}
