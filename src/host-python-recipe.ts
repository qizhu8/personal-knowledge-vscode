import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { HostPythonScriptAdapter, compilePythonProgram, pythonProgramSchema, pythonScriptArguments,
  type PythonScriptProgram } from "./host-python-script-adapter.js";
import { verifyHostPythonHandle } from "./host-python-workflow.js";
import { nativeChatRecipeCreate, type LegacyApiChatRecipes } from "./legacy-api-chat-recipes.js";
import { RuntimeProcessService, RuntimeProcessStore } from "./runtime-process.js";
import type { WorkflowStepAdapter } from "./workflow-executor.js";

type Binding = Parameters<LegacyApiChatRecipes["state"]>[0];
export const pythonRecipeRequestSchema = z.strictObject({
  operation: z.literal("recipe.runtime.start"), args: nativeChatRecipeCreate,
});
export const pythonRecipeApprovalSchema = z.strictObject({
  request: pythonRecipeRequestSchema, manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), program: pythonProgramSchema,
});
const fingerprint = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function eligible(node: Parameters<WorkflowStepAdapter["authorizeDefinition"]>[0]["node"]) {
  return node.kind === "pkm.step.script/v1" && node.config.runtime === "python"
    && (!node.control || node.control.mode === "single") && !node.dependsOn.some(edge => edge.loop)
    && (!node.config.cwd || node.config.cwd === ".") && node.config.timeoutSeconds <= 20
    && node.config.maxOutputBytes <= 4096 && Buffer.byteLength(node.config.script) <= 16384
    && !node.config.script.includes("\0") && (node.config.args ?? []).length <= 12;
}

