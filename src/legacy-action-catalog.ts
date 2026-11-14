import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { decodeLegacyActionPackage } from "./legacy-action-package.js";
import {
  loadModuleSet, moduleSnapshotDefinitions, validateActionDefinition, type ActionModuleSnapshot,
} from "./domain/action-compiler-validation.js";

export const LEGACY_ACTION_RUNTIME_UNAVAILABLE =
  "Original Action execution, authorization and readiness are unavailable in this next-server projection. GPT validation is not represented or required here.";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/);
const version = z.number().int().safe().positive();
const snapshot = z.strictObject({
  kind: z.literal("moduleSet"), manifest: z.json(), files: z.record(z.string(), z.string()), enabled: z.literal(false),
});
const binding = z.strictObject({
  actorId: z.literal("mcp:external"), workspaceId: z.string().min(1), authorityId: z.string().min(1),
  workspaceRoot: z.string().min(1), workspaceRootPin: z.string().min(1),
  sourceRoot: z.string().min(1), sourcePath: z.string().min(1), packageSha256: digest,
});
const admission = z.strictObject({ binding, source: snapshot, package: z.string(), sourcePin: z.string(), sourceRootPin: z.string() });
const event = z.strictObject({
  actorId: z.literal("mcp:external"), workspaceId: z.string().min(1), admissionId: digest,
  action: z.enum(["import", "load", "remove"]), enabled: z.boolean().optional(), previousSha256: digest.nullable(),
});
const ddl = `
CREATE TABLE legacy_action_catalog_admissions(admission_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TABLE legacy_action_catalog_events(sequence INTEGER PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TRIGGER legacy_action_catalog_admissions_no_update BEFORE UPDATE ON legacy_action_catalog_admissions BEGIN SELECT RAISE(ABORT,'original Action package admission immutable'); END;
CREATE TRIGGER legacy_action_catalog_admissions_no_delete BEFORE DELETE ON legacy_action_catalog_admissions BEGIN SELECT RAISE(ABORT,'original Action package admission immutable'); END;
CREATE TRIGGER legacy_action_catalog_events_no_update BEFORE UPDATE ON legacy_action_catalog_events BEGIN SELECT RAISE(ABORT,'original Action catalog event immutable'); END;
CREATE TRIGGER legacy_action_catalog_events_no_delete BEFORE DELETE ON legacy_action_catalog_events BEGIN SELECT RAISE(ABORT,'original Action catalog event immutable'); END;`;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fail = (message: string, code = "ACCESS_DENIED"): never => { throw new CoreError(code, message); };
const pin = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const actorCheck = (actor: Actor, write = false) => {
  if (actor.id !== "mcp:external" || actor.boardWorker || write && !actor.canWrite)
    fail("Original Action packages require the fixed external actor and appropriate write permission.");
};
function canonical(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("An exact canonical Action package path is required.");
  let current = path;
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) fail("Action package paths cannot contain links.");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  if (realpathSync(path) !== path) fail("Action package path changed.");
  return path;
}
function readPackage(path: string) {
  canonical(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) fail("A bounded regular single-link Action package is required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (pin(fstatSync(fd)) !== pin(stat)) fail("Action package changed before reading.", "CONFLICT");
    const bytes = readFileSync(fd);
    if (pin(fstatSync(fd)) !== pin(stat) || pin(lstatSync(path)) !== pin(stat))
      fail("Action package changed while reading.", "CONFLICT");
    return { bytes, sourcePin: pin(stat) };
  } finally { closeSync(fd); }
}
const present = (db: DatabaseSync) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE name LIKE 'legacy_action_catalog_%' LIMIT 1").get());
function readCatalog(db: DatabaseSync, workspaceId: string) {
  const admissions = new Map<string, z.infer<typeof admission>>();
  const installed = new Map<string, string>(), enabled = new Map<string, number>();
  let previousSha256: string | null = null, sequence = 0;
  if (!present(db)) return { admissions, installed, enabled, previousSha256, sequence };
  const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    expected.exec(ddl);
    const schema = (database: DatabaseSync) => database.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'legacy_action_catalog_%' ORDER BY name").all();
    if (JSON.stringify(schema(db)) !== JSON.stringify(schema(expected))) fail("Original Action catalog schema changed.", "RECOVERY_CONFLICT");
  } finally { expected.close(); }
  for (const row of db.prepare("SELECT admission_id,payload,payload_sha256 FROM legacy_action_catalog_admissions").all()) {
    if (sha(String(row.payload)) !== row.payload_sha256 || row.admission_id !== row.payload_sha256)
      fail("Original Action package admission bytes changed.", "RECOVERY_CONFLICT");
    const checked = admission.parse(JSON.parse(String(row.payload)));
    const raw = Buffer.from(checked.package, "base64");
    if (checked.binding.workspaceId !== workspaceId || raw.toString("base64") !== checked.package
      || sha(raw) !== checked.binding.packageSha256
      || JSON.stringify(snapshot.parse(decodeLegacyActionPackage(raw))) !== JSON.stringify(checked.source))
      fail("Original Action package admission binding changed.", "RECOVERY_CONFLICT");
    loadModuleSet(checked.source);
    admissions.set(String(row.admission_id), checked);
  }
  for (const row of db.prepare("SELECT sequence,payload,payload_sha256 FROM legacy_action_catalog_events ORDER BY sequence").all()) {
    if (Number(row.sequence) !== ++sequence || sha(String(row.payload)) !== row.payload_sha256)
      fail("Original Action catalog history changed.", "RECOVERY_CONFLICT");
    const checked = event.parse(JSON.parse(String(row.payload))), source = admissions.get(checked.admissionId);
    if (!source || checked.workspaceId !== workspaceId || checked.previousSha256 !== previousSha256)
      fail("Original Action catalog history binding changed.", "RECOVERY_CONFLICT");
    const manifest = loadModuleSet(source!.source).projection;
    const id = String(manifest.module_set_id), revision = Number(manifest.version), key = `${id}/${revision}`;
    if (checked.action === "import") {
      if (installed.has(key) || checked.enabled !== undefined) fail("Invalid Action package import history.", "RECOVERY_CONFLICT");
      installed.set(key, checked.admissionId);
    } else {
      if (installed.get(key) !== checked.admissionId) fail("Original Action package history lost its source.", "RECOVERY_CONFLICT");
      if (checked.action === "load") {
        if (checked.enabled === undefined) fail("Original Action package selection lost its state.", "RECOVERY_CONFLICT");
        if (checked.enabled) enabled.set(id, revision);
        else if (enabled.get(id) === revision) enabled.delete(id);
      } else {
        if (enabled.get(id) === revision) enabled.delete(id);
        installed.delete(key);
      }
    }
    previousSha256 = String(row.payload_sha256);
  }
  return { admissions, installed, enabled, previousSha256, sequence };
}
type Catalog = ReturnType<typeof readCatalog>;
function selectedSources(catalog: Catalog): ActionModuleSnapshot[] {
  return [...catalog.installed].flatMap(([key, admissionId]) => {
    const source = catalog.admissions.get(admissionId)!.source, manifest = loadModuleSet(source).projection;
    return catalog.enabled.get(String(manifest.module_set_id)) === Number(manifest.version) && key.endsWith(`/${manifest.version}`)
      ? [{ ...source, enabled: true }] : [];
  });
}
function validateSelection(catalog: Catalog) {
  const definitions = moduleSnapshotDefinitions(selectedSources(catalog));
  for (const source of selectedSources(catalog)) for (const definition of loadModuleSet(source).definitions.values()) {
    const raw = JSON.parse(source.files[`definitions/${definition.action_id}.json`]!);
    if (!raw.dependencies || typeof raw.dependencies !== "object" || Array.isArray(raw.dependencies))
      fail("Packaged Actions require an explicit dependencies object before selection.", "INVALID_DOCUMENT");
    const authored = Object.fromEntries(Object.entries(definition)
      .filter(([key]) => !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
    const diagnostics = validateActionDefinition(authored, definitions);
    if (diagnostics.length) fail(diagnostics[0]!.message, "INVALID_ARGUMENT");
  }
}
export async function legacyActionCatalogSources(storage: Storage): Promise<ActionModuleSnapshot[]> {
  const workspaceId = await storage.workspaceId();
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const db = storage.connectNative();
    try { return readLegacyActionCatalogSources(db, workspaceId); }
    finally { db.close(); }
  });
}
export function readLegacyActionCatalogSources(db: DatabaseSync, workspaceId: string): ActionModuleSnapshot[] {
  const catalog = readCatalog(db, workspaceId);
  validateSelection(catalog);
  return selectedSources(catalog);
}

