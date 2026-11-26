import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { compatibilityMcpConfiguration, connectCompatibilityMcp } from "./compatibility-mcp.js";
import { acquireCompatibilityGatewayCustody, type LegacySharedFence } from "./compatibility-gateway-custody.js";
import { createNativePublicFacade } from "./native-public-mcp.js";
import { directModuleTools } from "./native-public-mcp-module-tools.js";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const control = new Set(["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"]);

/**
 * Host-verified executable gateway, not a new Original writer. Selection is
 * deliberately process-local; there is no management endpoint on the relay.
 */
export interface VerifiedCompatibilityGateway {
  readonly generation: string;
  readonly runtimeBuild: string;
  readonly managedRoot: string;
  readonly createFacade: typeof createNativePublicFacade;
  assertVerified(): void;
}

async function body(req: IncomingMessage) {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error("Relay request too large.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!object(value)) throw new Error("Expected a JSON object.");
  return value;
}

export interface CompatibilityGatewayHost {
  acquireLegacyFence(root: string): LegacySharedFence;
  workbenchAttribution: Readonly<Json>;
  chatAttribution: Readonly<Json>;
  assertAllowed?(): void;
  confirm(review: { from: CompatibilityDispatchMode; to: CompatibilityDispatchMode; runtimeBuild: string }): Promise<boolean>;
}

export type CompatibilityDispatchMode = "original" | "bundled-v5";
export type CompatibilitySwitchExpectation = { mode: CompatibilityDispatchMode; selectionRevision: string };
export type CompatibilityGatewayAuthority = Awaited<ReturnType<typeof startCompatibilityGatewayAuthority>>;

export async function startCompatibilityGatewayAuthority(input: unknown, bundled: VerifiedCompatibilityGateway,
  host: CompatibilityGatewayHost, initialMode: CompatibilityDispatchMode = "bundled-v5") {
  const config = compatibilityMcpConfiguration.parse(input);
  if (config.legacy.compatibleUpdates || config.gateway.generation !== bundled.generation
    || config.gateway.runtimeBuild !== bundled.runtimeBuild || config.managedRoot !== bundled.managedRoot
    || !uuid(bundled.generation) || !digest(bundled.runtimeBuild) || bundled.generation === config.legacy.generation
    || initialMode !== "original" && initialMode !== "bundled-v5")
    throw new Error("Exact Original and bundled v5 bindings are required.");
  bundled.assertVerified();
  type Role = "workbench" | "chat";
  const roles = ["workbench", "chat"] as const;
  const attributions = { workbench: structuredClone(host.workbenchAttribution), chat: structuredClone(host.chatAttribution) };
  if (attributions.workbench.source !== "vscode-provider" || attributions.workbench.scope !== "shared-host"
    || attributions.chat.source !== "pkm-chat" || !["shared-host", "chat"].includes(String(attributions.chat.scope)))
    throw new Error("Distinct exact Original launch attribution is required.");
  const custody = await acquireCompatibilityGatewayCustody(config.knowledgeRoot, root => host.acquireLegacyFence(root));
  const originals = new Map<Role, Awaited<ReturnType<typeof connectCompatibilityMcp>>>();
  const original = (role: Role) => originals.get(role)!;
  type Session = { id: string; role: Role; accepting: boolean; inFlight: number };
  const sessions = new Map<string, Session>();
  type Facade = ReturnType<typeof createNativePublicFacade>;
  const facades = new Map<Role, Facade>();
  const shortcuts = new Map<Role, ReturnType<typeof directModuleTools>>();
  const serviceId = randomUUID(), tokens = Object.fromEntries(roles
    .map(role => [role, randomBytes(32).toString("hex")])) as Record<Role, string>;
  const relayIdentity = Object.freeze({ generation: serviceId, runtimeBuild: createHash("sha256")
    .update(JSON.stringify(["pkm.compatibility-relay/v1", bundled.runtimeBuild, config.legacy.runtimeBuild])).digest("hex") });
  let accepting = true, switching = false, inFlight = 0, closed = false, uncertain = false;
  let selectionRevision = randomUUID();
  let mode = initialMode;
  const originalUncertain = () => Math.max(0, ...[...originals.values()].map(item => item.identity.health.uncertainCalls));
  const originalInFlight = () => [...originals.values()].reduce((total, item) => total + item.identity.health.inFlight, 0);

  async function prepare() {
    for (const role of roles) {
      const upstream = original(role);
      const options = {
        manifest: { schema: "pkm.mcp.lifecycle/v1", managedRoot: bundled.managedRoot,
          generation: bundled.generation, runtimeBuild: bundled.runtimeBuild, version: "0.1.0",
          components: upstream.originalVersion.components, enabledFeatureDomains: [] },
        adapterCatalog: upstream.catalog, adapterIdentity: upstream.identity, writable: config.writable,
        catalogProfile: "original-full" as const, profile: "compact", toolSurface: "hybrid" as const, serverName: "pkm" as const,
        closeBackend: async () => {},
      };
      const facade = bundled.createFacade({ invoke: upstream.backend.invoke, close: async () => {} }, options);
      facades.set(role, facade);
      await verifyBundled(role);
      const current = role === "chat" ? facades.get("workbench") : undefined;
      if (current && (!isDeepStrictEqual(facade.definitions, current.definitions) || facade.instructions !== current.instructions))
        throw new Error("Gateway tool contracts differ.");
      const enabled = new Set(upstream.catalog.contracts.filter(item => config.writable || item.readOnly).map(item => item.id));
      shortcuts.set(role, directModuleTools(upstream.catalog.contracts, enabled, config.writable));
    }
  }
  async function verifyBundled(role: Role) {
    const { backend, runtime } = version(await facades.get(role)!.invoke("check_version", {}));
    if (!object(backend) || backend.storageEngine !== "original" || backend.storageMigrated !== false
      || backend.runtimeBuild !== config.legacy.runtimeBuild || backend.generation !== config.legacy.generation
      || backend.catalogRevision !== original(role).identity.catalogRevision
      || !object(runtime) || runtime.generation !== bundled.generation || runtime.runtimeBuild !== bundled.runtimeBuild
      || runtime.phase !== "accepting" || runtime.controlError)
      throw new Error("Gateway did not report the pinned Original authority and exact live generation.");
  }
  function version(result: Awaited<ReturnType<ReturnType<typeof createNativePublicFacade>["invoke"]>>) {
    const value = result.structuredContent ?? JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));
    if (result.isError || !object(value)) throw new Error("Unverified gateway version observation.");
    return value;
  }
  function available() {
    try { host.assertAllowed?.(); custody.assertHeld(); } catch { accepting = false; }
    return accepting && !uncertain && !closed && originals.size === roles.length
      && [...originals.values()].every(item => item.identity.health.phase === "accepting") && !originalUncertain();
  }
  const localStatus = (session: Session) => ({
    schema: "pkm.mcp.lifecycle/v1", ...relayIdentity,
    instanceId: session.id, acceptingNewCalls: session.accepting && available() && !switching,
    phase: !available() ? "action-required" : session.accepting
      ? switching ? "draining" : "accepting" : session.inFlight ? "draining" : "drained",
    inFlight: session.inFlight, uncertainCalls: Math.max(Number(uncertain), originalUncertain()),
    controlError: "", automaticReplay: false,
  });
  const toolResult = (value: Json) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const refused = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });

  async function invokeOriginal(role: Role, name: string, args: Json) {
    const upstream = original(role);
    const shortcut = shortcuts.get(role)!.find(item => item.tool.name === name);
    if (shortcut) return upstream.backend.invoke("original_mcp_public", {
      tool: shortcut.operationId.slice("mcp.tool.".length), arguments: args,
    });
    if (name === "capability_read" || name === "capability_call") {
      const read = name === "capability_read";
      if (typeof args.operation !== "string" || args.version !== 1 || !object(args.arguments)
        || Object.keys(args).some(key => !["operation", "version", "arguments", "worker_token"].includes(key)))
        return refused("INVALID_ARGUMENT: Pin version 1 and provide object arguments.");
      if (!read && !config.writable) return refused("ACCESS_DENIED: This route is read-only.");
      if (args.operation.startsWith("mcp.tool.")) {
        const leaf = upstream.catalog.contracts.find(item => item.id === args.operation);
        if (!leaf || leaf.readOnly !== read) return refused("ACCESS_DENIED: Unknown operation or wrong read/write entry.");
        const fields = { ...args.arguments };
        if (args.worker_token != null) {
          if (!object(leaf.inputSchema.properties) || !("worker_token" in leaf.inputSchema.properties) || "worker_token" in fields)
            return refused("INVALID_ARGUMENT: Invalid worker token argument.");
          fields.worker_token = args.worker_token;
        }
        return upstream.backend.invoke("original_mcp_public", { tool: leaf.transportName, arguments: fields });
      }
      const { worker_token, ...input } = args;
      const raw = await upstream.backend.invoke(read ? "legacy_capability_read" : "legacy_capability_call",
        { action: read ? "read" : "call", args: input, workerToken: worker_token });
      if (raw.isError) return raw;
      return toolResult(version(raw));
    }
    // Keep paginated discovery revision, visible tool schema and inventory stable for already-connected clients.
    if (["capabilities_list", "capabilities_search", "capabilities_describe", "capabilities_inventory"].includes(name))
      return facades.get(role)!.invoke(name, args);
    return refused("NOT_AVAILABLE: Tool is not exposed here.");
  }

  async function invoke(session: Session, name: string, args: Json) {
    if (name === "mcp_lifecycle_quiesce") session.accepting = false;
    if (name === "mcp_lifecycle_status" || name === "mcp_lifecycle_quiesce") return toolResult(localStatus(session));
    if (!available() || switching || !session.accepting)
      return refused("BUSY: Gateway unavailable or draining; no call dispatched. No request was replayed.");
    session.inFlight++; inFlight++;
    try {
      if (name === "check_version") {
        const observed = mode === "original" ? await original(session.role).observeVersion(args)
          : version(await facades.get(session.role)!.invoke(name, args));
        const upstream = original(session.role).originalVersion.runtime as Json;
        return toolResult({ ...observed, dispatchMode: mode,
          routeRuntime: { ...localStatus(session), inFlight: session.inFlight - 1 },
          originalConnection: { instanceId: upstream.instanceId, attribution: upstream.attribution } });
      }
      return mode === "original" ? await invokeOriginal(session.role, name, args)
        : await facades.get(session.role)!.invoke(name, args);
    }
    catch {
      // These facades throw for pre-dispatch validation as well as dispatch failures.
      // Original owns the dispatch receipt; loss of that channel is sticky.
      uncertain ||= originalUncertain() > 0;
      return refused("Gateway call failed. Do not retry an uncertain effect.");
    } finally { session.inFlight--; inFlight--; }
  }

  let origin = "";
  const authorization = Object.fromEntries(roles.map(role => [role, Buffer.from(`Bearer ${tokens[role]}`)])) as Record<Role, Buffer>;
  const server = createServer(async (req, res) => {
    function reply(code: number, value: Json) {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    }
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const role = roles.find(role => supplied.length === authorization[role].length && timingSafeEqual(supplied, authorization[role]));
      if (req.method !== "POST" || req.headers.host !== new URL(origin).host || req.headers.origin !== undefined
        || req.headers["x-pkm-service-id"] !== serviceId || !role || req.headers["content-type"] !== "application/json")
        return reply(403, { error: "Private relay only." });
      const input = await body(req);
      if (!uuid(input.clientId)) return reply(400, { error: "Expected exact relay session." });
      if (req.url === "/shared/enroll") {
        if (!available() || switching || sessions.has(input.clientId) || sessions.size >= 64)
          return reply(409, { error: "Cannot enroll relay." });
        sessions.set(input.clientId, { id: input.clientId, role, accepting: true, inFlight: 0 });
        return reply(200, { instructions: facades.get(role)!.instructions });
      }
      const session = sessions.get(input.clientId);
      if (!session || session.role !== role) return reply(409, { error: "Unknown relay session." });
      if (req.url === "/shared/leave") {
        session.accepting = false;
        sessions.delete(input.clientId);
        if (session.inFlight) uncertain = true;
        return reply(200, {});
      }
      if (req.url === "/shared/tools") return reply(200, { tools: facades.get(role)!.definitions });
      if (req.url === "/shared/call" && typeof input.name === "string" && object(input.arguments)) {
        let terminal = false;
        const disconnected = () => { if (!terminal && !control.has(input.name as string)) uncertain = true; };
        res.once("close", disconnected);
        const result = await invoke(session, input.name, input.arguments);
        terminal = true;
        res.off("close", disconnected);
        return reply(200, { result });
      }
      return reply(404, { error: "Unknown relay route." });
    } catch { if (!res.headersSent) reply(400, { error: "Relay request failed; no replay." }); }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  try {
    for (const role of roles) {
      custody.assertHeld();
      const adapter = await connectCompatibilityMcp(config, { attribution: attributions[role] });
      originals.set(role, adapter);
      adapter.onFailure(() => { accepting = false; });
      if (!isDeepStrictEqual((adapter.originalVersion.runtime as Json).attribution, attributions[role]))
        throw new Error("Actual Original launch attribution does not match the host-owned client role.");
    }
    await prepare();
    await new Promise<void>((ready, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); ready(); });
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  } catch (error) {
    const outcomes = await Promise.allSettled([...facades.values(), ...originals.values()].map(item => item.close()));
    await custody.release(false);
    const failures = outcomes.flatMap(item => item.status === "rejected" ? [item.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures]);
    throw error;
  }

  const identity = (value: CompatibilityDispatchMode) => value === "original" ? config.legacy : bundled;
  function assertSwitchable(expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode) {
    if (!available() || switching || inFlight || originalInFlight()
      || mode !== expected.mode || selectionRevision !== expected.selectionRevision || mode === target
      || target !== "original" && target !== "bundled-v5")
      throw new Error("Gateway selection changed or outstanding work blocks switching; no switch applied.");
  }
  async function approveSwitch(expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode) {
    expected = { ...expected };
    assertSwitchable(expected, target);
    if (!await host.confirm({ from: expected.mode, to: target, runtimeBuild: identity(target).runtimeBuild }))
      return { applied: false, status: status() };
    assertSwitchable(expected, target);
    switching = true;
    try {
      if (target === "bundled-v5") bundled.assertVerified();
      const results = await Promise.allSettled(roles.map(async role => {
        await original(role).observeVersion({}, true);
        if (target === "bundled-v5") await verifyBundled(role);
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (!available() || inFlight || originalInFlight()) throw new Error("Gateway no longer accepts handoff.");
      // Linearization point: both existing relays resolve the same active reference.
      mode = target;
      selectionRevision = randomUUID();
    } finally { switching = false; }
    return { applied: true, status: status() };
  }
  function status() {
    const active = identity(mode);
    const candidates = (["original", "bundled-v5"] as const).map(mode => {
      const { generation, runtimeBuild } = identity(mode);
      return { mode, generation, runtimeBuild };
    });
    return { mode, generation: active.generation, runtimeBuild: active.runtimeBuild, selectionRevision, candidates, inFlight,
      phase: !available() ? "action-required" : switching ? "draining" : "accepting",
      uncertain: uncertain || originalUncertain() > 0, automaticReplay: false,
      originalBuild: config.legacy.runtimeBuild, storageEngine: "original", storageMigrated: false,
      originalConnections: roles.map(role => ({ role, supervisorPid: original(role).adapterPid,
        runtime: original(role).originalVersion.runtime, health: original(role).identity.health })) };
  }
  let closing: Promise<void> | undefined;
  return {
    // Not a management credential; never expose to Webviews, settings, or browsers.
    relay(role: Role) {
      if (!roles.includes(role) || closed) throw new Error("Unknown or closed compatibility relay.");
      return { origin, serviceId, token: tokens[role] };
    },
    relayIdentity, approveSwitch, status,
    close() {
      if (switching || inFlight) return Promise.reject(new Error("Cannot close while gateway work is outstanding."));
      return closing ??= (async () => {
        accepting = false; closed = true;
        const outcomes = await Promise.allSettled([
          new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
          ...[...facades.values()].map(facade => facade.close()),
          ...[...originals.values()].map(item => item.close()),
        ]);
        const failures = outcomes.flatMap(item => item.status === "rejected" ? [item.reason] : []);
        await custody.release(!uncertain && !originalUncertain() && failures.length === 0);
        if (failures.length || uncertain || originalUncertain())
          throw new AggregateError(failures, "Original custody requires explicit recovery; no result was inferred or replayed.");
      })();
    },
  };
}
