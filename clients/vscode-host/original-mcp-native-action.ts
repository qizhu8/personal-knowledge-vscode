import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalDigest } from "../../src/domain/action-compiler-validation.js";
import {
  originalNativeActionMethods, originalNativeActionSession, originalNativeActionSourceDecision,
  originalNativeActionResultSchemas, parseOriginalNativeActionPayload, parseOriginalNativeActionConsent,
  type OriginalNativeActionMethod, type OriginalNativeActionSession, type OriginalNativeActionPayload,
} from "../../src/original-mcp-native-action-contracts.js";
import { originalActionProgramMethod, parseOriginalActionProgramPayload } from "../../src/original-mcp-action-program-contracts.js";
import { createOriginalMcpNativeActionProgramApprover } from "./original-mcp-native-action-program.js";
import { createOriginalMcpNativeActionPackageProducer } from "./original-mcp-native-action-package.js";
import { isNativeActionPackageMethod, type NativeActionPackageMethod } from "../../src/original-mcp-action-package-native-contracts.js";
import { pinRegisteredActionPath, registeredActionPathExists } from "../../src/original-mcp-registered-action-path.js";
import { pinRecipeEffectFile } from "../../src/original-mcp-recipe-effect-files.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type Source = OriginalNativeActionPayload<"action.source.approve">["request"]["sources"][number];

