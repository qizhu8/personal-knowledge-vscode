"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { chromium } = require("playwright");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async options => {
  const { fixture, env, editor, cli, candidate, version, launch, run, stop, hookInstalled, report } = options;
  const liveHistory = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8")).liveHistory;
  const sessions = [], dialogsSeen = [];
  let denyOwner = false;
  const read = role => {
    const file = path.join(fixture, `${role}-portal-ui-state.json`);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  async function pump(session) {
    const page = session.page;
    if (page.isClosed()) return;
    for (const dialog of await page.locator(".monaco-dialog-box").all()) {
      if (!await dialog.isVisible()) continue;
      const text = await dialog.innerText(), buttons = await dialog.getByRole("button").allTextContents();
      let choose;
      if (text.includes("Host this Room with the Next workspace owner?")) choose = liveHistory ? "Keep Legacy Reconnect" : "Use Participant Credentials";
      else if (text.includes("Save long-term permissions")) choose = "Save permissions";
      else if (text.includes("Admit this exact private Portal command?")) choose = denyOwner ? "Deny command" : "Admit command once";
      else if (text.includes("Admit this synthetic private Host credential?")) choose = "Admit private test Host";
      else if (text.includes("Force the active Host to close")) choose = "Force Close Host";
      else if (/pair|endpoint|control/i.test(text)) {
        choose = buttons.find(value => /^(Pair|Pair endpoints|Confirm|Accept|Connect|Allow|Confirm endpoint|Accept pairing|Enable control)/i.test(value.trim()));
      }
      if (choose) {
        dialogsSeen.push({ role: session.role, title: text.split("\n")[0], choice: choose.trim() });
        await dialog.getByRole("button", { name: choose.trim(), exact: true }).click();
      } else {
        fs.writeFileSync(path.join(fixture, `${session.role}-unhandled-dialog.json`), JSON.stringify({ text, buttons }), { mode: 0o600 });
      }
    }
    const quick = page.locator(".quick-input-widget");
    if (await quick.isVisible()) {
      const title = await quick.innerText();
      const input = quick.locator("input").first();
      const pick = async label => {
        try { await quick.locator(".monaco-list-row").filter({ hasText: label }).first().click({ timeout: 1500 }); }
        catch (error) { if (await quick.isVisible()) throw error; }
      };
      if (title.includes("New Portal endpoint")) {
        await input.fill(`Private ${session.role} endpoint`); await input.press("Enter");
      } else if (title.includes("Endpoint session binding")) await pick("General Enteray");
      else if (/Pair Private/.test(title)) await pick(session.role === "host" ? "Create private pairing code" : "Accept private pairing code");
      else if (title.includes("Private Portal pairing code")) {
        const link = JSON.parse(fs.readFileSync(path.join(fixture, "portal-invitation.json"), "utf8")).link;
        await input.fill(link); await input.press("Enter");
      } else if (title.includes("Local permissions accepted")) {
        const row = quick.locator(".monaco-list-row").filter({ hasText: "code-execute" }).first();
        if (await row.count()) {
          const checked = await row.getAttribute("aria-checked");
          if (checked !== "true") await row.click();
          const ok = quick.getByRole("button", { name: "OK", exact: true });
          if (await ok.count()) await ok.click(); else await input.press("Enter");
        }
      } else if (title.includes("Allow remote control of THIS machine?")) await pick("Enable receiving control");
      else {
        fs.writeFileSync(path.join(fixture, `${session.role}-unhandled-quick.json`), title, { mode: 0o600 });
      }
    }
  }
  async function until(check, label, timeout = 45000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      for (const session of sessions) await pump(session);
      for (const session of sessions) {
        const state = read(session.role);
        if (state.error) throw new Error(`${session.role}: ${state.error}`);
      }
      if (await check()) return;
      await wait(100);
    }
    for (const session of sessions) await session.page.screenshot({ path: path.join(fixture, `${session.role}-${label.replace(/\W/g, "-")}.png`) });
    throw new Error(`${label} timed out; private dialog/UI evidence retained.`);
  }
  async function frame(session) {
    for (const candidate of session.page.frames())
      if (await candidate.locator("[data-portal-command=portalEndpointCreate]").count()) return candidate;
  }
  async function click(session, selector, label) {
    await until(async () => !!await frame(session), "original Portal renderer");
    await (await frame(session)).locator(selector).first().click();
    if (label) await until(() => read(session.role).lastAction === label, label);
  }
  const hooks = new Map();
  async function launchSession(role, port) {
      const args = ["--no-sandbox", `--user-data-dir=${fixture}/${role}-user`, `--extensions-dir=${fixture}/${role}-extensions`];
      if (!hooks.has(role)) {
        run(cli, [...args, "--install-extension", candidate, "--force"]);
        hooks.set(role, hookInstalled(version, role));
      }
      const hook = hooks.get(role);
      const child = launch(editor, [...args, "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
        "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en",
        "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
        `--crash-reporter-directory=${fixture}/temp`, `--extensionDevelopmentPath=${fixture}/driver`, `${fixture}/${role}-workspace`],
      `portal-dual-${role}`, { HOME: `${fixture}/${role}-home`, USERPROFILE: `${fixture}/${role}-home`,
        PKM_MEETING_INSTALLED_FIXTURE: fixture, PKM_DUAL_PORTAL_ROLE: role });
      child.label = `portal-dual-${role}`;
      let versionInfo;
      await until(async () => {
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          if (!targets.some(target => target.type === "page" && target.url.includes("workbench"))) return false;
          versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return true;
        } catch { return false; }
      }, `${role} workbench target`, 60000);
      const browser = await chromium.connectOverCDP(versionInfo.webSocketDebuggerUrl);
      const page = browser.contexts()[0].pages().find(candidate => candidate.url().includes("workbench"));
      await page.waitForLoadState("networkidle");
      const session = { role, browser, page, child, hook };
      const index = sessions.findIndex(item => item.role === role);
      if (index >= 0) sessions[index] = session; else sessions.push(session);
      await until(() => read(role).ready, `${role} driver ready`);
      return session;
  }
  try {
    await launchSession("host", 19173);
    await launchSession("guest", 19174);
    const host = sessions[0];
    let guest = sessions[1];
    await click(host, "[data-portal-command=portalEndpointCreate]", "portalEndpointCreate");
    await click(guest, "[data-portal-command=portalEndpointCreate]", "portalEndpointCreate");
    await click(host, "[data-portal-command=portalEndpointPair]", "portalEndpointPair");
    await click(guest, "[data-portal-command=portalEndpointPair]", "portalEndpointPair");
    await until(() => read("host").confirmed && read("guest").confirmed, "private pair confirmation");
    const originalPair = read("host").pairId;
    assert.equal(read("guest").endpoint.acceptsIncoming, false);
    await click(host, "[data-test-action=command]", "command");
    await until(() => !!read("host").commandError || ["denied", "failed"].includes(read("host").receipt?.state), "receiving disabled rejects");
    assert.equal(read("guest").runs, 0);
    await click(guest, "[data-portal-command=portalEndpointPermissions]", "portalEndpointPermissions");
    await until(() => read("guest").endpoint.acceptsIncoming && read("host").confirmed, "receiving permission confirmed");
    await click(host, "[data-test-action=command]", "command");
    await until(() => read("host").receipt?.state === "completed", "owner admitted remote command");
    assert.match(read("host").receipt.result.stdout, /PRIVATE_PORTAL_OK/);
    denyOwner = true;
    await click(host, "[data-test-action=command]");
    await until(() => ["failed", "denied"].includes(read("host").receipt?.state), "independent owner denial");
    assert.equal(read("guest").runs, 1); denyOwner = false;
    await click(guest, "[data-portal-command=portalEndpointDisconnect]", "portalEndpointDisconnect");
    assert(read("guest").endpoint.paired && read("guest").endpoint.acceptsIncoming);
    await click(guest, "[data-portal-command=portalEndpointConnect]", "portalEndpointConnect");
    await until(() => read("host").confirmed && read("guest").confirmed, "saved pair reconnect");
    assert.equal(read("host").pairId, originalPair);
    await click(host, "[data-test-action=command]");
    await until(() => read("host").receipt?.state === "completed" && read("guest").runs === 2, "restored permission still needs owner approval");
    const guestBeforeRestart = read("guest");
    fs.writeFileSync(path.join(fixture, "guest-before-restart-state.json"), JSON.stringify(guestBeforeRestart), { mode: 0o600 });
    await guest.browser.close();
    await stop(guest.child);
    fs.writeFileSync(path.join(fixture, "guest-portal-ui-state.json"), '{"ready":false}', { mode: 0o600 });
    guest = await launchSession("guest", 19174);
    await until(() => read("host").confirmed && read("guest").confirmed, "full Guest Code restart restored pairing");
    assert.notEqual(read("guest").extensionHostPid, guestBeforeRestart.extensionHostPid);
    assert.equal(read("host").pairId, originalPair);
    assert.equal(read("guest").endpoint.acceptsIncoming, true);
    await click(host, "[data-test-action=command]");
    await until(() => read("host").receipt?.state === "completed" && read("guest").runs === 1,
      "restarted profile preserves policy but requires fresh owner admission");
    await click(host, "[data-test-action=create-room]", "create-room");
    await click(guest, "[data-test-action=admit-host]", "admit-host");
    await until(() => read("guest").rooms?.some(room => room.canForceClose), "foreign Host proof availability");
    let historyRestartBefore;
    if (liveHistory) {
      await click(guest, "[data-test-action=sync-history]", "sync-history");
      assert.equal(read("guest").interruptedHistoryBytes, 32768);
      historyRestartBefore = read("guest").extensionHostPid;
      await guest.browser.close(); await stop(guest.child);
      await click(host, "[data-test-action=late-history]", "late-history");
      await until(() => read("host").liveMessages === 11, "message committed while Guest Code is closed");
      fs.writeFileSync(path.join(fixture, "guest-portal-ui-state.json"), '{"ready":false}', { mode: 0o600 });
      guest = await launchSession("guest", 19174);
      assert.notEqual(read("guest").extensionHostPid, historyRestartBefore);
      assert.equal(read("guest").restoredHistoryCursor, 32768);
      await click(guest, "[data-test-action=sync-history]", "sync-history");
      assert.equal(read("guest").liveMessages, 11);
      await click(host, "[data-test-action=late-history]", "late-history");
      await until(() => read("host").liveMessages === 12, "new final message after resumed checkpoint");
    }
    await click(guest, "[data-test-action=force-close]", "force-close");
    await until(() => read("guest").forceClosePassed && read("host").roomStatus === "released", "foreign Host released");
    if (liveHistory) {
      assert.equal(read("guest").finalClosedHistoryMessages, 12);
      await click(guest, "[data-test-action=rehost-history]", "rehost-history");
      assert.equal(read("guest").rehostedLatestHistory, true);
      report.liveHistory = { originalDataCopiedByFixture: false, actualOldProtocolClients: true,
        liveMessages: 12, interruptedDurableBytes: 32768, guestRestartBefore: historyRestartBefore,
        guestRestartAfter: read("guest").extensionHostPid, resumedThenFetchedFreshHead: true,
        managerForceCloseFetchedFinalClosedHead: true, rehostDeliveredLatestHistoryAndOriginalGuestId: true,
        sourceLiveWhilePeerOffline: true, destinationHostBootstrap: "explicit private synthetic out-of-band approval",
        compatibilityPolicy: "explicit real Keep Legacy Reconnect dialog; not upgraded identity authentication",
        transport: "plaintext ws/HTTP via private source-owned fault proxy; no TLS",
        productionDefault: false };
    }
    await click(guest, "[data-test-action=revoke]", "revoke");
    assert.equal(read("guest").revoked, true);
    assert.equal(read("guest").revokedPortalEntryDenied, true);
    report.dual = { profiles: ["host", "guest"], oldRendererFixturePanel: true, actualBuiltinDialogs: true,
      pairing: true, disabledReceivingDenied: true, savedPermissions: true, independentOwnerDenial: true,
      disconnectReconnect: true, pairIdPreserved: true, foreignHostForceClose: true, ownerRevocation: true,
      fullCodeProfileRestart: true, guestExtensionHostBefore: guestBeforeRestart.extensionHostPid,
      guestExtensionHostAfter: read("guest").extensionHostPid,
      network: "private namespace loopback plaintext ws; no TLS/OS-keyring qualification",
      hostCredentialBootstrap: "explicit synthetic private out-of-band test bootstrap; not join-secret derived or production adoption" };
    report.dialogs = dialogsSeen;
    report.phases = sessions.map(session => ({ phase: "portal-dual", role: session.role, hook: session.hook }));
  } finally {
    for (const session of sessions) {
      await session.browser.close();
      await stop(session.child);
    }
  }
};
