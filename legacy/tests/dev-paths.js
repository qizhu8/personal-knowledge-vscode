// Development-only locations kept outside the extension tree, so vsce and file watchers never scan them.
const os = require("os");
const path = require("path");

/** Shared PKM environments root; matches the extension's default `personalKnowledge.environmentsPath`. */
const environmentsRoot = process.env.PKM_ENVIRONMENTS_PATH || path.join(os.homedir(), "pkm-envs");
/** Python venv used by repository tests (fastmcp, uone-prompt-manager, ...). */
const testVenv = process.env.PKM_TEST_VENV || path.join(environmentsRoot, "personal-knowledge-vscode-dev");
const testPython = process.env.PKM_TEST_PYTHON
  || path.join(testVenv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
/** @vscode/test-electron downloads and the bundled Xvfb. */
const vscodeTestCache = process.env.PKM_VSCODE_TEST_CACHE || path.join(os.homedir(), ".cache", "pkm-vscode-test");

module.exports = { environmentsRoot, testVenv, testPython, vscodeTestCache };
