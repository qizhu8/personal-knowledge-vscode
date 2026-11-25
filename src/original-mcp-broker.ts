import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, open, readdir, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createNativePublicOwnerBackend } from "./native-public-mcp-owner.js";
import { startNativePublicMcp } from "./native-public-mcp.js";
import { createNativePublicStdio } from "./native-public-mcp-stdio.js";
import contracts from "./native-public-mcp-contracts.js";
import { openOriginalMcpRoot } from "./original-mcp-root.js";
import { parseOriginalMcpPlan, type OriginalMcpPlan } from "./original-mcp-root-custody.js";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { verifyOriginalMcpImplementationReadiness } from "./original-mcp-public.js";
import { getNativeOriginalTrashPort } from "./original-native-trash-native.js";
import { serverStatusSchema, type ServerStatus } from "./server-status.js";
import {
  assertOriginalMcpBrokerDirectory, originalMcpBrokerError, originalMcpBrokerProcessPin,
  pinOriginalMcpBrokerFile, readOriginalMcpBrokerDescriptor, type OriginalMcpBrokerDescriptor,
} from "./original-mcp-relay.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalMcpBrokerAuthorizationSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-broker-authorization/v1"),
  operatorId: z.string().min(1).max(128), profileSha256: digest, planSha256: digest,
  acceptedScope: z.literal("knowledge-content-only/v1"), writable: z.boolean(),
});
export type OriginalMcpBrokerAuthorization = z.infer<typeof originalMcpBrokerAuthorizationSchema>;
export const originalMcpNativeBrokerAuthorizationSchema = originalMcpBrokerAuthorizationSchema.extend({
  acceptedScope: z.literal("native-dogfood/v1"),
});
export type OriginalMcpNativeBrokerAuthorization = z.infer<typeof originalMcpNativeBrokerAuthorizationSchema>;
export interface OriginalMcpBrokerOptions {
  plan: OriginalMcpPlan; writerFence: LinuxRootWriterFence; directory: string;
  runtime: { node: { path: string; sha256: string }; relay: { path: string; sha256: string }; buildSha256: string };
  manifest: Record<string, any>;
  authorization: OriginalMcpBrokerAuthorization;
  gitProtection?: { assertCurrent(): void };
}
export interface OriginalMcpNativeBrokerOptions extends Omit<OriginalMcpBrokerOptions, "authorization"> {
  authorization: OriginalMcpNativeBrokerAuthorization;
  owner: RootOwner;
  storage: Storage;
  nativeHost: OriginalMcpNativeHost;
}
type ShutdownReason = "maintenance" | "critical-failure";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function within(base: string, value: string) {
  const rel = relative(base, value);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function originalMcpBrokerAvailability(writable: boolean): OriginalMcpBrokerDescriptor["availability"] {
  const names = new Set(["get_note", "list_notes", "search_notes", "get_skill", "list_skills", "search_skills",
    "get_paper", "get_research", "list_papers", "list_research", "search_papers", "search_research",
    ...(writable ? ["add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"] : [])]);
  const entries = (contracts as { contracts: { id: string; transportName: string }[] }).contracts;
  return {
    enabledOperationIds: entries.filter(item => names.has(item.transportName)).map(item => item.id).sort(),
    disabledOperationIds: entries.filter(item => !names.has(item.transportName)).map(item => item.id).sort(),
    limitations: [
      "Explicit reduced knowledge-content-only scope; not original MCP parity.",
      "Lexical public Note/Skill/Paper content only; indexed/graph routes, private originals and legacy runtimes are unavailable.",
      "Original Trash remains preserved without restore/purge authority; moves with retained private subtrees are unavailable.",
      "No Chat, Actions, automation, models, memory, subscriptions, snapshots, scripts, worker tokens or automatic write replay.",
    ],
  };
}
export function originalMcpNativeBrokerAvailability(writable: boolean,
  native?: { storage: Storage; host: OriginalMcpNativeHost }): OriginalMcpBrokerDescriptor["availability"] {
  const source = originalPublicMcpContracts() as {
    provenance: { metadataSha256: string; producer: { revision: string } };
    contracts: { id: string; readOnly: boolean }[];
  };
  const readiness = verifyOriginalMcpImplementationReadiness({ acceptedScope: "preserve-existing-mcp/v1",
    catalogSha256: source.provenance.metadataSha256, catalogRevision: source.provenance.producer.revision });
  const implemented = new Set(readiness.implementedOperationIds);
  const conditional = new Set(["mcp.tool.update_note", "mcp.tool.update_skill", "mcp.tool.update_paper"]);
  if (native) {
    assertOriginalMcpNativeHost(native.host, native.storage);
    if (writable && getNativeOriginalTrashPort(native.storage, native.host))
      conditional.add("mcp.tool.knowledge_file_trash");
  }
  const unconditionalOperationIds = source.contracts.filter(item => implemented.has(item.id)
    && (writable || item.readOnly)).map(item => item.id).sort();
  const conditionalOperationIds = source.contracts.filter(item => conditional.has(item.id)
    && (writable || item.readOnly)).map(item => item.id).sort();
  const enabled = new Set([...unconditionalOperationIds, ...conditionalOperationIds]);
  return {
    enabledOperationIds: [...enabled].sort(),
    disabledOperationIds: source.contracts.filter(item => !enabled.has(item.id)).map(item => item.id).sort(),
    unconditionalOperationIds, conditionalOperationIds,
    limitations: [
      "Explicit native-dogfood/v1 increment, not preserve-existing-mcp/v1 or full 151-operation parity.",
      `${implemented.size} operations pass the unconditional implementation gate before read-only filtering; every business call still requires fresh exact native approval.`,
      "Conditional content/CAS updates are exposed, but private-reference rename/category moves remain unavailable.",
      "Semantic/graph/auto retrieval requires its separate native model/corpus admission; no silent lexical fallback.",
      "Public file Trash is conditional on the actual current native Trash port; custody and per-target review still gate every call. Canonical Trash, purge and unrelated native domains are not granted by this condition.",
      "No inherited legacy permissions, worker tokens, automatic write replay or production qualification.",
    ],
  };
}
async function writePrivate(path: string, bytes: Buffer) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
function sameSecret(value: unknown, expected: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"));
}

function responseDrainingTransport(wire: Transport, socket: Socket) {
  const responses = new Map<string, (() => void)[]>(), pending = new Set<Promise<void>>();
  const key = (id: string | number) => JSON.stringify(id);
  const complete = (id: string | number) => {
    const callbacks = responses.get(key(id));
    callbacks?.shift()?.();
    if (!callbacks?.length) responses.delete(key(id));
  };
  socket.once("close", () => {
    for (const callbacks of responses.values()) for (const done of callbacks) done();
    responses.clear();
  });
  const transport: Transport = {
    async start() {
      wire.onmessage = (message, extra) => {
        if ("method" in message && "id" in message && !socket.destroyed) {
          let done!: () => void;
          const response = new Promise<void>(ready => { done = ready; });
          pending.add(response);
          const callbacks = responses.get(key(message.id)) ?? [];
          callbacks.push(() => { pending.delete(response); done(); });
          responses.set(key(message.id), callbacks);
        } else if ("method" in message && message.method === "notifications/cancelled") {
          const id = message.params?.requestId;
          if (typeof id === "string" || typeof id === "number")
            while (responses.has(key(id))) complete(id);
        }
        transport.onmessage?.(message, extra);
      };
      wire.onerror = error => transport.onerror?.(error);
      wire.onclose = () => transport.onclose?.();
      await wire.start();
    },
    async send(message, extra) {
      try {
        await wire.send(message, extra);
        // SDK send resolves on write acceptance; the callback also waits for queued socket bytes.
        await new Promise<void>((ready, reject) => {
          socket.write("", error => error ? reject(error) : ready());
        });
      } finally {
        if (!("method" in message) && "id" in message
          && (typeof message.id === "string" || typeof message.id === "number")) complete(message.id);
      }
    },
    close: () => wire.close(),
  };
  return { transport, async drain() {
    while (pending.size) await Promise.all([...pending]);
  } };
}

/** The trusted offline operator owns this process and its one canonical root, not any client transport. */
export async function startOriginalMcpBroker(options: OriginalMcpBrokerOptions) {
  return startBroker(options);
}

/** Attach business transports to the bootstrap's actual owner; its lifetime remains bootstrap-owned. */
export async function startOriginalMcpNativeBroker(options: OriginalMcpNativeBrokerOptions) {
  return startBroker(options, options);
}

async function startBroker(options: OriginalMcpBrokerOptions | OriginalMcpNativeBrokerOptions,
  native?: OriginalMcpNativeBrokerOptions) {
  const plan = parseOriginalMcpPlan(options.plan), authorization = native
    ? originalMcpNativeBrokerAuthorizationSchema.parse(options.authorization)
    : originalMcpBrokerAuthorizationSchema.parse(options.authorization);
  if (authorization.operatorId !== plan.operatorId || authorization.profileSha256 !== plan.profileSha256
    || authorization.planSha256 !== plan.planSha256 || !isTrustedLinuxRootWriterFence(options.writerFence, plan.root))
    originalMcpBrokerError();
  options.writerFence.assertHeld();
  const directory = options.directory;
  assertOriginalMcpBrokerDirectory(directory);
  if (within(plan.root, directory) || within(directory, plan.root)
    || within(plan.backup, directory) || within(directory, plan.backup) || (await readdir(directory)).length)
    originalMcpBrokerError();
  const socketPath = join(directory, "s"), descriptorPath = join(directory, "descriptor.json");
  if (Buffer.byteLength(socketPath) > 103) originalMcpBrokerError();
  const runtime = {
    node: pinOriginalMcpBrokerFile(options.runtime.node.path), relay: pinOriginalMcpBrokerFile(options.runtime.relay.path),
    buildSha256: digest.parse(options.runtime.buildSha256),
  };
  if (runtime.node.sha256 !== options.runtime.node.sha256 || runtime.relay.sha256 !== options.runtime.relay.sha256
    || realpathSync(process.execPath) !== runtime.node.path
    || options.manifest.schema !== "pkm.mcp.lifecycle/v1" || options.manifest.version !== "0.1.0"
    || options.manifest.runtimeBuild !== runtime.buildSha256 || typeof options.manifest.managedRoot !== "string")
    originalMcpBrokerError();
  const availability = native ? originalMcpNativeBrokerAvailability(authorization.writable, { storage: native.storage, host: native.nativeHost })
    : originalMcpBrokerAvailability(authorization.writable);
  const protectGit = options.gitProtection?.assertCurrent.bind(options.gitProtection);
  let nativeBinding: OriginalMcpBrokerDescriptor["nativeHost"];
  if (native) {
    assertRootOwner(native.owner); assertStorage(native.storage);
    native.owner.assertWorkspaceLease(); native.storage.assertWorkspaceLease();
    assertOriginalMcpNativeHost(native.nativeHost, native.storage);
    const receipt = native.nativeHost.receipt;
    const source = originalPublicMcpContracts() as { provenance: { metadataSha256: string; producer: { revision: string } } };
    if (native.owner.workspaceRoot() !== plan.root || native.storage.workspaceRoot() !== plan.root
      || (await native.owner.ensureFull()).storage !== native.storage
      || await native.owner.workspaceId() !== receipt.workspaceId || await native.storage.workspaceId() !== receipt.workspaceId
      || receipt.root !== plan.root || receipt.planSha256 !== plan.planSha256 || receipt.profileSha256 !== plan.profileSha256
      || receipt.sourceCatalogSha256 !== source.provenance.metadataSha256 || !receipt.domains.includes("mcp-public"))
      originalMcpBrokerError();
    nativeBinding = { receiptSha256: receipt.receiptSha256, catalogSha256: receipt.sourceCatalogSha256,
      catalogRevision: source.provenance.producer.revision, authorityId: receipt.authorityId, epoch: receipt.epoch };
    native.nativeHost.assertCurrent();
  }
  const opened = native ? { owner: native.owner, storage: native.storage, workspaceId: native.nativeHost.receipt.workspaceId }
    : await openOriginalMcpRoot(plan, { writerFence: options.writerFence,
      ...(options.gitProtection ? { gitProtection: options.gitProtection } : {}) });
  let backend: ReturnType<typeof createNativePublicOwnerBackend>;
  try {
    backend = createNativePublicOwnerBackend(opened.owner, {
      actor: Object.freeze({ id: "mcp:external", canWrite: authorization.writable }),
      ...(native ? { originalMcpHost: native.nativeHost } : {}),
    });
  } catch (error) { if (!native) await opened.owner.close(); throw error; }
  let stopping = false, shutdownComplete = false, closing: Promise<void> | undefined;
  let reason: ShutdownReason = "maintenance";
  let finishClosed!: (value: { reason: ShutdownReason }) => void;
  let rejectClosed!: (error: unknown) => void;
  const stopped = new Promise<{ reason: ShutdownReason }>((ready, reject) => { finishClosed = ready; rejectClosed = reject; });
  void stopped.catch(() => {});
  let descriptor: OriginalMcpBrokerDescriptor, descriptorSha256 = "", descriptorFilePin = "";
  let descriptorPublished = false, socketPin: { device: string; inode: string } | undefined;
  const sockets = new Set<Socket>(), pending = new Set<Promise<void>>(), drainErrors: unknown[] = [];
  type Session = Awaited<ReturnType<typeof startNativePublicMcp>> & { drainResponses(): Promise<void> };
  const sessions = new Map<Socket, Session>();
  const serverStatus = (): ServerStatus => {
    const health = [...sessions.values()].map(session => session.lifecycle.status());
    return serverStatusSchema.parse({
      schema: "pkm.server-status/v1", workspaceId: opened.workspaceId, instanceId: descriptor.brokerId,
      runtimeBuild: runtime.buildSha256, writable: authorization.writable, scope: authorization.acceptedScope,
      phase: reason === "critical-failure" || drainErrors.length || health.some(item => item.controlError)
        ? "action-required" : shutdownComplete ? "closed" : stopping ? "draining" : "accepting",
      clients: sessions.size,
      inFlight: health.reduce((sum, item) => sum + item.inFlight, 0),
      uncertainCalls: health.reduce((sum, item) => sum + item.uncertainCalls, 0),
      handoff: { available: false, blockers: ["shared-routing-not-implemented", "unmanaged-writer-coverage-unverified"] },
    });
  };
  const assertCurrent = (admitting = true) => {
    if (stopping && admitting) originalMcpBrokerError();
    options.writerFence.assertHeld();
    opened.owner.assertWorkspaceLease();
    if (native) {
      protectGit?.();
      assertOriginalMcpNativeHost(native.nativeHost, opened.storage);
    }
    const verified = readOriginalMcpBrokerDescriptor(descriptorPath, descriptorSha256);
    if (verified.filePin !== descriptorFilePin || verified.descriptor.workspaceId !== opened.workspaceId
      || verified.descriptor.profileSha256 !== plan.profileSha256) originalMcpBrokerError();
  };
  const server = createServer({ allowHalfOpen: false }, socket => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => { socket.destroy(); });
    socket.once("close", () => { sockets.delete(socket); });
    const task = attach(socket).catch(() => { socket.destroy(); }).finally(() => { pending.delete(task); });
    pending.add(task);
  });
  const revoke = () => {
    if (stopping) return;
    reason = "critical-failure"; void stop().catch(() => {});
  };
  server.on("error", () => { if (descriptorPublished) revoke(); });
  let monitor: NodeJS.Timeout | undefined;
  async function attach(socket: Socket) {
    const statusOnly = await new Promise<boolean>((ready, reject) => {
      let bytes = Buffer.alloc(0), settled = false;
      const timer = setTimeout(() => fail(), 2000);
      const cleanup = () => {
        clearTimeout(timer); socket.removeListener("data", data);
        socket.removeListener("close", fail); socket.removeListener("error", fail);
      };
      const fail = () => {
        if (settled) return; settled = true; cleanup(); reject(new Error("Broker authentication refused."));
      };
      const data = (chunk: Buffer) => {
        if (settled) return;
        bytes = Buffer.concat([bytes, chunk]);
        const end = bytes.indexOf(10);
        if (bytes.length > 2048 || end !== -1 && end !== bytes.length - 1) { fail(); return; }
        if (end === -1) return;
        try {
          const value = JSON.parse(bytes.subarray(0, end).toString("utf8"));
          const statusOnly = value?.schema === "pkm.server-status-request/v1";
          assertCurrent(!statusOnly);
          if (!value || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).sort().join(",") !== "brokerId,descriptorSha256,schema,token"
            || (!statusOnly && value.schema !== "pkm.original-mcp-auth/v1") || value.brokerId !== descriptor.brokerId
            || value.descriptorSha256 !== descriptorSha256 || !sameSecret(value.token, descriptor.token))
            originalMcpBrokerError();
          settled = true; cleanup(); socket.pause(); ready(statusOnly);
        } catch { fail(); }
      };
      socket.on("data", data); socket.once("close", fail); socket.once("error", fail);
    });
    if (statusOnly) {
      assertCurrent(false);
      socket.end(JSON.stringify({ schema: "pkm.original-mcp-auth-result/v1", brokerId: descriptor.brokerId,
        workspaceId: opened.workspaceId, descriptorSha256, accepted: true, serverStatus: serverStatus() }) + "\n",
      () => socket.destroy());
      return;
    }
    assertCurrent();
    const boundary = createNativePublicStdio(socket, socket);
    const delivery = responseDrainingTransport(boundary.transport, socket);
    const session: Session = { ...await startNativePublicMcp({
      async invoke(name, input) {
        assertCurrent();
        if (native && name !== "original_mcp_public")
          throw new Error("NOT_AVAILABLE: native-dogfood/v1 does not admit canonical Todo/Memory operations.");
        const result = await backend.invoke(name, input);
        assertCurrent(false);
        return result;
      },
      async close() {},
    }, { writable: authorization.writable, manifest: options.manifest, availability,
      profile: "compact", ...(native ? { catalogProfile: "original-full", toolSurface: "hybrid" } as const : {}),
      closeBackend: async () => {} }, delivery.transport, boundary), drainResponses: delivery.drain };
    sessions.set(socket, session);
    socket.once("close", () => {
      const drain = session.close().catch(error => { drainErrors.push(error); revoke(); })
        .finally(() => { sessions.delete(socket); pending.delete(drain); });
      pending.add(drain);
    });
    if (stopping || socket.destroyed) { await session.close(); sessions.delete(socket); return; }
    socket.write(JSON.stringify({ schema: "pkm.original-mcp-auth-result/v1", brokerId: descriptor.brokerId,
      workspaceId: opened.workspaceId, descriptorSha256, accepted: true }) + "\n");
    socket.resume();
  }
  async function stop() {
    return closing ??= (async () => {
      stopping = true; if (monitor) clearInterval(monitor);
      native?.nativeHost.signal.removeEventListener("abort", revoke);
      try { protectGit?.(); } catch { reason = "critical-failure"; }
      for (const [socket, session] of sessions) {
        socket.pause();
        try { session.lifecycle.quiesce(); } catch (error) { drainErrors.push(error); }
        const drain = (async () => {
          try { await session.drainResponses(); } finally { await session.close(); }
        })().catch(error => { drainErrors.push(error); }).finally(() => { socket.destroy(); });
        pending.add(drain); void drain.finally(() => { pending.delete(drain); }).catch(() => {});
      }
      for (const socket of sockets) if (!sessions.has(socket)) socket.destroy();
      while (pending.size) await Promise.allSettled([...pending]);
      await new Promise<void>(ready => { if (server.listening) server.close(() => ready()); else ready(); });
      try { await backend.close(); } catch (error) { drainErrors.push(error); }
      finally { if (!native) await opened.owner.close(); }
      if (descriptorPublished) {
        try {
          const stat = await lstat(descriptorPath, { bigint: true });
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
            && [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") === descriptorFilePin
            && hash(readFileSync(descriptorPath)) === descriptorSha256) await unlink(descriptorPath);
        } catch { /* Changed controls require operator inspection, never destructive cleanup. */ }
      }
      if (socketPin) {
        try {
          const stat = await lstat(socketPath, { bigint: true });
          if (stat.isSocket() && String(stat.dev) === socketPin.device && String(stat.ino) === socketPin.inode)
            await unlink(socketPath);
        } catch { /* The server may already have removed its socket. */ }
      }
      if (drainErrors.length) throw new AggregateError(drainErrors, "Original MCP broker drain failed; no call was replayed.");
      shutdownComplete = true;
      finishClosed({ reason });
    })().catch(error => { reason = "critical-failure"; rejectClosed(error); throw error; });
  }
  try {
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(socketPath, () => {
      server.removeListener("error", reject); ready();
    }); });
    await chmod(socketPath, 0o600);
    const socket = await lstat(socketPath, { bigint: true }), root = await lstat(plan.root, { bigint: true });
    socketPin = { device: String(socket.dev), inode: String(socket.ino) };
    descriptor = {
      schema: "pkm.original-mcp-broker/v1", brokerId: randomUUID(), descriptorPath,
      root: { path: plan.root, device: String(root.dev), inode: String(root.ino) }, workspaceId: opened.workspaceId,
      planSha256: plan.planSha256, profileSha256: plan.profileSha256, operatorId: plan.operatorId,
      scope: authorization.acceptedScope, writable: authorization.writable, runtime,
      process: originalMcpBrokerProcessPin(), socket: { path: socketPath, ...socketPin, mode: 0o600 },
      availability, token: randomBytes(32).toString("hex"),
      ...(nativeBinding ? { nativeHost: nativeBinding } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(descriptor));
    descriptorSha256 = hash(bytes);
    await writePrivate(descriptorPath, bytes);
    descriptorPublished = true;
    descriptorFilePin = readOriginalMcpBrokerDescriptor(descriptorPath, descriptorSha256).filePin;
    opened.owner.onLeaseLost(revoke);
    native?.nativeHost.signal.addEventListener("abort", revoke, { once: true });
    if (native?.nativeHost.signal.aborted) originalMcpBrokerError();
    monitor = setInterval(() => {
      try { assertCurrent(); }
      catch { revoke(); }
    }, 500);
    monitor.unref();
    return {
      descriptorPath, descriptorSha256, owner: opened.owner, storage: opened.storage, stop, closed: stopped, serverStatus,
      status: () => ({ schema: "pkm.original-mcp-broker-status/v1" as const, brokerId: descriptor.brokerId,
        workspaceId: opened.workspaceId, writable: authorization.writable, scope: descriptor.scope,
        clients: sessions.size, pending: pending.size, stopping, reason }),
    };
  } catch (error) { await stop(); throw error; }
}
