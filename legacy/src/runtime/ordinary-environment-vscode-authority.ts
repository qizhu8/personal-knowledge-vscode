import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getStorePath } from "../knowledge/filestore";
import type { OrdinaryEnvironmentReadAuthority, OrdinaryEnvironmentReadBinding,
  OrdinaryEnvironmentRefreshIntent, OrdinaryEnvironmentRefreshPermit } from "./ordinary-environment-owner";

type HostBinding = Readonly<{
  knowledgeRoot: string; globalStorageDirectory: string; workspaceId: string; sessionId: string;
}>;
export type OrdinaryEnvironmentVscodeHost = {
  knowledgeRoot: string; workspaceId: string; sessionId: string;
  signal: AbortSignal;
  assertCurrent(binding: HostBinding): void;
};
export type OrdinaryEnvironmentManagedEffects = Pick<OrdinaryEnvironmentRefreshPermit,
  "environment" | "supervisorPython" | "registerPreparedExecution" | "finishRefresh" | "assertProfileWriter" | "assertExecution" | "recordExecution" | "verifyDrained" | "withProfileWrite"> & {
  signal: AbortSignal;
  claim(intent: Readonly<OrdinaryEnvironmentRefreshIntent>): void;
  assertCurrent(effect: "probe" | "execute" | "commit", id: string, kind: Parameters<OrdinaryEnvironmentRefreshPermit["assertCurrent"]>[2]): void;
};

function fence(callback: () => unknown): void {
  const value = callback();
  if (value !== undefined) {
    if (value && typeof (value as PromiseLike<unknown>).then === "function")
      void Promise.resolve(value).catch(() => {});
    throw new Error("Environment host/permission fence must synchronously return undefined.");
  }
}

const nativeRefreshIntents = new WeakMap<Readonly<OrdinaryEnvironmentRefreshIntent>, {
  signal: AbortSignal; expiresAtMs: number; assertCurrent(): void;
}>();

export function assertNativeOrdinaryEnvironmentRefreshIntent(intent: Readonly<OrdinaryEnvironmentRefreshIntent>,
  lifetime: Readonly<{ signal: AbortSignal; expiresAtMs: number }>): void {
  const entry = nativeRefreshIntents.get(intent);
  if (!entry || entry.signal !== lifetime.signal || entry.expiresAtMs !== lifetime.expiresAtMs)
    throw new Error("An exact independently approved native Environment Refresh intent is required.");
  entry.assertCurrent();
}

function awaitPrompt<T>(prompt: Thenable<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Environment UI approval was revoked.")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(prompt).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function nativeLifetime(context: vscode.ExtensionContext, host: OrdinaryEnvironmentVscodeHost, lifetimeMs: number) {
  if (!host || !path.isAbsolute(host.knowledgeRoot) || path.resolve(host.knowledgeRoot) !== host.knowledgeRoot
    || !host.workspaceId || !host.sessionId || !host.signal || typeof host.assertCurrent !== "function")
    throw new Error("Environment approval requires a trusted current owner host.");
  const hostSignal = host.signal, assertHostCurrent = host.assertCurrent.bind(host);
  const binding: HostBinding = Object.freeze({ knowledgeRoot: host.knowledgeRoot,
    globalStorageDirectory: context.globalStorageUri.fsPath, workspaceId: host.workspaceId, sessionId: host.sessionId });
  const identity = (directory: string) => {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || fs.realpathSync(directory) !== directory)
      throw new Error("Environment approval requires canonical Root/profile directories.");
    const info = fs.lstatSync(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Environment approval directory is unavailable.");
    return `${info.dev}:${info.ino}`;
  };
  const rootPin = identity(binding.knowledgeRoot), profilePin = identity(binding.globalStorageDirectory);
  if (binding.globalStorageDirectory === binding.knowledgeRoot
    || binding.globalStorageDirectory.startsWith(binding.knowledgeRoot + path.sep))
    throw new Error("Environment profile must be separate from the Knowledge Root.");
  const controller = new AbortController(), expiresAtMs = Date.now() + lifetimeMs;
  const subscriptions: vscode.Disposable[] = [];
  let registration: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispose = () => {
    controller.abort();
    if (timer) { clearInterval(timer); timer = undefined; }
    hostSignal.removeEventListener("abort", dispose);
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    if (registration) {
      const index = context.subscriptions.indexOf(registration);
      if (index >= 0) context.subscriptions.splice(index, 1);
      registration = undefined;
    }
  };
  const localCheck = () => {
    if (controller.signal.aborted || hostSignal.aborted || Date.now() >= expiresAtMs
      || !vscode.workspace.isTrusted || getStorePath() !== binding.knowledgeRoot
      || context.globalStorageUri.fsPath !== binding.globalStorageDirectory
      || identity(binding.knowledgeRoot) !== rootPin || identity(binding.globalStorageDirectory) !== profilePin)
      throw new Error("Environment UI approval was revoked or its Root/profile changed.");
  };
  const check = () => { localCheck(); fence(() => assertHostCurrent(binding)); localCheck(); };
  try {
    hostSignal.addEventListener("abort", dispose, { once: true });
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(dispose));
    subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("personalKnowledge")) dispose();
    }));
    check();
    timer = setInterval(() => { try { check(); } catch { dispose(); } }, 200);
    timer.unref();
    return { binding, check, dispose, signal: controller.signal, expiresAtMs,
      register(disposable: vscode.Disposable) { registration = disposable; context.subscriptions.push(disposable); } };
  } catch (error) { dispose(); throw error; }
}

