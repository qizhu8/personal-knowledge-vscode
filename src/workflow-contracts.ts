import { createHash } from "crypto";
import { WorkflowPortDescriptor, WorkflowValueError, normalizePortDescriptor } from "./workflows/value-contracts";

export const WORKFLOW_DEFINITION_SCHEMA = "pkm.workflow.definition/v1" as const;
export const NOOP_NODE_KIND = "pkm.step.noop/v1" as const;
export const COMMAND_NODE_KIND = "pkm.step.command/v1" as const;
export const SCRIPT_NODE_KIND = "pkm.step.script/v1" as const;
export const HUMAN_GATE_NODE_KIND = "pkm.gate.human/v1" as const;
export const SUBFLOW_NODE_KIND = "pkm.subflow/v1" as const;

export interface WorkflowDependencyV1 {
  from: string;
  accept: string[];
  required: true;
  fromOutput?: string;
  toInput?: string;
  loop?: { termination: { condition: string; maxIterations: number } };
}

export interface WorkflowNodePortsV1 {
  inputs: string[];
  outputs: string[];
}

export type WorkflowNodeControlV1 =
  | { mode: "single" }
  | { mode: "repeat"; count: { kind: "fixed"; value: number } | { kind: "dynamic" } }
  | { mode: "branch"; kind: "if" | "switch"; cases: string[]; dynamicCases?: true };

export interface WorkflowCronTriggerV1 {
  kind: "cron";
  expression: string;
  timezone: string;
}

interface WorkflowNodeBaseV1 {
  nodeId: string;
  generalInstruction?: string;
  dependsOn: WorkflowDependencyV1[];
  ports?: WorkflowNodePortsV1;
  control?: WorkflowNodeControlV1;
}

export interface WorkflowNoopNodeV1 extends WorkflowNodeBaseV1 {
  kind: typeof NOOP_NODE_KIND;
  config: Record<string, never>;
}

export interface WorkflowCommandNodeV1 extends WorkflowNodeBaseV1 {
  kind: typeof COMMAND_NODE_KIND;
  config: {
    program: string;
    args: string[];
    timeoutSeconds: number;
    maxOutputBytes: number;
    cwd?: string;
  };
}

export interface WorkflowScriptNodeV1 extends WorkflowNodeBaseV1 {
  kind: typeof SCRIPT_NODE_KIND;
  config: {
    runtime: "bash" | "powershell" | "python";
    script: string;
    environmentId?: string;
    timeoutSeconds: number;
    maxOutputBytes: number;
    cwd?: string;
  };
}

export interface WorkflowHumanGateNodeV1 extends WorkflowNodeBaseV1 {
  kind: typeof HUMAN_GATE_NODE_KIND;
  config: {
    prompt: string;
    inputKind: "approval" | "text" | "choice";
    choices?: string[];
  };
}

export interface WorkflowSubflowNodeV1 extends WorkflowNodeBaseV1 {
  kind: typeof SUBFLOW_NODE_KIND;
  config: { recipeId: string; revision: number; executableDigest: string };
}

export type WorkflowNodeV1 = WorkflowNoopNodeV1 | WorkflowCommandNodeV1 | WorkflowScriptNodeV1 | WorkflowHumanGateNodeV1 | WorkflowSubflowNodeV1;

export interface WorkflowDefinitionV1 {
  schema: typeof WORKFLOW_DEFINITION_SCHEMA;
  spec: {
    inputs: Record<string, WorkflowPortDescriptor>;
    nodes: WorkflowNodeV1[];
    outputs: Record<string, WorkflowPortDescriptor>;
    completion: { requiredNodes: string[] };
    trigger?: WorkflowCronTriggerV1;
  };
}

export interface WorkflowDiagnostic {
  phase: "P3" | "P5";
  code: string;
  severity: "error";
  pointer: string;
  details: Record<string, unknown>;
  messageTemplateId: string;
  remediationClass: "author" | "registry";
}

export type WorkflowCompileResult =
  | { ok: true; model: WorkflowDefinitionV1; canonicalBytes: Buffer; executableDigest: string; diagnostics: [] }
  | { ok: false; diagnostics: WorkflowDiagnostic[] };

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, pointer: string, details: Record<string, unknown>, messageTemplateId: string, remediationClass: "author" | "registry", phase: "P3" | "P5" = "P3"): WorkflowDiagnostic {
  return { phase, code, severity: "error", pointer, details, messageTemplateId, remediationClass };
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], pointer: string, diagnostics: WorkflowDiagnostic[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value).filter(key => !allowedKeys.has(key)).sort()) {
    diagnostics.push(diagnostic("E3001", `${pointer}/${escapePointer(key)}`, { key }, "workflow.schema.unknownField", "author"));
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left.normalize("NFC"), character => character.codePointAt(0)!);
  const b = Array.from(right.normalize("NFC"), character => character.codePointAt(0)!);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function validateIdentifier(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[]): value is string {
  if (typeof value !== "string" || value.normalize("NFC") !== value || !IDENTIFIER.test(value)) {
    diagnostics.push(diagnostic("E3002", pointer, { expected: "NFC workflow identifier" }, "workflow.schema.invalidIdentifier", "author"));
    return false;
  }
  return true;
}

