import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import type { ActionRuntime } from "./action-runtime.js";
import { originalDigest } from "./domain/action-compiler-validation.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest } from "./original-mcp-native-host.js";
import { readNestedActionPlan } from "./action-program-nested-artifacts.js";
import { actionGcRecord, readActionGcRecords } from "./action-artifact-gc-records.js";
import { readNativeManagedActionArtifacts, collectNativeManagedActionPayload,
  nativeActionManagedBlobDdl, verifyNativeActionManagedBlobs, verifyLegacyActionPackagePublications } from "./legacy-action-artifacts.js";
import { readOriginalMcpJournal, type OriginalMcpJournal } from "./original-mcp-root-custody.js";
import { verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";

const name = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/);
const bindings = z.array(z.strictObject({ host: name, vc: name, account: name })).min(1).max(100);
export const cosmosRecord = z.strictObject({
  schema: z.literal("pkm.native-action-cosmos-config/v1"), workspaceId: z.string(), actorId: z.literal("mcp:external"),
  nativeHostReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().uuid(),
  previousSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bindings,
});
function readCosmos(database: DatabaseSync, workspaceId: string) {
  let latest: z.infer<typeof cosmosRecord> | undefined, previousSha256: string | null = null;
  const records: z.infer<typeof cosmosRecord>[] = [];
  for (const row of database.prepare(
    "SELECT actor_id,operation_id,fingerprint,result FROM action_runtime_receipts WHERE json_extract(result,'$.schema')='pkm.native-action-cosmos-config/v1' ORDER BY rowid").all()) {
    const record = cosmosRecord.parse(JSON.parse(String(row.result)));
    if (record.actorId !== row.actor_id || record.workspaceId !== workspaceId || record.operationId !== row.operation_id
      || record.previousSha256 !== previousSha256 || originalDigest(record) !== row.fingerprint)
      throw new CoreError("RECOVERY_CONFLICT", "Private native Cosmos configuration history changed.");
    if (records.length >= 4096) throw new CoreError("RESOURCE_LIMIT", "Private native Cosmos configuration history exceeds its bound.");
    if (new Set(record.bindings.map(item => `${item.host}/${item.vc}`)).size !== record.bindings.length)
      throw new CoreError("RECOVERY_CONFLICT", "Private native Cosmos configuration contains duplicate bindings.");
    records.push(record);
    latest = record; previousSha256 = String(row.fingerprint);
  }
  return { latest, previousSha256, records };
}
export function readNativePrivateCosmosConfiguration(storage: Storage, host: OriginalMcpNativeHost) {
    storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    const journal = readOriginalMcpJournal(storage.workspaceRoot());
    if (!journal || journal.workspaceId !== host.receipt.workspaceId)
      throw new CoreError("ACCESS_DENIED", "Private Cosmos configuration requires its owning custody.");
    const database = storage.connectNative();
    try {
      const state = readCosmos(database, journal.workspaceId);
      for (const record of state.records)
        verifyOriginalMcpNativeHostReceiptDatabase(database, journal, record.nativeHostReceiptSha256);
      if (!state.latest) throw new CoreError("NOT_AVAILABLE", "Configure the exact private Cosmos host/VC/account first.");
      return { bindings: state.latest.bindings, sha256: state.previousSha256!, version: state.records.length };
    } finally { database.close(); }
  }
