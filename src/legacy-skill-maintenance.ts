import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { atomicFileWrite, sha256 } from "./file-write.js";
import { legacyKnowledgeTree } from "./legacy-knowledge-snapshot.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";

export interface LegacySkillMaintenanceGenesis {
  files: readonly { path: string; size: number; sha256: string }[];
}
const feedbackPath = "_feedback/skill-usage.jsonl";
const proposalPattern = /^_proposals\/skills\/(\d{8}T\d{6}Z-[a-f0-9]{8})-([a-z0-9._-]+)\.md$/;
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const originalDate = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?$/).refine(value => {
  const date = new Date(value + "Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
});
const entrySchema = z.strictObject({
  id: uuid, created: originalDate,
  task_hash: digest, used_skills: z.array(z.string()), outcome: z.string(),
  observations: z.array(z.string()), evidence: z.array(z.string()),
});
const schemas = {
  skill_feedback: z.strictObject({ task: z.string(), used_skills: z.array(z.string()), outcome: z.string(),
    observations: z.array(z.string()).nullable().optional(), evidence: z.array(z.string()).nullable().optional(),
    interaction_id: z.string().default("") }),
  propose_skill_update: z.strictObject({ skill_id: z.string(), base_hash: z.string(), reason: z.string(),
    evidence: z.array(z.string()).nullable().optional(), proposed_content: z.string().default(""),
    confidence: z.number().default(0) }),
};
export const legacySkillMaintenanceRequest = z.strictObject({
  tool: z.enum(["skill_feedback", "propose_skill_update"]), arguments: z.record(z.string(), z.unknown()),
});

export function validateLegacySkillMaintenanceArtifact(path: string, raw: string): void {
  if (path === feedbackPath) {
    if (raw && !raw.endsWith("\n")) throw new CoreError("INVALID_DOCUMENT", "Skill feedback must contain complete original JSONL entries.");
    const ids = new Set<string>();
    for (const line of raw ? raw.slice(0, -1).split("\n") : []) {
      let value;
      try { value = entrySchema.parse(JSON.parse(line)); }
      catch { throw new CoreError("INVALID_DOCUMENT", "Original Skill feedback entry schema is invalid."); }
      if (ids.has(value.id)) throw new CoreError("INVALID_DOCUMENT", "Duplicate original Skill feedback identity.");
      ids.add(value.id);
    }
    return;
  }
  const match = proposalPattern.exec(path);
  if (!match) throw new CoreError("INVALID_DOCUMENT", "Unknown Skill maintenance artifact path.");
  const front = /^---\nproposal_id: ([^\n]+)\nskill_id: ([^\n]+)\nbase_hash: ([^\n]+)\ncurrent_hash: ([^\n]+)\nconflict: (true|false)\nconfidence: ([^\n]+)\ncreated: ([^\n]+)\n---\n\n# Skill Update Proposal\n\n## Reason\n\n[\s\S]*\n\n## Evidence\n\n[\s\S]*\n\n## Proposed Content\n\n[\s\S]*\n$/.exec(raw);
  try {
    if (!front || front[1] !== match[1] || !entrySchema.shape.created.safeParse(front[7]).success
      || typeof JSON.parse(front[2]!) !== "string" || typeof JSON.parse(front[3]!) !== "string"
      || !digest.safeParse(JSON.parse(front[4]!)).success || !Number.isFinite(Number(front[6]))
      || Number(front[6]) < 0 || Number(front[6]) > 1)
      throw new Error();
    const safe = JSON.parse(front[2]!).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "skill";
    if (match[2] !== safe) throw new Error();
  } catch { throw new CoreError("INVALID_DOCUMENT", "Original Skill proposal schema is invalid."); }
}

interface Receipt {
  sequence: number; operation_id: string; workspace_id: string; actor_id: string; tool: string;
  request_sha256: string; path: string; raw: string; previous_sha256: string | null;
  current_sha256: string; result_json: string;
}
const table = "legacy_skill_maintenance_receipts";
const ddl = `CREATE TABLE ${table} (
  sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, tool TEXT NOT NULL, request_sha256 TEXT NOT NULL, path TEXT NOT NULL,
  raw TEXT NOT NULL, previous_sha256 TEXT, current_sha256 TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable Skill maintenance receipt'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable Skill maintenance receipt'); END;
CREATE TABLE legacy_skill_maintenance_projections (operation_id TEXT PRIMARY KEY, current_sha256 TEXT NOT NULL);
CREATE TRIGGER legacy_skill_maintenance_projections_no_update BEFORE UPDATE ON legacy_skill_maintenance_projections BEGIN SELECT RAISE(ABORT,'immutable Skill maintenance projection'); END;
CREATE TRIGGER legacy_skill_maintenance_projections_no_delete BEFORE DELETE ON legacy_skill_maintenance_projections BEGIN SELECT RAISE(ABORT,'immutable Skill maintenance projection'); END;`;
function receipts(database: DatabaseSync): Receipt[] {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_skill_maintenance_projections'").get())
      throw new CoreError("INVALID_WORKSPACE", "Orphan Skill maintenance projection table.");
    return [];
  }
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (JSON.stringify(columns) !== JSON.stringify(["sequence", "operation_id", "workspace_id", "actor_id", "tool",
    "request_sha256", "path", "raw", "previous_sha256", "current_sha256", "result_json"]))
    throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt schema changed.");
  for (const suffix of ["update", "delete"]) {
    const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(`${table}_no_${suffix}`);
    if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable Skill maintenance receipt')"))
      throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt immutability is missing.");
  }
  if (JSON.stringify(database.prepare("PRAGMA table_info(legacy_skill_maintenance_projections)").all().map(row => row.name))
    !== JSON.stringify(["operation_id", "current_sha256"]))
    throw new CoreError("INVALID_WORKSPACE", "Skill maintenance projection schema changed.");
  for (const suffix of ["update", "delete"]) {
    const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(`legacy_skill_maintenance_projections_no_${suffix}`);
    if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable Skill maintenance projection')"))
      throw new CoreError("INVALID_WORKSPACE", "Skill maintenance projection immutability is missing.");
  }
  return database.prepare(`SELECT * FROM ${table} ORDER BY sequence`).all() as unknown as Receipt[];
}
function read(root: string, path: string): Buffer | undefined {
  const full = join(root, path);
  let parent = dirname(full);
  while (parent !== root) {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new CoreError("INVALID_DOCUMENT", "Skill maintenance paths refuse non-directory parents.");
    parent = dirname(parent);
  }
  const stat = lstatSync(full, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw new CoreError("INVALID_DOCUMENT", "Skill maintenance artifacts refuse links and special files.");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => stat[key as keyof typeof stat] !== after[key as keyof typeof after]))
      throw new CoreError("CONFLICT", "Skill maintenance artifact changed while reading.");
    return bytes;
  } finally { closeSync(fd); }
}
function inspect(database: DatabaseSync, root: string, genesis: LegacySkillMaintenanceGenesis = { files: [] },
  lease?: () => void, allowPending = false) {
  lease?.();
  const expected = new Map<string, string>(), histories = new Map<string, (string | null)[]>();
  const immutable = new Set<string>();
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  for (const file of genesis.files) {
    if (file.path !== feedbackPath && !proposalPattern.test(file.path))
      throw new CoreError("INVALID_WORKSPACE", "Invalid imported Skill maintenance genesis path.");
    if (expected.has(file.path) || !digest.safeParse(file.sha256).success || !Number.isSafeInteger(file.size) || file.size < 0)
      throw new CoreError("INVALID_WORKSPACE", "Invalid imported Skill maintenance genesis pin.");
    const bytes = read(root, file.path);
    if (!bytes || bytes.length < file.size || sha256(bytes.subarray(0, file.size)) !== file.sha256
      || file.path !== feedbackPath && bytes.length !== file.size)
      throw new CoreError("RECOVERY_CONFLICT", "Imported Skill maintenance genesis bytes changed.");
    const raw = decode(bytes.subarray(0, file.size));
    validateLegacySkillMaintenanceArtifact(file.path, raw);
    expected.set(file.path, raw); histories.set(file.path, [file.sha256]); immutable.add(file.path);
  }
  const rows = receipts(database), identity = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id;
  const acknowledgments = rows.length ? new Map(database.prepare("SELECT operation_id,current_sha256 FROM legacy_skill_maintenance_projections").all()
    .map(row => [String(row.operation_id), String(row.current_sha256)])) : new Map<string, string>();
  const unprojected: Receipt[] = [];
  const operationIds = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index + 1 || !uuid.safeParse(row.operation_id).success || operationIds.has(row.operation_id)
      || row.workspace_id !== identity || !row.actor_id || !digest.safeParse(row.request_sha256).success
      || !["skill_feedback", "propose_skill_update"].includes(row.tool)
      || row.tool === "skill_feedback" && row.path !== feedbackPath || row.tool === "propose_skill_update" && !proposalPattern.test(row.path))
      throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt chain is invalid.");
    operationIds.add(row.operation_id);
    const previous = expected.get(row.path);
    if ((previous === undefined ? null : sha256(previous)) !== row.previous_sha256
      || row.tool === "propose_skill_update" && previous !== undefined)
      throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt predecessor differs.");
    validateLegacySkillMaintenanceArtifact(row.path, row.raw);
    const raw = row.tool === "skill_feedback" ? (previous ?? "") + row.raw : row.raw;
    validateLegacySkillMaintenanceArtifact(row.path, raw);
    if (sha256(raw) !== row.current_sha256)
      throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt content digest differs.");
    const result = JSON.parse(row.result_json);
    if (result?.ok !== true) throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt result is invalid.");
    if (row.tool === "skill_feedback" ? result.feedback_id !== JSON.parse(row.raw).id
      : result.proposal_id !== proposalPattern.exec(row.path)?.[1] || result.proposal_path !== row.path)
      throw new CoreError("INVALID_WORKSPACE", "Skill maintenance receipt result identity differs.");
    expected.set(row.path, raw);
    const history = histories.get(row.path) ?? [null];
    history.push(row.current_sha256); histories.set(row.path, history);
    if (acknowledgments.has(row.operation_id)) {
      if (acknowledgments.get(row.operation_id) !== row.current_sha256 || unprojected.length)
        throw new CoreError("INVALID_WORKSPACE", "Skill maintenance projection acknowledgment chain differs.");
      histories.set(row.path, [row.current_sha256]);
    } else unprojected.push(row);
  }
  if ([...acknowledgments.keys()].some(id => !operationIds.has(id)))
    throw new CoreError("INVALID_WORKSPACE", "Orphan Skill maintenance projection acknowledgment.");
  if (unprojected.length && !lease && !allowPending)
    throw new CoreError("RECOVERY_REQUIRED", "Committed Skill maintenance receipt requires native projection acknowledgment.");
  const actual = new Set<string>(), temporaries: string[] = [];
  const nativeTemps = new Map(unprojected.map(row => [join(dirname(row.path), `.pkm-write-${row.operation_id}`), row.path]));
  for (const area of ["_feedback", "_proposals"]) {
    const pending = [join(root, area)];
    while (pending.length) {
      const full = pending.pop()!, stat = lstatSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      const path = relative(root, full).split("\\").join("/");
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
        throw new CoreError("INVALID_DOCUMENT", "Skill maintenance inventory refuses links and special files.");
      if (stat.isDirectory()) {
        if (![area, "_proposals/skills"].includes(path))
          throw new CoreError("INVALID_DOCUMENT", "Unknown Skill maintenance directory.");
        for (const name of readdirSync(full)) pending.push(join(full, name));
      } else {
        const target = nativeTemps.get(path);
        if (target) {
          const bytes = read(root, path)!, wanted = Buffer.from(expected.get(target)!);
          if (bytes.length > wanted.length || !bytes.equals(wanted.subarray(0, bytes.length)))
            throw new CoreError("RECOVERY_CONFLICT", "Skill maintenance temporary bytes differ from their committed receipt.");
          if (!lease && !allowPending) throw new CoreError("RECOVERY_REQUIRED", "Committed Skill maintenance temporary requires native recovery.");
          temporaries.push(path); continue;
        }
        if (!expected.has(path)) throw new CoreError("INVALID_DOCUMENT", "Unreceipted Skill maintenance artifact.");
        actual.add(path);
      }
    }
  }
  const pending: string[] = [];
  pending.push(...temporaries);
  const projections: { path: string; raw: string; current: string | null }[] = [];
  for (const [path, raw] of expected) {
    const bytes = read(root, path), current = bytes ? sha256(bytes) : null, wanted = sha256(raw);
    if (current === wanted) continue;
    if ((!lease && !allowPending) || immutable.has(path) && path !== feedbackPath || !histories.get(path)?.includes(current))
      throw new CoreError("RECOVERY_CONFLICT", "Skill maintenance artifact differs from its authenticated receipt.");
    pending.push(path);
    projections.push({ path, raw, current });
  }
  if (lease) {
    for (const path of temporaries) { lease(); unlinkSync(join(root, path)); }
    for (const { path, raw, current } of projections) {
      lease();
    const parent = dirname(join(root, path));
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    read(root, path);
    const last = rows.filter(row => row.path === path).at(-1)!;
    atomicFileWrite(join(root, path), raw, current, last.operation_id);
    lease();
      actual.add(path);
    }
    if (unprojected.length) {
      lease();
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of unprojected) database.prepare("INSERT INTO legacy_skill_maintenance_projections VALUES(?,?)").run(row.operation_id, row.current_sha256);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
  }
  return { files: [...expected].map(([path, raw]) => ({ path, size: Buffer.byteLength(raw), sha256: sha256(raw) })),
    receiptCount: rows.length, pending };
}
export function inspectLegacySkillMaintenanceRecovery(database: DatabaseSync, root: string,
  genesis?: LegacySkillMaintenanceGenesis) {
  return inspect(database, root, genesis, undefined, true);
}
export function verifyLegacySkillMaintenance(database: DatabaseSync, root: string,
  genesis?: LegacySkillMaintenanceGenesis) {
  return inspect(database, root, genesis);
}
export function recoverLegacySkillMaintenance(database: DatabaseSync, root: string,
  options: { genesis?: LegacySkillMaintenanceGenesis; assertWorkspaceLease: () => void }) {
  if (typeof options.assertWorkspaceLease !== "function") throw new CoreError("ACCESS_DENIED", "Native Skill maintenance recovery lease required.");
  return inspect(database, root, options.genesis, options.assertWorkspaceLease);
}

