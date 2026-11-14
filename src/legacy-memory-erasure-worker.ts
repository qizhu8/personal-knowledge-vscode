import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ChatMemoryWorker } from "./compute/chat-memory-worker.js";
import type { ComputeOptions } from "./compute/contracts.js";
import type {
  LegacyMemoryEffectAuthorityRequest, LegacyMemoryErasureEngineBinding, LegacyMemoryErasureLease,
} from "./legacy-memory-erasure.js";

export interface LegacyMemoryOwnedFixtureBinding {
  runtimeDirectory: string;
  database: string;
  identity: string;
}

export interface LegacyMemoryOwnedFixturePolicy {
  readonly scope: "exclusive-native-disposable-fixture";
  /** Attests exclusion of all external writers and ancestor replacement, and worker/database identity. */
  assertFixtureOwnership(binding: Readonly<LegacyMemoryOwnedFixtureBinding>): boolean;
  /** Independently checks the live actor, operation, and externally maintained restore epoch. */
  authorizeEffect(request: Readonly<LegacyMemoryEffectAuthorityRequest>): boolean;
  assertNativeAdoption?(root: string, workspaceId: string): boolean;
  originalOperationRoot?(operationId: string): string | undefined;
  assertWriterAdmission?(): boolean;
  afterSafeClose?(): Promise<void>;
  afterOwnedDispatch?(): void;
  afterHeldRelease?(): void;
}

export class LegacyMemoryOwnedWorkerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LegacyMemoryOwnedWorkerError"; }
}

const methods = [
  "readPiece", "listPieces", "neighbors", "sources", "changes", "embedding", "children", "parents",
  "usage", "overview", "turnReceipt", "beginTurn", "continueTurn", "abortTurn", "commitTurn",
  "readMemory", "enforceCapacity", "createPiece", "appendStatement", "linkPieces", "commitSummary",
  "putEmbedding", "touchPiece", "acquireLease", "releaseLease", "evict",
] as const;
export type LegacyMemoryOwnedDispatchMethod = typeof methods[number];
const allowed = new Set<string>(methods);
const constructorKey = Symbol("owned-worker");

function assertPolicyResult(value: unknown): void {
  if (value !== true) throw new LegacyMemoryOwnedWorkerError("AUTHORITY_REQUIRED",
    "Synchronous native disposable fixture authority denied or unavailable.");
}

function pin(binding: LegacyMemoryOwnedFixtureBinding): string {
  const paths = [binding.database];
  for (let path = binding.runtimeDirectory;; path = dirname(path)) {
    paths.push(path);
    if (path === dirname(path)) break;
  }
  try {
    return JSON.stringify(paths.map((path, index) => {
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || (index === 0 ? !stat.isFile() : !stat.isDirectory())
        || index === 0 && (Number(stat.mode) & 0o777) !== 0o600 || realpathSync(path) !== path) throw new Error("Unstable path");
      return [path, stat.dev.toString(), stat.ino.toString(), stat.mode.toString()];
    }));
  } catch {
    throw new LegacyMemoryOwnedWorkerError("ENGINE_MISMATCH", "Disposable memory database or ancestor is missing or unsafe.");
  }
}

/** Fixture-only owned dispatcher; it is not an interprocess lock or a production ownership provider. */
export class LegacyMemoryErasureOwnedWorker {
  readonly #worker: ChatMemoryWorker;
  readonly #binding: Readonly<LegacyMemoryOwnedFixtureBinding>;
  readonly #policy: LegacyMemoryOwnedFixturePolicy;
  readonly #filePin: string;
  readonly #inFlight = new Set<Promise<unknown>>();
  #dispatchTail: Promise<unknown> = Promise.resolve();
  #state: "ready" | "draining" | "held" | "closed" | "fenced" = "ready";
  #effectInFlight = false;
  #heldEffectApplied = false;
  #generation = 0;

  private constructor(key: symbol, worker: ChatMemoryWorker, binding: Readonly<LegacyMemoryOwnedFixtureBinding>,
    policy: LegacyMemoryOwnedFixturePolicy, filePin: string) {
    if (key !== constructorKey) throw new LegacyMemoryOwnedWorkerError("AUTHORITY_REQUIRED", "Use the fixture-only factory.");
    this.#worker = worker;
    this.#binding = binding;
    this.#policy = policy;
    this.#filePin = filePin;
  }

