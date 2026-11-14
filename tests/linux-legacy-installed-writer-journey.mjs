import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const testsDirectory = dirname(fileURLToPath(import.meta.url));
const project = resolve(testsDirectory, "../legacy");
const workDirectory = join(project, ".migration-test-work");
const legacyVsix = resolve(project, ".tmp/personal-knowledge-2.7.32-dev.vsix");
const vscode = process.env.PKM_VSCODE_EXECUTABLE
  || join(process.env.HOME ?? "", ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const vscodeCli = join(dirname(vscode), "bin", "code");
const xvfb = process.env.PKM_TRIAL_XVFB
  || join(process.env.HOME ?? "", ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
const driverEntry = join(testsDirectory, "linux-legacy-private-driver.mjs");
const extensionIdentifier = "uone.personal-knowledge";
const delayPoll = 40;
const rootSha = value => createHash("sha256").update(value).digest("hex");

function assertIsolatedRun() {
  if (process.platform !== "linux" || process.pid !== 1)
    throw new Error("Run only inside a private PID namespace: unshare -Urnmpf --mount-proc node next-server/tests/linux-legacy-installed-writer-journey.mjs");
  const fs = require("node:fs");
  fs.accessSync(legacyVsix, fs.constants.R_OK);
  for (const file of [vscode, vscodeCli, xvfb]) fs.accessSync(file, fs.constants.X_OK);
}

function environment(home, temp, extra = {}) {
  return {
    PATH: process.env.PATH || "",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1",
    ...extra,
  };
}

async function waitForFile(file, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(delayPoll);
    }
  }
  throw new Error(`Timed out waiting for private fixture marker: ${file}`);
}

