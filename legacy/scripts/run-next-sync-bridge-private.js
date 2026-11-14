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
const adoptedGuard = process.argv.includes("--adopted-guard");
const legacySameRoot = process.argv.includes("--legacy-same-root");
if (legacySameRoot && !adoptedGuard) throw new Error("Same-root fixture requires the live-host guard check.");
const code = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
const xvfb = process.env.PKM_TRIAL_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
if (!candidate || !legacy || !path.isAbsolute(candidate) || !path.isAbsolute(legacy)) {
  console.error("Supply absolute --candidate-vsix and --legacy-vsix paths.");
  process.exit(1);
}
if (!process.argv.includes("--inside")) {
  const fixture = path.join(project, ".migration-test-work", `pkm-sync-fixture-${randomUUID()}`);
  const result = spawnSync("unshare", ["-Urnmpf", "--mount-proc", "bash", "-c",
    '"$@" & workload=$!; wait "$workload"', "private-init", process.execPath, __filename, "--inside",
    `--candidate-vsix=${candidate}`, `--legacy-vsix=${legacy}`, `--fixture=${fixture}`,
    ...(adoptedGuard ? ["--adopted-guard"] : []), ...(legacySameRoot ? ["--legacy-same-root"] : [])],
    { cwd: project, env: { PATH: process.env.PATH || "", PKM_VSCODE_EXECUTABLE: code, PKM_TRIAL_XVFB: xvfb }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0) fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  const scratch = process.argv.find(arg => arg.startsWith("--fixture="))?.slice("--fixture=".length);
  if (!scratch || path.dirname(scratch) !== path.join(project, ".migration-test-work")
    || !/^pkm-sync-fixture-[a-f0-9-]{36}$/.test(path.basename(scratch)) || fs.existsSync(scratch))
    throw new Error("Invalid private fixture path.");
  for (const name of ["u/User", "x", "h/run", "t", "workspace", "legacy-root/notes", "legacy-root/skills", "native-root/notes", "native-root/skills", "provider", "driver"])
    fs.mkdirSync(path.join(scratch, name), { recursive: true, mode: 0o700 });
  process.chdir(scratch);
  const short = `/proc/${process.pid}/cwd`;
  const user = `${short}/u`, extensions = `${short}/x`, root = path.join(scratch, "legacy-root");
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
  const nativeRoot = legacySameRoot ? root : path.join(scratch, "native-root");
  fs.writeFileSync(path.join(root, "notes/Sentinel.md"), "synthetic note unchanged\n", { mode: 0o600 });
  for (const name of ["InstallAlpha", "InstallBeta"])
    fs.writeFileSync(path.join(nativeRoot, "skills", `${name}.md`), `---\nname: ${name}\n---\nbase\n`, { mode: 0o600 });
  if (legacySameRoot) {
    fs.writeFileSync(path.join(root, "notes/Keep.md"), "---\ntitle: Keep\n---\nlegacy note\n", { mode: 0o600 });
    const data = await require("../tests/next-trial-electron/legacy-sync-actual-fixture.cjs").prepareLegacySync({
      fixture: scratch, root, globalStorage, pending: true,
    });
    const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
      secretRef: randomUUID(), expectedLogin: "fixture", visibility: "public", allowPrivate: false,
      extensionVersion: "4.0.22", approvalId: randomUUID() };
    fs.mkdirSync(path.join(scratch, "sync-installed"), { mode: 0o700 });
    fs.writeFileSync(path.join(scratch, "sync-installed/fixture.json"),
      JSON.stringify({ ...data, policy }), { mode: 0o600 });
  }
  if (adoptedGuard) {
    const adoption = await import("../next-server/dist/legacy-root-adoption.js");
    const adopted = await adoption.adoptLegacyRootInPlaceExperimental(nativeRoot, {});
    await adopted.storage.close();
  } else fs.writeFileSync(path.join(nativeRoot, ".pkm-next-workspace"),
    JSON.stringify({ schema: "pkm.next-workspace/v2", id: randomUUID() }), { mode: 0o600 });
  if (!legacySameRoot) {
    require("../tests/next-trial-electron/sync-installed.cjs").prepare({ fixture: scratch, root: nativeRoot, globalStorage });
    fs.renameSync(path.join(scratch, "sync-installed/remote.git"), path.join(scratch, "remote.git"));
    fs.chmodSync(path.join(scratch, "remote.git"), 0o700);
  }
  const legacySyncFiles = legacySameRoot ? [
    path.join(globalStorage, "github-sync/targets.json"),
    path.join(globalStorage, "github-sync/checkouts/fixture-target/transactions/latest.json"),
  ] : [];
  const legacySyncBefore = legacySyncFiles.map(file => fs.readFileSync(file));
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
    fs.copyFileSync(path.join(project, "tests/next-trial-electron/next-sync-bridge-driver.cjs"), path.join(driver, "extension.cjs"));
    clearUserCache();
    await runCode("candidate-host", { PKM_SYNC_HOST_DRIVER_MARKER: driverMarker, PKM_PRIVATE_SYNC_FIXTURE: scratch,
      PKM_SYNC_ADOPTED_GUARD_TEST: adoptedGuard ? "1" : "", PKM_PRIVATE_SYNC_SAME_ROOT: legacySameRoot ? "1" : "" }, [`--extensionDevelopmentPath=${driver}`]);
    const outcome = JSON.parse(fs.readFileSync(driverMarker, "utf8"));
    assert.equal(outcome.passed, true, `Real extension host observation failed: ${outcome.error || "unknown"}`);
    for (const log of ["legacy-seed.log", "candidate-host.log", "driver-result.json"])
      assert(!fs.readFileSync(path.join(scratch, log), "utf8").includes("fixture-token"), `Credential leaked in ${log}`);
    assert.deepEqual(payload(current), before, "Target installed VSIX payload changed during observation");
    assertInstalledVsix(candidate, current);
    legacySyncFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), legacySyncBefore[index]));
    assert.equal(fs.readFileSync(path.join(root, "notes/Sentinel.md"), "utf8"), "synthetic note unchanged\n");
    if (adoptedGuard)
      console.log(legacySameRoot
        ? "PASS: retained legacy Sync wrote historical baseline and pushed journal on the same adopted root; a live normal VS Code host remains blocked by LEGACY_WRITERS_ACTIVE."
        : "PASS: under a live normal VS Code host the private adopted root writer inventory reports a blocker and child opening remains refused.");
    else console.log("PASS: normal VS Code unmodified target package host served its own Next child from SecretStorage; private bare Git push/pull, crash recovery and conflict persistence; production cutover blocked.");
    console.log("Qualifier: synthetic fixture only; VS Code adds manifest installation metadata; old secret seeded by temporary shim, controller is a development-extension test hook. No real GitHub or production migration.");
    success = true;
  } finally {
    if (display.exitCode === null && display.signalCode === null) {
      const stopped = new Promise(resolve => display.once("exit", resolve));
      display.kill("SIGTERM"); await stopped;
    }
    if (!success) console.error(`Failed synthetic profile retained: ${scratch}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
