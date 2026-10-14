#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sync = require("../dist/sync/github-sync");
const repair = require("../dist/sync/github-sync-content-repair");
const { createHash } = require("node:crypto");
const { canonicalJson } = require("../dist/workflows/workflow-contracts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-content-repair-"));
const emptyBlock = "<<<<<<< Updated upstream\r\n\r\n=======\r\n>>>>>>> Stashed changes\r\n";
const original = `#CS\r\nvoid Run() {}\r\n${emptyBlock}#ENDCS\r\n`;
const candidate = "#CS\r\nvoid Run() {}\r\n#ENDCS\r\n";

(async () => {
  assert.equal(repair.inspectConflictMarkers(original).candidate, candidate);
  assert.deepEqual(repair.inspectConflictMarkers(original).lines, [3, 5, 6]);
  for (const content of [
    "<<<<<<< local\ncode();\n=======\nother();\n>>>>>>> remote\n",
    "<<<<<<< local\n=======\n",
    "<<<<<<< outer\n<<<<<<< inner\n=======\n>>>>>>> inner\n=======\n>>>>>>> outer\n",
    "=======\n", ">>>>>>> orphan\n",
    "<<<<<<< local\n||||||| base\n=======\n>>>>>>> remote\n",
  ]) assert.equal(repair.inspectConflictMarkers(content).candidate, undefined, content);
  assert.equal(repair.inspectConflictMarkers("ordinary code\n").lines.length, 0);
  assert.equal(repair.inspectConflictMarkers("Heading\n=======\n").lines.length, 0,
    "a Markdown heading underline alone is not evidence of merge markers");
  const catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [
    { nodeId: "z", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "z" }] },
  ], outputs: {}, completion: { requiredNodes: ["a"] } } };
  const legacy = { recipeId: "recipe_legacy", name: "Legacy", category: "Examples", definition,
    executableDigest: createHash("sha256").update(canonicalJson(definition)).digest("hex") };
  const managed = (type, itemId, relative, content) => ({
    path: relative, type, itemId, member: "", category: "", privacy: "public", content: Buffer.from(content),
    digest: createHash("sha256").update(content).digest("hex"),
  });
  const mixed = [
    managed("scripts", "marked", "scripts/Marked.script", original),
    managed("recipes", "recipe_legacy", "recipes/Examples/Legacy.recipe_legacy.json", JSON.stringify(legacy)),
  ];
  for (const files of [mixed, [...mixed].reverse()]) {
    const issues = sync.collectGitHubSyncLocalContentIssues(files, catalog);
    assert.equal(issues.length, 2);
    const recipeIssue = issues.find(issue => issue.reason === "recipe-digest");
    assert(recipeIssue.error.includes("executable digest is invalid"));
    assert.deepEqual(recipeIssue.sourceLocator, { kind: "recipe-store", recipeId: "recipe_legacy" });
    assert.equal(recipeIssue.sourcePath, undefined, "legacy export path must not be fabricated as a local file");
    assert.equal(recipeIssue.candidate, undefined, "digest errors are not marker cleanup candidates");
    const persisted = repair.storeGitHubSyncContentRepair(path.join(root, "mixed"), new repair.GitHubSyncContentRepairError("mixed", issues));
    assert.deepEqual(repair.readGitHubSyncContentRepair(path.join(root, "mixed"), "mixed"), persisted);
  }
  execFileSync("git", ["init", root], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), "scripts/Ignored.script\n");
  fs.mkdirSync(path.join(root, "scripts"));
  for (const [name, text] of [["Empty", original], ["Nonempty", "<<<<<<< local\nx\n=======\ny\n>>>>>>> remote\n"], ["Ignored", original]]) {
    const source = path.join(root, "scripts", `${name}.script`);
    fs.writeFileSync(source, text);
    catalog.scripts.push({ id: name, cat: "", label: name, source, destination: `scripts/${name}.script` });
  }
  const target = sync.normalizeGitHubSyncTarget({ id: "primary", name: "Primary", repository: path.join(root, "nonexistent-remote.git") });
  const checkouts = path.join(root, "checkouts");
  catalog.recipes.push({ id: legacy.recipeId, cat: "Examples", label: "Legacy", isPrivate: false,
    destination: mixed[1].path, content: JSON.stringify(legacy) });
  catalog.skills.push({ id: "invalid_skill", cat: "", label: "Bad", isPrivate: false,
    destination: "skills/Bad/SKILL.md", content: "missing frontmatter\n" });
  catalog.notes.push({ id: "missing_dependency", cat: "", label: "Missing", isPrivate: false,
    source: path.join(root, "missing.md"), destination: "notes/Missing.md" });
  catalog.scripts[0].dependencies = [
    { source: path.join(root, "missing-one.png"), destination: "scripts/missing-one.png" },
    { source: path.join(root, "missing-two.png"), destination: "scripts/missing-two.png" },
  ];
  let mixedFailure;
  try { await sync.syncGitHubTarget(target, catalog, checkouts, undefined, root); }
  catch (error) { mixedFailure = error; }
  assert(mixedFailure instanceof repair.GitHubSyncContentRepairError);
  assert.equal(mixedFailure.serviceShouldRetry, false);
  assert.equal(mixedFailure.issues.length, 7, "markers, Recipe, frontmatter and every unreadable dependency survive one scan");
  assert(mixedFailure.issues.some(issue => issue.reason === "materialization" && issue.error.includes("missing.md")));
  assert(!fs.existsSync(checkouts));
  catalog.recipes = []; catalog.skills = []; catalog.notes = [];
  catalog.scripts[0].dependencies = [];
  let failure;
  try { await sync.syncGitHubTarget(target, catalog, checkouts, undefined, root); }
  catch (error) { failure = error; }
  assert(failure instanceof repair.GitHubSyncContentRepairError);
  assert.equal(failure.issues.length, 2, "all selected local marker issues are reported together");
  assert(!failure.issues.some(issue => issue.itemId === "Ignored"), "Git-ignored markers do not block an unrelated target");
  assert(!fs.existsSync(checkouts), "no checkout, remote fetch or push precedes local content repair");
  assert(!("remoteCommit" in failure), "unknown remote state must not be invented");
  const record = repair.storeGitHubSyncContentRepair(path.join(root, "state"), failure);
  assert.deepEqual(repair.readGitHubSyncContentRepair(path.join(root, "state"), target.id), record);
  const issue = failure.issues.find(issue => issue.itemId === "Empty");
  assert.equal(fs.readFileSync(issue.sourcePath, "utf8"), original, "candidate creation must not modify the source");
  fs.writeFileSync(issue.sourcePath, original.replace(/\r\n/g, "\n"));
  assert.throws(() => repair.applyGitHubSyncEmptyMarkerCandidate(root, issue), /source bytes changed/i,
    "even line-ending-only source edits require a fresh review");
  fs.writeFileSync(issue.sourcePath, original);
  repair.applyGitHubSyncEmptyMarkerCandidate(root, issue);
  assert.equal(fs.readFileSync(issue.sourcePath, "utf8"), candidate, "CRLF and all other bytes survive approved cleanup");
  fs.writeFileSync(issue.sourcePath, original + "user edited\n");
  assert.throws(() => repair.applyGitHubSyncEmptyMarkerCandidate(root, issue), /source changed/i);
  assert.equal(fs.readFileSync(issue.sourcePath, "utf8"), original + "user edited\n");
  assert.throws(() => repair.applyGitHubSyncEmptyMarkerCandidate(root, failure.issues.find(issue => issue.itemId === "Nonempty")), /No safe/);
  assert.throws(() => repair.storeGitHubSyncContentRepair(root, new repair.GitHubSyncContentRepairError("../unsafe", [])), /Invalid/);
  fs.writeFileSync(issue.sourcePath, candidate);
  await assert.rejects(() => sync.syncGitHubTarget(target, catalog, checkouts, undefined, root),
    error => error instanceof repair.GitHubSyncContentRepairError && error.issues.length === 1
      && error.issues[0].itemId === "Nonempty", "revalidation reads new bytes and updates the remaining marker list");
  fs.writeFileSync(path.join(root, "scripts/Nonempty.script"), "resolved by user\n");
  execFileSync("git", ["init", "--bare", target.repository], { stdio: "ignore" });
  const synced = await sync.syncGitHubTarget(target, catalog, checkouts, undefined, root);
  assert(synced.changed, "a repaired untracked source resumes ordinary reconciliation and push");
  const remote = execFileSync("git", ["--git-dir", target.repository, "show", "main:scripts/Empty.script"], { encoding: "utf8" });
  assert.equal(remote, candidate.replace(/\r\n/g, "\n"));
  repair.clearGitHubSyncContentRepair(path.join(root, "state"), target.id);
  assert.equal(repair.readGitHubSyncContentRepair(path.join(root, "state"), target.id), undefined);
  console.log("GitHub Sync content repair tests passed");
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error); process.exitCode = 1;
});
