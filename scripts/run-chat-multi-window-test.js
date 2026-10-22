const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { runTests, downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { packageExtension, startVirtualDisplay } = require("./run-extension-startup-test");
const { stopFixtureServices } = require("./stop-fixture-services");

async function waitFor(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + description);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-chat-windows-"));
  const executions = [];
  let display, packaged, stop = false;
  try {
    const home = path.join(temporary, "home"), knowledge = path.join(temporary, "knowledge");
    const extensions = path.join(temporary, "extensions"), storage = path.join(temporary, "storage");
    for (const directory of [home, knowledge, storage]) fs.mkdirSync(directory, { recursive: true });
    const environment = {
      HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      USERPROFILE: home,
      HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1",
    };
    packaged = packageExtension(root, temporary);
    const runtime = path.join(temporary, "python-runtime");
    execFileSync(process.env.PKM_CHAT_TEST_PYTHON || "python3", ["-m", "venv", "--system-site-packages", runtime],
      { stdio: "pipe", timeout: 60000 });
    const python = path.join(runtime, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    execFileSync(python, ["-m", "pip", "install", "--no-index", "--no-deps",
      path.join(packaged, "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl")],
      { stdio: "pipe", timeout: 60000 });
    execFileSync(python, ["-c", "import fastmcp, prompt_manager, websockets, adaptive_skill_retrieval, cryptography"],
      { stdio: "pipe", timeout: 15000 });
    display = await startVirtualDisplay(root);
    environment.DISPLAY = display?.display || process.env.DISPLAY;
    const executable = await downloadAndUnzipVSCode(process.env.PKM_CHAT_VSCODE_VERSION || "stable");
    const installerUser = path.join(temporary, "installer-user");
    execFileSync(path.join(path.dirname(executable), "bin", "code"), [
      "--install-extension", path.join(temporary, "personal-knowledge.vsix"), `--user-data-dir=${installerUser}`,
      `--extensions-dir=${extensions}`, "--force",
    ], { env: { ...process.env, ...environment }, stdio: "pipe", timeout: 60000 });
    const { ApiChatStore } = require(path.join(packaged, "dist/chat/api-chat-store"));
    const store = new ApiChatStore(path.join(knowledge, ".pkm", "state"), "0123456789abcdef");
    const chat = store.create(); chat.permissionMode = "read-only"; chat.title = "Four-window offline fixture"; store.save(chat);
    const driver = path.join(temporary, "driver");
    fs.mkdirSync(driver);
    fs.writeFileSync(path.join(driver, "package.json"), JSON.stringify({
      name: "chat-window-test-driver", publisher: "pkm-tests", version: "1.0.0", engines: { vscode: "^1.90.0" },
    }));
    const users = [];
    for (let index = 0; index < 4; index++) {
      const user = path.join(temporary, "user-" + index), workspace = path.join(temporary, "workspace-" + index);
      fs.mkdirSync(path.join(user, "User", "globalStorage"), { recursive: true });
      fs.symlinkSync(storage, path.join(user, "User", "globalStorage", "uone.personal-knowledge"), "junction");
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(user, "User", "settings.json"), JSON.stringify({
        "personalKnowledge.storePath": knowledge, "personalKnowledge.openOnStartup": false,
        "personalKnowledge.mcpRuntimePath": runtime,
        "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none",
        "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
        "workbench.startupEditor": "none", "window.restoreWindows": "none",
      }));
      users.push({ user, workspace });
    }
    const launch = async (index, phase) => {
      const debugPort = await freePort();
      const { user, workspace } = users[index];
      const execution = runTests({
        vscodeExecutablePath: executable, extensionDevelopmentPath: driver,
        extensionTestsPath: path.join(root, "tests/chat-multi-window-host"),
        extensionTestsEnv: { ...environment, PKM_CHAT_WINDOWS_ROOT: temporary, PKM_CHAT_WINDOWS_INDEX: String(index),
          PKM_CHAT_WINDOWS_PHASE: phase, PKM_CHAT_DEBUG_PORT: String(debugPort),
          PKM_CHAT_FIXTURE_LOCATOR: `pkm://chats/${chat.workspaceNamespace}/${chat.id}`,
          PKM_CHAT_WINDOWS_REPORT: process.env.PKM_CHAT_WINDOWS_REPORT || "",
          PKM_PLAYWRIGHT_PATH: process.env.PKM_PLAYWRIGHT_PATH || "playwright" },
        launchArgs: [workspace, `--user-data-dir=${user}`, `--extensions-dir=${extensions}`,
          `--remote-debugging-port=${debugPort}`, "--disable-gpu", "--skip-welcome", "--skip-release-notes"],
      });
      executions.push(execution);
      execution.catch(() => { stop = true; });
      return { execution };
    };
    const windows = await Promise.all(Array.from({ length: 4 }, (_, index) => launch(index, "initial")));
    await waitFor(() => {
      if (stop) throw new Error("A VS Code window exited before the simultaneous-open barrier");
      return users.every((_, index) => fs.existsSync(path.join(temporary, `activated-${index}-initial`)));
    }, "four installed Hosts activated");
    fs.writeFileSync(path.join(temporary, "open-chat"), "");
    const resultPath = (index, phase) => path.join(temporary, `ready-${index}-${phase}.json`);
    await waitFor(() => {
      if (stop) throw new Error("A VS Code window failed while opening Chat");
      return users.every((_, index) => fs.existsSync(resultPath(index, "initial")));
    }, "four actual Chat Webviews and responsive Hosts");
    const results = users.map((_, index) => JSON.parse(fs.readFileSync(resultPath(index, "initial"), "utf8")));
    assert.equal(new Set(results.map(result => result.pid)).size, 4);
    assert.equal(new Set(results.map(result => result.workerPid)).size, 1, "four Hosts reuse one actual retrieval worker");
    assert.equal(new Set(results.map(result => result.workerPort)).size, 1, "one OS-assigned worker endpoint serves all windows");
    const hosts = path.join(knowledge, ".pkm/state/api-chat-control/hosts");
    assert.equal(fs.readdirSync(hosts).filter(name => name.endsWith(".json")).length, 4);
    fs.writeFileSync(path.join(temporary, "finish-0-initial"), "");
    await windows[0].execution;
    const restarted = await launch(0, "restart");
    await waitFor(() => {
      if (stop) throw new Error("Restarted VS Code window failed");
      return fs.existsSync(resultPath(0, "restart"));
    }, "one window restarted while three remain responsive");
    const after = JSON.parse(fs.readFileSync(resultPath(0, "restart"), "utf8"));
    assert.notEqual(after.pid, results[0].pid);
    assert.equal(after.workerPid, results[0].workerPid, "restarting a window does not replace the shared worker");
    fs.writeFileSync(path.join(temporary, "probe-survivors"), "");
    await waitFor(() => [1, 2, 3].every(index => fs.existsSync(path.join(temporary, `survived-${index}`))),
      "remaining windows respond after another window exits and restarts");
    for (let index = 1; index < 4; index++) fs.writeFileSync(path.join(temporary, `finish-${index}-initial`), "");
    fs.writeFileSync(path.join(temporary, "finish-0-restart"), "");
    await Promise.all([...windows.slice(1).map(window => window.execution), restarted.execution]);
    const report = { schema: "pkm.chat.multi-window/v1", windows: 4, actualInstalledHosts: true,
      simultaneousOpen: true, restartWithSurvivors: true, modelCalls: 0, results, restarted: after };
    if (process.env.PKM_CHAT_WINDOWS_REPORT) fs.writeFileSync(process.env.PKM_CHAT_WINDOWS_REPORT, JSON.stringify(report, null, 2));
    console.log("Installed four-window Chat acceptance: " + JSON.stringify(report));
  } finally {
    fs.writeFileSync(path.join(temporary, "abort"), "");
    await Promise.allSettled(executions);
    try {
      if (packaged) await stopFixtureServices({
        fixtureRoot: temporary, extensionRoot: packaged, storage: path.join(temporary, "storage"),
        knowledge: path.join(temporary, "knowledge"), home: path.join(temporary, "home"),
      });
    }
    finally { display?.process.kill("SIGTERM"); }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
