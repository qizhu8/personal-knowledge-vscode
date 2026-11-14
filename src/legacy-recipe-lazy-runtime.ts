import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { canonicalJson, compileWorkflowDefinitionV1, HUMAN_GATE_NODE_KIND, type WorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { normalizeTypedValue } from "./domain/project-recipes-value-contracts.js";
import { WorkflowExecutor, adapterKey, type WorkflowStepAdapter } from "./workflow-executor.js";
import type { LegacyApiChatRecipes } from "./legacy-api-chat-recipes.js";
import { legacyRecipeLazyInputs, type LegacyRecipeLazyOperation } from "./legacy-recipe-lazy-contracts.js";
import type { LegacyRecipeExternalReports } from "./legacy-recipe-external-reports.js";
import { legacyExternalReportOutcomes } from "./legacy-recipe-external-reports.js";
import { addReportedRecipeUsage, assertReportedRecipeNumbers, parseReportedRecipeUsage, reportedRecipeUsageSummary, type ReportedRecipeUsage } from "./legacy-recipe-reported-usage.js";

type Json = Record<string, unknown>;
type View = ReturnType<WorkflowExecutor["get"]>;
type HumanInput = { outcome: string; response: object; outputs: Record<string, unknown> };
type NodeRecord = { state: string; outcome?: string; result?: unknown; error?: string | null; externalReport?: { outcome: string; result: unknown; error: string }; humanInput?: HumanInput; challengeId?: string; progress?: Json; startedAt?: string; lastHeartbeatAt?: string; lastProgressAt?: string };
type Run = {
  runId: string; recipeId: string; revision: number; executableDigest: string; source: unknown;
  projectId: string; definition: WorkflowDefinitionV1; inputs: Json; version: number;
  observed: string; nodes: Record<string, NodeRecord>; unknown: boolean; progress: Record<string, Json>;
  reportedUsage?: ReportedRecipeUsage;
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

/**
 * Host-only bridge: protocol receipts are not an execution journal. Assignment,
 * lease, authority, result fencing and recovery belong to WorkflowExecutor.
 */
export class LegacyRecipeLazyRuntime {
  private readonly workflow: WorkflowExecutor;
  private closed = false;
  private readonly work = new Map<string, Promise<View | undefined>>();
  private readonly adapters: Readonly<Record<string, WorkflowStepAdapter>>;
  constructor(private readonly database: DatabaseSync, private readonly options: {
    actorId: string; root: string; bindingFingerprint: string; ownerId: string;
    adapters: Readonly<Record<string, WorkflowStepAdapter>>;
    catalog(): Promise<Catalog>;
    resolveRecipe: NonNullable<ConstructorParameters<typeof WorkflowExecutor>[1]["resolveRecipe"]>;
    assertOwner(): void;
    requestCancel(request: Readonly<{ runId: string; nodeId: string }>): void;
    externalReports?: LegacyRecipeExternalReports;
  }) {
    options.assertOwner();
    database.exec(`
      CREATE TABLE IF NOT EXISTS legacy_recipe_lazy_runs(
        actor_id TEXT NOT NULL,run_id TEXT NOT NULL,binding TEXT NOT NULL,version INTEGER NOT NULL,
        record TEXT NOT NULL,PRIMARY KEY(actor_id,run_id));
      CREATE TABLE IF NOT EXISTS legacy_recipe_lazy_receipts(
        actor_id TEXT NOT NULL,run_id TEXT NOT NULL,command_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,response TEXT,PRIMARY KEY(actor_id,run_id,command_id));`);
    if (options.externalReports && options.adapters["pkm.step.noop/v1"])
      throw new Error("External report ownership cannot replace an existing NoOp adapter.");
    if (options.externalReports?.humanGatesEnabled() && options.adapters[HUMAN_GATE_NODE_KIND])
      throw new Error("Human gate ownership cannot replace an existing adapter.");
    const adapters = { ...options.adapters,
      ...(options.externalReports ? { "pkm.step.noop/v1": options.externalReports.adapter } : {}),
      ...(options.externalReports?.humanGatesEnabled() ? { [HUMAN_GATE_NODE_KIND]: options.externalReports.adapter } : {}) };
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
    }
  }
  externalReportsEnabled() { return !!this.options.externalReports; }
  staticBranchesEnabled() { return this.options.externalReports?.staticBranchesEnabled() === true; }
  portedNoopsEnabled() { return this.options.externalReports?.portedNoopsEnabled() === true; }
  humanGatesEnabled() { return this.options.externalReports?.humanGatesEnabled() === true; }
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
    return JSON.parse(row.record) as Run;
  }
  private save(run: Run, previous: number) {
    if (Buffer.byteLength(JSON.stringify(run)) > 1_048_576) throw new Error("Legacy lazy record byte budget exceeded.");
    const result = this.database.prepare("UPDATE legacy_recipe_lazy_runs SET version=?,record=? WHERE actor_id=? AND run_id=? AND version=? AND binding=?")
      .run(run.version, JSON.stringify(run), this.options.actorId, run.runId, previous, this.options.bindingFingerprint);
    if (result.changes !== 1) throw new CoreError("CONFLICT", "Legacy run changed concurrently.");
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
    for (const node of state.nodes) {
      const previous = run.nodes[node.nodeId]!, uncertain = node.state === "unknown";
      const current = uncertain ? "running" : run.unknown && previous.state === "pending"
        && (node.state === "cancelled" || node.state === "skipped") ? "pending"
        : ["offered", "claimed"].includes(node.state) ? "running" : node.state;
      const record: NodeRecord = { ...previous, state: current };
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
      const binding = { actorId: this.options.actorId, executableDigest: run.executableDigest, source: run.source, node };
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
  private hasSkippedRequired(run: Run) {
    return run.definition.spec.completion.requiredNodes.some(id => run.nodes[id]?.state === "skipped");
  }
  private response(run: Run, detail: string, includeRecipe = false, reportNode?: string, executeNode = false, newlySkippedRequired = false): Json {
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
    const status = run.unknown || runningId ? "running" : skippedRequired.length ? "failed" : completedRequired ? "completed" : failed ? "failed" : "running";
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
        ? { kind: "execute_node", run_id: run.runId, node_id: runningId, node, inputs: run.inputs,
          accepted_outcomes: legacyExternalReportOutcomes(node), loop_context: [], knowledge_bindings: [] }
        : { kind: "report_node", run_id: run.runId, node_id: runningId, accepted_outcomes: legacyExternalReportOutcomes(node) };
      if (node.kind === HUMAN_GATE_NODE_KIND) action = {
        kind: "request_user_input", run_id: run.runId, node_id: runningId,
        challenge_id: run.nodes[runningId]!.challengeId,
        prompt: node.config.prompt, input_kind: node.config.inputKind,
        choices: node.config.choices ?? [], required: true, submit_tool: "recipe_run_submit_input",
      };
    }
    if (run.unknown) action = { ...action, state: "launch-outcome-unknown", reason: "reconciliation-required", replay_allowed: false };
    if (reportNode && !run.unknown
      && run.definition.spec.nodes.find(node => node.nodeId === reportNode)?.kind !== HUMAN_GATE_NODE_KIND)
      action = { kind: "report_node", run_id: run.runId, node_id: reportNode,
      accepted_outcomes: legacyExternalReportOutcomes(run.definition.spec.nodes.find(node => node.nodeId === reportNode)!) };
    const result: Json = {
      schema: "pkm.recipe.api/v1", ok: true, run_id: run.runId, status, version: run.version,
      current_result: { counts, progress: { completed: finished, total, percent: total ? Math.round(finished * 100 / total) : 100, running_node_id: runningId } },
      next_action: action, replayed: false,
    };
    if (includeRecipe || detail === "full")
      result.recipe = { recipe_id: run.recipeId, revision: run.revision, executable_digest: run.executableDigest };
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
    if (args.autonomous || args.max_auto_nodes !== 100 || args.max_auto_seconds !== 300)
      throw new Error("Autonomous execution is not qualified by the controlled lazy host.");
    const catalog = await this.options.catalog();
    const recipe = catalog.recipes.find(row => row.recipeId === args.recipe_id);
    if (!recipe) throw new Error("Recipe was not found.");
    if (args.expected_revision && args.expected_revision !== recipe.revision) throw new Error("Recipe revision does not match expected_revision.");
    if (args.expected_digest && args.expected_digest !== recipe.executableDigest) throw new Error("Recipe digest does not match expected_digest.");
    const compiled = compileWorkflowDefinitionV1(recipe.definition);
    if (!compiled.ok || compiled.executableDigest !== recipe.executableDigest) throw new Error("Recipe definition is invalid.");
    const external = !!this.options.externalReports && compiled.model.spec.nodes.every(node =>
      this.options.externalReports!.supportsNode(node));
    if (recipe.nodeBindings?.some(node => node.bindings.length)
      || !external && compiled.model.spec.nodes.some(node => node.kind !== "pkm.step.command/v1"
        || node.control && node.control.mode !== "single"))
      throw new Error("This controlled lazy host qualifies exact command single-node dispatch only; no script/agent/report/gate/subflow/loop or Knowledge binding authority.");
    const supplied = jsonObject(args.inputs_json, "inputs_json"), inputs: Json = Object.create(null);
    if (external) assertReportedRecipeNumbers(supplied, "inputs_json");
    if (!Object.keys(compiled.model.spec.inputs).length) Object.assign(inputs, supplied);
    else for (const key of Object.keys(supplied)) if (!Object.hasOwn(compiled.model.spec.inputs, key)) throw new Error(`/inputs contains unknown fields: ${key}.`);
    for (const [key, descriptor] of Object.entries(compiled.model.spec.inputs)) {
      const item = Object.hasOwn(supplied, key) ? supplied[key] : descriptor.default;
      if (item === undefined) { if (descriptor.required) throw new Error(`Required input missing: ${key}.`); continue; }
      inputs[key] = normalizeTypedValue(descriptor, item);
    }
    return { args, detail, recipe, definition: compiled.model, inputs, source: {
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
    const binding = { actorId: this.options.actorId, executableDigest: run.executableDigest, source: run.source, node };
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
    const binding = { actorId: this.options.actorId, executableDigest: run.executableDigest, source: run.source, node };
    if (!adapter || adapter.authorizeDefinition(binding) !== true || adapter.authorizeData?.({
      ...binding, definition: run.definition, inputs: run.inputs, previousOutputs: {},
      candidate: { nodeId: args.node_id, outputs: input.outputs },
    }) === false) throw new CoreError("ACCESS_DENIED", "Human gate authority changed.");
    return { detail, response, fingerprint, input };
  }
  private async dispatchOne(id: string) {
    let state = this.workflow.get(this.options.actorId, id);
    const dispatch = ["ready", "running"].includes(state.state)
      && !state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state));
    if (dispatch) {
      const work = this.workflow.tick(this.options.actorId, id);
      this.work.set(id, work);
      void work.catch(() => {
        if (!this.closed) {
          try { this.workflow.interruptHostOwnedRun(this.options.actorId, id); }
          catch { /* The next admitted owner fences durable start-intents. */ }
        }
      }).finally(() => { if (this.work.get(id) === work) this.work.delete(id); });
      state = this.workflow.get(this.options.actorId, id);
      const legacy = this.load(id);
      const resumedInput = Object.entries(legacy.nodes).find(([nodeId, record]) =>
        legacy.definition.spec.nodes.find(item => item.nodeId === nodeId)?.kind === HUMAN_GATE_NODE_KIND
        && record.humanInput && state.nodes.some(node => node.nodeId === nodeId && node.state === "running"));
      if (resumedInput) {
        await Promise.resolve();
        this.options.externalReports!.submitHumanInput(id, resumedInput[0], resumedInput[1].humanInput!);
        state = (await work) ?? this.workflow.get(this.options.actorId, id);
      } else if (!state.nodes.some(node => ["offered", "claimed", "running"].includes(node.state))) await work;
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
          inputs, expected_revision: args.expected_revision, expected_digest: args.expected_digest, detail });
        return this.atomic(() => {
          const replay = this.receipt(id, args.command_id, fingerprint);
          if (replay) return replay;
          const state = this.workflow.createInTransaction(this.options.actorId, {
            runId: id, operationId: operationId(this.options.actorId, args.command_id), source,
            expectedExecutableDigest: recipe.executableDigest, inputs: inputs as never, deadline: Date.now() + 86_400_000,
          }, { dispatchMode: "explicit", legacyRunInputs: true,
            ...(!Object.keys(definition.spec.inputs).length ? { legacyUntypedInputs: true } : {}) });
          const run: Run = { runId: id, recipeId: recipe.recipeId, revision: recipe.revision,
            executableDigest: recipe.executableDigest, source: state.source, definition, inputs, projectId: args.project_id,
            version: 1, observed: hash({ state: state.state, nodes: state.nodes }), unknown: false, progress: {},
            nodes: Object.fromEntries(definition.spec.nodes.map(node => [node.nodeId, { state: "pending" }])) };
          this.database.prepare("INSERT INTO legacy_recipe_lazy_runs VALUES(?,?,?,?,?)")
            .run(this.options.actorId, id, this.options.bindingFingerprint, 1, JSON.stringify(run));
          const response = this.response(run, detail, true);
          this.storeReceipt(id, args.command_id, fingerprint, response);
          return response;
        });
      }
      if (operation === "mcp.tool.recipe_run_get") {
        const args = legacyRecipeLazyInputs[operation].parse(value), detail = responseDetail(args.detail, "full");
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
          && this.load(args.run_id).definition.spec.nodes.some(node => node.nodeId === args.node_id && node.kind === "pkm.step.command/v1");
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
          try { this.options.requestCancel({ runId: args.run_id, nodeId: args.node_id }); }
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
        const next = await this.dispatchOne(args.run_id);
        return this.atomic(() => {
          const current = this.load(args.run_id), prior = current.version;
          this.sync(current, next.state);
          current.version++; this.save(current, prior);
          const response = this.response(current, prepared.detail, false, undefined, next.dispatch, true);
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
        this.atomic(() => {
          const current = this.load(args.run_id), previous = current.version;
          current.nodes[args.node_id]!.externalReport = { outcome: args.outcome, result: prepared.result, error: args.error };
          this.save(current, previous);
          this.storeReceipt(args.run_id, args.command_id, prepared.fingerprint, null);
        });
        const work = this.work.get(args.run_id)!;
        this.options.externalReports!.submit(args.run_id, args.node_id, args.outcome, prepared.result, args.error);
        const completed = await work;
        if (completed?.nodes.find(node => node.nodeId === args.node_id)?.effect !== "known")
          throw new CoreError("REPORT_OUTCOME_UNCERTAIN", "Reported output acknowledgment is unknown; inspect durable run, never replay.", "unknown");
        await this.checkExternalSource(run);
        const next = await this.dispatchOne(args.run_id);
        return this.atomic(() => {
          const current = this.load(args.run_id), previous = current.version;
          this.sync(current, next.state);
          current.reportedUsage = prepared.nextUsage;
          current.version++; this.save(current, previous);
          const response = this.response(current, prepared.detail, false, undefined, next.dispatch, true);
          this.storeReceipt(args.run_id, args.command_id, prepared.fingerprint, response);
          return response;
        });
      }
      const args = legacyRecipeLazyInputs["mcp.tool.recipe_run_next"].parse(value), detail = responseDetail(args.detail, "compact");
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
      const { state, dispatch } = await this.dispatchOne(args.run_id);
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
    this.workflow.close(); this.closed = true;
  }
}
