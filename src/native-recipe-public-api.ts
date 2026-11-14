import { CoreError, type Actor } from "./contracts.js";
import type { LegacyApiChatRecipes } from "./legacy-api-chat-recipes.js";
import { nativeChatRecipeCancel, nativeChatRecipeCreate, nativeChatRecipeLibrary } from "./legacy-api-chat-recipes.js";
import { legacyRecipeSearchInput } from "./recipe-public-contracts.js";
import { searchLocalRecipes } from "./legacy-recipe-search.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { readProjectRecipes } from "./project-recipes.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";
import type { WorkflowCompilerRequest } from "./workflow-compiler-contracts.js";
import { projectRecipeCapabilities } from "./legacy-recipe-capabilities-mcp.js";
import { legacyRecipeLazyInputs, legacyRecipeLazyOperations, type LegacyRecipeLazyOperation } from "./legacy-recipe-lazy-contracts.js";
import type { LegacyRecipeLazyRuntime } from "./legacy-recipe-lazy-runtime.js";

type Binding = Parameters<LegacyApiChatRecipes["state"]>[0];
const reads = new Set(["project.recipe.list", "project.recipe.get",
  "workflow.definition.validate", "workflow.definition.compile", "recipe.runtime.get",
  "recipe.library.state", "recipe.history.get", "recipe.compat.search", "mcp.tool.recipe_search", "mcp.tool.recipe_capabilities"]);
