#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");

const project = path.resolve(__dirname, "..");
const xvfb = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
const vscode = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const installed = process.argv.includes("--installed-vsix");
const legacyArgument = process.argv.find(arg => arg.startsWith("--legacy-vsix="));
const inPlace = process.argv.includes("--in-place-experiment");
const focusedPackage = process.argv.includes("--focused-package");
const sameRoot = process.argv.includes("--require-same-root");

function privateNamespaceArgs(command) {
  // Bash stays PID 1 to reap orphaned fixture daemons; Node alone leaves zombies that look alive.
  return ["-Urnmpf", "--mount-proc", "bash", "-c", '"$@" & workload=$!; wait "$workload"', "pkm-private-init", ...command];
}

async function main() {
  if (process.platform !== "linux") throw new Error("Private network display requires Linux.");
  if (process.argv.slice(2).some(arg => !["--inside", "--installed-vsix", "--in-place-experiment", "--focused-package", "--require-same-root", xvfb, vscode, legacyArgument].includes(arg)) && !process.argv.includes("--inside"))
    throw new Error("Usage: node scripts/run-next-trial-private-display.js [--installed-vsix [--legacy-vsix=/absolute/file.vsix [--in-place-experiment [--require-same-root] [--focused-package]]]]");
  if (legacyArgument && (!installed || !path.isAbsolute(legacyArgument.slice("--legacy-vsix=".length))))
    throw new Error("A legacy VSIX requires --installed-vsix and an absolute path.");
  if (inPlace && !legacyArgument) throw new Error("In-place experiment requires the explicit legacy installed upgrade journey.");
  if (focusedPackage && !inPlace) throw new Error("Focused packaging is restricted to the experimental installed journey.");
  if (sameRoot && !inPlace) throw new Error("Same-root acceptance requires the explicit in-place experiment.");
  if (process.argv[2] !== "--inside") {
    for (const file of [xvfb, vscode]) fs.accessSync(file, fs.constants.X_OK);
    const result = spawnSync("unshare", privateNamespaceArgs([process.execPath, __filename, "--inside", xvfb, vscode, ...(installed ? ["--installed-vsix"] : []), ...(legacyArgument ? [legacyArgument] : []), ...(inPlace ? ["--in-place-experiment"] : []), ...(focusedPackage ? ["--focused-package"] : []), ...(sameRoot ? ["--require-same-root"] : [])]), {
      cwd: project, stdio: "inherit", env: { PATH: process.env.PATH || "" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Private network display run failed: ${result.status ?? result.signal}`);
    return;
  }
  const [server, editor] = process.argv.slice(3);
  const scratch = path.join(project, ".migration-test-work", `trial-display-${randomUUID()}`);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  let child;
  try {
    const env = { PATH: process.env.PATH || "", HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    const loopback = spawnSync("ip", ["link", "set", "lo", "up"], { env, encoding: "utf8" });
    if (loopback.status !== 0) throw new Error(`Cannot enable private loopback: ${loopback.stderr}`);
    const number = 91;
    const display = `127.0.0.1:${number}`;
    const authority = path.join(scratch, "Xauthority");
    fs.writeFileSync(authority, "", { flag: "wx", mode: 0o600 });
    const auth = spawnSync("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], {
      env, encoding: "utf8",
    });
    if (auth.status !== 0) throw new Error("Cannot create isolated X11 authorization.");
    child = spawn(server, [`:${number}`, "-screen", "0", "1280x800x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-auth", authority], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
    child.once("error", error => { stderr += error.message; });
    const displayEnv = { ...env, DISPLAY: display, XAUTHORITY: authority, PKM_VSCODE_EXECUTABLE: editor };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) break;
      const probe = spawnSync("xdpyinfo", ["-display", display], { env: displayEnv, stdio: "ignore", timeout: 1000 });
      if (probe.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error(`Private Xvfb did not become ready: ${stderr}`);
    console.log("Private network Xvfb ready; local Unix transport and lock disabled.");
    const runner = spawn(process.execPath, [path.join(project, "scripts/run-next-trial-electron-test.js"), ...(installed ? ["--installed-vsix"] : []), ...(legacyArgument ? [legacyArgument] : []), ...(inPlace ? ["--in-place-experiment"] : []), ...(focusedPackage ? ["--focused-package"] : []), ...(sameRoot ? ["--require-same-root"] : [])], {
      cwd: project, env: displayEnv, stdio: "inherit",
    });
    let timedOut = false;
    let force;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error("Electron test timed out; requesting graceful shutdown and fixture cleanup.");
      runner.kill("SIGINT");
      force = setTimeout(() => {
        console.error("Electron runner did not exit; stopping its process. Inspect its retained fixture and processes.");
        runner.kill("SIGTERM");
      }, 30000);
    }, installed ? 600000 : 300000);
    const result = await new Promise(resolve => {
      runner.once("error", error => resolve({ error }));
      runner.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    clearTimeout(force);
    if (result.error) throw result.error;
    if (timedOut || result.code !== 0) throw new Error(`Electron test failed: ${result.code ?? result.signal}`);
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await stopped;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
module.exports = { privateNamespaceArgs };
if (require.main === module)
  main().catch(error => { console.error("FAIL: isolated display:", error.message); process.exitCode = 1; });
