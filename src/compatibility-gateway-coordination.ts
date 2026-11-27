import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compatibilityMcpConfiguration } from "./compatibility-mcp.js";
import { acquireCompatibilityGatewayCustody } from "./compatibility-gateway-custody.js";
import { originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { assertOriginalMcpBrokerDirectory, originalMcpBrokerProcessPin } from "./original-mcp-relay.js";
import { startCompatibilityGatewayAuthority, type CompatibilityGatewayHost, type CompatibilityGatewaySelection,
  type CompatibilitySwitchExpectation, type CompatibilityDispatchMode, type VerifiedCompatibilityGateway } from "./compatibility-gateway-authority.js";

type Json = Record<string, any>;
type Custody = Awaited<ReturnType<typeof acquireCompatibilityGatewayCustody>>;
type Authority = Awaited<ReturnType<typeof startCompatibilityGatewayAuthority>>;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const directory = (root: string) => join(root, ".pkm/state/compatibility-gateway");
const pending = (root: string) => join(directory(root), "owner-pending.json");
const descriptorPath = (root: string) => join(directory(root), "owner-live.json");
const denied = () => new Error("Compatibility custody belongs to another window or requires recovery. No fallback was started.");
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function loopback(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  try { const url = new URL(origin); return url.origin === origin && url.protocol === "http:"
    && url.hostname === "127.0.0.1" && !!url.port; } catch { return false; }
}
function processHeld(pin: ReturnType<typeof originalMcpBrokerProcessPin>) {
  if (!isDeepStrictEqual(originalMcpBrokerProcessPin(pin.pid), pin)) throw denied();
}
function readDescriptor(root: string) {
  assertOriginalMcpBrokerDirectory(directory(root));
  const bytes = originalMcpPrivateBytes(descriptorPath(root), 16_384);
  const value = JSON.parse(bytes.toString()) as Json;
  const stat = lstatSync(root, { bigint: true });
  if (value.schema !== "pkm.compatibility-gateway-owner/v1" || value.root !== root
    || value.device !== String(stat.dev) || value.inode !== String(stat.ino)
    || value.custodySha256 !== hash(originalMcpPrivateBytes(pending(root), 4096))
    || !loopback(value.origin) || !uuid(value.serviceId) || !hex(value.token)
    || !uuid(value.originalGeneration) || !hex(value.originalBuild) || !hex(value.bundledBuild))
    throw denied();
  processHeld(value.process);
  return { value, bytes };
}

/** An existing marker is never reclaimed. Only its live authenticated owner may admit a peer. */
type HostHandler = (route: string, input: Json) => Promise<unknown>;
type Reservation = { endpoint: Awaited<ReturnType<typeof privateServer>>;
  attach(handler: HostHandler, abandoned: (route: string) => void): void };
type NativeReservation = { memberId: string; callback: Awaited<ReturnType<typeof peerCallback>> };

export async function prepareCompatibilityGatewayAdmission(root: string, acquire: () => Promise<Custody>,
  ownerBinding?: () => Json) {
  if (!existsSync(pending(root))) {
    try {
      const pins = ownerBinding?.();
      const custody = await acquire();
      let reservation: Reservation | undefined;
      try {
        if (ownerBinding) {
          let handler: HostHandler | undefined, abandoned: ((route: string) => void) | undefined;
          const endpoint = await privateServer(async (route, input) => {
            custody.assertHeld();
            if (route === "/host/probe") return { available: true };
            // Reservation is already authenticated, but no work can enter until
            // the native owner finishes binding its exact Original connections.
            const deadline = Date.now() + 30_000;
            while (!handler) {
              if (Date.now() >= deadline) throw denied();
              await new Promise(resolve => setTimeout(resolve, 25));
              custody.assertHeld();
            }
            return handler(route, input);
          }, route => abandoned?.(route));
          reservation = { endpoint, attach(value, lost) { handler = value; abandoned = lost; } };
          await publishDescriptor(root, pins!, custody, endpoint);
        }
      } catch (error) {
        await reservation?.endpoint.close();
        await custody.release(false);
        throw error;
      }
      return { kind: "owner" as const, custody, reservation, assertHeld: () => custody.assertHeld(),
        async release(clean: boolean) {
          await reservation?.endpoint.close();
          if (clean && reservation) { custody.assertHeld(); await unlink(descriptorPath(root)); }
          await custody.release(clean);
        } };
    } catch (error) {
      if (!existsSync(pending(root))) throw error;
      // A competing managed window can still be publishing its rendezvous.
      for (let count = 0; count < 40 && !existsSync(descriptorPath(root)); count++)
        await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  let descriptor: ReturnType<typeof readDescriptor>;
  try { descriptor = readDescriptor(root); } catch { throw denied(); }
  const assertHeld = () => {
    try { if (!readDescriptor(root).bytes.equals(descriptor.bytes)) throw denied(); } catch { throw denied(); }
  };
  await request(descriptor.value, "/host/probe", {});
  return { kind: "peer" as const, descriptor: descriptor.value, assertHeld, async release(_clean: boolean) {} };
}
export type CompatibilityGatewayAdmission = Awaited<ReturnType<typeof prepareCompatibilityGatewayAdmission>> | {
  kind: "peer"; descriptor: Json; nativeReservation: NativeReservation;
  assertHeld(): void; release(clean: boolean): Promise<void>;
};

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 2_000_000) throw denied();
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  return value as Json;
}
async function request(endpoint: Json, route: string, input: Json) {
  if (!loopback(endpoint.origin) || !hex(endpoint.token) || !uuid(endpoint.serviceId)) throw denied();
  let res: Response;
  try {
    res = await fetch(endpoint.origin + route, { method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "x-pkm-service-id": endpoint.serviceId,
        // Do not reuse idle sockets whose deadline may expire while an admitted host is stalled.
        "content-type": "application/json", connection: "close" }, body: JSON.stringify(input), signal: AbortSignal.timeout(90_000),
      redirect: "error" });
  } catch (error) {
    if (error instanceof Error && error.cause instanceof Error)
      throw new Error(`Private owner request ${route} failed: ${error.cause.message}`, { cause: error });
    throw error;
  }
  const text = await res.text();
  if (text.length > 2_000_000) throw denied();
  const result = JSON.parse(text) as Json;
  if (!res.ok) throw new Error(typeof result?.detail === "string" ? result.detail : "Owner or peer unavailable; no replay.");
  return result;
}
export { request as requestCompatibilityOwner };

