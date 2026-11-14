import { HUMAN_GATE_NODE_KIND, type WorkflowDefinitionV1, type WorkflowNodeV1 } from "./project-recipes-workflow-contracts.js";
import type { WorkflowStepResult } from "../workflow-executor-contracts.js";
import { WORKFLOW_EXECUTOR_LIMITS as L } from "../workflow-executor-contracts.js";

export type StepState = "pending" | "offered" | "claimed" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "unknown";
export type RunState = "ready" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type Step = {
  nodeId: string; state: StepState; iteration: number;
  effect: "not-started" | "known" | "unknown"; outputs: Record<string, unknown>;
  branch?: string; assignmentId?: string;
};
export const terminalStep = (step: Step) => ["succeeded", "failed", "skipped", "cancelled", "unknown"].includes(step.state);
export function adapterKey(node: WorkflowNodeV1): string {
  return node.kind === "pkm.step.native/v1" ? `${node.kind}:${node.config.operation}` : node.kind;
}
export function assertSupportedControls(definition: WorkflowDefinitionV1): void {
  if (definition.spec.trigger) throw new Error("Cron dispatch is not qualified.");
  if (Object.keys(definition.spec.outputs).length) throw new Error("Run output mapping is not qualified; consume authoritative node outputs.");
  let bound = 0;
  for (const node of definition.spec.nodes) {
    if (node.kind === "pkm.subflow/v1") throw new Error("Subflow execution is not qualified.");
    if (node.control?.mode === "repeat" && node.control.count.kind !== "fixed") throw new Error("Dynamic repeat is not qualified.");
    if (node.control?.mode === "branch" && node.control.dynamicCases) throw new Error("Dynamic branch cases are not qualified.");
    const loops = node.dependsOn.filter(edge => edge.loop);
    if (loops.length > 1 || loops.some(edge => edge.from !== node.nodeId || edge.fromOutput || edge.toInput)) {
      throw new Error("Only one bounded self-loop without port remapping is qualified.");
    }
    if (loops.length && node.control && node.control.mode !== "single") throw new Error("Combined loop/control modes are not qualified.");
    const iterations = loops[0]?.loop?.termination.maxIterations
      ?? (node.control?.mode === "repeat" && node.control.count.kind === "fixed" ? node.control.count.value : 1);
    if (iterations > L.iterations) throw new Error("Iteration bound exceeded.");
    bound += iterations;
    for (const edge of node.dependsOn) {
      if (!!edge.fromOutput !== !!edge.toInput) throw new Error("Both dependency port names are required.");
    }
    const targetInputs = node.dependsOn.flatMap(edge => edge.toInput ? [edge.toInput] : []);
    if (new Set(targetInputs).size !== targetInputs.length) throw new Error("Duplicate dependency input authority.");
  }
  if (bound > L.steps) throw new Error("Step bound exceeded.");
}
export function dependencyState(node: WorkflowNodeV1, steps: Step[]): "ready" | "waiting" | "blocked" {
  let waiting = false;
  for (const edge of node.dependsOn.filter(edge => !edge.loop)) {
    const from = steps.find(step => step.nodeId === edge.from)!;
    if (!terminalStep(from)) { waiting = true; continue; }
    if (!edge.accept.includes(from.branch ?? from.state)) return "blocked";
  }
  return waiting ? "waiting" : "ready";
}
export function acceptStepResult(node: WorkflowNodeV1, step: Step, result: WorkflowStepResult): void {
  if (result.status !== "succeeded" && result.branch !== undefined) throw new Error("Only success may select a branch.");
  const outcomes = node.control?.mode === "branch" ? node.control.cases
    : node.kind === HUMAN_GATE_NODE_KIND
      ? node.config.inputKind === "approval" ? ["approved", "rejected"]
        : node.config.inputKind === "choice" ? node.config.choices ?? [] : []
      : [];
  if (result.branch !== undefined && !outcomes.includes(result.branch)) {
    throw new Error("Adapter supplied an undeclared branch.");
  }
  if (result.status === "succeeded" && node.control?.mode === "branch" && result.branch === undefined) {
    throw new Error("Branch adapter must select a declared case.");
  }
  if (result.status === "succeeded" && node.kind === HUMAN_GATE_NODE_KIND
    && node.config.inputKind !== "text" && result.branch === undefined) {
    throw new Error("Human gate adapter must record its submitted outcome.");
  }
  const loop = node.dependsOn.find(edge => edge.loop)?.loop;
  if (result.status === "succeeded" && loop && result.termination?.[loop.termination.condition] === undefined) {
    throw new Error("Loop adapter omitted the pinned termination verdict.");
  }
  step.outputs = result.status === "unknown" ? {} : result.outputs;
  step.effect = result.status === "unknown" ? "unknown" : "known";
  if (result.branch === undefined) delete step.branch;
  else step.branch = result.branch;
  step.iteration++;
  step.state = result.status;
  if (result.status !== "succeeded") return;
  if (node.control?.mode === "repeat" && node.control.count.kind === "fixed" && step.iteration < node.control.count.value) {
    step.state = "pending";
  }
  if (loop && result.termination![loop.termination.condition] !== true) {
    step.state = step.iteration < loop.termination.maxIterations ? "pending" : "failed";
  }
}
export function settle(definition: WorkflowDefinitionV1, steps: Step[]): RunState {
  for (let pass = 0; pass <= steps.length; pass++) {
    let changed = false;
    for (const node of definition.spec.nodes) {
      const step = steps.find(item => item.nodeId === node.nodeId)!;
      if (step.state === "pending" && dependencyState(node, steps) === "blocked") {
        step.state = "skipped"; changed = true;
      }
    }
    if (!changed) break;
  }
  if (steps.some(step => step.state === "unknown")) return "unknown";
  if (!steps.every(terminalStep)) return "running";
  return definition.spec.completion.requiredNodes.every(id => steps.find(step => step.nodeId === id)!.state === "succeeded")
    ? "succeeded" : "failed";
}