/** Native UI consent is profile access, not execution or original-profile writer ownership. */
export async function requestOrdinaryEnvironmentReadAuthority(context: vscode.ExtensionContext, host: OrdinaryEnvironmentVscodeHost):
Promise<(OrdinaryEnvironmentReadAuthority & vscode.Disposable) | undefined> {
  const life = nativeLifetime(context, host, 300_000);
  try {
    const answer = await awaitPrompt(vscode.window.showWarningMessage("Allow this owner to read the original Environments profile?",
      { modal: true, detail: `Knowledge Root: ${JSON.stringify(life.binding.knowledgeRoot)}\nProfile: ${JSON.stringify(life.binding.globalStorageDirectory)}\n`
        + `Owner session: ${life.binding.sessionId}\nFive-minute read-only approval. Refresh, processes and profile writes require separate permission.` },
      "Allow Environment Reads"), life.signal);
    life.check();
    if (answer !== "Allow Environment Reads") { life.dispose(); return undefined; }
    const binding: OrdinaryEnvironmentReadBinding = Object.freeze({ workspaceId: life.binding.workspaceId,
      actorId: "local:owner", knowledgeRoot: life.binding.knowledgeRoot,
      globalStorageDirectory: life.binding.globalStorageDirectory, scope: "ordinary-environments:read-cache" });
    const authority = Object.freeze({ ...binding, signal: life.signal, dispose: life.dispose,
      assertCurrent(actual: Readonly<OrdinaryEnvironmentReadBinding>) {
        life.check();
        if (!isDeepStrictEqual(actual, binding)) throw new Error("Environment read approval binding does not match.");
        life.check();
      } });
    life.register(authority);
    return authority;
  } catch (error) { life.dispose(); throw error; }
}

