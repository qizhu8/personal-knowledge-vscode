import { isMainThread, parentPort } from "node:worker_threads";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import type { OriginalMcpColdComponentFixture } from "./original-mcp-component-recovery.js";
import type { OriginalMcpTodoGenesisAdmission } from "./original-mcp-todo-genesis.js";
import { originalMcpTodoGenesisRequestDigest as digest, type OriginalMcpTodoGenesisPlan } from "./original-mcp-todo-genesis-contracts.js";

export interface ExperimentalTodoGenesisCheckpoint {
  readonly point: "durable-note-and-backing-before-canonical";
  readonly root: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly planSha256: string;
  readonly requestSha256: string;
}
export interface ExperimentalTodoGenesisFaultControl {
  checkpoint: ExperimentalTodoGenesisCheckpoint;
  oneUse: SharedArrayBuffer;
}
type Injector = (checkpoint: ExperimentalTodoGenesisCheckpoint) => void;
const owners = new WeakMap<Storage, {
  callback: Injector; current(): void; control?: ExperimentalTodoGenesisFaultControl; reported: boolean;
  failure?: Error & { code?: string; effect?: string }; errorReturned?: boolean;
}>();
function denied(): never {
  throw new CoreError("TODO_GENESIS_EXPERIMENTAL_CONTROL_REQUIRED", "Only an actual branded cold fixture may bind the bounded Todo publication interruption.");
}
function checkpoint(admission: OriginalMcpTodoGenesisAdmission): ExperimentalTodoGenesisCheckpoint {
  const request = admission.plan.request;
  return Object.freeze({ point: "durable-note-and-backing-before-canonical", root: request.root,
    workspaceId: request.workspaceId, operationId: request.operationId,
    planSha256: admission.plan.planSha256, requestSha256: digest(request) });
}

/** A function never crosses the worker boundary, and the control grants no publication authority. */
export async function bindExperimentalTodoGenesisFault(fixture: OriginalMcpColdComponentFixture,
  storage: Storage, host: OriginalMcpNativeHost, session: AuthenticatedOriginalMcpNativeSession, callback: Injector) {
  const { assertOriginalMcpColdComponentFixture } = await import("./original-mcp-component-recovery.js");
  await assertOriginalMcpColdComponentFixture(fixture);
  const current = () => {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    if (!isMainThread || typeof callback !== "function" || fixture.root !== storage.workspaceRoot()
      || host.receipt.root !== fixture.root || session.binding.root !== fixture.root
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}`
      || host.receipt.epoch !== session.activationId
      || host.receipt.workspaceId !== session.binding.workspaceId
      || host.receipt.planSha256 !== session.binding.planSha256
      || host.receipt.profileSha256 !== session.binding.profileSha256
      || host.receipt.sourceCatalogSha256 !== session.binding.catalogSha256) denied();
  };
  current();
  if (owners.has(storage)) denied();
  owners.set(storage, { callback, current, reported: false });
  storage.retainNativeCleanup({ release() { owners.delete(storage); } });
}

export function experimentalTodoGenesisFaultForStorage(storage: Storage, admission: OriginalMcpTodoGenesisAdmission) {
  const owner = owners.get(storage);
  if (!owner || admission.plan.request.phase !== "create") return undefined;
  owner.current();
  if (owner.control) return undefined;
  if (admission.plan.request.root !== storage.workspaceRoot()
    || digest(admission.provenance.request) !== digest(admission.plan.request)) denied();
  return owner.control = { checkpoint: checkpoint(admission), oneUse: new SharedArrayBuffer(4) };
}

export class ExperimentalTodoGenesisFault extends CoreError {
  constructor(readonly checkpoint: ExperimentalTodoGenesisCheckpoint) {
    super("TODO_GENESIS_EXPERIMENTAL_FAULT",
      "Todo genesis intent, Note and backing are durable; canonical publication was deliberately interrupted in an owned cold fixture.", "unknown");
  }
}
export function assertExperimentalTodoGenesisFaultControl(root: string, admission: OriginalMcpTodoGenesisAdmission,
  control: ExperimentalTodoGenesisFaultControl) {
  if (isMainThread || !parentPort || admission.plan.request.phase !== "create"
    || root !== admission.plan.request.root || digest(control.checkpoint) !== digest(checkpoint(admission))
    || Object.keys(control).sort().join(",") !== "checkpoint,oneUse"
    || !(control.oneUse instanceof SharedArrayBuffer) || control.oneUse.byteLength !== 4
    || Atomics.load(new Int32Array(control.oneUse), 0) !== 0) denied();
}
export function interruptExperimentalTodoGenesisPublication(root: string, admission: OriginalMcpTodoGenesisAdmission,
  control: ExperimentalTodoGenesisFaultControl) {
  assertExperimentalTodoGenesisFaultControl(root, admission, control);
  if (Atomics.compareExchange(new Int32Array(control.oneUse), 0, 0, 1) !== 0) denied();
  throw new ExperimentalTodoGenesisFault(checkpoint(admission));
}
export function reportExperimentalTodoGenesisFault(storage: Storage, control: ExperimentalTodoGenesisFaultControl,
  error: Error & { code?: string; effect?: string; experimentalTodoGenesisCheckpoint?: unknown }) {
  const owner = owners.get(storage);
  if (!owner || owner.control !== control || owner.reported || error.code !== "TODO_GENESIS_EXPERIMENTAL_FAULT"
    || error.effect !== "unknown" || digest(error.experimentalTodoGenesisCheckpoint) !== digest(control.checkpoint)
    || Atomics.load(new Int32Array(control.oneUse), 0) !== 1) denied();
  owner.current(); owner.reported = true;
  owner.failure = error;
  console.error("PKM owned Todo genesis interruption:", control.checkpoint);
  try {
    const result: unknown = owner.callback(control.checkpoint);
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(cause => console.error("PKM owned Todo asynchronous callback failure:", cause));
      throw new CoreError("TODO_GENESIS_EXPERIMENTAL_CALLBACK_INVALID", "Owned Todo checkpoint callbacks must finish synchronously.");
    }
  }
  catch (cause) {
    owner.failure = Object.assign(new CoreError("TODO_GENESIS_EXPERIMENTAL_CALLBACK_FAILED",
      "Owned Todo checkpoint callback failed after durable intent; preserve the pending Root.", "unknown"),
    { cause, experimentalTodoGenesisCheckpoint: control.checkpoint });
    throw owner.failure;
  }
}
/** Preserve the genuine typed cause across Core's normal error projection, for this one fixture attempt only. */
export function experimentalTodoGenesisFaultError(storage: Storage, plan: OriginalMcpTodoGenesisPlan,
  reply: { code: string; message: string; effect?: string }) {
  const owner = owners.get(storage), error = owner?.failure;
  if (!owner || !error || owner.errorReturned || !owner.control
    || owner.control.checkpoint.operationId !== plan.request.operationId
    || owner.control.checkpoint.planSha256 !== plan.planSha256
    || error.code !== reply.code || error.message !== reply.message || error.effect !== reply.effect) return undefined;
  owner.current(); owner.errorReturned = true; return error;
}
