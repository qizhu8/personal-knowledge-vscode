import { randomUUID, createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, rmSync, rmdirSync, fsyncSync } from "node:fs";
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

const directory = "packages/retrieval-models", hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
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
  for (const suffix of ["UPDATE", "DELETE"]) database.exec(`CREATE TRIGGER ${table}_no_${suffix.toLowerCase()}
    BEFORE ${suffix} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable model admission'); END;`);
}
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
function inventory(root: string) {
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
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
      let size = 0;
      for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) !== 0;) {
        hash.update(buffer.subarray(0, count)); size += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => stat[key as keyof typeof stat] !== after[key as keyof typeof after]))
        throw new CoreError("CONFLICT", "Model package changed during hashing.");
      files.push({ path, size, sha256: hash.digest("hex") });
    } finally { closeSync(fd); }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function receiptDigest(value: Record<string, unknown>) {
  const { receipt_sha256: _digest, ...body } = value;
  if (body.frozen_release_id == null) delete body.frozen_release_id;
  return sha256(JSON.stringify(body));
}
function modelState(database: DatabaseSync, root: string, recover?: () => void, allowPending = false) {
  const identity = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id;
  verifyLegacyRetrievalLearning(database, identity);
  const exists = schema(database);
  const rows = exists ? database.prepare("SELECT * FROM legacy_retrieval_models ORDER BY package_id").all().map(row => receiptSchema.parse(row)) : [];
  const selections = exists ? database.prepare("SELECT * FROM legacy_retrieval_model_selections ORDER BY sequence").all().map(row => selectionSchema.parse(row)) : [];
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
  const known = new Set(rows.map(row => row.package_id)), pending: string[] = [], emptyStages: string[] = [];
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
    const destination = join(root, directory, row.package_id), stage = join(root, directory, `.stage-${row.operation_id}`, row.package_id);
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
  if (existsSync(area)) {
    const stat = lstatSync(area);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Model package root must be a regular directory.");
    const stages = new Set(rows.map(row => `.stage-${row.operation_id}`));
    for (const name of readdirSync(area)) {
      if (known.has(name)) continue;
      const child = lstatSync(join(area, name));
      if (!child.isDirectory() || child.isSymbolicLink())
        throw new CoreError("INVALID_DOCUMENT", "Model staging directory must be a regular directory.");
      if (stages.has(name) && readdirSync(join(area, name)).length === 0) {
        if (!recover && !allowPending) throw new CoreError("RECOVERY_REQUIRED", "Native model stage cleanup requires recovery.");
        emptyStages.push(join(area, name)); continue;
      }
      if (!stages.has(name) || !pending.some(path => dirname(path) === join(area, name)))
        throw new CoreError("INVALID_DOCUMENT", "Unreceipted native model artifact.");
      if (JSON.stringify(readdirSync(join(area, name))) !== JSON.stringify([rows.find(row => `.stage-${row.operation_id}` === name)!.package_id]))
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
  const selected = selections.at(-1), active = selected?.package_id ? rows.find(row => row.package_id === selected.package_id)! : undefined;
  const release = frozen.find(row => row.selection_sha256 === selected?.receipt_sha256);
  return { pending: [...pending, ...emptyStages], packages: rows, selection: selected, active: active ? {
    packageId: active.package_id, root: join(root, directory, active.package_id), manifest: JSON.parse(active.manifest_json),
    revision: selected!.receipt_sha256, actorId: selected!.actor_id, learningEnabled: selected!.learning_enabled === 1,
    userFeedback: selected!.user_feedback === 1,
    ...(release ? { frozenRelease: { releaseId: release.release_id, envelopeJson: release.envelope_json } } : {}),
  } : undefined };
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
}) {
  if (!actor.canWrite || !request.authorityId || typeof request.authorize !== "function" || request.authorize() !== true)
    throw new CoreError("ACCESS_DENIED", "Explicit native local-model admission authority required.");
  const packageId = hashSchema.parse(request.packageId), source = resolve(request.sourceRoot);
  if (source !== request.sourceRoot || basename(source) !== packageId)
    throw new CoreError("INVALID_ARGUMENT", "Model source must be its explicit absolute original package directory.");
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const workspaceId = await storage.workspaceId();
    const db = storage.connectNative(), root = storage.workspaceRoot(), operationId = randomUUID();
    let stage: string | undefined, committed = false;
    try {
      const current = verifyLegacyRetrievalModels(db, root);
      const before = inventory(source);
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
      if (JSON.stringify(before) !== JSON.stringify(inventory(source))) throw new CoreError("CONFLICT", "Local model source changed during validation.");
      const existing = current.packages.find(row => row.package_id === packageId);
      if (!existing) {
        stage = join(root, directory, `.stage-${operationId}`, packageId);
        mkdirSync(stage, { recursive: true, mode: 0o700 });
        for (const file of before) {
          const target = join(stage, file.path);
          if (file.directory) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(join(source, file.path), target, constants.COPYFILE_EXCL);
          const fd = openSync(target, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        if (JSON.stringify(before) !== JSON.stringify(inventory(source)) || JSON.stringify(before) !== JSON.stringify(inventory(stage)))
          throw new CoreError("CONFLICT", "Local model source or staged bytes changed.");
        if (process.platform !== "win32") for (const path of [
          ...before.filter(file => file.directory).reverse().map(file => join(stage!, file.path)),
          stage, dirname(stage), dirname(dirname(stage)), join(root, "packages"), root,
        ]) {
          const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
      if (request.authorize() !== true) throw new CoreError("ACCESS_DENIED", "Local model authority was revoked.");
      if (frozen && (releasePin() !== frozenFilePin || readFileSync(request.frozenReleaseFile!, "utf8") !== envelopeJson
        || JSON.stringify(await snapshot()) !== frozenSnapshot))
        throw new CoreError("CONFLICT", "Frozen release or native Skill corpus changed during admission.");
      if (JSON.stringify(before) !== JSON.stringify(inventory(source))
        || stage && JSON.stringify(before) !== JSON.stringify(inventory(stage)))
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
        db.exec("COMMIT"); committed = true;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      recoverLegacyRetrievalModels(db, root, { assertWorkspaceLease: () => storage.assertWorkspaceLease() });
      return verifyLegacyRetrievalModels(db, root).active!;
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
      if (request.authorize() !== true) throw new CoreError("ACCESS_DENIED", "Local model selection authority was revoked.");
      const selection = { sequence: (current.selection?.sequence ?? 0) + 1, package_id: request.packageId, actor_id: actor.id,
        workspace_id: await storage.workspaceId(), authority_id: request.authorityId, learning_enabled: request.learningEnabled ? 1 : 0,
        user_feedback: request.userFeedback ? 1 : 0, previous_sha256: current.selection?.receipt_sha256 ?? null };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO legacy_retrieval_model_selections
          (sequence,package_id,actor_id,workspace_id,authority_id,learning_enabled,user_feedback,previous_sha256,receipt_sha256)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(...Object.values(selection), receiptDigest(selection));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return verifyLegacyRetrievalModels(db, storage.workspaceRoot());
    } finally { db.close(); }
  });
}
