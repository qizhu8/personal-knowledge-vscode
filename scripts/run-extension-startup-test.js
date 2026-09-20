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

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  const navigationNoteDir = path.join(storeDir, "notes", "Project", "AAGL_Improvement", "Module Optimizer", "LP Processor");
  fs.mkdirSync(navigationNoteDir, { recursive: true });
  fs.writeFileSync(path.join(navigationNoteDir, "progress.md.md"), [
    "---",
    'title: "LPFeatureProcessor v1.1 Optimization Progress"',
    'type: "general"',
    "---",
    "fixture",
  ].join("\n"));
  const packagedExtensionPath = packageExtension(root, testRoot);
  const virtualDisplay = await startVirtualDisplay(root);
  try {
    const scenarios = [
      { name: "clean-install", openPanel: true },
      { name: "persisted-upgrade", openPanel: false },
      { name: "offline", openPanel: false, offline: true },
      { name: "malformed-state", openPanel: false, malformed: true },
      { name: "repeated-reload", openPanel: false },
    ];
    for (const scenario of scenarios) {
      fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
        "personalKnowledge.storePath": storeDir,
        "personalKnowledge.openOnStartup": scenario.openPanel,
        "personalKnowledge.logLevel": "debug",
      }, null, 2));
      if (scenario.malformed) injectMalformedState(userDataDir);
      fs.rmSync(logPath, { force: true });
      const resultPath = path.join(testRoot, `startup-result-${scenario.name}.json`);
      await runTests({
        version: "1.90.0",
        extensionDevelopmentPath: packagedExtensionPath,
        extensionTestsPath: path.join(root, "tests", "extension-startup"),
        extensionTestsEnv: {
          DISPLAY: virtualDisplay?.display || process.env.DISPLAY,
          PKM_STARTUP_LOG_PATH: logPath,
          PKM_STARTUP_RESULT_PATH: resultPath,
          PKM_STARTUP_SCENARIO: scenario.name,
          PKM_STARTUP_EXPECT_PANEL: String(scenario.openPanel),
          ...(scenario.offline ? {
            HTTP_PROXY: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            ALL_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "",
          } : {}),
        },
        launchArgs: [
          workspaceDir,
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${path.join(testRoot, "extensions")}`,
          "--disable-extensions",
          "--disable-gpu",
        ],
      });
      assertStartupResult(resultPath, scenario.name);
    }
  } finally {
    virtualDisplay?.process.kill("SIGTERM");
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function injectMalformedState(userDataDir) {
  const stateRoot = path.join(userDataDir, "User", "globalStorage", "uone.personal-knowledge");
  for (const relative of ["performance/metrics.json", "inventory/manifest.json", "subscriptions/subscriptions.json"]) {
    const target = path.join(stateRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{malformed-state");
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

function assertStartupResult(resultPath, scenario) {
  if (!fs.existsSync(resultPath)) throw new Error("VS Code exited without running the startup assertions");
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const required = ["activated", "commandsRegistered", "panelExpectationMet", "deepNavigationNoteVisible"];
  for (const key of required) {
    if (result[key] !== true) throw new Error(`Startup assertion did not pass: ${key}`);
  }
  if (!Number.isFinite(result.activationDurationMs)) throw new Error("Startup assertion did not report activationDurationMs");
  console.log(`Extension startup soak [${scenario}]: activation ${result.activationDurationMs}ms, commands, state, and panel expectation OK`);
}

main().catch(error => {
  console.error("Extension startup test failed:", error);
  process.exitCode = 1;
});