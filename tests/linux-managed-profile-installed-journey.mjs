import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

const require = createRequire(import.meta.url);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const work = join(project, ".migration-test-work");
const old = join(project, "personal-knowledge-4.0.22.vsix");
const candidate = join(work, "profile-discovery-overlay-build/profile-focused-4.0.39.vsix");
const driver = join(project, "../tests/linux-managed-profile-installed-driver.mjs");
const code = process.env.PKM_PROFILE_CODE || join(process.env.HOME || "", ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const xvfb = process.env.PKM_PROFILE_XVFB || join(process.env.HOME || "", ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}
async function waitFile(file, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for fixture ${file}`);
}
function close(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
async function main() {
  assert.equal(process.platform, "linux");
  if (!process.argv.includes("--inside")) {
    const args = require("../legacy/scripts/run-next-trial-private-display").privateNamespaceArgs(
      [process.execPath, fileURLToPath(import.meta.url), "--inside"]);
    const child = spawnSync("unshare", args, { cwd: project, stdio: "inherit", timeout: 600000,
      env: { PATH: process.env.PATH || "", PKM_PROFILE_CODE: code, PKM_PROFILE_XVFB: xvfb,
        PKM_PROFILE_PARENT_MNT: await (await import("node:fs/promises")).readlink("/proc/self/ns/mnt") } });
    if (child.error || child.status !== 0) throw child.error || new Error(`Private namespace failed: ${child.status ?? child.signal}`);
    return;
  }
  assert.notEqual(await (await import("node:fs/promises")).readlink("/proc/self/ns/mnt"), process.env.PKM_PROFILE_PARENT_MNT);
  assert.equal(createHash("sha256").update(await readFile(old)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const scratch = join(work, `profile-installed-${randomUUID()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  assert((await realpath(scratch)).startsWith(await realpath(work) + sep));
  const home = join(scratch, "home"), temp = join(scratch, "temp"), root = join(scratch, "root"), control = join(scratch, "control");
  for (const dir of [home, temp, root, control, join(home, "run")]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const shortHome = "/proc/self/cwd/home", shortTemp = "/proc/self/cwd/temp";
  const env = { PATH: process.env.PATH || "", HOME: shortHome, USERPROFILE: shortHome, TMPDIR: shortTemp, TMP: shortTemp, TEMP: shortTemp,
    XDG_CONFIG_HOME: join(shortHome, "config"), XDG_DATA_HOME: join(shortHome, "data"), XDG_CACHE_HOME: join(shortHome, "cache"),
    XDG_RUNTIME_DIR: join(shortHome, "run"), HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1", PYTHONDONTWRITEBYTECODE: "1" };
  const cli = join(dirname(code), "bin/code"), processes = [];
  let display;
  try {
    checked("ip", ["link", "set", "lo", "up"], { env });
    const displayName = "127.0.0.1:95", authority = join(scratch, "Xauthority");
    await writeFile(authority, "", { mode: 0o600 });
    checked("xauth", ["-f", authority, "add", displayName, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
    env.DISPLAY = displayName; env.XAUTHORITY = authority;
    display = spawn(xvfb, [":95", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
      "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" });
    for (let tries = 0; ; tries++) {
      if (display.exitCode !== null || display.signalCode !== null || tries > 100) throw new Error("Private Xvfb did not start.");
      if (spawnSync("xdpyinfo", ["-display", displayName], { env, stdio: "ignore" }).status === 0) break;
      await delay(50);
    }
    checked(process.execPath, ["-e", `
      require(process.argv[1]).writeAccountMcpBinding(process.argv[2], "manual-user").catch(e => { console.error(e); process.exitCode = 1; });
    `, join(project, "dist/mcp/mcp-account-binding.js"), root], { env, cwd: scratch });
    const profiles = ["a", "b", "unbound"].map(name => ({ name, user: join(scratch, `user-${name}`),
      extensions: join(scratch, `extensions-${name}`), workspace: join(scratch, `workspace-${name}`),
      driver: join(scratch, `driver-${name}`) }));
    for (const profile of profiles) {
      for (const dir of [join(profile.user, "User"), profile.extensions, join(profile.workspace, ".vscode"), profile.driver]) await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(profile.workspace, ".vscode/settings.json"), JSON.stringify({
        "personalKnowledge.storePath": root, "personalKnowledge.openOnStartup": false,
        "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
        "extensions.autoCheckUpdates": false,
      }));
      await writeFile(join(profile.driver, "package.json"), JSON.stringify({ name: `pkm-profile-driver-${profile.name}`,
        publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.90.0" } }));
    }
    function install(profile, vsix, named = true) {
      checked(cli, ["--no-sandbox", `--user-data-dir=${profile.user}`, `--extensions-dir=${profile.extensions}`,
        ...(named ? [`--profile=PKM-${profile.name}`] : []), "--install-extension", vsix, "--force"], { env, cwd: scratch });
    }
    async function run(profile, version, session, suffix = "") {
      const label = `${version}-${profile.name}${suffix}`;
      const child = spawn(process.execPath, [driver], { cwd: scratch, env: { ...env,
        PKM_PROFILE_CODE: code, PKM_PROFILE_DRIVER: profile.driver, PKM_PROFILE_WORKSPACE: profile.workspace,
        PKM_PROFILE_USER: profile.user, PKM_PROFILE_EXTENSIONS: profile.extensions, PKM_PROFILE_NAME: `PKM-${profile.name}`,
        PKM_PROFILE_ROOT: root, PKM_PROFILE_CONTROL: control, PKM_PROFILE_LABEL: label, PKM_PROFILE_VERSION: version,
        PKM_PROFILE_EXPECT_ENROLLED: session ? "1" : "0",
        ...(session ? { PKM_MANAGED_WRITER_SESSION: session } : {}),
      }, stdio: "inherit" });
      const result = close(child);
      processes.push({ child, result });
      const ready = JSON.parse(await Promise.race([waitFile(join(control, `${label}-ready.json`)),
        result.then(value => { throw new Error(`Private profile ${label} exited before readiness: ${JSON.stringify(value)}`); })]));
      return { child, result, ready, label };
    }
    for (const profile of profiles) {
      const bootstrap = spawn(process.execPath, [driver], { cwd: scratch, env: { ...env,
        PKM_PROFILE_CODE: code, PKM_PROFILE_DRIVER: profile.driver, PKM_PROFILE_WORKSPACE: profile.workspace,
        PKM_PROFILE_USER: profile.user, PKM_PROFILE_EXTENSIONS: profile.extensions, PKM_PROFILE_NAME: `PKM-${profile.name}`,
        PKM_PROFILE_BOOTSTRAP: "1",
      }, stdio: "inherit" });
      assert.equal((await close(bootstrap)).code, 0, "The editor did not create its named profile.");
      install(profile, old);
    }
    const previous = await Promise.all(profiles.map(profile => run(profile, "4.0.22")));
    assert.notEqual(previous[0].ready.pid, previous[1].ready.pid);
    for (const instance of previous) await writeFile(join(control, `${instance.label}-exit`), "");
    for (const instance of previous) assert.equal((await instance.result).code, 0);

    for (const profile of profiles) install(profile, candidate);
    const id = randomUUID();
    require(join(project, "dist/runtime/managed-writer-session.js")).provisionManagedWriterSession(root, id);
    const current = await Promise.all(profiles.slice(0, 2).map(profile => run(profile, "4.0.39", id)));
    const unbound = await run(profiles[2], "4.0.39");
    assert.notEqual(current[0].ready.pid, current[1].ready.pid);
    for (const instance of current) {
      assert.equal(instance.ready.session, id);
      assert.equal(instance.ready.status.state, "accepting");
      assert.equal(instance.ready.status.preexistingAndExternalWriters, "unknown");
    }
    const repo = join(root, "repo");
    await mkdir(repo, { mode: 0o700 });
    const git = (...args) => checked("git", ["-C", repo, ...args], { env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "file"), "synthetic"); git("add", "file");
    const hook = join(repo, ".git/hooks/pre-commit"), worker = join(scratch, "hook.py");
    await writeFile(worker, `import os,pathlib,time\nos.setsid()\nfor fd in range(3,256):\n try: os.close(fd)\n except OSError: pass\npathlib.Path(${JSON.stringify(join(control, "hook-ready"))}).write_text(str(os.getpid()))\nwhile not pathlib.Path(${JSON.stringify(join(control, "hook-release"))}).exists(): time.sleep(.02)\npathlib.Path(${JSON.stringify(join(control, "hook-finished"))}).write_text("finished")\n`);
    await writeFile(hook, `#!/bin/sh\npython3 '${worker}' </dev/null >/dev/null 2>&1 &\nexit 0\n`, { mode: 0o700 });
    await writeFile(join(control, `${current[0].label}-git`), "");
    await waitFile(join(control, "hook-ready")); await waitFile(join(control, `${current[0].label}-git-returned`));
    process.kill(current[0].ready.pid, "SIGKILL");
    await Promise.race([current[0].result, delay(20000).then(() => { throw new Error("Killed profile did not exit."); })]);
    const restarted = await run(profiles[0], "4.0.39", id, "-restart");
    await writeFile(join(control, `${current[1].label}-discover-0`), "");
    const found = JSON.parse(await waitFile(join(control, `${current[1].label}-discovered-0`)));
    assert.equal(found.length, 3);
    assert.equal(new Set(found.map(entry => entry.profileId)).size, 2);
    assert(found.every(entry => entry.state === "registered-unverified"));
    await writeFile(join(control, `${current[1].label}-handoff`), "");
    await delay(800);
    await assert.rejects(readFile(join(control, `${current[1].label}-handoff-result`)), { code: "ENOENT" });
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    await writeFile(join(control, "hook-release"), "");
    await waitFile(join(control, "hook-finished"));
    const error = await waitFile(join(control, `${current[1].label}-handoff-error`), 20000);
    assert.match(error, /active or has an unknown outcome/);
    await writeFile(join(control, `${current[1].label}-discover-1`), "");
    const after = JSON.parse(await waitFile(join(control, `${current[1].label}-discovered-1`)));
    assert.equal(after.filter(entry => entry.state === "registered-unverified").length, 1);
    assert.equal(after.filter(entry => entry.state === "drained").length, 2);
    for (const instance of [current[1], restarted, unbound]) await writeFile(join(control, `${instance.label}-exit`), "");
    for (const instance of [current[1], restarted, unbound]) assert.equal((await instance.result).code, 0);
    console.log("PRIVATE_PROFILE_INSTALLED_PASS", JSON.stringify({ old: "4.0.22", overlay: "4.0.39",
      candidateSha256: createHash("sha256").update(await readFile(candidate)).digest("hex"),
      profiles: current.map(instance => instance.ready.pid), restarted: restarted.ready.pid,
      unbound: unbound.ready.pid, detachedHookCompleted: true, profilesAfterCrash: after, error }));
  } finally {
    await writeFile(join(control, "hook-release"), "").catch(() => {});
    for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(processes.map(({ result }) => Promise.race([result, delay(5000)])));
    if (display && display.exitCode === null && display.signalCode === null) { display.kill("SIGTERM"); await close(display); }
    await delay(1500);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
await main();
