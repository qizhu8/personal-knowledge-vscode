#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process"), { randomUUID, randomBytes, createHash } = require("node:crypto");
const project = path.resolve(__dirname, ".."), value = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function main() {
  const legacyVsix = value("legacy-vsix"), candidateVsix = value("candidate-vsix"), legacyRuntime = value("legacy-runtime");
  for (const file of [legacyVsix, candidateVsix, legacyRuntime]) assert(file && path.isAbsolute(file), "Explicit private legacy/candidate/runtime paths required.");
  assert.equal(createHash("sha256").update(fs.readFileSync(legacyVsix)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27", "Use the genuine unchanged original 4.0.22 VSIX.");
  assert(fs.realpathSync(legacyRuntime).startsWith(`${project}/.migration-test-work/`)
    && fs.existsSync(path.resolve(legacyRuntime, "../../../native-ui-fixture-token")), "Only a prior synthetic private Python runtime may be copied.");
  if (!process.argv.includes("--inside")) {
    const fixture = path.join(project, ".migration-test-work", `managed-recipe-profile-${randomUUID()}`);
    const python = spawnSync("python3", ["-B", "-c", "import pathlib,playwright;print(pathlib.Path(playwright.__file__).parent.parent)"], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    const browser = spawnSync("python3", ["-B", "-c", "from playwright.sync_api import sync_playwright;p=sync_playwright().start();print(p.chromium.executable_path);p.stop()"], { encoding: "utf8" });
    assert.equal(browser.status, 0, browser.stderr);
    const editor = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
    const display = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const result = spawnSync("unshare", require("./run-next-trial-private-display").privateNamespaceArgs([
      process.execPath, __filename, ...process.argv.slice(2), "--inside",
    ]), { stdio: "inherit", timeout: 900000, env: { PATH: process.env.PATH, PKM_RECIPE_EDITOR: editor,
      PKM_RECIPE_XVFB: display, PKM_RECIPE_CHROMIUM: browser.stdout.trim(), PYTHONPATH: python.stdout.trim(),
      PKM_RECIPE_PARENT_NS: fs.readlinkSync("/proc/self/ns/mnt"), PKM_RECIPE_PROFILE_PATH: fixture } });
    const owned = [];
    for (const pid of fs.readdirSync("/proc").filter(name => /^[1-9][0-9]*$/.test(name))) {
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === fixture || cwd.startsWith(`${fixture}/`) || args.some(arg => arg.startsWith(`${fixture}/`)
          || arg.startsWith(`--user-data-dir=${fixture}/`) || arg.startsWith(`--extensions-dir=${fixture}/`))) owned.push(Number(pid));
      } catch {}
    }
    if (fs.existsSync(fixture)) fs.writeFileSync(path.join(fixture, "managed-recipe-independent-cleanup.json"),
      JSON.stringify({ fixture, namespaceExited: true, exactFixtureProcesses: owned }));
    assert.equal(owned.length, 0, `Private fixture processes remained: ${owned.join(",")}`);
    assert.equal(result.status, 0, String(result.error ?? result.signal ?? "Private Recipe profile failed."));
    return;
  }
  assert.notEqual(fs.readlinkSync("/proc/self/ns/mnt"), process.env.PKM_RECIPE_PARENT_NS);
  process.umask(0o077);
  const fixture = process.env.PKM_RECIPE_PROFILE_PATH;
  assert(fixture && path.dirname(fixture) === path.join(project, ".migration-test-work")
    && path.basename(fixture).startsWith("managed-recipe-profile-"));
  fs.mkdirSync(fixture, { recursive: true, mode: 0o700 });
  process.chdir(fixture);
  console.log("RECIPE_PRIVATE_PROFILE", fixture);
  for (const name of ["h", "t", "u/User", "x", "crashes", "workspace", "independent", "driver"]) fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  fs.writeFileSync("driver/package.json", JSON.stringify({ name: "pkm-private-recipe-driver", publisher: "pkm-isolated-tests",
    version: "0.0.1", engines: { vscode: "*" }, main: "entry.cjs", activationEvents: [] }));
  fs.writeFileSync("driver/entry.cjs", "exports.activate = () => {};\n");
  fs.writeFileSync("private-recipe-fixture-token", randomUUID(), { flag: "wx", mode: 0o600 });
  const short = `/proc/${process.pid}/cwd`;
  const env = { PATH: process.env.PATH, HOME: `${short}/h`, USERPROFILE: `${short}/h`,
    TMPDIR: `${short}/t`, TMP: `${short}/t`, TEMP: `${short}/t`, PYTHONDONTWRITEBYTECODE: "1",
    XDG_RUNTIME_DIR: `${short}/t`, DISPLAY: "127.0.0.1:91", XAUTHORITY: path.join(fixture, "Xauthority"),
    PYTHONPATH: process.env.PYTHONPATH, PKM_RECIPE_CHROMIUM: process.env.PKM_RECIPE_CHROMIUM,
    PKM_UI_CHROMIUM: process.env.PKM_RECIPE_CHROMIUM,
    PKM_MANAGED_RECIPE_FIXTURE: fixture };
  const editor = process.env.PKM_RECIPE_EDITOR, cli = path.join(path.dirname(editor), "bin/code"), processes = new Set();
  const args = ["--no-sandbox", `--user-data-dir=${fixture}/u`, `--extensions-dir=${fixture}/x`];
  const command = (file, args, timeout = 120000) => {
    const result = spawnSync(file, args, { cwd: fixture, env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, String(result.error ?? "") + result.stdout + result.stderr);
    return result.stdout;
  };
  const launch = (file, args) => {
    const child = spawn(file, args, { cwd: fixture, env, stdio: "inherit" });
    processes.add(child); child.once("exit", () => processes.delete(child));
    return child;
  };
  const identity = pid => {
    try {
      const contents = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const stat = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
      return { pid: Number(pid), parent: Number(stat[1]), started: stat[19], state: stat[0],
        argv: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
    } catch { return undefined; }
  };
  let code, codeStage;
  async function stopCode() {
    if (!code) return;
    const records = fs.readdirSync("/proc").filter(name => /^[1-9][0-9]*$/.test(name)).map(identity).filter(Boolean);
    const owned = new Set([code.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const record of records) if (!owned.has(record.pid) && (owned.has(record.parent)
        || record.argv.some(arg => arg === `--user-data-dir=${fixture}/u` || arg === `--extensions-dir=${fixture}/x`))) {
        owned.add(record.pid); changed = true;
      }
    }
    const children = records.filter(record => owned.has(record.pid) && record.pid !== process.pid);
    const live = record => { const current = identity(record.pid); return current?.started === record.started && current.state !== "Z"; };
    const exited = code.exitCode !== null || code.signalCode !== null ? Promise.resolve() : new Promise(resolve => code.once("exit", resolve));
    if (code.exitCode === null && code.signalCode === null) code.kill("SIGTERM");
    await Promise.race([exited, wait(5000)]);
    if (code.exitCode === null && code.signalCode === null) { code.kill("SIGKILL"); await exited; }
    for (const record of children.filter(live)) { try { process.kill(record.pid, "SIGTERM"); } catch {} }
    for (let attempt = 0; attempt < 50 && children.some(live); attempt++) await wait(100);
    for (const record of children.filter(live)) { try { process.kill(record.pid, "SIGKILL"); } catch {} }
    for (let attempt = 0; attempt < 50 && children.some(live); attempt++) await wait(100);
    const remaining = children.filter(live);
    fs.writeFileSync(`code-lifetime-${codeStage}.json`, JSON.stringify({ codePid: code.pid, code: code.exitCode,
      signal: code.signalCode, capturedOwnedTree: children, remaining }));
    assert.equal(remaining.length, 0, "Previous private Code descendants must exit before another lifetime starts.");
    code = undefined;
    await wait(500);
  }
  async function startCode(stage) {
    codeStage = stage;
    fs.rmSync("renderer-driver-ready.json", { force: true });
    code = launch(editor, [...args, "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9333",
      `--crash-reporter-directory=${fixture}/crashes`,
      `--extensionDevelopmentPath=${fixture}/driver`,
      `--extensionTestsPath=${project}/tests/next-trial-electron/managed-recipe-profile-driver.cjs`, path.join(fixture, "workspace")]);
    for (let attempt = 0; attempt < 400; attempt++) {
      assert.equal(code.exitCode, null, "Private Code exited before readiness.");
      if (fs.existsSync("renderer-driver-ready.json")) break;
      await wait(150);
    }
    const ready = JSON.parse(fs.readFileSync("renderer-driver-ready.json"));
    console.log("NORMAL_EXTENSION_READY", stage, JSON.stringify(ready));
    command("python3", ["-B", path.join(project, "tests/managed_recipe_profile_ui.py"), "http://127.0.0.1:9333", fixture, stage], 180000);
    return ready;
  }
  const installed = version => {
    const names = fs.readdirSync("x").filter(name => /^uone.personal-knowledge-/i.test(name));
    const active = names.filter(name => fs.existsSync(path.join("x", name, "package.json"))
      && (!version || JSON.parse(fs.readFileSync(path.join("x", name, "package.json"))).version === version));
    assert.equal(active.length, 1, JSON.stringify(active));
    return path.join(fixture, "x", active[0]);
  };
  const snapshot = root => {
    const rows = {};
    function visit(file, relative) {
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`); }
      else if (stat.isSymbolicLink()) rows[relative] = { link: fs.readlinkSync(file) };
      else rows[relative] = { identity: `${stat.dev}:${stat.ino}`, mode: String(stat.mode),
        sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    }
    visit(root, ".");
    return rows;
  };
  let success = false;
  try {
    command("ip", ["link", "set", "lo", "up"]);
    fs.writeFileSync("Xauthority", "", { flag: "wx", mode: 0o600 });
    command("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
    launch(process.env.PKM_RECIPE_XVFB, [":91", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY]);
    for (let i = 0; i < 100; i++) {
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore" }).status === 0) break;
      await wait(75);
    }
    command(cli, [...args, "--install-extension", legacyVsix, "--force"]);
    const oldExtension = installed(), root = path.join(fixture, "knowledge");
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(path.join(root, "notes"));
    fs.writeFileSync(path.join(root, "notes/Existing.md"), "# Existing synthetic Note\nOriginal Root is not adopted by this journey.\n");
    fs.writeFileSync("native-ui-fixture-token", randomUUID(), { mode: 0o600 });
    fs.writeFileSync("in-place-fixture-token", fs.readFileSync("native-ui-fixture-token"), { mode: 0o600 });
    const helper = require("../tests/next-trial-electron/native-recipe-reflection-gate-installed-fixture.cjs");
    helper.prepare({ extension: oldExtension, root, fixture });
    const oldEvidence = JSON.parse(fs.readFileSync("reflection-gate-source.json"));
    const descriptor = { fixture, root, independent: path.join(fixture, "independent"), node: fs.realpathSync(process.execPath),
      original: oldEvidence, legacyRecipe: JSON.parse(fs.readFileSync("original-recipe-evidence.json")) };
    fs.writeFileSync("managed-recipe-descriptor.json", JSON.stringify(descriptor));
    fs.cpSync(legacyRuntime, path.join(fixture, "h/pkm-envs/pkm-mcp"), { recursive: true, verbatimSymlinks: true });
    const basePython = JSON.parse(command("python3", ["-B", "-c", "import sys,platform,json;print(json.dumps({'path':sys.executable,'version':platform.python_version()}))"]));
    fs.writeFileSync("h/pkm-envs/pkm-mcp/.pkm-base-python.json", JSON.stringify(basePython), { mode: 0o600 });
    fs.writeFileSync("u/User/settings.json", JSON.stringify({
      "personalKnowledge.storePath": root, "personalKnowledge.mcpPythonPath": basePython.path,
      "personalKnowledge.mcpRuntimePath": path.join(fixture, "h/pkm-envs/pkm-mcp"),
      "personalKnowledge.mcpServerPath": path.join(fixture, "legacy-mcp-server"),
      "security.workspace.trust.enabled": false, "files.simpleDialog.enable": true, "window.dialogStyle": "custom",
      "workbench.startupEditor": "none", "window.restoreWindows": "none", "telemetry.telemetryLevel": "off",
      "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
    }), { mode: 0o600 });
    fs.writeFileSync("u/User/keybindings.json", JSON.stringify([
      { key: "ctrl+alt+shift+r", command: "personalKnowledge.openRecipe", args: descriptor.legacyRecipe.recipeId },
      { key: "ctrl+alt+shift+n", command: "personalKnowledge.nextTrialStart" },
      { key: "ctrl+alt+shift+w", command: "personalKnowledge.nextTrialRecipes" },
      { key: "ctrl+alt+shift+c", command: "personalKnowledge.nextTrialClose" },
    ]), { mode: 0o600 });
    const old = await startCode("legacy");
    await stopCode();
    const originalBefore = snapshot(root);
    fs.writeFileSync("original-root-before.json", JSON.stringify(originalBefore));
    command(cli, [...args, "--install-extension", candidateVsix, "--force"]);
    const candidateVersion = JSON.parse(command("unzip", ["-p", candidateVsix, "extension/package.json"])).version;
    const candidate = installed(candidateVersion), inventory = snapshot(candidate);
    fs.writeFileSync("managed-recipe-descriptor.json", JSON.stringify({ ...descriptor, candidate }));
    await startCode("native");
    // Kill only the exact disposable managed child, never a production helper.
    const entry = path.join(candidate, "next-runtime/server/dist/managed-client-child.js"), owned = [];
    for (const pid of fs.readdirSync("/proc").filter(name => /^[1-9][0-9]*$/.test(name))) {
      try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        if (argv[1] === entry && fs.readlinkSync(`/proc/${pid}/cwd`) === path.join(candidate, "next-runtime")) owned.push(Number(pid));
      } catch {}
    }
    assert.equal(owned.length, 1, JSON.stringify(owned));
    process.kill(owned[0], "SIGKILL");
    await wait(500);
    await stopCode();
    await startCode("restart");
    await stopCode();
    const rootProbe = spawnSync(process.execPath, [path.join(project, "tests/next-trial-electron/managed-recipe-root-probe.mjs"),
      path.join(candidate, "next-runtime/server/dist"), root, fixture], {
      cwd: fixture, env, encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync("original-root-offline-probe.stdout.log", rootProbe.stdout ?? "");
    fs.writeFileSync("original-root-offline-probe.stderr.log", rootProbe.stderr ?? "");
    fs.writeFileSync("original-root-offline-probe-result.json", JSON.stringify({
      status: rootProbe.status, signal: rootProbe.signal, error: rootProbe.error?.message ?? null,
      actualInstalledDist: path.join(candidate, "next-runtime/server/dist"), postcommitRollbackQualified: false,
    }));
    console.log("SEPARATE_ORIGINAL_ROOT_PROBE", rootProbe.status, rootProbe.signal, rootProbe.stdout, rootProbe.stderr);
    assert.deepEqual(snapshot(candidate), inventory);
    const originalAfter = snapshot(root);
    // Normal legacy activation can update its own control/host records; original content must not change.
    assert.deepEqual(originalAfter["./notes/Existing.md"], originalBefore["./notes/Existing.md"]);
    assert(!fs.existsSync(path.join(root, "core.sqlite")), "No original-root adoption is performed.");
    fs.writeFileSync("managed-recipe-profile-evidence.json", JSON.stringify({
      passed: true, originalVersion: old.version, candidateVersion: JSON.parse(fs.readFileSync(path.join(candidate, "package.json"))).version,
      actualOrdinaryActivation: true, injectedRecipePolicy: false, actualRendererApprovals: true, actualManagedChildSigkill: true,
      originalRootAdopted: false, originalNoteUnchanged: true, installedPayloadUnchanged: true,
      separateOriginalRootProbeExitCode: rootProbe.status, postcommitRollbackQualified: false,
      fullRecipeParity: false, migrationQualified: false, windowsQualified: false,
    }, null, 2));
    success = true;
    console.log("PASS actual ordinary child/UI Recipe installed profile", fixture);
  } finally {
    await stopCode();
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await wait(500);
    fs.writeFileSync("managed-recipe-runner-result.json", JSON.stringify({ success, fixture }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
