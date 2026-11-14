import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";

type Json = Record<string, unknown>;
const fields = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "total_tokens"] as const;
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
type Usage = {
  measured_tokens?: Record<string, number>; estimated_tokens?: number; unknown_model_calls?: number;
  provider?: string; model?: string; derived_cost?: { amount_micros: number; currency: string; price_version: string };
};
export type ReportedRecipeUsage = {
  measured_tokens: Record<string, number>; estimated_tokens: number; unknown_model_calls: number;
  derived_cost_micros_by_currency: Record<string, number>; providers: string[]; models: string[];
  protocol_payload_estimate: { estimated_tokens: number; method: string };
  reported_attempts: number; records: Json[]; records_truncated: number;
};
export function assertReportedRecipeNumbers(value: unknown, field: string) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "number" && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item)))
      throw new Error(`${field} exceeds native finite/safe-integer number capacity.`);
    if (item && typeof item === "object") pending.push(...Object.values(item));
  }
}
export function parseReportedRecipeUsage(text: string) {
  const value: unknown = JSON.parse(text || "null", (_key, item: unknown, context?: { source?: string }) => {
    if (typeof item !== "number") return item;
    if (!context?.source) throw new Error("Lossless usage parsing requires the supported Node host runtime.");
    return /^-?\d+$/.test(context.source) ? item : NaN;
  });
  return normalizeReportedRecipeUsage(value);
}
export function normalizeReportedRecipeUsage(value: unknown): Usage | null {
  if (value === null) return null;
  if (!object(value)) throw new Error("usage_json must be an object or null.");
  const allowed = ["measured_tokens", "estimated_tokens", "unknown_model_calls", "provider", "model", "derived_cost"];
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unknown.length) throw new Error(`usage_json contains unknown fields: ${unknown.join(", ")}.`);
  if (!Object.keys(value).length) throw new Error("usage_json must not be empty.");
  const result: Usage = {};
  const integer = (item: unknown, maximum: number) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= maximum;
  if (Object.hasOwn(value, "measured_tokens")) {
    const bucket = value.measured_tokens, pointer = "usage_json.measured_tokens";
    if (!object(bucket) || !Object.keys(bucket).length) throw new Error(`${pointer} must be a non-empty object.`);
    const extra = Object.keys(bucket).filter(key => !(fields as readonly string[]).includes(key)).sort();
    if (extra.length) throw new Error(`${pointer} contains unknown fields: ${extra.join(", ")}.`);
    for (const [key, count] of Object.entries(bucket))
      if (!integer(count, 1e12)) throw new Error(`${pointer}.${key} must be a non-negative integer no greater than 1000000000000.`);
    const missing = fields.filter(key => !Object.hasOwn(bucket, key));
    if (missing.length) throw new Error(`${pointer} is missing required fields: ${missing.join(", ")}.`);
    if (Number(bucket.cached_input_tokens) > Number(bucket.input_tokens)) throw new Error(`${pointer}.cached_input_tokens cannot exceed input_tokens.`);
    if (Number(bucket.total_tokens) < Number(bucket.input_tokens) + Number(bucket.output_tokens))
      throw new Error(`${pointer}.total_tokens cannot be less than input_tokens plus output_tokens.`);
    result.measured_tokens = { ...bucket } as Record<string, number>;
    if (!Object.hasOwn(value, "provider") || !Object.hasOwn(value, "model"))
      throw new Error("usage_json.provider and usage_json.model are required with measured_tokens.");
  }
  for (const key of ["estimated_tokens", "unknown_model_calls"] as const) if (Object.hasOwn(value, key)) {
    const maximum = key === "estimated_tokens" ? 1e12 : 1e6;
    if (!integer(value[key], maximum)) throw new Error(`usage_json.${key} must be a non-negative integer no greater than ${maximum}.`);
    result[key] = value[key] as number;
  }
  for (const key of ["provider", "model"] as const) if (Object.hasOwn(value, key)) {
    const text = value[key];
    if (typeof text !== "string" || !text.trim() || [...text].length > 128)
      throw new Error(`usage_json.${key} must be a non-empty string no longer than 128 characters.`);
    result[key] = text.trim();
  }
  if (Object.hasOwn(value, "derived_cost")) {
    const cost = value.derived_cost;
    if (!object(cost) || Object.keys(cost).sort().join(",") !== "amount_micros,currency,price_version")
      throw new Error("usage_json.derived_cost must contain exactly amount_micros, currency, and price_version.");
    if (!integer(cost.amount_micros, 1e15)) throw new Error("usage_json.derived_cost.amount_micros must be a bounded non-negative integer.");
    if (typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) throw new Error("usage_json.derived_cost.currency must be a three-letter uppercase code.");
    if (typeof cost.price_version !== "string" || !cost.price_version.trim() || [...cost.price_version].length > 128)
      throw new Error("usage_json.derived_cost.price_version must be a non-empty bounded string.");
    result.derived_cost = { amount_micros: cost.amount_micros as number, currency: cost.currency, price_version: cost.price_version.trim() };
  }
  if (!["measured_tokens", "estimated_tokens", "unknown_model_calls"].some(key => Object.hasOwn(result, key)))
    throw new Error("usage_json must include measured_tokens, estimated_tokens, or unknown_model_calls.");
  return result;
}
export function addReportedRecipeUsage(previous: ReportedRecipeUsage | undefined, runId: string, nodeId: string,
  outcome: string, result: unknown, error: string, usage: Usage | null): ReportedRecipeUsage {
  const next: ReportedRecipeUsage = previous ? structuredClone(previous) : {
    measured_tokens: Object.fromEntries(fields.map(key => [key, 0])), estimated_tokens: 0, unknown_model_calls: 0,
    derived_cost_micros_by_currency: {}, providers: [], models: [],
    protocol_payload_estimate: { estimated_tokens: 0, method: "utf8-bytes-divided-by-4" },
    reported_attempts: 0, records: [], records_truncated: 0,
  };
  const add = (a: number, b: number) => {
    const sum = a + b;
    if (!Number.isSafeInteger(sum)) throw new Error("Reported usage exceeds native exact-integer capacity.");
    return sum;
  };
  for (const field of fields) next.measured_tokens[field] = add(next.measured_tokens[field]!, usage?.measured_tokens?.[field] ?? 0);
  next.estimated_tokens = add(next.estimated_tokens, usage?.estimated_tokens ?? 0);
  next.unknown_model_calls = add(next.unknown_model_calls, usage?.unknown_model_calls ?? 0);
  if (usage?.derived_cost) {
    const cost = usage.derived_cost, key = cost.currency;
    const previousCost = Object.hasOwn(next.derived_cost_micros_by_currency, key) ? next.derived_cost_micros_by_currency[key]! : 0;
    next.derived_cost_micros_by_currency[key] = add(previousCost, cost.amount_micros);
  }
  for (const [field, values] of [["provider", next.providers], ["model", next.models]] as const) {
    const value = usage?.[field];
    if (value && !values.includes(value) && values.length < 32) values.push(value);
  }
  const protocol = { estimated_tokens: Math.ceil(Buffer.byteLength(canonicalJson([{
    run_id: runId, node_id: nodeId, attempt: 1, outcome, result, error, usage,
  }])) / 4), method: "utf8-bytes-divided-by-4" };
  next.protocol_payload_estimate.estimated_tokens = add(next.protocol_payload_estimate.estimated_tokens, protocol.estimated_tokens);
  next.reported_attempts++;
  next.records.push({ recipeRunId: runId, nodeId, attempt: 1, measuredTokens: usage?.measured_tokens ?? {},
    estimatedTokens: usage?.estimated_tokens ?? 0, unknownModelCalls: usage?.unknown_model_calls ?? 0,
    protocolPayloadEstimate: protocol, ...(usage?.provider ? { provider: usage.provider } : {}),
    ...(usage?.model ? { model: usage.model } : {}), ...(usage?.derived_cost ? { derivedCost: usage.derived_cost } : {}) });
  if (next.records.length > 200) { next.records.splice(0, next.records.length - 200); next.records_truncated++; }
  return next;
}
export function reportedRecipeUsageSummary(value: ReportedRecipeUsage) {
  const { records, ...summary } = value;
  return { ...summary, derived_cost_micros_by_currency: Object.fromEntries(
    Object.entries(value.derived_cost_micros_by_currency).sort(([a], [b]) => a.localeCompare(b)).slice(0, 32)),
    measured_total_tokens: value.measured_tokens.total_tokens, records_retained: records.length };
}
