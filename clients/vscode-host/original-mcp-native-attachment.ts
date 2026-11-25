import * as vscode from "vscode";
import { createConnection } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { bindOriginalMcpNativeBootstrap } from "./original-mcp-enrollment.js";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalMcpNativeChallenge } from "../../src/original-mcp-native-identity.js";
import { originalMcpNativeApprovals } from "./original-mcp-native-approvals.js";
import type { OriginalMcpNativeRequestFrame } from "../../src/original-mcp-native-request.js";
import { enableOriginalMcpNativeChatSession } from "./original-mcp-native-chat-session.js";
import { createOriginalMcpNativeActionProducer } from "./original-mcp-native-action.js";
import { isOriginalNativeActionMethod } from "../../src/original-mcp-native-action-contracts.js";
import { originalActionProgramMethod } from "../../src/original-mcp-action-program-contracts.js";
import { createOriginalMcpNativeSourceProducer } from "./original-mcp-native-source.js";
import { isOriginalNativeSourceMethod } from "../../src/original-mcp-native-source-contracts.js";
import { createOriginalMcpNativeRecipeProducer } from "./original-mcp-native-recipe.js";
import { isOriginalNativeRecipeMethod } from "../../src/original-mcp-native-recipe-contracts.js";
import { createOriginalMcpNativeRoomProducer } from "./original-mcp-native-room.js";
import { isOriginalNativeRoomMethod } from "../../src/original-mcp-native-room-contracts.js";
import { createOriginalMcpNativeRoomSessionsProducer } from "./original-mcp-native-room-sessions.js";
import { isOriginalRoomSessionNativeMethod } from "../../src/original-mcp-room-session-contracts.js";
import { createOriginalMcpNativeTodoWorkerProducer } from "./original-mcp-native-todo-worker.js";
import { isOriginalNativeTodoWorkerMethod } from "../../src/original-mcp-native-todo-worker-contracts.js";
import { createOriginalMcpNativeTodoRoleProducer } from "./original-mcp-native-todo-role.js";
import { isOriginalTodoRoleMethod } from "../../src/original-mcp-todo-role-contracts.js";
import { createOriginalKnowledgeRecoveryProducer } from "./original-knowledge-recovery-producer.js";
import { originalRecoveryPhase1Methods } from "../../src/original-knowledge-recovery-contracts.js";
import { createOriginalMcpNativeSubscriptionProducer } from "./original-mcp-native-subscription.js";
import { originalSubscriptionReadMethod } from "../../src/original-mcp-subscription-contracts.js";
import { createOriginalMcpNativeRecipeEffectProducer } from "./original-mcp-native-recipe-effect.js";
import { originalSubscriptionProfileMethod } from "../../src/original-mcp-subscription-profile-contracts.js";
import { isNativeActionPackageMethod } from "../../src/original-mcp-action-package-native-contracts.js";
import { originalNativeSyncMethod } from "../../src/original-mcp-native-sync-contracts.js";
import { createOriginalMcpNativeSyncProducer } from "./original-mcp-native-sync.js";
import { originalRecipeEffectMethod } from "../../src/original-mcp-recipe-effect-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-attachment/v1"),
  brokerId: z.string().uuid(), socketPath: z.string(),
  identitySha256: digest,
  binding: z.strictObject({
    root: z.string(), workspaceId: z.string().uuid(), planSha256: digest, catalogSha256: digest,
    profileSha256: digest, payloadBuildId: digest, hostEntrySha256: digest,
  }),
});
const attachedSchema = z.strictObject({
  type: z.literal("attached"), brokerId: z.string().uuid(), activationId: z.string().uuid(),
  identitySha256: digest, businessReady: z.literal(false),
});
const pingSchema = z.strictObject({ type: z.literal("ping"), nonce: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const challengeFrameSchema = z.strictObject({ type: z.literal("challenge"), challenge: z.unknown() });
type ChatChannel = Awaited<ReturnType<typeof enableOriginalMcpNativeChatSession>>;
type Attachment = Readonly<{ signal: AbortSignal; close(): Promise<void>; enableModels(): Promise<void>; enableActions(): Promise<void> }>;
type StopOrigin = "protocol" | "socket-close" | "socket-error" | "requested-close" | "signer-abort" | "authentication-deadline";
const stopCodes = new Set(["EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOENT", "ERR_STREAM_DESTROYED", "ABORT_ERR",
  "NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT", "NATIVE_ATTACHMENT_SESSION_REVOKED", "NATIVE_CHAT_CANCELLED",
  "NATIVE_CHAT_CLOSED", "NATIVE_CHAT_TIMEOUT", "NATIVE_CHAT_PROTOCOL_INVALID", "NATIVE_CHAT_SESSION_REVOKED",
  "NATIVE_CHAT_SESSION_MISMATCH", "NATIVE_CHAT_FRAME_LIMIT", "NATIVE_CHAT_BACKPRESSURE",
  "NATIVE_REQUEST_BINDING_MISMATCH", "NATIVE_REQUEST_INVALID", "NATIVE_REQUEST_CANCELLED", "NATIVE_DENIED"]);
function stopCauseCodes(error: unknown): string[] {
  const codes: string[] = [];
  try {
    for (let depth = 0; error && typeof error === "object" && depth < 3; depth++) {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      codes.push(typeof code === "string" && stopCodes.has(code) ? code : "UNCLASSIFIED");
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch { codes.push("UNAVAILABLE"); }
  return codes.slice(0, 3);
}
function refused(message: string): never { throw new Error(`NATIVE_ATTACHMENT_UNAVAILABLE: ${message}`); }

export function registerOriginalMcpNativeAttachment(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const bootstrap = bindOriginalMcpNativeBootstrap(context.globalStorageUri.fsPath);
  let disposed = false, attempted = false, connecting: Promise<Attachment> | undefined;
  let observeDisposalIntent: (() => void) | undefined;
  const report = () => {
    output.appendLine("Native producer attachment is unavailable or disconnected; no business MCP activation or automatic replay occurred.");
    if (!disposed) void vscode.window.showErrorMessage("PKM v5 native attachment failed. Verify its independently pinned bootstrap and native identity; business activation remains closed.");
  };
  async function connect(): Promise<Attachment> {
    if (disposed) return refused("The native activation was disposed.");
    const pointer = bootstrap.current();
    if (!pointer) return refused("No private native bootstrap was provisioned for this activation.");
    const signer = await originalMcpNativeSigner(context);
    signer.assertCurrent();
    const runtime: unknown = await import(pathToFileURL(join(context.extensionPath,
      "next-runtime/server/dist/original-mcp-native-attachment.js")).href);
    if (!runtime || typeof runtime !== "object" || !("verifyOriginalMcpNativeAttachmentDescriptor" in runtime)
      || typeof runtime.verifyOriginalMcpNativeAttachmentDescriptor !== "function")
      return refused("The qualified native attachment verifier is missing.");
    const descriptor = descriptorSchema.parse(await runtime.verifyOriginalMcpNativeAttachmentDescriptor(
      pointer.descriptorPath, pointer.descriptorSha256, pointer.profileSha256));
    if (descriptor.identitySha256 !== signer.identity.sha256
      || descriptor.binding.profileSha256 !== signer.identity.profileSha256
      || descriptor.binding.payloadBuildId !== signer.payloadBuildId
      || descriptor.binding.hostEntrySha256 !== signer.hostEntrySha256)
      return refused("The native identity or installed build does not match the bootstrap.");
    const protocol: typeof import("../../src/original-mcp-native-request.js") = await import(pathToFileURL(
      join(context.extensionPath, "next-runtime/server/dist/original-mcp-native-request.js")).href);
    if (typeof protocol.parseOriginalMcpNativeRequest !== "function" || typeof protocol.originalMcpNativeResult !== "function")
      return refused("The qualified native request parser is missing.");
    let chat: ChatChannel | undefined;
    let actions: Awaited<ReturnType<typeof createOriginalMcpNativeActionProducer>> | undefined;
    let sources: Awaited<ReturnType<typeof createOriginalMcpNativeSourceProducer>> | undefined;
    let recipes: Awaited<ReturnType<typeof createOriginalMcpNativeRecipeProducer>> | undefined;
    let rooms: Awaited<ReturnType<typeof createOriginalMcpNativeRoomProducer>> | undefined;
    let roomSessions: ReturnType<typeof createOriginalMcpNativeRoomSessionsProducer> | undefined;
    let workers: Awaited<ReturnType<typeof createOriginalMcpNativeTodoWorkerProducer>> | undefined;
    let roles: Awaited<ReturnType<typeof createOriginalMcpNativeTodoRoleProducer>> | undefined;
    let recovery: Awaited<ReturnType<typeof createOriginalKnowledgeRecoveryProducer>> | undefined;
    let subscriptions: Awaited<ReturnType<typeof createOriginalMcpNativeSubscriptionProducer>> | undefined;
    let recipeEffects: Awaited<ReturnType<typeof createOriginalMcpNativeRecipeEffectProducer>> | undefined;
    let sync: Awaited<ReturnType<typeof createOriginalMcpNativeSyncProducer>> | undefined;
    const approvals = await originalMcpNativeApprovals(context, (model, digest) => chat?.claimInference(model, digest) === true);
    const session = protocol.originalMcpNativeRequestSessionSchema.parse({
      brokerId: descriptor.brokerId, activationId: signer.activationId, identitySha256: signer.identity.sha256,
      epoch: signer.activationId, binding: descriptor.binding,
    });
    bootstrap.current();
    if (disposed) return refused("The native activation was disposed during verification.");
    const socket = createConnection({ path: descriptor.socketPath }), lifetime = new AbortController();
    let phase: "challenge" | "signing" | "attaching" | "attached" | "closed" = "challenge";
    let buffered = Buffer.alloc(0), resolveReady!: (value: Attachment) => void, rejectReady!: (error: Error) => void;
    let requestedClose = false;
    let firstStopRecorded = false, disposalIntentRecorded = false;
    const connectedAt = performance.now();
    const pending = new Map<string, { request: OriginalMcpNativeRequestFrame; controller: AbortController }>();
    const retired = new Map<string, string>();
    let enablingChat: Promise<void> | undefined, closingChat: Promise<void> | undefined;
    const ready = new Promise<Attachment>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const closed = new Promise<void>(resolve => socket.once("close", resolve));
    const timer = setTimeout(() => fail(new Error("Native producer authentication timed out."), "authentication-deadline"), 90_000);
    const stop = () => {
      recordStop(signer.signal.aborted ? "signer-abort" : "requested-close", signer.signal.reason, disposed);
      void close();
    };
    const attachment: Attachment = Object.freeze({ signal: lifetime.signal, close, enableModels, enableActions });
    async function enableActions() {
      current();
      if (phase !== "attached" || !actions) return refused("Native Action identity authentication has not completed.");
      if (!await actions.enable()) return refused("Separate native Action approvals were declined.");
      current();
    }
    async function enableModels() {
      current();
      if (phase !== "attached") return refused("Native identity authentication has not completed.");
      return enablingChat ??= (async () => {
        const channel = await enableOriginalMcpNativeChatSession(context,
          { session, signal: lifetime.signal, assertCurrent: current, send, diagnostics: output, close() {
            recordStop("protocol", undefined, false);
            return closeTransport();
          } });
        chat = channel;
        try { current(); await channel.support(); current(); }
        catch (error) {
          await closeChat();
          throw error;
        }
      })().catch(error => { enablingChat = undefined; throw error; });
    }
    function closeChat(): Promise<void> {
      if (!chat) return Promise.resolve();
      return closingChat ??= chat.dispose();
    }
    function current() {
      signer.assertCurrent(); bootstrap.current();
      if (disposed || lifetime.signal.aborted || socket.destroyed) return refused("The native attachment is no longer current.");
    }
    function writeStop(prefix: "first-stop" | "disposal-intent", origin: StopOrigin, error: unknown,
      expectedShutdown: boolean, terminalObserved: boolean) {
      try {
        const now = performance.now(), memory = process.memoryUsage();
        const line = `[pkm.native-attachment.${prefix}] ${JSON.stringify({
          origin, phase, expectedShutdown, terminalObserved, epochTimeMs: Date.now(), monotonicMs: now, pid: process.pid,
          elapsedMs: now - connectedAt, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal, causeCodes: stopCauseCodes(error),
        })}`;
        try { output.appendLine(line); }
        catch { try { console.error(line); } catch { /* A diagnostic failure cannot prevent shutdown. */ } }
      } catch { /* A diagnostic sink must never prevent the existing cancellation and cleanup. */ }
    }
    observeDisposalIntent = () => {
      if (firstStopRecorded || disposalIntentRecorded) return;
      disposalIntentRecorded = true;
      writeStop("disposal-intent", "requested-close", undefined, true, false);
    };
    function recordStop(origin: StopOrigin, error: unknown, expectedShutdown = requestedClose) {
      if (firstStopRecorded) return;
      firstStopRecorded = true;
      writeStop("first-stop", origin, error, expectedShutdown, true);
    }
    function fail(error: Error, origin: StopOrigin = "protocol", diagnosticError: unknown = error) {
      if (phase === "closed") return;
      recordStop(origin, diagnosticError);
      const wasAttached = phase === "attached";
      phase = "closed"; clearTimeout(timer); lifetime.abort();
      actions?.dispose();
      sources?.dispose();
      recipes?.dispose();
      rooms?.dispose();
      void roomSessions?.dispose().catch(() => { output.appendLine("Native Room session cleanup requires reconciliation."); });
      workers?.dispose();
      roles?.dispose();
      recovery?.dispose();
      subscriptions?.dispose();
      sync?.dispose();
      approvals.dispose();
      for (const item of pending.values()) item.controller.abort();
      pending.clear(); retired.clear(); socket.destroy();
      void closeChat().catch(() => { output.appendLine("Native model channel shutdown failed; pending native requests require reconciliation."); });
      rejectReady(error);
      if (wasAttached && !requestedClose) report();
    }
    async function closeTransport(): Promise<void> {
      requestedClose = true;
      fail(new Error("Native producer attachment was closed."), "requested-close");
      await closed;
    }
    async function close(): Promise<void> {
      // Protocol fatal shutdown must not await its own channel-disposal promise.
      const results = await Promise.allSettled([closeTransport(), closeChat(), roomSessions?.dispose()]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Native attachment shutdown could not be confirmed.");
    }
    function send(value: object): Promise<void> {
      current();
      const line = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(line) > 65536 || socket.writableLength + Buffer.byteLength(line) > 65536 * 8)
        return refused("The native response exceeded its bounded transport.");
      return new Promise((resolve, reject) => {
        socket.write(line, error => error ? reject(error) : resolve());
      });
    }
    async function request(value: unknown) {
      const parsed = protocol.parseOriginalMcpNativeRequest(value, session);
      if (pending.has(parsed.requestId) || retired.has(parsed.requestId))
        return refused("A native request ID was replayed.");
      if (pending.size >= 8) {
        await send(protocol.originalMcpNativeErrorResult(parsed, "NATIVE_HANDLER_FAILED"));
        return;
      }
      const controller = new AbortController();
      pending.set(parsed.requestId, { request: parsed, controller });
      try {
        if (parsed.method !== originalActionProgramMethod && !isOriginalNativeActionMethod(parsed.method) && !isOriginalNativeSourceMethod(parsed.method)
          && !isOriginalNativeRecipeMethod(parsed.method)
          && !isOriginalNativeRoomMethod(parsed.method)
          && !isOriginalRoomSessionNativeMethod(parsed.method)
          && !isOriginalNativeTodoWorkerMethod(parsed.method)
          && !isOriginalTodoRoleMethod(parsed.method)
          && parsed.method !== originalRecoveryPhase1Methods.source
          && parsed.method !== originalRecoveryPhase1Methods.repair
          && parsed.method !== originalSubscriptionReadMethod
          && parsed.method !== originalSubscriptionProfileMethod
          && parsed.method !== originalRecipeEffectMethod
          && parsed.method !== originalNativeSyncMethod
          && !isNativeActionPackageMethod(parsed.method)
          && !approvals.methods.includes(parsed.method)) {
          await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
          return;
        }
        let result: unknown;
        if (parsed.method === originalNativeSyncMethod) {
          if (!sync) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await sync.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (parsed.method === originalRecipeEffectMethod) {
          if (!recipeEffects) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await recipeEffects.handle(parsed.payload, parsed.requestId, controller.signal);
        } else if (parsed.method === originalSubscriptionReadMethod || parsed.method === originalSubscriptionProfileMethod) {
          if (!subscriptions) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = parsed.method === originalSubscriptionProfileMethod
            ? await subscriptions.handleProfile(parsed.payload, parsed.requestId, controller.signal)
            : await subscriptions.handle(parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalRoomSessionNativeMethod(parsed.method)) {
          const producer = roomSessions;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (parsed.method === originalRecoveryPhase1Methods.source
          || parsed.method === originalRecoveryPhase1Methods.repair) {
          const producer = recovery;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalTodoRoleMethod(parsed.method)) {
          const producer = roles;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalNativeTodoWorkerMethod(parsed.method)) {
          const producer = workers;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalNativeRoomMethod(parsed.method)) {
          const producer = rooms;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalNativeRecipeMethod(parsed.method)) {
          const producer = recipes;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalNativeSourceMethod(parsed.method)) {
          const producer = sources;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else if (isOriginalNativeActionMethod(parsed.method) || parsed.method === originalActionProgramMethod
          || isNativeActionPackageMethod(parsed.method)) {
          const producer = actions;
          if (!producer) {
            await send(protocol.originalMcpNativeErrorResult(parsed, "MISSING_NATIVE_METHOD"));
            return;
          }
          result = await producer.handle(parsed.method, parsed.payload, parsed.requestId, controller.signal);
        } else result = await approvals.handle(parsed, controller.signal);
        current();
        await send(controller.signal.aborted
          ? protocol.originalMcpNativeErrorResult(parsed, "NATIVE_REQUEST_CANCELLED")
          : protocol.originalMcpNativeResult(parsed, result));
      } catch (error) {
        if (!lifetime.signal.aborted) {
          const code = error instanceof Error ? error.message : "";
          await send(protocol.originalMcpNativeErrorResult(parsed, controller.signal.aborted ? "NATIVE_REQUEST_CANCELLED"
            : code === "NATIVE_DENIED" ? "NATIVE_DENIED" : "NATIVE_HANDLER_FAILED"));
        }
      } finally {
        pending.delete(parsed.requestId);
        retired.set(parsed.requestId, parsed.requestDigest);
        if (retired.size > 256) retired.delete(retired.keys().next().value!);
      }
    }
    async function frame(value: unknown) {
      current();
      if (phase === "challenge") {
        const request = challengeFrameSchema.parse(value);
        const challenge = originalMcpNativeChallenge(request.challenge);
        if (challenge.brokerId !== descriptor.brokerId
          || challenge.root !== descriptor.binding.root || challenge.workspaceId !== descriptor.binding.workspaceId
          || challenge.planSha256 !== descriptor.binding.planSha256 || challenge.catalogSha256 !== descriptor.binding.catalogSha256
          || challenge.profileSha256 !== descriptor.binding.profileSha256 || challenge.payloadBuildId !== descriptor.binding.payloadBuildId
          || challenge.hostEntrySha256 !== descriptor.binding.hostEntrySha256)
          return refused("The challenge changed the independently pinned attachment binding.");
        phase = "signing";
        const attestation = await signer.signChallenge(challenge);
        current(); phase = "attaching";
        await send({ type: "attestation", attestation });
      } else if (phase === "attaching") {
        const response = attachedSchema.parse(value);
        if (response.brokerId !== descriptor.brokerId || response.activationId !== signer.activationId
          || response.identitySha256 !== signer.identity.sha256)
          return refused("The broker attachment response does not match this native activation.");
        phase = "attached"; clearTimeout(timer);
        actions = await createOriginalMcpNativeActionProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current });
        sources = await createOriginalMcpNativeSourceProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, close: closeTransport });
        recipes = await createOriginalMcpNativeRecipeProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, close: closeTransport });
        recipeEffects = await createOriginalMcpNativeRecipeEffectProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, sourceAdmission: recipes.sourceAdmission });
        rooms = await createOriginalMcpNativeRoomProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, close: closeTransport });
        roomSessions = createOriginalMcpNativeRoomSessionsProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current });
        workers = await createOriginalMcpNativeTodoWorkerProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, close: closeTransport });
        roles = await createOriginalMcpNativeTodoRoleProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, close: closeTransport });
        recovery = await createOriginalKnowledgeRecoveryProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current });
        subscriptions = await createOriginalMcpNativeSubscriptionProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current, close: closeTransport });
        sync = await createOriginalMcpNativeSyncProducer(context,
          { session, signal: lifetime.signal, assertCurrent: current });
        current();
        await send({ type: "native-supports", protocol: protocol.originalMcpNativeRequestProtocol,
          session, methods: [...approvals.methods, ...actions.methods, ...sources.methods, ...recipes.methods, ...rooms.methods,
            ...workers.methods, ...roles.methods, ...recovery.methods, ...roomSessions.methods, ...subscriptions.methods,
            ...sync.methods, recipeEffects.method],
          maxPacketBytes: 65536 });
        output.appendLine("Native producer authenticated. Model/tool/state permissions and business MCP activation are not granted by attachment.");
        resolveReady(attachment);
      } else if (phase === "attached") {
        if (value && typeof value === "object" && "type" in value
          && typeof value.type === "string" && value.type.startsWith("native-chat-")) {
          if (!chat) return refused("Native model support was not explicitly enabled.");
          chat.receive(value);
        } else if (value && typeof value === "object" && "type" in value && value.type === "native-request") {
          await request(value);
        } else if (value && typeof value === "object" && "type" in value && value.type === "native-cancel") {
          const cancel = protocol.originalMcpNativeCancelSchema.parse(value);
          if (JSON.stringify(cancel.session) !== JSON.stringify(session)) return refused("A cancellation changed its native session.");
          const active = pending.get(cancel.requestId);
          if (active && active.request.requestDigest === cancel.requestDigest) active.controller.abort();
          else if (retired.get(cancel.requestId) !== cancel.requestDigest) return refused("Unknown native request cancellation.");
        } else {
          const ping = pingSchema.parse(value);
          await send({ type: "pong", nonce: ping.nonce });
        }
      } else {
        return refused("Unexpected native attachment message ordering.");
      }
    }
    signer.signal.addEventListener("abort", stop, { once: true });
    socket.on("error", error => fail(new Error("Native producer socket transport failed."), "socket-error", error));
    socket.once("close", () => {
      signer.signal.removeEventListener("abort", stop);
      fail(new Error("Native producer socket disconnected."), "socket-close");
    });
    socket.on("data", chunk => {
      try {
        if (typeof chunk === "string") return refused("Unexpected native attachment text-mode transport.");
        buffered = Buffer.concat([buffered, chunk]);
        for (let boundary; (boundary = buffered.indexOf(10)) >= 0;) {
          if (boundary > (phase === "attached" ? 65_536 : 16_384))
            return refused("The native attachment packet exceeded its bound.");
          const line = buffered.subarray(0, boundary); buffered = buffered.subarray(boundary + 1);
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          void frame(value).catch(error => fail(new Error("Native producer authentication or protocol verification failed."), "protocol", error));
        }
        if (buffered.length > (phase === "attached" ? 65_536 : 16_384))
          return refused("The native attachment packet exceeded its bound.");
      } catch (error) {
        fail(new Error("Native producer sent an invalid bounded attachment packet."), "protocol", error);
      }
    });
    if (signer.signal.aborted || disposed) stop();
    return ready;
  }
  const start = () => {
    attempted = true;
    if (!connecting) {
      connecting = connect().then(attachment => {
        attachment.signal.addEventListener("abort", () => { connecting = undefined; }, { once: true });
        return attachment;
      }, error => { connecting = undefined; report(); throw error; });
    }
    return connecting;
  };
  const command = vscode.commands.registerCommand("pkm.nextHost.attachNativeProducer", async () => {
    await start();
    return { authenticated: true, businessReady: false };
  });
  const modelCommand = vscode.commands.registerCommand("pkm.nextHost.enableNativeModels", async () => {
    try {
      const attachment = await start();
      await attachment.enableModels();
      return { nativeModelChannel: true, businessReady: false };
    } catch (error) {
      output.appendLine("Native model channel could not be enabled; no automatic model retry or business activation occurred.");
      void vscode.window.showErrorMessage("PKM v5 native model access is unavailable or was declined.");
      throw error;
    }
  });
  const actionCommand = vscode.commands.registerCommand("pkm.nextHost.enableNativeActions", async () => {
    try {
      const attachment = await start();
      await attachment.enableActions();
      return { nativeActionApprovals: true, businessReady: false };
    } catch (error) {
      output.appendLine("Native Action approvals could not be enabled; source admission and business execution remain closed.");
      void vscode.window.showErrorMessage("PKM v5 native Action approvals are unavailable or were declined.");
      throw error;
    }
  });
  const startup = bootstrap.current() ? setImmediate(() => {
    if (attempted) return;
    void start().catch(() => { output.appendLine("Native attachment startup did not complete; inspect its preceding diagnostic."); });
  }) : undefined;
  return {
    dispose() {
      observeDisposalIntent?.();
      disposed = true; if (startup) clearImmediate(startup); command.dispose(); modelCommand.dispose(); actionCommand.dispose();
      if (connecting) void connecting.then(attachment => attachment.close(), () => {}).catch(() => {
        output.appendLine("Native producer attachment cleanup failed; no business operation was replayed.");
      });
    },
  };
}
