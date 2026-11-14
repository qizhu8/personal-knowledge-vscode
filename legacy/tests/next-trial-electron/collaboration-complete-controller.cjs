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
    const upstream = http.request({ hostname: "127.0.0.1", port: 19175, method: request.method,
      path: target.pathname + target.search, headers: request.headers }, incoming => {
      const bytes = [];
      incoming.on("data", value => bytes.push(value));
      incoming.on("end", () => {
        const body = Buffer.concat(bytes);
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
  const finish = async roles => {
    for (const role of roles) { if (!sessions[role]) continue;
      await sessions[role].browser.close(); await stop(sessions[role].code); delete sessions[role]; }
  };
  const action = async (role, operation, extra = {}, expectedFailure = false) => {
    const id = randomUUID();
    fs.writeFileSync(path.join(fixture, `${role}-complete-action.json`), JSON.stringify({ id, operation, ...extra }));
    await until(() => read(role).completed === id, `${role} ${operation}`);
    const state = read(role);
    if (expectedFailure) assert(state.actionError, "Failure must not be reported as a successful handoff.");
    else assert.equal(state.actionError, undefined);
    report.actions ??= []; report.actions.push({ role, operation, target: extra.target ?? "primary", state });
    return state;
  };
  const portal = async (role, command) => {
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
      const note = path.join(fixture, root, "notes", original.markdownPath);
      result[path.relative(fixture, note)] = createHash("sha256").update(fs.readFileSync(note)).digest("hex");
    }
    return result;
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
    const guestNote = path.join(fixture, "guest-old-root/notes", original.markdownPath);
    fs.mkdirSync(path.dirname(guestNote), { recursive: true });
    fs.copyFileSync(path.join(fixture, "old-root/notes", original.markdownPath), guestNote);
    report.originalSource = hashes();
    report.backup = { fullOriginalProfileBeforeClientIdentity: true, originalHostAuthorityRestoredNotFabricated: true,
      closedOriginalRoomBackupRestoredInSecondPrivateRoot: true, preRestoreRoomPreserved: true };
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
  } finally {
    await finish(Object.keys(sessions));
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  }
};
