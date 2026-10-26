#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  GitHubPublicationMigration,
  githubSyncMigrationCanonicalFiles,
  normalizeGitHubSyncTarget,
} = require("../dist/sync/github-sync.js");

const manifest2 = JSON.stringify({
  schema: 2,
  files: [{
    path: "skills/Legacy/One.md",
    type: "skills",
    itemId: "knowledge_one",
    category: "Legacy",
    privacy: "public",
    digest: "a".repeat(64),
  }],
}, null, 2) + "\n";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-migration-"));
try {
  const stateRoot = path.join(root, "state");
  const target = normalizeGitHubSyncTarget({
    name: "Knowledge",
    repository: "https://github.com/example/knowledge.git",
    branch: "main",
    automation: { enabled: true, intervalMinutes: 5, syncOnChange: true, initialSyncCompleted: true },
  }, () => "target-1");
  const selectedSkill = path.join(root, "Selected.md");
  fs.writeFileSync(selectedSkill, "# Selected\n");
  const selectionTarget = normalizeGitHubSyncTarget({
    name: "Selection boundary",
    repository: "https://github.com/example/knowledge.git",
    branch: "main",
    selection: {
      public: {
        skills: { items: ["selected-skill"], folders: [] },
        packages: { items: [], folders: [] },
      },
      private: {},
    },
  }, () => "target-selection");
  const canonicalCatalog = {
    skills: [{ id: "selected-skill", label: "Selected", cat: "", isPrivate: false, source: selectedSkill, destination: "skills/Selected.md" }],
    notes: [],
    papers: [],
    prompts: [],
    scripts: [],
    packages: [{
      id: "unselected-package",
      label: "Unselected package",
      cat: "",
      isPrivate: false,
      source: path.join(root, "must-not-be-read"),
      destination: "packages/unselected-package",
    }],
    servers: [],
    recipes: [],
    agentSnapshots: [],
  };
  assert.deepStrictEqual(githubSyncMigrationCanonicalFiles(canonicalCatalog, selectionTarget), [{
    path: "skills/Selected.md",
    type: "skills",
    itemId: "selected-skill",
    member: "",
    category: "",
    privacy: "public",
  }], "migration identity inventory must never traverse catalog items outside the target selection");
  const migration = new GitHubPublicationMigration(stateRoot, target.id);
  const source = {
    target,
    remoteCommit: "1".repeat(40),
    manifest: manifest2,
    repositoryFiles: ["skills/Legacy/One.md"],
    activeCount: 1,
    trashCount: 2,
    folderCount: 1,
    idCount: 1,
  };

  const preview = migration.preview(source);
  assert.strictEqual(preview.phase, "previewed");
  assert.strictEqual(preview.activeCount, 1);
  assert.strictEqual(preview.trashCount, 2);
  assert.strictEqual(preview.folderCount, 1);
  assert.strictEqual(preview.idCount, 1);
  assert.deepStrictEqual(preview.collisions, []);
  assert.throws(
    () => migration.preview({ ...source, remoteCommit: "2".repeat(40) }),
    /source changed after preview/i,
    "preview is persisted and fenced against a changing source",
  );

  const markerPath = path.join(stateRoot, "migrations", target.id, "migration.json");
  const legacyPreviewMarker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  legacyPreviewMarker.sourceDigest = "f".repeat(64);
  fs.writeFileSync(markerPath, JSON.stringify(legacyPreviewMarker, null, 2));
  const staged = migration.stage(source);
  assert.strictEqual(staged.phase, "staged");
  assert.notStrictEqual(staged.sourceDigest, legacyPreviewMarker.sourceDigest,
    "staging refreshes an obsolete preview digest when the remote commit is unchanged");
  assert.strictEqual(target.automation.enabled, false, "staging disables Auto Sync before any authority change");
  assert.strictEqual(target.automation.initialSyncCompleted, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(migration.stagedManifestPath(), "utf8")).schema, 3);
  assert.strictEqual(fs.readFileSync(path.join(stateRoot, "migrations", target.id, "backup", ".pkm-github-sync.json"), "utf8"), manifest2,
    "staging preserves the exact pre-migration manifest");
  assert.deepStrictEqual(migration.stage(source), staged, "staging retries are idempotent");

  const verified = migration.verify(source);
  assert.strictEqual(verified.phase, "verified");
  const cutover = migration.cutover(source);
  assert.strictEqual(cutover.phase, "cutover");
  assert.strictEqual(target.publication.requiredCapability, "stable-entity-identity");
  assert.strictEqual(target.automation.enabled, false);
  assert.strictEqual(target.automation.initialSyncCompleted, false,
    "cutover requires a new manual Fetch/Pull through Push and index refresh");

  assert.throws(
    () => migration.completeManualVerification({ ...source, remoteCommit: "2".repeat(40) }),
    /source changed/i,
    "a foreign repository update invalidates the staged transaction",
  );
  migration.completeManualVerification(source);
  assert.strictEqual(target.publication.manualVerificationCompleted, true);
  assert.strictEqual(target.automation.enabled, false, "manual verification never silently re-enables Auto Sync");
  assert.throws(() => migration.restartPreview(source), /already verified/);

  migration.rollback(source);
  assert.strictEqual(target.publication, undefined);
  assert.strictEqual(target.automation.enabled, true, "rollback restores the exact target state");
  assert.strictEqual(target.automation.initialSyncCompleted, true);

  const recoveryTarget = normalizeGitHubSyncTarget({ ...target, id: "recovery-target" }, () => "unused");
  const recovery = new GitHubPublicationMigration(stateRoot, recoveryTarget.id);
  const recoverySource = { ...source, target: recoveryTarget };
  recovery.preview(recoverySource); recovery.stage(recoverySource); recovery.verify(recoverySource); recovery.cutover(recoverySource);
  const changedSource = { ...recoverySource, remoteCommit: "3".repeat(40) };
  assert.throws(() => recovery.stage(changedSource), /source changed/);
  assert.throws(() => recovery.restartPreview({ ...changedSource, target: { ...recoveryTarget, branch: "different" } }), /branch changed/);
  recoveryTarget.automation.enabled = true;
  const restarted = recovery.restartPreview(changedSource);
  assert.strictEqual(restarted.phase, "previewed");
  assert.strictEqual(restarted.remoteCommit, changedSource.remoteCommit);
  assert.strictEqual(recoveryTarget.automation.enabled, false);
  assert.strictEqual(recoveryTarget.automation.initialSyncCompleted, false);
  assert.strictEqual(recoveryTarget.publication.manualVerificationCompleted, false, "restart never claims verification");
  const history = path.join(stateRoot, "migrations", recoveryTarget.id, "history");
  const archived = path.join(history, fs.readdirSync(history)[0]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(archived, "migration.json"))).phase, "cutover");
  assert.strictEqual(fs.readFileSync(path.join(archived, "backup", ".pkm-github-sync.json"), "utf8"), manifest2);
  assert.throws(() => recovery.verify(changedSource), /source changed|digest|staged|verified/i);
  recovery.stage(changedSource); recovery.verify(changedSource); recovery.cutover(changedSource);
  assert.strictEqual(fs.readFileSync(path.join(archived, "backup", ".pkm-github-sync.json"), "utf8"), manifest2,
    "restaging must not delete archived migration evidence");
  assert.strictEqual(recoveryTarget.publication.sourceCommit, changedSource.remoteCommit);
  recovery.rollback(changedSource);
  assert.strictEqual(recoveryTarget.publication, undefined, "restart retains the original pre-migration rollback target");
  assert.strictEqual(recoveryTarget.automation.enabled, true);

  const resourceTarget = normalizeGitHubSyncTarget({ ...target, id: "resource-target" }, () => "unused");
  const capabilities = { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] };
  const resourceFiles = [
    { path: "notes/Project/Report.md", member: "" },
    { path: "notes/Project/Report.assets/chart.svg", member: "notes/Project/Report.assets/chart.svg" },
    { path: "notes/Project/_assets/data.tsv", member: "notes/Project/_assets/data.tsv" },
  ].map(file => ({ ...file, type: "notes", itemId: "report", category: "Project", privacy: "public", digest: "a".repeat(64) }));
  const resourceSource = { ...source, target: resourceTarget,
    manifest: JSON.stringify({ schema: 3, capabilities, files: resourceFiles, deletions: [] }), repositoryFiles: resourceFiles.map(file => file.path) };
  const resourcesMigration = new GitHubPublicationMigration(stateRoot, resourceTarget.id);
  assert.deepStrictEqual(resourcesMigration.preview(resourceSource).collisions, [], "schema-3 Markdown attachments are entity members, not duplicate documents");
  resourcesMigration.stage(resourceSource);
  const duplicateTarget = normalizeGitHubSyncTarget({ ...target, id: "duplicate-target" }, () => "unused");
  const duplicateFiles = [...resourceFiles, { ...resourceFiles[0], path: "notes/Project/Other.md" }];
  const duplicateSource = { ...resourceSource, target: duplicateTarget,
    manifest: JSON.stringify({ schema: 3, capabilities, files: duplicateFiles, deletions: [] }), repositoryFiles: duplicateFiles.map(file => file.path) };
  const duplicateMigration = new GitHubPublicationMigration(stateRoot, duplicateTarget.id);
  assert.strictEqual(duplicateMigration.preview(duplicateSource).collisions.length, 1, "two principal documents remain a collision");
  assert.throws(() => duplicateMigration.stage(duplicateSource), /repeats stable member identity/);

  const retry = new GitHubPublicationMigration(stateRoot, target.id);
  assert.strictEqual(retry.stage(source).phase, "staged");
  fs.writeFileSync(retry.stagedManifestPath(), "{}\n");
  assert.throws(() => retry.verify(source), /staged manifest digest/i);
  retry.rollback(source);

  const foreign = normalizeGitHubSyncTarget({
    ...target,
    repository: "https://github.com/example/other.git",
  }, () => target.id);
  assert.throws(() => retry.stage({ ...source, target: foreign }), /repository or branch changed/i);

  const collisionTarget = normalizeGitHubSyncTarget({
    name: "Collision",
    repository: "https://github.com/example/collision.git",
    branch: "main",
  }, () => "target-collision");
  const collisionMigration = new GitHubPublicationMigration(stateRoot, collisionTarget.id);
  const collisionManifest = JSON.stringify({
    schema: 2,
    files: [
      { path: "skills/One.md", type: "skills", itemId: "knowledge_duplicate", category: "", privacy: "public", digest: "b".repeat(64) },
      { path: "skills/Two.md", type: "skills", itemId: "knowledge_duplicate", category: "", privacy: "public", digest: "c".repeat(64) },
    ],
  });
  const collisionSource = {
    ...source,
    target: collisionTarget,
    manifest: collisionManifest,
    repositoryFiles: ["skills/One.md", "skills/Two.md"],
    activeCount: 2,
  };
  const collisionPreview = collisionMigration.preview(collisionSource);
  assert.strictEqual(collisionPreview.collisions.length, 1);
  assert.throws(() => collisionMigration.stage(collisionSource), /unresolved collisions/i);

  const legacyTarget = normalizeGitHubSyncTarget({
    name: "Legacy Knowledge",
    repository: "https://github.com/example/legacy-knowledge.git",
    branch: "main",
    automation: { enabled: true, intervalMinutes: 5, syncOnChange: true, initialSyncCompleted: true },
  }, () => "target-legacy");
  const legacyMigration = new GitHubPublicationMigration(stateRoot, legacyTarget.id);
  const legacySource = {
    target: legacyTarget,
    remoteCommit: "3".repeat(40),
    manifest: JSON.stringify({ schema: 1, files: ["skills/Legacy/One.md"] }),
    repositoryFiles: ["skills/Legacy/One.md"],
    activeCount: 1,
    trashCount: 0,
    folderCount: 1,
    idCount: 1,
  };
  legacyMigration.preview(legacySource);
  assert.throws(() => legacyMigration.stage(legacySource), /requires a verified content digest/,
    "legacy manifests must not be upgraded with empty or invented content digests");
  legacyMigration.rollback(legacySource);
  const digestSource = { ...legacySource, repositoryDigests: { "skills/Legacy/One.md": "b".repeat(64) } };
  legacyMigration.preview(digestSource);
  legacyMigration.stage(digestSource);
  const migratedLegacyManifest = JSON.parse(fs.readFileSync(legacyMigration.stagedManifestPath(), "utf8"));
  assert.strictEqual(migratedLegacyManifest.files[0].digest, "b".repeat(64));
  assert.strictEqual(migratedLegacyManifest.minimumExtensionVersion, require("../package.json").version);
  legacyMigration.verify(digestSource);

  const basenameTarget = normalizeGitHubSyncTarget({
    name: "Legacy duplicate basenames",
    repository: "https://github.com/example/legacy-basenames.git",
    branch: "main",
  }, () => "target-legacy-basenames");
  const basenameMigration = new GitHubPublicationMigration(stateRoot, basenameTarget.id);
  const basenamePaths = [
    "skills/User/A6000/machine-info.md",
    "skills/User/A6000-CG/machine-info.md",
    "skills/User/VSCode Marketplace/publish-vscode-extension.md",
    "skills/Project/Release/publish-vscode-extension.md",
  ];
  const basenameSource = {
    ...legacySource,
    target: basenameTarget,
    remoteCommit: "4".repeat(40),
    manifest: JSON.stringify({ schema: 1, files: basenamePaths }),
    repositoryFiles: basenamePaths,
    repositoryDigests: Object.fromEntries(basenamePaths.map((file, index) => [file, String(index + 1).repeat(64)])),
    activeCount: basenamePaths.length,
    canonicalFiles: [
      { path: basenamePaths[0], type: "skills", itemId: "a6000-machine-info", member: "", category: "User/A6000", privacy: "private" },
      { path: basenamePaths[1], type: "skills", itemId: "a6000-cg-machine-info", member: "", category: "User/A6000-CG", privacy: "private" },
      { path: basenamePaths[3], type: "skills", itemId: "publish-vscode-extension", member: "", category: "Project/Release", privacy: "public" },
    ],
  };
  assert.deepStrictEqual(basenameMigration.preview(basenameSource).collisions, [],
    "schema-1 basename collisions must converge to canonical catalog identities");
  basenameMigration.stage(basenameSource);
  const basenameManifest = JSON.parse(fs.readFileSync(basenameMigration.stagedManifestPath(), "utf8"));
  assert.deepStrictEqual(basenameManifest.files.map(file => file.itemId), [
    "publish-vscode-extension",
    "a6000-cg-machine-info",
    "a6000-machine-info",
    "User/VSCode Marketplace/publish-vscode-extension",
  ], "unselected legacy files must receive a unique path identity until normal sync retires them");

  console.log("github-sync migration tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
