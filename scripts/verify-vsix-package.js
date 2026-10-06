#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");
const { REQUIRED_UI_ARTIFACTS } = require("./verify-ui-artifacts");

const [vsixPath, expectedVersion, expectedChannel] = process.argv.slice(2);
assert(vsixPath && expectedVersion && ["stable", "pre-release"].includes(expectedChannel),
  "usage: verify-vsix-package.js <vsix> <version> <stable|pre-release>");

function unzip(args) {
  const result = spawnSync("unzip", args, { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || `unzip ${args.join(" ")} failed`);
  return result.stdout;
}

const manifest = unzip(["-p", vsixPath, "extension.vsixmanifest"]);
const packageJson = JSON.parse(unzip(["-p", vsixPath, "extension/package.json"]));
const entries = unzip(["-Z1", vsixPath]).split(/\r?\n/).filter(Boolean);
const identityTag = manifest.match(/<Identity\b[^>]*\/>/)?.[0] || "";
const attributes = Object.fromEntries([...identityTag.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const preRelease = /<Property\b(?=[^>]*\bId="Microsoft\.VisualStudio\.Code\.PreRelease")(?=[^>]*\bValue="true")[^>]*\/>/.test(manifest);

assert.strictEqual(attributes.Id, "personal-knowledge", "VSIX identity must target personal-knowledge");
assert.strictEqual(attributes.Publisher, "Uone", "VSIX identity must target publisher Uone");
assert.strictEqual(attributes.Version, expectedVersion, "VSIX manifest version must match the requested release");
assert.strictEqual(packageJson.version, expectedVersion, "embedded package.json version must match the requested release");
assert.strictEqual(preRelease, expectedChannel === "pre-release", "VSIX channel marker must match the requested release channel");

const buildInfo = JSON.parse(unzip(["-p", vsixPath, "extension/dist/build-info.json"]));
assert.strictEqual(buildInfo.schema, "pkm.extension-build/v1");
assert.strictEqual(buildInfo.version, expectedVersion);
assert(buildInfo.files && Object.keys(buildInfo.files).length > 0, "Runtime fingerprint must list its artifacts");
assert.strictEqual(buildInfo.buildId, createHash("sha256").update(JSON.stringify(buildInfo.files)).digest("hex"));
for (const [filename, digest] of Object.entries(buildInfo.files)) {
  assert(!path.isAbsolute(filename) && !filename.split("/").includes(".."), "Build artifact path must be relative");
  assert(entries.includes(`extension/${filename}`), `Fingerprinted artifact must be packaged: ${filename}`);
  const bytes = spawnSync("unzip", ["-p", vsixPath, `extension/${filename}`], { maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(bytes.status, 0, `Cannot read fingerprinted artifact: ${filename}`);
  assert.strictEqual(createHash("sha256").update(bytes.stdout).digest("hex"), digest, `Packaged artifact fingerprint mismatch: ${filename}`);
}

for (const artifact of REQUIRED_UI_ARTIFACTS) {
  assert(entries.includes(`extension/${artifact}`), `VSIX must include required UI artifact: ${artifact}`);
}
assert(entries.some(entry => /^extension\/dist\/webview\/fonts\/[^/]+\.woff2$/.test(entry)),
  "VSIX must include the KaTeX fonts used by the UI");

const forbidden = entries.filter(entry => /^(extension\/(tests|docs|\.vscode|coverage|artifacts)\/|extension\/(?:bug|planning)\.md$|extension\/(?:[^/]+\/)*\.pytest_cache\/|extension\/scripts\/(?:verify-vsix-package|package-extension)\.js$)/.test(entry));
assert.deepStrictEqual(forbidden, [], `VSIX contains forbidden development files: ${forbidden.join(", ")}`);
assert.deepStrictEqual(entries.filter(entry => /^extension\/chat-e2e-[^/]+\//.test(entry)), [],
  "VSIX must exclude local Chat E2E reports and fixtures");
const forbiddenRecipePayloads = entries.filter(entry =>
  /^extension\/(?:resources\/)?recipes\//i.test(entry)
  || /\/Recipe Trash\//i.test(entry)
  || /\.recipe_[^/]*\.json$/i.test(entry));
assert.deepStrictEqual(forbiddenRecipePayloads, [],
  `VSIX contains Knowledge Root or personal Recipe payloads: ${forbiddenRecipePayloads.join(", ")}`);
assert.deepStrictEqual(entries.filter(entry => /^extension\/(?:next-step|retrieval-solutions)\//.test(entry)), [],
  "VSIX must exclude private planning and local model packages");
const systemRecipeInventoryPath = "extension/dist/system-recipes.inventory.json";
assert(entries.includes(systemRecipeInventoryPath), "VSIX must include the generated System Recipe inventory");
const systemRecipeInventory = JSON.parse(unzip(["-p", vsixPath, systemRecipeInventoryPath]));
assert.strictEqual(systemRecipeInventory.schema, "pkm.system-recipes.inventory/v1",
  "System Recipe inventory schema must be recognized");
assert(Array.isArray(systemRecipeInventory.recipes) && systemRecipeInventory.recipes.length > 0,
  "System Recipe inventory must declare packaged built-ins");
assert.strictEqual(new Set(systemRecipeInventory.recipes.map(recipe => recipe.key)).size,
  systemRecipeInventory.recipes.length, "System Recipe inventory keys must be unique");
assert.strictEqual(new Set(systemRecipeInventory.recipes.map(recipe => recipe.recipeId)).size,
  systemRecipeInventory.recipes.length, "System Recipe inventory IDs must be unique");
for (const recipe of systemRecipeInventory.recipes) {
  assert.strictEqual(recipe.systemKind, "built-in", `packaged Recipe must be built-in: ${recipe.key || "(missing key)"}`);
  assert.deepStrictEqual(recipe.tags, ["System"], `packaged Recipe must carry the System tag: ${recipe.key || "(missing key)"}`);
  assert(/^recipe_[0-9a-f]{32}$/.test(recipe.recipeId || ""), `packaged Recipe ID must be deterministic: ${recipe.key || "(missing key)"}`);
  assert(Number.isInteger(recipe.revision) && recipe.revision > 0, `packaged Recipe revision must be positive: ${recipe.key || "(missing key)"}`);
  assert(/^[0-9a-f]{64}$/.test(recipe.executableDigest || ""), `packaged Recipe digest must be pinned: ${recipe.key || "(missing key)"}`);
}
assert(systemRecipeInventory.recipes.some(recipe => recipe.key === "create-agent-snapshot"),
  "System Recipe inventory must include Create Agent Snapshot");
assert(entries.includes("extension/node_modules/ws/index.js"), "VSIX must include the ws runtime dependency used by Chatroom");
assert(entries.includes("extension/resources/windows/pkm-stdio-proxy.js"),
  "VSIX must include the Windows JavaScript stdio proxy");
assert(entries.includes("extension/resources/api_chat_control.py"),
  "VSIX must include the Agent-driven Chat MCP transport resource");
assert(entries.includes("extension/dist/chat/agent-control.js"),
  "VSIX must include the owning Extension Host Chat controller transport");
assert.deepStrictEqual(
  entries.filter(entry => /^extension\/resources\/windows\/.*\.exe$/i.test(entry)),
  [],
  "VSIX must not ship unsigned custom Windows launcher executables",
);

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-vsix-load-"));
try {
  unzip(["-q", vsixPath, "-d", isolatedRoot]);
  const isolatedExtension = path.join(isolatedRoot, "extension");
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require("assert");
    const path = require("path");
    const Module = require("module");
    const originalLoad = Module._load;
    Module._load = function(name, ...args) {
      if (name === "vscode") return {};
      return originalLoad.call(this, name, ...args);
    };
    for (const name of ["api-chat-client", "api-chat-mcp", "api-chat-tools", "api-chat-view", "api-chat-acceptance"]) {
      assert(Object.keys(require(path.join(process.argv[1], "dist", name + ".js"))).length > 0, name + " must load its exports");
    }
  `, isolatedExtension], {
    cwd: isolatedRoot,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.strictEqual(result.status, 0,
    `Packaged Chat modules must load without repository node_modules: ${result.stderr || result.error || result.stdout}`);
  console.log("VSIX package test: isolated Chat module dependency loading OK");
} finally {
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
}

console.log(`VSIX package test: Uone.personal-knowledge ${expectedVersion} (${expectedChannel}) metadata and boundaries OK`);