import { createHash } from "crypto";
import { canonicalJson } from "../workflow-contracts";

export type Scalar = null | boolean | string | Int64Value | DecimalValue;
export type ControlValue = Scalar | readonly ControlValue[] | Readonly<{ [key: string]: ControlValue }>;
export interface Int64Value { readonly type: "int64"; readonly value: string }
export interface DecimalValue { readonly type: "decimal"; readonly value: string }

export type Expression =
  | { readonly kind: "literal"; readonly value: ControlValue }
  | { readonly kind: "source"; readonly name: string }
  | { readonly kind: "field"; readonly target: Expression; readonly name: string }
  | { readonly kind: "index"; readonly target: Expression; readonly index: Expression }
  | { readonly kind: "and" | "or"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "not"; readonly operand: Expression }
  | { readonly kind: "compare"; readonly operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "arithmetic"; readonly operator: "add" | "sub" | "mul"; readonly left: Expression; readonly right: Expression };

export interface ControlCommand { readonly commandId: string; readonly fingerprint: string; readonly expectedVersion: number }
export interface ControlReceipt { readonly commandId: string; readonly fingerprint: string; readonly operation: string; readonly version: number; readonly index?: number }

export class WorkflowControlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowControlError";
  }
}

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const INT64_PATTERN = /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function controlFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function int64(value: string): Int64Value {
  const parsed = parseInt64(value);
  return deepFreeze({ type: "int64", value: parsed.toString() });
}

export function decimal(value: string): DecimalValue {
  return deepFreeze({ type: "decimal", value: normalizeDecimal(value) });
}

export function compareNfc(left: string, right: string): number {
  const leftPoints = Array.from(left.normalize("NFC"), character => character.codePointAt(0) as number);
  const rightPoints = Array.from(right.normalize("NFC"), character => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] < rightPoints[index] ? -1 : 1;
  }
  return leftPoints.length === rightPoints.length ? 0 : leftPoints.length < rightPoints.length ? -1 : 1;
}

export function evaluateExpression(expression: Expression, sources: Readonly<Record<string, ControlValue>>): ControlValue {
  switch (expression.kind) {
    case "literal": return normalizeValue(expression.value);
    case "source": {
      if (!Object.prototype.hasOwnProperty.call(sources, expression.name)) fail("expression-source", `Unknown source ${expression.name}.`);
      return normalizeValue(sources[expression.name]);
    }
    case "field": {
      const target = evaluateExpression(expression.target, sources);
      if (!isValueRecord(target) || !Object.prototype.hasOwnProperty.call(target, expression.name)) fail("expression-field", `Unknown field ${expression.name}.`);
      return target[expression.name];
    }
    case "index": {
      const target = evaluateExpression(expression.target, sources);
      const index = evaluateExpression(expression.index, sources);
      if (!Array.isArray(target) || !isInt64(index)) fail("expression-index", "Index requires an array and int64 index.");
      const offset = Number(parseInt64(index.value));
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= target.length) fail("expression-index-range", "Array index is outside the value.");
      return target[offset];
    }
    case "and": {
      const left = requireBoolean(evaluateExpression(expression.left, sources));
      return left ? requireBoolean(evaluateExpression(expression.right, sources)) : false;
    }
    case "or": {
      const left = requireBoolean(evaluateExpression(expression.left, sources));
      return left ? true : requireBoolean(evaluateExpression(expression.right, sources));
    }
    case "not": return !requireBoolean(evaluateExpression(expression.operand, sources));
    case "compare": {
      const order = compareExact(evaluateExpression(expression.left, sources), evaluateExpression(expression.right, sources));
      switch (expression.operator) {
        case "eq": return order === 0;
        case "ne": return order !== 0;
        case "lt": return order < 0;
        case "lte": return order <= 0;
        case "gt": return order > 0;
        case "gte": return order >= 0;
      }
    }
    case "arithmetic": return calculate(expression.operator, evaluateExpression(expression.left, sources), evaluateExpression(expression.right, sources));
  }
}

export type CheckAdapterResult =
  | Readonly<{ kind: "verdict"; passed: boolean; evidenceCitations: readonly string[] }>
  | Readonly<{ kind: "adapter-failure"; failureCode: string }>;
