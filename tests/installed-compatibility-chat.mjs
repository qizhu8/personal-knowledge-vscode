import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageCompatibilityMcp } from "../scripts/stage-compatibility-mcp.mjs";
import { createOverviewModel } from "./installed-chat-overview.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const shippedVsix = resolve(project, "../personal-knowledge-vscode/personal-knowledge-4.0.27.vsix");
const shippedSha = "d9deb3f1664496342ee1397c78748cb020fdf65aac0978bbbb43b880d5d2f1be";
const wait = ms => new Promise(done => setTimeout(done, ms));
const checked = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw result.error || Error(`${command}: ${result.stderr || result.stdout}`);
  return (result.stdout || "").trim();
};
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once("exit", done));
  child.kill("SIGTERM");
  await Promise.race([exited, wait(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}
async function file(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
}

if (!process.argv.includes("--inside")) {
  const options = {};
  for (const argument of process.argv.slice(2)) {
    if (argument === "--chat-overview" && !options.overview) options.overview = true;
    else if (argument.startsWith("--candidate-vsix=") && !options.candidate)
      options.candidate = resolve(argument.slice("--candidate-vsix=".length));
    else if (argument.startsWith("--candidate-sha256=") && !options.sha256)
      options.sha256 = argument.slice("--candidate-sha256=".length);
    else throw Error(`Unknown or repeated installed acceptance argument: ${argument}`);
  }
  if (options.overview) assert(options.candidate && /^[a-f0-9]{64}$/.test(options.sha256),
    "Task-overview acceptance requires an explicitly pinned candidate VSIX.");
  else assert(!options.candidate && !options.sha256, "Candidate pins require --chat-overview.");
  const editor = process.env.PKM_PROFILE_CODE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
  const xvfb = process.env.PKM_PROFILE_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
  const browserPython = checked("python3", ["-c", "import sys,playwright;print(sys.executable)"]);
  const businessPython = process.env.PKM_TEST_PYTHON || "/home/yuwang8/pkm-envs/personal-knowledge-vscode-dev/bin/python";
  checked("unshare", ["-Urn", process.execPath, fileURLToPath(import.meta.url), "--inside",
    editor, xvfb, browserPython, businessPython, options.overview ? "chat-overview" : "",
    options.candidate || "", options.sha256 || ""], { stdio: "inherit", timeout: options.overview ? 480_000 : 300_000,
    env: { PATH: process.env.PATH || "" } });
} else {
  const [editor, xvfb, browserPython, businessPython, overviewMarker, candidateVsix, candidateSha256] = process.argv.slice(3);
  const overview = overviewMarker === "chat-overview";
  if (overviewMarker) assert(overview && candidateVsix && /^[a-f0-9]{64}$/.test(candidateSha256));
  const vsix = overview ? candidateVsix : shippedVsix;
  process.umask(0o077);
  const base = resolve(project, `.pkm-test-evidence/installed-chat-${randomUUID()}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFile(join(base, "package.json"), '{"type":"commonjs"}\n');
  console.log("INSTALLED_CHAT_EVIDENCE", base);
  let display, app, browser, inference, passed = false;
  const errors = [], requests = [], logs = [];
  const overviewModel = overview ? createOverviewModel({ base }) : undefined;
  try {
    assert.equal(createHash("sha256").update(await readFile(shippedVsix)).digest("hex"), shippedSha);
    if (overview) {
      assert.equal(await realpath(vsix), resolve(vsix));
      assert.equal(createHash("sha256").update(await readFile(vsix)).digest("hex"), candidateSha256);
    }
    for (const directory of ["h", "u/User", "x", "driver", "scratch/runtime", "offline-deps", "library/notes",
      "library/skills", "library/papers", "business-python/bin"])
      await mkdir(join(base, directory), { recursive: true, mode: 0o700 });
    process.chdir(base);
    const short = `/proc/${process.pid}/cwd`;
    const env = { PATH: process.env.PATH || "", HOME: join(base, "h"), USERPROFILE: join(base, "h"),
      TMPDIR: join(base, "scratch"), TMP: join(base, "scratch"), TEMP: join(base, "scratch"),
      XDG_CONFIG_HOME: `${short}/h/config`, XDG_DATA_HOME: `${short}/h/data`,
      XDG_CACHE_HOME: `${short}/h/cache`, XDG_RUNTIME_DIR: `${short}/scratch/runtime`,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1", PYTHONDONTWRITEBYTECODE: "1", ELECTRON_RUN_AS_NODE: "1",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    checked("ip", ["link", "set", "lo", "up"], { env });
    const cli = join(dirname(editor), "bin/code");
    checked(cli, ["--no-sandbox", `--user-data-dir=${base}/u`, `--extensions-dir=${base}/x`,
      "--install-extension", vsix, "--force"], { env });
    const installedNames = (await readdir(join(base, "x"))).filter(name => /^uone\.personal-knowledge-/i.test(name));
    assert.equal(installedNames.length, 1);
    const installed = await realpath(join(base, "x", installedNames[0]));
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.version, "4.0.27");
    const wheel = join(installed, "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl");
    checked(businessPython, ["-m", "pip", "--disable-pip-version-check", "install",
      "--no-index", "--no-deps", "--target", join(base, "offline-deps"), wheel], { env });
    env.PYTHONPATH = join(base, "offline-deps");
    checked(businessPython, ["-c", "import fastmcp,prompt_manager,websockets,adaptive_skill_retrieval,cryptography;from adaptive_skill_retrieval import ContentType,RetrievalEngine,SkillDocument,academic_bm25_benchmark_route,exact_match_route"], { env });
    const library = join(base, "library"), managed = join(library, "mcp-server");
    checked("git", ["init", "--quiet", library], { env });
    const runtime = join(base, "business-python");
    await writeFile(join(runtime, "bin/python"),
      `#!/bin/sh\nexec ${JSON.stringify(businessPython)} "$@"\n`, { mode: 0o700 });
    checked(join(runtime, "bin/python"), ["-c", "import fastmcp,prompt_manager,websockets,adaptive_skill_retrieval,cryptography"], { env });
    // Only preprovisioning uses the existing configuration facade. The acceptance below
    // activates the unchanged CLI-installed extension with the real VS Code API.
    const generator = join(base, "generate.cjs");
    await writeFile(generator, `
const Module=require("node:module");
const c={mcpServerPath:${JSON.stringify(managed)},mcpRuntimePath:${JSON.stringify(runtime)},mcpEnabledFeatureDomains:["knowledge","automation","skillRouter"]};
const api={workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:()=>({get:(k,d)=>k in c?c[k]:d})},
env:{appRoot:${JSON.stringify(base)},machineId:"fixture",sessionId:"fixture"},Uri:{file:p=>({fsPath:p,toString:()=>p})}};
const load=Module._load;Module._load=function(id,...a){return id==="vscode"?api:load.call(this,id,...a)};
require(${JSON.stringify(join(installed, "dist/knowledge/filestore.js"))}).setStorePath(${JSON.stringify(library)});
require(${JSON.stringify(join(installed, "dist/mcp/mcp.js"))}).generateMcpServer({
extensionPath:${JSON.stringify(installed)},globalStorageUri:{fsPath:${JSON.stringify(join(base, "h"))}}}).catch(e=>{console.error(e);process.exitCode=1});
`);
    checked(process.execPath, [generator], { env, cwd: base });
    const stage = await stageCompatibilityMcp({ extension: installed, knowledgeRoot: library,
      managedRoot: managed, python: businessPython, destination: join(base, "gateway") });
    const target = JSON.parse(await readFile(stage.targetPath, "utf8"));
    let chatGatewayProcess;
    const captureChatGateway = async () => {
      const candidates = checked("ps", ["-eo", "pid=,args="], { env }).split("\n")
        .filter(line => line.includes(target.entry.path));
      for (const candidate of candidates) {
        const pid = Number(candidate.trim().split(/\s+/)[0]);
        const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
        if (argv[0] !== target.command.path || argv[1] !== target.entry.path) continue;
        const encoded = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0")
          .find(value => value.startsWith("PKM_MCP_LAUNCH_ATTRIBUTION="));
        const attribution = encoded && JSON.parse(encoded.slice("PKM_MCP_LAUNCH_ATTRIBUTION=".length));
        if (attribution?.source !== "pkm-chat") continue;
        assert(["chat", "unknown"].includes(attribution.scope));
        if (attribution.chatId) assert.match(attribution.chatId, /^[a-f0-9-]{36}$/);
        assert.deepEqual(argv.slice(2), target.args);
        chatGatewayProcess = { pid, argv, source: attribution.source, scope: attribution.scope,
          chatId: attribution.chatId ?? null, entrySha256: target.entry.sha256 };
      }
      assert(chatGatewayProcess, "Actual installed Chat must launch the selected pinned gateway, not silently use native fallback");
      await writeFile(join(base, "chat-gateway-process.json"), JSON.stringify(chatGatewayProcess, null, 2));
    };
    let cancelled = false;
    inference = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.authorization, "Bearer isolated-installed-provider");
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length; assert(length < 4_000_000); chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (overviewModel && await overviewModel.handle(request, response, input)) return;
        const last = input.messages.filter(message => message.role === "user").at(-1)?.content;
        requests.push({ tools: input.tools?.map(tool => tool.function.name),
          toolResults: input.messages.filter(message => message.role === "tool") });
        if (typeof last === "string" && last.includes("CANCEL_INSTALLED")) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting for actual installed Stop\n\n");
          await writeFile(join(base, "provider-waiting.json"), '{"waiting":true}');
          response.on("close", () => { cancelled = true; });
          return;
        }
        const sequence = [
          ["find_vscode_tools", { query: "mcp_pkm_add_note" }],
          ["invoke_vscode_tool", { name: "mcp_pkm_add_note", input: { title: "InstalledGatewayNote",
            content: "Created by installed PKM Chat through the selected v5 gateway." } }],
          ["record_harness", { kind: "validation", stepId: "installed-readback", status: "start",
            summary: "Read the original Note after the approved installed Chat write" }],
          ["find_vscode_tools", { query: "mcp_pkm_get_note" }],
          ["invoke_vscode_tool", { name: "mcp_pkm_get_note", input: { slug: "InstalledGatewayNote" } }],
          ["record_harness", { kind: "validation", stepId: "installed-readback", status: "complete",
            summary: "Installed Note readback confirms the requested content", evidenceCallIds: ["installed-call-4"] }],
        ];
        const results = requests.at(-1).toolResults, count = results.length, step = sequence[count];
        if (count === 2) assert(!JSON.parse(results.at(-1).content).error,
          `Actual approved Note write failed: ${results.at(-1).content.slice(0, 2000)}`);
        if (count === 2) await captureChatGateway();
        if (step) assert(input.tools.some(tool => tool.function.name === step[0]), `Missing actual Chat tool ${step[0]}`);
        if (count === 5) assert.match(results.at(-1).content, /Created by installed PKM Chat through the selected v5 gateway/);
        if (!step) assert.match(results.at(-1).content, /"ok":true/);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: step ? { tool_calls: [{ index: 0,
          id: `installed-call-${count}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
          : { content: "INSTALLED_GATEWAY_ACCEPTED: approved original Note write and readback; terminal read receipt cited by validation." },
          finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(String(error)); }
    });
    await new Promise(done => inference.listen(0, "127.0.0.1", done));
    await writeFile(join(base, "u/User/settings.json"), JSON.stringify({
      "personalKnowledge.storePath": library, "personalKnowledge.mcpServerPath": managed,
      "personalKnowledge.mcpRuntimePath": runtime, "personalKnowledge.mcpPythonPath": businessPython,
      "personalKnowledge.openOnStartup": false, "personalKnowledge.apiChatProvider": "openai-compatible",
      "personalKnowledge.aiEndpoint": `http://127.0.0.1:${inference.address().port}/v1`,
      "personalKnowledge.aiModel": "installed-fixture", "personalKnowledge.apiChatCapabilityProfile": "legacy",
      "personalKnowledge.apiChatActivityCreditLimit": -1,
      "personalKnowledge.apiChatModels": [], "personalKnowledge.apiChatModelProfiles": [
        { id: "installed-fixture", status: "active", contextWindow: 128000, maxOutputTokens: 4096 }],
      "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off",
      "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
      "workbench.startupEditor": "none", "window.dialogStyle": "custom",
    }));
    await writeFile(join(base, "driver/package.json"), JSON.stringify({
      name: "installed-chat-acceptance-driver", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.101.0" },
      activationEvents: ["*"], main: "accept.cjs",
    }));
    await writeFile(join(base, "driver/accept.cjs"), `
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vscode=require("vscode");
exports.activate=()=>{setImmediate(()=>exports.run().catch(error=>console.error(error)))};
exports.run=async()=>{
 const base=${JSON.stringify(base)},installed=${JSON.stringify(installed)},library=${JSON.stringify(library)};
 const progress=stage=>fs.writeFileSync(path.join(base,"progress.json"),JSON.stringify({stage}));
 let overviewObservation,overviewApi;
 try{
  const extension=vscode.extensions.getExtension("uone.personal-knowledge");
  assert(extension&&!extension.isActive,"Installed extension must be captured before its real activation");
  assert.equal(fs.realpathSync(extension.extensionPath),installed);
  ${overview ? `
  overviewApi=await import(${JSON.stringify(new URL("./installed-chat-overview.mjs", import.meta.url).href)});
  overviewObservation=overviewApi.observeInstalledChatRegistration(installed,require);` : ""}
  const main=require(path.join(installed,${JSON.stringify(manifest.main)})),activate=main.activate;
  let actualContext;
  main.activate=async function(context,...args){
   actualContext=context;assert.equal(context.extensionMode,vscode.ExtensionMode.Production);
   await context.globalState.update("pkm.mcpHotSwitchEnabled.v1",true);
   await context.secrets.store("personalKnowledge.aiApiKey","isolated-installed-provider");
   return activate.call(this,context,...args);
  };
  progress("activating-installed-extension");
  try{await extension.activate()}finally{main.activate=activate}
  assert(actualContext&&extension.isActive);
  assert(fs.realpathSync(actualContext.globalStorageUri.fsPath).startsWith(path.join(base,"u")));
  progress("starting-native-managed");
  await vscode.commands.executeCommand("personalKnowledge.startPkmMcp");
  progress("selecting-v5-gateway");
  const switched=await vscode.commands.executeCommand("personalKnowledge.switchMcpRuntime",${JSON.stringify(stage.targetPath)});
  assert.equal(switched.runtime.version,"0.1.0");
  const verified=await vscode.commands.executeCommand("personalKnowledge.verifyMcpRuntime");
  assert.equal(verified.runtime.version,"0.1.0");
  fs.writeFileSync(path.join(base,"native.json"),JSON.stringify({switched,verified}));
  progress("opening-installed-chat");
  await vscode.commands.executeCommand("personalKnowledge.openApiChat");
  fs.writeFileSync(path.join(base,"chat-ready.json"),'{"ready":true}');
  progress("browser-chat-and-harness");
  const deadline=Date.now()+120000;
  while(!fs.existsSync(path.join(base,"browser-done.json"))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert(fs.existsSync(path.join(base,"browser-done.json")),"Installed browser acceptance did not finish");
  const note=fs.readFileSync(path.join(library,"notes/InstalledGatewayNote.md"),"utf8");
  assert.match(note,/Created by installed PKM Chat through the selected v5 gateway/);
  const sessionDirectory=path.join(library,".pkm/state/agent-sessions");
  const records=fs.readdirSync(sessionDirectory).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(path.join(sessionDirectory,n),"utf8")));
  const session=records.find(r=>JSON.stringify(r).includes("INSTALLED_GATEWAY_ACCEPTED"));
  assert(session,"Installed Chat must have persisted its real native Session");
  const snapshot=await vscode.commands.executeCommand("personalKnowledge.readNativeHarness","snapshot",{sessionId:session.sessionId});
  assert(snapshot&&snapshot.origin==="pkm-native");
  assert(JSON.stringify(snapshot).includes("installed-call-4"));
  const overviewEvidence=${overview
    ? "await overviewApi.runInstalledOverviewHost({base,installed,library,vscode,context:actualContext,observation:overviewObservation,requireInstalled:require})"
    : "undefined"};
  fs.writeFileSync(path.join(base,"host-evidence.json"),JSON.stringify({
   extensionMode:"Production",installedExtensionPath:installed,actualVsCodeApi:true,
   nativeMcpVerified:true,originalNote:note,nativeSession:session,harnessSnapshot:snapshot,
   ...(overviewEvidence?{taskOverview:overviewEvidence}:{})
  }));
  progress("complete");
 }catch(error){fs.writeFileSync(path.join(base,"host-failure.json"),JSON.stringify({message:error.message,stack:error.stack}));throw error}
 finally{overviewObservation?.restore()}
};
`);
    const authority = join(base, "Xauthority");
    await writeFile(authority, "");
    checked("xauth", ["-f", authority, "add", "127.0.0.1:94", "MIT-MAGIC-COOKIE-1",
      randomBytes(16).toString("hex")], { env });
    const appEnv = { ...env, DISPLAY: "127.0.0.1:94", XAUTHORITY: authority };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    display = spawn(xvfb, [":94", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-auth", authority], { env: appEnv, stdio: "ignore" });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnSync("xdpyinfo", [], { env: appEnv, stdio: "ignore" }).status === 0) { ready = true; break; }
      if (display.exitCode !== null) break;
      await wait(50);
    }
    assert(ready, "Private Xvfb did not become responsive");
    const portSocket = (await import("node:net")).createServer();
    await new Promise(done => portSocket.listen(0, "127.0.0.1", done));
    const port = portSocket.address().port;
    await new Promise(done => portSocket.close(done));
    await writeFile(join(base, "fixture.json"), JSON.stringify({ base, port }));
    app = spawn(editor, [library, "--no-sandbox", "--new-window", `--user-data-dir=${short}/u`,
      `--extensions-dir=${base}/x`, `--extensionDevelopmentPath=${short}/driver`,
      "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes",
      "--password-store=basic", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [app.stdout, app.stderr]) stream.on("data", bytes => logs.push(bytes.toString()));
    browser = spawn(browserPython, ["-B", join(here, overview ? "installed-chat-overview-browser.py"
      : "installed-compatibility-chat.py"), join(base, "fixture.json")],
      { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
    let browserOutput = "";
    for (const stream of [browser.stdout, browser.stderr]) stream.on("data", bytes => {
      browserOutput += bytes; process.stdout.write(bytes);
    });
    const deadline = Date.now() + (overview ? 360_000 : 180_000);
    while (!(await file(join(base, "host-evidence.json")))) {
      const failure = await file(join(base, "host-failure.json"));
      if (failure) throw Error(`Real installed host: ${JSON.stringify(failure)}`);
      if (browser.exitCode !== null && browser.exitCode !== 0) throw Error(`Installed browser: ${browserOutput.slice(-8000)}`);
      if (Date.now() > deadline) throw Error(`Installed acceptance timeout at ${JSON.stringify(await file(join(base, "progress.json")))}`);
      if (app.exitCode !== null && app.exitCode !== 0) throw Error(`Installed editor exited: ${logs.join("").slice(-6000)}`);
      await wait(100);
    }
    assert.deepEqual(errors, []);
    const overviewProvider = overviewModel ? await overviewModel.flush() : undefined;
    if (overviewProvider) {
      assert.deepEqual(overviewProvider.failures, []);
      assert.deepEqual(overviewProvider.pending, []);
    }
    assert(cancelled, "Actual Stop must abort the deterministic HTTP provider");
    assert(!(await readdir(library)).includes("core.sqlite"));
    const browserEvidence = await file(join(base, "browser-done.json"));
    assert(browserEvidence.namedWriteApproval && browserEvidence.harnessCheck && browserEvidence.harnessEnd && browserEvidence.cancelled);
    const hostEvidence = await file(join(base, "host-evidence.json"));
    if (chatGatewayProcess.chatId)
      assert.equal(hostEvidence.nativeSession.nativeChat.id, chatGatewayProcess.chatId);
    const accepted = hostEvidence.nativeSession.nativeChat.messages.find(message => message.content?.includes("INSTALLED_GATEWAY_ACCEPTED"));
    assert.equal(accepted.status, "complete");
    assert(accepted.toolCalls.every(call => call.status === "complete"));
    assert.deepEqual(accepted.harnessReports.at(-1).evidenceCallIds, ["installed-call-4"]);
    assert.equal(hostEvidence.nativeSession.nativeChat.messages.at(-1).status, "cancelled");
    assert.notEqual(spawnSync("git", ["-C", library, "rev-parse", "--verify", "HEAD"],
      { env, stdio: "ignore" }).status, 0, "The synthetic library must remain commit-free");
    const report = { passed: true, shippedVsixSha256: shippedSha, shippedVersion: manifest.version,
      extensionInstallation: overview ? "VS Code CLI installed explicitly pinned controlled candidate; Production activation"
        : "VS Code CLI installed unchanged shipped VSIX; Production activation",
      ...(overview ? { candidateVsixSha256: candidateSha256, taskOverview: hostEvidence.taskOverview,
        overviewProvider } : {}),
      execution: "real installed VS Code/Electron Chromium webviews, native MCP, Chat IPC and original business adapter",
      model: "deterministic loopback OpenAI-compatible SSE fixture, synthetic isolated SecretStorage token",
      isolation: "new user/network namespace, loopback only, isolated HOME/user-data/extensions/library",
      preparatoryFacade: "managed MCP manifest preprovisioning only; not the acceptance host",
      gatewayRuntimeBuild: target.runtimeBuild, actualChatGatewayProcess: chatGatewayProcess,
      storageMigrated: false, liveProfileTouched: false, fixtureGitCommits: 0,
      providerAbortedByStop: cancelled, browser: browserEvidence };
    await writeFile(join(base, "accepted.json"), JSON.stringify(report, null, 2));
    passed = true;
    console.log("INSTALLED_CHAT_GATEWAY_ACCEPTED", JSON.stringify(report));
    await writeFile(join(base, "editor.log"), logs.join(""));
  } catch (error) {
    await writeFile(join(base, "blocked.json"), JSON.stringify({ passed: false, error: String(error),
      stage: await file(join(base, "progress.json")), providerErrors: errors }, null, 2));
    throw error;
  } finally {
    await stop(browser); await stop(app); await stop(display);
    await writeFile(join(base, "editor.log"), logs.join(""));
    if (inference) { inference.closeAllConnections(); await new Promise(done => inference.close(done)); }
    await writeFile(join(base, "provider-evidence.json"), JSON.stringify(requests, null, 2));
    if (passed) for (const directory of ["h", "u", "x", "scratch", "driver", "business-python", "gateway", "offline-deps"])
      await rm(join(base, directory), { recursive: true, force: true, maxRetries: 3 });
    if (passed) for (const path of ["generate.cjs", "Xauthority", "fixture.json", "chat-ready.json", "provider-waiting.json", "library/.git"])
      await rm(join(base, path), { recursive: true, force: true });
  }
}
