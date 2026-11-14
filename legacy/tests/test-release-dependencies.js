#!/usr/bin/env node
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = require(path.join(root, "package.json"));
const lockfile = require(path.join(root, "package-lock.json"));
const csvParser = require("csv-parse/sync");

assert.strictEqual(manifest.overrides["csv-parse"], "7.0.2", "release must retain the patched csv-parse override");
assert.strictEqual(lockfile.packages["node_modules/csv-parse"].version, "7.0.2", "lockfile must resolve the patched csv-parse version");
assert.deepStrictEqual(csvParser.parse("subject,action\nalice,read\n", { columns: true }), [
  { subject: "alice", action: "read" },
], "Casbin's csv-parse/sync API must remain compatible");

console.log("Release dependency test: patched csv-parse resolution and sync parser compatibility OK");