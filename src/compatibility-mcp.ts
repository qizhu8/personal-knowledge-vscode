import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { startNativePublicMcp, type NativePublicBackend, type NativePublicCatalog } from "./native-public-mcp.js";
import { createNativePublicStdio } from "./native-public-mcp-stdio.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.strictObject({ path: z.string().min(1), sha256: digest });
export const compatibilityMcpConfiguration = z.strictObject({
  schema: z.literal("pkm.compatibility-mcp/v1"),
  knowledgeRoot: z.string(), managedRoot: z.string(),
  node: file, supervisor: file, python: z.string(),
  legacy: z.strictObject({
    launcher: file, generation: z.string().uuid(), runtimeBuild: digest, version: z.string(),
    components: z.record(z.string(), z.string()).refine(value => Object.keys(value).length > 0),
    compatibleUpdates: z.boolean().default(false),
  }),
  gateway: z.strictObject({ generation: z.string().uuid(), runtimeBuild: digest }),
  serverName: z.literal("pkm").optional(),
  writable: z.boolean(),
});
type Configuration = z.infer<typeof compatibilityMcpConfiguration>;
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function pinnedFile(pin: z.infer<typeof file>, maximum: number) {
  const stat = lstatSync(pin.path);
  if (realpathSync(pin.path) !== pin.path || !stat.isFile() || stat.isSymbolicLink() || stat.size > maximum
    || hash(readFileSync(pin.path)) !== pin.sha256)
    throw new Error("COMPATIBILITY_RUNTIME_CHANGED: The reviewed adapter runtime changed; no request was replayed.");
}
function value(response: CallToolResult): Json {
  if (response.isError) throw new Error(response.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
  const raw: unknown = response.structuredContent
    ?? JSON.parse(response.content.filter(part => part.type === "text").map(part => part.text).join(""));
  if (!object(raw)) throw new Error("INVALID_ADAPTER_RESULT: Expected an actual original MCP object.");
  return raw;
}
const contractSchema = z.object({
  id: z.string().startsWith("mcp.tool."), version: z.literal(1), transportName: z.string(),
  description: z.string(), readOnly: z.boolean(), revision: digest,
  inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** One original business adapter, not a second database/storage owner. */
export async function connectCompatibilityMcp(input: unknown, launch?: { attribution: Readonly<Json>; custodyGrant?: string }) {
  const config = compatibilityMcpConfiguration.parse(input);
  for (const root of [config.knowledgeRoot, config.managedRoot]) {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
      throw new Error("COMPATIBILITY_ROOT_CHANGED");
  }
  pinnedFile(config.node, 512 * 1024 * 1024);
  pinnedFile(config.supervisor, 1024 * 1024);
  pinnedFile(config.legacy.launcher, 1024 * 1024);
  if (!lstatSync(realpathSync(config.python)).isFile()) throw new Error("COMPATIBILITY_PYTHON_UNAVAILABLE");
  const client = new Client({ name: "pkm-v5-original-business-adapter", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: config.python,
    args: ["-B", config.supervisor.path, config.python, "-B", config.legacy.launcher.path],
    cwd: config.knowledgeRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PKM_NODE_EXECUTABLE: config.node.path,
      PKM_CAPABILITY_PROFILE: "compact", PYTHONDONTWRITEBYTECODE: "1",
      PKM_COMPATIBILITY_LAUNCH_GRANT: launch?.custodyGrant ?? "",
      ...(launch ? { PKM_MCP_LAUNCH_ATTRIBUTION: JSON.stringify(launch.attribution) } : {}) },
    stderr: "inherit",
  });
  let upstreamIdentity: { generation: unknown; instanceId: unknown; runtimeBuild: unknown } | undefined;
  let closed = false, admissionClosed = false, closing: Promise<void> | undefined, failure: Error | undefined;
  const pending = new Map<symbol, boolean>(), uncertain = new Set<symbol>(), listeners = new Set<() => void>();
  const unavailable = () => new Error(`COMPATIBILITY_ADAPTER_UNAVAILABLE: Original adapter disconnected or returned an unverified response; uncertain writes: ${uncertain.size}. No request was replayed.`);
  const failed = (error: unknown) => {
    for (const [id, write] of pending) if (write) uncertain.add(id);
    if (!failure) {
      failure = error instanceof Error ? error : unavailable();
      for (const listener of listeners) listener();
    }
  };
  client.onclose = () => { if (!closing && !closed) failed(unavailable()); };
  client.onerror = error => { if (!closed) failed(error); };
  const call = async (name: string, args: Json, write = false, timeout = 600_000): Promise<CallToolResult> => {
    const id = Symbol(name);
    pending.set(id, write);
    try {
      const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout }));
      uncertain.delete(id);
      return response;
    } catch (error) {
      if (write) uncertain.add(id);
      failed(error);
      throw error;
    } finally { pending.delete(id); }
  };
  const checkLegacy = (reply: Json, requireIdle = true) => {
    const runtime = reply.runtime, components = reply.components;
    const sameBuild = object(runtime) && runtime.generation === config.legacy.generation && runtime.runtimeBuild === config.legacy.runtimeBuild;
    if (reply.version !== config.legacy.version || !object(runtime)
      || !z.string().uuid().safeParse(runtime.generation).success || !digest.safeParse(runtime.runtimeBuild).success
      || typeof runtime.instanceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(runtime.instanceId)
      || !sameBuild && !config.legacy.compatibleUpdates
      || !object(components) || Object.keys(components).length !== Object.keys(config.legacy.components).length
      || Object.entries(config.legacy.components).some(([key, expected]) => components[key] !== expected)
      || upstreamIdentity && (runtime.generation !== upstreamIdentity.generation
        || runtime.instanceId !== upstreamIdentity.instanceId || runtime.runtimeBuild !== upstreamIdentity.runtimeBuild)
      || runtime.phase !== "accepting" || runtime.acceptingNewCalls !== true
      || requireIdle && (runtime.inFlight !== 0 || runtime.uncertainCalls !== 0))
      throw new Error("COMPATIBILITY_ADAPTER_IDENTITY_MISMATCH: Original adapter version/build changed; reconnect explicitly.");
  };
  try {
    await client.connect(transport);
    const originalVersion = value(await call("check_version", {}));
    checkLegacy(originalVersion);
    if (!object(originalVersion.runtime))
      throw new Error("COMPATIBILITY_ADAPTER_IDENTITY_MISMATCH");
    upstreamIdentity = { generation: originalVersion.runtime.generation, instanceId: originalVersion.runtime.instanceId,
      runtimeBuild: originalVersion.runtime.runtimeBuild };
    const definitions: Tool[] = [];
    for (let cursor: string | undefined, count = 0;;) {
      if (++count > 32) throw new Error("COMPATIBILITY_CATALOG_LIMIT");
      const page = await client.listTools(cursor ? { cursor } : {});
      definitions.push(...page.tools);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const required = ["capabilities_list", "capabilities_search", "capabilities_describe", "capabilities_inventory",
      "capability_read", "capability_call", "check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"];
    if (definitions.length !== required.length || new Set(definitions.map(tool => tool.name)).size !== definitions.length
      || required.some(name => !definitions.some(tool => tool.name === name)))
      throw new Error("COMPATIBILITY_LIFECYCLE_OR_DISCOVERY_UNAVAILABLE");
    const ids = new Set<string>();
    let revision: string | undefined, offset = 0, total = -1;
    for (let pages = 0;;) {
      if (++pages > 512) throw new Error("COMPATIBILITY_CATALOG_LIMIT");
      const page = value(await call("capabilities_list", { path: "mcp.tool", offset, limit: 10,
        ...(revision ? { revision } : {}) }));
      if (typeof page.revision !== "string" || !/^[a-f0-9]{64}$/.test(page.revision)
        || revision && page.revision !== revision || !Array.isArray(page.operations)
        || !Number.isSafeInteger(page.total) || Number(page.total) < 1 || Number(page.total) > 4096
        || page.offset !== offset || total !== -1 && total !== page.total)
        throw new Error("COMPATIBILITY_CATALOG_CHANGED");
      revision = page.revision; total = Number(page.total);
      for (const entry of page.operations) {
        if (!object(entry) || typeof entry.id !== "string" || !entry.id.startsWith("mcp.tool.") || ids.has(entry.id))
          throw new Error("COMPATIBILITY_CATALOG_INVALID");
        ids.add(entry.id);
      }
      if (page.nextOffset === null) break;
      if (!Number.isSafeInteger(page.nextOffset) || Number(page.nextOffset) <= offset)
        throw new Error("COMPATIBILITY_CATALOG_DID_NOT_PROGRESS");
      offset = Number(page.nextOffset);
    }
    if (ids.size !== total) throw new Error("COMPATIBILITY_CATALOG_INCOMPLETE");
    const contracts: NativePublicCatalog["contracts"] = [];
    const contractBytes: Record<string, number> = {};
    const numericLexemes: NonNullable<NativePublicCatalog["numericLexemes"]> = [];
    for (const id of ids) {
      const response = await call("capabilities_describe", { operation: id });
      const parsed = contractSchema.parse(value(response));
      if (parsed.id !== id || parsed.revision !== revision || parsed.id !== `mcp.tool.${parsed.transportName}`)
        throw new Error("COMPATIBILITY_CATALOG_CHANGED");
      const text = response.content.filter(part => part.type === "text").map(part => part.text).join("");
      const numbers = new WeakMap<object, Map<string, string>>();
      const raw: unknown = JSON.parse(text, function(key: string, entry: unknown, context?: { source?: string }) {
        if (typeof entry === "number" && context?.source && this && typeof this === "object") {
          const entries = numbers.get(this) ?? new Map<string, string>();
          entries.set(key, context.source); numbers.set(this, entries);
        }
        return entry;
      });
      if (!object(raw) || JSON.stringify(raw) !== JSON.stringify(value(response)))
        throw new Error("COMPATIBILITY_METADATA_CHANNEL_MISMATCH");
      const paths = (item: unknown, path: (string | number)[]) => {
        if (!item || typeof item !== "object") return;
        for (const [key, entry] of Object.entries(item)) {
          const field = Array.isArray(item) ? Number(key) : key;
          const source = numbers.get(item)?.get(key);
          if (source) numericLexemes.push({ path: [id, ...path, field], source });
          paths(entry, [...path, field]);
        }
      };
      paths(raw, []);
      const { revision: _revision, ...metadata } = raw;
      const { revision: _parsedRevision, ...contract } = parsed;
      contracts.push({ ...metadata, ...contract, outputSchema: parsed.outputSchema ?? null });
      contractBytes[id] = Math.max(Buffer.byteLength(JSON.stringify(metadata)),
        ...response.content.filter(part => part.type === "text").map(part => Buffer.byteLength(part.text))) + 256;
    }
    checkLegacy(value(await call("check_version", {})));
    const catalog: NativePublicCatalog = {
      definitions, wireDefinitions: definitions, contracts, routing: {}, contractBytes, floatPaths: [], numericLexemes,
      variants: { "100": { names: contracts.map(item => item.transportName), revision: revision! },
        "000": { names: contracts.filter(item => item.readOnly).map(item => item.transportName), revision: revision! } },
    };
    const byName = new Map(contracts.map(item => [item.transportName, item]));
    const backend: NativePublicBackend = {
      async invoke(name, raw) {
        if (admissionClosed || !object(raw)) throw new Error("COMPATIBILITY_ADAPTER_CLOSED");
        if (failure) throw unavailable();
        if (name === "original_mcp_public") {
          if (typeof raw.tool !== "string" || !object(raw.arguments)) throw new Error("INVALID_ARGUMENT");
          const operation = byName.get(raw.tool);
          if (!operation || !config.writable && !operation.readOnly) throw new Error("ACCESS_DENIED");
          return call(operation.readOnly ? "capability_read" : "capability_call",
            { operation: operation.id, version: 1, arguments: raw.arguments }, !operation.readOnly);
        }
        if (name === "legacy_capability_read" || name === "legacy_capability_call") {
          if (typeof raw.action !== "string" || !object(raw.args)) throw new Error("INVALID_ARGUMENT");
          if (raw.action === "call" && !config.writable) throw new Error("ACCESS_DENIED");
          const method = { list: "capabilities_list", search: "capabilities_search", describe: "capabilities_describe",
            read: "capability_read", call: "capability_call" }[raw.action];
          if (!method) throw new Error("INVALID_ARGUMENT");
          return call(method, { ...raw.args, ...(raw.workerToken !== undefined ? { worker_token: raw.workerToken } : {}) },
            raw.action === "call");
        }
        throw new Error("COMPATIBILITY_ADAPTER_OPERATION_UNAVAILABLE");
      },
      close,
    };
    const health = () => ({ phase: closed ? "closed" : failure ? "unavailable" : admissionClosed ? "draining" : "accepting",
      inFlight: pending.size, uncertainCalls: uncertain.size, automaticReplay: false });
    return { backend, catalog, originalVersion, close, adapterPid: transport.pid,
      async observeVersion(args: Json = {}, requireIdle = false) {
        if (admissionClosed || failure) throw unavailable();
        const reply = value(await call("check_version", args, false, 10_000));
        try { checkLegacy(reply, false); }
        catch (error) { failed(error); throw error; }
        if (requireIdle && object(reply.runtime) && (reply.runtime.inFlight !== 0 || reply.runtime.uncertainCalls !== 0))
          throw new Error("Original reports outstanding or uncertain calls; no switch applied.");
        return reply;
      },
      onFailure(listener: () => void) { listeners.add(listener); if (failure) listener(); },
      identity: Object.freeze({ architecture: "v5-mcp-with-original-business-adapter",
        storageEngine: "original", storageMigrated: false, operations: total, catalogRevision: revision,
        version: originalVersion.version, generation: upstreamIdentity.generation, runtimeBuild: upstreamIdentity.runtimeBuild,
        compatibleBusinessUpdates: config.legacy.compatibleUpdates, get health() { return health(); } }) };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Compatibility startup failed; adapter shutdown is unconfirmed."); }
    throw error;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    admissionClosed = true;
    let drainUnverified = false;
    const attempt = (async () => {
      if (closed) return;
      const child = (transport as unknown as { _process?: ChildProcess })._process;
      if (!child) {
        await client.close(); closed = true;
        if (uncertain.size) throw new Error("COMPATIBILITY_ADAPTER_EXIT_UNKNOWN: An admitted write has an unknown outcome; no request was replayed.");
        if (failure && upstreamIdentity) throw new Error("COMPATIBILITY_ADAPTER_EXITED_BEFORE_DRAIN");
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        await client.close(); closed = true;
        if (uncertain.size) throw new Error("COMPATIBILITY_ADAPTER_EXIT_UNKNOWN: An admitted write has an unknown outcome; no request was replayed.");
        throw new Error("COMPATIBILITY_ADAPTER_EXITED_BEFORE_DRAIN");
      }
      const first = value(await call("mcp_lifecycle_quiesce", {}));
      const deadline = Date.now() + 120000;
      let state = first;
      const observed = upstreamIdentity ?? { generation: state.generation, instanceId: state.instanceId, runtimeBuild: state.runtimeBuild };
      const checkDrain = () => {
        if (state.generation !== observed.generation || state.instanceId !== observed.instanceId
          || state.runtimeBuild !== observed.runtimeBuild || state.acceptingNewCalls !== false
          || !Number.isSafeInteger(state.inFlight) || Number(state.inFlight) < 0
          || !Number.isSafeInteger(state.uncertainCalls) || Number(state.uncertainCalls) < 0
          || typeof state.controlError !== "string" || state.controlError) {
          drainUnverified = true;
          throw new Error("COMPATIBILITY_ADAPTER_DRAIN_UNKNOWN");
        }
      };
      checkDrain();
      while (state.inFlight !== 0 || state.uncertainCalls !== 0 || state.phase !== "drained") {
        if (Date.now() >= deadline) {
          drainUnverified = true;
          throw new Error("COMPATIBILITY_ADAPTER_DRAIN_UNKNOWN: No process was killed and no write was replayed.");
        }
        await new Promise(resolve => setTimeout(resolve, 25));
        state = value(await call("mcp_lifecycle_status", {}));
        checkDrain();
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error("COMPATIBILITY_ADAPTER_EXIT_UNKNOWN")); }, 30000);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0 && signal === null) resolve();
          else reject(new Error("COMPATIBILITY_ADAPTER_EXIT_UNKNOWN"));
        });
        child.stdin!.end();
      });
      await client.close();
      closed = true;
      if (uncertain.size) throw new Error("COMPATIBILITY_ADAPTER_EXIT_UNKNOWN: An admitted write has an unknown outcome; no request was replayed.");
    })();
    closing = attempt.catch(error => {
      if (drainUnverified && !closed && !failure) closing = undefined;
      throw error;
    });
    return closing;
  }
}

export async function startCompatibilityMcp(input: unknown) {
  const config: Configuration = compatibilityMcpConfiguration.parse(input);
  const adapter = await connectCompatibilityMcp(config);
  try {
    const boundary = createNativePublicStdio();
    const manifest = { schema: "pkm.mcp.lifecycle/v1", managedRoot: config.managedRoot,
      generation: config.gateway.generation, runtimeBuild: config.gateway.runtimeBuild, version: "0.1.0",
      components: adapter.originalVersion.components, enabledFeatureDomains: [] };
    const server = await startNativePublicMcp(adapter.backend, {
      writable: config.writable, manifest, catalogProfile: "original-full", adapterCatalog: adapter.catalog,
      adapterIdentity: adapter.identity, profile: "compact", toolSurface: "hybrid",
      serverName: config.serverName, closeBackend: async () => {},
    }, boundary.transport, boundary);
    adapter.onFailure(() => { server.lifecycle.quiesce(); });
    return server;
  } catch (error) {
    try { await adapter.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Compatibility gateway failed and adapter drain is unconfirmed."); }
    throw error;
  }
}
