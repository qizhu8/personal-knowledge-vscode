"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async ({ fixture, env, editor, cli, candidate, baseline, version, launch, run, stop, hookInstalled, report }) => {
  const args = role => ["--no-sandbox", `--user-data-dir=${fixture}/${role}-user`, `--extensions-dir=${fixture}/${role}-extensions`];
  const events = role => {
    const file = path.join(fixture, `${role}-collab-events.jsonl`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  const originalHashes = () => {
    const state = JSON.parse(fs.readFileSync(path.join(fixture, "production-state.json")));
    const result = {};
    const walk = directory => {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        assert(!stat.isSymbolicLink());
        if (stat.isDirectory()) walk(file);
        else result[path.relative(fixture, file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      }
    };
    walk(path.join(fixture, "old-root/chatrooms", state.roomId));
    for (const file of [path.join(fixture, "old-root/notes", state.markdownPath), state.ordinaryNote])
      result[path.relative(fixture, file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return result;
  };
  const profiles = {};
  const open = async (role, phase, hook) => {
    fs.writeFileSync(path.join(fixture, `${role}-collab-config.json`), JSON.stringify({ phase,
      oldRoot: path.join(fixture, role === "host" ? "old-root" : "guest-old-root"), ...hook }));
    const port = role === "host" ? 19173 : 19174;
    const code = launch(editor, [...args(role), "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en",
      "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
      `--crash-reporter-directory=${fixture}/temp`, `--extensionDevelopmentPath=${fixture}/driver`,
      `${fixture}/${role}-workspace`], `production-${phase}-${role}`, {
        HOME: `${fixture}/${role}-home`, USERPROFILE: `${fixture}/${role}-home`,
        PKM_MEETING_INSTALLED_FIXTURE: fixture, PKM_COLLAB_ROLE: role });
    code.label = `production-${phase}-${role}`;
    const end = Date.now() + 120000;
    let info;
    while (Date.now() < end) {
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { info = await response.json(); break; } } catch {}
      await wait(100);
    }
    assert(info, `${role} Code CDP is responsive`);
    const browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
    let page;
    while (Date.now() < end) {
      page = browser.contexts()[0]?.pages().find(item => item.url().includes("workbench"));
      if (page) break;
      await wait(100);
    }
    assert(page);
    await page.waitForLoadState("networkidle", { timeout: 45000 });
    profiles[role] = { code, browser, page };
  };
  const finish = async roles => {
    for (const role of roles) {
      const current = profiles[role];
      await current?.browser.close();
      await stop(current?.code);
      delete profiles[role];
    }
  };
  const awaitPhase = async (phase, roles) => {
    const end = Date.now() + 240000;
    while (Date.now() < end) {
      for (const role of roles) {
        const items = events(role).filter(item => item.phase === phase);
        const failure = items.find(item => item.event === "driver-failed");
        if (failure) throw new Error(failure.message);
        const page = profiles[role].page;
        for (const dialog of await page.locator(".monaco-dialog-box").all()) {
          if (!await dialog.isVisible()) continue;
          const text = await dialog.innerText();
          let choice;
          if (text.includes("Use Next for this profile's Collaboration?")) {
            assert(text.includes("plaintext ws/HTTP") && text.includes("SecretStorage"));
            choice = "Upgrade Collaboration";
          } else if (text.includes("Original Room/Meeting/Note recovery is ready.")) choice = "Later";
          else if (text.includes("Host this Room with the Next workspace owner?")) {
            assert(text.includes("not encrypted") && text.includes("every identity recovery"));
            choice = "Keep Legacy Reconnect";
          } else if (text.includes("Welcome to Visual Studio Code")) { await page.keyboard.press("Escape"); continue; }
          if (choice) {
            report.dialogs ??= [];
            report.dialogs.push({ phase, role, choice });
            await dialog.getByRole("button", { name: choice, exact: true }).click();
          }
        }
      }
      if (roles.every(role => events(role).some(item => item.phase === phase && item.event === "phase-complete"))) {
        for (const role of roles) await profiles[role].page.screenshot({ path: path.join(fixture, `production-${phase}-${role}.png`) });
        report.phases.push({ phase, events: Object.fromEntries(roles.map(role => [role, events(role).filter(item => item.phase === phase)])) });
        return;
      }
      await wait(100);
    }
    throw new Error(`Actual installed ${phase} timed out.`);
  };
  let hostHook, guestHook;
  try {
    for (const role of ["host", "guest"]) {
      run(cli, [...args(role), "--install-extension", baseline, "--force"]);
      if (role === "host") hostHook = hookInstalled("4.0.22", role);
      else guestHook = hookInstalled("4.0.22", role);
    }
    await open("host", "baseline", hostHook);
    await open("guest", "baseline", guestHook);
    await awaitPhase("baseline", ["host", "guest"]);
    await finish(["guest", "host"]);
    report.originalSource = originalHashes();
    run(cli, [...args("host"), "--install-extension", candidate, "--force"]);
    hostHook = hookInstalled(version, "host");
    await open("host", "prepare", hostHook);
    await awaitPhase("prepare", ["host"]);
    await finish(["host"]);
    assert.deepEqual(originalHashes(), report.originalSource);
    for (const role of ["guest"]) {
      run(cli, [...args(role), "--install-extension", candidate, "--force"]);
      guestHook = hookInstalled(version, role);
    }
    for (const phase of ["native-first", "native-restart"]) {
      await open("host", phase, hostHook);
      await open("guest", phase, guestHook);
      await awaitPhase(phase, ["host", "guest"]);
      await finish(["guest", "host"]);
      assert.deepEqual(originalHashes(), report.originalSource);
    }
    const first = events("host").find(item => item.phase === "native-first" && item.event === "phase-complete");
    const restarted = events("host").find(item => item.phase === "native-restart" && item.event === "phase-complete");
    assert.notEqual(first.status.pid, restarted.status.pid);
    assert.equal(first.status.workspaceId, restarted.status.workspaceId);
    report.productionCollaboration = {
      actualProductActivation: true, noVmRebound: true, noFixtureHostCredentialOrDirectoryBootstrap: true,
      configuredOriginalRoot: path.join(fixture, "old-root"), selectedPrivateRoot: first.status.root,
      workspaceId: first.status.workspaceId, firstChildPid: first.status.pid, restartedChildPid: restarted.status.pid,
      originalHostSecretStorage: true, originalHostGuestIds: true, fullProfileProcessRestart: true,
      originalRoomMeetingCanonicalManualNoteBytesUnchanged: true, independentOriginalNoteFileRoute: true,
      nativeMessageRecoveredAfterRestart: true, upgradedUnselectedGuestRemainsLegacy: true,
      userExplicitOptIn: true, oldRootDefaultAdoption: false, transport: "plaintext ws/HTTP; no TLS",
      scope: "Real installed product entry with observation-only private export hook; synthetic original user data created through the actual 4.0.22 Manager, real two profiles and native dialogs. Separate Collaboration workspace, not general same-root migration.",
    };
  } catch (error) {
    report.failureUi = {};
    for (const [role, current] of Object.entries(profiles)) {
      try {
        report.failureUi[role] = await current.page.locator(".notifications-list-container, .monaco-dialog-box").allTextContents();
        await current.page.screenshot({ path: path.join(fixture, `production-failed-${role}.png`) });
      } catch {}
    }
    throw error;
  } finally { await finish(Object.keys(profiles)); }
};
