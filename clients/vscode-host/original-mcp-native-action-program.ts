import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalDigest } from "../../src/domain/action-compiler-validation.js";
import {
  originalActionProgramMethod, parseOriginalActionProgramPayload, assertOriginalActionProgramDecision,
} from "../../src/original-mcp-action-program-contracts.js";
import { originalNativeActionSession, type OriginalNativeActionSession,
  type originalNativeActionSourceDecision } from "../../src/original-mcp-native-action-contracts.js";
import type { z } from "zod";

type SourceAdmission = {
  decision: z.infer<typeof originalNativeActionSourceDecision>;
  sources: ReadonlyMap<string, { actionId: string; contentHash: string; implementationSha256: string; effects: string[] }>;
};
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Leaf for the existing Action producer. Parent supplies its private admitted-source view, never an approval callback. */
export async function createOriginalMcpNativeActionProgramApprover(context: vscode.ExtensionContext, options: {
  session: OriginalNativeActionSession; signal: AbortSignal; assertCurrent(): void;
  sourceAdmission(): SourceAdmission | undefined;
}) {
  const signer = await originalMcpNativeSigner(context), session = originalNativeActionSession.parse(options.session);
  const retired = new Set<string>();
  const current = (signal: AbortSignal) => {
    signer.assertCurrent(); options.assertCurrent();
    if (signal.aborted || options.signal.aborted || signer.signal.aborted) fail("NATIVE_ACTION_PROGRAM_CANCELLED");
    if (!vscode.workspace.isTrusted || session.activationId !== signer.activationId || session.epoch !== signer.activationId
      || session.identitySha256 !== signer.identity.sha256 || session.binding.profileSha256 !== signer.identity.profileSha256
      || session.binding.payloadBuildId !== signer.payloadBuildId || session.binding.hostEntrySha256 !== signer.hostEntrySha256)
      fail("NATIVE_ACTION_PROGRAM_BINDING_MISMATCH");
  };
  return Object.freeze({
    methods: Object.freeze([originalActionProgramMethod]),
    async handle(payload: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      const { request } = parseOriginalActionProgramPayload(payload, session), admission = options.sourceAdmission();
      const source = admission?.sources.get(request.request.action_id);
      if (!admission || admission.decision.expiresAtMs <= Date.now() || !source
        || admission.decision.root !== request.root || admission.decision.workspaceId !== request.workspaceId
        || admission.decision.actorId !== request.actorId || admission.decision.profileSha256 !== request.profileSha256
        || admission.decision.noExecution !== true
        || admission.decision.epoch !== session.epoch || admission.decision.capsuleSha256 !== request.capsuleSha256
        || source.contentHash !== request.request.content_hash || source.implementationSha256 !== request.implementationSha256
        || originalDigest(source.effects) !== originalDigest(["pure"]))
        fail("NATIVE_ACTION_PROGRAM_SOURCE_REQUIRED");
      if (request.deadline <= Date.now() || request.deadline > Date.now() + 300000)
        fail("NATIVE_ACTION_PROGRAM_EXPIRED");
      if (retired.has(requestId) || !/^[a-f0-9-]{36}$/.test(requestId)) fail("NATIVE_ACTION_PROGRAM_REQUEST_REPLAY");
      if (retired.size >= 4096) fail("NATIVE_ACTION_PROGRAM_LEDGER_FULL");
      retired.add(requestId);
      const combined = AbortSignal.any([signal, options.signal, signer.signal]);
      const result = vscode.window.showWarningMessage("Run this exact pinned local Action program as one direct child?", {
        modal: true, detail: JSON.stringify({ request,
          permission: "Separate one-use local process/toolchain/input approval. No shell, inherited environment, credentials, network, descendants, build, or automatic replay is authorized.",
          limitation: "The direct-child supervisor is not an OS filesystem/network sandbox. Approve only independently reviewed harmless code in this isolated capsule context.",
        }, null, 2),
      }, "Run this exact local program", "Deny");
      const answer = await new Promise<string | undefined>((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("NATIVE_ACTION_PROGRAM_CANCELLED"), { code: "NATIVE_ACTION_PROGRAM_CANCELLED" }));
        combined.addEventListener("abort", abort, { once: true });
        Promise.resolve(result).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
        if (combined.aborted) abort();
      });
      current(signal);
      if (options.sourceAdmission() !== admission || admission.decision.expiresAtMs <= Date.now())
        fail("NATIVE_ACTION_PROGRAM_SOURCE_CHANGED");
      if (answer !== "Run this exact local program") return null;
      return assertOriginalActionProgramDecision({
        schema: "pkm.original-mcp-local-program-decision/v1", scope: "exact-local-direct-child/v1",
        root: request.root, workspaceId: request.workspaceId, actorId: request.actorId, profileSha256: request.profileSha256,
        epoch: request.epoch, capsuleSha256: request.capsuleSha256, runId: request.runId,
        requestSha256: originalDigest(request), executableSha256: request.executable.sha256,
        decisionId: randomUUID(), expiresAtMs: Math.min(request.deadline, admission.decision.expiresAtMs, Date.now() + 300000),
        automaticReplay: false,
      }, request);
    },
  });
}
