import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { z } from "zod";
import { canonicalJson, compileWorkflowDefinitionV1, HUMAN_GATE_NODE_KIND, type WorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { WorkflowExecutor, adapterKey, type WorkflowStepAdapter } from "./workflow-executor.js";
import { dependencyState } from "./domain/workflow-executor-state.js";
import { originalRecipeLoops } from "./domain/workflow-executor-original-loops.js";
import type { LegacyApiChatRecipes } from "./legacy-api-chat-recipes.js";
import { legacyRecipeLazyInputs, type LegacyRecipeLazyOperation } from "./legacy-recipe-lazy-contracts.js";
import type { LegacyRecipeExternalReports } from "./legacy-recipe-external-reports.js";
import { legacyExternalReportOutcomes } from "./legacy-recipe-external-reports.js";
import { addReportedRecipeUsage, assertReportedRecipeNumbers, parseReportedRecipeUsage, reportedRecipeUsageSummary, type ReportedRecipeUsage } from "./legacy-recipe-reported-usage.js";
import type { WorkflowRuntimeBindings } from "./domain/workflow-executor-bindings.js";
import { normalizeLegacyRecipeInputs } from "./domain/legacy-recipe-run-inputs.js";
import { controlledLegacyRecipeCapabilities } from "./legacy-recipe-capabilities-mcp.js";

type Json = Record<string, unknown>;
type View = ReturnType<WorkflowExecutor["get"]>;
type HumanInput = { outcome: string; response: object; outputs: Record<string, unknown> };
type NodeRecord = { state: string; outcome?: string; result?: unknown; error?: string | null; externalReport?: { outcome: string; result: unknown; error: string }; humanInput?: HumanInput; challengeId?: string; progress?: Json; startedAt?: string; lastHeartbeatAt?: string; lastProgressAt?: string };
const automationSchema = z.strictObject({
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled", "budget-exceeded", "interrupted"]),
  maxNodes: z.number().safe().int().min(1).max(1000), startedNodes: z.number().safe().int().min(0).max(1000),
  deadlineAt: z.iso.datetime({ offset: true }), cancellationRequested: z.boolean(),
  stopReason: z.string().optional(), waitingOn: z.string().optional(),
});
type Automation = z.infer<typeof automationSchema>;
const automaticNode = (kind: string) => kind === "pkm.step.command/v1" || kind === "pkm.step.script/v1";
const automationStopped = (automation?: Automation) => !!automation && !["running", "waiting"].includes(automation.status);
type Run = {
  runId: string; recipeId: string; revision: number; executableDigest: string; source: unknown;
  projectId: string; definition: WorkflowDefinitionV1; inputs: Json; version: number;
  observed: string; nodes: Record<string, NodeRecord>; unknown: boolean; progress: Record<string, Json>;
  reportedUsage?: ReportedRecipeUsage;
  automation?: Automation;
};
type Catalog = Awaited<ReturnType<LegacyApiChatRecipes["catalog"]>>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const runId = (command: string) => "recipe_run_" + createHash("sha256").update(command).digest("hex").slice(0, 24);
const operationId = (actor: string, command: string) => {
  const hex = hash({ actor, command });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const jsonObject = (text: string, field: string) => {
  let value: unknown;
  try { value = JSON.parse(text || "{}"); } catch (error) {
    throw new Error(`${field} must be valid JSON: ${error instanceof Error ? error.message : "Invalid JSON"}`);
  }
  if (!object(value)) throw new Error(`${field} must decode to dict`);
  return value;
};
const responseDetail = (value: string, fallback: string) => {
  const result = (value || fallback).trim().toLowerCase();
  if (result !== "compact" && result !== "full") throw new Error("detail must be compact or full.");
  return result;
};
const progressStrings = new Set(["phase", "message", "checkpoint", "nextStep", "waitingOn", "currentValidation"]);
const progressNumbers = new Set(["completed", "total", "etaSeconds", "staleAfterSeconds", "toolCallCount"]);
const progressBooleans = new Set(["safeToInterrupt", "cancellationRequested"]);
function parseProgress(text: string) {
  const value = jsonObject(text, "progress_json");
  for (const [key, item] of Object.entries(value)) {
    if (progressStrings.has(key)) {
      if (typeof item !== "string") throw new Error(`${key} must be a string.`);
    } else if (progressNumbers.has(key)) {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0) throw new Error(`${key} must be a non-negative number.`);
    } else if (progressBooleans.has(key)) {
      if (typeof item !== "boolean") throw new Error(`${key} must be a boolean.`);
    } else if (key === "events") {
      if (!Array.isArray(item) || item.some(event => !object(event) || typeof event.message !== "string"))
        throw new Error("events must be an array of objects with message.");
    } else if (key === "sideEffects") {
      if (!Array.isArray(item) || item.some(effect => typeof effect !== "string"))
        throw new Error("sideEffects must be an array of strings.");
    } else if (key !== "progressed") throw new Error(`progress_json contains unknown fields: ${key}.`);
  }
  return value;
}
export const legacyRecipeLazyDdl = `
        CREATE TABLE IF NOT EXISTS legacy_recipe_lazy_runs(
          actor_id TEXT NOT NULL,run_id TEXT NOT NULL,binding TEXT NOT NULL,version INTEGER NOT NULL,
          record TEXT NOT NULL,PRIMARY KEY(actor_id,run_id));
        CREATE TABLE IF NOT EXISTS legacy_recipe_lazy_receipts(
          actor_id TEXT NOT NULL,run_id TEXT NOT NULL,command_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,response TEXT,PRIMARY KEY(actor_id,run_id,command_id));`;
  const storedRun = z.strictObject({
    runId: z.string().regex(/^recipe_run_[a-f0-9]{24}$/), recipeId: z.string().min(1),
    revision: z.number().safe().int().positive(), executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.json(), projectId: z.string(), definition: z.unknown(), inputs: z.record(z.string(), z.json()),
    version: z.number().safe().int().positive(), observed: z.string().regex(/^[a-f0-9]{64}$/),
    unknown: z.boolean(), progress: z.record(z.string(), z.record(z.string(), z.json())),
    nodes: z.record(z.string(), z.strictObject({
      state: z.string().min(1), outcome: z.string().optional(), result: z.json().optional(), error: z.string().nullable().optional(),
      externalReport: z.strictObject({ outcome: z.string(), result: z.json(), error: z.string() }).optional(),
      humanInput: z.strictObject({ outcome: z.string(), response: z.record(z.string(), z.json()), outputs: z.record(z.string(), z.json()) }).optional(),
      challengeId: z.string().optional(), progress: z.record(z.string(), z.json()).optional(),
      startedAt: z.string().optional(), lastHeartbeatAt: z.string().optional(), lastProgressAt: z.string().optional(),
    })), reportedUsage: z.json().optional(),
  });
  export function parseLegacyRecipeLazyRun(value: string) {
    if (Buffer.byteLength(value) > 1_048_576) throw new Error("Legacy lazy record byte budget exceeded.");
    const parsed = storedRun.parse(JSON.parse(value)), compiled = compileWorkflowDefinitionV1(parsed.definition);
    if (!compiled.ok || compiled.executableDigest !== parsed.executableDigest
      || canonicalJson(Object.keys(parsed.nodes).sort()) !== canonicalJson(compiled.model.spec.nodes.map(node => node.nodeId).sort()))
      throw new Error("Legacy lazy definition or node identity changed.");
    assertReportedRecipeNumbers(parsed, "Legacy lazy record");
    return parsed as Run;
  }
/**
 * Host-only bridge: protocol receipts are not an execution journal. Assignment,
 * lease, authority, result fencing and recovery belong to WorkflowExecutor.
 */
export class LegacyRecipeLazyRuntime {
  private readonly workflow: WorkflowExecutor;
  private closed = false;
  private readonly work = new Map<string, Promise<View | undefined>>();
  private readonly subflowCreation = new Map<string, Promise<string>>();
  private readonly subflowPending = new Map<string, {
    childRunId: string; invocationId: string; complete(result: Awaited<ReturnType<WorkflowStepAdapter["execute"]>>): void;
  }>();
  private readonly automationWork = new Map<string, Promise<{ state: View; dispatch: boolean }>>();
  private readonly adapters: Readonly<Record<string, WorkflowStepAdapter>>;
  constructor(private readonly database: DatabaseSync, private readonly options: {
    actorId: string; root: string; bindingFingerprint: string; ownerId: string;
    adapters: Readonly<Record<string, WorkflowStepAdapter>>;
    catalog(): Promise<Catalog>;
    resolveRecipe: NonNullable<ConstructorParameters<typeof WorkflowExecutor>[1]["resolveRecipe"]>;
    assertOwner(): void;
    requestCancel(request: Readonly<{ runId: string; nodeId: string }>): void | Promise<void>;
    externalReports?: LegacyRecipeExternalReports;
    originalRecipeMetadata?: true;
    runtimeBindings?: WorkflowRuntimeBindings;
    knowledgeForNode?(nodeId: string, recipeId: string): unknown[];
    publicDefinition?: unknown;
    publicExecutableDigest?: string;
    publicDefinitionForRecipe?(recipeId: string): unknown;
    publicExecutableDigestForRecipe?(recipeId: string): string | undefined;
    subflows?: {
      authorizeDefinition: WorkflowStepAdapter["authorizeDefinition"];
      authorizeData: NonNullable<WorkflowStepAdapter["authorizeData"]>;
    };
  }) {
    options.assertOwner();
    database.exec(legacyRecipeLazyDdl);
    if (options.externalReports && options.adapters["pkm.step.noop/v1"])
      throw new Error("External report ownership cannot replace an existing NoOp adapter.");
    if (options.externalReports?.humanGatesEnabled() && options.adapters[HUMAN_GATE_NODE_KIND])
      throw new Error("Human gate ownership cannot replace an existing adapter.");
    if (options.subflows && (!options.originalRecipeMetadata || options.adapters["pkm.subflow/v1"]))
      throw new Error("Subflows require original metadata and one exact host-owned adapter.");
    const adapters = { ...options.adapters,
      ...(options.externalReports ? { "pkm.step.noop/v1": options.externalReports.adapter } : {}),
      ...(options.externalReports?.humanGatesEnabled() ? { [HUMAN_GATE_NODE_KIND]: options.externalReports.adapter } : {}),
      ...(options.subflows ? { "pkm.subflow/v1": this.subflowAdapter() } : {}) };
    this.adapters = adapters;
    this.workflow = new WorkflowExecutor(database, {
      workspaceRoot: options.root, ownerId: options.ownerId, adapters: this.adapters,
      ...(options.externalReports ? { leaseMs: 300_000 } : {}),
      resolveRecipe: options.resolveRecipe, assertOwner: options.assertOwner,
    });
    for (const row of database.prepare("SELECT run_id FROM legacy_recipe_lazy_runs WHERE actor_id=? AND binding=?")
      .all(options.actorId, options.bindingFingerprint) as { run_id: string }[]) {
      const state = this.workflow.get(options.actorId, row.run_id);
      if (state.dispatchMode !== "explicit") throw new Error("Legacy lazy dispatch ownership changed.");
      if (state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state)))
        this.workflow.interruptHostOwnedRun(options.actorId, row.run_id);
      const run = this.load(row.run_id);
      const recovered = this.workflow.get(options.actorId, row.run_id);
      if (run.automation && !automationStopped(run.automation)) this.atomic(() => {
        const previous = run.version;
        this.sync(run, recovered);
        run.automation!.status = "interrupted";
        run.automation!.stopReason = "host-restart-no-replay";
        this.fenceStoppedAutomation(run, recovered);
        run.version++; this.save(run, previous);
      });
    }
  }
  externalReportsEnabled() { return !!this.options.externalReports; }
  staticBranchesEnabled() { return this.options.externalReports?.staticBranchesEnabled() === true; }
  portedNoopsEnabled() { return this.options.externalReports?.portedNoopsEnabled() === true; }
  humanGatesEnabled() { return this.options.externalReports?.humanGatesEnabled() === true; }
  controlledCapabilities() {
    return controlledLegacyRecipeCapabilities(Object.keys(this.adapters),
      this.options.originalRecipeMetadata ? "original-recipe-metadata/v1"
        : this.options.runtimeBindings ? "pkm.workflow.runtime-controls/v1" : "single-dispatch");
  }
  sourceInputs(runId: string) { this.assert(); return structuredClone(this.load(runId).inputs); }
  recipeIdForRun(runId: string) { this.assert(); return this.load(runId).recipeId; }
  outputs(runId: string) { this.assert(); return this.workflow.outputs(this.options.actorId, runId); }
  private subflowAdapter(): WorkflowStepAdapter {
    return {
      id: "original-native-pinned-subflow", version: 1,
      authorizationDigest: hash({ binding: this.options.bindingFingerprint, protocol: "pinned-explicit-child/v1" }),
      outputContractDigest: hash({ contract: "original-child-current-result/v1" }),
      authorizeDefinition: binding => binding.node.kind === "pkm.subflow/v1"
        && this.options.subflows!.authorizeDefinition(binding),
      authorizeData: binding => binding.node.kind === "pkm.subflow/v1"
        && this.options.subflows!.authorizeData(binding),
      validateOutput: outputs => Object.hasOwn(outputs, "result") && typeof outputs.reportedError === "string"
        && Object.keys(outputs).every(key => key === "result" || key === "reportedError"),
      execute: (invocation, { signal }) => new Promise(resolve => {
        if (signal.aborted || this.subflowCreation.has(invocation.runId) || this.subflowPending.has(invocation.runId)) {
          resolve(undefined); return;
        }
        const abort = () => {
          this.subflowPending.delete(invocation.runId); resolve(undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        const creating = this.createSubflowChild(invocation, signal);
        this.subflowCreation.set(invocation.runId, creating);
        void creating.then(childRunId => {
          if (signal.aborted) { abort(); return; }
          this.subflowPending.set(invocation.runId, { childRunId, invocationId: invocation.invocationId,
            complete: result => {
              this.subflowPending.delete(invocation.runId);
              signal.removeEventListener("abort", abort); resolve(result);
            } });
        }).catch(() => {
          signal.removeEventListener("abort", abort); resolve(undefined);
        }).finally(() => {
          if (this.subflowCreation.get(invocation.runId) === creating) this.subflowCreation.delete(invocation.runId);
        });
      }),
    };
  }
  private async createSubflowChild(invocation: Readonly<import("./workflow-executor.js").WorkflowInvocation>, signal: AbortSignal) {
    this.assert();
    const parent = this.load(invocation.runId), catalog = await this.options.catalog();
    this.assert();
    if (signal.aborted || invocation.node.kind !== "pkm.subflow/v1")
      throw new CoreError("ACCESS_DENIED", "Subflow parent invocation is no longer current.");
    const config = invocation.node.config;
    const recipe = catalog.recipes.find(recipe => recipe.recipeId === config.recipeId);
    if (!recipe || recipe.revision !== config.revision || recipe.executableDigest !== config.executableDigest)
      throw new CoreError("ACCESS_DENIED", "Exact reachable subflow Recipe revision/digest changed.");
    const compiled = compileWorkflowDefinitionV1(recipe.definition);
    if (!compiled.ok || compiled.executableDigest !== recipe.executableDigest)
      throw new CoreError("ACCESS_DENIED", "Exact subflow Recipe definition is invalid.");
    const id = runId(`${parent.runId}:${invocation.node.nodeId}:${invocation.iteration + 1}`);
    const deadline = this.workflow.get(this.options.actorId, parent.runId).deadline;
    this.atomic(() => {
      const state = this.workflow.createHostOwnedSubflowChildInTransaction(this.options.actorId,
        parent.runId, invocation.invocationId, {
          runId: id, operationId: operationId(this.options.actorId, id), source: {
            kind: "recipe", recipeId: recipe.recipeId, expectedRevision: recipe.revision,
            expectedExecutableDigest: recipe.executableDigest, snapshotRevision: catalog.snapshotRevision,
          }, expectedExecutableDigest: recipe.executableDigest, inputs: parent.inputs as never,
          deadline,
        }, { recipeId: recipe.recipeId, revision: recipe.revision, executableDigest: recipe.executableDigest,
          compiledExecutableDigest: recipe.executableDigest });
      const child: Run = { runId: id, recipeId: recipe.recipeId, revision: recipe.revision,
        executableDigest: recipe.executableDigest, source: state.source,
        definition: recipe.definition as unknown as WorkflowDefinitionV1,
        inputs: structuredClone(parent.inputs), projectId: parent.projectId, version: 1,
        observed: hash({ state: state.state, nodes: state.nodes }), unknown: false, progress: {},
        nodes: Object.fromEntries(compiled.model.spec.nodes.map(node => [node.nodeId, { state: "pending" }])) };
      this.database.prepare("INSERT INTO legacy_recipe_lazy_runs VALUES(?,?,?,?,?)")
        .run(this.options.actorId, id, this.options.bindingFingerprint, 1, this.protocolRecord(child));
    });
    return id;
  }
  private async synchronizeSubflows(id: string): Promise<void> {
    const pending = this.subflowPending.get(id);
    if (!pending) return;
    await this.synchronizeSubflows(pending.childRunId);
    const state = this.workflow.get(this.options.actorId, pending.childRunId);
    const child = this.atomic(() => {
      const child = this.load(pending.childRunId), previous = child.version;
      if (this.sync(child, state)) { child.version++; this.save(child, previous); }
      return child;
    });
    if (child.unknown || state.state === "unknown") {
      this.workflow.interruptHostOwnedRun(this.options.actorId, id);
      return;
    }
    if (!["succeeded", "failed", "cancelled"].includes(state.state)) return;
    const response = this.response(child, "full");
    const success = state.state === "succeeded" && response.status === "completed";
    pending.complete({ status: success ? "succeeded" : "failed", outputs: {
      result: { child_run_id: child.runId, ...(success ? { child_result: response.current_result } : {}) },
      reportedError: success ? "" : "Pinned sub-Recipe run failed.",
    } });
    await this.work.get(id);
  }
  private assert(actor?: Readonly<Actor>) {
    this.options.assertOwner();
    if (this.closed || actor && (actor.id !== this.options.actorId || !actor.canWrite))
      throw new CoreError("ACCESS_DENIED", "Exact writable legacy Recipe host authority required.");
  }
  private atomic<T>(action: () => T): T {
    this.assert();
    if (this.database.isTransaction) throw new Error("Lazy protocol transaction already open.");
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.options.assertOwner(); this.database.exec("COMMIT"); return result; }
    catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  private load(id: string) {
    const row = this.database.prepare("SELECT binding,record FROM legacy_recipe_lazy_runs WHERE actor_id=? AND run_id=?")
      .get(this.options.actorId, id) as { binding: string; record: string } | undefined;
    if (!row) throw new Error("Recipe run was not found.");
    if (row.binding !== this.options.bindingFingerprint) throw new CoreError("ACCESS_DENIED", "Legacy run root/source/actor binding changed.");
    const run = parseLegacyRecipeLazyRun(row.record);
    const control = this.workflow.hostControl(this.options.actorId, id, "legacy-recipe-automation");
    if (control !== undefined) {
      const value = z.strictObject({ schema: z.literal("pkm.recipe.automation/v1"), automation: automationSchema }).parse(control);
      if (value.automation.startedNodes > value.automation.maxNodes) throw new Error("Automation node budget changed.");
      run.automation = value.automation;
    }
    return run;
  }
  private protocolRecord(run: Run) {
    const { automation: _automation, ...record } = run;
    return JSON.stringify(record);
  }
  recordNativeEffectApproval(runId: string, invocationId: string, metadata: unknown) {
    this.options.assertOwner();
    this.atomic(() => {
      this.load(runId);
      this.workflow.recordNativeEffectApprovalInTransaction(this.options.actorId, runId, invocationId, metadata);
    });
  }
  private saveAutomation(run: Run) {
    if (!run.automation) return;
    const control = { schema: "pkm.recipe.automation/v1", automation: run.automation };
    if (canonicalJson(this.workflow.hostControl(this.options.actorId, run.runId, "legacy-recipe-automation") ?? null) !== canonicalJson(control))
      this.workflow.recordHostControlInTransaction(this.options.actorId, run.runId, "legacy-recipe-automation", control);
  }
  private fenceStoppedAutomation(run: Run, state: View) {
    if (!automationStopped(run.automation) || !["ready", "running"].includes(state.state)) return;
    this.workflow.cancelInTransaction(this.options.actorId, {
      runId: run.runId, operationId: randomUUID(), expectedVersion: state.version,
    });
  }
  private save(run: Run, previous: number) {
    if (Buffer.byteLength(JSON.stringify(run)) > 1_048_576) throw new Error("Legacy lazy record byte budget exceeded.");
    const result = this.database.prepare("UPDATE legacy_recipe_lazy_runs SET version=?,record=? WHERE actor_id=? AND run_id=? AND version=? AND binding=?")
      .run(run.version, this.protocolRecord(run), this.options.actorId, run.runId, previous, this.options.bindingFingerprint);
    if (result.changes !== 1) throw new CoreError("CONFLICT", "Legacy run changed concurrently.");
    this.saveAutomation(run);
  }
  private receipt(id: string, command: string, fingerprint: string, uncertainCode = "recipe-run-next-failed") {
    if (!command.trim()) throw new Error("command_id is required.");
    const row = this.database.prepare("SELECT fingerprint,response FROM legacy_recipe_lazy_receipts WHERE actor_id=? AND run_id=? AND command_id=?")
      .get(this.options.actorId, id, command) as { fingerprint: string; response: string | null } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("command_id was reused with different parameters.");
    if (row.response === null) return { schema: "pkm.recipe.api/v1", ok: false, replayed: true, effect: "unknown",
      error: { code: uncertainCode, message: "Prior dispatch acknowledgment is unknown; inspect durable run; never replay." } };
    const response = JSON.parse(row.response) as Json;
    const current = response.current_result;
    if (object(current) && Array.isArray(current.completed_nodes)) {
      const run = this.load(id);
      for (const item of current.completed_nodes) if (object(item) && item.result_omitted) {
        delete item.result_omitted;
        const node = run.nodes[String(item.node_id)];
        if (node && Object.hasOwn(node, "result")) item.result = node.result;
        else item.result_omitted = true;
      }
    }
    return { ...response, replayed: true };
  }
  private storeReceipt(id: string, command: string, fingerprint: string, response: Json | null) {
    const compact = response === null ? null : structuredClone(response);
    if (compact && object(compact.current_result)) {
      const current = compact.current_result;
      if (Array.isArray(current.completed_nodes)) for (const item of current.completed_nodes) if (object(item)) {
        if (item.result !== null && item.result !== undefined) item.result_omitted = true;
        delete item.result;
      }
      if (object(current.running_progress) && object(current.running_progress.progress)
        && Array.isArray(current.running_progress.progress.events))
        current.running_progress.progress.events = current.running_progress.progress.events.slice(-3);
    }
    this.database.prepare("INSERT INTO legacy_recipe_lazy_receipts VALUES(?,?,?,?,?) ON CONFLICT(actor_id,run_id,command_id) DO UPDATE SET response=excluded.response WHERE fingerprint=excluded.fingerprint")
      .run(this.options.actorId, id, command, fingerprint, compact === null ? null : JSON.stringify(compact));
    const rows = this.database.prepare("SELECT rowid,command_id,response FROM legacy_recipe_lazy_receipts WHERE actor_id=? AND run_id=? ORDER BY rowid")
      .all(this.options.actorId, id) as { rowid: number; command_id: string; response: string | null }[];
    let bytes = rows.reduce((total, row) => total + Buffer.byteLength(row.command_id) + Buffer.byteLength(row.response ?? "") + 100, 0);
    while (rows.length > 1 && (rows.length > 500 || bytes > 262144)) {
      const row = rows.shift()!;
      this.database.prepare("DELETE FROM legacy_recipe_lazy_receipts WHERE rowid=?").run(row.rowid);
      bytes -= Buffer.byteLength(row.command_id) + Buffer.byteLength(row.response ?? "") + 100;
    }
  }
  private sync(run: Run, state: View) {
    const observed = hash({ state: state.state, nodes: state.nodes });
    if (run.observed === observed) return false;
    run.observed = observed;
    run.unknown = state.state === "unknown" || state.nodes.some(node => node.state === "unknown");
    const now = new Date().toISOString();
    const feedbackNodes = new Set(this.options.originalRecipeMetadata
      ? originalRecipeLoops(run.definition).flatMap(loop => loop.body) : []);
    for (const node of state.nodes) {
      const previous = run.nodes[node.nodeId]!, uncertain = node.state === "unknown";
      const current = uncertain ? "running" : (run.unknown || automationStopped(run.automation)) && previous.state === "pending"
        && (node.state === "cancelled" || node.state === "skipped") ? "pending"
        : ["offered", "claimed"].includes(node.state) ? "running" : node.state;
      const reset = current === "pending" && previous.state !== "pending" && feedbackNodes.has(node.nodeId);
      const record: NodeRecord = reset
        ? { state: current } : { ...previous, state: current };
      if (reset) delete run.progress[node.nodeId];
      if (current === "running" && previous.state === "pending") {
        record.startedAt = now; record.lastHeartbeatAt = now; record.lastProgressAt = now;
        record.progress = { phase: "claimed", message: "Module claimed and awaiting progress.",
          safeToInterrupt: false, staleAfterSeconds: 300, events: [] };
        if (run.definition.spec.nodes.find(item => item.nodeId === node.nodeId)?.kind === HUMAN_GATE_NODE_KIND)
          record.challengeId ??= `gate_${createHash("sha256").update(`${run.runId}:${node.nodeId}:1`).digest("hex").slice(0, 24)}`;
      }
      if (current === "succeeded" || current === "failed") {
        record.outcome = previous.externalReport?.outcome ?? previous.humanInput?.outcome ?? node.branch ?? current;
        record.result = previous.externalReport ? previous.externalReport.result
          : previous.humanInput ? previous.humanInput.response
            : Object.hasOwn(node.outputs, "result") ? node.outputs.result : node.outputs;
        record.error = previous.externalReport?.error ?? (Object.hasOwn(node.outputs, "reportedError")
          ? String(node.outputs.reportedError)
          : current === "failed" ? String(object(record.result) && record.result.error || "Command failed.") : "");
        delete record.externalReport;
      }
      if (uncertain) delete record.externalReport;
      if (current === "skipped") { record.result = null; record.error = "Dependency outcome did not select this path."; }
      run.nodes[node.nodeId] = record;
    }
    return true;
  }
  private checkDispatchPolicy(run: Run, state: View, command: string) {
    if (!["ready", "running"].includes(state.state)
      || state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state))
      || this.database.prepare("SELECT 1 FROM legacy_recipe_lazy_receipts WHERE actor_id=? AND run_id=? AND command_id=?")
        .get(this.options.actorId, run.runId, command)) return;
    for (const node of run.definition.spec.nodes) {
      const adapter = this.adapters[adapterKey(node)];
      const binding = this.policyBinding(run, node);
      let allowed = false;
      try {
        allowed = !!adapter && adapter.authorizeDefinition(structuredClone(binding)) === true
          && (!adapter.authorizeData || adapter.authorizeData(structuredClone({ ...binding,
            definition: run.definition, inputs: run.inputs,
            previousOutputs: state.nodes.find(step => step.nodeId === node.nodeId)?.outputs ?? {},
          })) === true);
      } catch { /* Deny before reserving a request or claiming an execution intent. */ }
      if (!allowed) throw new CoreError("ACCESS_DENIED", "Exact controlled Recipe adapter/source/runtime authority changed before dispatch.");
    }
  }
  private policyBinding(run: Run, node: WorkflowDefinitionV1["spec"]["nodes"][number]) {
    return { actorId: this.options.actorId, executableDigest: run.executableDigest, source: run.source, node,
      ...(this.options.originalRecipeMetadata ? { executionSemantics: "original-recipe-metadata/v1" as const } : {}),
      ...(this.options.runtimeBindings ? { runtimeBindings: this.options.runtimeBindings } : {}) };
  }
  private hasSkippedRequired(run: Run) {
    return run.definition.spec.completion.requiredNodes.some(id => run.nodes[id]?.state === "skipped");
  }
  private response(run: Run, detail: string, includeRecipe = false, reportNode?: string, executeNode = false, newlySkippedRequired = false, loopTransition = false): Json {
    const loops = this.options.originalRecipeMetadata ? Object.values(this.workflow.originalRecipeLoopState(this.options.actorId, run.runId)) : [];
    for (const loop of loops) for (const history of loop.history)
      for (const [nodeId, node] of Object.entries(history.nodes)) {
        if (!object(node) || typeof node.attempt !== "number") continue;
        const observation = this.workflow.hostOwnedOriginalNodeObservation(this.options.actorId, run.runId, nodeId, node.attempt - 1);
        if (observation) Object.assign(node, {
          progress: observation.progress, startedAt: observation.startedAt, completedAt: observation.completedAt,
          lastHeartbeatAt: observation.lastHeartbeatAt, lastProgressAt: observation.lastProgressAt,
        });
      }
    const limited = loops.some(loop => loop.state === "limited");
    const counts: Record<string, number> = { pending: 0, running: 0, succeeded: 0, failed: 0 };
    const completed: Json[] = [];
    for (const [id, node] of Object.entries(run.nodes)) {
      counts[node.state] = (counts[node.state] ?? 0) + 1;
      if (["succeeded", "failed", "skipped"].includes(node.state))
        completed.push({ node_id: id, outcome: node.outcome ?? node.state, result: node.result ?? null, error: node.error ?? null });
    }
    const runningId = Object.keys(run.nodes).find(id => run.nodes[id]!.state === "running"
      || run.nodes[id]!.state === "pending" && !!run.nodes[id]!.challengeId
        && run.definition.spec.nodes.find(node => node.nodeId === id)?.kind === HUMAN_GATE_NODE_KIND) ?? null;
    const total = Object.keys(run.nodes).length, finished = completed.length;
    const required = run.definition.spec.completion.requiredNodes;
    const skippedRequired = required.filter(id => run.nodes[id]!.state === "skipped");
    const completedRequired = required.every(id => run.nodes[id]!.state === "succeeded");
    const failed = skippedRequired.length > 0 || !runningId && !counts.pending && !completedRequired;
    const automationFailed = run.automation && ["failed", "cancelled", "budget-exceeded"].includes(run.automation.status);
    const status = run.unknown || runningId ? "running" : automationFailed ? "failed"
      : skippedRequired.length ? "failed" : completedRequired ? "completed" : failed ? "failed" : "running";
    let action: Json = runningId ? { kind: "wait_for_background", run_id: run.runId, node_id: runningId }
      : status === "running" ? { kind: "call_recipe_run_next", run_id: run.runId }
        : { kind: "none", reason: failed ? "recipe-failed" : "recipe-completed" };
    if (skippedRequired.length && newlySkippedRequired) action = { kind: "none", reason: "required-node-skipped", required_node_ids: skippedRequired };
    if (runningId) {
      const node = run.definition.spec.nodes.find(node => node.nodeId === runningId)!;
      const render = (text: string) => text.replace(/\$\{inputs\.([A-Za-z][A-Za-z0-9._-]{0,127})\}/g,
        (_match, key: string) => {
          let value: unknown = run.inputs;
          for (const part of key.split(".")) {
            if (!object(value) || !Object.hasOwn(value, part)) throw new Error("Recipe command references missing input: " + key);
            value = value[part];
          }
          return value === null ? "" : typeof value === "string" ? value : canonicalJson(value);
        });
      action = { ...action, state: "running", started_at: run.nodes[runningId]!.startedAt,
        command: node.kind === "pkm.step.command/v1" ? { program: render(String(node.config.program)),
          args: (node.config.args as string[] ?? []).map(render) } : null,
        poll_with: "recipe_run_get" };
      if (node.kind === "pkm.step.noop/v1") action = executeNode
        ? { kind: "execute_node", run_id: run.runId, node_id: runningId,
          node: this.publicNode(runningId, run.recipeId) ?? node, inputs: run.inputs,
          accepted_outcomes: this.options.originalRecipeMetadata ? legacyExternalReportOutcomes(node)
            : this.options.externalReports!.acceptedOutcomes(run.runId, runningId),
          loop_context: loops.filter(loop => loop.body.includes(runningId))
            .map(({ loopId, iteration, maxIterations, condition }) => ({ loopId, iteration, maxIterations, condition })),
          knowledge_bindings: this.options.knowledgeForNode?.(runningId, run.recipeId) ?? [] }
        : { kind: "report_node", run_id: run.runId, node_id: runningId, accepted_outcomes: legacyExternalReportOutcomes(node) };
      if (node.kind === HUMAN_GATE_NODE_KIND) action = {
        kind: "request_user_input", run_id: run.runId, node_id: runningId,
        challenge_id: run.nodes[runningId]!.challengeId,
        prompt: node.config.prompt, input_kind: node.config.inputKind,
        choices: node.config.choices ?? [], required: true, submit_tool: "recipe_run_submit_input",
      };
      if (node.kind === "pkm.subflow/v1" && this.options.subflows) {
        const link = this.workflow.hostOwnedSubflowChildren(this.options.actorId, run.runId)
          .find(link => link.parentNodeId === runningId && link.parentInvocationId === this.subflowPending.get(run.runId)?.invocationId);
        if (link) {
          const child = this.load(link.childRunId), response = this.response(child, detail, false);
          action = { kind: "run_subrecipe", run_id: run.runId, node_id: runningId, child_run_id: child.runId,
            pinned_recipe: { recipe_id: child.recipeId, revision: child.revision,
              executable_digest: this.options.publicExecutableDigestForRecipe?.(child.recipeId) ?? child.executableDigest },
            child_status: response.status, child_next_action: response.next_action };
        }
      }
    }
    if (run.unknown) action = { ...action, state: "launch-outcome-unknown", reason: "reconciliation-required", replay_allowed: false };
    else if (automationStopped(run.automation) && status !== "completed")
      action = { kind: "none", reason: run.automation!.stopReason, replay_allowed: false };
    if (reportNode && !run.unknown
      && run.definition.spec.nodes.find(node => node.nodeId === reportNode)?.kind !== HUMAN_GATE_NODE_KIND)
      action = { kind: "report_node", run_id: run.runId, node_id: reportNode,
      accepted_outcomes: legacyExternalReportOutcomes(run.definition.spec.nodes.find(node => node.nodeId === reportNode)!) };
    const result: Json = {
      schema: "pkm.recipe.api/v1", ok: true, run_id: run.runId, status, version: run.version,
      current_result: { counts, progress: { completed: finished, total, percent: total ? Math.round(finished * 100 / total) : 100, running_node_id: runningId } },
      next_action: action, replayed: false,
    };
    if (run.automation) result.automation = structuredClone(run.automation);
    if (loops.length) (result.current_result as Json).control_state = { loops: structuredClone(loops) };
    if (limited) {
      const loop = loops.find(loop => loop.state === "limited")!;
      result.status = "failed"; result.next_action = loopTransition
        ? { kind: "none", reason: "loop-limit-reached", loop_id: loop.loopId,
          iteration: loop.iteration, max_iterations: loop.maxIterations }
        : { kind: "none", reason: "recipe-failed" };
      for (const item of completed) if (loops.some(loop => loop.state === "limited" && loop.source === item.node_id)) {
        item.outcome = "failed"; item.error = "Loop reached maxIterations before its termination condition.";
      }
    }
    if (this.options.originalRecipeMetadata || this.options.runtimeBindings)
      result.runtime = { executionSemantics: this.options.originalRecipeMetadata
        ? "original-recipe-metadata/v1" : "native-runtime-bindings/v1", automaticReplay: false };
    if (includeRecipe || detail === "full")
      result.recipe = { recipe_id: run.recipeId, revision: run.revision,
        executable_digest: this.options.publicExecutableDigestForRecipe?.(run.recipeId)
          ?? this.options.publicExecutableDigest ?? run.executableDigest };
    if (detail === "full") {
      (result.current_result as Json).completed_nodes = completed;
      result.usage = { measured_tokens: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 0 },
        measured_total_tokens: 0, estimated_tokens: 0, unknown_model_calls: 0, derived_cost_micros_by_currency: {},
        providers: [], models: [], protocol_payload_estimate: { estimated_tokens: 0, method: "utf8-bytes-divided-by-4" },
        reported_attempts: 0, records_retained: 0, records_truncated: 0 };
      if (run.reportedUsage) result.usage = reportedRecipeUsageSummary(run.reportedUsage);
    }
    if (runningId) {
      const node = run.nodes[runningId]!;
      (result.current_result as Json).running_progress = { node_id: runningId, started_at: node.startedAt,
        last_heartbeat_at: node.lastHeartbeatAt, last_progress_at: node.lastProgressAt,
        progress: { ...node.progress, ...run.progress[runningId] },
        observability: this.observability(node, run.progress[runningId], run.unknown) };
    }
    return result;
  }
  private publicNode(nodeId: string, recipeId: string) {
    const definition = this.options.publicDefinitionForRecipe?.(recipeId) ?? this.options.publicDefinition;
    if (!object(definition) || !object(definition.spec) || !Array.isArray(definition.spec.nodes)) return undefined;
    return definition.spec.nodes.find(node => object(node) && node.nodeId === nodeId);
  }
  private observability(node: NodeRecord, progress: Json | undefined, unknown: boolean) {
    const value = { ...node.progress, ...progress };
    const stale = Math.max(typeof value.staleAfterSeconds === "number" ? value.staleAfterSeconds : 300, 1);
    const age = (time?: string) => time ? Math.round(Math.max(0, Date.now() - Date.parse(time))) / 1000 : null;
    const heartbeat = age(node.lastHeartbeatAt), changed = age(node.lastProgressAt), maximum = Math.max(heartbeat ?? 0, changed ?? 0);
    const [state, action] = unknown ? ["intervention-required", "inspect-unknown-effect-no-replay"]
      : value.cancellationRequested ? ["cancelling", "await-terminal-report"]
        : String(value.waitingOn ?? "").trim() ? ["waiting", "await-dependency"]
          : maximum >= stale * 2 ? ["intervention-required", "checkpoint-cancel-or-reassign"]
            : maximum >= stale ? ["stale", "soft-nudge"]
              : (changed ?? 0) >= Math.min(Math.max(stale / 2, 30), 120) ? ["quiet", "observe"] : ["active", "continue"];
    return { state, recommended_action: action, heartbeat_age_seconds: heartbeat,
      progress_age_seconds: changed, stale_after_seconds: stale };
  }
  private async prepareStart(value: unknown) {
    const args = legacyRecipeLazyInputs["mcp.tool.recipe_run_start"].parse(value);
    const detail = responseDetail(args.detail, "compact");
    if (!args.command_id.trim()) throw new Error("command_id is required.");
    const catalog = await this.options.catalog();
    const recipe = catalog.recipes.find(row => row.recipeId === args.recipe_id);
    if (!recipe) throw new Error("Recipe was not found.");
    if (args.expected_revision && args.expected_revision !== recipe.revision) throw new Error("Recipe revision does not match expected_revision.");
    if (args.expected_digest && args.expected_digest !== recipe.executableDigest) throw new Error("Recipe digest does not match expected_digest.");
    const compiled = compileWorkflowDefinitionV1(recipe.definition);
    if (!compiled.ok || compiled.executableDigest !== recipe.executableDigest) throw new Error("Recipe definition is invalid.");
    const external = !!this.options.externalReports && compiled.model.spec.nodes.some(node =>
      this.options.externalReports!.supportsNode(node));
    if (recipe.nodeBindings?.some(node => node.bindings.length) && !this.options.knowledgeForNode
      || compiled.model.spec.nodes.some(node => !this.options.externalReports?.supportsNode(node)
        && (!automaticNode(node.kind) && !(node.kind === "pkm.subflow/v1" && this.options.subflows)
          || node.control && node.control.mode !== "single"
          && !this.options.originalRecipeMetadata && !this.options.runtimeBindings)))
      throw new Error("This controlled host requires exact command/Script single dispatch or explicitly admitted report/human nodes; no agent/subflow/dynamic control or Knowledge binding authority.");
    if (args.autonomous && compiled.model.spec.nodes.some(node => node.dependsOn.some(edge => edge.loop)))
      throw new Error("Autonomous execution does not support loop edges; use the lazy adapter.");
    const inputs = normalizeLegacyRecipeInputs(compiled.model, args.inputs_json);
    if (external) assertReportedRecipeNumbers(inputs, "inputs_json");
    return { args, detail, recipe, definition: recipe.definition as unknown as WorkflowDefinitionV1, inputs, source: {
      kind: "recipe" as const, recipeId: recipe.recipeId, expectedRevision: recipe.revision,
      expectedExecutableDigest: recipe.executableDigest, snapshotRevision: catalog.snapshotRevision,
    } };
  }
  private async checkExternalSource(run: Run) {
    if (!run.definition.spec.nodes.some(node => node.kind === "pkm.step.noop/v1" || node.kind === HUMAN_GATE_NODE_KIND)) return;
    const catalog = await this.options.catalog(), recipe = catalog.recipes.find(row => row.recipeId === run.recipeId);
    if (!recipe || recipe.revision !== run.revision || recipe.executableDigest !== run.executableDigest
      || catalog.snapshotRevision !== (run.source as { snapshotRevision?: string }).snapshotRevision
      || hash(recipe.definition) !== hash(run.definition))
      throw new CoreError("ACCESS_DENIED", "Exact external Recipe source changed; no report or dependent Step was admitted.");
  }
  private async checkAutomationSource(run: Run) {
    const catalog = await this.options.catalog(), recipe = catalog.recipes.find(row => row.recipeId === run.recipeId);
    if (!recipe || recipe.revision !== run.revision || recipe.executableDigest !== run.executableDigest
      || catalog.snapshotRevision !== (run.source as { snapshotRevision?: string }).snapshotRevision
      || hash(recipe.definition) !== hash(run.definition))
      throw new CoreError("ACCESS_DENIED", "Exact autonomous Recipe source changed; no dependent effect was admitted.");
    this.assert();
  }
  private advanceAutomation(id: string): Promise<{ state: View; dispatch: boolean }> {
    const existing = this.automationWork.get(id);
    if (existing) return existing;
    const advance = async () => {
      this.assert();
      let run = this.load(id), state = this.workflow.get(this.options.actorId, id);
      if (!run.automation) return this.dispatchOne(id);
      this.atomic(() => {
        run = this.load(id);
        const previous = run.version, automation = run.automation!;
        this.sync(run, state);
        if (!automationStopped(automation)) {
          if (run.unknown) {
            automation.status = "interrupted"; automation.stopReason = "unknown-effect-no-replay";
          } else if (!state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state))) {
            if (automation.cancellationRequested) {
              automation.status = "cancelled"; automation.stopReason = "cancellation-requested";
            } else if (state.nodes.some(node => node.state === "failed"
              && automaticNode(run.definition.spec.nodes.find(item => item.nodeId === node.nodeId)!.kind))) {
              automation.status = "failed"; automation.stopReason = "command-failed";
              if (Date.now() >= Date.parse(automation.deadlineAt)) {
                automation.status = "budget-exceeded"; automation.stopReason = "automation-budget-exceeded";
              }
            } else if (state.state === "succeeded" || state.state === "failed") {
              automation.status = state.state === "succeeded" ? "completed" : "failed";
            }
          }
        }
        this.fenceStoppedAutomation(run, state);
        if (canonicalJson(run) !== canonicalJson(this.load(id))) { run.version++; this.save(run, previous); }
      });
      state = this.workflow.get(this.options.actorId, id);
      if (automationStopped(run.automation) || this.work.has(id)
        || state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state)))
        return { state, dispatch: false };
      const node = run.definition.spec.nodes.find(node => state.nodes.find(step => step.nodeId === node.nodeId)?.state === "pending"
        && dependencyState(node, state.nodes) === "ready");
      if (!node) return { state, dispatch: false };
      if (!automaticNode(node.kind)) {
        this.atomic(() => {
          const current = this.load(id), previous = current.version;
          if (current.automation!.status === "waiting" && current.automation!.waitingOn === node.nodeId) return;
          current.automation!.status = "waiting"; current.automation!.waitingOn = node.nodeId;
          current.version++; this.save(current, previous);
        });
        if (node.kind === HUMAN_GATE_NODE_KIND) {
          await this.checkAutomationSource(run);
          this.checkDispatchPolicy(run, this.workflow.get(this.options.actorId, id), "");
          return this.dispatchOne(id);
        }
        return { state, dispatch: false };
      }
      await this.checkAutomationSource(run);
      state = this.workflow.get(this.options.actorId, id);
      this.checkDispatchPolicy(run, state, "");
      const admitted = this.atomic(() => {
        const current = this.load(id), previous = current.version, automation = current.automation!;
        if (automationStopped(automation) || automation.cancellationRequested || this.work.has(id)
          || state.nodes.some(step => ["offered", "claimed", "running"].includes(step.state))) return false;
        if (automation.startedNodes >= automation.maxNodes || Date.now() >= Date.parse(automation.deadlineAt)) {
          automation.status = "budget-exceeded"; automation.stopReason = "automation-budget-exceeded";
          this.fenceStoppedAutomation(current, state);
          current.version++; this.save(current, previous); return false;
        }
        // Reserve the whole-run budget before the executor claims an effect intent.
        automation.startedNodes++; automation.status = "running"; delete automation.waitingOn;
        current.version++; this.save(current, previous); return true;
      });
      return admitted ? this.dispatchOne(id) : { state, dispatch: false };
    };
    const task = advance().catch(error => {
      if (!this.closed) {
        try {
          const state = this.workflow.get(this.options.actorId, id);
          this.atomic(() => {
            const current = this.load(id), previous = current.version;
            this.sync(current, state);
            current.automation!.status = "interrupted";
            current.automation!.stopReason = current.unknown ? "unknown-effect-no-replay" : "authority-or-source-changed";
            this.fenceStoppedAutomation(current, state);
            current.version++; this.save(current, previous);
          });
        } catch { /* The next owner fences surviving intents; never resume automatically. */ }
      }
      throw error;
    });
    this.automationWork.set(id, task);
    void task.finally(() => { if (this.automationWork.get(id) === task) this.automationWork.delete(id); }).catch(() => {});
    return task;
  }
  private prepareReport(run: Run, args: ReturnType<typeof legacyRecipeLazyInputs["mcp.tool.recipe_run_report"]["parse"]>) {
    const detail = responseDetail(args.detail, "compact");
    if (!args.command_id.trim()) throw new Error("command_id is required.");
    if (Buffer.byteLength(args.usage_json) > 65536) throw new Error("usage_json must not exceed 65536 UTF-8 bytes.");
    const result: unknown = JSON.parse(args.result_json || "null");
    assertReportedRecipeNumbers(result, "result_json");
    const usage = parseReportedRecipeUsage(args.usage_json);
    if (Buffer.byteLength(canonicalJson(result)) + Buffer.byteLength(args.error) > 61_440)
      throw new Error("Reported result exceeds the native bounded output budget.");
    const fingerprint = hash({ run_id: args.run_id, node_id: args.node_id, outcome: args.outcome,
      result, error: args.error, usage, detail });
    const replay = this.receipt(args.run_id, args.command_id, fingerprint, "recipe-run-report-failed");
    if (replay) return { detail, result, usage, fingerprint, replay };
    if (run.unknown || run.nodes[args.node_id]?.state !== "running")
      throw new Error("Only the currently claimed running node can report an outcome.");
    const node = run.definition.spec.nodes.find(node => node.nodeId === args.node_id)!;
    if (node.kind !== "pkm.step.noop/v1") throw new Error("This node kind has a dedicated runtime adapter and cannot be reported manually.");
    if (!legacyExternalReportOutcomes(node).includes(args.outcome)) throw new Error("outcome is not accepted by the claimed node.");
    const adapter = this.adapters[adapterKey(node)];
    const binding = this.policyBinding(run, node);
    if (!adapter || adapter.authorizeDefinition(binding) !== true || adapter.authorizeData?.({
      ...binding, definition: run.definition, inputs: run.inputs, previousOutputs: {},
      candidate: { nodeId: args.node_id, outputs: { result, reportedError: args.error } },
    }) === false) throw new CoreError("ACCESS_DENIED", "External reporter authority changed.");
    const report = this.options.externalReports?.preview(args.run_id, args.node_id);
    if (!report || !this.work.has(args.run_id)) throw new Error("Only the currently claimed running node can report an outcome.");
    const nextUsage = addReportedRecipeUsage(run.reportedUsage, run.runId, args.node_id, args.outcome, result, args.error, usage);
    return { detail, result, usage, fingerprint, report, nextUsage };
  }
  private prepareHumanInput(run: Run, args: ReturnType<typeof legacyRecipeLazyInputs["mcp.tool.recipe_run_submit_input"]["parse"]>) {
    const detail = responseDetail(args.detail, "compact");
    if (!args.command_id.trim() || !args.challenge_id.trim()) throw new Error("command_id and challenge_id are required.");
    const response: unknown = JSON.parse(args.response_json || "{}");
    assertReportedRecipeNumbers(response, "response_json");
    if (Buffer.byteLength(canonicalJson(response)) > 61_440) throw new Error("Human gate response exceeds the bounded output budget.");
    const fingerprint = hash({ run_id: args.run_id, node_id: args.node_id, challenge_id: args.challenge_id, response, detail });
    const replay = this.receipt(args.run_id, args.command_id, fingerprint, "recipe-run-submit-input-failed");
    if (replay) return { detail, response, fingerprint, replay };
    const nodeRecord = run.nodes[args.node_id];
    if (run.unknown || !nodeRecord || !["running", "pending"].includes(nodeRecord.state)
      || nodeRecord.humanInput || !nodeRecord.challengeId || nodeRecord.challengeId !== args.challenge_id)
      throw new Error("Only the current uncompleted human gate challenge can accept user input.");
    const node = run.definition.spec.nodes.find(item => item.nodeId === args.node_id);
    if (!node || node.kind !== HUMAN_GATE_NODE_KIND) throw new Error("Only a dedicated human gate accepts submitted input.");
    const input = this.options.externalReports?.validateHumanInput(args.run_id, args.node_id, response, node);
    if (!input) throw new Error("Human gate input is not enabled.");
    const adapter = this.adapters[adapterKey(node)];
    const binding = this.policyBinding(run, node);
    if (!adapter || adapter.authorizeDefinition(binding) !== true || adapter.authorizeData?.({
      ...binding, definition: run.definition, inputs: run.inputs, previousOutputs: {},
      candidate: { nodeId: args.node_id, outputs: input.outputs },
    }) === false) throw new CoreError("ACCESS_DENIED", "Human gate authority changed.");
    return { detail, response, fingerprint, input };
  }
  private async dispatchOne(id: string) {
    let state = this.workflow.get(this.options.actorId, id);
    if (automationStopped(this.load(id).automation)) return { state, dispatch: false };
    const dispatch = ["ready", "running"].includes(state.state)
      && !state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state));
    if (dispatch) {
      if (this.options.originalRecipeMetadata) this.atomic(() => {
        const current = this.load(id), previous = current.version;
        const body = new Set(originalRecipeLoops(current.definition).flatMap(loop => loop.body));
        if (state.nodes.some(node => body.has(node.nodeId) && node.state === "pending"
          && current.nodes[node.nodeId]?.state !== "pending")
          && this.sync(current, state)) this.save(current, previous);
      });
      const work = this.workflow.tick(this.options.actorId, id);
      this.work.set(id, work);
      void work.catch(() => {
        if (!this.closed) {
          try { this.workflow.interruptHostOwnedRun(this.options.actorId, id); }
          catch { /* The next admitted owner fences durable start-intents. */ }
        }
      }).finally(() => {
        if (this.work.get(id) === work) this.work.delete(id);
        if (!this.closed && this.load(id).automation) {
          // Wait for any initial scheduler pass before advancing its completed intent.
          void Promise.resolve(this.automationWork.get(id)).catch(() => {}).then(() => {
            if (!this.closed) return this.advanceAutomation(id);
          }).catch(() => {});
        }
      }).catch(() => {});
      state = this.workflow.get(this.options.actorId, id);
      const legacy = this.load(id);
      if (state.nodes.some(node => node.state === "running"
        && legacy.definition.spec.nodes.find(row => row.nodeId === node.nodeId)?.kind === "pkm.subflow/v1")) {
        await Promise.resolve();
        await this.subflowCreation.get(id);
        state = this.workflow.get(this.options.actorId, id);
      }
      const resumedInput = Object.entries(legacy.nodes).find(([nodeId, record]) =>
        legacy.definition.spec.nodes.find(item => item.nodeId === nodeId)?.kind === HUMAN_GATE_NODE_KIND
        && record.humanInput && state.nodes.some(node => node.nodeId === nodeId && node.state === "running"));
      if (resumedInput) {
        await Promise.resolve();
        this.options.externalReports!.submitHumanInput(id, resumedInput[0], resumedInput[1].humanInput!);
        state = (await work) ?? this.workflow.get(this.options.actorId, id);
      } else if (!state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state))) {
        await work; state = this.workflow.get(this.options.actorId, id);
      }
    }
    return { state, dispatch };
  }
  async preview(operation: LegacyRecipeLazyOperation, value: unknown, actor: Readonly<Actor>) {
    this.assert(actor);
    const args = legacyRecipeLazyInputs[operation].parse(value);
    const state = operation.endsWith("_start") ? await this.prepareStart(args) : (() => {
      const id = (args as { run_id: string }).run_id, run = this.load(id);
      const execution = this.workflow.get(this.options.actorId, id);
      if (operation === "mcp.tool.recipe_run_next")
        this.checkDispatchPolicy(run, execution, (args as { command_id: string }).command_id);
      const report = operation === "mcp.tool.recipe_run_report"
        ? this.prepareReport(run, legacyRecipeLazyInputs["mcp.tool.recipe_run_report"].parse(args)) : undefined;
      const humanInput = operation === "mcp.tool.recipe_run_submit_input"
        ? this.prepareHumanInput(run, legacyRecipeLazyInputs["mcp.tool.recipe_run_submit_input"].parse(args)) : undefined;
      return { run, execution, ...(report ? { report } : {}), ...(humanInput ? { humanInput } : {}) };
    })();
    if (operation === "mcp.tool.recipe_run_report" || operation === "mcp.tool.recipe_run_next"
      || operation === "mcp.tool.recipe_run_submit_input")
      await this.checkExternalSource(this.load((args as { run_id: string }).run_id));
    this.assert(actor);
    const adapters = Object.fromEntries(Object.entries(this.adapters).map(([key, adapter]) => [key, {
      id: adapter.id, version: adapter.version, outputContractDigest: adapter.outputContractDigest,
      authorizationDigest: adapter.authorizationDigest,
    }]));
    return { operation, args, actorId: actor.id, binding: this.options.bindingFingerprint, adapters, state,
      ...(this.options.externalReports ? { externalReports: {
        executionAuthority: false, resultAuthority: "external-caller-reported", automaticAgentExecution: false,
      } } : {}) };
  }
  async dispatch(operation: LegacyRecipeLazyOperation, value: unknown, actor: Readonly<Actor>): Promise<Json> {
    this.assert(actor);
    try {
      if (operation === "mcp.tool.recipe_run_start") {
        const { args, detail, recipe, definition, inputs, source } = await this.prepareStart(value);
        this.assert(actor);
        const id = runId(args.command_id), fingerprint = hash({ recipe_id: args.recipe_id, project_id: args.project_id,
          inputs, expected_revision: args.expected_revision, expected_digest: args.expected_digest, detail,
          ...(args.autonomous || args.max_auto_nodes !== 100 || args.max_auto_seconds !== 300
            ? { autonomous: args.autonomous, max_auto_nodes: args.max_auto_nodes, max_auto_seconds: args.max_auto_seconds } : {}) });
        const initial = this.atomic(() => {
          const replay = this.receipt(id, args.command_id, fingerprint);
          if (replay) return replay;
          const hasSubflow = definition.spec.nodes.some(node => node.kind === "pkm.subflow/v1");
          const state = this.workflow.createInTransaction(this.options.actorId, {
            runId: id, operationId: operationId(this.options.actorId, args.command_id), source,
            expectedExecutableDigest: recipe.executableDigest, inputs: inputs as never,
            deadline: Date.now() + (hasSubflow && args.autonomous ? args.max_auto_seconds * 1000 : 86_400_000),
            ...(this.options.runtimeBindings ? { runtimeBindings: this.options.runtimeBindings } : {}),
          }, { dispatchMode: "explicit", legacyRunInputs: true,
            ...(this.options.originalRecipeMetadata ? { originalRecipeMetadata: true } : {}),
            ...(hasSubflow ? { treeBudget: { maxSteps: args.autonomous ? args.max_auto_nodes : 1000,
              maxDepth: 16, maxRuns: 32 } } : {}),
            ...(!Object.keys(definition.spec.inputs).length ? { legacyUntypedInputs: true } : {}) });
          const run: Run = { runId: id, recipeId: recipe.recipeId, revision: recipe.revision,
            executableDigest: recipe.executableDigest, source: state.source, definition, inputs, projectId: args.project_id,
            version: 1, observed: hash({ state: state.state, nodes: state.nodes }), unknown: false, progress: {},
            nodes: Object.fromEntries(definition.spec.nodes.map(node => [node.nodeId, { state: "pending" }])),
            ...(args.autonomous ? { automation: { status: "running" as const, maxNodes: args.max_auto_nodes,
              startedNodes: 0, deadlineAt: new Date(Date.now() + args.max_auto_seconds * 1000).toISOString(),
              cancellationRequested: false } } : {}) };
          this.database.prepare("INSERT INTO legacy_recipe_lazy_runs VALUES(?,?,?,?,?)")
            .run(this.options.actorId, id, this.options.bindingFingerprint, 1, this.protocolRecord(run));
          this.saveAutomation(run);
          const response = this.response(run, detail, true);
          this.storeReceipt(id, args.command_id, fingerprint, args.autonomous ? null : response);
          return response;
        });
        if (!args.autonomous || initial.replayed) return initial;
        await this.advanceAutomation(id);
        const currentState = this.workflow.get(this.options.actorId, id);
        return this.atomic(() => {
          const run = this.load(id), previous = run.version;
          if (this.sync(run, currentState)) { run.version++; this.save(run, previous); }
          const response = this.response(run, detail, true);
          this.storeReceipt(id, args.command_id, fingerprint, response);
          return response;
        });
      }
      if (operation === "mcp.tool.recipe_run_get") {
        const args = legacyRecipeLazyInputs[operation].parse(value), detail = responseDetail(args.detail, "full");
        await this.synchronizeSubflows(args.run_id);
        if (this.load(args.run_id).automation) await this.advanceAutomation(args.run_id);
        const state = this.workflow.get(this.options.actorId, args.run_id);
        return this.atomic(() => {
          const run = this.load(args.run_id), previous = run.version, previouslySkipped = this.hasSkippedRequired(run);
          if (this.sync(run, state)) { run.version++; this.save(run, previous); }
          return this.response(run, detail, false, undefined, false, !previouslySkipped);
        });
      }
      if (operation === "mcp.tool.recipe_run_progress") {
        const args = legacyRecipeLazyInputs[operation].parse(value), detail = responseDetail(args.detail, "compact");
        const progress = parseProgress(args.progress_json), fingerprint = hash({ operation, ...args, detail, progress_json: progress });
        const execution = this.workflow.get(this.options.actorId, args.run_id);
        const cancelOwned = progress.cancellationRequested === true
          && this.load(args.run_id).definition.spec.nodes.some(node => node.nodeId === args.node_id && automaticNode(node.kind));
        const response = this.atomic(() => {
          const replay = this.receipt(args.run_id, args.command_id, fingerprint);
          if (replay) return replay;
          const run = this.load(args.run_id), previous = run.version;
          this.sync(run, execution);
          if (run.nodes[args.node_id]?.state !== "running") throw new Error("Progress can only be recorded for the currently running node.");
          const current = { ...run.nodes[args.node_id]!.progress, ...run.progress[args.node_id] };
          const now = new Date().toISOString();
          const events = (progress.events as Json[] | undefined ?? []).map(event => ({
            at: String(event.at || now), level: String(event.level || "info"), message: event.message,
          }));
          const normalized = Object.fromEntries(Object.entries(progress).filter(([key]) => key !== "events" && key !== "progressed"));
          run.progress[args.node_id] = { ...current, ...normalized, events: [...(current.events as Json[] ?? []), ...events].slice(-20) };
          if (run.automation && progress.cancellationRequested === true) run.automation.cancellationRequested = true;
          run.nodes[args.node_id]!.lastHeartbeatAt = now;
          if (progress.progressed === undefined || progress.progressed) run.nodes[args.node_id]!.lastProgressAt = now;
          run.version++; this.save(run, previous);
          const response = this.response(run, detail, false, args.node_id);
          this.storeReceipt(args.run_id, args.command_id, fingerprint, cancelOwned ? {
            schema: "pkm.recipe.api/v1", ok: false, effect: "unknown", replayed: false,
            error: { code: "recipe-run-progress-failed", message: "Cancellation request acknowledgment is unknown; inspect durable run, never signal an unowned process or replay automatically." },
          } : response);
          return response;
        });
        if (!response.replayed && cancelOwned) {
          try { await this.options.requestCancel({ runId: args.run_id, nodeId: args.node_id }); }
          catch { throw new CoreError("CANCEL_REQUEST_UNCERTAIN", "Cancellation request acknowledgment is unknown; inspect durable run, never signal an unowned process or replay automatically.", "unknown"); }
          this.atomic(() => this.storeReceipt(args.run_id, args.command_id, fingerprint, response));
        }
        return response;
      }
      if (operation === "mcp.tool.recipe_run_submit_input") {
        const args = legacyRecipeLazyInputs[operation].parse(value), run = this.load(args.run_id);
        await this.checkExternalSource(run); this.assert(actor);
        const prepared = this.prepareHumanInput(run, args);
        if (prepared.replay) return prepared.replay;
        this.atomic(() => {
          const current = this.load(args.run_id), prior = current.version;
          if (current.nodes[args.node_id]?.challengeId !== args.challenge_id)
            throw new Error("Human gate challenge changed before submission.");
          current.nodes[args.node_id]!.humanInput = prepared.input;
          current.version++; this.save(current, prior);
          this.storeReceipt(args.run_id, args.command_id, prepared.fingerprint, null);
        });
        let completed: View | undefined;
        const work = this.work.get(args.run_id);
        try {
          if (work) {
            this.options.externalReports!.submitHumanInput(args.run_id, args.node_id, prepared.input);
            completed = await work;
          } else {
            const resumed = await this.dispatchOne(args.run_id);
            completed = resumed.state;
          }
        } catch {
          throw new CoreError("HUMAN_INPUT_OUTCOME_UNCERTAIN", "Human input was durably recorded but completion acknowledgment is unknown; inspect the run; never submit another approval.", "unknown");
        }
        if (completed?.nodes.find(node => node.nodeId === args.node_id)?.effect !== "known")
          throw new CoreError("HUMAN_INPUT_OUTCOME_UNCERTAIN", "Submitted human input acknowledgment is unknown; inspect the durable run; never replay.", "unknown");
        await this.checkExternalSource(run);
        const next = run.automation ? await this.advanceAutomation(args.run_id) : await this.dispatchOne(args.run_id);
        const state = this.workflow.get(this.options.actorId, args.run_id);
        return this.atomic(() => {
          const current = this.load(args.run_id), prior = current.version;
          this.sync(current, state);
          current.version++; this.save(current, prior);
          const response = this.response(current, prepared.detail, false, undefined, next.dispatch, true, true);
          this.storeReceipt(args.run_id, args.command_id, prepared.fingerprint, response);
          return response;
        });
      }
      if (operation === "mcp.tool.recipe_run_report") {
        const args = legacyRecipeLazyInputs[operation].parse(value), run = this.load(args.run_id);
        await this.checkExternalSource(run); this.assert(actor);
        const prepared = this.prepareReport(run, args);
        if (prepared.replay) return prepared.replay;
        this.options.externalReports!.validate(args.run_id, args.node_id, args.outcome, prepared.result, args.error);
        const observed = this.options.originalRecipeMetadata
          ? this.workflow.get(this.options.actorId, args.run_id) : undefined;
        this.atomic(() => {
          const current = this.load(args.run_id), previous = current.version;
          const body = new Set(this.options.originalRecipeMetadata
            ? originalRecipeLoops(current.definition).filter(loop => loop.source === args.node_id).flatMap(loop => loop.body) : []);
          for (const step of observed?.nodes ?? []) {
            const node = current.nodes[step.nodeId];
            if (!body.has(step.nodeId) || !node?.progress
              || step.state !== "running" && step.effect !== "known") continue;
            this.workflow.recordHostControlInTransaction(this.options.actorId, args.run_id, "legacy-recipe-node-observation", {
              schema: "pkm.original-recipe-node-observation/v1", actorId: this.options.actorId, runId: args.run_id,
              invocationId: prepared.report!.invocationId, nodeId: step.nodeId,
              iteration: step.state === "running" ? step.iteration : step.iteration - 1,
              progress: { ...node.progress, ...current.progress[step.nodeId] },
              startedAt: node.startedAt ?? null, completedAt: null,
              lastHeartbeatAt: node.lastHeartbeatAt ?? null, lastProgressAt: node.lastProgressAt ?? null,
            });
          }
          current.nodes[args.node_id]!.externalReport = { outcome: args.outcome, result: prepared.result, error: args.error };
          this.save(current, previous);
          this.storeReceipt(args.run_id, args.command_id, prepared.fingerprint, null);
        });
        const work = this.work.get(args.run_id)!;
        this.options.externalReports!.submit(args.run_id, args.node_id, args.outcome, prepared.result, args.error);
        const completed = await work;
        if (completed?.nodes.find(node => node.nodeId === args.node_id)?.effect !== "known"
          && !this.workflow.knownInvocationResult(this.options.actorId, args.run_id, prepared.report!.invocationId))
          throw new CoreError("REPORT_OUTCOME_UNCERTAIN", "Reported output acknowledgment is unknown; inspect durable run, never replay.", "unknown");
        await this.checkExternalSource(run);
        const next = run.automation ? await this.advanceAutomation(args.run_id) : await this.dispatchOne(args.run_id);
        const state = this.workflow.get(this.options.actorId, args.run_id);
        return this.atomic(() => {
          const current = this.load(args.run_id), previous = current.version;
          this.sync(current, state);
          current.reportedUsage = prepared.nextUsage;
          current.version++; this.save(current, previous);
          const response = this.response(current, prepared.detail, false, undefined, next.dispatch, true, true);
          this.storeReceipt(args.run_id, args.command_id, prepared.fingerprint, response);
          return response;
        });
      }
      const args = legacyRecipeLazyInputs["mcp.tool.recipe_run_next"].parse(value), detail = responseDetail(args.detail, "compact");
      await this.synchronizeSubflows(args.run_id);
      const fingerprint = hash({ operation, ...args, detail });
      await this.checkExternalSource(this.load(args.run_id));
      this.checkDispatchPolicy(this.load(args.run_id), this.workflow.get(this.options.actorId, args.run_id), args.command_id);
      const replay = this.atomic(() => {
        this.load(args.run_id);
        const response = this.receipt(args.run_id, args.command_id, fingerprint);
        if (!response) this.storeReceipt(args.run_id, args.command_id, fingerprint, null);
        return response;
      });
      if (replay) return replay;
      const automatic = this.load(args.run_id).automation;
      let next = automatic ? await this.advanceAutomation(args.run_id) : await this.dispatchOne(args.run_id);
      if (automatic && this.load(args.run_id).automation?.status === "waiting" && !next.dispatch)
        next = await this.dispatchOne(args.run_id);
      const state = this.workflow.get(this.options.actorId, args.run_id), dispatch = next.dispatch;
      return this.atomic(() => {
        const run = this.load(args.run_id), previous = run.version, previouslySkipped = this.hasSkippedRequired(run);
        if (this.sync(run, state)) { run.version++; this.save(run, previous); }
        const response = this.response(run, detail, false, undefined, dispatch, !previouslySkipped);
        this.storeReceipt(args.run_id, args.command_id, fingerprint, response);
        return response;
      });
    } catch (error) {
      if (error instanceof CoreError && ["ACCESS_DENIED", "FORBIDDEN", "LEASE_LOST", "CLOSED"].includes(error.code)) throw error;
      return { schema: "pkm.recipe.api/v1", ok: false,
        ...(error instanceof CoreError && error.effect === "unknown" ? { effect: "unknown" } : {}),
        error: { code: operation.slice("mcp.tool.".length).replaceAll("_", "-") + "-failed",
          message: error instanceof Error ? error.message : "Recipe operation failed." } };
    }
  }
  close() {
    if (this.closed) return;
    for (const row of this.database.prepare("SELECT run_id FROM legacy_recipe_lazy_runs WHERE actor_id=? AND binding=?")
      .all(this.options.actorId, this.options.bindingFingerprint) as { run_id: string }[]) {
      const run = this.load(row.run_id);
      if (!run.automation || automationStopped(run.automation)) continue;
      const state = this.workflow.interruptHostOwnedRun(this.options.actorId, row.run_id);
      this.atomic(() => {
        const previous = run.version;
        this.sync(run, state);
        run.automation!.status = "interrupted"; run.automation!.stopReason = "host-restart-no-replay";
        this.fenceStoppedAutomation(run, state);
        run.version++; this.save(run, previous);
      });
    }
    this.workflow.close(); this.closed = true;
  }
}
