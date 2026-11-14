import type * as vscode from "vscode";
import { attachOrdinaryEnvironmentsToOwner, type EnvironmentOwnerContext, type EnvironmentHostSession,
  type OrdinaryEnvironmentRefreshIntent } from "./ordinary-environment-owner";
import { requestOrdinaryEnvironmentReadAuthority, requestOrdinaryEnvironmentRefreshPermit,
  type OrdinaryEnvironmentVscodeHost, type OrdinaryEnvironmentManagedEffects } from "./ordinary-environment-vscode-authority";

/** Trusted same-process embedding; no command, socket credential or session ID creates effects. */
export async function startOrdinaryEnvironmentVscodeHost(options: {
  context: vscode.ExtensionContext;
  owner: EnvironmentOwnerContext;
  hostSession: EnvironmentHostSession;
  sessionId: string;
  assertHostCurrent: OrdinaryEnvironmentVscodeHost["assertCurrent"];
  acquireEffects?(intent: Readonly<OrdinaryEnvironmentRefreshIntent>,
    lifetime: Readonly<{ signal: AbortSignal; expiresAtMs: number }>): Promise<OrdinaryEnvironmentManagedEffects>;
  onCloseError(error: unknown): void;
}) {
  const { context, owner, hostSession } = options;
  if (owner.workspaceId !== hostSession.workspaceId || typeof options.assertHostCurrent !== "function")
    throw new Error("Environment UI requires the selected Root owner's actual host session.");
  const scopeSignal = hostSession.signalFor?.("environment") ?? hostSession.signal;
  const controller = new AbortController();
  const revoke = () => controller.abort();
  const synchronous = (check: () => unknown) => {
    const result = check();
    if (result !== undefined) {
      if (result && typeof (result as PromiseLike<unknown>).then === "function")
        void Promise.resolve(result).catch(() => {});
      throw new Error("Environment owner/session fence must synchronously return undefined.");
    }
  };
  scopeSignal.addEventListener("abort", revoke, { once: true });
  if (scopeSignal.aborted) revoke();
  const host: OrdinaryEnvironmentVscodeHost = {
    knowledgeRoot: owner.storage.workspaceRoot(), workspaceId: owner.workspaceId, sessionId: options.sessionId,
    signal: controller.signal,
    assertCurrent(binding) {
      synchronous(() => owner.assertCurrent());
      synchronous(() => hostSession.assertCurrent("environment"));
      if (owner.storage.workspaceRoot() !== binding.knowledgeRoot || owner.workspaceId !== binding.workspaceId
        || hostSession.workspaceId !== binding.workspaceId || context.globalStorageUri.fsPath !== binding.globalStorageDirectory)
        throw new Error("Environment UI Root/profile/session binding changed.");
      return options.assertHostCurrent(binding);
    },
  };
  let authority: Awaited<ReturnType<typeof requestOrdinaryEnvironmentReadAuthority>>;
  try { authority = await requestOrdinaryEnvironmentReadAuthority(context, host); }
  catch (error) { scopeSignal.removeEventListener("abort", revoke); throw error; }
  if (!authority) { scopeSignal.removeEventListener("abort", revoke); return undefined; }
  authority.signal.addEventListener("abort", revoke, { once: true });
  const readAuthority = authority;
  let adapter: ReturnType<typeof attachOrdinaryEnvironmentsToOwner>;
  try { adapter = attachOrdinaryEnvironmentsToOwner({ owner, hostSession, authority: readAuthority, onCloseError: options.onCloseError }); }
  catch (error) { readAuthority.dispose(); scopeSignal.removeEventListener("abort", revoke); throw error; }
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  let closingTask: Promise<void> | undefined;
  let unregisterOwner: (() => void) | undefined, unregisterSession: (() => void) | undefined;
  const close = () => {
    if (closingTask) return closingTask;
    const task = (async () => {
      closing = true;
      revoke();
      readAuthority.dispose();
      await Promise.allSettled([...pending]);
      await adapter.close();
      unregisterSession?.(); unregisterOwner?.();
      scopeSignal.removeEventListener("abort", revoke);
      readAuthority.signal.removeEventListener("abort", revoke);
    })();
    closingTask = task;
    void task.catch(() => { if (closingTask === task) closingTask = undefined; });
    return task;
  };
  try {
    unregisterOwner = owner.registerChildClose(close);
    unregisterSession = hostSession.registerChildClose("environment", close);
  } catch (error) { await close(); throw error; }
  const handle = async (message: { command: string; id?: unknown; refresh?: unknown }) => {
    if (closing) throw new Error("Environment UI host is closing.");
    const request = Object.freeze({ command: message.command, id: message.id, refresh: message.refresh });
    if (request.command !== "envList" && request.command !== "envPackages") return adapter.handleMessage(request);
    if (request.command === "envList" && request.refresh !== true) return adapter.handleMessage(request);
    if (request.command === "envPackages" && request.refresh !== true) {
      const cached = await adapter.handleMessage(request);
      if (cached.command === "envPackages" && !cached.error) return cached;
    }
    const rows = await adapter.handleMessage({ command: "envList" });
    if (rows.command !== "envList") throw new Error("Environment owner registry is unavailable.");
    const environments = request.command === "envPackages" ? rows.data.filter(row => row.id === request.id) : rows.data;
    if (!environments.length) return adapter.handleMessage(request);
    const operation: "packages" | "metadata" = request.command === "envPackages" ? "packages" : "metadata";
    const intent = { workspaceId: owner.workspaceId, actorId: "local:owner" as const, knowledgeRoot: host.knowledgeRoot,
      globalStorageDirectory: context.globalStorageUri.fsPath, operation, refresh: request.refresh === true,
      environments: environments.map(({ id, path, python, manager }) => ({ id, path, python, manager })) };
    try {
      const permit = await requestOrdinaryEnvironmentRefreshPermit(context, {
        host, intent,
        acquireEffects: options.acquireEffects ?? (async () => {
          throw new Error("Refresh is unavailable: trusted profile-writer handoff and physical process-drain authority have not been established.");
        }),
      });
      if (!permit) return adapter.handleMessage(request);
      try { return await adapter.handleMessage(request, permit); }
      finally { permit.dispose(); }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (request.command === "envPackages")
        return { command: "envPackages" as const, id: String(request.id ?? ""), packages: [], capturedAt: "", cached: false, error: detail };
      return { command: "envList" as const, data: rows.data, refreshErrors: [detail] };
    }
  };
  return {
    handleMessage(message: Parameters<typeof handle>[0]) {
      const task = handle(message);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    close,
  };
}
