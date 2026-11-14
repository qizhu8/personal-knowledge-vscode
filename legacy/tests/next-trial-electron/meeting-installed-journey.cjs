"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");
const project = path.resolve(__dirname, "../..");
const value = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const workspace = value("workspace"), baseline = value("baseline"), candidate = value("candidate");
  const portalClose = value("workflow") === "portal-owner-close";
  const liveHistory = value("workflow") === "portal-dual-live-history";
  const portalDual = value("workflow") === "portal-dual" || liveHistory;
  const collaborationComplete = value("workflow") === "collaboration-complete-product";
  const collaborationUpgrade = value("workflow") === "collaboration-production-upgrade" || collaborationComplete;
  for (const file of [workspace, baseline, candidate]) assert(file && path.isAbsolute(file));
  assert.equal(digest(fs.readFileSync(baseline)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  if (!process.argv.includes("--inside")) {
    const env = { PATH: process.env.PATH,
      PKM_MEETING_CODE: process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code"),
      PKM_MEETING_XVFB: process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb"),
      PKM_MEETING_PARENT_MNT: fs.readlinkSync("/proc/self/ns/mnt") };
    const result = spawnSync("unshare", require("../../scripts/run-next-trial-private-display").privateNamespaceArgs(
      [process.execPath, __filename, ...process.argv.slice(2), "--inside"]), { env, stdio: "inherit", timeout: 900000 });
    if (result.error || result.status) throw result.error || new Error(`Meeting namespace exited ${result.status ?? result.signal}`);
    return;
  }
  assert.notEqual(fs.readlinkSync("/proc/self/ns/mnt"), process.env.PKM_MEETING_PARENT_MNT);
  process.umask(0o077);
  const fixture = path.join(project, ".migration-test-work", `meeting-installed-${randomUUID()}`);
  fs.mkdirSync(fixture, { mode: 0o700 });
  for (const name of ["host-home", "host-user/User", "host-extensions", "host-workspace", "old-root", "temp", "driver", "native"])
    fs.mkdirSync(path.join(fixture, name), { recursive: true, mode: 0o700 });
  if (portalDual || collaborationUpgrade) for (const name of ["guest-home", "guest-user/User", "guest-extensions", "guest-workspace", "guest-old-root"])
    fs.mkdirSync(path.join(fixture, name), { recursive: true, mode: 0o700 });
  process.chdir(fixture);
  const short = `/proc/${process.pid}/cwd`;
  const env = { PATH: process.env.PATH, HOME: `${short}/host-home`, USERPROFILE: `${short}/host-home`,
    TMPDIR: `${fixture}/temp`, TMP: `${fixture}/temp`, TEMP: `${fixture}/temp`, XDG_RUNTIME_DIR: `${short}/temp`,
    DISPLAY: "127.0.0.1:93", XAUTHORITY: `${fixture}/Xauthority`, ELECTRON_NO_ATTACH_CONSOLE: "1",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${short}/temp/session-bus`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${short}/temp/no-system-bus` };
  Object.assign(process.env, env);
  fs.writeFileSync(path.join(fixture, "host-user/User/settings.json"), JSON.stringify({
    "personalKnowledge.storePath": path.join(fixture, "old-root"), "window.dialogStyle": "custom",
    "security.workspace.trust.enabled": false, "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
    "update.mode": "none", "workbench.startupEditor": "none"
  }));
  fs.writeFileSync(path.join(fixture, "driver/package.json"), JSON.stringify({
    publisher: "fixture", name: "meeting-installed-private-driver", version: "1.0.0",
    engines: { vscode: "^1.90.0" }, activationEvents: ["*"], main: "./extension.cjs"
  }));
  const driverFile = path.join(__dirname, collaborationComplete ? "collaboration-complete-driver.cjs" : collaborationUpgrade ? "collaboration-installed-driver.cjs" : portalDual ? "portal-dual-installed-driver.cjs"
    : portalClose ? "portal-owner-installed-driver.cjs" : "meeting-installed-driver.cjs");
  fs.copyFileSync(driverFile, path.join(fixture, "driver/extension.cjs"));
  fs.writeFileSync(path.join(fixture, "native/package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(workspace, "next-server/node_modules"), path.join(fixture, "native/node_modules"), "dir");
  const esbuild = require("esbuild");
  esbuild.buildSync({ stdin: { contents: `
    export {initialize,Storage} from "./next-server/src/storage";
    export {admitPrivateRoom,openPrivateRoomAdmissions} from "./next-server/src/next-room-private-admission";
    export {createNativeRoom,inspectNativeRoom} from "./next-server/src/native-chatroom-identity";
    export {createNextRoomUiHub} from "./next-server/src/next-room-ui-hub";`, resolveDir: workspace },
    bundle: true, platform: "node", format: "esm", packages: "external",
    outfile: path.join(fixture, "native/native.mjs"), logLevel: "silent" });
  esbuild.buildSync({ entryPoints: [path.join(workspace, "next-server/src/storage-worker.ts")], bundle: true,
    platform: "node", format: "esm", packages: "external", outfile: path.join(fixture, "native/storage-worker.js"), logLevel: "silent" });
  const native = await import(pathToFileURL(path.join(fixture, "native/native.mjs")));
  if (!collaborationUpgrade) await native.initialize(path.join(fixture, "next-root"));
  if (portalDual || collaborationUpgrade) {
    if (!collaborationUpgrade) await native.initialize(path.join(fixture, "guest-next-root"));
    fs.copyFileSync(path.join(project, "src/webview/panel/16-portal-connections.js"), path.join(fixture, "portal-renderer.js"));
    fs.writeFileSync(path.join(fixture, "guest-user/User/settings.json"), JSON.stringify({
      "personalKnowledge.storePath": path.join(fixture, "guest-old-root"), "window.dialogStyle": "custom",
      "security.workspace.trust.enabled": false, "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
      "update.mode": "none", "workbench.startupEditor": "none"
    }));
  }
  const children = new Set(), cleanup = [];
  const launch = (command, args, label, extra = {}) => {
    const child = spawn(command, args, { cwd: fixture, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", bytes => fs.appendFileSync(path.join(fixture, `${label}.log`), bytes, { mode: 0o600 }));
    child.stderr.on("data", bytes => fs.appendFileSync(path.join(fixture, `${label}.log`), bytes, { mode: 0o600 }));
    children.add(child); child.once("exit", () => children.delete(child)); return child;
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: fixture, env, encoding: "utf8", timeout: 120000 });
    if (result.error || result.status) throw result.error || new Error(result.stderr || `${command} exited ${result.status}`);
    return result.stdout;
  };
  const until = async (check, label, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await wait(100); }
    throw new Error(`${label} timed out`);
  };
  const start = pid => {
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[19]; } catch {}
  };
  const live = pid => {
    try { return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").startsWith("Z "); } catch { return false; }
  };
  const descendants = pid => {
    let found = [];
    try {
      for (const tid of fs.readdirSync(`/proc/${pid}/task`))
        try { found.push(...fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch {}
    } catch {}
    return [...new Set(found)].flatMap(child => [child, ...descendants(child)]);
  };
  const stop = async child => {
    if (!child) return;
    const owned = descendants(child.pid).map(pid => ({ pid, start: start(pid) }));
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (live(child.pid)) child.kill(signal);
      for (const item of owned) if (start(item.pid) === item.start && live(item.pid)) {
        try { process.kill(item.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await wait(signal === "SIGTERM" ? 2500 : 1000);
    }
    const remaining = owned.filter(item => start(item.pid) === item.start && live(item.pid));
    cleanup.push({ parentPid: child.pid, label: child.label, remaining });
    assert.equal(remaining.length, 0, "Only this fixture's recorded descendants may be stopped.");
  };
  const editor = process.env.PKM_MEETING_CODE, cli = path.join(path.dirname(editor), "bin/code");
  const profileArgs = ["--no-sandbox", `--user-data-dir=${fixture}/host-user`, `--extensions-dir=${fixture}/host-extensions`];
  const events = () => fs.existsSync(path.join(fixture, "host-events.jsonl"))
    ? fs.readFileSync(path.join(fixture, "host-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  function hookInstalled(version, role = "host") {
    const entries = fs.readdirSync(path.join(fixture, `${role}-extensions`)).filter(name => name.toLowerCase().startsWith("uone.personal-knowledge-"));
    const installed = entries.map(name => path.join(fixture, `${role}-extensions`, name)).find(directory =>
      JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version === version);
    assert(installed, "Actual installed version must be present.");
    const file = path.join(installed, "dist/extension.js"), text = fs.readFileSync(file, "utf8");
    const ts = require("typescript"), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set();
    const bind = node => { if (ts.isIdentifier(node)) names.add(node.text); else for (const element of node.elements ?? []) bind(element.name); };
    for (const node of ast.statements) {
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) bind(declaration.name);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    }
    const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ChatRoomManager");
    assert(cls);
    const classText = cls.getText(ast);
    fs.writeFileSync(path.join(fixture, "installed-manager-class.js"), classText);
    if (portalDual || collaborationUpgrade) fs.writeFileSync(path.join(fixture, `${role}-installed-manager-class.js`), classText);
    fs.appendFileSync(file, "\nmodule.exports.__meetingFixtureScope={" +
      [...names].map(name => `get ${name}(){return ${name};}`).join(",") + "};\n" +
      "const __meetingOriginalActivate=module.exports.activate;\n" +
      "module.exports.activate=async function(context,...args){const value=await __meetingOriginalActivate.call(this,context,...args);" +
      "module.exports.__meetingFixtureScope.__fixtureProductContext=context;" +
      `if(process.env.PKM_MEETING_INSTALLED_FIXTURE===${JSON.stringify(fixture)})process[Symbol.for(${JSON.stringify("pkm.meeting.fixture." + fixture)})]=module.exports.__meetingFixtureScope;return value;};\n`);
    return { classSha256: digest(classText), installed, originalCompiledSha256: digest(text), privateObserverHook: true };
  }
  const sourceEntries = () => {
    const state = JSON.parse(fs.readFileSync(path.join(fixture, "meeting-state.json"), "utf8"));
    const result = {};
    for (const root of ["old-root", "next-root"]) {
      const note = path.join(fixture, root, "notes", state.markdownPath);
      const walk = directory => {
        for (const name of fs.readdirSync(directory)) {
          const file = path.join(directory, name), stat = fs.lstatSync(file);
          assert(!stat.isSymbolicLink(), "Controlled source fixtures may not contain links.");
          if (stat.isDirectory()) walk(file);
          else { assert(stat.isFile()); result[path.relative(fixture, file)] = digest(fs.readFileSync(file)); }
        }
      };
      if (fs.existsSync(path.join(fixture, root, "chatrooms", state.roomId)))
        walk(path.join(fixture, root, "chatrooms", state.roomId));
      if (root === "old-root") result[path.relative(fixture, note)] = digest(fs.readFileSync(note));
      else {
        assert.equal(fs.existsSync(note), false, "A private Meeting copy must never enter the public Notes directory.");
        if (fs.existsSync(path.join(fixture, root, ".pkm-room-admission")))
          walk(path.join(fixture, root, ".pkm-room-admission"));
      }
    }
    return result;
  };
  let code, browser, report = { fixture, baselineSha256: digest(fs.readFileSync(baseline)),
    driverSha256: digest(fs.readFileSync(driverFile)),
    controllerSha256: digest(fs.readFileSync(__filename)),
    candidateSha256: digest(fs.readFileSync(candidate)), scope: collaborationUpgrade
      ? "Actual installed product activation/public upgrade entry; private observation-only module export hook, separate Collaboration workspace, not general same-root migration"
      : "private installed compiled class/provider/profile; not ordinary production entry",
    dialogStyle: "explicit custom private test setting; does not prove default native X11 modal",
    workflow: portalDual || collaborationUpgrade ? value("workflow") : portalClose ? "portal-owner-close" : "meeting-private-admission", phases: [], passed: false };
  try {
    run("ip", ["link", "set", "lo", "up"]);
    fs.writeFileSync(path.join(fixture, "session-bus.conf"), `<busconfig><type>session</type><listen>${env.DBUS_SESSION_BUS_ADDRESS}</listen>
      <auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow own="*"/>
      <allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/></policy></busconfig>`);
    launch("dbus-daemon", ["--nofork", `--config-file=${fixture}/session-bus.conf`], "bus");
    await until(() => fs.existsSync(path.join(fixture, "temp/session-bus")), "private DBus");
    fs.writeFileSync(env.XAUTHORITY, "");
    run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
    launch(process.env.PKM_MEETING_XVFB, [":93", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY], "xvfb");
    await until(() => spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0, "private Xvfb");
    const version = value("candidate-version") || JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8")).version;
    if (collaborationUpgrade) {
      await require(collaborationComplete ? "./collaboration-complete-controller.cjs" : "./collaboration-installed-controller.cjs")({ fixture, env, editor, cli, candidate, baseline, version,
        launch, run, stop, hookInstalled, report });
      report.passed = true;
      return;
    }
    if (portalDual) {
      fs.writeFileSync(path.join(fixture, "driver-config.json"), JSON.stringify({ phase: "portal-dual",
        nextRoot: path.join(fixture, "next-root"), guestNextRoot: path.join(fixture, "guest-next-root"), liveHistory }));
      await require("./portal-dual-installed-controller.cjs")({ fixture, env, editor, cli, candidate, version,
        launch, run, stop, hookInstalled, report });
      report.passed = true;
      return;
    }
    for (const phase of portalClose ? ["portal-owner-close"] : ["baseline", "owned-first", "owned-restart", "owned-conflict"]) {
      if (phase === "baseline" || phase === "owned-first" || portalClose) run(cli, [...profileArgs, "--install-extension", phase === "baseline" ? baseline : candidate, "--force"]);
      const hook = phase === "owned-restart" || phase === "owned-conflict" ? report.phases[1].hook : hookInstalled(phase === "baseline" ? "4.0.22" : version);
      const config = { phase, ...hook, oldRoot: path.join(fixture, "old-root"), nextRoot: path.join(fixture, "next-root") };
      fs.writeFileSync(path.join(fixture, "driver-config.json"), JSON.stringify(config));
      code = launch(editor, [...profileArgs, "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
        "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en", "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=19173", `--crash-reporter-directory=${fixture}/temp`,
        `--extensionDevelopmentPath=${fixture}/driver`, `${fixture}/host-workspace`], `${phase}-code`,
      { PKM_MEETING_INSTALLED_FIXTURE: fixture });
      code.label = phase;
      let info;
      await until(async () => { try { const response = await fetch("http://127.0.0.1:19173/json/version");
        if (response.ok) { info = await response.json(); return true; } } catch {} }, `${phase} CDP`);
      await until(async () => {
        const response = await fetch("http://127.0.0.1:19173/json/list");
        return response.ok && (await response.json()).some(target => target.type === "page" && target.url.includes("workbench"));
      }, `${phase} workbench renderer target`);
      browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
      let page;
      await until(() => { page = browser.contexts()[0]?.pages().find(item => item.url().includes("workbench")); return !!page; }, "actual workbench");
      await page.waitForLoadState("networkidle", { timeout: 45000 });
      const end = Date.now() + 150000;
      while (!events().some(item => item.phase === phase && item.event === "phase-complete")) {
        const failure = events().find(item => item.phase === phase && item.event === "driver-failed");
        if (failure) throw new Error(failure.message);
        if (Date.now() > end) throw new Error(`${phase} driver timeout`);
        const dialogs = page.locator(".monaco-dialog-box");
        for (const dialog of await dialogs.all()) if (await dialog.isVisible()) {
          const text = await dialog.innerText();
          if (portalClose && text.includes("Allow this exact isolated Portal command once?")) {
            await dialog.getByRole("button", { name: "Allow Command Once", exact: true }).click();
          } else if (text.includes("Host this Room with the Next workspace owner?")) {
            assert.match(text, /not encrypted/);
            await dialog.getByRole("button", { name: "Use Participant Credentials", exact: true }).click();
          } else if (text.includes("Admit this exact retained Room and its private Meeting Notes?")) {
            assert.match(text, /never enter the public Notes library/);
            await dialog.getByRole("button", { name: "Admit Room and Private Notes", exact: true }).click();
          } else if (text.includes("Restore this historical participant identity?")) {
            const state = JSON.parse(fs.readFileSync(path.join(fixture, "meeting-state.json"), "utf8"));
            assert(text.includes(state.participantId) && text.includes("out of band"));
            await dialog.getByRole("button", { name: "Approve Identity Recovery", exact: true }).click();
          } else if (text.includes("Welcome to Visual Studio Code")) await page.keyboard.press("Escape");
        }
        await wait(100);
      }
      await page.screenshot({ path: path.join(fixture, `${phase}-editor.png`) });
      report.phases.push({ phase, hook, events: events().filter(item => item.phase === phase) });
      await browser.close(); browser = undefined;
      await stop(code); code = undefined;
      if (portalClose) {
        report.sourceBefore = {};
        report.sourceScope = "Synthetic Portal requests; no legacy Room/Meeting sources seeded in this installed workflow.";
      } else if (phase === "baseline") {
        report.sourceBefore = sourceEntries();
      } else {
        const after = sourceEntries();
        const state = JSON.parse(fs.readFileSync(path.join(fixture, "meeting-state.json"), "utf8"));
        for (const [file, sha] of Object.entries(report.sourceBefore)) {
          if (phase === "owned-restart" && file === path.join("old-root", "notes", state.markdownPath)) {
            assert.equal(after[file], digest(state.conflictOriginalNote));
            continue;
          }
          assert.equal(after[file], sha, "Original and already-admitted source bytes must remain unchanged.");
        }
        report.sourceBefore = after;
      }
    }
    report.passed = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally {
    await browser?.close();
    await stop(code);
    for (const child of [...children]) await stop(child);
    report.cleanup = cleanup;
    fs.writeFileSync(path.join(fixture, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(project, ".migration-test-work/meeting-installed-latest.json"), JSON.stringify({ fixture, passed: report.passed }, null, 2));
    console.log(JSON.stringify({ fixture, passed: report.passed, error: report.error, cleanup }));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
