import { ManagedOrdinaryEnvironmentProfileWriter } from "./ordinary-environment-managed-effects";
import { beginManagedEnvironmentRefresh, completeManagedEnvironmentRefresh,
  createManagedEnvironmentHostFence, assertManagedEnvironmentHostFence,
  type ManagedProfileRegistration } from "./managed-writer-session";
import type { HostWriterAdmission } from "./host-writer-admission";
import type { OrdinaryEnvironmentRefreshIntent, EnvironmentQueryTrace } from "./ordinary-environment-owner";

export interface IndependentEnvironmentProfileWriter {
  readonly scope: "ordinary-environments:refresh-profile-writer";
  assertCurrent(binding: Readonly<Pick<OrdinaryEnvironmentRefreshIntent,
    "workspaceId" | "knowledgeRoot" | "globalStorageDirectory">>): void;
}
function synchronous(callback: () => unknown): void {
  const result = callback();
  if (result !== undefined) {
    if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
    throw new Error("Root/profile Environment fences must synchronously return undefined.");
  }
}
/**
 * Root's branded current/deny capability is mandatory, but never supplies the
 * independently authorized profile writer or actual execution approval.
 */
export function attachOrdinaryEnvironmentRootProfileWriter(options: {
  binding: Pick<OrdinaryEnvironmentRefreshIntent, "workspaceId" | "knowledgeRoot" | "globalStorageDirectory">;
  profileUri: string;
  scopeSignal: AbortSignal;
  registration: ManagedProfileRegistration;
  hostAdmission: HostWriterAdmission;
  profileWriter?: IndependentEnvironmentProfileWriter;
  supervisorPython: string;
  environment: NodeJS.ProcessEnv;
  assertExecutionAuthority(trace: Readonly<EnvironmentQueryTrace>): void;
  registerRootChildClose(close: () => Promise<void>): () => void;
  registerEnvironmentChildClose(close: () => Promise<void>): () => void;
  onCloseError(error: unknown): void;
}) {
  const binding = Object.freeze({ ...options.binding });
  const handle = createManagedEnvironmentHostFence({ root: binding.knowledgeRoot,
    profileStorage: binding.globalStorageDirectory, profileUri: options.profileUri,
    registration: options.registration, hostAdmission: options.hostAdmission, scopeSignal: options.scopeSignal });
  const profileWriter = options.profileWriter;
  const current = () => synchronous(() => assertManagedEnvironmentHostFence(handle));
  current();
  const signal = handle.denySignal;
  current();
  if (!signal || typeof signal.addEventListener !== "function" || signal.aborted)
    throw new Error("Root managed Environment host scope is unavailable.");
  if (!profileWriter || profileWriter.scope !== "ordinary-environments:refresh-profile-writer"
    || typeof profileWriter.assertCurrent !== "function")
    throw new Error("Independent Environment profile writer authority is required; Root host/session confirmation is not that grant.");
  const exclusive = () => {
    current();
    synchronous(() => profileWriter.assertCurrent(binding));
    current();
  };
  exclusive();
  return new ManagedOrdinaryEnvironmentProfileWriter({
    binding, hostAdmission: options.hostAdmission, supervisorPython: options.supervisorPython,
    environment: options.environment, signal,
    assertHostCurrent: current, assertExclusiveProfileWriter: exclusive,
    assertExecutionAuthority: options.assertExecutionAuthority,
    registerRootChildClose: options.registerRootChildClose,
    registerEnvironmentChildClose: options.registerEnvironmentChildClose,
    onCloseError: options.onCloseError,
    begin: prepared => beginManagedEnvironmentRefresh(binding.knowledgeRoot, prepared),
    complete: (registration, physical, transaction) => completeManagedEnvironmentRefresh(registration, physical, transaction),
  });
}

