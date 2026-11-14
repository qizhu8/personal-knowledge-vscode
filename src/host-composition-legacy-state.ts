import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { legacyImportOutcomeSchema, legacyImportPlanSchema, type LegacyImportOutcome, type LegacyImportPlan } from "./domain/legacy-import.js";
import { LegacyStateImportError, readImportedEncryptedSnapshot, inspectImportedSubscriptionCache, type LegacySnapshotKeyAuthority } from "./legacy-state-import.js";
import { readAgentSnapshots } from "./agent-snapshot-reads.js";
import { readSubscriptions } from "./subscription-reads.js";
import { authorizeSubscriptionIdentity, type NativeSubscriptionIdentityPolicy } from "./legacy-subscription-identity.js";
import { verifyLegacySkillMaintenance, type LegacySkillMaintenanceGenesis } from "./legacy-skill-maintenance.js";
import { readProtectedRefresh } from "./legacy-subscription-refresh.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface NativeLegacySnapshotPolicy {
  readonly receiptSha256: string;
  readonly authority: LegacySnapshotKeyAuthority;
  authorize(actor: Readonly<Actor>, workspaceId: string): boolean | Promise<boolean>;
}

export function initializeLegacyStateReceiptSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_state_import_receipt(
      workspace_id TEXT PRIMARY KEY, plan TEXT NOT NULL, outcome TEXT NOT NULL,
      binding_sha256 TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS legacy_state_receipt_no_update BEFORE UPDATE ON legacy_state_import_receipt
      BEGIN SELECT RAISE(ABORT,'Immutable legacy state import receipt'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_state_receipt_no_delete BEFORE DELETE ON legacy_state_import_receipt
      BEGIN SELECT RAISE(ABORT,'Immutable legacy state import receipt'); END;
  `);
}

export function insertLegacyStateReceipt(database: DatabaseSync, plan: LegacyImportPlan, outcome: LegacyImportOutcome): void {
  if (!plan.statePlan) return;
  validateBinding(plan, outcome, outcome.workspaceId);
  database.prepare("INSERT INTO legacy_state_import_receipt(workspace_id,plan,outcome,binding_sha256) VALUES(?,?,?,?)")
    .run(outcome.workspaceId, JSON.stringify(plan), JSON.stringify(outcome), digest({ plan, outcome }));
}

function validateBinding(plan: LegacyImportPlan, outcome: LegacyImportOutcome, workspaceId: string): void {
  const { planSha256, ...planBody } = plan;
  const { receiptSha256, ...receiptBody } = outcome.receipt;
  const state = plan.statePlan;
  const { planSha256: stateHash, ...stateBody } = state ?? { planSha256: "" };
  if (!state || digest(planBody) !== planSha256 || digest(stateBody) !== stateHash
    || digest(receiptBody) !== receiptSha256 || !plan.ready || plan.blockers.length
    || outcome.workspaceId !== workspaceId || outcome.fingerprint !== plan.fingerprint
    || outcome.receipt.fingerprint !== plan.fingerprint || outcome.destination !== outcome.receipt.destination
    || outcome.receipt.importPlanSha256 !== planSha256
    || JSON.stringify(outcome.receipt.retrievalHistoryPlan) !== JSON.stringify(plan.retrievalHistoryPlan)
    || JSON.stringify(outcome.receipt.statePlan) !== JSON.stringify(state)) {
    throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state import binding is invalid.");
  }
}

export function readLegacyStateReceipt(database: DatabaseSync, workspaceId: string) {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_state_import_receipt'").get();
  if (!table) {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version >= 14) throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state import receipt table is missing.");
    return undefined;
  }
  const rows = database.prepare("SELECT workspace_id,plan,outcome,binding_sha256 FROM legacy_state_import_receipt").all();
  if (!rows.length) return undefined;
  if (rows.length !== 1 || rows[0]!.workspace_id !== workspaceId) throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state receipt belongs to another workspace.");
  const row = rows[0]!;
  try {
    const plan = legacyImportPlanSchema.parse(JSON.parse(String(row.plan)));
    const outcome = legacyImportOutcomeSchema.parse(JSON.parse(String(row.outcome)));
    validateBinding(plan, outcome, workspaceId);
    if (digest({ plan, outcome }) !== row.binding_sha256) throw new Error();
    return { plan, outcome };
  } catch { throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state import receipt failed verification."); }
}

export function readLegacySkillMaintenanceGenesis(database: DatabaseSync, workspaceId: string): LegacySkillMaintenanceGenesis | undefined {
  const binding = readLegacyStateReceipt(database, workspaceId);
  if (!binding) return undefined;
  return { files: binding.plan.statePlan!.entries
    .filter(entry => entry.destination.startsWith("_feedback/") || entry.destination.startsWith("_proposals/"))
    .map(entry => ({ path: entry.destination, size: entry.size, sha256: entry.sha256 })) };
}

export function verifyLegacyRetrievalHistoryBinding(database: DatabaseSync, workspaceId: string): void {
  const binding = readLegacyStateReceipt(database, workspaceId);
  if (!binding) return;
  readProtectedRefresh(database, workspaceId);
  const history = binding.plan.retrievalHistoryPlan;
  if (history) {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_original_learning_genesis'").get();
    const rows = table ? database.prepare("SELECT * FROM legacy_original_learning_genesis WHERE workspace_id=? AND actor_id=?")
      .all(workspaceId, history.actorId) : [];
    if (rows.length !== 1 || rows[0]!.source_sha256 !== history.source.sha256
      || rows[0]!.selected_package_id !== history.selectedPackageId
      || createHash("sha256").update(String(rows[0]!.payload)).digest("hex") !== history.source.stateSha256) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Original learner genesis differs from its immutable import receipt.");
    }
    const packages = history.directories.filter(path => /^solutions\/[a-f0-9]{64}$/.test(path));
    const modelTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_models'").get();
    for (const path of packages) {
      const packageId = path.split("/")[1]!, prefix = `${path}/`;
      const receipt = modelTable ? database.prepare("SELECT * FROM legacy_retrieval_models WHERE package_id=?").get(packageId) : undefined;
      const expected = [
        ...history.files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) })),
        ...history.directories.filter(directory => directory.startsWith(prefix)).map(directory => ({
          path: directory.slice(prefix.length), size: 0,
          sha256: createHash("sha256").update("directory").digest("hex"), directory: true,
        })),
      ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (!receipt || receipt.workspace_id !== workspaceId || receipt.actor_id !== history.actorId
        || receipt.authority_id !== rows[0]!.approval_id
        || JSON.stringify(JSON.parse(String(receipt.inventory_json))) !== JSON.stringify(expected)) {
        throw new CoreError("IMPORT_RECEIPT_INVALID", "Original model package admission differs from its immutable history import receipt.");
      }
    }
    if (history.frozenRelease) {
      const release = history.frozenRelease;
      const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_retrieval_frozen_releases'").get();
      const admitted = table ? database.prepare(`SELECT f.* FROM legacy_retrieval_frozen_releases f
        JOIN legacy_retrieval_model_selections s ON s.receipt_sha256=f.selection_sha256
        WHERE f.workspace_id=? AND f.actor_id=? AND f.authority_id=? AND f.package_id=? AND f.release_id=?
        AND s.workspace_id=f.workspace_id AND s.actor_id=f.actor_id AND s.authority_id=f.authority_id
        AND s.package_id=f.package_id AND s.frozen_release_id=f.release_id`)
        .all(workspaceId, history.actorId, rows[0]!.approval_id, release.packageId, release.releaseId) : [];
      const sourceFile = history.files.find(file => file.path === "serving-release.json");
      if (admitted.length !== 1 || history.selectedPackageId !== release.packageId
        || release.originalModelPath !== join(history.stateRoot, "solutions", release.packageId, "model")
        || sourceFile?.sha256 !== release.sha256
        || createHash("sha256").update(String(admitted[0]!.envelope_json)).digest("hex") !== release.sha256) {
        throw new CoreError("IMPORT_RECEIPT_INVALID", "Original frozen release admission differs from its immutable history import receipt.");
      }
      const envelope = JSON.parse(String(admitted[0]!.envelope_json));
      if (envelope.sha256 !== release.releaseId || envelope.release?.config?.model !== release.originalModelPath) {
        throw new CoreError("IMPORT_RECEIPT_INVALID", "Original frozen release identity or model scope differs from its import receipt.");
      }
    }
  }
}

export async function verifyBoundLegacyStateBytes(database: DatabaseSync, root: string, workspaceId: string): Promise<void> {
  const genesis = readLegacySkillMaintenanceGenesis(database, workspaceId);
  verifyLegacySkillMaintenance(database, root, genesis);
  verifyLegacyRetrievalHistoryBinding(database, workspaceId);
  const binding = readLegacyStateReceipt(database, workspaceId);
  if (!binding) return;
  const identity = binding.plan.statePlan!.subscriptionIdentity;
  const statePlan = binding.plan.statePlan!;
  const protectedSubscriptions = statePlan.protectedSubscriptions;
  const cacheEntries = statePlan.entries.filter(entry => entry.destination.startsWith("subscriptions/cache/"));
  const cacheDirectories = (statePlan.directories ?? []).filter(path => path.startsWith("subscriptions/cache"));
  const cachePaths = new Set(cacheEntries.map(entry => entry.destination));
  if (statePlan.entries.some(entry => entry.destination === "subscriptions/subscriptions.json")) {
    const subscriptionNames = await readdir(join(root, "subscriptions"));
    const expectedNames = [...new Set(statePlan.entries.filter(entry => entry.destination.startsWith("subscriptions/"))
      .map(entry => entry.destination.split("/")[1]!))];
    if (cacheDirectories.length) expectedNames.push("cache");
    if (JSON.stringify([...new Set(expectedNames)].sort()) !== JSON.stringify(subscriptionNames.sort())) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Original subscriber inventory differs from its complete import receipt.");
    }
    if (cacheDirectories.length || cacheEntries.length) {
      try {
        const cache = await inspectImportedSubscriptionCache(join(root, "subscriptions"));
        const pins = cache.files.map(file => ({ destination: `subscriptions/${file.relative}`,
          sha256: file.sha256, size: file.size }));
        const expected = cacheEntries.map(({ destination, sha256, size }) => ({ destination, sha256, size }));
        if (JSON.stringify(pins) !== JSON.stringify(expected)
          || JSON.stringify(cache.directories) !== JSON.stringify(cacheDirectories)) throw new Error();
      } catch {
        throw new CoreError("IMPORT_RECEIPT_INVALID", "Original subscriber cache membership, provenance or complete byte inventory changed.");
      }
    }
  }
  if (protectedSubscriptions) {
    const state = statePlan.entries.find(entry => entry.destination === "subscriptions/subscriptions.json");
    const snapshotEntries = statePlan.entries.filter(entry => entry.destination.startsWith("subscriptions/snapshots/"));
    if (identity || !statePlan.subscriptionRoot || !state || state.projection !== "protected-subscription"
      || !state.sourceSha256 || state.sourceSize === undefined
      || statePlan.entries.some(entry => entry !== state && (entry.sourceSha256 || entry.projection))
      || snapshotEntries.length !== protectedSubscriptions.snapshots.length
      || new Set(protectedSubscriptions.snapshots.map(snapshot => snapshot.name)).size !== snapshotEntries.length
      || protectedSubscriptions.snapshots.some(snapshot => {
        const entry = snapshotEntries.find(item => item.destination === `subscriptions/snapshots/${snapshot.name}`);
        return !entry || entry.sha256 !== snapshot.sha256;
      })) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Protected Subscription inventory binding is invalid.");
    }
    const snapshotDir = join(root, "subscriptions", "snapshots");
    const stat = await lstat(snapshotDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(snapshotDir) !== snapshotDir
      || JSON.stringify((await readdir(snapshotDir)).sort())
        !== JSON.stringify(protectedSubscriptions.snapshots.map(snapshot => snapshot.name).sort())) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Protected Subscription snapshot inventory changed.");
    }
  } else if (identity) {
    const entries = binding.plan.statePlan!.entries;
    const sidecar = entries.find(entry => entry.destination === "subscriptions/native-identity.json");
    const state = entries.find(entry => entry.destination === "subscriptions/subscriptions.json");
    const statistics = entries.find(entry => entry.destination === "subscriptions/subscriber-stats.json");
    if (entries.some(entry => entry.projection) || !sidecar || !state || sidecar.sourceSha256 !== identity.sourceSha256 || state.sourceSha256 !== identity.sourceSha256
      || sidecar.sha256 !== createHash("sha256").update(JSON.stringify(identity)).digest("hex")
      || state.sha256 !== identity.stateSha256 || (statistics?.sha256 ?? null) !== identity.statisticsSha256
      ) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Native subscription identity sidecar or complete metadata binding is invalid.");
    }
  } else if (binding.plan.statePlan!.entries.some(entry => entry.destination === "subscriptions/native-identity.json" || entry.sourceSha256 || entry.projection)) {
    throw new CoreError("IMPORT_RECEIPT_INVALID", "Native subscription identity authority binding was omitted.");
  }
  for (const entry of binding.plan.statePlan!.entries) {
    if (cachePaths.has(entry.destination)) continue;
    if (entry.destination.startsWith("_feedback/") || entry.destination.startsWith("_proposals/")) continue;
    if (!/^agent-snapshot-reads\/\.pkm\/state\/agent-snapshots\/agent_snapshot_[A-Za-z0-9_-]+\.json$/.test(entry.destination)
      && !/^subscriptions\/(?:subscriptions|subscriber-stats|native-identity)\.json$/.test(entry.destination)
      && !(protectedSubscriptions && /^subscriptions\/snapshots\/[A-Za-z0-9_-]+-\d+\.json$/.test(entry.destination))
      && !cachePaths.has(entry.destination)) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state receipt path is invalid.");
    }
    const full = join(root, ...entry.destination.split("/"));
    const maxBytes = entry.destination.startsWith("subscriptions/snapshots/") ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
    if (entry.size > maxBytes || await realpath(full) !== full) throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state path is unsafe.");
    const before = await lstat(full);
    const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!before.isFile() || !opened.isFile() || before.isSymbolicLink() || before.nlink !== 1 || opened.nlink !== 1
        || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== entry.size) {
        throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state bytes changed.");
      }
      const bytes = await handle.readFile();
      const after = await lstat(full);
      if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256
        || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== entry.size || after.isSymbolicLink()) {
        throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state bytes differ from their authenticated import receipt.");
      }
    } finally { await handle.close(); }
  }
  const snapshots = binding.plan.statePlan!.entries.filter(entry => entry.destination.startsWith("agent-snapshot-reads/"));
  if (snapshots.length) {
    const listed = await readAgentSnapshots(root, { operation: "agent.snapshot.list", actorId: "native-import-verification", args: {} } as never) as { total: number };
    if (listed.total !== snapshots.length) throw new CoreError("IMPORT_RECEIPT_INVALID", "Original snapshot inventory differs from its complete import receipt.");
  }
}

export async function verifyNativeSubscriptionIdentity(database: DatabaseSync, root: string, workspaceId: string,
  policy: NativeSubscriptionIdentityPolicy | undefined, purpose: "read" | "backup" | "restore",
  destination: string | null = null, actor?: Readonly<Actor>): Promise<void> {
  const binding = readLegacyStateReceipt(database, workspaceId)?.plan.statePlan?.subscriptionIdentity;
  if (!binding && policy) throw new CoreError("IMPORT_RECEIPT_INVALID", "Native subscription identity requires its exact imported receipt.");
  if (!binding) return;
  await verifyBoundLegacyStateBytes(database, root, workspaceId);
  await authorizeSubscriptionIdentity(binding, root, workspaceId, policy, purpose, destination, actor);
}

export async function dispatchNativeSubscriptionRead(operation: string, args: Record<string, unknown>, actor: Actor,
  context: { database: DatabaseSync; root: string; workspaceId: string; assertOwner(): void },
  policy?: NativeSubscriptionIdentityPolicy): Promise<unknown> {
  context.assertOwner();
  await verifyNativeSubscriptionIdentity(context.database, context.root, context.workspaceId, policy, "read", null, actor);
  context.assertOwner();
  const identity = readLegacyStateReceipt(context.database, context.workspaceId)?.plan.statePlan?.subscriptionIdentity;
  let result: unknown;
  if (operation === "subscription.identity.get") {
    if (!identity) throw new CoreError("NOT_AVAILABLE", "No authoritative native subscription identity was imported.");
    result = { nodeId: identity.nodeId, publicKey: identity.publicKey, secretRef: identity.secretRef,
      authorityId: identity.authorityId, signing: "unavailable", grants: "unavailable",
      broker: "unavailable", provider: "unavailable" };
  } else result = await readSubscriptions(context.root, { operation, args, actorId: actor.id });
  await verifyNativeSubscriptionIdentity(context.database, context.root, context.workspaceId, policy, "read", null, actor);
  context.assertOwner();
  return result;
}

export async function dispatchLegacySnapshot(
  operation: string, args: Record<string, unknown>, actor: Actor,
  context: { root: string; workspaceId: string; receipt(): ReturnType<typeof readLegacyStateReceipt>; assertOwner(): void },
  policy?: NativeLegacySnapshotPolicy,
): Promise<unknown> {
  context.assertOwner();
  if (policy) {
    let allowed = false;
    try { allowed = await policy.authorize(Object.freeze({ ...actor }), context.workspaceId); } catch { /* Deny unavailable policy. */ }
    context.assertOwner();
    if (!allowed) throw new CoreError("ACCESS_DENIED", "Native snapshot policy denied this actor.");
  }
  const binding = context.receipt();
  if (policy && (!binding || binding.outcome.receipt.receiptSha256 !== policy.receiptSha256)) {
    throw new CoreError("IMPORT_RECEIPT_INVALID", "Native snapshot policy requires its exact imported receipt.");
  }
  try {
    const result = operation === "agent.snapshot.read" && binding?.plan.statePlan?.keyEpoch && policy
      ? await readImportedEncryptedSnapshot(binding.plan.statePlan, context.root, { actorId: actor.id, args }, policy.authority)
      : await readAgentSnapshots(context.root, { operation, actorId: actor.id, args } as never);
    context.assertOwner();
    if (binding && JSON.stringify(context.receipt()) !== JSON.stringify(binding)) {
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Original state receipt changed during read.");
    }
    if (policy) {
      let allowed = false;
      try { allowed = await policy.authorize(Object.freeze({ ...actor }), context.workspaceId); } catch { /* Deny revoked policy. */ }
      context.assertOwner();
      if (!allowed) throw new CoreError("ACCESS_DENIED", "Native snapshot policy was revoked during read.");
      if (binding?.plan.statePlan?.keyEpoch !== await policy.authority.epoch()) {
        throw new CoreError("KEY_AUTHORITY_REQUIRED", "Native snapshot key policy changed during read.");
      }
      context.assertOwner();
    }
    if (binding) {
      const revision = (result as { snapshotRevision?: string }).snapshotRevision;
      await readAgentSnapshots(context.root, { operation: "agent.snapshot.list", actorId: actor.id,
        args: revision ? { snapshotRevision: revision } : {} } as never);
      context.assertOwner();
      if (policy && binding.plan.statePlan?.keyEpoch !== await policy.authority.epoch()) {
        throw new CoreError("KEY_AUTHORITY_REQUIRED", "Native snapshot key policy changed during the final identity check.");
      }
      context.assertOwner();
    }
    return result;
  } catch (error) {
    if (error instanceof LegacyStateImportError) throw new CoreError(error.code, error.message);
    throw error;
  }
}
