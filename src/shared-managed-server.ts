import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { isolatedManagedLaunch, verifyIsolatedManagedGeneration } from "../experimental/managed-launch-client.mjs";
import { publishIsolatedManagedGeneration, inspectIsolatedManagedRuntime,
  cleanupIsolatedManagedRuntime, withIsolatedManagedGenerationAdmission } from "../experimental/managed-migration.mjs";
import { assertOriginalMcpBrokerDirectory } from "./original-mcp-relay.js";
import { originalMcpBrokerAvailability } from "./original-mcp-broker.js";
import { resetFreshNoteIndex } from "./workspace-storage-migration.js";
import { workspaceStoragePaths } from "./workspace-storage-paths.js";
import { acquireSharedManagerControlGuard } from "./shared-manager-control.js";
import { parseSharedCoreProfile } from "./shared-core-profile.js";
import { connectSharedCoreBackend } from "./shared-core-supervisor.js";
import { loadBrowserAssets } from "./browser-host.js";
import { createBrowserReleaseGate, type BrowserCoreDispatch } from "./browser-release-gate.js";
import { CoreError } from "./contracts.js";
import { sharedManagementBodySha256 } from "./shared-managed-client.js";

type Phase = "starting" | "accepting" | "draining" | "action-required" | "closed";
type Receipt = { id: string; clientId: string; tool: string; generation: string; outcome: "pending" | "unknown" };
type State = { schema: "pkm.shared-manager/v1"; serviceId: string; managedRoot: string;
  phase: Phase; generation?: string; workspaceId?: string; dataPath?: string; writable?: boolean;
  catalogSha256?: string; runtimeBuild?: string; receipts: Receipt[];
  backendKind?: "native-public-mcp" | "standalone-core";
  revokedCredentials?: string[];
  history?: { id: string; action: string; from: string | null; to: string | null;
    phase: "prepared" | "completed" | "failed" | "interrupted"; at: number;
    receiptId?: string; clientId?: string; tool?: string; bodySha256?: string }[] };
type ManagementRecord = NonNullable<State["history"]>[number];
type Approval = { action: string; generation?: string; receiptId?: string; expires: number; revision: string;
  operationId: string; bodySha256: string; correlated: boolean };
const managementUuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const controls = new Set(["mcp_lifecycle_quiesce", "mcp_lifecycle_status"]);
const publicTools = new Set(["check_version", "capabilities_inventory", "capabilities_list",
  "capabilities_search", "capabilities_describe", "capability_read", "capability_call"]);
