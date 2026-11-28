import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { compatibilityMcpConfiguration, connectCompatibilityMcp } from "./compatibility-mcp.js";
import { acquireCompatibilityGatewayCustody, type LegacySharedFence } from "./compatibility-gateway-custody.js";
import { createNativePublicFacade } from "./native-public-mcp.js";
import { directModuleTools } from "./native-public-mcp-module-tools.js";

type Json = Record<string, unknown>;
type ToolResult = Awaited<ReturnType<ReturnType<typeof createNativePublicFacade>["invoke"]>>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const control = new Set(["check_version", "mcp_lifecycle_status", "mcp_lifecycle_quiesce"]);

/**
 * Host-verified executable gateway, not a new Original writer. Selection is
 * owned by the admitted host; management credentials never reach tool relays.
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
  relayRoles?: readonly ("workbench" | "chat")[];
  externalPeer?: { writable: boolean; memberId?: string;
    process?: { pid: number; startTimeTicks: string; bootId: string } };
  acquireLegacyFence(root: string): LegacySharedFence;
  acquireCustody?(root: string): ReturnType<typeof acquireCompatibilityGatewayCustody>;
  workbenchAttribution: Readonly<Json>;
  chatAttribution: Readonly<Json>;
  assertAllowed?(): void;
  hasActiveChatWork?(): boolean;
  confirm(review: { from: CompatibilityDispatchMode; to: CompatibilityDispatchMode; runtimeBuild: string }): Promise<boolean>;
}

export type CompatibilityDispatchMode = "original" | "bundled-v5";
export type CompatibilitySwitchExpectation = { mode: CompatibilityDispatchMode; selectionRevision: string };
export interface CompatibilityGatewaySelection {
  mode: CompatibilityDispatchMode;
  selectionRevision: string;
  switching: boolean;
  failed: boolean;
}
export type CompatibilityGatewayAuthority = Awaited<ReturnType<typeof startCompatibilityGatewayAuthority>>;

export async function startCompatibilityGatewayAuthority(input: unknown, bundled: VerifiedCompatibilityGateway,
  host: CompatibilityGatewayHost, initialMode: CompatibilityDispatchMode = "bundled-v5",
  shared?: CompatibilityGatewaySelection) {
  const config = compatibilityMcpConfiguration.parse(input);
  if (config.legacy.compatibleUpdates || config.gateway.generation !== bundled.generation
    || config.gateway.runtimeBuild !== bundled.runtimeBuild || config.managedRoot !== bundled.managedRoot
    || !uuid(bundled.generation) || !digest(bundled.runtimeBuild) || bundled.generation === config.legacy.generation
    || initialMode !== "original" && initialMode !== "bundled-v5")
    throw new Error("Exact Original and bundled v5 bindings are required.");
  bundled.assertVerified();
  type Role = "workbench" | "chat";
  const roles = host.relayRoles ?? ["workbench", "chat"] as const;
  if (!roles.includes("workbench") || new Set(roles).size !== roles.length
    || roles.some(role => !["workbench", "chat"].includes(role))) throw new Error("Invalid relay roles.");
  const attributions = { workbench: structuredClone(host.workbenchAttribution), chat: structuredClone(host.chatAttribution) };
  const readOnlyCli = !config.writable && roles.length === 1 && attributions.workbench.source === "standalone"
    && attributions.workbench.scope === "unknown";
  const external = !!shared && roles.length === 1 && host.externalPeer?.writable === config.writable
    && attributions.workbench.source === "standalone" && attributions.workbench.scope === "unknown";
  if (!readOnlyCli && !external && (attributions.workbench.source !== "vscode-provider" || attributions.workbench.scope !== "shared-host")
    || roles.includes("chat") && (attributions.chat.source !== "pkm-chat"
      || !["shared-host", "chat"].includes(String(attributions.chat.scope))))
    throw new Error("Distinct exact Original launch attribution is required.");
  const custody = await (host.acquireCustody?.(config.knowledgeRoot)
    ?? acquireCompatibilityGatewayCustody(config.knowledgeRoot, root => host.acquireLegacyFence(root)));
  const originals = new Map<Role, Awaited<ReturnType<typeof connectCompatibilityMcp>>>();
  const original = (role: Role) => originals.get(role)!;
  type Session = { id: string; role: Role; accepting: boolean; inFlight: number };
  const sessions = new Map<string, Session>();
  type Facade = ReturnType<typeof createNativePublicFacade>;
  const facades = new Map<Role, Facade>();
  const bundledVersions = new Map<Role, string>();
  const shortcuts = new Map<Role, ReturnType<typeof directModuleTools>>();
  const serviceId = randomUUID(), tokens = Object.fromEntries(roles
    .map(role => [role, randomBytes(32).toString("hex")])) as Record<Role, string>;
  const relayIdentity = Object.freeze({ generation: serviceId, runtimeBuild: createHash("sha256")
    .update(JSON.stringify(["pkm.compatibility-relay/v1", bundled.runtimeBuild, config.legacy.runtimeBuild])).digest("hex") });
  let accepting = true, switching = false, inFlight = 0, stopping = false, closed = false, uncertain = false;
  const selection = shared ?? { mode: initialMode, selectionRevision: randomUUID(), switching: false, failed: false };
  const currentMode = () => selection.mode;
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
    const observed = version(await facades.get(role)!.invoke("check_version", {}));
    const { backend, runtime } = observed;
    if (!object(backend) || backend.storageEngine !== "original" || backend.storageMigrated !== false
      || backend.runtimeBuild !== config.legacy.runtimeBuild || backend.generation !== config.legacy.generation
      || backend.catalogRevision !== original(role).identity.catalogRevision
      || !object(runtime) || runtime.generation !== bundled.generation || runtime.runtimeBuild !== bundled.runtimeBuild
      || runtime.phase !== "accepting" || runtime.controlError || typeof observed.version !== "string" || !observed.version)
      throw new Error("Gateway did not report the pinned Original authority and exact live generation.");
    bundledVersions.set(role, observed.version);
  }
  function version(result: Awaited<ReturnType<ReturnType<typeof createNativePublicFacade>["invoke"]>>) {
    const value = result.structuredContent ?? JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));
    if (result.isError || !object(value)) throw new Error("Unverified gateway version observation.");
    return value;
  }
  function available() {
    try { host.assertAllowed?.(); custody.assertHeld(); } catch { accepting = false; }
    return accepting && !selection.failed && !uncertain && !closed && originals.size === roles.length
      && [...originals.values()].every(item => item.identity.health.phase === "accepting") && !originalUncertain();
  }
  const localStatus = (session: Session) => ({
    schema: "pkm.mcp.lifecycle/v1", ...relayIdentity,
    instanceId: session.id, acceptingNewCalls: session.accepting && available() && !switching && !selection.switching && !stopping,
    phase: !available() ? "action-required" : session.accepting
      ? switching || selection.switching || stopping ? "draining" : "accepting" : session.inFlight ? "draining" : "drained",
    inFlight: session.inFlight, uncertainCalls: Math.max(Number(uncertain), originalUncertain()),
    controlError: "", automaticReplay: false,
    ...(host.externalPeer ? { participant: { source: "external", writable: config.writable,
      memberId: host.externalPeer.memberId, process: host.externalPeer.process,
      verifiedBy: "authenticated-owner-rendezvous" } } : {}),
  });
  const toolResult = (value: Json): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const refused = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

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
    if (!available() || switching || selection.switching || stopping || !session.accepting)
      return refused("BUSY: Gateway unavailable or draining; no call dispatched. No request was replayed.");
    // Admission evidence must reach stable storage before any adapter dispatch.
    session.inFlight++; inFlight++;
    let evidence: string | undefined;
    let completed = false;
    try {
      evidence = await custody.beginRecoveryEvidence?.("operation", `relay:${session.role}:${name}`);
      if (!available() || switching || selection.switching || stopping || !session.accepting) {
        completed = true;
        return refused("BUSY: Gateway unavailable or draining; no call dispatched. No request was replayed.");
      }
      if (name === "check_version") {
        const observed = currentMode() === "original" ? await original(session.role).observeVersion(args)
          : version(await facades.get(session.role)!.invoke(name, args));
        const upstream = original(session.role).originalVersion.runtime as Json;
        const result = toolResult({ ...observed, dispatchMode: currentMode(),
          routeRuntime: { ...localStatus(session), inFlight: session.inFlight - 1 },
          originalConnection: { instanceId: upstream.instanceId, attribution: upstream.attribution } });
        completed = true;
        return result;
      }
      const result = currentMode() === "original" ? await invokeOriginal(session.role, name, args)
        : await facades.get(session.role)!.invoke(name, args);
      completed = true;
      return result;
    }
    catch {
      // Validation can throw before dispatch. Original owns the dispatch receipt:
      // its accepting/settled channel distinguishes refusal from unknown effects.
      uncertain ||= originalUncertain() > 0 || !evidence && !!custody.beginRecoveryEvidence;
      completed = !uncertain && [...originals.values()].every(item => item.identity.health.phase === "accepting");
      if (uncertain && shared) shared.failed = true;
      return refused("Gateway call failed. Do not retry an uncertain effect.");
    } finally {
      try {
        if (evidence && completed && !uncertain && !originalUncertain())
          await custody.completeRecoveryEvidence(evidence);
      } catch {
        uncertain = true;
        if (shared) shared.failed = true;
        throw new Error("Recovery receipt was not durable; no outcome may be inferred or replayed.");
      } finally { session.inFlight--; inFlight--; }
    }
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
        if (!available() || switching || selection.switching || stopping || sessions.has(input.clientId) || sessions.size >= 64)
          return reply(409, { error: "Cannot enroll relay." });
        inFlight++;
        try {
          if (currentMode() === "original") await original(role).observeVersion({}, true);
          else await verifyBundled(role);
        } finally { inFlight--; }
        if (!available() || switching || selection.switching || stopping || sessions.has(input.clientId) || sessions.size >= 64)
          return reply(409, { error: "Cannot enroll relay." });
        sessions.set(input.clientId, { id: input.clientId, role, accepting: true, inFlight: 0 });
        return reply(200, { instructions: facades.get(role)!.instructions });
      }
      const session = sessions.get(input.clientId);
      if (!session || session.role !== role) return reply(409, { error: "Unknown relay session." });
      if (req.url === "/shared/leave") {
        session.accepting = false;
        sessions.delete(input.clientId);
        if (session.inFlight) { uncertain = true; if (shared) shared.failed = true; }
        return reply(200, {});
      }
      if (req.url === "/shared/tools") return reply(200, { tools: facades.get(role)!.definitions });
      if (req.url === "/shared/call" && typeof input.name === "string" && object(input.arguments)) {
        let terminal = false;
        const disconnected = () => {
          if (!terminal && !control.has(input.name as string)) { uncertain = true; if (shared) shared.failed = true; }
        };
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
      const adapter = await connectCompatibilityMcp(config, { attribution: attributions[role], custodyGrant: custody.launchGrant });
      originals.set(role, adapter);
      adapter.onFailure(() => { accepting = false; if (shared) shared.failed = true; });
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
  const missingRelays = () => roles.filter(role =>
    ![...sessions.values()].some(session => session.role === role && session.accepting));
  function assertSwitchable(expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode) {
    if (!available() || switching || selection.switching || stopping || inFlight || originalInFlight() || host.hasActiveChatWork?.()
      || currentMode() !== expected.mode || selection.selectionRevision !== expected.selectionRevision || currentMode() === target
      || target !== "original" && target !== "bundled-v5")
      throw new Error("Gateway selection changed or outstanding work blocks switching; no switch applied.");
    if (missingRelays().length) throw new Error("Both native PKM relays must verify their live backend before switching.");
  }
  async function approveSwitch(expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode, onDraining?: () => void) {
    expected = { ...expected };
    assertSwitchable(expected, target);
    if (!await host.confirm({ from: expected.mode, to: target, runtimeBuild: identity(target).runtimeBuild }))
      return { applied: false, status: status() };
    assertSwitchable(expected, target);
    switching = true;
    try {
      onDraining?.();
      if (target === "bundled-v5") bundled.assertVerified();
      const results = await Promise.allSettled(roles.map(async role => {
        await original(role).observeVersion({}, true);
        if (target === "bundled-v5") await verifyBundled(role);
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (!available() || stopping || inFlight || originalInFlight() || host.hasActiveChatWork?.() || missingRelays().length)
        throw new Error("Gateway no longer accepts handoff.");
      // Linearization point: both existing relays resolve the same active reference.
      selection.mode = target;
      selection.selectionRevision = randomUUID();
    } finally { switching = false; }
    return { applied: true, status: status() };
  }
  function status() {
    const mode = currentMode(), active = identity(mode);
    const candidates = (["original", "bundled-v5"] as const).map(mode => {
      const { generation, runtimeBuild } = identity(mode);
      const version = mode === "original" ? original("workbench").originalVersion.version : bundledVersions.get("workbench")!;
      return { mode, generation, runtimeBuild, version };
    });
    return { mode, version: candidates.find(item => item.mode === mode)!.version,
      generation: active.generation, runtimeBuild: active.runtimeBuild, selectionRevision: selection.selectionRevision, candidates, inFlight, missingRelays: missingRelays(),
      phase: !available() ? "action-required" : switching || selection.switching || stopping ? "draining" : "accepting",
      uncertain: uncertain || originalUncertain() > 0, automaticReplay: false,
      originalBuild: config.legacy.runtimeBuild, storageEngine: "original", storageMigrated: false,
      originalConnections: roles.map(role => ({ role, supervisorPid: original(role).adapterPid,
        runtime: original(role).originalVersion.runtime, health: original(role).identity.health })) };
  }
  let closing: Promise<void> | undefined;
  return {
    async verifyHandoff(target: CompatibilityDispatchMode) {
      if (!shared || !selection.switching || !available() || stopping || inFlight || originalInFlight()
        || host.hasActiveChatWork?.() || missingRelays().length) throw new Error("Gateway no longer accepts handoff.");
      bundled.assertVerified();
      for (const role of roles) {
        await original(role).observeVersion({}, true);
        if (target === "bundled-v5") await verifyBundled(role);
      }
      if (!available() || stopping || inFlight || originalInFlight()) throw new Error("Gateway no longer accepts handoff.");
    },
    bindBrowserReads() {
      const operations = new Set(["list_notes", "search_notes", "get_note", "api_chat_capabilities",
        "api_chat_list", "api_chat_get", "api_chat_request_get"].map(name => `mcp.tool.${name}`));
      const revision = selection.selectionRevision;
      const generation = status().generation;
      const session: Session = { id: randomUUID(), role: "workbench", accepting: true, inFlight: 0 };
      const assertCurrent = () => {
        if (!session.accepting || !available() || switching || selection.switching || stopping || revision !== selection.selectionRevision)
          throw new Error("The browser gateway binding is no longer current.");
      };
      assertCurrent();
      return {
        generation, assertCurrent,
        async read(input: { operation: string; version: number; arguments: Json }) {
          assertCurrent();
          const contract = original(session.role).catalog.contracts.find(entry => entry.id === input.operation);
          if (input.version !== 1 || !operations.has(input.operation) || !contract?.readOnly)
            throw new Error("The operation is not in the browser read grant.");
          const result = await invoke(session, "capability_read", {
            operation: input.operation, version: 1, arguments: input.arguments,
          });
          assertCurrent();
          if (result.isError) throw new Error(result.content.filter(item => item.type === "text")
            .map(item => item.text).join("\n") || "The browser gateway read failed.");
          if (result.structuredContent !== undefined) return result.structuredContent;
          if (input.operation === "mcp.tool.search_notes" && result.content.length === 0) return [];
          const block = result.content[0];
          if (result.content.length !== 1 || block?.type !== "text" || block.text.length > 2_000_000)
            throw new Error("The browser gateway returned an unsupported read result.");
          return JSON.parse(block.text) as unknown;
        },
        async close() { session.accepting = false; },
      };
    },
    // Not a management credential; never expose to Webviews, settings, or browsers.
    relay(role: Role) {
      if (!roles.includes(role) || stopping || closed) throw new Error("Unknown or closed compatibility relay.");
      return { origin, serviceId, token: tokens[role] };
    },
    relayIdentity, approveSwitch, status,
    close() {
      stopping = true;
      return closing ??= (async () => {
        const deadline = performance.now() + 30_000;
        while (switching || inFlight || originalInFlight()) {
          if (performance.now() >= deadline) {
            accepting = false;
            throw new Error("Gateway drain was not confirmed; Original custody requires explicit recovery.");
          }
          await delay(25);
        }
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