  static async open(options: ComputeOptions, policy: LegacyMemoryOwnedFixturePolicy): Promise<LegacyMemoryErasureOwnedWorker> {
    if (!policy || policy.scope !== "exclusive-native-disposable-fixture"
      || typeof policy.assertFixtureOwnership !== "function" || typeof policy.authorizeEffect !== "function") {
      throw new LegacyMemoryOwnedWorkerError("AUTHORITY_REQUIRED", "Explicit native disposable fixture ownership and epoch authority are required.");
    }
    if (!isAbsolute(options.runtimeDirectory) || !isAbsolute(options.database)
      || dirname(resolve(options.database)) !== resolve(options.runtimeDirectory)) {
      throw new LegacyMemoryOwnedWorkerError("ENGINE_MISMATCH", "Memory database must be a direct absolute fixture runtime child.");
    }
    const binding = Object.freeze({ runtimeDirectory: resolve(options.runtimeDirectory),
      database: resolve(options.database), identity: options.identity });
    assertPolicyResult(policy.assertFixtureOwnership(binding));
    const worker = await ChatMemoryWorker.openOwnedSnapshot({ ...options, ...binding });
    try {
      assertPolicyResult(policy.assertFixtureOwnership(binding));
      if (!worker.healthy || worker.ready?.identity !== binding.identity) {
        throw new LegacyMemoryOwnedWorkerError("ENGINE_MISMATCH", "Owned fixture worker identity is inconsistent.");
      }
      return new LegacyMemoryErasureOwnedWorker(constructorKey, worker, binding, policy, pin(binding));
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

  #assertOwner(): void {
    if (this.#state === "closed" || this.#state === "fenced") {
      throw new LegacyMemoryOwnedWorkerError("NOT_AVAILABLE", "Owned fixture worker is closed or fenced.");
    }
    try {
      assertPolicyResult(this.#policy.assertFixtureOwnership(this.#binding));
      if (pin(this.#binding) !== this.#filePin || !this.#worker.healthy
        || this.#worker.ready?.identity !== this.#binding.identity) {
        throw new LegacyMemoryOwnedWorkerError("ENGINE_MISMATCH", "Owned fixture worker or file pin changed.");
      }
    } catch (error) {
      this.#state = "fenced";
      throw error;
    }
  }

  dispatch<M extends LegacyMemoryOwnedDispatchMethod>(
    method: M, ...args: Parameters<ChatMemoryWorker[M]>
  ): ReturnType<ChatMemoryWorker[M]> {
    if (this.#state !== "ready") throw new LegacyMemoryOwnedWorkerError("BUSY", "Owned fixture dispatcher is quiesced or closed.");
    if (!allowed.has(method)) throw new LegacyMemoryOwnedWorkerError("NOT_AVAILABLE", "Worker method is not admitted.");
    this.#assertOwner();
    if (this.#policy.assertWriterAdmission) assertPolicyResult(this.#policy.assertWriterAdmission());
    const fn = this.#worker[method] as (...values: unknown[]) => Promise<unknown>;
    const task = this.#dispatchTail.then(async () => {
      this.#assertOwner();
      try {
        if (this.#policy.assertWriterAdmission) assertPolicyResult(this.#policy.assertWriterAdmission());
        const result = await fn.apply(this.#worker, args);
        this.#policy.afterOwnedDispatch?.();
        return result;
      } catch (error) {
        if (this.#policy.afterOwnedDispatch) this.#state = "fenced";
        throw error;
      }
    });
    this.#dispatchTail = task.catch(() => undefined);
    this.#inFlight.add(task);
    void task.then(() => this.#inFlight.delete(task), () => this.#inFlight.delete(task));
    return task as ReturnType<ChatMemoryWorker[M]>;
  }

  async acquireMemoryQuiescence(): Promise<LegacyMemoryErasureLease> {
    if (this.#state !== "ready") throw new LegacyMemoryOwnedWorkerError("BUSY", "Owned fixture dispatcher is already quiesced.");
    this.#assertOwner();
    if (this.#policy.assertWriterAdmission) assertPolicyResult(this.#policy.assertWriterAdmission());
    this.#state = "draining";
    await Promise.allSettled([...this.#inFlight]);
    this.#assertOwner();
    if (this.#policy.assertWriterAdmission) assertPolicyResult(this.#policy.assertWriterAdmission());
    if (this.#state !== "draining") throw new LegacyMemoryOwnedWorkerError("NOT_AVAILABLE", "Owned fixture drain was interrupted.");
    this.#state = "held";
    this.#heldEffectApplied = false;
    const generation = ++this.#generation;
    return Object.freeze({
      assertHeld: () => {
        if (this.#state !== "held" || generation !== this.#generation) {
          throw new LegacyMemoryOwnedWorkerError("NOT_AVAILABLE", "Owned fixture quiescence is not held.");
        }
        this.#assertOwner();
      },
      release: () => {
        if (this.#state !== "held" || generation !== this.#generation || this.#effectInFlight) {
          throw new LegacyMemoryOwnedWorkerError("NOT_AVAILABLE", "Owned fixture lease cannot be released.");
        }
        this.#assertOwner();
        try {
          if (this.#heldEffectApplied) this.#policy.afterHeldRelease?.();
          if (this.#policy.assertWriterAdmission) assertPolicyResult(this.#policy.assertWriterAdmission());
        } catch (error) {
          this.#state = "fenced";
          throw error;
        }
        this.#state = "ready";
      },
    });
  }

  engineBinding(): LegacyMemoryErasureEngineBinding {
    const owner = this;
    const adapter = Object.freeze({
      get healthy() { return owner.#worker.healthy && owner.#state !== "closed" && owner.#state !== "fenced"; },
      get ready() { return owner.#worker.ready; },
      forgetScope(params: { scope: string }) {
        if (owner.#state !== "held" || owner.#effectInFlight) {
          throw new LegacyMemoryOwnedWorkerError("BUSY", "Owned erasure effect requires the exclusive fixture lease.");
        }
        owner.#assertOwner();
        owner.#effectInFlight = true;
        return owner.#worker.forgetScope(params).then(result => {
          owner.#heldEffectApplied = true;
          return result;
        }).finally(() => { owner.#effectInFlight = false; });
      },
      snapshotDatabase(destination: string) {
        if (owner.#state !== "held" || owner.#effectInFlight) {
          throw new LegacyMemoryOwnedWorkerError("BUSY", "Owned engine snapshot requires the exclusive fixture lease.");
        }
        owner.#assertOwner();
        const path = resolve(destination);
        if (dirname(path) !== owner.#binding.runtimeDirectory
          || !path.split(/[\\/]/u).at(-1)?.startsWith(".pkm-memory-snapshot-")) {
          throw new LegacyMemoryOwnedWorkerError("INVALID_PATH", "Engine snapshot must be staged beside its owned database.");
        }
        owner.#effectInFlight = true;
        return owner.#worker.snapshotDatabase(path).finally(() => { owner.#effectInFlight = false; });
      },
    });
    return Object.freeze({ ...this.#binding, worker: adapter as unknown as ChatMemoryWorker,
      assertNativeAdoption: (root: string, workspaceId: string) => this.#policy.assertNativeAdoption?.(root, workspaceId) === true,
      originalOperationRoot: (operationId: string) => this.#policy.originalOperationRoot?.(operationId) });
  }

  assertEffectAuthority(request: Readonly<LegacyMemoryEffectAuthorityRequest>): boolean {
    if (this.#state !== "held") return false;
    this.#assertOwner();
    if (request.database !== this.#binding.database || request.runtimeDirectory !== this.#binding.runtimeDirectory) return false;
    return this.#policy.authorizeEffect(request) === true;
  }

  fenceUnknownOutcome(): void { this.#state = "fenced"; }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "held" || this.#state === "draining") {
      throw new LegacyMemoryOwnedWorkerError("BUSY", "Release the owned fixture lease before closing.");
    }
    const seal = this.#state === "ready" && this.#worker.healthy;
    this.#state = seal ? "draining" : "closed";
    const drained = await Promise.allSettled([...this.#inFlight]);
    const safelyDrained = seal && this.#state === "draining" && drained.every(item => item.status === "fulfilled");
    this.#state = "closed";
    await this.#worker.close();
    if (safelyDrained)
      await this.#policy.afterSafeClose?.();
  }
}
