import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initialize } from "../../next-server/dist/storage.js";

const require = createRequire(import.meta.url);
const project = resolve(new URL("../..", import.meta.url).pathname);
const editor = process.env.PKM_VSCODE_EXECUTABLE || join(homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const xvfb = process.env.PKM_TRIAL_XVFB || join(homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
if (!process.argv.includes("--inside")) {
  const result = spawnSync("unshare", ["-Urnmpf", "--mount-proc", process.execPath, process.argv[1],
    "--inside", editor, xvfb], { cwd: project, env: { PATH: process.env.PATH || "" }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Private Room host test failed: ${result.status ?? result.signal}`);
} else {
  const [code, displayServer] = process.argv.slice(3);
  const fixture = join(project, ".migration-test-work", `room-secretstorage-${randomUUID()}`);
  const extension = join(fixture, "extension"), legacy = join(fixture, "legacy-source");
  let display, editorProcess;
  mkdirSync(join(legacy, "dist"), { recursive: true, mode: 0o700 });
  for (const dir of ["user", "extensions", "home", "scratch", "workspace"]) mkdirSync(join(fixture, dir), { mode: 0o700 });
  mkdirSync(join(fixture, "user", "User"), { mode: 0o700 });
  writeFileSync(join(fixture, "user", "User", "settings.json"), JSON.stringify({ "window.dialogStyle": "custom" }), { mode: 0o600 });
  mkdirSync(extension, { mode: 0o700 });
  try {
    const ts = require("typescript"), esbuild = require("esbuild");
    for (const name of ["chat-persistence", "chat-persistence-worker"]) {
      writeFileSync(join(legacy, name === "chat-persistence" ? "dist" : "", `${name}.js`),
        ts.transpileModule(readFileSync(join(project, "src/chatroom", `${name}.ts`), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText);
    }
    for (const name of ["sql-wasm.js", "sql-wasm.wasm"])
      copyFileSync(join(project, "node_modules/sql.js/dist", name), join(fixture, name));
    esbuild.buildSync({ stdin: { contents: `
      export {ChatHub} from "./src/chatroom/chatroom-hub";
      export {ChatClient} from "./src/chatroom/chatroom-client";
      export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
      export {NextRoomResumeStore} from "./src/chatroom/next-room-resume-store";
      export {WebSocketServer} from "ws";`, resolveDir: project },
      bundle: true, platform: "node", format: "cjs", packages: "external",
      outfile: join(fixture, "retained.cjs"), logLevel: "silent" });
    esbuild.buildSync({ entryPoints: [join(project, "tests/next-trial-electron/chatroom-secretstorage-extension.ts")],
      bundle: true, platform: "node", format: "cjs", packages: "external", external: ["vscode"],
      outfile: join(extension, "extension.cjs"), logLevel: "silent" });
    writeFileSync(join(extension, "package.json"), JSON.stringify({ name: "private-room-host-test",
      publisher: "pkm-isolated", version: require(join(project, "package.json")).version, engines: { vscode: "^1.90.0" },
      main: "./extension.cjs", activationEvents: ["*"] }));
    require(join(project, "scripts/next-rehearsal-runtime.js")).stage(join(extension, "next-runtime"), { production: true });
    await initialize(join(fixture, "knowledge"));
    const env = { PATH: process.env.PATH || "", HOME: join(fixture, "home"), TMPDIR: join(fixture, "scratch"),
      TMP: join(fixture, "scratch"), TEMP: join(fixture, "scratch") };
    assert.equal(spawnSync("ip", ["link", "set", "lo", "up"], { env }).status, 0);
    const authority = join(fixture, "Xauthority"), displayName = "127.0.0.1:91";
    writeFileSync(authority, "", { mode: 0o600 });
    assert.equal(spawnSync("xauth", ["-f", authority, "add", displayName, "MIT-MAGIC-COOKIE-1",
      randomBytes(16).toString("hex")], { env }).status, 0);
    display = spawn(displayServer, [":91", "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-auth", authority], { env, stdio: "ignore" });
    const displayEnv = { ...env, DISPLAY: displayName, XAUTHORITY: authority };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (display.exitCode !== null || display.signalCode !== null) break;
      if (spawnSync("xdpyinfo", ["-display", displayName], { env: displayEnv, stdio: "ignore", timeout: 1000 }).status === 0) {
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(ready, "Private display unavailable");
    process.chdir(fixture);
    const shortRoot = `/proc/${process.pid}/cwd`;
    editorProcess = spawn(code, [join(shortRoot, "workspace"), "--no-sandbox", "--disable-gpu",
      "--disable-extensions", "--disable-telemetry", "--disable-updates", "--disable-workspace-trust", "--skip-welcome",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9333",
      "--disable-dev-shm-usage", "--no-cached-data",
      "--password-store=basic", `--extensionDevelopmentPath=${extension}`,
      `--user-data-dir=${join(shortRoot, "user")}`, `--extensions-dir=${join(shortRoot, "extensions")}`], {
      cwd: fixture, env: { ...displayEnv, PKM_ROOM_SECRET_FIXTURE: fixture, PKM_ROOM_SECRET_PROJECT: project,
        PKM_ROOM_SECRET_NODE: realpathSync(process.execPath) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    editorProcess.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-6000); });
    const timeout = setTimeout(() => editorProcess.kill("SIGTERM"), 90_000);
    const approve = (async () => {
      const { chromium } = require("playwright");
      const deadline = Date.now() + 70_000;
      let browser;
      while (Date.now() < deadline && !browser && editorProcess.exitCode === null && editorProcess.signalCode === null) {
        try { browser = await chromium.connectOverCDP("http://127.0.0.1:9333"); }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!browser) throw new Error("Private VS Code renderer unavailable.");
      try {
        while (Date.now() < deadline && editorProcess.exitCode === null && editorProcess.signalCode === null) {
          for (const context of browser.contexts()) for (const page of context.pages()) {
            const button = page.getByRole("button", { name: "Approve Identity Recovery", exact: true });
            if (await button.isVisible().catch(() => false)) {
              const text = await page.locator("body").innerText();
              assert(text.includes("historic-agent") && text.includes("historic-client-1")
                && text.includes("out of band"), "Approval dialog did not identify the historical participant and risk.");
              await button.click();
              return;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("Real Room identity approval dialog did not appear.");
      } finally { await browser.close(); }
    })().catch(error => error);
    const marker = join(fixture, "result.json");
    while (!existsSync(marker) && editorProcess.exitCode === null && editorProcess.signalCode === null)
      await new Promise(resolve => setTimeout(resolve, 50));
    clearTimeout(timeout);
    if (!existsSync(marker)) throw new Error(`VS Code Room test produced no result: ${editorProcess.exitCode ?? editorProcess.signalCode} ${diagnostic}`);
    const report = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(report.passed, true, JSON.stringify(report));
    const approvalError = await approve;
    if (approvalError instanceof Error) throw approvalError;
    assert.equal(report.realSecretStorage, true);
    assert.equal(report.realExtensionHost, true);
    assert.equal(report.roomDrainedOnRevocation, true);
    assert.equal(report.managedTrialAction, true);
    assert.equal(report.originalParticipantRecovery, true);
    console.log("PASS private VS Code Host, real approval dialog, distinct peer process, original identity and stored-proof reconnect.");
  } finally {
    for (const child of [editorProcess, display]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGTERM"); await exited;
      }
    }
    process.chdir(project);
    rmSync(fixture, { recursive: true, force: true });
  }
}