export interface CheckResolution {
  readonly status: "passed" | "failed-verdict" | "adapter-failure";
  readonly nodeResult: "succeeded" | "failed" | "indeterminate";
  readonly signal: boolean;
  readonly evidenceCitations: readonly string[];
  readonly failureCode?: string;
}

export function resolveCheck(result: CheckAdapterResult, failureMode: "signal" | "require-passed"): CheckResolution {
  if (result.kind === "adapter-failure") {
    return deepFreeze({ status: "adapter-failure", nodeResult: "indeterminate", signal: false, evidenceCitations: [], failureCode: result.failureCode });
  }
  if (result.passed) return deepFreeze({ status: "passed", nodeResult: "succeeded", signal: false, evidenceCitations: [...result.evidenceCitations] });
  return deepFreeze({ status: "failed-verdict", nodeResult: failureMode === "signal" ? "succeeded" : "failed", signal: failureMode === "signal", evidenceCitations: [...result.evidenceCitations] });
}

export interface VersionTuple { readonly runId: string; readonly runVersion: number; readonly nodeId: string; readonly nodeVersion: number; readonly attemptId: string; readonly attemptVersion: number; readonly definitionVersionId: string }
export interface EvidenceCitation { readonly evidenceId: string; readonly digest: string }
export interface GateChallenge {
  readonly challengeId: string;
  readonly version: number;
  readonly tuple: VersionTuple;
  readonly authorizedActors: readonly string[];
  readonly authorizationSnapshotId: string;
  readonly evidence: readonly EvidenceCitation[];
  readonly expiresAt: number;
  readonly decision?: Readonly<{ actorId: string; verdict: "approved" | "rejected"; evidence: readonly EvidenceCitation[] }>;
  readonly receipts: readonly ControlReceipt[];
}
export interface GateDecisionResult { readonly challenge: GateChallenge; readonly receipt: ControlReceipt; readonly replayed: boolean }

export function createGateChallenge(input: Omit<GateChallenge, "version" | "decision" | "receipts">): GateChallenge {
  requireIdentity(input.challengeId, "gate-challenge");
  requireIdentity(input.authorizationSnapshotId, "gate-authorization-snapshot");
  validateTuple(input.tuple);
  if (!Number.isFinite(input.expiresAt)) fail("gate-expiry", "Gate expiry must be an explicit finite instant.");
  const authorizedActors = sortedUnique(input.authorizedActors, "gate-actor");
  if (!authorizedActors.length) fail("gate-actor", "Gate requires an authorization snapshot with at least one actor.");
  return deepFreeze({ ...input, tuple: { ...input.tuple }, authorizedActors, evidence: normalizeEvidence(input.evidence), version: 1, receipts: [] });
}

export function decideGate(
  challenge: GateChallenge,
  command: ControlCommand,
  input: Readonly<{ actorId: string; verdict: "approved" | "rejected"; tuple: VersionTuple; evidence: readonly EvidenceCitation[]; observedAt: number }>
): GateDecisionResult {
  const replay = replayReceipt(challenge.receipts, command);
  if (replay) return { challenge, receipt: replay, replayed: true };
  checkCommandVersion(challenge.version, command);
  if (challenge.decision) fail("gate-consumed", "Gate challenge has already been consumed.");
  if (!Number.isFinite(input.observedAt)) fail("gate-observation", "Gate observation must be an explicit finite instant.");
  if (input.observedAt > challenge.expiresAt) fail("gate-expired", "Gate challenge has expired.");
  if (!challenge.authorizedActors.includes(input.actorId)) fail("gate-unauthorized", "Actor is not in the immutable authorization snapshot.");
  if (controlFingerprint(input.tuple) !== controlFingerprint(challenge.tuple)) fail("gate-stale", "Gate response carries a stale version tuple.");
  const evidence = normalizeEvidence(input.evidence);
  if (controlFingerprint(evidence) !== controlFingerprint(challenge.evidence)) fail("gate-evidence-stale", "Gate response does not cite the exact challenged evidence.");
  const receipt = makeReceipt(command, "gate-decision", challenge.version + 1);
  return {
    challenge: deepFreeze({ ...challenge, version: receipt.version, decision: { actorId: input.actorId, verdict: input.verdict, evidence }, receipts: [...challenge.receipts, receipt] }),
    receipt,
    replayed: false
  };
}