type ActionPackageBinding = z.infer<typeof binding>;
export async function admitLegacyActionPackage(storage: Storage, actor: Actor, request: {
  sourceRoot: string; sourcePath: string; expectedPackageSha256: string; authorityId: string;
  authorize(binding: Readonly<ActionPackageBinding>): boolean;
}) {
  actorCheck(actor, true);
  const nativeRoot = storage.workspaceRoot(), nativeStat = lstatSync(nativeRoot);
  const grant = binding.parse({ actorId: actor.id, workspaceId: await storage.workspaceId(),
    workspaceRoot: nativeRoot, workspaceRootPin: `${nativeStat.dev}:${nativeStat.ino}`,
    authorityId: request.authorityId, sourceRoot: request.sourceRoot, sourcePath: request.sourcePath,
    packageSha256: request.expectedPackageSha256 });
  if (request.authorize(Object.freeze(grant)) !== true) fail("Native host denied the exact Action package source.");
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const root = canonical(grant.sourceRoot);
    if (!lstatSync(root).isDirectory() || !grant.sourcePath.startsWith(root + sep)) fail("Action package is outside its approved source workspace.");
    const rootStat = lstatSync(root), sourceRootPin = `${rootStat.dev}:${rootStat.ino}`;
    const { bytes, sourcePin } = readPackage(grant.sourcePath);
    if (sha(bytes) !== grant.packageSha256) fail("Approved Action package digest changed.", "CONFLICT");
    const source = snapshot.parse(decodeLegacyActionPackage(bytes));
    loadModuleSet(source);
    const manifest = source.manifest as Record<string, unknown>;
    if (typeof manifest.name !== "string" || !manifest.provenance || typeof manifest.provenance !== "object")
      fail("Portable Action packages require explicit name and provenance metadata.", "INVALID_DOCUMENT");
    const reread = readPackage(grant.sourcePath);
    const finalRoot = lstatSync(canonical(grant.sourceRoot));
    if (reread.sourcePin !== sourcePin || !reread.bytes.equals(bytes) || `${finalRoot.dev}:${finalRoot.ino}` !== sourceRootPin)
      fail("Action package source changed during validation.", "CONFLICT");
    const payload = JSON.stringify({ binding: grant, source, package: bytes.toString("base64"), sourcePin, sourceRootPin });
    const id = sha(payload), db = storage.connectNative();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        readCatalog(db, grant.workspaceId);
        if (!present(db)) db.exec(ddl);
        storage.assertWorkspaceLease();
        db.prepare("INSERT OR IGNORE INTO legacy_action_catalog_admissions VALUES(?,?,?)").run(id, payload, id);
        db.exec("COMMIT");
        return { admissionId: id, packageSha256: grant.packageSha256 };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  });
}

