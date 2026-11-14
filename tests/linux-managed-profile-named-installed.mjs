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
const work = join(project, ".migration-test-work");
const packages = join(work, "profile-named-overlay-v6");
const compiled = join(work, "profile-named-focused/dist");
const code = process.env.PKM_PROFILE_CODE || join(process.env.HOME || "", ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const xvfb = process.env.PKM_PROFILE_XVFB || join(process.env.HOME || "", ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
const host = join(project, "../tests/linux-managed-profile-auto-host.cjs");

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command}: ${result.stdout}\n${result.stderr}`);
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
      [process.execPath, fileURLToPath(import.meta.url), "--inside", ...(process.argv.includes("--crash-loop") ? ["--crash-loop"] : [])]);
    const child = spawnSync("unshare", args, { cwd: project, stdio: "inherit", timeout: 600000,
      env: { PATH: process.env.PATH || "", PKM_PROFILE_CODE: code, PKM_PROFILE_XVFB: xvfb,
        PKM_PROFILE_PARENT_MNT: await (await import("node:fs/promises")).readlink("/proc/self/ns/mnt") } });
    if (child.error || child.status !== 0) throw child.error || new Error(`Private namespace failed: ${child.status ?? child.signal}`);
    return;
  }
  assert.notEqual(await (await import("node:fs/promises")).readlink("/proc/self/ns/mnt"), process.env.PKM_PROFILE_PARENT_MNT);
  for (const [version, sha] of [
    ["4.0.52", "5ae787a2b228444a1f877c5560b00372915b348096c8feb700129a15e3acbfff"],
    ["4.0.53", "cc21235efdd8f361699b47092f856dea6da34d5de4af51bf0432017a4d6f3a8d"],
  ]) assert.equal(createHash("sha256").update(await readFile(join(packages, `profile-${version}.vsix`))).digest("hex"), sha);
  const scratch = join(work, `profile-named-installed-${randomUUID()}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  assert((await realpath(scratch)).startsWith(await realpath(work) + sep));
  process.chdir(scratch);
  const home = join(scratch, "home"), temp = join(scratch, "temp"), root = join(scratch, "root"), control = join(scratch, "control");
  const user = join(scratch, "user"), extensions = join(scratch, "extensions");
  const driver = join(scratch, "driver");
  const workspaceA = join(scratch, "named-a"), workspaceB = join(scratch, "named-b");
  for (const dir of [home, temp, root, control, join(home, "run"), join(user, "User"), extensions, driver,
    join(workspaceA, ".vscode"), join(workspaceB, ".vscode")]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const shortHome = `/proc/${process.pid}/cwd/home`, shortTemp = "/proc/self/cwd/temp";
  const env = { PATH: process.env.PATH || "", HOME: shortHome, USERPROFILE: shortHome, TMPDIR: shortTemp, TMP: shortTemp, TEMP: shortTemp,
    XDG_CONFIG_HOME: join(shortHome, "config"), XDG_DATA_HOME: join(shortHome, "data"), XDG_CACHE_HOME: join(shortHome, "cache"),
    XDG_RUNTIME_DIR: join(shortHome, "run"), HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1", PYTHONDONTWRITEBYTECODE: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const cli = join(dirname(code), "bin/code"), processes = [];
  let display, completed = false;
  try {
    checked("ip", ["link", "set", "lo", "up"], { env });
    const authority = join(scratch, "Xauthority"), displayName = "127.0.0.1:96";
    await writeFile(authority, "", { mode: 0o600 });
    checked("xauth", ["-f", authority, "add", displayName, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
    env.DISPLAY = displayName; env.XAUTHORITY = authority;
    display = spawn(xvfb, [":96", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
      "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" });
    await until(() => display.exitCode === null && spawnSync("xdpyinfo", ["-display", displayName], { env, stdio: "ignore" }).status === 0, "private Xvfb", 10000);
    checked(process.execPath, ["-e", `
      require(process.argv[1]).writeAccountMcpBinding(process.argv[2], "manual-user").catch(e => { console.error(e); process.exitCode = 1; });
    `, join(compiled, "mcp/mcp-account-binding.js"), root], { env, cwd: scratch });
    for (const workspace of [workspaceA, workspaceB]) await writeFile(join(workspace, ".vscode/settings.json"), JSON.stringify({
      "personalKnowledge.storePath": root, "personalKnowledge.openOnStartup": false,
      "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
    }));
    await writeFile(join(driver, "package.json"), JSON.stringify({ name: "pkm-named-driver", publisher: "fixture",
      description: "Isolated profile test driver", version: "0.0.1", engines: { vscode: "^1.90.0" },
      activationEvents: ["*"], main: "./extension.cjs" }));
    await writeFile(join(driver, "README.md"), "# Isolated profile test driver\n");
    require("esbuild").buildSync({ entryPoints: [host], bundle: true, platform: "node", format: "cjs",
      packages: "external", external: ["vscode"], outfile: join(driver, "extension.cjs"), logLevel: "silent" });
    const driverVsix = join(scratch, "driver.vsix");
    checked("vsce", ["package", "--no-dependencies", "--allow-missing-repository", "--out", driverVsix],
      { env, cwd: driver });
    const baseArgs = [`--user-data-dir=${user}`, `--extensions-dir=${extensions}`, "--no-sandbox",
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--disable-workspace-trust",
      "--skip-welcome", "--skip-release-notes", "--password-store=basic", "--proxy-server=http://127.0.0.1:1",
      "--proxy-bypass-list=127.0.0.1"];
    for (const [workspace, name, expected] of [[workspaceA, "Managed A", 1], [workspaceB, "Managed B", 2]]) {
      const bootstrap = spawn(code, [workspace, ...baseArgs, `--profile=${name}`], { cwd: scratch, env, stdio: "inherit" });
      const bootstrapExit = close(bootstrap);
      processes.push({ child: bootstrap, result: bootstrapExit });
      await until(async () => { try { return (await readdir(join(user, "User/profiles"))).length >= expected; } catch { return false; } }, `create ${name}`);
      await delay(4000);
      bootstrap.kill("SIGTERM");
      await bootstrapExit;
    }
    function install(file, name) {
      return checked(cli, [`--user-data-dir=${user}`, `--extensions-dir=${extensions}`, "--no-sandbox",
        `--profile=${name}`, "--install-extension", file, "--force"], { env, cwd: scratch });
    }
    for (const name of ["Managed A", "Managed B"]) {
      console.log("PRIVATE_NAMED_INSTALL", name, install(join(packages, "profile-4.0.52.vsix"), name).trim());
      install(driverVsix, name);
    }
    const profileDirectories = await readdir(join(user, "User/profiles"));
    assert.equal(profileDirectories.length, 2);
    for (const directory of profileDirectories) {
      const namedIndex = join(user, "User/profiles", directory, "extensions.json");
      assert(JSON.parse(await readFile(namedIndex, "utf8")).some(item =>
        item.identifier?.id?.toLowerCase() === "uone.personal-knowledge" && item.version === "4.0.52"));
    }
    const session = require(join(compiled, "runtime/managed-writer-session.js")), id = randomUUID();
    session.provisionManagedWriterSession(root, id);
    const hostEnv = { ...env, PKM_PROFILE_ROOT: root, PKM_PROFILE_CONTROL: control, PKM_PROFILE_LABEL_FROM_WORKSPACE: "1",
      PKM_MANAGED_WRITER_SESSION: id };
    function launch(workspace, name) {
      const child = spawn(code, [workspace, ...baseArgs, "--new-window", `--profile=${name}`], { cwd: scratch, env: hostEnv, stdio: "inherit" });
      processes.push({ child, result: close(child) });
      return child;
    }
    const seen = new Set();
    async function ready(label, predicate = () => true, timeout = 90000) {
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
      }, `ready ${label}`, timeout);
    }
    launch(workspaceA, "Managed A");
    const named = await ready("named-a");
    launch(workspaceB, "Managed B");
    const normal = await ready("named-b");
    assert.equal(named.version, "4.0.52"); assert.equal(normal.version, "4.0.52");
    assert.equal(named.session, id); assert.equal(normal.session, id);
    console.log("PRIVATE_NAMED_LIVE", JSON.stringify({ named, normal, discovered: session.discoverManagedProfiles(root, id) }));
    const state = join(root, ".pkm/state/managed-writer-session"), operations = join(state, "operations");
    const serviceOperation = await until(async () => {
      const serviceDir = join(user, "User/globalStorage/uone.personal-knowledge/pkm-service");
      let started = false;
      try {
        for (const directory of await readdir(serviceDir)) {
          try { if ((await readFile(join(serviceDir, directory, "service.log"), "utf8")).includes("PKM_SERVICE_STARTED")) started = true; }
          catch {}
        }
      } catch {}
      if (!started) return;
      for (const file of await readdir(operations)) {
        if (!file.endsWith(".pending")) continue;
        const record = JSON.parse(await readFile(join(operations, file), "utf8"));
        if (record.kind === "sync-service" && !(await readdir(operations)).includes(file.replace(".pending", ".complete"))) return file;
      }
    }, "registered live Sync service", 45000);
    console.log("PRIVATE_SYNC_SERVICE_PENDING", serviceOperation);
    let restored = named;
    const recoveries = [];
    for (let attempt = 0; attempt < (process.argv.includes("--crash-loop") ? 4 : 1); attempt++) {
      const crashed = restored.pid;
      process.kill(crashed, "SIGKILL");
      let mode = "automatic";
      try { restored = await ready("named-a", value => value.pid !== crashed, 8000); }
      catch (error) {
        if (!String(error).includes("Timed out: ready named-a")) throw error;
        mode = "manual-command";
        console.log("PRIVATE_HOST_NOT_AUTOMATICALLY_RESTARTED", crashed);
        console.log("PRIVATE_X11_TREE", checked("xwininfo", ["-root", "-tree"], { env, cwd: scratch }));
        console.log(checked("python3", ["-B", join(project, "../tests/linux-managed-profile-x11-restart.py"), "named-a"], { env, cwd: scratch }));
        restored = await ready("named-a", value => value.pid !== crashed, 45000);
      }
      assert.equal(restored.session, id);
      recoveries.push({ crashed, restored: restored.pid, mode });
      console.log("PRIVATE_NAMED_HOST_RESTORED", JSON.stringify({ ...restored, mode }));
    }
    console.log("PRIVATE_NAMED_UPDATE", install(join(packages, "profile-4.0.53.vsix"), "Managed A").trim());
    const successor = await until(async () => {
      const current = JSON.parse(await readFile(join(state, "session.json"), "utf8")).id;
      return current !== id && current;
    }, "named profile automatic rotation", 45000);
    const nextA = await ready("named-a", value => value.session === successor);
    const nextB = await ready("named-b", value => value.session === successor);
    assert.equal(nextA.version, "4.0.53"); assert.equal(nextB.version, "4.0.52");
    assert.equal(nextA.status.cutoverAuthorized, false);
    assert.equal(nextB.status.preexistingAndExternalWriters, "unknown");
    assert.equal(session.resolveManagedWriterSession(root, id), successor);
    const archived = join(state, `operations.${id}`);
    assert((await readdir(archived)).includes(serviceOperation.replace(".pending", ".complete")),
      "The registered Sync daemon must drain before rotation.");
    console.log("PRIVATE_NAMED_INSTALLED_PASS", JSON.stringify({ id, successor, named: named.pid, normal: normal.pid,
      restored: restored.pid, recoveries, nextA: nextA.pid, nextB: nextB.pid, syncServiceDrained: true, cutoverAuthorized: false }));
    completed = true;
  } finally {
    for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(processes.map(({ result }) => Promise.race([result, delay(5000)])));
    if (display && display.exitCode === null && display.signalCode === null) { display.kill("SIGTERM"); await close(display); }
    await delay(1500);
    if (completed) await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    else console.error("PRIVATE_FAILED_FIXTURE_RETAINED", scratch);
  }
}
await main();