const knowledge = originalMcpBrokerAvailability(true);
const admittedOperations = new Set(knowledge.enabledOperationIds);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
function fail(message: string): never { throw new Error(message); }
const decode = (result: CallToolResult): Record<string, any> => {
  if (result.isError) fail("Backend lifecycle control failed.");
  if (object(result.structuredContent)) return result.structuredContent;
  const first = result.content.find(part => part.type === "text");
  const value = JSON.parse(first?.type === "text" ? first.text : "");
  return object(value) ? value : fail("Invalid backend lifecycle result.");
};
async function bounded<T>(work: Promise<T>, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Lifecycle deadline exceeded; explicit recovery required.")), ms);
  })]); } finally { clearTimeout(timer); }
}
async function requestBytes(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > 1_048_576) fail("Request exceeds bounded budget.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function requestBody(req: IncomingMessage) {
  const value = JSON.parse((await requestBytes(req)).toString("utf8"));
  return object(value) ? value : fail("Expected an object.");
}
function authenticates(req: IncomingMessage, token: string) {
  const actual = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function assertStableManagerPlacement(managedRoot: string) {
  const root = await realpath(managedRoot);
  const codePaths = [await realpath(fileURLToPath(import.meta.url))];
  if (process.argv[1]) codePaths.push(await realpath(resolve(process.argv[1])));
  for (const code of codePaths) {
    const local = relative(root, code);
    if (!isAbsolute(local) && local !== ".." && !local.startsWith("../"))
      fail("STABLE_MANAGER_PAYLOAD_REQUIRED: Run the supervisor from an independently provisioned complete server payload outside managed runtime trees.");
    let parent = dirname(code);
    while (true) {
      try {
        await lstat(join(parent, ".pkm-isolated-migration"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
        continue;
      }
      fail("STABLE_MANAGER_PAYLOAD_REQUIRED: Supervisor code or its entry point is inside a managed runtime tree and has no independent code lease.");
    }
  }
}

/** One owned backend process; public clients never acquire a workspace writer lease. */
export async function startSharedManagedServer(options: {
  directory: string; managedRoot: string; token: string; managementToken: string; port?: number;
  backendKind?: "native-public-mcp" | "standalone-core";
}) {
  await assertStableManagerPlacement(options.managedRoot);
  if ([options.token, options.managementToken].some(token => token.length < 32 || token.length > 4096 || /[\r\n]/.test(token))
    || options.token === options.managementToken)
    fail("Independent business and management secrets of at least 32 characters are required.");
  assertOriginalMcpBrokerDirectory(options.directory);
  const dataPath = dirname(dirname(dirname(options.directory)));
  const paths = workspaceStoragePaths(dataPath);
  if (paths.layout !== "separated" || options.directory !== join(paths.serverData, "runtime-control", "shared-manager"))
    fail("Manager controls require the separated workspace server-data/runtime-control/shared-manager namespace.");
  const workspaceId = JSON.parse(await readFile(join(dataPath, ".pkm-next-workspace"), "utf8")).id;
  if (!uuid(workspaceId)) fail("Durable workspace identity is unavailable.");
  const root = await realpath(options.managedRoot);
  if (root !== options.managedRoot) fail("Canonical isolated managed root required.");
  const backendKind = options.backendKind ?? "native-public-mcp";
  const browser = backendKind === "standalone-core" ? await loadBrowserAssets() : undefined;
  const webview = browser ? await createBrowserReleaseGate(options.token, true) : undefined;
  const guard = await acquireSharedManagerControlGuard(join(options.directory, "shared-manager.guard"));
  const path = join(options.directory, "shared-manager.json");
  let state: State;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576
      || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) fail("Unsafe manager state.");
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value;
    try { value = JSON.parse(await fd.readFile("utf8")); } finally { await fd.close(); }
    if (value?.schema === "pkm.shared-manager/v1" && (value.managedRoot !== root
      || value.dataPath !== undefined && value.dataPath !== dataPath
      || value.workspaceId !== undefined && value.workspaceId !== workspaceId
      || value.backendKind !== undefined && value.backendKind !== backendKind))
      fail("SHARED_MANAGER_REENROLLMENT_REQUIRED: Restored controls retain their original root/workspace binding. No implicit rebind or write replay is supported.");
    if (value.schema !== "pkm.shared-manager/v1" || !uuid(value.serviceId) || value.managedRoot !== root
      || !Array.isArray(value.receipts) || !["starting", "accepting", "draining", "action-required", "closed"].includes(value.phase)
      || value.dataPath !== undefined && value.dataPath !== dataPath
      || value.workspaceId !== undefined && value.workspaceId !== workspaceId
      || value.history !== undefined && (!Array.isArray(value.history) || value.history.some((item: any) =>
        !object(item) || !uuid(item.id) || !["switch", "recover", "cleanup-runtime", "reset-index", "reconcile", "revoke-access", "human-review-enrollment"].includes(item.action)
        || item.from !== null && !uuid(item.from) || item.to !== null && !uuid(item.to)
        || item.receiptId !== undefined && !uuid(item.receiptId) || item.clientId !== undefined && !uuid(item.clientId)
        || item.tool !== undefined && typeof item.tool !== "string"
        || item.bodySha256 !== undefined && !sha256(item.bodySha256)
        || !["prepared", "completed", "failed", "interrupted"].includes(item.phase) || !Number.isSafeInteger(item.at)))
      || value.revokedCredentials !== undefined && (!Array.isArray(value.revokedCredentials)
        || value.revokedCredentials.length > 128 || new Set(value.revokedCredentials).size !== value.revokedCredentials.length
        || value.revokedCredentials.some((item: unknown) => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)))
      || value.receipts.some((item: any) => !object(item) || !uuid(item.id) || !uuid(item.clientId)
        || typeof item.tool !== "string" || !uuid(item.generation) || !["pending", "unknown"].includes(item.outcome)))
      fail("Manager identity or journal changed.");
    state = value;
    // A previous process may have dispatched any pending call before its crash.
    for (const receipt of state.receipts) receipt.outcome = "unknown";
    for (const item of state.history ?? []) if (item.phase === "prepared") item.phase = "interrupted";
    if (state.phase !== "closed" || state.receipts.length) state.phase = "action-required";
    else state.phase = "starting";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await guard.release(); throw error; }
    state = { schema: "pkm.shared-manager/v1", serviceId: randomUUID(), managedRoot: root, phase: "starting", receipts: [] };
  }
  state.workspaceId = workspaceId; state.dataPath = dataPath;
  state.backendKind = backendKind;
  state.history ??= [];
  state.revokedCredentials ??= [];
  const credentialFingerprint = createHash("sha256").update(options.token).digest("hex");
  const businessAllowed = (req: IncomingMessage) =>
    !state.revokedCredentials!.includes(credentialFingerprint) && authenticates(req, options.token);
  let durableHistory: ManagementRecord[] = [];
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      guard.assertHeld();
      const pending = `${path}.${randomUUID()}.pending`;
      const fd = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const snapshot = JSON.stringify(state);
      try { await fd.writeFile(snapshot); await fd.sync(); } finally { await fd.close(); }
      await rename(pending, path);
      const directory = await open(options.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
      durableHistory = JSON.parse(snapshot).history ?? [];
    });
    return saving;
  };
  let backend: { client: Client; transport: Transport; generation: string;
    runtimeBuild: string; tools: Tool[]; child: ChildProcess; exited: Promise<void>;
    kind?: "standalone-core"; control?(action: "status" | "quiesce" | "close" | "human-enrollment"): Promise<any>;
    url?: string; token?: string } | undefined;
  let startingCore: { child: ChildProcess; exited: Promise<void> } | undefined;
  let backgroundChat: { active: number; uncertain: number } | undefined;
  const clients = new Set<string>(), approvals = new Map<string, Approval>(), calls = new Set<Promise<unknown>>();
  const managementExecuting = new Set<string>();
  let transition = false, revision = randomUUID(), catalogPin = state.catalogSha256, closing: Promise<void> | undefined;
  const status = () => ({
    schema: "pkm.shared-service-status/v1", serviceId: state.serviceId, managedRoot: root,
    phase: state.phase, generation: backend?.generation ?? state.generation, workspaceId: state.workspaceId,
    actorId: backendKind === "standalone-core" ? "local:owner" : "mcp:external",
    runtimeBuild: backend?.runtimeBuild ?? state.runtimeBuild, backendPid: backend?.child.pid, clients: clients.size, inFlight: calls.size,
    uncertain: state.receipts.filter(item => item.outcome === "unknown").map(item => ({ ...item })),
    automaticReplay: false, backendKind, scope: backendKind === "standalone-core" ? "isolated-standalone-core/v1" : "isolated-native-knowledge/v1",
    protocols: { coreHttp: backendKind === "standalone-core", browserChat: backendKind === "standalone-core",
      mcp: backendKind === "standalone-core" ? "canonical-core" : "native-compact" },
    ...(backgroundChat ? { backgroundChat } : {}),
    writable: state.writable === true,
    authentication: { businessCredential: state.revokedCredentials!.includes(credentialFingerprint) ? "revoked" : "active",
      principal: "one-configured-local-actor", clientIds: "routing-only-not-principals", remoteEnrollment: false,
      revocation: "new-dispatch-only; does not undo admitted effects or revoke independent human-review authority" },
    enabledOperationIds: backendKind === "standalone-core" ? [] : originalMcpBrokerAvailability(state.writable === true).enabledOperationIds,
    limitations: backendKind === "standalone-core" ? [
      "Explicit configured standalone Core, not original 151-operation parity or legacy production ownership.",
      "Model/tool/provider authority is fixed by the immutable admitted native host profile, never request headers.",
      "Active/uncertain background Chat work blocks handoff; no automatic replay.",
    ] : ["Reduced synchronous knowledge-only scope, not original 151-operation parity.",
      "Chat, Actions, Recipes, model execution, automation and other background writers are refused before dispatch.",
      "No arbitrary legacy or production Root switching.",
      "All enrolled clients must use this stable service; independently launched writers remain excluded by the workspace lease."],
  });
  async function connectBackend() {
    const expected = await inspectIsolatedManagedRuntime(root);
    const expectedGeneration = expected.activeGeneration ?? fail("No published isolated generation.");
    const manifest = await verifyIsolatedManagedGeneration(root, expectedGeneration) as unknown as Record<string, any>;
    const launchConfig = JSON.parse(await readFile(join(root, "generations", expectedGeneration, "launch.json"), "utf8"));
    if (Object.keys(launchConfig).sort().join(",") !== "allowWrites,data"
      || typeof launchConfig.allowWrites !== "boolean")
      fail("Shared knowledge scope refuses snapshot schedulers and unknown background runtime features before startup.");
    if ((manifest.backendKind ?? "native-public-mcp") !== backendKind)
      fail("Incompatible backend kind; explicit new service enrollment is required.");
    if (backendKind === "standalone-core") {
      if (manifest.backendAbi !== "pkm.shared-core-http/v1" || launchConfig.data !== dataPath)
        fail("Core backend ABI/workspace is incompatible.");
      parseSharedCoreProfile(JSON.parse(await readFile(join(root, "generations", expectedGeneration, "core-host.json"), "utf8")));
      const opening = await withIsolatedManagedGenerationAdmission(root, expectedGeneration, "standalone-core", async launch => {
        const owned = connectSharedCoreBackend({
          launch, manifest,
          capture(value) { startingCore = value; },
        });
        return { pid: owned.child.pid!, value: owned };
      });
      backend = await opening.ready;
      startingCore = undefined;
      state.writable = true;
      backgroundChat = (await backend!.control!("status")).backgroundChat;
      if (backend!.generation !== expectedGeneration) fail("Core generation readiness changed.");
      const pin = createHash("sha256").update(JSON.stringify(backend!.tools)).digest("hex");
      if (catalogPin && catalogPin !== pin) fail("Core MCP contracts changed; client re-enrollment required.");
      catalogPin = pin; state.catalogSha256 = pin;
      state.generation = backend!.generation; state.runtimeBuild = backend!.runtimeBuild;
      backend!.child.once("exit", () => {
        if (state.phase === "accepting") { state.phase = "action-required"; void save().catch(() => {}); }
      });
      return;
    }
    const launch = await isolatedManagedLaunch(root);
    const client = new Client({ name: "pkm-shared-manager", version: "0.1.0" });
    const transport = new StdioClientTransport({
      ...launch, env: Object.fromEntries(Object.entries({ ...launch.env, PKM_CAPABILITY_PROFILE: "compact" })
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")), stderr: "inherit",
    });
    const connecting = client.connect(transport, { timeout: 30_000 });
    void connecting.catch(() => {});
    await Promise.resolve();
    const processHandle = (transport as unknown as { _process?: ChildProcess })._process;
    if (!processHandle?.stdin || processHandle.pid !== transport.pid) return fail("Owned backend process is unavailable.");
    const child = processHandle;
    const exited = new Promise<void>((ready, reject) => child.once("exit", (code, signal) =>
      code === 0 && signal === null ? ready() : reject(new Error("Owned backend did not exit cleanly."))));
    void exited.catch(() => {});
    // Retain custody even if discovery fails: never start a replacement before confirmed exit.
    const owned: NonNullable<typeof backend> = { client, transport, child, exited, generation: "", runtimeBuild: "", tools: [] };
    backend = owned;
    await connecting;
    const lifecycle = decode(await client.callTool({ name: "mcp_lifecycle_status", arguments: {} }) as CallToolResult);
    if (lifecycle.schema !== "pkm.mcp.lifecycle/v1" || !uuid(lifecycle.generation)
      || lifecycle.phase !== "accepting" || lifecycle.controlError || lifecycle.acceptingNewCalls !== true)
      fail("Backend is not accepting verified calls.");
    const runtime = await inspectIsolatedManagedRuntime(root);
    if (manifest.managedRoot !== root || manifest.runtimeBuild !== lifecycle.runtimeBuild
      || expectedGeneration !== lifecycle.generation
      || runtime.activeGeneration !== lifecycle.generation) fail("Backend identity does not match the published generation.");
    const marker = JSON.parse(await readFile(join(launchConfig.data, ".pkm-next-workspace"), "utf8"));
    if (!uuid(marker.id) || state.workspaceId && state.workspaceId !== marker.id
      || state.dataPath && state.dataPath !== launchConfig.data) fail("Backend durable workspace identity changed.");
    state.workspaceId = marker.id; state.dataPath = launchConfig.data;
    state.writable = launchConfig.allowWrites === true;
    owned.generation = lifecycle.generation; owned.runtimeBuild = lifecycle.runtimeBuild;
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      owned.tools.push(...page.tools);
      if (owned.tools.length > 512 || page.nextCursor && seen.has(page.nextCursor)) fail("Unbounded backend catalog.");
      cursor = page.nextCursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    owned.tools = owned.tools.filter(tool => publicTools.has(tool.name)).map(tool => ({
      ...tool, description: `${tool.description ?? ""}\nShared manager admits synchronous Note/Skill/Paper content only; see authenticated shared status for exact operation IDs.`,
    }));
    const pin = createHash("sha256").update(JSON.stringify(owned.tools)).digest("hex");
    if (catalogPin && catalogPin !== pin) fail("Backend catalog changed; explicit client re-enrollment required.");
    catalogPin = pin;
    state.catalogSha256 = pin;
    child.once("exit", () => {
      if (backend === owned && state.phase === "accepting") {
        state.phase = "action-required"; void save().catch(() => {});
      }
    });
    state.generation = owned.generation;
    state.runtimeBuild = owned.runtimeBuild;
  }
  async function closeBackend(allowCrashed = false) {
    const owned = backend;
    if (!owned) {
      if (startingCore) {
        if (startingCore.child.connected) startingCore.child.disconnect();
        try { await bounded(startingCore.exited); }
        catch (error) {
          if (!allowCrashed || startingCore.child.exitCode === null && startingCore.child.signalCode === null) throw error;
        }
        startingCore = undefined;
      }
      return;
    }
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      try { await owned.exited; } catch (error) { if (!allowCrashed) throw error; }
      await owned.client.close(); backend = undefined; return;
    }
    if (owned.kind === "standalone-core") {
      const drained = await owned.control!("quiesce");
      backgroundChat = drained.backgroundChat;
      if (drained.phase !== "drained" || drained.generation !== owned.generation
        || drained.runtimeBuild !== owned.runtimeBuild || drained.backgroundChat?.active || drained.backgroundChat?.uncertain)
        fail("BUSY: Core background work has not safely drained.");
      await owned.control!("close"); await bounded(owned.exited); await owned.client.close(); backend = undefined;
      return;
    }
    if (owned.generation) {
      const quiesced = decode(await owned.client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} }) as CallToolResult);
      if (quiesced.generation !== owned.generation || quiesced.runtimeBuild !== owned.runtimeBuild)
        fail("Backend drain identity changed.");
      const deadline = Date.now() + 30_000;
      while (true) {
        const value = decode(await owned.client.callTool({ name: "mcp_lifecycle_status", arguments: {} }) as CallToolResult);
        if (value.generation !== owned.generation || value.runtimeBuild !== owned.runtimeBuild || value.controlError)
          fail("Backend drain ownership unknown.");
        if (value.phase === "drained" && value.inFlight === 0 && value.uncertainCalls === 0) break;
        if (Date.now() >= deadline) fail("Backend did not drain; no process was terminated.");
        await new Promise(ready => setTimeout(ready, 25));
      }
    }
    owned.child.stdin!.end();
    await bounded(owned.exited);
    await owned.client.close();
    backend = undefined;
  }
  async function change(action: string, generation: string | undefined, record: ManagementRecord) {
    if (transition) fail("Lifecycle transition already running.");
    const previous = backend, previouslyAccepting = state.phase === "accepting";
    let validating = action === "switch";
    transition = true; revision = randomUUID(); approvals.clear();
    try {
      guard.assertHeld();
      if (state.receipts.some(item => item.outcome === "unknown"))
        fail("Uncertain calls require explicit receipt reconciliation before handoff.");
      if (action === "switch") {
        if (!uuid(generation)) fail("Exact staged generation required.");
        const candidate = await verifyIsolatedManagedGeneration(root, generation!) as unknown as Record<string, any>;
        const current = await verifyIsolatedManagedGeneration(root, state.generation!) as unknown as Record<string, any>;
        const launch = JSON.parse(await readFile(join(root, "generations", generation!, "launch.json"), "utf8"));
        if ((candidate.backendKind ?? "native-public-mcp") !== backendKind
          || (candidate.backendAbi ?? "pkm.mcp.api/1") !== (current.backendAbi ?? "pkm.mcp.api/1")
          || !isDeepStrictEqual(candidate.compatibility, current.compatibility) || launch.data !== dataPath)
          fail("Incompatible staged backend; existing owner was not drained.");
        validating = false;
      }
      state.phase = "draining"; await save();
      await bounded(Promise.all([...calls]));
      if (state.receipts.length) fail("Calls did not produce confirmed terminal receipts.");
      await closeBackend(action === "recover");
      if (action === "switch") {
        if (!uuid(generation)) fail("Exact staged generation required.");
        await publishIsolatedManagedGeneration(root, generation!);
      }
      if (action === "cleanup-runtime") await cleanupIsolatedManagedRuntime(root);
      if (action === "reset-index") {
        if (!state.dataPath) fail("Verified durable workspace path is unavailable.");
        await resetFreshNoteIndex(state.dataPath!);
      }
      await connectBackend();
      record.phase = "completed";
      state.phase = "accepting"; await save();
    } catch (error) {
      record.phase = "failed";
      state.phase = validating && previouslyAccepting && backend === previous && backend?.child.exitCode === null
        || backend?.kind === "standalone-core" && error instanceof Error && /BUSY|background Chat work blocks handoff/.test(error.message)
        ? "accepting" : "action-required";
      await save(); throw error;
    }
    finally { transition = false; }
  }
  await save();
  if (state.phase === "starting") {
    try { await connectBackend(); state.phase = "accepting"; }
    catch (error) {
      state.phase = "action-required";
      console.error("Shared backend admission refused:", error instanceof Error ? error.message : "unknown failure");
    }
    await save();
  }
  const inspect = async () => {
    if (backend?.control) backgroundChat = (await backend.control("status")).backgroundChat;
    return status();
  };
  const coreAccepting = (owned: typeof backend) => owned?.kind === "standalone-core" && owned === backend
    && state.phase === "accepting" && !transition && calls.size < 32;
  async function proxyCore(req: IncomingMessage, res: ServerResponse) {
    const owned = backend;
    const refuse = () => {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: randomUUID(),
        error: { code: "BUSY", message: "Shared Core is not accepting; no request dispatched.", effect: "not-committed" } }));
    };
    if (owned?.kind !== "standalone-core" || state.phase !== "accepting" || transition || calls.size >= 32) return refuse();
    const input = req.method === "GET" || req.method === "HEAD" ? undefined : await requestBytes(req);
    if (!businessAllowed(req) && !req.url?.startsWith("/human-review")) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: randomUUID(),
        error: { code: "UNAUTHORIZED", message: "Business credential is revoked.", effect: "not-committed" } }));
      return;
    }
    if (owned !== backend || state.phase !== "accepting" || transition) return refuse();
    const human = req.url?.startsWith("/human-review") ?? false;
    const headers: Record<string, string> = human ? {} : { authorization: `Bearer ${owned.token}` };
    if (human && req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (req.headers.origin) headers.origin = owned.url!;
    const response = await coreExchange(owned, req.url!, req.method!, headers, input);
    res.writeHead(response.status, response.headers);
    res.end(response.bytes);
  }
  async function coreExchange(owned: NonNullable<typeof backend>, path: string, method: string,
    headers: Record<string, string>, input?: Buffer) {
    const receipt: Receipt = { id: randomUUID(), clientId: randomUUID(), tool: path, generation: owned.generation, outcome: "pending" };
    state.receipts.push(receipt);
    const work = (async () => {
      await save();
      try {
        guard.assertHeld();
        const response = await fetch(`${owned.url}${path}`, { method, headers, redirect: "error",
          ...(input === undefined ? {} : { body: new Uint8Array(input) }) });
        const bytes = Buffer.from(await response.arrayBuffer());
        let unknown = false;
        if (path.startsWith("/v1/")) {
          const value = JSON.parse(bytes.toString("utf8"));
          unknown = value.error?.effect === "unknown";
        }
        if (unknown) { receipt.outcome = "unknown"; state.phase = "action-required"; }
        else state.receipts = state.receipts.filter(item => item !== receipt);
        await save();
        const observed = await owned.control!("status").catch(() => undefined);
        if (observed) backgroundChat = observed.backgroundChat;
        const cookies = response.headers.getSetCookie();
        return { status: response.status, headers: { "Content-Type": response.headers.get("content-type") ?? "application/json",
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-PKM-Service-Id": state.serviceId,
          ...(response.headers.has("content-security-policy") ? { "Content-Security-Policy": response.headers.get("content-security-policy")! } : {}),
          ...(cookies.length ? { "Set-Cookie": cookies } : {}) }, bytes };
      } catch {
        receipt.outcome = "unknown"; state.phase = "action-required"; await save();
        return { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          bytes: Buffer.from(JSON.stringify({ schema: "pkm.next-result/v1", requestId: receipt.id,
          error: { code: "NOT_AVAILABLE", message: `Shared Core outcome unknown; reconcile receipt ${receipt.id}. No replay.`,
            effect: "unknown" } })) };
      }
    })();
    calls.add(work);
    try { return await work; } finally { calls.delete(work); }
  }
  const server = createServer(async (req, res) => {
    let businessDispatched = false;
    let managementOperation: Approval | undefined;
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value));
    };
    try {
      guard.assertHeld();
      const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (req.headers.host !== host || req.socket.remoteAddress !== "127.0.0.1"
        || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
        return reply(403, { error: "Exact same-origin loopback required.", effect: "not-committed" });
      if (webview && (req.url === "/webview" || req.url?.startsWith("/webview/"))) {
        const owned = backend;
        const authorized = () => !state.revokedCredentials!.includes(credentialFingerprint);
        const dispatch: BrowserCoreDispatch = async (method, args) => {
          if (!owned || !coreAccepting(owned)) throw new CoreError("BUSY", "Shared Core changed or is not accepting.");
          if (!authorized()) throw new CoreError("ACCESS_DENIED", "Shared business credential revoked.");
          const response = await coreExchange(owned, `/v1/${method}`, "POST",
            { authorization: `Bearer ${owned.token}`, "content-type": "application/json" }, Buffer.from(JSON.stringify(args)));
          return JSON.parse(response.bytes.toString("utf8"));
        };
        await webview(req, res, { accepting: () => coreAccepting(owned), authorized, dispatch });
        return;
      }
      if (backendKind !== "standalone-core" && (req.url === "/webview" || req.url?.startsWith("/webview/")))
        return reply(501, { error: "Browser unavailable: the native public MCP backend does not expose a compatible browser authority.",
          backendAbi: "pkm.mcp.api/1", effect: "not-committed" });
      const assetPath = req.url === "/" ? "/index.html" : req.url;
      const asset = browser?.assets.get(assetPath ?? "");
      if (asset && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { ...browser!.headers,
          "Content-Type": assetPath!.endsWith(".html") ? "text/html; charset=utf-8"
            : assetPath!.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : asset); return;
      }
      if (backendKind === "standalone-core" && /^\/human-review(?:(?:\/[a-z-]+)|(?:-host)?\.mjs|\.css)?$/.test(req.url ?? ""))
        return await proxyCore(req, res);
      const management = req.url?.startsWith("/manage/") ?? false;
      if (!(management ? authenticates(req, options.managementToken) : businessAllowed(req)))
        return reply(401, { error: "Separate authenticated authority required.", effect: "not-committed" });
      if (backendKind === "standalone-core" && (/^\/v1\/[a-z_]+$/.test(req.url ?? "")
        || req.url === "/service/status")) return await proxyCore(req, res);
      if (req.headers["x-pkm-service-id"] !== state.serviceId)
        return reply(409, { error: "Service identity mismatch.", effect: "not-committed" });
      if (req.method === "GET" && ["/shared/status", "/manage/status"].includes(req.url ?? ""))
        return reply(200, { ...await inspect(), ...(management ? { history: durableHistory.slice(-32) } : {}) });
      if (req.method === "GET" && req.url === "/manage/candidates") {
        const runtime = await inspectIsolatedManagedRuntime(root);
        if (runtime.candidates.length > 16) fail("Candidate inspection is bounded to 16; explicitly clean inactive runtime artifacts first.");
        const activeGeneration = backend?.generation ?? state.generation ?? runtime.activeGeneration;
        const active = activeGeneration
          ? await verifyIsolatedManagedGeneration(root, activeGeneration) as unknown as Record<string, any> : undefined;
        const items: Record<string, unknown>[] = [];
        let rejectedCount = 0;
        for (const generation of runtime.candidates) {
          try {
            const candidate = await verifyIsolatedManagedGeneration(root, generation) as unknown as Record<string, any>;
            const launch = JSON.parse(await readFile(join(root, "generations", generation, "launch.json"), "utf8"));
            const kind = candidate.backendKind ?? "native-public-mcp", abi = candidate.backendAbi ?? "pkm.mcp.api/1";
            items.push({ generation, backendKind: kind, backendAbi: abi, runtimeBuild: candidate.runtimeBuild,
              compatible: kind === backendKind && (!active || abi === (active.backendAbi ?? "pkm.mcp.api/1")
                && isDeepStrictEqual(candidate.compatibility, active.compatibility)) && launch.data === dataPath });
          } catch { rejectedCount++; }
        }
        return reply(200, { schema: "pkm.shared-service-candidates/v1", serviceId: state.serviceId,
          activeGeneration: activeGeneration ?? null, items, rejectedCount });
      }
      if (req.method !== "POST" || req.headers["content-type"]?.split(";")[0] !== "application/json")
        return reply(404, { error: "Unsupported route.", effect: "not-committed" });
      const input = await requestBody(req);
      if (!management && !businessAllowed(req))
        return reply(401, { error: "Business credential revoked before dispatch.", effect: "not-committed" });
      if (req.url === "/manage/operation-status") {
        if (!managementUuid(input.operationId) || !sha256(input.bodySha256)) fail("Exact management operation UUID and semantic body SHA256 required.");
        const records = durableHistory.filter(item => item.id === input.operationId);
        const record = records.length === 1 && records[0]!.bodySha256 === input.bodySha256 ? records[0] : undefined;
        const executing = managementExecuting.has(input.operationId)
          && state.history!.some(item => item.id === input.operationId && item.bodySha256 === input.bodySha256);
        const outcome = executing ? "pending" : record?.phase === "completed" || record?.phase === "failed" ? "terminal" : "unknown";
        return reply(200, { schema: "pkm.shared-management-outcome/v1", serviceId: state.serviceId,
          operationId: input.operationId, bodySha256: input.bodySha256, status: outcome, ...(record ? { record } : {}),
          automaticReplay: false, absenceIsNotNoncommit: true });
      }
      if (req.url === "/manage/approve") {
        if (!["switch", "recover", "cleanup-runtime", "reset-index", "reconcile", "revoke-access", "human-review-enrollment"].includes(input.action)
          || input.action === "switch" && !uuid(input.generation)
          || input.action === "reconcile" && !uuid(input.receiptId)) fail("Unsupported management action.");
        const bodySha256 = await sharedManagementBodySha256(state.serviceId, input.action, input);
        const correlated = input.operationId !== undefined || input.bodySha256 !== undefined;
        if (correlated && (!managementUuid(input.operationId) || input.bodySha256 !== bodySha256))
          fail("Exact semantic management operation UUID and body SHA256 required.");
        const operationId = correlated ? input.operationId : randomUUID();
        if (state.history!.some(item => item.id === operationId) || managementExecuting.has(operationId)
          || [...approvals.values()].some(item => item.operationId === operationId && item.expires >= Date.now()))
          fail("Management operation already observed or approved; inspect its outcome without re-execution.");
        const approvalId = randomUUID();
        approvals.set(approvalId, { action: input.action, generation: input.generation,
          receiptId: input.receiptId, revision, expires: Date.now() + 60_000, operationId, bodySha256, correlated });
        return reply(200, { approvalId, expiresInSeconds: 60, operationId, bodySha256 });
      }
      if (management) {
        const approval = approvals.get(input.approvalId);
        approvals.delete(input.approvalId);
        const action = req.url!.slice("/manage/".length);
        if (!approval || approval.action !== action || approval.generation !== input.generation
          || approval.receiptId !== input.receiptId
          || approval.revision !== revision || approval.expires < Date.now()) fail("Fresh exact management approval required.");
        const correlated = input.operationId !== undefined || input.bodySha256 !== undefined;
        if ((approval.correlated || correlated)
          && (input.operationId !== approval.operationId || input.bodySha256 !== approval.bodySha256)
          || await sharedManagementBodySha256(state.serviceId, action, input) !== approval.bodySha256)
          fail("Management approval does not match the semantic operation UUID/body SHA256.");
        if (transition || managementExecuting.size) fail("A management operation is already running.");
        if (state.history!.some(item => item.id === approval.operationId))
          fail("Management operation already observed; inspect its outcome without re-execution.");
        if (state.history!.length >= 1024) fail("Durable manager history requires explicit offline archival.");
        const reviewed = action === "reconcile"
          ? state.receipts.find(item => item.id === input.receiptId && item.outcome === "unknown") : undefined;
        if (action === "reconcile" && (!reviewed || input.acknowledge !== "reviewed-outcome-no-replay"))
          fail("Exact reviewed receipt acknowledgment required.");
        if (action === "revoke-access" && (input.acknowledge !== "revoke-current-business-credential"
          || state.revokedCredentials!.length >= 128)) fail("Explicit revocation acknowledgment and bounded history required.");
        if (action === "human-review-enrollment" && (state.phase !== "accepting" || backend?.kind !== "standalone-core"))
          fail("An accepting configured Core is required for separate human enrollment.");
        const record: ManagementRecord = { id: approval.operationId, bodySha256: approval.bodySha256, action,
          from: state.generation ?? null, to: input.generation ?? state.generation ?? null, phase: "prepared", at: Date.now(),
          ...(reviewed ? { from: reviewed.generation, to: reviewed.generation,
            receiptId: reviewed.id, clientId: reviewed.clientId, tool: reviewed.tool } : {}) };
        managementExecuting.add(record.id);
        state.history!.push(record);
        try {
          await save();
          managementOperation = approval;
          if (action === "human-review-enrollment") {
            const owner = backend!;
            const enrollment = await owner.control!("human-enrollment");
            if (owner !== backend || transition
              || enrollment.schema !== "pkm.shared-human-enrollment/v1" || enrollment.generation !== owner.generation
              || typeof enrollment.code !== "string" || !/^[a-f0-9]{64}$/.test(enrollment.code)
              || enrollment.path !== "/human-review" || enrollment.expiresInMs !== 120000)
              fail("Invalid native human enrollment.");
            record.phase = "completed"; await save();
            return reply(200, { ...enrollment, serviceId: state.serviceId, operationId: record.id, bodySha256: record.bodySha256 });
          } else if (action === "revoke-access") {
            if (!state.revokedCredentials!.includes(credentialFingerprint)) state.revokedCredentials!.push(credentialFingerprint);
            revision = randomUUID(); approvals.clear();
          } else if (action === "reconcile") {
            state.receipts = state.receipts.filter(item => item !== reviewed);
          } else await change(action, input.generation, record);
          record.phase = "completed"; await save();
          return reply(200, { ...status(), operationId: record.id, bodySha256: record.bodySha256 });
        } catch (error) {
          if (record.phase === "prepared") record.phase = "failed";
          await save(); throw error;
        } finally { managementExecuting.delete(record.id); }
      }
      if (!uuid(input.clientId)) fail("Exact enrolled client ID required.");
      if (req.url === "/shared/enroll") {
        if (clients.size >= 128 && !clients.has(input.clientId)) fail("Client admission bound reached.");
        clients.add(input.clientId); return reply(200, status());
      }
      if (!clients.has(input.clientId)) fail("Client is not enrolled.");
      if (req.url === "/shared/leave") { clients.delete(input.clientId); return reply(200, { left: true }); }
      if (state.phase !== "accepting" || !backend || transition)
        return reply(503, { error: "Service is not accepting; no call dispatched.", effect: "not-committed" });
      if (req.url === "/shared/tools") return reply(200, { tools: backend.tools });
      if (req.url !== "/shared/call" || typeof input.name !== "string" || controls.has(input.name)
        || !backend.tools.some(tool => tool.name === input.name) || !object(input.arguments)) fail("Unsupported business call.");
      if (backendKind !== "standalone-core" && ["capability_read", "capability_call"].includes(input.name)
        && !admittedOperations.has(input.arguments.operation))
        fail("NOT_AVAILABLE: Shared knowledge scope excludes Chat/background writers and this operation.");
      if (calls.size >= 32 || state.receipts.length >= 128) fail("Call admission bound reached.");
      const owned = backend;
      const receipt: Receipt = { id: randomUUID(), clientId: input.clientId, tool: input.name,
        generation: owned.generation, outcome: "pending" };
      state.receipts.push(receipt);
      const call = (async () => {
        await save();
        try {
          guard.assertHeld();
          businessDispatched = true;
          const result = await owned.client.callTool({ name: input.name, arguments: input.arguments }, undefined, { timeout: 60_000 });
          const envelope = result.structuredContent as { error?: { effect?: string } } | undefined;
          if (envelope?.error?.effect === "unknown") { receipt.outcome = "unknown"; state.phase = "action-required"; }
          else state.receipts = state.receipts.filter(item => item !== receipt);
          await save();
          if (owned.control) {
            const observed = await owned.control("status").catch(() => undefined);
            if (observed) backgroundChat = observed.backgroundChat;
          }
          return { result, receiptId: receipt.id, generation: owned.generation };
        } catch {
          receipt.outcome = "unknown"; state.phase = "action-required"; await save();
          return { error: "Backend outcome unknown. Reconcile this receipt; never replay automatically.",
            effect: "unknown", receiptId: receipt.id, generation: owned.generation };
        }
      })();
      calls.add(call);
      try { return reply(200, await call); } finally { calls.delete(call); }
    } catch (error) {
      if (businessDispatched) state.phase = "action-required";
      reply(409, { error: error instanceof Error ? error.message : "Request failed.",
        effect: businessDispatched || managementOperation ? "unknown" : "not-committed",
        ...(managementOperation ? { operationId: managementOperation.operationId, bodySha256: managementOperation.bodySha256 } : {}) });
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
  await new Promise<void>((ready, reject) => {
    server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", ready);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, serviceId: state.serviceId, status, inspect,
    close() {
      return closing ??= (async () => {
        if (transition || managementExecuting.size) fail("A management transition is still running.");
        transition = true; state.phase = "draining"; await save();
        try {
          await bounded(Promise.all([...calls])); await closeBackend(true);
          await new Promise<void>((ready, reject) => server.close(error => error ? reject(error) : ready()));
          state.phase = state.receipts.length ? "action-required" : "closed"; await save();
          await guard.release();
        } catch (error) { state.phase = "action-required"; await save(); closing = undefined; transition = false; throw error; }
      })();
    },
  };
}
