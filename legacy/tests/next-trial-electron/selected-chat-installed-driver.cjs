"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const vscode = require("vscode");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
  const root = process.env.PKM_SELECTED_FIXTURE;
  assert(root && path.isAbsolute(root));
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  assert(extension, "Installed PKM extension missing.");
  if (process.env.PKM_SELECTED_RESTART === "1" && process.env.PKM_SELECTED_RECOVERY !== "1"
    && process.env.PKM_SELECTED_SESSION_UI !== "1" && process.env.PKM_SELECTED_AFTER_TASK_UI !== "1"
    && process.env.PKM_SELECTED_PERMISSION_UI !== "1") {
    await extension.activate();
    await wait(5000);
    fs.writeFileSync(path.join(root, "restart-complete"), "done", { mode: 0o600 });
    await vscode.commands.executeCommand("workbench.action.closeWindow");
    await wait(2000);
    return;
  }
  const original = {
    showOpenDialog: vscode.window.showOpenDialog,
    showQuickPick: vscode.window.showQuickPick,
    showWarningMessage: vscode.window.showWarningMessage,
    showInformationMessage: vscode.window.showInformationMessage,
    showInputBox: vscode.window.showInputBox,
    showErrorMessage: vscode.window.showErrorMessage,
    showSaveDialog: vscode.window.showSaveDialog,
  };
  const sdkUi = process.env.PKM_SELECTED_SDK_UI === "1";
  const trace = value => {
    if (sdkUi) fs.appendFileSync(path.join(root, `sdk-phase${process.env.PKM_SELECTED_PHASE || "1"}-host-actions.log`),
      `${new Date().toISOString()} ${value}\n`, { mode: 0o600 });
  };
  let sdkRuntime, originalForStdio, originalGetSession;
  if (sdkUi) {
    const sdkDir = path.join(vscode.env.appRoot, "node_modules.asar", "@github", "copilot-sdk");
    const sdk = require(sdkDir);
    sdkRuntime = sdk.RuntimeConnection;
    originalForStdio = sdkRuntime.forStdio;
    sdkRuntime.forStdio = options => {
      assert.match(options.path, /copilot-sdk-linux-x64\/prebuilds\/linux-x64\/copilot-runtime$/);
      return originalForStdio({ path: process.execPath, args: [process.env.PKM_SELECTED_SDK_PROXY, process.env.PKM_SELECTED_SDK_URL] });
    };
    originalGetSession = vscode.authentication.getSession;
    vscode.authentication.getSession = async (provider, scopes) => {
      assert.equal(provider, "github");
      assert.deepEqual(scopes, ["user:email"]);
      return { accessToken: "fixture-only-token" };
    };
    fs.writeFileSync(path.join(root, "bundled-sdk.json"), JSON.stringify({
      sdkDir, version: require(path.join(sdkDir, "package.json")).version,
      redirectedToLocalRpcViaStdioProxy: true, syntheticToken: true,
    }), { mode: 0o600 });
  }
  const errors = [];
  vscode.window.showOpenDialog = async options => {
    const label = options.openLabel;
    if (label?.startsWith("Select an empty trial")) return [vscode.Uri.file(path.join(root, "trial"))];
    if (label === "Select local Node 22.18 or newer" || label === "Select one exact program")
      return [vscode.Uri.file(process.env.PKM_SELECTED_NODE)];
    if (label === "Select its exact working directory") return [vscode.Uri.file(path.join(root, "trial", "workspace"))];
    throw new Error(`Unexpected file dialog: ${label}`);
  };
  if (!sdkUi) vscode.window.showQuickPick = async (choices, options) => {
    if (options?.title === "Choose an original Chat for the independent Next workspace") {
      assert.equal(choices.length, 1);
      return choices[0];
    }
    if (options?.title === "Choose the independent Chat process scope")
      return choices.find(item => item.value === true);
    if (options?.title === "Choose the independent Chat model source")
      return choices.find(item => item.sdk === false);
    return undefined;
  };
  if (!sdkUi) vscode.window.showWarningMessage = async (message, _options, ...items) => {
    if (message.startsWith("Create a disposable PKM Next trial")) return "Create Trial";
    if (message.startsWith("Reopen this isolated selected Chat trial?")) return "Reopen Chat";
    if (message.startsWith("Open this Chat in the independent Next workspace?")) return "Open Independent Chat";
    if (message.startsWith("Reset remembered process approvals for this Chat?")) return "Reset and close Chat";
    if (message.startsWith("Complete current Task?")) return "Complete Task";
    if (message.startsWith("Abandon these uncertain intents without replay?")) return "Keep unknown; never replay";
    if (message.startsWith("Confirm this selected Chat unknown-outcome decision?")) return "Confirm unknown; never replay";
    if (process.env.PKM_SELECTED_REAL_SAVE === "1" && message === "Replace the selected image file?")
      return original.showWarningMessage(message, _options, ...items);
    throw new Error(`Unexpected confirmation: ${message}; ${items.join(", ")}`);
  };
  if (!sdkUi) vscode.window.showInformationMessage = async message => {
    if (message === "Next Chat remembered process approvals were reset. Reopen the Chat to continue.")
      fs.writeFileSync(path.join(root, "permission-reset-confirmed"), "done", { mode: 0o600 });
    return undefined;
  };
  if (sdkUi) vscode.window.showInformationMessage = (message, ...args) => {
    if (message === "Isolated PKM Next trial started. External writers remain unknown; no cutover was performed.") {
      trace("trial information invoked");
      fs.writeFileSync(path.join(root, "sdk-trial-information-shown"), "shown", { mode: 0o600 });
    }
    const result = original.showInformationMessage(message, ...args);
    if (message === "Isolated PKM Next trial started. External writers remain unknown; no cutover was performed.")
      Promise.resolve(result).then(() => trace("trial information resolved"), () => trace("trial information rejected"));
    return result;
  };
  vscode.window.showErrorMessage = async (message, ...args) => {
    errors.push(String(message));
    fs.writeFileSync(path.join(root, "driver-errors.json"), JSON.stringify(errors), { mode: 0o600 });
    if (sdkUi) return original.showErrorMessage(message, ...args);
  };
  if (!sdkUi && process.env.PKM_SELECTED_REAL_SAVE !== "1") {
    vscode.window.showSaveDialog = async options => {
      assert.equal(process.env.PKM_SELECTED_IMAGE_ONLY, "1");
      assert.deepEqual(options.filters, { Image: ["png"] });
      return vscode.Uri.file(path.join(root, "export.png"));
    };
  }
  if (!sdkUi) vscode.window.showInputBox = async options => {
    if (options?.password) return "selected-fixture-secret";
    if (options?.title === "Exact program arguments as a JSON string array")
      return JSON.stringify([path.join(root, "background.cjs")]);
    if (options?.title === "Start Task") return "Private selected Chat task";
    if (options?.title === "Unknown outcome review") return "Preserve the uncertain effect without replay.";
    throw new Error(`Unexpected input dialog: ${options?.title ?? options?.prompt}`);
  };
  try {
    await extension.activate();
    if (sdkUi) fs.writeFileSync(path.join(root,
      process.env.PKM_SELECTED_RESTART === "1" ? `sdk-phase${process.env.PKM_SELECTED_PHASE}-driver-ready` : "driver-ready"),
      "ready", { mode: 0o600 });
    if ((process.env.PKM_SELECTED_RECOVERY === "1" || process.env.PKM_SELECTED_SESSION_UI === "1"
      || process.env.PKM_SELECTED_AFTER_TASK_UI === "1" || process.env.PKM_SELECTED_PERMISSION_UI === "1")
      && process.env.PKM_SELECTED_RESTART === "1") {
      fs.writeFileSync(path.join(root, "restart-driver-ready"), "ready", { mode: 0o600 });
      trace("nextTrialStart begin");
      await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
      trace("nextTrialStart returned");
      assert.deepEqual(errors, [], errors.join("; "));
      fs.writeFileSync(path.join(root, "recovery-ui-ready"), "ready", { mode: 0o600 });
      if (process.env.PKM_SELECTED_PERMISSION_UI === "1")
        fs.writeFileSync(path.join(root, `permission-phase${process.env.PKM_SELECTED_PHASE}-ready`), "ready", { mode: 0o600 });
      const deadline = Date.now() + 180000;
      const marker = process.env.PKM_SELECTED_PERMISSION_UI === "1"
        ? `permission-phase${process.env.PKM_SELECTED_PHASE}-complete` : "recovery-ui-complete";
      while (!fs.existsSync(path.join(root, marker))) {
        if (Date.now() > deadline) throw new Error("Recovered renderer journey did not finish.");
        await wait(100);
      }
      assert.deepEqual(errors, [], errors.join("; "));
      fs.writeFileSync(path.join(root, "restart-complete"), "done", { mode: 0o600 });
      await vscode.commands.executeCommand("workbench.action.closeWindow");
      await wait(2000);
      return;
    }
    try {
      const models = await vscode.lm.selectChatModels();
      console.log("Private Code LM discovery", JSON.stringify({ available: true, count: models.length,
        vendors: [...new Set(models.map(model => model.vendor))] }));
    } catch {
      console.log("Private Code LM discovery unavailable");
    }
    if (!sdkUi) await vscode.commands.executeCommand("personalKnowledge.setAiKey");
    if (process.env.PKM_SELECTED_ORIGINAL_UI === "1") {
      if (!sdkUi) fs.writeFileSync(path.join(root, "driver-ready"), "ready", { mode: 0o600 });
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(path.join(root, "renderer-connected"))) {
        if (Date.now() > deadline) throw new Error("Renderer did not attach before original Chat opened.");
        await wait(100);
      }
      await vscode.commands.executeCommand("personalKnowledge.openApiChat",
        fs.readFileSync(path.join(root, "original-chat-locator"), "utf8"));
      assert.deepEqual(errors, [], errors.join("; "));
      fs.writeFileSync(path.join(root, "ui-ready"), "ready", { mode: 0o600 });
      const uiDeadline = Date.now() + 120000;
      while (!fs.existsSync(path.join(root, "ui-complete"))) {
        if (Date.now() > uiDeadline) throw new Error("Original UI did not finish.");
        await wait(100);
      }
      const fixtureTitle = process.env.PKM_SELECTED_AFTER_TASK_UI === "1" ? "New chat" : "ORIGINAL_UI_FIRST";
      assert(errors.every(message => message.startsWith(`PKM Chat [${fixtureTitle}]: response saved, but memory organization failed:`)
        || message.startsWith(`PKM Chat [${fixtureTitle}] failed: User Profile extraction failed:`)),
      `Unexpected original Chat error: ${errors.join("; ")}`);
      fs.writeFileSync(path.join(root, "host-complete"), "done", { mode: 0o600 });
      await vscode.commands.executeCommand("workbench.action.closeWindow");
      await wait(2000);
      return;
    }
    if (process.env.PKM_SELECTED_RECOVERY === "1")
      fs.writeFileSync(path.join(root, "extension-host-pid"), String(process.pid), { mode: 0o600 });
    trace("nextTrialStart begin");
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    trace("nextTrialStart returned");
    assert.deepEqual(errors, [], errors.join("; "));
    fs.writeFileSync(path.join(root, "driver-ready"), "ready", { mode: 0o600 });
    const attachDeadline = Date.now() + 30000;
    while (!fs.existsSync(path.join(root, "renderer-connected"))) {
      if (Date.now() > attachDeadline) throw new Error("Renderer did not attach before view creation.");
      await wait(100);
    }
    trace("openNextSelectedChat begin");
    await vscode.commands.executeCommand("personalKnowledge.openNextSelectedChat");
    trace("openNextSelectedChat returned");
    assert.deepEqual(errors, [], errors.join("; "));
    assert((await vscode.commands.getCommands(true)).includes("personalKnowledge.focusNextSelectedChat"),
      "Selected Chat UI registration was not retained.");
    if (process.env.PKM_SELECTED_IMAGE_ONLY !== "1") {
      const hosts = path.join(root, "legacy/.pkm/state/api-chat-control/hosts");
      const hostNames = fs.readdirSync(hosts).filter(name => /^[a-f0-9-]+\.json$/.test(name));
      assert.equal(hostNames.length, 1, "Expected the live installed Chat Host.");
      const hostFile = path.join(hosts, hostNames[0]);
      const previous = JSON.parse(fs.readFileSync(hostFile, "utf8"));
      let updated;
      const heartbeatDeadline = Date.now() + 10000;
      while (Date.now() < heartbeatDeadline) {
        await wait(100);
        const current = JSON.parse(fs.readFileSync(hostFile, "utf8"));
        if (current.updatedAt > previous.updatedAt) { updated = current; break; }
      }
      assert(updated, "Live installed Chat Host did not heartbeat after selected Chat opened.");
      assert.deepEqual({ ...updated, updatedAt: previous.updatedAt }, previous, "Host changed beyond its heartbeat.");
      console.log("Observed installed Chat Host heartbeat after selected snapshot admission.");
    }
    fs.writeFileSync(path.join(root, "ui-ready"), "ready", { mode: 0o600 });
    const deadline = Date.now() + (process.env.PKM_SELECTED_STEER === "1" ? 240000 : 120000);
    while (!fs.existsSync(path.join(root, process.env.PKM_SELECTED_RECOVERY === "1" ? "ui-crash-ready" : "ui-complete"))) {
      if (Date.now() > deadline) throw new Error("Renderer journey did not finish.");
      await wait(100);
    }
    if (process.env.PKM_SELECTED_RECOVERY === "1") {
      if (process.env.PKM_SELECTED_REVOKE === "1") {
        await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
        assert.deepEqual(errors, [], errors.join("; "));
        fs.writeFileSync(path.join(root, "host-complete"), "done", { mode: 0o600 });
        await vscode.commands.executeCommand("workbench.action.closeWindow");
        await wait(2000);
        return;
      }
      while (true) await wait(1000);
    }
    assert.deepEqual(errors, [], errors.join("; "));
    fs.writeFileSync(path.join(root, "host-complete"), "done", { mode: 0o600 });
    await vscode.commands.executeCommand("workbench.action.closeWindow");
    await wait(2000);
  } finally {
    Object.assign(vscode.window, original);
    if (sdkUi) {
      sdkRuntime.forStdio = originalForStdio;
      vscode.authentication.getSession = originalGetSession;
    }
  }
};
