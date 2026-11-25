import { z } from "zod";
import { CoreError } from "./contracts.js";
import { readActionCompiler } from "./action-compiler.js";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import {
  actionComponents, actionDefinitionDiagnostics, builtinActionDefinitions, exactRunnableArtifactBuiltin, originalDefinitionValue, originalDigest, loadModuleSet,
  moduleSnapshotDefinitions, validateActionDefinition,
  type ActionModuleSnapshot,
} from "./domain/action-compiler-validation.js";
import { ORIGINAL_LEGACY_ACTION_MCP as original } from "./domain/legacy-action-mcp-original.js";
import {
  LEGACY_ACTION_RUNTIME_UNAVAILABLE, legacyActionCatalogSources, readLegacyActionCatalogSources,
} from "./legacy-action-catalog.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { actionRuntimeDefinitions } from "./action-runtime-contracts.js";
import { resolveActionExecutable } from "./action-program-build.js";

export type LegacyActionRuntimeReader = (
  operation: "action.runtime.get",
  args: { runId: string },
) => Promise<unknown>;

const object = z.record(z.string(), z.json());
const proposal = z.strictObject({
  schema: z.literal("pkm.action.proposal/v1"),
  proposal_id: z.string().regex(/^proposal_[a-f0-9]{32}$/), state: z.literal("pending"),
  action_id: z.string(), content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  base_content_hash: z.null(), definition: object, submitted_at: z.string().datetime(),
});
const record = z.strictObject({
  actorId: z.literal("mcp:external"), workspaceId: z.string().min(1), proposal,
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const table = "legacy_action_mcp_proposals";
const ddl = `
CREATE TABLE legacy_action_mcp_proposals(proposal_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TRIGGER legacy_action_mcp_proposals_no_update BEFORE UPDATE ON legacy_action_mcp_proposals BEGIN SELECT RAISE(ABORT,'original Action proposal immutable'); END;
CREATE TRIGGER legacy_action_mcp_proposals_no_delete BEFORE DELETE ON legacy_action_mcp_proposals BEGIN SELECT RAISE(ABORT,'original Action proposal immutable'); END;`;
export const legacyActionProposalDdl = ddl;

export const legacyActionCapabilitiesRequest = z.strictObject({
  tool: z.literal("action_capabilities"), arguments: z.strictObject({}),
});

export function legacyActionCapabilitiesRead(actor: Actor,
  input: z.infer<typeof legacyActionCapabilitiesRequest>) {
  assertActor(actor);
  legacyActionCapabilitiesRequest.parse(input);
  return {
    schema: "pkm.action.capabilities.limited/v1",
    originalSchema: "pkm.action.capabilities/v1",
    compatibility: "limited-projection",
    runtimeStatus: "not-runnable-here",
    limitation: "Compiler metadata only, not the original runtime capability contract. No host/provider discovery, execution, qualification or mutation is performed.",
    unavailableOriginalFields: [
      "version", "registry", "authoring", "execution_host", "scheduler_error", "workspace_setting",
      "settings", "platform", "trusted_host_execution_is_sandboxed", "tools", "builtins",
      "basic_components", "enabled_platform_actions",
    ],
    compiler: readActionCompiler({ operation: "action.compiler.capabilities", args: {} }),
  };
}

export const legacyActionReadRequest = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("action_definition_check"),
    arguments: z.strictObject({ definition: z.record(z.string(), z.json()) }),
  }),
  z.strictObject({
    tool: z.literal("action_graph_check"),
    arguments: z.strictObject({ graph: z.record(z.string(), z.json()) }),
  }),
  z.strictObject({ tool: z.literal("action_templates"), arguments: z.strictObject({}) }),
  z.strictObject({ tool: z.literal("action_retrieve"), arguments: z.strictObject({
    task: z.string(), limit: z.number().int().default(1),
  }) }),
  z.strictObject({ tool: z.literal("action_proposals"), arguments: z.strictObject({}) }),
  z.strictObject({ tool: z.literal("action_get"), arguments: z.strictObject({ action_id: z.string() }) }),
  z.strictObject({ tool: z.literal("action_run_get"), arguments: z.strictObject({ run_id: z.string() }) }),
]);

export const legacyActionWriteRequest = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("action_register"), arguments: z.strictObject({ definition: object }),
  }),
  z.strictObject({
    tool: z.literal("action_graph_save"), arguments: z.strictObject({ graph: object }),
  }),
  z.strictObject({
    tool: z.literal("action_template_create"),
    arguments: z.strictObject({ action_id: z.string(), parameters: object }),
  }),
]);