async function privateServer(handler: (route: string, input: Json) => Promise<unknown>,
  abandoned?: (route: string) => void) {
  const serviceId = randomUUID(), token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  let origin = "";
  const server = createServer(async (req, res) => {
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (req.method !== "POST" || req.headers.host !== new URL(origin).host || req.headers.origin !== undefined
        || req.headers["x-pkm-service-id"] !== serviceId || req.headers["content-type"] !== "application/json"
        || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization))
        return reply(403, { error: "Private admitted hosts only." });
      const input = await body(req), route = req.url ?? "";
      let terminal = false;
      const disconnected = () => {
        if (!terminal) {
          console.error("Private admitted request disconnected before its result:", {
            route, requestComplete: req.complete, listening: server.listening,
          });
          abandoned?.(route);
        }
      };
      res.once("close", disconnected);
      try {
        const result = await handler(route, input);
        terminal = true;
        reply(200, result);
      } finally { terminal = true; res.off("close", disconnected); }
    } catch (error) {
      reply(409, { error: "Owner or peer unavailable; no replay.",
        detail: error instanceof Error ? error.message : "The private owner request failed." });
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, serviceId, token, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
async function publishDescriptor(root: string, pins: Json, custody: Custody,
  endpoint: Awaited<ReturnType<typeof privateServer>>) {
  const stat = lstatSync(root, { bigint: true });
  const descriptor = JSON.stringify({ schema: "pkm.compatibility-gateway-owner/v1", root,
    device: String(stat.dev), inode: String(stat.ino), custodySha256: hash(originalMcpPrivateBytes(pending(root))),
    process: originalMcpBrokerProcessPin(), ...pins,
    origin: endpoint.origin, serviceId: endpoint.serviceId, token: endpoint.token });
  custody.assertHeld();
  const file = await open(descriptorPath(root), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(descriptor); await file.sync(); } finally { await file.close(); }
  const dir = await open(directory(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
function binding(input: unknown, bundled: VerifiedCompatibilityGateway) {
  const config = compatibilityMcpConfiguration.parse(input);
  return { originalGeneration: config.legacy.generation, originalBuild: config.legacy.runtimeBuild,
    bundledBuild: bundled.runtimeBuild };
}

/** All peers retain distinct Original connections, while dispatch selection has one linearization point. */
export async function startOrJoinCompatibilityGateway(input: unknown, bundled: VerifiedCompatibilityGateway,
  host: CompatibilityGatewayHost, admission: CompatibilityGatewayAdmission,
  initialMode: CompatibilityDispatchMode = "original",
  service?: { headless: true; onIdle(): void; onFailure?(error: unknown): void }) {
  const config = compatibilityMcpConfiguration.parse(input);
  bundled.assertVerified(); host.assertAllowed?.(); admission.assertHeld();
  if (admission.kind === "peer")
    return joinCompatibilityGatewayPeer(config.knowledgeRoot, binding(input, bundled), host, admission,
      () => bundled.assertVerified());
  const custody = admission.custody;
  const selection: CompatibilityGatewaySelection = { mode: initialMode, selectionRevision: randomUUID(),
    switching: false, failed: false };
  type Member = { id: string; authority: Authority; host: CompatibilityGatewayHost; process: ReturnType<typeof originalMcpBrokerProcessPin>;
    callback?: Json; checked: number; busy: boolean; leaving: boolean };
  const members = new Map<string, Member>();
  const reservations = new Map<string, { process: Member["process"]; callback: Json; busy: boolean }>();
  const participants = new Map<string, string>();
  const activities = new Map<string, string>();
  let evidenceQueue = Promise.resolve();
  function serializeEvidence(task: () => Promise<void>) {
    const result = evidenceQueue.then(task);
    evidenceQueue = result.catch(() => { selection.failed = true; });
    return result;
  }
  async function participant(id: string, process: Member["process"]) {
    await serializeEvidence(async () => {
      if (!participants.has(id))
        participants.set(id, await custody.beginRecoveryEvidence("participant", `peer:${id}`, process));
    });
  }
  async function activity(id: string, busy: boolean) {
    await serializeEvidence(async () => {
      const existing = activities.get(id);
      if (busy && !existing) activities.set(id, await custody.beginRecoveryEvidence("operation", `peer-background:${id}`));
      if (!busy && existing) { await custody.completeRecoveryEvidence(existing); activities.delete(id); }
    });
  }
  async function departed(id: string) {
    await serializeEvidence(async () => {
      if (activities.has(id)) throw new Error("Participant background work requires manual recovery.");
      const evidence = participants.get(id);
      if (evidence) { await custody.completeRecoveryEvidence(evidence); participants.delete(id); }
    });
  }
  let joining = false, closing = false, managementBusy = false;
  const assertMember = (member: Member, refreshing = false) => {
    try {
      custody.assertHeld(); processHeld(member.process);
      if (member.leaving || !refreshing && member.callback && Date.now() - member.checked > 5_000) throw denied();
      member.host.assertAllowed?.();
    } catch (error) { selection.failed = true; throw new Error(denied().message, { cause: error }); }
  };
  async function add(id: string, memberHost: CompatibilityGatewayHost,
    process: Member["process"], callback?: Json, readOnly = false) {
    const member = { id, host: memberHost, process, callback, checked: Date.now(), busy: false, leaving: false } as Member;
    const authority = await startCompatibilityGatewayAuthority({ ...config, writable: readOnly ? false : config.writable }, bundled, {
      ...memberHost, assertAllowed: () => assertMember(member),
      ...(memberHost.externalPeer ? { externalPeer: { ...memberHost.externalPeer, memberId: id, process } } : {}),
      hasActiveChatWork: () => member.callback ? member.busy : !!memberHost.hasActiveChatWork?.(),
      acquireCustody: async () => ({ launchGrant: custody.launchGrant,
        beginRecoveryEvidence: custody.beginRecoveryEvidence, completeRecoveryEvidence: custody.completeRecoveryEvidence,
        assertHeld: () => custody.assertHeld(), async release(clean: boolean) { if (!clean) selection.failed = true; } }),
    }, initialMode, selection);
    member.authority = authority;
    members.set(id, member);
    return member;
  }
  async function probe(member: Member) {
    assertMember(member, true);
    if (member.callback) {
      const observed = await request(member.callback, "/peer/probe", {});
      if (observed.allowed !== true || typeof observed.busy !== "boolean") throw denied();
      member.busy = observed.busy;
      member.checked = Date.now();
    } else member.busy = !!member.host.hasActiveChatWork?.();
    await activity(member.id, member.busy);
  }
  async function probeAll() {
    const entries = [...members.values()].filter(member => !member.leaving);
    const outcomes = await Promise.allSettled(entries.map(probe));
    const failed = outcomes.find((outcome, index) => outcome.status === "rejected"
      && members.get(entries[index]!.id) === entries[index] && !entries[index]!.leaving);
    if (failed?.status === "rejected") {
      selection.failed = true; throw new Error(denied().message, { cause: failed.reason });
    }
    for (const [id, reservation] of reservations) {
      try {
        processHeld(reservation.process);
        const observed = await request(reservation.callback, "/peer/probe", {});
        if (observed.allowed !== true || typeof observed.busy !== "boolean") throw denied();
        reservation.busy = observed.busy;
        await activity(id, reservation.busy);
      } catch {
        if (reservations.get(id) === reservation) { selection.failed = true; throw denied(); }
      }
    }
  }
  function status(member: Member) {
    assertMember(member);
    const all = [...members.values()].map(entry => entry.authority.status());
    return { ...member.authority.status(), inFlight: all.reduce((sum, item) => sum + item.inFlight, 0),
      missingRelays: [...new Set(all.flatMap(item => item.missingRelays))],
      uncertain: selection.failed || all.some(item => item.uncertain),
      backgroundActive: Number([...members.values()].some(item => item.busy)
        || [...reservations.values()].some(item => item.busy)),
      members: members.size };
  }
  async function approve(member: Member, expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode,
    switchId?: string) {
    if (managementBusy || joining || closing) throw denied();
    managementBusy = true;
    const assertIdle = () => {
      const snapshot = status(member);
      if (selection.failed || snapshot.phase !== "accepting" || snapshot.inFlight || snapshot.uncertain
        || snapshot.backgroundActive || snapshot.missingRelays.length || selection.mode !== expected.mode
        || selection.selectionRevision !== expected.selectionRevision || target === selection.mode
        || !["original", "bundled-v5"].includes(target)) throw new Error("Outstanding work or selection changed; no switch applied.");
    };
    try {
      await probeAll(); assertIdle();
      const review = { from: expected.mode, to: target,
        runtimeBuild: target === "original" ? config.legacy.runtimeBuild : bundled.runtimeBuild };
      for (const entry of members.values()) {
        if (entry.host.relayRoles?.length === 1) continue;
        const confirmed = entry.callback ? (await request(entry.callback, "/peer/confirm", { review })).confirmed
          : await entry.host.confirm(review);
        if (confirmed !== true) return { applied: false };
      }
      for (const entry of reservations.values())
        if ((await request(entry.callback, "/peer/confirm", { review })).confirmed !== true) return { applied: false };
      await probeAll(); assertIdle();
      selection.switching = true;
      // Deliver this real, correlated phase before synchronous verification can hide it from status polling.
      if (member.callback) {
        if (!switchId || (await request(member.callback, "/peer/switch-progress", {
          switchId, expected, status: status(member),
        })).observed !== true) throw denied();
      }
      const verified = await Promise.allSettled([...members.values()].map(entry => entry.authority.verifyHandoff(target)));
      for (const result of verified) if (result.status === "rejected") throw result.reason;
      await probeAll();
      if (selection.failed || [...members.values()].some(entry => entry.busy
        || entry.authority.status().inFlight || entry.authority.status().uncertain
        || entry.authority.status().missingRelays.length)) throw denied();
      selection.mode = target;
      selection.selectionRevision = randomUUID();
      return { applied: true };
    } finally { selection.switching = false; managementBusy = false; }
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let endpoint: Awaited<ReturnType<typeof privateServer>> | undefined;
  const owner = service ? undefined : await add(randomUUID(), host, originalMcpBrokerProcessPin());
  const browsers = new Map<string, { member: Member; bound: ReturnType<Authority["bindBrowserReads"]> }>();
  const response = (member: Member) => ({ memberId: member.id, status: status(member),
    relayIdentity: member.authority.relayIdentity,
    relays: Object.fromEntries((member.host.relayRoles ?? ["workbench", "chat"] as const)
      .map(role => [role, member.authority.relay(role)])) });
  try {
    const handle: HostHandler = async (route, args) => {
      custody.assertHeld();
      if (selection.failed || closing) throw denied();
      if (route === "/host/probe") return { available: true };
      if (route === "/host/reserve") {
        if (!service || joining || managementBusy || members.size + reservations.size >= 32
          || !uuid(args.memberId) || members.has(args.memberId) || reservations.has(args.memberId)
          || !isDeepStrictEqual(args.binding, binding(input, bundled)) || !loopback(args.callback?.origin)
          || !hex(args.callback?.token) || !uuid(args.callback?.serviceId)) throw denied();
        processHeld(args.process);
        const observed = await request(args.callback, "/peer/probe", {});
        if (observed.allowed !== true) throw denied();
        await participant(args.memberId, args.process);
        reservations.set(args.memberId, { process: args.process, callback: args.callback, busy: observed.busy === true });
        await activity(args.memberId, observed.busy === true);
        return { reserved: true };
      }
      if (route === "/host/unreserve") {
        const reservation = reservations.get(args.memberId);
        if (!reservation) throw denied();
        processHeld(reservation.process);
        const observed = await request(reservation.callback, "/peer/probe", {});
        if (observed.allowed !== true || observed.busy !== false) throw denied();
        await activity(args.memberId, false);
        await departed(args.memberId);
        reservations.delete(args.memberId);
        const last = !!service && !members.size && !reservations.size;
        if (last) setImmediate(() => service?.onIdle());
        return { last };
      }
      if (route === "/host/join") {
        if (joining || managementBusy || members.size >= 16 || !uuid(args.memberId)
          || members.has(args.memberId) || !isDeepStrictEqual(args.binding, binding(input, bundled))
          || !loopback(args.callback?.origin) || !hex(args.callback?.token) || !uuid(args.callback?.serviceId)) throw denied();
        joining = true;
        try {
          processHeld(args.process);
          const reservation = reservations.get(args.memberId);
          if (reservation && (!isDeepStrictEqual(reservation.process, args.process)
            || !isDeepStrictEqual(reservation.callback, args.callback))) throw denied();
          const observed = await request(args.callback, "/peer/probe", {});
          if (observed.allowed !== true) throw denied();
          const external = args.externalPeer !== undefined || args.readOnly === true;
          if (args.externalPeer !== undefined && (!args.externalPeer || typeof args.externalPeer !== "object"
            || Object.keys(args.externalPeer).join() !== "writable" || typeof args.externalPeer.writable !== "boolean"))
            throw denied();
          const externalWritable = args.externalPeer?.writable === true;
          if (externalWritable && !config.writable)
            return { error: "READ_ONLY_OWNER", detail: "The managed owner is read-only; writable external admission was refused." };
          const memberHost: CompatibilityGatewayHost = { ...host, workbenchAttribution: args.workbenchAttribution,
            chatAttribution: args.chatAttribution, assertAllowed() {},
            ...(external ? { relayRoles: ["workbench"] as const, externalPeer: { writable: externalWritable } } : {}),
            async confirm() { return false; } };
          if (external) {
            if (!isDeepStrictEqual(args.workbenchAttribution,
              { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" })) throw denied();
          } else for (const attribution of [args.workbenchAttribution, args.chatAttribution])
            if (attribution?.extensionHostPid !== args.process.pid || typeof attribution?.hostId !== "string"
              || !attribution.hostId || typeof attribution?.editorSessionId !== "string" || !attribution.editorSessionId) throw denied();
          await participant(args.memberId, args.process);
          const member = await add(args.memberId, memberHost, args.process, args.callback, external && !externalWritable);
          await probe(member);
          reservations.delete(args.memberId);
          return response(member);
        } finally { joining = false; }
      }
      const member = members.get(args.memberId);
      if (!member || member === owner) throw denied();
      assertMember(member);
      if (route === "/host/status") { await probeAll(); return { status: status(member) }; }
      if (route === "/host/switch") {
        if (member.host.relayRoles?.length === 1 || !uuid(args.switchId)) throw denied();
        return approve(member, args.expected, args.target, args.switchId);
      }
      if (route === "/host/browser-bind") {
        const id = randomUUID(), bound = member.authority.bindBrowserReads();
        browsers.set(id, { member, bound });
        return { id, generation: bound.generation };
      }
      if (route.startsWith("/host/browser-")) {
        const entry = browsers.get(args.id);
        if (!entry || entry.member !== member) throw denied();
        if (route === "/host/browser-read") return { value: await entry.bound.read(args.input) };
        if (route === "/host/browser-check") { entry.bound.assertCurrent(); return {}; }
        if (route === "/host/browser-close") { await entry.bound.close(); browsers.delete(args.id); return {}; }
      }
      if (route === "/host/leave") {
        while (managementBusy || joining) {
          await new Promise(resolve => setTimeout(resolve, 10));
          custody.assertHeld();
          if (selection.failed || closing) throw denied();
        }
        joining = true;
        try {
          await member.authority.close();
          await probe(member);
          if (member.busy) throw denied();
          await departed(member.id);
          member.leaving = true;
          for (const [id, entry] of browsers) if (entry.member === member) {
            await entry.bound.close(); browsers.delete(id);
          }
          members.delete(member.id);
          const last = !!service && !members.size && !reservations.size;
          if (last) setImmediate(() => service?.onIdle());
          return { last };
        } catch (error) { selection.failed = true; throw error; }
        finally { joining = false; }
      }
      throw denied();
    };
    const handler: HostHandler = async (route, args) => {
      const tracked = ["/host/reserve", "/host/unreserve", "/host/join", "/host/leave",
        "/host/switch", "/host/browser-read"].includes(route);
      const evidence = tracked ? await custody.beginRecoveryEvidence("operation", route) : undefined;
      try {
        const result = await handle(route, args);
        if (evidence && !selection.failed) await custody.completeRecoveryEvidence(evidence);
        return result;
      } catch (error) {
        // A terminal refusal (stale browser binding, busy switch, invalid join)
        // is not transport loss. Sticky participant/Original failures stay pending.
        if (evidence && !selection.failed) await custody.completeRecoveryEvidence(evidence);
        throw error;
      }
    };
    const abandoned = (route: string) => {
      if (["/host/join", "/host/leave", "/host/switch", "/host/browser-read"].includes(route)) selection.failed = true;
    };
    if (admission.reservation) {
      const descriptor = readDescriptor(config.knowledgeRoot).value;
      if (!isDeepStrictEqual(binding(input, bundled), { originalGeneration: descriptor.originalGeneration,
        originalBuild: descriptor.originalBuild, bundledBuild: descriptor.bundledBuild })) throw denied();
      endpoint = admission.reservation.endpoint;
      admission.reservation.attach(handler, abandoned);
    } else {
      endpoint = await privateServer(handler, abandoned);
      await publishDescriptor(config.knowledgeRoot, { ...binding(input, bundled), ...(service ? { independentService: true } : {}) }, custody, endpoint);
    }
    timer = setInterval(() => {
      if (!closing) void probeAll().then(() => {
        if (selection.failed) service?.onFailure?.(new Error("Compatibility selection failed closed."));
      }).catch(error => service?.onFailure?.(error));
    }, 1_000);
    timer.unref();
  } catch (error) {
    await endpoint?.close();
    await owner?.authority.close().catch(() => {});
    await custody.release(false);
    throw error;
  }
  async function closeManager() {
      if (!selection.failed && (joining || managementBusy
        || (service ? members.size > 0 || reservations.size > 0 : members.size !== 1)))
        throw new Error("Peers remain admitted; owner custody is retained.");
      closing = true; clearInterval(timer);
      while (joining || managementBusy) await new Promise(resolve => setTimeout(resolve, 10));
      let released = false;
      try {
        const outcomes = await Promise.allSettled([
          ...[...members.values()].map(member => member.authority.close()), endpoint!.close(),
        ]);
        const failures = outcomes.flatMap(item => item.status === "rejected" ? [item.reason] : []);
        const clean = !selection.failed && failures.length === 0;
        if (clean) { custody.assertHeld(); await unlink(descriptorPath(config.knowledgeRoot)); }
        await custody.release(clean); released = true;
        if (!clean) throw new AggregateError(failures, "Original custody requires explicit recovery; no result was inferred or replayed.");
      } catch (error) { if (!released) await custody.release(false); throw error; }
  }
  return {
    ...(owner?.authority),
    bindBrowserReads() { if (!owner) throw denied(); return owner.authority.bindBrowserReads(); },
    async status() { if (!owner) throw denied(); await probeAll(); return status(owner); },
    async approveSwitch(expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode, onDraining?: () => void) {
      if (!owner) throw denied();
      const result = approve(owner, expected, target);
      const progress = setInterval(() => { if (selection.switching) onDraining?.(); }, 20);
      try { return await result; } finally { clearInterval(progress); }
    },
    close: closeManager,
    isIdle() { return !members.size && !reservations.size && !joining && !managementBusy; },
    failClosed() { selection.failed = true; return closeManager(); },
  };
}

async function peerCallback(descriptor: Json, host: CompatibilityGatewayHost, assertHeld: () => void,
  disposed: () => boolean) {
  const progress = new Map<string, { expected: CompatibilitySwitchExpectation; observed: boolean;
    deliver(status: Json): Promise<void> }>();
  const endpoint = await privateServer(async (route, args) => {
    if (disposed()) throw denied();
    assertHeld();
    if (route === "/peer/probe") return { allowed: true, busy: !!host.hasActiveChatWork?.() };
    if (route === "/peer/confirm") {
      const { review } = args;
      if (!review || !["original", "bundled-v5"].includes(review.from) || !["original", "bundled-v5"].includes(review.to)
        || review.from === review.to || review.runtimeBuild !== (review.to === "original"
          ? descriptor.originalBuild : descriptor.bundledBuild)) throw denied();
      return { confirmed: await host.confirm(review) };
    }
    if (route === "/peer/switch-progress") {
      const pending = progress.get(args.switchId);
      if (!pending || !isDeepStrictEqual(pending.expected, args.expected)
        || args.status?.phase !== "draining" || args.status.mode !== pending.expected.mode
        || args.status.selectionRevision !== pending.expected.selectionRevision
        || args.status.runtimeBuild !== (pending.expected.mode === "original" ? descriptor.originalBuild : descriptor.bundledBuild))
        throw denied();
      if (!pending.observed) {
        pending.observed = true;
        await pending.deliver({ ...args.status, authorityPid: descriptor.process.pid });
      }
      return { observed: true };
    }
    throw denied();
  });
  return { ...endpoint, watchSwitch(switchId: string, expected: CompatibilitySwitchExpectation,
    deliver: (status: Json) => Promise<void>) {
    if (progress.has(switchId)) throw denied();
    progress.set(switchId, { expected, observed: false, deliver });
    return () => { progress.delete(switchId); };
  } };
}
async function settleIdle(descriptor: Json, response: Json) {
  if (response.last !== true) return;
  const deadline = performance.now() + 30_000;
  while (existsSync(pending(descriptor.root))) {
    processHeld(descriptor.process);
    if (performance.now() >= deadline) throw denied();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Reserve a window's lifecycle without launching any Original adapter. */
export async function reserveCompatibilityGatewayPeer(root: string, expectedBinding: Json, host: CompatibilityGatewayHost) {
  const admitted = await prepareCompatibilityGatewayAdmission(root, async () => { throw denied(); });
  if (admitted.kind !== "peer" || admitted.descriptor.independentService !== true) throw denied();
  const descriptor = admitted.descriptor;
  if (!isDeepStrictEqual(expectedBinding, { originalGeneration: descriptor.originalGeneration,
    originalBuild: descriptor.originalBuild, bundledBuild: descriptor.bundledBuild })) throw denied();
  const assertHeld = () => { admitted.assertHeld(); host.assertAllowed?.(); };
  let disposed = false;
  const callback = await peerCallback(descriptor, host, assertHeld, () => disposed);
  const memberId = randomUUID();
  try {
    await request(descriptor, "/host/reserve", { memberId, binding: expectedBinding,
      process: originalMcpBrokerProcessPin(), callback: { origin: callback.origin, serviceId: callback.serviceId, token: callback.token } });
  } catch (error) { await callback.close(); throw error; }
  return { kind: "peer" as const, descriptor, nativeReservation: { memberId, callback }, assertHeld,
    async release(_clean: boolean) {
      try { assertHeld(); await settleIdle(descriptor, await request(descriptor, "/host/unreserve", { memberId })); }
      finally { disposed = true; await callback.close(); }
    } };
}

/** Host-only join. Never publish these management credentials to tools, Webviews or browsers. */
export async function joinCompatibilityGatewayPeer(root: string, expectedBinding: Json, host: CompatibilityGatewayHost,
  admission?: CompatibilityGatewayAdmission, assertVerified: () => void = () => {}) {
  if (!admission && (!existsSync(pending(root)) || !existsSync(descriptorPath(root))))
    throw new Error("COMPATIBILITY_OWNER_UNAVAILABLE: No authenticated managed owner rendezvous is available. Start the admitted native PKM owner; no cold fallback was started.");
  const admitted = admission ?? await prepareCompatibilityGatewayAdmission(root, async () => { throw denied(); });
  if (admitted.kind !== "peer") throw denied();
  const descriptor = admitted.descriptor;
  if (!isDeepStrictEqual(expectedBinding, { originalGeneration: descriptor.originalGeneration,
    originalBuild: descriptor.originalBuild, bundledBuild: descriptor.bundledBuild })) throw denied();
  const assertHeld = () => { admitted.assertHeld(); assertVerified(); host.assertAllowed?.(); };
  assertHeld();
  let disposed = false;
  const reservation = "nativeReservation" in admitted ? admitted.nativeReservation : undefined;
  const callback = reservation?.callback ?? await peerCallback(descriptor, host, assertHeld, () => disposed);
  const memberId = reservation?.memberId ?? randomUUID();
  const rpc = (route: string, args: Json = {}) => { assertHeld(); return request(descriptor, route, { ...args, memberId }); };
  let joined: Json;
  try {
    joined = await rpc("/host/join", { binding: expectedBinding, process: originalMcpBrokerProcessPin(),
      callback: { origin: callback.origin, serviceId: callback.serviceId, token: callback.token },
      workbenchAttribution: host.workbenchAttribution, chatAttribution: host.chatAttribution,
      ...(host.externalPeer ? { externalPeer: { writable: host.externalPeer.writable } }
        : host.relayRoles?.length === 1 ? { readOnly: true } : {}) });
    if (joined.error === "READ_ONLY_OWNER") throw new Error(joined.detail);
  } catch (error) { if (!reservation) await callback.close(); throw error; }
  return {
    relayIdentity: joined.relayIdentity as Authority["relayIdentity"],
    relay(role: "workbench" | "chat") { assertHeld(); if (disposed || !joined.relays[role]) throw denied(); return joined.relays[role]; },
    async status() { return { ...(await rpc("/host/status")).status, authorityPid: descriptor.process.pid } as ReturnType<Authority["status"]> & { authorityPid: number }; },
    async approveSwitch(expected: CompatibilitySwitchExpectation, target: CompatibilityDispatchMode,
      onDraining?: (status: Json) => void | Promise<void>) {
      const switchId = randomUUID();
      const stop = callback.watchSwitch(switchId, expected, async status => { await onDraining?.(status); });
      try { return await rpc("/host/switch", { expected, target, switchId }) as { applied: boolean }; }
      finally { stop(); }
    },
    async bindBrowserReads() {
      const bound = await rpc("/host/browser-bind");
      return { generation: bound.generation as string,
        assertCurrent: () => assertHeld(),
        async read(input: Json) { return (await rpc("/host/browser-read", { id: bound.id, input })).value; },
        async close() { await rpc("/host/browser-close", { id: bound.id }); } };
    },
    async close() {
      if (disposed) return;
      try { await settleIdle(descriptor, await rpc("/host/leave")); } finally { disposed = true; await callback.close(); }
    },
  };
}
