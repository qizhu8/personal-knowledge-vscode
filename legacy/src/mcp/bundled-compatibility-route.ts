import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_LIFECYCLE_SCHEMA, readManagedMcpManifest } from "./mcp-lifecycle";
import { verifyNextPayload } from "../runtime/next-payload-verifier";
import { acquireLinuxRootWriterFence, assertLinuxRootStillLegacyWritable } from "../runtime/linux-root-writer-fence";
import { MCP_ATTRIBUTION_ENV, managedMcpAttributionEnv } from "./mcp-attribution";
import { withPkmServiceNativeAdmission, type PkmServiceBootOptions } from "../runtime/pkm-service";

type Mode = "original" | "bundled-v5";
type Selection = { mode: Mode; selectionRevision: string };
type Custody = { kind: "owner" | "peer"; launchGrant?: string; assertHeld(): void; release(clean: boolean): Promise<void> };
type Authority = {
  relayIdentity: { generation: string; runtimeBuild: string };
  relay(role: "workbench" | "chat"): { origin: string; serviceId: string; token: string };
  status(): Promise<Selection & { generation: string; runtimeBuild: string; version: string; phase: string; inFlight: number; uncertain: boolean;
    backgroundActive?: number; authorityPid?: number;
    missingRelays: ("workbench" | "chat")[];
    candidates: { mode: Mode; generation: string; runtimeBuild: string; version: string }[] }>;
  approveSwitch(expected: Selection, mode: Mode,
    onDraining?: (status?: Awaited<ReturnType<Authority["status"]>>) => void | Promise<void>): Promise<{ applied: boolean }>;
  bindBrowserReads(): Promise<{
    generation: string; assertCurrent(): void; close(): Promise<void>;
    read(input: { operation: string; version: number; arguments: Record<string, unknown> }): Promise<unknown>;
  }> | {
    generation: string; assertCurrent(): void; close(): Promise<void>;
    read(input: { operation: string; version: number; arguments: Record<string, unknown> }): Promise<unknown>;
  };
  close(): Promise<void>;
};
const importPayload = new Function("url", "return import(url)") as (url: string) => Promise<any>;

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;
function pin(filename: string) {
  const resolved = fs.realpathSync(filename), stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw new Error("Compatibility runtime entry unavailable.");
  return { path: resolved, sha256: hash(fs.readFileSync(resolved)) };
}
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const ownerMarker = (root: string) => path.join(root, ".pkm/state/compatibility-gateway/owner-pending.json");
function hasPendingOwner(root: string) {
  if (!root || !path.isAbsolute(root)) return false;
  try { fs.lstatSync(ownerMarker(root)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createBundledCompatibilityRoute(options: {
  extensionPath: string; storage: string; executable?: string;
  root(): string; managed(): string; python(): string; assertAllowed(): void;
  startupStatus?(): { pending: boolean; error?: string };
  service?(): PkmServiceBootOptions;
  live?: { assertAdmittedRoot(): void; hasActiveChatWork(): boolean;
    confirm(review: { from: Mode; to: Mode; runtimeBuild: string }): Promise<boolean> };
}) {
  let selected: ReturnType<typeof select> | undefined;
  let phase: "pending" | "selected" | "unavailable" = "pending";
  let starting: Promise<Authority> | undefined;
  let workbenchRelay: ReturnType<Authority["relay"]> | undefined;
  let preparing: Promise<Custody> | undefined;
  let preparedRoot: string | undefined;
  let admissionError: unknown;
  let busy = false, disposed = false;
  function acquireLegacyFence(root: string) {
    assertLinuxRootStillLegacyWritable(root);
    let preflight;
    try { preflight = acquireLinuxRootWriterFence(root, "exclusive", 1_000); }
    catch (error) {
      const detail = error instanceof Error ? error.message : "Writer fence unavailable.";
      throw new Error(`Could not verify that cooperating Original writers have drained: ${detail}`);
    }
    try { preflight.assertHeld(); } finally { preflight.release(); }
    return acquireLinuxRootWriterFence(root, "shared", 1_000);
  }
  async function prepareCustody() {
    if (!options.live) return undefined;
    if (disposed) throw new Error("Compatibility gateway disposed.");
    options.live.assertAdmittedRoot();
    const root = options.root();
    if (preparing) {
      if (preparedRoot !== root) throw new Error("Native admission root changed; reload explicitly.");
      const custody = await preparing;
      custody.assertHeld();
      return custody;
    }
    preparedRoot = root;
    admissionError = undefined;
    preparing = (async () => {
      const selection = getSelected();
      const { reserveCompatibilityGatewayPeer } = await importPayload(
        pathToFileURL(path.join(selection.payload.root, "server/dist/compatibility-gateway-coordination.js")).href);
      const binding = { originalGeneration: selection.config.legacy.generation,
        originalBuild: selection.config.legacy.runtimeBuild, bundledBuild: selection.runtimeBuild };
      const reserve = () => reserveCompatibilityGatewayPeer(root, binding, {
        workbenchAttribution: {}, chatAttribution: {}, acquireLegacyFence,
        assertAllowed: selection.assertCurrent, hasActiveChatWork: options.live!.hasActiveChatWork,
        confirm: options.live!.confirm,
      }) as Promise<Custody>;
      if (hasPendingOwner(root)) {
        for (let count = 0; count < 40 && !fs.existsSync(path.join(root, ".pkm/state/compatibility-gateway/owner-live.json")); count++)
          await new Promise(resolve => setTimeout(resolve, 50));
        return reserve();
      }
      const boot = async (drain?: () => Promise<void>) => {
        if (hasPendingOwner(root)) return reserve();
        const entry = pin(path.join(selection.payload.root, "server/dist/compatibility-gateway-service-cli.js"));
        const nonce = randomBytes(32).toString("hex");
        const filename = path.join(selection.cwd, `service-${nonce}.json`);
        const bytes = JSON.stringify({ schema: "pkm.compatibility-gateway-service/v1", configuration: selection.config,
          extensionPath: options.extensionPath, payloadBuild: selection.payload.buildId, nonce,
          verifier: pin(path.join(options.extensionPath, "dist/runtime/next-payload-verifier.js")),
          fence: pin(path.join(options.extensionPath, "dist/runtime/linux-root-writer-fence.js")) });
        fs.writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" });
        const log = fs.openSync(path.join(selection.cwd, "service.log"),
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
        const logStat = fs.fstatSync(log);
        if (!logStat.isFile() || logStat.uid !== process.getuid?.() || (logStat.mode & 0o7777) !== 0o600 || logStat.nlink !== 1) {
          fs.closeSync(log); throw new Error("Compatibility service log must be a private owner-owned file.");
        }
        const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
        delete env[MCP_ATTRIBUTION_ENV];
        delete env.PKM_COMPATIBILITY_CUSTODY_GRANT;
        delete env.PKM_COMPATIBILITY_LAUNCH_GRANT;
        delete env.PKM_SHARED_TOKEN;
        const child = spawn(selection.command, [entry.path, filename, hash(bytes)], {
          cwd: selection.cwd, env, detached: true, stdio: ["ignore", log, log, "ipc"],
        });
        fs.closeSync(log);
        let requested = false;
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { child.send?.({ command: "abort", nonce }); reject(new Error("Compatibility service admission timed out; no second owner was started.")); }, 90_000);
            child.once("error", reject);
            child.once("exit", () => { clearTimeout(timeout); reject(new Error("Compatibility service admission failed. No fallback was started.")); });
            child.on("message", async input => {
              if (!input || typeof input !== "object" || !("nonce" in input) || input.nonce !== nonce || !("command" in input)) return;
              if (input.command === "drain") {
                if (requested) return;
                requested = true;
                try {
                  await drain?.(); selection.assertCurrent();
                  child.send?.({ command: "drained", nonce });
                } catch { child.send?.({ command: "refused", nonce }); }
              }
              if (input.command === "ready") { clearTimeout(timeout); resolve(); }
              if (input.command === "failed") {
                clearTimeout(timeout);
                reject(new Error("detail" in input ? String(input.detail) : "Compatibility service admission failed."));
              }
            });
          });
          const custody = await reserve();
          await new Promise<void>((resolve, reject) => child.send({ command: "committed", nonce }, error => error ? reject(error) : resolve()));
          child.disconnect(); child.unref();
          return custody;
        } catch (error) {
          if (child.connected) { child.send?.({ command: "abort", nonce }); child.disconnect(); }
          child.unref();
          if (hasPendingOwner(root)) {
            for (let count = 0; count < 40 && !fs.existsSync(path.join(root, ".pkm/state/compatibility-gateway/owner-live.json")); count++)
              await new Promise(resolve => setTimeout(resolve, 50));
            return reserve();
          }
          throw error;
        }
      };
      return options.service ? withPkmServiceNativeAdmission(options.service(), boot) : boot();
    })();
    try { return await preparing; }
    catch (error) {
      admissionError = error; phase = "unavailable";
      preparing = undefined; preparedRoot = undefined;
      throw error;
    }
  }
  function select() {
    options.assertAllowed();
    const root = options.root(), managed = options.managed();
    if (options.live) options.live.assertAdmittedRoot();
    const rootId = identity(fs.lstatSync(root));
    if (fs.realpathSync(root) !== root || fs.realpathSync(managed) !== managed)
      throw new Error("Compatibility selection requires canonical Original paths.");
    const original = readManagedMcpManifest(managed);
    if (!original) throw new Error("The Original managed generation is unavailable.");
    fs.mkdirSync(options.storage, { recursive: true, mode: 0o700 });
    const storage = fs.realpathSync(options.storage);
    const storageStat = fs.lstatSync(storage);
    if (!storageStat.isDirectory()) throw new Error(`Compatibility control is not a directory: ${storage}`);
    if (storageStat.uid !== process.getuid?.()) throw new Error(`Compatibility control is not owned by the current account: ${storage}`);
    if ((storageStat.mode & 0o022) !== 0) throw new Error(`Compatibility control is group/other writable: ${storage}`);
    if (inside(root, storage) || inside(storage, root))
      throw new Error(`Compatibility control overlaps the Knowledge Root: ${storage}`);
    const payload = verifyNextPayload(options.extensionPath);
    const node = pin(options.executable ?? process.execPath);
    const supervisor = pin(path.join(options.extensionPath, "resources/next_mcp_subreaper.py"));
    const entry = pin(path.join(payload.root, "server/dist/compatibility-mcp-cli.js"));
    const launcher = pin(path.join(managed, "server.py"));
    const python = options.python();
    const generation = randomUUID();
    const runtimeBuild = hash(JSON.stringify({ payload: payload.buildId, entry, node, supervisor,
      upstream: original.runtimeBuild, architecture: "v5-mcp-with-original-business-adapter", serverName: "pkm" }));
    const control = path.join(storage, `compatibility-${generation}`);
    fs.mkdirSync(control, { mode: 0o700 });
    const configPath = path.join(control, "adapter.json");
    const config = JSON.stringify({
      schema: "pkm.compatibility-mcp/v1", knowledgeRoot: root, managedRoot: control,
      node, supervisor, python,
      legacy: { launcher, generation: original.generation, runtimeBuild: original.runtimeBuild,
        version: original.version, components: original.components, compatibleUpdates: false },
      gateway: { generation, runtimeBuild }, serverName: "pkm", writable: true,
    });
    const active = JSON.stringify({ schema: MCP_LIFECYCLE_SCHEMA, generation });
    const digest = hash(config);
    fs.writeFileSync(configPath, config, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(control, "active-generation.json"), active, { flag: "wx", mode: 0o600 });
    const assertCurrent = () => {
      options.assertAllowed();
      options.live?.assertAdmittedRoot();
      const current = readManagedMcpManifest(managed);
      if (options.root() !== root || options.managed() !== managed || identity(fs.lstatSync(root)) !== rootId
        || current?.generation !== original.generation || current.runtimeBuild !== original.runtimeBuild
        || hash(fs.readFileSync(configPath)) !== digest || hash(fs.readFileSync(entry.path)) !== entry.sha256
        || fs.readFileSync(path.join(control, "active-generation.json"), "utf8") !== active)
        throw new Error("Bound compatibility gateway changed. No Original fallback; reload and verify explicitly.");
    };
    assertCurrent();
    return {
      command: node.path, args: [entry.path, configPath, digest], cwd: control,
      version: payload.version, generation, runtimeBuild, originalBuild: original.runtimeBuild,
      assertCurrent, payload, config: JSON.parse(config),
    };
  }
  function getSelected() {
    if (disposed) throw new Error("Compatibility gateway disposed.");
    selected ??= select();
    selected.assertCurrent();
    return selected;
  }
  async function startAuthority(selection: ReturnType<typeof select>): Promise<Authority> {
    const relay = pin(path.join(selection.payload.root, "server/dist/compatibility-gateway-relay.js"));
    const from = (file: string) => importPayload(pathToFileURL(path.join(selection.payload.root, "server/dist", file)).href);
    const [{ startOrJoinCompatibilityGateway }, { createNativePublicFacade }] = await Promise.all([
      from("compatibility-gateway-coordination.js"), from("native-public-mcp.js"),
    ]);
    const assertVerified = () => {
      selection.assertCurrent();
      if (verifyNextPayload(options.extensionPath).buildId !== selection.payload.buildId || pin(relay.path).sha256 !== relay.sha256)
        throw new Error("Bundled compatibility payload changed.");
    };
    const attribution = (source: "vscode-provider" | "pkm-chat") =>
      JSON.parse(managedMcpAttributionEnv({}, source)[MCP_ATTRIBUTION_ENV]);
    const custody = await prepareCustody();
    return startOrJoinCompatibilityGateway(selection.config, { generation: selection.generation,
      runtimeBuild: selection.runtimeBuild, managedRoot: selection.cwd, createFacade: createNativePublicFacade, assertVerified },
    { acquireLegacyFence, async acquireCustody(root: string) {
      if (root !== options.root()) throw new Error("Native admission root changed.");
      return prepareCustody();
    }, workbenchAttribution: attribution("vscode-provider"), chatAttribution: attribution("pkm-chat"),
    assertAllowed: selection.assertCurrent, hasActiveChatWork: options.live!.hasActiveChatWork,
    confirm: options.live!.confirm }, custody, "original");
  }
  function assertLaunchAdmission() {
    if (admissionError) {
      // Revalidate a newly available managed owner on an explicit Start retry.
      // Unknown owners still fail the authenticated custody handshake.
      if (options.live) return;
      if (hasPendingOwner(options.root()))
        throw new Error("Compatibility custody belongs to another window or requires recovery. No fallback was started.");
      throw admissionError;
    }
    if (!options.live && !starting && !preparing && hasPendingOwner(options.root()))
      throw new Error("Compatibility custody belongs to another window or requires recovery. No fallback was started.");
  }
  return {
    assertLaunchAdmission,
    prepareCustody,
    describeLaunch() {
      const selection = getSelected();
      if (!options.live) return { ...selection, liveRelay: false as const, env: {} as Record<string, string> };
      return { ...selection, liveRelay: true as const,
        runtimeBuild: hash(JSON.stringify(["pkm.compatibility-relay/v1", selection.runtimeBuild, selection.config.legacy.runtimeBuild])),
        args: [path.join(selection.payload.root, "server/dist/compatibility-gateway-relay.js")],
        env: workbenchRelay ? { PKM_SHARED_ORIGIN: workbenchRelay.origin,
          PKM_SHARED_SERVICE_ID: workbenchRelay.serviceId, PKM_SHARED_TOKEN: workbenchRelay.token }
          : {} as Record<string, string> };
    },
    async managedPeerDefinition(): Promise<{ command: string; args: string[] }> {
      if (!options.live) throw new Error("Managed CLI peers require the supported native PKM route.");
      const selection = getSelected();
      if (starting) {
        const status = await (await starting).status();
        if (status.phase !== "accepting" || status.uncertain) throw new Error("The native PKM owner is not verified.");
      }
      return { command: selection.command,
        args: [path.join(selection.payload.root, "server/dist/compatibility-gateway-peer-cli.js"),
          selection.config.knowledgeRoot, selection.config.legacy.generation,
          selection.config.legacy.runtimeBuild, selection.runtimeBuild,
          selection.config.writable ? "--writable" : "--read-only"] };
    },
    async bindBrowserReads() {
      if (!options.live) return undefined;
      if (!starting) throw new Error("Start the existing PKM connection before opening PKM Browser.");
      const selection = getSelected();
      const bound = await (await starting).bindBrowserReads();
      return { ...bound, assertCurrent() { selection.assertCurrent(); bound.assertCurrent(); } };
    },
    async launch(role: "workbench" | "chat" = "workbench") {
      try {
        assertLaunchAdmission();
        await prepareCustody();
        const selection = getSelected();
        if (options.live) {
          const authority = await (starting ??= startAuthority(selection));
          selection.assertCurrent();
          const { origin, serviceId, token } = authority.relay(role);
          if (role === "workbench") workbenchRelay = { origin, serviceId, token };
          phase = "selected";
          return {
            ...selection, ...authority.relayIdentity, liveRelay: true as const,
            args: [path.join(selection.payload.root, "server/dist/compatibility-gateway-relay.js")],
            env: { PKM_SHARED_ORIGIN: origin, PKM_SHARED_SERVICE_ID: serviceId, PKM_SHARED_TOKEN: token },
          };
        }
        phase = "selected";
        return { ...selection, liveRelay: false as const, env: {} as Record<string, string> };
      } catch (error) {
        phase = "unavailable";
        if (starting) {
          try { await starting; } catch { starting = undefined; }
        }
        throw error;
      }
    },
    async handleSettings(message: any, respond: (message: object) => void) {
      if (!["mcpBackendSwitchRead", "mcpBackendSwitchApply"].includes(message?.command)) return false;
      if (!Number.isSafeInteger(message.requestId) || message.requestId < 1) return true;
      const send = (data: object) => respond({ command: "mcpBackendSwitchResult", data: { requestId: message.requestId, ...data } });
      if (busy) { send({ error: "busy" }); return true; }
      busy = true;
      try {
        if (!starting) {
          const startup = options.startupStatus?.();
          send(startup?.pending ? { error: "preparing" }
            : startup?.error ? { error: "loadingFailed", detail: startup.error }
            : admissionError ? { error: "loadingFailed",
            detail: admissionError instanceof Error ? admissionError.message : String(admissionError) }
            : { error: !preparing && hasPendingOwner(options.root()) ? "custodyUnavailable" : "notAdmitted" });
          return true;
        }
        const selection = getSelected();
        const authority = await starting;
        selection.assertCurrent();
        const snapshot = async (observed?: Awaited<ReturnType<Authority["status"]>>) => {
          const status = observed ?? await authority.status();
          return { serviceId: authority.relayIdentity.generation, selectionRevision: status.selectionRevision,
            active: { mode: status.mode, version: status.version, phase: status.phase, generation: status.generation, runtimeBuild: status.runtimeBuild,
              backendPid: status.authorityPid ?? process.pid, inFlight: status.inFlight, uncertain: Number(status.uncertain),
              backgroundActive: status.backgroundActive ?? Number(options.live!.hasActiveChatWork()), backgroundUncertain: 0 },
            candidates: status.candidates.map(item => ({ ...item, compatible: true })),
            ...(status.missingRelays.length ? { error: "relayUnverified" } : {}) };
        };
        const current = await snapshot();
        if (message.command === "mcpBackendSwitchRead") { send(current); return true; }
        if (current.error) { send(current); return true; }
        if (current.active.backgroundActive) { send({ ...current, error: "backgroundWork" }); return true; }
        const target = current.candidates.find(item => item.generation === message.generation && item.runtimeBuild === message.runtimeBuild);
        if (!target || message.serviceId !== current.serviceId || message.activeGeneration !== current.active.generation
          || message.selectionRevision !== current.selectionRevision) { send({ ...current, error: "selectionChanged" }); return true; }
        try {
          const result = await authority.approveSwitch(
            { mode: current.active.mode, selectionRevision: current.selectionRevision }, target.mode,
            async observed => { await send({ progress: true, active: (await snapshot(observed)).active }); });
          send({ ...await snapshot(), outcome: result.applied ? "completed" : "cancelled" });
        } catch { send({ ...await snapshot(), error: "refused" }); }
      } catch (error) {
        send({ error: "loadingFailed", detail: error instanceof Error ? error.message : String(error) });
      }
      finally { busy = false; }
      return true;
    },
    async dispose() {
      disposed = true;
      if (starting) await (await starting).close();
      else if (preparing && !admissionError) await (await preparing).release(true);
    },
    status() {
      let blockedByCustody = false;
      try { blockedByCustody = !starting && (!preparing || Boolean(admissionError)) && hasPendingOwner(options.root()); }
      catch { blockedByCustody = true; }
      if (selected) {
        try { selected.assertCurrent(); }
        catch { phase = "unavailable"; }
      }
      return { phase: blockedByCustody ? "unavailable" as const : phase,
        ...(blockedByCustody ? { reason: "custodyUnavailable" as const } : {}),
        selected: selected ? { generation: selected.generation, runtimeBuild: selected.runtimeBuild,
        version: selected.version, originalBuild: selected.originalBuild } : null,
        compatibleCandidates: [], scope: "native-vscode-pkm-and-pkm-chat" as const,
        storageEngine: "original" as const, storageMigrated: false as const, cutoverAuthorized: false as const };
    },
  };
}
