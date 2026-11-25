import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";

const tables: Record<string, number> = { settings: 2, models: 14, calls: 19, query_judgments: 9 };
const scalar = z.union([z.string(), z.number().finite(), z.null()]);
export const legacyLearningStateSchema = z.strictObject({
  settings: z.array(z.array(scalar).length(2)), models: z.array(z.array(scalar).length(14)),
  calls: z.array(z.array(scalar).length(19)).max(512), query_judgments: z.array(z.array(scalar).length(9)),
});
export type LegacyLearningState = z.infer<typeof legacyLearningStateSchema>;
const ddl = `CREATE TABLE legacy_original_learning_heads (
 namespace TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TABLE legacy_original_learning_versions (
 namespace TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(namespace,revision));
 CREATE TABLE legacy_original_learning_receipts (
 retrieval_id TEXT PRIMARY KEY,namespace TEXT NOT NULL,actor_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
 package_id TEXT NOT NULL,selection_revision TEXT NOT NULL,corpus_revision TEXT NOT NULL,pins_digest TEXT NOT NULL,receipt_digest TEXT NOT NULL);
 CREATE TRIGGER legacy_original_learning_versions_no_update BEFORE UPDATE ON legacy_original_learning_versions BEGIN SELECT RAISE(ABORT,'immutable original learning'); END;
 CREATE TRIGGER legacy_original_learning_versions_no_delete BEFORE DELETE ON legacy_original_learning_versions BEGIN SELECT RAISE(ABORT,'immutable original learning'); END;
 CREATE TRIGGER legacy_original_learning_receipts_no_update BEFORE UPDATE ON legacy_original_learning_receipts BEGIN SELECT RAISE(ABORT,'immutable original learning'); END;
 CREATE TRIGGER legacy_original_learning_receipts_no_delete BEFORE DELETE ON legacy_original_learning_receipts BEGIN SELECT RAISE(ABORT,'immutable original learning'); END;`;
