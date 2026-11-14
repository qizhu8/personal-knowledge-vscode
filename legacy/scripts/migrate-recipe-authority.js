#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ProjectStore } = require("../dist/workflows/project-store");
const { RecipeFilesystemStore } = require("../dist/workflows/recipe-filesystem-store");

const OPERATIONS = new Set([
  "inspect", "preview", "backup", "stage", "verify", "cutover",
  "restart-verify", "status", "rollback",
]);
const DIGEST_OPERATIONS = new Set([
  "backup", "stage", "verify", "cutover", "restart-verify", "rollback",
]);

class MigrationCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArguments(argv) {
  const operation = argv[0];
  if (!OPERATIONS.has(operation)) {
    throw new MigrationCommandError("usage", "A valid migration operation is required.");
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--root", "--source-digest"].includes(name) || !value) {
      throw new MigrationCommandError("usage", `Invalid or incomplete argument: ${name || "<missing>"}.`);
    }
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      throw new MigrationCommandError("usage", `Duplicate argument: ${name}.`);
    }
    options[name] = value;
  }
  if (!options["--root"]) {
    throw new MigrationCommandError("usage", "--root <knowledge-root> is required.");
  }
  const sourceDigest = options["--source-digest"];
  if (DIGEST_OPERATIONS.has(operation) && !/^[a-f0-9]{64}$/.test(sourceDigest || "")) {
    throw new MigrationCommandError(
      "source-digest-required",
      `${operation} requires --source-digest with the exact digest returned by preview.`,
    );
  }
  const requestedRoot = path.resolve(options["--root"]);
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
    throw new MigrationCommandError("knowledge-root-not-found", "Knowledge Root does not exist.");
  }
  return { operation, root: fs.realpathSync(requestedRoot), sourceDigest };
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function backupDirectory(stateRoot) {
  return path.join(stateRoot, "recipe-store-migration", "backups");
}

function backupsFor(stateRoot, sourceDigest) {
  const directory = backupDirectory(stateRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name.startsWith(`${sourceDigest}.`) && name.endsWith(".projects.json"))
    .map(name => path.join(directory, name))
    .sort();
}

function requireBackup(stateRoot, sourceDigest) {
  const backups = backupsFor(stateRoot, sourceDigest);
  if (!backups.length) {
    throw new MigrationCommandError(
      "migration-backup-required",
      "Create an immutable backup for the previewed source before staging or cutover.",
    );
  }
  return backups;
}

function createBackup(stateRoot, sourceDigest, preview) {
  if (preview.sourceDigest !== sourceDigest) {
    throw new MigrationCommandError("migration-source-changed", "Legacy Recipe source changed after preview.");
  }
  const sourcePath = path.join(stateRoot, "projects.json");
  const content = fs.readFileSync(sourcePath);
  const fileDigest = hash(content);
  const directory = backupDirectory(stateRoot);
  const backupPath = path.join(directory, `${sourceDigest}.${fileDigest}.projects.json`);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(backupPath)) {
    if (hash(fs.readFileSync(backupPath)) !== fileDigest) {
      throw new MigrationCommandError("migration-backup-corrupt", "Existing migration backup failed checksum validation.");
    }
  } else {
    const descriptor = fs.openSync(backupPath, "wx", 0o400);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(backupPath, 0o400);
  }
  return {
    sourceDigest,
    fileDigest,
    backupPath,
    bytes: content.length,
    mode: (fs.statSync(backupPath).mode & 0o777).toString(8).padStart(3, "0"),
  };
}

function sourceInventory(stateRoot) {
  const sourcePath = path.join(stateRoot, "projects.json");
  if (!fs.existsSync(sourcePath)) {
    throw new MigrationCommandError("legacy-source-not-found", "Legacy projects.json source does not exist.");
  }
  const content = fs.readFileSync(sourcePath);
  const envelope = JSON.parse(content.toString("utf8"));
  const state = envelope?.payload?.state || {};
  return {
    sourcePath,
    fileDigest: hash(content),
    bytes: content.length,
    containsLegacyRecipes: Object.prototype.hasOwnProperty.call(state, "recipes"),
    containsLegacyRecipeFolders: Object.prototype.hasOwnProperty.call(state, "recipeFolders"),
    containsLegacyRecipeTrash: Object.prototype.hasOwnProperty.call(state, "recipeTrash"),
  };
}

function execute(argv) {
  const { operation, root, sourceDigest } = parseArguments(argv);
  const stateRoot = path.join(root, ".pkm", "state");
  const projectStore = new ProjectStore(stateRoot, crypto.randomUUID, { autoMigrate: false });
  const recipeStore = new RecipeFilesystemStore(stateRoot);

  if (operation === "status") {
    const snapshot = recipeStore.list();
    return {
      operation,
      root,
      migration: recipeStore.migrationStatus() || null,
      canonical: {
        exists: recipeStore.hasCanonicalStore(),
        active: snapshot.recipes.length,
        trash: snapshot.trash.length,
        categories: snapshot.categories.length,
        diagnostics: snapshot.diagnostics,
      },
      backups: fs.existsSync(backupDirectory(stateRoot))
        ? fs.readdirSync(backupDirectory(stateRoot)).sort()
        : [],
    };
  }

  if (operation === "restart-verify") {
    const receipt = new RecipeFilesystemStore(stateRoot).verifyCutover(sourceDigest);
    const inventory = sourceInventory(stateRoot);
    if (inventory.containsLegacyRecipes || inventory.containsLegacyRecipeFolders
      || inventory.containsLegacyRecipeTrash) {
      throw new MigrationCommandError(
        "migration-legacy-source-active",
        "projects.json still contains legacy Recipe authority after cutover.",
      );
    }
    return { operation, root, receipt, source: inventory };
  }

  const preview = projectStore.migrateLegacyRecipes("preview");
  if (operation === "inspect") {
    return {
      operation,
      root,
      source: sourceInventory(stateRoot),
      preview,
      migration: recipeStore.migrationStatus() || null,
      backups: backupsFor(stateRoot, preview.sourceDigest),
    };
  }
  if (operation === "preview") return { operation, root, receipt: preview };
  if (operation === "backup") {
    return { operation, root, backup: createBackup(stateRoot, sourceDigest, preview) };
  }

  if (preview.sourceDigest !== sourceDigest) {
    throw new MigrationCommandError("migration-source-changed", "Legacy Recipe source changed after preview.");
  }
  if (operation === "stage") {
    requireBackup(stateRoot, sourceDigest);
    return {
      operation,
      root,
      receipt: projectStore.migrateLegacyRecipes("stage", { sourceDigest }),
    };
  }
  if (operation === "verify") {
    return {
      operation,
      root,
      receipt: projectStore.migrateLegacyRecipes("verify", { sourceDigest }),
    };
  }
  if (operation === "cutover") {
    requireBackup(stateRoot, sourceDigest);
    const status = recipeStore.migrationStatus();
    if (!status || !["verified", "cutover"].includes(status.phase) || status.sourceDigest !== sourceDigest) {
      throw new MigrationCommandError(
        "migration-verification-required",
        "Explicit verify must succeed for this source before cutover.",
      );
    }
    return {
      operation,
      root,
      receipt: projectStore.migrateLegacyRecipes("cutover", { sourceDigest }),
    };
  }
  return {
    operation,
    root,
    receipt: projectStore.migrateLegacyRecipes("rollback", { sourceDigest }),
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...execute(argv) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error?.code || "migration-command-failed",
        message: error instanceof Error ? error.message : String(error),
        diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [],
      },
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { execute, main, parseArguments };
