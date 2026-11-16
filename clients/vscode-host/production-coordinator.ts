import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActiveVscodeMigrationHost, ActiveMigrationIntent } from "../../src/active-vscode-migration-host.js";
import type { LegacyRootAdoptionPrepared } from "../../src/legacy-root-adoption.js";

type Prepared = Pick<LegacyRootAdoptionPrepared, "sourceRoot" | "workspaceId" | "sourceFingerprint" | "planSha256">;
type Receipt = {
  schema: "pkm.active-vscode-migration/v1"; root: string; profile: string; rootPin: string; profilePin: string;
  buildId: string; prepared: Prepared; state: "prepared" | "committed" | "rolled-back"; sha256: string;
};
type IntentReceipt = Omit<Receipt, "schema" | "prepared" | "state"> & {
  schema: "pkm.active-vscode-migration-intent/v1"; planSha256: string;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = async (path: string) => {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Migration directory identity is unavailable.");
  return `${stat.dev}:${stat.ino}`;
};

/** Global-only enablement selects a candidate Root; it grants no migration effects. */
export function productionCoordinatorConfiguration(): { enabled: true; root: string } | undefined {
  const value = vscode.workspace.getConfiguration("pkm.nextHost").inspect<unknown>("productionCoordinator")?.globalValue;
  if (value === undefined || value === false) return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const config = value as Record<string, unknown>, keys = Object.keys(config).sort().join(",");
    if (keys === "enabled" && config.enabled === false) return;
    if (keys === "enabled,root" && config.enabled === true && typeof config.root === "string" && config.root.length)
      return { enabled: true, root: config.root };
  }
  throw new Error("productionCoordinator accepts only {enabled:true,root} or {enabled:false}; profile/build overrides are forbidden.");
}