export interface BranchPath { readonly id: string; readonly priority: number; readonly when: Expression }
export interface BranchDecision {
  readonly mode: "exclusive" | "multi";
  readonly selected: readonly string[];
  readonly notSelected: readonly string[];
  readonly defaultSelected: boolean;
  readonly commandId: string;
  readonly fingerprint: string;
}

export function decideBranch(
  mode: "exclusive" | "multi",
  paths: readonly BranchPath[],
  defaultPathId: string | undefined,
  sources: Readonly<Record<string, ControlValue>>,
  command: Readonly<{ commandId: string; fingerprint: string }>
): BranchDecision {
  requireCommand(command);
  const ids = sortedUnique(paths.map(path => path.id), "branch-path");
  if (paths.some(path => !Number.isSafeInteger(path.priority))) fail("branch-priority", "Branch priority must be a safe integer.");
  if (defaultPathId !== undefined && ids.includes(defaultPathId)) fail("branch-default", "Default path must be distinct from conditional paths.");
  const ordered = [...paths].sort((left, right) => left.priority - right.priority || compareNfc(left.id, right.id));
  const matched = ordered.filter(path => requireBoolean(evaluateExpression(path.when, sources))).map(path => path.id);
  let selected = mode === "exclusive" ? matched.slice(0, 1) : matched;
  let defaultSelected = false;
  if (!selected.length && defaultPathId !== undefined) {
    selected = [defaultPathId];
    defaultSelected = true;
  }
  const all = defaultPathId === undefined ? ids : [...ids, defaultPathId].sort(compareNfc);
  return deepFreeze({ mode, selected, notSelected: all.filter(id => !selected.includes(id)), defaultSelected, commandId: command.commandId, fingerprint: command.fingerprint });
}

export interface MergeInput { readonly pathId: string; readonly state: "completed" | "failed" | "not-selected" }
export interface MergeResolution { readonly ready: boolean; readonly consumed: readonly string[]; readonly failed: readonly string[] }

export function resolveMerge(mode: "exclusive" | "multi", inputs: readonly MergeInput[]): MergeResolution {
  if (mode === "multi" && inputs.some(input => input.state === "not-selected")) fail("merge-not-selected", "Multi-branch merge cannot consume not-selected inputs.");
  const relevant = mode === "exclusive" ? inputs.filter(input => input.state !== "not-selected") : [...inputs];
  return deepFreeze({
    ready: relevant.length > 0 && relevant.every(input => input.state === "completed"),
    consumed: inputs.filter(input => mode === "exclusive" || input.state !== "not-selected").map(input => input.pathId).sort(compareNfc),
    failed: relevant.filter(input => input.state === "failed").map(input => input.pathId).sort(compareNfc)
  });
}

export type JoinMode = "all" | "any" | "first-success" | "quorum" | "race";
export interface JoinCandidate { readonly id: string; readonly state: "pending" | "succeeded" | "failed"; readonly transactionSequence?: number }
export interface JoinResolution { readonly state: "pending" | "succeeded" | "failed"; readonly winners: readonly string[]; readonly loserActions: readonly Readonly<{ candidateId: string; action: "cancel" | "ignore" }>[] }

