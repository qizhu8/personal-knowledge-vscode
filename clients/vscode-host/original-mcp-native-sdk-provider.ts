import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { originalMcpExtensionId } from "../../src/original-mcp-profile-binding.js";
import {
  assertOriginalSdkReadonlyMount, createOriginalMcpNativeSdkHostControl,
  originalSdkCatalogueControlReason, verifyOriginalSdkPrivateSelection,
  type OriginalSdkImmutableSelection,
} from "./original-mcp-native-sdk-control.js";

type FactoryOptions = Parameters<typeof createOriginalMcpNativeSdkHostControl>[0];
export interface OriginalSdkNativeProviderDescriptor {
  readonly kind: "pkm.vscode-sdk-provider-selection/v1";
  readonly selectionSha256: string;
  readonly provider: "copilot-sdk";
  readonly catalogue: "unqualified-cli-control";
}
type Selected = Pick<FactoryOptions, "sdk" | "selection" | "clientOptions" | "profileRoot" | "accountToken"> & {
  python: string; supervisor: string; supervisorSha256: string; consumed: boolean;
  assertCurrent(): void; dispose(): Promise<void>;
};
const selected = new WeakMap<object, Selected>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const unavailable: () => never = () => { throw new Error("NATIVE_SDK_HOST_SELECTION_UNAVAILABLE"); };

