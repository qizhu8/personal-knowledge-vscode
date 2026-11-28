import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
    else if (argument === "--chat-core" && !options.core) options.core = true;
    else if (argument === "--same-profile-upgrade" && !options.upgrade) options.upgrade = true;
    else if (argument === "--bundled-gateway" && !options.gateway) options.gateway = true;
    else if (argument === "--browser-transcript" && !options.transcript) options.transcript = true;
    else if (argument === "--settings-switch" && !options.settings) options.settings = true;
    else if (argument === "--native-cold-start" && !options.nativeCold) options.nativeCold = true;
    else if (argument === "--installed-browser" && !options.browser) options.browser = true;
    else if (argument.startsWith("--candidate-vsix=") && !options.candidate)
      options.candidate = resolve(argument.slice("--candidate-vsix=".length));
    else if (argument.startsWith("--candidate-sha256=") && !options.sha256)
      options.sha256 = argument.slice("--candidate-sha256=".length);
    else throw Error(`Unknown or repeated installed acceptance argument: ${argument}`);
  }
  assert(!(options.overview && options.upgrade));
  assert(!(options.core && (options.overview || options.upgrade)));
  assert(!options.gateway || options.upgrade);
  assert(!options.transcript || options.gateway);
  assert([options.settings, options.browser, options.transcript].filter(Boolean).length <= 1);
  assert(!(options.settings || options.browser) || options.gateway);
  assert(!options.nativeCold || options.settings, "Cold-start qualification requires the installed Settings lane.");
  if (options.overview || options.core || options.upgrade) assert(options.candidate && /^[a-f0-9]{64}$/.test(options.sha256),
    "Installed acceptance requires an explicitly pinned candidate VSIX.");
  else assert(!options.candidate && !options.sha256, "Candidate pins require an explicit candidate acceptance mode.");
  const editor = process.env.PKM_PROFILE_CODE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
  const xvfb = process.env.PKM_PROFILE_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
  const browserPython = checked("python3", ["-c", "import sys,playwright;print(sys.executable)"]);
  const browserCache = options.browser || options.settings ? checked(browserPython, ["-B", "-c",
    "from pathlib import Path; from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(Path(p.chromium.executable_path).parents[2]); p.stop()"]) : "";
  const businessPython = process.env.PKM_TEST_PYTHON || "/home/yuwang8/pkm-envs/personal-knowledge-vscode-dev/bin/python";
  const command = [process.execPath, fileURLToPath(import.meta.url), "--inside",
    editor, xvfb, browserPython, businessPython, options.overview ? "chat-overview" : options.core ? "chat-core" : options.upgrade ? "same-profile-upgrade" : "",
    options.candidate || "", options.sha256 || "", options.gateway ? "bundled-gateway" : "",
    options.transcript ? "browser-transcript" : options.settings ? "settings-switch" : options.browser ? "installed-browser" : "", browserCache,
    options.nativeCold ? "native-cold-start" : ""];
  const require = createRequire(import.meta.url);
  const namespace = options.upgrade
    ? require("../legacy/scripts/run-next-trial-private-display.js").privateNamespaceArgs(command)
    : ["-Urn", ...command];
  checked("unshare", namespace, { stdio: "inherit", timeout: options.overview || options.core || options.upgrade ? 480_000 : 300_000,
    env: { PATH: process.env.PATH || "" } });
} else {
  const [editor, xvfb, browserPython, businessPython, overviewMarker, candidateVsix, candidateSha256, gatewayMarker,
    transcriptMarker, browserCache, coldMarker] = process.argv.slice(3);
  const overview = overviewMarker === "chat-overview";
  const core = overviewMarker === "chat-core";
  const candidateChat = overview || core;
  const upgrade = overviewMarker === "same-profile-upgrade";
  const bundledGateway = upgrade && gatewayMarker === "bundled-gateway";
  const transcript = bundledGateway && transcriptMarker === "browser-transcript";
  const settingsSwitch = bundledGateway && transcriptMarker === "settings-switch";
  const installedBrowser = bundledGateway && transcriptMarker === "installed-browser";
  const nativeCold = settingsSwitch && coldMarker === "native-cold-start";
  let candidateVersion;
  if (upgrade) assert((await readFile("/proc/1/cmdline", "utf8")).split("\0").includes("pkm-private-init"));
  if (overviewMarker) assert((candidateChat || upgrade) && candidateVsix && /^[a-f0-9]{64}$/.test(candidateSha256));
  const vsix = candidateChat ? candidateVsix : shippedVsix;
  process.umask(0o077);
  const base = resolve(project, `.pkm-test-evidence/installed-chat-${randomUUID()}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFile(join(base, "package.json"), '{"type":"commonjs"}\n');
  console.log("INSTALLED_CHAT_EVIDENCE", base);
  let display, app, peer, browser, inference, passed = false;
  const coldPeers = [];
  const errors = [], requests = [], logs = [];
  const overviewModel = overview ? createOverviewModel({ base }) : undefined;
  try {
    assert.equal(createHash("sha256").update(await readFile(shippedVsix)).digest("hex"), shippedSha);
    if (candidateChat || upgrade) {
      assert.equal(await realpath(candidateVsix), resolve(candidateVsix));
      assert.equal(createHash("sha256").update(await readFile(candidateVsix)).digest("hex"), candidateSha256);
      const candidate = JSON.parse(checked("unzip", ["-p", candidateVsix, "extension/package.json"]));
      assert.deepEqual([candidate.publisher, candidate.name], ["Uone", "personal-knowledge"]);
      assert.match(candidate.version, /^5\.\d+\.\d+$/);
      candidateVersion = candidate.version;
    }
    for (const directory of ["h", "u/User", "x", "driver", "scratch/runtime", "offline-deps", "library/notes",
      "library/skills", "library/papers", "business-python/bin"])
      await mkdir(join(base, directory), { recursive: true, mode: 0o700 });
    process.chdir(base);
    const short = `/proc/${process.pid}/cwd`;
    const env = { PATH: process.env.PATH || "", HOME: `${short}/h`, USERPROFILE: `${short}/h`,
      TMPDIR: upgrade ? "/proc/self/cwd/scratch" : join(base, "scratch"),
      TMP: upgrade ? "/proc/self/cwd/scratch" : join(base, "scratch"),
      TEMP: upgrade ? "/proc/self/cwd/scratch" : join(base, "scratch"),
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
    assert.equal(manifest.version, candidateChat ? candidateVersion : "4.0.27");
    if (candidateVersion) env.PKM_UPGRADE_CANDIDATE_VERSION = candidateVersion;
    const wheel = join(installed, "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl");
    checked(businessPython, ["-m", "pip", "--disable-pip-version-check", "install",
      "--no-index", "--no-deps", "--target", join(base, "offline-deps"), wheel], { env });
    env.PYTHONPATH = join(base, "offline-deps");
    checked(businessPython, ["-c", "import fastmcp,prompt_manager,websockets,adaptive_skill_retrieval,cryptography;from adaptive_skill_retrieval import ContentType,RetrievalEngine,SkillDocument,academic_bm25_benchmark_route,exact_match_route"], { env });
    const library = join(base, "library"), managed = join(library, "mcp-server");
    checked("git", ["init", "--quiet", library], { env });
    const runtime = join(base, "business-python");
    await writeFile(join(runtime, "bin/python"),
      `#!/bin/sh\n${upgrade ? 'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 90; fi\n' : ""}export PYTHONPATH=${JSON.stringify(env.PYTHONPATH)}\nexec ${JSON.stringify(businessPython)} "$@"\n`,
      { mode: 0o700 });
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
    const noteText = bundledGateway ? "Created by genuine installed 4.0.27 PKM Chat."
      : "Created by installed PKM Chat through the selected v5 gateway.";
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
        if (core) {
          if (!input.tools?.length) {
            const system = input.messages?.[0]?.content;
            let reply;
            if (system?.startsWith("Extract concise, retrieval-ready User Profile fragments")) reply = '{"fragments":[]}';
            else if (system?.startsWith("Select applicable user requirements")) reply = '{"matches":[]}';
            else if (system?.includes("CURRENT user input")) reply = '{"focus":[]}';
            else if (system?.includes("Extract at most")) reply = '{"statements":[]}';
            if (reply !== undefined) {
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\n`
                + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
              return;
            }
          }
          const last = input.messages?.filter(message => message.role === "user").at(-1)?.content;
          if (typeof last === "string" && last.startsWith("CORE_")) {
            const history = input.messages.filter(message => message.role === "assistant").map(message => message.content);
            requests.push({ core: last, history });
            if (last === "CORE_FAIL") {
              response.writeHead(401, { "content-type": "application/json" });
              response.end('{"error":{"message":"Isolated Chat core authentication failure"}}');
            } else {
              if (last === "CORE_SECOND") assert(history.some(text => text?.includes("CORE_FIRST_REPLY")),
                "Second turn must include the first persisted assistant reply");
              const reply = `${last}_REPLY`;
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\n`
                + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
            }
            return;
          }
        }
        const last = input.messages.filter(message => message.role === "user").at(-1)?.content;
        if (installedBrowser && last === "INSTALLED_BROWSER_COMPLETE") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end('data: {"choices":[{"delta":{"content":"Installed browser turn completed"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          await writeFile(join(base, "browser-provider-completed"), "");
          return;
        }
        if (typeof last === "string" && last.includes("BUNDLED_GATEWAY_READBACK")) {
          const user = input.messages.findLastIndex(message => message.role === "user" && message.content === last);
          const results = input.messages.slice(user + 1).filter(message => message.role === "tool");
          await appendFile(join(base, "upgrade-milestones.jsonl"), JSON.stringify({
            at: new Date().toISOString(), name: "chat-model-round", results: results.length,
          }) + "\n");
          const sequence = [["find_vscode_tools", { query: "mcp_pkm_get_note" }],
            ["invoke_vscode_tool", { name: "mcp_pkm_get_note", input: { slug: "InstalledGatewayNote" } }]];
          const step = sequence[results.length];
          if (!step) {
            assert(results.at(-1).content.includes(noteText));
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`data: ${JSON.stringify({ choices: [{ delta: step ? { tool_calls: [{ index: 0,
            id: `bundled-call-${results.length}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
            : { content: "BUNDLED_GATEWAY_ACCEPTED" }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        requests.push({ tools: input.tools?.map(tool => tool.function.name),
          toolResults: input.messages.filter(message => message.role === "tool") });
        if (typeof last === "string" && last.includes("CANCEL_INSTALLED")) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting for actual installed Stop\n\n");
          response.on("close", () => {
            cancelled = true;
            if (installedBrowser && last === "CANCEL_INSTALLED_BROWSER") void writeFile(join(base, "browser-provider-closed"), "");
          });
          await writeFile(join(base, "provider-waiting.json"), '{"waiting":true}');
          if (installedBrowser && last === "CANCEL_INSTALLED_BROWSER")
            await writeFile(join(base, "browser-provider-waiting"), "");
          return;
        }
        const sequence = [
          ["find_vscode_tools", { query: "mcp_pkm_add_note" }],
          ["invoke_vscode_tool", { name: "mcp_pkm_add_note", input: { title: "InstalledGatewayNote",
            content: noteText } }],
          ["record_harness", { kind: "validation", stepId: "installed-readback", status: "start",
            summary: "Read the original Note after the approved installed Chat write" }],
          ["find_vscode_tools", { query: "mcp_pkm_get_note" }],
          ["invoke_vscode_tool", { name: "mcp_pkm_get_note", input: { slug: "InstalledGatewayNote" } }],
          ["record_harness", { kind: "validation", stepId: "installed-readback", status: "complete",
            summary: "Installed Note readback confirms the requested content", evidenceCallIds: ["installed-call-4"] }],
        ].slice(0, bundledGateway ? 2 : undefined);
        const results = requests.at(-1).toolResults, count = results.length, step = sequence[count];
        if (count === 2) assert(!JSON.parse(results.at(-1).content).error,
          `Actual approved Note write failed: ${results.at(-1).content.slice(0, 2000)}`);
        if (count === 2 && !bundledGateway && !candidateChat) await captureChatGateway();
        if (step) assert(input.tools.some(tool => tool.function.name === step[0]), `Missing actual Chat tool ${step[0]}`);
        if (count === 5) assert(results.at(-1).content.includes(noteText));
        if (!step && !bundledGateway) assert.match(results.at(-1).content, /"ok":true/);
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
 ${core ? `
 const finishCore=async(initial)=>{
  const coreDeadline=Date.now()+180000;
  while(!fs.existsSync(path.join(base,"chat-core-done.json"))&&Date.now()<coreDeadline)await new Promise(r=>setTimeout(r,100));
  assert(fs.existsSync(path.join(base,"chat-core-done.json")),"Installed core Chat journey did not finish");
  const coreEvidence=JSON.parse(fs.readFileSync(path.join(base,"chat-core-done.json"),"utf8"));
  const coreRoot=path.join(library,".pkm/state/api-chats");
  const coreRecords=fs.readdirSync(coreRoot,{recursive:true}).filter(n=>n.endsWith(".json"))
    .map(n=>JSON.parse(fs.readFileSync(path.join(coreRoot,n),"utf8")));
  const coreChat=coreRecords.find(r=>r.id===coreEvidence.chatId);
  assert(coreChat,"Core Chat must be persisted in the actual Knowledge Root");
  for(const marker of ["CORE_FIRST_REPLY","CORE_SECOND_REPLY","CORE_RECOVER_REPLY"])
    assert(coreChat.messages.some(m=>m.content.includes(marker)&&m.status==="complete"),marker);
  assert(coreChat.messages.some(m=>m.status==="failed"),"Failed turn must remain honest in saved history");
  assert.notEqual(initial.extensionHostPid,process.pid,"Core acceptance requires a real restarted extension host");
  fs.writeFileSync(path.join(base,"host-evidence.json"),JSON.stringify({...initial,coreChat:{...coreEvidence,reloadedExtensionHostPid:process.pid}}));
  progress("complete");
 };
 ` : ""}
 let overviewObservation,overviewApi;
 try{
  const extension=vscode.extensions.getExtension("uone.personal-knowledge");
  ${core ? `
  const initialPath=path.join(base,"chat-core-initial-host.json");
  if(fs.existsSync(initialPath)){
   assert(extension);
   assert.equal(fs.realpathSync(extension.extensionPath),installed);
   await extension.activate();
   await finishCore(JSON.parse(fs.readFileSync(initialPath,"utf8")));
   return;
  }
  ` : ""}
  assert(extension&&!extension.isActive,"Installed extension must be captured before its real activation");
  assert.equal(fs.realpathSync(extension.extensionPath),installed);
  ${overview ? `
  overviewApi=await import(${JSON.stringify(new URL("./installed-chat-overview.mjs", import.meta.url).href)});
  overviewObservation=overviewApi.observeInstalledChatRegistration(installed,require);` : ""}
  const main=require(path.join(installed,${JSON.stringify(manifest.main)})),activate=main.activate;
  let actualContext;
  main.activate=async function(context,...args){
   actualContext=context;assert.equal(context.extensionMode,vscode.ExtensionMode.Production);
   ${bundledGateway || candidateChat ? "" : 'await context.globalState.update("pkm.mcpHotSwitchEnabled.v1",true);'}
   await context.secrets.store("personalKnowledge.aiApiKey","isolated-installed-provider");
   return activate.call(this,context,...args);
  };
  progress("activating-installed-extension");
  try{await extension.activate()}finally{main.activate=activate}
  assert(actualContext&&extension.isActive);
  assert(fs.realpathSync(actualContext.globalStorageUri.fsPath).startsWith(path.join(base,"u")));
  progress("starting-native-managed");
  const original=await vscode.commands.executeCommand("personalKnowledge.startPkmMcp");
  ${bundledGateway || candidateChat ? `
  const native=await vscode.lm.invokeTool("mcp_pkm_check_version",{input:{}},undefined);
  const live=JSON.parse(native.content.map(part=>part.value??"").join(""));
  ${candidateChat ? `assert.equal(live.dispatchMode,"original");
  assert.equal(live.originalConnection.attribution.source,"vscode-provider");` : ""}
  fs.writeFileSync(path.join(base,"native.json"),JSON.stringify({original:{runtime:live}}));
  ` : `progress("selecting-v5-gateway");
  const switched=await vscode.commands.executeCommand("personalKnowledge.switchMcpRuntime",${JSON.stringify(stage.targetPath)});
  assert.equal(switched.runtime.version,"0.1.0");
  const verified=await vscode.commands.executeCommand("personalKnowledge.verifyMcpRuntime");
  assert.equal(verified.runtime.version,"0.1.0");
  fs.writeFileSync(path.join(base,"native.json"),JSON.stringify({original,switched,verified}));`}
  progress("opening-installed-chat");
  await vscode.commands.executeCommand("personalKnowledge.openApiChat");
  fs.writeFileSync(path.join(base,"chat-ready.json"),'{"ready":true}');
  progress("browser-chat-and-harness");
  const deadline=Date.now()+120000;
  while(!fs.existsSync(path.join(base,"browser-done.json"))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert(fs.existsSync(path.join(base,"browser-done.json")),"Installed browser acceptance did not finish");
  const note=fs.readFileSync(path.join(library,"notes/InstalledGatewayNote.md"),"utf8");
  assert(note.includes(${JSON.stringify(noteText)}));
  ${bundledGateway ? `
  const chatRoot=path.join(library,".pkm/state/api-chats");
  const records=fs.readdirSync(chatRoot,{recursive:true}).filter(n=>n.endsWith(".json"))
    .map(n=>JSON.parse(fs.readFileSync(path.join(chatRoot,n),"utf8")));
  const session={nativeChat:records.find(r=>JSON.stringify(r).includes("INSTALLED_GATEWAY_ACCEPTED"))};
  assert(session.nativeChat?.id,"Installed predecessor must persist its Chat");
  const snapshot=undefined;
  ` : `const sessionDirectory=path.join(library,".pkm/state/agent-sessions");
  const records=fs.readdirSync(sessionDirectory).filter(n=>n.endsWith(".json")).map(n=>JSON.parse(fs.readFileSync(path.join(sessionDirectory,n),"utf8")));
  const session=records.find(r=>JSON.stringify(r).includes("INSTALLED_GATEWAY_ACCEPTED"));
  assert(session,"Installed Chat must have persisted its real native Session");
  const snapshot=await vscode.commands.executeCommand("personalKnowledge.readNativeHarness","snapshot",{sessionId:session.sessionId});
  assert(snapshot&&snapshot.origin==="pkm-native");
  assert(JSON.stringify(snapshot).includes("installed-call-4"));`}
  const overviewEvidence=${overview
    ? "await overviewApi.runInstalledOverviewHost({base,installed,library,vscode,context:actualContext,observation:overviewObservation,requireInstalled:require})"
    : "undefined"};
  const initialEvidence={
   extensionMode:"Production",installedExtensionPath:installed,actualVsCodeApi:true,extensionHostPid:process.pid,
   nativeMcpVerified:true,originalNote:note,nativeSession:session,harnessSnapshot:snapshot,
   ...(overviewEvidence?{taskOverview:overviewEvidence}:{})
  };
  ${core ? `
  fs.writeFileSync(initialPath,JSON.stringify(initialEvidence));
  await finishCore(initialEvidence);
  ` : 'fs.writeFileSync(path.join(base,"host-evidence.json"),JSON.stringify(initialEvidence));'}
  progress("complete");
  ${upgrade ? `while(!fs.existsSync(path.join(base,"close-predecessor")))await new Promise(r=>setTimeout(r,200));
  await vscode.commands.executeCommand("workbench.action.closeWindow");` : ""}
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
    const launchArgs = [library, "--no-sandbox", "--new-window", `--user-data-dir=${short}/u`,
      `--extensions-dir=${base}/x`, `--extensionDevelopmentPath=${short}/driver`,
      "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes",
      "--password-store=basic", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"];
    app = spawn(editor, launchArgs, { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [app.stdout, app.stderr]) stream.on("data", bytes => logs.push(bytes.toString()));
    browser = spawn(browserPython, ["-B", join(here, core ? "installed-chat-core-browser.py" : overview ? "installed-chat-overview-browser.py"
      : "installed-compatibility-chat.py"), join(base, "fixture.json"), ...(bundledGateway ? ["--populate"] : [])],
      { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
    let browserOutput = "";
    for (const stream of [browser.stdout, browser.stderr]) stream.on("data", bytes => {
      browserOutput += bytes; process.stdout.write(bytes);
    });
    const deadline = Date.now() + (candidateChat ? 360_000 : 180_000);
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
    if (core) assert.deepEqual(requests.filter(request => request.core).map(request => request.core),
      ["CORE_FIRST", "CORE_SECOND", "CORE_FAIL", "CORE_RECOVER"],
      "Core Chat must issue each requested turn exactly once, including the failed turn");
    if (overviewProvider) {
      assert.deepEqual(overviewProvider.failures, []);
      assert.deepEqual(overviewProvider.pending, []);
    }
    if (!bundledGateway) assert(cancelled, "Actual Stop must abort the deterministic HTTP provider");
    assert(!(await readdir(library)).includes("core.sqlite"));
    const browserEvidence = await file(join(base, "browser-done.json"));
    assert(browserEvidence.namedWriteApproval);
    if (!bundledGateway) assert(browserEvidence.harnessCheck && browserEvidence.harnessEnd && browserEvidence.cancelled);
    const hostEvidence = await file(join(base, "host-evidence.json"));
    if (chatGatewayProcess?.chatId)
      assert.equal(hostEvidence.nativeSession.nativeChat.id, chatGatewayProcess.chatId);
    const accepted = hostEvidence.nativeSession.nativeChat.messages.find(message => message.content?.includes("INSTALLED_GATEWAY_ACCEPTED"));
    assert.equal(accepted.status, "complete");
    assert(accepted.toolCalls.every(call => call.status === "complete"));
    if (!bundledGateway) {
      assert.deepEqual(accepted.harnessReports.at(-1).evidenceCallIds, ["installed-call-4"]);
      assert.equal(hostEvidence.nativeSession.nativeChat.messages.at(-1).status, "cancelled");
    }
    assert.notEqual(spawnSync("git", ["-C", library, "rev-parse", "--verify", "HEAD"],
      { env, stdio: "ignore" }).status, 0, "The synthetic library must remain commit-free");
    let upgradeEvidence, coldStartEvidence;
    if (upgrade) {
      const { original, verified } = await file(join(base, "native.json"));
      assert.match(original.runtime.runtime.runtimeBuild, /^[0-9a-f]{64}$/);
      if (!bundledGateway) assert.equal(verified.runtime.runtime.runtimeBuild, target.runtimeBuild);
      const settings = join(base, "u/User/settings.json");
      const [oldRoot, oldSettings] = await Promise.all([stat(library), readFile(settings, "utf8")]);
      await writeFile(join(base, "close-predecessor"), "");
      const shutdownDeadline = Date.now() + 40_000;
      while (app.exitCode === null && app.signalCode === null && Date.now() < shutdownDeadline) await wait(100);
      assert.equal(app.exitCode, 0, "Predecessor must close normally before installation.");
      const oldClients = () => checked("ps", ["-eo", "args="], { env }).split("\n")
        .some(line => line.includes(target.entry.path) || line.includes(join(managed, "server.py")));
      while (oldClients() && Date.now() < shutdownDeadline) await wait(100);
      assert(!oldClients(),
        "A fixture gateway or Original MCP is still alive; do not install the candidate.");
      if (installedBrowser) {
        // The predecessor can leave its detached retrieval worker alive with
        // the empty pre-Note corpus. Only retire this fixture-owned endpoint,
        // after its only Workbench and old clients have exited.
        const retrieval = join(base, "u/User/globalStorage/uone.personal-knowledge/retrieval");
        const workers = (await Promise.all((await readdir(retrieval)).map(async key =>
          /^[a-f0-9]{16}$/.test(key) ? file(join(retrieval, key, "worker.json")).then(endpoint =>
            endpoint && { ...endpoint, state: join(retrieval, key) }) : null))).filter(Boolean);
        assert(workers.length <= 1, "Ambiguous private predecessor retrieval worker");
        if (workers.length) {
          const { pid, port, token, state } = workers[0];
          assert(Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(port) && port > 0 && port < 65536 && typeof token === "string");
          const processArgs = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(error => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          if (processArgs) {
            const args = processArgs.split("\0");
            const scriptIndex = args.findIndex(arg => arg.endsWith("/retrieval_worker.py"));
            const script = scriptIndex < 0 ? "" : await realpath(args[scriptIndex].replace("/proc/self/", `/proc/${pid}/`));
            const stateArg = script && await realpath(args[scriptIndex + 1].replace("/proc/self/", `/proc/${pid}/`));
            assert(script.startsWith(`${state}/runtimes/`) && stateArg === state &&
              (await readFile(script)).equals(await readFile(join(installed, "resources/retrieval_worker.py"))),
              "Unexpected predecessor retrieval process in private namespace");
            const shutdown = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST",
              headers: { "X-PKM-Retrieval-Token": token }, redirect: "error", signal: AbortSignal.timeout(5000) });
            assert(shutdown.ok && (await shutdown.json()).ok, "Private predecessor retrieval worker declined retirement");
            const retired = Date.now() + 15000;
            while (await stat(`/proc/${pid}`).catch(() => undefined) && Date.now() < retired) await wait(100);
            assert(!(await stat(`/proc/${pid}`).catch(() => undefined)), "Private predecessor retrieval worker did not exit");
          }
        }
      }
      await writeFile(join(base, "driver/accept.cjs"),
        await readFile(join(here, settingsSwitch ? "installed-settings-switch-host.cjs" : "installed-compatible-upgrade-host.cjs"), "utf8"));
      checked(cli, ["--no-sandbox", `--user-data-dir=${base}/u`, `--extensions-dir=${base}/x`,
        "--install-extension", candidateVsix, "--force"], { env });
      if (transcript) {
        const installed = join(base, "x", `uone.personal-knowledge-${candidateVersion}`);
        const manifest = await file(join(installed, "package.json"));
        assert.deepEqual([manifest.publisher, manifest.name, manifest.version], ["Uone", "personal-knowledge", candidateVersion]);
        // The restored sidebar can activate the installed extension before the driver.
        // Only capture the actual shell return; leave authority, storage and consent unmodified.
        const shell = join(installed, "dist/chat/api-chat-shell.js");
        const original = await readFile(shell, "utf8");
        await writeFile(shell, original + `
const fixtureRegister = exports.registerApiChatShell;
exports.registerApiChatShell = (...args) => {
    const shell = fixtureRegister(...args);
    if (process.env.PKM_UPGRADE_TRANSCRIPT === "1") globalThis[Symbol.for("pkm.test.captureOriginalChatShell")] = shell;
    return shell;
};
`);
      }
      if (nativeCold) {
        process.env.HOME = env.HOME;
        assert(!await file(join(library, ".pkm/state/compatibility-gateway/owner-pending.json")),
          "Cold-start qualification must begin without an existing native owner.");
        const { withPkmServiceNativeAdmission } = createRequire(import.meta.url)(
          join(base, "x", `uone.personal-knowledge-${candidateVersion}`, "dist/runtime/pkm-service.js"));
        await withPkmServiceNativeAdmission({
          knowledgeRoot: library, globalStoragePath: join(base, "u/User/globalStorage/uone.personal-knowledge"),
          extensionVersion: candidateVersion,
        }, async drain => { await drain(); });
        for (const id of ["first", "second", "third"]) {
          const profile = join(base, "cold", id);
          await mkdir(join(profile, "User"), { recursive: true, mode: 0o700 });
          await writeFile(join(profile, "User/settings.json"), oldSettings);
        }
        const startedAt = Date.now();
        for (const id of ["first", "second", "third"]) {
          const child = spawn(editor, launchArgs.filter(arg =>
            !arg.startsWith("--user-data-dir=") && !arg.startsWith("--remote-debugging-"))
            .concat(`--user-data-dir=${short}/cold/${id}`), {
            env: { ...appEnv, PKM_UPGRADE_BASE: base, PKM_COLD_WINDOW: id }, stdio: ["ignore", "pipe", "pipe"],
          });
          coldPeers.push(child);
          for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => logs.push(bytes.toString()));
        }
        const deadline = Date.now() + 180_000;
        let receipts;
        while (true) {
          const failure = await file(join(base, "upgrade-failure.json"));
          if (failure) throw Error(`Installed cold startup: ${JSON.stringify(failure)}`);
          receipts = await Promise.all(["first", "second", "third"].map(id => file(join(base, `native-cold-${id}.json`))));
          if (receipts.every(Boolean)) break;
          assert(Date.now() < deadline && coldPeers.every(child => child.exitCode === null && child.signalCode === null),
            "Three installed windows did not reach automatic live-tools readiness.");
          await wait(100);
        }
        assert.equal(new Set(receipts.map(receipt => receipt.hostPid)).size, 3);
        assert(receipts.every(receipt => receipt.explicitStartExecuted === false && receipt.automaticReady === true));
        assert.equal(new Set(receipts.flatMap(receipt => ["native", "chat"].map(role =>
          receipt.observed[role].originalConnection.instanceId))).size, 6);
        const owner = await file(join(library, ".pkm/state/compatibility-gateway/owner-live.json"));
        assert.equal(owner.independentService, true);
        coldStartEvidence = { startedAt, completedAt: Date.now(), ownerPid: owner.process.pid, receipts };
        for (let index = 0; index < coldPeers.length; index++) {
          const id = ["first", "second", "third"][index], child = coldPeers[index];
          await writeFile(join(base, `close-native-cold-${id}`), "");
          const deadline = Date.now() + 40_000;
          while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(100);
          assert.equal(child.exitCode, 0, "Each installed cold window must quit normally.");
        }
        const retired = Date.now() + 40_000;
        while (await file(join(library, ".pkm/state/compatibility-gateway/owner-pending.json")) && Date.now() < retired)
          await wait(100);
        assert(!await file(join(library, ".pkm/state/compatibility-gateway/owner-pending.json")),
          "The final installed cold window must retire native custody cleanly.");
        await Promise.all(["first", "second", "third"].map(id => withPkmServiceNativeAdmission({
          knowledgeRoot: library, globalStoragePath: join(base, "cold", id, "User/globalStorage/uone.personal-knowledge"),
          extensionVersion: candidateVersion,
        }, async drain => { await drain(); })));
        coldStartEvidence.cleanFinalRetirement = true;
        await writeFile(join(base, "native-cold-start.json"), JSON.stringify(coldStartEvidence));
      }
      app = spawn(editor, launchArgs, {
        env: { ...appEnv, PKM_UPGRADE_BASE: base, PKM_UPGRADE_CHAT: hostEvidence.nativeSession.nativeChat.id,
          PKM_UPGRADE_GATEWAY: bundledGateway ? "1" : "0", PKM_UPGRADE_TRANSCRIPT: transcript ? "1" : "0",
          PKM_UPGRADE_BROWSER: installedBrowser ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [app.stdout, app.stderr]) stream.on("data", bytes => logs.push(bytes.toString()));
      if (transcript || settingsSwitch) {
        browser = spawn(browserPython, ["-B", join(here, settingsSwitch ? "installed-settings-switch.py" : "installed-compatibility-chat.py"),
          join(base, "fixture.json"), ...(transcript ? ["--transcript-consent"] : [])],
          { env: settingsSwitch ? { ...appEnv, PLAYWRIGHT_BROWSERS_PATH: browserCache } : appEnv, stdio: "inherit" });
      }
      if (installedBrowser) {
        browser = spawn(browserPython, ["-B", join(here, "installed-original-browser.py"), join(base, "fixture.json")],
          { env: { ...appEnv, PLAYWRIGHT_BROWSERS_PATH: browserCache }, stdio: "inherit" });
      }
      const candidateDeadline = Date.now() + (installedBrowser ? 240_000 : settingsSwitch ? 180_000 : 100_000);
      while (!(upgradeEvidence = await file(join(base, settingsSwitch ? "installed-settings-switch.json" : "upgrade-host.json")))) {
        const failure = await file(join(base, "upgrade-failure.json"));
        if (failure) throw Error(`Installed upgrade host: ${JSON.stringify(failure)}`);
        if ((installedBrowser || settingsSwitch) && browser.exitCode !== null && browser.exitCode !== 0)
          throw Error("Installed browser driver failed.");
        if (app.exitCode !== null || app.signalCode !== null || Date.now() > candidateDeadline)
          throw Error("Candidate did not verify the live native pkm connection.");
        await wait(100);
      }
      if (settingsSwitch) {
        upgradeEvidence.candidateVsixSha256 = candidateSha256;
        upgradeEvidence.candidateVersion = candidateVersion;
        const ownerFile = join(library, ".pkm/state/compatibility-gateway/owner-pending.json");
        const owner = await readFile(ownerFile, "utf8");
        const rendezvousFile = join(library, ".pkm/state/compatibility-gateway/owner-live.json");
        const rendezvous = await readFile(rendezvousFile, "utf8");
        assert.equal(JSON.parse(rendezvous).independentService, true);
        await mkdir(join(base, "peer/User"), { recursive: true, mode: 0o700 });
        await writeFile(join(base, "peer/User/settings.json"), oldSettings);
        const peerSocket = (await import("node:net")).createServer();
        await new Promise(done => peerSocket.listen(0, "127.0.0.1", done));
        const peerPort = peerSocket.address().port;
        await new Promise(done => peerSocket.close(done));
        await writeFile(join(base, "peer-fixture.json"), JSON.stringify({ base, port: peerPort }));
        peer = spawn(editor, launchArgs.filter(arg => !arg.startsWith("--user-data-dir=") && !arg.startsWith("--remote-debugging-"))
          .concat(`--user-data-dir=${short}/peer`, `--remote-debugging-port=${peerPort}`, "--remote-debugging-address=127.0.0.1"), {
          env: { ...appEnv, PKM_UPGRADE_BASE: base, PKM_SWITCH_PEER: "1" }, stdio: ["ignore", "pipe", "pipe"],
        });
        for (const stream of [peer.stdout, peer.stderr]) stream.on("data", bytes => logs.push(bytes.toString()));
        browser = spawn(browserPython, ["-B", join(here, "installed-settings-peer-departure.py"), join(base, "peer-fixture.json")],
          { env: { ...appEnv, PLAYWRIGHT_BROWSERS_PATH: browserCache }, stdio: "inherit" });
        const peerDeadline = Date.now() + 180_000;
        let admitted;
        while (!(admitted = await file(join(base, "settings-peer-admitted.json")))) {
          const failure = await file(join(base, "settings-peer-failure.json"));
          if (failure) throw Error(`Installed second window: ${JSON.stringify(failure)}`);
          if (peer.exitCode !== null || peer.signalCode !== null || Date.now() > peerDeadline)
            throw Error("Installed second window did not verify its managed admission.");
          await wait(100);
        }
        assert.notEqual(admitted.hostPid, upgradeEvidence.hostPid);
        assert.equal(admitted.nativeStartAdmitted, true);
        assert.equal(await readFile(ownerFile, "utf8"), owner);
        while (!(await file(join(base, "settings-owner-after-peer.json")))) {
          const failure = await file(join(base, "upgrade-failure.json"));
          if (failure) throw Error(`Original installed owner: ${JSON.stringify(failure)}`);
          if (Date.now() > peerDeadline) throw Error("The original owner did not verify continuity while the second window was open.");
          await wait(100);
        }
        await writeFile(join(base, "close-settings-candidate"), "");
        const closeDeadline = Date.now() + 40_000;
        while (app.exitCode === null && app.signalCode === null && Date.now() < closeDeadline) await wait(100);
        assert.equal(app.exitCode, 0, "Initiating Settings window must close normally while its peer stays open.");
        let departure;
        while (!(departure = await file(join(base, "settings-peer-owner-departure.json")))) {
          const failure = await file(join(base, "settings-peer-failure.json"));
          if (failure) throw Error(`Surviving installed window: ${JSON.stringify(failure)}`);
          if (browser.exitCode !== null && browser.exitCode !== 0) throw Error("Surviving installed Settings driver failed.");
          assert(peer.exitCode === null && peer.signalCode === null && Date.now() < peerDeadline,
            "Surviving installed window did not verify both backends after initiating-window exit.");
          await wait(100);
        }
        assert.equal(departure.peerRemainedOperational, true);
        assert.equal(departure.bothBackendsRead, true);
        assert.equal(departure.identitiesPreserved, true);
        assert.equal(await readFile(ownerFile, "utf8"), owner);
        assert.equal(await readFile(rendezvousFile, "utf8"), rendezvous);
        await writeFile(join(base, "close-settings-peer"), "");
        while (peer.exitCode === null && peer.signalCode === null && Date.now() < peerDeadline) await wait(100);
        assert.equal(peer.exitCode, 0, "Managed peer must close normally.");
        upgradeEvidence.peer = { ...admitted, ownerDeparture: departure };
        assert.equal(await readFile(join(library, "notes/InstalledGatewayNote.md"), "utf8"), hostEvidence.originalNote);
        assert.equal(await readFile(settings, "utf8"), oldSettings);
        assert.equal((await stat(library)).ino, oldRoot.ino);
        await assert.rejects(stat(join(library, ".pkm/state/compatibility-gateway/owner-pending.json")), { code: "ENOENT" });
      } else {
      assert.notEqual(upgradeEvidence.liveBuild, original.runtime.runtime.runtimeBuild);
      if (!bundledGateway) assert.notEqual(upgradeEvidence.liveBuild, target.runtimeBuild);
      if (bundledGateway) {
        const clients = await file(join(base, "upgrade-gateway-clients.json"));
        assert.deepEqual(clients.chat.gateway, { generation: upgradeEvidence.generation, runtimeBuild: upgradeEvidence.liveBuild });
        upgradeEvidence.clients = clients;
        if (transcript) upgradeEvidence.transcript = await file(join(base, "upgrade-transcript.json"));
        if (installedBrowser) {
          upgradeEvidence.browser = await file(join(base, "upgrade-browser.json"));
          assert.equal(upgradeEvidence.browser?.predecessorNoteSearchReadOnly, true, "Browser must find the real predecessor Note");
          assert.equal(upgradeEvidence.browser?.nativeSendAndStopAfterReload, true, "Browser must complete and stop real native Chat turns");
          assert.equal(upgradeEvidence.browser?.fixtureProviderAborted, true, "Stop must close the fixture provider stream");
        }
        assert.equal(await readFile(join(library, "notes/InstalledGatewayNote.md"), "utf8"), hostEvidence.originalNote);
        assert.deepEqual(errors, []);
        await writeFile(join(base, "close-candidate"), "");
        const closeDeadline = Date.now() + 40_000;
        while (app.exitCode === null && app.signalCode === null && Date.now() < closeDeadline) await wait(100);
        assert.equal(app.exitCode, 0, "Candidate must close normally before restart.");
        const gatewayAlive = () => checked("ps", ["-eo", "args="], { env }).split("\n").some(line =>
          line.includes(join(base, "x")) && line.includes("/compatibility-mcp-cli.js"));
        while ((oldClients() || gatewayAlive()) && Date.now() < closeDeadline) await wait(100);
        assert(!oldClients() && !gatewayAlive(), "Prior stdio clients must exit before restart.");
        if (installedBrowser) {
          browser = spawn(browserPython, ["-B", join(here, "installed_https_detached.py"),
            join(base, "https-detached-enrollment.json")],
          { env: { ...appEnv, PLAYWRIGHT_BROWSERS_PATH: browserCache }, stdio: "inherit" });
          const detachedDeadline = Date.now() + 90_000;
          while (browser.exitCode === null && browser.signalCode === null && Date.now() < detachedDeadline) await wait(100);
          assert.equal(browser.exitCode, 0, "Native-provisioned HTTPS must work after the actual Workbench exits.");
          upgradeEvidence.browser.detached = await file(join(base, "https-detached.json"));
          assert.equal(upgradeEvidence.browser.detached?.actualNativeHostExited, true);
        }
        app = spawn(editor, launchArgs, { env: { ...appEnv, PKM_UPGRADE_BASE: base,
          PKM_UPGRADE_GATEWAY: "1", PKM_UPGRADE_RESTART: "1" }, stdio: ["ignore", "pipe", "pipe"] });
        for (const stream of [app.stdout, app.stderr]) stream.on("data", bytes => logs.push(bytes.toString()));
        const restartDeadline = Date.now() + 60_000;
        while (!(upgradeEvidence.restart = await file(join(base, "upgrade-restart.json")))) {
          const failure = await file(join(base, "upgrade-failure.json"));
          if (failure) throw Error(`Installed restart: ${JSON.stringify(failure)}`);
          assert(Date.now() < restartDeadline && app.exitCode === null, "Candidate restart did not verify native Note read.");
          await wait(100);
        }
        assert.equal(upgradeEvidence.restart.build, upgradeEvidence.liveBuild);
        assert.notEqual(upgradeEvidence.restart.instance, upgradeEvidence.instance);
        assert.equal(upgradeEvidence.restart.generation, upgradeEvidence.generation,
          "Restart must retain the configured Original runtime generation");
        assert.notEqual(upgradeEvidence.restart.routeGeneration, upgradeEvidence.routeGeneration,
          "Restart must establish a fresh gateway authority generation");
      }
      }
      assert.equal(await readFile(settings, "utf8"), oldSettings);
      const newRoot = await stat(library);
      assert.deepEqual([newRoot.dev, newRoot.ino], [oldRoot.dev, oldRoot.ino]);
      upgradeEvidence = { ...upgradeEvidence, predecessorBuild: original.runtime.runtime.runtimeBuild,
        predecessorGatewayBuild: bundledGateway ? null : target.runtimeBuild,
        candidateVsixSha256: candidateSha256, sameRootAndSettings: true,
        ...(nativeCold ? { coldStart: coldStartEvidence } : {}) };
    }
    const report = { passed: true, shippedVsixSha256: shippedSha, shippedVersion: "4.0.27",
      extensionInstallation: candidateChat ? "VS Code CLI installed explicitly pinned controlled candidate; Production activation"
        : "VS Code CLI installed unchanged shipped VSIX; Production activation",
      ...(candidateChat ? { candidateVsixSha256: candidateSha256, candidateVersion: manifest.version,
        ...(overview ? { taskOverview: hostEvidence.taskOverview, overviewProvider } : { coreChat: hostEvidence.coreChat }) } : {}),
      ...(upgrade ? { upgrade: upgradeEvidence } : {}),
      execution: "real installed VS Code/Electron Chromium webviews, native MCP, Chat IPC and original business adapter",
      model: "deterministic loopback OpenAI-compatible SSE fixture, synthetic isolated SecretStorage token",
      isolation: "new user/network namespace, loopback only, isolated HOME/user-data/extensions/library",
      preparatoryFacade: "managed MCP manifest preprovisioning only; not the acceptance host",
      gatewayRuntimeBuild: settingsSwitch ? upgradeEvidence.v5.native.runtime.runtimeBuild
        : candidateChat ? (await file(join(base,"native.json"))).original.runtime.runtime.runtimeBuild
        : bundledGateway ? upgradeEvidence.liveBuild : target.runtimeBuild,
      actualChatGatewayProcess: chatGatewayProcess,
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
    await stop(browser); await stop(peer); await Promise.all(coldPeers.map(stop)); await stop(app); await stop(display);
    await writeFile(join(base, "editor.log"), logs.join(""));
    if (inference) { inference.closeAllConnections(); await new Promise(done => inference.close(done)); }
    await writeFile(join(base, "provider-evidence.json"), JSON.stringify(requests, null, 2));
    await rm(join(base, "browser-enrollment.json"), { force: true });
    if (passed) for (const directory of ["h", "u", "peer", "cold", "x", "scratch", "driver", "business-python", "gateway", "offline-deps"])
      await rm(join(base, directory), { recursive: true, force: true, maxRetries: 3 });
    if (passed) for (const path of ["generate.cjs", "Xauthority", "fixture.json", "chat-ready.json", "provider-waiting.json", "library/.git"])
      await rm(join(base, path), { recursive: true, force: true });
  }
}
