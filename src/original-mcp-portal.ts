import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { accessSync, constants, realpathSync, openSync, closeSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CoreError, type Actor } from "./contracts.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest,
  withOriginalMcpPublicRequest, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { requestOriginalMcpNative, originalMcpNativeSupportedMethods } from "./original-mcp-native-request.js";
import { originalPortalInput, originalPortalNativeMethod, originalPortalNativeDecision } from "./original-mcp-portal-contracts.js";
import { OriginalPortalBusiness, type OriginalPortalBusinessHost } from "./original-mcp-portal-business.js";
import { RuntimeProcessService, RuntimeProcessStore, type RuntimeProcessAdapter } from "./runtime-process.js";
import { originalApiChatRequestDdl } from "./original-mcp-api-chat-schema.js";
import { createOriginalMcpApiChatRuntime } from "./original-mcp-api-chat.js";
import { pythonMetadataJson } from "./native-public-mcp.js";
import { registerOriginalPortalTaskFilter } from "./original-mcp-api-chat-task-adapter.js";
import { originalNativeChatDigest } from "./original-mcp-api-chat-contracts.js";
import { readOriginalMcpApiChatSourceSession } from "./original-mcp-api-chat-source.js";

type Json = Record<string, any>;
const result = (value: Json): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function executable(program: string) {
  for (const candidate of isAbsolute(program) ? [program] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, program))) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch {}
  }
  throw new CoreError("NOT_AVAILABLE", "The executing Host has no such executable; no process was started.");
}
function nonSecret(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(nonSecret); return; }
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|credential|privateLink|pairingCode/i.test(key))
      throw new CoreError("INVALID_RESULT", "Portal credentials are local native custody, not public results.");
    nonSecret(item);
  }
}

