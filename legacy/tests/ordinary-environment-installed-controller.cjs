"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawn, spawnSync, execFileSync } = require("node:child_process"), { randomBytes, createHash } = require("node:crypto");
const project = process.cwd(), contractFile = path.join(project, ".migration-test-work/environment-ordinary-root-ui/installed-contract.json");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function wait(probe, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await pause(100); }
  throw Error(`Timeout: ${label}`);
}
function checked(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120000 });
  if (result.status !== 0 || result.error) throw result.error || Error(`${command}: ${result.stderr}`);
}
async function main() {
  assert(process.argv.includes("--run-installed"), "Installed execution requires an explicit authorized invocation.");
  const contract = JSON.parse(fs.readFileSync(contractFile)), fixture = contract.fixture.root;
  if (!process.argv.includes("--inside")) {
    assert.equal(contract.status, "STANDARD_PACKAGE_READY_INSTALLED_PENDING");
    const code = path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
    const xvfb = path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const python = process.env.PKM_BROWSER_PYTHON; assert(python && path.isAbsolute(python));
    const args = require("../scripts/run-next-trial-private-display").privateNamespaceArgs(
      [process.execPath, __filename, "--run-installed", "--inside", code, xvfb, python]);
    const result = spawnSync("unshare", args, { cwd: project, env: { PATH: process.env.PATH || "" }, stdio: "inherit", timeout: 420000 });
    fs.writeFileSync(path.join(fixture, "controller-exit.json"), JSON.stringify({ status: result.status, signal: result.signal }));
    if (result.status !== 0 || result.error) throw result.error || Error(`Namespace exited ${result.status}`);
    return;
  }
  const [editor, displayExecutable, python] = process.argv.slice(process.argv.indexOf("--inside") + 1);
  assert(fs.readFileSync("/proc/1/cmdline", "utf8").includes("pkm-private-init"),
    "Cleanup is permitted only inside this controller's private PID namespace.");
  assert.equal(digest(contract.standard.vsix), contract.standard.sha256);
  assert.equal(digest(path.join(project, "personal-knowledge-4.0.22.vsix")), contract.fixture.legacyVsixSha256);
  assert(!fs.existsSync(path.join(fixture, "installed-started")), "Never reuse an installed attempt.");
  fs.writeFileSync(path.join(fixture, "installed-started"), "");
  const home = path.join(fixture, "installed-home"), local = path.join(fixture, "installed-runtime");
  const extensions = path.join(fixture, "installed-extensions"), driver = path.join(fixture, "installed-driver"), workspace = path.join(fixture, "workspace");
  for (const dir of [home, local, extensions, driver, workspace, path.join(home, "run")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(driver, "package.json"), JSON.stringify({ name: "ordinary-environment-driver", publisher: "fixture",
    version: "0.0.1", engines: { vscode: "^1.90.0" }, main: "./extension.cjs", activationEvents: ["*"] }));
  fs.copyFileSync(path.join(project, "tests/ordinary-environment-installed-host.cjs"), path.join(driver, "extension.cjs"));
  fs.writeFileSync(path.join(contract.fixture.userData, "User/settings.json"), JSON.stringify({
    "personalKnowledge.storePath": contract.fixture.knowledgeRoot, "personalKnowledge.openOnStartup": false,
    "personalKnowledge.experimental.localEnvironmentUpgrade": false, "telemetry.telemetryLevel": "off",
    "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
    "security.workspace.trust.enabled": false, "workbench.startupEditor": "none", "window.restoreWindows": "none",
    "window.dialogStyle": "custom",
  }));
  process.chdir(fixture);
  const short = `/proc/${process.pid}/cwd`;
  const env = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: `${short}/installed-home`, USERPROFILE: `${short}/installed-home`,
    TMPDIR: "/proc/self/cwd/installed-runtime", TMP: "/proc/self/cwd/installed-runtime", TEMP: "/proc/self/cwd/installed-runtime",
    XDG_RUNTIME_DIR: `${short}/installed-home/run`, XDG_CONFIG_HOME: `${short}/installed-home/config`,
    XDG_CACHE_HOME: `${short}/installed-home/cache`, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
    PYTHONDONTWRITEBYTECODE: "1", PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_LIST_OUTDATED: "0", PIP_LIST_UPTODATE: "0", PIP_CACHE_DIR: path.join(local, "pip-cache"), PKM_ORDINARY_ENV_FIXTURE: fixture };
  const display = "127.0.0.1:98", authority = path.join(fixture, "Xauthority");
  fs.writeFileSync(authority, "", { mode: 0o600 });
  checked("ip", ["link", "set", "lo", "up"], { env });
  checked("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
  env.DISPLAY = display; env.XAUTHORITY = authority;
  const captured = new Map(), tracked = []; let x, tracker;
  const rows = () => fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const s = fs.readFileSync(`/proc/${name}/stat`, "utf8"), fields = s.slice(s.lastIndexOf(")") + 2).trim().split(/\s+/);
      return [{ pid: Number(name), ppid: Number(fields[1]), start: fields[19], state: fields[0] }];
    } catch { return []; }
  });
  function capture() {
    for (const row of rows()) if (row.pid !== 1 && row.pid !== process.pid)
      captured.set(row.pid, row);
  }
  const live = row => rows().some(current => current.pid === row.pid && current.start === row.start && !["Z", "X"].includes(current.state));
  try {
    x = spawn(displayExecutable, [":98", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" }); tracked.push(x);
    await wait(() => spawnSync("xdpyinfo", ["-display", display], { env, stdio: "ignore", timeout: 1000 }).status === 0, "private display");
    tracker = setInterval(capture, 100);
    const cli = path.join(path.dirname(editor), "bin/code"), base = [`--user-data-dir=${contract.fixture.userData}`, `--extensions-dir=${extensions}`, "--no-sandbox"];
    const results = [];
    for (const phase of ["original", "upgrade", "restart"]) {
      if (phase !== "restart") checked(cli, [...base, "--install-extension", phase === "original"
        ? path.join(project, "personal-knowledge-4.0.22.vsix") : contract.standard.vsix, "--force"], { env, cwd: fixture });
      fs.writeFileSync(path.join(fixture, "phase"), phase);
      const log = fs.openSync(path.join(local, `code-${phase}.log`), "wx");
      const editorProcess = spawn("setpriv", ["--bounding-set=-dac_override,-dac_read_search", "--no-new-privs",
        editor, workspace, ...base, `--extensionDevelopmentPath=${driver}`, "--new-window", "--disable-gpu",
        "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--disable-workspace-trust",
        "--skip-welcome", "--skip-release-notes", "--password-store=basic", "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=19685"], { env, cwd: fixture, stdio: ["ignore", log, log] });
      fs.closeSync(log); tracked.push(editorProcess);
      const host = await wait(() => {
        const error = path.join(fixture, `host-error-${phase}.txt`); if (fs.existsSync(error)) throw Error(fs.readFileSync(error, "utf8"));
        const file = path.join(fixture, `host-${phase}.json`); return fs.existsSync(file) && JSON.parse(fs.readFileSync(file));
      }, "actual activated legacy host");
      assert.equal(host.version, phase === "original" ? "4.0.22" : "4.0.900");
      const actor = spawn(python, ["-I", "-B", path.join(project, "tests/ordinary_environment_installed_actor.py"),
        "--cdp", "http://127.0.0.1:19685", "--helper", path.join(project, "tests/ordinary_environment_profile_ui.py"),
        "--id", contract.fixture.id, "--venv-id", contract.fixture.venvId, "--phase", phase, "--fixture-root", fixture],
      { env, cwd: fixture, stdio: ["ignore", "pipe", "pipe"] }); tracked.push(actor);
      let stdout = "", stderr = ""; actor.stdout.on("data", data => { stdout += data; }); actor.stderr.on("data", data => { stderr += data; });
      const exit = await new Promise(resolve => actor.once("close", (code, signal) => resolve({ code, signal })));
      fs.writeFileSync(path.join(fixture, `actor-${phase}.log`), stdout + stderr);
      assert.equal(exit.code, 0, stderr); results.push({ host, ui: JSON.parse(stdout) });
      fs.writeFileSync(path.join(fixture, `close-${phase}`), "");
      await wait(() => editorProcess.exitCode !== null, "native window close", 30000);
      await pause(300);
      assert(!fs.existsSync(path.join(contract.fixture.storage, "next-local-environments")));
    }
    fs.writeFileSync(path.join(fixture, "installed-results.json"), JSON.stringify(results, null, 2));
    console.log("PASS ordinary same-profile original Root installed Environment journey");
  } finally {
    clearInterval(tracker); capture();
    for (const row of [...captured.values()].reverse()) if (live(row)) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
    await pause(1000);
    for (const row of captured.values()) if (live(row)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    await pause(300);
    const remaining = [...captured.values()].filter(live);
    fs.writeFileSync(path.join(fixture, "cleanup.json"), JSON.stringify({ captured: [...captured.values()], remaining }, null, 2));
    assert.equal(remaining.length, 0, "Own captured processes remain");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