export function resolveJoin(mode: JoinMode, candidates: readonly JoinCandidate[], quorum = 1): JoinResolution {
  if (!candidates.length) fail("join-candidates", "Join requires candidates.");
  sortedUnique(candidates.map(candidate => candidate.id), "join-candidate");
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > candidates.length) fail("join-quorum", "Join quorum is outside the candidate set.");
  const terminal = candidates.filter(candidate => candidate.state !== "pending");
  if (terminal.some(candidate => !Number.isSafeInteger(candidate.transactionSequence) || (candidate.transactionSequence as number) < 1)) {
    fail("join-sequence", "Terminal candidates require an authoritative positive transaction sequence.");
  }
  const ordered = [...terminal].sort((left, right) => (left.transactionSequence as number) - (right.transactionSequence as number) || compareNfc(left.id, right.id));
  const successes = ordered.filter(candidate => candidate.state === "succeeded");
  let state: JoinResolution["state"] = "pending";
  let winners: JoinCandidate[] = [];
  if (mode === "all") {
    if (candidates.some(candidate => candidate.state === "failed")) state = "failed";
    else if (successes.length === candidates.length) { state = "succeeded"; winners = successes; }
  } else if (mode === "any") {
    if (ordered.length) { winners = [ordered[0]]; state = ordered[0].state; }
  } else if (mode === "race") {
    if (ordered.length) { winners = [ordered[0]]; state = ordered[0].state; }
  } else if (mode === "first-success") {
    if (successes.length) { state = "succeeded"; winners = [successes[0]]; }
    else if (terminal.length === candidates.length) state = "failed";
  } else {
    if (successes.length >= quorum) { state = "succeeded"; winners = successes.slice(0, quorum); }
    else if (candidates.length - terminal.filter(candidate => candidate.state === "failed").length < quorum) state = "failed";
  }
  const winnerIds = new Set(winners.map(candidate => candidate.id));
  const loserActions = state === "pending" ? [] : candidates.filter(candidate => !winnerIds.has(candidate.id)).sort((left, right) => compareNfc(left.id, right.id)).map(candidate => ({ candidateId: candidate.id, action: candidate.state === "pending" ? "cancel" as const : "ignore" as const }));
  return deepFreeze({ state, winners: winners.map(candidate => candidate.id), loserActions });
}

export interface LoopState {
  readonly version: number;
  readonly maxIterations: number;
  readonly onLimit: "fail" | "complete";
  readonly nextIndex: number;
  readonly outputs: readonly Readonly<{ index: number; value: ControlValue }>[];
  readonly limited: boolean;
  readonly limitResult?: "failed" | "completed";
  readonly receipts: readonly ControlReceipt[];
}
export interface LoopMutation { readonly loop: LoopState; readonly receipt: ControlReceipt; readonly replayed: boolean; readonly index?: number }

export function createLoop(maxIterations: number, onLimit: "fail" | "complete"): LoopState {
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) fail("loop-bound", "Loop maximum must be a non-negative safe integer.");
  return deepFreeze({ version: 1, maxIterations, onLimit, nextIndex: 0, outputs: [], limited: false, receipts: [] });
}

export function beginLoopIteration(loop: LoopState, command: ControlCommand): LoopMutation {
  const replay = replayReceipt(loop.receipts, command);
  if (replay) return { loop, receipt: replay, replayed: true, ...(replay.index === undefined ? {} : { index: replay.index }) };
  checkCommandVersion(loop.version, command);
  if (loop.limited) fail("loop-closed", "Loop is already at its limit.");
  if (loop.nextIndex >= loop.maxIterations) {
    const receipt = makeReceipt(command, `loop-limit-${loop.onLimit}`, loop.version + 1);
    const limitResult = loop.onLimit === "fail" ? "failed" : "completed";
    return { loop: deepFreeze({ ...loop, version: receipt.version, limited: true, limitResult, receipts: [...loop.receipts, receipt] }), receipt, replayed: false };
  }
  const index = loop.nextIndex;
  const receipt = deepFreeze({ ...makeReceipt(command, "loop-begin", loop.version + 1), index });
  return { loop: deepFreeze({ ...loop, version: receipt.version, nextIndex: index + 1, receipts: [...loop.receipts, receipt] }), receipt, replayed: false, index };
}

export function recordLoopOutput(loop: LoopState, command: ControlCommand, index: number, value: ControlValue): LoopMutation {
  const replay = replayReceipt(loop.receipts, command);
  if (replay) return { loop, receipt: replay, replayed: true };
  checkCommandVersion(loop.version, command);
  if (!Number.isSafeInteger(index) || index < 0 || index >= loop.nextIndex) fail("loop-index", "Loop output index was not transactionally allocated.");
  if (loop.outputs.some(output => output.index === index)) fail("loop-output-duplicate", "Loop output index is already recorded.");
  const receipt = makeReceipt(command, "loop-output", loop.version + 1);
  const outputs = [...loop.outputs, { index, value: normalizeValue(value) }].sort((left, right) => left.index - right.index);
  return { loop: deepFreeze({ ...loop, version: receipt.version, outputs, receipts: [...loop.receipts, receipt] }), receipt, replayed: false };
}

