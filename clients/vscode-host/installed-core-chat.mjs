import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cachedVSCode } from "./electron-test.mjs";
import { validateHostPayload } from "./package-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const sleep = ms => new Promise(ready => setTimeout(ready, ms));
const run = (command, args, env, timeout = 120000) => {
  const result = spawnSync(command, args, { env, stdio: "inherit", timeout });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
};
async function until(observe, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(ready => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); ready(); });
    child.kill("SIGTERM");
  });
}

export async function runInstalledCoreChat() {
  assert.equal(process.platform, "linux");
  if (process.argv[2] !== "--inside-core-chat") {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) {
      const option = process.argv[index];
      if (option === "--core-chat") continue;
      assert(["--vsix", "--evidence"].includes(option) && !options[option] && process.argv[index + 1],
        "Usage: node installed-test.mjs --core-chat --vsix CURRENT.vsix [--evidence REPORT.json]");
      options[option] = resolve(process.argv[++index]);
    }
    assert(options["--vsix"], "--core-chat requires the parent's already-built current VSIX; it never rebuilds shared artifacts.");
    const editor = cachedVSCode();
    const xvfb = process.env.PKM_TRIAL_XVFB || join(homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const python = execFileSync("python3", ["-c", "import sys, playwright; print(sys.executable)"], { encoding: "utf8" }).trim();
    run("unshare", ["-Urn", process.execPath, fileURLToPath(new URL("installed-test.mjs", import.meta.url)),
      "--inside-core-chat", editor, xvfb, python, options["--vsix"], options["--evidence"] || ""],
    { PATH: process.env.PATH || "" }, 600000);
    return;
  }
  const [editor, xvfb, python, vsix, evidencePath] = process.argv.slice(3);
  const root = resolve(here, `.installed-core-chat-${randomUUID()}`);
  const originalCwd = process.cwd(), originalEnv = { ...process.env };
  await mkdir(root, { mode: 0o700 });
  let display, app, ui, provider, service, mcp, businessApi, passed = false, report;
  const providerCalls = [], providerErrors = [], providerConnections = new Set();
  const business = randomBytes(32).toString("hex"), management = randomBytes(32).toString("hex");
  const input = "One real installed Electron Chat input.";
  const partial = "Test-only loopback provider streamed this durable partial answer.";
  try {
    for (const dir of ["h", "t/runtime", "u/User", "x", "editor", "driver"])
      await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
    process.chdir(root);
    const short = `/proc/${process.pid}/cwd`;
    const env = {
      PATH: originalEnv.PATH || "", HOME: `${short}/h`, USERPROFILE: `${short}/h`,
      TMPDIR: "/proc/self/cwd/t", TMP: "/proc/self/cwd/t", TEMP: "/proc/self/cwd/t",
      XDG_CONFIG_HOME: `${short}/h/config`, XDG_DATA_HOME: `${short}/h/data`, XDG_CACHE_HOME: `${short}/h/cache`,
      XDG_RUNTIME_DIR: `${short}/t/runtime`, DISPLAY: "127.0.0.1:92", XAUTHORITY: join(root, "Xauthority"),
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1", PKM_INSTALLED_CORE_CHAT_MODEL_KEY: "test-only-no-real-sdk-or-account",
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    run("ip", ["link", "set", "lo", "up"], env);
    await writeFile(env.XAUTHORITY, "", { mode: 0o600 });
    run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")], env);
    display = spawn(xvfb, [":92", "-screen", "0", "1280x900x24", "-nolock", "-nolisten", "unix", "-nolisten", "local",
      "-listen", "tcp", "-auth", env.XAUTHORITY], { env, stdio: "ignore" });
    await until(() => spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0,
      "private Xvfb responsiveness", 15000);
    const vsixSha256 = hash(await readFile(vsix));
    const manifest = JSON.parse(execFileSync("unzip", ["-p", vsix, "extension/package.json"], { encoding: "utf8" }));
    assert.equal(`${manifest.publisher}.${manifest.name}`, "pkm-nonproduction.pkm-v5");
    const cli = join(dirname(editor), "bin/code");
    const cliArgs = ["--no-sandbox", `--user-data-dir=${root}/u`, `--extensions-dir=${root}/x`];
    run(cli, [...cliArgs, "--install-extension", vsix, "--force"], env);
    const names = (await readdir(join(root, "x"))).filter(name => name.startsWith("pkm-nonproduction.pkm-v5-"));
    assert.equal(names.length, 1);
    const installed = join(root, "x", names[0]);
    const installedPayload = await validateHostPayload(installed);
    const load = name => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
    const { initialize } = await load("storage");
    const { startSharedManagedServer } = await load("shared-managed-server");
    const { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration } =
      await import("../../experimental/managed-migration.mjs");
    const data = await initialize(join(root, "data"), { storageLayout: "separated" });
    const workspaceId = JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8")).id;
    provider = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, `Bearer ${env.PKM_INSTALLED_CORE_CHAT_MODEL_KEY}`);
        const payload = JSON.parse(body);
        providerCalls.push({ path: request.url, payload, receivedAt: Date.now() });
        assert.equal(payload.messages.at(-1).content, input);
        assert.equal(payload.model, "deterministic-installed-test");
        assert.equal(payload.stream, true);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`);
        providerCalls.at(-1).streamed = true;
        response.on("close", () => { providerCalls[0].closedAt = Date.now(); });
        // Intentionally unfinished until the actual user's Stop aborts the native provider stream.
      } catch (error) {
        providerErrors.push(String(error));
        response.writeHead(500); response.end();
      }
    });
    provider.on("connection", socket => {
      providerConnections.add(socket); socket.once("close", () => providerConnections.delete(socket));
    });
    await new Promise(ready => provider.listen(0, "127.0.0.1", ready));
    const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
    const coreHostProfile = {
      schema: "pkm.shared-core-host/v1",
      config: { schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
        secretRef: "secret:fixture/installed-chat", model: "deterministic-installed-test", contextWindow: 16384,
        maxOutputTokens: 4096, outputTokenParameter: "max_tokens", includeUsage: false, tools: ["knowledge.document.get"] },
      policy: { allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["deterministic-installed-test"],
        allowedTools: ["knowledge.document.get"], allowInsecureLoopback: true },
      secretEnvironment: { "secret:fixture/installed-chat": "PKM_INSTALLED_CORE_CHAT_MODEL_KEY" }, humanReview: "browser",
    };
    const managedRoot = join(root, "managed");
    const first = await stageIsolatedManagedGeneration({ managedRoot, data, backendKind: "standalone-core", coreHostProfile, allowWrites: true });
    const second = await stageIsolatedManagedGeneration({ managedRoot, data, backendKind: "standalone-core", coreHostProfile, allowWrites: true });
    await publishIsolatedManagedGeneration(managedRoot, first.generation);
    const directory = join(data, "server-data/runtime-control/shared-manager");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    service = await startSharedManagedServer({ directory, managedRoot, token: business, managementToken: management,
      backendKind: "standalone-core" });
    const before = service.status();
    assert.equal(before.phase, "accepting");
    const clientEnrollment = { beforeRelay: before.clients };
    assert.equal(clientEnrollment.beforeRelay, 0, "A fresh manager must have no enrolled MCP clients");
    mcp = new Client({ name: "installed-core-chat-proof", version: "1" });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [join(installed, "next-runtime/server/dist/shared-managed-relay.js")],
      cwd: root, stderr: "pipe",
      env: { ...env, PKM_SHARED_ORIGIN: service.url, PKM_SHARED_SERVICE_ID: service.serviceId, PKM_SHARED_TOKEN: business },
    }));
    const mcpRead = async (name, args) => {
      const response = await mcp.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response));
      const body = response.structuredContent ?? JSON.parse(response.content[0].text);
      assert(!body.error, JSON.stringify(body));
      return body.result;
    };
    const mcpInfo = await mcpRead("server_info", {});
    assert.equal(mcpInfo.workspaceId, workspaceId);
    assert.equal(mcpInfo.actorId, "local:owner");
    clientEnrollment.afterRelayJoin = service.status().clients;
    assert.equal(clientEnrollment.afterRelayJoin, 1, "Exactly one explicit packaged MCP relay must be enrolled");
    const api = async (endpoint, body) => {
      const response = await fetch(service.url + endpoint, { method: "POST",
        headers: { authorization: `Bearer ${business}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert(!value.error, JSON.stringify(value));
      return value.result;
    };
    businessApi = api;
    clientEnrollment.statelessHttpPolls = 140;
    for (let index = 0; index < clientEnrollment.statelessHttpPolls; index++)
      await api("/v1/server_info", {});
    clientEnrollment.afterStatelessHttpPolling = service.status().clients;
    assert.equal(clientEnrollment.afterStatelessHttpPolling, 1,
      "Repeated stateless typed HTTP reads must not enroll extra MCP clients or exhaust the 128-client registry");
    await writeFile(join(root, "u/User/settings.json"), JSON.stringify({
      "security.workspace.trust.enabled": false, "window.dialogStyle": "custom", "window.commandCenter": false,
      "workbench.startupEditor": "none", "update.mode": "none", "telemetry.telemetryLevel": "off",
      "pkm.nextHost.origin": service.url, "pkm.nextHost.workspaceId": workspaceId, "pkm.nextHost.actorId": "local:owner",
      "pkm.nextHost.sharedServer": { enabled: true, backendKind: "standalone-core", origin: service.url,
        serviceId: service.serviceId, generation: first.generation },
    }));
    await writeFile(join(root, "driver/package.json"), JSON.stringify({
      name: "installed-core-chat-test-driver", publisher: "fixture", version: "0.0.1",
      engines: { vscode: "^1.101.0" }, activationEvents: ["*"], main: "./driver.cjs",
    }));
    await writeFile(join(root, "driver/driver.cjs"),
      `module.exports = require(${JSON.stringify(join(here, "installed-core-chat-runner.cjs"))});\n`);
    const portServer = createServer();
    await new Promise(ready => portServer.listen(0, "127.0.0.1", ready));
    const port = portServer.address().port;
    await new Promise(ready => portServer.close(ready));
    const fixture = { root, installed, port, input, partial, business, management,
      firstGeneration: first.generation, secondGeneration: second.generation };
    app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`, "--disable-gpu",
      "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes",
      "--password-store=basic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
      `--remote-debugging-port=${port}`, "--remote-allow-origins=http://127.0.0.1"],
    { env: { ...env, PKM_INSTALLED_CORE_CHAT: JSON.stringify(fixture) }, stdio: "inherit" });
    fixture.editorPid = app.pid;
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
    ui = spawn(python, ["-B", join(here, "installed-core-chat-ui.py"), fixturePath], { env, stdio: "inherit" });
    const check = async () => {
      const progress = await json(join(root, "progress.json"));
      assert.notEqual(progress?.stage, "failed", progress?.error);
      const failed = await json(join(root, "ui-failed.json"));
      assert(!failed, JSON.stringify(failed));
      assert(ui.exitCode === null || ui.exitCode === 0 && await json(join(root, "ui-passed.json")),
        "Installed Electron Chat UI exited before completion");
      assert.equal(app.exitCode, null, "Installed Electron exited before completion");
    };
    await until(async () => { await check(); return service.status().generation === second.generation; }, "approved installed shared generation handoff", 180000);
    await writeFile(join(root, "handoff-verified.json"), JSON.stringify({ generation: second.generation }));
    const runner = await until(async () => { await check(); return json(join(root, "runner-passed.json")); }, "installed Chat completion");
    const uiEvidence = await json(join(root, "ui-passed.json"));
    assert.equal(uiEvidence.passed, true);
    const transcript = await api("/v1/capability_read", { operation: "chat.session.messages", version: 1,
      arguments: { id: uiEvidence.sessionId } });
    const turns = await api("/v1/capability_read", { operation: "chat.turn.list", version: 1,
      arguments: { sessionId: uiEvidence.sessionId } });
    assert.deepEqual(transcript.items.map(item => [item.role, item.status]), [["user", "complete"], ["assistant", "cancelled"]]);
    assert.equal(transcript.items[0].content, input);
    assert.equal(transcript.items[1].content, partial);
    assert.equal(turns.items.length, 1);
    assert.equal(turns.items[0].status, "cancelled");
    const mcpTranscript = await mcpRead("capability_read", { operation: "chat.session.messages", version: 1,
      arguments: { id: uiEvidence.sessionId } });
    assert.deepEqual(mcpTranscript, transcript);
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerErrors, []);
    const after = service.status();
    clientEnrollment.afterUiPollingAndHandoff = after.clients;
    assert.equal(clientEnrollment.afterUiPollingAndHandoff, 1,
      "Actual installed Chat polling, reopen and handoff must preserve only the explicit MCP relay enrollment");
    assert.equal(after.serviceId, before.serviceId);
    assert.equal(after.workspaceId, before.workspaceId);
    assert.notEqual(after.backendPid, before.backendPid);
    assert.equal(after.generation, second.generation);
    report = { schema: "pkm.installed-core-chat-acceptance/v1", passed: true,
      scope: "ACTUALLY INSTALLED VSIX in real cached VS Code Electron; native provider is TEST-ONLY deterministic loopback HTTP, not real SDK/account",
      vsix, vsixSha256, installedPayloadBuildId: installedPayload.buildId, executable: editor,
      runner, ui: uiEvidence, transcript, turns, before, after, stableOrigin: service.url, clientEnrollment,
      canonicalMcpPeer: { executable: process.execPath, installedRelay: join(installed, "next-runtime/server/dist/shared-managed-relay.js"),
        info: mcpInfo, transcript: mcpTranscript, sameConnectionAcrossHandoff: true },
      provider: { testOnly: true, requests: providerCalls, requestCount: providerCalls.length, errors: providerErrors },
      zeroReplay: true, productionProfileTouched: false };
    await stop(ui); ui = undefined;
    await stop(app); app = undefined;
    await mcp.close(); mcp = undefined;
    await until(() => service.status().clients === 0, "explicit MCP relay departure", 15000);
    await api("/v1/server_info", {});
    clientEnrollment.afterRelayLeaveAndHttpRead = service.status().clients;
    assert.equal(clientEnrollment.afterRelayLeaveAndHttpRead, 0,
      "A subsequent stateless typed HTTP read must not recreate an enrolled MCP client after relay departure");
    run(cli, [...cliArgs, "--uninstall-extension", "pkm-nonproduction.pkm-v5"], env);
    const installedList = execFileSync(cli, [...cliArgs, "--list-extensions"], { env, encoding: "utf8" });
    assert(!installedList.includes("pkm-nonproduction.pkm-v5"));
    passed = true;
  } finally {
    await stop(ui); await stop(app);
    await mcp?.close();
    if (!passed && businessApi) {
      try {
        const sessions = await businessApi("/v1/capability_read", { operation: "chat.session.list", version: 1, arguments: {} });
        for (const session of sessions.items) {
          const turns = await businessApi("/v1/capability_read", {
            operation: "chat.turn.list", version: 1, arguments: { sessionId: session.id },
          });
          for (const turn of turns.items.filter(item => !["completed", "failed", "cancelled", "unknown"].includes(item.status)))
            await businessApi("/v1/capability_call", { operation: "chat.turn.cancel", version: 1,
              arguments: { id: turn.id, operationId: randomUUID(), expectedRevision: turn.revision } });
        }
      } catch (error) { console.error(`Disposable Chat failure cleanup: ${String(error)}`); }
    }
    for (const socket of providerConnections) socket.destroy();
    if (provider) await new Promise(ready => provider.close(ready));
    try { await service?.close(); }
    finally { await stop(display); }
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (passed) {
      await rm(root, { recursive: true, force: true });
      if (evidencePath) {
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(evidencePath, JSON.stringify({ ...report, profileRemoved: true, uninstalled: true }, null, 2) + "\n", { mode: 0o600 });
      }
      console.log(`PASS installed Electron Core Chat: stream, Stop, exact durable reopen and compatible handoff, one provider call; private profile uninstalled/removed.${evidencePath ? ` Evidence: ${evidencePath}` : ""}`);
    } else console.error(`Private installed Chat fixture retained for explicit diagnosis/cleanup: ${root}`);
  }
}
