const { copyFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function stageBrowserWebview(source, target, version, copyTree) {
  const { webviewBundleFiles, webviewFont } = require("../dist/browser-release-gate.js");
  const fonts = readdirSync(join(source, "fonts")).filter(name => webviewFont.test(name)).sort();
  if (!fonts.length) throw new Error("Build the extension Webview before staging its browser payload.");
  for (const name of [...webviewBundleFiles, ...fonts.map(name => `fonts/${name}`)])
    copyTree(join(source, name), join(target, "bundle", name));
  writeFileSync(join(target, "release.json"), JSON.stringify({ schema: "pkm.packaged-webview/v1", version }) + "\n", { flag: "wx" });
}

function stageBrowserAdapters(source, target) {
  for (const name of ["webview-sign-in.js", "webview-adapter.js", "webview-chat.js"])
    copyFileSync(join(source, name), join(target, name));
}

module.exports = { stageBrowserWebview, stageBrowserAdapters };
