const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { runTests, downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { packageExtension, startVirtualDisplay } = require("./run-extension-startup-test");
const { stopFixtureServices } = require("./stop-fixture-services");

async function main() {
  const root = path.resolve(__dirname, ".."), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-ctx-host-"));
  let display, packaged;
  try {
    const user = path.join(temporary, "user"), extensions = path.join(temporary, "extensions");
    const workspace = path.join(temporary, "workspace"), knowledge = path.join(temporary, "knowledge");
    const home = path.join(temporary, "home");
    const environment = { HOME:home, XDG_CONFIG_HOME:path.join(home, ".config"), XDG_DATA_HOME:path.join(home, ".local", "share") };
    for (const directory of [path.join(user, "User"), workspace, knowledge, home]) fs.mkdirSync(directory, { recursive:true });
    fs.writeFileSync(path.join(user, "User", "settings.json"), JSON.stringify({
      "personalKnowledge.storePath":knowledge, "personalKnowledge.openOnStartup":false,
      "security.workspace.trust.enabled":false, "telemetry.telemetryLevel":"off",
      "update.mode":"none", "extensions.autoUpdate":false,
    }));
    packaged = packageExtension(root, temporary);
    display = await startVirtualDisplay(root);
    const executable = await downloadAndUnzipVSCode("1.90.0");
    execFileSync(path.join(path.dirname(executable), "bin", "code"), [
      "--install-extension", path.join(temporary, "personal-knowledge.vsix"),
      `--user-data-dir=${user}`, `--extensions-dir=${extensions}`, "--force",
    ], { env:{ ...process.env, ...environment, DISPLAY:display?.display || process.env.DISPLAY }, stdio:"pipe", timeout:60000 });
    const driver = path.join(temporary, "driver");
    fs.mkdirSync(driver);
    fs.writeFileSync(path.join(driver, "package.json"), JSON.stringify({
      name:"ctx-host-test-driver", publisher:"pkm-tests", version:"1.0.0", engines:{ vscode:"^1.90.0" },
    }));
    let first;
    for (const phase of ["initial", "restart"]) {
      const reservation = net.createServer();
      await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const debugPort = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      await runTests({
        vscodeExecutablePath:executable, extensionDevelopmentPath:driver,
        extensionTestsPath:path.join(root, "tests", "ctx-host"),
        extensionTestsEnv:{ ...environment, DISPLAY:display?.display || process.env.DISPLAY, PKM_CTX_ROOT:temporary, PKM_CTX_PHASE:phase,
          PKM_CTX_INSTALLED:packaged, PKM_PLAYWRIGHT_PATH:process.env.PKM_PLAYWRIGHT_PATH || "",
          PKM_CTX_NODE:process.execPath,
          PKM_TEST_PYTHON:process.env.PKM_TEST_PYTHON || "python",
          PKM_CTX_DEBUG_PORT:String(debugPort), PKM_VIS_ACCEPTANCE_OUTPUT:process.env.PKM_VIS_ACCEPTANCE_OUTPUT || "",
          PKM_CTX_CHROMIUM_PATH:process.env.PKM_CHROMIUM_EXECUTABLE || "",
          HTTP_PROXY:"http://127.0.0.1:9", HTTPS_PROXY:"http://127.0.0.1:9", NO_PROXY:"localhost,127.0.0.1" },
        launchArgs:[workspace, `--user-data-dir=${user}`, `--extensions-dir=${extensions}`, `--remote-debugging-port=${debugPort}`, "--disable-gpu", "--skip-welcome", "--skip-release-notes"],
      });
      const result = JSON.parse(fs.readFileSync(path.join(temporary, `${phase}.json`), "utf8"));
      assert(result.installed && result.webview && result.browser && result.nativeEnvelope && result.inlineVisualization && result.refinements === 1);
      assert(result.standaloneVisualization?.panels === 6 && result.standaloneVisualization.reopen && result.standaloneVisualization.recordChange);
      assert(result.liveVisualization?.recovered && result.liveVisualization.reopen && result.liveVisualization.requests === 4);
      assert(result.visualizationChain.tags.includes("terminal") && result.visualizationChain.tags.includes("recipe"));
      assert.equal(result.durableProcess.state, phase === "initial" ? "running" : "complete");
      if (!first) first = result;
      else {
        assert.notEqual(result.pid, first.pid);
        assert.equal(result.evidenceHash, first.evidenceHash);
        assert.equal(result.liveVisualization.evidenceHash, first.liveVisualization.evidenceHash);
        assert.equal(result.visualizationChain.evidenceHash, first.visualizationChain.evidenceHash);
        assert.equal(result.durableProcess.handle, first.durableProcess.handle);
        assert.equal(result.durableProcess.recovered, true);
      }
      console.log(`CTX-M18 installed Extension Host ${phase}: webview/browser, actual HTTP receipts and evidence OK`);
      console.log(`VIS installed ${phase}: ${result.liveVisualization.phases.join(" -> ")}, deny/approve-once/approve-once, six panels, reopen, once-only process effect; evidence=${result.liveVisualization.evidenceHash}`);
      console.log(`VIS runtime chain ${phase}: ${result.visualizationChain.tags.join(", ")}, ${result.visualizationChain.requests} model requests; evidence=${result.visualizationChain.evidenceHash}`);
    }
  } finally {
    try {
      if (packaged) await stopFixtureServices({
        fixtureRoot: temporary, extensionRoot: packaged,
        storage: path.join(temporary, "user", "User", "globalStorage", "uone.personal-knowledge"),
        knowledge: path.join(temporary, "knowledge"), home: path.join(temporary, "home"),
      });
      fs.rmSync(temporary, { recursive:true, force:true });
    } finally { display?.process.kill("SIGTERM"); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
