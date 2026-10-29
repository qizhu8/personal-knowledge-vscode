import { createHash } from "crypto";

export type TaskProgressStatus = "progressing" | "slow-but-progressing" | "looping" | "waiting" | "blocked" | "complete" | "unknown";
export type TaskWaitReason = "user" | "approval" | "external-job";
export interface TaskProgressToolCall {
  id: string;
  name: string;
  arguments: string;
  status: "running" | "complete" | "failed" | "permission-denied";
  result?: string;
  alternativeAvailable?: boolean;
}
/** Explicit observations, not inferred completion from a transport ending or a quiet worker. */
export type TaskProgressRecord = { at: number } & (
  | { kind: "artifact"; hash: string }
  | { kind: "content"; hash: string }
  | { kind: "file"; path: string }
  | { kind: "tool-call"; call: TaskProgressToolCall }
  | { kind: "wait"; id: string; reason: TaskWaitReason; status: "pending" | "resolved" }
  | { kind: "complete"; detail?: string }
  | { kind: "activity" }
);
export interface TaskProgressOptions {
  /** Defaults to the latest record's timestamp; this module never reads the wall clock. */
  now?: number;
  windowMs?: number;
  repeatThreshold?: number;
  slowAfterMs?: number;
  startedAt?: number;
}
export interface TaskProgressEvidence {
  at: number;
  kind: TaskProgressRecord["kind"];
  key: string;
  detail: string;
}
export interface TaskProgressResult {
  status: TaskProgressStatus;
  reasons: string[];
  evidence: TaskProgressEvidence[];
}

function nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and nonnegative.`);
  return value;
}
function positive(value: number, label: string): number {
  nonnegative(value, label);
  if (value === 0) throw new Error(`${label} must be positive.`);
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

/** JSON object key order and whitespace are ignored; array order and string contents are preserved. */
export function taskToolCallSignature(call: Pick<TaskProgressToolCall, "name" | "arguments">): string {
  let normalized: string;
  try { normalized = canonical(JSON.parse(call.arguments)); }
  catch { normalized = call.arguments.trim(); }
  return JSON.stringify([call.name, hash(normalized)]);
}

/** Precedence: explicit completion, pending wait, blocked, looping, progress, unknown. */
export function classifyTaskProgress(records: readonly TaskProgressRecord[], options: TaskProgressOptions = {}): TaskProgressResult {
  const ordered = [...records].sort((a, b) => a.at - b.at);
  for (const record of ordered) nonnegative(record.at, "Record timestamp");
  const now = nonnegative(options.now ?? ordered[ordered.length - 1]?.at ?? 0, "Current time");
  const windowMs = positive(options.windowMs ?? 60_000, "Progress window");
  const threshold = positive(options.repeatThreshold ?? 3, "Repeat threshold");
  if (!Number.isSafeInteger(threshold) || threshold < 2) throw new Error("Repeat threshold must be an integer >= 2.");
  const slowAfterMs = positive(options.slowAfterMs ?? 300_000, "Slow threshold");
  const startedAt = nonnegative(options.startedAt ?? ordered[0]?.at ?? now, "Start time");
  const history = ordered.filter(record => record.at <= now);
  const result = (status: TaskProgressStatus, reason: string, evidence: TaskProgressEvidence[]): TaskProgressResult => ({ status, reasons: [reason], evidence });
  const evidence = (record: TaskProgressRecord, key: string, detail: string): TaskProgressEvidence => ({ at: record.at, kind: record.kind, key, detail });
  const completion = history.find(record => record.kind === "complete");
  if (completion) return result("complete", "Explicit task completion was recorded.", [evidence(completion, "complete", "Task completion record")]);

  const waits = new Map<string, Extract<TaskProgressRecord, { kind: "wait" }>>();
  for (const record of history) if (record.kind === "wait") {
    if (record.status === "pending") waits.set(record.id, record);
    else waits.delete(record.id);
  }
  if (waits.size) return result("waiting", "Pending user input, approval or external work is not idle time.",
    [...waits.values()].map(record => evidence(record, record.id, record.reason)));

  const artifacts = new Set<string>(), signatures = new Set<string>();
  const artifactEvidence: TaskProgressEvidence[] = [], toolEvidence: TaskProgressEvidence[] = [];
  // A call's running/terminal snapshots are one invocation, not repeated attempts.
  const calls = new Map<string, { call: TaskProgressToolCall; at: number; index: number; signature: string }>();
  let lastArtifactIndex = -1;
  for (const [index, record] of history.entries()) {
    if (record.kind === "artifact" || record.kind === "content" || record.kind === "file") {
      const key = record.kind === "file" ? `file:${record.path}` : `hash:${record.hash}`;
      if (!artifacts.has(key)) {
        artifacts.add(key);
        lastArtifactIndex = index;
        if (record.at >= now - windowMs) artifactEvidence.push(evidence(record, key, "New artifact, content hash or file"));
      }
    } else if (record.kind === "tool-call") {
      const signature = taskToolCallSignature(record.call);
      if (!signatures.has(signature)) {
        signatures.add(signature);
        if (record.at >= now - windowMs) toolEvidence.push(evidence(record, signature, "New distinct tool-call signature"));
      }
      const previous = calls.get(record.call.id);
      if (previous && previous.signature !== signature) throw new Error("Tool-call identity cannot change its signature.");
      calls.set(record.call.id, { call: record.call, at: previous?.at ?? record.at, index: previous?.index ?? index, signature });
    }
  }
  const repeats = new Map<string, TaskProgressEvidence[]>(), failures = new Map<string, TaskProgressEvidence[]>();
  const blocked: TaskProgressEvidence[] = [];
  for (const { call, at, index, signature } of calls.values()) {
    if (at < now - windowMs || index < lastArtifactIndex) continue;
    const item: TaskProgressEvidence = { at, kind: "tool-call", key: signature, detail: call.status };
    const group = repeats.get(signature) ?? [];
    group.push(item); repeats.set(signature, group);
    if (call.status === "failed" || call.status === "permission-denied") {
      const failureKey = JSON.stringify([call.status, hash(call.result ?? "")]);
      // Missing error text is not evidence that two failures had the same result.
      if (call.result !== undefined) {
        const failing = failures.get(failureKey) ?? [];
        failing.push(item); failures.set(failureKey, failing);
      }
      if (call.alternativeAvailable === false) blocked.push(item);
    }
  }
  if (blocked.length >= threshold) return result("blocked", "Repeated denials or failures explicitly have no available alternative and no new artifacts.", blocked);
  const repeated = [...repeats.values(), ...failures.values()].find(group => group.length >= threshold);
  if (repeated) return result("looping", "A tool signature or failing result repeated within the window without new artifacts.", repeated);
  const progress = [...artifactEvidence, ...toolEvidence];
  if (progress.length) {
    const slow = now - startedAt >= slowAfterMs && artifactEvidence.length >= 2
      && artifactEvidence[0].at !== artifactEvidence[artifactEvidence.length - 1].at;
    return result(slow ? "slow-but-progressing" : "progressing", slow
      ? "Long wall time, but distinct artifacts continue to arrive."
      : "New artifacts, content, files or distinct tool signatures were observed.", progress);
  }
  return result("unknown", "No explicit completion, pending wait or sufficient recent progress/stall evidence.", []);
}

/** Own, round-local counters only: never subtree totals or attempt-cumulative counters repeated per round. */
export interface WorkerQuotaRound {
  roundId: string | number;
  usage: Readonly<Record<string, number>>;
}
export interface WorkerQuotaNode {
  workerId: string;
  rounds: readonly WorkerQuotaRound[];
  children?: readonly WorkerQuotaNode[];
}
export interface WorkerQuotaAggregate {
  workerId: string;
  ownUsage: Record<string, number>;
  totalUsage: Record<string, number>;
  roundCount: number;
  children: WorkerQuotaAggregate[];
}

/** Re-reported cumulative round counters merge by maximum, not addition (including stale reloads). */
export function aggregateWorkerQuotas(root: WorkerQuotaNode): WorkerQuotaAggregate {
  const workers = new Map<string, { parent?: string; rounds: Map<string, Record<string, number>>; children: Set<string> }>();
  function visit(node: WorkerQuotaNode, parent: string | undefined, ancestry: ReadonlySet<string>): void {
    if (!node.workerId || ancestry.has(node.workerId)) throw new Error("Invalid or cyclic worker identity.");
    let worker = workers.get(node.workerId);
    if (worker && worker.parent !== parent) throw new Error("A worker cannot have multiple parents.");
    if (!worker) { worker = { parent, rounds: new Map(), children: new Set() }; workers.set(node.workerId, worker); }
    for (const round of node.rounds) {
      if (typeof round.roundId === "number" ? !Number.isSafeInteger(round.roundId) || round.roundId < 0 : !round.roundId) throw new Error("Invalid round identity.");
      const key = String(round.roundId);
      const usage = worker.rounds.get(key) ?? Object.create(null) as Record<string, number>;
      for (const [metric, value] of Object.entries(round.usage)) {
        nonnegative(value, `Worker usage ${metric}`);
        usage[metric] = Math.max(usage[metric] ?? 0, value);
      }
      worker.rounds.set(key, usage);
    }
    const next = new Set(ancestry); next.add(node.workerId);
    for (const child of node.children ?? []) {
      worker.children.add(child.workerId);
      visit(child, node.workerId, next);
    }
  }
  visit(root, undefined, new Set());
  function add(total: Record<string, number>, usage: Record<string, number>): void {
    for (const [metric, value] of Object.entries(usage)) {
      total[metric] = (total[metric] ?? 0) + value;
      if (!Number.isFinite(total[metric]) || total[metric] > Number.MAX_SAFE_INTEGER) throw new Error("Worker usage exceeds safe accounting precision.");
    }
  }
  function aggregate(workerId: string): WorkerQuotaAggregate {
    const worker = workers.get(workerId)!;
    const ownUsage: Record<string, number> = Object.create(null);
    for (const usage of worker.rounds.values()) add(ownUsage, usage);
    const children = [...worker.children].sort().map(aggregate);
    const totalUsage: Record<string, number> = Object.assign(Object.create(null), ownUsage);
    for (const child of children) add(totalUsage, child.totalUsage);
    return { workerId, ownUsage, totalUsage, roundCount: worker.rounds.size, children };
  }
  return aggregate(root.workerId);
}

export type DeadlinePhase = "foreground" | "tool" | "materialization";
/** warningMs is an active elapsed-time threshold (defaults to 80% of limitMs). */
export interface PhaseDeadline { limitMs: number; warningMs?: number; }
export interface PhaseWait { startedAt: number; finishedAt?: number; reason: TaskWaitReason; }
/** Accepts the invocation clock's userWaitMs, or intervals (whose overlaps are merged), never both. */
export interface PhaseTiming {
  startedAt: number;
  finishedAt?: number;
  userWaitMs?: number;
  waits?: readonly PhaseWait[];
}
export interface PhaseDeadlineResult {
  status: "ok" | "warning" | "exceeded";
  remainingMs?: number;
  activeMs?: number;
  excludedWaitMs?: number;
  reason: string;
}
export type PhaseDeadlines = Partial<Record<DeadlinePhase, number | PhaseDeadline>>;
export type PhaseTimings = Partial<Record<DeadlinePhase, PhaseTiming>>;

export function evaluateDeadlines(deadlines: PhaseDeadlines, timings: PhaseTimings, now: number): Record<DeadlinePhase, PhaseDeadlineResult> {
  nonnegative(now, "Current time");
  const entries = (["foreground", "tool", "materialization"] as const).map(phase => {
    const configured = deadlines[phase], timing = timings[phase];
    const limit = typeof configured === "number" ? configured : configured?.limitMs;
    const warning = typeof configured === "object" ? configured.warningMs ?? (limit ?? 0) * 0.8 : (limit ?? 0) * 0.8;
    if (limit !== undefined) {
      positive(limit, "Phase deadline"); nonnegative(warning, "Warning threshold");
      if (warning > limit) throw new Error("Warning threshold must not exceed deadline.");
    }
    if (!timing) return [phase, { status: "ok", reason: "Phase has not started; no elapsed time is inferred." }] as const;
    nonnegative(timing.startedAt, "Phase start");
    if (timing.finishedAt !== undefined && nonnegative(timing.finishedAt, "Phase finish") < timing.startedAt) throw new Error("Phase finish precedes start.");
    const end = Math.max(timing.startedAt, Math.min(now, timing.finishedAt ?? now));
    const elapsed = end - timing.startedAt;
    if (timing.waits !== undefined && timing.userWaitMs !== undefined) throw new Error("Use wait intervals or cumulative user wait, not both.");
    const intervals = (timing.waits ?? []).map(wait => {
      nonnegative(wait.startedAt, "Wait start");
      if (wait.finishedAt !== undefined && nonnegative(wait.finishedAt, "Wait finish") < wait.startedAt) throw new Error("Wait finish precedes start.");
      return wait;
    }).filter(wait => wait.reason !== "external-job").map(wait => [Math.max(timing.startedAt, wait.startedAt), Math.min(end, wait.finishedAt ?? end)])
      .filter(([start, finish]) => finish > start).sort((a, b) => a[0] - b[0]);
    let excluded = 0, previousEnd = timing.startedAt;
    for (const [start, finish] of intervals) {
      excluded += Math.max(0, finish - Math.max(start, previousEnd));
      previousEnd = Math.max(previousEnd, finish);
    }
    if (timing.userWaitMs !== undefined) {
      excluded = nonnegative(timing.userWaitMs, "Cumulative user wait");
      if (excluded > elapsed) throw new Error("User wait cannot exceed observed phase time.");
    }
    const activeMs = elapsed - excluded;
    const status = limit === undefined ? "ok" : activeMs >= limit ? "exceeded" : activeMs >= warning ? "warning" : "ok";
    return [phase, { status, activeMs, excludedWaitMs: excluded, ...(limit === undefined ? {} : { remainingMs: limit - activeMs }),
      reason: limit === undefined ? "No deadline configured; this is not unlimited measured capacity." : "Deadline uses active time, excluding user and approval waits." }] as const;
  });
  return Object.fromEntries(entries) as Record<DeadlinePhase, PhaseDeadlineResult>;
}
