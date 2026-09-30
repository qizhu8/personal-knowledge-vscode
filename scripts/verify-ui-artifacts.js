#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const REQUIRED_UI_ARTIFACTS = Object.freeze([
  "dist/extension.js",
  "dist/webview/panel.html",
  "dist/webview/panel.js",
  "dist/webview/panel.css",
  "dist/webview/codicon.css",
  "dist/webview/codicon.ttf",
  "dist/webview/marked.umd.js",
  "dist/webview/hljs.js",
  "dist/webview/hljs.css",
  "dist/webview/katex.js",
  "dist/webview/katex.css",
  "dist/webview/cytoscape.js",
  "dist/webview/mermaid.js",
  "dist/webview/forcegraph3d.js",
  "resources/sidebar-icon.svg",
]);

function validateUiArtifacts(root) {
  const missing = REQUIRED_UI_ARTIFACTS.filter((relativePath) => {
    const artifactPath = path.join(root, relativePath);
    try {
      return !fs.statSync(artifactPath).isFile() || fs.statSync(artifactPath).size === 0;
    } catch {
      return true;
    }
  });
  const fontsDir = path.join(root, "dist", "webview", "fonts");
  const hasKatexFont = fs.existsSync(fontsDir)
    && fs.readdirSync(fontsDir).some((name) => name.endsWith(".woff2") && fs.statSync(path.join(fontsDir, name)).size > 0);
  if (!hasKatexFont) missing.push("dist/webview/fonts/*.woff2");
  if (missing.length > 0) {
    throw new Error(`Required PKM UI artifacts are missing or empty:\n- ${missing.join("\n- ")}\nRun npm run build before launching or packaging the extension.`);
  }
  return REQUIRED_UI_ARTIFACTS.length + 1;
}

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const count = validateUiArtifacts(root);
  console.log(`UI artifact validation passed (${count} required outputs)`);
}

module.exports = { REQUIRED_UI_ARTIFACTS, validateUiArtifacts };