function normalizeDependency(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[]): WorkflowDependencyV1 | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("E3003", pointer, { expected: "object" }, "workflow.schema.type", "author"));
    return undefined;
  }
  unexpectedKeys(value, ["from", "accept", "required", "fromOutput", "toInput", "loop"], pointer, diagnostics);
  const fromValid = validateIdentifier(value.from, `${pointer}/from`, diagnostics);
  const fromOutputValid = value.fromOutput === undefined || validateIdentifier(value.fromOutput, `${pointer}/fromOutput`, diagnostics);
  const toInputValid = value.toInput === undefined || validateIdentifier(value.toInput, `${pointer}/toInput`, diagnostics);
  const accept = value.accept === undefined ? ["succeeded"] : value.accept;
  if (!Array.isArray(accept) || !accept.length || accept.some(outcome => typeof outcome !== "string" || !outcome)) {
    diagnostics.push(diagnostic("E3004", `${pointer}/accept`, { expected: "non-empty unique outcome set" }, "workflow.schema.nonEmptySet", "author"));
    return undefined;
  }
  if (value.required !== undefined && value.required !== true) {
    diagnostics.push(diagnostic("E3005", `${pointer}/required`, { expected: true }, "workflow.schema.const", "author"));
  }
  const normalizedAccept = [...new Set(accept as string[])].sort(compareCodePoints);
  if (normalizedAccept.length !== accept.length) {
    diagnostics.push(diagnostic("E3006", `${pointer}/accept`, {}, "workflow.schema.duplicateSetKey", "author"));
  }
  let loop: WorkflowDependencyV1["loop"];
  if (value.loop !== undefined) {
    if (!isRecord(value.loop)) {
      diagnostics.push(diagnostic("E3003", `${pointer}/loop`, { expected: "object" }, "workflow.schema.type", "author"));
    } else {
      unexpectedKeys(value.loop, ["termination"], `${pointer}/loop`, diagnostics);
      if (!isRecord(value.loop.termination)) {
        diagnostics.push(diagnostic("E3003", `${pointer}/loop/termination`, { expected: "object" }, "workflow.schema.type", "author"));
      } else {
        unexpectedKeys(value.loop.termination, ["condition", "maxIterations"], `${pointer}/loop/termination`, diagnostics);
        const condition = typeof value.loop.termination.condition === "string" ? value.loop.termination.condition.trim() : "";
        const maxIterations = value.loop.termination.maxIterations;
        if (!condition) diagnostics.push(diagnostic("E3005", `${pointer}/loop/termination/condition`, { expected: "non-empty exit condition" }, "workflow.schema.const", "author"));
        if (!Number.isSafeInteger(maxIterations) || (maxIterations as number) < 1) diagnostics.push(diagnostic("E3005", `${pointer}/loop/termination/maxIterations`, { expected: "positive safe integer" }, "workflow.schema.const", "author"));
        if (condition && Number.isSafeInteger(maxIterations) && (maxIterations as number) > 0) loop = { termination: { condition, maxIterations: maxIterations as number } };
      }
    }
  }
  if (!fromValid || !fromOutputValid || !toInputValid) return undefined;
  return {
    from: value.from as string,
    accept: normalizedAccept,
    required: true,
    ...(value.fromOutput === undefined ? {} : { fromOutput: value.fromOutput as string }),
    ...(value.toInput === undefined ? {} : { toInput: value.toInput as string }),
    ...(loop ? { loop } : {})
  };
}

function normalizeIdentifiers(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[], allowEmpty: boolean): string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) {
    diagnostics.push(diagnostic("E3004", pointer, { expected: allowEmpty ? "unique identifier set" : "non-empty unique identifier set" }, "workflow.schema.nonEmptySet", "author"));
    return undefined;
  }
  const normalized = value.filter((item, index): item is string => validateIdentifier(item, `${pointer}/${index}`, diagnostics)).sort(compareCodePoints);
  if (new Set(normalized).size !== normalized.length) diagnostics.push(diagnostic("E3006", pointer, {}, "workflow.schema.duplicateSetKey", "author"));
  return [...new Set(normalized)];
}

function normalizeNodePorts(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[]): WorkflowNodePortsV1 | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("E3003", pointer, { expected: "object" }, "workflow.schema.type", "author"));
    return undefined;
  }
  unexpectedKeys(value, ["inputs", "outputs"], pointer, diagnostics);
  const inputs = normalizeIdentifiers(value.inputs, `${pointer}/inputs`, diagnostics, true);
  const outputs = normalizeIdentifiers(value.outputs, `${pointer}/outputs`, diagnostics, true);
  return inputs && outputs ? { inputs, outputs } : undefined;
}