export function verifyOriginalMcpActionMaintenanceMetadata(database: DatabaseSync, journal: OriginalMcpJournal) {
  const gc = readActionGcRecords(database, journal.workspaceId), cosmos = readCosmos(database, journal.workspaceId);
  for (const record of [...gc, ...cosmos.records])
    verifyOriginalMcpNativeHostReceiptDatabase(database, journal, record.nativeHostReceiptSha256);
}
export function readNativePrivateCosmosBinding(storage: Storage, host: OriginalMcpNativeHost, hostName: string, vc: string) {
  storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  if (!name.safeParse(hostName).success || !name.safeParse(vc).success)
    throw new CoreError("INVALID_ARGUMENT", "Private Cosmos host and VC must be exact lowercase names.");
  const journal = readOriginalMcpJournal(storage.workspaceRoot());
  if (!journal || journal.workspaceId !== host.receipt.workspaceId)
    throw new CoreError("ACCESS_DENIED", "Private Cosmos bindings require their owning custody.");
  const database = storage.connectNative();
  try {
    const history = readCosmos(database, journal.workspaceId);
    for (const record of history.records)
      verifyOriginalMcpNativeHostReceiptDatabase(database, journal, record.nativeHostReceiptSha256);
    assertOriginalMcpNativeHost(host, storage);
    const binding = history.latest?.bindings.find(item => item.host === hostName && item.vc === vc);
    return binding ? Object.freeze({ ...binding }) : undefined;
  } finally { database.close(); }
}
function snapshots(database: DatabaseSync, engine: ActionRuntime) {
  const rows = database.prepare("SELECT actor_id,run_id,version FROM action_runtime_runs").all();
  if (rows.length > 4096) throw new CoreError("RESOURCE_LIMIT", "Action maintenance exceeds its run inventory bound.");
  return rows.map(row => {
    const value = engine.maintenanceSnapshot(String(row.actor_id), String(row.run_id));
    if (value.version !== row.version) throw new CoreError("RECOVERY_CONFLICT", "Action maintenance run version changed.");
    return { ...value, actorId: String(row.actor_id) };
  });
}
function references(value: unknown): Set<string> {
  const result = new Set<string>(), pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (key === "artifact_id" && typeof child === "string") result.add(child);
        else pending.push(child);
      }
    }
  }
  return result;
}
export async function maintainOriginalMcpAction(storage: Storage, engine: ActionRuntime, host: OriginalMcpNativeHost,
  actor: Actor, tool: "action_cosmos_configure" | "action_run_gc", args: Record<string, unknown>, signal?: AbortSignal) {
  const check = () => {
    signal?.throwIfAborted(); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    if (actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker || actor.recipeProtocol)
      throw new CoreError("ACCESS_DENIED", "Native Action maintenance requires the fixed writable external actor.");
  };
  check();
  if (!originalMcpPublicRequestMatches(storage, host, { operation: `mcp.tool.${tool}`, version: 1, tool,
    readOnly: false, arguments: args, argumentsDigest: originalMcpRequestDigest(args) }))
    throw new CoreError("ACCESS_DENIED", "Exact fresh operator approval is required for native Action maintenance.");
  return storage.withWorkspaceExclusive(() => {
    check();
    const database = storage.connectNative();
    try {
      const workspaceId = host.receipt.workspaceId, inventory = snapshots(database, engine);
      if (Number(database.prepare("SELECT count(*) AS n FROM action_runtime_receipts WHERE json_extract(result,'$.schema') IN (?,?)")
        .get("pkm.native-action-gc/v1", "pkm.native-action-cosmos-config/v1")?.n) >= 4096)
        throw new CoreError("RESOURCE_LIMIT", "Native Action maintenance history exceeds its bounded capacity.");
      if (tool === "action_cosmos_configure") {
        const parsed = bindings.safeParse(args.bindings);
        if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Provide 1-100 exact lowercase private host/VC/account bindings without credentials.");
        const identities = new Set(parsed.data.map(item => `${item.host}/${item.vc}`));
        if (identities.size !== parsed.data.length) throw new CoreError("INVALID_ARGUMENT", "Duplicate private Cosmos binding.");
        const ordered = parsed.data.sort((a, b) => `${a.host}/${a.vc}`.localeCompare(`${b.host}/${b.vc}`));
        const history = readCosmos(database, workspaceId);
        if (history.latest && originalDigest(history.latest.bindings) !== originalDigest(ordered)
          && (existsSync(join(storage.workspaceRoot(), ".pkm/state/actions/policy.json"))
            || inventory.some(run => ["ready", "running", "waiting", "cancelling", "unknown"].includes(run.state))))
          throw new CoreError("ACCESS_DENIED", "Revoke/reconcile live operator Action path authority before changing private Cosmos bindings.");
        const record = cosmosRecord.parse({ schema: "pkm.native-action-cosmos-config/v1", workspaceId, actorId: actor.id,
          nativeHostReceiptSha256: host.receipt.receiptSha256, operationId: randomUUID(),
          previousSha256: history.previousSha256, bindings: ordered });
        database.exec("BEGIN IMMEDIATE");
        check();
        database.prepare("INSERT INTO action_runtime_receipts VALUES(?,?,?,?)")
          .run(actor.id, record.operationId, originalDigest(record), JSON.stringify(record));
        database.exec("COMMIT");
        return { ok: true, private: true, bindings_count: parsed.data.length };
      }
      const run = inventory.find(item => item.actorId === actor.id && item.runId === args.run_id);
      if (!run) throw new CoreError("NOT_FOUND", "Owned Action Run was not found.");
      if (readNestedActionPlan(database, actor.id, run.runId))
        return { ok: false, gc_state: "deferred", reason: "Only the top-level owner can collect artifacts." };
      if (run.state === "unknown") return { ok: false, gc_state: "deferred", reason: "Reconcile uncertain effects before collecting their evidence." };
      const roots = inventory.map(item => ({ ...item, rootRunId: readNestedActionPlan(database, item.actorId, item.runId)?.parentRunId ?? item.runId }));
      if (roots.some(item => item.actorId === actor.id && item.rootRunId === run.runId
        && ["ready", "running", "waiting", "cancelling", "unknown"].includes(item.state)))
        return { ok: false, gc_state: "deferred", reason: "An owning run is still active." };
      const releaseOutputs = args.release_outputs === true;
      if (run.state !== "succeeded" && !releaseOutputs && Date.now() - run.completedAt < 3_600_000)
        return { ok: true, gc_state: "retained", reason: "Failure diagnostics retained for one hour." };
      const prior = readActionGcRecords(database, workspaceId);
      const artifacts = readNativeManagedActionArtifacts(database, workspaceId).filter(item => item.actorId === actor.id
        && (item.rootRunId ?? item.ownerRunId) === run.runId);
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_action_artifact_intent'").get()
        && database.prepare("SELECT 1 FROM legacy_action_artifact_intent LIMIT 1").get())
        return { ok: false, gc_state: "deferred", reason: "Reconcile uncertain artifact publication before collecting its evidence." };
      if ([...verifyLegacyActionPackagePublications(database, workspaceId).values()].some(history => history.at(-1)?.stage !== "written"))
        return { ok: false, gc_state: "deferred", reason: "Reconcile uncertain package publication before collecting its evidence." };
      const retained = new Set<string>();
      for (const item of roots) {
        const outputReleased = prior.some(record => record.actorId === item.actorId && record.runId === item.rootRunId && record.releaseOutputs);
        const currentRoot = item.actorId === actor.id && item.rootRunId === run.runId;
        const live = ["ready", "running", "waiting", "cancelling", "unknown"].includes(item.state);
        if (currentRoot) {
          if (!releaseOutputs && !outputReleased && item.runId === run.runId)
            for (const id of references(item.outputs)) retained.add(id);
        } else {
          if (live || item.state !== "succeeded" && Date.now() - item.completedAt < 3_600_000)
            for (const id of references(item.inputs)) retained.add(id);
          if (live || !outputReleased)
            for (const id of references(item.outputs)) retained.add(id);
        }
      }
      const released = new Set(prior.flatMap(record => record.releasedArtifacts.map(item => item.artifactId)));
      const candidates = artifacts.filter(item => !retained.has(item.artifactId) && !released.has(item.artifactId));
      const historicalPayloads = artifacts.filter(item => "bytes" in item
        && (released.has(item.artifactId) || candidates.includes(item))).map(item => item.artifactId);
      const record = actionGcRecord.parse({ schema: "pkm.native-action-gc/v1", workspaceId, actorId: actor.id, runId: run.runId,
        definitionDigest: run.definitionDigest, version: run.version, releaseOutputs,
        nativeHostReceiptSha256: host.receipt.receiptSha256, operationId: randomUUID(),
        gcState: artifacts.some(item => retained.has(item.artifactId)) || historicalPayloads.length ? "retained" : "completed",
        releasedArtifacts: candidates.map(item => ({ artifactId: item.artifactId, digest: item.digest,
          ownerRunId: item.ownerRunId, rootRunId: run.runId })) });
      database.exec("BEGIN IMMEDIATE");
      check();
      if (!verifyNativeActionManagedBlobs(database, workspaceId)) database.exec(nativeActionManagedBlobDdl);
      database.prepare("INSERT INTO action_runtime_receipts VALUES(?,?,?,?)")
        .run(actor.id, record.operationId, originalDigest(record), JSON.stringify(record));
      for (const item of candidates) { check(); collectNativeManagedActionPayload(database, workspaceId, item.artifactId); }
      check(); database.exec("COMMIT");
      return { ok: true, gc_state: record.gcState, deleted: candidates.filter(item => "storage" in item).map(item => item.artifactId),
        released: candidates.map(item => item.artifactId), retained_historical_payloads: historicalPayloads };
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally { database.close(); }
  });
}