/** Real installed native UI only. A signed attachment is identity, never an Action grant. */
export async function createOriginalMcpNativeActionProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeActionSession;
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  const signer = await originalMcpNativeSigner(context);
  const session = freeze(originalNativeActionSession.parse(structuredClone(options.session)));
  const lifetime = new AbortController(), retired = new Set<string>();
  const authorizations = new Map<string, { contentHash: string; expiresAtMs: number }>();
  let enabled = false, terminal = false, enabling: Promise<boolean> | undefined, capsuleSha256: string | undefined;
  let admitted: { decision: ReturnType<typeof originalNativeActionSourceDecision.parse>; sources: Map<string, Source> } | undefined;
  let status: vscode.StatusBarItem | undefined;
  let packages: ReturnType<typeof createOriginalMcpNativeActionPackageProducer> | undefined;
  const command = `personalKnowledge.revokeNativeActions.${session.activationId}.${session.brokerId}`;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (options.signal.aborted || signal?.aborted) fail("NATIVE_ACTION_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("NATIVE_ACTION_BINDING_MISMATCH");
  }
  function revoke() {
    terminal = true; enabled = false; authorizations.clear(); admitted = undefined; retired.clear();
    packages?.revoke(); lifetime.abort(); status?.dispose(); status = undefined;
  }
  function dispose() {
    revoke();
    options.signal.removeEventListener("abort", revoke); signer.signal.removeEventListener("abort", revoke);
    revokeCommand.dispose(); workspaceChange.dispose();
  }
  async function approve(title: string, detail: object, signal: AbortSignal) {
    current(signal);
    if (terminal) fail("NATIVE_ACTION_REVOKED");
    const combined = AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]);
    const work = vscode.window.showWarningMessage(title, { modal: true, detail: JSON.stringify({
      root: session.binding.root, workspaceId: session.binding.workspaceId,
      profileSha256: session.binding.profileSha256, epoch: session.epoch, ...detail,
    }, null, 2) }, "Approve this exact Action request", "Deny");
    const answer = await new Promise<string | undefined>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("NATIVE_ACTION_CANCELLED"), { code: "NATIVE_ACTION_CANCELLED" }));
      combined.addEventListener("abort", abort, { once: true });
      Promise.resolve(work).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
    current(signal);
    if (terminal || combined.aborted) fail("NATIVE_ACTION_REVOKED");
    return answer === "Approve this exact Action request";
  }
  current();
  const programs = await createOriginalMcpNativeActionProgramApprover(context, {
    session, signal: AbortSignal.any([options.signal, lifetime.signal]),
    assertCurrent: () => current(options.signal), sourceAdmission: () => admitted,
  });
  packages = createOriginalMcpNativeActionPackageProducer({ session, approve,
    assertCurrent(signal) { current(signal); if (terminal || lifetime.signal.aborted) fail("NATIVE_ACTION_REVOKED"); } });
  const revokeCommand = vscode.commands.registerCommand(command, revoke);
  const workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(revoke);
  options.signal.addEventListener("abort", revoke, { once: true });
  signer.signal.addEventListener("abort", revoke, { once: true });
  context.subscriptions.push({ dispose });
  function sameCapsule(value: string) {
    if (capsuleSha256 && capsuleSha256 !== value) fail("NATIVE_ACTION_CAPSULE_CHANGED");
  }
  const denial = () => ({ decision: "deny" as const, trustEpoch: session.epoch });
  const approved = () => ({ decision: "approve" as const, trustEpoch: session.epoch });
  return Object.freeze({
    methods: Object.freeze([...originalNativeActionMethods, ...programs.methods, ...packages.methods]), signal: lifetime.signal,
    async enable() {
      current();
      if (terminal) fail("NATIVE_ACTION_REVOKED");
      if (enabled) return true;
      return enabling ??= (async () => {
        const allowed = await approve("Enable separate native Action approvals for this selected PKM library?", {
          permission: "Enable the approval UI only. Source/state review and each invocation require their own exact decisions. No old worker, policy, model, process or credential grants are inherited.",
        }, options.signal);
        if (allowed) {
          status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
          status.text = "$(shield) PKM Action approvals";
          status.tooltip = `Revoke native Action approvals for ${session.binding.root}\nProfile ${session.binding.profileSha256}`;
          status.command = command; status.show(); enabled = true;
        }
        return allowed;
      })().finally(() => { enabling = undefined; });
    },
    async handle(method: OriginalNativeActionMethod | typeof originalActionProgramMethod | NativeActionPackageMethod,
      value: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      if (isNativeActionPackageMethod(method)) {
        if (!enabled || terminal) return method === "action.package.decision.current" ? { current: false } : null;
        if (!/^[a-f0-9-]{36}$/.test(requestId) || retired.has(requestId)) fail("NATIVE_ACTION_REQUEST_REPLAY");
        if (retired.size >= 4096) fail("NATIVE_ACTION_REQUEST_LEDGER_FULL");
        retired.add(requestId);
        return packages!.handle(method, value, AbortSignal.any([signal, options.signal, signer.signal, lifetime.signal]));
      }
      if (method === originalActionProgramMethod) {
        const payload = parseOriginalActionProgramPayload(value, session);
        if (!enabled || terminal) return null;
        return programs.handle(payload, requestId, signal);
      }
      const payload = parseOriginalNativeActionPayload(method, structuredClone(value), session);
      if (method === "action.registered.status")
        return { trusted: enabled && !terminal, trustEpoch: session.epoch };
      if (method === "action.registered.review") {
        const request = payload as OriginalNativeActionPayload<"action.registered.review">;
        if (!enabled || terminal) return null;
        if (!/^[a-f0-9-]{36}$/.test(requestId) || retired.has(requestId) || retired.size >= 4096)
          fail("NATIVE_ACTION_REQUEST_REPLAY");
        retired.add(requestId);
        if (request.deadline <= Date.now() || request.deadline > Date.now() + 300000)
          fail("NATIVE_ACTION_REQUEST_EXPIRED");
        const checkLocal = () => {
          for (const file of request.sourceFiles)
            if (pinRecipeEffectFile(file.path).sha256 !== file.sha256) fail("NATIVE_ACTION_SOURCE_FILE_CHANGED");
          if (!request.localPath) return;
          const local = request.localPath, parent = lstatSync(dirname(local.path));
          if (realpathSync(dirname(local.path)) !== dirname(local.path) || !parent.isDirectory()
            || parent.mode & 0o022 || parent.uid !== 0 && parent.uid !== process.getuid?.()
            || [parent.dev, parent.ino, parent.uid, parent.mode].join(":") !== local.parentPin)
            fail("NATIVE_ACTION_LOCAL_PATH_CHANGED");
          if (local.sha256 === null) {
            if (local.kind !== "destination" || local.entryKind !== null || registeredActionPathExists(local.path))
              fail("NATIVE_ACTION_NEW_DESTINATION_REQUIRED");
          } else {
            const actual = pinRegisteredActionPath(local.path);
            if (actual.sha256 !== local.sha256 || actual.entryKind !== local.entryKind)
              fail("NATIVE_ACTION_LOCAL_PATH_CHANGED");
          }
        };
        checkLocal();
        if (request.localPath) {
          const local = request.localPath;
          const selected = local.kind === "source" || local.entryKind === "directory"
            ? (await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(local.path),
              canSelectFiles: local.entryKind !== "directory",
              canSelectFolders: local.entryKind === "directory", canSelectMany: false }))?.[0]
            : await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(local.path) });
          current(signal);
          if (selected?.fsPath !== local.path) return null;
          checkLocal();
        }
        const allowed = await approve(request.purpose === "source"
          ? "Admit this exact newly authored Action source without executing it?"
          : request.purpose === "reconcile" ? "Accept this exact owned observed process completion? NO execution or replay."
          : "Run this exact registered Action with these inputs and effects?", {
          request,
          permission: request.purpose === "source" ? "Current revision source only; no process or remote effect permission."
            : request.purpose === "reconcile" ? "Exact current Run revision and independently observed terminal process receipt only. User-declared outcomes cannot authorize this operation. No new effect, replay, or rollback."
            : "One invocation only. Shell-free owned direct child; not an OS filesystem/network sandbox. Remote effects are not rolled back; uncertain outcomes are never automatically replayed.",
        }, signal);
        current(signal);
        checkLocal();
        return { decision: allowed ? "approve" as const : "deny" as const,
          requestSha256: originalDigest(request), decisionId: randomUUID(),
          expiresAtMs: Math.min(request.deadline, Date.now() + 300000) };
      }
      if (method === "action.status") {
        const input = payload as OriginalNativeActionPayload<"action.status">;
        return { trusted: enabled && !terminal && (!capsuleSha256 || capsuleSha256 === input.capsuleSha256), trustEpoch: session.epoch };
      }
      if (!enabled || terminal) return method === "action.source.approve" ? null : denial();
      if (!/^[a-f0-9-]{36}$/.test(requestId) || retired.has(requestId)) fail("NATIVE_ACTION_REQUEST_REPLAY");
      if (retired.size >= 4096) fail("NATIVE_ACTION_REQUEST_LEDGER_FULL");
      retired.add(requestId);
      if (method === "action.authorize") {
        const input = payload as OriginalNativeActionPayload<"action.authorize">;
        sameCapsule(input.capsuleSha256);
        const key = `${input.capsuleSha256}:${input.actionId}`, prior = authorizations.get(key);
        if (prior?.contentHash === input.contentHash && prior.expiresAtMs > Date.now()) return approved();
        // The existing bridge's authorize probe has a three-second deadline.
        // Candidate acknowledgement grants nothing; the typed aggregate review below owns the UI decision.
        capsuleSha256 = input.capsuleSha256;
        authorizations.set(key, { contentHash: input.contentHash, expiresAtMs: Date.now() + 300000 });
        return approved();
      }
      if (method === "action.source.approve") {
        const input = (payload as OriginalNativeActionPayload<"action.source.approve">).request;
        sameCapsule(input.capsuleSha256);
        if (input.sources.some(source => {
          const prior = authorizations.get(`${input.capsuleSha256}:${source.actionId}`);
          return !prior || prior.contentHash !== source.contentHash || prior.expiresAtMs <= Date.now();
        })) fail("NATIVE_ACTION_EXACT_SOURCE_REVIEW_REQUIRED");
        const allowed = await approve("Admit this exact original Action source/state capsule without execution?", {
          request: input, permission: "Only source/state custody and manual evidence reconciliation. Old grants and validation success are not current execution permission.",
        }, signal);
        if (!allowed) { admitted = undefined; return null; }
        const decision = originalNativeActionSourceDecision.parse({
          schema: "pkm.native-action-source-decision/v1", scope: "original-action-source-state/v1",
          root: input.root, workspaceId: input.workspaceId, actorId: "mcp:external", profileSha256: input.profileSha256,
          epoch: session.epoch, capsuleSha256: input.capsuleSha256, requestSha256: input.requestSha256,
          decisionId: randomUUID(), expiresAtMs: Date.now() + 300000, noExecution: true,
        });
        admitted = { decision, sources: new Map(input.sources.map(source => [source.actionId, freeze(structuredClone(source))])) };
        return freeze(decision);
      }
      const input = payload as OriginalNativeActionPayload<"action.invocation.approve">;
      const consent = parseOriginalNativeActionConsent(input.effectContext);
      sameCapsule(input.capsuleSha256);
      const admission = admitted, source = admission?.sources.get(input.actionId);
      if (!admission || admission.decision.expiresAtMs <= Date.now() || !source || source.contentHash !== input.contentHash
        || source.implementationSha256 !== consent.implementationSha256
        || originalDigest(source.effects) !== originalDigest(input.effectContext.effects))
        fail("NATIVE_ACTION_EXACT_SOURCE_REVIEW_REQUIRED");
      if (consent.operation === "action_call" && (consent.deadline <= Date.now() || consent.deadline > Date.now() + 300000))
        fail("NATIVE_ACTION_INVOCATION_EXPIRED");
      const allowed = await approve(consent.operation === "action_call"
        ? "Execute this exact admitted native Action invocation?"
        : "Continue this exact waiting native Action Run?", {
          actionId: input.actionId, contentHash: input.contentHash, effects: input.effectContext.effects,
          components: input.effectContext.components, consent,
          permission: "One exact native pure/interaction invocation or continuation. No process, credential, artifact, remote effect, automatic replay, or other Run is approved.",
        }, signal);
      current(signal);
      if (admitted !== admission || !admission || admission.decision.expiresAtMs <= Date.now())
        fail("NATIVE_ACTION_SOURCE_REVIEW_EXPIRED");
      const result = allowed ? approved() : denial();
      return originalNativeActionResultSchemas["action.invocation.approve"].parse(result);
    },
    revoke, dispose,
  });
}
