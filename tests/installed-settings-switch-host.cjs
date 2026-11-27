const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.activate = context => setImmediate(() => void run(context));
async function run(context) {
  const base = process.env.PKM_UPGRADE_BASE;
  const write = (name, value) => fs.writeFileSync(path.join(base, name), JSON.stringify(value));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, deadline = Date.now() + 60_000) {
    while (Date.now() < deadline) {
      const observed = await fn();
      if (observed) return observed;
      await wait(100);
    }
    throw new Error("Installed Settings switch observation timed out.");
  }
  async function automaticStartup() {
    return until(() => {
      const directory = path.dirname(context.logUri.fsPath);
      for (const filename of fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith(".log"))) {
        const text = fs.readFileSync(path.join(directory, filename), "utf8");
        if (text.includes("PKM MCP automatic startup: ready")) return text;
      }
      return undefined;
    }, Date.now() + 120_000);
  }
  try {
    const extension = vscode.extensions.getExtension("uone.personal-knowledge");
    assert.match(process.env.PKM_UPGRADE_CANDIDATE_VERSION || "", /^5\.\d+\.\d+$/);
    assert(extension && extension.packageJSON.version === process.env.PKM_UPGRADE_CANDIDATE_VERSION);
    assert.equal(process.env.PKM_COMPATIBILITY_LIVE_SWITCH, undefined);
    await extension.activate();
    if (process.env.PKM_SWITCH_UNMANAGED === "1") {
      assert.equal(process.env.PKM_COMPATIBILITY_LIVE_SWITCH, undefined);
      const status = await vscode.commands.executeCommand("_personalKnowledge.pkmCompatibilityRouteStatus");
      assert.equal(status.phase, "unavailable");
      assert.equal(status.reason, "custodyUnavailable");
      assert.equal(status.selected, null);
      await assert.rejects(() => Promise.resolve(vscode.commands.executeCommand("personalKnowledge.startPkmMcp")),
        /Compatibility custody belongs to another window or requires recovery/);
      write("settings-peer-refused.json", { hostPid: process.pid, status, nativeStartRefused: true });
      await until(() => fs.existsSync(path.join(base, "close-settings-peer")));
      await vscode.commands.executeCommand("workbench.action.quit");
      return;
    }
    if (process.env.PKM_SWITCH_PEER === "1") {
      await automaticStartup();
      await vscode.commands.executeCommand("personalKnowledge.openApiChat");
      const observed = await until(async () => {
        try { return await observe("original"); } catch { return undefined; }
      });
      const status = await vscode.commands.executeCommand("_personalKnowledge.pkmCompatibilityRouteStatus");
      assert.equal(status.phase, "selected");
      assert.equal(observed.native.originalConnection.attribution.extensionHostPid, process.pid);
      assert.equal(observed.chat.originalConnection.attribution.extensionHostPid, process.pid);
      write("settings-peer-admitted.json", { hostPid: process.pid, status, observed, nativeStartAdmitted: true });
      const departure = await until(() => {
        if (fs.existsSync(path.join(base, "close-settings-peer"))) return "close";
        if (fs.existsSync(path.join(base, "settings-owner-closing.json"))) return "owner";
        return undefined;
      });
      if (departure === "owner") {
        const owner = JSON.parse(fs.readFileSync(path.join(base, "settings-owner-closing.json"), "utf8"));
        await until(() => {
          try { process.kill(owner.hostPid, 0); return false; }
          catch (error) { if (error.code === "ESRCH") return true; throw error; }
        });
        const afterOwner = await observe("original");
        for (const role of ["native", "chat"]) {
          assert.deepEqual(afterOwner[role].originalConnection, observed[role].originalConnection);
          assert.deepEqual(afterOwner[role].routeRuntime, observed[role].routeRuntime);
        }
        write("settings-peer-after-owner.json", { hostPid: process.pid, departedHostPid: owner.hostPid, observed: afterOwner });
        await vscode.commands.executeCommand("personalKnowledge.setupMcp");
        write("settings-peer-owner-departure-ready.json", { hostPid: process.pid });
        const peerPhase = async (label, mode) => {
          const action = await until(() => fs.existsSync(path.join(base, "close-settings-peer")) ? "close"
            : fs.existsSync(path.join(base, `settings-peer-switch-${label}.json`)) ? "switch" : undefined);
          if (action === "close") return undefined;
          const result = await observe(mode);
          for (const role of ["native", "chat"]) {
            assert.deepEqual(result[role].originalConnection, observed[role].originalConnection);
            assert.equal(result[role].routeRuntime.instanceId, observed[role].routeRuntime.instanceId);
          }
          write(`settings-peer-observed-${label}.json`, result);
          return result;
        };
        const v5 = await peerPhase("v5", "bundled-v5");
        if (v5) {
          const returned = await peerPhase("returned", "original");
          if (returned) write("settings-peer-owner-departure.json", { afterOwner, v5, returned,
            peerRemainedOperational: true, bothBackendsRead: true, identitiesPreserved: true });
        }
      }
      await until(() => fs.existsSync(path.join(base, "close-settings-peer")));
      await vscode.commands.executeCommand("workbench.action.quit");
      return;
    }
    const automaticTrace = await automaticStartup();
    write("settings-native-started.json", { hostPid: process.pid, source: "activation",
      beforeSetupAndToolInvocation: true, explicitStartExecuted: false,
      startupTrace: automaticTrace.split("\n").filter(line => line.includes("PKM MCP automatic startup: ready")) });
    await vscode.commands.executeCommand("personalKnowledge.setupMcp");
    await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction");
    const restoredStartup = await until(() => {
      const directory = path.dirname(context.logUri.fsPath);
      const files = fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith(".log"));
      for (const filename of files) {
        const text = fs.readFileSync(path.join(directory, filename), "utf8");
        if (text.includes("PKM Chat first state:") && text.includes("PKM MCP discovery: elapsedMs=")) return text;
      }
      return undefined;
    });
    const restoredStatus = await vscode.commands.executeCommand("_personalKnowledge.pkmCompatibilityRouteStatus");
    assert.equal(restoredStatus.phase, "selected");
    const restoredChat = await vscode.commands.executeCommand("_personalKnowledge.observeChatGateway");
    assert.equal(restoredChat.dispatchMode, "original");
    assert.equal(restoredChat.version, "2.19.0");
    assert.equal(restoredChat.originalConnection.attribution.source, "pkm-chat");
    assert.equal(restoredChat.originalConnection.attribution.extensionHostPid, process.pid);
    write("settings-restored-startup.json", { source: "restored-chat-ready", hostPid: process.pid,
      status: restoredStatus, observed: restoredChat,
      startupTrace: restoredStartup.split("\n").filter(line =>
        /PKM Chat first state:|PKM MCP preparation|PKM MCP discovery/.test(line)) });
    write("settings-awaiting-status.json", { hostPid: process.pid });
    await until(() => fs.existsSync(path.join(base, "settings-ui-auto-status.json")), Date.now() + 100_000);
    await vscode.commands.executeCommand("personalKnowledge.openApiChat");
    const first = await until(async () => {
      try { return await observe("original"); } catch { return undefined; }
    });
    const phase = async (label, mode) => {
      await until(() => fs.existsSync(path.join(base, `settings-switch-${label}.json`)));
      const result = await observe(mode);
      assert.equal(result.native.routeRuntime.instanceId, first.native.routeRuntime.instanceId);
      assert.equal(result.chat.routeRuntime.instanceId, first.chat.routeRuntime.instanceId);
      for (const role of ["native", "chat"]) assert.deepEqual(result[role].originalConnection, first[role].originalConnection);
      write(`settings-observed-${label}.json`, result);
      if (label === "v5") await enrollBrowser(label);
      return result;
    };
    async function enrollBrowser(label) {
      const url = await vscode.commands.executeCommand("personalKnowledge.openOriginalBrowser");
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/webview\/$/);
      const token = await vscode.env.clipboard.readText();
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      await vscode.env.clipboard.writeText("");
      fs.writeFileSync(path.join(base, "browser-enrollment.json"), JSON.stringify({ label, url, token }),
        { mode: 0o600, flag: "wx" });
      await until(() => fs.existsSync(path.join(base, `settings-browser-read-${label}`)));
    }
    async function observe(mode) {
      const value = await vscode.lm.invokeTool("mcp_pkm_check_version", { input: {} }, undefined);
      const native = JSON.parse(value.content.map(part => part.value ?? "").join(""));
      const chat = await vscode.commands.executeCommand("_personalKnowledge.observeChatGateway");
      assert.equal(native.dispatchMode, mode);
      assert.equal(chat?.dispatchMode, mode);
      assert.equal(native.version, chat.version);
      assert.equal(native.runtime.generation, chat.runtime.generation);
      assert.equal(native.routeRuntime.generation, chat.routeRuntime.generation);
      assert.notEqual(native.routeRuntime.instanceId, chat.routeRuntime.instanceId);
      assert.equal(native.originalConnection.attribution.source, "vscode-provider");
      assert.equal(chat.originalConnection.attribution.source, "pkm-chat");
      const read = await vscode.lm.invokeTool("mcp_pkm_capability_read", { input: {
        operation: "mcp.tool.get_note", version: 1, arguments: { slug: "InstalledGatewayNote" },
      } }, undefined);
      const note = read.content.map(part => part.value ?? "").join("");
      assert.match(note, /InstalledGatewayNote/);
      return { native, chat };
    }
    await vscode.commands.executeCommand("personalKnowledge.setupMcp");
    write("settings-observed-original.json", first);
    await enrollBrowser("original");
    const cancelled = await phase("cancelled", "original");
    const v5 = await phase("v5", "bundled-v5");
    const returned = await phase("returned", "original");
    assert.notEqual(first.native.version, v5.native.version);
    assert.equal(first.native.version, returned.native.version);
    await until(() => fs.existsSync(path.join(base, "settings-browser-coexistence.json")));
    const browser = JSON.parse(fs.readFileSync(path.join(base, "settings-browser-coexistence.json"), "utf8"));
    assert.deepEqual(browser, { bothBackendsRead: true, grantsRevokedOnSwitch: true });
    write("installed-settings-switch.json", { hostPid: process.pid, first, cancelled, v5, returned, browser });
    await until(() => fs.existsSync(path.join(base, "settings-peer-admitted.json")));
    const whilePeerOpen = await observe("original");
    for (const role of ["native", "chat"]) {
      assert.deepEqual(whilePeerOpen[role].routeRuntime, returned[role].routeRuntime);
      assert.deepEqual(whilePeerOpen[role].originalConnection, returned[role].originalConnection);
    }
    write("settings-owner-after-peer.json", whilePeerOpen);
    await until(() => fs.existsSync(path.join(base, "close-settings-candidate")));
    write("settings-owner-closing.json", { hostPid: process.pid });
    await vscode.commands.executeCommand("workbench.action.quit");
  } catch (error) {
    write(process.env.PKM_SWITCH_PEER === "1" ? "settings-peer-failure.json" : "upgrade-failure.json",
      { message: error.message, stack: error.stack });
  }
}
