#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { canonicalJson } = require("../dist/workflow-contracts.js");
const { GitHubSyncConflictError } = require("../dist/github-sync.js");
const {
  clearGitHubSyncConflict,
  listGitHubSyncConflicts,
  readGitHubSyncConflict,
  readGitHubSyncConflictCandidate,
  refreshGitHubSyncConflictLocalCandidate,
  selectAllGitHubSyncConflictCandidates,
  selectAllGitHubSyncConflictDeletions,
  selectGitHubSyncConflictCandidate,
  selectGitHubSyncConflictDeletion,
  storeGitHubSyncConflict,
  updateGitHubSyncAgentCandidate,
  validateGitHubSyncConflictLocalState,
  validateGitHubSyncManualCandidate,
} = require("../dist/github-sync-conflicts.js");

const skill = body => Buffer.from(`---\nname: "Shared"\ndescription: "test"\n---\n# Shared\n\n${body}\n`);
const recipeDefinition = {
  schema: "pkm.workflow.definition/v1",
  spec: {
    inputs: {},
    nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {},
    completion: { requiredNodes: ["work"] }
  }
};
const recipe = label => Buffer.from(JSON.stringify({
  recipeId: "recipe_shared",
  scope: "global",
  category: "Examples",
  name: "Shared Recipe",
  description: label,
  revision: 1,
  definition: recipeDefinition,
  executableDigest: crypto.createHash("sha256")
    .update(canonicalJson(recipeDefinition))
    .digest("hex")
}, null, 2) + "\n");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-sync-conflict-"));