export const legacyActionCallRequest = z.strictObject({
  action_id: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/),
  proposal_id: z.string().regex(/^proposal_[a-f0-9]{32}$/).optional(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  inputs: object,
  idempotency_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
});

function graphDefinition(graph: Record<string, unknown>, sourceModules: ActionModuleSnapshot[]) {
  const result = readActionCompiler({
    operation: "action.graph.compile", args: { graph: "edges" in graph ? graph : { ...graph, edges: [] }, sourceModules },
  }) as { status: string; definition?: Record<string, unknown>; diagnostics?: { message: string }[] };
  if (result.status !== "valid" || !result.definition)
    throw new CoreError("INVALID_ARGUMENT", result.diagnostics?.[0]?.message ?? "Invalid Action graph.");
  return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries({ ...result.definition, graph })
    .filter(([key]) => !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key))))) as Record<string, unknown>;
}
function checkDefinition(definition: Record<string, unknown>, sources: ActionModuleSnapshot[]) {
  const checked = readActionCompiler({
    operation: "action.definition.check", args: { source: { kind: "inline", definition } },
  }) as { ok: boolean; diagnostics: { message: string }[]; next_action: string };
  if (!sources.length) return checked;
  let diagnostics = actionDefinitionDiagnostics(definition);
  if (!diagnostics.length) diagnostics = validateActionDefinition(definition, moduleSnapshotDefinitions(sources));
  return { ...checked, ok: diagnostics.length === 0, diagnostics,
    next_action: diagnostics.length ? "fix_definition" : "action_register" };
}

