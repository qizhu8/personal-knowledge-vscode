import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import type { OriginalSdkHostControl } from "./original-mcp-native-sdk-chat.js";
import { OriginalSdkForwardingError, originalSdkClientOptionsDigest } from "./original-mcp-native-sdk-forwarding.js";
import { createOriginalSdkEgressOwner } from "./original-mcp-native-sdk-egress.js";

export const originalSdkNoBypassReason = Object.freeze({
  code: "NATIVE_SDK_NO_UNINTERCEPTED_SENDING_PROOF" as const,
  message: "The selected SDK exposes registration success but no enforced no-bypass sending capability. HTTP/WebSocket conformance alone cannot authorize SDK model work.",
});
export const originalSdkCatalogueControlReason = Object.freeze({
  code: "NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED" as const,
  message: "SDK models.list is a CLI control RPC, not an awaited model-sending hook. An official account-bound Host catalogue path is unqualified; no Auto model or catalogue is invented.",
});
export interface OriginalSdkImmutableSelection {
  moduleFile: string; moduleSha256: string; moduleManifest: string; manifestSha256: string;
  runtimeFile: string; runtimeManifest: string; runtimeManifestSha256: string;
  runtimeIdentity: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const permittedEnvironment = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP",
  "ELECTRON_RUN_AS_NODE", "NODE_EXTRA_CA_CERTS"]);
