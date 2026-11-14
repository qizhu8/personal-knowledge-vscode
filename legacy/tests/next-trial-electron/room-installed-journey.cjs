"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const project = path.resolve(__dirname, "../..");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = key => process.argv.find(item => item.startsWith(`--${key}=`))?.slice(key.length + 3);
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function main() {
  const baseline = value("baseline"), candidate = value("candidate");
  const candidateVersion = value("candidate-version") || "4.0.43";
  if (!baseline || !candidate || !path.isAbsolute(baseline) || !path.isAbsolute(candidate) || process.platform !== "linux")
    throw new Error("Usage: node tests/next-trial-electron/room-installed-journey.cjs --baseline=/absolute/old.vsix --candidate=/absolute/new.vsix");
  assert.equal(digest(baseline), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  if (!process.argv.includes("--inside")) {
    const editor = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
    const xvfb = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const args = require("../../scripts/run-next-trial-private-display").privateNamespaceArgs(
      [process.execPath, __filename, ...process.argv.slice(2), "--inside"]);
    const result = spawnSync("unshare", args, { stdio: "inherit", timeout: 900000,
      env: { PATH: process.env.PATH, PKM_UI_EDITOR: editor, PKM_UI_XVFB: xvfb, PKM_PARENT_MNT: fs.readlinkSync("/proc/self/ns/mnt") } });
    if (result.error || result.status) throw result.error || new Error(`Private Room journey failed: ${result.status ?? result.signal}`);
    return;
  }
  assert.notEqual(fs.readlinkSync("/proc/self/ns/mnt"), process.env.PKM_PARENT_MNT);
  process.umask(0o077);
  const fixture = path.join(project, ".migration-test-work", `room-installed-${randomUUID()}`);
  const mkdir = name => fs.mkdirSync(path.join(fixture, name), { recursive: true, mode: 0o700 });
  ["host-home", "guest-home", "host-user/User", "guest-user/User", "host-extensions", "guest-extensions",
    "temp", "source", "trial", "old-root", "guest-root", "host-workspace", "guest-workspace", "driver"].forEach(mkdir);
  process.chdir(fixture);
  const short = `/proc/${process.pid}/cwd`;
  fs.writeFileSync(path.join(fixture, "driver/package.json"), JSON.stringify({
    name: "room-installed-private-driver", publisher: "fixture", version: "1.0.0", engines: { vscode: "^1.90.0" },
    activationEvents: ["*"], main: "./extension.cjs"
  }));
  fs.copyFileSync(path.join(__dirname, "room-installed-driver.cjs"), path.join(fixture, "driver/extension.cjs"));
  const settings = { "window.dialogStyle": "custom", "security.workspace.trust.enabled": false,
    "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false, "update.mode": "none",
    "workbench.startupEditor": "none" };
  for (const role of ["host", "guest"])
    fs.writeFileSync(path.join(fixture, `${role}-user/User/settings.json`), JSON.stringify({
      ...settings, "personalKnowledge.storePath": path.join(fixture, role === "host" ? "old-root" : "guest-root")
    }));
  const env = { PATH: process.env.PATH, HOME: `${short}/host-home`, USERPROFILE: `${short}/host-home`,
    TMPDIR: `${fixture}/temp`, TMP: `${fixture}/temp`, TEMP: `${fixture}/temp`,
    XDG_RUNTIME_DIR: `${short}/temp`, DISPLAY: "10.77.0.1:91", XAUTHORITY: path.join(fixture, "Xauthority"),
    PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" };
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${short}/temp/session-bus`;
  env.DBUS_SYSTEM_BUS_ADDRESS = `unix:path=${short}/temp/no-system-bus`;
  Object.assign(process.env, env);
  const children = new Set();
  let codeLaunches = 0;
  function launch(command, args, extra = {}, label) {
    const child = spawn(command, args, { cwd: fixture, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const log = label && path.join(fixture, `${label}.log`);
    const record = data => {
      tail = (tail + data).slice(-8192);
      if (log) fs.appendFileSync(log, data, { mode: 0o600 });
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", error => record(`\nPROCESS_ERROR ${error.stack || error.message}\n`));
    child.on("exit", (code, signal) => record(`\nPROCESS_EXIT ${JSON.stringify({ code, signal })}\n`));
    child.diagnostic = () => tail;
    child.log = log;
    children.add(child); child.once("exit", () => children.delete(child));
    return child;
  }
  function run(command, args, extra = {}) {
    const result = spawnSync(command, args, { cwd: fixture, env: { ...env, ...extra }, encoding: "utf8", timeout: 120000 });
    if (result.error || result.status) throw result.error || new Error(`${command}: ${result.stderr}`);
    return result.stdout;
  }
  async function until(fn, label, timeout = 30000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await fn(); if (last) return last; } catch (error) { last = error; }
      await wait(100);
    }
    throw new Error(`${label} timed out${last instanceof Error ? `: ${last.message}` : ""}`);
  }
  async function stop(child) {
    if (!child) return;
    const original = child.ownedDescendants ?? (child.codeRole
      ? descendants(child.pid).map(pid => ({ pid, start: processStart(pid) })) : []);
    child.ownedDescendants = original;
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([done, wait(7000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await done; }
    }
    const survivors = () => original.filter(({ pid, start }) =>
      start !== undefined && processStart(pid) === start && !processStopped(pid));
    if (survivors().length) {
      fs.appendFileSync(path.join(fixture, "process-cleanup.jsonl"), JSON.stringify({
        role: child.codeRole, codePid: child.pid, survivors: survivors().map(record => {
          let argv;
          try { argv = fs.readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch {}
          return { ...record, argv };
        }),
      }) + "\n", { mode: 0o600 });
      for (const { pid } of survivors()) {
        try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      const deadline = Date.now() + 5000;
      while (survivors().length && Date.now() < deadline) await wait(100);
      for (const { pid } of survivors()) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    if (original.length) await until(() => !survivors().length, `${child.codeRole} Code descendants stopped`, 20000);
    await wait(1000);
  }
  function processStart(pid) {
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[19]; }
    catch { return undefined; }
  }
  function descendants(pid) {
    let children = [];
    try {
      for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
        try {
          const found = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
          children.push(...found);
        } catch { /* A thread can exit during enumeration. */ }
      }
    }
    catch { return []; }
    return [...new Set(children)].flatMap(child => [child, ...descendants(child)]);
  }
  function processStopped(pid) {
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").startsWith("Z "); }
    catch { return true; }
  }
  function roleEnv(role) { return { HOME: `${short}/${role}-home`, USERPROFILE: `${short}/${role}-home` }; }
  const editor = process.env.PKM_UI_EDITOR, cli = path.join(path.dirname(editor), "bin/code");
  const roleArgs = role => ["--no-sandbox", `--user-data-dir=${fixture}/${role}-user`, `--extensions-dir=${fixture}/${role}-extensions`];
  function install(role, vsix, version) {
    run(cli, [...roleArgs(role), "--install-extension", vsix, "--force"], roleEnv(role));
    const list = run(cli, [...roleArgs(role), "--list-extensions", "--show-versions"], roleEnv(role));
    assert(list.toLowerCase().split(/\r?\n/).includes(`uone.personal-knowledge@${version}`),
      `${role} does not have the expected installed extension`);
  }
  const relaySource = 'const net=require("node:net");net.createServer(s=>{const t=net.connect(+process.argv[3],"127.0.0.1");s.on("error",()=>t.destroy());t.on("error",()=>s.destroy());s.pipe(t).pipe(s)}).listen(+process.argv[2],process.argv[1]);';
  let host, guest, guestNamespace, hostRelay, hostBrowser, guestBrowser, sequence = 0, completed = false, report;
  const eventsFile = path.join(fixture, "host-events.jsonl");
  const events = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const eventCount = name => events().filter(event => event.event === name).length;
  async function eventAfter(name, before, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const error = events().find(event => event.event === "driver-failed" || event.event === "error");
      if (error) throw new Error(`Host driver ${error.event}: ${error.message}`);
      if (eventCount(name) > before) return;
      await wait(100);
    }
    throw new Error(`Host ${name} timed out`);
  }
  function command(action) {
    const target = path.join(fixture, "host-command.json"), staging = `${target}.next`;
    fs.writeFileSync(staging, JSON.stringify({ sequence: ++sequence, action }), { mode: 0o600 });
    fs.renameSync(staging, target);
  }
  async function cdp(address) {
    let info;
    try {
      info = await until(async () => {
        const result = await fetch(`http://${address}/json/version`);
        return result.ok && await result.json();
      }, `CDP ${address}`, 60000);
    } catch (error) {
      const child = address.startsWith("127.0.0.1:9333") ? host : guest;
      console.error("ROOM_CDP_DIAGNOSTIC", JSON.stringify({ address, pid: child?.pid, code: child?.exitCode,
        signal: child?.signalCode, descendants: child?.pid ? descendants(child.pid) : [], log: child?.log,
        tail: child?.diagnostic() }));
      throw error;
    }
    const endpoint = new URL(info.webSocketDebuggerUrl);
    endpoint.host = address;
    return chromium.connectOverCDP(endpoint.toString());
  }
  async function openRoom(browser) {
    const page = await until(() => browser.contexts()[0]?.pages().find(item => item.url().includes("workbench")), "VS Code workbench", 60000);
    await page.waitForLoadState("networkidle", { timeout: 45000 });
    await page.bringToFront();
    const welcome = page.getByRole("dialog", { name: "Welcome to Visual Studio Code", exact: true });
    await page.addLocatorHandler(welcome, async () => page.keyboard.press("Escape"));
    if (await welcome.isVisible()) await page.keyboard.press("Escape");
    try { await page.getByRole("button", { name: "Open Quick Access", exact: true }).click({ timeout: 10000 }); }
    catch (error) {
      console.error("ROOM_UI_BLOCKER", JSON.stringify(await page.locator(".monaco-dialog-box").allInnerTexts()));
      throw error;
    }
    const input = page.locator(".quick-input-widget input");
    await input.waitFor({ state: "visible", timeout: 30000 });
    await input.fill(">Personal Knowledge Manager: Open Chatroom");
    const row = page.locator(".quick-input-widget .monaco-list-row").filter({ hasText: "Personal Knowledge Manager: Open Chatroom" });
    await row.first().click({ timeout: 30000 });
    const frame = await until(async () => {
      for (const frame of page.frames()) if (await frame.locator("#chat-root").count()) return frame;
    }, "Room webview", 45000);
    return { page, frame };
  }
  async function startCode(role, driver = false) {
    const args = [...roleArgs(role), "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en",
      "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${role === "host" ? 9333 : 9334}`,
      `--crash-reporter-directory=${fixture}/temp`, ...(driver ? [`--extensionDevelopmentPath=${fixture}/driver`] : []),
      `${fixture}/${role}-workspace`];
    const label = `${role}-start-${++codeLaunches}`;
    const child = role === "host" ? launch(editor, args, { ...roleEnv(role), PKM_ROOM_INSTALLED_FIXTURE: fixture }, label)
      : launch("nsenter", ["-t", String(guestNamespace.pid), "-n", "--", editor, ...args], roleEnv(role), label);
    child.codeRole = role;
    return child;
  }
  async function join(frame, room = "Fixture Room", secret = "synthetic-fixture-room-secret") {
    if (!await frame.locator("#chat-join").isVisible()) await frame.locator('button[onclick="chatToggleJoin()"]').click();
    await frame.locator("#chat-url").fill("ws://10.77.0.1:7345");
    await frame.locator("#chat-room").fill(room);
    await frame.locator("#chat-name").fill("Fixture Guest");
    await frame.locator("#chat-secret-in").fill(secret);
    await frame.locator('button[onclick="chatDoJoin()"]').click();
  }
  async function connected(frame) {
    return until(() => frame.evaluate(() => {
      if (!chat.active || chat.active.status !== "connected") return null;
      const self = chat.active.members.find(member => member.user === "Fixture Guest" && member.present !== false);
      return self && { participantId: self.participantId, sid: self.sid };
    }), "Guest connected with participant identity", 45000);
  }
  async function leave(frame) {
    await frame.locator("#chat-leave-btn").click();
    await until(() => frame.evaluate(() => !chat.active), "Guest left");
    await wait(300);
  }
  async function approval(page, approve, participantId) {
    await page.bringToFront();
    const previous = eventCount("approval-dialog");
    command("review");
    await eventAfter("approval-dialog", previous);
    const dialog = page.getByRole("dialog").filter({ hasText: "Restore this historical participant identity?" });
    await dialog.waitFor({ state: "visible" });
    const text = await dialog.innerText();
    assert(text.includes(participantId) && text.includes("Fixture Guest") && text.includes("out of band"),
      "Actual Host dialog must identify the historical participant and verification risk");
    await dialog.getByRole("button", { name: approve ? "Approve Identity Recovery" : "Cancel", exact: true }).click();
  }
  try {
    run("ip", ["link", "set", "lo", "up"]);
    const busConfig = path.join(fixture, "session-bus.conf");
    fs.writeFileSync(busConfig, `<busconfig><type>session</type><listen>${env.DBUS_SESSION_BUS_ADDRESS}</listen>
      <auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow own="*"/>
      <allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/></policy></busconfig>`, { mode: 0o600 });
    const bus = launch("dbus-daemon", ["--nofork", `--config-file=${busConfig}`], {}, "session-bus");
    await until(() => {
      if (bus.exitCode !== null || bus.signalCode !== null) throw new Error(bus.diagnostic());
      return fs.existsSync(path.join(fixture, "temp/session-bus"));
    }, "Private session bus");
    guestNamespace = launch("unshare", ["-n", process.execPath, "-e", "setInterval(()=>{},1000)"]);
    await until(() => guestNamespace.pid && fs.existsSync(`/proc/${guestNamespace.pid}/ns/net`), "Guest network namespace");
    run("ip", ["link", "add", "room-host", "type", "veth", "peer", "name", "room-guest"]);
    run("ip", ["link", "set", "room-guest", "netns", String(guestNamespace.pid)]);
    run("ip", ["addr", "add", "10.77.0.1/30", "dev", "room-host"]);
    run("ip", ["link", "set", "room-host", "up"]);
    const inGuest = args => run("nsenter", ["-t", String(guestNamespace.pid), "-n", "--", "ip", ...args]);
    inGuest(["link", "set", "lo", "up"]);
    inGuest(["addr", "add", "10.77.0.2/30", "dev", "room-guest"]);
    inGuest(["link", "set", "room-guest", "up"]);
    fs.writeFileSync(env.XAUTHORITY, "", { mode: 0o600 });
    run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
    const x = launch(process.env.PKM_UI_XVFB, [":91", "-screen", "0", "1440x1100x24", "-nolock",
      "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY]);
    await until(() => spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0,
      `private Xvfb ${x.diagnostic()}`);
    launch("nsenter", ["-t", String(guestNamespace.pid), "-n", "--", process.execPath, "-e", relaySource,
      "10.77.0.2", "9334", "9334"]);
    for (const role of ["host", "guest"]) install(role, baseline, "4.0.22");
    console.log("ROOM_STAGE baseline installed");
    host = await startCode("host"); guest = await startCode("guest");
    hostBrowser = await cdp("127.0.0.1:9333"); guestBrowser = await cdp("10.77.0.2:9334");
    let oldHost = await openRoom(hostBrowser);
    const oldGuest = await openRoom(guestBrowser);
    await oldHost.frame.locator("#chat-host-toggle").click();
    await oldHost.frame.locator("#chat-hub-room").fill("Fixture Room");
    await oldHost.frame.locator("#chat-hub-name").fill("Fixture Host");
    await oldHost.frame.locator("#chat-hub-key").fill("synthetic-fixture-room-secret");
    await oldHost.frame.locator("#chat-hub-port").fill("7345");
    await oldHost.frame.locator('button[onclick="chatHostRoom()"]').click();
    const roomId = await until(() => oldHost.frame.evaluate(() => chat.hubAdminRooms?.[0]?.roomId), "Old Host room ID", 45000);
    await join(oldGuest.frame);
    const oldIdentity = await connected(oldGuest.frame);
    assert(typeof oldIdentity.participantId === "string" && oldIdentity.participantId.length > 0
      && typeof oldIdentity.sid === "string" && oldIdentity.sid.length > 0,
    "Original Guest identity must include real participant and client identifiers");
    await oldGuest.frame.locator("#chat-input").fill("Private upgrade history fixture");
    await oldGuest.frame.locator("#chat-send-btn").click();
    await until(() => oldHost.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "Private upgrade history fixture")), "Original Host received Guest's message");
    await leave(oldGuest.frame);
    await until(() => oldHost.frame.evaluate(() => {
      const guest = chat.active?.members.find(member => member.user === "Fixture Guest");
      return guest?.present === false;
    }), "Original Host observed Guest leave");
    await join(oldGuest.frame);
    assert.deepEqual(await connected(oldGuest.frame), oldIdentity, "Original old Host must resume the same identity without Host approval");
    console.log("ROOM_STAGE baseline automatic historical identity");
    await leave(oldGuest.frame);
    await oldHost.frame.locator("#chat-host-toggle").click();
    await oldHost.frame.locator("#chat-hub-room").fill("Fixture Room Two");
    await oldHost.frame.locator("#chat-hub-name").fill("Fixture Host");
    await oldHost.frame.locator("#chat-hub-key").fill("synthetic-fixture-second-secret");
    await oldHost.frame.locator('button[onclick="chatHostRoom()"]').click();
    const roomIds = await until(() => oldHost.frame.evaluate(() => chat.hubAdminRooms?.length === 2
      && chat.hubAdminRooms.map(room => room.roomId)), "Original two simultaneous Rooms", 45000);
    const secondRoomId = roomIds.find(id => id !== roomId);
    assert(secondRoomId);
    await join(oldGuest.frame, "Fixture Room Two", "synthetic-fixture-second-secret");
    const oldSecondIdentity = await connected(oldGuest.frame);
    await oldGuest.frame.locator("#chat-input").fill("Second Room private history");
    await oldGuest.frame.locator("#chat-send-btn").click();
    await until(() => oldHost.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "Second Room private history")), "Original second Room history");
    await leave(oldGuest.frame);
    console.log("ROOM_STAGE original two active Rooms share one Hub");
    await hostBrowser.close(); await stop(host);
    host = await startCode("host"); hostBrowser = await cdp("127.0.0.1:9333");
    oldHost = await openRoom(hostBrowser);
    assert.equal(await oldHost.frame.evaluate(() => chat.hubRunning), false,
      "Original Host does not automatically reopen the Hub after VS Code restart");
    await oldHost.frame.locator("#chat-hosted-rooms .chat-room-card-divider").click({ timeout: 45000 });
    const oldRehost = oldHost.frame.locator('[title="Rehost this Room"]');
    try { await oldRehost.first().waitFor({ state: "visible", timeout: 45000 }); }
    catch (error) {
      console.error("ORIGINAL_REHOST_DIAGNOSTIC", JSON.stringify(await oldHost.frame.evaluate(() => ({
        hubRunning: chat.hubRunning, storedRooms: chat.storedRooms, hubAdminRooms: chat.hubAdminRooms,
        hostedMarkup: document.querySelector("#chat-hosted-rooms")?.innerHTML,
      }))));
      throw error;
    }
    assert.equal(await oldRehost.count(), 2, "Both Rooms remain inactive after original Host restart");
    const firstCard = oldHost.frame.locator("#chat-hosted-rooms").locator(".chat-room-card").filter({ hasText: "Fixture Room" })
      .filter({ hasNotText: "Fixture Room Two" });
    await firstCard.locator('[title="Rehost this Room"]').click();
    await until(() => oldHost.frame.evaluate(() => chat.hubRunning && chat.hubAdminRooms?.length === 1),
      "Original Host manually rehosted exactly one Room after restart");
    await oldHost.frame.locator("#chat-hosted-rooms").locator(".chat-room-card").filter({ hasText: "Fixture Room Two" })
      .locator('[title="Rehost this Room"]').click();
    await until(() => oldHost.frame.evaluate(() => chat.hubRunning && chat.hubAdminRooms?.length === 2),
      "Original Host manually rehosted second Room on the same Hub");
    await join(oldGuest.frame);
    assert.deepEqual(await connected(oldGuest.frame), oldIdentity, "Original Host restart preserves historical Guest identity");
    await leave(oldGuest.frame);
    await join(oldGuest.frame, "Fixture Room Two", "synthetic-fixture-second-secret");
    assert.deepEqual(await connected(oldGuest.frame), oldSecondIdentity, "Original second Room preserves its own Guest identity");
    await until(() => oldGuest.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "Second Room private history")), "Original second Room history after rehost");
    await leave(oldGuest.frame);
    console.log("ROOM_STAGE original Host restart requires manual rehost");
    await oldHost.frame.locator("#chat-stophub-btn").click();
    await until(() => oldHost.frame.evaluate(() => !chat.hubRunning), "Old Hub stopped");
    await guestBrowser.close(); await hostBrowser.close(); await stop(guest); await stop(host);
    const oldRooms = path.join(fixture, "old-root", "chatrooms");
    fs.cpSync(oldRooms, path.join(fixture, "source/chatrooms"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "driver-config.json"), JSON.stringify({ source: path.join(fixture, "source"),
      trial: path.join(fixture, "trial"), node: process.execPath, roomId, roomIds: [roomId, secondRoomId], port: 7345 }));
    install("host", candidate, candidateVersion);
    hostRelay = launch(process.execPath, ["-e", relaySource, "10.77.0.1", "7345", "7345"]);
    host = await startCode("host", true); guest = await startCode("guest");
    hostBrowser = await cdp("127.0.0.1:9333"); guestBrowser = await cdp("10.77.0.2:9334");
    let hostPage = await until(() => hostBrowser.contexts()[0]?.pages().find(page => page.url().includes("workbench")), "New Host workbench");
    await eventAfter("host-menu-ready", 0, 90000);
    let menu = eventCount("host-menu-ready");
    command("add"); await eventAfter("host-menu-ready", menu, 90000);
    await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 2, "Two upgraded Rooms share one Hub");
    menu = eventCount("host-menu-ready"); command("close-one"); await eventAfter("host-menu-ready", menu);
    await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 1, "Closing one upgraded Room leaves the other active");
    menu = eventCount("host-menu-ready"); command("add"); await eventAfter("host-menu-ready", menu);
    await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 2, "Second upgraded Room rehosted");
    menu = eventCount("host-menu-ready"); command("switch0"); await eventAfter("host-menu-ready", menu);
    console.log("ROOM_STAGE upgraded Host ready");
    const oldGuestAgain = await openRoom(guestBrowser);
    let pending = eventCount("participant-pending");
    await join(oldGuestAgain.frame); await eventAfter("participant-pending", pending);
    await approval(hostPage, false, oldIdentity.participantId);
    await until(() => oldGuestAgain.frame.evaluate(() => !chat.active), "Rejected old Guest disconnected");
    for (let i = 0; i < 2; i++) {
      pending = eventCount("participant-pending");
      await join(oldGuestAgain.frame); await eventAfter("participant-pending", pending);
      await approval(hostPage, true, oldIdentity.participantId);
      assert.deepEqual(await connected(oldGuestAgain.frame), oldIdentity);
      if (i === 0) await leave(oldGuestAgain.frame);
    }
    pending = eventCount("participant-pending");
    await stop(hostRelay);
    await until(() => oldGuestAgain.frame.evaluate(() => chat.active && chat.active.status !== "connected"),
      "Old Guest observed network interruption");
    hostRelay = launch(process.execPath, ["-e", relaySource, "10.77.0.1", "7345", "7345"]);
    await eventAfter("participant-pending", pending);
    await approval(hostPage, true, oldIdentity.participantId);
    assert.deepEqual(await connected(oldGuestAgain.frame), oldIdentity);
    await leave(oldGuestAgain.frame);
    console.log("ROOM_STAGE old Guest rejected and approved twice, then approved after automatic network retry");
    menu = eventCount("host-menu-ready"); command("new"); await eventAfter("host-menu-ready", menu, 90000);
    const newRoom = await until(async () => {
      const state = await (await fetch("http://127.0.0.1:7345/health")).json();
      return state.activeRooms?.find(room => room.room === "Fixture New Room");
    }, "New native Room on shared Hub");
    const configFile = path.join(fixture, "driver-config.json");
    const newConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
    newConfig.roomIds.push(newRoom.roomId);
    fs.writeFileSync(configFile, JSON.stringify(newConfig), { mode: 0o600 });
    await join(oldGuestAgain.frame, "Fixture New Room", "synthetic-new-secret");
    const oldNativeIdentity = await connected(oldGuestAgain.frame);
    menu = eventCount("host-menu-ready"); command("send-new"); await eventAfter("host-menu-ready", menu);
    await until(async () => (await oldGuestAgain.frame.locator("#chat-log").textContent())?.includes(
      "Native-created Room message"), "Old Guest receives new native Room message");
    await leave(oldGuestAgain.frame);
    pending = eventCount("participant-pending");
    await join(oldGuestAgain.frame, "Fixture New Room", "synthetic-new-secret");
    await eventAfter("participant-pending", pending);
    await approval(hostPage, true, oldNativeIdentity.participantId);
    assert.deepEqual(await connected(oldGuestAgain.frame), oldNativeIdentity, "Old Guest identity requires explicit repeat approval");
    await leave(oldGuestAgain.frame);
    menu = eventCount("host-menu-ready"); command("switch0"); await eventAfter("host-menu-ready", menu);
    console.log("ROOM_STAGE native Room creation and original Guest repeat approval");
    await guestBrowser.close(); await stop(guest);
    install("guest", candidate, candidateVersion);
    guest = await startCode("guest"); guestBrowser = await cdp("10.77.0.2:9334");
    let currentGuest = await openRoom(guestBrowser);
    pending = eventCount("participant-pending");
    await join(currentGuest.frame); await eventAfter("participant-pending", pending);
    await approval(hostPage, true, oldIdentity.participantId);
    assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
    await until(() => currentGuest.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "Private upgrade history fixture")), "Upgraded Guest received original history");
    await leave(currentGuest.frame); pending = eventCount("participant-pending");
    await join(currentGuest.frame); assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
    assert.equal(eventCount("participant-pending"), pending, "Stored credential reconnect must not request approval");
    await leave(currentGuest.frame);
    menu = eventCount("host-menu-ready"); command("switch1"); await eventAfter("host-menu-ready", menu);
    pending = eventCount("participant-pending");
    await join(currentGuest.frame, "Fixture Room Two", "synthetic-fixture-second-secret");
    await eventAfter("participant-pending", pending);
    await approval(hostPage, true, oldSecondIdentity.participantId);
    assert.deepEqual(await connected(currentGuest.frame), oldSecondIdentity);
    await until(() => currentGuest.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "Second Room private history")), "Upgraded second Room retains its own history");
    await leave(currentGuest.frame);
    menu = eventCount("host-menu-ready"); command("switch0"); await eventAfter("host-menu-ready", menu);
    pending = eventCount("participant-pending");
    await join(currentGuest.frame); assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
    assert.equal(eventCount("participant-pending"), pending, "Room A proof remains separate from Room B approval");
    console.log("ROOM_STAGE upgraded Guest approved and rejoined");
    await leave(currentGuest.frame);
    await guestBrowser.close(); await stop(guest);
    guest = await startCode("guest"); guestBrowser = await cdp("10.77.0.2:9334");
    currentGuest = await openRoom(guestBrowser); pending = eventCount("participant-pending");
    await join(currentGuest.frame); assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
    assert.equal(eventCount("participant-pending"), pending, "Guest process restart must retain credential");
    console.log("ROOM_STAGE upgraded Guest process restarted");
    await stop(hostRelay);
    await until(() => currentGuest.frame.evaluate(() => chat.active && chat.active.status !== "connected"),
      "Guest observed unexpected network interruption");
    hostRelay = launch(process.execPath, ["-e", relaySource, "10.77.0.1", "7345", "7345"]);
    assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
    assert.equal(eventCount("participant-pending"), pending, "Unexpected network reconnect must not request approval");
    console.log("ROOM_STAGE upgraded Guest automatically recovered network");
    const stopped = eventCount("host-stopped"), ready = eventCount("host-menu-ready");
    command("stop"); await eventAfter("host-stopped", stopped);
    try {
      await until(() => currentGuest.frame.evaluate(() => chat.active?.status === "disconnected"
        && chat.active.messages.some(message => message.text.startsWith("Room closed ("))),
      "Guest observed explicit Room shutdown", 10000);
    } catch (error) {
      console.error("ROOM_STOP_STATUS", JSON.stringify(await currentGuest.frame.evaluate(() => ({
        status: chat.active?.status, detail: chat.active?.statusDetail,
        recent: chat.active?.messages.slice(-3).map(message => message.text),
      }))));
      throw error;
    }
    command("rehost"); await eventAfter("host-menu-ready", ready, 60000);
    await join(currentGuest.frame);
    assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
    assert.equal(eventCount("participant-pending"), pending, "Manual rejoin after rehost must not require approval");
    menu = eventCount("host-menu-ready"); command("add"); await eventAfter("host-menu-ready", menu);
    await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 2,
      "Both Rooms active before Host SIGKILL");
    menu = eventCount("host-menu-ready"); command("switch0"); await eventAfter("host-menu-ready", menu);
    console.log("ROOM_STAGE same-trial Host rehost and manual rejoin");
    let activeRestartReconnect, killedHostEvidence;
    for (let round = 0; round < 2; round++) {
      const beforeStop = eventCount("host-stopped"), beforeReady = eventCount("host-menu-ready");
      if (round === 1) {
        command("stop"); await eventAfter("host-stopped", beforeStop);
        await until(() => currentGuest.frame.evaluate(() => chat.active?.status === "disconnected"
          && chat.active.messages.some(message => message.text.startsWith("Room closed ("))), "Guest observed Host shutdown");
      }
      if (round === 0) {
        const activation = events().filter(event => event.event === "product-activated").at(-1);
        const extensionHostPid = activation?.extensionHostPid;
        const tree = descendants(host.pid);
        assert(Number.isInteger(extensionHostPid) && tree.includes(extensionHostPid),
          `Actual installed extension Host ${extensionHostPid} must belong to isolated Code ${host.pid}; descendants ${tree.join(",")}`);
        const nativePid = descendants(extensionHostPid).find(pid => {
          try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("managed-client-child.js"); }
          catch { return false; }
        });
        assert(nativePid, "The real extension Host must own the actual Room native child");
        process.kill(extensionHostPid, "SIGKILL");
        await until(() => processStopped(extensionHostPid), "Installed extension Host SIGKILL");
        await until(() => processStopped(nativePid), "Native Room child exited after Host SIGKILL", 45000);
        killedHostEvidence = { codePid: host.pid, extensionHostPid, nativePid, signal: "SIGKILL",
          extensionHostStopped: true, nativeChildStopped: true };
      }
      await hostBrowser.close(); await stop(host);
      const observed = await until(() => currentGuest.frame.evaluate(() => chat.active?.status !== "connected" &&
        ({ status: chat.active?.status, detail: chat.active?.statusDetail })), "Guest observed Host process exit");
      const beforeDialog = eventCount("recovery-dialog");
      const configFile = path.join(fixture, "driver-config.json");
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      config.recoveryMode = round === 0 ? "proof-required" : "host-approval";
      fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      host = await startCode("host", true); hostBrowser = await cdp("127.0.0.1:9333");
      hostPage = await until(() => hostBrowser.contexts()[0]?.pages().find(page => page.url().includes("workbench")), "Recovered Host workbench");
      await eventAfter("recovery-dialog", beforeDialog, 90000);
      const dialog = hostPage.getByRole("dialog").filter({ hasText: "Reopen the saved isolated Room" });
      await dialog.waitFor({ state: "visible" });
      assert((await dialog.innerText()).includes("not encrypted"), "Recovery must disclose plaintext WebSocket");
      await dialog.getByRole("button", { name: "Reopen Room", exact: true }).click();
      await eventAfter("host-menu-ready", beforeReady, 90000);
      await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 1,
        "Recovery rehosts only the explicitly selected Room");
      const beforeAdd = eventCount("host-menu-ready");
      command("add"); await eventAfter("host-menu-ready", beforeAdd, 90000);
      await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 2,
        "Explicit second Room rehost after complete restart");
      const beforeSwitch = eventCount("host-menu-ready");
      command("switch0"); await eventAfter("host-menu-ready", beforeSwitch);
      if (observed.status === "disconnected") await join(currentGuest.frame);
      assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
      if (round === 0) activeRestartReconnect = observed.status === "disconnected" ? "manual-after-closed" : "automatic";
      assert.equal(eventCount("participant-pending"), pending, "Host process restart must retain participant proof");
      if (round === 0) {
        await leave(currentGuest.frame);
        await guestBrowser.close(); await stop(guest);
        guest = await startCode("guest"); guestBrowser = await cdp("10.77.0.2:9334");
        currentGuest = await openRoom(guestBrowser);
        await join(currentGuest.frame);
        assert.deepEqual(await connected(currentGuest.frame), oldIdentity);
        await until(() => currentGuest.frame.evaluate(() => chat.active?.messages.some(message =>
          message.text === "Private upgrade history fixture")), "Fresh Guest process received history after Host restart");
        assert.equal(eventCount("participant-pending"), pending, "Guest restart after Host restart must retain participant proof");
      }
    }
    console.log("ROOM_STAGE two complete Host restarts and manual Guest rejoins");
    await leave(currentGuest.frame);
    menu = eventCount("host-menu-ready"); command("add-native"); await eventAfter("host-menu-ready", menu, 90000);
    await until(async () => (await (await fetch("http://127.0.0.1:7345/health")).json()).rooms === 3,
      "New native Room explicitly rehosted alongside legacy Rooms");
    pending = eventCount("participant-pending");
    await join(currentGuest.frame, "Fixture New Room", "synthetic-new-secret");
    await eventAfter("participant-pending", pending);
    await approval(hostPage, true, oldNativeIdentity.participantId);
    assert.deepEqual(await connected(currentGuest.frame), oldNativeIdentity);
    await until(() => currentGuest.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "@all Native-created Room message")), "New Room history survived full Host restart");
    await leave(currentGuest.frame);
    pending = eventCount("participant-pending");
    await join(currentGuest.frame, "Fixture New Room", "synthetic-new-secret");
    assert.deepEqual(await connected(currentGuest.frame), oldNativeIdentity);
    assert.equal(eventCount("participant-pending"), pending, "Upgraded Guest retains its new Room credential");
    const nativeHostPid = events().filter(event => event.event === "product-activated").at(-1)?.extensionHostPid;
    assert(Number.isInteger(nativeHostPid) && descendants(host.pid).includes(nativeHostPid));
    const nativeChildPid = descendants(nativeHostPid).find(pid => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("managed-client-child.js"); }
      catch { return false; }
    });
    assert(nativeChildPid, "Native Room runs in the actual managed child");
    process.kill(nativeHostPid, "SIGKILL");
    await until(() => processStopped(nativeHostPid) && processStopped(nativeChildPid), "New Room Host and child stopped after SIGKILL", 45000);
    await hostBrowser.close(); await stop(host);
    const nativeDisconnect = await until(() => currentGuest.frame.evaluate(() => chat.active?.status !== "connected" &&
      ({ status: chat.active?.status, detail: chat.active?.statusDetail })), "New Room Guest observed Host death");
    const savedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
    savedConfig.resumeRoomId = newRoom.roomId;
    fs.writeFileSync(configFile, JSON.stringify(savedConfig), { mode: 0o600 });
    const beforeNativeDialog = eventCount("recovery-dialog"), beforeNativeMenu = eventCount("host-menu-ready");
    host = await startCode("host", true); hostBrowser = await cdp("127.0.0.1:9333");
    hostPage = await until(() => hostBrowser.contexts()[0]?.pages().find(page => page.url().includes("workbench")), "New Room recovered Host");
    await eventAfter("recovery-dialog", beforeNativeDialog, 90000);
    const nativeDialog = hostPage.getByRole("dialog").filter({ hasText: "Reopen the saved isolated Room" });
    await nativeDialog.getByRole("button", { name: "Reopen Room", exact: true }).click();
    await eventAfter("host-menu-ready", beforeNativeMenu, 90000);
    if (nativeDisconnect.status === "disconnected") await join(currentGuest.frame, "Fixture New Room", "synthetic-new-secret");
    assert.deepEqual(await connected(currentGuest.frame), oldNativeIdentity);
    assert.equal(eventCount("participant-pending"), pending, "New Room participant credential survives Host SIGKILL");
    await until(() => currentGuest.frame.evaluate(() => chat.active?.messages.some(message =>
      message.text === "@all Native-created Room message")), "New Room history after SIGKILL");
    console.log("ROOM_STAGE new native Room Host SIGKILL and recovery");
    await leave(currentGuest.frame);
    const finalStop = eventCount("host-stopped");
    command("stop"); await eventAfter("host-stopped", finalStop);
    command("close"); await eventAfter("driver-finished", 0);
    await hostBrowser.close(); await stop(host);
    const formTrial = path.join(fixture, "form-trial");
    fs.mkdirSync(formTrial, { mode: 0o700 });
    const formConfig = { ...savedConfig, trial: formTrial, formEntry: true, recoveryMode: "proof-required" };
    fs.writeFileSync(configFile, JSON.stringify(formConfig), { mode: 0o600 });
    const formFinished = eventCount("driver-finished"), formMenu = eventCount("host-menu-ready");
    host = await startCode("host", true); hostBrowser = await cdp("127.0.0.1:9333");
    await eventAfter("form-driver-ready", 0, 90000);
    const formHost = await openRoom(hostBrowser);
    await formHost.frame.locator("#chat-host-toggle").click();
    await formHost.frame.locator("#chat-hub-room").fill("Form Created Room");
    await formHost.frame.locator("#chat-hub-name").fill("Form Host");
    await formHost.frame.locator("#chat-hub-key").fill("synthetic-form-secret");
    await formHost.frame.locator("#chat-hub-port").fill("7345");
    await formHost.frame.getByRole("button", { name: "Host in isolated Next trial…", exact: true }).click();
    assert.equal(await formHost.frame.locator("#chat-hub-key").inputValue(), "");
    await eventAfter("form-trial-confirm", 0);
    const formTrialDialog = formHost.page.getByRole("dialog").filter({ hasText: "Create a disposable PKM Next trial" });
    await formTrialDialog.getByRole("button", { name: "Create Trial", exact: true }).click();
    const input = formHost.page.locator(".quick-input-widget input");
    for (const expected of ["Form Created Room", "Form Host", "synthetic-form-secret", "7345"]) {
      await until(async () => await input.isVisible() && await input.inputValue() === expected, `Prefilled Room input ${expected === "synthetic-form-secret" ? "secret" : expected}`);
      await formHost.page.keyboard.press("Enter");
      await wait(100);
    }
    await eventAfter("form-host-confirm", 0);
    const formHostDialog = formHost.page.getByRole("dialog").filter({ hasText: "Copy and host this Room only inside the disposable Next trial" });
    assert((await formHostDialog.innerText()).includes("not encrypted"), "Form-host confirmation discloses plaintext");
    await formHostDialog.getByRole("button", { name: "Host Isolated Room", exact: true }).click();
    await eventAfter("host-menu-ready", formMenu, 90000);
    await join(currentGuest.frame, "Form Created Room", "synthetic-form-secret");
    await connected(currentGuest.frame);
    await leave(currentGuest.frame);
    command("stop"); await eventAfter("driver-finished", formFinished, 90000);
    console.log("ROOM_STAGE legacy Chatroom form created and hosted an isolated Next Room");
    const candidateMetadata = path.join(path.dirname(candidate), "candidate.json");
    const snapshot = fs.existsSync(candidateMetadata) ? JSON.parse(fs.readFileSync(candidateMetadata, "utf8")) : undefined;
    if (snapshot) assert.equal(snapshot.vsixSha256, digest(candidate), "Candidate snapshot metadata does not match installed bytes");
    report = { baseline: digest(baseline), candidate: digest(candidate), sourceSnapshot: snapshot?.sourceSha256 ?? null,
      roomId, participantId: oldIdentity.participantId,
      oldHostAutomatic: true, rejection: true, oldClientRepeatedApproval: true,
      oldClientNetworkRetryRequiredApproval: true, upgradedResume: true,
      historicalMessage: true, guestProcessRestart: true, networkAutoReconnect: true,
      sameTrialHostRehostManualRejoin: true, originalHostRestartManualRehost: true,
      hostProcessRestarts: 2, activeHostRestartReconnect: activeRestartReconnect, stoppedHostRestartManualGuestRejoin: true,
      actualHostSigkill: killedHostEvidence, originalTwoRoomSharedHub: true, originalRestartManualEachRoom: true,
      independentlyClosedSecondRoom: true, explicitSecondRoomRecovery: true,
      nativeCreatedRoomId: newRoom.roomId, nativeCreatedHostSigkill: { extensionHostPid: nativeHostPid, nativeChildPid },
      nativeOriginalGuestRepeatedApproval: true, nativeHistoryAndCredentialAfterSigkill: true,
      legacyChatroomFormCreatedIsolatedNextRoom: true,
      freshGuestHistoryAfterHostRestart: true,
      proofRequiredRestartWithStablePort: true, hostApprovalRestartWithStablePort: true,
      backgroundErrors: events().filter(event => event.event === "background-error").map(event => event.message),
      driverSha256: digest(path.join(__dirname, "room-installed-driver.cjs")), controllerSha256: digest(__filename),
      scope: "separate private user-data directories (default profiles), separate network namespaces, scripted setup and real approval dialog",
      passwordStore: "VS Code basic; OS keyring and encryption at rest not qualified", transport: "isolated plaintext ws" };
    completed = true;
  } finally {
    if (guestBrowser) await guestBrowser.close().catch(() => {});
    if (hostBrowser) await hostBrowser.close().catch(() => {});
    const cleanupErrors = [];
    for (const child of [...children]) {
      try { await stop(child); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        cleanupErrors.push(detail);
        console.error("ROOM_CLEANUP_DIAGNOSTIC", detail);
      }
    }
    if (!completed) {
      for (const [name, child] of [["host", host], ["guest", guest]]) {
        if (child) fs.writeFileSync(path.join(fixture, `${name}-stderr.log`), child.diagnostic(), { mode: 0o600 });
      }
    }
    console.log("ROOM_FIXTURE", fixture);
    if (completed && cleanupErrors.length) throw new Error("Private Room cleanup failed; verification is incomplete.");
    if (completed) {
      fs.writeFileSync(path.join(project, ".migration-test-work", `${path.basename(fixture)}-verification.json`),
        JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log("ROOM_INSTALLED_VERIFICATION", JSON.stringify(report));
    }
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