async function templateDefinition(actionId: string, parameters: Record<string, unknown>, sources: ActionModuleSnapshot[]) {
  if (parameters.template_id === "azuredevops-pipeline-status") {
    const inputs = { organization: { type: "string", pattern: "^https://(?:dev\\.azure\\.com/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\\.visualstudio\\.com)/?$" },
      project: { type: "string", minLength: 1, maxLength: 256 }, run_id: { type: "string", pattern: "^[0-9]{1,40}$" } };
    const outputs = { remote_id: { type: "string" }, pipeline_id: { type: "string" }, observed_at: { type: "string" },
      url: { type: "string" }, status: { type: "string" }, result: { type: ["string", "null"] }, terminal: { type: "boolean" }, tasks: { type: "array" } };
    const script = fileURLToPath(new URL("../compat/legacy-action-azuredevops-query.py", import.meta.url));
    return { schema: "pkm.action.definition/v1", action_id: actionId, version: 1,
      description: "Explicit read-only Azure DevOps status; existing native host Azure CLI identity only. No install, login, queue, retry or credential export.",
      effects: ["remote-read"], dependencies: {}, examples: [],
      input_schema: { type: "object", properties: inputs, required: Object.keys(inputs), additionalProperties: false },
      output_schema: { type: "object", properties: outputs, required: Object.keys(outputs), additionalProperties: false },
      implementations: [{ id: "azure-cli", kind: "program", platforms: ["Linux", "Windows", "Darwin"],
        program: resolveActionExecutable("python3"), args: [script], files: [script], result_protocol: "pkm.action.result/v1" }] };
  }
  const monitoring = parameters.template_id === "monitor";
  const parametersWithoutKind = monitoring
    ? Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== "template_id")) : parameters;
  const keys = ["query_action_id", "query_revision", "query_inputs", "interval_seconds", "timeout_seconds", "max_iterations",
    ...(monitoring ? [] : ["field", "expected"])];
  if (Object.keys(parametersWithoutKind).length !== keys.length || keys.some(key => !Object.hasOwn(parametersWithoutKind, key)))
    throw new CoreError("INVALID_ARGUMENT", monitoring ? "Monitor requires exact query pins/inputs and bounded observation settings."
      : "Poll template requires exactly the declared parameters.");
  const queryId = parameters.query_action_id;
  if (typeof queryId !== "string") throw new CoreError("INVALID_ARGUMENT", "Invalid query Action ID.");
  const rawQuery = moduleSnapshotDefinitions(sources).get(queryId);
  if (!rawQuery) throw new CoreError("NOT_AVAILABLE", "The pinned query must be a builtin or selected native-admitted ModuleSet Action.");
  const query = originalDefinitionValue(rawQuery);
  if (query.content_hash !== parameters.query_revision || !Array.isArray(query.effects)
    || query.effects.some(effect => !["pure", "read", "local-read", "remote-read"].includes(String(effect))))
    throw new CoreError("ACCESS_DENIED", "Poll query must be pinned and read-only.");
  const output = query.output_schema as { properties?: Record<string, Record<string, unknown>>; required?: unknown[] };
  const properties = output?.properties ?? {};
  if (monitoring && (!["remote_id", "terminal", "result"].every(key => Object.hasOwn(properties, key) && output.required?.includes(key))
    || properties.terminal?.type !== "boolean" || properties.remote_id?.type !== "string"))
    throw new CoreError("INVALID_ARGUMENT", "Monitor queries must require remote_id, terminal and result output fields.");
  const field = monitoring ? "terminal" : parameters.field;
  if (typeof field !== "string" || !field || !Object.hasOwn(properties, field))
    throw new CoreError("INVALID_ARGUMENT", "Choose a declared top-level query output field.");
  const settings = { interval_seconds: parameters.interval_seconds, timeout_seconds: parameters.timeout_seconds,
    max_iterations: parameters.max_iterations };
  const components = actionComponents();
  const poll = components["core.poll"]!;
  await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-action-template-check.py", import.meta.url)), [], {
    checks: [
      { schema: query.input_schema, value: parameters.query_inputs },
      { schema: poll.input_schema, value: { ...settings, body: [], condition: false, value: null } },
    ],
  });
  const monitorProperties = {
    schema: { const: "pkm.action.observation/v1" }, pkm_run_id: { type: "string" }, remote_id: { type: "string" },
    stop_reason: { enum: ["observing", "remote_completed", "observation_timed_out", "cancelled", "query_failed"] },
    remote_result: { type: ["string", "null"] }, attempts: { type: "integer" }, last_observation: { type: ["object", "null"] },
    last_observed_at: { type: ["number", "null"] }, next_check_at: { type: ["number", "null"] },
    observation_deadline: { type: "number" }, remote_may_still_be_active: { type: "boolean" },
    failure: { type: ["object", "null"] }, resume_run_id: { type: "string" },
  };
  const outputSchema = monitoring ? { type: "object", properties: monitorProperties, required: Object.keys(monitorProperties),
    additionalProperties: false } : poll.output_schema as { properties: Record<string, unknown> };
  const inputs: Record<string, unknown> = {
    ...settings, body: [{ id: "query", action_id: queryId, inputs: { $literal: parameters.query_inputs } }],
    condition: { $op: "eq", args: [{ $step: `query.${field}` }, { $literal: monitoring ? true : parameters.expected }] },
    value: { $step: monitoring ? "query" : `query.${field}` },
  };
  if (monitoring) {
    const queryInputs = parameters.query_inputs;
    if (!queryInputs || typeof queryInputs !== "object" || Array.isArray(queryInputs))
      throw new CoreError("INVALID_ARGUMENT", "Monitor query inputs must be an object.");
    const runId = (queryInputs as Record<string, unknown>).run_id;
    if (runId !== undefined && typeof runId !== "string")
      throw new CoreError("NOT_AVAILABLE", "Monitor templates currently require a string run_id.");
    inputs.remote_id = runId ?? "";
  }
  return {
    schema: "pkm.action.definition/v1", action_id: actionId, version: 1,
    description: monitoring ? "Durable read-only observation; failed/cancelled remote results and observation timeout never authorize continuation."
      : "Read-only polling template; timed_out is not a successful condition.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    output_schema: outputSchema, dependencies: { [queryId]: query.content_hash },
    effects: [...new Set([...query.effects, "pure"])].sort(),
    implementations: [{ id: "native", kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
      ...(monitoring ? { observation_monitor: true } : {}),
      steps: [{ id: "poll", component: monitoring ? "core.monitor" : "core.poll", inputs }],
      output: Object.fromEntries(Object.keys(outputSchema.properties).map(name => [name, { $step: `poll.${name}` }])) }],
    examples: [{ inputs: {} }],
  };
}