try {
  const error = new GitHubSyncConflictError("a".repeat(40), [{
    path: "skills/Shared/Shared.md",
    type: "skills",
    itemId: "Shared",
    category: "Shared",
    privacy: "public",
    base: skill("base"),
    local: skill("local"),
    remote: skill("remote"),
  }]);
  const stored = storeGitHubSyncConflict(root, "target-1", error);
  assert.strictEqual(stored.files.length, 1);
  assert.strictEqual(stored.resolutionReport.rules["human-required"], 1);
  assert.strictEqual(stored.files[0].candidateSource, "unresolved", "every conflict requires an explicit resolution");
  assert.deepStrictEqual(listGitHubSyncConflicts(root).map(item => item.targetId), ["target-1"]);
  assert(readGitHubSyncConflictCandidate(root, "target-1", stored.files[0].path).equals(skill("local")));
  selectGitHubSyncConflictCandidate(root, "target-1", stored.files[0].path, "remote");
  assert(readGitHubSyncConflictCandidate(root, "target-1", stored.files[0].path).equals(skill("remote")));
  assert.strictEqual(readGitHubSyncConflict(root, "target-1").files[0].candidateSource, "remote");
  selectGitHubSyncConflictCandidate(root, "target-1", stored.files[0].path, "local");
  const batchRemote = selectAllGitHubSyncConflictCandidates(root, "target-1", "remote");
  assert.deepStrictEqual(batchRemote, { selected: 1, unavailable: [] });
  assert.strictEqual(readGitHubSyncConflict(root, "target-1").files[0].candidateSource, "remote");
  assert.throws(
    () => updateGitHubSyncAgentCandidate(root, "target-1", stored.files[0].path, skill("<<<<<<< local").toString("utf8"), "bad"),
    /conflict markers/,
    "invalid Agent output must never become an approved candidate"
  );
  updateGitHubSyncAgentCandidate(root, "target-1", stored.files[0].path, skill("merged meaning").toString("utf8"), "Preserved both valid requirements.", {
    decisions: [{ subject: "requirements", choice: "combined", reason: "Both are compatible." }],
    evidence: ["Base, local, and remote variants"],
    unresolvedConflicts: [],
    introducedContent: [],
    confidence: 0.93,
    accuracyRisk: false,
    humanFinalReviewRequired: true,
  });
  const updated = readGitHubSyncConflict(root, "target-1");
  assert.strictEqual(updated.files[0].candidateSource, "agent");
  assert.match(updated.files[0].rationale, /Preserved/);
  assert.strictEqual(updated.files[0].agentReview.confidence, 0.93);
  assert.strictEqual(updated.files[0].agentReview.humanFinalReviewRequired, true);
  assert(readGitHubSyncConflictCandidate(root, "target-1", stored.files[0].path).equals(skill("merged meaning")));
  validateGitHubSyncManualCandidate(root, "target-1", stored.files[0].path);
  assert.strictEqual(readGitHubSyncConflict(root, "target-1").files[0].candidateSource, "manual");
  assert.doesNotThrow(() => validateGitHubSyncConflictLocalState(stored.files[0].path, skill("local"), skill("merged meaning"), skill("local")));
  assert.doesNotThrow(() => validateGitHubSyncConflictLocalState(stored.files[0].path, skill("local"), skill("merged meaning"), skill("merged meaning")));
  assert.throws(
    () => validateGitHubSyncConflictLocalState(stored.files[0].path, skill("local"), skill("merged meaning"), skill("edited later")),
    /changed after the conflict was prepared/,
    "acceptance must not overwrite an edit made after conflict staging"
  );

  const preview = storeGitHubSyncConflict(root, "target-preview", new GitHubSyncConflictError("c".repeat(40), [
    {
      path: "notes/Remote.md", type: "notes", itemId: "Remote", category: "", privacy: "public",
      remote: Buffer.from("# Remote\n"),
    },
    {
      path: "notes/Local.md", type: "notes", itemId: "Local", category: "", privacy: "public",
      local: Buffer.from("# Local\n"),
    },
    {
      path: "notes/Both.md", type: "notes", itemId: "Both", category: "", privacy: "public",
      local: Buffer.from("# Local edit\n"), remote: Buffer.from("# Remote edit\n"),
    },
  ]), "initial-preview", 3);
  assert.strictEqual(preview.purpose, "initial-preview");
  assert.strictEqual(preview.remoteSchema, 3);
  assert.deepStrictEqual(
    preview.files.map(file => file.candidateSource),
    ["remote", "local", "unresolved"],
    "initial comparison preserves one-sided files automatically and asks only for true two-sided differences",
  );

  const deletedOnBothSides = storeGitHubSyncConflict(root, "target-2", new GitHubSyncConflictError("b".repeat(40), [{
    path: "skills/Shared/Deleted.md",
    type: "skills",
    itemId: "Deleted",
    category: "Shared",
    privacy: "public",
    base: skill("recoverable base"),
  }]));
  assert.strictEqual(deletedOnBothSides.files[0].candidateSource, "unresolved");
  assert(readGitHubSyncConflictCandidate(root, "target-2", deletedOnBothSides.files[0].path).equals(skill("recoverable base")));
  assert.deepStrictEqual(
    selectAllGitHubSyncConflictCandidates(root, "target-2", "remote"),
    { selected: 0, unavailable: ["skills/Shared/Deleted.md"] },
    "bulk selection leaves conflicts unresolved when that side has no candidate"
  );
  assert.strictEqual(readGitHubSyncConflict(root, "target-2").files[0].candidateSource, "unresolved");
  selectGitHubSyncConflictCandidate(root, "target-2", deletedOnBothSides.files[0].path, "base");
  assert.strictEqual(readGitHubSyncConflict(root, "target-2").files[0].candidateSource, "base");

  const missingLocal = storeGitHubSyncConflict(root, "target-delete", new GitHubSyncConflictError("d".repeat(40), [{
    path: "papers/Ideas/Delete.md",
    type: "papers",
    itemId: "Ideas/Delete",
    category: "Ideas",
    privacy: "public",
    base: Buffer.from("# Previous\n"),
    remote: Buffer.from("# Remote\n"),
  }]));
  selectGitHubSyncConflictDeletion(root, "target-delete", missingLocal.files[0].path);
  assert.strictEqual(readGitHubSyncConflict(root, "target-delete").files[0].candidateSource, "delete");
  assert.match(readGitHubSyncConflict(root, "target-delete").files[0].rationale, /remove this file from GitHub/);
  const missingLocalBatch = storeGitHubSyncConflict(root, "target-delete-all", new GitHubSyncConflictError("e".repeat(40), [{
    path: "papers/Ideas/Delete.md",
    type: "papers",
    itemId: "Ideas/Delete",
    category: "Ideas",
    privacy: "public",
    base: Buffer.from("# Previous\n"),
    remote: Buffer.from("# Remote\n"),
  }]));
  assert.deepStrictEqual(selectAllGitHubSyncConflictDeletions(root, "target-delete-all"), { selected: 1 });
  assert.strictEqual(readGitHubSyncConflict(root, "target-delete-all").files[0].candidateSource, "delete");
  assert.throws(
    () => selectGitHubSyncConflictDeletion(root, "target-1", stored.files[0].path),
    /available only when/,
    "remote deletion cannot be selected when a machine-local candidate still exists"
  );
  refreshGitHubSyncConflictLocalCandidate(
    root,
    "target-delete",
    missingLocal.files[0].path,
    Buffer.from("# Newly restored locally\n"),
  );
  const refreshedLocal = readGitHubSyncConflict(root, "target-delete").files[0];
  assert.strictEqual(refreshedLocal.hasLocal, true);
  assert.strictEqual(refreshedLocal.candidateSource, "unresolved");
  assert.match(refreshedLocal.rationale, /changed after this conflict was prepared/);
  assert(readGitHubSyncConflictCandidate(root, "target-delete", missingLocal.files[0].path)
    .equals(Buffer.from("# Newly restored locally\n")));

  const recipeConflict = storeGitHubSyncConflict(root, "target-recipes", new GitHubSyncConflictError("c".repeat(40), [{
    path: "recipes/Examples/Shared.recipe_shared.json",
    type: "recipes",
    itemId: "recipe_shared",
    category: "Examples",
    privacy: "public",
    base: recipe("base"),
    local: recipe("local"),
    remote: recipe("remote"),
  }]));
  selectGitHubSyncConflictCandidate(root, "target-recipes", recipeConflict.files[0].path, "remote");
  assert(readGitHubSyncConflictCandidate(root, "target-recipes", recipeConflict.files[0].path).equals(recipe("remote")));
  assert.throws(
    () => updateGitHubSyncAgentCandidate(root, "target-recipes", recipeConflict.files[0].path, "{\"recipeId\":\"broken\"}", "bad"),
    /missing recipeId, name, or definition/,
    "invalid Agent Recipe output must never become a candidate"
  );
  updateGitHubSyncAgentCandidate(root, "target-recipes", recipeConflict.files[0].path, recipe("merged").toString("utf8"), "Merged Recipe graph.");
  assert.strictEqual(readGitHubSyncConflict(root, "target-recipes").files[0].candidateSource, "agent");

  const legacyMetadataPath = path.join(root, "conflicts", "target-recipes", "conflict.json");
  const legacyMetadata = JSON.parse(fs.readFileSync(legacyMetadataPath, "utf8"));
  delete legacyMetadata.explicitResolution;
  legacyMetadata.files[0].candidateSource = "local";
  fs.writeFileSync(legacyMetadataPath, JSON.stringify(legacyMetadata, null, 2) + "\n");
  assert.strictEqual(readGitHubSyncConflict(root, "target-recipes").files[0].candidateSource, "unresolved",
    "pre-upgrade conflict workspaces must require a new explicit choice");
  clearGitHubSyncConflict(root, "target-1");
  assert.strictEqual(readGitHubSyncConflict(root, "target-1"), undefined);
  console.log("github-sync conflict tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
