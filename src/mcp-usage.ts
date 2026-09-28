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
