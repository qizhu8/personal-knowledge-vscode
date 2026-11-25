import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalNativeRecipeDigest, originalNativeRecipeSessionSchema, type OriginalNativeRecipeSession } from "../../src/original-mcp-native-recipe-contracts.js";
import { originalRecipeEffectMethod, originalRecipeEffectDecision, parseOriginalRecipeEffectPayload } from "../../src/original-mcp-recipe-effect-contracts.js";
import { pinRecipeEffectFile, pinRecipeEffectCwd, assertRecipeEffectExecutable } from "../../src/original-mcp-recipe-effect-files.js";
import { selectRegisteredHostPythonEnvironment } from "../../src/host-python-environment.js";
import { resolveActionExecutable } from "../../src/action-program-build.js";
import { compileWorkflowDefinitionV1 } from "../../src/domain/project-recipes-workflow-contracts.js";

const label = "Run this exact independently reviewed Recipe step";
/** Source admission is not an effect grant. Every invocation gets a separate, non-replayable native choice. */
export async function createOriginalMcpNativeRecipeEffectProducer(context: vscode.ExtensionContext, options: {
  session: OriginalNativeRecipeSession; signal: AbortSignal; assertCurrent(): void;
  sourceAdmission(): { request: unknown; expiresAtMs: number } | undefined;
}) {
  const signer = await originalMcpNativeSigner(context), session = originalNativeRecipeSessionSchema.parse(options.session);
  const retired = new Set<string>(); let pending = false;
  function current(signal?: AbortSignal) {
    signer.assertCurrent(); options.assertCurrent();
    if (!vscode.workspace.isTrusted || options.signal.aborted || signer.signal.aborted || signal?.aborted
      || session.activationId !== signer.activationId || session.identitySha256 !== signer.identity.sha256
      || session.binding.profileSha256 !== signer.identity.profileSha256 || session.binding.payloadBuildId !== signer.payloadBuildId
      || session.binding.hostEntrySha256 !== signer.hostEntrySha256) throw new Error("NATIVE_RECIPE_EFFECT_SESSION_CHANGED");
  }
  return Object.freeze({ method: originalRecipeEffectMethod,
    async handle(value: unknown, requestId: string, signal: AbortSignal) {
      current(signal);
      const { request } = parseOriginalRecipeEffectPayload(structuredClone(value), session);
      originalNativeRecipeSessionSchema.shape.activationId.parse(requestId);
      if (retired.has(requestId) || retired.has(request.invocationId) || retired.size >= 8192 || pending)
        throw new Error("NATIVE_RECIPE_EFFECT_REPLAY_OR_BUSY");
      retired.add(requestId); retired.add(request.invocationId); pending = true;
      const combined = AbortSignal.any([signal, signer.signal, options.signal]);
      let admission: ReturnType<typeof options.sourceAdmission>;
      let source: Record<string, unknown> | undefined;
      function checked() {
        current(combined);
        const reachable = source?.reachableRecipes as Array<Record<string, unknown>> | undefined;
        const recipe = source?.recipeId === request.recipeId ? source
          : reachable?.find(recipe => recipe.recipeId === request.recipeId);
        if (!admission || options.sourceAdmission() !== admission || admission.expiresAtMs <= Date.now()
          || request.deadline <= Date.now() || source?.planSha256 !== request.sourcePlanSha256
          || !recipe || recipe.recordSha256 !== request.sourceRecordSha256
          || recipe.executableDigest !== request.executableDigest || recipe.revision !== request.revision
          || source.nativeHostReceiptSha256 !== request.nativeHostReceiptSha256
          || originalNativeRecipeDigest(pinRecipeEffectCwd(request.root, request.cwd.path)) !== originalNativeRecipeDigest(request.cwd))
          throw new Error("NATIVE_RECIPE_EFFECT_SOURCE_CHANGED");
        const compiled = compileWorkflowDefinitionV1(request.definition);
        const node = compiled.ok && compiled.model.spec.nodes.find(node => node.nodeId === request.nodeId);
        if (!node || node.kind === "pkm.step.command/v1" && resolveActionExecutable(request.program!) !== request.executable?.path
          || source.executionSemantics && source.executionSemantics !== request.executionSemantics)
          throw new Error("NATIVE_RECIPE_EFFECT_PROGRAM_CHANGED");
        for (const file of request.sources)
          if (originalNativeRecipeDigest(pinRecipeEffectFile(file.path)) !== originalNativeRecipeDigest(file))
            throw new Error("NATIVE_RECIPE_EFFECT_FILE_CHANGED");
        if (request.executable && originalNativeRecipeDigest(pinRecipeEffectFile(request.executable.path, undefined, true)) !== originalNativeRecipeDigest(request.executable))
          throw new Error("NATIVE_RECIPE_EFFECT_FILE_CHANGED");
      }
      try {
        admission = options.sourceAdmission();
        source = admission?.request as Record<string, unknown> | undefined;
        checked();
        let environment: ReturnType<typeof selectRegisteredHostPythonEnvironment> | null = null;
        if (request.environmentId) {
          let registry = join(context.globalStorageUri.fsPath, "registry.json");
          if (!existsSync(registry)) {
            const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
              canSelectFolders: false, title: `Select the existing registered Python catalog for ${request.environmentId}`, filters: { JSON: ["json"] } });
            checked();
            if (!selected?.length) return null;
            registry = selected[0]!.fsPath;
          }
          environment = selectRegisteredHostPythonEnvironment(registry, request.workspaceId, request.actorId, request.environmentId);
        }
        const executable = request.executable ?? pinRecipeEffectFile(environment!.handle.target, undefined, true);
        assertRecipeEffectExecutable(executable.path);
        const detail = JSON.stringify({ session, request, requestSha256: originalNativeRecipeDigest(request), executable, environment,
          permission: "One exact source-bound direct child only, with literal argv, empty inherited environment and bounded output/deadline. The registered executable may be writable by its current owner and the owner's primary group; its exact owner/group/mode/bytes are pinned and rechecked, not made immutable. This is NOT an OS filesystem/network sandbox: approve only independently reviewed code that does not spawn/detach descendants, access credentials, or perform unrelated effects. No model, worker, subflow or automatic replay grant. Source approval alone authorizes NONE of these process effects." }, null, 2);
        const answer = await new Promise<string | undefined>((resolve, reject) => {
          const aborted = () => reject(new Error("NATIVE_RECIPE_EFFECT_CANCELLED"));
          combined.addEventListener("abort", aborted, { once: true });
          Promise.resolve(vscode.window.showWarningMessage("Run this exact Recipe command/Script step?", { modal: true, detail }, label, "Deny"))
            .then(resolve, reject).finally(() => combined.removeEventListener("abort", aborted));
          if (combined.aborted) aborted();
        });
        checked();
        if (answer !== label) return null;
        if (environment && originalNativeRecipeDigest(selectRegisteredHostPythonEnvironment(environment.registry.path,
          request.workspaceId, request.actorId, request.environmentId!)) !== originalNativeRecipeDigest(environment)
          || originalNativeRecipeDigest(pinRecipeEffectFile(executable.path, undefined, true)) !== originalNativeRecipeDigest(executable))
          throw new Error("NATIVE_RECIPE_EFFECT_ENVIRONMENT_CHANGED");
        return originalRecipeEffectDecision.parse({
          schema: "pkm.original-recipe-effect-decision/v1", scope: request.authority.scope,
          root: request.root, workspaceId: request.workspaceId, actorId: request.actorId, profileSha256: request.profileSha256,
          epoch: request.epoch, sourcePlanSha256: request.sourcePlanSha256, sourceRecordSha256: request.sourceRecordSha256,
          runId: request.runId, nodeId: request.nodeId, invocationId: request.invocationId,
          requestSha256: originalNativeRecipeDigest(request), executableSha256: executable.sha256,
          decisionId: randomUUID(), expiresAtMs: Math.min(Date.now() + 300000, request.deadline, admission!.expiresAtMs),
          environment, automaticReplay: false,
        });
      } finally { pending = false; }
    } });
}
