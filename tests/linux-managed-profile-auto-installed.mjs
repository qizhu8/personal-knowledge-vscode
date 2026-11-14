import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const work = join(project, ".migration-test-work"), baseline = join(project, "personal-knowledge-4.0.22.vsix");
const packageDir = join(work, "profile-automatic-overlay-build-v3");
const code = process.env.PKM_PROFILE_CODE || join(process.env.HOME || "", ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const xvfb = process.env.PKM_PROFILE_XVFB || join(process.env.HOME || "", ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
const host = join(project, "../tests/linux-managed-profile-auto-host.cjs");

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}
async function until(action, description, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await action();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
function close(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
async function main() {
  if (!process.argv.includes("--inside")) {
    const args = require("../legacy/scripts/run-next-trial-private-display").privateNamespaceArgs(
      [process.execPath, fileURLToPath(import.meta.url), "--inside", ...(process.argv.includes("--guard-only") ? ["--guard-only"] : [])]);
    const child = spawnSync("unshare", args, { cwd: project, stdio: "inherit", timeout: 600000,
      env: { PATH: process.env.PATH || "", PKM_PROFILE_CODE: code, PKM_PROFILE_XVFB: xvfb,
        PKM_PROFILE_PARENT_MNT: await (await import("node:fs/promises")).readlink("/proc/self/ns/mnt") } });
    if (child.error || child.status !== 0) throw child.error || new Error(`Private namespace failed: ${child.status ?? child.signal}`);
    return;
  }
  assert.notEqual(await (await import("node:fs/promises")).readlink("/proc/self/ns/mnt"), process.env.PKM_PROFILE_PARENT_MNT);
  assert.equal(createHash("sha256").update(await readFile(baseline)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const scratch = join(work, `profile-automatic-${randomUUID()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  assert((await realpath(scratch)).startsWith(await realpath(work) + sep));
  process.chdir(scratch);
  const home = join(scratch, "home"), temp = join(scratch, "temp"), root = join(scratch, "root"), control = join(scratch, "control");
  for (const dir of [home, temp, root, control, join(home, "run")]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const shortHome = `/proc/${process.pid}/cwd/home`, shortTemp = "/proc/self/cwd/temp";
  const env = { PATH: process.env.PATH || "", HOME: shortHome, USERPROFILE: shortHome, TMPDIR: shortTemp, TMP: shortTemp, TEMP: shortTemp,
    XDG_CONFIG_HOME: join(shortHome, "config"), XDG_DATA_HOME: join(shortHome, "data"), XDG_CACHE_HOME: join(shortHome, "cache"),
    XDG_RUNTIME_DIR: join(shortHome, "run"), HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1", PYTHONDONTWRITEBYTECODE: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const cli = join(dirname(code), "bin/code"), processes = [];
  let display, completed = false;
  try {
    checked("ip", ["link", "set", "lo", "up"], { env });
    const authority = join(scratch, "Xauthority"), displayName = "127.0.0.1:95";
    await writeFile(authority, "", { mode: 0o600 });
    checked("xauth", ["-f", authority, "add", displayName, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
    env.DISPLAY = displayName; env.XAUTHORITY = authority;
    display = spawn(xvfb, [":95", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
      "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" });
    await until(() => display.exitCode === null && spawnSync("xdpyinfo", ["-display", displayName], { env, stdio: "ignore" }).status === 0, "private Xvfb", 10000);
    checked(process.execPath, ["-e", `
      require(process.argv[1]).writeAccountMcpBinding(process.argv[2], "manual-user").catch(e => { console.error(e); process.exitCode = 1; });
    `, join(project, "dist/mcp/mcp-account-binding.js"), root], { env, cwd: scratch });
    const profiles = ["a", "b", "unbound", "old"].map(name => ({ name, user: join(scratch, `user-${name}`),
      extensions: join(scratch, `extensions-${name}`), workspace: join(scratch, `workspace-${name}`), driver: join(scratch, `driver-${name}`) }));
    for (const profile of profiles) {
      for (const dir of [join(profile.user, "User"), profile.extensions, join(profile.workspace, ".vscode"), profile.driver])
        await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(profile.workspace, ".vscode/settings.json"), JSON.stringify({
        "personalKnowledge.storePath": root, "personalKnowledge.openOnStartup": false,
        "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
      }));
      await writeFile(join(profile.driver, "package.json"), JSON.stringify({ name: `pkm-auto-driver-${profile.name}`, publisher: "fixture",
        version: "0.0.1", engines: { vscode: "^1.90.0" }, activationEvents: ["*"], main: "./extension.cjs" }));
      require("esbuild").buildSync({ entryPoints: [host], bundle: true, platform: "node", format: "cjs",
        packages: "external", external: ["vscode"], outfile: join(profile.driver, "extension.cjs"), logLevel: "silent" });
    }
    function install(profile, file) {
      return checked(cli, ["--no-sandbox", `--user-data-dir=${profile.user}`, `--extensions-dir=${profile.extensions}`,
        "--install-extension", file, "--force"], { env, cwd: scratch });
    }
    const seen = new Set();
    async function ready(label, predicate = () => true) {
      return until(async () => {
        for (const filename of await readdir(control)) {
          if (filename.startsWith(`${label}-activation-error-`))
            throw new Error(`Private profile activation failed: ${await readFile(join(control, filename), "utf8")}`);
          if (!filename.startsWith(`${label}-ready-`) || seen.has(filename)) continue;
          const value = JSON.parse(await readFile(join(control, filename), "utf8"));
          if (!predicate(value)) continue;
          seen.add(filename);
          return value;
        }
      }, `ready ${label}`);
    }
    function launch(profile, session) {
      const child = spawn(code, [profile.workspace, `--user-data-dir=${profile.user}`, `--extensions-dir=${profile.extensions}`,
        `--extensionDevelopmentPath=${profile.driver}`, "--new-window", "--no-sandbox",
        "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--disable-workspace-trust", "--skip-welcome",
        "--skip-release-notes", "--password-store=basic", "--proxy-server=http://127.0.0.1:1",
        "--proxy-bypass-list=127.0.0.1"], { cwd: scratch, env: { ...env, PKM_PROFILE_ROOT: root,
        PKM_PROFILE_CONTROL: control, PKM_PROFILE_LABEL: profile.name, ...(session ? { PKM_MANAGED_WRITER_SESSION: session } : {}) },
        stdio: "inherit" });
      processes.push({ child, result: close(child) });
      return child;
    }
    for (const profile of profiles) install(profile, baseline);
    launch(profiles[0]);
    assert.equal((await ready("a")).version, "4.0.22");
    const original = processes.pop();
    original.child.kill("SIGTERM");
    await original.result;
    for (const profile of profiles.slice(0, 3)) install(profile, join(packageDir, "profile-4.0.47.vsix"));
    const id = randomUUID(), session = require(join(project, "dist/runtime/managed-writer-session.js"));
    session.provisionManagedWriterSession(root, id);
    launch(profiles[0], id); launch(profiles[1], id); launch(profiles[2]);
    const first = await Promise.all(profiles.slice(0, 3).map(profile => ready(profile.name)));
    assert(first.every(item => item.version === "4.0.47"));
    assert.equal(first[0].session, id); assert.equal(first[1].session, id); assert.equal(first[2].session, null);
    const repo = join(root, "repo"); await mkdir(repo, { mode: 0o700 });
    const git = (...args) => checked("git", ["-C", repo, ...args], { env });
    git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "file"), "synthetic"); git("add", "file");
    const hook = join(repo, ".git/hooks/pre-commit"), worker = join(scratch, "hook.py");
    await writeFile(worker, `import os,pathlib,time\nos.setsid()\nfor fd in range(3,256):\n try: os.close(fd)\n except OSError: pass\npathlib.Path(${JSON.stringify(join(control, "hook-ready"))}).write_text(str(os.getpid()))\nwhile not pathlib.Path(${JSON.stringify(join(control, "hook-release"))}).exists(): time.sleep(.02)\npathlib.Path(${JSON.stringify(join(control, "hook-finished"))}).write_text("finished")\n`);
    await writeFile(hook, `#!/bin/sh\npython3 '${worker}' </dev/null >/dev/null 2>&1 &\nexit 0\n`, { mode: 0o700 });
    await writeFile(join(control, "a-git"), "");
    await until(async () => (await readdir(control)).includes("hook-ready") && (await readdir(control)).includes("a-git-returned"), "detached Git hook");
    process.kill(first[0].pid, "SIGKILL");
    processes[0].child.kill("SIGTERM");
    await processes[0].result;
    launch(profiles[0], id);
    const restarted = await ready("a", value => value.pid !== first[0].pid);
    assert.equal(restarted.session, id);
    const participants = session.discoverManagedProfiles(root, id);
    assert.equal(participants.length, 3);
    assert.equal(participants.filter(item => item.state === "stopped").length, 1);
    const ambiguousProfile = join(profiles[1].user, "User/profiles/synthetic-named");
    await mkdir(ambiguousProfile, { recursive: true, mode: 0o700 });
    console.log("PRIVATE_PROFILE_STORAGE", first.map(item => item.globalStorage));
    const state = join(root, ".pkm/state/managed-writer-session");
    assert(!(await readdir(state)).includes("fenced"), "Session must be accepting before the update.");
    const observations = [];
    let lastObservation = "";
    const observe = () => {
      try {
        const fs = require("node:fs");
        const snapshot = JSON.stringify({
          marker: fs.existsSync(ambiguousProfile),
          profiles: fs.readdirSync(join(profiles[1].user, "User/profiles")),
          fenced: fs.existsSync(join(state, "fenced")),
          session: JSON.parse(fs.readFileSync(join(state, "session.json"), "utf8")).id,
        });
        if (snapshot !== lastObservation) {
          observations.push({ at: Date.now(), ...JSON.parse(snapshot) });
          lastObservation = snapshot;
        }
      } catch (error) { observations.push({ at: Date.now(), error: String(error) }); }
    };
    observe();
    const observer = setInterval(observe, 20);
    observer.unref();
    const watcher = require("node:fs").watch(join(profiles[1].user, "User/profiles"), (event, name) => {
      observations.push({ at: Date.now(), event, name: String(name) });
      observe();
    });
    const installer = spawn(cli, ["--no-sandbox", `--user-data-dir=${profiles[1].user}`,
      `--extensions-dir=${profiles[1].extensions}`, "--install-extension",
      join(packageDir, "profile-4.0.48.vsix"), "--force"], { env, cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
    let installOutput = "";
    installer.stdout.on("data", chunk => { installOutput += chunk; });
    installer.stderr.on("data", chunk => { installOutput += chunk; });
    try {
      const installExit = await close(installer);
      observe();
      assert.equal(installExit.code, 0, `Install failed: ${installOutput}`);
      console.log("PRIVATE_INSTALL_OUTPUT", installOutput.trim());
      await delay(2000);
    } finally {
      clearInterval(observer);
      watcher.close();
      observe();
      console.log("PRIVATE_AMBIGUITY_TRACE", JSON.stringify(observations));
    }
    assert((await readdir(join(profiles[1].user, "User/profiles"))).includes("synthetic-named"),
      "The synthetic ambiguity marker must remain present during observation.");
    assert(!(await readdir(state)).includes("fenced"), "Ambiguous installed profile must not trigger automatic fencing.");
    await rm(ambiguousProfile, { recursive: true });
    console.log("PRIVATE_AMBIGUOUS_PROFILE_AUTOMATIC_FENCE_BLOCKED");
    if (process.argv.includes("--guard-only")) { completed = true; return; }
    await writeFile(join(control, "b-inspect"), "");
    await until(async () => (await readdir(control)).includes("b-inspect-result.json"), "installed runtime inspection", 15000);
    console.log("PRIVATE_INSTALLED_PROFILE_INSPECTION", await readFile(join(control, "b-inspect-result.json"), "utf8"));
    try { console.log("PRIVATE_DEFAULT_INDEX", await readFile(join(profiles[1].extensions, "extensions.json"), "utf8")); } catch {}
    await until(async () => (await readdir(state)).includes("fenced"), "automatic admission fence", 30000);
    await delay(750);
    assert.equal(JSON.parse(await readFile(join(state, "session.json"), "utf8")).id, id, "Detached Git must delay rotation.");
    launch(profiles[3]);
    const old = await ready("old");
    assert.equal(old.version, "4.0.22");
    assert.equal(old.session, null);
    await writeFile(join(control, "old-old-write"), "");
    await until(async () => (await readdir(control)).includes("old-old-write-result"), "stale installed profile write", 15000);
    assert.match(await readFile(join(root, "notes/Legacy After Stop.md"), "utf8"), /Synthetic stale-profile write/);
    assert.equal(session.discoverManagedProfiles(root, id).length, 3);
    await writeFile(join(control, "hook-release"), "");
    await until(async () => (await readdir(control)).includes("hook-finished"), "detached Git completion");
    const next = await until(async () => {
      const current = JSON.parse(await readFile(join(state, "session.json"), "utf8")).id;
      return current !== id && current;
    }, "automatic rotation", 30000);
    const successorA = await ready("a", value => value.session === next);
    const successorB = await ready("b", value => value.session === next);
    assert.equal(successorA.version, "4.0.47");
    assert.equal(successorB.version, "4.0.48");
    assert.equal(successorA.status.cutoverAuthorized, false);
    assert.equal(successorB.status.preexistingAndExternalWriters, "unknown");
    assert.equal(session.resolveManagedWriterSession(root, id), next);
    console.log("PRIVATE_PROFILE_AUTO_INSTALLED_PASS", JSON.stringify({ old: "4.0.22", initial: "4.0.47", update: "4.0.48",
      previous: id, next, crashPid: first[0].pid, restartedPid: restarted.pid,
      successorA: successorA.pid, successorB: successorB.pid, unbound: first[2].pid,
      staleOldPid: old.pid, staleOldWriteDuringFence: true, detachedHookCompleted: true, external: "unknown", cutoverAuthorized: false }));
    completed = true;
  } finally {
    await writeFile(join(control, "hook-release"), "").catch(() => {});
    for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(processes.map(({ result }) => Promise.race([result, delay(5000)])));
    if (display && display.exitCode === null && display.signalCode === null) { display.kill("SIGTERM"); await close(display); }
    await delay(1500);
    if (completed) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    else console.error("PRIVATE_FAILED_FIXTURE_RETAINED", scratch);
  }
}
await main();
