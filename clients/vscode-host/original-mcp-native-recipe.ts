import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import {
  originalNativeRecipeMethods, originalNativeRecipeSessionSchema, originalNativeRecipeResultSchemas,
  parseOriginalNativeRecipePayload, assertOriginalNativeRecipePacketBudget, originalNativeRecipeDigest,
  type OriginalNativeRecipeMethod, type OriginalNativeRecipeSession,
} from "../../src/original-mcp-native-recipe-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const approveLabel = "Admit this exact Recipe source only";

/** Installed source consent only. A UI choice never imports Recipe execution, Core or old permissions. */
export async function createOriginalMcpNativeRecipeProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeRecipeSession; signal: AbortSignal; assertCurrent(): void;
  /** Revocation must close the actual signed attachment, not merely clear a status indicator. */
  close(): Promise<void>;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = freeze(originalNativeRecipeSessionSchema.parse(structuredClone(options.session)));
  const lifetime = new AbortController(), retired = new Set<string>();
  const commandName = `personalKnowledge.revokeNativeSource.recipe.${session.activationId}.${session.brokerId}`;
  let pending = false, terminal = false, closing: Promise<void> | undefined, bar: vscode.StatusBarItem | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let admitted: { request: unknown; expiresAtMs: number } | undefined;
  let admissionExpiry: ReturnType<typeof setTimeout> | undefined;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (terminal || options.signal.aborted || signer.signal.aborted || signal?.aborted) fail("NATIVE_RECIPE_SOURCE_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("NATIVE_RECIPE_SOURCE_BINDING_MISMATCH");
  }
  function removeBar() { clearTimeout(expiry); expiry = undefined; bar?.dispose(); bar = undefined; }
  function clearAdmission() { clearTimeout(admissionExpiry); admissionExpiry = undefined; admitted = undefined; }
  function retire() {
    if (terminal) return;
    terminal = true; lifetime.abort(); clearAdmission(); removeBar(); command.dispose(); workspaceChange.dispose();
    options.signal.removeEventListener("abort", dispose); signer.signal.removeEventListener("abort", dispose);
  }
  function revoke() {
    retire();
    return closing ??= Promise.resolve().then(() => options.close());
  }
  function dispose() {
    void revoke().catch(() => vscode.window.showErrorMessage(
      "PKM Recipe source revocation could not confirm signed attachment shutdown. Disconnect the native session; no new Recipe source consent was granted."));
  }
  current();
  const command = vscode.commands.registerCommand(commandName, revoke);
  const workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(dispose);
  options.signal.addEventListener("abort", dispose, { once: true }); signer.signal.addEventListener("abort", dispose, { once: true });
  context.subscriptions.push({ dispose });
  async function handle(method: OriginalNativeRecipeMethod, value: unknown, requestId: string, signal: AbortSignal) {
    current(signal);
    const payload = freeze(parseOriginalNativeRecipePayload(method, structuredClone(value), session));
    originalNativeRecipeSessionSchema.shape.activationId.parse(requestId);
    assertOriginalNativeRecipePacketBudget(method, payload, session, requestId);
    if (retired.has(requestId)) fail("NATIVE_RECIPE_SOURCE_REQUEST_REPLAY");
    if (retired.size >= 4096) fail("NATIVE_RECIPE_SOURCE_REQUEST_LEDGER_FULL");
    if (pending) fail("NATIVE_RECIPE_SOURCE_BUSY");
    retired.add(requestId); pending = true;
    const executionSource = payload.request.schema === "pkm.original-recipe-library-source/v1"
      || payload.request.schema === "pkm.original-native-recipe-library-source/v1" && payload.request.purpose === "execute";
    if (executionSource) { clearAdmission(); removeBar(); }
    else if (!admitted) removeBar();
    try {
      const combined = AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]);
      const terminal = payload.request.schema === "pkm.original-recipe-terminal-source/v1";
      const nativeLibrary = payload.request.schema === "pkm.original-native-recipe-library-source/v1";
      const library = payload.request.schema === "pkm.original-recipe-library-source/v1" || nativeLibrary;
      const work = vscode.window.showWarningMessage(library ? "Admit this exact original Recipe library source?"
        : terminal ? "Admit this exact finalized original Recipe run?"
        : "Admit this exact original Recipe usage source?",
        { modal: true, detail: JSON.stringify({
          session, request: payload.request, requestSha256: originalNativeRecipeDigest(payload.request),
          noExecution: true,
          permission: payload.request.schema === "pkm.original-native-recipe-library-source/v1" && payload.request.purpose === "author"
            ? "Create only this exact native Recipe definition and source receipt, with the displayed current Knowledge pins. This definition authoring decision does not run a node or grant any process, model, worker or remote effect. Execution requires an independently reviewed source and a separate exact native approval for every process invocation."
            : payload.request.schema === "pkm.original-native-recipe-library-source/v1" && payload.request.purpose === "read"
            ? "Read only this exact currently witnessed native Recipe metadata and current Knowledge pins. This read decision does not replace an unchanged execution source or authorize any node, process, model, worker or remote effect."
            : library
            ? "Admit only this exact Library revision to the native controlled external-report scheduler. This source decision does not start or claim a run: each original lifecycle request needs its own current public approval. Callers perform work under their own permissions; native code only claims and records their results. No automatic Agent/model/process/script/subflow/worker or Knowledge effect is authorized. Usage and terminal grants enable none of this. Revocation closes this signed session and all cached source grants."
            : terminal
            ? "Read only this exact already-finalized Recipe run's historical results for this root/profile/actor/epoch, for five minutes. No usage grant is inherited and no execution, reconciliation, worker, model, Action or other source permission is granted. Revocation closes this signed session and all cached source grants."
            : "Historical usage accounting for this exact root/profile/actor/epoch only, for five minutes. No Recipe run, worker, model, Action or Todo/Memory/Chat source grant is inherited. Revocation closes this signed native session and all cached source grants.",
        }, null, 2) }, approveLabel, "Deny");
      const answer = await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("NATIVE_RECIPE_SOURCE_CANCELLED"), { code: "NATIVE_RECIPE_SOURCE_CANCELLED" }));
        combined.addEventListener("abort", abort, { once: true });
        Promise.resolve(work).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
        if (combined.aborted) abort();
      });
      current(signal); combined.throwIfAborted();
      if (answer !== approveLabel) return null;
      const decision = freeze(originalNativeRecipeResultSchemas[method].parse({
        actorId: "mcp:external", decisionId: randomUUID(), requestSha256: originalNativeRecipeDigest(payload.request),
        expiresAtMs: Date.now() + 300000,
      }));
      if (!decision) fail("NATIVE_RECIPE_SOURCE_DECISION_INVALID");
      if (executionSource) {
        const granted = freeze({ request: payload.request, expiresAtMs: decision.expiresAtMs }); admitted = granted;
        admissionExpiry = setTimeout(() => { if (admitted === granted) { clearAdmission(); removeBar(); } },
          decision.expiresAtMs - Date.now()); admissionExpiry.unref();
      } else if (admitted) return decision;
      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89); bar = status;
      status.text = "$(shield) PKM Recipe source";
      const selected = payload.request.schema === "pkm.original-recipe-terminal-source/v1"
        ? `Finalized historical run ${payload.request.runId}`
        : payload.request.schema === "pkm.original-recipe-library-source/v1" || payload.request.schema === "pkm.original-native-recipe-library-source/v1"
          ? `Controlled external-report Library ${payload.request.recipeId}@${payload.request.revision}` : "Historical accounting only";
      status.tooltip = `${selected}: ${session.binding.root}\nProfile ${session.binding.profileSha256}\nExpires ${new Date(decision.expiresAtMs).toISOString()}\nRevocation closes the actual signed session.`;
      status.command = commandName; status.show();
      expiry = setTimeout(() => { if (bar === status) removeBar(); }, decision.expiresAtMs - Date.now()); expiry.unref();
      return decision;
    } finally { pending = false; }
  }
  return Object.freeze({ methods: originalNativeRecipeMethods, signal: lifetime.signal, handle, revoke, dispose,
    sourceAdmission() {
      current();
      return admitted && admitted.expiresAtMs > Date.now() ? admitted : undefined;
    } });
}
