import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { exactRunnableArtifactBuiltin, originalDefinitionValue } from "./domain/action-compiler-validation.js";
import type { Storage } from "./storage.js";
import { authorizeNestedArtifact, readNestedActionPlan } from "./action-program-nested-artifacts.js";
import { actionArtifactWasReleased } from "./action-artifact-gc-records.js";
import { assertOriginalMcpPrivacy, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalMcpNativeHostReceiptSchema, originalMcpNativeHostReceiptTable,
  verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const grantSchema = z.strictObject({
  workspaceId: z.string().min(1), workspaceRoot: z.string().min(1), workspaceRootPin: z.string().min(1),
  actorId: z.literal("mcp:external"), authorityId: z.string().min(1), kind: z.enum(["source", "destination"]),
  selectedRoot: z.string().min(1), selectedRootPin: z.string().min(1),
  path: z.string().min(1), expectedSha256: digest.nullable(), parentPin: z.string().min(1),
  filePin: z.string().nullable(),
});
type Grant = z.infer<typeof grantSchema>;
const borrowedArtifactSchema = z.strictObject({
  artifactId: z.string().regex(/^artifact_[a-f0-9]{32}$/), sourceGrant: digest, digest,
});
const managedArtifactBase = z.strictObject({
  artifactId: borrowedArtifactSchema.shape.artifactId, kind: z.literal("managed"),
  actorId: z.literal("mcp:external"), workspaceId: z.string().min(1), ownerRunId: z.string().min(1),
  rootRunId: z.string().min(1).optional(),
  executableDigest: digest, sourceArtifactId: borrowedArtifactSchema.shape.artifactId,
  digest, size: z.number().int().min(0).max(32 * 1024 * 1024),
});
export const nativeActionManagedArtifact = managedArtifactBase.extend({ storage: z.literal("native-blob/v1") });
const managedArtifactSchema = z.union([
  managedArtifactBase.extend({ bytes: z.string().max(44_739_244) }),
  nativeActionManagedArtifact,
]);
const artifactSchema = z.union([borrowedArtifactSchema, managedArtifactSchema]);
const intentSchema = z.strictObject({
  operationId: z.string().uuid(), workspaceId: z.string().min(1), actorId: z.literal("mcp:external"),
  artifactId: borrowedArtifactSchema.shape.artifactId, destinationGrant: digest, digest, size: z.number().int().nonnegative(),
  filePin: z.string().nullable(),
});
type Intent = z.infer<typeof intentSchema>;
const ddl = `
CREATE TABLE legacy_action_artifact_grants(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE legacy_action_artifacts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TABLE legacy_action_artifact_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TABLE legacy_action_artifact_receipts(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TRIGGER legacy_action_artifact_grants_no_update BEFORE UPDATE ON legacy_action_artifact_grants BEGIN SELECT RAISE(ABORT,'immutable Action artifact grant'); END;
CREATE TRIGGER legacy_action_artifact_grants_no_delete BEFORE DELETE ON legacy_action_artifact_grants BEGIN SELECT RAISE(ABORT,'immutable Action artifact grant'); END;
CREATE TRIGGER legacy_action_artifacts_no_update BEFORE UPDATE ON legacy_action_artifacts BEGIN SELECT RAISE(ABORT,'immutable Action artifact'); END;
CREATE TRIGGER legacy_action_artifacts_no_delete BEFORE DELETE ON legacy_action_artifacts BEGIN SELECT RAISE(ABORT,'immutable Action artifact'); END;
CREATE TRIGGER legacy_action_artifact_receipts_no_update BEFORE UPDATE ON legacy_action_artifact_receipts BEGIN SELECT RAISE(ABORT,'immutable Action artifact receipt'); END;
CREATE TRIGGER legacy_action_artifact_receipts_no_delete BEFORE DELETE ON legacy_action_artifact_receipts BEGIN SELECT RAISE(ABORT,'immutable Action artifact receipt'); END;`;
export const legacyActionArtifactDdl = ddl;
export const nativeActionManagedBlobDdl = `CREATE TABLE native_action_managed_blobs(artifact_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,bytes TEXT NOT NULL,digest TEXT NOT NULL,size INTEGER NOT NULL);
CREATE TRIGGER native_action_managed_blobs_no_update BEFORE UPDATE ON native_action_managed_blobs BEGIN SELECT RAISE(ABORT,'immutable native Action payload'); END;
CREATE TRIGGER native_action_managed_blobs_release_only BEFORE DELETE ON native_action_managed_blobs WHEN NOT EXISTS (
SELECT 1 FROM action_runtime_receipts r,json_each(r.result,'$.releasedArtifacts') a
WHERE json_extract(r.result,'$.schema')='pkm.native-action-gc/v1' AND r.actor_id=OLD.actor_id
AND json_extract(a.value,'$.artifactId')=OLD.artifact_id AND json_extract(a.value,'$.digest')=OLD.digest)
BEGIN SELECT RAISE(ABORT,'native Action payload requires owned release receipt'); END;`;
export const legacyActionPackagePublicationDdl = `CREATE TABLE legacy_action_package_publications(operation_id TEXT NOT NULL,stage TEXT NOT NULL,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL,PRIMARY KEY(operation_id,stage));
CREATE TRIGGER legacy_action_package_publications_no_update BEFORE UPDATE ON legacy_action_package_publications BEGIN SELECT RAISE(ABORT,'immutable Action package publication'); END;
CREATE TRIGGER legacy_action_package_publications_no_delete BEFORE DELETE ON legacy_action_package_publications BEGIN SELECT RAISE(ABORT,'immutable Action package publication'); END;`;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
const fail = (code: string, message: string): never => { throw new CoreError(code, message); };
const maxBytes = 32 * 1024 * 1024;
const managedBudget = 64 * 1024 * 1024;
const inode = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
const filePin = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  `${inode(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function actorCheck(actor: Actor) {
  if (actor.id !== "mcp:external" || actor.boardWorker || !actor.canWrite)
    fail("ACCESS_DENIED", "Action artifacts require the fixed writable external actor.");
}
function canonicalDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH", "An exact absolute canonical path is required.");
  let current = path;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Artifact paths require real directory ancestors.");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  if (realpathSync(path) !== path) fail("UNSAFE_PATH", "Artifact directory changed.");
}
function withParent<T>(path: string, expectedPin: string, work: (anchored: string, fd: number) => T): T {
  if (process.platform !== "linux") fail("NOT_AVAILABLE", "Safe descriptor-relative Action artifact paths require Linux.");
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (inode(fstatSync(fd)) !== expectedPin || inode(lstatSync(dirname(path))) !== expectedPin)
      fail("SOURCE_CHANGED", "Approved artifact parent directory changed.");
    return work(join(`/proc/self/fd/${fd}`, basename(path)), fd);
  } finally { closeSync(fd); }
}
function exactFile(path: string, parentPin: string, expectedPin?: string) {
  return withParent(path, parentPin, anchored => {
    const stat = lstatSync(anchored);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes
      || expectedPin !== undefined && filePin(stat) !== expectedPin)
      fail("SOURCE_CHANGED", "Artifact source must be the exact bounded single-link regular file.");
    const fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (filePin(fstatSync(fd)) !== filePin(stat)) fail("SOURCE_CHANGED", "Artifact source changed before reading.");
      const bytes = readFileSync(fd);
      if (filePin(fstatSync(fd)) !== filePin(stat) || filePin(lstatSync(anchored)) !== filePin(stat)
        || filePin(lstatSync(path)) !== filePin(stat))
        fail("SOURCE_CHANGED", "Artifact source changed while reading.");
      return { bytes, pin: filePin(stat) };
    } finally { closeSync(fd); }
  });
}
function schema(db: DatabaseSync) {
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'legacy_action_artifact%' ORDER BY name";
  const actual = db.prepare(query).all();
  if (!actual.length) return false;
  const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    expected.exec(ddl);
    if (encode(actual) !== encode(expected.prepare(query).all()))
      fail("RECOVERY_CONFLICT", "Action artifact schema changed.");
  } finally { expected.close(); }
  return true;
}
function storedGrant(db: DatabaseSync, id: string, workspaceId: string): Grant {
  const row = db.prepare("SELECT payload FROM legacy_action_artifact_grants WHERE id=?").get(id);
  if (!row || sha(String(row.payload)) !== id) return fail("RECOVERY_CONFLICT", "Action artifact grant changed.");
  const grant = grantSchema.parse(JSON.parse(String(row.payload)));
  const member = relative(grant.selectedRoot, grant.path);
  if (grant.workspaceId !== workspaceId || !isAbsolute(grant.selectedRoot) || resolve(grant.selectedRoot) !== grant.selectedRoot
    || !isAbsolute(grant.path) || resolve(grant.path) !== grant.path || !member || member === ".."
    || member.startsWith(`..${sep}`) || isAbsolute(member)
    || grant.kind === "source" && (!grant.expectedSha256 || !grant.filePin)
    || grant.kind === "destination" && (grant.expectedSha256 !== null || grant.filePin !== null))
    fail("RECOVERY_CONFLICT", "Action artifact workspace or path binding changed.");
  return grant;
}
function currentGrant(grant: Grant, root: string) {
  if (grant.workspaceRoot !== root || inode(lstatSync(root)) !== grant.workspaceRootPin)
    fail("ACCESS_DENIED", "Artifact grant does not authorize this workspace root.");
  canonicalDirectory(dirname(grant.path));
  if (inode(lstatSync(grant.selectedRoot)) !== grant.selectedRootPin || inode(lstatSync(dirname(grant.path))) !== grant.parentPin)
    fail("SOURCE_CHANGED", "Artifact parent directory changed.");
}
function transaction<T>(storage: Storage, db: DatabaseSync, work: () => T): T {
  storage.assertWorkspaceLease(); db.exec("BEGIN IMMEDIATE");
  try { const result = work(); storage.assertWorkspaceLease(); db.exec("COMMIT"); return result; }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

function originalArtifactNamespace(db: DatabaseSync, workspaceId: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(originalMcpNativeHostReceiptTable))
    return false;
  const rows = db.prepare(`SELECT receipt_sha256,payload FROM ${originalMcpNativeHostReceiptTable} LIMIT 4097`).all();
  if (!rows.length || rows.length > 4096) fail("RECOVERY_CONFLICT", "Original artifact namespace requires bounded native host metadata.");
  for (const row of rows) {
    const receipt = originalMcpNativeHostReceiptSchema.parse(JSON.parse(String(row.payload)));
    const journal = readOriginalMcpJournal(receipt.root);
    if (!journal || journal.workspaceId !== workspaceId || !assertOriginalMcpPrivacy(receipt.root))
      return fail("RECOVERY_CONFLICT", "Original artifact namespace lost its exact root/custody binding.");
    verifyOriginalMcpNativeHostReceiptDatabase(db, journal, String(row.receipt_sha256));
  }
  return true;
}
export function verifyLegacyActionArtifacts(db: DatabaseSync, workspaceId: string, allowPending = false): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version), present = schema(db);
  if (!present) {
    if (version === 27) fail("RECOVERY_CONFLICT", "Schema27 requires the original Action artifact authority.");
    return;
  }
  if (![27, 28].includes(version) && !(version === 23 && originalArtifactNamespace(db, workspaceId)))
    fail("RECOVERY_CONFLICT", "Action artifacts require downgrade-fenced native storage or exact original-root metadata.");
  for (const row of db.prepare("SELECT id FROM legacy_action_artifact_grants").all())
    storedGrant(db, String(row.id), workspaceId);
  for (const row of db.prepare("SELECT id,payload,payload_sha256 FROM legacy_action_artifacts").all()) {
    if (sha(String(row.payload)) !== row.payload_sha256) fail("RECOVERY_CONFLICT", "Action artifact record changed.");
    const value = artifactSchema.parse(JSON.parse(String(row.payload)));
    if (value.artifactId !== row.id) fail("RECOVERY_CONFLICT", "Action artifact identity changed.");
    if ("kind" in value) verifyManaged(db, workspaceId, value, false);
    else {
      const source = storedGrant(db, value.sourceGrant, workspaceId);
      if (source.kind !== "source" || value.digest !== source.expectedSha256)
        fail("RECOVERY_CONFLICT", "Action artifact source binding changed.");
    }
  }
  for (const row of db.prepare("SELECT operation_id,payload,payload_sha256 FROM legacy_action_artifact_receipts").all()) {
    if (sha(String(row.payload)) !== row.payload_sha256) fail("RECOVERY_CONFLICT", "Action artifact receipt changed.");
    const receipt = intentSchema.parse(JSON.parse(String(row.payload)));
    if (receipt.operationId !== row.operation_id || receipt.workspaceId !== workspaceId || !receipt.filePin
      || storedGrant(db, receipt.destinationGrant, workspaceId).kind !== "destination"
      || artifact(db, workspaceId, receipt.artifactId, false, undefined, true).value.digest !== receipt.digest)
      fail("RECOVERY_CONFLICT", "Action artifact receipt binding changed.");
  }
  const pending = db.prepare("SELECT payload,payload_sha256 FROM legacy_action_artifact_intent WHERE singleton=1").get();
  if (pending) {
    if (sha(String(pending.payload)) !== pending.payload_sha256) fail("RECOVERY_CONFLICT", "Action artifact intent changed.");
    const intent = intentSchema.parse(JSON.parse(String(pending.payload)));
    if (intent.workspaceId !== workspaceId || storedGrant(db, intent.destinationGrant, workspaceId).kind !== "destination"
      || artifact(db, workspaceId, intent.artifactId).value.digest !== intent.digest)
      fail("RECOVERY_CONFLICT", "Action artifact intent binding changed.");
    if (!allowPending) fail("RECOVERY_REQUIRED", "Uncertain Action artifact publication requires explicit native reconciliation.");
  }
  if (!allowPending && [...verifyLegacyActionPackagePublications(db, workspaceId).values()].some(history => history.at(-1)?.stage !== "written"))
    fail("RECOVERY_REQUIRED", "Uncertain Action package publication requires explicit native reconciliation.");
}

export async function admitLegacyActionArtifactPath(storage: Storage, actor: Actor, request: {
  kind: "source" | "destination"; selectedRoot: string; path: string; expectedSha256?: string; authorityId: string;
  authorize: (binding: Readonly<{ workspaceId: string; workspaceRoot: string; workspaceRootPin: string;
    actorId: string; authorityId: string; kind: "source" | "destination"; selectedRoot: string;
    path: string; expectedSha256: string | null }>) => boolean;
  prepareCurrent?: () => Promise<void>;
}) {
  actorCheck(actor);
  const workspaceRoot = storage.workspaceRoot(), workspaceId = await storage.workspaceId();
  const proposed = { workspaceId, workspaceRoot, workspaceRootPin: inode(lstatSync(workspaceRoot)), actorId: actor.id,
    authorityId: request.authorityId, kind: request.kind, path: request.path,
    selectedRoot: request.selectedRoot,
    expectedSha256: request.expectedSha256 ?? null };
  const member = relative(request.selectedRoot, request.path);
  if (!request.authorityId || !isAbsolute(request.selectedRoot) || resolve(request.selectedRoot) !== request.selectedRoot
    || !isAbsolute(request.path) || resolve(request.path) !== request.path
    || !member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)
    || request.kind === "source" && !digest.safeParse(request.expectedSha256).success
    || request.kind === "destination" && request.expectedSha256 !== undefined
    || request.authorize(Object.freeze(proposed)) !== true)
    fail("ACCESS_DENIED", "Explicit exact native Action artifact path approval is required.");
  return storage.withWorkspaceExclusive(async () => {
    await request.prepareCurrent?.();
    storage.assertWorkspaceLease();
    canonicalDirectory(request.selectedRoot);
    canonicalDirectory(dirname(request.path));
    const parentPin = inode(lstatSync(dirname(request.path))), selectedRootPin = inode(lstatSync(request.selectedRoot));
    let sourcePin: string | null = null;
    if (request.kind === "source") {
      const source = exactFile(request.path, parentPin);
      if (sha(source.bytes) !== request.expectedSha256) fail("SOURCE_CHANGED", "Approved artifact digest differs.");
      sourcePin = source.pin;
    } else if (lstatSync(request.path, { throwIfNoEntry: false }))
      fail("CONFLICT", "Artifact destination already exists.");
    if (request.authorize(Object.freeze(proposed)) !== true || inode(lstatSync(workspaceRoot)) !== proposed.workspaceRootPin
      || inode(lstatSync(dirname(request.path))) !== parentPin || inode(lstatSync(request.selectedRoot)) !== selectedRootPin)
      fail("ACCESS_DENIED", "Artifact approval or root changed during admission.");
    const grant = grantSchema.parse({ ...proposed, selectedRootPin, parentPin, filePin: sourcePin });
    const payload = encode(grant), id = sha(payload), db = storage.connectNative();
    try {
      transaction(storage, db, () => {
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
        if (![23, 24, 25, 26, 27, 28].includes(version))
          fail("RECOVERY_CONFLICT", "Action artifact admission requires a supported native workspace schema.");
        if (!schema(db)) {
          if (version === 27) fail("RECOVERY_CONFLICT", "Schema27 artifact authority is missing.");
          db.exec(ddl);
          if (!(version === 23 && originalArtifactNamespace(db, workspaceId)))
            db.exec(`PRAGMA user_version=${Math.max(27, version)}`);
        }
        verifyLegacyActionArtifacts(db, workspaceId);
        db.prepare("INSERT OR IGNORE INTO legacy_action_artifact_grants VALUES(?,?)").run(id, payload);
      });
      return { id };
    } finally { db.close(); }
  });
}

function findGrant(db: DatabaseSync, workspaceId: string, root: string, kind: Grant["kind"], path: string,
  authorizePicked?: (authorityId: string) => boolean, selectedGrantId?: string) {
  const found = db.prepare("SELECT id FROM legacy_action_artifact_grants").all()
    .map(row => ({ id: String(row.id), grant: storedGrant(db, String(row.id), workspaceId) }))
    .filter(value => value.grant.kind === kind && value.grant.path === path
      && value.grant.workspaceRoot === root && value.grant.workspaceRootPin === inode(lstatSync(root))
      && (selectedGrantId === undefined || value.id === selectedGrantId)
      && (!value.grant.authorityId.startsWith("pkm-action-picker:") || authorizePicked?.(value.grant.authorityId) === true));
  if (found.length !== 1) return fail("ACCESS_DENIED", "The exact artifact path requires one native host admission.");
  currentGrant(found[0]!.grant, root);
  return found[0]!;
}
function artifact(db: DatabaseSync, workspaceId: string, id: string, materialize = true, activeParent?: string, historical = false) {
  const row = db.prepare("SELECT payload,payload_sha256 FROM legacy_action_artifacts WHERE id=?").get(id);
  if (!row || sha(String(row.payload)) !== row.payload_sha256)
    return fail("NOT_FOUND", "Original Action artifact was not found.");
  const value = (() => {
    try { return artifactSchema.parse(JSON.parse(String(row.payload))); }
    catch { return fail("RECOVERY_CONFLICT", "Action artifact metadata violates its closed custody schema."); }
  })();
  if (value.artifactId !== id) fail("RECOVERY_CONFLICT", "Action artifact identity changed.");
  if ("kind" in value) {
    const bytes = verifyManaged(db, workspaceId, value, true, materialize, activeParent, historical);
    return { value, bytes };
  }
  const grant = storedGrant(db, value.sourceGrant, workspaceId);
  if (grant.kind !== "source" || value.digest !== grant.expectedSha256 || !grant.filePin)
    fail("RECOVERY_CONFLICT", "Action artifact source binding changed.");
  return { value, grant };
}

function verifyManaged(db: DatabaseSync, workspaceId: string, value: z.infer<typeof managedArtifactSchema>,
  published: boolean, materialize = true, activeParent?: string, historical = false): Buffer | undefined {
  if (historical && materialize) fail("RECOVERY_CONFLICT", "Historical artifact metadata cannot materialize payloads.");
  if (value.workspaceId !== workspaceId) fail("RECOVERY_CONFLICT", "Managed Action artifact workspace changed.");
  const row = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
    .get(value.actorId, value.ownerRunId);
  if (!row) return fail("RECOVERY_CONFLICT", "Managed Action artifact owner is unavailable.");
  const run = JSON.parse(String(row.snapshot)) as {
    runId?: unknown; actionId?: unknown; definitionDigest?: unknown; definition?: unknown; state?: unknown;
    inputs?: { source?: { artifact_id?: unknown } }; nodes?: Array<{ nodeId?: unknown; outputs?: { artifact_id?: unknown } }>;
  };
  if (run.runId !== value.ownerRunId || run.actionId !== "core.artifact.copy"
    || run.definitionDigest !== value.executableDigest || !exactRunnableArtifactBuiltin(run.definition)
    || run.inputs?.source?.artifact_id !== value.sourceArtifactId || !Array.isArray(run.nodes)
    || run.nodes.length !== 1 || run.nodes[0]?.nodeId !== "action"
    || !["running", "succeeded", "failed", "cancelled", "cancelling", "unknown"].includes(String(run.state)))
    fail("RECOVERY_CONFLICT", "Managed Action artifact run binding changed.");
  if (originalDefinitionValue(run.definition as Record<string, unknown>).content_hash !== value.executableDigest)
    fail("RECOVERY_CONFLICT", "Managed Action artifact executable digest changed.");
  const nestedPlan = readNestedActionPlan(db, value.actorId, value.ownerRunId);
  if ((nestedPlan?.parentRunId ?? undefined) !== value.rootRunId)
    fail("RECOVERY_CONFLICT", "Managed Action artifact root ownership changed.");
  if ((published || run.state === "succeeded") && (run.state !== "succeeded" || run.nodes?.length !== 1
    || run.nodes[0]?.outputs?.artifact_id !== value.artifactId))
    fail("ACCESS_DENIED", "Managed Action artifact has not been published by its successful owner.");
  if (value.rootRunId && published && !historical)
    authorizeNestedArtifact(db, workspaceId, value.actorId, value.ownerRunId, value.rootRunId,
      value.artifactId, value.sourceArtifactId, activeParent);
  const released = actionArtifactWasReleased(db, workspaceId, value.artifactId);
  if (released) {
    if (published && !historical) fail("ACCESS_DENIED", "The owned Action artifact reference was explicitly released.");
    return undefined;
  }
  if (!materialize) return undefined;
  let encoded: string;
  if ("bytes" in value) encoded = value.bytes;
  else {
    verifyNativeActionManagedBlobs(db, workspaceId);
    const blob = db.prepare("SELECT actor_id,bytes,digest,size FROM native_action_managed_blobs WHERE artifact_id=?").get(value.artifactId);
    if (!blob || blob.actor_id !== value.actorId || blob.digest !== value.digest || blob.size !== value.size)
      return fail("RECOVERY_CONFLICT", "Managed Action blob lost its exact immutable owner binding.");
    encoded = String(blob.bytes);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== value.size || bytes.toString("base64") !== encoded || sha(bytes) !== value.digest)
    fail("RECOVERY_CONFLICT", "Managed Action artifact bytes changed.");
  return bytes;
}

export function inspectActionArtifact(db: DatabaseSync, root: string, workspaceId: string, actor: Actor, id: string,
  authorizePicked?: (authorityId: string) => boolean) {
  actorCheck(actor);
  if (!borrowedArtifactSchema.shape.artifactId.safeParse(id).success || !schema(db))
    return fail("NOT_FOUND", "Original Action artifact was not found.");
  const item = artifact(db, workspaceId, id, false);
  if (actionArtifactWasReleased(db, workspaceId, id)) fail("ACCESS_DENIED", "The Action artifact reference was explicitly released.");
  if ("grant" in item && item.grant) {
    if (item.grant.authorityId.startsWith("pkm-action-picker:") && authorizePicked?.(item.grant.authorityId) !== true)
      return fail("ACCESS_DENIED", "The selected artifact grant requires its original live trust epoch.");
    currentGrant(item.grant, root);
    const size = Number(item.grant.filePin!.split(":")[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
      return fail("RECOVERY_CONFLICT", "Artifact source size binding changed.");
    return { artifactId: id, digest: item.value.digest, size };
  }
  if (!("kind" in item.value)) return fail("RECOVERY_CONFLICT", "Artifact source binding changed.");
  return { artifactId: id, digest: item.value.digest, size: item.value.size };
}

export function verifyOwnedActionArtifact(db: DatabaseSync, workspaceId: string, actor: Actor, runId: string, id: string,
  activeParent?: string) {
  actorCheck(actor);
  const item = artifact(db, workspaceId, id, true, activeParent);
  if (!("kind" in item.value) || item.value.ownerRunId !== runId || item.value.actorId !== actor.id)
    return fail("ACCESS_DENIED", "The Action result does not own this managed artifact.");
  return { artifactId: id, digest: item.value.digest, size: item.value.size };
}

export function managedActionArtifactOwner(db: DatabaseSync, workspaceId: string, actor: Actor, id: string): string | undefined {
  actorCheck(actor);
  if (!schema(db)) return fail("ACCESS_DENIED", "Action artifact paths require native host admission.");
  const item = artifact(db, workspaceId, id, false);
  return "kind" in item.value ? item.value.ownerRunId : undefined;
}

function artifactBytes(db: DatabaseSync, root: string, workspaceId: string, id: string,
  authorizePicked?: (authorityId: string) => boolean): Buffer {
  const item = artifact(db, workspaceId, id);
  if ("grant" in item && item.grant) {
    if (item.grant.authorityId.startsWith("pkm-action-picker:") && authorizePicked?.(item.grant.authorityId) !== true)
      return fail("ACCESS_DENIED", "The selected artifact grant requires its original live trust epoch.");
    currentGrant(item.grant, root);
    let bytes: Buffer;
    try { bytes = exactFile(item.grant.path, item.grant.parentPin, item.grant.filePin!).bytes; }
    catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) {
        const changed = new CoreError("SOURCE_CHANGED", "Approved artifact source is unavailable.");
        changed.cause = error;
        throw changed;
      }
      throw error;
    }
    if (sha(bytes) !== item.value.digest) return fail("SOURCE_CHANGED", "Approved artifact source changed.");
    return bytes;
  }
  if (!("bytes" in item) || !item.bytes) return fail("RECOVERY_CONFLICT", "Managed Action artifact bytes unavailable.");
  return item.bytes;
}

export function verifyNativeActionManagedBlobs(db: DatabaseSync, workspaceId: string) {
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'native_action_managed_blobs%' ORDER BY name";
  const actual = db.prepare(query).all();
  if (!actual.length) return false;
  const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    expected.exec(nativeActionManagedBlobDdl);
    if (encode(actual) !== encode(expected.prepare(query).all())) fail("RECOVERY_CONFLICT", "Native Action blob schema changed.");
  } finally { expected.close(); }
  for (const row of db.prepare("SELECT artifact_id,actor_id,bytes,digest,size FROM native_action_managed_blobs").all()) {
    const metadata = db.prepare("SELECT payload,payload_sha256 FROM legacy_action_artifacts WHERE id=?").get(row.artifact_id);
    if (!metadata || sha(String(metadata.payload)) !== metadata.payload_sha256)
      return fail("RECOVERY_CONFLICT", "Native Action blob has no immutable metadata.");
    const value = managedArtifactSchema.parse(JSON.parse(String(metadata.payload)));
    const bytes = Buffer.from(String(row.bytes), "base64");
    if (!("storage" in value) || value.workspaceId !== workspaceId || value.artifactId !== row.artifact_id
      || value.actorId !== row.actor_id || value.digest !== row.digest || value.size !== row.size
      || bytes.length !== value.size || bytes.toString("base64") !== row.bytes || sha(bytes) !== value.digest
      || actionArtifactWasReleased(db, workspaceId, value.artifactId))
      fail("RECOVERY_CONFLICT", "Native Action blob ownership or bytes changed.");
  }
  return true;
}
export function readNativeManagedActionArtifacts(db: DatabaseSync, workspaceId: string) {
  if (!schema(db)) return [];
  verifyLegacyActionArtifacts(db, workspaceId, true);
  return db.prepare("SELECT payload FROM legacy_action_artifacts").all().flatMap(row => {
    const value = artifactSchema.parse(JSON.parse(String(row.payload)));
    return "kind" in value ? [value] : [];
  });
}
export function collectNativeManagedActionPayload(db: DatabaseSync, workspaceId: string, artifactId: string) {
  if (!actionArtifactWasReleased(db, workspaceId, artifactId)) fail("ACCESS_DENIED", "Owned release receipt is required before payload collection.");
  const row = db.prepare("SELECT payload FROM legacy_action_artifacts WHERE id=?").get(artifactId);
  const value = row && managedArtifactSchema.parse(JSON.parse(String(row.payload)));
  if (!value || value.workspaceId !== workspaceId) return fail("RECOVERY_CONFLICT", "Managed payload collection lost its owner.");
  if ("storage" in value) db.prepare("DELETE FROM native_action_managed_blobs WHERE artifact_id=? AND actor_id=?")
    .run(artifactId, value.actorId);
}

export function copyActionArtifact(db: DatabaseSync, root: string, workspaceId: string, actor: Actor,
  runId: string, executableDigest: string, sourceId: string, assertOwner: () => void,
  authorizePicked?: (authorityId: string) => boolean): { artifact_id: string } {
  actorCheck(actor);
  if (db.isTransaction) return fail("TRANSACTION_BOUNDARY", "Artifact production requires an idle native database.");
  assertOwner();
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = inspectActionArtifact(db, root, workspaceId, actor, sourceId, authorizePicked);
    const bytes = artifactBytes(db, root, workspaceId, sourceId, authorizePicked);
    if (bytes.length !== source.size || sha(bytes) !== source.digest)
      fail("SOURCE_CHANGED", "Action artifact input differs from its approved identity.");
    if (!verifyNativeActionManagedBlobs(db, workspaceId)) db.exec(nativeActionManagedBlobDdl);
    const used = Number(db.prepare("SELECT coalesce(sum(length(payload)),0) AS size FROM legacy_action_artifacts").get()?.size)
      + Number(db.prepare("SELECT coalesce(sum(length(bytes)),0) AS size FROM native_action_managed_blobs").get()?.size);
    const nested = readNestedActionPlan(db, actor.id, runId);
    if (nested && (nested.workspaceId !== workspaceId || nested.sourceId !== sourceId))
      fail("RECOVERY_CONFLICT", "Nested Action artifact source or workspace changed.");
    const value = managedArtifactSchema.parse({
      artifactId: `artifact_${randomUUID().replaceAll("-", "")}`, kind: "managed", actorId: actor.id,
      workspaceId, ownerRunId: runId, executableDigest, sourceArtifactId: sourceId,
      ...(nested ? { rootRunId: nested.parentRunId } : {}),
      digest: source.digest, size: bytes.length, storage: "native-blob/v1",
    });
    const payload = encode(value);
    if (!Number.isSafeInteger(used) || used + Buffer.byteLength(payload) + bytes.toString("base64").length > managedBudget)
      fail("RESOURCE_LIMIT", "Managed Action artifact workspace quota exceeded.");
    verifyManaged(db, workspaceId, value, false, false);
    const owner = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actor.id, runId);
    const run = JSON.parse(String(owner?.snapshot)) as { state?: unknown; cancelRequested?: unknown; nodes?: Array<{ nodeId?: unknown; state?: unknown }> };
    if (run.state !== "running" || run.cancelRequested || run.nodes?.length !== 1
      || run.nodes[0]?.nodeId !== "action" || run.nodes[0]?.state !== "running")
      fail("ACCESS_DENIED", "Artifact production requires a live owned Action node.");
    assertOwner();
    db.prepare("INSERT INTO legacy_action_artifacts VALUES(?,?,?)").run(value.artifactId, payload, sha(payload));
    db.prepare("INSERT INTO native_action_managed_blobs VALUES(?,?,?,?,?)")
      .run(value.artifactId, actor.id, bytes.toString("base64"), value.digest, bytes.length);
    assertOwner();
    db.exec("COMMIT");
    return { artifact_id: value.artifactId };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function saveIntent(db: DatabaseSync, intent: Intent) {
  const payload = encode(intent);
  db.prepare("INSERT OR REPLACE INTO legacy_action_artifact_intent VALUES(1,?,?)").run(payload, sha(payload));
}
function commitIntent(storage: Storage, db: DatabaseSync, intent: Intent) {
  transaction(storage, db, () => {
    const pending = db.prepare("SELECT payload,payload_sha256 FROM legacy_action_artifact_intent WHERE singleton=1").get();
    if (!pending || pending.payload !== encode(intent) || pending.payload_sha256 !== sha(String(pending.payload)))
      fail("RECOVERY_CONFLICT", "Action artifact pending publication changed.");
    const payload = encode(intent);
    db.prepare("INSERT INTO legacy_action_artifact_receipts VALUES(?,?,?)").run(intent.operationId, payload, sha(payload));
    db.prepare("DELETE FROM legacy_action_artifact_intent WHERE singleton=1").run();
  });
}

export async function legacyActionArtifact(storage: Storage, actor: Actor, input:
  { tool: "action_artifact_import"; local_path: string } |
  { tool: "action_artifact_export"; artifact_id: string; destination: string },
  host?: { checkpoint?(stage: "prepared" | "pinned" | "written"): void; authorizeManaged?(): boolean;
    authorizePicked?(authorityId: string, artifact?: { artifactId: string; digest: string }): boolean; selectedGrantId?: string }) {
  actorCheck(actor);
  const workspaceId = await storage.workspaceId(), root = storage.workspaceRoot();
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const db = storage.connectNative();
    try {
      if (!schema(db)) fail("ACCESS_DENIED", "Action artifact paths require native host admission.");
      verifyLegacyActionArtifacts(db, workspaceId);
      if (input.tool === "action_artifact_import") {
        const source = findGrant(db, workspaceId, root, "source", input.local_path, host?.authorizePicked, host?.selectedGrantId);
        const authorizePicked = () => {
          if (source.grant.authorityId.startsWith("pkm-action-picker:")
            && host?.authorizePicked?.(source.grant.authorityId) !== true)
            fail("ACCESS_DENIED", "The selected artifact grant requires its original live trust epoch.");
        };
        authorizePicked();
        const bytes = exactFile(source.grant.path, source.grant.parentPin, source.grant.filePin!).bytes;
        if (sha(bytes) !== source.grant.expectedSha256) fail("SOURCE_CHANGED", "Approved artifact source changed.");
        const value = artifactSchema.parse({ artifactId: `artifact_${randomUUID().replaceAll("-", "")}`,
          sourceGrant: source.id, digest: source.grant.expectedSha256 });
        const payload = encode(value);
        transaction(storage, db, () => {
          currentGrant(source.grant, root);
          authorizePicked();
          if (sha(exactFile(source.grant.path, source.grant.parentPin, source.grant.filePin!).bytes) !== value.digest)
            fail("SOURCE_CHANGED", "Approved artifact source changed during import.");
          db.prepare("INSERT INTO legacy_action_artifacts VALUES(?,?,?)").run(value.artifactId, payload, sha(payload));
        });
        return { artifact_id: value.artifactId };
      }
      const source = artifact(db, workspaceId, input.artifact_id, false);
      const authorizeManaged = () => {
        if ("kind" in source.value && host?.authorizeManaged?.() !== true)
          fail("ACCESS_DENIED", "Managed Action artifact export requires current owner and Action trust.");
      };
      authorizeManaged();
      const bytes = artifactBytes(db, root, workspaceId, input.artifact_id, host?.authorizePicked);
      const destinationBinding = { artifactId: source.value.artifactId, digest: source.value.digest };
      const destination = findGrant(db, workspaceId, root, "destination", input.destination,
        id => host?.authorizePicked?.(id, destinationBinding) === true, host?.selectedGrantId);
      const authorizeDestination = () => {
        if (destination.grant.authorityId.startsWith("pkm-action-picker:")
          && host?.authorizePicked?.(destination.grant.authorityId, destinationBinding) !== true)
          fail("ACCESS_DENIED", "The selected artifact destination requires its original live trust epoch.");
      };
      authorizeDestination();
      if ("grant" in source && source.grant && (destination.grant.selectedRoot !== source.grant.selectedRoot
        || destination.grant.selectedRootPin !== source.grant.selectedRootPin))
        fail("ACCESS_DENIED", "Artifact source and destination require the same approved selected workspace.");
      if (lstatSync(destination.grant.path, { throwIfNoEntry: false }))
        fail("CONFLICT", "Artifact destination already exists; export never overwrites.");
      let intent: Intent = { operationId: randomUUID(), workspaceId, actorId: "mcp:external",
        artifactId: source.value.artifactId, destinationGrant: destination.id,
        digest: source.value.digest, size: bytes.length, filePin: null };
      transaction(storage, db, () => saveIntent(db, intent));
      host?.checkpoint?.("prepared");
      storage.assertWorkspaceLease();
      authorizeManaged();
      authorizeDestination();
      currentGrant(destination.grant, root);
      withParent(destination.grant.path, destination.grant.parentPin, (anchored, parent) => {
        const fd = openSync(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || inode(lstatSync(anchored)) !== inode(stat))
            fail("RECOVERY_CONFLICT", "Artifact publication identity changed.");
          intent = { ...intent, filePin: inode(stat) };
          transaction(storage, db, () => saveIntent(db, intent));
          host?.checkpoint?.("pinned");
          fchmodSync(fd, 0o600);
          writeFileSync(fd, bytes);
          fsyncSync(fd);
          if (inode(fstatSync(fd)) !== intent.filePin || inode(lstatSync(anchored)) !== intent.filePin)
            fail("RECOVERY_CONFLICT", "Artifact destination changed during publication.");
        } finally { closeSync(fd); }
        fsyncSync(parent);
      });
      const output = exactFile(destination.grant.path, destination.grant.parentPin);
      if (sha(output.bytes) !== intent.digest || output.bytes.length !== intent.size)
        fail("RECOVERY_CONFLICT", "Artifact output differs from approved source.");
      host?.checkpoint?.("written");
      currentGrant(destination.grant, root);
      authorizeManaged();
      authorizeDestination();
      if (sha(artifactBytes(db, root, workspaceId, input.artifact_id, host?.authorizePicked)) !== intent.digest)
        fail("SOURCE_CHANGED", "Artifact changed during export; publication requires reconciliation.");
      commitIntent(storage, db, intent);
      return { ok: true, path: destination.grant.path, digest: intent.digest, ownership: "user-exported" };
    } finally { db.close(); }
  });
}

export async function reconcileLegacyActionArtifact(storage: Storage, actor: Actor, authorize: (binding:
  Readonly<{ workspaceId: string; workspaceRoot: string; operationId: string; destination: string;
    artifactId: string; digest: string; filePin: string | null }>) => boolean) {
  actorCheck(actor);
  const workspaceId = await storage.workspaceId(), root = storage.workspaceRoot();
  return storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative();
    try {
      verifyLegacyActionArtifacts(db, workspaceId, true);
      const row = db.prepare("SELECT payload FROM legacy_action_artifact_intent WHERE singleton=1").get();
      if (!row) return { reconciled: false };
      const intent = intentSchema.parse(JSON.parse(String(row.payload)));
      const destination = storedGrant(db, intent.destinationGrant, workspaceId);
      const binding = Object.freeze({ workspaceId, workspaceRoot: root, operationId: intent.operationId,
        destination: destination.path, artifactId: intent.artifactId, digest: intent.digest, filePin: intent.filePin });
      if (authorize(binding) !== true) fail("ACCESS_DENIED", "Exact Action artifact reconciliation approval is required.");
      currentGrant(destination, root);
      if (!intent.filePin) fail("RECOVERY_CONFLICT", "Unpinned publication cannot be automatically adopted or removed.");
      const result = exactFile(destination.path, destination.parentPin);
      if (inode(lstatSync(destination.path)) !== intent.filePin || result.bytes.length !== intent.size || sha(result.bytes) !== intent.digest)
        fail("RECOVERY_CONFLICT", "Uncertain artifact bytes or owner do not match the pinned publication.");
      if (authorize(binding) !== true) fail("ACCESS_DENIED", "Action artifact reconciliation approval was revoked.");
      withParent(destination.path, destination.parentPin, (_path, parent) => fsyncSync(parent));
      commitIntent(storage, db, intent);
      return { reconciled: true };
    } finally { db.close(); }
  });
}

const packagePublication = z.strictObject({ operationId: z.string().uuid(), stage: z.enum(["prepared", "pinned", "written"]),
  workspaceId: z.string(), actorId: z.literal("mcp:external"), destinationGrant: digest, path: z.string(),
  digest, size: z.number().safe().int().min(0).max(maxBytes), filePin: z.string().nullable() });
export function verifyLegacyActionPackagePublications(db: DatabaseSync, workspaceId: string) {
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'legacy_action_package_publications%' ORDER BY name";
  const actual = db.prepare(query).all(), histories = new Map<string, z.infer<typeof packagePublication>[]>();
  if (!actual.length) return histories;
  const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    expected.exec(legacyActionPackagePublicationDdl);
    if (encode(actual) !== encode(expected.prepare(query).all())) fail("RECOVERY_CONFLICT", "Package publication schema changed.");
  } finally { expected.close(); }
  for (const row of db.prepare("SELECT operation_id,stage,payload,payload_sha256 FROM legacy_action_package_publications ORDER BY rowid").all()) {
    if (sha(String(row.payload)) !== row.payload_sha256) fail("RECOVERY_CONFLICT", "Package publication history changed.");
    const value = packagePublication.parse(JSON.parse(String(row.payload))), history = histories.get(value.operationId) ?? [];
    if (value.operationId !== row.operation_id || value.stage !== row.stage || value.workspaceId !== workspaceId
      || value.stage !== ["prepared", "pinned", "written"][history.length]
      || value.stage === "prepared" && value.filePin !== null || value.stage !== "prepared" && value.filePin === null
      || history[0] && ["path", "digest", "size", "destinationGrant"].some(key =>
        value[key as keyof typeof value] !== history[0]![key as keyof typeof value])
      || history[1] && value.filePin !== history[1].filePin)
      fail("RECOVERY_CONFLICT", "Package publication binding changed.");
    const grant = storedGrant(db, value.destinationGrant, workspaceId);
    if (grant.path !== value.path || grant.kind !== "destination")
      fail("RECOVERY_CONFLICT", "Package destination custody changed.");
    history.push(value); histories.set(value.operationId, history);
  }
  if (histories.size > 1000) fail("RESOURCE_LIMIT", "Package publication receipt budget exceeded.");
  return histories;
}

/** A package is not an Action artifact or Run output. Reuse only independently admitted destination custody. */
export async function publishLegacyActionPackage(storage: Storage, actor: Actor, destinationPath: string, bytes: Buffer,
  assertCurrent: () => void, prepareCurrent?: () => Promise<void>) {
  actorCheck(actor);
  if (bytes.length > maxBytes) fail("RESOURCE_LIMIT", "Action package exceeds its bounded publication budget.");
  const workspaceId = await storage.workspaceId(), root = storage.workspaceRoot();
  return storage.withWorkspaceExclusive(async () => {
    await prepareCurrent?.();
    assertCurrent(); storage.assertWorkspaceLease();
    const db = storage.connectNative();
    try {
      if (!schema(db)) fail("ACCESS_DENIED", "An independently admitted package destination is required.");
      verifyLegacyActionArtifacts(db, workspaceId);
      const destination = findGrant(db, workspaceId, root, "destination", destinationPath);
      if (destination.grant.authorityId.startsWith("pkm-action-picker:"))
        fail("ACCESS_DENIED", "Artifact-bound picker grants cannot publish ModuleSets.");
      currentGrant(destination.grant, root);
      if (lstatSync(destinationPath, { throwIfNoEntry: false })) fail("CONFLICT", "Package export never overwrites or replays a destination.");
      const ddl = legacyActionPackagePublicationDdl;
      const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
      try {
        expected.exec(ddl);
        const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'legacy_action_package_publications%' ORDER BY name";
        const actual = db.prepare(query).all();
        if (actual.length && encode(actual) !== encode(expected.prepare(query).all()))
          fail("RECOVERY_CONFLICT", "Package publication schema changed.");
        if (!actual.length) transaction(storage, db, () => db.exec(ddl));
      } finally { expected.close(); }
      const histories = verifyLegacyActionPackagePublications(db, workspaceId);
      if (histories.size >= 1000) fail("RESOURCE_LIMIT", "Package publication receipt budget exceeded.");
      for (const history of histories.values()) if (history.at(-1)!.stage !== "written")
        fail("RECOVERY_REQUIRED", "An uncertain package publication must be reconciled; it cannot be replayed.");
      const operationId = randomUUID(), packageDigest = sha(bytes);
      const save = (stage: string, filePin: string | null) => transaction(storage, db, () => {
        assertCurrent();
        const payload = encode({ operationId, stage, workspaceId, actorId: actor.id, destinationGrant: destination.id,
          path: destinationPath, digest: packageDigest, size: bytes.length, filePin });
        db.prepare("INSERT INTO legacy_action_package_publications VALUES(?,?,?,?)").run(operationId, stage, payload, sha(payload));
      });
      save("prepared", null);
      withParent(destinationPath, destination.grant.parentPin, (anchored, parent) => {
        assertCurrent(); currentGrant(destination.grant, root);
        const fd = openSync(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const id = inode(fstatSync(fd));
          if (inode(lstatSync(anchored)) !== id || fstatSync(fd).nlink !== 1)
            fail("RECOVERY_CONFLICT", "Package publication identity changed.");
          save("pinned", id);
          writeFileSync(fd, bytes); fsyncSync(fd);
          if (inode(fstatSync(fd)) !== id || inode(lstatSync(anchored)) !== id || fstatSync(fd).nlink !== 1)
            fail("RECOVERY_CONFLICT", "Package destination changed during publication.");
          fsyncSync(parent);
          assertCurrent();
          const written = exactFile(destinationPath, destination.grant.parentPin).bytes;
          if (!written.equals(bytes)) fail("RECOVERY_CONFLICT", "Package output differs from approved source.");
          save("written", id);
        } finally { closeSync(fd); }
      });
      return { ok: true, path: destinationPath, digest: packageDigest };
    } finally { db.close(); }
  });
}
