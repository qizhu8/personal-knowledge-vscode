#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  GitHubPublicationMigration,
  normalizeGitHubSyncTarget,
} = require("../dist/github-sync.js");

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

  const staged = migration.stage(source);
  assert.strictEqual(staged.phase, "staged");
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

  migration.rollback(source);
  assert.strictEqual(target.publication, undefined);
  assert.strictEqual(target.automation.enabled, true, "rollback restores the exact target state");
  assert.strictEqual(target.automation.initialSyncCompleted, true);

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

  console.log("github-sync migration tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
