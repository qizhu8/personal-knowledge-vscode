const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

exports.activate = () => setImmediate(() => void run());
async function run() {
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
  try {
    const extension = vscode.extensions.getExtension("uone.personal-knowledge");
    assert(extension && extension.packageJSON.version === "5.0.0");
    await extension.activate();
    if (process.env.PKM_SWITCH_PEER === "1") {
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
    await vscode.commands.executeCommand("personalKnowledge.startPkmMcp");
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
      return result;
    };
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
    const cancelled = await phase("cancelled", "original");
    const v5 = await phase("v5", "bundled-v5");
    const returned = await phase("returned", "original");
    assert.notEqual(first.native.version, v5.native.version);
    assert.equal(first.native.version, returned.native.version);
    write("installed-settings-switch.json", { hostPid: process.pid, first, cancelled, v5, returned });
    await until(() => fs.existsSync(path.join(base, "settings-peer-refused.json")));
    const whilePeerOpen = await observe("original");
    for (const role of ["native", "chat"]) {
      assert.deepEqual(whilePeerOpen[role].routeRuntime, returned[role].routeRuntime);
      assert.deepEqual(whilePeerOpen[role].originalConnection, returned[role].originalConnection);
    }
    write("settings-owner-after-peer.json", whilePeerOpen);
    await until(() => fs.existsSync(path.join(base, "close-settings-candidate")));
    await vscode.commands.executeCommand("workbench.action.quit");
  } catch (error) {
    write(process.env.PKM_SWITCH_PEER === "1" ? "settings-peer-failure.json" : "upgrade-failure.json",
      { message: error.message, stack: error.stack });
  }
}