/** Private native composition. Neither preview, SQL metadata nor public start approval mints a Python grant. */
export class HostPythonRecipe {
  private readonly runtime: RuntimeProcessService;
  private readonly python: HostPythonScriptAdapter;
  private readonly approvals = new Map<string, { expires: number; manifest: Awaited<ReturnType<HostPythonRecipe["preview"]>>["manifest"];
    program: PythonScriptProgram }>();
  private readonly consumed = new Set<string>();
  private readonly executions = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly options: {
    database: DatabaseSync; binding: Binding; cwd: string; assertOwner(): void;
    recipes(): LegacyApiChatRecipes;
    environmentIds(): readonly string[];
    checkEnvironment(program: PythonScriptProgram): void;
    jobCreated?(runId: string, jobId: string, phase: string): void;
    recoverPreviousOwner?: string;
  }) {
    options.assertOwner();
    this.runtime = new RuntimeProcessService({
      repositoryFactory: (owner, capacity) => new RuntimeProcessStore(options.database, owner, capacity, options.recoverPreviousOwner),
      adapters: [], resolveAdapter: (id, input) => this.python?.processAdapter(id, input),
      authorizeLaunch: async request => {
        this.check();
        return request.actorId === options.binding.actorId && request.adapterId === "host-python-script";
      },
      limits: { concurrency: 1, queue: 0, stdoutBytes: 4096, stderrBytes: 1024, deadlineMs: 25000, graceMs: 100 },
    });
    this.python = new HostPythonScriptAdapter({
      workspaceId: options.binding.workspaceId, actorId: options.binding.actorId,
      workspaceRoot: options.cwd, runtime: this.runtime, check: () => this.check(),
      jobCreated: (runId, jobId, phase) => options.jobCreated?.(runId, jobId, phase),
      track: work => {
        this.executions.add(work); void work.finally(() => this.executions.delete(work)).catch(() => undefined); return work;
      },
      verifyRecipeSource: program => {
        options.checkEnvironment(program);
        const resolved = options.recipes().resolveRecipe({ kind: "recipe", recipeId: program.source.recipeId,
          expectedRevision: program.source.revision, expectedExecutableDigest: program.source.executableDigest,
          snapshotRevision: program.source.snapshotRevision });
        if (resolved.executableDigest !== program.executableDigest || fingerprint(resolved.source) !== fingerprint(program.source)
          || fingerprint(resolved.definition) !== fingerprint(program.definition)) throw new Error("Approved SQL Python Recipe source changed.");
      },
    });
  }
  private check() {
    if (this.closed) throw new Error("Native Python Recipe authority closed.");
    this.options.assertOwner();
  }
  adapter(): WorkflowStepAdapter {
    const raw = this.python.adapter();
    return { ...raw,
      // Static eligibility keeps the catalog digest stable across a separate human decision.
      // authorizeData and execute still require the exact consumed native per-run registration.
      authorizeDefinition: binding => {
        this.check();
        return binding.actorId === this.options.binding.actorId && eligible(binding.node)
          && this.options.environmentIds().includes(binding.node.kind === "pkm.step.script/v1" ? binding.node.config.environmentId ?? "" : "")
          && !!binding.source && typeof binding.source === "object" && (binding.source as { kind?: string }).kind === "recipe";
      },
    };
  }
  async preview(value: unknown) {
    this.check();
    const request = pythonRecipeRequestSchema.parse(value), binding = this.options.binding;
    if (request.args.namespace !== binding.namespace || request.args.chatId !== binding.chatId)
      throw new Error("Python Recipe namespace/Chat changed.");
    const state = await this.options.recipes().state(binding);
    if (state.digest !== request.args.expectedDigest) throw new Error("Python Recipe catalog changed before review.");
    const snapshot = await this.options.recipes().catalog(binding);
    const recipe = snapshot.recipes.find(row => row.recipeId === request.args.recipeId);
    if (!recipe) throw new Error("Python Recipe is absent.");
    const resolved = this.options.recipes().resolveRecipe({ kind: "recipe", recipeId: recipe.recipeId,
      expectedRevision: recipe.revision, expectedExecutableDigest: recipe.executableDigest, snapshotRevision: snapshot.snapshotRevision });
    const nodes = resolved.definition.spec.nodes, first = nodes[0];
    if (!first || first.kind !== "pkm.step.script/v1" || !first.config.environmentId || nodes.length > 4 || !nodes.every(node =>
      eligible(node) && node.kind === "pkm.step.script/v1" && node.config.environmentId === first.config.environmentId))
      throw new Error("SQL Recipe is not a bounded single-environment Python definition.");
    if (!this.options.environmentIds().includes(first.config.environmentId)) throw new Error("Python Recipe environment is not registered.");
    const manifest = { binding: structuredClone(binding), request, cwd: this.options.cwd,
      runId: `recipe_native_${request.args.operationId.replaceAll("-", "").toLowerCase()}`,
      source: resolved.source, executableDigest: resolved.executableDigest, definition: resolved.definition,
      inputs: request.args.inputs, environmentId: first.config.environmentId,
      steps: nodes.map(node => {
        if (node.kind !== "pkm.step.script/v1") throw new Error("Not Python.");
        return { nodeId: node.nodeId, scriptSha256: createHash("sha256").update(node.config.script).digest("hex"),
          argv: pythonScriptArguments(node, request.args.inputs) };
      }) };
    if (Buffer.byteLength(JSON.stringify(manifest)) > 49152) throw new Error("Python Recipe review exceeds its bound.");
    return { manifest: structuredClone(manifest), manifestDigest: fingerprint(manifest) };
  }
  async approve(value: unknown) {
    const input = pythonRecipeApprovalSchema.parse(value), current = await this.preview(input.request);
    if (current.manifestDigest !== input.manifestDigest) throw new Error("SQL Python Recipe manifest changed before approval.");
    const { program } = compilePythonProgram(input.program), manifest = current.manifest;
    if (program.sourceFile || program.cwd !== manifest.cwd || program.handle.environmentId !== manifest.environmentId
      || fingerprint(program.source) !== fingerprint(manifest.source) || fingerprint(program.definition) !== fingerprint(manifest.definition)
      || fingerprint(program.inputs) !== fingerprint(manifest.inputs) || program.executableDigest !== manifest.executableDigest)
      throw new Error("Exact SQL Python Recipe program/manifest binding rejected.");
    verifyHostPythonHandle(program.handle, manifest.binding.workspaceId, manifest.binding.actorId);
    this.options.checkEnvironment(program);
    for (const [runId, approval] of this.approvals) if (approval.expires <= Date.now()) this.approvals.delete(runId);
    if (this.approvals.size >= 32 || this.approvals.has(manifest.runId) || this.consumed.has(manifest.runId))
      throw new Error("Python Recipe approval is pending, consumed or at capacity.");
    this.approvals.set(manifest.runId, { expires: Date.now() + 180000, manifest, program: structuredClone(program) });
    return { runId: manifest.runId, manifestDigest: current.manifestDigest };
  }
  /** Called only by the genuine LegacyApiChatRecipes create authorization callback. */
  admit(binding: Binding, approval: unknown): boolean {
    this.check();
    const candidate = approval as { runId?: unknown };
    if (!candidate || typeof candidate.runId !== "string") return false;
    const selected = this.approvals.get(candidate.runId);
    this.approvals.delete(candidate.runId);
    if (!selected || selected.expires <= Date.now() || fingerprint(binding) !== fingerprint(this.options.binding)) return false;
    this.consumed.add(candidate.runId);
    const manifest = selected.manifest;
    if (fingerprint(approval) !== fingerprint({ runId: manifest.runId, recipeId: manifest.source.recipeId,
      revision: manifest.source.revision, executableDigest: manifest.executableDigest, source: manifest.source,
      inputs: manifest.inputs, definition: manifest.definition })) return false;
    this.options.checkEnvironment(selected.program);
    this.python.register(candidate.runId, selected.program);
    return true;
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.approvals.clear();
    await this.runtime.close({ drainMs: 0 });
    await Promise.allSettled([...this.executions]);
  }
}