interface Head { namespace: string; revision: number; payload: string; digest: string }
const genesisSchema = z.strictObject({
  namespace: z.string().regex(/^[a-f0-9]{64}$/), workspace_id: z.string().min(1), actor_id: z.string().min(1),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/), approval_id: z.string().min(1),
  selected_package_id: z.string().regex(/^[a-f0-9]{64}$/).nullable(), corpus_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.string(), receipt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const genesisDdl = `CREATE TABLE legacy_original_learning_genesis (
 namespace TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,actor_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,
 approval_id TEXT NOT NULL,selected_package_id TEXT,corpus_sha256 TEXT NOT NULL,payload TEXT NOT NULL,receipt_sha256 TEXT NOT NULL);
 CREATE TRIGGER legacy_original_learning_genesis_no_update BEFORE UPDATE ON legacy_original_learning_genesis BEGIN SELECT RAISE(ABORT,'immutable original learning'); END;
 CREATE TRIGGER legacy_original_learning_genesis_no_delete BEFORE DELETE ON legacy_original_learning_genesis BEGIN SELECT RAISE(ABORT,'immutable original learning'); END;`;
export interface LegacyLearningAuthority {
  actorId: string; workspaceId: string; packageId: string; selectionRevision: string; corpusRevision: string; pinsDigest: string;
}
export const legacyRetrievalLearningOptionalSchemaGroups = [
  { ddl, tables: ["legacy_original_learning_heads", "legacy_original_learning_versions", "legacy_original_learning_receipts"] },
  { ddl: genesisDdl, tables: ["legacy_original_learning_genesis"] },
] as const;
const hash = (value: unknown) => sha256(JSON.stringify(value));
const namespace = (authority: Pick<LegacyLearningAuthority, "actorId" | "workspaceId">) => hash([authority.workspaceId, authority.actorId]);
function validate(state: unknown) {
  const parsed = legacyLearningStateSchema.parse(state);
  for (const [name, width] of Object.entries(tables))
    if (parsed[name as keyof typeof parsed].some(row => row.length !== width))
      throw new CoreError("INVALID_WORKSPACE", "Original learning fixed-table schema differs.");
  const settings = new Map(parsed.settings.map(row => [row[0], row[1]]));
  if (!/^[a-f0-9]{64}$/.test(String(settings.get("salt"))) || !["true", "false"].includes(String(settings.get("enabled"))))
    throw new CoreError("INVALID_WORKSPACE", "Original learning salt or configuration differs.");
  if (settings.size !== 4 || settings.size !== parsed.settings.length || settings.get("online_learning_opt_in_version") !== "1"
    || settings.get("learner_version") !== "2")
    throw new CoreError("INVALID_WORKSPACE", "Original learning settings keys or versions differ.");
  if (new Set(parsed.calls.map(row => row[1])).size !== parsed.calls.length
    || parsed.calls.some(row => !/^[a-f0-9]{48}$/.test(String(row[1]))))
    throw new CoreError("INVALID_WORKSPACE", "Original learning receipt identity differs.");
  return parsed;
}
export const validateLegacyRetrievalLearningSnapshot = validate;
function genesisRows(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_original_learning_genesis' AND type='table'").get()) return [];
  if (JSON.stringify(db.prepare("PRAGMA table_info(legacy_original_learning_genesis)").all().map(row => row.name))
    !== JSON.stringify(Object.keys(genesisSchema.shape)))
    throw new CoreError("INVALID_WORKSPACE", "Original learning genesis columns changed.");
  for (const suffix of ["update", "delete"]) {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`legacy_original_learning_genesis_no_${suffix}`);
    if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable original learning')"))
      throw new CoreError("INVALID_WORKSPACE", "Original learning genesis immutability is missing.");
  }
  return db.prepare("SELECT * FROM legacy_original_learning_genesis ORDER BY namespace").all().map(row => {
    const value = genesisSchema.parse(row), { receipt_sha256, ...body } = value;
    if (hash(body) !== receipt_sha256 || value.namespace !== namespace({ actorId: value.actor_id, workspaceId: value.workspace_id }))
      throw new CoreError("INVALID_WORKSPACE", "Original learning genesis authority digest differs.");
    validate(JSON.parse(value.payload));
    return value;
  });
}
function schema(db: DatabaseSync) {
  const definitions = {
    legacy_original_learning_heads: ["namespace", "revision", "payload", "digest"],
    legacy_original_learning_versions: ["namespace", "revision", "payload", "digest"],
    legacy_original_learning_receipts: ["retrieval_id", "namespace", "actor_id", "workspace_id", "package_id",
      "selection_revision", "corpus_revision", "pins_digest", "receipt_digest"],
  };
  const found = Object.keys(definitions).map(name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name));
  if (!found.some(Boolean)) return false;
  if (!found.every(Boolean)) throw new CoreError("INVALID_WORKSPACE", "Original learning schema is incomplete.");
  for (const [name, columns] of Object.entries(definitions))
    if (JSON.stringify(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name)) !== JSON.stringify(columns))
      throw new CoreError("INVALID_WORKSPACE", "Original learning table columns changed.");
  for (const table of ["legacy_original_learning_versions", "legacy_original_learning_receipts"]) for (const suffix of ["update", "delete"]) {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`${table}_no_${suffix}`);
    if (!String(trigger?.sql).includes("RAISE(ABORT,'immutable original learning')"))
      throw new CoreError("INVALID_WORKSPACE", "Original learning immutability is missing.");
  }
  return true;
}
export function verifyLegacyRetrievalLearning(db: DatabaseSync, workspaceId?: string) {
  const genesis = genesisRows(db);
  if (!schema(db)) {
    if (genesis.length) throw new CoreError("INVALID_WORKSPACE", "Original learning genesis has no native namespace.");
    return;
  }
  const heads = db.prepare("SELECT * FROM legacy_original_learning_heads ORDER BY namespace").all() as unknown as Head[];
  for (const row of genesis) {
    if (!heads.some(head => head.namespace === row.namespace) || workspaceId && row.workspace_id !== workspaceId
      || db.prepare("SELECT payload FROM legacy_original_learning_versions WHERE namespace=? AND revision=1").get(row.namespace)?.payload !== row.payload)
      throw new CoreError("INVALID_WORKSPACE", "Original learning genesis has no exact initial native version.");
    if (row.selected_package_id && (
      !db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_models' AND type='table'").get()
      || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_model_selections' AND type='table'").get()
      || !db.prepare("SELECT 1 FROM legacy_retrieval_models WHERE package_id=? AND workspace_id=? AND actor_id=? AND authority_id=?")
        .get(row.selected_package_id, row.workspace_id, row.actor_id, row.approval_id)
      || !db.prepare("SELECT 1 FROM legacy_retrieval_model_selections WHERE package_id=? AND workspace_id=? AND actor_id=? AND authority_id=?")
        .get(row.selected_package_id, row.workspace_id, row.actor_id, row.approval_id)))
      throw new CoreError("INVALID_WORKSPACE", "Original learning genesis selected model admission authority is missing.");
  }
  for (const head of heads) {
    if (!/^[a-f0-9]{64}$/.test(head.namespace) || !Number.isSafeInteger(head.revision) || head.revision < 1)
      throw new CoreError("INVALID_WORKSPACE", "Original learning namespace or revision differs.");
    const versions = db.prepare("SELECT * FROM legacy_original_learning_versions WHERE namespace=? ORDER BY revision")
      .all(head.namespace) as unknown as Head[];
    if (versions.length !== head.revision || versions.some((row, i) => row.revision !== i + 1
      || row.digest !== hash([row.namespace, row.revision, row.payload])))
      throw new CoreError("INVALID_WORKSPACE", "Original learning version chain differs.");
    if (JSON.stringify(versions.at(-1)) !== JSON.stringify(head))
      throw new CoreError("INVALID_WORKSPACE", "Original learning head differs from its immutable version.");
    const state = validate(JSON.parse(head.payload)), salt = state.settings.find(row => row[0] === "salt")![1];
    const initial = genesis.find(row => row.namespace === head.namespace);
    const historicalCalls = initial ? validate(JSON.parse(initial.payload)).calls : [];
    for (const version of versions)
      if (validate(JSON.parse(version.payload)).settings.find(row => row[0] === "salt")![1] !== salt)
        throw new CoreError("INVALID_WORKSPACE", "Original learning namespace salt changed.");
    for (const call of state.calls)
      if (!db.prepare("SELECT 1 FROM legacy_original_learning_receipts WHERE retrieval_id=? AND namespace=?").get(call[1]!, head.namespace)
        && !historicalCalls.some(original => original[0] === call[0] && original[1] === call[1] && original[2] === call[2]))
        throw new CoreError("INVALID_WORKSPACE", "Original learning call has no native actor/model envelope.");
  }
  if (db.prepare("SELECT 1 FROM legacy_original_learning_versions v LEFT JOIN legacy_original_learning_heads h USING(namespace) WHERE h.namespace IS NULL LIMIT 1").get())
    throw new CoreError("INVALID_WORKSPACE", "Orphan original learning version.");
  for (const row of db.prepare("SELECT * FROM legacy_original_learning_receipts").all()) {
    const { receipt_digest, ...body } = row;
    if (hash(body) !== receipt_digest || workspaceId && row.workspace_id !== workspaceId
      || row.namespace !== namespace({ actorId: String(row.actor_id), workspaceId: String(row.workspace_id) })
      || !heads.some(head => head.namespace === row.namespace))
      throw new CoreError("INVALID_WORKSPACE", "Original learning actor/source/model receipt envelope differs.");
    if (!/^[a-f0-9]{48}$/.test(String(row.retrieval_id))
      || ["package_id", "selection_revision", "corpus_revision", "pins_digest"].some(key => !/^[a-f0-9]{64}$/.test(String(row[key])))
      || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_model_selections' AND type='table'").get()
      || !db.prepare("SELECT 1 FROM legacy_retrieval_model_selections WHERE receipt_sha256=? AND package_id=? AND workspace_id=?")
        .get(row.selection_revision!, row.package_id!, row.workspace_id!))
      throw new CoreError("INVALID_WORKSPACE", "Original learning model-selection authority is missing.");
  }
}
export function persistLegacyRetrievalLearningGenesis(db: DatabaseSync, request: {
  workspaceId: string; actorId: string; sourceSha256: string; approvalId: string;
  selectedPackageId: string | null; currentCorpusSha256: string; tables: LegacyLearningState;
}) {
  if (!db.isTransaction) throw new CoreError("ACCESS_DENIED", "Historical learning genesis requires the authorized native import transaction.");
  const state = validate(request.tables), before = readLegacyRetrievalLearning(db, request);
  if (before.revision !== 0 || genesisRows(db).some(row => row.namespace === before.namespace))
    throw new CoreError("CONFLICT", "Original learner genesis cannot replace an existing native namespace.");
  const payload = JSON.stringify(state), key = before.namespace;
  const body = { namespace: key, workspace_id: request.workspaceId, actor_id: request.actorId,
    source_sha256: request.sourceSha256, approval_id: request.approvalId, selected_package_id: request.selectedPackageId,
    corpus_sha256: request.currentCorpusSha256, payload };
  const receipt = genesisSchema.parse({ ...body, receipt_sha256: hash(body) });
  if (!schema(db)) db.exec(ddl);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_original_learning_genesis' AND type='table'").get()) db.exec(genesisDdl);
  db.prepare("INSERT INTO legacy_original_learning_genesis VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(receipt));
  const digest = hash([key, 1, payload]);
  db.prepare("INSERT INTO legacy_original_learning_versions VALUES(?,?,?,?)").run(key, 1, payload, digest);
  db.prepare("INSERT INTO legacy_original_learning_heads VALUES(?,?,?,?)").run(key, 1, payload, digest);
  verifyLegacyRetrievalLearning(db, request.workspaceId);
  return { namespace: key, revision: 1, genesisSha256: receipt.receipt_sha256 };
}
export function readLegacyRetrievalLearning(db: DatabaseSync, authority: Pick<LegacyLearningAuthority, "actorId" | "workspaceId">) {
  verifyLegacyRetrievalLearning(db, authority.workspaceId);
  if (!schema(db)) return { namespace: namespace(authority), revision: 0, state: null };
  const head = db.prepare("SELECT * FROM legacy_original_learning_heads WHERE namespace=?").get(namespace(authority)) as unknown as Head | undefined;
  return { namespace: namespace(authority), revision: head?.revision ?? 0, state: head ? validate(JSON.parse(head.payload)) : null };
}
export function publishLegacyRetrievalLearning(db: DatabaseSync, authority: LegacyLearningAuthority,
  expectedRevision: number, state: LegacyLearningState, retrievalId?: string) {
  if (!db.isTransaction) throw new CoreError("INVALID_WORKSPACE", "Original learning publication requires the native source-fenced transaction.");
  const before = readLegacyRetrievalLearning(db, authority);
  if (before.revision !== expectedRevision) throw new CoreError("CONFLICT", "Original learner changed before publication.");
  const safe = validate(state);
  if (!schema(db)) db.exec(ddl);
  const key = namespace(authority), revision = expectedRevision + 1, payload = JSON.stringify(safe), digest = hash([key, revision, payload]);
  db.prepare("INSERT INTO legacy_original_learning_versions VALUES(?,?,?,?)").run(key, revision, payload, digest);
  db.prepare(`INSERT INTO legacy_original_learning_heads VALUES(?,?,?,?) ON CONFLICT(namespace)
    DO UPDATE SET revision=excluded.revision,payload=excluded.payload,digest=excluded.digest`).run(key, revision, payload, digest);
  if (retrievalId) {
    if (!/^[a-f0-9]{48}$/.test(retrievalId) || !safe.calls.some(row => row[1] === retrievalId))
      throw new CoreError("INVALID_WORKSPACE", "Original model result has no staged learner receipt.");
    const body = { retrieval_id: retrievalId, namespace: key, actor_id: authority.actorId, workspace_id: authority.workspaceId,
      package_id: authority.packageId, selection_revision: authority.selectionRevision, corpus_revision: authority.corpusRevision,
      pins_digest: authority.pinsDigest };
    db.prepare("INSERT INTO legacy_original_learning_receipts VALUES(?,?,?,?,?,?,?,?,?)")
      .run(...Object.values(body), hash(body));
  }
}
export function authorizeLegacyRetrievalFeedback(db: DatabaseSync, authority: LegacyLearningAuthority, retrievalId: string) {
  verifyLegacyRetrievalLearning(db, authority.workspaceId);
  if (!schema(db)) throw new CoreError("NOT_FOUND", "Unknown or expired retrieval_id; only the latest 512 model calls are retained");
  const row = db.prepare("SELECT * FROM legacy_original_learning_receipts WHERE retrieval_id=?").get(retrievalId);
  if (!row || row.actor_id !== authority.actorId || row.workspace_id !== authority.workspaceId)
    throw new CoreError("ACCESS_DENIED", "Retrieval feedback requires the original native actor-bound model receipt.");
  if (row.package_id !== authority.packageId || row.selection_revision !== authority.selectionRevision
    || row.corpus_revision !== authority.corpusRevision || row.pins_digest !== authority.pinsDigest)
    throw new CoreError("CONFLICT", "Retrieval feedback source corpus or admitted model selection changed.");
}
