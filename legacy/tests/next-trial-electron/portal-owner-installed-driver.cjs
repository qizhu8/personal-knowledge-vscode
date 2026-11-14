"use strict";
const fs = require("node:fs"), path = require("node:path");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.activate = async context => {
  const vscode = require("vscode");
  const fixture = process.env.PKM_MEETING_INSTALLED_FIXTURE;
  if (!fixture || !context.globalStorageUri.fsPath.startsWith(path.join(fixture, "host-user") + path.sep))
    throw new Error("Portal owner driver requires its exact private profile.");
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8"));
  const emit = (event, data = {}) => fs.appendFileSync(path.join(fixture, "host-events.jsonl"),
    JSON.stringify({ event, phase: config.phase, ...data }) + "\n", { mode: 0o600 });
  const until = async check => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (check()) return; await wait(25); }
    throw new Error("Installed Portal cancellation timed out.");
  };
  let storage, registration, pending, caller;
  try {
    const product = vscode.extensions.getExtension("Uone.personal-knowledge");
    assert(fs.realpathSync(product.extensionPath).startsWith(path.join(fixture, "host-extensions") + path.sep));
    await product.activate();
    const scope = process[Symbol.for("pkm.meeting.fixture." + fixture)];
    assert(scope, "Only the actual activated product module may provide its owner registry/context.");
    const productContext = scope.__fixtureProductContext;
    assert(productContext?.secrets && productContext !== context);
    const actualExport = name => scope[name] ?? Object.values(scope).find(value => typeof value?.[name] === "function")?.[name];
    const register = actualExport("registerAdoptedRoomHostOwner"), select = actualExport("selectRoomHostHub");
    assert.equal(typeof register, "function"); assert.equal(typeof select, "function");
    const requireProduct = createRequire(path.join(product.extensionPath, "dist/extension.js"));
    const commands = requireProduct("./chatroom/portal-command.js");
    const native = await import(pathToFileURL(path.join(fixture, "native/native.mjs")));
    storage = await native.Storage.open(config.nextRoot, { deferRecovery: true });
    const workspaceId = await storage.workspaceId();
    let live = true, executionSignal, processResult;
    registration = register({ root: config.nextRoot, workspaceId, qualification: "new-next-workspace",
      assertAuthority() { if (!live) throw new Error("Portal selected owner revoked."); storage.assertWorkspaceLease(); },
      createHub(ui, selected) {
        return native.createNextRoomUiHub({ ...ui, storage, workspaceId, qualification: "new-next-workspace",
          credentials: {}, retained: {},
          assertAuthority() { selected(); if (!live) throw new Error("Portal selected owner revoked."); },
          portal: {
            async authorize(input) {
              const answer = await vscode.window.showWarningMessage("Allow this exact isolated Portal command once?",
                { modal: true, detail: `Root: ${input.root}\nRequest: ${input.detail.requestId}\n`
                  + "Synthetic Portal request; no remote network, model or production root. Executes one private local test process." },
                "Allow Command Once");
              return answer === "Allow Command Once";
            },
            async executeCommand(input) {
              executionSignal = input.signal;
              processResult = await commands.executePortalCommand(
                path.join(productContext.globalStorageUri.fsPath, "portal-processes", input.contextId),
                `${input.pairId}:${input.requestId}`, input.command, input.defaultCwd, input.signal);
              return processResult;
            },
          },
        });
      },
    });
    const hub = select(config.nextRoot, () => assert.fail("Selected owner cannot start a legacy writer."), {});
    const authority = hub.portalAuthority;
    assert.equal(hub.isRunning, false, "The remote-link executor does not require a local Hub.");
    const request = () => {
      const started = path.join(fixture, `portal-${randomUUID()}.started`);
      const effect = `${started}.late-effect`, requestId = randomUUID();
      const command = commands.parsePortalCommand({ program: "node", arguments: ["-e",
        `require('fs').writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(effect)},'late'),30000);`],
        timeoutSeconds: 45 });
      return { started, effect, input: { root: config.nextRoot, contextId: randomUUID(), operation: "command",
        pairId: randomUUID(), peerId: randomUUID(), detail: { requestId, command, defaultCwd: fixture } } };
    };
    for (const cause of ["hub-stop", "owner-dispose"]) {
      const { started, effect, input } = request();
      assert(await authority.authorize(input));
      caller = new AbortController();
      pending = authority.executeCommand({ ...input, ...input.detail, signal: caller.signal });
      pending.catch(() => {});
      await until(() => fs.existsSync(started));
      if (cause === "hub-stop") await hub.stop(); else { await registration.dispose(); registration = undefined; }
      await until(() => executionSignal.aborted);
      await assert.rejects(pending, /revoked|stopped|lifecycle/i);
      assert.equal(processResult.state, "cancelled");
      assert.equal(fs.existsSync(effect), false);
      emit("installed-portal-process-cancelled", { cause, terminalOriginalReceipt: processResult.state,
        processHandle: processResult.handle, lateEffectAbsent: true, localHubStarted: false });
      pending = undefined; caller = undefined;
    }
    assert.throws(() => select(config.nextRoot, () => assert.fail("Revocation cannot fall back to legacy."), {}), /revoked/);
    let legacyCalls = 0;
    const legacy = select(path.join(fixture, "unadopt-root"), () => {
      legacyCalls++; return new (actualExport("ChatHub"))();
    }, {});
    assert.equal(legacyCalls, 1);
    await legacy.stop();
    assert.equal(fs.readdirSync(path.join(config.nextRoot, "notes")).length, 0);
    assert.equal(fs.existsSync(path.join(config.nextRoot, "chatrooms")), false);
    emit("unadopt-legacy-and-private-root-preserved", { legacyFactoryCalls: legacyCalls,
      roomArchivesCreated: false, publicNotesCreated: false });
    await storage.close(); storage = undefined;
    emit("phase-complete", { actualProductOwnerRegistry: true, actualProductContext: true,
      modelCalls: 0, requestFixture: "scripted synthetic Portal admission; not actual installed pairing/remote UI",
      originalSupervisor: "installed compiled product, not a replacement executor", productionDefaultQualified: false });
  } catch (error) {
    emit("driver-failed", { message: error.stack || String(error) });
    throw error;
  } finally {
    caller?.abort();
    await pending?.catch(() => {});
    await registration?.dispose();
    await storage?.close();
  }
};
exports.deactivate = () => {};