/** Native UI selection only, not a Core grant or an assertion that the official SDK catalogue works. */
export async function selectOriginalMcpNativeSdkProvider(context: vscode.ExtensionContext, options: {
  signal: AbortSignal; assertCurrent(): void; reportFailure(error: Error): void;
}): Promise<null | { descriptor: OriginalSdkNativeProviderDescriptor; reason: typeof originalSdkCatalogueControlReason;
  dispose(): Promise<void> }> {
  const activation = vscode.extensions.getExtension(context.extension.id);
  const current = () => {
    options.assertCurrent(); options.signal.throwIfAborted();
    if (context.extension.id !== originalMcpExtensionId
      || context.extensionMode !== vscode.ExtensionMode.Production || !vscode.workspace.isTrusted
      || !activation?.isActive || activation.extensionPath !== context.extensionPath
      || typeof activation.exports?.assertActiveMigrationContext !== "function") unavailable();
    activation.exports.assertActiveMigrationContext(context);
  };
  current();
  const choose = async (title: string, folders = false) => {
    const choice = await vscode.window.showOpenDialog({ title, canSelectFiles: !folders,
      canSelectFolders: folders, canSelectMany: false });
    current();
    if (!choice?.[0] || choice[0].scheme !== "file") unavailable();
    return realpath(choice[0].fsPath);
  };
  const answer = await vscode.window.showWarningMessage("Select a private SDK Host provider configuration?", {
    modal: true, detail: "Select readonly public SDK/runtime files, a protected Python interpreter and a private profile parent. No login, old profile/config/credential copy, model selection or business permission is performed. Official SDK catalogue routing is currently unqualified.",
  }, "Select exact private SDK configuration");
  current();
  if (answer !== "Select exact private SDK configuration") return null;
  const moduleManifest = await choose("Select the public @github/copilot-sdk package.json");
  const runtimeManifest = await choose("Select the matching SDK runtime package.json");
  const runtimeFile = await choose("Select the exact SDK runtime executable (metadata inspection only)");
  const python = await choose("Select the protected Python interpreter for the SDK supervisor");
  const parent = await choose("Select a private parent directory for a fresh SDK-only profile", true);
  const parentStat = await lstat(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.uid !== BigInt(process.getuid!()) || (parentStat.mode & 0o077n) !== 0n) unavailable();
  await assertOriginalSdkReadonlyMount(moduleManifest);
  await assertOriginalSdkReadonlyMount(runtimeManifest);
  await assertOriginalSdkReadonlyMount(runtimeFile);
  const manifest = JSON.parse(await readFile(moduleManifest, "utf8"));
  const runtimeMetadata = JSON.parse(await readFile(runtimeManifest, "utf8"));
  if (manifest.name !== "@github/copilot-sdk" || manifest.version !== "1.0.34"
    || runtimeMetadata.version !== manifest.version || !runtimeMetadata.name?.startsWith("@github/copilot-sdk-")) unavailable();
  const require = createRequire(moduleManifest), moduleFile = await realpath(require.resolve("@github/copilot-sdk"));
  if (relative(dirname(moduleManifest), moduleFile).startsWith(`..${sep}`)) unavailable();
  await assertOriginalSdkReadonlyMount(moduleFile);
  const consent = await vscode.window.showWarningMessage("Use these exact SDK public modules and private runtime boundaries?", {
    modal: true, detail: JSON.stringify({ moduleManifest, moduleFile, runtimeManifest, runtimeFile, python, privateParent: parent,
      catalogue: originalSdkCatalogueControlReason.message,
      permission: "This selection authorizes no model sending, tool effect, role, human approval or automatic sign-in." }, null, 2),
  }, "Use this exact SDK Host configuration");
  current();
  if (consent !== "Use this exact SDK Host configuration") return null;
  const sdk: typeof import("@github/copilot-sdk") = require(moduleFile);
  const runtime = await lstat(runtimeFile, { bigint: true });
  const selection: OriginalSdkImmutableSelection = {
    moduleFile, moduleSha256: hash(await readFile(moduleFile)), moduleManifest,
    manifestSha256: hash(await readFile(moduleManifest)), runtimeFile, runtimeManifest,
    runtimeManifestSha256: hash(await readFile(runtimeManifest)),
    runtimeIdentity: { dev: String(runtime.dev), ino: String(runtime.ino), size: String(runtime.size),
      mtimeNs: String(runtime.mtimeNs), ctimeNs: String(runtime.ctimeNs) },
  };
  const supervisor = join(context.extensionPath, "dist/original-mcp-native-sdk-supervisor.py");
  const build = JSON.parse(await readFile(join(context.extensionPath, "dist/host-build.json"), "utf8"));
  const supervisorSha256 = hash(await readFile(supervisor));
  if (build.files?.["original-mcp-native-sdk-supervisor.py"] !== supervisorSha256) unavailable();
  await assertOriginalSdkReadonlyMount(supervisor);
  const profileRoot = join(parent, `sdk-provider-${randomUUID()}`);
  await mkdir(profileRoot, { mode: 0o700 });
  const profilePin = await lstat(profileRoot, { bigint: true });
  let closed = false, disposal: Promise<void> | undefined;
  let detach = () => {};
  const dispose = () => disposal ??= (async () => {
    closed = true;
    detach();
    const named = await lstat(profileRoot, { bigint: true });
    if (!named.isDirectory() || named.dev !== profilePin.dev || named.ino !== profilePin.ino) unavailable();
    await rm(profileRoot, { recursive: true });
  })();
  try {
    const directories = Object.fromEntries(["home", "data", "work", "config", "cache", "state", "scratch"]
      .map(name => [name, join(profileRoot, name)]));
    for (const directory of Object.values(directories)) await mkdir(directory, { mode: 0o700 });
    const clientOptions: FactoryOptions["clientOptions"] = {
      mode: "empty", useLoggedInUser: false, logLevel: "error", connection: { kind: "stdio", path: runtimeFile },
      baseDirectory: directories.data, workingDirectory: directories.work,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directories.home!,
        XDG_CONFIG_HOME: directories.config!, XDG_CACHE_HOME: directories.cache!, XDG_DATA_HOME: directories.data!,
        XDG_STATE_HOME: directories.state!, TMPDIR: directories.scratch! },
    };
    await verifyOriginalSdkPrivateSelection({ sdk, selection, clientOptions, profileRoot, fixtureProbe: false });
    current();
    const existing = await vscode.authentication.getSession("github", ["user:email"], { silent: true });
    current();
    if (!existing) unavailable();
    const accountId = existing.account.id, sessionId = existing.id;
    const accountConsent = await vscode.window.showWarningMessage("Use this already-authorized current account for this SDK Host?", {
      modal: true, detail: `${existing.account.label}\nNo new session/login or copied account grant. Account/session changes require a new explicit selection. The official SDK catalogue remains unqualified; no model is started by this selection.`,
    }, "Use this existing account");
    current();
    if (accountConsent !== "Use this existing account") { await dispose(); return null; }
    const descriptor: OriginalSdkNativeProviderDescriptor = Object.freeze({
      kind: "pkm.vscode-sdk-provider-selection/v1", provider: "copilot-sdk", catalogue: "unqualified-cli-control",
      selectionSha256: hash(Buffer.from(JSON.stringify({ selection, clientOptions }))),
    });
    const entry: Selected = {
      sdk, selection, clientOptions, profileRoot, python, supervisor, supervisorSha256, consumed: false,
      assertCurrent() { current(); if (closed) unavailable(); },
      async accountToken(_interactiveRequested, signal) {
        entry.assertCurrent(); signal.throwIfAborted();
        const fresh = await vscode.authentication.getSession("github", ["user:email"], { silent: true });
        entry.assertCurrent(); signal.throwIfAborted();
        if (!fresh || fresh.id !== sessionId || fresh.account.id !== accountId) unavailable();
        return fresh.accessToken;
      },
      dispose,
    };
    selected.set(descriptor, entry);
    const abort = () => {
      if (entry.consumed || closed) return;
      void dispose().catch(error => {
        try { options.reportFailure(error); }
        catch { try { console.error("NATIVE_SDK_SELECTION_CLEANUP_FAILED: inspect the native provider's private selection."); } catch {} }
      });
    };
    detach = () => options.signal.removeEventListener("abort", abort);
    options.signal.addEventListener("abort", abort, { once: true });
    context.subscriptions.push({ dispose: abort });
    if (options.signal.aborted) abort();
    return Object.freeze({ descriptor, reason: originalSdkCatalogueControlReason,
      async dispose() { if (entry.consumed) unavailable(); await entry.dispose(); } });
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "NATIVE_SDK_SELECTION_CLEANUP_FAILED", { cause: error }); }
    throw error;
  }
}