export interface SubflowLock { readonly definitionId: string; readonly versionId: string; readonly bundleDigest: string }
export interface SubflowBinding { readonly childRunId: string; readonly lock: SubflowLock; readonly commandId: string; readonly fingerprint: string }
export interface SubflowState { readonly version: number; readonly binding?: SubflowBinding; readonly receipts: readonly ControlReceipt[] }
export interface SubflowMutation { readonly subflow: SubflowState; readonly receipt: ControlReceipt; readonly replayed: boolean }

export function createSubflowState(): SubflowState {
  return deepFreeze({ version: 1, receipts: [] });
}

export function bindSubflow(state: SubflowState, command: ControlCommand, childRunId: string, lock: SubflowLock): SubflowMutation {
  const replay = replayReceipt(state.receipts, command);
  if (replay) return { subflow: state, receipt: replay, replayed: true };
  checkCommandVersion(state.version, command);
  requireIdentity(childRunId, "subflow-child");
  requireIdentity(lock.definitionId, "subflow-definition");
  requireIdentity(lock.versionId, "subflow-version");
  if (!DIGEST.test(lock.bundleDigest)) fail("subflow-lock", "Subflow requires an exact bundle digest.");
  if (state.binding) fail("subflow-bound", "Subflow node already has a child binding.");
  const receipt = makeReceipt(command, "subflow-bind", state.version + 1);
  const binding = { childRunId, lock: { ...lock }, commandId: command.commandId, fingerprint: command.fingerprint };
  return { subflow: deepFreeze({ ...state, version: receipt.version, binding, receipts: [...state.receipts, receipt] }), receipt, replayed: false };
}

export function mapSubflowResult(result: "succeeded" | "failed" | "cancelled" | "indeterminate"): "succeeded" | "failed" | "cancelled" | "indeterminate" {
  switch (result) {
    case "succeeded": return "succeeded";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "indeterminate": return "indeterminate";
  }
}

function calculate(operator: "add" | "sub" | "mul", left: ControlValue, right: ControlValue): Int64Value | DecimalValue {
  if (isInt64(left) && isInt64(right)) {
    const leftValue = parseInt64(left.value);
    const rightValue = parseInt64(right.value);
    const result = operator === "add" ? leftValue + rightValue : operator === "sub" ? leftValue - rightValue : leftValue * rightValue;
    if (result < INT64_MIN || result > INT64_MAX) fail("arithmetic-overflow", "int64 arithmetic overflow.");
    return int64(result.toString());
  }
  if (isDecimal(left) && isDecimal(right)) return decimalOperation(operator, left.value, right.value);
  fail("arithmetic-type", "Arithmetic requires operands of the same numeric type.");
}

function decimalOperation(operator: "add" | "sub" | "mul", left: string, right: string): DecimalValue {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (operator === "mul") return decimal(formatDecimal(leftParts.coefficient * rightParts.coefficient, leftParts.scale + rightParts.scale));
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftCoefficient = leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale);
  const rightCoefficient = rightParts.coefficient * 10n ** BigInt(scale - rightParts.scale);
  return decimal(formatDecimal(operator === "add" ? leftCoefficient + rightCoefficient : leftCoefficient - rightCoefficient, scale));
}

function compareExact(left: ControlValue, right: ControlValue): number {
  const leftKind = valueKind(left);
  const rightKind = valueKind(right);
  if (leftKind !== rightKind) fail("comparison-type", "Exact comparison requires matching value types.");
  if (left === null && right === null) return 0;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right ? 0 : left ? 1 : -1;
  if (typeof left === "string" && typeof right === "string") return compareNfc(left, right);
  if (isInt64(left) && isInt64(right)) return compareBigInt(parseInt64(left.value), parseInt64(right.value));
  if (isDecimal(left) && isDecimal(right)) {
    const difference = decimalOperation("sub", left.value, right.value).value;
    return difference === "0" ? 0 : difference.startsWith("-") ? -1 : 1;
  }
  fail("comparison-value", "Objects and arrays do not support exact ordering.");
}

function valueKind(value: ControlValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isInt64(value)) return "int64";
  if (isDecimal(value)) return "decimal";
  return typeof value;
}