function normalizeNodeControl(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[]): WorkflowNodeControlV1 | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("E3003", pointer, { expected: "object" }, "workflow.schema.type", "author"));
    return undefined;
  }
  if (value.mode === "single") {
    unexpectedKeys(value, ["mode"], pointer, diagnostics);
    return { mode: "single" };
  }
  if (value.mode === "repeat") {
    unexpectedKeys(value, ["mode", "count"], pointer, diagnostics);
    if (!isRecord(value.count)) {
      diagnostics.push(diagnostic("E3003", `${pointer}/count`, { expected: "object" }, "workflow.schema.type", "author"));
      return undefined;
    }
    if (value.count.kind === "dynamic") {
      unexpectedKeys(value.count, ["kind"], `${pointer}/count`, diagnostics);
      return { mode: "repeat", count: { kind: "dynamic" } };
    }
    unexpectedKeys(value.count, ["kind", "value"], `${pointer}/count`, diagnostics);
    if (value.count.kind !== "fixed" || !Number.isSafeInteger(value.count.value) || (value.count.value as number) < 1) {
      diagnostics.push(diagnostic("E3005", `${pointer}/count`, { expected: "fixed positive safe integer or dynamic" }, "workflow.schema.const", "author"));
      return undefined;
    }
    return { mode: "repeat", count: { kind: "fixed", value: value.count.value as number } };
  }
  if (value.mode === "branch") {
    unexpectedKeys(value, ["mode", "kind", "cases", "dynamicCases"], pointer, diagnostics);
    if (value.kind !== "if" && value.kind !== "switch") diagnostics.push(diagnostic("E3005", `${pointer}/kind`, { expected: "if or switch" }, "workflow.schema.const", "author"));
    if (value.dynamicCases !== undefined && value.dynamicCases !== true) diagnostics.push(diagnostic("E3005", `${pointer}/dynamicCases`, { expected: true }, "workflow.schema.const", "author"));
    const cases = normalizeIdentifiers(value.cases, `${pointer}/cases`, diagnostics, false);
    return (value.kind === "if" || value.kind === "switch") && cases
      ? { mode: "branch", kind: value.kind, cases, ...(value.dynamicCases === true ? { dynamicCases: true as const } : {}) }
      : undefined;
  }
  diagnostics.push(diagnostic("E3005", `${pointer}/mode`, { expected: "single, repeat, or branch" }, "workflow.schema.const", "author"));
  return undefined;
}