export async function legacySkillMaintenance(storage: Storage, actor: Actor,
  request: z.infer<typeof legacySkillMaintenanceRequest>, options: {
    operationId?: string; genesis?: LegacySkillMaintenanceGenesis; assertCurrent?: () => void;
  } = {}) {
  if (!actor.canWrite) throw new CoreError("ACCESS_DENIED", "The isolated MCP process is read-only.");
  options.assertCurrent?.();
  const args = schemas[request.tool].parse(request.arguments);
  const operationId = uuid.parse(options.operationId ?? randomUUID());
  const requestDigest = sha256(JSON.stringify({ tool: request.tool, arguments: args, actor: actor.id }));
  return storage.withWorkspaceExclusive(async () => {
    options.assertCurrent?.();
    storage.assertWorkspaceLease();
    const database = storage.connectNative(), root = storage.workspaceRoot();
    try {
      const workspaceId = await storage.workspaceId();
      recoverLegacySkillMaintenance(database, root, { genesis: options.genesis, assertWorkspaceLease: () => storage.assertWorkspaceLease() });
      let rows = receipts(database);
      const prior = rows.find(row => row.operation_id === operationId);
      const render = (text: string) => {
        const value = JSON.parse(text);
        if (value.proposal_path) {
          value.proposal_path = join(root, value.proposal_path);
          text = text.replace(/"proposal_path":\s*"(?:\\.|[^"])*"/, `"proposal_path": ${JSON.stringify(value.proposal_path)}`);
        }
        return { value, text };
      };
      if (prior) {
        if (prior.actor_id !== actor.id || prior.request_sha256 !== requestDigest)
          throw new CoreError("CONFLICT", "Skill maintenance replay arguments or actor changed.");
        return render(prior.result_json);
      }
      const files = legacyKnowledgeTree(root, "skills").concat(legacyKnowledgeTree(root, "subscriptions", "cache"));
      const projection = z.strictObject({ value: z.record(z.string(), z.unknown()), text: z.string(),
        artifacts: z.array(z.strictObject({ path: z.string(), raw: z.string(), append: z.boolean() })).max(1),
      }).parse(await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-knowledge-mcp.py", import.meta.url)), [],
        { tool: request.tool, arguments: args, files, recipes: [] }));
      options.assertCurrent?.();
      if (JSON.stringify(files) !== JSON.stringify(legacyKnowledgeTree(root, "skills").concat(legacyKnowledgeTree(root, "subscriptions", "cache"))))
        throw new CoreError("CONFLICT", "Skill source changed during advisory planning.");
      if (!projection.artifacts.length) return { text: projection.text, value: projection.value };
      const artifact = projection.artifacts[0]!;
      validateLegacySkillMaintenanceArtifact(artifact.path, artifact.raw);
      if ((request.tool === "skill_feedback") !== artifact.append
        || artifact.append && artifact.path !== feedbackPath || !artifact.append && !proposalPattern.test(artifact.path))
        throw new CoreError("INVALID_DOCUMENT", "Original Skill maintenance planner returned an invalid effect.");
      verifyLegacySkillMaintenance(database, root, options.genesis);
      const previous = read(root, artifact.path), previousSha = previous ? sha256(previous) : null;
      if (!artifact.append && previous) throw new CoreError("CONFLICT", "Skill proposal identity already exists.");
      const current = artifact.append ? Buffer.concat([previous ?? Buffer.alloc(0), Buffer.from(artifact.raw)]) : Buffer.from(artifact.raw);
      validateLegacySkillMaintenanceArtifact(artifact.path, new TextDecoder("utf-8", { fatal: true }).decode(current));
      const currentSha = sha256(current);
      const value = { ...projection.value };
      if (value.proposal_path) value.proposal_path = artifact.path;
      const resultText = value.proposal_path
        ? projection.text.replace(/"proposal_path":\s*"(?:\\.|[^"])*"/, `"proposal_path": ${JSON.stringify(artifact.path)}`)
        : projection.text;
      storage.assertWorkspaceLease();
      options.assertCurrent?.();
      database.exec("BEGIN IMMEDIATE");
      try {
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) database.exec(ddl);
        rows = receipts(database);
        database.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(rows.length + 1, operationId,
          workspaceId, actor.id, request.tool, requestDigest, artifact.path, artifact.raw,
          previousSha, currentSha, resultText);
        options.assertCurrent?.();
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      try {
        recoverLegacySkillMaintenance(database, root, { genesis: options.genesis, assertWorkspaceLease: () => storage.assertWorkspaceLease() });
      } catch (error) {
        throw new CoreError("RECOVERY_REQUIRED", `Skill maintenance receipt committed; artifact projection needs reconciliation: ${String(error)}`, "unknown");
      }
      return render(resultText);
    } finally { database.close(); }
  });
}
