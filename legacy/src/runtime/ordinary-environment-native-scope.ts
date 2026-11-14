import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HostWriterAdmission } from "./host-writer-admission";
import { createManagedEnvironmentHostFence, assertManagedEnvironmentHostFence,
  type ManagedProfileRegistration } from "./managed-writer-session";
import { assertManagedHostChildRegistry, type ManagedHostChildRegistry } from "./managed-host-child-registry";
import { attachOrdinaryEnvironmentRootProfileWriter } from "./ordinary-environment-root-host-effects";
import { acquireNativeEnvironmentProfileWriter, assertNativeEnvironmentProfileWriter,
  type NativeEnvironmentProfileWriter } from "./ordinary-environment-native-profile-writer";
import { assertPausedLegacyEnvironmentDispatch, type LegacyEnvironmentDispatchPause } from "./ordinary-environment-legacy-dispatch";
import type { EnvironmentOwnerContext, EnvironmentHostSession, OrdinaryEnvironmentRefreshIntent, EnvironmentQueryTrace } from "./ordinary-environment-owner";

type Lifetime = Readonly<{ signal: AbortSignal; expiresAtMs: number }>;
type Parent = ManagedHostChildRegistry;
type Close = () => Promise<void>;

function executable(filename: string) {
  const canonical = fs.realpathSync(filename), stat = fs.statSync(canonical);
  if (!stat.isFile() || !stat.size || stat.size > 64 * 1024 * 1024)
    throw new Error("Native Environment query requires a bounded installed executable.");
  return { canonical, pin: `${stat.dev}:${stat.ino}`, digest: createHash("sha256").update(fs.readFileSync(canonical)).digest("hex") };
}

/**
 * Owns the actual enrolled legacy Environment subsystem. Its UI workspace key
 * identifies this host generation, not an adopted Next workspace or lease.
 */
