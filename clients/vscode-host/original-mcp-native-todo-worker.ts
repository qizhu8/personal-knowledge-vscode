import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import {
  originalNativeTodoWorkerMethods, originalNativeTodoWorkerSessionSchema, originalNativeTodoWorkerDigest,
  parseOriginalNativeTodoWorkerPayload, parseOriginalNativeTodoWorkerDecision,
  type OriginalNativeTodoWorkerMethod, type OriginalNativeTodoWorkerSession,
} from "../../src/original-mcp-native-todo-worker-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const approveLabel = "Enroll this exact Board worker";

/** Separate owner consent, never a global public/model/source approval or a restored worker token. */
export async function createOriginalMcpNativeTodoWorkerProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeTodoWorkerSession; signal: AbortSignal; assertCurrent(): void; close(): Promise<void>;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = freeze(originalNativeTodoWorkerSessionSchema.parse(structuredClone(options.session)));
  const lifetime = new AbortController(), retired = new Set<string>();
  const bars = new Map<string, { bar: vscode.StatusBarItem; expiry: ReturnType<typeof setTimeout>; sessionDecisionId: string }>();
  let terminal = false, pending = false, closing: Promise<void> | undefined;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (terminal || options.signal.aborted || signer.signal.aborted || signal?.aborted) fail("NATIVE_TODO_WORKER_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("NATIVE_TODO_WORKER_BINDING_MISMATCH");
  }
  const commandName = `personalKnowledge.revokeNativeTodoWorkers.${session.activationId}.${session.brokerId}`;
  function remove(key: string) {
    const item = bars.get(key);
    if (item) { clearTimeout(item.expiry); item.bar.dispose(); bars.delete(key); }
  }
  function retire() {
    if (terminal) return;
    terminal = true; lifetime.abort();
    for (const key of bars.keys()) remove(key);
    command.dispose(); workspaceChange.dispose();
    options.signal.removeEventListener("abort", dispose); signer.signal.removeEventListener("abort", dispose);
  }
  function revoke() {
    retire();
    return closing ??= Promise.resolve().then(() => options.close());
  }
  function dispose() {
    void revoke().catch(() => vscode.window.showErrorMessage(
      "PKM worker revocation could not confirm signed attachment shutdown. Disconnect the native session; no new worker was enrolled."));
  }
  current();
  const command = vscode.commands.registerCommand(commandName, revoke);
  const workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(dispose);
  options.signal.addEventListener("abort", dispose, { once: true });
  signer.signal.addEventListener("abort", dispose, { once: true });
  context.subscriptions.push({ dispose });
  return Object.freeze({
    methods: originalNativeTodoWorkerMethods, signal: lifetime.signal, revoke, dispose,
    async handle(method: OriginalNativeTodoWorkerMethod, input: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      originalNativeTodoWorkerSessionSchema.shape.activationId.parse(requestId);
      const payload = freeze(parseOriginalNativeTodoWorkerPayload(method, structuredClone(input), session));
      if (retired.has(requestId)) fail("NATIVE_TODO_WORKER_REQUEST_REPLAY");
      if (retired.size >= 4096 || bars.size >= 128) fail("NATIVE_TODO_WORKER_LIMIT");
      if (pending) fail("NATIVE_TODO_WORKER_BUSY");
      const key = `${payload.request.boardSlug}\0${payload.request.actorId}`;
      if (bars.get(key)?.sessionDecisionId !== payload.sessionDecisionId) remove(key);
      if (bars.has(key)) fail("NATIVE_TODO_WORKER_REPLACEMENT_REQUIRES_REVOCATION");
      retired.add(requestId); pending = true;
      try {
        const combined = AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]);
        const work = vscode.window.showWarningMessage("Enroll a fresh worker for this exact original Todo Board?",
          { modal: true, detail: JSON.stringify({
            session, request: payload.request, custodyPlanSha256: payload.custodyPlanSha256,
            profileSha256: payload.profileSha256, epoch: payload.epoch, sourceSha256: payload.sourceSha256,
            sessionDecisionId: payload.sessionDecisionId, sessionExpiresAtMs: payload.sessionExpiresAtMs,
            requestSha256: originalNativeTodoWorkerDigest(payload), noExecution: true, noLegacyTokenInheritance: true,
            permission: "Issue only a new worker token for this exact Board and external actor under current Todo source consent. Board-agent management permissions follow the existing Core contract; original Chat ownership, source/Chat/model/Action grants and acceptance-review delegation are not granted. No task, prompt or queue starts. Never reuse an old token. Revoking closes this signed attachment and all its grants; current Core has no independent per-worker revocation channel.",
          }, null, 2) }, approveLabel, "Deny");
        const answer = await new Promise<string | undefined>((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("NATIVE_TODO_WORKER_CANCELLED"), { code: "NATIVE_TODO_WORKER_CANCELLED" }));
          combined.addEventListener("abort", abort, { once: true });
          Promise.resolve(work).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
          if (combined.aborted) abort();
        });
        current(signal);
        if (combined.aborted) fail("NATIVE_TODO_WORKER_CANCELLED");
        if (answer !== approveLabel) return null;
        const expiresAtMs = Math.min(Date.now() + 300_000, payload.sessionExpiresAtMs);
        const decision = freeze(parseOriginalNativeTodoWorkerDecision({
          schema: "pkm.original-mcp-native-todo-worker-decision/v1", actorId: payload.request.actorId,
          decisionId: randomUUID(), expiresAtMs, requestSha256: originalNativeTodoWorkerDigest(payload),
          epoch: payload.epoch, sessionDecisionId: payload.sessionDecisionId,
        }, payload));
        if (!decision) fail("NATIVE_TODO_WORKER_DECISION_REQUIRED");
        const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
        bar.text = "$(shield) PKM Board worker";
        bar.tooltip = `${payload.request.actorId}\nBoard ${payload.request.boardSlug}\nRoot ${session.binding.root}\nExpires ${new Date(expiresAtMs).toISOString()}\nClick to revoke the signed session and all its grants.`;
        bar.command = commandName;
        const expiry = setTimeout(() => remove(key), expiresAtMs - Date.now()); expiry.unref();
        bars.set(key, { bar, expiry, sessionDecisionId: payload.sessionDecisionId }); bar.show();
        return decision;
      } finally { pending = false; }
    },
  });
}
