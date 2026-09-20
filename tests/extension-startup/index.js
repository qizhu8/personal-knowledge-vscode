const assert = require("assert");
const fs = require("fs");
const vscode = require("vscode");

async function waitFor(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function run() {
  const extension = vscode.extensions.getExtension("uone.personal-knowledge");
  assert.ok(extension, "Personal Knowledge extension was not discovered");

  await extension.activate();
  assert.strictEqual(extension.isActive, true, "extension did not activate");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("personalKnowledge.open"), "open command was not registered");
  assert.ok(commands.includes("personalKnowledge.setupMcp"), "config command was not registered");
  const navigation = await vscode.commands.executeCommand(
    "_personalKnowledge.testNavigationPath",
    "notes",
    ["Project", "AAGL_Improvement", "Module Optimizer", "LP Processor"],
  );
  assert.strictEqual(navigation.found, true, `Navigation hierarchy was missing: ${JSON.stringify(navigation)}`);
  const progress = navigation.children.find(item => item.description === "progress.md.md");
  assert.ok(progress, `progress.md.md was not visible under LP Processor: ${JSON.stringify(navigation.children)}`);
  assert.strictEqual(progress.label, "LPFeatureProcessor v1.1 Optimization Progress");
  assert.strictEqual(progress.relPath, "Project/AAGL_Improvement/Module Optimizer/LP Processor/progress.md.md");

  const expectPanel = process.env.PKM_STARTUP_EXPECT_PANEL === "true";
  if (expectPanel) await vscode.commands.executeCommand("personalKnowledge.open");
  const logPath = process.env.PKM_STARTUP_LOG_PATH;
  assert.ok(logPath, "startup log path was not provided");
  await waitFor(() => {
    if (!fs.existsSync(logPath)) return false;
    const log = fs.readFileSync(logPath, "utf8");
    return /activation complete durationMs=\d+/.test(log) && (!expectPanel || log.includes("panel created") && log.includes('handleMessage: ready'));
  }, expectPanel ? "Panel did not complete its Webview ready handshake" : "Extension activation did not complete with the panel closed");
  if (!expectPanel) await new Promise(resolve => setTimeout(resolve, 500));

  const resultPath = process.env.PKM_STARTUP_RESULT_PATH;
  assert.ok(resultPath, "startup result path was not provided");
  const startupLog = fs.readFileSync(logPath, "utf8");
  const durationMs = Number(/activation complete durationMs=(\d+)/.exec(startupLog)?.[1]);
  assert(Number.isFinite(durationMs), "activation duration metric was not recorded");
  const panelCreatedAt = startupLog.indexOf("panel created");
  const activationCompleteAt = startupLog.indexOf("activation complete durationMs=");
  if (expectPanel) assert(panelCreatedAt >= 0 && panelCreatedAt < activationCompleteAt, "the panel framework must appear before activation completes");
  else assert.strictEqual(panelCreatedAt, -1, `panel must remain closed during ${process.env.PKM_STARTUP_SCENARIO || "closed-panel startup"}`);
  fs.writeFileSync(resultPath, JSON.stringify({
    activated: extension.isActive,
    commandsRegistered: true,
    panelExpectationMet: expectPanel ? panelCreatedAt >= 0 && startupLog.includes('handleMessage: ready') : panelCreatedAt === -1,
    deepNavigationNoteVisible: true,
    activationDurationMs: durationMs,
  }));
}

module.exports = { run };