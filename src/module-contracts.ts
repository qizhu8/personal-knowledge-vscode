import { createHash } from "crypto";
import { canonicalJson } from "./workflow-contracts";

export const MODULE_USAGE_SCHEMA = "pkm.module.usage/v1" as const;

export type UsageMeasurement =
  | {
      kind: "measured";
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    }
  | {
      kind: "estimated";
      estimator: string;
      estimatorVersion: string;
      confidence: "low" | "medium" | "high";
      estimatedTokens: number;
    }
  | {
      kind: "unknown";
      reason: "host-not-reported" | "provider-not-reported" | "unsupported-runtime";
      modelCalls: number;
    };

export interface ModuleUsageEventV1 {
  schema: typeof MODULE_USAGE_SCHEMA;
  eventId: string;
  sourceModule: string;
  occurredAt: string;
  attribution: {
    recipeRunId: string;
    nodeId: string;
    attemptId: string;
  };
  measurement: UsageMeasurement;
  derivedCost?: {
    currency: string;
    amountMicros: number;
    priceVersion: string;
  };
}

export interface ModuleContractDiagnostic {
  code: string;
  pointer: string;
  message: string;
}

export type ModuleUsageCompileResult =
  | {
      ok: true;
      model: ModuleUsageEventV1;
      canonicalBytes: Buffer;
      digest: string;
      diagnostics: [];
    }
  | { ok: false; diagnostics: ModuleContractDiagnostic[] };

export interface ModuleUsageSummary {
  events: number;
  measuredEvents: number;
  estimatedEvents: number;
  unknownEvents: number;
  measuredInputTokens: number;
  measuredOutputTokens: number;
  measuredTotalTokens: number;
  estimatedTokens: number;
  unknownModelCalls: number;
  derivedCostMicros: Record<string, number>;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const UNKNOWN_REASONS = ["host-not-reported", "provider-not-reported", "unsupported-runtime"] as const;
const CONFIDENCE = ["low", "medium", "high"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(diagnostics: ModuleContractDiagnostic[], code: string, pointer: string, message: string): void {
  diagnostics.push({ code, pointer, message });
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  pointer: string,
  diagnostics: ModuleContractDiagnostic[]
): void {
  for (const key of Object.keys(value).filter(key => !allowed.includes(key)).sort()) {
    diagnostic(diagnostics, "unknown-field", `${pointer}/${key}`, `Unknown field ${key}.`);
  }
}

function text(
  value: unknown,
  pointer: string,
  diagnostics: ModuleContractDiagnostic[],
  identifier = false
): string | undefined {
  const normalized = typeof value === "string" ? value.trim().normalize("NFC") : "";
  if (!normalized || (identifier && !IDENTIFIER.test(normalized))) {
    diagnostic(diagnostics, identifier ? "identifier" : "text", pointer, identifier ? "Expected a portable identifier." : "Expected non-empty text.");
    return undefined;
  }
  return normalized;
}

function count(value: unknown, pointer: string, diagnostics: ModuleContractDiagnostic[]): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    diagnostic(diagnostics, "non-negative-integer", pointer, "Expected a non-negative safe integer.");
    return undefined;
  }
  return value as number;
}

