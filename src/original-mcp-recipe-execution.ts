import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CoreError, type Actor } from "./contracts.js";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import type { RootOwner } from "./root-owner.js";
import type { Storage } from "./storage.js";
import { NativeRecipeLibrary } from "./native-recipe-library.js";
import { LegacyRecipeLazyRuntime } from "./legacy-recipe-lazy-runtime.js";
import { LegacyRecipeExternalReports } from "./legacy-recipe-external-reports.js";
import { legacyRecipeLazyInputs, type LegacyRecipeLazyOperation } from "./legacy-recipe-lazy-contracts.js";
import { originalMcpPublicRequestActive, originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalRecipeLibraryScope, originalMcpRecipeLibrarySession, verifyOriginalMcpRecipeLibrary } from "./original-mcp-recipe-library.js";
import { originalMcpNativeRecipeSourcePolicyForOwner, originalMcpNativeRecipeSourcePolicySession } from "./original-mcp-native-recipe-policy.js";
import { acquireOriginalMcpNativeRecipeLibraryExecution, prepareOriginalMcpRecipeAdhoc,
  prepareOriginalMcpRecipeLibraryRun } from "./original-mcp-recipe-authoring.js";
import { createOriginalMcpRecipeEffects } from "./original-mcp-recipe-effects.js";
import { workflowRuntimeBindingsFromOriginalInputs } from "./domain/workflow-executor-bindings.js";
import { projectRecipeCapabilities, controlledLegacyRecipeCapabilities } from "./legacy-recipe-capabilities-mcp.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const operations = new Set(["recipe_run_start", "recipe_run_start_adhoc", "recipe_run_next", "recipe_run_report", "recipe_run_get",
  "recipe_run_progress", "recipe_run_submit_input"]);
