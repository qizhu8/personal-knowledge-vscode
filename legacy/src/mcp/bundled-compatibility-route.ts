import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_LIFECYCLE_SCHEMA, readManagedMcpManifest } from "./mcp-lifecycle";
import { verifyNextPayload } from "../runtime/next-payload-verifier";
import { acquireLinuxRootWriterFence, assertLinuxRootStillLegacyWritable } from "../runtime/linux-root-writer-fence";
import { MCP_ATTRIBUTION_ENV, managedMcpAttributionEnv } from "./mcp-attribution";

type Mode = "original" | "bundled-v5";
type Selection = { mode: Mode; selectionRevision: string };
type Authority = {
  relayIdentity: { generation: string; runtimeBuild: string };
  relay(role: "workbench" | "chat"): { origin: string; serviceId: string; token: string };
  status(): Selection & { generation: string; runtimeBuild: string; phase: string; inFlight: number; uncertain: boolean;
    candidates: { mode: Mode; generation: string; runtimeBuild: string }[] };
  approveSwitch(expected: Selection, mode: Mode): Promise<{ applied: boolean }>;
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
  extensionPath: string; storage: string;
  root(): string; managed(): string; python(): string; assertAllowed(): void;
  live?: { assertAdmittedRoot(): void; confirm(review: { from: Mode; to: Mode; runtimeBuild: string }): Promise<boolean> };
}) {
  let selected: ReturnType<typeof select> | undefined;
  let phase: "pending" | "selected" | "unavailable" = "pending";
  let starting: Promise<Authority> | undefined;
  let busy = false, disposed = false;
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
    if (!storageStat.isDirectory() || storageStat.uid !== process.getuid?.()
      || (storageStat.mode & 0o022) !== 0 || inside(root, storage) || inside(storage, root))
      throw new Error("Compatibility control must be separate from the Knowledge Root.");
    const payload = verifyNextPayload(options.extensionPath);
    const node = pin(process.execPath);
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
    const [{ startCompatibilityGatewayAuthority }, { createNativePublicFacade }] = await Promise.all([
      from("compatibility-gateway-authority.js"), from("native-public-mcp.js"),
    ]);
    const assertVerified = () => {
      selection.assertCurrent();
      if (verifyNextPayload(options.extensionPath).buildId !== selection.payload.buildId || pin(relay.path).sha256 !== relay.sha256)
        throw new Error("Bundled compatibility payload changed.");
    };
    const attribution = (source: "vscode-provider" | "pkm-chat") =>
      JSON.parse(managedMcpAttributionEnv({}, source)[MCP_ATTRIBUTION_ENV]);
    return startCompatibilityGatewayAuthority(selection.config, { generation: selection.generation,
      runtimeBuild: selection.runtimeBuild, managedRoot: selection.cwd, createFacade: createNativePublicFacade, assertVerified },
    { acquireLegacyFence(root: string) {
      assertLinuxRootStillLegacyWritable(root);
      return acquireLinuxRootWriterFence(root, "shared", 1_000);
    }, workbenchAttribution: attribution("vscode-provider"), chatAttribution: attribution("pkm-chat"),
    assertAllowed: selection.assertCurrent,
    confirm: options.live!.confirm }, "original");
  }
  function assertLaunchAdmission() {
    if (!starting && hasPendingOwner(options.root()))
      throw new Error("Compatibility custody belongs to another window or requires recovery. No fallback was started.");
  }
  return {
    assertLaunchAdmission,
    async launch(role: "workbench" | "chat" = "workbench") {
      try {
        assertLaunchAdmission();
        const selection = getSelected();
        if (options.live) {
          const authority = await (starting ??= startAuthority(selection));
          selection.assertCurrent();
          const { origin, serviceId, token } = authority.relay(role);
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
          send({ error: hasPendingOwner(options.root()) ? "custodyUnavailable" : "notAdmitted" });
          return true;
        }
        const selection = getSelected();
        const authority = await starting;
        selection.assertCurrent();
        const snapshot = () => {
          const status = authority.status();
          return { serviceId: authority.relayIdentity.generation, selectionRevision: status.selectionRevision,
            active: { mode: status.mode, phase: status.phase, generation: status.generation, runtimeBuild: status.runtimeBuild,
              backendPid: process.pid, inFlight: status.inFlight, uncertain: Number(status.uncertain),
              backgroundActive: 0, backgroundUncertain: 0 },
            candidates: status.candidates.map(item => ({ ...item, compatible: true })) };
        };
        const current = snapshot();
        if (message.command === "mcpBackendSwitchRead") { send(current); return true; }
        const target = current.candidates.find(item => item.generation === message.generation && item.runtimeBuild === message.runtimeBuild);
        if (!target || message.serviceId !== current.serviceId || message.activeGeneration !== current.active.generation
          || message.selectionRevision !== current.selectionRevision) { send({ ...current, error: "selectionChanged" }); return true; }
        try {
          const result = await authority.approveSwitch({ mode: current.active.mode, selectionRevision: current.selectionRevision }, target.mode);
          send({ ...snapshot(), outcome: result.applied ? "completed" : "cancelled" });
        } catch { send({ ...snapshot(), error: "refused" }); }
      } catch {
        try { send({ error: hasPendingOwner(options.root()) ? "custodyUnavailable" : "statusUnavailable" }); }
        catch { send({ error: "statusUnavailable" }); }
      }
      finally { busy = false; }
      return true;
    },
    async dispose() {
      disposed = true;
      if (starting) await (await starting).close();
    },
    status() {
      let blockedByCustody = false;
      try { blockedByCustody = !starting && hasPendingOwner(options.root()); }
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
