import { createHash } from "node:crypto";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { HUMAN_GATE_NODE_KIND, type WorkflowNodeV1 } from "./domain/project-recipes-workflow-contracts.js";
import type { WorkflowInvocation, WorkflowStepAdapter } from "./workflow-executor.js";

type Pending = { invocation: Readonly<WorkflowInvocation>; complete(result: unknown): void };
export const legacyExternalReportOutcomes = (node: WorkflowNodeV1) =>
  node.control?.mode === "branch" ? [...new Set([...node.control.cases, "failed"])] : ["succeeded", "failed"];

/** External callers do the work under their own permissions; this adapter only records their explicit report. */
export class LegacyRecipeExternalReports {
  readonly adapter: WorkflowStepAdapter;
  private readonly pending = new Map<string, Pending>();
  private readonly allowStaticBranches: boolean;
  private readonly allowPortedNoops: boolean;
  private readonly allowHumanGates: boolean;
  constructor(options: {
    id: string; authorizationDigest: string;
    staticBranches?: boolean;
    portedNoops?: boolean;
    humanGates?: boolean;
    authorizeDefinition: WorkflowStepAdapter["authorizeDefinition"];
    authorizeData?: WorkflowStepAdapter["authorizeData"];
  }) {
    this.allowStaticBranches = options.staticBranches === true;
    this.allowPortedNoops = options.portedNoops === true;
    this.allowHumanGates = options.humanGates === true;
    const allowed: WorkflowStepAdapter["authorizeDefinition"] = binding =>
      this.supportsNode(binding.node)
      && options.authorizeDefinition(binding) === true;
    this.adapter = {
      id: options.id, version: 1, authorizationDigest: options.authorizationDigest,
      outputContractDigest: createHash("sha256").update(JSON.stringify({
        contract: "pkm.external-recipe-reported-result/v1",
        staticBranches: this.allowStaticBranches,
        portedNoops: this.allowPortedNoops,
        humanGates: this.allowHumanGates,
        legacyInputSemantics: "run-inputs-only/v1",
      })).digest("hex"),
      authorizeDefinition: allowed,
      authorizeData: binding => allowed(binding) && (!options.authorizeData || options.authorizeData(binding) === true),
      validateOutput: outputs => Object.hasOwn(outputs, "result") && typeof outputs.reportedError === "string"
        && Object.keys(outputs).every(key => key === "result" || key === "reportedError")
        || (this.allowPortedNoops || this.allowHumanGates)
          && Object.keys(outputs).every(key => /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)),
      execute: (invocation, { signal }) => new Promise(resolve => {
        const key = this.key(invocation.runId, invocation.node.nodeId);
        if (signal.aborted || this.pending.has(key)) { resolve(undefined); return; }
        const abort = () => { this.pending.delete(key); resolve(undefined); };
        this.pending.set(key, { invocation, complete: result => {
          this.pending.delete(key); signal.removeEventListener("abort", abort); resolve(result);
        } });
        signal.addEventListener("abort", abort, { once: true });
      }),
    };
  }
  staticBranchesEnabled() { return this.allowStaticBranches; }
  portedNoopsEnabled() { return this.allowPortedNoops; }
  humanGatesEnabled() { return this.allowHumanGates; }
  supportsNode(node: WorkflowNodeV1) {
    if (node.kind === HUMAN_GATE_NODE_KIND)
      return this.humanGatesEnabled() && (!node.control || node.control.mode === "single")
        && !node.dependsOn.some(edge => edge.loop);
    if (node.kind !== "pkm.step.noop/v1" || node.control?.mode === "repeat") return false;
    if (node.ports && !this.portedNoopsEnabled()) return false;
    if (node.control?.mode === "branch" && (!this.staticBranchesEnabled() || node.control.dynamicCases)) return false;
    return !node.control || node.control.mode === "single"
      || node.control.mode === "branch" && this.staticBranchesEnabled() && !node.control.dynamicCases;
  }
  private key(runId: string, nodeId: string) { return `${runId}\0${nodeId}`; }
  private reportOutputs(node: WorkflowNodeV1, outcome: string, result: unknown, error: string) {
    if (!node.ports) return { result, reportedError: error };
    if (outcome === "failed") return {};
    if (result === null || typeof result !== "object" || Array.isArray(result))
      throw new Error("A ported node report result must be an object with exactly its declared output ports.");
    const expected = [...node.ports.outputs].sort();
    const actual = Object.keys(result).sort();
    if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index]))
      throw new Error("A ported node report result must contain exactly its declared output ports.");
    return result as Record<string, unknown>;
  }
  preview(runId: string, nodeId: string) {
    const pending = this.pending.get(this.key(runId, nodeId));
    if (!pending || pending.invocation.deadline <= Date.now())
      throw new Error("Only the currently claimed running node can report an outcome.");
    return { invocationId: pending.invocation.invocationId, deadline: pending.invocation.deadline,
      proofDigest: createHash("sha256").update(canonicalJson(pending.invocation.lease)).digest("hex"),
      executionAuthority: false, resultAuthority: "external-caller-reported" };
  }
  validate(runId: string, nodeId: string, outcome: string, result: unknown, error: string) {
    this.preview(runId, nodeId);
    const pending = this.pending.get(this.key(runId, nodeId))!;
    if (pending.invocation.node.kind === HUMAN_GATE_NODE_KIND)
      throw new Error("Human gate input cannot be replaced by an ordinary Recipe report.");
    if (!legacyExternalReportOutcomes(pending.invocation.node).includes(outcome))
      throw new Error("outcome is not accepted by the claimed node.");
    if (pending.invocation.legacyRunInputs) return outcome === "failed" ? {} : { result, reportedError: error };
    return this.reportOutputs(pending.invocation.node, outcome, result, error);
  }
  submit(runId: string, nodeId: string, outcome: string, result: unknown, error: string) {
    const outputs = this.validate(runId, nodeId, outcome, result, error);
    const pending = this.pending.get(this.key(runId, nodeId))!;
    const node = pending.invocation.node;
    pending.complete({
      status: outcome === "failed" ? "failed" : "succeeded",
      ...(node.control?.mode === "branch" && outcome !== "failed" ? { branch: outcome } : {}),
      outputs,
    });
  }
  validateHumanInput(runId: string, nodeId: string, response: unknown, nodeOverride?: WorkflowNodeV1) {
    const pending = this.pending.get(this.key(runId, nodeId));
    if (!this.humanGatesEnabled()) throw new Error("Human gate input is not enabled.");
    if (pending && (pending.invocation.node.kind !== HUMAN_GATE_NODE_KIND || pending.invocation.deadline <= Date.now()))
      throw new Error("Only the currently claimed human gate can accept user input.");
    const node = pending?.invocation.node ?? nodeOverride;
    if (!node || node.kind !== HUMAN_GATE_NODE_KIND || node.nodeId !== nodeId)
      throw new Error("Only the currently waiting human gate can accept user input.");
    if (response === null || typeof response !== "object" || Array.isArray(response)
      || Object.getPrototypeOf(response) !== Object.prototype)
      throw new Error("Human gate response must be a JSON object.");
    const config = node.config;
    let outcome: string;
    if (config.inputKind === "approval") {
      if (typeof (response as { approved?: unknown }).approved !== "boolean")
        throw new Error("Approval input requires an explicit boolean approved value.");
      outcome = (response as { approved: boolean }).approved ? "approved" : "rejected";
    } else if (config.inputKind === "text") {
      if (typeof (response as { text?: unknown }).text !== "string"
        || !(response as { text: string }).text.trim())
        throw new Error("Text input requires a non-empty text value.");
      outcome = "succeeded";
    } else {
      if (typeof (response as { choice?: unknown }).choice !== "string"
        || !config.choices?.includes((response as { choice: string }).choice))
        throw new Error("Choice input must select exactly one configured choice.");
      outcome = (response as { choice: string }).choice;
    }
    const ports = node.ports?.outputs;
    let outputs: Record<string, unknown> = { result: response };
    if (ports) {
      outputs = Object.create(null);
      for (const port of ports) {
        if (port === "result") outputs[port] = response;
        else if (config.inputKind === "text" && (port === "text" || port === "response"))
          outputs[port] = (response as { text: string }).text;
        else if (port === "approved" || port === "rejected" || config.choices?.includes(port))
          outputs[port] = port === outcome;
        else throw new Error(`Human gate output port is not supported: ${port}.`);
      }
    }
    return { outcome, response: structuredClone(response), outputs };
  }
  submitHumanInput(runId: string, nodeId: string, input: ReturnType<LegacyRecipeExternalReports["validateHumanInput"]>) {
    const pending = this.pending.get(this.key(runId, nodeId));
    if (!pending || pending.invocation.node.kind !== HUMAN_GATE_NODE_KIND)
      throw new Error("Only the currently claimed human gate can accept user input.");
    pending.complete({
      status: "succeeded",
      ...(input.outcome === "succeeded" ? {} : { branch: input.outcome }),
      outputs: input.outputs,
    });
  }
}