/** Original asynchronous public protocol, using the canonical lease/approval and retained peer components. */
export async function createOriginalMcpPortalRuntime(owner: RootOwner, actor: Readonly<Actor>, native: OriginalMcpNativeHost,
  options: { apiChat?: () => ReturnType<typeof createOriginalMcpApiChatRuntime> } = {}) {
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull(), root = storage.workspaceRoot();
  assertOriginalMcpNativeHost(native, storage);
  if (actor.id !== "mcp:external" || actor.boardWorker || !native.nativeChat
    || !originalMcpNativeSupportedMethods(native.nativeChat.session).includes(originalPortalNativeMethod))
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "A current authenticated local Portal consent producer is required.");
  const session = native.nativeChat.session, hostId = await storage.workspaceId();
  const { receiptSha256: _receipt, ...binding } = native.receipt;
  const database = storage.connectNative(), processDatabase = new DatabaseSync(":memory:");
  const lifetime = new AbortController(), pending = new Set<Promise<void>>(), liveResults = new Map<string, Json>();
  let closed = false, processService: RuntimeProcessService | undefined;
  let closing: Promise<void> | undefined;
  const processAdapters = new Map<string, RuntimeProcessAdapter>();
  const taskContexts = new Map<string, Parameters<OriginalPortalBusinessHost["executeTask"]>[0]>();
  let chat: ReturnType<typeof createOriginalMcpApiChatRuntime> | undefined;
  const current = () => {
    assertOriginalMcpNativeHost(native, storage);
    if (closed || native.signal.aborted || lifetime.signal.aborted) throw new CoreError("ACCESS_DENIED", "Portal Host is no longer current.");
  };
  const nativePortal = async (request: Json, signal: AbortSignal = lifetime.signal) => {
    current();
    const requestSha256 = originalMcpRequestDigest(request);
    const value = originalPortalNativeDecision.parse(await requestOriginalMcpNative(session, originalPortalNativeMethod,
      { binding, request, requestSha256 }, { signal, timeoutMs: 120000 }));
    current();
    if (!value || value.requestSha256 !== requestSha256 || value.epoch !== native.receipt.epoch
      || value.expiresAtMs <= Date.now() || value.expiresAtMs > Date.now() + 120000)
      throw new CoreError("ACCESS_DENIED", "Portal consent is expired or belongs to another current context.");
    return value;
  };
  const linkedTask = (requestId: string, contextId: string) => {
    current();
    const source = readOriginalMcpApiChatSourceSession(storage, native);
    const rows = database.prepare(`SELECT a.*,t.chat_id,t.goal,t.revision,t.source_plan_sha256,t.native_epoch,m.record
      FROM managed_chat_task_attempts a JOIN managed_chat_tasks t ON t.task_id=a.task_id
      JOIN chat_session_messages m ON m.actor_id=t.actor_id AND m.chat_id=t.chat_id AND m.id=a.input_id
      WHERE t.actor_id=? AND json_extract(m.record,'$.metadata.planning.schema')='pkm.original-portal-task-link/v1'
      AND json_extract(m.record,'$.metadata.planning.requestId')=? AND json_extract(m.record,'$.metadata.planning.contextId')=?`)
      .all(actor.id, requestId, contextId);
    if (rows.length !== 1) throw new CoreError("NOT_AVAILABLE", "An exact actual original Portal input/reply link is required.");
    const row = rows[0], input = JSON.parse(String(row.record)), link = input.metadata.planning;
    if (link.inputId !== row.input_id || link.replyId !== row.reply_id || link.nativeRequestId !== row.request_id
      || link.taskId !== row.task_id || row.source_plan_sha256 !== source.planSha256 || link.sourcePlanSha256 !== source.planSha256
      || link.nativeEpoch !== native.receipt.epoch || row.native_epoch !== native.receipt.epoch
      || taskContexts.get(requestId)?.pairId !== link.pairId)
      throw new CoreError("ACCESS_DENIED", "Portal Task/source/pair lineage changed.");
    return { row, input, link };
  };
  const attempts = (requestId: string, contextId: string) => {
    const original = linkedTask(requestId, contextId), messages: Json[] = [original.input];
    const rows = database.prepare(`SELECT a.*,i.record AS input,r.record AS reply
      FROM managed_chat_task_attempts a JOIN chat_session_messages i ON i.actor_id=? AND i.chat_id=? AND i.id=a.input_id
      JOIN chat_session_messages r ON r.actor_id=i.actor_id AND r.chat_id=i.chat_id AND r.id=a.reply_id
      WHERE a.task_id=? ORDER BY a.ordinal`).all(actor.id, original.row.chat_id, original.row.task_id);
    for (const row of rows) {
      const input = JSON.parse(String(row.input)), reply = JSON.parse(String(row.reply)), link = input.metadata?.planning;
      const isOriginal = row.attempt_id === original.row.attempt_id;
      if (!isOriginal && (link?.schema !== "pkm.original-portal-manual-link/v1" || link.requestId !== requestId
        || link.contextId !== contextId || link.pairId !== original.link.pairId || link.shareConfirmed !== true
        || link.originalReplyId !== original.row.reply_id || link.originalInputId !== original.row.input_id
        || link.nativeRequestId !== row.request_id || link.replyId !== row.reply_id || link.inputId !== row.input_id
        || link.nativeEpoch !== native.receipt.epoch || link.sourcePlanSha256 !== original.row.source_plan_sha256)) continue;
      messages.push({ ...reply, inputId: original.row.input_id, taskId: original.row.task_id,
        progress: { attemptId: row.attempt_id, ...(isOriginal ? {} : { retryOf: link.retryOfAttemptId }) },
        portalTask: { requestId, originalReplyId: original.row.reply_id,
          ...(isOriginal ? {} : { retryOfReplyId: link.retryOfReplyId, shareConfirmed: true }) } });
    }
    const helper = createRequire(import.meta.url)("./legacy-chatroom-retained.cjs").portalTaskAttempts;
    const value = helper({ id: original.row.chat_id, messages }, requestId);
    if (!value) throw new CoreError("NOT_AVAILABLE", "The exact Original reply/confirmed manual-retry chain is unavailable.");
    return value as Json;
  };
  const publishTaskReference = async (requestId: string, contextId: string) => {
    const original = linkedTask(requestId, contextId), projected = attempts(requestId, contextId);
    const latest = database.prepare(`SELECT a.*,t.revision,t.goal FROM managed_chat_task_attempts a
      JOIN managed_chat_tasks t ON t.task_id=a.task_id WHERE a.attempt_id=? AND t.status!='cancelled'`)
      .get(projected.latestAttempt.attemptId);
    if (!latest) return;
    await nativePortal({ phase: "task-reference", contextId, pairId: original.link.pairId, revision: Number(latest.revision),
      detail: { reference: { requestId, contextId, pairId: original.link.pairId, chatId: original.row.chat_id,
        taskId: original.row.task_id, replyId: latest.reply_id, originalReplyId: original.row.reply_id,
        inputId: original.row.input_id, nativeRequestId: latest.request_id, revision: Number(latest.revision),
        goalSha256: originalNativeChatDigest(JSON.parse(String(latest.goal))), sourcePlanSha256: original.row.source_plan_sha256,
        epoch: native.receipt.epoch, status: projected.latestAttempt.status } } });
  };
  const atomic = <T>(work: () => T) => {
    current(); database.exec("BEGIN IMMEDIATE");
    try { const value = work(); current(); database.exec("COMMIT"); return value; }
    catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
  };
  atomic(() => {
    database.exec(originalApiChatRequestDdl);
    database.prepare(`UPDATE original_api_chat_request_state SET status='outcome_unknown',result=NULL,error='Portal Host ended; never replay.'
      WHERE request_id IN (SELECT request_id FROM original_api_chat_requests WHERE operation='portal')
      AND status IN ('queued','running')`).run();
  });
  const nativeAbort = () => { lifetime.abort(); void closeRuntime().catch(() => {}); };
  native.signal.addEventListener("abort", nativeAbort, { once: true });
  const business = new OriginalPortalBusiness({
    root, assertCurrent: current,
    async savedEndpoints() {
      current();
      const request = { phase: "endpoints", contextId: "", pairId: "", revision: 0, detail: {} };
      const requestSha256 = originalMcpRequestDigest(request);
      const value = originalPortalNativeDecision.parse(await requestOriginalMcpNative(session, originalPortalNativeMethod,
        { binding, request, requestSha256 }, { signal: lifetime.signal, timeoutMs: 120000 }));
      current();
      if (!value || value.decision !== "approve" || value.requestSha256 !== requestSha256
        || value.epoch !== native.receipt.epoch || value.expiresAtMs <= Date.now())
        throw new CoreError("ACCESS_DENIED", "Current native saved endpoint inventory is unavailable.");
      return value.endpoints ?? [];
    },
    commandCapabilities: [`platform:${process.platform}`, ...["bash", "sh", "pwsh", "cmd", "powershell"].flatMap(program => {
      try { executable(program); return [`program:${program}`]; } catch { return []; }
    })],
    async consent(request, signal) {
      current();
      const requestSha256 = originalMcpRequestDigest(request);
      const value = originalPortalNativeDecision.parse(await requestOriginalMcpNative(session, originalPortalNativeMethod,
        { binding, request, requestSha256 }, { signal: signal ?? lifetime.signal, timeoutMs: 120000 }));
      current();
      if (!value || value.requestSha256 !== requestSha256 || value.epoch !== native.receipt.epoch
        || value.expiresAtMs <= Date.now() || value.expiresAtMs > Date.now() + 120000)
        throw new CoreError("ACCESS_DENIED", "Portal consent is absent, expired or belongs to another context.");
      return value;
    },
    async executeCommand(command, signal, requestId, contextId) {
      current();
      const path = executable(command.program), cwd = command.cwd ?? root, adapterId = `portal:${hash(JSON.stringify([path, cwd])).slice(0, 32)}`;
      if (!isAbsolute(cwd) || realpathSync(cwd) !== cwd) throw new CoreError("INVALID_ARGUMENT", "Use an existing canonical executing-Host directory.");
      const argumentValues = [...command.arguments];
      processAdapters.set(adapterId, { id: adapterId, executable: path, cwd, env: {},
        processScope: "linux-process-group",
        arguments: input => {
          const value = input as Json;
          if (JSON.stringify(value.arguments) !== JSON.stringify(argumentValues)) throw new Error("PORTAL_COMMAND_CHANGED");
          return argumentValues;
        }, assertCurrent: current,
        openLaunch: () => {
          current();
          const executable = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const directory = openSync(cwd, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
            return { executable, cwd: directory };
          } catch (error) { closeSync(executable); throw error; }
        } });
      processService ??= new RuntimeProcessService({
        repositoryFactory: (ownerId, capacity) => new RuntimeProcessStore(processDatabase, ownerId, capacity),
        adapters: [],
        originalPortalCommand: { assertCurrent: current },
        limits: { deadlineMs: 86400000 },
        resolveAdapter: id => processAdapters.get(id),
        authorizeLaunch: async () => { current(); return !signal.aborted; },
      });
      const operationId = requestId, processActor = `portal:${contextId}`;
      const job = await processService.launch({ actorId: processActor, operationId, adapterId,
        input: { arguments: argumentValues }, deadlineMs: command.timeoutSeconds * 1000 });
      const cancel = () => { void processService!.cancel(processActor, job.jobId).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const output = await processService.wait(processActor, job.jobId);
        current();
        return { execution: "direct-command", modelCalls: 0, handle: job.jobId,
          state: output.state === "SUCCEEDED" ? "complete" : output.state === "CANCELLED" ? "cancelled"
            : output.effect === "unknown" ? "unknown" : "failed",
          exitCode: output.exitCode, exitSignal: output.signal, stdout: Buffer.from(output.stdout, "base64").toString("utf8"),
          stderr: Buffer.from(output.stderr, "base64").toString("utf8"), stdoutBytes: output.stdoutBytes, stderrBytes: output.stderrBytes,
          truncated: !!output.stdoutDroppedBytes || !!output.stderrDroppedBytes };
      } finally { signal.removeEventListener("abort", cancel); }
    },
    async executeTask(input, signal) {
      current();
      if (taskContexts.size >= 128) taskContexts.delete(taskContexts.keys().next().value!);
      taskContexts.set(input.requestId, input);
      if (!database.prepare(`SELECT 1 FROM original_api_chat_current_chats m JOIN chat_sessions c ON c.id=m.id
        WHERE m.id=? AND c.actor_id=?`).get(input.chatId, actor.id))
        throw new CoreError("NATIVE_TASK_ADOPTION_REQUIRED", "Select an existing current native-created or independently adopted Chat before Portal execution. No archived Goal is implicitly inherited.");
      chat ??= options.apiChat?.() ?? createOriginalMcpApiChatRuntime(owner, actor, native);
      const api = await chat;
      input.assertCurrent();
      const previous = database.prepare(`SELECT t.task_id,t.revision,t.current_attempt_id,t.goal
        FROM managed_chat_tasks t WHERE t.actor_id=? AND t.chat_id=? AND t.status!='cancelled'`).get(actor.id, input.chatId);
      const replacement = previous ? { taskId: String(previous.task_id), revision: Number(previous.revision),
        attemptId: String(previous.current_attempt_id), goalSha256: originalNativeChatDigest(JSON.parse(String(previous.goal))) } : undefined;
      if (replacement) await input.approveTransition({ ...replacement, chatId: input.chatId,
        action: "Retire only this reconciled previous Task binding and start an explicitly NEW Task. Preserve old goal, inputs and receipts; never replay UNKNOWN effects." });
      input.assertCurrent();
      const commandId = `portal-task:${input.requestId}`, nativeRequestId = hash(pythonMetadataJson([hostId, commandId]));
      const release = registerOriginalPortalTaskFilter(native, nativeRequestId, {
        assertCurrent: input.assertCurrent, authorizeTool: input.authorizeTool, replacement,
        origin: { requestId: input.requestId, contextId: input.contextId, pairId: input.pairId },
      });
      try {
      const submitted = await api.invoke("api_chat_send", { host_id: hostId, chat_id: input.chatId,
        prompt: `Start a new task: ${input.prompt}`, command_id: commandId }, signal);
      const id = (submitted.structuredContent as Json).request_id;
      while (true) {
        current();
        if (signal.aborted) {
          await api.invoke("api_chat_cancel", { host_id: hostId, chat_id: input.chatId,
            command_id: `portal-cancel:${input.requestId}` });
          throw new CoreError("CANCELLED", "Portal Task cancellation requested; inspect its original receipt.");
        }
        const receipt = (await api.invoke("api_chat_request_get", { host_id: hostId, request_id: id })).structuredContent as Json;
        if (!["queued", "running"].includes(receipt.status)) {
          if (receipt.status !== "succeeded") {
            try { await publishTaskReference(input.requestId, input.contextId); }
            catch (error) {
              if (!(error instanceof CoreError) || error.code !== "NOT_AVAILABLE") throw error;
            }
            throw new CoreError("NATIVE_TASK_FAILED",
              `Inspect the original native Task receipt; no task is replayed.${typeof receipt.error === "string" ? ` ${receipt.error}` : ""}`,
              receipt.status === "outcome_unknown" ? "unknown" : "not-committed");
          }
          await publishTaskReference(input.requestId, input.contextId);
          const original = linkedTask(input.requestId, input.contextId);
          const row = database.prepare("SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND id=?")
            .get(actor.id, input.chatId, original.row.reply_id);
          const reply = row && JSON.parse(String(row.record));
          if (!reply || reply.status !== "complete") throw new CoreError("NATIVE_TASK_FAILED", "The original native reply did not complete; inspect its recorded status.", "unknown");
          const content = String(reply.content);
          const mapping = database.prepare("SELECT namespace FROM original_api_chat_current_chats WHERE id=?").get(input.chatId);
          return { chatId: input.chatId, chatUrl: `pkm://chats/${mapping!.namespace}/${input.chatId}`,
            requestId: input.requestId, replyId: original.row.reply_id, attemptId: original.row.attempt_id,
            inputId: original.row.input_id, content: content.slice(0, 12000), truncated: content.length > 12000 };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      } finally { release(); }
    },
    async taskAttempts(requestId, contextId) {
      current(); taskContexts.get(requestId)?.assertCurrent();
      return attempts(requestId, contextId);
    },
    destination: () => root,
  });
  let checkingManual = false;
  const manualTimer = setInterval(() => {
    if (checkingManual || lifetime.signal.aborted || closed) return;
    checkingManual = true;
    const operation = (async () => {
      const decision = await nativePortal({ phase: "manual-intents", contextId: "", pairId: "", revision: 0, detail: {} });
      for (const intent of decision.manualIntents ?? []) {
        let manualReceipt: Json = { status: "failed", error: "The exact current Task/source/manual intent could not be admitted." };
        try {
        const input = taskContexts.get(intent.requestId);
        if (!input || intent.epoch !== native.receipt.epoch || intent.expiresAtMs <= Date.now()
          || intent.expiresAtMs > Date.now() + 120000) throw new CoreError("ACCESS_DENIED", "The current manual intent expired or changed.");
        input.assertCurrent();
        const original = linkedTask(intent.requestId, intent.contextId);
        const previous = database.prepare(`SELECT a.*,t.revision,t.goal,t.status FROM managed_chat_task_attempts a
          JOIN managed_chat_tasks t ON t.task_id=a.task_id WHERE t.task_id=? AND a.attempt_id=t.current_attempt_id`)
          .get(intent.taskId);
        if (!previous || previous.status === "cancelled" || previous.request_id !== intent.nativeRequestId
          || previous.reply_id !== intent.replyId || previous.revision !== intent.revision
          || original.row.reply_id !== intent.originalReplyId || original.row.input_id !== intent.inputId
          || originalNativeChatDigest(JSON.parse(String(previous.goal))) !== intent.goalSha256)
          throw new CoreError("ACCESS_DENIED", "The reviewed manual Task/reply/revision changed.");
        const commandId = `portal-manual:${intent.commandId}`, requestId = hash(pythonMetadataJson([hostId, commandId]));
        const release = registerOriginalPortalTaskFilter(native, requestId, { assertCurrent: input.assertCurrent,
          authorizeTool: input.authorizeTool, manualOrigin: { requestId: intent.requestId, contextId: intent.contextId,
            pairId: intent.pairId, originalReplyId: intent.originalReplyId, originalInputId: intent.inputId,
            retryOfReplyId: intent.replyId, retryOfAttemptId: String(previous.attempt_id), nativeRequestId: intent.nativeRequestId,
            revision: intent.revision, goalSha256: intent.goalSha256, shareConfirmed: true } });
        try {
          chat ??= options.apiChat?.() ?? createOriginalMcpApiChatRuntime(owner, actor, native);
          const api = await chat, signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(intent.expiresAtMs - Date.now())]);
          const submitted = await api.invoke("api_chat_send", { host_id: hostId, chat_id: intent.chatId,
            prompt: "Resume the original objective and repeat its acceptance check with fresh evidence.", command_id: commandId }, signal);
          const id = (submitted.structuredContent as Json).request_id;
          while (!signal.aborted) {
            const receipt = (await api.invoke("api_chat_request_get", { host_id: hostId, request_id: id })).structuredContent as Json;
            if (!["queued", "running"].includes(receipt.status)) { manualReceipt = receipt; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (signal.aborted) {
            await api.invoke("api_chat_cancel", { host_id: hostId, chat_id: intent.chatId, command_id: `portal-manual-cancel:${intent.commandId}` });
            manualReceipt = { status: "outcome_unknown", request_id: id, error: "Manual deadline/cancellation requested; inspect the durable native receipt." };
          }
          await publishTaskReference(intent.requestId, intent.contextId);
        } finally { release(); }
        } catch (error) {
          manualReceipt = { status: error instanceof CoreError && error.effect === "unknown" ? "outcome_unknown" : "failed",
            error: error instanceof Error ? error.message.slice(0, 2000) : "Manual attempt failed; inspect its receipt." };
        } finally {
          await nativePortal({ phase: "manual-result", contextId: intent.contextId, pairId: intent.pairId, revision: intent.revision,
            detail: { commandId: intent.commandId, status: manualReceipt.status,
              receiptId: manualReceipt.request_id ?? "", error: String(manualReceipt.error ?? "").slice(0, 2000) } });
        }
      }
    })();
    pending.add(operation); void operation.catch(() => {}).finally(() => { pending.delete(operation); checkingManual = false; });
  }, 500);
  manualTimer.unref();
  const readReceipt = (requestId: string): Json | undefined => {
    current();
    const row = database.prepare(`SELECT r.host_id,s.status,s.epoch,s.error FROM original_api_chat_requests r
      JOIN original_api_chat_request_state s USING(request_id) WHERE r.request_id=? AND r.operation='portal'`).get(requestId);
    if (!row) return;
    const status = row.epoch !== native.receipt.epoch || row.status === "succeeded" && !liveResults.has(requestId)
      ? "outcome_unknown" : row.status;
    return { ok: true, host_id: hostId, request_id: requestId, status,
      result: row.epoch === native.receipt.epoch ? liveResults.get(requestId) ?? null : null, error: row.error ?? null,
      next_action: status === "outcome_unknown" ? "Inspect the existing receipt; never automatically replay an uncertain request."
        : ["queued", "running"].includes(String(status)) ? "Call api_chat_request_get for this request_id." : null };
  };
  function closeRuntime(): Promise<void> {
    return closing ??= (async () => {
      native.signal.removeEventListener("abort", nativeAbort);
      clearInterval(manualTimer);
      lifetime.abort(); await business.close(); await processService?.close();
      await Promise.allSettled([...pending]); if (!options.apiChat) await (await chat)?.close();
      closed = true; database.close(); processDatabase.close(); liveResults.clear();
      taskContexts.clear();
    })();
  }
  owner.retainResource({ closeAdmission() { lifetime.abort(); }, release: closeRuntime });
  return {
    readReceipt,
    async invoke(tool: string, raw: Json, signal?: AbortSignal): Promise<CallToolResult> {
      current();
      if (tool !== "portal_control") throw new CoreError("INVALID_ARGUMENT", "Use the exact Portal public contract.");
      const request = { operation: "mcp.tool.portal_control", version: 1 as const, tool, readOnly: false,
        arguments: raw, argumentsDigest: originalMcpRequestDigest(raw) };
      if (!originalMcpPublicRequestMatches(storage, native, request))
        return withOriginalMcpPublicRequest(storage, native, request, () => this.invoke(tool, raw, signal), signal);
      if (!actor.canWrite) throw new CoreError("ACCESS_DENIED", "Portal public requests require the write/control channel.");
      const input = originalPortalInput.parse(raw);
      if (input.host_id !== hostId) throw new CoreError("ACCESS_DENIED", "Select this exact current native Host.");
      const requestId = hash(pythonMetadataJson([hostId, input.command_id]).replace(/[\u007f-\uffff]/g,
        value => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`));
      const arguments_ = { operation: input.operation, contextId: input.context_id, prompt: input.prompt, requestId: input.request_id,
        ...(input.file_paths ? { paths: input.file_paths } : {}), ...(raw.command ? { command: raw.command } : {}),
        ...(raw.requirements ? { requirements: raw.requirements } : {}) };
      const payload = hash(pythonMetadataJson({ operation: "portal", arguments: arguments_, commandId: input.command_id }, true));
      const exists = atomic(() => {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='original_api_chat_source_controls' AND type='table'").get()
          && database.prepare("SELECT 1 FROM original_api_chat_source_controls WHERE host_id=? AND request_id=?").get(hostId, requestId))
          throw new CoreError("CONFLICT", "An archived request owns this command identity; never replay it through a new Portal.");
        const prior = database.prepare("SELECT payload_sha256 FROM original_api_chat_requests WHERE request_id=?").get(requestId);
        if (prior) {
          if (prior.payload_sha256 !== payload) throw new CoreError("CONFLICT", "command_id belongs to another exact request; no operation was repeated.");
          return true;
        }
        if (pending.size >= 32) throw new CoreError("BUSY", "Portal public request queue is full.");
        database.prepare("INSERT INTO original_api_chat_requests VALUES(?,?,?,?,?,?,?)")
          .run(requestId, hostId, input.command_id, "portal", "{}", payload, Date.now());
        database.prepare("INSERT INTO original_api_chat_request_state VALUES(?,?,NULL,NULL,?)")
          .run(requestId, "queued", native.receipt.epoch);
        return false;
      });
      if (!exists) {
        const operation = (async () => {
          try {
            atomic(() => database.prepare("UPDATE original_api_chat_request_state SET status='running' WHERE request_id=?").run(requestId));
            const value = await business.invoke(input, lifetime.signal);
            nonSecret(value);
            atomic(() => database.prepare("UPDATE original_api_chat_request_state SET status='succeeded' WHERE request_id=?").run(requestId));
            liveResults.set(requestId, value);
          } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 512) : "Portal request did not settle.";
            const status = native.signal.aborted || lifetime.signal.aborted || error instanceof CoreError && error.effect === "unknown"
              ? "outcome_unknown" : "failed";
            storage.assertWorkspaceLease();
            database.prepare("UPDATE original_api_chat_request_state SET status=?,error=? WHERE request_id=?")
              .run(status, message, requestId);
          }
        })();
        pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {});
      }
      return result(readReceipt(requestId)!);
    },
    close: closeRuntime,
  };
}
