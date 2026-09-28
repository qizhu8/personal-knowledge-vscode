#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");
const manifest = require("../package.json");

const root = path.join(__dirname, "..");
const output = path.join(root, `personal-knowledge-${manifest.version}.vsix`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(npx, ["vsce", "package", "--out", output]);
run(process.execPath, [
  path.join(__dirname, "verify-vsix-package.js"),
  output,
  manifest.version,
  "stable",
]);