export const legacyActionCatalogReadRequest = z.strictObject({
  tool: z.literal("action_module_sets"), arguments: z.strictObject({}),
});
export const legacyActionCatalogWriteRequest = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("action_module_set_import"), arguments: z.strictObject({ local_path: z.string().min(1) }) }),
  z.strictObject({ tool: z.literal("action_module_set_load"), arguments: z.strictObject({
    module_set_id: identity, version, enabled: z.boolean().default(true),
  }) }),
  z.strictObject({ tool: z.literal("action_module_set_remove"), arguments: z.strictObject({ module_set_id: identity, version }) }),
]);
export async function legacyActionCatalog(storage: Storage, actor: Actor,
  input: z.infer<typeof legacyActionCatalogReadRequest> | z.infer<typeof legacyActionCatalogWriteRequest>): Promise<unknown> {
  actorCheck(actor, input.tool !== "action_module_sets");
  const request = input.tool === "action_module_sets" ? legacyActionCatalogReadRequest.parse(input) : legacyActionCatalogWriteRequest.parse(input);
  const workspaceId = await storage.workspaceId();
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const db = storage.connectNative();
    try {
      if (request.tool !== "action_module_sets") db.exec("BEGIN IMMEDIATE");
      try {
        const catalog = readCatalog(db, workspaceId);
        validateSelection(catalog);
        if (request.tool === "action_module_sets") {
          return { ok: true, module_sets: [...catalog.installed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([, id]) => {
              const { projection } = loadModuleSet(catalog.admissions.get(id)!.source);
              return { ...projection, enabled: catalog.enabled.get(String(projection.module_set_id)) === Number(projection.version) };
            }) };
        }
        let admissionId: string | undefined, result: unknown, action: "import" | "load" | "remove", enabled: boolean | undefined;
        if (request.tool === "action_module_set_import") {
          const nativeRoot = storage.workspaceRoot(), nativeStat = lstatSync(nativeRoot);
          const found = [...catalog.admissions].filter(([, value]) => value.binding.sourcePath === request.arguments.local_path
            && value.binding.workspaceRoot === nativeRoot && value.binding.workspaceRootPin === `${nativeStat.dev}:${nativeStat.ino}`);
          if (found.length !== 1) fail("An exact previously host-admitted Action package source is required.");
          [admissionId] = found[0]!;
          const admitted = found[0]![1], root = lstatSync(canonical(admitted.binding.sourceRoot));
          if (`${root.dev}:${root.ino}` !== admitted.sourceRootPin) fail("Admitted Action package source workspace changed.", "CONFLICT");
          const current = readPackage(admitted.binding.sourcePath);
          if (current.sourcePin !== admitted.sourcePin || sha(current.bytes) !== admitted.binding.packageSha256)
            fail("Admitted Action package source changed.", "CONFLICT");
          const manifest = admitted.source.manifest as Record<string, unknown>, key = `${manifest.module_set_id}/${manifest.version}`;
          const previous = catalog.installed.get(key);
          if (previous) {
            if (loadModuleSet(catalog.admissions.get(previous)!.source).projection.package_hash !== manifest.package_hash)
              fail("Immutable ModuleSet version already exists with different content.", "CONFLICT");
            db.exec("COMMIT");
            return { ok: true, manifest: catalog.admissions.get(previous)!.source.manifest, enabled: false, already_installed: true };
          }
          action = "import";
          result = { ok: true, manifest, enabled: false, qualified: false, readiness: "deferred_until_load" };
        } else {
          const args = request.arguments, key = `${args.module_set_id}/${args.version}`;
          admissionId = catalog.installed.get(key);
          if (!admissionId) fail("Original Action ModuleSet is not installed.", "NOT_FOUND");
          const source = catalog.admissions.get(admissionId!)!.source;
          if (request.tool === "action_module_set_load") {
            action = "load"; enabled = request.arguments.enabled;
            const previous = catalog.enabled.get(args.module_set_id);
            if (enabled && previous !== undefined && previous !== args.version)
              fail("A different ModuleSet version is enabled. Agent updates cannot replace the approved provider; ask the operator to review the package change first.");
            if (enabled) catalog.enabled.set(args.module_set_id, args.version);
            else if (previous === args.version) catalog.enabled.delete(args.module_set_id);
            validateSelection(catalog);
            const manifest = source.manifest as { actions: string[] };
            result = { ok: true, module_set_id: args.module_set_id, version: args.version, enabled,
              readiness: enabled ? Object.fromEntries(manifest.actions.map(id => [id, {
                state: "blocked", reason: LEGACY_ACTION_RUNTIME_UNAVAILABLE,
              }])) : {} };
          } else {
            action = "remove";
            if (catalog.enabled.get(args.module_set_id) === args.version) catalog.enabled.delete(args.module_set_id);
            catalog.installed.delete(key);
            validateSelection(catalog);
            result = { ok: true, module_set_id: args.module_set_id, version: args.version, removed: true, runs_deleted: false };
          }
        }
        const payload = JSON.stringify({ actorId: actor.id, workspaceId, admissionId, action,
          ...(enabled !== undefined ? { enabled } : {}), previousSha256: catalog.previousSha256 });
        storage.assertWorkspaceLease();
        db.prepare("INSERT INTO legacy_action_catalog_events VALUES(?,?,?)").run(catalog.sequence + 1, payload, sha(payload));
        db.exec("COMMIT");
        return result;
      } catch (error) { if (request.tool !== "action_module_sets") db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  });
}