function rows(db: DatabaseSync, workspaceId: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    expected.exec(ddl);
    const schema = (database: DatabaseSync) => database.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'legacy_action_mcp_proposals%' ORDER BY name",
    ).all();
    if (JSON.stringify(schema(db)) !== JSON.stringify(schema(expected)))
      throw new CoreError("RECOVERY_CONFLICT", "Original Action proposal schema changed.");
  } finally { expected.close(); }
  return db.prepare(`SELECT proposal_id,payload,payload_sha256 FROM ${table} ORDER BY proposal_id`).all().map(row => {
    if (hash(String(row.payload)) !== row.payload_sha256)
      throw new CoreError("RECOVERY_CONFLICT", "Original Action proposal bytes changed.");
    const value = record.parse(JSON.parse(String(row.payload)));
    if (value.workspaceId !== workspaceId || value.proposal.proposal_id !== row.proposal_id
      || value.proposal.action_id !== value.proposal.definition.action_id
      || value.proposal.definition.knowledgeId !== `action_${originalDigest(value.proposal.action_id).slice(0, 24)}`
      || originalDefinitionValue(value.proposal.definition).content_hash !== value.proposal.content_hash)
      throw new CoreError("RECOVERY_CONFLICT", "Original Action proposal binding changed.");
    return value.proposal;
  });
}
export function verifyLegacyActionProposals(database: DatabaseSync, workspaceId: string) {
  return rows(database, workspaceId);
}

function assertActor(actor: Actor) {
  if (actor.id !== "mcp:external" || actor.boardWorker)
    throw new CoreError("ACCESS_DENIED", "Original Action compatibility requires its fixed external actor.");
}

function blockedActionGet(definition: Record<string, unknown>) {
  const effects = definition.effects as string[];
  const pythonOrder = (left: string, right: string) => {
    const a = Array.from(left, value => value.codePointAt(0)!), b = Array.from(right, value => value.codePointAt(0)!);
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  };
  const levels: Record<string, string> = { pure: "read", read: "read", "local-read": "read",
    "remote-read": "read", "human-input": "read", "local-write": "write", "remote-write": "write",
    send: "send", delete: "delete", spend: "spend" };
  const normalized = [...new Set(effects.map(effect => levels[effect] ?? "unknown"))].sort();
  return { ...definition, execution_contract: {
    schema: "pkm.action.execution-contract/v1", actionId: definition.action_id, revision: definition.content_hash,
    effects: normalized, inputSchema: definition.input_schema, outputSchema: definition.output_schema,
    requiredCapabilities: [...new Set(effects)].sort(pythonOrder),
    resourceClaims: [{ resource: "invocation-workspace", access: normalized.length === 1 && normalized[0] === "read" ? "read" : "write" }],
    timeoutPolicy: { kind: "deadline", onTimeout: "reconcile" },
    retryPolicy: { automatic: false, reason: "Reconcile the original Run before any new attempt." },
    idempotency: { kind: "launch-key", externalEffectGuaranteed: false },
    receiptContract: "pkm.action.execution/v1",
    reconciler: Object.hasOwn(definition, "reconciler") ? definition.reconciler : { kind: "manual" },
  }, availability: { state: "blocked", reason: LEGACY_ACTION_RUNTIME_UNAVAILABLE } };
}