const mutations = new Set(["recipe.runtime.start", "recipe.runtime.cancel", "recipe.library.save"]);
export const recipePublicApprovalInput = z.strictObject({
  operation: z.literal("recipe.runtime.start"), args: nativeChatRecipeCreate,
});
export const recipePublicLazyRequest = z.strictObject({
  operation: z.enum(["mcp.tool.recipe_run_start", "mcp.tool.recipe_run_get", "mcp.tool.recipe_run_next", "mcp.tool.recipe_run_progress", "mcp.tool.recipe_run_report", "mcp.tool.recipe_run_submit_input"]),
  args: z.record(z.string(), z.json()),
});
export const recipePublicLazyApproval = recipePublicLazyRequest.extend({
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const fingerprint = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Explicit host composition only. A protocol bearer is never a native execution grant. */
export class NativeRecipePublicApi {
  private readonly approvals = new Map<string, number>();
  private readonly lazyApprovals = new Map<string, { expires: number; previewDigest: string }>();
  constructor(private readonly options: {
    recipes: LegacyApiChatRecipes; binding: Binding;
    uiApprovals?: boolean;
    lazy?: LegacyRecipeLazyRuntime;
    authorizeMutation?(request: Readonly<{ operation: string; args: Record<string, unknown>; actor: Actor }>): Promise<boolean>;
  }) {}
  owns(operation: string) {
    return reads.has(operation) || mutations.has(operation) || legacyRecipeLazyOperations.has(operation) || operation === "project.recipe.bundle.get";
  }
  lazyEnabled() { return !!this.options.lazy; }
  available(operation: string, actor?: Readonly<Actor>) {
    if (operation === "mcp.tool.recipe_run_report" && !this.options.lazy?.externalReportsEnabled()) return false;
    if (operation === "mcp.tool.recipe_run_submit_input" && !this.options.lazy?.humanGatesEnabled()) return false;
    if (operation === "project.recipe.bundle.get")
      return this.options.recipes.knowledgeEnabled() && (!actor || actor.id === this.options.binding.actorId);
    if (legacyRecipeLazyOperations.has(operation))
      return !!this.options.lazy && (!!this.options.authorizeMutation || this.options.uiApprovals === true)
        && (!actor || actor.id === this.options.binding.actorId && actor.canWrite);
    return (reads.has(operation) || mutations.has(operation) && (!!this.options.authorizeMutation
      || this.options.uiApprovals === true && operation === "recipe.runtime.start"))
      && (!actor || actor.id === this.options.binding.actorId && (!mutations.has(operation) || actor.canWrite));
  }
  private lazyRequest(value: unknown) {
    const request = recipePublicLazyRequest.parse(value);
    return { operation: request.operation, args: legacyRecipeLazyInputs[request.operation].parse(request.args) };
  }
  async previewLazy(binding: Binding, value: z.infer<typeof recipePublicLazyRequest>) {
    if (!this.options.uiApprovals || !this.options.lazy || fingerprint(binding) !== fingerprint(this.options.binding))
      throw new CoreError("ACCESS_DENIED", "Private lazy Recipe approval scope changed.");
    await this.options.recipes.catalog(binding);
    const request = this.lazyRequest(value);
    const manifest = await this.options.lazy.preview(request.operation, request.args,
      { id: binding.actorId, canWrite: true });
    return { ...request, manifest, previewDigest: fingerprint(manifest) };
  }
  async approveLazy(binding: Binding, value: z.infer<typeof recipePublicLazyApproval>) {
    const input = recipePublicLazyApproval.parse(value), preview = await this.previewLazy(binding,
      { operation: input.operation, args: input.args });
    if (preview.previewDigest !== input.previewDigest) throw new CoreError("CONFLICT", "Lazy Recipe execution changed before the exact human decision.");
    for (const [key, approval] of this.lazyApprovals) if (approval.expires <= Date.now()) this.lazyApprovals.delete(key);
    if (this.lazyApprovals.size >= 32) throw new CoreError("BUSY", "Too many pending exact lazy Recipe decisions.");
    this.lazyApprovals.set(fingerprint({ operation: preview.operation, args: preview.args, actorId: binding.actorId }),
      { expires: Date.now() + 180000, previewDigest: preview.previewDigest });
    return { operation: preview.operation, args: preview.args };
  }
  async approve(binding: Binding, value: z.infer<typeof recipePublicApprovalInput>) {
    const request = recipePublicApprovalInput.parse(value);
    if (!this.options.uiApprovals || fingerprint(binding) !== fingerprint(this.options.binding)
      || request.args.namespace !== binding.namespace || request.args.chatId !== binding.chatId)
      throw new CoreError("ACCESS_DENIED", "Private native approval scope changed.");
    const state = await this.options.recipes.state(binding);
    if (request.args.expectedDigest !== state.digest)
      throw new CoreError("CONFLICT", "Recipe changed before the native human decision.");
    for (const [key, expires] of this.approvals) if (expires <= Date.now()) this.approvals.delete(key);
    if (this.approvals.size >= 32) throw new CoreError("BUSY", "Too many pending exact native Recipe decisions.");
    this.approvals.set(fingerprint({ ...request, actorId: binding.actorId }), Date.now() + 180000);
    return structuredClone(request);
  }
  async dispatch(operation: string, args: Record<string, unknown>, actor: Actor): Promise<unknown> {
    if (!this.available(operation, actor)) throw new CoreError("ACCESS_DENIED", "No exact Recipe public host authority.");
    const binding = this.options.binding;
    if (operation === "recipe.history.get")
      return this.options.recipes.originalRun(binding, String(args.runId), String(args.expectedSha256));
    let snapshot: Awaited<ReturnType<LegacyApiChatRecipes["catalog"]>>;
    try { snapshot = await this.options.recipes.catalog(binding); }
    catch (error) { this.approvals.clear(); this.lazyApprovals.clear(); throw error; }
    if (legacyRecipeLazyOperations.has(operation)) {
      const request = this.lazyRequest({ operation, args });
      const key = fingerprint({ ...request, actorId: actor.id }), approval = this.lazyApprovals.get(key);
      this.lazyApprovals.delete(key);
      let allowed = false;
      if (approval && approval.expires > Date.now() && this.options.uiApprovals) {
        const manifest = await this.options.lazy!.preview(operation as LegacyRecipeLazyOperation, request.args, actor);
        if (fingerprint(manifest) !== approval.previewDigest)
          throw new CoreError("CONFLICT", "Exact lazy Recipe decision expired after execution/source state changed.");
        allowed = true;
      }
      if (!allowed) allowed = await this.options.authorizeMutation?.(structuredClone({ operation, args: request.args, actor })) === true;
      if (!allowed) throw new CoreError("ACCESS_DENIED", "Fresh separate host approval is required for this exact mutating legacy Recipe request, including get.");
      return this.options.lazy!.dispatch(request.operation, request.args, actor);
    }
    if (operation === "recipe.compat.search" || operation === "mcp.tool.recipe_search")
      return searchLocalRecipes(snapshot.recipes, legacyRecipeSearchInput.parse(args));
    if (operation === "mcp.tool.recipe_capabilities") {
      const capabilities = projectRecipeCapabilities(await readWorkflowCompiler(binding.root,
        { operation: "workflow.compiler.capabilities", args: {} }, [], { nativeRecipes: snapshot }), true);
      if (!this.options.lazy) return capabilities;
      const operations = [...legacyRecipeLazyOperations]
        .filter(operation => operation !== "mcp.tool.recipe_run_report" || this.options.lazy!.externalReportsEnabled())
        .filter(operation => operation !== "mcp.tool.recipe_run_submit_input" || this.options.lazy!.humanGatesEnabled());
      return { ...capabilities, legacyRecipeToolsNotProvided: capabilities.legacyRecipeToolsNotProvided
        .filter((name: string) => !operations.includes(`mcp.tool.${name}`)),
        controlledLazy: { operations, autonomous: false,
          nodeKinds: ["pkm.step.command/v1", ...(this.options.lazy.externalReportsEnabled() ? ["pkm.step.noop/v1"] : []),
            ...(this.options.lazy.humanGatesEnabled() ? ["pkm.gate.human/v1"] : [])],
          controls: ["single", ...(this.options.lazy.staticBranchesEnabled() ? ["branch"] : [])],
          externalReports: this.options.lazy.externalReportsEnabled()
            ? { resultAuthority: "external-caller-reported", automaticAgentExecution: false,
              cancellationRequested: "cooperative-progress-only-no-process-signal",
              staticBranches: this.options.lazy.staticBranchesEnabled(), ports: this.options.lazy.portedNoopsEnabled(),
              humanGates: this.options.lazy.humanGatesEnabled(),
              leaseMilliseconds: 300000 } : false,
          getIsMutation: true, cancelVia: "recipe_run_progress.cancellationRequested", restartUnknownNeverReplayed: true,
          authority: "fresh-exact-native-host-per-request", fullRecipeParity: false } };
    }
    if (operation === "recipe.library.state") return this.options.recipes.state(binding);
    if (operation === "project.recipe.list" || operation === "project.recipe.get" || operation === "project.recipe.bundle.get")
      return readProjectRecipes(binding.root, { operation, args, actorId: actor.id },
        operation === "project.recipe.bundle.get" ? await this.options.recipes.documents(binding) : [], { nativeRecipes: snapshot });
    if (operation.startsWith("workflow.definition."))
      return readWorkflowCompiler(binding.root, { operation, args } as WorkflowCompilerRequest,
        await this.options.recipes.documents(binding), { nativeRecipes: snapshot });
    if (operation === "recipe.runtime.get") {
      const state = await this.options.recipes.state(binding);
      const run = state.runs.find(row => row.runId === args.runId);
      if (!run) throw new CoreError("NOT_FOUND", "No actor-owned native Recipe intention.");
      return run;
    }
    if (args.namespace !== binding.namespace || args.chatId !== binding.chatId)
      throw new CoreError("ACCESS_DENIED", "Recipe public scope changed.");
    const key = fingerprint({ operation, args, actorId: actor.id }), expires = this.approvals.get(key) ?? 0;
    this.approvals.delete(key);
    const allowed = this.options.uiApprovals && expires > Date.now()
      || await this.options.authorizeMutation?.(structuredClone({ operation, args, actor })) === true;
    if (!allowed)
      throw new CoreError("ACCESS_DENIED", "Fresh separate host approval is required for this exact public Recipe request.");
    try {
      if (operation === "recipe.runtime.start")
        return await this.options.recipes.create(binding, nativeChatRecipeCreate.parse(args));
      if (operation === "recipe.library.save")
        return await this.options.recipes.saveLibrary(binding, nativeChatRecipeLibrary.parse(args));
      return await this.options.recipes.cancel(binding, nativeChatRecipeCancel.parse(args));
    } catch (error) {
      if (error instanceof CoreError) throw error;
      const message = error instanceof Error ? error.message : "Native Recipe request failed.";
      if (/conflict|changed|Existing Recipe intention/i.test(message))
        throw new CoreError("CONFLICT", message);
      if (/authority|approval|qualified trusted|unsupported|Knowledge bindings/i.test(message))
        throw new CoreError("ACCESS_DENIED", message);
      if (/read-only/i.test(message)) throw new CoreError("ACCESS_DENIED", message);
      if (/reused/i.test(message)) throw new CoreError("CONFLICT", message);
      throw new CoreError("RECIPE_OPERATION_UNCERTAIN", "Inspect the durable native record/intention and operation receipt; never automatically retry.", "unknown");
    }
  }
}
