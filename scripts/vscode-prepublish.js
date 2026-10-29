#!/usr/bin/env node
// vsce always runs vscode:prepublish; the package gate has already built and tested this tree.
const path = require("path");
const { spawnSync } = require("child_process");

if (process.env.PKM_PACKAGE_PREBUILT === "1") {
  console.log("Skipping vscode:prepublish build: the package gate already built and verified dist/.");
  process.exit(0);
}
const root = path.join(__dirname, "..");
for (const [command, args] of [[process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]], [process.execPath, ["tests/test-ui-build-artifacts.js"]]]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
