import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

export async function runInstalledGitHubUi(fixture, vsix, runtime, commit, enablePublic) {
  assert(/^pkm-native-subscription-ui-[a-f0-9-]{36}$/.test(fixture.split("/").at(-1)));
  assert(/^.*\/\.migration-test-work\/native-chat-ui-build-[a-f0-9-]{36}\/native-chat-ui-candidate\.vsix$/.test(vsix));
  const editor = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
  const displayServer = process.env.PKM_TRIAL_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
  const global = join(fixture, "u", "User", "globalStorage", "uone.personal-knowledge");
  for (const dir of ["h", "t", "workspace", "x"]) mkdirSync(join(fixture, dir), { mode: 0o700 });
  const socket = resolve(`.ng-${randomUUID().slice(0, 8)}`);
  symlinkSync(join(fixture, "t"), socket, "dir");
  const env = { ...process.env, HOME: join(fixture, "h"), USERPROFILE: join(fixture, "h"),
    TMPDIR: join(fixture, "t"), TMP: join(fixture, "t"), TEMP: join(fixture, "t"),
    XDG_RUNTIME_DIR: socket, DISPLAY: "127.0.0.1:92", PKM_PRIVATE_NATIVE_SUBSCRIPTION: "1",
    PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT: join(global, "native-subscription-ui.json"),
    PKM_TEST_GITHUB_FIXTURE: fixture, PKM_TEST_GITHUB_EXPECTED_COMMIT: commit,
    PKM_NATIVE_SUBSCRIPTION_DRIVER_READY: join(fixture, "driver-ready") };
  writeFileSync(join(fixture, "u", "User", "settings.json"), JSON.stringify({
    "personalKnowledge.storePath": join(fixture, "root"), "personalKnowledge.openOnStartup": false,
    "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none",
    "extensions.autoUpdate": false,
  }), { mode: 0o600 });
  const seed = join(fixture, "seed"); mkdirSync(seed, { mode: 0o700 });
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "native-github-seed", publisher: "fixture",
    version: "0.0.1", engines: { vscode: "^1.90.0" } }), { mode: 0o600 });
  const common = [join(fixture, "workspace"), "--no-sandbox", "--new-window", `--user-data-dir=${join(fixture, "u")}`,
    `--extensions-dir=${join(fixture, "x")}`, "--disable-gpu", "--disable-dev-shm-usage", "--disable-site-isolation-trials",
    "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic"];
  let display, code;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(done => child.once("exit", done));
    child.kill("SIGTERM");
    await Promise.race([exited, wait(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
  try {
    const install = spawnSync(join(dirname(editor), "bin", "code"), ["--no-sandbox",
      `--user-data-dir=${join(fixture, "u")}`, `--extensions-dir=${join(fixture, "x")}`,
      "--install-extension", vsix, "--force"], { env, encoding: "utf8", timeout: 120000 });
    assert.equal(install.status, 0, install.stderr);
    const installedNames = readdirSync(join(fixture, "x")).filter(name => /^uone\.personal-knowledge-/.test(name));
    assert.equal(installedNames.length, 1);
    const installed = join(fixture, "x", installedNames[0], "next-runtime", "server");
    const compare = (source, target, relative = "") => {
      for (const item of readdirSync(join(source, relative), { withFileTypes: true })) {
        const next = join(relative, item.name);
        if (item.isDirectory()) compare(source, target, next);
        else assert(item.isFile() && readFileSync(join(source, next)).equals(readFileSync(join(target, next))));
      }
    };
    for (const name of ["dist", "compat", "browser"]) compare(join(runtime, name), join(installed, name));
    display = spawn(displayServer, [":92", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-ac"], { env, stdio: "ignore" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnSync("xdpyinfo", ["-display", "127.0.0.1:92"], { env, stdio: "ignore" }).status === 0) break;
      if (display.exitCode !== null || attempt === 99) throw new Error("Private X display unavailable.");
      await wait(50);
    }
    code = spawn(editor, [...common, `--extensionDevelopmentPath=${seed}`,
      `--extensionTestsPath=${resolve("tests/native-subscription-github-secret.cjs")}`,
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9335"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    for (const stream of [code.stdout, code.stderr]) stream.on("data", chunk => {
      if (diagnostics.length < 8192) diagnostics += chunk.toString().slice(0, 8192 - diagnostics.length);
    });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (code.exitCode !== null) throw new Error(`Private UI exited: ${diagnostics}`);
      try { if (existsSync(join(fixture, "driver-ready")) && (await fetch("http://127.0.0.1:9335/json/list")).ok) break; } catch {}
      if (attempt === 299) throw new Error(`Private UI did not start: ${diagnostics}`);
      await wait(100);
    }
    for (const alias of ["Old Skills", "Public Skills"]) {
      if (alias === "Public Skills") enablePublic();
      const run = spawn("python3", ["-B", resolve("tests/native-subscription-github-ui.py")],
        { env: { ...env, PKM_TEST_GITHUB_ALIAS: alias }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      run.stdout.resume();
      run.stderr.on("data", chunk => { output += chunk.toString(); });
      const exit = await new Promise(done => {
        const timer = setTimeout(() => { run.kill("SIGKILL"); }, 120000);
        run.once("exit", code => { clearTimeout(timer); done(code); });
      });
      assert.equal(exit, 0, `Private GitHub Subscription UI failed: ${output}\n${diagnostics}`);
    }
    writeFileSync(join(fixture, "github-test-done"), "done", { mode: 0o600 });
    await new Promise((done, reject) => {
      if (code.exitCode !== null) return code.exitCode === 0 ? done() : reject(new Error("Private UI test host failed."));
      const timer = setTimeout(() => reject(new Error("Private UI test host did not exit.")), 30000);
      code.once("exit", status => { clearTimeout(timer); status === 0 ? done() : reject(new Error("Private UI test host failed.")); });
    });
  } finally {
    await stop(code); await stop(display);
    rmSync(socket, { force: true });
  }
}
