import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { readProjectRecipeSnapshot } from "./project-recipes.js";
import { readWorkflowCompiler } from "./workflow-compiler.js";
import { adapterKey, type WorkflowExecutor, type WorkflowStepAdapter } from "./workflow-executor.js";
import { assertSupportedControls } from "./domain/workflow-executor-state.js";
import type { Core } from "./core.js";
import type { WorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { NativeRecipeLibrary, recipeLibraryEditable } from "./native-recipe-library.js";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import type { MarkdownRecord } from "./markdown.js";
import { freshRecipeKnowledgeDocuments, recipeKnowledgeForNode, resolveRecipeKnowledgeContext, type RecipeKnowledgeContext } from "./recipe-knowledge-context.js";
import { originalRecipeRunSummaries, readOriginalRecipeRun } from "./legacy-recipe-run-archive.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const identity = {
  namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid(),
  operationId: z.string().uuid(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
};
export const nativeChatRecipeCreate = z.strictObject({
  ...identity, recipeId: z.string().min(1).max(256), inputs: z.record(z.string(), z.json()),
});
export const nativeChatRecipeCancel = z.strictObject({
  ...identity, runId: z.string().regex(/^recipe_native_[a-f0-9]{32}$/), expectedVersion: z.number().int().positive(),
});
export const nativeChatRecipeLibrary = z.strictObject({
  ...identity, recipeId: z.string().min(1).max(256), expectedRevision: z.number().int().nonnegative(),
  fields: recipeLibraryEditable,
});
export const nativeChatRecipeEditor = z.strictObject({
  namespace: identity.namespace, chatId: identity.chatId, recipeId: z.string().min(1).max(256),
  copy: z.boolean().optional(),
});
export const nativeChatRecipeHistory = z.strictObject({
  namespace: identity.namespace, chatId: identity.chatId,
  runId: z.string().regex(/^recipe_run_[a-f0-9]{24}$/),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type Binding = {
  root: string; workspaceId: string; actorId: string; sourceFingerprint: string; namespace: string; chatId: string;
};
type Approval = {
  runId: string; recipeId: string; revision: number; executableDigest: string;
  source: unknown; inputs: Record<string, unknown>; definition: WorkflowDefinitionV1;
};
type Grant = Approval & { binding: Binding; expires: number; knowledge?: RecipeKnowledgeContext };
type Options = {
  root: string; workspaceId: string; actorId: string; sourceFingerprint: string;
  adapters: Readonly<Record<string, WorkflowStepAdapter>>;
  assertLease(): void;
  library?: { database: DatabaseSync; fault?: ConstructorParameters<typeof NativeRecipeLibrary>[0]["fault"] };
  knowledgeDocuments?(): readonly MarkdownRecord[];
  authorize(binding: Binding, operation: "read" | "create" | "cancel" | "library-save", approval?: unknown): Promise<boolean>;
};

/** Private host-only bridge. Original run reads never call the old execution-capable getter. */
export class LegacyApiChatRecipes {
  readonly adapters: Readonly<Record<string, WorkflowStepAdapter>>;
  private readonly grants = new Map<string, Grant>();
  private runtime?: { core: Pick<Core, "dispatch">; workflow: WorkflowExecutor };
  private closed = false;
  private readonly library?: NativeRecipeLibrary;
  constructor(private readonly options: Options) {
    if (options.library) this.library = new NativeRecipeLibrary({ ...options.library,
      workspaceId: options.workspaceId, assertLease: options.assertLease,
      original: () => readProjectRecipeSnapshot(options.root) });
    this.adapters = Object.fromEntries(Object.entries(options.adapters).map(([key, adapter]) => [key, {
      ...adapter,
      authorizeDefinition: binding => binding.source !== null && typeof binding.source === "object"
        && (binding.source as { kind?: string }).kind === "recipe"
        && [...this.grants.values()].some(grant => this.matches(grant, binding))
        && adapter.authorizeDefinition(binding) === true,
      authorizeData: binding => [...this.grants.values()].some(grant => this.matches(grant, binding)
        && digest(grant.inputs) === digest(binding.inputs))
        && (!adapter.authorizeData || adapter.authorizeData(binding) === true),
      execute: async (invocation, context) => {
        this.options.assertLease();
        const grant = this.grants.get(invocation.runId);
        if (!grant || !this.matches(grant, invocation) || digest(grant.inputs) !== digest(invocation.inputs)
          || context.signal.aborted) throw new Error("Recipe execution has no fresh exact run authority.");
        const snapshot = this.source();
        if (snapshot.snapshotRevision !== (grant.source as { snapshotRevision: string }).snapshotRevision)
          throw new Error("Original Recipe source changed after approval.");
        const enriched = grant.knowledge
          ? { ...invocation, recipeKnowledge: recipeKnowledgeForNode(structuredClone(grant.knowledge), invocation.node.nodeId) } : invocation;
        return adapter.execute(enriched, context);
      },
    } satisfies WorkflowStepAdapter]));
  }
  bindRuntime(core: Pick<Core, "dispatch">, workflow: WorkflowExecutor) {
    if (this.runtime || this.closed) throw new Error("Recipe runtime already bound or closed.");
    this.options.assertLease();
    for (const run of workflow.list(this.options.actorId))
      if (/^recipe_native_[a-f0-9]{32}$/.test(run.runId) && ["ready", "running"].includes(run.state))
        workflow.interruptHostOwnedRun(this.options.actorId, run.runId);
    this.runtime = { core, workflow };
  }
  private matches(grant: Grant, binding: { actorId: string; executableDigest: string; source?: unknown }) {
    const matches = !this.closed && grant.expires > Date.now() && grant.binding.actorId === binding.actorId
      && grant.executableDigest === binding.executableDigest
      && (binding.source === undefined || digest(grant.source) === digest(binding.source));
    if (!matches || !grant.knowledge) return matches;
    try {
      const recipe = this.source().recipes.find(row => row.recipeId === grant.recipeId);
      return !!recipe && this.knowledge(recipe)?.digest === grant.knowledge.digest;
    } catch { return false; }
  }
  private source() {
    this.options.assertLease();
    return this.library?.snapshot() ?? readProjectRecipeSnapshot(this.options.root);
  }
  async catalog(binding: Binding) {
    await this.authorize(binding, "read");
    return this.source();
  }
  knowledgeEnabled() { return !!this.options.knowledgeDocuments; }
  async documents(binding: Binding) {
    await this.authorize(binding, "read");
    return freshRecipeKnowledgeDocuments(this.options.root, this.options.knowledgeDocuments?.() ?? []);
  }
  async originalRun(binding: Binding, runId: string, expectedSha256: string) {
    await this.authorize(binding, "read");
    const result = readOriginalRecipeRun(this.options.root, runId, expectedSha256);
    this.options.assertLease();
    return result;
  }
  private knowledge(recipe: ReturnType<LegacyApiChatRecipes["source"]>["recipes"][number]) {
    if (!recipe.nodeBindings?.some(node => node.bindings.length)) return undefined;
    if (!this.options.knowledgeDocuments)
      throw new Error("Recipe Knowledge bindings require an explicitly scoped host document authority.");
    return resolveRecipeKnowledgeContext(this.options.root, recipe, this.options.knowledgeDocuments());
  }
  resolveRecipe = (source: unknown) => {
    if (!this.library || !source || typeof source !== "object") throw new Error("No native Recipe library source resolver.");
    const ref = source as Record<string, unknown>, snapshot = this.source();
    const recipe = snapshot.recipes.find(row => row.recipeId === ref.recipeId);
    if (ref.kind !== "recipe" || !recipe || ref.snapshotRevision !== snapshot.snapshotRevision
      || ref.expectedRevision !== recipe.revision || ref.expectedExecutableDigest !== recipe.executableDigest)
      throw new Error("Native Recipe source revision/digest conflict.");
    const knowledge = this.knowledge(recipe);
    const compiled = compileWorkflowDefinitionV1(recipe.definition);
    if (!compiled.ok || compiled.executableDigest !== recipe.executableDigest) throw new Error("Damaged native Recipe definition.");
    return { status: "valid", executableDigest: compiled.executableDigest, definition: compiled.model,
      ...(knowledge ? { recipeKnowledge: knowledge } : {}),
      source: { kind: "recipe", recipeId: recipe.recipeId, revision: recipe.revision,
        executableDigest: recipe.executableDigest, snapshotRevision: snapshot.snapshotRevision } };
  };
  private async authorize(binding: Binding, operation: "read" | "create" | "cancel" | "library-save", approval?: unknown) {
    this.options.assertLease();
    if (this.closed || !this.runtime || binding.root !== this.options.root || binding.actorId !== this.options.actorId
      || binding.workspaceId !== this.options.workspaceId || binding.sourceFingerprint !== this.options.sourceFingerprint
      || await this.options.authorize(structuredClone(binding), operation, approval && structuredClone(approval)) !== true)
      throw new Error("Recipe operation requires fresh exact private host authority.");
    this.options.assertLease();
    if (this.closed) throw new Error("Recipe authority closed during approval.");
  }
  async state(binding: Binding) {
    await this.authorize(binding, "read");
    const snapshot = this.source();
    const recipes = snapshot.recipes.map(recipe => {
      let available = false;
      let knowledge: RecipeKnowledgeContext | undefined;
      try {
        const compiled = compileWorkflowDefinitionV1(recipe.definition);
        if (!compiled.ok) throw new Error("Invalid original Recipe definition.");
        assertSupportedControls(compiled.model);
        knowledge = this.knowledge(recipe);
        if (knowledge && !this.library) throw new Error("Bound Recipe execution requires the native Library source resolver.");
        available = compiled.model.spec.nodes.every(node => {
          const adapter = this.options.adapters[adapterKey(node)];
          return !!adapter && adapter.authorizeDefinition({ actorId: binding.actorId, executableDigest: recipe.executableDigest,
            source: { kind: "recipe", recipeId: recipe.recipeId, revision: recipe.revision,
              executableDigest: recipe.executableDigest, snapshotRevision: snapshot.snapshotRevision }, node }) === true;
        });
      } catch { /* Unsupported original controls remain unavailable, never approximated. */ }
      return { recipeId: recipe.recipeId, name: recipe.name, revision: recipe.revision,
        executableDigest: recipe.executableDigest, available, ...(available ? { definition: recipe.definition,
          ...(knowledge ? { recipeKnowledge: knowledge } : {}) } : {}) };
    });
    const originalRuns = originalRecipeRunSummaries(this.options.root);
    const runs = this.runtime!.workflow.list(binding.actorId).filter(run => /^recipe_native_[a-f0-9]{32}$/.test(run.runId));
    return { digest: digest({ binding,
      snapshotRevision: snapshot.snapshotRevision, recipes, originalRuns }), recipes, originalRuns, runs,
      libraryEnabled: !!this.library, execution: "explicit-native-adapters-only", replay: "never" };
  }
  async editor(binding: Binding, input: z.infer<typeof nativeChatRecipeEditor>) {
    nativeChatRecipeEditor.parse(input);
    if (input.namespace !== binding.namespace || input.chatId !== binding.chatId) throw new Error("Recipe editor scope changed.");
    await this.authorize(binding, "read");
    if (!this.library) throw new Error("Native library authoring is not installed.");
    const recipe = input.copy ? this.library.draft(input.recipeId)
      : this.source().recipes.find(row => row.recipeId === input.recipeId);
    if (!recipe) throw new Error("Recipe no longer exists.");
    try { return { recipe, digest: (await this.state(binding)).digest }; }
    catch { throw new CoreError("RECIPE_OPERATION_UNCERTAIN", "Native Recipe committed; inspect its durable operation receipt before any retry.", "unknown"); }
  }
  async validateLibrary(binding: Binding, definition: unknown) {
    await this.authorize(binding, "read");
    if (!this.library) throw new Error("Native library authoring is not installed.");
    return this.library.validate(definition);
  }
  async saveLibrary(binding: Binding, value: z.infer<typeof nativeChatRecipeLibrary>) {
    const input = nativeChatRecipeLibrary.parse(value);
    if (input.namespace !== binding.namespace || input.chatId !== binding.chatId) throw new Error("Recipe library scope changed.");
    await this.authorize(binding, "library-save", input);
    if (!this.library) throw new Error("Native library authoring is not installed.");
    const state = await this.state(binding);
    if (input.expectedDigest !== state.digest) throw new Error("Recipe source conflict; reload before saving.");
    const recipe = this.library.save({ actorId: binding.actorId, operationId: input.operationId,
      recipeId: input.recipeId, expectedRevision: input.expectedRevision,
      expectedSnapshot: this.source().snapshotRevision, fields: input.fields });
    return { recipe, digest: (await this.state(binding)).digest };
  }
  async create(binding: Binding, value: z.infer<typeof nativeChatRecipeCreate>) {
    const input = nativeChatRecipeCreate.parse(value), state = await this.state(binding);
    if (input.namespace !== binding.namespace || input.chatId !== binding.chatId || input.expectedDigest !== state.digest)
      throw new Error("Original Recipe scope or snapshot changed.");
    const snapshot = this.source(), recipe = snapshot.recipes.find(recipe => recipe.recipeId === input.recipeId);
    if (!recipe || !state.recipes.find(item => item.recipeId === recipe.recipeId)?.available)
      throw new Error("Original Recipe has no qualified trusted native adapter.");
    const source = { kind: "recipe" as const, recipeId: recipe.recipeId, expectedRevision: recipe.revision,
      expectedExecutableDigest: recipe.executableDigest, snapshotRevision: snapshot.snapshotRevision };
    const compiled = (this.library ? this.resolveRecipe(source)
      : readWorkflowCompiler(this.options.root, { operation: "workflow.definition.compile", args: { source } })) as {
      status: string; executableDigest: string; definition: WorkflowDefinitionV1; source: unknown;
    };
    if (compiled.status !== "valid") throw new Error("Original Recipe compilation failed.");
    const runId = `recipe_native_${input.operationId.replaceAll("-", "").toLowerCase()}`;
    if (state.runs.some(run => run.runId === runId)) throw new Error("Existing Recipe intention must be read, never automatically recreated.");
    const approval: Approval = { runId, recipeId: recipe.recipeId, revision: recipe.revision,
      executableDigest: compiled.executableDigest, source: compiled.source, inputs: input.inputs, definition: compiled.definition };
    await this.authorize(binding, "create", approval);
    if ((await this.state(binding)).digest !== input.expectedDigest) throw new Error("Original Recipe changed during approval.");
    const knowledge = this.knowledge(recipe);
    this.grants.set(runId, { ...structuredClone(approval), binding: structuredClone(binding), expires: Date.now() + 900_000,
      ...(knowledge ? { knowledge } : {}) });
    try {
      const response = await this.runtime!.core.dispatch("capability_call", { operation: "workflow.executor.create", version: 1,
        arguments: { operationId: input.operationId, runId, source, expectedExecutableDigest: compiled.executableDigest,
          deadline: Date.now() + 900_000, inputs: input.inputs } }, { id: binding.actorId, canWrite: true });
      if (response.error) throw new CoreError(response.error.code, `Native Recipe create failed: ${response.error.code}`, response.error.effect);
      return this.runtime!.workflow.get(binding.actorId, runId);
    } catch (error) {
      this.grants.delete(runId);
      throw error;
    }
  }
  async cancel(binding: Binding, value: z.infer<typeof nativeChatRecipeCancel>) {
    const input = nativeChatRecipeCancel.parse(value), state = await this.state(binding);
    if (input.namespace !== binding.namespace || input.chatId !== binding.chatId || input.expectedDigest !== state.digest
      || !state.runs.some(run => run.runId === input.runId)) throw new Error("Recipe cancellation scope changed.");
    await this.authorize(binding, "cancel", { runId: input.runId, expectedVersion: input.expectedVersion });
    if ((await this.state(binding)).digest !== input.expectedDigest) throw new Error("Original Recipe changed during approval.");
    const response = await this.runtime!.core.dispatch("capability_call", { operation: "workflow.executor.cancel", version: 1,
      arguments: { operationId: input.operationId, runId: input.runId, expectedVersion: input.expectedVersion } },
    { id: binding.actorId, canWrite: true });
    if (response.error) throw new CoreError(response.error.code, `Native Recipe cancel failed: ${response.error.code}`, response.error.effect);
    this.grants.delete(input.runId);
    return this.runtime!.workflow.get(binding.actorId, input.runId);
  }
  close() { this.closed = true; this.grants.clear(); this.library?.close(); }
}