const privateEnvironment = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR"] as const;
function incompatible(): never { throw new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent"); }
const ownedControls = new WeakMap<object, { current(): void; module: OriginalSdkHostControl["sdk"];
  configSha256: string; prepareClient?: OriginalSdkHostControl["prepareClient"]; admission: OriginalSdkHostControl["runtimeAdmission"] }>();
const ownedAdmissions = new WeakMap<object, { current(): void; module: OriginalSdkHostControl["sdk"];
  configSha256: string; prepareClient?: OriginalSdkHostControl["prepareClient"] }>();
export const assertOriginalSdkOwnedHostControl = (control: OriginalSdkHostControl) =>
  assertOriginalSdkOwnedHostControlCurrent(control);
export function assertOriginalSdkOwnedHostControlCurrent(control: OriginalSdkHostControl): void {
  const owned = ownedControls.get(control) ?? ownedAdmissions.get(control.runtimeAdmission);
  if (!owned || owned.module !== control.sdk || owned.prepareClient !== control.prepareClient
    || owned.configSha256 !== originalSdkClientOptionsDigest(control.clientOptions)) incompatible();
  owned!.current();
}
export async function assertOriginalSdkReadonlyMount(file: string) {
  const mounts = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n").map(line => {
    const fields = line.split(" "), path = fields[4]!.replace(/\\([0-7]{3})/g, (_all, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)));
    return { path, readonly: fields[5]!.split(",").includes("ro") };
  }).filter(mount => file === mount.path || file.startsWith(mount.path.endsWith("/") ? mount.path : `${mount.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  if (!mounts[0]?.readonly) incompatible();
}

/** Validates selected public JS and runtime identity without reading a platform binary or any account material. */
export async function verifyOriginalSdkPrivateSelection(options: {
  sdk: OriginalSdkHostControl["sdk"]; selection: OriginalSdkImmutableSelection;
  profileRoot: string; clientOptions: Readonly<CopilotClientOptions>; fixtureProbe: boolean;
}) {
  const { selection, clientOptions: config } = options;
  if (Object.keys(config).some(key => !["connection", "mode", "baseDirectory", "workingDirectory", "env",
    "logLevel", "useLoggedInUser"].includes(key))
    || !isAbsolute(options.profileRoot) || config.mode !== "empty" || config.useLoggedInUser !== false
    || config.gitHubToken || config.entra || config.sessionFs || config.builtinPluginDirectories?.length
    || !config.connection || config.connection.kind !== "stdio" || config.connection.path !== selection.runtimeFile
    || config.connection.args?.length || config.connection.env || !config.env
    || Object.keys(config.env).some(key => !permittedEnvironment.has(key))
    || !config.env.PATH || !config.baseDirectory || !config.workingDirectory) incompatible();
  if (!options.fixtureProbe && config.env.NODE_EXTRA_CA_CERTS) incompatible();
  const profile = await lstat(options.profileRoot, { bigint: true });
  if (await realpath(options.profileRoot) !== options.profileRoot || !profile.isDirectory()
    || profile.uid !== BigInt(process.getuid!()) || (profile.mode & 0o077n) !== 0n) incompatible();
  const extraScratch = ["TMP", "TEMP"].flatMap(key => config.env![key] ? [config.env![key]!] : []);
  for (const name of [config.baseDirectory, config.workingDirectory, ...privateEnvironment.map(key => config.env![key]), ...extraScratch]) {
    const path = name ? relative(options.profileRoot, name) : "";
    if (!name || !isAbsolute(name) || !path || path === ".." || isAbsolute(path)
      || path.startsWith(`..${sep}`) || await realpath(name) !== name) incompatible();
    const info = await lstat(name, { bigint: true });
    if (!info.isDirectory() || info.uid !== profile.uid || (info.mode & 0o077n) !== 0n) incompatible();
  }
  for (const [file, expected] of [[selection.moduleFile, selection.moduleSha256],
    [selection.moduleManifest, selection.manifestSha256], [selection.runtimeManifest, selection.runtimeManifestSha256]]) {
    if (!isAbsolute(file) || await realpath(file) !== file || hash(await readFile(file)) !== expected) incompatible();
    await assertOriginalSdkReadonlyMount(file);
  }
  const manifest = JSON.parse(await readFile(selection.moduleManifest, "utf8"));
  const runtimeManifest = JSON.parse(await readFile(selection.runtimeManifest, "utf8"));
  if (manifest.name !== "@github/copilot-sdk" || manifest.version !== "1.0.34"
    || runtimeManifest.version !== manifest.version || !runtimeManifest.name.startsWith("@github/copilot-sdk-")
    || !selection.moduleFile.startsWith(`${dirname(selection.moduleManifest)}${sep}`)
    || !selection.runtimeFile.startsWith(`${dirname(selection.runtimeManifest)}${sep}`)) incompatible();
  const runtime = await lstat(selection.runtimeFile, { bigint: true });
  await assertOriginalSdkReadonlyMount(selection.runtimeFile);
  if (!runtime.isFile() || await realpath(selection.runtimeFile) !== selection.runtimeFile
    || (runtime.mode & 0o111n) === 0n
    || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key =>
      String(runtime[key as keyof typeof runtime]) !== selection.runtimeIdentity[key as keyof typeof selection.runtimeIdentity])) incompatible();
  if (config.env.NODE_EXTRA_CA_CERTS) {
    const cert = config.env.NODE_EXTRA_CA_CERTS;
    if (await realpath(cert) !== cert || !cert.startsWith(`${options.profileRoot}${sep}`)) incompatible();
    const info = await lstat(cert, { bigint: true });
    if (!info.isFile() || info.uid !== profile.uid || (info.mode & 0o022n) !== 0n) incompatible();
  }
  const loaded = await import(pathToFileURL(selection.moduleFile).href);
  const actual = loaded.default ?? loaded;
  for (const key of ["CopilotClient", "CopilotRequestHandler", "CopilotWebSocketForwarder", "RuntimeConnection", "defineTool"] as const)
    if (actual[key] !== options.sdk[key]) incompatible();
  return Object.freeze({ moduleVersion: manifest.version as string, configSha256: originalSdkClientOptionsDigest(config) });
}

export async function assertOriginalSdkConformanceIsolation(parentNetworkNamespace: string) {
  const network = await readFile("/proc/self/uid_map", "utf8"), { readlink } = await import("node:fs/promises");
  const ownNamespace = await readlink("/proc/self/ns/net");
  const mapping = network.trim().split(/\s+/);
  if (process.env.PKM_TEST_ISOLATED_NETWORK !== "1" || ownNamespace === parentNetworkNamespace
    || mapping.length !== 3 || mapping[0] !== String(process.getuid!()) || mapping[2] !== "1"
    || Number(mapping[1]) <= 0
    || Object.values(networkInterfaces()).flat().some(address => !address?.internal)) incompatible();
  return ownNamespace;
}

/** Host-owned denial port: genuine public startup observations never become a fabricated all-sending capability. */
export async function createOriginalMcpNativeSdkHostControl(options: {
  sdk: OriginalSdkHostControl["sdk"]; selection: OriginalSdkImmutableSelection; profileRoot: string;
  clientOptions: Readonly<CopilotClientOptions>; host: OriginalSdkHostControl["host"];
  retained: OriginalSdkHostControl["retained"]; epoch: string; hostReceiptSha256: string; sourcePlanSha256: string;
  assertCurrent(): void; accountToken: OriginalSdkHostControl["accountToken"];
  assertDestination: OriginalSdkHostControl["assertDestination"];
  approveBoundary: OriginalSdkHostControl["approveBoundary"]; signal: AbortSignal;
  fixtureProbe?: { parentNetworkNamespace: string };
  egress?: { python: string; supervisor: string; supervisorSha256: string;
    registerChild(close: () => Promise<void>): () => void; reportFailure?(error: Error): void };
}) {
  options = { ...options, selection: structuredClone(options.selection),
    clientOptions: structuredClone(options.clientOptions), ...(options.egress ? { egress: { ...options.egress } } : {}) };
  options.assertCurrent(); options.signal.throwIfAborted();
  const config = structuredClone(options.clientOptions);
  const identity = await verifyOriginalSdkPrivateSelection({ ...options, clientOptions: config, fixtureProbe: !!options.fixtureProbe });
  if (options.egress) await assertOriginalSdkReadonlyMount(options.egress.supervisor);
  const egress = options.egress ? await createOriginalSdkEgressOwner({
    ...options.egress, selection: options.selection, profileRoot: options.profileRoot, baseOptions: config,
    assertCurrent: options.assertCurrent, signal: options.signal,
  }) : undefined;
  try {
  let startup: { registered: boolean; runtimeVersion: string; protocolVersion: number } | null = null;
  if (egress) {
    if (options.fixtureProbe) await assertOriginalSdkConformanceIsolation(options.fixtureProbe.parentNetworkNamespace);
    class RejectModelWork extends options.sdk.CopilotRequestHandler {
      protected override async sendRequest(): Promise<Response> { return incompatible(); }
      protected override async openWebSocket(): Promise<InstanceType<typeof options.sdk.CopilotWebSocketForwarder>> { return incompatible(); }
    }
    const launch = await egress.reserve();
    let client: InstanceType<typeof options.sdk.CopilotClient> | undefined;
    try {
      client = new options.sdk.CopilotClient({ ...launch.clientOptions, requestHandler: new RejectModelWork() });
      const currentClient = client;
      launch.bindClient(() => currentClient.stop());
      await client.start();
      await launch.ready();
      const result = await client.rpc.llmInference.setProvider(), status = await client.getStatus();
      if (result.success !== true) incompatible();
      startup = { registered: result.success === true, runtimeVersion: status.version, protocolVersion: status.protocolVersion };
    } catch {
      return incompatible();
    } finally {
      try { await client?.stop(); } finally { await launch.close(); }
    }
  }
  options.assertCurrent(); options.signal.throwIfAborted();
  await verifyOriginalSdkPrivateSelection({ ...options, clientOptions: config, fixtureProbe: !!options.fixtureProbe });
  const control: OriginalSdkHostControl = {
    ...options, clientOptions: config,
    ...(egress ? { prepareClient: egress.reserve, unavailableReason: originalSdkCatalogueControlReason }
      : { unavailableReason: originalSdkNoBypassReason }),
    runtimeAdmission: {
      assertCurrent(module, _requirements, supplied) {
        options.assertCurrent(); options.signal.throwIfAborted();
        if (module !== options.sdk || originalSdkClientOptionsDigest(supplied) !== identity.configSha256) incompatible();
        if (egress) { egress.assertCurrent(); return; }
        throw Object.assign(new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent"), { reasonCode: originalSdkNoBypassReason.code });
      },
    },
    async accountToken(interactiveRequested, signal) {
      assertOriginalSdkOwnedHostControlCurrent(control);
      return options.accountToken(interactiveRequested, signal);
    },
  };
  Object.freeze(control.runtimeAdmission);
  Object.freeze(control.clientOptions.connection);
  Object.freeze(control.clientOptions.env);
  Object.freeze(control.clientOptions);
  Object.freeze(control);
  const record = { module: options.sdk, configSha256: identity.configSha256, prepareClient: control.prepareClient,
    admission: control.runtimeAdmission, current() {
    options.assertCurrent(); options.signal.throwIfAborted();
    if (originalSdkClientOptionsDigest(control.clientOptions) !== identity.configSha256) incompatible();
    if (!egress) throw Object.assign(new OriginalSdkForwardingError("NATIVE_SDK_RUNTIME_INCOMPATIBLE", "not-sent"), { reasonCode: originalSdkNoBypassReason.code });
    egress.assertCurrent();
  } };
  ownedControls.set(control, record);
  ownedAdmissions.set(control.runtimeAdmission, record);
  return Object.freeze({ status: egress ? "awaited-host-forwarding-supported" as const : "unsupported" as const,
    reason: egress ? null : originalSdkNoBypassReason, catalogueReason: originalSdkCatalogueControlReason,
    identity, startup, control, close: async () => egress?.close() });
  } catch (error) {
    try { await egress?.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "NATIVE_SDK_HOST_CONTROL_CLEANUP_FAILED", { cause: error }); }
    throw error;
  }
}
