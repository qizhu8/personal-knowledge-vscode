import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ApprovalBridgeStorage } from "./approval-bridge-contracts.js";
import { approvalBridgeDigest, approvalBridgeJSON, approvalBridgeRecordDigest } from "./domain/approval-bridge-digest.js";
import { ExecutionStateStore } from "./execution-state.js";
import { createHumanReviewQueue, type HumanReviewIntent, type HumanReviewPrincipal } from "./human-review.js";
import { createNativeRuntime } from "./native-runtime.js";
import { Storage } from "./storage.js";
import { buildHostConfigOptions, type HostConfigPolicy } from "./host-config.js";
import type { ManagerTextConfig } from "./host-composition-manager.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { createVscodeActionTrustBridge } from "./vscode-action-trust-bridge.js";
import { composeLegacyRecipeHost, type LegacyRecipeHostPolicy } from "./legacy-recipe-host.js";
import type { LegacyRootAdoptionResult } from "./legacy-root-adoption.js";

const configPathLimit = 4096;
const adoptedStorageClaims = new WeakSet<Storage>();

export class AdoptedHostStartupCleanupError extends Error {
  constructor(readonly retryCleanup: () => Promise<void>) {
    super("Adopted host startup cleanup is unconfirmed; retain the Storage owner and retry cleanup.");
  }
}

export interface StandaloneHostPolicy extends HostConfigPolicy {
  /** Exact absolute path authorized by the embedding host; never inferred from the environment. */
  authorizedConfigPath: string;
}

export interface StandaloneHostOptions {
  dataPath: string;
  configPath: string;
  policy: StandaloneHostPolicy;
  resolveSecret(reference: string): Promise<string | undefined>;
  authenticateHuman(hostEvidence: unknown): HumanReviewPrincipal | null | Promise<HumanReviewPrincipal | null>;
  managerText?: ManagerTextConfig;
  hostServices?: NativeRuntimeOptions["hostServices"];
  /** Opts this standalone native host into the VS Code host-owned Action trust channel for one fixed actor. */
  actionTrustActorId?: string;
  coding?: NativeRuntimeOptions["coding"];
  channel?: NativeRuntimeOptions["channel"];
  remote?: NativeRuntimeOptions["remote"];
  subscription?: NativeRuntimeOptions["subscription"];
  subscriptionBundle?: NativeRuntimeOptions["subscriptionBundle"];
  legacySnapshots?: NativeRuntimeOptions["legacySnapshots"];
  pausedSnapshots?: NativeRuntimeOptions["pausedSnapshots"];
  legacyInlineNotes?: NativeRuntimeOptions["legacyInlineNotes"];
  batch15Skills?: NativeRuntimeOptions["batch15Skills"];
  skillSource?: NativeRuntimeOptions["skillSource"];
  batch15Assets?: NativeRuntimeOptions["batch15Assets"];
  batch16Classification?: NativeRuntimeOptions["batch16Classification"];
  originalClassification?: NativeRuntimeOptions["originalClassification"];
  batch16Memory?: NativeRuntimeOptions["batch16Memory"];
  portal?: NativeRuntimeOptions["portal"];
  legacyCommands?: NativeRuntimeOptions["legacyCommands"];
  legacyRecipes?: LegacyRecipeHostPolicy;
}

export interface StandaloneHumanReview {
  openSession(hostEvidence: unknown): Promise<object>;
  closeSession(capability: object): void;
  handlers: ReturnType<typeof createHumanReviewQueue>["handlers"];
}

/** Supplied by the trusted embedding host, not inferred from a Storage lease. */
export interface SelectedWorkspaceOwner {
  workspaceId: string;
  actorId: "local:owner";
  assertCurrent(): void;
}

