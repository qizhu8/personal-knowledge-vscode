"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async ({ project, fixture, source, workspace, host, actorId, sourceFingerprint, workspaceId, namespace, chatId }) => {
  const extension = path.join(fixture, "extension"), profile = path.join(fixture, "profile");
  const user = path.join(profile, "User"), temp = path.join(fixture, "local-temp");
  const authority = path.join(fixture, "Xauthority"), nonce = randomUUID();
  for (const dir of [extension, user, temp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const compilation = spawnSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"),
    "-p", path.join(project, "tsconfig.json"), "--outDir", path.join(extension, "dist"), "--pretty", "false"],
  { cwd: project, encoding: "utf8", timeout: 120000, env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp } });
  if (compilation.status !== 0) throw new Error(compilation.stderr || compilation.stdout || "Private extension compilation failed.");
  fs.cpSync(path.join(project, "dist/webview"), path.join(extension, "dist/webview"), { recursive: true });
  fs.copyFileSync(path.join(project, "package.json"), path.join(extension, "package.json"));
  fs.symlinkSync(path.join(project, "node_modules"), path.join(extension, "node_modules"), "dir");
  const grant = path.join(user, "globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  fs.mkdirSync(path.dirname(grant), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixture, "native-ui-fixture-token"), nonce, { flag: "wx", mode: 0o600 });
  const stat = fs.lstatSync(source, { bigint: true });
  fs.writeFileSync(grant, JSON.stringify({
    schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", nonce, fixture, root: source,
    rootDevice: String(stat.dev), rootInode: String(stat.ino), workspaceId, actorId, sourceFingerprint,
    endpoint: host.endpoint, bearer: host.bearer,
  }), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(user, "settings.json"), JSON.stringify({
    "personalKnowledge.storePath": source, "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off",
  }), { mode: 0o600 });
  const priorCwd = process.cwd();
  process.chdir(fixture);
  const shortTemp = `/proc/${process.pid}/cwd/local-temp`;
  const env = { PATH: process.env.PATH || "", HOME: fixture, USERPROFILE: fixture,
    TMPDIR: temp, TMP: temp, TEMP: temp, XDG_RUNTIME_DIR: shortTemp,
    DISPLAY: "127.0.0.1:91", XAUTHORITY: authority, PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grant,
    PYTHONDONTWRITEBYTECODE: "1" };
  fs.writeFileSync(authority, "", { flag: "wx", mode: 0o600 });
  const auth = spawnSync("xauth", ["-f", authority, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], { env });
  assert.equal(auth.status, 0, "Private display authentication failed.");
  const server = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
  const executable = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
  let xvfb, code;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    await Promise.race([exited, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  };
  try {
    xvfb = spawn(server, [":91", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
      "-listen", "tcp", "-auth", authority], { cwd: fixture, env, stdio: "ignore" });
    for (let n = 0; n < 100; n++) {
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore" }).status === 0) break;
      if (n === 99) throw new Error("Private X display did not start.");
      await delay(50);
    }
    code = spawn(executable, ["--no-sandbox", `--user-data-dir=${profile}`, `--extensions-dir=${path.join(fixture, "extensions")}`,
      `--extensionDevelopmentPath=${extension}`, "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--password-store=basic", "--skip-release-notes", "--skip-welcome", "--locale=en",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9333", workspace],
    { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = "";
    code.stdout.on("data", data => { diagnostics = (diagnostics + data).slice(-20000); });
    code.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-20000); });
    let ready = false;
    for (let n = 0; n < 200; n++) {
      if (code.exitCode !== null || code.signalCode !== null) throw new Error(`Private Code exited: ${diagnostics}`);
      try { ready = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).some(item => item.url.includes("workbench")); }
      catch {}
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error(`Private Code did not become ready: ${diagnostics}`);
    const driver = spawn("python3", ["-B", path.join(project, "tests/native_chat_process_ui.py"),
      "http://127.0.0.1:9333", chatId, fixture], { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    driver.stdout.on("data", chunk => { output += chunk; }); driver.stderr.on("data", chunk => { output += chunk; });
    const [exit, signal] = await once(driver, "exit");
    if (exit !== 0) {
      const response = await fetch(`${host.endpoint}/rpc`, { method: "POST",
        headers: { authorization: `Bearer ${host.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
        body: JSON.stringify({ method: "process-approvals", namespace, chatId }) });
      throw new Error(`Private real UI journey failed (${exit ?? signal}): ${output}\nPENDING ${await response.text()}\n${diagnostics}`);
    }
    console.log(output.trim());
  } finally {
    await stop(code); await stop(xvfb);
    process.chdir(priorCwd);
  }
};