function normalizeNode(value: unknown, index: number, diagnostics: WorkflowDiagnostic[]): WorkflowNodeV1 | undefined {
  const pointer = `/spec/nodes/${index}`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("E3003", pointer, { expected: "object" }, "workflow.schema.type", "author"));
    return undefined;
  }
  unexpectedKeys(value, ["nodeId", "kind", "config", "generalInstruction", "dependsOn", "ports", "control"], pointer, diagnostics);
  const nodeIdValid = validateIdentifier(value.nodeId, `${pointer}/nodeId`, diagnostics);
  if (value.kind !== NOOP_NODE_KIND && value.kind !== COMMAND_NODE_KIND && value.kind !== SCRIPT_NODE_KIND
    && value.kind !== HUMAN_GATE_NODE_KIND && value.kind !== SUBFLOW_NODE_KIND) {
    diagnostics.push(diagnostic("E3101", `${pointer}/kind`, { kind: value.kind }, "workflow.registry.unknownNodeKind", "registry"));
  }
  let config: WorkflowNodeV1["config"] | undefined;
  if (value.kind === NOOP_NODE_KIND) {
    if (!isRecord(value.config) || Object.keys(value.config).length) diagnostics.push(diagnostic("E3007", `${pointer}/config`, { kind: NOOP_NODE_KIND }, "workflow.schema.noopConfig", "author"));
    config = {};
  } else if (value.kind === COMMAND_NODE_KIND) {
    if (!isRecord(value.config)) {
      diagnostics.push(diagnostic("E3003", `${pointer}/config`, { expected: "object" }, "workflow.schema.type", "author"));
    } else {
      unexpectedKeys(value.config, ["program", "args", "timeoutSeconds", "maxOutputBytes", "cwd"], `${pointer}/config`, diagnostics);
      const program = typeof value.config.program === "string" ? value.config.program.trim() : "";
      const args = value.config.args;
      const timeoutSeconds = value.config.timeoutSeconds === undefined ? 300 : value.config.timeoutSeconds;
      const maxOutputBytes = value.config.maxOutputBytes === undefined ? 65536 : value.config.maxOutputBytes;
      const cwd = value.config.cwd === undefined ? undefined
        : typeof value.config.cwd === "string" ? value.config.cwd.trim() : "";
      if (!program || /[\r\n\0]/.test(program)) diagnostics.push(diagnostic("E3005", `${pointer}/config/program`, { expected: "non-empty executable without control characters" }, "workflow.schema.const", "author"));
      if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || /[\0]/.test(argument))) diagnostics.push(diagnostic("E3003", `${pointer}/config/args`, { expected: "string array" }, "workflow.schema.type", "author"));
      if (!Number.isSafeInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > 3600) diagnostics.push(diagnostic("E3005", `${pointer}/config/timeoutSeconds`, { expected: "integer from 1 through 3600" }, "workflow.schema.const", "author"));
      if (!Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1024 || (maxOutputBytes as number) > 1048576) diagnostics.push(diagnostic("E3005", `${pointer}/config/maxOutputBytes`, { expected: "integer from 1024 through 1048576" }, "workflow.schema.const", "author"));
      if (value.config.cwd !== undefined && (!cwd || /[\r\n\0]/.test(cwd))) diagnostics.push(diagnostic("E3005", `${pointer}/config/cwd`, { expected: "non-empty path without control characters" }, "workflow.schema.const", "author"));
      if (program && Array.isArray(args) && args.every(argument => typeof argument === "string" && !/[\0]/.test(argument))
          && Number.isSafeInteger(timeoutSeconds) && (timeoutSeconds as number) >= 1 && (timeoutSeconds as number) <= 3600
          && Number.isSafeInteger(maxOutputBytes) && (maxOutputBytes as number) >= 1024 && (maxOutputBytes as number) <= 1048576
          && (value.config.cwd === undefined || Boolean(cwd))) {
        config = { program, args: args as string[], timeoutSeconds: timeoutSeconds as number,
          maxOutputBytes: maxOutputBytes as number, ...(cwd ? { cwd } : {}) };
      }
    }
  } else if (value.kind === SCRIPT_NODE_KIND) {
    if (!isRecord(value.config)) {
      diagnostics.push(diagnostic("E3003", `${pointer}/config`, { expected: "object" }, "workflow.schema.type", "author"));
    } else {
      unexpectedKeys(value.config, ["runtime", "script", "environmentId", "timeoutSeconds", "maxOutputBytes", "cwd"], `${pointer}/config`, diagnostics);
      const runtime = value.config.runtime;
      const script = typeof value.config.script === "string" ? value.config.script : "";
      const environmentId = typeof value.config.environmentId === "string" ? value.config.environmentId.trim() : "";
      const timeoutSeconds = value.config.timeoutSeconds === undefined ? 300 : value.config.timeoutSeconds;
      const maxOutputBytes = value.config.maxOutputBytes === undefined ? 65536 : value.config.maxOutputBytes;
      const cwd = value.config.cwd === undefined ? undefined
        : typeof value.config.cwd === "string" ? value.config.cwd.trim() : "";
      if (!(runtime === "bash" || runtime === "powershell" || runtime === "python")) diagnostics.push(diagnostic("E3005", `${pointer}/config/runtime`, { expected: "bash, powershell, or python" }, "workflow.schema.const", "author"));
      if (!script.trim() || script.includes("\0")) diagnostics.push(diagnostic("E3005", `${pointer}/config/script`, { expected: "non-empty script without null characters" }, "workflow.schema.const", "author"));
      if (runtime === "python" && !IDENTIFIER.test(environmentId)) diagnostics.push(diagnostic("E3005", `${pointer}/config/environmentId`, { expected: "PKM Environment ID required for Python" }, "workflow.schema.const", "author"));
      if (runtime !== "python" && value.config.environmentId !== undefined) diagnostics.push(diagnostic("E3005", `${pointer}/config/environmentId`, { expected: "environmentId only for Python" }, "workflow.schema.const", "author"));
      if (!Number.isSafeInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > 3600) diagnostics.push(diagnostic("E3005", `${pointer}/config/timeoutSeconds`, { expected: "integer from 1 through 3600" }, "workflow.schema.const", "author"));
      if (!Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1024 || (maxOutputBytes as number) > 1048576) diagnostics.push(diagnostic("E3005", `${pointer}/config/maxOutputBytes`, { expected: "integer from 1024 through 1048576" }, "workflow.schema.const", "author"));
      if (value.config.cwd !== undefined && (!cwd || /[\r\n\0]/.test(cwd))) diagnostics.push(diagnostic("E3005", `${pointer}/config/cwd`, { expected: "non-empty path without control characters" }, "workflow.schema.const", "author"));
      if ((runtime === "bash" || runtime === "powershell" || runtime === "python") && script.trim() && !script.includes("\0")
          && (runtime !== "python" || IDENTIFIER.test(environmentId))
          && (runtime === "python" || value.config.environmentId === undefined)
          && Number.isSafeInteger(timeoutSeconds) && (timeoutSeconds as number) >= 1 && (timeoutSeconds as number) <= 3600
          && Number.isSafeInteger(maxOutputBytes) && (maxOutputBytes as number) >= 1024 && (maxOutputBytes as number) <= 1048576
          && (value.config.cwd === undefined || Boolean(cwd))) {
        config = { runtime, script, ...(runtime === "python" ? { environmentId } : {}),
          timeoutSeconds: timeoutSeconds as number, maxOutputBytes: maxOutputBytes as number, ...(cwd ? { cwd } : {}) };
      }
    }
  } else if (value.kind === HUMAN_GATE_NODE_KIND) {
    if (!isRecord(value.config)) {
      diagnostics.push(diagnostic("E3003", `${pointer}/config`, { expected: "object" }, "workflow.schema.type", "author"));
    } else {
      unexpectedKeys(value.config, ["prompt", "inputKind", "choices"], `${pointer}/config`, diagnostics);
      const prompt = typeof value.config.prompt === "string" ? value.config.prompt.trim() : "";
      const inputKind = value.config.inputKind;
      const choices = value.config.choices;
      if (!prompt) diagnostics.push(diagnostic("E3005", `${pointer}/config/prompt`, { expected: "non-empty prompt" }, "workflow.schema.const", "author"));
      if (!(["approval", "text", "choice"] as unknown[]).includes(inputKind)) diagnostics.push(diagnostic("E3005", `${pointer}/config/inputKind`, { expected: "approval, text, or choice" }, "workflow.schema.const", "author"));
      if (inputKind === "choice" && (!Array.isArray(choices) || choices.length < 2 || choices.some(choice => typeof choice !== "string" || !choice.trim()) || new Set(choices).size !== choices.length)) diagnostics.push(diagnostic("E3004", `${pointer}/config/choices`, { expected: "at least two unique non-empty choices" }, "workflow.schema.nonEmptySet", "author"));
      if (inputKind !== "choice" && choices !== undefined) diagnostics.push(diagnostic("E3005", `${pointer}/config/choices`, { expected: "choices only for choice input" }, "workflow.schema.const", "author"));
      if (prompt && (["approval", "text", "choice"] as unknown[]).includes(inputKind)
          && (inputKind !== "choice" || (Array.isArray(choices) && choices.length >= 2 && choices.every(choice => typeof choice === "string" && choice.trim()) && new Set(choices).size === choices.length))) {
        config = { prompt, inputKind: inputKind as "approval" | "text" | "choice",
          ...(inputKind === "choice" ? { choices: choices as string[] } : {}) };
      }
    }
  } else if (value.kind === SUBFLOW_NODE_KIND) {
    if (!isRecord(value.config)) {
      diagnostics.push(diagnostic("E3003", `${pointer}/config`, { expected: "object" }, "workflow.schema.type", "author"));
    } else {
      unexpectedKeys(value.config, ["recipeId", "revision", "executableDigest"], `${pointer}/config`, diagnostics);
      const recipeIdValid = validateIdentifier(value.config.recipeId, `${pointer}/config/recipeId`, diagnostics);
      const revisionValid = Number.isSafeInteger(value.config.revision) && (value.config.revision as number) > 0;
      const digestValid = typeof value.config.executableDigest === "string" && /^[a-f0-9]{64}$/.test(value.config.executableDigest);
      if (!revisionValid) diagnostics.push(diagnostic("E3005", `${pointer}/config/revision`, { expected: "positive safe integer" }, "workflow.schema.const", "author"));
      if (!digestValid) diagnostics.push(diagnostic("E3005", `${pointer}/config/executableDigest`, { expected: "SHA-256 hex digest" }, "workflow.schema.const", "author"));
      if (recipeIdValid && revisionValid && digestValid) config = {
        recipeId: value.config.recipeId as string,
        revision: value.config.revision as number,
        executableDigest: value.config.executableDigest as string
      };
    }
  } else if (!isRecord(value.config) || Object.keys(value.config).length) {
    diagnostics.push(diagnostic("E3007", `${pointer}/config`, { kind: value.kind }, "workflow.schema.noopConfig", "author"));
  }
  if (!Array.isArray(value.dependsOn)) {
    diagnostics.push(diagnostic("E3003", `${pointer}/dependsOn`, { expected: "array" }, "workflow.schema.type", "author"));
  }
  let generalInstruction: string | undefined;
  if (value.generalInstruction !== undefined) {
    if (typeof value.generalInstruction !== "string") {
      diagnostics.push(diagnostic("E3003", `${pointer}/generalInstruction`, { expected: "string" }, "workflow.schema.type", "author"));
    } else if (!value.generalInstruction.trim()) {
      diagnostics.push(diagnostic("E3005", `${pointer}/generalInstruction`, { expected: "non-empty instruction" }, "workflow.schema.const", "author"));
    } else {
      generalInstruction = value.generalInstruction.trim();
    }
  }
  const dependencies = Array.isArray(value.dependsOn)
    ? value.dependsOn.map((dependency, dependencyIndex) => normalizeDependency(dependency, `${pointer}/dependsOn/${dependencyIndex}`, diagnostics)).filter((dependency): dependency is WorkflowDependencyV1 => Boolean(dependency))
    : [];
  dependencies.sort((left, right) => compareCodePoints(left.from, right.from)
    || compareCodePoints(left.fromOutput || "", right.fromOutput || "")
    || compareCodePoints(left.toInput || "", right.toInput || "")
    || compareCodePoints(canonicalJson(left.accept), canonicalJson(right.accept))
    || compareCodePoints(canonicalJson(left.loop || null), canonicalJson(right.loop || null)));
  const dependencyKeys = new Set<string>();
  for (const dependency of dependencies) {
    const key = canonicalJson([dependency.from, dependency.fromOutput || "", dependency.toInput || "", dependency.accept, dependency.loop || null]);
    if (dependencyKeys.has(key)) diagnostics.push(diagnostic("E3006", `${pointer}/dependsOn`, { key }, "workflow.schema.duplicateSetKey", "author"));
    dependencyKeys.add(key);
  }
  const ports = value.ports === undefined ? undefined : normalizeNodePorts(value.ports, `${pointer}/ports`, diagnostics);
  const control = value.control === undefined ? undefined : normalizeNodeControl(value.control, `${pointer}/control`, diagnostics);
  if (control?.mode === "branch" && ports && control.cases.some(caseId => !ports.outputs.includes(caseId))) {
    diagnostics.push(diagnostic("E3005", `${pointer}/control/cases`, { expected: "cases declared as output ports" }, "workflow.schema.const", "author"));
  }
  if (!nodeIdValid || !config || ![NOOP_NODE_KIND, COMMAND_NODE_KIND, SCRIPT_NODE_KIND, HUMAN_GATE_NODE_KIND, SUBFLOW_NODE_KIND].includes(value.kind as typeof NOOP_NODE_KIND)) return undefined;
  const base = {
    nodeId: value.nodeId as string,
    ...(generalInstruction ? { generalInstruction } : {}),
    dependsOn: dependencies,
    ...(ports ? { ports } : {}),
    ...(control ? { control } : {})
  };
  return value.kind === NOOP_NODE_KIND
    ? { ...base, kind: NOOP_NODE_KIND, config: config as Record<string, never> }
    : value.kind === COMMAND_NODE_KIND
      ? { ...base, kind: COMMAND_NODE_KIND, config: config as WorkflowCommandNodeV1["config"] }
      : value.kind === SCRIPT_NODE_KIND
        ? { ...base, kind: SCRIPT_NODE_KIND, config: config as WorkflowScriptNodeV1["config"] }
      : value.kind === HUMAN_GATE_NODE_KIND
        ? { ...base, kind: HUMAN_GATE_NODE_KIND, config: config as WorkflowHumanGateNodeV1["config"] }
    : { ...base, kind: SUBFLOW_NODE_KIND, config: config as WorkflowSubflowNodeV1["config"] };
}

