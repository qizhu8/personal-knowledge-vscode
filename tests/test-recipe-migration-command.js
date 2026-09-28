#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ProjectStore } = require("../dist/workflows/project-store");

const scratch = path.join(__dirname, ".recipe-migration-command-work");
const script = path.join(__dirname, "..", "scripts", "migrate-recipe-authority.js");

function createRoot() {
  const root = path.join(scratch, crypto.randomUUID());
  const stateRoot = path.join(root, ".pkm", "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  new ProjectStore(stateRoot, () => "migration-command-seed", { autoMigrate: false }).list();
  return { root, stateRoot };
}

function command(root, operation, sourceDigest, expectedStatus = 0) {
  const args = [script, operation, "--root", root];
  if (sourceDigest) args.push("--source-digest", sourceDigest);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.strictEqual(result.status, expectedStatus, `${operation} failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(expectedStatus === 0 ? result.stdout : result.stderr);
}

function firstJsonFile(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = firstJsonFile(candidate);
      if (nested) return nested;
    } else if (entry.name.endsWith(".json")) {
      return candidate;
    }
  }
  return undefined;
}

try {
  fs.mkdirSync(scratch, { recursive: true });
  const primary = createRoot();
  const inspect = command(primary.root, "inspect");
  assert.strictEqual(inspect.preview.active > 0, true);
  assert.strictEqual(inspect.source.containsLegacyRecipes, true);
  const preview = command(primary.root, "preview").receipt;
  assert.match(preview.sourceDigest, /^[a-f0-9]{64}$/);

  const missingBackup = command(primary.root, "stage", preview.sourceDigest, 1);
  assert.strictEqual(missingBackup.error.code, "migration-backup-required");
  const backup = command(primary.root, "backup", preview.sourceDigest).backup;
  assert.strictEqual(backup.sourceDigest, preview.sourceDigest);
  assert.strictEqual(backup.mode, "400");
  assert(fs.existsSync(backup.backupPath));

  assert.strictEqual(command(primary.root, "stage", preview.sourceDigest).receipt.phase, "staged");
  assert.strictEqual(command(primary.root, "status").migration.phase, "staged");
  const prematureCutover = command(primary.root, "cutover", preview.sourceDigest, 1);
  assert.strictEqual(prematureCutover.error.code, "migration-verification-required");
  assert.strictEqual(command(primary.root, "verify", preview.sourceDigest).receipt.phase, "verified");
  assert.strictEqual(command(primary.root, "status").migration.phase, "verified");
  assert.strictEqual(command(primary.root, "cutover", preview.sourceDigest).receipt.phase, "cutover");
  assert.strictEqual(command(primary.root, "restart-verify", preview.sourceDigest).receipt.phase, "cutover");

  const cutoverEnvelope = JSON.parse(fs.readFileSync(path.join(primary.stateRoot, "projects.json"), "utf8"));
  for (const field of ["recipes", "recipeFolders", "recipeTrash"]) {
    assert(!Object.prototype.hasOwnProperty.call(cutoverEnvelope.payload.state, field));
  }

  fs.copyFileSync(backup.backupPath, path.join(primary.stateRoot, "projects.json"));
  assert.strictEqual(command(primary.root, "cutover", preview.sourceDigest).receipt.phase, "cutover");
  const repairedEnvelope = JSON.parse(fs.readFileSync(path.join(primary.stateRoot, "projects.json"), "utf8"));
  assert(!Object.prototype.hasOwnProperty.call(repairedEnvelope.payload.state, "recipes"),
    "replayed cutover must finish stripping legacy Recipe authority");

  assert.strictEqual(command(primary.root, "rollback", preview.sourceDigest).receipt.phase, "rolled-back");
  const rolledBackEnvelope = JSON.parse(fs.readFileSync(path.join(primary.stateRoot, "projects.json"), "utf8"));
  assert(Object.prototype.hasOwnProperty.call(rolledBackEnvelope.payload.state, "recipes"));
  assert(!fs.existsSync(path.join(primary.root, "recipes")));
  assert(fs.existsSync(backup.backupPath), "rollback must preserve the immutable operator backup");

  const corrupted = createRoot();
  const corruptedPreview = command(corrupted.root, "preview").receipt;
  command(corrupted.root, "backup", corruptedPreview.sourceDigest);
  command(corrupted.root, "stage", corruptedPreview.sourceDigest);
  const stagedRoot = path.join(corrupted.stateRoot, "recipe-store-migration", "stage", "recipes");
  const stagedRecipe = firstJsonFile(stagedRoot);
  assert(stagedRecipe);
  fs.writeFileSync(stagedRecipe, "{", "utf8");
  const verificationFailure = command(corrupted.root, "verify", corruptedPreview.sourceDigest, 1);
  assert.strictEqual(verificationFailure.error.code, "migration-verification-failed");
  assert.strictEqual(command(corrupted.root, "status").migration.phase, "staged");

  console.log("recipe migration command tests passed");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