function normalizeMeasurement(value: unknown, diagnostics: ModuleContractDiagnostic[]): UsageMeasurement | undefined {
  const pointer = "/measurement";
  if (!isRecord(value)) {
    diagnostic(diagnostics, "object", pointer, "Expected a measurement object.");
    return undefined;
  }
  if (value.kind === "measured") {
    rejectUnknown(value, ["kind", "provider", "model", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "totalTokens"], pointer, diagnostics);
    const provider = text(value.provider, `${pointer}/provider`, diagnostics);
    const model = text(value.model, `${pointer}/model`, diagnostics);
    const inputTokens = count(value.inputTokens, `${pointer}/inputTokens`, diagnostics);
    const outputTokens = count(value.outputTokens, `${pointer}/outputTokens`, diagnostics);
    const cachedInputTokens = count(value.cachedInputTokens, `${pointer}/cachedInputTokens`, diagnostics);
    const reasoningTokens = count(value.reasoningTokens, `${pointer}/reasoningTokens`, diagnostics);
    const totalTokens = count(value.totalTokens, `${pointer}/totalTokens`, diagnostics);
    if (inputTokens !== undefined && cachedInputTokens !== undefined && cachedInputTokens > inputTokens) {
      diagnostic(diagnostics, "cached-input-range", `${pointer}/cachedInputTokens`, "Cached input tokens cannot exceed input tokens.");
    }
    if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined && totalTokens < inputTokens + outputTokens) {
      diagnostic(diagnostics, "total-token-range", `${pointer}/totalTokens`, "Total tokens cannot be lower than input plus output tokens.");
    }
    return provider && model && inputTokens !== undefined && outputTokens !== undefined && cachedInputTokens !== undefined
      && reasoningTokens !== undefined && totalTokens !== undefined
      ? { kind: "measured", provider, model, inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens }
      : undefined;
  }
  if (value.kind === "estimated") {
    rejectUnknown(value, ["kind", "estimator", "estimatorVersion", "confidence", "estimatedTokens"], pointer, diagnostics);
    const estimator = text(value.estimator, `${pointer}/estimator`, diagnostics);
    const estimatorVersion = text(value.estimatorVersion, `${pointer}/estimatorVersion`, diagnostics);
    const confidence = CONFIDENCE.includes(value.confidence as typeof CONFIDENCE[number])
      ? value.confidence as typeof CONFIDENCE[number]
      : undefined;
    if (!confidence) diagnostic(diagnostics, "confidence", `${pointer}/confidence`, "Expected low, medium, or high.");
    const estimatedTokens = count(value.estimatedTokens, `${pointer}/estimatedTokens`, diagnostics);
    return estimator && estimatorVersion && confidence && estimatedTokens !== undefined
      ? { kind: "estimated", estimator, estimatorVersion, confidence, estimatedTokens }
      : undefined;
  }
  if (value.kind === "unknown") {
    rejectUnknown(value, ["kind", "reason", "modelCalls"], pointer, diagnostics);
    const reason = UNKNOWN_REASONS.includes(value.reason as typeof UNKNOWN_REASONS[number])
      ? value.reason as typeof UNKNOWN_REASONS[number]
      : undefined;
    if (!reason) diagnostic(diagnostics, "unknown-reason", `${pointer}/reason`, "Unknown usage requires a supported reason.");
    const modelCalls = count(value.modelCalls, `${pointer}/modelCalls`, diagnostics);
    return reason && modelCalls !== undefined ? { kind: "unknown", reason, modelCalls } : undefined;
  }
  diagnostic(diagnostics, "measurement-kind", `${pointer}/kind`, "Expected measured, estimated, or unknown.");
  return undefined;
}

