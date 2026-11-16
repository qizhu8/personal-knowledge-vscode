import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, cp, readdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { packageHost, validateHostPayload } from "./package-host.mjs";
import { cachedVSCode } from "./electron-test.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed: ${result.status}`);
};

async function main() {
  if (process.platform !== "linux") throw new Error("Installed-host acceptance currently requires Linux private network/display support.");
  if (process.argv[2] !== "--inside") {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) {
      const option = process.argv[index];
      if (option === "--side-by-side" && !options[option]) {
        options[option] = true; continue;
      }
      if (["--coordinator", "--coordinator-preflight"].includes(option) && !options[option]) {
        if (options["--coordinator"] || options["--coordinator-preflight"])
          throw new Error("Choose either positive --coordinator or safety-only --coordinator-preflight.");
        options[option] = true; continue;
      }
      if (!["--vsix", "--evidence"].includes(option) || !process.argv[index + 1] || options[option])
        throw new Error("Usage: node installed-test.mjs [--vsix EXISTING_HOST.vsix] [--evidence REPORT.json] [--side-by-side | --coordinator | --coordinator-preflight]");
      options[option] = resolve(process.argv[++index]);
    }
    if (options["--side-by-side"] && (options["--coordinator"] || options["--coordinator-preflight"]))
      throw new Error("Side-by-side provider verification requires the default-disabled coordinator.");
    const editor = cachedVSCode();
    const xvfb = process.env.PKM_TRIAL_XVFB || join(homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const vsce = process.env.PKM_VSCE_EXECUTABLE || execFileSync("which", ["vsce"], { encoding: "utf8" }).trim();
    const python = execFileSync("python3", ["-c", "import sys, playwright; print(sys.executable)"], { encoding: "utf8" }).trim();
    run("unshare", ["-Urn", process.execPath, fileURLToPath(import.meta.url), "--inside", editor, xvfb, vsce, python,
      options["--vsix"] || "", options["--evidence"] || "",
      options["--coordinator-preflight"] ? "preflight-safety" : options["--coordinator"] ? "positive" : "",
      options["--side-by-side"] ? "side-by-side" : ""], {
      env: { PATH: process.env.PATH || "" },
      timeout: options["--side-by-side"] ? 600000 : 300000,
    });
    return;
  }
  const [editor, xvfb, vsce, python, existingVsix, evidencePath, coordinatorMode, identityMode] = process.argv.slice(3);
  const root = resolve(here, `.installed-host-${randomUUID()}`);
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  await mkdir(root, { mode: 0o700 });
  let display, ui, app, evidence, passed = false;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); });
  };
  try {
    for (const dir of ["h", "t", "t/runtime", "u/User", "x", "editor", "driver", "data/source/notes",
      ...(coordinatorMode ? ["coordinator/notes", "coordinator/.pkm"] : [])])
      await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
    process.chdir(root);
    const short = `/proc/${process.pid}/cwd`;
    const env = {
      PATH: originalEnv.PATH || "", HOME: `${short}/h`, USERPROFILE: `${short}/h`,
      TMPDIR: "/proc/self/cwd/t", TMP: "/proc/self/cwd/t", TEMP: "/proc/self/cwd/t",
      XDG_CONFIG_HOME: `${short}/h/config`, XDG_DATA_HOME: `${short}/h/data`, XDG_CACHE_HOME: `${short}/h/cache`,
      XDG_RUNTIME_DIR: `${short}/t/runtime`,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1", PKM_VSCE_EXECUTABLE: vsce,
      DISPLAY: "127.0.0.1:92", XAUTHORITY: join(root, "Xauthority"),
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    run("ip", ["link", "set", "lo", "up"], { env });
    await writeFile(env.XAUTHORITY, "", { mode: 0o600 });
    run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomUUID().replaceAll("-", "")], { env });
    display = spawn(xvfb, [":92", "-screen", "0", "1280x900x24", "-nolock", "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY], { env, stdio: "ignore" });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0) { ready = true; break; }
      if (display.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Private Xvfb unavailable; no installed-host acceptance performed.");
    const vsix = existingVsix || join(root, "host.vsix");
    if (!existingVsix) await packageHost(vsix, { env });
    const vsixSha256 = createHash("sha256").update(await readFile(vsix)).digest("hex");
    const manifest = JSON.parse(execFileSync("unzip", ["-p", vsix, "extension/package.json"],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }));
    assert.equal(`${manifest.publisher}.${manifest.name}`, "pkm-nonproduction.pkm-v5",
      "Only the explicitly isolated nonproduction host artifact may be installed");
    assert.equal(manifest.main, "./dist/extension.cjs");
    const cli = join(dirname(editor), "bin", "code");
    const profileBase = coordinatorMode || identityMode ? root : short;
    const cliArgs = ["--no-sandbox", `--user-data-dir=${profileBase}/u`, `--extensions-dir=${profileBase}/x`];
    run(cli, [...cliArgs, "--install-extension", vsix, "--force"], { env });
    const names = (await readdir(join(root, "x"))).filter(name => name.startsWith("pkm-nonproduction.pkm-v5-"));
    assert.equal(names.length, 1, "Exactly one host VSIX must be installed");
    assert(!(await readdir(join(root, "x"))).some(name => /^uone\.personal-knowledge-/i.test(name)));
    const installed = join(root, "x", names[0]);
    const installedPayload = await validateHostPayload(installed);
    let sideBySide;
    if (identityMode) {
      assert.equal(identityMode, "side-by-side");
      assert(!coordinatorMode);
      assert.equal(manifest.displayName, "pkm-v5");
      assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [{ id: "pkm-v5", label: "pkm-v5" }]);
      sideBySide = { managedRoot: join(root, "managed"), data: join(root, "data/imported"),
        installedPayloadBuildId: installedPayload.buildId, allowWrites: false,
        provisioner: fileURLToPath(new URL("../../experimental/managed-migration.mjs", import.meta.url)),
        launchVerifier: fileURLToPath(new URL("../../experimental/managed-launch-client.mjs", import.meta.url)) };
    }
    await cp(new URL("installed-test-runner.cjs", import.meta.url), join(installed, "installed-test-runner.cjs"));
    await writeFile(join(root, "driver/package.json"), JSON.stringify({
      name: "host-installed-test-driver", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.96.0" },
      activationEvents: ["*"], main: "./driver.cjs",
    }));
    await writeFile(join(root, "driver/driver.cjs"), `
const vscode = require("vscode");
const fs = require("node:fs");
exports.activate = () => {
  require(${JSON.stringify(join(installed, "installed-test-runner.cjs"))}).run().then(
    () => fs.writeFileSync(${JSON.stringify(join(root, "electron-passed.json"))}, '{"passed":true}'),
    error => { console.error(error); fs.writeFileSync(${JSON.stringify(join(root, "electron-passed.json"))}, JSON.stringify({passed:false,error:String(error)})); }
  ).finally(() => vscode.commands.executeCommand("workbench.action.quit"));
};
`);
    await writeFile(join(root, "u/User/settings.json"), JSON.stringify({
      "files.simpleDialog.enable": true, "window.dialogStyle": "custom",
      "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off",
      "update.mode": "none", "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false,
      "workbench.enableExperiments": false, "workbench.startupEditor": "none",
      "chat.mcp.autostart": "never",
      "git.enabled": false, "git.autoRepositoryDetection": false, "git.openRepositoryInParentFolders": "never",
      "http.proxy": "http://127.0.0.1:1", "http.proxySupport": "override",
      ...(coordinatorMode ? { "pkm.nextHost.productionCoordinator": { enabled: true, root: join(root, "coordinator") } } : {}),
    }));
    const note = join(root, "data/source/notes/Example.md");
    await writeFile(note, "---\nid: installed-host-fixture\ntitle: Installed host\n---\nDisposable fixture only.\n");
    const coordinator = coordinatorMode ? {
      root: join(root, "coordinator"), note: join(root, "coordinator/notes/Existing.md"),
      documentId: "native-coordinator-note", mode: coordinatorMode,
    } : undefined;
    if (coordinator) {
      await writeFile(coordinator.note,
        "---\ntitle: Native coordinator\ndocumentId: native-coordinator-note\nrevision: 1\n---\nDisposable same-root fixture.\n", { mode: 0o600 });
      await writeFile(join(coordinator.root, ".pkm/content-privacy.json"),
        '{"schema":1,"private":{"notes":["Chatroom Meetings"]}}', { mode: 0o600 });
    }
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const fixture = {
      root, installed, data: join(root, "data"), source: join(root, "data/source"),
      destination: join(root, "data/imported"), node: process.execPath, python, note, port, coordinator, sideBySide,
    };
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    // VS Code's extensionTestsPath mode rejects modal dialogs. A separate development
    // driver invokes the installed host without enabling that dialog-suppressing mode.
    app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`, "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes",
        "--password-store=basic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
        `--remote-debugging-port=${port}`, "--remote-allow-origins=http://127.0.0.1"], {
      env: { ...env, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(fixture) }, stdio: "inherit",
    });
    const electron = new Promise((resolve, reject) => {
      app.once("error", reject);
      app.once("exit", code => code === 0 ? resolve() : reject(new Error(`Private VS Code exited ${code}`)));
    });
    const deadline = setTimeout(() => app.kill("SIGTERM"), coordinatorMode || identityMode ? 225000 : 105000);
    electron.then(() => clearTimeout(deadline), () => clearTimeout(deadline));
    fixture.editorPid = app.pid;
    await writeFile(fixturePath, JSON.stringify(fixture));
    ui = spawn(python, ["-B", fileURLToPath(new URL("installed-ui.py", import.meta.url)), fixturePath], { env, stdio: "inherit" });
    const uiDone = new Promise((resolve, reject) => {
      ui.once("error", reject);
      ui.once("exit", code => code === 0 ? resolve() : reject(new Error(`Real dialog driver failed: ${code}; inspect ${root}`)));
    });
    const results = await Promise.allSettled([electron, uiDone]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const activation = JSON.parse(await readFile(join(root, "activation.json"), "utf8"));
    assert.equal(activation.active, true);
    assert.equal(JSON.parse(await readFile(join(root, "electron-passed.json"), "utf8")).passed, true);
    assert.equal(JSON.parse(await readFile(join(root, "ui-passed.json"), "utf8")).passed, true);
    run(cli, [...cliArgs, "--uninstall-extension", "pkm-nonproduction.pkm-v5"], { env });
    const list = execFileSync(cli, [...cliArgs, "--list-extensions"], { env, encoding: "utf8", timeout: 120000 });
    assert(!list.includes("pkm-nonproduction.pkm-v5"));
    evidence = {
      schema: "pkm.installed-host-acceptance/v1", passed: true, timestamp: new Date().toISOString(),
      editor, vsix, vsixSha256, installedPayloadBuildId: installedPayload.buildId,
      isolation: { privateNetwork: true, privateAuthenticatedDisplay: true, source: "synthetic-disposable-notes" },
      installation: { executable: cli, args: [...cliArgs, "--install-extension", vsix, "--force"],
        userData: join(root, "u"), extensions: join(root, "x"), installed, uninstalled: true },
      activation, ui: JSON.parse(await readFile(join(root, "ui-passed.json"), "utf8")),
      ...(sideBySide ? { sideBySide: JSON.parse(await readFile(join(root, "side-by-side-passed.json"), "utf8")) } : {}),
      ...(coordinatorMode === "preflight-safety"
        ? { acceptanceScope: "installed preflight safety/negative-path only",
          coordinatorPreflightSafety: JSON.parse(await readFile(join(root, "coordinator-preflight-passed.json"), "utf8")) }
        : coordinatorMode ? { coordinator: JSON.parse(await readFile(join(root, "coordinator-passed.json"), "utf8")) } : {}),
      electronExitCode: app.exitCode, productionCutover: false,
    };
    passed = true;
    console.log("PASS installed host VSIX: real file pickers, read-only preview, deny/no-write, exact-plan confirmation/publication; private profile uninstalled.");
    if (coordinatorMode === "preflight-safety")
      console.log("PASS preflight safety/negative-path only; adoption, managed read, rollback and live takeover NOT verified.");
  } finally {
    await stop(ui);
    await stop(app);
    await stop(display);
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (passed) {
      await rm(root, { recursive: true, force: true });
      if (evidencePath) {
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(evidencePath, JSON.stringify({ ...evidence, profileRemoved: true }, null, 2) + "\n");
        console.log(`Installed-host evidence: ${evidencePath}`);
      }
    }
    else console.error(`Private fixture retained for diagnosis: ${root}`);
  }
}

await main();
