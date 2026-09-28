#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { KnowledgeV1Migration } = require("../dist/knowledge-migration");

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

function execute(argv) {
  const { operation, root, sourceDigest } = parseArguments(argv);
  const migration = new KnowledgeV1Migration(root);
  if (operation === "status") return { operation, root, migration: migration.status() || null };
  if (operation === "preview") return { operation, root, receipt: migration.preview() };
  if (operation === "inspect") {
    return { operation, root, preview: migration.preview(), migration: migration.status() || null };
  }
  const methods = {
    backup: "backup",
    stage: "stage",
    verify: "verify",
    cutover: "cutover",
    "restart-verify": "restartVerify",
    rollback: "rollback",
  };
  return { operation, root, receipt: migration[methods[operation]](sourceDigest) };
}

function main(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...execute(argv) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof MigrationCommandError;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: known ? error.code : "migration-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { execute, main, MigrationCommandError };
