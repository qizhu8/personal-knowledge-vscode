#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");

const project = path.resolve(__dirname, "..");
const candidate = process.argv.find(arg => arg.startsWith("--candidate-vsix="))?.slice("--candidate-vsix=".length);
const legacy = process.argv.find(arg => arg.startsWith("--legacy-vsix="))?.slice("--legacy-vsix=".length);
const code = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
const xvfb = process.env.PKM_TRIAL_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
if (!candidate || !legacy || !path.isAbsolute(candidate) || !path.isAbsolute(legacy)) {
  console.error("Supply absolute --candidate-vsix and --legacy-vsix paths.");
  process.exit(1);
}
if (!process.argv.includes("--inside")) {
  const result = spawnSync("unshare", ["-Urnmpf", "--mount-proc", "bash", "-c",
    '"$@" & workload=$!; wait "$workload"', "private-init", process.execPath, __filename, "--inside",
    `--candidate-vsix=${candidate}`, `--legacy-vsix=${legacy}`],
    { cwd: project, env: { PATH: process.env.PATH || "", PKM_VSCODE_EXECUTABLE: code, PKM_TRIAL_XVFB: xvfb }, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function payload(directory) {
  const result = [];
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) result.push([relative, "link", fs.readlinkSync(file)]);
    else if (stat.isDirectory()) {
      result.push([relative, "dir", stat.mode]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else {
      assert(stat.isFile()); result.push([relative, stat.mode, digest(fs.readFileSync(file))]);
    }
  }
  visit(directory, "");
  return result;
}

function assertInstalledVsix(vsix, directory) {
  const script = [
    "import json,pathlib,sys,zipfile",
    "root=pathlib.Path(sys.argv[2])",
    "with zipfile.ZipFile(sys.argv[1]) as archive:",
    " for info in archive.infolist():",
    "  if not info.filename.startswith('extension/') or info.is_dir(): continue",
    "  relative=pathlib.PurePosixPath(info.filename).relative_to('extension')",
    "  if any(part in ('..','.') for part in relative.parts): raise ValueError('unsafe package path')",
    "  file=root.joinpath(*relative.parts)",
    "  if not file.is_file(): raise ValueError('missing installed file: '+str(relative))",
    "  actual=file.read_bytes(); expected=archive.read(info)",
    "  if str(relative)=='package.json':",
    "   installed=json.loads(actual); installed.pop('__metadata',None)",
    "   if installed!=json.loads(expected): raise ValueError('installed manifest differs from VSIX')",
    "  elif actual!=expected: raise ValueError('installed package bytes differ: '+str(relative))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script, vsix, directory], { encoding: "utf8", timeout: 60000 });
  if (result.status !== 0) throw new Error(`Installed payload differs from VSIX: ${result.stderr}`);
}

async function main() {
  const scratch = path.join(project, ".migration-test-work", `sync-real-host-${randomUUID()}`);
  for (const name of ["u/User", "x", "h/run", "t", "workspace", "root/notes", "driver"])
    fs.mkdirSync(path.join(scratch, name), { recursive: true, mode: 0o700 });
  process.chdir(scratch);
  const short = `/proc/${process.pid}/cwd`;
  const user = `${short}/u`, extensions = `${short}/x`, root = path.join(scratch, "root");
  const globalStorage = path.join(scratch, "u/User/globalStorage/uone.personal-knowledge");
  const profile = { PATH: process.env.PATH || "", HOME: `${short}/h`, USERPROFILE: `${short}/h`,
    XDG_RUNTIME_DIR: `${short}/h/run`, TMPDIR: path.join(scratch, "t"), TMP: path.join(scratch, "t"), TEMP: path.join(scratch, "t"),
    DISPLAY: "127.0.0.1:91", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" };
  fs.mkdirSync(globalStorage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(scratch, "u/User/settings.json"), JSON.stringify({
    "personalKnowledge.storePath": root, "personalKnowledge.openOnStartup": false,
    "personalKnowledge.mcpPythonPath": path.join(scratch, "no-python"),
    "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off",
    "update.mode": "none", "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false,
    "http.proxy": "http://127.0.0.1:1", "http.proxySupport": "override",
  }));
  const target = { schema: 1, id: "fixture-target", name: "Synthetic fixture",
    repository: "https://github.com/fixture/fixture.git", branch: "main",
    authentication: { method: "vscode", expectedLogin: "fixture" },
    automation: { enabled: false, intervalMinutes: 5, syncOnChange: false, initialSyncCompleted: true },
    conflictResolution: "manual", selection: { public: { skills: { items: [], folders: [""] } }, private: {} },
    lastSync: { at: "2026-01-01T00:00:00Z", commit: "a".repeat(40), fingerprints: {},
      repository: "https://github.com/fixture/fixture.git", branch: "main", storeRoot: root } };
  function put(parts, value) {
    const file = path.join(globalStorage, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
    return file;
  }
  const config = put(["github-sync", "targets.json"], { schema: 1, targets: [target] });
  const transaction = put(["github-sync", "checkouts", target.id, "transactions", "latest.json"], {
    schema: 1, targetId: target.id, transactionId: randomUUID(), operation: "sync", state: "recorded",
    repository: target.repository, branch: target.branch, pushedCommit: target.lastSync.commit,
  });
  const coordinator = put(["github-sync", "coordinators", digest(root), "coordinator.json"], {
    schema: 1, intents: { [target.id]: {} }, claims: {}, blocked: {},
  });
  const result = put(["pkm-service", "fixture", "results", "pending.json"], { schema: 1, fixture: true });
  const journal = put(["github-sync", "experimental-next", `${target.id}.json`], {
    schema: "pkm.experimental-legacy-sync/v1", workspaceId: "fixture", configHash: "b".repeat(64),
    targetId: target.id, policyId: randomUUID(), baseline: target.lastSync.commit, phase: "publishing",
  });
  const preserved = [config, transaction, coordinator, result, journal].map(file => fs.readFileSync(file));
  fs.writeFileSync(path.join(root, "notes/Sentinel.md"), "synthetic note unchanged\n", { mode: 0o600 });
  assert.equal(spawnSync("ip", ["link", "set", "lo", "up"], { env: profile }).status, 0);
  const display = spawn(xvfb, [":91", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-listen", "tcp", "-ac"],
    { env: profile, stdio: "ignore" });
  let success = false;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnSync("xdpyinfo", ["-display", profile.DISPLAY], { env: profile, stdio: "ignore" }).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Private Xvfb did not start");
    const args = ["--no-sandbox", `--user-data-dir=${user}`, `--extensions-dir=${extensions}`];
    const cli = path.join(path.dirname(code), "bin/code");
    function install(vsix) {
      const run = spawnSync(cli, [...args, "--install-extension", vsix, "--force"],
        { env: profile, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL" });
      if (run.status !== 0) throw new Error(`Private VSIX install failed: ${run.stderr}`);
    }
    function installed() {
      const names = fs.readdirSync(path.join(scratch, "x")).filter(name => /^uone\.personal-knowledge-/i.test(name)
        && !fs.existsSync(path.join(scratch, "x", name, ".obsolete")));
      return names.map(name => path.join(scratch, "x", name));
    }
    async function runCode(action, extraEnv, extraArgs = []) {
      const log = fs.openSync(path.join(scratch, `${action}.log`), "w", 0o600);
      const child = spawn(code, [path.join(scratch, "workspace"), ...args, "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic", ...extraArgs],
        { env: { ...profile, ...extraEnv }, stdio: ["ignore", log, log] });
      const status = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => { clearTimeout(timer); resolve(code ?? signal); });
      });
      fs.closeSync(log);
      if (status !== 0) throw new Error(`${action} VS Code failed: ${status}; private logs retained at ${scratch}`);
    }
    function clearUserCache() {
      const dir = path.join(scratch, "u/CachedProfilesData/__default__profile__");
      if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir))
        if (/^extensions\.user(?:\.[a-z0-9-]+)?\.cache$/.test(name)) fs.rmSync(path.join(dir, name));
    }
    install(legacy);
    const [old] = installed(); assert(old);
    const original = fs.readFileSync(path.join(old, "package.json")), oldPayload = payload(old);
    const shim = path.join(old, "sync-normal-shim.cjs"), oldMarker = path.join(scratch, "old-secret.json");
    try {
      const manifest = JSON.parse(original);
      manifest.main = "./sync-normal-shim.cjs"; manifest.activationEvents = ["*"];
      fs.copyFileSync(path.join(project, "tests/next-trial-electron/sync-normal-shim.cjs"), shim, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(old, "package.json"), JSON.stringify(manifest)); clearUserCache();
      await runCode("legacy-seed", { PKM_SYNC_NORMAL_ACTION: "store", PKM_SYNC_NORMAL_MARKER: oldMarker,
        PKM_SYNC_PROFILE_STORAGE: globalStorage });
      assert.equal(JSON.parse(fs.readFileSync(oldMarker)).passed, true);
    } finally {
      fs.writeFileSync(path.join(old, "package.json"), original);
      fs.rmSync(shim, { force: true }); clearUserCache();
      assert.deepEqual(payload(old), oldPayload, "Old installed payload not restored");
    }
    install(candidate);
    const version = require(path.join(project, "package.json")).version;
    const current = path.join(scratch, "x", `uone.personal-knowledge-${version}`);
    assert(fs.existsSync(current), "Candidate target VSIX not installed");
    assertInstalledVsix(candidate, current);
    const before = payload(current);
    const driver = path.join(scratch, "driver"), driverMarker = path.join(scratch, "driver-result.json");
    fs.writeFileSync(path.join(driver, "package.json"), JSON.stringify({
      name: "sync-host-test-driver", publisher: "fixture", version: "0.0.1",
      engines: { vscode: "^1.90.0" }, activationEvents: ["*"], main: "./extension.cjs",
    }));
    fs.copyFileSync(path.join(project, "tests/next-trial-electron/next-sync-host-driver.cjs"), path.join(driver, "extension.cjs"));
    clearUserCache();
    await runCode("candidate-host", { PKM_SYNC_HOST_DRIVER_MARKER: driverMarker }, [`--extensionDevelopmentPath=${driver}`]);
    const outcome = JSON.parse(fs.readFileSync(driverMarker, "utf8"));
    assert.equal(outcome.passed, true, `Real extension host observation failed: ${outcome.error || "unknown"}`);
    assert.deepEqual(payload(current), before, "Target installed VSIX payload changed during observation");
    assertInstalledVsix(candidate, current);
    [config, transaction, coordinator, result, journal].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), preserved[index]));
    assert.equal(fs.readFileSync(path.join(root, "notes/Sentinel.md"), "utf8"), "synthetic note unchanged\n");
    console.log("PASS: normal VS Code target package unmodified; actual host read synthetic legacy target, saved SecretStorage and recovery status; cutover blocked.");
    console.log("Qualifier: VS Code adds install metadata to package.json (all other VSIX file bytes verified); old secret seeding used a temporary shim and the controller was a development-extension test hook; no real GitHub or production migration.");
    success = true;
  } finally {
    if (display.exitCode === null && display.signalCode === null) {
      const stopped = new Promise(resolve => display.once("exit", resolve));
      display.kill("SIGTERM"); await stopped;
    }
    if (success) fs.rmSync(scratch, { recursive: true, force: true });
    else console.error(`Failed synthetic profile retained: ${scratch}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