function normalizePortMap(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[]): Record<string, WorkflowPortDescriptor> | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("E3003", pointer, { expected: "object" }, "workflow.schema.type", "author"));
    return undefined;
  }
  const result: Record<string, WorkflowPortDescriptor> = {};
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    if (!validateIdentifier(key, `${pointer}/${escapePointer(key)}`, diagnostics)) continue;
    try {
      result[key] = normalizePortDescriptor(value[key], `${pointer}/${escapePointer(key)}`);
    } catch (error) {
      if (!(error instanceof WorkflowValueError)) throw error;
      diagnostics.push(diagnostic("E3010", error.pointer, { reason: error.code }, "workflow.schema.invalidPort", "author"));
    }
  }
  return result;
}

function normalizeTrigger(value: unknown, pointer: string, diagnostics: WorkflowDiagnostic[]): WorkflowCronTriggerV1 | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("E3003", pointer, { expected: "object" }, "workflow.schema.type", "author"));
    return undefined;
  }
  unexpectedKeys(value, ["kind", "expression", "timezone"], pointer, diagnostics);
  if (value.kind !== "cron") diagnostics.push(diagnostic("E3005", `${pointer}/kind`, { expected: "cron" }, "workflow.schema.const", "author"));
  const expression = typeof value.expression === "string" ? value.expression.trim() : "";
  const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
  if (!expression || expression.split(/\s+/).length !== 5) diagnostics.push(diagnostic("E3005", `${pointer}/expression`, { expected: "five-field cron expression" }, "workflow.schema.const", "author"));
  if (!timezone) diagnostics.push(diagnostic("E3005", `${pointer}/timezone`, { expected: "IANA timezone or UTC" }, "workflow.schema.const", "author"));
  return value.kind === "cron" && expression.split(/\s+/).length === 5 && timezone ? { kind: "cron", expression, timezone } : undefined;
}

