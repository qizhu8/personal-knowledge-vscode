import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { validateRecipeRecord } from "./domain/project-recipes-storage-rules.js";

type Json = Record<string, any>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(): never { throw new Error("LEGACY_UI_RECIPE_RECEIPTS_BLOCKED: Unsupported, inconsistent or damaged original Recipe history."); }
function exact(value: any, names: string) {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || Object.keys(value).sort().join(" ") !== names.split(" ").sort().join(" ")) fail();
}
function envelope(value: Json) {
  exact(value, "schema storeVersion digest payload"); exact(value.payload, "receipts state");
  if (value.schema !== 1 || !Number.isSafeInteger(value.storeVersion) || value.storeVersion < 1
    || !hex.test(value.digest) || value.digest !== sha(JSON.stringify(value.payload))
    || !Array.isArray(value.payload.receipts) || value.payload.receipts.length) fail();
}
const metadata = z.strictObject({
  applicableFunctions: z.array(z.string()), solution: z.string(),
  requiredInputs: z.array(z.strictObject({ name: z.string(), description: z.string(), required: z.boolean().optional() })),
  expectedOutputs: z.array(z.strictObject({ name: z.string(), description: z.string(), required: z.boolean().optional() })),
});
const recipe = z.strictObject({
  recipeId: z.string().regex(/^recipe_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  scope: z.literal("global"), name: z.string().min(1), category: z.string().optional(), description: z.string(),
  metadata: metadata.optional(), definition: z.json(), executableDigest: z.string().regex(hex),
  revision: z.number().int().safe().positive(), nodeBindings: z.array(z.strictObject({
    nodeId: z.string(), bindings: z.array(z.strictObject({
      bindingId: z.string(), kind: z.enum(["skill", "note"]), knowledgeId: z.string(),
      contentHash: z.string().regex(hex), usage: z.enum(["required", "recommended", "reference"]),
    })),
  })).optional(),
  methodology: z.json().optional(), methodologyDigest: z.string().regex(hex).optional(),
  editorLayout: z.strictObject({ nodePositions: z.record(z.string(),
    z.strictObject({ x: z.number().finite(), y: z.number().finite() })) }).optional(),
});

/** Source-only inventory: these old mutation receipts confer no native execution or writer authority. */
export function validateLegacyRecipeReceiptEvolution(current: Json, control: Json, baseline: Json) {
  envelope(current); envelope(baseline);
  if (baseline.storeVersion !== 1 || current.storeVersion <= 1) fail();
  exact(current.payload.state, "schema rootId audit collaborationTasks ganttTasks migrations projects recipeFolders recipeTrash recipes threads");
  exact(baseline.payload.state, "schema rootId audit collaborationTasks ganttTasks migrations projects recipeFolders recipeTrash recipes threads");
  const before = baseline.payload.state, after = current.payload.state;
  if (canonicalJson({ ...before, recipes: [] }) !== canonicalJson({ ...after, recipes: [] })
    || !Array.isArray(before.recipes) || !Array.isArray(after.recipes) || after.recipes.length > 64
    || new Set(before.recipes.map((item: Json) => item.recipeId)).size !== before.recipes.length) fail();
  exact(control, "schema rootId storeVersion canonicalDigest migration receipts");
  exact(control.migration, "phase sourceDigest canonicalDigest projects threads ganttTasks collaborationTasks");
  if (control.schema !== 1 || control.rootId !== before.rootId || control.storeVersion !== current.storeVersion
    || !hex.test(control.canonicalDigest) || control.migration.phase !== "cutover"
    || control.migration.sourceDigest !== baseline.digest || control.migration.canonicalDigest !== control.canonicalDigest
    || !Array.isArray(control.receipts) || !control.receipts.length || control.receipts.length > 256
    || current.storeVersion !== control.receipts.length + 1) fail();
  const originals = new Map<string, Json>(before.recipes.map((item: Json) => [item.recipeId, item]));
  const custom = new Map<string, Json>(), seen = new Set<string>();
  for (const item of after.recipes) {
    if (!item || seen.has(item.recipeId)) fail();
    seen.add(item.recipeId);
    if (originals.has(item.recipeId)) {
      if (canonicalJson(item) !== canonicalJson(originals.get(item.recipeId))) fail();
    } else {
      if (!recipe.safeParse(item).success) fail();
      try { validateRecipeRecord(item); } catch { fail(); }
      custom.set(item.recipeId, item);
    }
  }
  if ([...originals.keys()].some(id => !seen.has(id)) || !custom.size) fail();
  const counts = new Map<string, number>(), commands = new Set<string>();
  for (const [index, receipt] of control.receipts.entries()) {
    exact(receipt, "commandId fingerprint operation entityId storeVersion");
    if (!uuid.test(receipt.commandId) || commands.has(receipt.commandId)
      || !(hex.test(receipt.fingerprint) || uuid.test(receipt.fingerprint))
      || receipt.storeVersion !== index + 2 || !custom.has(receipt.entityId)
      || receipt.operation !== (counts.has(receipt.entityId) ? "recipe-update" : "recipe-create")) fail();
    commands.add(receipt.commandId); counts.set(receipt.entityId, (counts.get(receipt.entityId) ?? 0) + 1);
  }
  if ([...custom].some(([id, value]) => counts.get(id) !== value.revision)) fail();
  return { baselineDigest: baseline.digest as string, storeVersion: current.storeVersion as number,
    receipts: structuredClone(control.receipts) as Json[] };
}

/** Narrow inert archive of observed Agent adhoc runs; never invokes the old materializing getter. */
export function validateLegacyRecipeRunArchive(value: Json, name: string) {
  const optional = ["usage", "healthReceipt", "terminalAt"].filter(key => key in value);
  exact(value, `schema runId recipeId recipeName recipeRevision executableDigest definition nodeBindings inputs nodes loops nodeAttemptCounts ancestry createdAt updatedAt status version projectId origin receipts ${optional.join(" ")}`.trim());
  if (value.schema !== "pkm.recipe.run/v1" || !/^recipe_run_[a-f0-9]{24}$/.test(value.runId)
    || name !== `${value.runId}.json` || typeof value.recipeName !== "string"
    || value.recipeRevision !== 1 || !hex.test(value.executableDigest)
    || value.recipeId !== `adhoc_recipe_${value.executableDigest.slice(0, 24)}`
    || value.executableDigest !== sha(canonicalJson({ definition: value.definition, nodeBindings: [] }))
    || !["running", "completed"].includes(value.status) || !Number.isSafeInteger(value.version) || value.version < 1
    || value.projectId !== "" || canonicalJson(value.ancestry) !== canonicalJson([value.recipeId])
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) fail();
  exact(value.origin, "kind"); exact(value.nodeBindings, ""); exact(value.loops, "");
  if (value.origin.kind !== "agent-session-adhoc") fail();
  const compiled = compileWorkflowDefinitionV1(value.definition);
  if (!compiled.ok || compiled.model.spec.nodes.some(node => node.kind !== "pkm.step.noop/v1"
    || Object.keys(node.config).length || node.control && node.control.mode !== "single")) fail();
  const ids = compiled.model.spec.nodes.map(node => node.nodeId).sort();
  exact(value.nodes, ids.join(" "));
  for (const id of ids) {
    const node = value.nodes[id];
    if (node.state === "pending") { exact(node, "state"); continue; }
    if (!["running", "succeeded"].includes(node.state)) fail();
    const completed = node.state === "succeeded";
    exact(node, `state attempt startedAt lastHeartbeatAt lastProgressAt progress${completed ? " completedAt outcome result error" : ""}`);
    if (node.attempt !== 1 || value.nodeAttemptCounts[id] !== node.attempt
      || !["startedAt", "lastHeartbeatAt", "lastProgressAt", ...(completed ? ["completedAt"] : [])]
        .every(key => typeof node[key] === "string" && Number.isFinite(Date.parse(node[key])))
      || completed && (node.outcome !== "succeeded" || typeof node.error !== "string")) fail();
    exact(node.progress, "events message phase safeToInterrupt staleAfterSeconds");
    if (!Array.isArray(node.progress.events) || node.progress.events.length || node.progress.phase !== "claimed"
      || node.progress.safeToInterrupt !== false || typeof node.progress.message !== "string"
      || node.progress.staleAfterSeconds !== 300) fail();
  }
  if (Object.keys(value.nodeAttemptCounts).some(id => !ids.includes(id) || value.nodes[id].state === "pending")
    || value.status === "completed" && (ids.some(id => value.nodes[id].state !== "succeeded")
      || value.terminalAt !== value.updatedAt)) fail();
  if ("healthReceipt" in value) {
    exact(value.healthReceipt, "schema candidateRequestId classification evidenceRef receiptDigest");
    if (value.status !== "completed" || value.healthReceipt.schema !== "pkm.recipe.run-health/v1"
      || value.healthReceipt.classification !== "healthy" || value.healthReceipt.candidateRequestId !== null
      || !hex.test(value.healthReceipt.receiptDigest)
      || value.healthReceipt.evidenceRef !== `pkm://recipe-health/${value.healthReceipt.receiptDigest}`) fail();
  }
  if ("usage" in value) {
    const usage = value.usage;
    exact(usage, "derivedCosts estimatedReports estimatedTokens measuredReports measuredTokens models protocolPayloadEstimate providers records recordsTruncated reportedAttempts unknownModelCalls");
    exact(usage.derivedCosts, ""); exact(usage.measuredTokens, ""); exact(usage.protocolPayloadEstimate, "estimatedTokens");
    if (usage.estimatedReports !== 0 || usage.estimatedTokens !== 0 || usage.measuredReports !== 0
      || usage.recordsTruncated !== 0 || usage.unknownModelCalls !== 0 || canonicalJson(usage.models) !== "[]"
      || canonicalJson(usage.providers) !== "[]" || !Array.isArray(usage.records)
      || usage.reportedAttempts !== usage.records.length || usage.records.length !== ids.filter(id => value.nodes[id].state === "succeeded").length) fail();
    const seen = new Set<string>(); let protocolTokens = 0;
    for (const row of usage.records) {
      exact(row, "attempt estimatedTokens measuredTokens nodeId protocolPayloadEstimate recipeRunId unknownModelCalls");
      exact(row.measuredTokens, ""); exact(row.protocolPayloadEstimate, "estimated_tokens method");
      if (!ids.includes(row.nodeId) || seen.has(row.nodeId) || value.nodes[row.nodeId].state !== "succeeded"
        || row.attempt !== 1 || row.recipeRunId !== value.runId || row.estimatedTokens !== 0
        || row.unknownModelCalls !== 0 || row.protocolPayloadEstimate.method !== "utf8-bytes-divided-by-4"
        || !Number.isSafeInteger(row.protocolPayloadEstimate.estimated_tokens) || row.protocolPayloadEstimate.estimated_tokens < 0) fail();
      seen.add(row.nodeId); protocolTokens += row.protocolPayloadEstimate.estimated_tokens;
    }
    if (usage.protocolPayloadEstimate.estimatedTokens !== protocolTokens) fail();
  }
  for (const receipt of Object.values(value.receipts) as Json[]) {
    exact(receipt, "fingerprint response");
    if (!hex.test(receipt.fingerprint) || typeof receipt.response !== "string") fail();
    let response: Json; try { response = JSON.parse(receipt.response); } catch { fail(); }
    if (response.schema !== "pkm.recipe.api/v1" || response.run_id !== value.runId
      || !Number.isSafeInteger(response.version) || response.version < 1 || response.version > value.version) fail();
  }
}

export function validateLegacyRecipeHealthArchive(value: Json, runs: Map<string, Json>) {
  exact(value, "schema aggregates candidateRequests receipts");
  if (value.schema !== "pkm.recipe.run-health-store/v1" || !Array.isArray(value.candidateRequests)
    || value.candidateRequests.length || !Array.isArray(value.receipts) || value.receipts.length > 200
    || !Array.isArray(value.aggregates) || value.aggregates.length > 200) fail();
  const receipts = new Map<string, Json>();
  for (const row of value.receipts) {
    exact(row, "schema receiptDigest evidenceRef recipe runId startedAt terminalAt terminalOutcome classification codes counts durationMs complete ambiguous truncated evolution inputRevisionFacts nodeFacts cost validation");
    const run = runs.get(row.runId), { receiptDigest, evidenceRef, ...payload } = row;
    if (!run || run.status !== "completed" || receipts.has(row.runId) || row.schema !== "pkm.recipe.run-health/v1"
      || row.classification !== "healthy" || row.terminalOutcome !== "succeeded" || row.complete !== true
      || row.ambiguous !== false || row.truncated !== false || row.startedAt !== run.createdAt
      || row.terminalAt !== run.terminalAt || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0
      || receiptDigest !== sha(canonicalJson(payload)) || evidenceRef !== `pkm://recipe-health/${receiptDigest}`
      || run.healthReceipt?.receiptDigest !== receiptDigest || run.healthReceipt?.evidenceRef !== evidenceRef
      || canonicalJson(row.recipe) !== canonicalJson({ recipeId: run.recipeId, revision: run.recipeRevision,
        executableDigest: run.executableDigest }) || !Array.isArray(row.codes) || row.codes.length
      || !Array.isArray(row.inputRevisionFacts) || row.inputRevisionFacts.length) fail();
    exact(row.counts, "cancelled humanInterventions nodes nodesRetained retries skipped timedOut");
    if (row.counts.nodes !== Object.keys(run.nodes).length || row.counts.nodesRetained !== row.counts.nodes
      || Object.entries(row.counts).some(([key, count]) => !["nodes", "nodesRetained"].includes(key) && count !== 0)) fail();
    exact(row.evolution, "context excluded"); exact(row.validation, "allPassed anyFailed observed");
    if (row.evolution.context !== "normal" || row.evolution.excluded !== false
      || row.validation.allPassed !== true || row.validation.anyFailed !== false || row.validation.observed !== false
      || !Array.isArray(row.nodeFacts) || row.nodeFacts.length !== row.counts.nodes
      || new Set(row.nodeFacts.map((node: Json) => node.nodeId)).size !== row.counts.nodes) fail();
    exact(row.cost, "attribution derived estimated measured unknown");
    exact(row.cost.derived, ""); exact(row.cost.measured, ""); exact(row.cost.estimated, "protocolTokens tokens");
    exact(row.cost.unknown, "modelCalls"); exact(row.cost.attribution, "attempts recordsRetained recordsTruncated runId");
    if (!run.usage || row.cost.estimated.tokens !== 0 || row.cost.unknown.modelCalls !== 0
      || row.cost.estimated.protocolTokens !== run.usage.protocolPayloadEstimate.estimatedTokens
      || row.cost.attribution.runId !== run.runId || row.cost.attribution.recordsTruncated !== 0
      || row.cost.attribution.recordsRetained !== run.usage.records.length
      || canonicalJson(row.cost.attribution.attempts) !== canonicalJson(run.usage.records.map((record: Json) => ({
        attempt: record.attempt, derived: {}, estimated: 0, measured: {}, nodeId: record.nodeId,
        runId: run.runId, unknownModelCalls: 0,
      })))) fail();
    for (const node of row.nodeFacts) {
      exact(node, "attemptCount cancelled durationMs errorCode humanIntervention io nodeId outcome retryCount skipped timedOut validation");
      if (!run.nodes[node.nodeId] || node.outcome !== "succeeded" || node.attemptCount !== run.nodes[node.nodeId].attempt
        || node.cancelled !== false || node.humanIntervention !== false || node.skipped !== false || node.timedOut !== false
        || node.retryCount !== 0 || node.errorCode !== "none" || !Number.isSafeInteger(node.durationMs) || node.durationMs < 0) fail();
      exact(node.io, "artifactDigests declaredReadCount declaredWriteCount observedReadCount observedWriteCount");
      exact(node.validation, "failed observed passed");
      if (canonicalJson(node.io) !== canonicalJson({ artifactDigests: [], declaredReadCount: 0, declaredWriteCount: 0,
        observedReadCount: 0, observedWriteCount: 0 })
        || canonicalJson(node.validation) !== canonicalJson({ failed: false, observed: false, passed: false })) fail();
    }
    receipts.set(row.runId, row);
  }
  const grouped = new Map<string, Json[]>();
  for (const receipt of receipts.values()) {
    const key = `${receipt.recipe.recipeId}:${receipt.recipe.revision}:${receipt.recipe.executableDigest}`;
    grouped.set(key, [...(grouped.get(key) ?? []), receipt]);
  }
  if (value.aggregates.length !== grouped.size) fail();
  const seen = new Set<string>();
  for (const aggregate of value.aggregates) {
    exact(aggregate, "counts durationDistribution key lastTerminalAt recentEvidence recipe");
    const group = grouped.get(aggregate.key);
    if (!group || seen.has(aggregate.key)) fail();
    seen.add(aggregate.key);
    exact(aggregate.counts, "environment-failure healthy implementation-failure input-failure recipe-failure recipe-friction");
    if (aggregate.counts.healthy !== group.length
      || Object.entries(aggregate.counts).some(([key, count]) => key !== "healthy" && count !== 0)
      || canonicalJson(aggregate.recipe) !== canonicalJson(group[0]!.recipe)
      || aggregate.lastTerminalAt !== group.at(-1)!.terminalAt
      || canonicalJson(aggregate.recentEvidence) !== canonicalJson(group.slice(-20).map(row => ({
        classification: row.classification, codes: row.codes, evidenceRef: row.evidenceRef,
        runId: row.runId, terminalAt: row.terminalAt,
      })))) fail();
    const distribution: Json = {};
    for (const row of group) {
      const key = row.durationMs < 1000 ? "lt-1s" : row.durationMs < 10000 ? "1s-10s"
        : row.durationMs < 60000 ? "10s-1m" : row.durationMs < 600000 ? "1m-10m" : "gte-10m";
      distribution[key] = (distribution[key] ?? 0) + 1;
    }
    if (canonicalJson(distribution) !== canonicalJson(aggregate.durationDistribution)) fail();
  }
  if ([...runs.values()].some(run => run.status === "completed" && !receipts.has(run.runId))) fail();
}
