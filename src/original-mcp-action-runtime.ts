import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import type { ActionRuntime } from "./action-runtime.js";
import { readActionCompiler } from "./action-compiler.js";
import { builtinActionDefinitions, originalDefinitionValue, originalDigest } from "./domain/action-compiler-validation.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, originalMcpRequestDigest,
  withOriginalMcpPublicRequest, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { appendOriginalActionValidation, readOriginalActionValidation,
  type OriginalActionValidationJob } from "./original-mcp-action-validation.js";
import { assertOriginalMcpActionDomainSession, assertOriginalMcpActionImplementation, originalMcpActionRunIsAdmitted,
  originalMcpActionSourceIsAdmitted, originalMcpActionRunOrigin, originalMcpActionRelatedRuns, originalMcpActionRunNeedsAdmission,
  readOriginalMcpActionSource, readOriginalMcpActionModuleSets, reconcileOriginalMcpActionRun,
  originalMcpActionValidationNeedsAdmission, assertOriginalMcpActionRecoveryCoverage, invokeOriginalMcpAction,
  authorizeOriginalMcpActionContinuation, originalMcpActionBlockedContinuations } from "./original-mcp-action-domain.js";
import { readOriginalActionInvocations } from "./original-mcp-action-invocation.js";
import { legacyActionRead, legacyActionWrite } from "./legacy-action-mcp.js";
import { maintainOriginalMcpAction } from "./original-mcp-action-maintenance.js";
import { readActionGcRecords } from "./action-artifact-gc-records.js";
import { originalCosmosAction, nativeCosmosDefinition } from "./original-mcp-cosmos.js";

import { originalMcpActionRuntimeTools as tools, originalMcpActionOperationIds } from "./original-mcp-action-tools.js";
export { originalMcpActionOperationIds } from "./original-mcp-action-tools.js";
export interface OriginalMcpActionRuntime {
  readonly operationIds: readonly string[];
  invoke(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}
const priorities: Record<string, number> = { demand: 0, graph: 1, module_set: 2, idle: 3 };
const engineEpochs = new WeakMap<ActionRuntime, string>();
interface ValidationActivity { active: Set<string>; worker?: Promise<void>; restart?: () => void }
const engineValidation = new WeakMap<ActionRuntime, ValidationActivity>();
type Json = Record<string, any>;
const objectResult = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const reply = (value: Json): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const failed = (message: string): never => { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message); };
const timestamp = () => new Date().toISOString();

