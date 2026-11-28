// Linux only. The real editor, HOME, extension directory and network are private.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL("../", import.meta.url));
const file = fileURLToPath(import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const baselineDigest = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";

if (process.argv[2] !== "--inside") {
  const [candidate, baseline] = process.argv.slice(2);
  assert(process.platform === "linux" && candidate && process.argv.length <= 4,
    "usage: node tests/linux-default-host-installed.mjs candidate.vsix [published-4.0.22.vsix]");
  const { privateNamespaceArgs } = require("../legacy/scripts/run-next-trial-private-display.js");
  const code = process.env.PKM_VSCODE_EXECUTABLE || join(process.env.HOME, ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
  const xvfb = process.env.PKM_TRIAL_XVFB || join(process.env.HOME, ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
  execFileSync("unshare", privateNamespaceArgs([process.execPath, file, "--inside",
    await readlink("/proc/self/ns/mnt"), await readlink("/proc/self/ns/net"), resolve(code), resolve(xvfb),
    resolve(candidate), ...(baseline ? [resolve(baseline)] : [])]), {
    stdio: "inherit", timeout: 600_000, env: { PATH: process.env.PATH },
  });
} else {
  const [, , , parentMount, parentNetwork, code, xvfb, candidate, baseline] = process.argv;
  assert((await readFile("/proc/1/cmdline", "utf8")).split("\0").includes("pkm-private-init"));
  assert.notEqual(await readlink("/proc/self/ns/mnt"), parentMount);
  assert.notEqual(await readlink("/proc/self/ns/net"), parentNetwork);
  if (baseline) assert.equal(hash(await readFile(baseline)), baselineDigest);
  const work = join(project, ".migration-test-work", `compatible-host-${randomUUID()}`);
  const root = join(work, "root"), user = join(work, "user"), ext = join(work, "ext");
  const driver = join(work, "driver"), workspace = join(work, "workspace");
  const authority = join(work, "xauthority"), display = "127.0.0.1:95";
  for (const dir of ["home/run", "t", "root/notes", "user/User", "ext", "driver", "workspace"])
    await mkdir(join(work, dir), { recursive: true, mode: 0o700 });
  await chmod(work, 0o700);
  process.chdir(work);
  const home = `/proc/${process.pid}/cwd/home`;
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: "/proc/self/cwd/t",
    TMP: "/proc/self/cwd/t", TEMP: "/proc/self/cwd/t", XDG_RUNTIME_DIR: `${home}/run`,
    XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`, XDG_CACHE_HOME: `${home}/cache`,
    GIT_CONFIG_GLOBAL: "/dev/null", DISPLAY: display, XAUTHORITY: authority, PKM_FIXTURE_ROOT: root,
  };
  const run = (bin, args, localEnv = env) => execFileSync(bin, args, { env: localEnv, stdio: "inherit", timeout: 150_000 });
  await writeFile(authority, "", { mode: 0o600 });
  run("ip", ["link", "set", "lo", "up"]);
  run("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
  const screen = spawn(xvfb, [":95", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
    "-listen", "tcp", "-auth", authority], { env, stdio: "inherit" });
  const screenClosed = new Promise((resolve, reject) => {
    screen.once("error", reject);
    screen.once("close", resolve);
  });
  try {
    let displayReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { execFileSync("xdpyinfo", ["-display", display], { env, stdio: "ignore", timeout: 1000 }); displayReady = true; break; }
      catch { await delay(50); }
    }
    assert(displayReady, "isolated Xvfb not ready");
    const settings = join(user, "User/settings.json"), note = join(root, "notes/fixture.md");
    const noteBody = "---\ntitle: Fixture\n---\nExisting synthetic note.\n";
    await writeFile(settings, JSON.stringify({
      "personalKnowledge.storePath": root, "personalKnowledge.openOnStartup": false,
      "update.mode": "none", "telemetry.telemetryLevel": "off", "extensions.autoUpdate": false,
    }), { mode: 0o600 });
    await writeFile(note, noteBody, { mode: 0o600 });
    const rootPin = await stat(root);
    await writeFile(join(driver, "package.json"), JSON.stringify({
      publisher: "fixture", name: "compatible-host-driver", version: "0.0.1", engines: { vscode: "^1.90.0" },
    }));
    const flags = ["--no-sandbox", `--user-data-dir=${user}`, `--extensions-dir=${ext}`];
    const cli = join(dirname(code), "bin/code");
    const install = vsix => run(cli, [...flags, "--install-extension", vsix, "--force"]);
    const open = version => run(code, [...flags, workspace, `--extensionDevelopmentPath=${driver}`,
      `--extensionTestsPath=${fileURLToPath(new URL("./linux-default-host-installed.cjs", import.meta.url))}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates",
      "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--password-store=basic"],
    { ...env, PKM_FIXTURE_VERSION: version });
    if (baseline) { install(baseline); open("4.0.22"); }
    install(candidate);
    open("5.0.0");
    open("5.0.0");
    const restartedPin = await stat(root);
    assert.deepEqual([restartedPin.dev, restartedPin.ino], [rootPin.dev, rootPin.ino]);
    assert.equal(await readFile(note, "utf8"), noteBody);
    for (const marker of [".pkm-next-workspace", ".pkm-next-root-adoption.json", ".pkm-next-root-adoption.commit.json"])
      await assert.rejects(stat(join(root, marker)), { code: "ENOENT" });
    console.log(baseline ? "Published 4.0.22 then same-ID candidate and restart passed." :
      "Candidate installed and restarted; published predecessor not exercised.");
  } finally {
    if (screen.exitCode === null && screen.signalCode === null) screen.kill("SIGTERM");
    await screenClosed;
    process.chdir(project);
    await rm(work, { recursive: true, force: true });
  }
}
