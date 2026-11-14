#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { Writable } = require("node:stream");

const project = path.resolve(__dirname, "..");
const preparedOnly = process.argv.includes("--prepare-only");
const installed = process.argv.includes("--installed-vsix");
const legacyArgument = process.argv.find(argument => argument.startsWith("--legacy-vsix="));
const legacyVsix = legacyArgument?.slice("--legacy-vsix=".length);
const inPlace = process.argv.includes("--in-place-experiment");
const focusedPackage = process.argv.includes("--focused-package");
const sameRoot = process.argv.includes("--require-same-root");
if (process.argv.slice(2).some(argument => !["--prepare-only", "--installed-vsix", "--in-place-experiment", "--focused-package", "--require-same-root", legacyArgument].includes(argument)) || (installed && preparedOnly)
    || (inPlace && !legacyVsix)
    || (focusedPackage && !inPlace)
    || (sameRoot && !inPlace)
    || (legacyArgument && (!installed || !path.isAbsolute(legacyVsix)))) {
  console.error("Usage: node scripts/run-next-trial-electron-test.js [--prepare-only|--installed-vsix [--legacy-vsix=/absolute/file.vsix [--in-place-experiment [--require-same-root] [--focused-package]]]]");
  process.exit(1);
}
if (installed && process.platform !== "linux") {
  console.error("FAIL: installed VSIX acceptance requires Linux private paths.");
  process.exit(1);
}
const cache = path.join(os.homedir(), ".cache", "pkm-vscode-test");
const vscode = process.env.PKM_VSCODE_EXECUTABLE || path.join(cache, "vscode-linux-x64-1.143.0", "code");
const vscodeCli = path.join(path.dirname(vscode), "bin", "code");
const bundledXvfb = path.join(cache, "tools/xvfb/usr/bin/Xvfb");
const executable = filename => { try { fs.accessSync(filename, fs.constants.X_OK); return true; } catch { return false; } };
const actionSnapshotFiles = [
  "package.json", "package-lock.json", "tsconfig.json", ".vscodeignore", "src/ui/action-browser.ts", "src/runtime/action-trust-authority.ts",
  "next-server/package.json", "next-server/package-lock.json", "next-server/tsconfig.json",
  "next-server/README.md", "next-server/src/cli.ts", "next-server/src/storage.ts",
  "next-server/src/workspace-backup.ts", "next-server/src/action-runtime.ts",
  "next-server/src/action-runtime-process.ts", "next-server/src/runtime-process.ts", "next-server/src/host-services.ts",
  "next-server/src/vscode-action-trust-bridge.ts", "next-server/src/trusted-action-host.ts",
  "next-server/src/legacy-note-mcp.ts", "next-server/src/legacy-action-mcp.ts",
  "src/ui/next-managed-trial.ts", "src/runtime/next-managed-client.ts", "src/runtime/memory-migration-authority.ts",
  "next-server/src/managed-client-child.ts", "next-server/src/managed-memory-reader.ts",
  "next-server/src/memory-scope-continuity.ts", "next-server/src/memory-readoption.ts", "next-server/src/memory-import.ts",
  "next-server/src/legacy-import.ts", "next-server/src/legacy-import-cli.ts", "next-server/src/managed-import-audit.ts",
  "next-server/src/managed-import-write.ts", "next-server/src/domain/memory-import-contracts.ts",
  "next-server/tests/trusted-action-cli.test.mjs", "next-server/tests/vscode-action-trust-bridge-e2e.test.mjs",
  "scripts/run-next-trial-private-display.js", "scripts/run-next-trial-electron-test.js",
  "scripts/package-extension.js", "scripts/next-rehearsal-runtime.js", "scripts/verify-vsix-package.js",
  "tests/test-next-upgrade-experiment.js",
  "tests/next-trial-electron/extension-test.cjs", "tests/next-trial-electron/actions-installed.cjs",
  "tests/next-trial-electron/skills-installed.cjs", "tests/next-trial-electron/memory-installed.cjs",
  "tests/next-trial-electron/legacy-upgrade.cjs", "tests/next-trial-electron/upgrade-activation.cjs",
  "tests/next-trial-electron/in-place-journey.cjs", "tests/next-trial-electron/in-place-server.cjs",
  "tests/next-trial-electron/in-place-options.cjs",
  "tests/next-trial-electron/chatroom-fixture.cjs",
  "tests/next-trial-electron/chatroom-live-fixture.cjs", "tests/next-trial-electron/chatroom-live-journey.cjs",
  "tests/next-trial-electron/api-chat-fixture.cjs",
  "next-server/src/legacy-chatroom-runtime.ts", "next-server/src/legacy-chatroom-host-authority.ts",
  "next-server/src/legacy-chatroom-host-ipc.ts", "next-server/src/legacy-chatroom-vscode-host.ts",
  "next-server/src/legacy-chatroom-private-copy.ts", "next-server/src/managed-client-host.ts",
  "next-server/src/standalone-host.ts", "next-server/tests/managed-client-import.test.mjs",
  "src/chatroom/next-room-host-bridge.ts", "src/chatroom/next-room-resume-store.ts",
  "tests/test-next-room-resume-store.js", "next-server/tests/legacy-chatroom-runtime.test.mjs",
  "next-server/tests/legacy-chatroom-host-ipc.test.mjs", "next-server/tests/legacy-chatroom-host-ipc-child.mjs",
  "next-server/tests/legacy-chatroom-remote.mjs",
  "tests/next-trial-electron/chatroom-secretstorage-journey.mjs",
  "tests/next-trial-electron/chatroom-secretstorage-extension.ts",
  "next-server/tests/legacy-api-chat-upgrade.test.mjs",
  "next-server/src/legacy-chatroom-continuation.ts", "next-server/tests/legacy-chatroom-continuation.test.mjs",
  "src/runtime/linux-root-writer-fence.ts", "resources/root_writer_fence.py",
  "resources/knowledge_mutations.py", "resources/action_modules.py",
  "src/knowledge/markdown-assets.ts", "src/mcp/mcp.ts",
  "next-server/src/linux-root-writer-fence.ts", "next-server/src/legacy-root-inert-state.ts",
  "next-server/src/domain/legacy-import.ts",
  "next-server/tests/linux-root-writer-fence.test.mjs", "next-server/tests/linux-root-writer-fence-child.mjs",
  "next-server/tests/linux-root-writer-python-child.py", "next-server/tests/legacy-root-adoption.test.mjs",
  "next-server/src/linux-legacy-writer-quiescence.ts", "next-server/tests/linux-legacy-writer-quiescence.test.mjs",
  "next-server/tests/linux-legacy-installed-writer-journey.mjs",
  "next-server/tests/linux-legacy-private-driver.mjs", "next-server/tests/linux-legacy-private-host.cjs",
  "next-server/src/sync-skills-only.ts", "next-server/tests/sync-skills-only.test.mjs",
  "next-server/src/legacy-github-sync-credentials.ts", "next-server/tests/legacy-github-sync-credentials.test.mjs",
  "next-server/tests/local-git-sync-provider.mjs", "next-server/tests/legacy-github-sync-local-journey.test.mjs",
  "next-server/tests/legacy-github-sync-publish-crash-child.mjs", "next-server/tests/legacy-github-sync-reconcile-child.mjs",
  "next-server/src/remote-runtime.ts", "next-server/src/legacy-github-sync-experimental-host.ts",
  "next-server/src/legacy-root-pkm-state.ts", "next-server/src/native-runtime.ts",
  "next-server/src/sync-plan.ts", "next-server/src/sync-plan-contracts.ts", "next-server/src/sync-apply.ts",
  "next-server/src/sync-transport.ts", "next-server/src/sync-transport-contracts.ts",
  "next-server/src/sync-transport-store.ts", "next-server/src/sync-transport-plan.ts",
  "next-server/src/domain/sync-transport-original.ts", "next-server/src/legacy-api-chat-archive.ts",
  "next-server/src/legacy-api-chat-runtime.ts", "next-server/src/legacy-api-chat-local-provider.ts",
  "next-server/tests/legacy-api-chat-archive.test.mjs", "next-server/tests/legacy-api-chat-runtime.test.mjs",
  "next-server/tests/legacy-api-chat-local-provider.test.mjs", "docs/guides/INSTALLATION.md",
  "next-server/tests/legacy-github-sync-experimental-host.test.mjs", "next-server/tests/legacy-github-sync-experimental-child.mjs",
  "tests/next-trial-electron/sync-installed.cjs", "tests/next-trial-electron/sync-installed-child.cjs",
  "tests/next-trial-electron/sync-secret-legacy.cjs", "tests/next-trial-electron/sync-normal-shim.cjs",
  ...(inPlace ? ["next-server/src/legacy-root-adoption.ts"] : []),
];
function actionSnapshot(directory) {
  return Object.fromEntries(actionSnapshotFiles.map(file => [file,
    createHash("sha256").update(fs.readFileSync(path.join(directory, file))).digest("hex")]));
}
function rootSnapshot(directory) {
  const entries = {};
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    const metadata = { mode: stat.mode, inode: stat.ino, mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) entries[relative] = { ...metadata, link: fs.readlinkSync(file) };
    else if (stat.isDirectory()) {
      entries[relative] = metadata;
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else {
      assert(stat.isFile(), `Unexpected fixture entry: ${file}`);
      entries[relative] = { ...metadata, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    }
  }
  visit(directory, ".");
  return entries;
}
function installedPayloadSnapshot(directory) {
  const entries = {};
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) entries[relative] = { link: fs.readlinkSync(file) };
    else if (stat.isDirectory()) {
      entries[relative] = { directory: true, mode: stat.mode };
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else {
      assert(stat.isFile(), `Unexpected installed payload entry: ${file}`);
      entries[relative] = { mode: stat.mode, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    }
  }
  visit(directory, ".");
  return entries;
}
async function runNormalSecretStage({ extension, action, workspace, user, extensions, env, scratch }) {
  const manifestPath = path.join(extension, "package.json");
  const shimPath = path.join(extension, "sync-normal-shim.cjs");
  const marker = path.join(scratch, `sync-normal-${action}.json`);
  const snapshot = installedPayloadSnapshot(extension);
  const original = fs.readFileSync(manifestPath);
  const socketPath = `/proc/${process.pid}/cwd/sync-secret.sock`;
  const socketFile = path.join(scratch, "sync-secret.sock");
  const nonce = randomUUID();
  let credential, server;
  assert(!fs.existsSync(shimPath) && !fs.existsSync(marker), "Normal-mode fixture must start clean");
  assert.equal(fs.realpathSync(user), fs.realpathSync(path.join(scratch, "u")), "Only the private profile cache may be invalidated");
  const invalidateUserExtensionCache = () => {
    const directory = path.join(user, "CachedProfilesData/__default__profile__");
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (/^extensions\.user(?:\.[a-z0-9-]+)?\.cache$/.test(name)) fs.rmSync(path.join(directory, name));
    }
  };
  try {
    if (action === "read") {
      assert(!fs.existsSync(socketFile), "Secret bridge must start clean");
      server = net.createServer(socket => {
        let input = "";
        socket.setTimeout(30000, () => socket.destroy());
        socket.on("error", () => {});
        socket.on("data", data => {
          input += data.toString("utf8");
          if (input.length > 8192) return socket.destroy();
          if (!input.endsWith("\n")) return;
          try {
            const message = JSON.parse(input);
            if (message.nonce !== nonce || typeof message.value !== "string" || credential !== undefined) return socket.destroy();
            credential = message.value;
            socket.end("ok\n");
          } catch { socket.destroy(); }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      fs.chmodSync(socketFile, 0o600);
    }
    const manifest = JSON.parse(original.toString("utf8"));
    manifest.main = "./sync-normal-shim.cjs";
    manifest.activationEvents = ["*"];
    fs.copyFileSync(path.join(project, "tests/next-trial-electron/sync-normal-shim.cjs"), shimPath, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    invalidateUserExtensionCache();
    const child = spawn(vscode, [workspace, `--user-data-dir=${user}`, `--extensions-dir=${extensions}`,
      "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates",
      "--skip-welcome", "--skip-release-notes", "--password-store=basic", "--wait",
      "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1"], {
      env: { ...process.env, ...env, TMPDIR: path.join(scratch, "t"), TMP: path.join(scratch, "t"), TEMP: path.join(scratch, "t"),
        PKM_SYNC_NORMAL_ACTION: action, PKM_SYNC_NORMAL_MARKER: marker,
        PKM_SYNC_PROFILE_STORAGE: path.join(scratch, "u/User/globalStorage/uone.personal-knowledge"),
        ...(action === "read" ? { PKM_SYNC_SECRET_SOCKET: socketPath, PKM_SYNC_SECRET_NONCE: nonce } : {}) },
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Normal-mode ${action} process exited: ${code ?? signal}`));
      });
    });
    const result = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(result.passed, true, `Normal-mode ${action} fixture failed: ${result.error ?? "unknown error"}`);
    assert.equal(result.extensionId, "uone.personal-knowledge");
    assert.equal(result.storage, fs.realpathSync(path.join(scratch, "u/User/globalStorage/uone.personal-knowledge")));
    if (action === "read") assert.equal(typeof credential, "string", "Secret bridge did not receive credential");
  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(socketFile, { force: true });
    }
    fs.writeFileSync(manifestPath, original);
    fs.rmSync(shimPath, { force: true });
    invalidateUserExtensionCache();
    assert.deepEqual(installedPayloadSnapshot(extension), snapshot, "Installed payload was not restored after private shim.");
  }
  console.log(`PASS: normal VS Code private profile SecretStorage ${action} stage; temporary installed-extension shim restored.`);
  return credential;
}
if (installed && !executable(vscodeCli)) {
  console.error("FAIL: installed VSIX acceptance requires the existing VS Code bin/code CLI beside the executable.");
  process.exit(1);
}
if (!preparedOnly && (!path.isAbsolute(vscode) || !executable(vscode))) {
  console.error("FAIL: cached VS Code unavailable; set PKM_VSCODE_EXECUTABLE to an existing absolute executable. No download is performed.");
  process.exit(1);
}
if (!preparedOnly && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  const xvfbRun = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  console.error(`FAIL: no DISPLAY or WAYLAND_DISPLAY; xvfb-run ${xvfbRun.status === 0 ? "available" : "unavailable"}, cached Xvfb ${executable(bundledXvfb) ? "available" : "unavailable"}.`);
  console.error("Provide an already-running isolated display. This runner does not start xvfb-run or create X11 sockets/locks under forbidden temporary paths.");
  process.exit(1);
}

async function main() {
  const scratch = path.join(project, ".migration-test-work", `trial-electron-${randomUUID()}`);
  let extension = path.join(scratch, "extension");
  const legacy = path.join(scratch, "legacy");
  const user = path.join(scratch, "u"), home = path.join(scratch, "h");
  const workspace = path.join(scratch, "editor"), trial = path.join(scratch, "trial");
  const temp = path.join(scratch, "t"), extensions = path.join(scratch, "x");
  const saved = { ...process.env };
  const previousCwd = process.cwd();
  let staged = false;
  let servicesStopped = false;
  let passed = false;
  let interrupted = false;
  let actionSourceSnapshot;
  const onInterrupt = () => { interrupted = true; };
  process.on("SIGINT", onInterrupt);
  try {
    for (const dir of [extension, legacy, user, home, workspace, trial, temp, extensions]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      PATH: saved.PATH || "", HOME: home, USERPROFILE: home,
      TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
      ...(saved.DISPLAY ? { DISPLAY: saved.DISPLAY } : {}),
      ...(saved.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: saved.WAYLAND_DISPLAY } : {}),
      ...(saved.XAUTHORITY ? { XAUTHORITY: saved.XAUTHORITY } : {}),
    });
    if (!inPlace) fs.writeFileSync(path.join(legacy, "fixture-sentinel.txt"), "untouched", { flag: "wx" });
    fs.mkdirSync(path.join(legacy, "notes"));
    if (inPlace) fs.writeFileSync(path.join(legacy, "notes/Sentinel.md"), "---\ntitle: Sentinel\n---\nuntouched\n", { flag: "wx" });
    fs.writeFileSync(path.join(legacy, "notes/Existing.md"),
      `---\ntitle: ${inPlace ? "Existing" : "Existing synthetic root"}\ndocumentId: existing-fixture\nrevision: 1\n---\nDo not change this legacy fixture.\n`, { flag: "wx" });
    if (installed) require(path.join(project, "tests/next-trial-electron/skills-installed.cjs")).prepareRoot(legacy);
    const settings = path.join(user, "User");
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(settings, "settings.json"), JSON.stringify({
      "personalKnowledge.storePath": legacy,
      "personalKnowledge.openOnStartup": false,
      "personalKnowledge.mcpPythonPath": path.join(scratch, "no-python"),
      "security.workspace.trust.enabled": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "http.proxy": "http://127.0.0.1:1",
      "http.proxySupport": "override",
    }));
    let testExtension = extension;
    if (installed) {
      actionSourceSnapshot = actionSnapshot(project);
      const build = path.join(scratch, "build");
      fs.mkdirSync(build);
      const translations = fs.readdirSync(project).filter(name => /^package\.nls(?:\.[^.]+)?\.json$/.test(name));
      for (const name of ["package.json", "package-lock.json", "tsconfig.json", ".vscodeignore", "README.md", "CHANGELOG.md", "LICENSE", "FEATURES.md",
        ...translations, "src", "scripts", "resources", "modules", "tools", "tests", "next-server", "docs"]) {
        const source = path.join(project, name);
        if (!fs.existsSync(source)) continue;
        fs.cpSync(source, path.join(build, name), { recursive: true, verbatimSymlinks: true,
          filter: file => path.basename(file) !== "node_modules" && path.basename(file) !== "dist" && path.basename(file) !== "__pycache__" });
      }
      assert.deepEqual(actionSnapshot(build), actionSourceSnapshot, "Isolated production build source snapshot differs from the selected source.");
      fs.symlinkSync(path.join(project, "node_modules"), path.join(build, "node_modules"), "dir");
      fs.symlinkSync(path.join(project, "next-server/node_modules"), path.join(build, "next-server/node_modules"), "dir");
      process.chdir(scratch);
      const shortScratch = process.platform === "linux" ? `/proc/${process.pid}/cwd` : scratch;
      const shortBuildTemp = path.join(shortScratch, "t");
      const buildEnv = { ...process.env, TMPDIR: shortBuildTemp, TMP: shortBuildTemp, TEMP: shortBuildTemp,
        HOME: path.join(shortScratch, "h"), USERPROFILE: path.join(shortScratch, "h") };
      execFileSync("npm", ["run", "build"], { cwd: build, env: buildEnv, stdio: "inherit", timeout: 180000 });
      const vsix = path.join(build, `personal-knowledge-${require("../package.json").version}.vsix`);
      if (focusedPackage) {
        console.log("Focused experimental packaging: full release/package service gate is NOT run.");
        require(path.join(build, "scripts/next-rehearsal-runtime.js")).stage(path.join(build, "next-runtime"), { production: true });
        execFileSync("npx", ["--no-install", "vsce", "package", "--out", vsix], {
          cwd: build, env: { ...buildEnv, PKM_PACKAGE_PREBUILT: "1", PKM_PACKAGE_NEXT_PAYLOAD_STAGED: "1" },
          stdio: "inherit", timeout: 180000,
        });
        execFileSync("python3", ["-B", "scripts/verify-next-payload.py", vsix], {
          cwd: build, env: buildEnv, stdio: "inherit", timeout: 60000,
        });
      } else {
        execFileSync(process.execPath, ["scripts/package-extension.js", "--prebuilt"], { cwd: build, env: buildEnv, stdio: "inherit", timeout: 240000 });
      }
      process.chdir(scratch);
      const cliEnv = { ...process.env, HOME: path.join(shortScratch, "h"), USERPROFILE: path.join(shortScratch, "h"),
        TMPDIR: shortBuildTemp, TMP: shortBuildTemp, TEMP: shortBuildTemp,
        HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1" };
      const cliArgs = ["--no-sandbox", `--user-data-dir=${shortScratch}/u`, `--extensions-dir=${shortScratch}/x`];
      if (legacyVsix) {
        execFileSync(vscodeCli, [...cliArgs, "--install-extension", legacyVsix, "--force"], { env: cliEnv, stdio: "inherit", timeout: 120000 });
        const oldNames = fs.readdirSync(extensions).filter(name => /^uone\.personal-knowledge-/i.test(name));
        assert.equal(oldNames.length, 1, "Expected exactly one installed legacy extension.");
        const oldExtension = path.join(extensions, oldNames[0]);
        const oldManifest = require(path.join(oldExtension, "package.json"));
        assert.equal(`${oldManifest.publisher}.${oldManifest.name}`.toLowerCase(), "uone.personal-knowledge");
        const parseVersion = version => {
          assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected a VSIX semantic version.");
          return version.split("-", 1)[0].split(".").map(Number);
        };
        const oldVersion = parseVersion(oldManifest.version), nextVersion = parseVersion(require("../package.json").version);
        const firstDifference = oldVersion.findIndex((part, index) => part !== nextVersion[index]);
        assert(firstDifference >= 0 && oldVersion[firstDifference] < nextVersion[firstDifference],
          "Legacy VSIX must be an earlier version.");
        const oldDriver = path.join(scratch, "old-driver");
        fs.mkdirSync(oldDriver);
        fs.writeFileSync(path.join(oldDriver, "package.json"), JSON.stringify({
          name: "pkm-legacy-upgrade-driver", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.90.0" },
        }));
        fs.copyFileSync(path.join(project, "tests/next-trial-electron/legacy-upgrade.cjs"), path.join(oldExtension, "legacy-upgrade.cjs"));
        if (inPlace) fs.copyFileSync(path.join(project, "tests/next-trial-electron/sync-secret-legacy.cjs"), path.join(oldExtension, "sync-secret-legacy.cjs"));
        if (inPlace) fs.copyFileSync(path.join(project, "tests/next-trial-electron/chatroom-fixture.cjs"), path.join(oldExtension, "chatroom-fixture.cjs"));
        if (inPlace) fs.copyFileSync(path.join(project, "tests/next-trial-electron/chatroom-live-fixture.cjs"), path.join(oldExtension, "chatroom-live-fixture.cjs"));
        const { runTests } = require("@vscode/test-electron");
        await runTests({
          vscodeExecutablePath: vscode, extensionDevelopmentPath: oldDriver,
          extensionTestsPath: path.join(oldExtension, inPlace ? "sync-secret-legacy.cjs" : "legacy-upgrade.cjs"),
          extensionTestsEnv: { PKM_UPGRADE_ROOT: legacy, PKM_UPGRADE_EXTENSION: oldExtension,
            ...(inPlace ? { PKM_UPGRADE_SENTINEL: path.join(legacy, "notes/Sentinel.md"), PKM_UPGRADE_CHATROOM_FIXTURE: "1" } : {}) },
          launchArgs: [workspace, ...cliArgs.slice(1), "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
            "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic",
            "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1"],
        });
        console.log(`PASS: installed legacy ${oldManifest.version} activated against the synthetic root in the private profile.`);
        if (inPlace) {
          require(path.join(project, "tests/next-trial-electron/sync-installed.cjs")).prepare({
            fixture: scratch, root: legacy, globalStorage: path.join(user, "User/globalStorage/uone.personal-knowledge"),
          });
          await runNormalSecretStage({ extension: oldExtension, action: "store", workspace, user: `${shortScratch}/u`,
            extensions: `${shortScratch}/x`, env: cliEnv, scratch });
        }
      }
      execFileSync(vscodeCli, [...cliArgs, "--install-extension", vsix, "--force"], { env: cliEnv, stdio: "inherit", timeout: 120000 });
      const currentVersion = require("../package.json").version.toLowerCase();
      const installedNames = fs.readdirSync(extensions).filter(name =>
        name.toLowerCase() === `uone.personal-knowledge-${currentVersion}`);
      if (installedNames.length !== 1) throw new Error(`Expected the current production extension: ${installedNames}`);
      extension = path.join(extensions, installedNames[0]);
      testExtension = path.join(scratch, "test-driver");
      fs.mkdirSync(testExtension);
      fs.writeFileSync(path.join(testExtension, "package.json"), JSON.stringify({
        name: "pkm-install-test-driver", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.90.0" },
      }));
      // The test module must resolve the installed extension's own VS Code API
      // object; the separate development extension only enables test mode.
      fs.copyFileSync(path.join(project, `tests/next-trial-electron/${inPlace ? "upgrade-activation" : "extension-test"}.cjs`), path.join(extension, "trial-electron-test.cjs"));
      fs.copyFileSync(path.join(project, "tests/next-trial-electron/actions-installed.cjs"), path.join(extension, "trial-action-test.cjs"));
      fs.copyFileSync(path.join(project, "tests/next-trial-electron/skills-installed.cjs"), path.join(extension, "trial-skills-test.cjs"));
      fs.copyFileSync(path.join(project, "tests/next-trial-electron/memory-installed.cjs"), path.join(extension, "trial-memory-test.cjs"));
    } else {
    fs.copyFileSync(path.join(project, "package.json"), path.join(extension, "package.json"));
    fs.copyFileSync(path.join(project, "tests/next-trial-electron/extension-test.cjs"), path.join(extension, "trial-electron-test.cjs"));
    for (const name of ["package.nls.json", "package.nls.zh-cn.json"]) {
      if (fs.existsSync(path.join(project, name))) fs.copyFileSync(path.join(project, name), path.join(extension, name));
    }
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project,
      "--outDir", path.join(extension, "dist"), "--sourceMap", "false"], { cwd: project, stdio: "inherit" });
    const esbuild = require("esbuild");
    for (const entry of ["runtime/pkm-service-entry", "subscriptions/subscription-mqtt-client"]) {
      esbuild.buildSync({
        entryPoints: [path.join(project, "src", `${entry}.ts`)], bundle: true, platform: "node", format: "cjs",
        ...(entry.includes("mqtt") ? { define: { navigator: "undefined" } } : {}),
        outfile: path.join(extension, "dist", `${entry}.js`),
      });
    }
    fs.cpSync(path.join(project, "resources"), path.join(extension, "resources"), { recursive: true, verbatimSymlinks: true });
    fs.cpSync(path.join(project, "src/webview"), path.join(extension, "dist/webview"), { recursive: true });
    fs.cpSync(path.join(project, "node_modules"), path.join(extension, "node_modules"), {
      recursive: true, verbatimSymlinks: true, filter: source => path.basename(source) !== ".bin",
    });
    require("./next-rehearsal-runtime").stage(path.join(extension, "next-runtime"), { production: true });
    }
    const verifier = require(path.join(extension, "dist/runtime/next-payload-verifier.js"));
    verifier.verifyNextPayload(extension);
    if (legacyVsix) {
      const before = rootSnapshot(legacy);
      const cli = path.join(extension, "next-runtime/server/dist/cli.js");
      const inspection = JSON.parse(execFileSync(process.execPath, [cli, "inspect-legacy-root", "--root", legacy], {
        cwd: scratch, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 60000,
      })).inspection;
      assert.equal(inspection.schema, "pkm.legacy-root-adoption-inspection/v1");
      assert.equal(inspection.sourceRoot, fs.realpathSync(legacy));
      const stat = fs.statSync(legacy, { bigint: true });
      assert.deepEqual(inspection.rootIdentity, { device: String(stat.dev), inode: String(stat.ino) });
      assert.equal(inspection.ready, false, "Inspection must never authorize in-place cutover");
      for (const code of ["direct-adoption-unqualified", "writer-isolation-unverified",
        "complete-workflow-parity-unverified", "recovery-and-rollback-unqualified"])
        assert(inspection.blockers.some(blocker => blocker.code === code), `Missing adoption blocker ${code}`);
      assert.deepEqual(rootSnapshot(legacy), before, "Read-only inspection changed the synthetic legacy root.");
      console.log("PASS: verified installed payload inspected the configured synthetic legacy root read-only; qualification blockers still prohibit production cutover.");
    }
    staged = true;
    if (interrupted) throw new Error("Electron test interrupted during staging.");
    if (preparedOnly) { console.log("PASS: isolated extension and bundled payload staged; Electron was not run."); return; }
    // Keep Unix socket paths short while all filesystem targets remain in scratch.
    const short = process.platform === "linux" ? (installed ? `/proc/${process.pid}/cwd` : "/proc/self/cwd") : scratch;
    const shortTemp = process.platform === "linux" ? "/proc/self/cwd/t" : path.join(short, "t");
    const gitConfig = path.join(scratch, "fixture-gitconfig");
    if (installed) fs.writeFileSync(gitConfig,
      `[url ${JSON.stringify(path.join(scratch, "skills-installed", "mount-remote.git"))}]\n` +
      `\tinsteadOf = https://github.com/pkm-installed-fixture/skills.git\n`);
    const env = {
      HOME: process.platform === "linux" ? `/proc/${process.pid}/cwd/h` : home,
      USERPROFILE: process.platform === "linux" ? `/proc/${process.pid}/cwd/h` : home, XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_RUNTIME_DIR: path.join(short, "h/run"), TMPDIR: shortTemp, TMP: shortTemp, TEMP: shortTemp,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1",
      PKM_TRIAL_ELECTRON_ROOT: scratch, PKM_TRIAL_ELECTRON_DIRECTORY: trial,
      PKM_TRIAL_ELECTRON_NODE: fs.realpathSync(process.execPath),
      PKM_TRIAL_ELECTRON_PYTHON: fs.realpathSync(execFileSync("python3",
        ["-I", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim()),
      PKM_TRIAL_ELECTRON_EXTENSION: extension, PKM_TRIAL_ELECTRON_LEGACY: legacy,
      ...(inPlace ? { PKM_UPGRADE_SENTINEL: path.join(legacy, "notes/Sentinel.md") } : {}),
      PKM_TRIAL_ACTIONS_INSTALLED: installed ? "1" : "0",
      ...(installed ? { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" } : {}),
    };
    fs.mkdirSync(path.join(home, "run"), { mode: 0o700 });
    process.chdir(scratch);
    Object.assign(process.env, env);
    const { runTests } = require("@vscode/test-electron");
    let unexpectedSigpipe = false;
    const monitor = destination => {
      let tail = "";
      return new Writable({ write(chunk, encoding, callback) {
        const text = tail + chunk.toString();
        if (text.includes("Unexpected SIGPIPE")) unexpectedSigpipe = true;
        tail = text.slice(-64);
        destination.write(chunk, callback);
      } });
    };
    await runTests({
      vscodeExecutablePath: vscode, extensionDevelopmentPath: testExtension,
      extensionTestsPath: path.join(installed ? extension : testExtension, "trial-electron-test.cjs"),
      extensionTestsEnv: env,
      stdout: monitor(process.stdout), stderr: monitor(process.stderr),
      launchArgs: [workspace, `--user-data-dir=${path.join(short, "u")}`, `--extensions-dir=${path.join(short, "x")}`,
        ...(installed ? [] : ["--disable-extensions"]), "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
        "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic",
        "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1"],
    });
    if (unexpectedSigpipe) throw new Error("Unexpected SIGPIPE observed in Electron output; IPC/drain acceptance is not satisfied.");
    if (interrupted) throw new Error("Electron test interrupted.");
    const result = JSON.parse(fs.readFileSync(path.join(scratch, "passed.json"), "utf8"));
    if (result.passed !== true) throw new Error("Extension test did not confirm the real child lifecycle.");
    if (inPlace) {
      assert.equal(result.upgradeActivationPassed, true);
    } else {
    if (result.importPassed !== true) throw new Error("Extension test did not confirm the real import journey.");
    if (result.writePassed !== true) throw new Error("Extension test did not confirm the isolated write/restart journey.");
    if (result.resourcesPassed !== true) throw new Error("Extension test did not confirm safe imported resource preview.");
    if (result.boardsPassed !== true) throw new Error("Extension test did not confirm read-only migrated Boards.");
    if (result.structuredPassed !== true) throw new Error("Extension test did not confirm structured Research/Skills read models.");
    if (result.recipesPassed !== true) throw new Error("Extension test did not confirm read-only ProjectStore Recipe migration.");
    if (result.libraryPassed !== true) throw new Error("Extension test did not confirm read-only Prompt/Script bytes, original projections and restart.");
    if (result.nativeEditorPassed !== true) throw new Error("Extension test did not confirm native isolated Notes/Skills/Research editing and CAS.");
    if (result.codeArchivePassed !== true) throw new Error("Extension test did not confirm protected inert code archive inspection.");
    if (result.actionStateArchivePassed !== true) throw new Error("Extension test did not confirm archive_only Action history inspection without inherited authority.");
    if (installed && result.actionInstalledPassed !== true) throw new Error("Installed extension did not confirm the real trusted Action MCP lifecycle.");
    if (installed && result.skillsInstalledPassed !== true) throw new Error("Installed extension did not confirm the Skills-only indexing journey.");
    if (installed && result.memoryInstalledPassed !== true) throw new Error("Installed extension did not confirm the Memory adoption and non-inheritance journey.");
    }
    if (installed) {
      assert.deepEqual(actionSnapshot(project), actionSourceSnapshot, "Experiment source changed during installed VSIX acceptance.");
      const digest = createHash("sha256").update(JSON.stringify(actionSourceSnapshot)).digest("hex");
      console.log(`Installed experiment source snapshot SHA256: ${digest}`);
      console.log(`Installed experiment source files: ${JSON.stringify(actionSourceSnapshot)}`);
      const { stopFixtureServices } = require("./stop-fixture-services");
      await stopFixtureServices({ fixtureRoot: scratch, extensionRoot: extension,
        storage: path.join(user, "User/globalStorage/uone.personal-knowledge"), knowledge: legacy,
        home: `/proc/${process.pid}/cwd/h` });
      servicesStopped = true;
      if (inPlace) {
        console.log(`Synthetic old-root metadata inventory: ${JSON.stringify(rootSnapshot(path.join(legacy, ".pkm")))}`);
        const { pathToFileURL } = require("node:url");
        const importer = await import(pathToFileURL(path.join(extension, "next-runtime/server/dist/legacy-import.js")).href);
        console.log(`Synthetic old-root import blockers: ${JSON.stringify((await importer.planLegacyImport(legacy)).blockers)}`);
        const adoption = await import(pathToFileURL(path.join(extension, "next-runtime/server/dist/legacy-root-adoption.js")).href);
        const runInPlace = target => require("../tests/next-trial-electron/in-place-journey.cjs").run({
          fixture: scratch, root: target, extension, node: fs.realpathSync(process.execPath),
          requireChat: target === legacy,
          adopt: async (root, nonce) => {
            assert(servicesStopped, "Only quiescent synthetic fixture writers are admitted");
            const originalEntries = rootSnapshot(root);
            for (const name of ["in-place-server.cjs", "in-place-options.cjs"])
              fs.copyFileSync(path.join(project, "tests/next-trial-electron", name), path.join(extension, name));
            const child = spawnSync(process.execPath, [path.join(extension, "in-place-server.cjs"),
              scratch, root, path.join(extension, "next-runtime/server"), nonce, "--interrupt-after-prepare"], {
              cwd: scratch, env: { ...process.env, PKM_IN_PLACE_PRIVATE_FIXTURE: nonce },
              encoding: "utf8", timeout: 60000,
            });
            if (child.status !== 75) {
              const details = child.stderr.split("\n").map(line => {
                try { return JSON.parse(line).error; } catch { return undefined; }
              }).find(Boolean);
              throw Object.assign(new Error(details?.message ?? child.stderr ?? child.error?.message), { code: details?.code });
            }
            const prepared = JSON.parse(child.stdout.trim()).prepared;
            assert.equal(prepared.sourceRoot, root);
            const { Storage } = await import(pathToFileURL(path.join(extension, "next-runtime/server/dist/storage.js")).href);
            await assert.rejects(Storage.open(root), error => error.code === "RECOVERY_REQUIRED",
              "Ordinary startup must reject interrupted adoption rather than silently initialize it");
            const options = require("../tests/next-trial-electron/in-place-options.cjs").options({
              fixture: scratch, root, nonce, workspaceId: prepared.workspaceId,
            });
            const result = await adoption.resumeLegacyRootAdoptionExperimental(root, options);
            try {
              assert.equal(result.recoveredPendingPlan, true, "Resume did not recover the interrupted original adoption");
              assert.equal(result.workspaceId, prepared.workspaceId);
              assert.equal(result.sourceFingerprint, prepared.sourceFingerprint);
              assert.equal(result.qualification, "experimental-unqualified");
              assert.equal(result.state, "committed");
              const { acquireLinuxRootWriterFence } = await import(pathToFileURL(path.join(extension,
                "next-runtime/server/dist/linux-root-writer-fence.js")).href);
              await assert.rejects(acquireLinuxRootWriterFence(root, 50), error => error.code === "BUSY",
                "The installed adopter must hold its actual Linux cross-process exclusive fence for Storage lifetime");
              const after = rootSnapshot(root);
              for (const [name, original] of Object.entries(originalEntries)) {
                assert(after[name], `Original legacy entry disappeared: ${name}`);
                if (Object.hasOwn(original, "sha256") || Object.hasOwn(original, "link"))
                  assert.deepEqual(after[name], original, `Adoption changed original legacy bytes or file identity: ${name}`);
                else {
                  assert.equal(after[name].inode, original.inode, `Adoption replaced an original directory: ${name}`);
                  assert.equal(after[name].mode, original.mode, `Adoption changed original directory permissions: ${name}`);
                }
              }
              console.log(`PASS: interrupted preparation refused ordinary startup and resumed the same journal; qualification: ${result.qualification}`);
            } finally { await result.storage.close(); }
          },
        });
        const unchanged = rootSnapshot(legacy);
        try {
          const outcome = await runInPlace(legacy);
          assert.deepEqual(outcome, { root: legacy, read: true, write: true, restarted: true,
            chat: { history: true, continued: true, restarted: true, recoveredWithoutReplay: true, sourceUnchanged: true,
              room: { sameRoot: true, multiParticipant: true, reopened: true, actualClients: true, attachmentBytes: true,
                crashRecoveredWithoutDuplicateEffect: true, originalArchiveUnchanged: true,
                missingHistoricalPayload: "unrecoverable-never-persisted",
                apiChat: { inlineImagesReadable: true, segmentedHistoryReadable: true, legacyHttpContinuation: true,
                  takeover: "EXPERIMENTAL_SAME_ROOT", nativeHttpContinuation: true, restarted: true,
                  crashRecoveredWithoutDuplicateEffect: true, unknownProviderOutcome: "BLOCKED_NO_REISSUE",
                  originalSourceUnchanged: true } } } });
          const after = rootSnapshot(legacy);
          for (const [name, original] of Object.entries(unchanged)) {
            if (name !== "notes/Existing.md" && (Object.hasOwn(original, "sha256") || Object.hasOwn(original, "link")))
              assert.deepEqual(after[name], original, `Same-root lifecycle changed unrelated legacy content: ${name}`);
          }
          const providerRoot = path.join(scratch, "sync-provider");
          fs.mkdirSync(path.join(providerRoot, "tests"), { recursive: true, mode: 0o700 });
          fs.symlinkSync(path.join(extension, "next-runtime/server/dist"), path.join(providerRoot, "dist"), "dir");
          fs.copyFileSync(path.join(project, "next-server/tests/local-git-sync-provider.mjs"),
            path.join(providerRoot, "tests/local-git-sync-provider.mjs"));
          for (const name of ["sync-installed.cjs", "sync-installed-child.cjs"])
            fs.copyFileSync(path.join(project, "tests/next-trial-electron", name), path.join(extension, name));
          const credential = await runNormalSecretStage({ extension, action: "read", workspace, user: `${short}/u`,
            extensions: `${short}/x`, env, scratch });
          await require(path.join(project, "tests/next-trial-electron/sync-installed.cjs")).runWithCredential({
            extensionPath: extension, globalStorage: path.join(user, "User/globalStorage/uone.personal-knowledge"),
            readSecret: async key => {
              assert.equal(key, "personalKnowledge.githubSync.vscode.fixture-target");
              return credential;
            },
          });
          assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch, "sync-installed-passed.json"), "utf8")),
            { passed: true, push: true, pull: true, recovery: true, conflict: true, secretStorage: true, nonSkillsUnchanged: true });
        }
        catch (error) {
          assert(["IMPORT_BLOCKED", "LEGACY_PKM_AUTHORITY_REQUIRED"].includes(error?.code),
            `Unexpected failure is not an accepted legacy-metadata safety refusal: ${String(error)}`);
          assert.deepEqual(rootSnapshot(legacy), unchanged, "Rejected original-root adoption modified its data");
          console.log(`BLOCKED: installed old-root in-place adoption preserved the complete tree: ${String(error)}`);
          if (sameRoot) throw error;
          const minimal = path.join(scratch, "minimal-in-place-root");
          fs.mkdirSync(path.join(minimal, "notes"), { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(minimal, "notes/Existing.md"),
            "---\ntitle: Existing\nrevision: 1\n---\nDo not change this legacy fixture.\n", { mode: 0o600 });
          console.log("Running separate notes-only synthetic in-place lifecycle; this is NOT the installed legacy root.");
          const outcome = await runInPlace(minimal);
          assert.deepEqual(outcome, { root: minimal, read: true, write: true, restarted: true });
        }
      }
      assert.deepEqual(actionSnapshot(project), actionSourceSnapshot, "Experiment source changed during the same-root MCP lifecycle.");
      const cliArgs = ["--no-sandbox", `--user-data-dir=${short}/u`, `--extensions-dir=${short}/x`];
      execFileSync(vscodeCli, [...cliArgs, "--uninstall-extension", "Uone.personal-knowledge"], { env: process.env, stdio: "inherit", timeout: 120000 });
      const list = execFileSync(vscodeCli, [...cliArgs, "--list-extensions"], { env: process.env, encoding: "utf8", timeout: 120000 });
      if (list.split(/\r?\n/).some(line => line.toLowerCase() === "uone.personal-knowledge"))
        throw new Error("Production extension remains installed after uninstall.");
      console.log("PASS: verified production VSIX installed into and uninstalled from the private profile.");
    }
    passed = true;
    console.log(inPlace
      ? "PASS: bounded installed-upgrade activation, explicit experimental lifecycle, safety refusal and drain; not complete legacy migration."
      : "PASS: real Extension Host native Notes/Skills/Research editing, readonly libraries/Recipes/Boards, isolated authorization, conflicts, restart, refusal and drain.");
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    if (staged && !preparedOnly && !servicesStopped) {
      const { stopFixtureServices } = require("./stop-fixture-services");
      try {
        await stopFixtureServices({ fixtureRoot: scratch, extensionRoot: extension,
          storage: path.join(user, "User/globalStorage/uone.personal-knowledge"), knowledge: legacy,
          home: process.platform === "linux" ? `/proc/${process.pid}/cwd/h` : home });
      } catch (error) {
        console.error(`Fixture service cleanup failed; preserving ${scratch}: ${error.message}`);
        process.chdir(previousCwd);
        Object.keys(process.env).forEach(key => { if (!(key in saved)) delete process.env[key]; });
        Object.assign(process.env, saved);
        throw error;
      }
    }
    process.chdir(previousCwd);
    Object.keys(process.env).forEach(key => { if (!(key in saved)) delete process.env[key]; });
    Object.assign(process.env, saved);
    if (!passed && !preparedOnly) console.error(`Failed Electron fixture retained for diagnosis: ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error("FAIL: Next trial Electron acceptance:", error); process.exitCode = 1; });
