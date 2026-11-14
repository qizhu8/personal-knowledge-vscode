import { createHash } from "node:crypto";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";

export const workflowExecutorAdapterKey = "pkm.step.native/v1:fixture";
export const workflowExecutorContractDigest = createHash("sha256").update("fixture outputs number-v1").digest("hex");
export function workflowExecutorNode(nodeId, dependsOn = [], extra = {}) {
  return { nodeId, kind: "pkm.step.native/v1", config: { operation: "fixture", arguments: {} }, dependsOn, ...extra };
}
export function workflowExecutorFixture(nodes, requiredNodes = [nodes.at(-1).nodeId]) {
  const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes, completion: { requiredNodes } } };
  const compiled = compileWorkflowDefinitionV1(definition);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return { definition, executableDigest: compiled.executableDigest };
}
export function workflowExecutorSyntheticAdapter(execute = async invocation => ({
  status: "succeeded", outputs: { value: invocation.iteration + 1 },
})) {
  return {
    id: "fixture-native", version: 1, outputContractDigest: workflowExecutorContractDigest, execute,
    authorizationDigest: createHash("sha256").update("explicit synthetic inline policy-v1").digest("hex"),
    authorizeDefinition: binding => binding.source.kind === "inline"
      && binding.node.kind === "pkm.step.native/v1" && binding.node.config.operation === "fixture",
    validateOutput: outputs => Object.keys(outputs).length === 1 && Number.isSafeInteger(outputs.value),
  };
}
export const workflowExecutorDAGFixture = workflowExecutorFixture([
  workflowExecutorNode("first"),
  workflowExecutorNode("second", [{ from: "first", accept: ["succeeded"], required: true }]),
]);