function spawnSyncChecked(command, args, options, timeout, purpose) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${purpose} failed (${result.status ?? result.signal}): ${result.stderr}`);
  return result.stdout;
}

async function waitForProcessClose(child, timeoutMs = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error(`Timed out waiting for owned PID ${child.pid} to exit.`)), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    });
  });
}

async function startPrivateDisplay(scratch, env) {
  spawnSyncChecked("ip", ["link", "set", "lo", "up"], { env }, 10_000, "Private loopback setup");
  const number = 170 + Math.floor(Math.random() * 60);
  const display = `127.0.0.1:${number}`;
  const authority = join(scratch, "Xauthority");
  await writeFile(authority, "", { flag: "wx", mode: 0o600 });
  spawnSyncChecked("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")],
    { env }, 10_000, "Private Xauthority setup");
  const displayEnv = { ...env, DISPLAY: display, XAUTHORITY: authority };
  const server = spawn(xvfb, [`:${number}`, "-screen", "0", "1280x800x24", "-nolock",
    "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp", "-auth", authority],
  { env: displayEnv, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!server.pid || server.exitCode !== null || server.signalCode !== null)
        throw new Error(`Private Xvfb exited before readiness: ${stderr}`);
      const probe = spawnSync("xdpyinfo", ["-display", display], { env: displayEnv, stdio: "ignore", timeout: 1000 });
      if (probe.status === 0) return { server, env: displayEnv };
      await delay(50);
    }
    throw new Error(`Private Xvfb did not become ready: ${stderr}`);
  } catch (error) {
    await stopOwnedChild(server).catch(() => {});
    throw error;
  }
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForProcessClose(child, 10_000);
}

async function prepareProfile({ label, profile, extensions, workspace, root, home, temp, mcpRuntime }) {
  await mkdir(join(profile, "User"), { recursive: true, mode: 0o700 });
  await mkdir(join(profile, "User", "globalStorage", "uone.personal-knowledge"), { recursive: true, mode: 0o700 });
  await mkdir(extensions, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const directory of ["run", "config", "data", "cache"])
    await mkdir(join(home, directory), { recursive: true, mode: 0o700 });
  await writeFile(join(profile, "User", "settings.json"), JSON.stringify({
    "personalKnowledge.storePath": root,
    "personalKnowledge.openOnStartup": false,
    "personalKnowledge.mcpPythonPath": "",
    "personalKnowledge.mcpRuntimePath": mcpRuntime,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "http.proxy": "http://127.0.0.1:1",
    "http.proxySupport": "override",
  }), { flag: "wx", mode: 0o600 });
  spawnSyncChecked(vscodeCli, ["--no-sandbox", `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`,
    "--install-extension", legacyVsix, "--force"],
  { cwd: project, env: environment(home, temp), stdio: ["ignore", "inherit", "inherit"] },
  120_000, `Install old extension into private profile ${label}`);
  const installed = (await readdir(extensions)).filter(name => /^uone\.personal-knowledge-/i.test(name));
  assert.equal(installed.length, 1, `Profile ${label} must contain exactly one PKM extension.`);
  const extensionPath = join(extensions, installed[0]);
  const manifest = JSON.parse(await readFile(join(extensionPath, "package.json"), "utf8"));
  assert.equal(`${manifest.publisher}.${manifest.name}`.toLowerCase(), extensionIdentifier);
  assert.equal(manifest.version, "2.7.32");
  return extensionPath;
}

async function createDriver(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "pkm-private-legacy-writer-driver", publisher: "fixture", version: "0.0.1",
    engines: { vscode: "^1.90.0" },
  }), { flag: "wx", mode: 0o600 });
}

async function startLegacyWindow({
  label, profile: profilePath, home: profileHome, temp: profileTemp, extensions, workspace, driver,
  extensionPath, root, scratch, displayEnv, generateMcp,
}) {
  const ready = join(scratch, `${label}.ready.json`);
  const release = join(scratch, `${label}.release`);
  const shortPath = path => `/proc/self/cwd/${relative(scratch, path)}`;
  const home = shortPath(profileHome);
  const temp = shortPath(profileTemp);
  const runner = spawn(process.execPath, [driverEntry], {
    cwd: scratch,
    env: {
      ...displayEnv,
      PKM_LEGACY_PRIVATE_LABEL: label,
      PKM_LEGACY_PRIVATE_ROOT: root,
      PKM_LEGACY_PRIVATE_PROFILE: profilePath,
      PKM_LEGACY_PRIVATE_READY: ready,
      PKM_LEGACY_PRIVATE_RELEASE: release,
      PKM_LEGACY_PRIVATE_EXTENSION: extensionPath,
      PKM_LEGACY_PRIVATE_DRIVER: shortPath(driver),
      PKM_LEGACY_PRIVATE_WORKSPACE: shortPath(workspace),
      PKM_LEGACY_PRIVATE_EXTENSIONS: shortPath(extensions),
      PKM_VSCODE_EXECUTABLE: vscode,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_RUNTIME_DIR: join(home, "run"),
      ...(generateMcp ? { PKM_LEGACY_PRIVATE_GENERATE_MCP: "1" } : {}),
    },
    stdio: "inherit",
  });
  return { driver: runner, ready, release };
}

async function mcpResponse(child, request, timeoutMs = 30_000) {
  return await new Promise((resolveResponse, rejectResponse) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Legacy MCP initialization did not respond.")), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value?.id === request.id) return finish(undefined, value);
      }
    };
    const onExit = (code, signal) => finish(new Error(`Legacy MCP exited before responding (${code ?? signal}).`));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) rejectResponse(error);
      else resolveResponse(value);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    const payload = JSON.stringify(request);
    child.stdin.write(`${payload}\n`);
  });
}

async function startLegacyMcp({ root, extensionPath, scratch, env }) {
  const serverPath = join(root, "mcp-server", "server.py");
  const vendor = join(extensionPath, "resources", "vendor");
  const wheels = (await readdir(vendor)).filter(name => name.endsWith(".whl")).map(name => join(vendor, name));
  const python = spawnSyncChecked("python3", ["-c", "import sys; print(sys.executable)"],
    { cwd: scratch, env }, 10_000, "Find private Python runtime").trim();
  const pythonEnv = { ...env, PYTHONPATH: [env.PYTHONPATH, ...wheels].filter(Boolean).join(":") };
  spawnSyncChecked(python, ["-c", "import fastmcp, prompt_manager, adaptive_skill_retrieval"],
    { cwd: scratch, env: pythonEnv }, 20_000, "Verify old MCP runtime dependencies");
  const process = spawn(python, [serverPath], { cwd: scratch, env: pythonEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  process.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try {
    const initialized = await mcpResponse(process, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "pkm-private-legacy-writer-test", version: "0.0.1" },
      },
    });
    assert.equal(initialized.jsonrpc, "2.0");
    assert.equal(initialized.id, 1);
    assert(initialized.result, `Legacy MCP initialization failed: ${JSON.stringify(initialized)}`);
    process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await mcpResponse(process, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert(Array.isArray(tools.result?.tools), `Legacy MCP tools/list failed: ${JSON.stringify(tools)}`);
    return { process, serverPath, python, tools: tools.result.tools, stderr: () => stderr };
  } catch (error) {
    try { process.stdin.end(); } catch { /* The private child may already have exited. */ }
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGTERM");
      await waitForProcessClose(process, 10_000).catch(() => {});
    }
    throw error;
  }
}

async function stopLegacyMcp(service) {
  if (!service || service.process.exitCode !== null || service.process.signalCode !== null) return;
  service.process.stdin.end();
  try { await waitForProcessClose(service.process, 10_000); }
  catch {
    service.process.kill("SIGTERM");
    await waitForProcessClose(service.process, 10_000);
  }
}

async function treeSnapshot(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const full = join(directory, name);
      const details = await stat(full);
      entries.push({
        path: relativePath,
        kind: details.isDirectory() ? "directory" : "file",
        mode: details.mode & 0o777,
        ...(details.isFile() ? { sha256: rootSha(await readFile(full)) } : {}),
      });
      if (details.isDirectory()) await visit(full, relativePath);
    }
  }
  await visit(root);
  return entries;
}

async function main() {
  assertIsolatedRun();
  const fs = await import("node:fs/promises");
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
  const scratch = join(workDirectory, `legacy-writer-private-${randomUUID()}`);
  await mkdir(scratch, { mode: 0o700 });
  const scratchReal = await realpath(scratch);
  assert(relative(project, scratchReal) !== ".." && !relative(project, scratchReal).startsWith(`..${sep}`));
  const previousCwd = process.cwd();
  process.chdir(scratch);
  const root = join(scratch, "knowledge-root");
  const profiles = ["window-one", "window-two"].map(label => ({
    label,
    home: join(scratch, `${label}-home`),
    temp: join(scratch, `${label}-temp`),
    profile: join(scratch, `${label}-user`),
    extensions: join(scratch, `${label}-extensions`),
    workspace: join(scratch, `${label}-workspace`),
    driver: join(scratch, `${label}-driver`),
  }));
  for (const directory of [root, join(root, "notes"), join(root, "mcp-server"),
    ...profiles.flatMap(profile => [profile.home, profile.temp])])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes", "Existing.md"),
    "---\ntitle: Existing\nrevision: 1\n---\nPrivate old-writer fixture.\n", { flag: "wx", mode: 0o600 });
  await createDriver(profiles[0].driver);
  await createDriver(profiles[1].driver);
  const env = environment(profiles[0].home, profiles[0].temp);
  const python = spawnSyncChecked("python3", ["-c", "import sys; print(sys.executable)"],
    { cwd: project, env }, 10_000, "Find private Python runtime").trim();
  const mcpRuntime = join(scratch, "mcp-runtime");
  await mkdir(join(mcpRuntime, "bin"), { recursive: true, mode: 0o700 });
  await (await import("node:fs/promises")).symlink(python, join(mcpRuntime, "bin", "python"));
  let display;
  let windows = [];
  let mcp;
  try {
    display = await startPrivateDisplay(scratch, env);
    const extensionPaths = [];
    for (const profile of profiles) {
      extensionPaths.push(await prepareProfile({ ...profile, root, mcpRuntime }));
    }

    windows = await Promise.all(profiles.map((profile, index) => startLegacyWindow({
      ...profile,
      extensionPath: extensionPaths[index],
      root,
      scratch,
      displayEnv: { ...display.env },
      generateMcp: index === 0,
    })));
    const readyRecords = await Promise.all(windows.map(async window => JSON.parse(await waitForFile(window.ready))));
    assert.deepEqual(readyRecords.map(record => record.version), ["2.7.32", "2.7.32"]);
    assert.deepEqual(readyRecords.map(record => record.root), [await realpath(root), await realpath(root)]);
    assert.notEqual(readyRecords[0].extensionHostPid, readyRecords[1].extensionHostPid);

    mcp = await startLegacyMcp({ root, extensionPath: extensionPaths[0], scratch, env });
    const firstMcpPid = mcp.process.pid;
    for (const name of ["mcp_lifecycle_status", "mcp_lifecycle_quiesce"]) {
      assert(!mcp.tools.some(tool => tool.name === name), `Published legacy MCP unexpectedly exposes ${name}.`);
    }
    const unsupportedDrain = await mcpResponse(mcp.process, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "mcp_lifecycle_quiesce", arguments: {} },
    });
    assert(unsupportedDrain.error || unsupportedDrain.result?.isError,
      `Old MCP unexpectedly accepted the lifecycle drain: ${JSON.stringify(unsupportedDrain)}`);
    const stillAvailable = await mcpResponse(mcp.process, {
      jsonrpc: "2.0", id: 4, method: "tools/list", params: {},
    });
    assert(Array.isArray(stillAvailable.result?.tools), "Unsupported drain must not retire the old server.");
    const report = await (await import(pathToFileURL(join(project, "../dist/linux-legacy-writer-quiescence.js")).href))
      .inspectLinuxLegacyWriterQuiescence(root);
    console.log("Private process inventory:", JSON.stringify({
      ready: readyRecords,
      blockers: report.blockers,
    }));
    for (const ready of readyRecords) {
      assert(report.blockers.some(item => item.pid === ready.extensionHostPid
        && ["vscode-extension-host", "vscode-host-process"].includes(item.kind)),
        `Actual old extension-host PID ${ready.extensionHostPid} was not classified as a blocker.`);
    }
    assert(report.blockers.some(item => item.pid === mcp.process.pid && item.kind === "legacy-mcp"),
      `Actual old MCP PID ${mcp.process.pid} was not classified as a blocker.`);

    const before = await treeSnapshot(root);
    const adoptionSource = `import { prepareLegacyRootAdoptionExperimental } from ${JSON.stringify(pathToFileURL(join(project, "../dist/legacy-root-adoption.js")).href)}; try { await prepareLegacyRootAdoptionExperimental(process.argv[1], {}); console.log(JSON.stringify({ok:true})); } catch (error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
    const attempt = spawnSync(process.execPath, ["--input-type=module", "-e", adoptionSource, root], {
      cwd: scratch, env, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(attempt.status, 0, attempt.stderr);
    const result = JSON.parse(attempt.stdout.trim());
    assert.deepEqual(result, { ok: false, code: "LEGACY_WRITERS_ACTIVE" });
    assert.deepEqual(await treeSnapshot(root), before, "Blocked cutover changed the synthetic legacy root.");

    const previousServer = mcp.serverPath;
    mcp.process.stdin.end();
    assert.deepEqual(await waitForProcessClose(mcp.process, 10_000), { code: 0, signal: null },
      "The fixture-owned idle client should close its MCP transport normally without a signal.");
    mcp = undefined;
    const fenceModule = await import(pathToFileURL(join(project, "../dist/linux-root-writer-fence.js")).href);
    const fence = await fenceModule.acquireLinuxRootWriterFence(root, 3_000);
    try {
      fence.assertHeld();
      assert((await stat(previousServer)).isFile());
      mcp = await startLegacyMcp({ root, extensionPath: extensionPaths[0], scratch, env: display.env });
      assert.equal(mcp.process.exitCode, null, "The old MCP must start after the Next fence has been acquired.");
      assert(mcp.tools.some(tool => tool.name === "add_note"), "The actual old MCP did not expose its legacy note writer.");
      const marker = `legacy-writer-race-${randomUUID()}`;
      const written = await mcpResponse(mcp.process, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "add_note", arguments: { title: marker, content: "Written while Next holds flock." } },
      });
      assert(!written.result?.isError, `Legacy note write failed while the new fence was held: ${JSON.stringify(written)}`);
      const matchingNotes = (await readdir(join(root, "notes"))).filter(name => name.endsWith(".md"));
      assert((await Promise.all(matchingNotes.map(name => readFile(join(root, "notes", name), "utf8"))))
        .some(content => content.includes(marker)), "Legacy MCP write did not reach the shared root.");
      const raced = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { inspectLinuxLegacyWriterQuiescence } from ${JSON.stringify(pathToFileURL(join(project, "../dist/linux-legacy-writer-quiescence.js")).href)}; const r=await inspectLinuxLegacyWriterQuiescence(process.argv[1]); console.log(JSON.stringify(r.blockers));`,
        root], { cwd: scratch, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(raced.status, 0, raced.stderr);
      const raceBlockers = JSON.parse(raced.stdout.trim());
      assert(raceBlockers.some(item => item.pid === mcp.process.pid && item.kind === "legacy-mcp"),
        "New Next fence did not see the independently running old MCP service.");
      console.log("CONFIRMED LIMIT: a real legacy MCP server started after Next acquired flock and successfully wrote a Note; the old release does not participate in that fence.");
    } finally { await fence.release(); }

    console.log(JSON.stringify({
      result: "PASS",
      privatePidNamespace: process.pid === 1,
      oldVersion: "2.7.32",
      oldExtensionHostPids: readyRecords.map(record => record.extensionHostPid),
      oldMcpPids: [firstMcpPid, mcp.process.pid],
      oldMcpToolCount: mcp.tools.length,
      blockers: report.blockers.filter(item => readyRecords.some(record => record.extensionHostPid === item.pid)
        || item.pid === firstMcpPid),
      blockedAttempt: result.code,
      publishedMcpSupportsLifecycleDrain: false,
      fixtureOwnedIdleMcpExitedOnClientEof: true,
      oldMcpWriteWhileNextFenceHeld: true,
      newFlockExcludesOldWriter: false,
      externalProcessesInterrupted: false,
    }, null, 2));
  } finally {
    if (mcp) await stopLegacyMcp(mcp);
    for (const window of windows) await writeFile(window.release, "release", { flag: "w", mode: 0o600 }).catch(() => {});
    for (const window of windows) {
      if (window.driver.exitCode === null && window.driver.signalCode === null)
        await waitForProcessClose(window.driver, 120_000);
    }
    if (display?.server) await stopOwnedChild(display.server);
    process.chdir(previousCwd);
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => {
  console.error("FAIL: private legacy writer journey:", error);
  process.exitCode = 1;
});