/** Parent attaches the real current Host binding and managed-child registry; JSON copies are never selections. */
export async function createOriginalMcpNativeSdkProviderFromSelection(descriptor: OriginalSdkNativeProviderDescriptor,
  binding: Pick<FactoryOptions, "host" | "retained" | "epoch" | "hostReceiptSha256" | "sourcePlanSha256"
    | "assertCurrent" | "assertDestination" | "approveBoundary" | "signal"> & {
    registerChild(close: () => Promise<void>): () => void; reportFailure(error: Error): void;
  }) {
  const entry = selected.get(descriptor);
  if (!entry || entry.consumed) unavailable();
  try { entry.assertCurrent(); binding.assertCurrent(); }
  catch (error) {
    try { await entry.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "NATIVE_SDK_SELECTION_CLEANUP_FAILED", { cause: error }); }
    throw error;
  }
  entry.consumed = true;
  try {
    const resource = await createOriginalMcpNativeSdkHostControl({
      ...binding, ...entry, assertCurrent() { entry!.assertCurrent(); binding.assertCurrent(); },
      egress: { python: entry!.python, supervisor: entry!.supervisor, supervisorSha256: entry!.supervisorSha256,
        registerChild: binding.registerChild, reportFailure: binding.reportFailure },
    });
    return Object.freeze({ ...resource, async close() {
      await resource.close(); await entry.dispose();
    } });
  } catch (error) {
    try { binding.reportFailure(error instanceof Error ? error : new Error("NATIVE_SDK_PROVIDER_STARTUP_FAILED", { cause: error })); }
    catch (notification) { throw new AggregateError([error, notification], "NATIVE_SDK_PROVIDER_NOTIFICATION_FAILED", { cause: error }); }
    throw error;
  }
}
