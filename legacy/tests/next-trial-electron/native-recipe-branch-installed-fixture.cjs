"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const helper = require("./legacy-static-branch-fixture.cjs");
exports.prepare = ({ extension, root, fixture }) => {
  const evidence = helper.create({ extension, root, fixture });
  const oracle = path.join(fixture, "static-branch-original-oracle");
  fs.mkdirSync(oracle, { mode: 0o700 });
  fs.cpSync(root, path.join(oracle, "knowledge"), { recursive: true, errorOnExist: true });
  fs.mkdirSync(path.join(oracle, "workspace"), { mode: 0o700 });
  for (const file of ["native-ui-fixture-token", "static-branch-source.json"])
    fs.copyFileSync(path.join(fixture, file), path.join(oracle, file));
  for (const file of ["recipe-input.txt", "branch-invalid.txt"])
    fs.copyFileSync(path.join(fixture, "workspace", file), path.join(oracle, "workspace", file));
  const result = spawnSync("python3", ["-B", path.join(__dirname, "legacy-static-branch-oracle.py"), extension, oracle],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const trace = JSON.parse(result.stdout);
  assert.match(JSON.stringify(trace.original_tutorial_start), /succeeded|accept/);
  assert.equal(trace.scenarios.valid.final.status, "completed");
  assert.equal(trace.scenarios.invalid.final.status, "completed");
  fs.writeFileSync(path.join(fixture, "static-branch-original-trace.json"), JSON.stringify(trace), { flag: "wx", mode: 0o600 });
  return { recipeId: evidence.recipe.recipeId, executableDigest: evidence.recipe.executableDigest,
    definition: evidence.recipe.definition, nodeCount: 4, authoredWithActualOriginalProjectStore: true,
    oracleRoot: path.join(oracle, "knowledge"), oracleNeverAdopted: true,
    originalTutorialStart: trace.original_tutorial_start };
};
exports.policy = context => {
  const { recipe } = JSON.parse(fs.readFileSync(path.join(context.fixture, "static-branch-source.json")));
  return helper.policy({ ...context, recipe });
};