export interface StandaloneHost {
  readonly core: Awaited<ReturnType<typeof createNativeRuntime>>["core"];
  readonly workspaceId: string;
  readonly readiness: Readonly<{ ready: true; transport: "native"; chatAvailable: boolean }>;
  readonly humanReview: StandaloneHumanReview;
  readonly services: Awaited<ReturnType<typeof createNativeRuntime>>["services"];
  readonly recipeHost?: Pick<Awaited<ReturnType<typeof composeLegacyRecipeHost>>, "binding" | "recipes" | "publicApi">;
  roomContext(): Promise<{ storage: Storage; actorId: "local:owner"; assertAuthority(): Promise<void> }>;
  selectedOwnerContext(selection: SelectedWorkspaceOwner): {
    storage: Storage; workspaceId: string; actorId: "local:owner"; assertCurrent(): void;
    registerChildClose(close: () => Promise<void>): () => void;
  };
  /** Private embedding capability, not a transport or client authorization. */
  ownerResourceContext(): {
    storage: Storage; core: Awaited<ReturnType<typeof createNativeRuntime>>["core"]; workspaceId: string;
    assertCurrent(): void; registerChildClose(close: () => Promise<void>): () => void;
  };
  close(): Promise<void>;
}

function assertConfigPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || Buffer.byteLength(path, "utf8") > configPathLimit
    || !isAbsolute(path) || resolve(path) !== path) throw new Error();
}

