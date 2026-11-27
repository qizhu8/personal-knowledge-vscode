const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.activate = () => {
  const base = process.env.PKM_UPGRADE_BASE;
  const stage = (name, facts = {}) => fs.appendFileSync(path.join(base, "upgrade-milestones.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), name, ...facts }) + "\n");
  if (process.env.PKM_UPGRADE_BROWSER === "1") {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const started = Date.now();
      try { return await fetch(...args); }
      catch (error) {
        const url = new URL(args[0] instanceof Request ? args[0].url : args[0]);
        if (url.hostname === "127.0.0.1" && url.pathname.startsWith("/host/")) {
          const cause = error.cause;
          stage("private-request-failed", { route: url.pathname, elapsedMs: Date.now() - started,
            code: cause?.code, bytesRead: cause?.socket?.bytesRead, bytesWritten: cause?.socket?.bytesWritten });
          try {
            const probe = await fetch(new URL("/host/probe", url), {
              method: "POST", headers: args[1].headers, body: "{}", signal: AbortSignal.timeout(2000),
            });
            await probe.arrayBuffer();
            stage("private-owner-after-failure", { status: probe.status });
          } catch (probeError) {
            stage("private-owner-after-failure", { code: probeError.cause?.code, name: probeError.name });
          }
        }
        throw error;
      }
    };
  }
  setImmediate(() => void (async () => {
    const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
    assert.equal(extension.packageJSON.version, "5.0.0");
    assert.equal(vscode.extensions.getExtension("pkm-nonproduction.pkm-v5"), undefined);
    const transcript = process.env.PKM_UPGRADE_TRANSCRIPT === "1";
    await extension.activate();
    const capture = Symbol.for("pkm.test.captureOriginalChatShell");
    const chatShell = transcript ? globalThis[capture] : undefined;
    if (transcript) {
      delete globalThis[capture];
      assert(chatShell, "Fixture must observe the real installed shell registration");
    }
    const root = path.join(base, "library");
    assert.equal(vscode.workspace.getConfiguration("personalKnowledge").get("storePath"), root);
    const mcp = require(path.join(extension.extensionPath, "dist/mcp/mcp.js"));
    const deadline = Date.now() + 60_000;
    while (!mcp.mcpStatus().current && Date.now() < deadline) await delay(250);
    assert(mcp.mcpStatus().current, JSON.stringify(mcp.mcpStatus()));
    await vscode.commands.executeCommand("personalKnowledge.startPkmMcp");
    const tool = async (name, input) => {
      const id = `mcp_pkm_${name}`;
      const toolDeadline = Date.now() + 15_000;
      while (Date.now() < toolDeadline) {
        if (vscode.lm.tools.some(item => item.name === id)) {
          try {
            const response = await vscode.lm.invokeTool(id, { input }, undefined);
            return response.content.map(part => part.value ?? "").join("");
          } catch (error) {
            // The public tool list can still contain the predecessor while VS Code replaces its registrations.
            if (error.message !== `Tool ${id} was not contributed`) throw error;
          }
        }
        await delay(100);
      }
      assert.fail(      `Live tool unavailable: ${id}; available: ${vscode.lm.tools.map(item => item.name).filter(name => name.startsWith("mcp_")).join(", ")}`);
    };
    const liveVersion = async () => JSON.parse(await tool("check_version", {}));
    const version = await liveVersion();
    assert.match(version.runtime.runtimeBuild, /^[a-f0-9]{64}$/);
    const lifecycle = require(path.join(extension.extensionPath, "dist/mcp/mcp-lifecycle.js"));
    const expectGateway = process.env.PKM_UPGRADE_GATEWAY === "1";
    const originalBuild = lifecycle.bundledMcpBuildIdentity(extension.extensionPath);
    if (expectGateway) {
      assert.equal(version.dispatchMode, "original", "Production activation must preserve Original as the initial backend");
      assert.equal(version.version, mcp.UNIFIED_MCP_VERSION);
      assert.equal(version.runtime.runtimeBuild, originalBuild);
      assert.equal(version.runtime.extensionVersion, "5.0.0");
      assert.match(version.routeRuntime.runtimeBuild, /^[a-f0-9]{64}$/);
      assert.equal(version.routeRuntime.phase, "accepting");
      assert.equal(version.originalConnection.attribution.source, "vscode-provider");
    } else assert.equal(version.runtime.runtimeBuild, originalBuild);
    fs.writeFileSync(path.join(base, "upgrade-live-version.json"), JSON.stringify(version));
    const readOriginalNote = async () => assert.match(await tool("capability_read", {
      operation: "mcp.tool.get_note", version: 1, arguments: { slug: "InstalledGatewayNote" },
    }), expectGateway ? /Created by genuine installed 4\.0\.27 PKM Chat/
      : /Created by installed PKM Chat through the selected v5 gateway/);
    await readOriginalNote();
    if (process.env.PKM_UPGRADE_RESTART === "1") {
      assert(expectGateway);
      fs.writeFileSync(path.join(base, "upgrade-restart.json"), JSON.stringify({
        build: version.runtime.runtimeBuild, instance: version.runtime.instanceId,
        generation: version.runtime.generation, routeGeneration: version.routeRuntime.generation, noteRead: true,
      }));
      return;
    }

    // An active client must make the real repair reject before any Python
    // packages are changed. Its scoped maintenance markers must not survive.
    const verifyRejectedRepair = async () => {
      const managed = mcp.managedMcpServerDirectory(), runtime = mcp.managedMcpRuntimePath();
      const markers = [path.join(managed, "runtime-maintenance.json"), `${runtime}.pkm-maintenance.json`];
      assert.equal(runtime, path.join(base, "business-python"));
      assert(mcp.mcpProcessStatus(true).running, "The original connection must still be live before the repair attempt.");
      for (const marker of markers) assert(!fs.existsSync(marker), `Unexpected existing maintenance marker: ${marker}`);
      const active = path.join(managed, "active-generation.json"), generation = fs.readFileSync(active, "utf8");
      await assert.rejects(mcp.ensureMcpRuntime(undefined), /close\/reconnect all managed PKM clients/);
      for (const marker of markers) assert(!fs.existsSync(marker), `Leaked maintenance marker: ${marker}`);
      assert.equal(fs.readFileSync(active, "utf8"), generation);
      assert.equal((await liveVersion()).runtime.instanceId, version.runtime.instanceId);
      await readOriginalNote();
      stage("rejected-repair-native-reader-preserved");
    };
    if (!expectGateway) await verifyRejectedRepair();
    stage("native-note-read");
    if (!expectGateway) await vscode.commands.executeCommand("personalKnowledge.openNote", "InstalledGatewayNote.md");
    else stage("open-note-not-awaited", { reason: "independent native Note read verified" });
    stage("sidebar-focus-start");
    void vscode.commands.executeCommand("personalKnowledge.openApiChat", process.env.PKM_UPGRADE_CHAT)
      .then(() => stage("sidebar-focus-complete"), error => stage("sidebar-focus-error", { message: error.message }));
    if (expectGateway) {
      const read = async (operation, args = {}) => JSON.parse(await tool("capability_read", {
        operation: `mcp.tool.${operation}`, version: 1, arguments: args,
      }));
      const hostDeadline = Date.now() + 10_000;
      let liveHosts;
      stage("chat-host-capability-poll");
      do {
        const capability = await read("api_chat_capabilities");
        assert(capability.tools?.includes("api_chat_send"), JSON.stringify(capability));
        liveHosts = capability.hosts.filter(host => host.workspace_paths.includes(root) && host.operations.includes("send"));
        if (liveHosts.length) break;
        await delay(250);
      } while (Date.now() < hostDeadline);
      assert.equal(liveHosts.length, 1, "Exactly one live workspace Chat Host must advertise send");
      const hostId = liveHosts[0].host_id;
      stage("chat-host-registered", { hostId });
      if (transcript) {
        const chatId = process.env.PKM_UPGRADE_CHAT;
        const grant = Object.freeze({ actorId: "isolated-browser", workspaceRoot: root,
          generation: version.runtime.generation, chatHostId: hostId });
        const bind = given => chatShell.bindBrowserChatTranscript(given, current => {
          assert.equal(current.actorId, grant.actorId);
          assert.equal(current.workspaceRoot, root);
          assert.equal(current.generation, grant.generation);
        });
        assert.throws(() => bind({ ...grant, chatHostId: "00000000-0000-0000-0000-000000000001" }), /Host.*available/);
        const readTranscript = bind(grant);
        const unrelated = "00000000-0000-0000-0000-000000000002";
        await assert.rejects(readTranscript(grant, { chatId: unrelated }), /not available/);
        const first = await readTranscript({ ...grant }, { chatId, limit: 1 });
        assert(first.nextCursor);
        await assert.rejects(readTranscript(grant, { chatId: unrelated, cursor: first.nextCursor }), /not available/);
        const second = await readTranscript(grant, { chatId, cursor: first.nextCursor, limit: 1 });
        const prior = JSON.parse(fs.readFileSync(path.join(base, "host-evidence.json"), "utf8")).nativeSession.nativeChat.messages;
        assert.equal(prior.length, 2);
        assert.equal(second.nextCursor, null);
        assert.equal(second.start, 1);
        assert.deepEqual([...first.messages, ...second.messages], prior.map(({ id, role, content, status, recordedAt }) =>
          ({ id, role, content, status, ...(recordedAt ? { recordedAt } : {}) })));
        fs.writeFileSync(path.join(base, "upgrade-transcript.json"), JSON.stringify({
          messages: prior.length, chronological: true, exactHost: true, otherChatRejected: true, nativeConsent: true,
        }));
      }
      stage("chat-send-start");
      // Call the shipped, same-user IPC client. It validates the live host and owns
      // admission/deduplication; the installed Chat independently enforces tool policy.
      const dispatched = JSON.parse(execFileSync(mcp.resolveMcpPython(), ["-B", "-c", `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from api_chat_control import register_api_chat_tools
class Registration:
    def tool(self, **kwargs):
        return lambda fn: fn
tools = register_api_chat_tools(Registration(), Path(sys.argv[2]))
print(json.dumps(tools["api_chat_send"](sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])))
`, path.join(extension.extensionPath, "resources"), root, hostId, process.env.PKM_UPGRADE_CHAT,
      "BUNDLED_GATEWAY_READBACK: read the existing Note using PKM.", "installed-bundled-readback"],
      { encoding: "utf8", timeout: 5000 }));
      assert.match(dispatched.request_id, /^[0-9a-f]{64}$/);
      stage("chat-send-admitted", { requestId: dispatched.request_id, status: dispatched.status });
      const until = Date.now() + 30_000;
      let receipt;
      do {
        const previous = receipt?.status;
        receipt = await read("api_chat_request_get", { host_id: hostId, request_id: dispatched.request_id });
        if (receipt.status !== previous) stage("chat-receipt", { status: receipt.status, error: receipt.error });
        if (receipt.status === "succeeded") break;
        assert(["queued", "running"].includes(receipt.status), JSON.stringify(receipt));
        await delay(250);
      } while (Date.now() < until);
      assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
      assert.equal(receipt.result?.reply?.status, "complete", JSON.stringify(receipt));
      assert.equal(receipt.result?.reply?.content, "BUNDLED_GATEWAY_ACCEPTED");
      stage("chat-final-read-receipt");
      const observedChat = await vscode.commands.executeCommand("_personalKnowledge.observeChatGateway");
      const observedNative = await liveVersion();
      assert.equal(observedChat.dispatchMode, "original");
      assert.equal(observedNative.dispatchMode, "original");
      assert.equal(observedChat.routeRuntime.generation, observedNative.routeRuntime.generation);
      assert.notEqual(observedChat.routeRuntime.instanceId, observedNative.routeRuntime.instanceId);
      const clients = Object.fromEntries([["native", observedNative], ["chat", observedChat]].map(([role, observed]) => [
        role, { source: observed.originalConnection.attribution.source,
          gateway: { generation: observed.runtime.generation, runtimeBuild: observed.runtime.runtimeBuild },
          relay: observed.routeRuntime },
      ]));
      assert.equal(clients.native.source, "vscode-provider");
      assert.equal(clients.chat.source, "pkm-chat");
      assert.deepEqual(clients.native.gateway, clients.chat.gateway);
      fs.writeFileSync(path.join(base, "upgrade-gateway-clients.json"), JSON.stringify(clients));
      if (process.env.PKM_UPGRADE_BROWSER === "1") {
        const searchDeadline = Date.now() + 30_000;
        let standard;
        do {
          standard = await read("search_notes", { query: "InstalledGatewayNote", limit: 100, detail: "standard" });
          if (standard.hits?.some(hit => hit.skill_id === "note:InstalledGatewayNote")) break;
          await delay(250);
        } while (Date.now() < searchDeadline);
        const standardHasNote = standard.hits?.some(hit => hit.skill_id === "note:InstalledGatewayNote") === true;
        stage("native-note-search", { standardOk: standard.ok, standardCode: standard.code ?? null,
          standardHitCount: standard.hits?.length ?? null, standardHasNote });
        assert(standardHasNote, "Original indexed search did not return the predecessor Note before browser enrollment");
        const url = await vscode.commands.executeCommand("personalKnowledge.openOriginalBrowser");
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/webview\/$/);
        const token = await vscode.env.clipboard.readText();
        assert.match(token, /^[A-Za-z0-9_-]{43}$/);
        await vscode.env.clipboard.writeText("");
        const enrollment = path.join(base, "browser-enrollment.json");
        fs.writeFileSync(enrollment, JSON.stringify({ url, token, chatId: process.env.PKM_UPGRADE_CHAT,
          bundle: path.join(extension.extensionPath, "dist/webview/panel.js"),
        }), { mode: 0o600, flag: "wx" });
        const until = Date.now() + 180_000;
        const focused = path.join(base, "browser-focus-request");
        while (!fs.existsSync(focused) && Date.now() < until) await delay(100);
        assert(fs.existsSync(focused), "Browser evidence did not reach native Chat focus.");
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
        await vscode.commands.executeCommand("workbench.view.extension.personalKnowledgeChat");
        await vscode.commands.executeCommand("personalKnowledge.apiChat.focus");
        stage("browser-workbench-focused");
        const ready = path.join(base, "browser-revoke-request");
        while (!fs.existsSync(ready) && Date.now() < until) await delay(100);
        assert(fs.existsSync(ready), "Browser evidence did not reach revocation.");
        await vscode.commands.executeCommand("personalKnowledge.openOriginalBrowser");
        const evidence = path.join(base, "upgrade-browser.json");
        while (!fs.existsSync(evidence) && Date.now() < until) {
          const httpsEnrollment = path.join(base, "https-enrollment.json");
          if (fs.existsSync(path.join(base, "https-enrollment-request")) && !fs.existsSync(httpsEnrollment)) {
            const token = await vscode.env.clipboard.readText();
            if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
              const { pkmServiceIdentity } = require(path.join(extension.extensionPath, "dist/runtime/pkm-service.js"));
              const service = pkmServiceIdentity({ knowledgeRoot: root, extensionVersion: extension.packageJSON.version,
                globalStoragePath: path.join(base, "u/User/globalStorage/uone.personal-knowledge") });
              fs.writeFileSync(httpsEnrollment, JSON.stringify({ token,
                provisionPath: path.join(service.serviceDirectory, "browser-transcript-v1.json"),
              }), { mode: 0o600, flag: "wx" });
              await vscode.env.clipboard.writeText("");
            }
          }
          await delay(100);
        }
        assert(fs.existsSync(evidence), "Browser evidence did not verify revocation.");
      }
      // Maintenance can intentionally fence a live Chat adapter even when repair is rejected.
      await verifyRejectedRepair();
    }
    fs.writeFileSync(path.join(base, "upgrade-host.json"), JSON.stringify({
      liveBuild: version.runtime.runtimeBuild, liveVersion: version.version,
      route: expectGateway ? "flag-free-original-dispatch" : "original-managed",
      generation: version.runtime.generation,
      routeGeneration: version.routeRuntime?.generation,
      oldNoteReadThroughNativePkm: true, panelAndChatCommands: true,
      rejectedRuntimeRepairReleasedScopedMarkers: true,
      instance: version.runtime.instanceId,
    }));
    if (expectGateway) {
      const deadline = Date.now() + 40_000;
      while (!fs.existsSync(path.join(base, "close-candidate")) && Date.now() < deadline) await delay(100);
      if (fs.existsSync(path.join(base, "close-candidate"))) await vscode.commands.executeCommand("workbench.action.closeWindow");
    }
  })().catch(error => fs.writeFileSync(path.join(base, "upgrade-failure.json"),
    JSON.stringify({ message: error.message, stack: error.stack }))));
};