function normalizeValue(value: ControlValue): ControlValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (isInt64(value)) return int64(value.value);
  if (isDecimal(value)) return decimal(value.value);
  if (Array.isArray(value)) return deepFreeze(value.map(normalizeValue));
  if (isValueRecord(value)) {
    const normalized: Record<string, ControlValue> = {};
    for (const key of Object.keys(value).sort(compareNfc)) {
      const normalizedKey = key.normalize("NFC");
      if (Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) fail("expression-object-key", "Object keys must be unique after NFC normalization.");
      normalized[normalizedKey] = normalizeValue(value[key]);
    }
    return deepFreeze(normalized);
  }
  fail("expression-value", "Expression contains an unsupported value.");
}

function parseInt64(value: string): bigint {
  if (!INT64_PATTERN.test(value)) fail("int64", "Invalid canonical int64 value.");
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX) fail("int64", "int64 value is outside the signed 64-bit range.");
  return parsed;
}

function normalizeDecimal(value: string): string {
  if (!DECIMAL_PATTERN.test(value)) fail("decimal", "Invalid decimal value.");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normalized = trimmed ? `${integer}.${trimmed}` : integer;
  return normalized === "0" ? "0" : negative ? `-${normalized}` : normalized;
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const normalized = normalizeDecimal(value);
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${value}` : value;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function requireBoolean(value: ControlValue): boolean {
  if (typeof value !== "boolean") fail("expression-boolean", "Boolean expression requires boolean operands.");
  return value;
}

function isInt64(value: ControlValue): value is Int64Value {
  if (Array.isArray(value) || typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.type === "int64" && typeof record.value === "string";
}

function isDecimal(value: ControlValue): value is DecimalValue {
  if (Array.isArray(value) || typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.type === "decimal" && typeof record.value === "string";
}

function isValueRecord(value: ControlValue): value is Readonly<Record<string, ControlValue>> {
  return !Array.isArray(value) && typeof value === "object" && value !== null && !isInt64(value) && !isDecimal(value);
}

function normalizeEvidence(evidence: readonly EvidenceCitation[]): readonly EvidenceCitation[] {
  const normalized = evidence.map(citation => {
    requireIdentity(citation.evidenceId, "gate-evidence");
    if (!DIGEST.test(citation.digest)) fail("gate-evidence", "Evidence citation requires an exact digest.");
    return { evidenceId: citation.evidenceId, digest: citation.digest };
  }).sort((left, right) => compareNfc(left.evidenceId, right.evidenceId) || compareNfc(left.digest, right.digest));
  if (new Set(normalized.map(citation => citation.evidenceId)).size !== normalized.length) fail("gate-evidence", "Evidence IDs must be unique.");
  return deepFreeze(normalized);
}

function validateTuple(tuple: VersionTuple): void {
  for (const identity of [tuple.runId, tuple.nodeId, tuple.attemptId, tuple.definitionVersionId]) requireIdentity(identity, "gate-tuple");
  for (const version of [tuple.runVersion, tuple.nodeVersion, tuple.attemptVersion]) {
    if (!Number.isSafeInteger(version) || version < 1) fail("gate-tuple", "Gate version tuple requires positive versions.");
  }
}

function sortedUnique(values: readonly string[], code: string): readonly string[] {
  const normalized = values.map(value => {
    requireIdentity(value, code);
    return value.normalize("NFC");
  }).sort(compareNfc);
  if (new Set(normalized).size !== normalized.length) fail(code, "Values must be unique after NFC normalization.");
  return deepFreeze(normalized);
}

function requireIdentity(value: string, code: string): void {
  if (!value.normalize("NFC").trim()) fail(code, "Identity is required.");
}

function requireCommand(command: Readonly<{ commandId: string; fingerprint: string }>): void {
  requireIdentity(command.commandId, "command");
  requireIdentity(command.fingerprint, "command");
}

function checkCommandVersion(version: number, command: ControlCommand): void {
  requireCommand(command);
  if (command.expectedVersion !== version) fail("command-stale", "Command expected version does not match.");
}

function replayReceipt(receipts: readonly ControlReceipt[], command: ControlCommand): ControlReceipt | undefined {
  const receipt = receipts.find(candidate => candidate.commandId === command.commandId);
  if (receipt && receipt.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was reused with another fingerprint.");
  return receipt;
}

function makeReceipt(command: ControlCommand, operation: string, version: number): ControlReceipt {
  return deepFreeze({ commandId: command.commandId, fingerprint: command.fingerprint, operation, version });
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function fail(code: string, message: string): never {
  throw new WorkflowControlError(code, message);
}