export async function legacyActionRead(storage: Storage, actor: Actor,
  input: z.infer<typeof legacyActionReadRequest>, readActionRuntime?: LegacyActionRuntimeReader,
  readRegisteredAction?: (actor: Actor, actionId: string) => Promise<Record<string, unknown> | undefined>,
  readActionResult?: (actor: Actor, runId: string) => Promise<Record<string, unknown> | undefined>,
  additionalSources: ActionModuleSnapshot[] = []): Promise<unknown> {
  assertActor(actor);
  const request = legacyActionReadRequest.parse(input);
  if (request.tool === "action_run_get") {
    if (!readActionRuntime) throw new CoreError("NOT_AVAILABLE", "Native Action runtime reads are unavailable.");
    const parsed = actionRuntimeDefinitions[1].output.safeParse(
      await readActionRuntime("action.runtime.get", { runId: request.arguments.run_id }),
    );
    if (!parsed.success) throw new CoreError("INVALID_RESULT", "Native Action runtime returned an invalid run view.");
    const run = parsed.data;
    let output: Record<string, unknown> | undefined;
    let outputUnavailable = false;
    if (run.state === "succeeded" && readActionResult) {
      try { output = await readActionResult(actor, run.runId); }
      catch (error) {
        if (!(error instanceof CoreError) || error.code !== "ACCESS_DENIED") throw error;
        outputUnavailable = true;
      }
    }
    return {
      run_id: run.runId, state: run.state, action_id: run.actionId, action_version: run.actionVersion,
      version: run.version, definition_digest: run.definitionDigest, deadline: run.deadline,
      nodes: run.nodes.map(node => ({ node_id: node.nodeId, state: node.state, ...(node.reason ? { reason: node.reason } : {}) })),
      ...(output === undefined ? {} : { output }),
      ...(outputUnavailable ? { output_availability: { state: "blocked", reason: "ACCESS_DENIED" } } : {}),
    };
  }
  if (request.tool === "action_templates") return structuredClone(original.templates);
  if (request.tool === "action_retrieve") {
    const task = request.arguments.task;
    const limit = request.arguments.limit;
    // Python str.strip includes C0 separators/NEL, but not the JavaScript BOM.
    if (/^[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(task)
      || limit < 1 || limit > 10)
      throw new CoreError("INVALID_ARGUMENT", "A non-empty task and limit between 1 and 10 are required.");
    const sources = [...await legacyActionCatalogSources(storage), ...additionalSources];
    const definitions = [
      ...builtinActionDefinitions().values(),
      ...sources.flatMap(source => [...loadModuleSet(source).definitions.values()]),
    ];
    const words = task.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/gu) ?? [];
    const matches = definitions.flatMap(definition => {
      const text = `${definition.action_id} ${String(definition.description).toLowerCase()}`;
      const score = words.reduce((total, word) => total + Number(text.includes(word)), 0);
      return score ? [{ ...structuredClone(definition),
        availability: { state: "blocked", reason: LEGACY_ACTION_RUNTIME_UNAVAILABLE }, score }] : [];
    }) as Array<Record<string, unknown> & { score: number }>;
    matches.sort((left, right) => right.score - left.score
      || (String(left.action_id) < String(right.action_id) ? -1 : Number(left.action_id !== right.action_id)));
    const ambiguous = matches.length > 1 && matches[0]!.score === matches[1]!.score;
    const candidateLimit = Math.max(limit, ambiguous ? 2 : 1);
    return {
      schema: "pkm.action.retrieval/v1", ok: true, no_match: matches.length === 0,
      ambiguous, selected_action_id: null, candidates: matches.slice(0, candidateLimit),
      truncated: matches.length > candidateLimit,
    };
  }
  if (request.tool === "action_proposals") {
    const workspaceId = await storage.workspaceId();
    return storage.withWorkspaceExclusive(() => {
      storage.assertWorkspaceLease();
      const db = storage.connectNative();
      try { return { ok: true, proposals: rows(db, workspaceId) }; }
      finally { db.close(); }
    });
  }
  if (request.tool === "action_get") {
    const registered = await readRegisteredAction?.(actor, request.arguments.action_id);
    if (registered) return { ...blockedActionGet(registered), availability: { state: "ready" } };
    const workspaceId = await storage.workspaceId();
    return storage.withWorkspaceExclusive(() => {
      storage.assertWorkspaceLease();
      const db = storage.connectNative();
      try {
        const sources = readLegacyActionCatalogSources(db, workspaceId);
        const definitions = sources.flatMap(source => [...loadModuleSet(source).definitions.values()]);
        const definition = definitions.find(value => value.action_id === request.arguments.action_id);
        if (!definition)
          throw new CoreError("NOT_AVAILABLE", "Only selected native-admitted ModuleSet Actions without execution admission can be inspected.");
        if (!definition.dependencies || typeof definition.dependencies !== "object"
          || Object.keys(definition.dependencies).length !== 0)
          throw new CoreError("NOT_AVAILABLE", "Action dependency readiness requires its original admitted runtime.");
        const value = blockedActionGet(definition);
        storage.assertWorkspaceLease();
        return value;
      } finally { db.close(); }
    });
  }
  const sources = [...await legacyActionCatalogSources(storage), ...additionalSources];
  if (request.tool === "action_definition_check") {
    const checked = checkDefinition(request.arguments.definition, sources);
    const current = await readRegisteredAction?.(actor, String(request.arguments.definition.action_id));
    if (checked.ok && current && Number(request.arguments.definition.version) <= Number(current.version))
      return { ...checked, ok: false, diagnostics: [{ path: "/version", code: "revision",
        message: "Updating an Action requires a larger version." }], next_action: "fix_definition" };
    return checked;
  }
  return graphDefinition(request.arguments.graph, sources);
}

