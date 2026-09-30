#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
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