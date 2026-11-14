"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const sha256 = value => createHash("sha256").update(value).digest("hex");
exports.create = ({ extension, root, fixture }) => {
  assert(fs.existsSync(path.join(fixture, "native-ui-fixture-token")));
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {
      source: { type: "string", required: true, nullable: false, schema: {} },
      expected_sha256: { type: "string", required: true, nullable: false, schema: {} },
    },
    nodes: [
      { nodeId: "inspect", kind: "pkm.step.noop/v1", config: {},
        ports: { inputs: ["source", "expected_sha256"], outputs: ["sha256", "branch", "valid", "invalid"] },
        control: { mode: "branch", kind: "switch", cases: ["valid", "invalid"] }, dependsOn: [] },
      { nodeId: "record-valid", kind: "pkm.step.noop/v1", config: {}, ports: { inputs: ["evidence"], outputs: ["artifact", "sha256"] },
        dependsOn: [{ from: "inspect", fromOutput: "sha256", toInput: "evidence", accept: ["valid"], required: true }] },
      { nodeId: "repair", kind: "pkm.step.noop/v1", config: {}, ports: { inputs: ["evidence"], outputs: ["artifact", "sha256"] },
        dependsOn: [{ from: "inspect", fromOutput: "sha256", toInput: "evidence", accept: ["invalid"], required: true }] },
      { nodeId: "finish", kind: "pkm.step.noop/v1", config: {},
        ports: { inputs: [], outputs: ["branch", "artifact", "sha256"] }, dependsOn: [
        { from: "inspect", accept: ["valid", "invalid"], required: true },
        { from: "record-valid", accept: ["succeeded", "skipped"], required: true },
        { from: "repair", accept: ["succeeded", "skipped"], required: true },
      ] },
    ], outputs: {}, completion: { requiredNodes: ["finish"] },
  } };
  const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
  const store = new ProjectStore(path.join(root, ".pkm/state"));
  const command = () => ({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: store.list().storeVersion });
  const created = store.createRecipe(command(), { kind: "global" }, "SATURN static evidence branch", "Synthetic");
  store.updateRecipe(command(), created.entityId, { name: "SATURN static evidence branch", category: "Synthetic",
    description: "External caller inspects real bytes, records or repairs exactly one path, then archives; no ports or automatic agent.", definition });
  const rows = store.list().recipes, recipe = rows.find(row => row.recipeId === created.entityId);
  const tutorial = rows.find(row => row.name === "PKM Tutorial");
  const payload = fs.readFileSync(path.join(fixture, "workspace/recipe-input.txt"));
  fs.writeFileSync(path.join(fixture, "workspace/branch-invalid.txt"), "corrupt synthetic content\n", { flag: "wx", mode: 0o600 });
  const evidence = { recipe, tutorialRecipeId: tutorial?.recipeId, expectedSha256: sha256(payload) };
  fs.writeFileSync(path.join(fixture, "static-branch-source.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
  return evidence;
};
exports.policy = ({ fixture, binding, canonicalJson, recipe }) => {
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture, "static-branch-source.json")));
  return {
    id: "private-explicit-static-evidence-ported-branch-reporter", staticBranches: true, portedNoops: true,
    authorizationDigest: sha256(canonicalJson({ binding, recipeId: recipe.recipeId,
      executableDigest: recipe.executableDigest, expectedSha256: evidence.expectedSha256,
      authority: "external-caller-reported-no-model-or-command-authority", staticBranches: true })),
    authorizeDefinition: candidate => candidate.actorId === binding.actorId
      && candidate.source?.kind === "recipe" && candidate.source.recipeId === recipe.recipeId
      && candidate.executableDigest === recipe.executableDigest
      && canonicalJson(candidate.node) === canonicalJson(recipe.definition.spec.nodes.find(node => node.nodeId === candidate.node.nodeId)),
    authorizeData: candidate => ["valid", "invalid"].includes(candidate.inputs.source)
      && candidate.inputs.expected_sha256 === evidence.expectedSha256,
  };
};
exports.perform = ({ fixture, scenario, nodeId, inputs, ledger = "new-static-branch-effects.jsonl" }) => {
  assert(/^[a-z-]+$/.test(scenario));
  const directory = path.join(fixture, "workspace", `branch-${scenario}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const original = path.join(fixture, "workspace/recipe-input.txt");
  const input = inputs.source === "valid" ? original : path.join(fixture, "workspace/branch-invalid.txt");
  const bytes = fs.readFileSync(input), actual = sha256(bytes);
  const outcome = actual === inputs.expected_sha256 ? "valid" : "invalid";
  let result;
  const write = (file, value) => {
    const fd = fs.openSync(path.join(directory, file), "wx", 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  if (nodeId === "inspect") result = { sha256: actual, branch: outcome, valid: outcome === "valid", invalid: outcome === "invalid" };
  else if (nodeId === "record-valid") {
    assert.equal(outcome, "valid");
    write("validated.txt", actual + "\n");
    result = { artifact: "validated.txt", sha256: sha256(fs.readFileSync(path.join(directory, "validated.txt"))) };
  } else if (nodeId === "repair") {
    assert.equal(outcome, "invalid");
    write("repaired.txt", fs.readFileSync(original));
    assert.equal(sha256(fs.readFileSync(path.join(directory, "repaired.txt"))), inputs.expected_sha256);
    result = { artifact: "repaired.txt", sha256: inputs.expected_sha256 };
  } else {
    assert.equal(nodeId, "finish");
    const artifact = outcome === "valid" ? "validated.txt" : "repaired.txt";
    assert(!fs.existsSync(path.join(directory, outcome === "valid" ? "repaired.txt" : "validated.txt")));
    result = { branch: outcome, artifact, sha256: sha256(fs.readFileSync(path.join(directory, artifact))) };
    write("archive.json", JSON.stringify(result));
  }
  const fd = fs.openSync(path.join(fixture, ledger), "a", 0o600);
  try { fs.writeSync(fd, JSON.stringify({ scenario, node: nodeId, result }) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return { outcome: nodeId === "inspect" ? outcome : "succeeded", result };
};
if (require.main === module) {
  const [fixture, scenario, nodeId, inputs] = process.argv.slice(2);
  console.log(JSON.stringify(exports.perform({ fixture, scenario, nodeId, inputs: JSON.parse(inputs),
    ledger: "native-static-branch-effects.jsonl" })));
}