export interface OriginalMcpRecipeExecution {
  close(): void;
  ownsRun(runId: string): boolean;
  dispatch(tool: string, args: Record<string, unknown>, actor: Readonly<Actor>, signal?: AbortSignal): Promise<Record<string, any>>;
}
const executions = new WeakMap<Storage, { host: OriginalMcpNativeHost; signal: AbortSignal; execution: OriginalMcpRecipeExecution }>();
export async function originalMcpRecipeCapabilities(owner: RootOwner, host: OriginalMcpNativeHost,
  args: Record<string, unknown>) {
  const { storage } = await originalRecipeLibraryScope(owner, host);
  if (!originalMcpPublicRequestActive(storage, "recipe_capabilities", args))
    throw new CoreError("ACCESS_DENIED", "Recipe capabilities require the exact current authenticated public request.");
  const capabilities = projectRecipeCapabilities(await readWorkflowCompiler(owner.workspaceRoot(),
    { operation: "workflow.compiler.capabilities", args: {} }, []), true);
  const provided = [...operations, "recipe_search", "recipe_usage_summary", "recipe_create_from_skill", "recipe_capabilities"];
  return { ...capabilities, legacyRecipeToolsNotProvided: capabilities.legacyRecipeToolsNotProvided
    .filter((name: string) => !provided.includes(name)),
    controlledLazy: { operations: [...operations], ...controlledLegacyRecipeCapabilities([
      "pkm.step.command/v1", "pkm.step.script/v1", "pkm.step.noop/v1", "pkm.gate.human/v1", "pkm.subflow/v1",
    ], "original-recipe-metadata/v1"), availableImplementationsNotExecutionGrants: true,
    sourceRequiresIndependentNativeDecision: true, eachProcessRequiresSeparateNativeDecision: true,
    getIsMutation: true, cancelVia: "recipe_run_progress.cancellationRequested",
    restartUnknownNeverReplayed: true, fullRecipeParity: false } };
}
/** Routing classification only: never a source decision, runtime authority, result read or fallback permission. */
export async function originalMcpRecipeExecutionRunExists(owner: RootOwner, host: OriginalMcpNativeHost, runId: string) {
  const { storage } = await originalRecipeLibraryScope(owner, host), db = storage.connectNative();
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_recipe_lazy_runs'").get()) return false;
    return !!db.prepare("SELECT 1 FROM legacy_recipe_lazy_runs WHERE actor_id=? AND run_id=?").get("mcp:external", runId);
  } finally { db.close(); }
}
export async function dispatchOriginalMcpRecipeExecution(owner: RootOwner, host: OriginalMcpNativeHost,
  tool: string, args: Record<string, unknown>, actor: Readonly<Actor>, signal?: AbortSignal) {
  try {
    if (tool === "recipe_run_start_adhoc") await prepareOriginalMcpRecipeAdhoc(owner, host, actor, args, signal);
    else if (tool === "recipe_run_start") {
      const { storage } = await originalRecipeLibraryScope(owner, host);
      let existing: ReturnType<typeof originalMcpRecipeLibrarySession> | undefined;
      try { existing = originalMcpRecipeLibrarySession(storage, owner, host); }
      catch (error) { if (!(error instanceof CoreError) || error.code !== "ACCESS_DENIED") throw error; }
      const compiled = existing && compileWorkflowDefinitionV1(existing.recipe.definition);
      const keepOriginal = existing?.recipe.recipeId === args.recipe_id && compiled?.ok
        && !compiled.model.spec.trigger && !Object.keys(compiled.model.spec.outputs).length
        && !compiled.model.spec.nodes.some(node => node.dependsOn.some(edge => edge.loop)
          || node.control?.mode === "repeat" || node.control?.mode === "branch" && node.control.dynamicCases)
        && !workflowRuntimeBindingsFromOriginalInputs(compiled.model, JSON.parse(String(args.inputs_json || "{}")))
        && !await acquireOriginalMcpNativeRecipeLibraryExecution(owner, host);
      if (keepOriginal) await verifyOriginalMcpRecipeLibrary(owner, host, signal);
      else await prepareOriginalMcpRecipeLibraryRun(owner, host, actor, args, signal);
    }
  } catch (error) {
    if (error instanceof CoreError || error instanceof Error && (error.name === "AbortError"
      || /^NATIVE_/.test(error.message))) throw error;
    return { schema: "pkm.recipe.api/v1", ok: false, error: {
      code: tool === "recipe_run_start_adhoc" ? "recipe-run-start-adhoc-failed" : "recipe-run-start-failed",
      message: error instanceof Error ? error.message : String(error),
    } };
  }
  return (await createOriginalMcpRecipeExecution(owner, host)).dispatch(tool, args, actor, signal);
}
/** Original protocol over the actual native explicit scheduler; external reports do not execute caller work. */
export async function createOriginalMcpRecipeExecution(owner: RootOwner, host: OriginalMcpNativeHost): Promise<OriginalMcpRecipeExecution> {
  const { storage } = await originalRecipeLibraryScope(owner, host);
  const native = await acquireOriginalMcpNativeRecipeLibraryExecution(owner, host);
  const admitted = native ?? await verifyOriginalMcpRecipeLibrary(owner, host);
  const cached = executions.get(storage);
  if (cached?.host === host && cached.signal === admitted.signal) return cached.execution;
  cached?.execution.close();
  const database = storage.connectNative(); let closed = false, closing = false, lazy: LegacyRecipeLazyRuntime | undefined;
  let execution: OriginalMcpRecipeExecution | undefined;
  let effects: ReturnType<typeof createOriginalMcpRecipeEffects> | undefined;
  const assertOwner = () => {
    if (closed) throw new CoreError("ACCESS_DENIED", "Native Recipe execution attachment was closed; no old work may replay.");
    if (closing) { owner.assertWorkspaceLease(); storage.assertWorkspaceLease(); return; }
    if (native) { native.assertCurrent(); return; }
    const current = originalMcpRecipeLibrarySession(storage, owner, host);
    if (current.source.planSha256 !== admitted.source.planSha256 || current.signal !== admitted.signal)
      throw new CoreError("ACCESS_DENIED", "Native Recipe Library admission changed.");
  };
  let library: NativeRecipeLibrary | undefined;
  try {
    if (!native) library = new NativeRecipeLibrary({ database, workspaceId: admitted.source.workspaceId, assertLease: assertOwner,
      original: () => { assertOwner(); return { snapshotRevision: admitted.source.planSha256, recipes: [admitted.recipe] }; } });
  } catch (error) { database.close(); throw error; }
  const snapshot = () => {
    assertOwner();
    if (native) return native.catalog();
    const current = library!.snapshot();
    if (current.recipes.length !== 1 || digest(current.recipes[0]) !== admitted.source.recordSha256)
      throw new CoreError("ACCESS_DENIED", "Library authoring/overlay changes require an independent newly reviewed source.");
    return current;
  };
  const refresh = async () => {
    if (native) await native.refresh();
    else await verifyOriginalMcpRecipeLibrary(owner, host);
    assertOwner();
  };
  const compiled = compileWorkflowDefinitionV1(admitted.recipe.definition);
  if (!compiled.ok) { database.close(); throw new CoreError("ACCESS_DENIED", "Damaged admitted Recipe definition."); }
  const authorize: Parameters<typeof createOriginalMcpRecipeEffects>[0]["authorize"] = binding => {
    assertOwner();
    const source = binding.source as { kind?: unknown; recipeId?: unknown; executableDigest?: unknown; snapshotRevision?: unknown };
    const recipe = native ? native.recordForRecipe(String(source?.recipeId ?? ""))
      : source?.recipeId === admitted.recipe.recipeId ? admitted.recipe : undefined;
    if (!recipe) return false;
    const current = compileWorkflowDefinitionV1(recipe.definition);
    if (!current.ok || current.executableDigest !== recipe.executableDigest) return false;
    const originalNodes = (recipe.definition as unknown as typeof current.model).spec.nodes;
    return binding.actorId === "mcp:external" && source?.kind === "recipe" && source.recipeId === recipe.recipeId
      && binding.executableDigest === recipe.executableDigest && source.executableDigest === recipe.executableDigest
      && source.snapshotRevision === snapshot().snapshotRevision
      && (native?.executionSemantics !== "original-recipe-metadata/v1" || binding.executionSemantics === native.executionSemantics)
      && (!native?.runtimeBindings || canonicalJson(binding.runtimeBindings) === canonicalJson(native.runtimeBindings))
      && (canonicalJson(binding.node) === canonicalJson(current.model.spec.nodes.find(node => node.nodeId === binding.node.nodeId))
        || canonicalJson(binding.node) === canonicalJson(originalNodes.find(node => node.nodeId === binding.node.nodeId)));
  };
  const externalReports = new LegacyRecipeExternalReports({
    id: "original-native-controlled-external-report", authorizationDigest: digest({ source: admitted.source.planSha256,
      protocol: admitted.source.protocol, effects: admitted.source.effects }),
    staticBranches: true, portedNoops: true, humanGates: !!native,
    resolvedControls: !!native,
    authorizeDefinition: authorize,
  });
  function close() {
    if (closed) return;
    // Close the real native scheduler first; offered/claimed/running intents become UNKNOWN, never replayed.
    closing = true;
    try { lazy?.close(); } finally { closed = true; closing = false; library?.close();
      void effects?.close().catch(() => undefined); }
    admitted.signal.removeEventListener("abort", revoked);
    if (executions.get(storage)?.execution === execution) executions.delete(storage);
  }
  const revoked = () => {
    try { close(); }
    catch { /* A lost root lease prevents shutdown writes; the next owner fences the durable intents, never replays them. */ }
  };
  try {
    if (snapshot().recipes.some(recipe => {
      const definition = compileWorkflowDefinitionV1(recipe.definition);
      return definition.ok && definition.model.spec.nodes.some(node => node.kind === "pkm.step.command/v1" || node.kind === "pkm.step.script/v1");
    })) {
      const session = native?.session ?? originalMcpNativeRecipeSourcePolicySession(
        await originalMcpNativeRecipeSourcePolicyForOwner(owner, host), owner, host);
      effects = createOriginalMcpRecipeEffects({ root: owner.workspaceRoot(), host, session, signal: admitted.signal,
        source: admitted.source, definition: compiled.model, authorize, assertCurrent: assertOwner, refresh,
        ...(native ? { executionSemantics: native.executionSemantics } : {}),
        ...(native ? { sourceForRun: (runId: string) => {
          const record = native.recordForRecipe(lazy!.recipeIdForRun(runId));
          return { recipeId: record.recipeId, revision: record.revision, executableDigest: record.executableDigest,
            recordSha256: digest(record), definition: record.definition };
        } } : {}),
        sourceInputs: runId => lazy!.sourceInputs(runId),
        approved: (runId, invocationId, metadata) => lazy!.recordNativeEffectApproval(runId, invocationId, metadata) });
    }
    lazy = new LegacyRecipeLazyRuntime(database, {
      actorId: "mcp:external", root: owner.workspaceRoot(), bindingFingerprint: digest({
        root: owner.workspaceRoot(), workspaceId: admitted.source.workspaceId, source: admitted.source.planSha256, actorId: "mcp:external",
      }), ownerId: randomUUID(), adapters: effects?.adapters ?? {}, externalReports, assertOwner,
      catalog: async () => { await refresh(); return snapshot(); },
      resolveRecipe(source) {
        assertOwner();
        if (native) return native.resolveRecipe(source as Record<string, unknown>);
        const ref = source as Record<string, unknown>, catalog = snapshot(), recipe = catalog.recipes[0]!;
        if (ref.kind !== "recipe" || ref.recipeId !== recipe.recipeId || ref.expectedRevision !== recipe.revision
          || ref.expectedExecutableDigest !== recipe.executableDigest || ref.snapshotRevision !== catalog.snapshotRevision)
          throw new CoreError("CONFLICT", "Exact admitted Recipe source revision/digest changed.");
        const compiled = compileWorkflowDefinitionV1(recipe.definition);
        if (!compiled.ok) throw new CoreError("ACCESS_DENIED", "Damaged admitted Recipe definition.");
        return { status: "valid", executableDigest: compiled.executableDigest, definition: compiled.model,
          source: { kind: "recipe", recipeId: recipe.recipeId, revision: recipe.revision,
            executableDigest: recipe.executableDigest, snapshotRevision: catalog.snapshotRevision } };
      },
      ...(native?.executionSemantics === "original-recipe-metadata/v1" ? { originalRecipeMetadata: true as const } : {}),
      ...(native?.runtimeBindings ? { runtimeBindings: native.runtimeBindings } : {}),
      ...(native ? { publicDefinition: native.recipe.definition, publicExecutableDigest: native.source.publicExecutableDigest,
        publicDefinitionForRecipe: (recipeId: string) => native.recordForRecipe(recipeId).definition,
        publicExecutableDigestForRecipe: (recipeId: string) => native.publicExecutableDigestForRecipe(recipeId),
        knowledgeForNode: (nodeId: string, recipeId: string) => native.knowledgeForRecipeNode(recipeId, nodeId)
          .nodes.find(node => node.nodeId === nodeId)?.bindings ?? [],
        ...(native.executionSemantics === "original-recipe-metadata/v1" ? { subflows: {
          authorizeDefinition: authorize, authorizeData: authorize,
        } } : {}) } : {}),
      requestCancel: request => {
        if (!effects) throw new CoreError("ACCESS_DENIED", "No native command/process effect is admitted.");
        return effects.requestCancel(request);
      },
    });
    admitted.signal.addEventListener("abort", revoked, { once: true }); if (admitted.signal.aborted) close();
    storage.retainNativeCleanup({ async release() { close(); await effects?.close(); } });
  } catch (error) { close(); throw error; }
  execution = Object.freeze({
    close,
    ownsRun(runId: string) {
      assertOwner();
      return !!database.prepare("SELECT 1 FROM legacy_recipe_lazy_runs WHERE actor_id=? AND run_id=?")
        .get("mcp:external", runId);
    },
    async dispatch(tool: string, args: Record<string, unknown>, actor: Readonly<Actor>, signal?: AbortSignal) {
      assertOwner();
      if (!operations.has(tool) || actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker
        || !originalMcpPublicRequestMatches(storage, host, { operation: `mcp.tool.${tool}`, tool, version: 1,
          readOnly: tool === "recipe_run_get", arguments: args, argumentsDigest: digest(args) }))
        throw new CoreError("ACCESS_DENIED", "Exact fresh native public request and writable actor are required, including execution-capable get.");
      signal?.throwIfAborted();
      await refresh(); signal?.throwIfAborted(); assertOwner();
      const operation = `mcp.tool.${tool === "recipe_run_start_adhoc" ? "recipe_run_start" : tool}` as LegacyRecipeLazyOperation;
      const runtimeArgs: Record<string, unknown> = tool === "recipe_run_start_adhoc" ? {
        ...args, recipe_id: admitted.recipe.recipeId, project_id: "", expected_revision: 1,
        expected_digest: admitted.recipe.executableDigest,
      } : args;
      if (tool === "recipe_run_start_adhoc")
        for (const key of ["name", "definition_json", "node_bindings_json"]) delete runtimeArgs[key];
      if (tool === "recipe_run_start") {
        const request = legacyRecipeLazyInputs["mcp.tool.recipe_run_start"].safeParse(args);
        const runId = request.success
          ? "recipe_run_" + createHash("sha256").update(request.data.command_id).digest("hex").slice(0, 24) : undefined;
        if (runId && lstatSync(join(owner.workspaceRoot(), ".pkm/state/recipe-runs", `${runId}.json`), { throwIfNoEntry: false }))
          return { schema: "pkm.recipe.api/v1", ok: false,
            error: { code: "recipe-run-start-failed", message: "Deterministic run identity already exists for another command." } };
      }
      const result = await lazy!.dispatch(operation, runtimeArgs, actor);
      if (native?.runtimeBindings && result.status === "completed" && typeof result.run_id === "string")
        (result.current_result as Record<string, unknown>).outputs = lazy!.outputs(result.run_id);
      try { assertOwner(); signal?.throwIfAborted(); }
      catch {
        throw new CoreError("ACCESS_DENIED", "Native Recipe authority changed after dispatch; reconcile its durable receipt, never automatically retry.", "unknown");
      }
      return result;
    },
  });
  assertOwner();
  executions.set(storage, { host, signal: admitted.signal, execution });
  return execution;
}
