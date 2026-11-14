"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

exports.create = ({ extension, root, fixture }) => {
  assert(require("node:fs").existsSync(path.join(fixture, "native-ui-fixture-token")));
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: { seed: { type: "string", required: true, nullable: false, schema: {} } },
    nodes: [
      { nodeId: "inspect", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
        ports: { inputs: ["seed"], outputs: ["token", "valid", "invalid"] },
        control: { mode: "branch", kind: "switch", cases: ["valid", "invalid"] } },
      { nodeId: "record-valid", kind: "pkm.step.noop/v1", config: {},
        ports: { inputs: ["incoming"], outputs: ["checked"] },
        dependsOn: [{ from: "inspect", fromOutput: "token", toInput: "incoming", accept: ["valid"], required: true }] },
      { nodeId: "record-invalid", kind: "pkm.step.noop/v1", config: {},
        ports: { inputs: ["incoming"], outputs: ["repaired"] },
        dependsOn: [{ from: "inspect", fromOutput: "token", toInput: "incoming", accept: ["invalid"], required: true }] },
      { nodeId: "join", kind: "pkm.step.noop/v1", config: {}, dependsOn: [
        { from: "inspect", accept: ["valid", "invalid"], required: true },
        { from: "record-valid", accept: ["succeeded", "skipped"], required: true },
        { from: "record-invalid", accept: ["succeeded", "skipped"], required: true },
      ] },
    ],
    outputs: {}, completion: { requiredNodes: ["join"] },
  } };
  const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
  const store = new ProjectStore(path.join(root, ".pkm/state"));
  const command = () => ({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: store.list().storeVersion });
  const created = store.createRecipe(command(), { kind: "global" }, "SATURN ported branch fixture", "Synthetic");
  store.updateRecipe(command(), created.entityId, { name: "SATURN ported branch fixture", category: "Synthetic",
    description: "Synthetic external report with branch, mapped ports, and join; no autonomous execution.", definition });
  const recipe = store.list().recipes.find(row => row.recipeId === created.entityId);
  const evidence = { recipe };
  require("node:fs").writeFileSync(path.join(fixture, "ported-branch-source.json"), JSON.stringify(evidence),
    { flag: "wx", mode: 0o600 });
  return evidence;
};