export function compileModuleUsageEventV1(value: unknown): ModuleUsageCompileResult {
  const diagnostics: ModuleContractDiagnostic[] = [];
  if (!isRecord(value)) return { ok: false, diagnostics: [{ code: "object", pointer: "", message: "Expected a usage event object." }] };
  rejectUnknown(value, ["schema", "eventId", "sourceModule", "occurredAt", "attribution", "measurement", "derivedCost"], "", diagnostics);
  if (value.schema !== MODULE_USAGE_SCHEMA) diagnostic(diagnostics, "schema", "/schema", `Expected ${MODULE_USAGE_SCHEMA}.`);
  const eventId = text(value.eventId, "/eventId", diagnostics);
  const sourceModule = text(value.sourceModule, "/sourceModule", diagnostics, true);
  const occurredAt = text(value.occurredAt, "/occurredAt", diagnostics);
  if (occurredAt && Number.isNaN(Date.parse(occurredAt))) diagnostic(diagnostics, "timestamp", "/occurredAt", "Expected an ISO 8601 timestamp.");

  let attribution: ModuleUsageEventV1["attribution"] | undefined;
  if (!isRecord(value.attribution)) {
    diagnostic(diagnostics, "object", "/attribution", "Expected an attribution object.");
  } else {
    rejectUnknown(value.attribution, ["recipeRunId", "nodeId", "attemptId"], "/attribution", diagnostics);
    const recipeRunId = text(value.attribution.recipeRunId, "/attribution/recipeRunId", diagnostics, true);
    const nodeId = text(value.attribution.nodeId, "/attribution/nodeId", diagnostics, true);
    const attemptId = text(value.attribution.attemptId, "/attribution/attemptId", diagnostics, true);
    if (recipeRunId && nodeId && attemptId) attribution = { recipeRunId, nodeId, attemptId };
  }
  const measurement = normalizeMeasurement(value.measurement, diagnostics);

  let derivedCost: ModuleUsageEventV1["derivedCost"] | undefined;
  if (value.derivedCost !== undefined) {
    if (!isRecord(value.derivedCost)) {
      diagnostic(diagnostics, "object", "/derivedCost", "Expected a derived cost object.");
    } else {
      rejectUnknown(value.derivedCost, ["currency", "amountMicros", "priceVersion"], "/derivedCost", diagnostics);
      const currency = text(value.derivedCost.currency, "/derivedCost/currency", diagnostics);
      const amountMicros = count(value.derivedCost.amountMicros, "/derivedCost/amountMicros", diagnostics);
      const priceVersion = text(value.derivedCost.priceVersion, "/derivedCost/priceVersion", diagnostics);
      if (currency && amountMicros !== undefined && priceVersion) derivedCost = { currency, amountMicros, priceVersion };
    }
  }
  if (diagnostics.length || !eventId || !sourceModule || !occurredAt || !attribution || !measurement) {
    return { ok: false, diagnostics: diagnostics.sort((left, right) => left.pointer.localeCompare(right.pointer) || left.code.localeCompare(right.code)) };
  }
  const model: ModuleUsageEventV1 = {
    schema: MODULE_USAGE_SCHEMA,
    eventId,
    sourceModule,
    occurredAt,
    attribution,
    measurement,
    ...(derivedCost ? { derivedCost } : {}),
  };
  const canonicalBytes = Buffer.from(canonicalJson(model), "utf8");
  return {
    ok: true,
    model,
    canonicalBytes,
    digest: createHash("sha256").update(canonicalBytes).digest("hex"),
    diagnostics: [],
  };
}

export function summarizeModuleUsage(events: readonly ModuleUsageEventV1[]): ModuleUsageSummary {
  const summary: ModuleUsageSummary = {
    events: 0,
    measuredEvents: 0,
    estimatedEvents: 0,
    unknownEvents: 0,
    measuredInputTokens: 0,
    measuredOutputTokens: 0,
    measuredTotalTokens: 0,
    estimatedTokens: 0,
    unknownModelCalls: 0,
    derivedCostMicros: {},
  };
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    summary.events += 1;
    if (event.measurement.kind === "measured") {
      summary.measuredEvents += 1;
      summary.measuredInputTokens += event.measurement.inputTokens;
      summary.measuredOutputTokens += event.measurement.outputTokens;
      summary.measuredTotalTokens += event.measurement.totalTokens;
    } else if (event.measurement.kind === "estimated") {
      summary.estimatedEvents += 1;
      summary.estimatedTokens += event.measurement.estimatedTokens;
    } else {
      summary.unknownEvents += 1;
      summary.unknownModelCalls += event.measurement.modelCalls;
    }
    if (event.derivedCost) {
      summary.derivedCostMicros[event.derivedCost.currency] =
        (summary.derivedCostMicros[event.derivedCost.currency] || 0) + event.derivedCost.amountMicros;
    }
  }
  return summary;
}