/** Local canonical-native controls only. Archived Action files, old workers and old grants confer no authority. */
export async function createOriginalMcpActionRuntime(owner: RootOwner, inputActor: Readonly<Actor>,
  host: OriginalMcpNativeHost): Promise<OriginalMcpActionRuntime> {
  assertRootOwner(owner);
  const actor = Object.freeze({ ...inputActor }), { storage, runtime } = await owner.ensureFull();
  assertOriginalMcpNativeHost(host, storage);
  const source = originalPublicMcpContracts() as { provenance: { metadataSha256: string }; contracts: Json[] };
  if (actor.id !== "mcp:external" || actor.boardWorker || actor.recipeProtocol
    || host.receipt.sourceCatalogSha256 !== source.provenance.metadataSha256 || !host.receipt.domains.includes("mcp-public"))
    throw new CoreError("ACCESS_DENIED", "Action controls require the same canonical native host and fixed original external actor.");
  const contracts = new Map(source.contracts.filter(item => tools.includes(item.transportName)).map(item => [item.transportName, item]));
  const validator = new AjvJsonSchemaValidator();
  const workspaceId = await storage.workspaceId(), service = runtime.services.hostServices;
  const engine = service?.actionRuntime;
  let epoch = engine && engineEpochs.get(engine);
  if (engine && !epoch) { epoch = randomUUID(); engineEpochs.set(engine, epoch); }
  const activity: ValidationActivity = engine && engineValidation.get(engine) || { active: new Set<string>() };
  if (engine) engineValidation.set(engine, activity);
  const lifetime = new AbortController();
  const pending = new Set<Promise<CallToolResult>>();
  let closed = false, worker: Promise<void> | undefined, closing: Promise<void> | undefined;
  function check(signal?: AbortSignal) {
    if (closed) throw new CoreError("CLOSED", "Original Action adapter is closed.");
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    assertRootOwner(owner); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
  }
  async function core(operation: string, args: Json, write = false) {
    check();
    const response = await runtime.core.dispatch(write ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: args }, actor);
    if (response.error) {
      if (response.error.code === "NOT_AVAILABLE") failed("ACTION_NATIVE_ENGINE_REQUIRED: this owner has no admitted native Action engine.");
      throw new CoreError(response.error.code, response.error.message, response.error.effect);
    }
    return response.result as Json;
  }
  async function nativeEngine() {
    const available = await runtime.core.dispatch("capabilities_describe", { operation: "action.runtime.get" }, actor);
    if (!engine || !service || available.error)
      return failed("ACTION_NATIVE_ENGINE_REQUIRED: Action source/effect authority must be composed on this canonical owner; old settings are archival.");
    return engine;
  }
  async function exclusive<T>(work: () => T): Promise<T> {
    return storage.withWorkspaceExclusive(() => { check(); const value = work(); check(); return value; });
  }
  async function queue<T>(work: (jobs: Map<string, OriginalActionValidationJob>,
    save: (job: OriginalActionValidationJob) => void) => T): Promise<T> {
    return exclusive(() => {
      const database = storage.connectNative();
      try {
        database.exec("BEGIN IMMEDIATE");
        const state = readOriginalActionValidation(database, workspaceId);
        const value = work(state.jobs, job => appendOriginalActionValidation(database, workspaceId, job));
        check(); database.exec("COMMIT"); return value;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      } finally { database.close(); }
    });
  }
  async function definition(actionId: string, digest?: string) {
    const builtin = builtinActionDefinitions().get(actionId);
    const original = originalMcpActionSourceIsAdmitted(storage, actionId) ? readOriginalMcpActionSource(storage, host, actionId) : undefined;
    const value = original ?? builtin ?? (service?.automaticActionTrustEnabled ? await service.readRegisteredAction(actor, actionId) : undefined);
    check();
    if (!value) return failed("ACTION_SOURCE_ADMISSION_REQUIRED: the original Action source has no current exact native registration.");
    const native = originalDefinitionValue(value);
    if (digest !== undefined && native.content_hash !== digest) throw new CoreError("CONFLICT", "Pin the current Action definition.");
    return native;
  }
  async function pureValidationDefinition(actionId: string, digest: string) {
    if (!builtinActionDefinitions().has(actionId))
      throw new CoreError("ACCESS_DENIED", "ACTION_CODE_REVIEW_REQUIRED: non-builtin Actions require native Workbench review and exact source admission.");
    const value = await definition(actionId, digest);
    if (!Array.isArray(value.effects) || value.effects.length !== 1 || value.effects[0] !== "pure")
      return failed("ACTION_EFFECT_CONSENT_REQUIRED: public allow_effects is not a native effect grant.");
    await nativeEngine();
    return value;
  }
  async function eventPage(runId: string, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new CoreError("INVALID_ARGUMENT", "after_sequence must be a nonnegative integer.");
    const first = await core("action.runtime.events", { runId, after: 0, limit: 1 });
    const origin = originalMcpActionRunIsAdmitted(storage, runId) ? originalMcpActionRunOrigin(storage, host, runId) : undefined;
    const historySchema = z.array(z.strictObject({ sequence: z.number().safe().int().positive(), run_id: z.string(),
      kind: z.string(), at: z.number().finite(), payload: z.record(z.string(), z.json()) })).max(256);
    const historical = origin ? historySchema.parse(origin.notifications ?? []) : [];
    const base = origin ? z.number().safe().int().nonnegative().parse(origin.event_sequence ?? 0) : 0;
    const latest = Number(first.latestSequence), oldest = Math.max(Number(first.oldestSequence), latest - 255);
    const events: Json[] = [];
    let cursor = Math.max(after - base, oldest - 1);
    while (cursor < latest) {
      const previous = cursor;
      const page = await core("action.runtime.events", { runId, after: cursor, limit: 100 });
      if (!Array.isArray(page.items) || !page.items.length) break;
      for (const event of page.items) {
        if (event.sequence > latest) break;
        events.push({ sequence: base + event.sequence, run_id: runId, kind: event.kind, at: event.at / 1000,
          payload: { version: event.version, state: event.state, ...(event.nodeId ? { node_id: event.nodeId } : {}) } });
        cursor = event.sequence;
      }
      if (events.length >= 256 || cursor >= latest || cursor === previous) break;
    }
    const retained = [...historical.filter(event => event.sequence > after), ...events].slice(-256);
    const nativeCount = latest ? latest - oldest + 1 : 0;
    const firstAvailable = nativeCount >= 256 ? base + oldest
      : historical.slice(-Math.max(0, 256 - nativeCount))[0]?.sequence ?? base + oldest;
    return { events: retained, next_sequence: base + latest, gap: after < firstAvailable - 1,
      delivery: "Replayable pull/active-wait delivery, not unsolicited agent wakeup.", retention: 256 };
  }
  async function runView(runId: string) {
    const run = await core("action.runtime.get", { runId });
    const database = storage.connectNative();
    let gc: ReturnType<typeof readActionGcRecords>;
    try { gc = readActionGcRecords(database, workspaceId).filter(item => item.actorId === actor.id && item.runId === runId); }
    finally { database.close(); }
    const origin = originalMcpActionRunIsAdmitted(storage, runId) ? originalMcpActionRunOrigin(storage, host, runId) : undefined;
    const state = run.state === "unknown" ? "outcome_unknown" : run.state;
    let output: Record<string, unknown> | undefined, unavailable = false;
    if (run.state === "succeeded" && !gc.some(record => record.releaseOutputs)) {
      try {
        const call = readOriginalActionInvocations(storage, workspaceId).find(item => item.runId === runId);
        const source = origin || call ? readOriginalMcpActionSource(storage, host, String(origin?.action_id ?? call!.request.action_id)) : undefined;
        output = source ? engine!.getOwnedResult(actor.id, runId, source)
          : service?.automaticActionTrustEnabled
            ? await service.readAutomaticActionResult(actor, runId) ?? engine!.getCurrentOwnedResult(actor.id, runId)
            : engine!.getCurrentOwnedResult(actor.id, runId);
      }
      catch (error) {
        if (!(error instanceof CoreError) || error.code !== "ACCESS_DENIED") throw error;
        unavailable = true;
      }
    }
    const checkpoint = engine!.checkpoints(actor.id, runId).checkpoints.at(-1);
    const execution = origin ? {
      schema: "pkm.action.execution/v1", version: run.version, fence: run.version, workerPid: null,
      phase: state === "outcome_unknown" ? "reconciling" : state === "waiting" ? "waiting"
        : state === "ready" ? "ready" : ["running", "cancelling"].includes(state) ? "started" : "completed",
      owner: state === "outcome_unknown" ? "user" : state === "waiting" ? checkpoint?.owner ?? "user" : "native-action-plan",
      definitionRevision: run.definitionDigest, automaticReplay: false,
      reasonCode: state === "outcome_unknown" ? "native-reconciliation-required" : "original-source-state-admitted",
    } : undefined;
    return { ...(origin ?? {}), schema: "pkm.action.run/v1", engine: "native-action-plan", run_id: run.runId, action_id: run.actionId, content_hash: run.definitionDigest,
      state, version: run.version, deadline: run.deadline / 1000, productObject: "Run",
      ok: !["failed", "cancelled", "outcome_unknown"].includes(state),
      userState: state === "outcome_unknown" ? "Reconciling" : state === "waiting" ? "Waiting"
        : state === "running" ? "Running" : state === "succeeded" ? "Completed" : state === "cancelled" ? "Cancelled" : "Blocked",
      nodes: run.nodes, nextOwner: state === "outcome_unknown" ? "user" : state === "waiting" ? checkpoint?.owner ?? "user"
        : ["ready", "running", "cancelling"].includes(state) ? "execution-host" : "none",
      ...(checkpoint ? { checkpoint } : {}), ...(output ? {
        output: originalCosmosAction(run.actionId) ? output.result : output } : {}),
      ...(gc.length ? { gc_state: gc.at(-1)!.gcState } : {}),
      ...(execution ? { execution, legacy_execution: origin!.execution } : {}),
      ...(unavailable ? { output_availability: { state: "blocked", reason: "ACCESS_DENIED" } } : {}) };
  }
  async function scan(limit = 8) {
    const blocked = await originalMcpActionBlockedContinuations(storage, host);
    if (blocked.length) return { ok: false, dispatched: [], reviewed: [], blocked,
      reason: "ACTION_CONTINUATION_APPROVAL_REQUIRED" };
    const { result, versions } = await exclusive(() => {
      const result = engine!.scanCheckpoints(actor.id, limit);
      return { result, versions: new Map(result.ready.map(id => [id, engine!.get(actor.id, id).version])) };
    });
    service!.wake();
    const dispatched: string[] = [];
    for (const id of result.ready) {
      const current = await core("action.runtime.get", { runId: id });
      if (current.version > versions.get(id)!) dispatched.push(id);
    }
    return { ok: true, dispatched, reviewed: result.reviewed };
  }
  async function cancelRun(runId: string) {
    const record = await runView(runId), run = engine!.get(actor.id, runId);
    await core("action.runtime.cancel", { operationId: randomUUID(), runId, expectedVersion: run.version }, true);
    return { ...record, cancel_requested: ["ready", "running", "waiting", "cancelling"].includes(run.state), remote_rollback: false };
  }
  async function reconcileQueue() {
    return queue((jobs, save) => {
      const reviewed: string[] = [];
      for (const job of jobs.values()) if (job.state === "running" && (job.worker !== epoch || !activity.active.has(job.job_id))) {
        save({ ...job, state: "outcome_unknown", stage: "reconciliation_required", completed_at: timestamp() });
        reviewed.push(job.job_id);
      }
      return reviewed;
    });
  }
  async function update(jobId: string, fields: Partial<OriginalActionValidationJob>) {
    return queue((jobs, save) => {
      const job = jobs.get(jobId);
      if (!job) throw new CoreError("NOT_FOUND", "Owned native Action validation job not found.");
      if (!["queued", "running"].includes(job.state)) return job;
      const value = { ...job, ...fields };
      if (value.cancel_requested && value.state === "succeeded") { value.state = "cancelled"; value.stage = "cancelled"; }
      save(value); return value;
    });
  }
  async function validate(actionId: string, digest: string, jobId?: string, signal?: AbortSignal) {
    const value = await pureValidationDefinition(actionId, digest);
    const source = { kind: "inline" as const, definition: value };
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } }) as Json;
    if (compiled.status !== "valid") throw new CoreError("INVALID_DEFINITION", "Native Action compiler rejected this exact builtin.");
    const evidence: { run_id: string; passed: boolean }[] = [];
    if (!Array.isArray(value.examples) || !value.examples.length)
      return failed("ACTION_VALIDATION_FIXTURE_REQUIRED: qualification requires real native builtin examples.");
    for (const example of value.examples) {
      check(signal);
      if (jobId) {
        const cancelled = await queue(jobs => jobs.get(jobId)?.cancel_requested);
        if (cancelled) throw new CoreError("CANCELLED", "Validation cancelled before the next example.");
      }
      const runId = `validation-run-${randomUUID()}`;
      await core("action.runtime.create", { operationId: randomUUID(), runId, source,
        expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 30_000, inputs: example.inputs }, true);
      if (jobId) await update(jobId, { run_id: runId });
      try {
        for (;;) {
          check(signal);
          const run = await core("action.runtime.get", { runId });
          if (!["ready", "running", "cancelling"].includes(run.state)) {
            if (run.state === "unknown" || run.state === "waiting") throw new CoreError("RECOVERY_REQUIRED", "Qualification outcome requires reconciliation; never replay it.");
            const output = run.state === "succeeded" ? engine!.getCurrentOwnedResult(actor.id, runId) : undefined;
            evidence.push({ run_id: runId, passed: run.state === "succeeded"
              && (!Object.hasOwn(example, "output") || originalDigest(example.output) === originalDigest(output)) });
            break;
          }
          if (jobId && await queue(jobs => jobs.get(jobId)?.cancel_requested))
            throw new CoreError("CANCELLED", "Validation cancellation requested; remote rollback is not promised.");
          await sleep(10, undefined, { signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
        }
      } catch (error) {
        if (!closed) await cancelRun(runId).catch(() => {});
        throw error;
      }
    }
    const passed = evidence.every(item => item.passed);
    return { ok: passed, state: "tested", schema: "pkm.action.validation/v1", action_id: actionId, content_hash: digest,
      environment_fingerprint: originalMcpRequestDigest({ workspaceId, engine: epoch, definition: compiled.definitionDigest }),
      status: passed ? "passed" : "failed", validation_mode: "examples", validated_at: timestamp(), evidence };
  }
  function startQueue() {
    if (closed) return;
    if (activity.worker || activity.active.size) { activity.restart = startQueue; return; }
    activity.restart = undefined;
    worker = Promise.resolve().then(async () => {
      for (;;) {
        check();
        let claimed: string | undefined;
        const job = await queue((jobs, save) => {
          if (activity.active.size) return;
          const candidate = [...jobs.values()].filter(item => item.state === "queued").sort((a, b) =>
            a.priority - (Date.now() / 1000 - a.queued_at) / 300 - (b.priority - (Date.now() / 1000 - b.queued_at) / 300)
            || a.queued_at - b.queued_at)[0];
          if (!candidate) return;
          const value = { ...candidate, state: "running" as const, stage: "preflight", worker: epoch, started_at: timestamp() };
          save(value); claimed = value.job_id; activity.active.add(value.job_id); return value;
        }).catch(error => { if (claimed) activity.active.delete(claimed); throw error; });
        if (!job) return;
        try {
          const result = await validate(job.action_id, job.content_hash, job.job_id);
          const cancelled = await queue(jobs => jobs.get(job.job_id)?.cancel_requested);
          await update(job.job_id, { state: cancelled ? "cancelled" : result.ok ? "succeeded" : "failed",
            stage: cancelled ? "cancelled" : result.ok ? "qualified" : "test_failed", completed_at: timestamp(), evidence: result.evidence });
        } catch (error) {
          if (closed) return;
          await update(job.job_id, { state: error instanceof CoreError && error.code === "CANCELLED" ? "cancelled"
            : error instanceof CoreError && error.code === "RECOVERY_REQUIRED" ? "outcome_unknown" : "blocked",
          stage: "validation_failed", completed_at: timestamp(), error: error instanceof Error ? error.message : "Native qualification failed." });
        } finally { activity.active.delete(job.job_id); }
      }
    }).catch(() => {}).finally(() => {
      if (activity.worker === worker) activity.worker = undefined;
      worker = undefined;
      const restart = activity.restart; activity.restart = undefined; restart?.();
    });
    activity.worker = worker;
  }
  async function execute(tool: string, args: Json, signal?: AbortSignal): Promise<Json> {
    check(signal);
    switch (tool) {
      case "action_run_gc":
      case "action_cosmos_configure":
        return maintainOriginalMcpAction(storage, engine!, host, actor, tool, args, signal);
      case "action_call": {
        let created: { runId: string; launchReused?: boolean };
        if (originalCosmosAction(args.action_id)) {
          if (!service?.automaticActionTrustEnabled) failed("ACTION_NATIVE_ENGINE_REQUIRED");
          const definition = nativeCosmosDefinition(storage, host, args.action_id);
          if (definition.content_hash !== args.content_hash)
            throw new CoreError("CONFLICT", "The pinned Cosmos configuration or executable revision changed.");
          const authored = Object.fromEntries(Object.entries(definition).filter(([key]) =>
            !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key)));
          await legacyActionWrite(storage, actor, { tool: "action_register", arguments: { definition: authored as Json } },
            (principal, proposalId, contentHash) => service!.admitActionProposal(principal, proposalId, contentHash));
        }
        if (!originalMcpActionSourceIsAdmitted(storage, args.action_id) && service?.automaticActionTrustEnabled) {
          if (args.trigger != null || args.project_id != null)
            throw new CoreError("ACCESS_DENIED", "Scheduled/project Action calls require their exact independent native authority.");
          created = await service.createActionRunFromProposal(actor, { actionId: args.action_id, contentHash: args.content_hash,
            inputs: args.inputs, idempotencyKey: args.idempotency_key }) as typeof created;
        } else created = await invokeOriginalMcpAction(owner, actor, host, args, signal);
        return { ...await runView(created.runId), launch_reused: created.launchReused };
      }
      case "action_run_events": return { run_id: args.run_id, ...await eventPage(args.run_id, args.after_sequence ?? 0) };
      case "action_run_get": return runView(args.run_id);
      case "action_get": {
        if (originalCosmosAction(args.action_id))
          return { ...nativeCosmosDefinition(storage, host, args.action_id), visibility: "private", exportable: false,
            direct_only: true, backend: "az-dls-fs" };
        if (!originalMcpActionSourceIsAdmitted(storage, args.action_id)) {
          const registered = service?.automaticActionTrustEnabled ? await service.readRegisteredAction(actor, args.action_id) : undefined;
          const native = registered ?? builtinActionDefinitions().get(args.action_id);
          if (!native) return failed("ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED: the Action has no current source/registration admission.");
          const value = await legacyActionRead(storage, actor, { tool: "action_get", arguments: { action_id: args.action_id } },
            undefined, async () => native);
          if (!objectResult(value)) throw new CoreError("INVALID_RESULT", "Native source reader returned no typed definition.");
          return registered ? value : { ...value, availability: { state: "blocked",
            reason: "ORIGINAL_ACTION_EXACT_INVOCATION_APPROVAL_REQUIRED" } };
        }
        const value = await legacyActionRead(storage, actor, { tool: "action_get", arguments: { action_id: args.action_id } },
          undefined, async () => readOriginalMcpActionSource(storage, host, args.action_id));
        if (!objectResult(value)) throw new CoreError("INVALID_RESULT", "Original source reader returned no typed definition.");
        return { ...value, availability: { state: "blocked", reason: "ORIGINAL_ACTION_EXACT_INVOCATION_APPROVAL_REQUIRED",
          detail: "Source/state custody does not grant a new invocation or credential/process effect." } };
      }
      case "action_module_sets": return readOriginalMcpActionModuleSets(storage, host);
      case "action_run_reconcile":
        if (!await service?.reconcileAutomaticActionRun(actor,
          originalCosmosAction(engine!.get(actor.id, args.run_id).actionId) && args.evidence?.output !== undefined
            ? { ...args, evidence: { ...args.evidence, output: { result: args.evidence.output } } } : args))
          await reconcileOriginalMcpActionRun(owner, actor, host, args as Parameters<typeof reconcileOriginalMcpActionRun>[3]);
        return runView(args.run_id);
      case "action_run_cancel": return cancelRun(args.run_id);
      case "action_run_wait": {
        const seconds = args.wait_seconds ?? 30, after = args.after_sequence;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300 || after != null && (!Number.isSafeInteger(after) || after < 0))
          throw new CoreError("INVALID_ARGUMENT", "Wait requires 0..300 finite seconds and an optional nonnegative event cursor.");
        const deadline = performance.now() + seconds * 1000;
        for (;;) {
          check(signal);
          await scan();
          const run = await runView(args.run_id), delivery = await eventPage(args.run_id, after ?? 0);
          if (!["ready", "running", "waiting", "cancelling"].includes(run.state)) return { ...run, event_delivery: delivery };
          if (after != null && (delivery.events.length || delivery.gap))
            return { ...run, event_update: true, completed: false, event_delivery: delivery };
          if (performance.now() >= deadline) return { ...run, wait_expired: true, completed: false, event_delivery: delivery };
          await sleep(Math.min(25, Math.max(0, deadline - performance.now())), undefined,
            { signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
        }
      }
      case "action_run_checkpoints": return exclusive(() => {
        const original = originalMcpActionRunIsAdmitted(storage, args.run_id);
        const ids = original ? originalMcpActionRelatedRuns(storage, host, args.run_id) : [args.run_id];
        const checkpoints = ids.flatMap(id => engine!.checkpoints(actor.id, id, args.include_history ?? false).checkpoints);
        const origin = original ? originalMcpActionRunOrigin(storage, host, args.run_id) : undefined;
        if (origin && objectResult(origin.definition) && objectResult(origin.definition.dependencies)
          && Object.keys(origin.definition.dependencies).length)
          return failed("ACTION_NESTED_CHECKPOINT_ADMISSION_REQUIRED: nested historical roots need their exact invocation-tree admission.");
        const oldCheckpoint = origin && objectResult(origin.checkpoint) ? origin.checkpoint : undefined;
        if (oldCheckpoint && !checkpoints.some(item => item.checkpoint_id === oldCheckpoint.checkpoint_id))
          return failed("ACTION_CONTINUATION_REBIND_REQUIRED: this historical nested/unsupported checkpoint requires native reconciliation.");
        return { ok: true, checkpoints };
      });
      case "action_checkpoint_respond": {
        await authorizeOriginalMcpActionContinuation(owner, actor, host, tool, args, signal);
        const value = await exclusive(() => engine!.respondCheckpoint(actor.id, args as never)); service!.wake(); return value;
      }
      case "action_run_wake": {
        await authorizeOriginalMcpActionContinuation(owner, actor, host, tool, args, signal);
        const value = await exclusive(() => engine!.wakeCheckpoint(actor.id, args.run_id, args.event_key, args.event_name)); service!.wake(); return value;
      }
      case "action_run_recover": {
        assertOriginalMcpActionRecoveryCoverage(storage, host);
        const reconciled = await exclusive(() => engine!.recoverInterrupted(actor.id));
        await reconcileQueue();
        return { ok: true, reconciled, dispatched: [] };
      }
      case "action_run_safety_scan": {
        return scan(args.limit ?? 8);
      }
      case "action_implementation_select": {
        if (originalMcpActionSourceIsAdmitted(storage, args.action_id))
          assertOriginalMcpActionImplementation(storage, host, args.action_id, args.implementation_id);
        const value = await definition(args.action_id);
        const source = { kind: "inline" as const, definition: value };
        const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } }) as Json;
        return exclusive(() => engine!.selectImplementation(actor.id,
          { ...source, definition: z.json().parse(source.definition) }, compiled.definitionDigest, args.implementation_id));
      }
      case "action_validate": {
        // inputs is used by host-specific transfer validation, never as a public effect grant.
        await pureValidationDefinition(args.action_id, args.content_hash);
        if (activity.active.size) throw new CoreError("BUSY", "A canonical native qualification is already active.");
        const jobId = `validation_${randomUUID().replaceAll("-", "")}`;
        activity.active.add(jobId);
        try {
          await queue((_jobs, save) => save({ job_id: jobId, key: originalMcpRequestDigest({ direct: jobId }),
            action_id: args.action_id, content_hash: args.content_hash, priority: 0, allow_effects: false,
            queued_at: Date.now() / 1000, state: "running", stage: "test", depends_on: [], worker: epoch, started_at: timestamp() }));
          const result = await validate(args.action_id, args.content_hash, jobId, signal);
          const completed = await update(jobId, { state: result.ok ? "succeeded" : "failed", stage: result.ok ? "qualified" : "test_failed",
            completed_at: timestamp(), evidence: result.evidence });
          if (result.ok && completed.state !== "succeeded") throw new CoreError("CANCELLED", "Qualification was cancelled before its evidence committed.");
          return result;
        } catch (error) {
          if (!closed) await update(jobId, { state: "outcome_unknown", stage: "reconciliation_required", completed_at: timestamp() });
          throw error;
        } finally { activity.active.delete(jobId); if (!closed) startQueue(); }
      }
      case "action_validation_enqueue": {
        await pureValidationDefinition(args.action_id, args.content_hash);
        const priority = args.priority ?? "demand";
        if (!Object.hasOwn(priorities, priority)) throw new CoreError("INVALID_ARGUMENT", "Invalid validation priority.");
        await reconcileQueue();
        const jobId = await queue((jobs, save) => {
          const key = originalMcpRequestDigest({ action: args.action_id, hash: args.content_hash, workspaceId,
            platform: process.platform, architecture: process.arch });
          const existing = [...jobs.values()].find(item => item.key === key && ["queued", "running"].includes(item.state));
          if (existing) { save({ ...existing, priority: Math.min(existing.priority, priorities[priority]!) }); return existing.job_id; }
          const job_id = `validation_${randomUUID().replaceAll("-", "")}`;
          save({ job_id, key, action_id: args.action_id, content_hash: args.content_hash, priority: priorities[priority]!,
            allow_effects: args.allow_effects ?? false, queued_at: Date.now() / 1000, state: "queued", stage: "queued", depends_on: [] });
          return job_id;
        });
        startQueue(); return { ok: true, job_id: jobId, dependencies: [jobId], priority };
      }
      case "action_validation_status": {
        await reconcileQueue();
        return queue(jobs => {
          const sorted = [...jobs.values()].sort((a, b) => Number(!["queued", "running"].includes(a.state))
            - Number(!["queued", "running"].includes(b.state)) || b.queued_at - a.queued_at);
          const counts: Record<string, number> = {};
          for (const job of sorted) counts[job.state] = (counts[job.state] ?? 0) + 1;
          return { ok: true, worker_pid: sorted.some(job => job.state === "running" && job.worker === epoch) ? process.pid : null,
            max_concurrency: 1, counts, jobs: sorted.slice(0, 250).map(({ worker: _worker, ...job }) => job) };
        });
      }
      case "action_validation_cancel": {
        const value = await queue((jobs, save) => {
          const job = jobs.get(args.job_id);
          if (!job) throw new CoreError("NOT_FOUND", "Owned native validation job not found.");
          const value = job.state === "queued" ? { ...job, state: "cancelled" as const, stage: "cancelled" }
            : job.state === "running" ? { ...job, cancel_requested: true } : job;
          save(value); return value;
        });
        if (value.cancel_requested && value.run_id) await cancelRun(value.run_id);
        const { worker: _worker, ...job } = value;
        return { ok: true, job, remote_rollback: false };
      }
      case "action_validation_resume": {
        await reconcileQueue();
        if (await queue(jobs => [...jobs.values()].some(job => job.state === "queued"))) startQueue();
        return { ok: true, worker_pid: activity.worker ? process.pid : null, max_concurrency: 1 };
      }
      default: return failed("ACTION_NATIVE_PROTOCOL_REQUIRED: this operation has no complete typed native adapter.");
    }
  }
  async function close() {
    if (closing) return closing;
    closed = true; lifetime.abort();
    closing = Promise.allSettled([...pending, ...(worker ? [worker] : [])]).then(() => {});
    return closing;
  }
  owner.retainResource({ closeAdmission() { closed = true; lifetime.abort(); }, release: close });
  return Object.freeze({
    operationIds: originalMcpActionOperationIds,
    invoke(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
      const task = invoke(tool, args, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
      pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    close,
  });
  async function invoke(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    check(signal);
    const contract = contracts.get(tool);
    if (!contract) return failed("ACTION_NATIVE_PROTOCOL_REQUIRED: operation is outside the implemented local Action control slice.");
    if (!contract.readOnly && !actor.canWrite) throw new CoreError("ACCESS_DENIED", "This original Action principal is read-only.");
    if (!validator.getValidator(contract.inputSchema)(args).valid)
      throw new CoreError("INVALID_ARGUMENT", "Arguments violate the independently pinned actual151 Action contract.");
    const pinned = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const perform = async () => {
      await nativeEngine();
      if ((tool.startsWith("action_validation_") || tool === "action_validate") && originalMcpActionValidationNeedsAdmission(storage))
        assertOriginalMcpActionDomainSession(storage, host);
      if (typeof pinned.run_id === "string" && originalMcpActionRunIsAdmitted(storage, pinned.run_id))
        assertOriginalMcpActionDomainSession(storage, host);
      else if (typeof pinned.run_id === "string" && readOriginalActionInvocations(storage, workspaceId).some(item => item.runId === pinned.run_id))
        assertOriginalMcpActionDomainSession(storage, host);
      else if (typeof pinned.run_id === "string" && originalMcpActionRunNeedsAdmission(storage, pinned.run_id))
        return failed("ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED: historical Runs are preserved, not inherited by a new worker.");
      const value = await execute(tool, pinned, signal); check(signal); return reply(value);
    };
    const approval = { operation: contract.id, version: 1 as const, tool,
      readOnly: contract.readOnly, arguments: pinned, argumentsDigest: originalMcpRequestDigest(pinned) };
    if (originalMcpPublicRequestMatches(storage, host, approval)) return perform();
    return withOriginalMcpPublicRequest(storage, host, approval, perform, signal);
  }
}
