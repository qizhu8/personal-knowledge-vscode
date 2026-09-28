#!/usr/bin/env node
const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const run = (args) => cp.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const show = file => run(["show", `HEAD:${file}`]);
const semver = value => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : undefined;
};
const greater = (left, right) => {
  const a = semver(left), b = semver(right);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
};
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const versionFrom = (text, pattern, label) => {
  const match = pattern.exec(text);
  assert(match, `Could not read ${label}`);
  return match[1];
};

const changed = new Set([
  ...run(["diff", "--name-only", "HEAD", "--", "src", "resources", "scripts", "package.json", "package-lock.json"]).split("\n").filter(Boolean),
  ...run(["ls-files", "--others", "--exclude-standard", "--", "src", "resources", "scripts"]).split("\n").filter(Boolean),
]);
if (!changed.size) {
  console.log("version bump discipline: no product changes");
  process.exit(0);
}

const currentPackage = json("package.json").version;
const baselinePackage = JSON.parse(show("package.json")).version;
assert(greater(currentPackage, baselinePackage),
  `Product files changed, so package.json must increase beyond ${baselinePackage}; found ${currentPackage}`);
assert.strictEqual(json("package-lock.json").version, currentPackage, "package-lock.json version must match package.json");
assert.strictEqual(json("package-lock.json").packages[""].version, currentPackage, "lockfile root package version must match package.json");

const currentMcp = fs.readFileSync(path.join(root, "src", "mcp.ts"), "utf8");
const baselineMcp = show("src/mcp.ts");
const currentUnified = versionFrom(currentMcp, /UNIFIED_MCP_VERSION\s*=\s*"([^"]+)"/, "current unified MCP version");
const baselineUnified = versionFrom(baselineMcp, /UNIFIED_MCP_VERSION\s*=\s*"([^"]+)"/, "baseline unified MCP version");
const runtimeChanged = [...changed].some(file =>
  file === "src/mcp.ts" || file === "resources/retrieval_worker.py"
  || file === "resources/recipe_runtime.py" || file === "resources/agent_session_runtime.py");
if (runtimeChanged) {
  assert(greater(currentUnified, baselineUnified),
    `Bundled MCP/runtime sources changed, so UNIFIED_MCP_VERSION must increase beyond ${baselineUnified}; found ${currentUnified}`);
}

for (const [file, pattern, label] of [
  ["resources/recipe_runtime.py", /RECIPE_SCHEMA_VERSION\s*=\s*"([^"]+)"/, "Recipe runtime"],
  ["resources/agent_session_runtime.py", /AGENT_SESSION_SCHEMA_VERSION\s*=\s*"([^"]+)"/, "Agent Session runtime"],
]) {
  if (!changed.has(file)) continue;
  const current = versionFrom(fs.readFileSync(path.join(root, file), "utf8"), pattern, `current ${label} version`);
  const baseline = versionFrom(show(file), pattern, `baseline ${label} version`);
  assert(greater(current, baseline), `${label} changed, so its component version must increase beyond ${baseline}; found ${current}`);
}

console.log(`version bump discipline: extension ${baselinePackage} → ${currentPackage}, unified MCP ${baselineUnified} → ${currentUnified}`);
