import { constants, accessSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hostDirectory = fileURLToPath(new URL(".", import.meta.url));

function executable(pathname) {
  try {
    accessSync(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function cachedVSCode() {
  const configured = process.env.PKM_VSCODE_EXECUTABLE;
  if (configured) {
    if (!executable(configured)) throw new Error(`PKM_VSCODE_EXECUTABLE is not executable: ${configured}`);
    return configured;
  }

  if (process.platform !== "linux") {
    throw new Error("No VS Code executable configured; set PKM_VSCODE_EXECUTABLE to an installed executable");
  }

  const cache = path.join(os.homedir(), ".cache", "pkm-vscode-test");
  if (!existsSync(cache)) throw new Error(`No cached VS Code executable found in ${cache}`);

  const candidates = readdirSync(cache)
    .map(name => ({ name, version: /^vscode-linux-x64-(\d+\.\d+\.\d+)$/.exec(name)?.[1] }))
    .filter(candidate => candidate.version && compareVersions(candidate.version, "1.96.0") >= 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  for (const candidate of candidates) {
    const pathname = path.join(cache, candidate.name, "code");
    if (executable(pathname)) return pathname;
  }
  throw new Error(`No executable VS Code installation compatible with ^1.96.0 found in ${cache}`);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export async function runElectronAcceptance({ runner = "electron-test-runner.cjs", environment = {}, workspace, vscodeExecutablePath = cachedVSCode() } = {}) {
  const { runTests } = require("@vscode/test-electron");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("A usable DISPLAY or WAYLAND_DISPLAY is required for the Linux Electron Extension Development Host");
  }

  const profileDirectory = path.join(hostDirectory, workspace ? `.e-${process.pid}` : `.electron-test-state-${process.pid}`);
  if (existsSync(profileDirectory)) {
    throw new Error(`Refusing to overwrite an existing test profile: ${profileDirectory}`);
  }
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  const previousCwd = process.cwd();
  const previousTemporary = process.env.TMPDIR;

  try {
    // Linux Unix-domain IPC paths have a 107-byte limit. /proc/self/cwd
    // keeps all files in this package without relocating them to /tmp.
    const shortProfile = workspace && process.platform === "linux"
      ? path.join("/proc/self/cwd", path.basename(profileDirectory))
      : profileDirectory;
    if (workspace) {
      process.chdir(hostDirectory);
      mkdirSync(path.join(profileDirectory, "t"), { mode: 0o700 });
      process.env.TMPDIR = path.join(shortProfile, "t");
      environment = { ...environment, TMPDIR: process.env.TMPDIR, TMP: process.env.TMPDIR, TEMP: process.env.TMPDIR };
    }
    if (workspace) {
      const settingsDirectory = path.join(profileDirectory, "u", "User");
      mkdirSync(settingsDirectory, { recursive: true });
      writeFileSync(path.join(settingsDirectory, "settings.json"), JSON.stringify({
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "workbench.enableExperiments": false,
        "workbench.startupEditor": "none",
        "security.workspace.trust.enabled": false,
        "http.proxy": "http://127.0.0.1:1",
        "http.proxySupport": "override",
      }));
    }
    console.log(`Using installed VS Code: ${vscodeExecutablePath}`);
    const launchArgs = [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${path.join(shortProfile, workspace ? "u" : "user-data")}`,
      `--extensions-dir=${path.join(shortProfile, workspace ? "x" : "extensions")}`,
      ...(workspace ? [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-telemetry", "--disable-updates"] : []),
      ...(workspace ? ["--password-store=basic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1"] : []),
    ];

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: hostDirectory,
      extensionTestsPath: path.join(hostDirectory, runner),
      launchArgs,
      extensionTestsEnv: environment,
    });
  } finally {
    process.chdir(previousCwd);
    if (previousTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporary;
    rmSync(profileDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runElectronAcceptance().catch(error => {
  console.error(`VS Code Electron acceptance failed: ${error.message}`);
  process.exitCode = 1;
});