export function registerProductionCoordinator(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const activationConfiguration = JSON.stringify(productionCoordinatorConfiguration());
  let host: ActiveVscodeMigrationHost | undefined;
  let api: typeof import("../../src/legacy-root-adoption.js");
  let authority: typeof import("../../src/active-vscode-migration-host.js");
  let gate: typeof import("../../src/linux-legacy-writer-quiescence.js");
  let planner: typeof import("../../src/legacy-import.js");
  let hostApi: typeof import("../../src/managed-client-host.js");
  let owner: Awaited<ReturnType<typeof hostApi.startAdoptedRootUnifiedHost>> | undefined;
  let pendingStorage: { close(): Promise<void> } | undefined;
  let retryCleanup: (() => Promise<void>) | undefined;
  let preview: { planSha256: string; privacy: boolean; snapshotAuthorityId?: string; prepared?: Prepared } | undefined;
  let receipt: Receipt | undefined;
  let status = activationConfiguration === undefined ? "disabled" : "boot-closed";
  let disposed = false, busy: Promise<unknown> | undefined;
  const receiptPath = join(context.globalStorageUri.fsPath, "active-v5-migration.json");
  const intentPath = join(context.globalStorageUri.fsPath, "active-v5-migration-intent.json");
  const state = () => ({
    status, enabled: !!productionCoordinatorConfiguration(), profile: context.globalStorageUri.fsPath,
    root: host?.root, buildId: host?.buildId, workspaceId: receipt?.prepared.workspaceId,
    automaticReplay: false, productionSwitch: false, qualification: "experimental-unqualified",
    writerBoundary: host?.writerBoundary ?? "cold-host-unproven",
    installedLegacyTakeover: false,
  });
  const syncDirectory = async () => {
    const file = await open(context.globalStorageUri.fsPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await file.sync(); } finally { await file.close(); }
  };
  const readRecord = async (path: string): Promise<any> => {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 16384n || (before.mode & 0o077n) !== 0n
        || process.getuid === undefined || before.uid !== BigInt(process.getuid())) throw new Error("Unsafe migration receipt.");
      const bytes = await file.readFile(), after = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino
        || BigInt(bytes.length) !== before.size) throw new Error("Migration receipt changed during inspection.");
      const value = JSON.parse(bytes.toString("utf8")), { sha256, ...body } = value;
      if (sha(JSON.stringify(body)) !== sha256
        || value.root !== host!.root || value.profile !== host!.profile
        || value.rootPin !== await identity(host!.root) || value.profilePin !== await identity(host!.profile)
        || !/^[a-f0-9]{64}$/.test(value.buildId))
        throw new Error("Migration receipt does not bind this Root/profile and build.");
      return value;
    } finally { await file.close(); }
  };
  const loadReceipt = async (): Promise<Receipt | undefined> => {
    const value = await readRecord(receiptPath);
    if (!value) return;
    if (value.schema !== "pkm.active-vscode-migration/v1" || !["prepared", "committed", "rolled-back"].includes(value.state)
      || value.prepared?.sourceRoot !== host!.root || !/^[a-f0-9]{64}$/.test(value.prepared.planSha256)
      || !/^[a-f0-9]{64}$/.test(value.prepared.sourceFingerprint)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.prepared.workspaceId))
      throw new Error("Migration receipt has no valid prepared identity.");
    return value;
  };
  const loadIntent = async (): Promise<IntentReceipt | undefined> => {
    const value = await readRecord(intentPath);
    if (!value) return;
    if (value.schema !== "pkm.active-vscode-migration-intent/v1" || !/^[a-f0-9]{64}$/.test(value.planSha256))
      throw new Error("Migration pre-publication intent is malformed.");
    return value;
  };
  const recordBinding = async () => ({
    root: host!.root, profile: host!.profile, rootPin: await identity(host!.root),
    profilePin: await identity(host!.profile), buildId: host!.buildId,
  });
  const writeRecord = async <T extends object>(path: string, body: T): Promise<T & { sha256: string }> => {
    await readRecord(path);
    const value = { ...body, sha256: sha(JSON.stringify(body)) };
    const scratch = join(host!.profile, `.active-v5-migration-${randomUUID()}.json`);
    const file = await open(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    try { await rename(scratch, path); await syncDirectory(); }
    finally { await unlink(scratch).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return value;
  };
  const persist = async (prepared: Prepared, phase: Receipt["state"]) => {
    await loadReceipt();
    receipt = await writeRecord(receiptPath, {
      schema: "pkm.active-vscode-migration/v1" as const, ...await recordBinding(), prepared: {
        sourceRoot: prepared.sourceRoot, workspaceId: prepared.workspaceId,
        sourceFingerprint: prepared.sourceFingerprint, planSha256: prepared.planSha256,
      }, state: phase,
    });
  };
  const ensure = async () => {
    if (disposed) throw new Error("The coordinator activation was disposed.");
    if (!productionCoordinatorConfiguration()) throw new Error("The production coordinator is disabled.");
    if (JSON.stringify(productionCoordinatorConfiguration()) !== activationConfiguration)
      throw new Error("Coordinator enablement changed after activation. Reload before selecting a same-root owner.");
    if (host) {
      if (host.signal.aborted) throw new Error("The coordinator binding was revoked. Reload before retrying; no replay was performed.");
      return;
    }
    const require = createRequire(join(context.extensionPath, "package.json"));
    const verified = require(join(context.extensionPath, "next-runtime/server/legacy/dist/runtime/next-payload-verifier.js"))
      .verifyNextPayload(context.extensionPath);
    const load = (name: string) => import(pathToFileURL(join(verified.root, "server/dist", `${name}.js`)).href);
    authority = await load("active-vscode-migration-host");
    host = authority.activateActiveVscodeMigrationHost(context);
    [api, gate, planner, hostApi] = await Promise.all([
      load("legacy-root-adoption"), load("linux-legacy-writer-quiescence"), load("legacy-import"), load("managed-client-host"),
    ]);
    receipt = await loadReceipt();
    status = receipt && receipt.state !== "rolled-back" ? "boot-closed" : "ready";
  };
  const options = async (action: ActiveMigrationIntent["action"], selected: NonNullable<typeof preview>) => {
    authority.assertActiveVscodeMigrationWriterBoundary(host!);
    await host!.drain();
    let snapshotAdmission;
    if (selected.privacy) {
      const snapshot = await host!.requestSnapshotAuthority(selected.snapshotAuthorityId);
      if (!snapshot) return;
      snapshotAdmission = { authorityId: snapshot.authorityId, authorize: snapshot.authorize, allowedTools: [...snapshot.allowedTools] };
    }
    const grant = await host!.requestMigrationApproval({
      action, sourceRoot: host!.root, planSha256: selected.planSha256,
      ...(selected.prepared ? { prepared: selected.prepared } : {}),
    });
    if (!grant) return;
    const activeVscodeMigration = { host: host!, grant };
    const experimentalManagedSnapshotHost = gate.bindLinuxActiveVscodeMigrationHost({ ...activeVscodeMigration, snapshotAdmission });
    return { activeVscodeMigration, experimentalManagedSnapshotHost, snapshotAdmission };
  };
  const closeOwned = async () => {
    if (retryCleanup) { await retryCleanup(); retryCleanup = undefined; }
    if (owner) { await owner.managed.close(); owner = undefined; pendingStorage = undefined; }
    if (pendingStorage) { await pendingStorage.close(); pendingStorage = undefined; }
  };
  const guarded = (operation: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    if (busy) throw new Error("An active migration lifecycle operation is already running.");
    const task = (async () => {
      try { await ensure(); return await operation(...args); }
      catch (error) {
        status = "action-required"; preview = undefined;
        output.appendLine(`Active migration stopped: ${error instanceof Error ? error.message : "unknown failure"}. No automatic replay.`);
        throw error;
      }
    })();
    busy = task;
    try { return await task; } finally { busy = undefined; }
  };
  const previewOperation = async () => {
    if (owner || pendingStorage || retryCleanup) throw new Error("Close the current owner before inspecting a migration transition.");
    const intent = await loadIntent();
    if (receipt && receipt.state !== "rolled-back" || intent) {
      const pinned = receipt && receipt.state !== "rolled-back" ? receipt.prepared : undefined;
      const planSha256 = pinned?.planSha256 ?? intent!.planSha256;
      const recovery = await api.inspectLegacyRootAdoptionRecoveryExperimental(host!.root, { planSha256, prepared: pinned });
      if (recovery) {
        preview = { planSha256, privacy: recovery.privacy, snapshotAuthorityId: recovery.snapshotAuthorityId, prepared: recovery.prepared };
      } else {
        if (pinned) throw new Error("The independently retained prepared recovery journal is unavailable.");
        const plan = await host!.inspect(() => planner.planLegacyImport(host!.root, {}, { inPlaceAdoption: true }));
        if (!plan.ready || plan.planSha256 !== planSha256) throw new Error("The pending migration intent no longer matches the original Root.");
        preview = { planSha256, privacy: !!plan.inPlacePkmPrivacySha256 };
      }
    } else {
      const inspect = () => planner.planLegacyImport(host!.root, {}, { inPlaceAdoption: true });
      const plan = await host!.inspect(inspect);
      if (!plan.ready || plan.blockers.length) {
        output.appendLine(JSON.stringify(plan.blockers));
        throw new Error("The complete legacy Root is not qualified for this bounded same-root transition.");
      }
      preview = { planSha256: plan.planSha256, privacy: !!plan.inPlacePkmPrivacySha256 };
    }
    status = "previewed";
    output.appendLine(JSON.stringify({ root: host!.root, profile: host!.profile, buildId: host!.buildId, ...preview }));
    return { ...state(), ...preview };
  };
  const subscriptions = [
    vscode.commands.registerCommand("pkm.nextHost.productionState", state),
    vscode.commands.registerCommand("pkm.nextHost.productionPreview", guarded(previewOperation)),
    vscode.commands.registerCommand("pkm.nextHost.productionTransition", guarded(async () => {
      const selected = preview; preview = undefined;
      if (!selected || owner || pendingStorage || retryCleanup) throw new Error("A fresh preview and closed owner are required.");
      const approved = await options(selected.prepared ? "resume" : "adopt", selected);
      if (!approved) { status = "drained"; return state(); }
      let prepared = selected.prepared;
      if (!prepared) {
        await writeRecord(intentPath, { schema: "pkm.active-vscode-migration-intent/v1",
          ...await recordBinding(), planSha256: selected.planSha256 });
        prepared = await api.prepareLegacyRootAdoptionExperimental(host!.root, approved);
        await persist(prepared, "prepared"); status = "prepared";
        await unlink(intentPath); await syncDirectory();
      } else if (!receipt || receipt.state === "rolled-back") {
        await persist(prepared, "prepared");
      }
      await unlink(intentPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      const adoption = await api.resumeLegacyRootAdoptionExperimental(host!.root, {
        ...approved, expectedPrepared: prepared, experimentalPostCommitRollbackBaseline: true,
      });
      pendingStorage = adoption.storage;
      await persist(prepared, "committed");
      const configPath = join(host!.profile, "active-v5-owner.json"), endpoint = "http://127.0.0.1:9/v1";
      try { await lstat(configPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const file = await open(configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await file.writeFile(JSON.stringify({
            schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
            secretRef: "secret:disabled/provider", model: "disabled", contextWindow: 16384, maxOutputTokens: 4096,
            outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.list"],
          }));
          await file.sync();
        } finally { await file.close(); }
        await syncDirectory();
      }
      try {
        owner = await hostApi.startAdoptedRootUnifiedHost({
          optIn: true, dataPath: host!.root, configPath, expectedWorkspaceId: adoption.workspaceId,
          policy: { authorizedConfigPath: configPath, allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint],
            allowedModels: ["disabled"], allowedTools: ["knowledge.document.list"], allowInsecureLoopback: true },
          resolveSecret: async () => undefined,
        }, adoption);
      } catch (error) {
        if (error && typeof error === "object" && "retryCleanup" in error && typeof error.retryCleanup === "function")
          retryCleanup = error.retryCleanup as () => Promise<void>;
        throw error;
      }
      status = "connected";
      return state();
    })),
    vscode.commands.registerCommand("pkm.nextHost.productionRead", guarded(async (request: unknown) => {
      if (!owner || !request || typeof request !== "object" || Array.isArray(request)) throw new Error("A connected owner and read request are required.");
      const { operation, input } = request as { operation?: unknown; input?: unknown };
      if (operation !== "list" && operation !== "get" || !input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Only explicit list/get document reads are exposed by this bounded coordinator.");
      return owner.managed.invoke(operation, input as Record<string, unknown>);
    })),
    vscode.commands.registerCommand("pkm.nextHost.productionRollback", guarded(async () => {
      if (!receipt || receipt.state === "rolled-back") throw new Error("There is no independently pinned migration receipt.");
      authority.assertActiveVscodeMigrationWriterBoundary(host!);
      await closeOwned();
      const selected = preview ?? await (async () => { await previewOperation(); return preview!; })();
      preview = undefined;
      const approved = await options(receipt.state === "prepared" ? "rollback-prepared" : "rollback-committed", selected);
      if (!approved) return state();
      const result = receipt.state === "prepared"
        ? await api.rollbackPreparedLegacyRootAdoptionExperimental(host!.root, { ...approved, expectedPrepared: receipt.prepared })
        : await api.rollbackCommittedLegacyRootAdoptionExperimental(host!.root, {
          ...approved, expectedPrepared: receipt.prepared, workspaceId: receipt.prepared.workspaceId,
        });
      await persist(receipt.prepared, "rolled-back");
      status = "rolled-back";
      return result;
    })),
    vscode.commands.registerCommand("pkm.nextHost.productionDisconnect", guarded(async () => {
      await closeOwned(); status = "disconnected"; return state();
    })),
  ];
  const close = async () => {
    disposed = true; host?.dispose();
    await busy?.catch(() => undefined);
    await closeOwned();
    status = "closed";
  };
  subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (host && (event.affectsConfiguration("pkm.nextHost") || event.affectsConfiguration("personalKnowledge")))
      void close().catch(() => { status = "action-required"; });
  }), { dispose() { void close().catch(() => { status = "action-required"; }); } });
  return { subscriptions, close };
}
