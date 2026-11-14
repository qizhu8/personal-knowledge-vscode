"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
exports.prepare = ({ extension, root, fixture }) => {
  const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
  const oracle = path.join(fixture, "external-report-original-oracle");
  fs.mkdirSync(oracle, { mode: 0o700 });
  fs.cpSync(root, path.join(oracle, "knowledge"), { recursive: true, errorOnExist: true });
  const recipe = new ProjectStore(path.join(oracle, "knowledge/.pkm/state")).list().recipes
    .find(row => row.name === "Universal Unknown Task");
  assert(recipe && recipe.definition.spec.nodes.length === 6);
  assert(recipe.definition.spec.nodes.every(node => node.kind === "pkm.step.noop/v1" && !node.ports));
  fs.writeFileSync(path.join(fixture, "external-report-recipe.json"), JSON.stringify(recipe), { mode: 0o600 });
  fs.mkdirSync(path.join(oracle, "workspace"), { mode: 0o700 });
  for (const file of ["native-ui-fixture-token", "external-report-recipe.json"])
    fs.copyFileSync(path.join(fixture, file), path.join(oracle, file));
  fs.copyFileSync(path.join(fixture, "workspace/recipe-input.txt"), path.join(oracle, "workspace/recipe-input.txt"));
  const result = spawnSync("python3", ["-B", path.join(__dirname, "legacy-external-report-oracle.py"), extension, oracle],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const trace = JSON.parse(result.stdout);
  assert.equal(trace.final.status, "completed");
  fs.writeFileSync(path.join(fixture, "external-report-original-trace.json"), JSON.stringify(trace), { mode: 0o600 });
  return { recipeId: recipe.recipeId, executableDigest: recipe.executableDigest, nodeCount: 6,
    oracleRoot: path.join(oracle, "knowledge"), oracleNeverAdopted: true };
};
exports.policy = ({ fixture, binding, canonicalJson }) => {
  const recipe = JSON.parse(fs.readFileSync(path.join(fixture, "external-report-recipe.json")));
  return {
    id: "private-explicit-original-universal-external-reporter",
    authorizationDigest: require("node:crypto").createHash("sha256").update(canonicalJson({
      binding, recipeId: recipe.recipeId, executableDigest: recipe.executableDigest,
      authority: "external-caller-reported-no-agent-or-command-permissions",
    })).digest("hex"),
    authorizeDefinition: candidate => candidate.actorId === binding.actorId
      && candidate.executableDigest === recipe.executableDigest && candidate.source?.kind === "recipe"
      && candidate.source.recipeId === recipe.recipeId && canonicalJson(candidate.node)
        === canonicalJson(recipe.definition.spec.nodes.find(node => node.nodeId === candidate.node.nodeId)),
  };
};