/** Call only from the selected owner's UI dispatcher, never deserialize effects from message JSON. */
export async function requestOrdinaryEnvironmentRefreshIntent(context: vscode.ExtensionContext, options: {
  host: OrdinaryEnvironmentVscodeHost;
  intent: Omit<OrdinaryEnvironmentRefreshIntent, "requestId">;
}) {
  const life = nativeLifetime(context, options.host, 120_000);
  const dispose = life.dispose;
  try {
    const source = options.intent;
    if (!source || source.actorId !== "local:owner" || source.workspaceId !== life.binding.workspaceId
      || source.knowledgeRoot !== life.binding.knowledgeRoot || source.globalStorageDirectory !== life.binding.globalStorageDirectory
      || !["metadata", "packages"].includes(source.operation) || typeof source.refresh !== "boolean"
      || !Array.isArray(source.environments) || !source.environments.length || source.environments.length > 256
      || source.operation === "packages" && source.environments.length !== 1
      || source.operation === "metadata" && !source.refresh)
      throw new Error("Environment approval requires one exact ordinary UI operation.");
    const entries = source.environments.map(entry => {
      if (!entry || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id)
        || !path.isAbsolute(entry.path) || !path.isAbsolute(entry.python)
        || !["conda", "venv", "uv", "other"].includes(entry.manager))
        throw new Error("Environment approval target is invalid.");
      return Object.freeze({ id: entry.id, path: entry.path, python: entry.python, manager: entry.manager });
    });
    if (new Set(entries.map(entry => entry.id)).size !== entries.length)
      throw new Error("Environment approval targets are ambiguous.");
    const intent: Readonly<OrdinaryEnvironmentRefreshIntent> = Object.freeze({
      requestId: randomUUID(), workspaceId: source.workspaceId, actorId: "local:owner",
      knowledgeRoot: source.knowledgeRoot, globalStorageDirectory: source.globalStorageDirectory,
      operation: source.operation, refresh: source.refresh, environments: Object.freeze(entries),
    });
    const answer = await awaitPrompt(vscode.window.showWarningMessage("Refresh the selected original Environments through this owner?",
      { modal: true, detail: `Knowledge Root: ${JSON.stringify(intent.knowledgeRoot)}\nProfile: ${JSON.stringify(intent.globalStorageDirectory)}\n`
        + `Owner session: ${life.binding.sessionId}\nOperation: ${intent.operation}, refresh=${intent.refresh}\n`
        + entries.map(entry => `ID: ${entry.id}\nManager: ${entry.manager}\nPrefix: ${JSON.stringify(entry.path)}\nPython: ${JSON.stringify(entry.python)}`).join("\n\n")
        + "\nOne request, at most two minutes. Existing version/size/package queries and cache updates only; no installation, download or deletion."
        + "\nNative managed Refresh may acquire a cooperative profile lock through the installed Python helper."
        + " This covers enrolled callbacks, not unknown legacy or external writers." },
      "Refresh Selected Environments"), life.signal);
    life.check();
    if (answer !== "Refresh Selected Environments") { dispose(); return undefined; }
    nativeRefreshIntents.set(intent, { signal: life.signal, expiresAtMs: life.expiresAtMs, assertCurrent: life.check });
    let claimed = false;
    const approval = Object.freeze({ intent, signal: life.signal, expiresAtMs: life.expiresAtMs,
      dispose, assertCurrent: life.check,
      claim(actual: Readonly<OrdinaryEnvironmentRefreshIntent>) {
        life.check();
        if (claimed || !isDeepStrictEqual(actual, intent)) throw new Error("Environment UI intent is already consumed or changed.");
        claimed = true;
        life.check();
      } });
    life.register(approval);
    return approval;
  } catch (error) { dispose(); throw error; }
}

