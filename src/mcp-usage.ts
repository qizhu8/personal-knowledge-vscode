import * as fs from "fs";
import * as path from "path";

export interface McpUsageDomainSummary {
  calls: number;
  successes: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
  resultCount: number;
  estimatedTokenEquivalent: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
}

export interface McpUsageSessionSummary extends McpUsageDomainSummary {
  sessionId: string;
  lastUsedAt: string;
  domains: Record<string, McpUsageDomainSummary>;
}

export type TodoUsageQuality = "measured" | "estimated" | "partial" | "unknown";

export interface TodoUsageSummary {
  schema: "pkm.agent.todo-usage/v1";
  protocol: {
    observed: boolean;
    quality: "estimated" | "unknown";
    calls: number;
    successes: number;
    failures: number;
    inputBytes: number;
    outputBytes: number;
    durationMs: number;
    estimatedTokens: number;
    firstUsedAt: string;
    lastUsedAt: string;
    domains: Record<string, number>;
    tools: Record<string, number>;
  };
  model: {
    quality: TodoUsageQuality;
    measuredTokens: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    };
    estimatedTokens: number;
    unknownModelCalls: number;
    providers: string[];
    models: string[];
  };
  credit: {
    quality: "unknown";
    premiumRequests: null;
  };
}

interface RecipeUsageSource {
  usage?: any;
}

function emptySummary(): McpUsageDomainSummary {
  return {
    calls: 0, successes: 0, inputBytes: 0, outputBytes: 0, durationMs: 0,
    resultCount: 0, estimatedTokenEquivalent: 0, reportedInputTokens: 0, reportedOutputTokens: 0,
  };
}

function addEvent(summary: McpUsageDomainSummary, event: any): void {
  summary.calls += 1;
  summary.successes += event.success ? 1 : 0;
  summary.inputBytes += Number(event.inputBytes) || 0;
  summary.outputBytes += Number(event.outputBytes) || 0;
  summary.durationMs += Number(event.durationMs) || 0;
  summary.resultCount += Number(event.resultCount) || 0;
  summary.estimatedTokenEquivalent += Number(event.estimatedTokenEquivalent) || 0;
  summary.reportedInputTokens += Number(event.reportedTokens?.input) || 0;
  summary.reportedOutputTokens += Number(event.reportedTokens?.output) || 0;
}