export function compileWorkflowDefinitionV1(input: unknown): WorkflowCompileResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  if (!isRecord(input)) return { ok: false, diagnostics: [diagnostic("E3003", "", { expected: "object" }, "workflow.schema.type", "author")] };
  unexpectedKeys(input, ["schema", "spec"], "", diagnostics);
  if (input.schema !== WORKFLOW_DEFINITION_SCHEMA) {
    diagnostics.push(diagnostic("E3008", "/schema", { expected: WORKFLOW_DEFINITION_SCHEMA }, "workflow.schema.unsupported", "author"));
  }
  if (!isRecord(input.spec)) {
    diagnostics.push(diagnostic("E3003", "/spec", { expected: "object" }, "workflow.schema.type", "author"));
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }
  unexpectedKeys(input.spec, ["inputs", "nodes", "outputs", "completion", "trigger"], "/spec", diagnostics);
  const inputs = normalizePortMap(input.spec.inputs, "/spec/inputs", diagnostics);
  const outputs = normalizePortMap(input.spec.outputs, "/spec/outputs", diagnostics);
  const trigger = input.spec.trigger === undefined ? undefined : normalizeTrigger(input.spec.trigger, "/spec/trigger", diagnostics);
  if (!Array.isArray(input.spec.nodes) || !input.spec.nodes.length) {
    diagnostics.push(diagnostic("E3004", "/spec/nodes", { expected: "non-empty node set" }, "workflow.schema.nonEmptySet", "author"));
  }
  const nodes = Array.isArray(input.spec.nodes)
    ? input.spec.nodes.map((node, index) => normalizeNode(node, index, diagnostics)).filter((node): node is WorkflowNodeV1 => Boolean(node))
    : [];
  nodes.sort((left, right) => compareCodePoints(left.nodeId, right.nodeId));
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.nodeId)) diagnostics.push(diagnostic("E3006", "/spec/nodes", { nodeId: node.nodeId }, "workflow.schema.duplicateSetKey", "author"));
    nodeIds.add(node.nodeId);
  }
  const completion = isRecord(input.spec.completion) ? input.spec.completion : undefined;
  if (!completion) diagnostics.push(diagnostic("E3003", "/spec/completion", { expected: "object" }, "workflow.schema.type", "author"));
  if (completion) unexpectedKeys(completion, ["requiredNodes"], "/spec/completion", diagnostics);
  const requiredNodes = completion && Array.isArray(completion.requiredNodes) ? completion.requiredNodes : [];
  if (!requiredNodes.length || requiredNodes.some(nodeId => typeof nodeId !== "string" || !nodeIds.has(nodeId))) {
    diagnostics.push(diagnostic("E3201", "/spec/completion/requiredNodes", {}, "workflow.graph.unknownRequiredNode", "author"));
  }
  const normalizedRequiredNodes = [...new Set(requiredNodes as string[])].sort(compareCodePoints);
  if (normalizedRequiredNodes.length !== requiredNodes.length) {
    diagnostics.push(diagnostic("E3006", "/spec/completion/requiredNodes", {}, "workflow.schema.duplicateSetKey", "author"));
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeIds.has(dependency.from)) {
        diagnostics.push(diagnostic("E3202", `/spec/nodes/${escapePointer(node.nodeId)}/dependsOn`, { from: dependency.from }, "workflow.graph.invalidDependency", "author"));
      }
      const source = nodes.find(candidate => candidate.nodeId === dependency.from);
      if (dependency.fromOutput && source?.ports && !source.ports.outputs.includes(dependency.fromOutput)) {
        diagnostics.push(diagnostic("E3202", `/spec/nodes/${escapePointer(node.nodeId)}/dependsOn`, { fromOutput: dependency.fromOutput }, "workflow.graph.invalidDependency", "author"));
      }
      if (dependency.toInput && node.ports && !node.ports.inputs.includes(dependency.toInput)) {
        diagnostics.push(diagnostic("E3202", `/spec/nodes/${escapePointer(node.nodeId)}/dependsOn`, { toInput: dependency.toInput }, "workflow.graph.invalidDependency", "author"));
      }
    }
  }
  const nonTerminatingNodes = nodes.map(node => ({ ...node, dependsOn: node.dependsOn.filter(dependency => !dependency.loop) }));
  for (const witness of canonicalCycleWitnesses(nonTerminatingNodes)) {
    const edges = witness.slice(0, -1).map((from, index) => {
      const to = witness[index + 1];
      const dependency = nonTerminatingNodes.find(node => node.nodeId === to)?.dependsOn.find(candidate => candidate.from === from);
      return {
        from,
        to,
        ...(dependency?.fromOutput ? { fromOutput: dependency.fromOutput } : {}),
        ...(dependency?.toInput ? { toInput: dependency.toInput } : {})
      };
    });
    const suggestedLoopEdge = edges[edges.length - 1];
    diagnostics.push(diagnostic("E3203", "/spec/nodes", {
      kind: "accidental-cycle",
      witness,
      cycle: witness.join(" → "),
      edges,
      suggestedLoopEdge,
      remediation: {
        action: "declare-terminating-loop-edge",
        requiredFields: ["loop.termination.condition", "loop.termination.maxIterations"]
      }
    }, "workflow.graph.cycle", "author"));
  }
  if (diagnostics.length) return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  const model: WorkflowDefinitionV1 = {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    spec: { inputs: inputs!, nodes, outputs: outputs!, completion: { requiredNodes: normalizedRequiredNodes }, ...(trigger ? { trigger } : {}) }
  };
  try {
    const canonicalBytes = Buffer.from(canonicalJson(model), "utf8");
    return { ok: true, model, canonicalBytes, executableDigest: createHash("sha256").update(canonicalBytes).digest("hex"), diagnostics: [] };
  } catch (error) {
    return { ok: false, diagnostics: [diagnostic("E4001", "", { reason: String(error) }, "workflow.canonical.invalidValue", "author", "P5")] };
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not canonical JSON values.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (/([\uD800-\uDBFF](?![\uDC00-\uDFFF]))|((?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(value)) throw new Error("Lone Unicode surrogate.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`Unsupported canonical JSON type: ${typeof value}`);
}

function sortDiagnostics(diagnostics: WorkflowDiagnostic[]): WorkflowDiagnostic[] {
  return diagnostics.sort((left, right) => compareCodePoints(left.phase, right.phase)
    || compareJsonPointers(left.pointer, right.pointer)
    || compareCodePoints(left.code, right.code)
    || compareCodePoints(canonicalJson(left.details), canonicalJson(right.details)));
}

function compareJsonPointers(left: string, right: string): number {
  const leftSegments = left.split("/").slice(1);
  const rightSegments = right.split("/").slice(1);
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    if (leftSegments[index] === undefined) return -1;
    if (rightSegments[index] === undefined) return 1;
    const leftIndex = /^(0|[1-9][0-9]*)$/.test(leftSegments[index]) ? Number(leftSegments[index]) : undefined;
    const rightIndex = /^(0|[1-9][0-9]*)$/.test(rightSegments[index]) ? Number(rightSegments[index]) : undefined;
    if (leftIndex !== undefined && rightIndex !== undefined && leftIndex !== rightIndex) return leftIndex - rightIndex;
    const comparison = compareCodePoints(leftSegments[index], rightSegments[index]);
    if (comparison) return comparison;
  }
  return 0;
}

function canonicalCycleWitnesses(nodes: WorkflowNodeV1[]): string[][] {
  const outgoing = new Map(nodes.map(node => [node.nodeId, [] as string[]]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (outgoing.has(dependency.from)) outgoing.get(dependency.from)!.push(node.nodeId);
    }
  }
  for (const targets of outgoing.values()) targets.sort(compareCodePoints);

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (nodeId: string): void => {
    indexes.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const target of outgoing.get(nodeId)!) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indexes.get(target)!));
      }
    }
    if (lowLinks.get(nodeId) !== indexes.get(nodeId)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    if (component.length > 1 || outgoing.get(component[0])!.includes(component[0])) components.push(component.sort(compareCodePoints));
  };
  for (const nodeId of [...outgoing.keys()].sort(compareCodePoints)) if (!indexes.has(nodeId)) visit(nodeId);
  components.sort((left, right) => compareCodePoints(left[0], right[0]));
  return components.map(component => shortestCycle(component, outgoing));
}

