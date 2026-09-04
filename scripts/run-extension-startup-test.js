#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const root = path.resolve(__dirname, "..");
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-startup-"));
  const userDataDir = path.join(testRoot, "user-data");
  const workspaceDir = path.join(testRoot, "workspace");
  const storeDir = path.join(testRoot, "knowledge");
  const settingsDir = path.join(userDataDir, "User");
  const logPath = path.join(userDataDir, "User", "globalStorage", "uone.personal-knowledge", "personal-knowledge.log");
  const resultPath = path.join(testRoot, "startup-result.json");

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
    "personalKnowledge.storePath": storeDir,
    "personalKnowledge.openOnStartup": false,
    "personalKnowledge.logLevel": "debug",
  }, null, 2));

  const packagedExtensionPath = packageExtension(root, testRoot);
  const virtualDisplay = await startVirtualDisplay(root);
  try {
    await runTests({
      version: "1.90.0",
      extensionDevelopmentPath: packagedExtensionPath,
      extensionTestsPath: path.join(root, "tests", "extension-startup"),
      extensionTestsEnv: {
        DISPLAY: virtualDisplay?.display || process.env.DISPLAY,
        PKM_STARTUP_LOG_PATH: logPath,
        PKM_STARTUP_RESULT_PATH: resultPath,
      },
      launchArgs: [
        workspaceDir,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${path.join(testRoot, "extensions")}`,
        "--disable-extensions",
        "--disable-gpu",
      ],
    });
    assertStartupResult(resultPath);
  } finally {
    virtualDisplay?.process.kill("SIGTERM");
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function packageExtension(root, testRoot) {
  const vsixPath = path.join(testRoot, "personal-knowledge.vsix");
  execFileSync("npx", ["vsce", "package", "--out", vsixPath], { cwd: root, stdio: "pipe" });
  execFileSync("unzip", ["-q", vsixPath, "-d", testRoot]);
  const extensionPath = path.join(testRoot, "extension");
  if (!fs.existsSync(path.join(extensionPath, "dist", "extension.js"))) {
    throw new Error("Packaged extension is missing dist/extension.js");
  }
  if (fs.existsSync(path.join(extensionPath, "node_modules", "ipaddr.js"))) {
    throw new Error("Startup test must not rely on a packaged ipaddr.js dependency");
  }
  return extensionPath;
}

async function startVirtualDisplay(root) {
  if (process.env.DISPLAY) return null;
  const bundled = path.join(root, ".vscode-test", "tools", "xvfb", "usr", "bin", "Xvfb");
  const system = spawnSync("which", ["Xvfb"], { encoding: "utf8" }).stdout.trim();
  const executable = fs.existsSync(bundled) ? bundled : system;
  if (!executable) throw new Error("Extension startup tests require DISPLAY or Xvfb. Install xvfb before running the release gate.");

  const displayNumber = Array.from({ length: 20 }, (_, index) => 90 + index)
    .find(number => !fs.existsSync(`/tmp/.X11-unix/X${number}`));
  if (displayNumber === undefined) throw new Error("No free X display number is available for the startup test");
  const display = `:${displayNumber}`;
  const child = spawn(executable, [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(socketPath)) {
    if (child.exitCode !== null) {
      throw new Error(`Xvfb exited before startup: ${stderr.trim()}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM");
      throw new Error("Timed out starting Xvfb for the extension startup test");
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { display, process: child };
}

function assertStartupResult(resultPath) {
  if (!fs.existsSync(resultPath)) throw new Error("VS Code exited without running the startup assertions");
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const required = ["activated", "commandsRegistered", "panelCreated", "webviewReady"];
  for (const key of required) {
    if (result[key] !== true) throw new Error(`Startup assertion did not pass: ${key}`);
  }
  console.log("Extension startup test: activation, commands, panel creation, and Webview ready handshake OK");
}

main().catch(error => {
  console.error("Extension startup test failed:", error);
  process.exitCode = 1;
});