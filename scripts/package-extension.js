#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");
const manifest = require("../package.json");

const root = path.join(__dirname, "..");
const output = path.join(root, `personal-knowledge-${manifest.version}.vsix`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// --prebuilt: the caller already ran the build and tests, so vsce's prepublish hook can skip rebuilding.
const env = process.argv.includes("--prebuilt") ? { ...process.env, PKM_PACKAGE_PREBUILT: "1" } : process.env;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true, env });
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