function shortestCycle(component: string[], outgoing: Map<string, string[]>): string[] {
  const members = new Set(component);
  let best: string[] | undefined;
  for (const start of component) {
    const queue: string[][] = outgoing.get(start)!.filter(nodeId => members.has(nodeId)).map(nodeId => [start, nodeId]);
    while (queue.length) {
      const path = queue.shift()!;
      const current = path[path.length - 1];
      if (current === start) {
        const candidate = canonicalizeCycle(path);
        if (!best || candidate.length < best.length || (candidate.length === best.length && compareStringArrays(candidate, best) < 0)) best = candidate;
        continue;
      }
      if (best && path.length + 1 > best.length) continue;
      for (const target of outgoing.get(current)!) {
        if (!members.has(target) || (target !== start && path.includes(target))) continue;
        queue.push([...path, target]);
      }
    }
  }
  return best!;
}

function canonicalizeCycle(cycle: string[]): string[] {
  const open = cycle.slice(0, -1);
  let smallestIndex = 0;
  for (let index = 1; index < open.length; index += 1) {
    if (compareCodePoints(open[index], open[smallestIndex]) < 0) smallestIndex = index;
  }
  const rotated = [...open.slice(smallestIndex), ...open.slice(0, smallestIndex)];
  return [...rotated, rotated[0]];
}

function compareStringArrays(left: string[], right: string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareCodePoints(left[index], right[index]);
    if (comparison) return comparison;
  }
  return 0;
}