export async function readAuthorizedConfig(path: string, authorizedPath: string): Promise<string> {
  try {
    assertConfigPath(path);
    assertConfigPath(authorizedPath);
    if (path !== authorizedPath) throw new Error();

    const canonical = await realpath(path);
    if (canonical !== path) throw new Error();
    let protectedDirectory = process.platform === "win32";
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      const directoryStat = await lstat(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error();
      if (process.platform !== "win32" && (directoryStat.mode & 0o077) === 0
        && (!process.getuid || directoryStat.uid === process.getuid())) {
        protectedDirectory = true;
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
    }
    if (!protectedDirectory) throw new Error();

    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const file = await open(path, constants.O_RDONLY | noFollow);
    try {
      const before = await file.stat();
      if (!before.isFile() || process.platform !== "win32" && ((before.mode & 0o077) !== 0
        || process.getuid && before.uid !== process.getuid())
        || before.size > 32_768) throw new Error();
      const bytes = Buffer.alloc(32_769);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      const after = await file.stat();
      if (total > 32_768 || before.dev !== after.dev || before.ino !== after.ino || after.size > 32_768) throw new Error();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("Standalone host configuration is unavailable.");
  }
}

/** Start configured native Chat against the explicitly selected isolated workspace. */
export async function startStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost> {
  return startStandaloneHostInternal(options);
}

/**
 * Takes custody of an already-live experimental in-place Storage lease. The
 * trusted caller remains responsible for adoption and Chat/profile admission.
 */
export async function startStandaloneHostFromAdoptedRoot(
  options: StandaloneHostOptions, adoption: LegacyRootAdoptionResult,
): Promise<StandaloneHost> {
  if (!adoption || !(adoption.storage instanceof Storage) || adoption.state !== "committed"
    || adoption.qualification !== "experimental-unqualified" || adoptedStorageClaims.has(adoption.storage))
    throw new Error("Experimental adopted Storage is unavailable or already claimed.");
  const storage = adoption.storage;
  adoptedStorageClaims.add(storage);
  const releaseClaim = () => { adoptedStorageClaims.delete(storage); };
  try {
    storage.assertWorkspaceLease();
    const root = await realpath(options.dataPath);
    if (root !== resolve(options.dataPath) || root !== storage.workspaceRoot() || root !== adoption.sourceRoot
      || await storage.workspaceId() !== adoption.workspaceId)
      throw new Error("Adopted Storage root or workspace binding changed.");
    storage.assertWorkspaceLease();
    return await startStandaloneHostInternal(options, { storage, releaseClaim });
  } catch (error) {
    if (!(error instanceof AdoptedHostStartupCleanupError)) releaseClaim();
    throw error;
  }
}

async function startStandaloneHostInternal(options: StandaloneHostOptions,
  adopted?: { storage: Storage; releaseClaim(): void }): Promise<StandaloneHost> {
  let config: string;
  let policy: StandaloneHostPolicy;
  try {
    if (!options || typeof options !== "object" || typeof options.resolveSecret !== "function"
      || typeof options.authenticateHuman !== "function" || typeof options.dataPath !== "string"
      || !options.policy || typeof options.policy !== "object") throw new Error();
    policy = Object.freeze({
      ...options.policy,
      allowedProviders: Object.freeze([...options.policy.allowedProviders]),
      allowedEndpoints: Object.freeze([...options.policy.allowedEndpoints]),
      allowedModels: Object.freeze([...options.policy.allowedModels]),
      allowedTools: Object.freeze([...options.policy.allowedTools]),
    });
    config = await readAuthorizedConfig(options.configPath, policy.authorizedConfigPath);
  } catch {
    throw new Error("Standalone host configuration is unavailable.");
  }
  try {
    buildHostConfigOptions(config, {
      policy,
      resolveSecret: async () => undefined,
      fetchFactory: () => globalThis.fetch,
      reviewer: async () => null,
      authorizeTool: async () => false,
    });
  } catch {
    throw new Error("Standalone host configuration is invalid.");
  }

  let storage: Storage | undefined;
  let native: Awaited<ReturnType<typeof createNativeRuntime>> | undefined;
  let reviewDatabase: ReturnType<Storage["connectNative"]> | undefined;
  let reviewQueue: ReturnType<typeof createHumanReviewQueue> | undefined;
  let recipeHost: Awaited<ReturnType<typeof composeLegacyRecipeHost>> | undefined;
  let startupResourceUnconfirmed = false;
  try {
    storage = adopted?.storage ?? await Storage.open(options.dataPath, { deferRecovery: true });
    storage.assertWorkspaceLease();
    const workspaceId = await storage.workspaceId();
    let hostServicesOptions = options.hostServices;
    if (options.actionTrustActorId !== undefined) {
      if (hostServicesOptions?.action?.automaticTrusted) {
        throw new Error("Configure either the native VS Code Action authority bridge or a direct host authority, not both.");
      }
      hostServicesOptions = {
        ...hostServicesOptions,
        action: {
          ...hostServicesOptions?.action,
          automaticTrusted: createVscodeActionTrustBridge({
            workspaceRoot: storage.workspaceRoot(), workspaceId, actorId: options.actionTrustActorId,
          }),
        },
      };
    }
    reviewDatabase = storage.connectNative();
    const assertLease = () => storage!.assertWorkspaceLease();
    const reviewStorage: ApprovalBridgeStorage = {
      read<T>(callback: (database: DatabaseSync) => T): T {
        assertLease();
        if (reviewDatabase!.isTransaction) throw new Error("Review read cannot nest inside a transaction.");
        const result = callback(reviewDatabase!);
        assertLease();
        return result;
      },
      transaction<T>(callback: (database: DatabaseSync) => T): T {
        assertLease();
        if (reviewDatabase!.isTransaction) throw new Error("Review transactions cannot be nested.");
        reviewDatabase!.exec("BEGIN IMMEDIATE");
        try {
          const result = callback(reviewDatabase!);
          if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Review transactions must be synchronous.");
          assertLease();
          reviewDatabase!.exec("COMMIT");
          return result;
        } catch (error) {
          if (reviewDatabase!.isTransaction) reviewDatabase!.exec("ROLLBACK");
          throw error;
        }
      },
    };
    reviewQueue = createHumanReviewQueue({
      workspaceId,
      storage: reviewStorage,
      authenticateHuman: options.authenticateHuman,
      validateCurrent(intent: Readonly<HumanReviewIntent>) {
        try {
          assertLease();
          if (intent.authority !== "approval" || intent.workspaceId !== workspaceId) return false;
          const request = intent.request;
          if (request.workspaceId !== workspaceId || request.actorId !== intent.actorId
            || request.operationId !== intent.operationId) return false;
          const approval = reviewDatabase!.prepare(`SELECT execution_id,execution_revision,status,record_digest,
            arguments_digest FROM approval_bridge_requests WHERE workspace_id=? AND actor_id=? AND operation_id=?`)
            .get(workspaceId, intent.actorId, intent.operationId) as {
              execution_id: string; execution_revision: number; status: string;
              record_digest: string; arguments_digest: string;
            } | undefined;
          if (!approval || approval.status !== "pending" || approval.execution_id !== request.record.id
            || approval.record_digest !== request.recordDigest || approval.arguments_digest !== request.argumentsDigest)
            return false;
          const binding = reviewDatabase!.prepare(`SELECT operation_id,context_json FROM approval_bridge_bindings
            WHERE workspace_id=? AND actor_id=? AND execution_id=?`)
            .get(workspaceId, intent.actorId, request.record.id) as { operation_id: string; context_json: string } | undefined;
          if (!binding || binding.operation_id !== request.executionOperationId) return false;
          const record = new ExecutionStateStore(reviewDatabase!).get(intent.actorId, request.record.id);
          if (!record || record.revision !== approval.execution_revision || record.status !== "awaiting_approval") return false;
          const context = JSON.parse(binding.context_json);
          return approvalBridgeJSON(context) === approvalBridgeJSON(request.context)
            && approvalBridgeDigest(record.arguments) === request.argumentsDigest
            && approvalBridgeRecordDigest(workspaceId, record, request.context, binding.operation_id) === request.recordDigest
            && approvalBridgeRecordDigest(workspaceId, request.record, request.context, binding.operation_id) === request.recordDigest;
        } catch {
          return false;
        }
      },
    });
    const configured = buildHostConfigOptions(config, {
      policy,
      resolveSecret: reference => options.resolveSecret(reference),
      fetchFactory: () => globalThis.fetch.bind(globalThis),
      reviewer: reviewQueue.native.reviewer,
      authorizeTool: async (binding, signal) => !signal.aborted && policy.allowedTools.includes(binding.operation),
    });
    if (options.legacyRecipes) {
      startupResourceUnconfirmed = true;
      recipeHost = await composeLegacyRecipeHost(storage, options.legacyRecipes);
      startupResourceUnconfirmed = false;
    }
    startupResourceUnconfirmed = true;
    native = await createNativeRuntime({ storage, ...configured, managerText: options.managerText, hostServices: hostServicesOptions,
      ...(recipeHost ? { recipeApi: recipeHost.publicApi, workflow: recipeHost.workflow } : {}),
      coding: options.coding, channel: options.channel, remote: options.remote, subscription: options.subscription,
      subscriptionBundle: options.subscriptionBundle, legacySnapshots: options.legacySnapshots, portal: options.portal,
      pausedSnapshots: options.pausedSnapshots, legacyInlineNotes: options.legacyInlineNotes,
      batch15Skills: options.batch15Skills, batch15Assets: options.batch15Assets, skillSource: options.skillSource,
      batch16Classification: options.batch16Classification,
      originalClassification: options.originalClassification,
      batch16Memory: options.batch16Memory,
      legacyCommands: options.legacyCommands });
    startupResourceUnconfirmed = false;
    recipeHost?.bindRuntime(native);
    let closeTask: Promise<void> | undefined;
    let ownerAdmissionClosed = false;
    let reviewClosed = false, recipeClosed = false, nativeClosed = false, reviewDatabaseClosed = false;
    const ownerChildren = new Map<symbol, () => Promise<void>>();
    const registerChildClose = (close: () => Promise<void>) => {
      if (ownerAdmissionClosed || typeof close !== "function") throw new Error("Owner child admission closed.");
      const key = Symbol();
      ownerChildren.set(key, close);
      return () => { if (!ownerAdmissionClosed) ownerChildren.delete(key); };
    };
    const host: StandaloneHost = {
      core: native.core,
      services: native.services,
      ...(recipeHost ? { recipeHost: { binding: recipeHost.binding, recipes: recipeHost.recipes, publicApi: recipeHost.publicApi } } : {}),
      workspaceId,
      readiness: Object.freeze({
        ready: true,
        transport: "native",
        chatAvailable: native.services.chatTurns?.available === true,
      }),
      humanReview: Object.freeze({
        openSession: reviewQueue.native.openSession,
        closeSession: reviewQueue.native.closeSession,
        handlers: reviewQueue.handlers,
      }),
      async roomContext() {
        if (ownerAdmissionClosed) throw new Error("Standalone Room authority unavailable.");
        storage!.assertWorkspaceLease();
        return { storage: storage!, actorId: "local:owner", async assertAuthority() {
          if (ownerAdmissionClosed) throw new Error("Standalone Room authority revoked.");
          storage!.assertWorkspaceLease();
        } };
      },
      selectedOwnerContext(selection) {
        const assertCurrent = () => {
          if (ownerAdmissionClosed || !selection || selection.workspaceId !== workspaceId
            || selection.actorId !== "local:owner" || typeof selection.assertCurrent !== "function")
            throw new Error("Selected workspace owner unavailable.");
          storage!.assertWorkspaceLease();
          const result = (selection.assertCurrent as () => unknown)();
          if (result !== undefined) {
            if (result && (typeof result === "object" || typeof result === "function")
              && typeof (result as { then?: unknown }).then === "function")
              void Promise.resolve(result).catch(() => {});
            throw new Error("Selected workspace owner fence must be synchronous and return undefined.");
          }
          if (ownerAdmissionClosed || selection.workspaceId !== workspaceId || selection.actorId !== "local:owner")
            throw new Error("Selected workspace owner unavailable.");
          storage!.assertWorkspaceLease();
        };
        assertCurrent();
        return Object.freeze({
          storage: storage!, workspaceId, actorId: "local:owner" as const, assertCurrent,
          registerChildClose(close: () => Promise<void>) { assertCurrent(); return registerChildClose(close); },
        });
      },
      ownerResourceContext() {
        const assertCurrent = () => {
          if (ownerAdmissionClosed) throw new Error("Owner resource admission closed.");
          storage!.assertWorkspaceLease();
        };
        assertCurrent();
        return Object.freeze({ storage: storage!, core: native!.core, workspaceId, assertCurrent,
          registerChildClose(close: () => Promise<void>) { assertCurrent(); return registerChildClose(close); } });
      },
      close() {
        if (closeTask) return closeTask;
        ownerAdmissionClosed = true;
        closeTask = Promise.resolve().then(async () => {
          const children = [...ownerChildren];
          const results = await Promise.allSettled(children.map(([, close]) => Promise.resolve().then(close)));
          results.forEach((result, index) => {
            if (result.status === "fulfilled") ownerChildren.delete(children[index][0]);
          });
          if (results.some(result => result.status === "rejected")) {
            closeTask = undefined;
            throw new Error("Standalone host child operations did not drain.");
          }
          let failed = false;
          if (!reviewClosed) try { reviewQueue!.native.shutdown(); reviewClosed = true; } catch { failed = true; }
          if (!recipeClosed) try { recipeHost?.close(); recipeClosed = true; } catch { failed = true; }
          if (!nativeClosed) try { await native!.close(); nativeClosed = true; } catch { failed = true; }
          if (nativeClosed && !reviewDatabaseClosed)
            try { reviewDatabase!.close(); reviewDatabaseClosed = true; } catch { failed = true; }
          if (failed || !reviewDatabaseClosed) {
            closeTask = undefined;
            throw new Error("Standalone host operations did not drain; Storage remains owned.");
          }
          try { await storage!.close(); adopted?.releaseClaim(); }
          catch {
            closeTask = undefined;
            throw new Error("Standalone host Storage shutdown is unconfirmed.");
          }
        });
        return closeTask;
      },
    };
    return Object.freeze(host);
  } catch {
    if (adopted) {
      let reviewClosed = false, recipeClosed = false, nativeClosed = false, databaseClosed = false;
      const cleanup = async () => {
        if (startupResourceUnconfirmed)
          throw new Error("A startup factory failed without returning a drainable resource; retain Storage for process-level recovery.");
        let failed = false;
        if (!reviewClosed) try { reviewQueue?.native.shutdown(); reviewClosed = true; } catch { failed = true; }
        if (!recipeClosed) try { recipeHost?.close(); recipeClosed = true; } catch { failed = true; }
        if (!nativeClosed) try { await native?.close(); nativeClosed = true; } catch { failed = true; }
        if (nativeClosed && !databaseClosed) try { reviewDatabase?.close(); databaseClosed = true; } catch { failed = true; }
        if (failed || !databaseClosed) throw new Error("Adopted host startup cleanup is unconfirmed.");
      };
      try { await cleanup(); }
      catch {
        let retry: Promise<void> | undefined;
        throw new AdoptedHostStartupCleanupError(() => {
          if (!retry) retry = cleanup().then(() => { adopted.releaseClaim(); }).catch(error => { retry = undefined; throw error; });
          return retry;
        });
      }
      throw new Error("Standalone adopted host startup failed; the caller retains Storage.");
    }
    try { reviewQueue?.native.shutdown(); } catch { /* Continue releasing host resources. */ }
    try { recipeHost?.close(); } catch { /* Continue releasing host resources. */ }
    if (native) await Promise.allSettled([native.close()]);
    try { reviewDatabase?.close(); } catch { /* Continue releasing host resources. */ }
    if (storage) await Promise.allSettled([storage.close()]);
    throw new Error("Standalone host startup failed.");
  }
}