export async function requestOrdinaryEnvironmentRefreshPermit(context: vscode.ExtensionContext, options: {
  host: OrdinaryEnvironmentVscodeHost;
  intent: Omit<OrdinaryEnvironmentRefreshIntent, "requestId">;
  acquireEffects(intent: Readonly<OrdinaryEnvironmentRefreshIntent>,
    lifetime: Readonly<{ signal: AbortSignal; expiresAtMs: number }>): Promise<OrdinaryEnvironmentManagedEffects>;
}): Promise<(OrdinaryEnvironmentRefreshPermit & vscode.Disposable) | undefined> {
  if (typeof options.acquireEffects !== "function")
    throw new Error("Environment Refresh requires independent managed effects.");
  const approval = await requestOrdinaryEnvironmentRefreshIntent(context, options);
  if (!approval) return undefined;
  const { intent } = approval, entries = intent.environments;
  let effectSignal: AbortSignal | undefined;
  let registration: vscode.Disposable | undefined;
  const dispose = () => {
    effectSignal?.removeEventListener("abort", dispose); approval.dispose();
    if (registration) {
      const index = context.subscriptions.indexOf(registration);
      if (index >= 0) context.subscriptions.splice(index, 1);
      registration = undefined;
    }
  };
  try {
    const effects = await options.acquireEffects(intent, { signal: approval.signal, expiresAtMs: approval.expiresAtMs });
    effectSignal = effects?.signal;
    if (!effectSignal || typeof effectSignal.addEventListener !== "function"
      || ["claim", "assertCurrent", "assertProfileWriter", "assertExecution", "recordExecution", "verifyDrained", "withProfileWrite"]
        .some(name => typeof (effects as unknown as Record<string, unknown>)?.[name] !== "function")
      || !effects.environment?.PATH || !effects.environment.HOME || !effects.environment.TMPDIR)
      throw new Error("Refresh requires independent managed profile-writer and physical process-drain capabilities.");
    effectSignal.addEventListener("abort", dispose, { once: true });
    const check = () => { approval.assertCurrent(); if (effectSignal!.aborted) throw new Error("Environment effect authority was revoked."); };
    check();
    fence(() => effects.assertProfileWriter());
    check();
    let claimed = false;
    const permit = Object.freeze({
      intent, signal: approval.signal, expiresAtMs: approval.expiresAtMs, environment: Object.freeze({ ...effects.environment }), dispose,
      ...(effects.supervisorPython !== undefined ? {
        supervisorPython: effects.supervisorPython,
        registerPreparedExecution(prepared: Parameters<NonNullable<OrdinaryEnvironmentManagedEffects["registerPreparedExecution"]>>[0]) {
          check();
          if (!effects.registerPreparedExecution) throw new Error("A managed Environment registration is required.");
          fence(() => effects.registerPreparedExecution!(prepared)); check();
        },
      } : {}),
      claim(actual: Readonly<OrdinaryEnvironmentRefreshIntent>) {
        check();
        if (claimed || !isDeepStrictEqual(actual, intent)) throw new Error("Environment UI intent is already consumed or changed.");
        claimed = true;
        approval.claim(actual);
        fence(() => effects.claim(actual)); check();
      },
      assertCurrent(effect: Parameters<OrdinaryEnvironmentManagedEffects["assertCurrent"]>[0], id: string, kind: Parameters<OrdinaryEnvironmentManagedEffects["assertCurrent"]>[2]) {
        check();
        if (!claimed || !entries.some(entry => entry.id === id)
          || intent.operation === "packages" && kind !== "packages"
          || intent.operation === "metadata" && kind === "packages")
          throw new Error("Environment effect does not match the approved UI request.");
        fence(() => effects.assertCurrent(effect, id, kind)); check();
      },
      assertProfileWriter() { check(); fence(() => effects.assertProfileWriter()); check(); },
      assertExecution(trace: Parameters<OrdinaryEnvironmentManagedEffects["assertExecution"]>[0]) {
        check();
        if (!claimed || !trace || !isDeepStrictEqual(trace.intent, intent)
          || !entries.some(entry => entry.id === trace.environmentId)
          || intent.operation === "packages" && trace.kind !== "packages"
          || intent.operation === "metadata" && trace.kind === "packages")
          throw new Error("Environment execution does not match the approved UI request.");
        fence(() => effects.assertExecution(trace)); check();
      },
      recordExecution: effects.recordExecution.bind(effects),
      verifyDrained: effects.verifyDrained.bind(effects),
      ...(effects.finishRefresh ? { async finishRefresh(completion: Parameters<NonNullable<OrdinaryEnvironmentManagedEffects["finishRefresh"]>>[0]) {
        if (completion) check();
        await effects.finishRefresh!(completion);
        if (completion) check();
      } } : {}),
      async withProfileWrite(id: string, kind: Parameters<OrdinaryEnvironmentManagedEffects["assertCurrent"]>[2], write: () => void) {
        check();
        await effects.withProfileWrite(id, kind, () => { check(); write(); check(); });
        check();
      },
    });
    registration = permit; context.subscriptions.push(permit);
    return permit;
  } catch (error) { dispose(); throw error; }
}