export function createNativeLegacyEnvironmentScope(options: {
  knowledgeRoot: string;
  globalStorageDirectory: string;
  profileUri: string;
  registration: ManagedProfileRegistration;
  hostAdmission: HostWriterAdmission;
  rootChildren: Parent;
  dispatchPause: LegacyEnvironmentDispatchPause;
  supervisorPython: string;
  home: string;
  temporaryDirectory: string;
  onCloseError(error: unknown): void;
}) {
  if (!(options.hostAdmission instanceof HostWriterAdmission) || !options.rootChildren
    || options.rootChildren.signal.aborted || typeof options.rootChildren.register !== "function"
    || typeof options.rootChildren.close !== "function" || typeof options.onCloseError !== "function")
    throw new Error("Native Environment scope requires the actual managed Root parent lifecycle.");
  assertManagedHostChildRegistry(options.rootChildren, options.knowledgeRoot, options.hostAdmission);
  const workspaceId = `legacy-environment:${options.hostAdmission.status().ownerId}`;
  const binding = Object.freeze({ workspaceId, knowledgeRoot: options.knowledgeRoot,
    globalStorageDirectory: options.globalStorageDirectory });
  assertPausedLegacyEnvironmentDispatch(options.dispatchPause, binding);
  for (const directory of [options.home, options.temporaryDirectory])
    if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory || !fs.statSync(directory).isDirectory())
      throw new Error("Native Environment requires explicit canonical existing HOME/TMPDIR.");
  const helper = executable(options.supervisorPython);
  if (helper.canonical !== options.supervisorPython)
    throw new Error("Native Environment helper must be canonical.");
  const controller = new AbortController();
  const hostFence = createManagedEnvironmentHostFence({ root: binding.knowledgeRoot,
    profileStorage: binding.globalStorageDirectory, profileUri: options.profileUri,
    registration: options.registration, hostAdmission: options.hostAdmission,
    scopeSignal: AbortSignal.any([controller.signal, options.rootChildren.signal]) });
  const environment = Object.freeze({ PATH: "/usr/bin:/bin", HOME: options.home, TMPDIR: options.temporaryDirectory,
    PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONDONTWRITEBYTECODE: "1" });
  const children = new Map<symbol, Close>();
  const queries = new Map<string, {
    intent: Readonly<OrdinaryEnvironmentRefreshIntent>; lifetime: Lifetime; programs: Map<string, ReturnType<typeof executable>>;
  }>();
  let state: "open" | "closing" | "closed" | "unknown" = "open";
  let closing: Promise<void> | undefined, unregisterParent = () => {};
  let kernelWriter: NativeEnvironmentProfileWriter | undefined;
  let kernelFailure: unknown;
  let managedWriter: ReturnType<typeof attachOrdinaryEnvironmentRootProfileWriter> | undefined;
  const current = () => {
    if (state !== "open" || controller.signal.aborted || options.rootChildren.signal.aborted)
      throw new Error("Native legacy Environment scope is not current.");
    assertManagedHostChildRegistry(options.rootChildren, binding.knowledgeRoot, options.hostAdmission);
    assertManagedEnvironmentHostFence(hostFence);
    assertPausedLegacyEnvironmentDispatch(options.dispatchPause, binding);
  };
  const registerEnvironment = (close: Close) => {
    current();
    if (typeof close !== "function") throw new Error("An actual Environment child-close barrier is required.");
    const key = Symbol(); children.set(key, close);
    return () => { if (state === "open") children.delete(key); };
  };
  const close = () => {
    if (closing) return closing;
    if (state === "closed") return Promise.resolve();
    if (state === "unknown") return Promise.reject(new Error("UNKNOWN: native Environment child barriers remain registered."));
    state = "closing"; controller.abort();
    closing = (async () => {
      try {
        const results = await Promise.allSettled([...children.values()].map(child => Promise.resolve().then(child)));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        if (kernelFailure) throw new Error("UNKNOWN: native Environment kernel writer failed; retain both child registrars.");
        kernelWriter?.close(); children.clear(); queries.clear(); unregisterParent(); state = "closed";
        options.rootChildren.signal.removeEventListener("abort", revoked);
        options.hostAdmission.denySignal.removeEventListener("abort", revoked);
      } catch (error) { state = "unknown"; throw error; }
    })();
    return closing;
  };
  const revoked = () => { void close().catch(error => { try { options.onCloseError(error); } catch {} }); };
  const owner: EnvironmentOwnerContext = Object.freeze({
    workspaceId, storage: Object.freeze({ workspaceRoot: () => binding.knowledgeRoot }),
    assertCurrent: current,
    registerChildClose(child: Close) { current(); return options.rootChildren.register(child); },
  });
  const hostSession: EnvironmentHostSession = Object.freeze({
    workspaceId, signal: controller.signal,
    assertCurrent(scope: "environment") { if (scope !== "environment") throw new Error("Wrong native Environment scope."); current(); },
    signalFor(scope: "environment") { hostSession.assertCurrent(scope); return controller.signal; },
    registerChildClose(scope: "environment", child: Close) { hostSession.assertCurrent(scope); return registerEnvironment(child); },
  });
  const assertExecution = (trace: Readonly<EnvironmentQueryTrace>) => {
    current();
    const approved = queries.get(trace.intent.requestId);
    const native = require("./ordinary-environment-vscode-authority") as typeof import("./ordinary-environment-vscode-authority");
    if (!approved || !isDeepStrictEqual(trace.intent, approved.intent))
      throw new Error("Native Environment execution has no exact approved intent.");
    native.assertNativeOrdinaryEnvironmentRefreshIntent(approved.intent, approved.lifetime);
    const entry = trace.intent.environments.find(row => row.id === trace.environmentId);
    if (!entry || !isDeepStrictEqual(trace.environment, environment)
      || trace.launch?.program !== helper.canonical || !isDeepStrictEqual(executable(helper.canonical), helper))
      throw new Error("Native Environment execution/helper binding changed.");
    const filename = trace.kind === "size" ? "/usr/bin/du" : entry.python;
    const args = trace.kind === "size" ? ["-sk", entry.path]
      : trace.kind === "version" ? ["--version"] : ["-m", "pip", "list", "--format=json"];
    const pinned = approved.programs.get(filename);
    if (!pinned || trace.program !== (trace.kind === "size" ? "du" : entry.python)
      || !isDeepStrictEqual(trace.args, args) || !isDeepStrictEqual(executable(filename), pinned))
      throw new Error("Native Environment query executable/arguments changed.");
  };
  try {
    current(); unregisterParent = options.rootChildren.register(close);
    options.rootChildren.signal.addEventListener("abort", revoked, { once: true });
    options.hostAdmission.denySignal.addEventListener("abort", revoked, { once: true });
    current();
  } catch (error) {
    unregisterParent(); options.rootChildren.signal.removeEventListener("abort", revoked);
    options.hostAdmission.denySignal.removeEventListener("abort", revoked); throw error;
  }
  return Object.freeze({
    owner, hostSession, signal: controller.signal, assertCurrent: current, close,
    async acquireEffects(intent: Readonly<OrdinaryEnvironmentRefreshIntent>, lifetime: Lifetime) {
      current();
      const native = require("./ordinary-environment-vscode-authority") as typeof import("./ordinary-environment-vscode-authority");
      native.assertNativeOrdinaryEnvironmentRefreshIntent(intent, lifetime);
      if (intent.workspaceId !== workspaceId || intent.knowledgeRoot !== binding.knowledgeRoot
        || intent.globalStorageDirectory !== binding.globalStorageDirectory || queries.has(intent.requestId)
        || intent.operation === "packages" && intent.environments.some(row => !["venv", "uv"].includes(row.manager)))
        throw new Error("Native legacy Environment Refresh binding/manager is unsupported or already consumed.");
      const programs = new Map<string, ReturnType<typeof executable>>();
      for (const entry of intent.environments) programs.set(entry.python, executable(entry.python));
      if (intent.operation === "metadata") programs.set("/usr/bin/du", executable("/usr/bin/du"));
      if (!kernelWriter) {
        kernelWriter = acquireNativeEnvironmentProfileWriter({ binding, hostFence, dispatchPause: options.dispatchPause,
          intent, lifetime, supervisorPython: helper.canonical });
        try {
          managedWriter = attachOrdinaryEnvironmentRootProfileWriter({ binding, profileUri: options.profileUri,
            registration: options.registration, hostAdmission: options.hostAdmission,
            scopeSignal: controller.signal, supervisorPython: helper.canonical, environment,
            profileWriter: { scope: "ordinary-environments:refresh-profile-writer",
              assertCurrent(expected) {
                try { assertNativeEnvironmentProfileWriter(kernelWriter!, expected); }
                catch (error) { kernelFailure = error; throw error; }
              } },
            assertExecutionAuthority: assertExecution,
            registerRootChildClose: child => options.rootChildren.register(child),
            registerEnvironmentChildClose: registerEnvironment, onCloseError: options.onCloseError });
        } catch (error) { kernelWriter.close(); kernelWriter = undefined; throw error; }
      }
      try { assertNativeEnvironmentProfileWriter(kernelWriter, binding); }
      catch (error) { kernelFailure = error; throw error; }
      queries.set(intent.requestId, { intent, lifetime, programs });
      return managedWriter!.acquireLegacyEffects(intent, lifetime);
    },
  });
}