export function mcpUsageSummary(storeRoot: string, maximumEvents = 1000): {
  sessions: McpUsageSessionSummary[];
  measurementNote: string;
} {
  const eventDirectory = path.join(storeRoot, ".pkm", "state", "mcp-usage", "events");
  if (!fs.existsSync(eventDirectory)) {
    return { sessions: [], measurementNote: "Tool calls, payload bytes, elapsed time, success, and result counts are observed. Token equivalents are estimates unless the runtime reports token usage." };
  }
  const files = fs.readdirSync(eventDirectory)
    .filter(name => name.endsWith(".json"))
    .map(name => ({ name, mtime: fs.statSync(path.join(eventDirectory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, Math.max(1, maximumEvents));
  const sessions = new Map<string, McpUsageSessionSummary>();
  for (const file of files) {
    try {
      const event = JSON.parse(fs.readFileSync(path.join(eventDirectory, file.name), "utf8"));
      const sessionId = String(event.sessionId || "unknown");
      let session = sessions.get(sessionId);
      if (!session) {
        session = { ...emptySummary(), sessionId, lastUsedAt: String(event.occurredAt || ""), domains: {} };
        sessions.set(sessionId, session);
      }
      addEvent(session, event);
      const domain = String(event.domain || "unknown");
      session.domains[domain] ||= emptySummary();
      addEvent(session.domains[domain], event);
      if (String(event.occurredAt || "") > session.lastUsedAt) session.lastUsedAt = String(event.occurredAt);
    } catch { /* ignore incomplete best-effort observation files */ }
  }
  return {
    sessions: [...sessions.values()].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)).slice(0, 12),
    measurementNote: "Tool calls, payload bytes, elapsed time, success, and result counts are observed. Token equivalents are estimates unless the runtime reports token usage.",
  };
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function countMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const count = nonNegativeNumber(typeof item === "object" ? (item as any)?.calls : item);
    if (count > 0) result[key] = count;
    if (Object.keys(result).length >= 128) break;
  }
  return result;
}

function modelQuality(measuredReports: number, estimatedReports: number, unknownModelCalls: number): TodoUsageQuality {
  const knownKinds = Number(measuredReports > 0) + Number(estimatedReports > 0);
  if (knownKinds > 1 || (knownKinds > 0 && unknownModelCalls > 0)) return "partial";
  if (measuredReports > 0) return "measured";
  if (estimatedReports > 0) return "estimated";
  return "unknown";
}

export function todoUsageSummary(
  storeRoot: string,
  sessionId: string,
  todoId: string,
  recipeRuns: RecipeUsageSource[],
): TodoUsageSummary {
  let aggregate: any = {};
  try {
    const aggregatePath = path.join(storeRoot, ".pkm", "state", "mcp-usage", "todos", sessionId, `${todoId}.json`);
    aggregate = JSON.parse(fs.readFileSync(aggregatePath, "utf8"));
    if (aggregate?.schema !== "pkm.mcp.todo-usage/v1"
      || aggregate?.agentSessionId !== sessionId
      || aggregate?.todoId !== todoId) aggregate = {};
  } catch { aggregate = {}; }

  const measured = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0,
  };
  let estimatedTokens = 0;
  let unknownModelCalls = 0;
  let measuredReports = 0;
  let estimatedReports = 0;
  const providers = new Set<string>();
  const models = new Set<string>();
  for (const run of recipeRuns) {
    const usage = run?.usage;
    if (!usage || typeof usage !== "object") continue;
    const tokens = usage.measuredTokens || {};
    measured.inputTokens += nonNegativeNumber(tokens.input_tokens);
    measured.outputTokens += nonNegativeNumber(tokens.output_tokens);
    measured.cachedInputTokens += nonNegativeNumber(tokens.cached_input_tokens);
    measured.reasoningTokens += nonNegativeNumber(tokens.reasoning_tokens);
    measured.totalTokens += nonNegativeNumber(tokens.total_tokens);
    estimatedTokens += nonNegativeNumber(usage.estimatedTokens);
    unknownModelCalls += nonNegativeNumber(usage.unknownModelCalls);
    measuredReports += nonNegativeNumber(usage.measuredReports);
    estimatedReports += nonNegativeNumber(usage.estimatedReports);
    for (const provider of Array.isArray(usage.providers) ? usage.providers : []) if (providers.size < 32) providers.add(String(provider));
    for (const model of Array.isArray(usage.models) ? usage.models : []) if (models.size < 32) models.add(String(model));
  }

  const calls = nonNegativeNumber(aggregate.calls);
  const successes = Math.min(calls, nonNegativeNumber(aggregate.successes));
  return {
    schema: "pkm.agent.todo-usage/v1",
    protocol: {
      observed: calls > 0,
      quality: calls > 0 ? "estimated" : "unknown",
      calls,
      successes,
      failures: Math.max(0, calls - successes),
      inputBytes: nonNegativeNumber(aggregate.inputBytes),
      outputBytes: nonNegativeNumber(aggregate.outputBytes),
      durationMs: nonNegativeNumber(aggregate.durationMs),
      estimatedTokens: nonNegativeNumber(aggregate.estimatedTokens),
      firstUsedAt: String(aggregate.firstUsedAt || ""),
      lastUsedAt: String(aggregate.lastUsedAt || ""),
      domains: countMap(aggregate.domains),
      tools: countMap(aggregate.tools),
    },
    model: {
      quality: modelQuality(measuredReports, estimatedReports, unknownModelCalls),
      measuredTokens: measured,
      estimatedTokens,
      unknownModelCalls,
      providers: [...providers],
      models: [...models],
    },
    credit: { quality: "unknown", premiumRequests: null },
  };
}
