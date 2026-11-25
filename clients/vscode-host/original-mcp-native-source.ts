import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import {
  originalNativeSourceMethods, originalNativeSourceSessionSchema, originalNativeSourceResultSchemas,
  parseOriginalNativeSourcePayload, assertOriginalNativeSourcePacketBudget, originalNativeSourceRequestDigest,
  type OriginalNativeSourceMethod, type OriginalNativeSourceSession, type OriginalNativeSourceDomain,
} from "../../src/original-mcp-native-source-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const approveLabel = "Admit this exact source only";

/** Installed UI produces source-only decisions. Identity/model/public approval never enables these grants. */
export async function createOriginalMcpNativeSourceProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeSourceSession;
  signal: AbortSignal;
  assertCurrent(): void;
  /** Until signed granular revoke notifications exist, UI revocation must close the actual attachment. */
  close(): Promise<void>;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = freeze(originalNativeSourceSessionSchema.parse(structuredClone(options.session)));
  const lifetime = new AbortController(), retired = new Set<string>(), pending = new Set<OriginalNativeSourceDomain>();
  const bars = new Map<OriginalNativeSourceDomain, vscode.StatusBarItem>();
  const expiries = new Map<OriginalNativeSourceDomain, ReturnType<typeof setTimeout>>();
  const commands: vscode.Disposable[] = [];
  let terminal = false, closing: Promise<void> | undefined;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (terminal || options.signal.aborted || signer.signal.aborted || signal?.aborted) fail("NATIVE_SOURCE_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("NATIVE_SOURCE_BINDING_MISMATCH");
  }
  function removeBar(domain: OriginalNativeSourceDomain) {
    clearTimeout(expiries.get(domain)); expiries.delete(domain);
    bars.get(domain)?.dispose(); bars.delete(domain);
  }
  function retire() {
    if (terminal) return;
    terminal = true; lifetime.abort();
    for (const domain of ["todo", "memory", "chat"] as const) removeBar(domain);
    commands.forEach(command => command.dispose());
    workspaceChange.dispose();
    options.signal.removeEventListener("abort", dispose); signer.signal.removeEventListener("abort", dispose);
  }
  function revoke() {
    retire();
    return closing ??= Promise.resolve().then(() => options.close());
  }
  function dispose() {
    void revoke().catch(() => vscode.window.showErrorMessage(
      "PKM native source revocation could not confirm attachment shutdown. Disconnect the native session; no new source consent was granted."));
  }
  const workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(dispose);
  current();
  options.signal.addEventListener("abort", dispose, { once: true }); signer.signal.addEventListener("abort", dispose, { once: true });
  for (const domain of ["todo", "memory", "chat"] as const) {
    const name = `personalKnowledge.revokeNativeSource.${domain}.${session.activationId}.${session.brokerId}`;
    commands.push(vscode.commands.registerCommand(name, revoke));
  }
  context.subscriptions.push({ dispose });
  async function handle(method: OriginalNativeSourceMethod, value: unknown, requestId: string, signal: AbortSignal) {
    current(signal);
    const payload = freeze(parseOriginalNativeSourcePayload(method, structuredClone(value), session));
    originalNativeSourceSessionSchema.shape.activationId.parse(requestId);
    assertOriginalNativeSourcePacketBudget(method, payload, session, requestId);
    if (retired.has(requestId)) fail("NATIVE_SOURCE_REQUEST_REPLAY");
    if (retired.size >= 4096) fail("NATIVE_SOURCE_REQUEST_LEDGER_FULL");
    const domain = method.split(".")[0] as OriginalNativeSourceDomain;
    if (pending.has(domain)) fail("NATIVE_SOURCE_BUSY");
    retired.add(requestId); pending.add(domain); removeBar(domain);
    try {
      const combined = AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]);
      const work = vscode.window.showWarningMessage(
        `Admit this exact original ${domain === "chat" ? "API Chat" : domain === "todo" ? "Todo" : "Memory"} source?`,
        { modal: true, detail: JSON.stringify({
          session, request: payload.request, requestSha256: originalNativeSourceRequestDigest(payload),
          noExecution: true,
          permission: "Only the selected source's native custody/projection and actor continuity are admitted for five minutes. No old worker, Engine, queued execution, model, tool, Action, or other source grant is inherited. Revoking any source closes this signed native session and all its grants.",
        }, null, 2) }, approveLabel, "Deny");
      const answer = await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("NATIVE_SOURCE_CANCELLED"), { code: "NATIVE_SOURCE_CANCELLED" }));
        combined.addEventListener("abort", abort, { once: true });
        Promise.resolve(work).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
        if (combined.aborted) abort();
      });
      current(signal);
      if (combined.aborted) fail("NATIVE_SOURCE_CANCELLED");
      if (answer !== approveLabel) return null;
      const decision = freeze(originalNativeSourceResultSchemas[method].parse({
        actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 300000,
      }));
      if (!decision) fail("NATIVE_SOURCE_DECISION_INVALID");
      const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
      bar.text = `$(shield) PKM ${domain} source`;
      bar.tooltip = `Exact source-only consent for ${session.binding.root}\nProfile ${session.binding.profileSha256}\nExpires ${new Date(decision.expiresAtMs).toISOString()}\nRevocation closes the full signed session.`;
      bar.command = `personalKnowledge.revokeNativeSource.${domain}.${session.activationId}.${session.brokerId}`;
      bars.set(domain, bar); bar.show();
      const expiry = setTimeout(() => { if (bars.get(domain) === bar) removeBar(domain); }, decision.expiresAtMs - Date.now());
      expiry.unref(); expiries.set(domain, expiry);
      return decision;
    } finally { pending.delete(domain); }
  }
  return Object.freeze({ methods: originalNativeSourceMethods, signal: lifetime.signal, handle, revoke, dispose });
}
