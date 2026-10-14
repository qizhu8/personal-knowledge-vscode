import * as fs from "fs";
import * as path from "path";
import { withCrossProcessLockSync } from "./cross-process-lock";
import { ExecutionSource } from "./pkm-projection";

export const BASELINE_PERSONAS = ["student", "researcher", "pm", "designer", "developer"] as const;
export const BASELINE_EVENTS = ["start-request", "start-success", "start-failed", "completed", "failed", "cancel", "restart-observed", "task-lost", "approval", "approval-repeat", "wait", "resume", "unknown-effect", "next-step-found", "chat-created", "promotion-knowledge", "promotion-action", "promotion-project"] as const;
export type BaselineEventKind = typeof BASELINE_EVENTS[number];
export interface BaselineEvent {
  kind: BaselineEventKind;
  source: ExecutionSource;
  evidence: "observed" | "synthetic" | "human";
  persona?: typeof BASELINE_PERSONAS[number];
  durationMs?: number;
  count?: number;
}
export type BaselineFailureCode = "directory-unavailable" | "lock-failed" | "write-failed" | "replace-failed" | "cleanup-failed" | "read-failed" | "invalid-storage" | "storage-too-large";
export type BaselineRecordResult = { status: "recorded" | "disabled" | "invalid-event" } | { status: "unavailable"; reasonCode: BaselineFailureCode };
const recordingFailures = new Map<string, BaselineFailureCode>();
function rememberFailure(directory: string, reasonCode: BaselineFailureCode): void {
  if (!recordingFailures.has(directory)) {
    if (recordingFailures.size >= 32) recordingFailures.delete(recordingFailures.keys().next().value!);
    recordingFailures.set(directory, reasonCode);
  }
}
const sources = new Set(["recipe-runtime", "agent-session", "action-validation", "action-runtime", "chat-worker", "project", "collaboration"]);
function sanitize(value: BaselineEvent): BaselineEvent | undefined {
  if (!value || typeof value !== "object") return;
  if (!BASELINE_EVENTS.includes(value.kind) || !sources.has(value.source)
    || !["observed", "synthetic", "human"].includes(value.evidence)
    || value.persona !== undefined && !BASELINE_PERSONAS.includes(value.persona)
    || value.durationMs !== undefined && (!Number.isFinite(value.durationMs) || value.durationMs < 0)
    || value.count !== undefined && (!Number.isSafeInteger(value.count) || value.count < 1)) return;
  return { kind: value.kind, source: value.source, evidence: value.evidence,
    ...(value.persona ? { persona: value.persona } : {}),
    ...(value.durationMs !== undefined ? { durationMs: Math.round(value.durationMs) } : {}),
    ...(value.count !== undefined ? { count: value.count } : {}) };
}
function read(directory: string): { status: "available" | "missing" | "unavailable"; events: BaselineEvent[]; reasonCode?: BaselineFailureCode } {
  try {
    const file = path.join(directory, "p0-baseline.json");
    if (fs.statSync(file).size > 4_000_000) return { status: "unavailable", events: [], reasonCode: "storage-too-large" };
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.schema !== "pkm.baseline/v1" || !Array.isArray(value.events)) return { status: "unavailable", events: [], reasonCode: "invalid-storage" };
    const events = value.events.slice(-10000).map(sanitize);
    if (events.some((event: BaselineEvent | undefined) => !event)) return { status: "unavailable", events: [], reasonCode: "invalid-storage" };
    return { status: "available", events };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing", events: [] }
      : { status: "unavailable", events: [], reasonCode: error instanceof SyntaxError ? "invalid-storage" : "read-failed" };
  }
}
/** Opt-in is evaluated on every call. Payload fields outside the allowlist are discarded. */
export function recordBaselineEvent(directory: string, enabled: boolean, event: BaselineEvent): BaselineRecordResult {
  if (!enabled) return { status: "disabled" };
  if (!directory) return { status: "unavailable", reasonCode: "directory-unavailable" };
  const safe = sanitize(event);
  if (!safe) return { status: "invalid-event" };
  let reasonCode: BaselineFailureCode = "directory-unavailable";
  try {
    fs.mkdirSync(directory, { recursive: true });
    reasonCode = "lock-failed";
    withCrossProcessLockSync(path.join(directory, "p0-baseline.lock"), "Local baseline", () => {
      const stored = read(directory);
      if (stored.status === "unavailable") {
        reasonCode = stored.reasonCode!;
        throw new Error("Local baseline storage unavailable");
      }
      const events = [...stored.events, safe].slice(-10000);
      const file = path.join(directory, "p0-baseline.json");
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        reasonCode = "write-failed";
        fs.writeFileSync(temporary, JSON.stringify({ schema: "pkm.baseline/v1", events }), { mode: 0o600 });
        reasonCode = "replace-failed";
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) {
          try { fs.unlinkSync(temporary); }
          catch { reasonCode = "cleanup-failed"; throw new Error("Local baseline cleanup unavailable"); }
        }
      }
    });
    return { status: "recorded" };
  } catch {
    rememberFailure(directory, reasonCode);
    return { status: "unavailable", reasonCode };
  }
}
export function summarizeBaseline(events: readonly BaselineEvent[]) {
  const count = (kind: BaselineEventKind) => {
    const rows = events.filter(event => event.kind === kind);
    return rows.length ? rows.reduce((sum, event) => sum + (event.count ?? 1), 0) : null;
  };
  const ratio = (numerator: BaselineEventKind, denominator: BaselineEventKind) => {
    const n = count(numerator), d = count(denominator);
    return { available: n !== null && d !== null && d > 0, numerator: n, denominator: d,
      value: n !== null && d !== null && d > 0 ? n / d : null };
  };
  const durations = events.filter(event => event.kind === "next-step-found" && event.durationMs !== undefined).map(event => event.durationMs!);
  return {
    samples: events.length,
    startSuccess: ratio("start-success", "start-request"), cancellation: ratio("cancel", "start-success"),
    restartLoss: ratio("task-lost", "restart-observed"), repeatedApproval: ratio("approval-repeat", "approval"),
    waitingRecovery: ratio("resume", "wait"), unknownEffects: count("unknown-effect"),
    nextStepMs: { available: durations.length > 0, samples: durations.length, mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null },
    promotions: Object.fromEntries((["knowledge", "action", "project"] as const).map(kind => [kind, ratio(`promotion-${kind}`, "chat-created")])),
  };
}
export function baselineReport(directory: string, enabled: boolean) {
  const stored = enabled ? read(directory) : undefined;
  const recordingFailure = enabled ? recordingFailures.get(directory) : undefined;
  const available = stored?.status === "available" && !recordingFailure;
  const events = available ? stored.events : [];
  return { schema: "pkm.baseline-report/v1", enabled, scope: "local-only", window: "latest-10000-events",
    available,
    storage: { status: stored?.status || "disabled", ...(stored?.reasonCode ? { reasonCode: stored.reasonCode } : {}) },
    collection: { status: !enabled ? "disabled" : recordingFailure ? "incomplete" : "no-known-failure",
      ...(recordingFailure ? { reasonCode: recordingFailure } : {}) },
    observed: summarizeBaseline(events.filter(event => event.evidence === "observed")),
    sources: Object.fromEntries([...sources].map(source => [source, summarizeBaseline(events.filter(event => event.source === source && event.evidence === "observed"))])),
    personas: BASELINE_PERSONAS.map(persona => ({ persona,
      human: summarizeBaseline(events.filter(event => event.persona === persona && event.evidence === "human")),
      synthetic: summarizeBaseline(events.filter(event => event.persona === persona && event.evidence === "synthetic")),
      humanUxEvidence: events.some(event => event.persona === persona && event.evidence === "human" && event.kind === "next-step-found" && event.durationMs !== undefined) ? "available" : "unavailable",
    })),
  };
}
