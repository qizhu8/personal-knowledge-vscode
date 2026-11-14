"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), net = require("node:net");
const assert = require("node:assert/strict"), { randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright"), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async ({ fixture, env, editor, cli, candidate, baseline, version, launch, run, stop, hookInstalled, report }) => {
  report.workflowControllerSha256 = createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
  const sessions = {}, hooks = {}, originalModules = path.join(fixture, "original-installed-preserved");
  const args = role => ["--no-sandbox", `--user-data-dir=${fixture}/${role}-user`, `--extensions-dir=${fixture}/${role}-extensions`];
  const read = role => { try { return JSON.parse(fs.readFileSync(path.join(fixture, `${role}-complete-state.json`))); } catch { return {}; } };
  let denyStrict = false, receiving = true, fault = "none";
  report.dialogs = [];
  report.faultProxy = { standardNodeEnvironmentProxy: true, preservesConfiguredSignedEndpoint: true,
    noForgedOwnerDescriptors: true, requests: [], upgrades: [] };
  const tunnels = new Set();
  const heldPages = new Set();
  const proxy = http.createServer((request, response) => {
    const target = new URL(request.url, `http://${request.headers.host || "127.0.0.1:19175"}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
      response.writeHead(403); response.end(); return;
    }
    if (target.origin !== "http://127.0.0.1:19175") {
      const upstream = http.request(target, { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      });
      upstream.on("error", () => response.destroy()); request.pipe(upstream); return;
    }
    report.faultProxy.requests.push({ path: target.pathname, fault });
    if (fault === "directory-offline") { response.destroy(); return; }
    const requestChunks = [];
    request.on("data", bytes => requestChunks.push(bytes));
    const upstream = http.request({ hostname: "127.0.0.1", port: 19175, method: request.method,
      path: target.pathname + target.search, headers: request.headers }, incoming => {
      const bytes = [];
      incoming.on("data", value => bytes.push(value));
      incoming.on("end", () => {
        const body = Buffer.concat(bytes);
        if (fault === "pause-full-history" && target.pathname.endsWith("/history")) {
          const input = JSON.parse(Buffer.concat(requestChunks).toString("utf8"));
          if (input.version === 2 && input.offset >= 32768) {
            const held = { response, offset: input.offset };
            heldPages.add(held); response.once("close", () => heldPages.delete(held));
            return;
          }
        }
        if (fault === "lost-release" && body.toString().includes('"state":"released"')) { response.destroy(); return; }
        response.writeHead(incoming.statusCode, incoming.headers); response.end(body);
      });
    });
    upstream.on("error", () => response.destroy()); request.pipe(upstream);
  });
  proxy.on("connect", (request, socket, head) => {
    const target = new URL(`http://${request.url}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) { socket.destroy(); return; }
    tunnels.add(socket); socket.on("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
    if (target.hostname === "127.0.0.1" && target.port === "19175") {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      proxy.emit("connection", socket);
      if (head.length) socket.unshift(head);
      return;
    }
    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("close", () => upstream.destroy());
  });
  proxy.on("upgrade", (request, socket, head) => {
    const target = new URL(request.url, `http://${request.headers.host || "127.0.0.1:19175"}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) { socket.destroy(); return; }
    report.faultProxy.upgrades.push({ authority: target.host, path: target.pathname });
    const upstream = net.connect(Number(target.port || 80), target.hostname.replace(/^\[|\]$/g, ""), () => {
      const headers = request.rawHeaders.reduce((text, value, index, values) =>
        index % 2 ? text : text + `${value}: ${values[index + 1]}\r\n`, "");
      upstream.write(`${request.method} ${target.pathname + target.search} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    tunnels.add(socket); socket.on("close", () => { tunnels.delete(socket); upstream.destroy(); });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  await new Promise(resolve => proxy.listen(19177, "127.0.0.1", resolve));
  const pump = async () => {
    for (const [role, session] of Object.entries(sessions)) {
      if (session.pythonUiOwnsCdp) continue;
      const page = session.page;
      for (const dialog of await page.locator(".monaco-dialog-box").all()) {
        if (!await dialog.isVisible()) continue;
        const text = await dialog.innerText(), buttons = await dialog.getByRole("button").allTextContents();
        if (text.includes("Sign in to use GitHub Copilot")) {
          report.dialogs.push({ role, phase: session.phase, choice: "Escape (no model/login authorization)" });
          await page.keyboard.press("Escape"); continue;
        }
        let choice;
        if (text.includes("Use Next for this profile's Collaboration?")) choice = "Upgrade Collaboration";
        else if (text.includes("Original Room/Meeting/Note recovery is ready.")) choice = "Later";
        else if (text.includes("Configure the Personal Knowledge root")) choice = "Enter Another Path…";
        else if (text.includes("Use this machine-local Knowledge Root?") && text.includes(fixture)) choice = "Use This Root";
        else if (text.includes("Save long-term permissions")) choice = "Save permissions";
        else if (text.includes("Remove Portal endpoint")) choice = "Remove endpoint";
        else if (text.includes("Force the active Host to close")) choice = "Force Close Host";
        else if (text.includes("Take over full Room assets for")) choice = "Transfer and take over";
        else if (text.includes("Recover saved bytes for")) choice = "Recover selected bytes";
        else if (text.includes("Strict Collaboration:")) choice = denyStrict ? buttons.find(value => /cancel/i.test(value)) : "Approve once";
        else if (text.includes("Restore this historical participant identity?")) choice = "Approve Identity Recovery";
        else if (/pair|endpoint|control/i.test(text))
          choice = buttons.find(value => /^(Pair|Confirm|Accept|Connect|Allow|Enable)/i.test(value.trim()));
        if (choice) {
          report.dialogs.push({ role, phase: session.phase, text, choice: choice.trim() });
          try { await dialog.getByRole("button", { name: choice.trim(), exact: true }).click({ timeout: 1500 }); }
          catch (error) { if (await dialog.isVisible() && await dialog.innerText() === text) throw error; }
        } else fs.writeFileSync(path.join(fixture, `${role}-complete-unhandled-dialog.json`), JSON.stringify({ text, buttons }));
      }
      const quick = page.locator(".quick-input-widget");
      if (await quick.isVisible()) {
        const title = await quick.innerText(), input = quick.locator("input").first();
        const pick = async label => {
          try { await quick.locator(".monaco-list-row").filter({ hasText: label }).first().click({ timeout: 1500 }); }
          catch (error) { if (await quick.isVisible() && await quick.innerText() === title) throw error; }
        };
        try {
        if (title.includes("New Portal endpoint")) { await input.fill(`Private ${role} endpoint`, { timeout: 1500 }); await input.press("Enter", { timeout: 1500 }); }
        else if (title.includes("Endpoint session binding")) await pick("General Enteray");
        else if (/Pair Private/.test(title)) await pick(role === "host" ? "Create private pairing code" : "Accept private pairing code");
        else if (title.includes("Private Portal pairing code")) { await input.fill(read("host").invitation, { timeout: 1500 }); await input.press("Enter", { timeout: 1500 }); }
        else if (title.includes("Local permissions accepted")) {
          const row = quick.locator(".monaco-list-row").filter({ hasText: "code-execute" }).first();
          if (await row.getAttribute("aria-checked") !== "true") await row.click({ timeout: 1500 });
          const ok = quick.getByRole("button", { name: "OK", exact: true });
          if (await ok.count()) await ok.click({ timeout: 1500 }); else await input.press("Enter", { timeout: 1500 });
        } else if (title.includes("Allow remote control of THIS machine?")) await pick(receiving ? "Enable receiving control" : "Disabled");
        else if (session.phase === "relocate") { await input.fill(path.join(fixture, "guest-old-root"), { timeout: 1500 }); await input.press("Enter", { timeout: 1500 }); }
        else fs.writeFileSync(path.join(fixture, `${role}-complete-unhandled-quick.txt`), title);
        } catch (error) { if (await quick.isVisible() && await quick.innerText() === title) throw error; }
      }
    }
  };
  const until = async (check, label, timeout = 120000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const role of Object.keys(sessions)) if (read(role).error) throw new Error(read(role).error);
      if (await check()) return;
      await pump(); await wait(100);
    }
    throw new Error("Complete actual installed journey: " + label);
  };
  const open = async (role, phase) => {
    fs.writeFileSync(path.join(fixture, `${role}-complete-state.json`), "{}");
    fs.writeFileSync(path.join(fixture, `${role}-complete-config.json`), JSON.stringify({ phase,
      oldRoot: path.join(fixture, role === "host" ? "old-root" : "guest-old-root"), hook: hooks[role], originalModules }));
    const port = role === "host" ? 19173 : 19174;
    const code = launch(editor, [...args(role), "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en",
      "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--crash-reporter-directory=${fixture}/temp`,
      `--extensionDevelopmentPath=${fixture}/driver`, `${fixture}/${role}-workspace`], `complete-${phase}-${role}`, {
        HOME: `${fixture}/${role}-home`, USERPROFILE: `${fixture}/${role}-home`, PKM_MEETING_INSTALLED_FIXTURE: fixture, PKM_COLLAB_ROLE: role,
        ...(role === "guest" && !["seed", "baseline", "relocate"].includes(phase) ? {
          NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:19177", HTTPS_PROXY: "http://127.0.0.1:19177",
          NO_PROXY: "", no_proxy: "",
        } : {}) });
    code.label = `complete-${phase}-${role}`;
    let info;
    await until(async () => { try { const result = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (result.ok) { info = await result.json(); return true; } } catch {} }, `${role} responsive CDP`);
    const browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
    let page;
    await until(() => { page = browser.contexts()[0]?.pages().find(value => value.url().includes("workbench")); return !!page; }, "workbench");
    await page.waitForLoadState("networkidle", { timeout: 45000 });
    sessions[role] = { code, browser, page, phase };
    await until(() => read(role).ready, `${phase} ${role} actual activation`);
    report.phases.push({ phase, role, hook: hooks[role], activation: read(role) });
  };
  const ui = require("./collaboration-room-full-ui.cjs")({ fixture, env, until, read,
    action: (...values) => action(...values), report,
    observeOriginalNoteSave: () => captureOriginalContentUriFailure(),
    async beforeUi(role) {
      report.nodeFrameProbes ??= [];
      const frames = [];
      for (const frame of sessions[role].page.frames())
        frames.push({ url: frame.url().split("?")[0], detail: await frame.locator("#detail").count(),
          tabs: await frame.locator(".tab").count() });
      report.nodeFrameProbes.push({ role, frames });
      sessions[role].pythonUiOwnsCdp = true;
      await sessions[role].browser.close();
    },
    async afterUi(role) {
      const port = role === "host" ? 19173 : 19174;
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
      sessions[role].browser = browser;
      sessions[role].page = browser.contexts()[0].pages().find(value => value.url().includes("workbench"));
      assert(sessions[role].page);
      sessions[role].pythonUiOwnsCdp = false;
    } });
  const finish = async roles => {
    for (const role of roles) { if (!sessions[role]) continue;
      await ui.disconnect(role);
      await sessions[role].browser.close(); await stop(sessions[role].code); delete sessions[role]; }
  };
  const action = async (role, operation, extra = {}, expectedFailure = false) => {
    const id = randomUUID();
    fs.writeFileSync(path.join(fixture, `${role}-complete-action.json`), JSON.stringify({ id, operation, ...extra }));
    try {
      await until(() => read(role).completed === id, `${role} ${operation}`);
    } catch (failure) {
      try {
        report.actionFailure = await require("./collaboration-room-action-diagnostic.cjs")({
          fixture, role, operation, page: sessions[role]?.page, state: read(role),
        });
      } catch (error) { report.actionFailure = { role, operation, diagnosticErrorType: error.name }; }
      throw failure;
    }
    const state = read(role);
    if (expectedFailure) assert(state.actionError, "Failure must not be reported as a successful handoff.");
    else assert.equal(state.actionError, undefined);
    report.actions ??= []; report.actions.push({ role, operation, target: extra.target ?? "primary", state });
    return state;
  };
  const portal = async (role, command) => {
    await ui.perform(role, "tab", { tab: "portalConnections" });
    let frame;
    await until(async () => {
      for (const current of sessions[role].page.frames())
        if (await current.locator(`[data-portal-command="${command}"]`).count()) { frame = current; return true; }
      return false;
    }, "actual production Portal renderer");
    await frame.locator(`[data-portal-command="${command}"]`).first().click();
  };
  const hashes = () => {
    const original = JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json"))), result = {};
    const walk = directory => { for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file); assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) walk(file); else result[path.relative(fixture, file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } };
    for (const root of ["old-root", "guest-old-root"]) {
      walk(path.join(fixture, root, "chatrooms"));
      const note = path.join(fixture, root, "notes", original.savedMarkdownPath ?? original.markdownPath);
      result[path.relative(fixture, note)] = createHash("sha256").update(fs.readFileSync(note)).digest("hex");
    }
    return result;
  };
  const captureOriginalContentUriFailure = async () => {
    const old = await action("host", "observe-note-editor");
    assert.equal(old.noteEditor.dirty, true);
    assert(old.noteEditor.readError, "Original title rename must reproduce the missing URI.");
    await sessions.host.page.getByText(/^Failed to save/).filter({ visible: true }).first()
      .waitFor({ state: "visible", timeout: 15000 });
    await sessions.host.page.screenshot({ path: path.join(fixture, "original-content-uri-save-failure.png") });
    report.originalContentUri = { persistentContentVerified: true, uiSaveFailed: true, dirty: true };
  };
  try {
    run(cli, [...args("host"), "--install-extension", baseline, "--force"]); hooks.host = hookInstalled("4.0.22", "host");
    fs.cpSync(hooks.host.installed, originalModules, { recursive: true });
    await open("host", "seed"); assert(read("host").seedBeforeClientIdentity); await finish(["host"]);
    for (const [from, to] of [["host-user", "guest-user"], ["host-home", "guest-home"], ["old-root", "guest-old-root"]])
      fs.cpSync(path.join(fixture, from), path.join(fixture, to), { recursive: true });
    for (const role of ["host", "guest"]) {
      const file = path.join(fixture, `${role}-user/User/settings.json`), settings = JSON.parse(fs.readFileSync(file));
      settings["personalKnowledge.chatHubPort"] = role === "host" ? 19175 : 19176;
      settings["personalKnowledge.chatHubUrl"] = role === "guest" ? "ws://127.0.0.1:19175" : "";
      fs.writeFileSync(file, JSON.stringify(settings));
    }
    run(cli, [...args("guest"), "--install-extension", baseline, "--force"]); hooks.guest = hookInstalled("4.0.22", "guest");
    await open("guest", "relocate"); await finish(["guest"]);
    await open("host", "baseline"); await open("guest", "baseline");
    const hostBaseline = await action("host", "host");
    const guestBaseline = await action("guest", "join", { invitation: hostBaseline.hosted });
    assert.notEqual(hostBaseline.cid, guestBaseline.cid);
    await action("host", "meeting");
    if (report.workflow === "collaboration-original-editor-stability") {
      await action("host", "seed-editor-probe");
      const probe = JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json"))).editorProbe;
      report.originalEditorProbe = { fixtureSeedUsesActual4022Api: true, notUiCreationQualification: true, saves: [] };
      let previous = probe.content;
      for (const mode of ["fresh-load", "scroll-and-tab-switch", "after-code-restart"]) {
        if (mode === "after-code-restart") {
          await finish(["guest", "host"]);
          await open("host", "baseline");
        }
        const opened = await action("host", "open-editor-probe");
        assert.equal(opened.editorProbe.persistedContent, previous);
        if (mode === "scroll-and-tab-switch")
          await ui.perform("host", "workbench-editor-layout", { switchTabs: true });
        const expected = probe.content + `\nActual original Workbench save: ${mode}.\n`;
        await ui.perform("host", "workbench-edit-save", { value: expected });
        let observed;
        await until(async () => {
          observed = await action("host", "observe-editor-probe");
          return observed.editorProbe.dirty === false && observed.editorProbe.persistedContent === expected;
        }, "actual original canonical Note GUI save is clean and persisted");
        assert.equal(observed.editorProbe.text, expected);
        assert.equal(observed.editorProbe.physicalContent, expected);
        assert.equal(observed.editorProbe.statSize, Buffer.byteLength(expected));
        assert.equal(observed.version, "4.0.22");
        report.originalEditorProbe.saves.push({ mode, uri: observed.editorProbe.uri, dirty: false,
          version: observed.version, extensionHostPid: observed.extensionHostPid,
          contentSha256: createHash("sha256").update(expected).digest("hex"),
          physicalRawSha256: observed.editorProbe.physicalRawSha256 });
        await sessions.host.page.screenshot({ path: path.join(fixture, `original-editor-${mode}.png`) });
        previous = expected;
      }
      assert.notEqual(report.originalEditorProbe.saves[0].extensionHostPid,
        report.originalEditorProbe.saves[2].extensionHostPid);
      await action("host", "host");
      const original = JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json")));
      await ui.editNote("host", original.originalNote + "\nTargeted original Meeting URI negative.\n", false);
      await captureOriginalContentUriFailure();
      report.scope = "Targeted actual original 4.0.22 Editor load/focus/layout/save/restart stability only. Canonical Note saves positive; Meeting old URI failure retained. No full/attachment/candidate/adoption qualification.";
      return;
    }
    if (report.workflow === "collaboration-room-note-compatibility") {
      const original = JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json")));
      const canonicalFile = path.join(fixture, "old-root/chatrooms", original.roomId, "meetings/canonical.json");
      const canonical = fs.readFileSync(canonicalFile);
      const first = original.originalNote + "\nOriginal actual content URI write.\n";
      await ui.editNote("host", first, false);
      await captureOriginalContentUriFailure();
      await finish(["guest", "host"]);
      run(cli, [...args("host"), "--install-extension", candidate, "--force"]);
      hooks.host = hookInstalled(version, "host");
      report.currentContentUri = [];
      let previous = first;
      for (const suffix of ["first-save", "after-code-restart"]) {
        await open("host", "prepare");
        const opened = await action("host", "open-original-content-uri");
        assert.equal(opened.noteEditor.persistedContent, previous);
        const expected = first + `\nCurrent actual content URI ${suffix}.\n`;
        await ui.perform("host", "workbench-edit-save", { value: expected });
        let observed;
        await until(async () => {
          observed = await action("host", "observe-note-editor");
          return observed.noteEditor.dirty === false && observed.noteEditor.persistedContent === expected;
        }, "current actual original URI save completed without dirty buffer");
        assert.equal(observed.noteEditor.statSize, Buffer.byteLength(expected));
        assert.equal(observed.root, path.join(fixture, "old-root"));
        assert.equal(observed.version, version);
        assert(!fs.existsSync(path.join(fixture, "old-root/core.sqlite")), "Ordinary Note must not create a Next Core root.");
        assert.deepEqual(fs.readFileSync(canonicalFile), canonical);
        report.currentContentUri.push({ suffix, uri: observed.noteEditor.uri, dirty: false,
          contentSha256: createHash("sha256").update(expected).digest("hex"), version,
          sameOriginalRoot: true, canonicalBytesUnchanged: true });
        previous = expected;
        await sessions.host.page.screenshot({ path: path.join(fixture, `current-content-uri-${suffix}.png`) });
        await finish(["host"]);
      }
      report.scope = "Private original-root/profile ordinary Note content URI compatibility; no Next adoption, Room attachment/full or standard release qualification.";
      return;
    }
    await ui.originalRound();
    for (const role of ["host", "guest"]) { await portal(role, "portalEndpointCreate"); await until(() => read(role).endpoint, "original endpoint"); }
    await portal("host", "portalEndpointPair"); await until(() => read("host").invitation, "actual original pairing link");
    await portal("guest", "portalEndpointPair"); await until(() => read("host").confirmed && read("guest").confirmed, "original pair approval");
    const pairId = read("host").pairId;
    await action("host", "command"); await until(() => read("host").commandError || ["denied", "failed"].includes(read("host").receipt?.state), "disabled receiving rejected");
    assert(!fs.existsSync(path.join(fixture, "physical-command-runs")));
    await portal("guest", "portalEndpointPermissions"); await until(() => read("guest").endpoint?.acceptsIncoming, "saved original permissions");
    await action("host", "command");
    await until(() => ["denied", "failed"].includes(read("host").receipt?.state), "actual original General endpoint missing-Chat denial");
    assert(!fs.existsSync(path.join(fixture, "physical-command-runs")));
    report.originalGeneralCommandFailure = {
      receivingEnabledAndCodePermissionSaved: true, originalProductDeniedRatherThanExecuting: true,
      sourceFinding: "4.0.22 treats an unbound General endpoint ID as a Chat ID before checking receiving permission.",
      notAClaimThatOldDirectCommandSucceeded: true };
    const handoffBaselineHost = await action("host", "host", { target: "handoff" });
    const handoffBaselineGuest = await action("guest", "join", { invitation: handoffBaselineHost.hosted, target: "handoff" });
    await action("host", "send", { target: "handoff", text: "Original transcript before upgrade" });
    await action("host", "stop"); await finish(["guest", "host"]);
    const original = JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json")));
    for (const [room, preserved] of [[original, "guest-pre-restore-room-preserved"],
      [original.handoff, "guest-pre-restore-handoff-preserved"]]) {
      const guestRoom = path.join(fixture, "guest-old-root/chatrooms", room.roomId);
      fs.renameSync(guestRoom, path.join(fixture, preserved));
      fs.cpSync(path.join(fixture, "old-root/chatrooms", room.roomId), guestRoom, { recursive: true });
    }
    assert(!fs.existsSync(path.join(fixture, "old-root/chatrooms", original.handoff.roomId, "meetings/canonical.json")));
    const savedNotePath = original.savedMarkdownPath ?? original.markdownPath;
    const guestNote = path.join(fixture, "guest-old-root/notes", savedNotePath);
    for (const [relative, preserved] of [[original.markdownPath, "guest-pre-restore-note-preserved.md"],
      [savedNotePath, "guest-pre-restore-saved-note-preserved.md"]]) {
      const existing = path.join(fixture, "guest-old-root/notes", relative);
      if (fs.existsSync(existing)) fs.renameSync(existing, path.join(fixture, preserved));
    }
    fs.mkdirSync(path.dirname(guestNote), { recursive: true });
    fs.copyFileSync(path.join(fixture, "old-root/notes", savedNotePath), guestNote);
    report.originalSource = hashes();
    report.backup = { fullOriginalProfileBeforeClientIdentity: true, originalHostAuthorityRestoredNotFabricated: true,
      closedOriginalRoomBackupRestoredInSecondPrivateRoot: true, preRestoreRoomPreserved: true,
      preRestoreNotesPreserved: ["guest-pre-restore-note-preserved.md", "guest-pre-restore-saved-note-preserved.md"]
        .filter(file => fs.existsSync(path.join(fixture, file)))
        .map(file => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(fixture, file))).digest("hex") })) };
    for (const role of ["host", "guest"]) {
      run(cli, [...args(role), "--install-extension", candidate, "--force"]); hooks[role] = hookInstalled(version, role);
      await open(role, "prepare"); await action(role, "upgrade"); await finish([role]);
    }
    await open("host", "native"); await action("host", "host");
    await open("guest", "native"); await action("guest", "refresh");
    await until(() => read("host").confirmed && read("guest").confirmed, "real saved original pairing after upgrade");
    assert.equal(read("host").pairId, pairId);
    const nativeHost = read("host"), nativeGuest = read("guest");
    await action("guest", "join", { invitation: nativeHost.hosted });
    assert.equal(read("host").participantId, hostBaseline.participantId);
    assert.equal(read("guest").participantId, guestBaseline.participantId);
    await action("host", "note");
    await ui.nativeRound();
    receiving = false; await portal("guest", "portalEndpointPermissions");
    await until(() => read("guest").endpoint?.acceptsIncoming === false, "upgraded receiving disabled");
    await action("host", "command");
    await until(() => ["denied", "failed"].includes(read("host").receipt?.state), "upgraded disabled receiving rejects real command");
    assert(!fs.existsSync(path.join(fixture, "physical-command-runs")));
    receiving = true; await portal("guest", "portalEndpointPermissions");
    await until(() => read("guest").endpoint?.acceptsIncoming === true, "upgraded receiving enabled");
    await action("host", "command");
    await until(() => read("host").receipt?.state === "completed", "default product Portal real command");
    await portal("guest", "portalEndpointDisconnect");
    await until(() => !read("guest").connected, "real product disconnect");
    assert(read("guest").endpoint.paired && read("guest").endpoint.acceptsIncoming);
    await portal("guest", "portalEndpointConnect");
    await until(() => read("host").confirmed && read("guest").confirmed, "original saved permissions reconnect");
    assert.equal(read("guest").pairId, pairId);
    assert(!report.dialogs.some(value => (value.text ?? "").includes("Strict Collaboration:") || (value.text ?? "").includes("Host this Room with the Next workspace owner?")));
    await action("host", "command", { slow: true });
    await until(() => fs.existsSync(path.join(fixture, "physical-slow-starts")), "real remote OS command in flight");
    await finish(["guest"]);
    await open("guest", "native-restart"); await action("guest", "refresh");
    await until(() => read("host").confirmed && read("guest").confirmed, "full in-flight Guest Host restart restored saved pairing");
    assert.equal(read("guest").pairId, pairId);
    assert.notEqual(read("guest").status.pid, nativeGuest.status.pid);
    assert.equal(read("guest").status.workspaceId, nativeGuest.status.workspaceId);
    await action("guest", "join", { invitation: nativeHost.hosted });
    assert.equal(read("guest").participantId, guestBaseline.participantId);
    await action("host", "command"); await until(() => read("host").receipt?.state === "completed", "new command after restart, not replay");
    await action("host", "project-interrupted"); await action("host", "project-resume");
    const meetingBlocked = await action("guest", "force-close", {}, true);
    assert.match(meetingBlocked.actionError, /Meeting.*separate transfer|Meeting\/Note transfer/i);
    assert(read("host").activeRoomIds.includes(original.roomId));
    const handoffNative = await action("host", "host", { target: "handoff" });
    await action("guest", "join", { invitation: handoffNative.hosted, target: "handoff" });
    assert.equal(read("host").participantId, handoffBaselineHost.participantId);
    assert.equal(read("guest").participantId, handoffBaselineGuest.participantId);
    await action("host", "send", { target: "handoff", text: "Late product history after upgrade" });
    await action("guest", "join-only-close", { target: "handoff", url: handoffNative.hosted.url });
    await action("guest", "public-force-close", { target: "handoff" });
    const reopened = await action("host", "host", { target: "handoff" });
    await action("guest", "join", { invitation: reopened.hosted, target: "handoff" });
    fault = "directory-offline";
    await action("guest", "force-close", { target: "handoff" }, true);
    assert(read("host").activeRoomIds.includes(original.handoff.roomId));
    fault = "lost-release";
    const uncertain = await action("guest", "force-close", { target: "handoff" }, true);
    assert.match(uncertain.actionError, /unconfirmed|unavailable|disappeared/i);
    assert.notEqual(uncertain.confirmedRelease, true);
    fault = "none";
    await action("guest", "refresh");
    await action("guest", "leave-remote", { target: "handoff" });
    const takeover = await action("guest", "rehost-for-guest", { target: "handoff" });
    assert.equal(takeover.participantId, handoffBaselineGuest.participantId);
    assert(takeover.messages.includes("Late product history after upgrade"));
    await action("guest", "local-owner", { target: "handoff" });
    await action("guest", "strict"); await action("guest", "stop"); await finish(["guest"]);
    await open("guest", "strict"); await action("guest", "refresh"); await action("guest", "rehost-for-guest", { target: "handoff" });
    await until(() => read("host").confirmed && read("guest").confirmed, "saved pair after strict full restart");
    assert.equal(read("guest").pairId, pairId);
    await action("host", "command"); await until(() => read("host").receipt?.state === "completed", "strict one-operation owner approval");
    denyStrict = true;
    await action("host", "command"); await until(() => ["denied", "failed"].includes(read("host").receipt?.state), "strict denial overrides saved execution permission");
    denyStrict = false;
    const approvals = report.dialogs.filter(value => value.choice === "Approve Identity Recovery").length;
    await action("guest", "old-recovery", { target: "handoff" }); await action("guest", "old-recovery", { target: "handoff" });
    assert.equal(read("guest").oldRecovery.participantId, handoffBaselineGuest.participantId);
    assert.equal(report.dialogs.filter(value => value.choice === "Approve Identity Recovery").length, approvals + 2);
    assert.notEqual(nativeGuest.extensionHostPid, read("guest").extensionHostPid);
    assert.equal(fs.readFileSync(path.join(fixture, "physical-slow-starts"), "utf8"), "start\n");
    assert.equal(fs.existsSync(path.join(fixture, "physical-slow-finishes")), false);
    await portal("guest", "portalEndpointRemove");
    await until(() => !read("guest").endpoint && !read("host").confirmed, "real endpoint removal revokes peer binding");
    assert.deepEqual(hashes(), report.originalSource);
    report.productComplete = { actualProductActivationAndPortalRenderer: true, noVmOrOwnerFactoryInjection: true,
      publicUpgradeBothProfiles: true, originalPairId: pairId, defaultLegacyInteractions: true,
      originalProjectThreadAndHostGuestIds: true, interruptedProjectLinkRetrySameRoom: true,
      joinSecretCannotForceClose: true, directoryFailureNotRelease: true, acceptedCloseLostReleaseNotSuccess: true,
      authenticatedReleaseThenCrossRootRehostLatestHistory: true, originalGuestIdAfterTakeover: true,
      takeoverRoom: { roomId: original.handoff.roomId, transcriptOnly: true, createdByOriginal4022: true },
      retainedMeetingForceCloseRefusedWithoutRelease: true,
      oldRemoteHintExplicitlyClearedAfterConfirmedTakeover: true,
      explicitRemoteLeaveAndFreshLocalHistoryBeforeTakeover: true,
      fullRestartSavedPairAndStrictApproval: true, oldClientEveryRecoveryApproval: true,
      actualInFlightOsCommandHostRestartWithoutReplay: true,
      originalRoomMeetingManualNoteBytesUnchanged: true, transport: "plaintext ws/HTTP, not TLS",
      notQualified: ["real model inference or billing", "physical two hosts", "OS keyring", "full cross-root Meeting/Note/file transfer", "general same-root adoption"] };
    const { DatabaseSync } = require("node:sqlite");
    const coreRoots = { host: read("host").status.root, guest: read("guest").status.root };
    const core = (role, callback) => {
      const root = coreRoots[role];
      assert(path.resolve(root).startsWith(path.join(fixture, `${role}-user`) + path.sep));
      const database = new DatabaseSync(path.join(root, "core.sqlite"), { readOnly: true });
      try { database.exec("PRAGMA query_only=ON"); return callback(database); }
      finally { database.close(); }
    };
    const primaryNote = role => core(role, database => database.prepare(
      "SELECT body FROM next_room_meeting_notes WHERE room_id=? AND meeting_id=?").get(original.roomId, original.meetingId).body);
    const guestBase = primaryNote("guest");
    assert.equal(guestBase, JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json"))).originalNote);
    await action("guest", "leave-remote");
    fault = "pause-full-history";
    await ui.perform("guest", "room-action", { section: "hosted", room: original.room, label: "Take over full assets…" });
    await until(() => heldPages.size && core("guest", database => database.prepare(
      "SELECT length(data) AS bytes FROM next_room_full_history_incoming WHERE room_id=?").get(original.roomId)?.bytes > 0),
    "real full button paused after an unpublished page");
    assert.equal(primaryNote("guest"), guestBase);
    assert.equal(core("guest", database => database.prepare(
      "SELECT COUNT(*) AS n FROM legacy_room_runtime_files WHERE room_id=?").get(original.roomId).n), 0);
    assert(read("host").activeRoomIds.includes(original.roomId));
    const crashed = { pid: read("guest").status.pid,
      bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      namespace: fs.readlinkSync(`/proc/${read("guest").status.pid}/ns/mnt`) };
    const stat = pid => fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[19];
    crashed.start = stat(crashed.pid);
    assert.equal(crashed.namespace, fs.readlinkSync("/proc/self/ns/mnt"));
    assert(fs.readlinkSync(`/proc/${crashed.pid}/cwd`).startsWith(fixture));
    const argv = fs.readFileSync(`/proc/${crashed.pid}/cmdline`, "utf8");
    assert(argv.includes(fixture) && argv.includes("next-collaboration-child"));
    await action("guest", "expect-child-crash");
    assert.equal(stat(crashed.pid), crashed.start);
    assert([...heldPages].some(value => !value.response.destroyed), "The actual HTTP page must still be paused at crash.");
    process.kill(crashed.pid, "SIGKILL");
    assert.equal(primaryNote("guest"), guestBase);
    const sharedNow = JSON.parse(fs.readFileSync(path.join(fixture, "complete-original.json")));
    const latest = sharedNow.expectedNativeNote + "\nNew actual source head after the receiver owner crash.\n";
    await ui.editNote("host", latest);
    fault = "none";
    for (const held of heldPages) held.response.destroy();
    await finish(["guest"]);
    await open("guest", "full-assets-restart"); await action("guest", "refresh");
    assert.equal(read("guest").status.root, coreRoots.guest);
    await ui.perform("guest", "room-action", { section: "hosted", room: original.room, label: "Take over full assets…" });
    await until(() => read("guest").uiCurrent?.roomId === original.roomId && read("guest").uiCurrent.selfHost
      && primaryNote("guest") === latest, "real full button resumes immutable checkpoint then takes over latest sealed head");
    assert(!read("host").activeRoomIds.includes(original.roomId));
    const receiver = read("guest").uiCurrent;
    assert.equal(receiver.participantId, guestBaseline.participantId);
    const savedFile = sharedNow.uiFile;
    core("guest", database => {
      const row = database.prepare("SELECT data,sha256 FROM legacy_room_runtime_files WHERE room_id=? AND file_id=?")
        .get(original.roomId, savedFile.fileId);
      assert.equal(createHash("sha256").update(Buffer.from(row.data)).digest("hex"), savedFile.sha256);
      assert.equal(row.sha256, savedFile.sha256);
      const provenance = database.prepare("SELECT source_canonical FROM next_room_meeting_transferred_sources WHERE room_id=?").get(original.roomId);
      assert.equal(createHash("sha256").update(provenance.source_canonical).digest("hex"),
        createHash("sha256").update(fs.readFileSync(path.join(fixture, "old-root/chatrooms", original.roomId, "meetings/canonical.json"))).digest("hex"));
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM next_room_full_history_incoming WHERE room_id=?").get(original.roomId).n, 0);
    });
    await until(() => read("guest").uiFiles?.some(value => value.fileId === savedFile.fileId), "actual replayed receiver file");
    const receiverSave = path.join(fixture, "actual-full-receiver-saved.bin");
    await ui.perform("guest", "save-file", { name: savedFile.name });
    await ui.perform("guest", "workbench-file", { title: "Save shared file", value: receiverSave });
    await until(() => fs.existsSync(receiverSave), "actual receiver Save dialog");
    assert.equal(createHash("sha256").update(fs.readFileSync(receiverSave)).digest("hex"), savedFile.sha256);
    const receiverSaved = latest + "\nSaved by the actual receiver Workbench editor.\n";
    await ui.editNote("guest", receiverSaved);
    assert.equal(primaryNote("host"), latest);
    const receiverOwner = { pid: read("guest").status.pid };
    receiverOwner.start = stat(receiverOwner.pid);
    assert.equal(fs.readlinkSync(`/proc/${receiverOwner.pid}/ns/mnt`), crashed.namespace);
    assert(fs.readlinkSync(`/proc/${receiverOwner.pid}/cwd`).startsWith(fixture));
    const receiverArgv = fs.readFileSync(`/proc/${receiverOwner.pid}/cmdline`, "utf8");
    assert(receiverArgv.includes(fixture) && receiverArgv.includes("next-collaboration-child"));
    await action("guest", "expect-child-crash");
    assert.equal(stat(receiverOwner.pid), receiverOwner.start);
    process.kill(receiverOwner.pid, "SIGKILL");
    await ui.perform("guest", "workbench-edit-save", { value: receiverSaved + "\nThis dirty save must not reach Core.\n" });
    await ui.perform("guest", "workbench-notification", { text: "Failed to save" });
    assert.equal(primaryNote("guest"), receiverSaved);
    assert.deepEqual(hashes(), report.originalSource);
    report.fullRoomAssetsActual = { explicitNewButton: true, defaultForceCloseStillRefused: true,
      originalUiFileSaveAndExplicitRecovery: true, sourceAndReceiverActualEditableNotes: true,
      privateOwnerCrash: crashed, partialCheckpointUnpublished: true, restartResumedThenFetchedLatestHead: true,
      guestIdPreserved: receiver.participantId, receiverUiSavedFileSha256: savedFile.sha256,
      dirtyReceiverSaveAfterOwnerCrashRefused: true,
      originalCanonicalAndRetainedNotePinsUnchanged: true, plaintextTransport: true };
  } finally {
    try { await finish(Object.keys(sessions)); }
    finally {
      await ui.close();
      for (const held of heldPages) held.response.destroy();
      for (const socket of tunnels) socket.destroy();
      proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    }
  }
};
