#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const { verifyLayout } = require(path.join(root, "scripts", "organize-source.js"));
verifyLayout(root, true);
const runtime = require(path.join(root, "dist", "runtime", "extension-host-runtime.js"));
const build = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"));
assert.strictEqual(runtime.loadedExtensionBuild?.buildId, build.buildId,
  "the moved runtime module must capture this extension's build, not its domain directory");
assert.strictEqual(require(path.join(root, "dist", "extension-host-runtime.js")), runtime,
  "legacy runtime entries must share the domain module instance");
const { REQUIRED_UI_ARTIFACTS, validateUiArtifacts } = require(path.join(root, "scripts", "verify-ui-artifacts.js"));

assert.strictEqual(validateUiArtifacts(root), REQUIRED_UI_ARTIFACTS.length + 1,
  "the current build must contain every required UI artifact");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-ui-artifacts-"));
try {
  for (const relativePath of REQUIRED_UI_ARTIFACTS) {
    const artifactPath = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "fixture");
  }
  const fontPath = path.join(fixture, "dist", "webview", "fonts", "fixture.woff2");
  fs.mkdirSync(path.dirname(fontPath), { recursive: true });
  fs.writeFileSync(fontPath, "fixture");

  assert.strictEqual(validateUiArtifacts(fixture), REQUIRED_UI_ARTIFACTS.length + 1);
  fs.rmSync(path.join(fixture, "dist", "extension.js"));
  assert.throws(() => validateUiArtifacts(fixture), /dist\/extension\.js/,
    "validation must fail when the extension entry point is missing");

  fs.writeFileSync(path.join(fixture, "dist", "extension.js"), "fixture");
  fs.writeFileSync(path.join(fixture, "dist", "webview", "panel.html"), "");
  assert.throws(() => validateUiArtifacts(fixture), /dist\/webview\/panel\.html/,
    "validation must fail when a required UI artifact is empty");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

const manifest = require(path.join(root, "package.json"));
assert(manifest.scripts["vscode:prepublish"].includes("test-ui-build-artifacts.js"),
  "VS Code packaging must run the UI artifact regression test");

console.log("UI build artifact tests passed");

const chatFixture = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-bundle-"));
try {
  for (const name of ["api-chat-tools.js", "api-chat-mcp.js"]) fs.copyFileSync(path.join(root, "dist", name), path.join(chatFixture, name));
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    const original = Module._load;
    Module._load = function(name, ...args) { return name === "vscode" ? {} : original.call(this, name, ...args); };
    const directory = process.argv[1];
    assert.equal(typeof require(directory + "/api-chat-tools.js").createBuiltinTools, "function");
    assert.equal(typeof require(directory + "/api-chat-mcp.js").createVscodeTools, "function");
  `, chatFixture], { cwd: chatFixture, env: {}, stdio: "pipe" });
} finally { fs.rmSync(chatFixture, { recursive: true, force: true }); }
console.log("Chat bundled dependencies load without workspace node_modules");