import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalNativeSourceSessionSchema, type OriginalNativeSourceSession } from "../../src/original-mcp-native-source-contracts.js";
import { originalTodoRoleMethods, originalTodoRoleDigest, parseOriginalTodoRolePayload,
  parseOriginalTodoRoleDecision, type OriginalTodoRoleMethod } from "../../src/original-mcp-todo-role-contracts.js";

function fail(): never { throw Object.assign(new Error("NATIVE_TODO_ROLE_CANCELLED"), { code: "NATIVE_TODO_ROLE_CANCELLED" }); }
export async function createOriginalMcpNativeTodoRoleProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeSourceSession; signal: AbortSignal; assertCurrent(): void; close(): Promise<void>;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = originalNativeSourceSessionSchema.parse(structuredClone(options.session));
  const lifetime = new AbortController(), retired = new Set<string>();
  let pending = false, closed = false;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (closed || options.signal.aborted || signer.signal.aborted || lifetime.signal.aborted || signal?.aborted
      || !vscode.workspace.isTrusted || session.activationId !== signer.activationId
      || session.epoch !== signer.activationId || session.identitySha256 !== signer.identity.sha256
      || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256) fail();
  }
  async function wait<T>(work: Thenable<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("NATIVE_TODO_ROLE_CANCELLED"), { code: "NATIVE_TODO_ROLE_CANCELLED" }));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  const commandName = `personalKnowledge.revokeNativeTodoRoles.${session.activationId}.${session.brokerId}`;
  const bars = new Set<vscode.StatusBarItem>();
  function dispose() {
    if (closed) return;
    closed = true; lifetime.abort();
    bars.forEach(bar => bar.dispose()); bars.clear(); command.dispose(); workspace.dispose();
    signer.signal.removeEventListener("abort", dispose); options.signal.removeEventListener("abort", dispose);
  }
  const revoke = async () => { dispose(); await options.close(); };
  const command = vscode.commands.registerCommand(commandName, revoke);
  const workspace = vscode.workspace.onDidChangeWorkspaceFolders(() => { void revoke(); });
  signer.signal.addEventListener("abort", dispose, { once: true });
  options.signal.addEventListener("abort", dispose, { once: true });
  context.subscriptions.push({ dispose });
  current();
  return Object.freeze({
    methods: originalTodoRoleMethods, signal: lifetime.signal, revoke, dispose,
    async handle(method: OriginalTodoRoleMethod, input: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      if (retired.has(requestId) || pending || retired.size >= 4096) fail();
      const payload = parseOriginalTodoRolePayload(method, structuredClone(input), session);
      retired.add(requestId); pending = true;
      const combined = AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]);
      try {
        const role = method === "todo.role.approve";
        const label = role ? "Grant this exact Todo role" : "Accept this exact reviewed workitem";
        const answer = await wait(vscode.window.showWarningMessage(role
          ? "Run this exact timed Chat role for this Todo workitem?"
          : "Accept this exact completed workitem as the human?",
        { modal: true, detail: JSON.stringify({
          ...payload.request, requestSha256: originalTodoRoleDigest(payload), defaultDecision: "deny",
          permission: role
            ? "One exact current Chat, Board and workitem. Worker: read, claim, submit actual current-model-read evidence. Reviewer: read and recommendation comment only. No reviewerIds delegation, acceptance, user actions, other Chat, private resource, file, scheduler or public-target authority. External worker noExecution grants remain unchanged. Each inference/tool retains its independent native approval."
            : "One exact acceptance as user:local after the actual worker result and reviewer recommendation. Role/task approval is not this human decision. Deny/cancel leaves acceptance unset. A reviewer comment is not approval; Original has only one acceptanceDecision.",
        }, null, 2) }, "Deny", label), combined);
        current(combined);
        if (answer !== label) return null;
        const expiresAtMs = Math.min(payload.request.expiresAtMs, Date.now() + (role ? 300_000 : 120_000));
        const common = { actorId: payload.request.actorId, decisionId: randomUUID(),
          requestSha256: originalTodoRoleDigest(payload), epoch: session.epoch, expiresAtMs };
        let result: unknown;
        if (role) {
          result = { schema: "pkm.original-native-todo-role-decision/v1", ...common };
        } else {
          const reason = await wait(vscode.window.showInputBox({
            title: "Human acceptance reason", prompt: "Explain why you accept this exact reviewed workitem.",
            ignoreFocusOut: true, validateInput: value => value.trim() && value.trim().length <= 8000 ? undefined : "A nonempty reason of at most 8000 characters is required.",
          }), combined);
          current(combined);
          if (!reason?.trim()) return null;
          result = { schema: "pkm.original-native-todo-human-decision/v1", ...common, reason: reason.trim() };
        }
        current(combined);
        const decision = parseOriginalTodoRoleDecision(method, result, payload);
        if (role) {
          const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 87);
          bar.text = "$(shield) PKM Todo role";
          bar.tooltip = `${payload.request.actorId}\n${payload.request.boardSlug}/${payload.request.workItemId}\nRoot ${session.binding.root}\nExpires ${new Date(expiresAtMs).toISOString()}\nClick to close the signed attachment and revoke all its grants.`;
          bar.command = commandName; bars.add(bar); bar.show();
          const timer = setTimeout(() => { bars.delete(bar); bar.dispose(); }, Math.max(1, expiresAtMs - Date.now()));
          timer.unref();
        }
        return decision;
      } finally { pending = false; }
    },
  });
}