export async function legacyActionWrite(storage: Storage, actor: Actor,
  input: z.infer<typeof legacyActionWriteRequest>,
  admitProposal?: (actor: Actor, proposalId: string, contentHash: string) => boolean | Promise<boolean>,
  additionalSources: ActionModuleSnapshot[] = [], assertSources?: () => void): Promise<unknown> {
  assertActor(actor);
  if (!actor.canWrite) throw new CoreError("ACCESS_DENIED", "Original Action proposals require write permission.");
  const request = legacyActionWriteRequest.parse(input);
  const inventory = [...await legacyActionCatalogSources(storage), ...additionalSources];
  const sources = request.tool === "action_register" && exactRunnableArtifactBuiltin(request.arguments.definition)
    ? [] : inventory;
  const definition = request.tool === "action_register" ? request.arguments.definition
    : request.tool === "action_graph_save" ? graphDefinition(request.arguments.graph, sources)
      : await templateDefinition(request.arguments.action_id, request.arguments.parameters, sources);
  const checked = checkDefinition(definition, sources);
  if (!checked.ok) throw new CoreError("INVALID_ARGUMENT", checked.diagnostics[0]?.message ?? "Invalid Action definition.");
  if ("knowledgeId" in definition || "content_hash" in definition || "source_id" in definition || "implementation_hash" in definition)
    throw new CoreError("INVALID_ARGUMENT", "Caller-supplied Action runtime identity is not proposal authority.");
  const value = { dependencies: {}, casts: {}, examples: [], ...definition,
    knowledgeId: `action_${originalDigest(definition.action_id).slice(0, 24)}` };
  const contentHash = originalDefinitionValue(value).content_hash;
  const workspaceId = await storage.workspaceId();
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const db = storage.connectNative();
    try {
      let proposed!: z.infer<typeof proposal>;
      db.exec("BEGIN IMMEDIATE");
      try {
        assertSources?.();
        const currentSources = readLegacyActionCatalogSources(db, workspaceId);
        if (originalDigest([...currentSources, ...additionalSources]) !== originalDigest(inventory))
          throw new CoreError("CONFLICT", "Action catalog changed before proposal publication.");
        if (currentSources.some(source => (source.manifest as { actions: unknown[] }).actions.includes(definition.action_id)))
          throw new CoreError("INVALID_ARGUMENT", "Unload the packaged provider before proposing a local definition with this identity.");
        const previous = rows(db, workspaceId);
        const existing = previous.find(row => row.action_id === definition.action_id && row.content_hash === contentHash);
        if (previous.length >= 1000 && !existing)
          throw new CoreError("RESOURCE_LIMIT", "Original Action pending proposal budget exceeded.");
        proposed = existing ?? proposal.parse({
          schema: "pkm.action.proposal/v1", proposal_id: `proposal_${randomUUID().replaceAll("-", "")}`,
          state: "pending", action_id: definition.action_id, content_hash: contentHash,
          base_content_hash: null, definition: value, submitted_at: new Date().toISOString(),
        });
        if (!existing) {
          if (!previous.length && !db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) db.exec(ddl);
          const payload = JSON.stringify({ actorId: actor.id, workspaceId, proposal: proposed });
          db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(proposed.proposal_id, payload, hash(payload));
        }
        storage.assertWorkspaceLease();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const result = { ...original.proposalResult, proposal_id: proposed.proposal_id,
        action_id: proposed.action_id, content_hash: proposed.content_hash,
        next_action: "The trusted VS Code Extension Host may automatically admit this exact revision. GPT review is optional; inputs, host authorization, and effect consent remain required. Without active workspace trust the proposal remains pending and is not callable." };
      let automaticallyAdmitted = false;
      try { automaticallyAdmitted = await admitProposal?.(actor, proposed.proposal_id, proposed.content_hash) === true; }
      catch (error) {
        if (!(error instanceof CoreError) || error.code !== "ACCESS_DENIED") throw error;
      }
      if (automaticallyAdmitted) return {
        ...result, state: "automatically_admitted", registered: true, callable: true,
        automatic_admission: "exact-revision/trusted-vscode-workspace",
        next_action: "Call action_call with this action_id and content_hash. GPT review is optional; Action input, host authorization, and effect-consent policies still apply.",
      };
      return result;
    } finally { db.close(); }
  });
}

export async function legacyActionCall(
  actor: Actor,
  input: z.infer<typeof legacyActionCallRequest>,
  createRun: (actor: Actor, request: z.infer<typeof legacyActionCallRequest>) => unknown,
): Promise<unknown> {
  assertActor(actor);
  if (!actor.canWrite) throw new CoreError("ACCESS_DENIED", "Action calls require write permission.");
  return createRun(actor, legacyActionCallRequest.parse(input));
}
