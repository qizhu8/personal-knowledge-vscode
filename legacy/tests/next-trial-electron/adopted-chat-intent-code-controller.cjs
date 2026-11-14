"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process"), { randomBytes, randomUUID, createHash } = require("node:crypto");
const project = process.cwd();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function wait(probe, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = probe(); if (result) return result; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
function checked(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120000 });
  if (result.status !== 0 || result.error) throw result.error || new Error(`${command}: ${result.stderr}`);
}

async function main() {
  const contractFile = process.argv[2];
  assert(contractFile && path.isAbsolute(contractFile) && contractFile.startsWith(path.join(project, ".migration-test-work") + path.sep));
  const contract = JSON.parse(fs.readFileSync(contractFile, "utf8"));
  const fixture = contract.fixture;
  assert(fixture.startsWith(path.join(project, ".migration-test-work") + path.sep));
  assert.equal(digest(contract.vsix), contract.vsixSha256);
  assert.equal(digest(contract.actor), contract.actorSha256);
  assert.equal(digest(__filename), contract.controllerSha256);
  if (!process.argv.includes("--inside")) {
    assert(process.argv.includes("--run-installed"), "An explicit private Code window is required.");
    const args = require(path.join(project, "scripts/run-next-trial-private-display")).privateNamespaceArgs(
      [process.execPath, __filename, contractFile, "--inside"]);
    const result = spawnSync("unshare", args, { cwd: project, env: { PATH: process.env.PATH || "" }, stdio: "inherit", timeout: 240000 });
    fs.writeFileSync(path.join(fixture, "controller-exit.json"), JSON.stringify({ status: result.status, signal: result.signal }));
    if (result.status !== 0 || result.error) throw result.error || new Error(`Private namespace exited ${result.status}`);
    return;
  }
  assert(fs.readFileSync("/proc/1/cmdline", "utf8").includes("pkm-private-init"));
  assert(!fs.existsSync(path.join(fixture, "installed-started")), "A Code fixture must not be reused.");
  fs.writeFileSync(path.join(fixture, "installed-started"), "");
  const home = path.join(fixture, "home"), runtime = path.join(fixture, "runtime");
  const extensions = path.join(fixture, "extensions"), userData = path.join(fixture, "user-data"), workspace = path.join(fixture, "workspace");
  for (const dir of [home, runtime, extensions, workspace, path.join(home, "run"), path.join(userData, "User")])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userData, "User/settings.json"), JSON.stringify({
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false, "window.dialogStyle": "custom", "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
  }));
  const editor = contract.editor, xvfb = contract.xvfb;
  const python = contract.python;
  assert([editor, xvfb, python].every(value => typeof value === "string" && path.isAbsolute(value)));
  process.chdir(fixture);
  const short = `/proc/${process.pid}/cwd`;
  const env = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: `${short}/home`, USERPROFILE: `${short}/home`,
    TMPDIR: "/proc/self/cwd/runtime", TMP: "/proc/self/cwd/runtime", TEMP: "/proc/self/cwd/runtime",
    XDG_RUNTIME_DIR: `${short}/home/run`, XDG_CONFIG_HOME: `${short}/home/config`, XDG_CACHE_HOME: `${short}/home/cache`,
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1", PYTHONDONTWRITEBYTECODE: "1", PKM_CHAT_INTENT_FIXTURE: fixture };
  const display = "127.0.0.1:98", authority = path.join(fixture, "Xauthority");
  fs.writeFileSync(authority, "", { mode: 0o600 });
  checked("ip", ["link", "set", "lo", "up"], { env });
  checked("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
  env.DISPLAY = display; env.XAUTHORITY = authority;
  const captured = new Map();
  const rows = () => fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return [{ pid: Number(name), start: fields[19], state: fields[0] }];
    } catch { return []; }
  });
  const capture = () => { for (const row of rows()) if (row.pid !== 1 && row.pid !== process.pid) captured.set(`${row.pid}:${row.start}`, row); };
  const live = row => rows().some(now => now.pid === row.pid && now.start === row.start && !["Z", "X"].includes(now.state));
  let tracker;
  try {
    const x = spawn(xvfb, [":98", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" });
    let displayError;
    x.once("error", error => { displayError = error; });
    tracker = setInterval(capture, 50);
    await wait(() => {
      if (displayError) throw displayError;
      return x.exitCode === null && spawnSync("xdpyinfo", ["-display", display], { env, stdio: "ignore", timeout: 1000 }).status === 0;
    }, "private display");
    const cli = path.join(path.dirname(editor), "bin/code"), base = [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, "--no-sandbox"];
    checked(cli, [...base, "--install-extension", contract.vsix, "--force"], { env, cwd: fixture });
    const log = fs.openSync(path.join(fixture, "code.log"), "wx");
    const code = spawn("setpriv", ["--bounding-set=-dac_override,-dac_read_search", "--no-new-privs",
      editor, workspace, ...base, "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19686",
      `--crash-reporter-directory=${runtime}`], { env, cwd: fixture, stdio: ["ignore", log, log] });
    let codeError;
    code.once("error", error => { codeError = error; });
    fs.closeSync(log);
    await wait(() => {
      if (codeError) throw codeError;
      if (code.exitCode !== null) throw new Error(`Code exited ${code.exitCode}`);
      return fs.existsSync(path.join(fixture, "driver-ready.json"));
    }, "fixture extension activation");
    const actor = spawn(python, ["-I", "-B", contract.actor, "--cdp", "http://127.0.0.1:19686", "--fixture", fixture],
      { env, cwd: fixture, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    actor.once("error", error => { stderr += String(error); });
    actor.stdout.on("data", data => { stdout += data; }); actor.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => { if (actor.exitCode === null && actor.signalCode === null) actor.kill("SIGTERM"); }, 100000);
    const result = await new Promise(resolve => actor.once("close", (code, signal) => resolve({ code, signal })));
    clearTimeout(timer);
    fs.writeFileSync(path.join(fixture, "actor.log"), stdout + stderr);
    assert.equal(result.code, 0, stderr);
    console.log(stdout.trim());
  } finally {
    clearInterval(tracker); capture();
    for (const row of [...captured.values()].reverse()) if (live(row)) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
    await pause(1000);
    for (const row of captured.values()) if (live(row)) { try { process.kill(row.pid, "SIGKILL"); } catch {} }
    await pause(300);
    const remaining = [...captured.values()].filter(live);
    fs.writeFileSync(path.join(fixture, "cleanup.json"), JSON.stringify({ captured: [...captured.values()], remaining }, null, 2));
    assert.equal(remaining.length, 0, "Private fixture processes remain.");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
