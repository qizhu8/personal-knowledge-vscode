import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CoreError } from "./contracts.js";

type NativeContext = {
  extensionPath: string; extension: { id: string }; globalStorageUri: { fsPath: string };
  subscriptions: { dispose(): void }[];
};
type PreparedPin = { sourceRoot: string; workspaceId: string; sourceFingerprint: string; planSha256: string };
export type ActiveMigrationIntent = {
  action: "adopt" | "resume" | "rollback-prepared" | "rollback-committed";
  sourceRoot: string; planSha256: string; prepared?: PreparedPin;
};
type SnapshotAuthority = {
  authorityId: string; allowedTools: readonly "knowledge_snapshot_status"[]; authorize: (binding: unknown) => boolean;
  signal: AbortSignal; dispose(): void;
};
type Admission = {
  run<T>(kind: "ui", work: () => T | Promise<T>): Promise<T>;
  drain(): Promise<void>; assertDrainedRoot(root: string): void;
};
export interface ActiveVscodeMigrationHost {
  readonly root: string;
  readonly profile: string;
  readonly buildId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly writerBoundary: "cold-host-unproven";
  assertCurrent(binding: { root: string; profile: string; sessionId: string }): void;
  inspect<T>(work: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  requestSnapshotAuthority(recoveryAuthorityId?: string): Promise<SnapshotAuthority | undefined>;
  requestMigrationApproval(intent: ActiveMigrationIntent): Promise<ActiveVscodeMigrationGrant | undefined>;
  dispose(): void;
}
export interface ActiveVscodeMigrationGrant { readonly kind: "pkm.active-vscode-migration-grant/v1"; }
type HostBinding = {
  context: NativeContext; check(): void; assertDrained(): void;
  snapshot?: SnapshotAuthority;
};
const hosts = new WeakMap<ActiveVscodeMigrationHost, HostBinding>();
const grants = new WeakMap<ActiveVscodeMigrationGrant, {
  host: ActiveVscodeMigrationHost; intent: ActiveMigrationIntent; expiresAt: number; prepared?: PreparedPin;
}>();
const contexts = new WeakMap<object, ActiveVscodeMigrationHost>();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const denied = (message: string): never => { throw new CoreError("ACTIVE_MIGRATION_AUTHORITY_REQUIRED", message); };
const pin = (directory: string) => {
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory)
    return denied("Migration directories must be canonical absolute paths.");
  let current = dirname(directory);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) return denied("Migration directory parents must not be links.");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) return denied("Migration directory is unavailable.");
  return `${stat.dev}:${stat.ino}`;
};
const within = (a: string, b: string) => {
  const path = relative(a, b);
  return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const samePrepared = (a: PreparedPin, b: PreparedPin) => a.sourceRoot === b.sourceRoot
  && a.workspaceId === b.workspaceId && a.sourceFingerprint === b.sourceFingerprint && a.planSha256 === b.planSha256;

/** Loaded from the verified payload by the actual VS Code activation, never bundled into its caller. */
export function activateActiveVscodeMigrationHost(context: NativeContext): ActiveVscodeMigrationHost {
  if (process.platform !== "linux") return denied("Active migration writer inventory is qualified only on Linux.");
  if (!context || contexts.has(context)) return denied("This activation already owns a migration host.");
  const require = createRequire(import.meta.url);
  let vscode;
  try { vscode = require("vscode"); }
  catch { return denied("The actual native VS Code module is unavailable; caller-supplied modules are not accepted."); }
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const extension = vscode.extensions.getExtension(context.extension?.id);
  if (!extension?.isActive || context.extensionPath !== extensionPath
    || extension.extensionPath !== extensionPath || !vscode.workspace.isTrusted)
    return denied("A live trusted installed VS Code extension activation is required.");
  const activation = extension.exports;
  if (typeof activation?.assertActiveMigrationContext !== "function")
    return denied("The installed entrypoint does not own an active migration context.");
  activation.assertActiveMigrationContext(context);
  const legacyIdentity = (manifest: { publisher?: string; name?: string } | undefined) =>
    `${manifest?.publisher}.${manifest?.name}`.toLowerCase() === "uone.personal-knowledge";
  const assertNativeInventory = () => {
    const inventory = vscode.extensions.all;
    const current = vscode.extensions.getExtension(context.extension.id);
    if (!Array.isArray(inventory) || !current?.isActive || current.exports !== activation
      || current.extensionPath !== extensionPath
      || !inventory.some(item => item.id === current.id && item.extensionPath === extensionPath))
      return denied("The native installed extension inventory or active entrypoint is unavailable.");
    for (const item of inventory) {
      if (typeof item?.id !== "string" || typeof item.extensionPath !== "string")
        return denied("The native installed extension inventory is incomplete.");
      if (item.id.toLowerCase() === "uone.personal-knowledge" || legacyIdentity(item.packageJSON))
        return denied("The native inventory includes Uone.personal-knowledge, even if inactive. Remove/disable it and start a cold host; its work has not been drained.");
      if (typeof item.packageJSON?.main !== "string") continue;
      let entry = resolve(item.extensionPath, item.packageJSON.main);
      try { entry = realpathSync(entry); } catch { /* Missing entrypoints do not certify a cold host. */ }
      if (!entry.endsWith(`${sep}dist${sep}extension.js`)) continue;
      let manifest;
      try {
        const path = join(dirname(dirname(entry)), "package.json");
        if (lstatSync(path).size > 1024 * 1024) continue;
        manifest = JSON.parse(readFileSync(path, "utf8"));
      } catch { continue; }
      if (legacyIdentity(manifest))
        return denied("A native extension entrypoint resolves into an installed legacy PKM build. Retained payload utility modules are not old extension entrypoints.");
    }
  };
  if (typeof vscode.extensions.onDidChange !== "function")
    return denied("Native extension inventory change observation is required.");
  assertNativeInventory();
  const settings = () => vscode.workspace.getConfiguration("pkm.nextHost").inspect("productionCoordinator")?.globalValue;
  const configuration = settings();
  if (!configuration || configuration.enabled !== true || typeof configuration.root !== "string"
    || Object.keys(configuration).sort().join(",") !== "enabled,root")
    return denied("Explicit machine-level enablement and Root are required; unsupported fields are forbidden.");
  const root = configuration.root as string, profile = context.globalStorageUri.fsPath;
  const rootPin = pin(root);
  if (within(root, profile) || within(profile, root)) return denied("Root and host profile must be disjoint.");
  pin(dirname(profile));
  try { mkdirSync(profile, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const profilePin = pin(profile);
  const retained = join(extensionPath, "next-runtime/server/legacy/dist");
  const verifier = require(join(retained, "runtime/next-payload-verifier.js"));
  const initialPayload = verifier.verifyNextPayload(extensionPath);
  const buildId = initialPayload.buildId as string;
  const verifyBuild = () => {
    const payload = verifier.verifyNextPayload(extensionPath);
    if (payload.buildId !== buildId
      || resolve(payload.root, "server/dist") !== dirname(fileURLToPath(import.meta.url)))
      return denied("The active migration payload is not the independently selected build.");
  };
  verifyBuild();
  const manifestPath = join(extensionPath, "next-runtime/manifest.json");
  const manifestHash = hash(readFileSync(manifestPath));
  const entryPath = join(extensionPath, "dist/extension.cjs"), entryHash = hash(readFileSync(entryPath));
  const originalSettings = JSON.stringify(configuration);
  const filestore = require(join(retained, "knowledge/filestore.js"));
  const { HostWriterAdmission } = require(join(retained, "runtime/host-writer-admission.js"));
  const { createManagedHostChildRegistry } = require(join(retained, "runtime/managed-host-child-registry.js"));
  const snapshot = require(join(retained, "runtime/legacy-snapshot-vscode-authority.js"));
  filestore.setStorePath(root);
  const admission: Admission = new HostWriterAdmission(root, filestore.getStorePath);
  const children = createManagedHostChildRegistry(root, admission);
  const lifetime = new AbortController(), sessionId = randomUUID();
  let drained = false, draining: Promise<void> | undefined;
  const subscriptions: { dispose(): void }[] = [];
  let host!: ActiveVscodeMigrationHost;
  const dispose = () => {
    lifetime.abort();
    hosts.get(host)?.snapshot?.dispose();
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
  };
  const check = () => {
    try {
      if (lifetime.signal.aborted) return denied("The migration activation was revoked; a cold host is required.");
      activation.assertActiveMigrationContext(context);
      assertNativeInventory();
      if (!extension.isActive || extension.exports !== activation
        || context.extensionPath !== extensionPath || context.globalStorageUri.fsPath !== profile
        || !vscode.workspace.isTrusted || JSON.stringify(settings()) !== originalSettings
        || pin(root) !== rootPin || pin(profile) !== profilePin || filestore.getStorePath() !== root
        || hash(readFileSync(manifestPath)) !== manifestHash || hash(readFileSync(entryPath)) !== entryHash)
        return denied("Migration activation, Root, profile, trust or installed build changed.");
    } catch (error) { dispose(); throw error; }
  };
  const assertDrained = () => {
    check();
    if (!drained) return denied("The actual active host resources have not completed their drain.");
    admission.assertDrainedRoot(root);
  };
  host = Object.freeze({
    root, profile, buildId, sessionId, signal: lifetime.signal, writerBoundary: "cold-host-unproven" as const,
    assertCurrent(binding: { root: string; profile: string; sessionId: string }) {
      if (binding.root !== root || binding.profile !== profile || binding.sessionId !== sessionId)
        return denied("Migration host binding does not match.");
      assertDrained();
    },
    inspect<T>(work: () => Promise<T>): Promise<T> {
      check();
      if (draining || drained) return Promise.reject(new Error("Migration host admission is closed."));
      return admission.run("ui", work);
    },
    drain() {
      check();
      return draining ??= (async () => {
        const results = await Promise.allSettled([admission.drain(), children.close()]);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        check(); drained = true; assertDrained();
      })();
    },
    async requestSnapshotAuthority(recoveryAuthorityId?: string) {
      assertDrained();
      const authority: SnapshotAuthority | undefined = await snapshot.requestLegacySnapshotVscodeAuthority(context, {
        host, allowedTools: ["knowledge_snapshot_status"], ...(recoveryAuthorityId ? { recoveryAuthorityId } : {}),
      });
      assertDrained();
      if (authority) {
        snapshot.assertLegacySnapshotVscodeAuthority(authority, context, host);
        hosts.get(host)!.snapshot?.dispose();
        hosts.get(host)!.snapshot = authority;
      }
      return authority;
    },
    async requestMigrationApproval(intent: ActiveMigrationIntent) {
      assertDrained(); verifyBuild();
      const approved = structuredClone(intent);
      if (!["adopt", "resume", "rollback-prepared", "rollback-committed"].includes(approved.action)
        || approved.sourceRoot !== root || !digest.test(approved.planSha256)
        || approved.action !== "adopt" && !approved.prepared
        || approved.prepared && (approved.prepared.sourceRoot !== root
          || approved.prepared.planSha256 !== approved.planSha256 || !uuid.test(approved.prepared.workspaceId)
          || !digest.test(approved.prepared.sourceFingerprint)))
        return denied("An exact inspected plan and prepared recovery identity are required.");
      const label = "Approve exact same-root transition";
      const answer = await vscode.window.showWarningMessage("Authorize this exact same-root migration operation?", {
        modal: true,
        detail: `Operation: ${approved.action}\nRoot: ${root}\nProfile: ${profile}\nBuild: ${buildId}\n`
          + `Plan SHA-256: ${approved.planSha256}\nWorkspace: ${approved.prepared?.workspaceId ?? "new identity assigned by Core"}\n\n`
          + "This is separate from snapshot-status consent. It authorizes only this bounded operation for two minutes. "
          + "It is not proof of legacy drain or a cold host. Writer qualification remains blocked. "
          + "No production service registration, profile switch or effect replay is authorized.",
      }, label);
      assertDrained(); verifyBuild();
      if (answer !== label) return undefined;
      const grant = Object.freeze({ kind: "pkm.active-vscode-migration-grant/v1" as const });
      grants.set(grant, { host, intent: approved, expiresAt: Date.now() + 120_000,
        ...(approved.prepared ? { prepared: approved.prepared } : {}) });
      return grant;
    },
    dispose,
  });
  hosts.set(host, { context, check, assertDrained });
  contexts.set(context, host);
  subscriptions.push(vscode.extensions.onDidChange(() => {
    try { check(); } catch { /* Revocation is permanent, including after legacy removal. */ }
  }), vscode.workspace.onDidChangeWorkspaceFolders(dispose),
    vscode.workspace.onDidChangeConfiguration((event: { affectsConfiguration(section: string): boolean }) => {
      if (event.affectsConfiguration("pkm.nextHost") || event.affectsConfiguration("personalKnowledge")) dispose();
    }));
  context.subscriptions.push({ dispose });
  check();
  return host;
}

export function assertActiveVscodeMigrationHost(host: ActiveVscodeMigrationHost): void {
  const binding = hosts.get(host);
  if (!binding) return denied("An authentic same-process active host is required.");
  binding.assertDrained();
}

export function assertActiveVscodeMigrationWriterBoundary(host: ActiveVscodeMigrationHost): void {
  const binding = hosts.get(host);
  if (!binding) return denied("An authentic same-process active host is required.");
  binding.check();
  throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE",
    "The active host cold-host boundary is unproven. Native inventory cannot exclude previously loaded/uninstalled legacy code. "
    + "This host's planning drain and empty child registry do not justify a same-PID writer exemption; installed takeover remains blocked.");
}

export function assertActiveVscodeSnapshotAdmission(
  host: ActiveVscodeMigrationHost, admission: { authorityId: string; authorize: unknown; allowedTools: readonly string[] } | undefined,
): void {
  assertActiveVscodeMigrationHost(host);
  const binding = hosts.get(host)!, authority = binding.snapshot;
  if (!authority && admission === undefined) return;
  if (!authority || authority.signal.aborted || !admission || authority.authorityId !== admission.authorityId
    || authority.authorize !== admission.authorize || JSON.stringify(authority.allowedTools) !== JSON.stringify(admission.allowedTools))
    return denied("Snapshot admission is not the native status-only approval owned by this activation.");
  const require = createRequire(import.meta.url);
  require(join(binding.context.extensionPath, "next-runtime/server/legacy/dist/runtime/legacy-snapshot-vscode-authority.js"))
    .assertLegacySnapshotVscodeAuthority(authority, binding.context, host);
}

export function assertActiveVscodeMigrationGrant(
  host: ActiveVscodeMigrationHost, grant: ActiveVscodeMigrationGrant, root: string,
  operation?: { action: ActiveMigrationIntent["action"]; planSha256: string; prepared?: PreparedPin },
): void {
  assertActiveVscodeMigrationHost(host);
  const binding = grants.get(grant);
  if (!binding || binding.host !== host || binding.intent.sourceRoot !== root || host.root !== root
    || binding.expiresAt <= Date.now()) return denied("Migration approval is absent, expired or belongs to another activation.");
  if (!operation) return;
  if (binding.intent.action !== operation.action
    || binding.intent.planSha256 !== operation.planSha256
    || operation.prepared && (!binding.prepared || !samePrepared(binding.prepared, operation.prepared))
    || binding.prepared && !operation.prepared)
    return denied("The locked migration plan, operation or prepared identity does not match native approval.");
}

/** Core binds the newly issued identity only after validating the approved locked plan. */
export function bindActiveVscodePreparedIdentity(
  host: ActiveVscodeMigrationHost, grant: ActiveVscodeMigrationGrant, prepared: PreparedPin,
): void {
  assertActiveVscodeMigrationGrant(host, grant, prepared.sourceRoot);
  const binding = grants.get(grant)!;
  if (binding.intent.action !== "adopt" || binding.intent.planSha256 !== prepared.planSha256
    || binding.prepared && !samePrepared(binding.prepared, prepared))
    return denied("The newly prepared identity does not belong to this approved adoption.");
  binding.prepared = { sourceRoot: prepared.sourceRoot, workspaceId: prepared.workspaceId,
    sourceFingerprint: prepared.sourceFingerprint, planSha256: prepared.planSha256 };
}
