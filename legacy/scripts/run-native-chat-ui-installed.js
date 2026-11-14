#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const project = path.resolve(__dirname, "..");
const value = key => process.argv.find(argument => argument.startsWith(`--${key}=`))?.slice(key.length + 3);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  const baseline = value("legacy-vsix"), candidate = value("candidate-vsix");
  const chatWorkerJourney = process.argv.includes("--chat-worker-managed");
  const chatWorkflows = process.argv.includes("--chat-workflows");
  const chatMemory = process.argv.includes("--chat-memory");
  const recipeUpgradeProbe = process.argv.includes("--recipe-upgrade-probe");
  const recipeLazy = process.argv.includes("--chat-recipe-lazy");
  const recipePython = process.argv.includes("--chat-recipe-python");
  const recipeKnowledge = process.argv.includes("--chat-recipe-knowledge");
  const recipeReports = process.argv.includes("--chat-recipe-reports");
  const recipeBranches = process.argv.includes("--chat-recipe-branches");
  const recipeReflectionGates = process.argv.includes("--chat-recipe-reflection-gates");
  if (recipeReflectionGates && (recipeBranches || recipeReports || recipeKnowledge || recipeLazy || recipePython))
    throw new Error("Reflection/Gate/raw ports require their own original→candidate installed profile.");
  if (recipeBranches && (recipeReports || recipeKnowledge || recipeLazy || recipePython))
    throw new Error("Static Recipe branches require their own original→candidate installed profile.");
  if (recipeReports && (recipeKnowledge || recipeLazy || recipePython))
    throw new Error("External Recipe reports require their own original→candidate installed profile.");
  if (recipeKnowledge && (recipeLazy || recipePython))
    throw new Error("Knowledge/history qualification uses its own profile, not lazy/Python evidence.");
  if (recipePython && recipeLazy) throw new Error("Python public full-graph and legacy lazy qualification use separate profiles.");
  const legacyRecipeLazyProbe = process.argv.includes("--legacy-recipe-lazy-probe");
  if (legacyRecipeLazyProbe && !process.argv.includes("--probe-only"))
    throw new Error("Actual old execution comparison must remain a separate probe-only profile; its usage is not admitted for takeover.");
  const recipePublic = process.argv.includes("--chat-recipe-public") || recipeLazy || recipePython || recipeKnowledge || recipeReports || recipeBranches || recipeReflectionGates;
  const recipeLibrary = process.argv.includes("--chat-recipe-library") || recipePublic;
  const chatRecipe = process.argv.includes("--chat-recipe") || recipeLibrary;
  const recipeJourney = recipeUpgradeProbe || chatRecipe || legacyRecipeLazyProbe;
  if (recipeUpgradeProbe && chatRecipe) throw new Error("Historical refusal probe and current Recipe journey are distinct.");
  if (recipeJourney && (!chatWorkerJourney || !candidate || chatMemory || chatWorkflows
    || process.argv.includes("--chat-task-controls") || process.argv.includes("--native-protocol-only")))
    throw new Error("Recipe upgrade probe requires a distinct actual legacy UI managed same-root install; it is not native Recipe qualification.");
  if (chatMemory && !chatWorkerJourney) throw new Error("Memory requires the full managed same-root installed journey.");
  if (chatMemory && (chatWorkflows || process.argv.includes("--chat-task-controls") || process.argv.includes("--native-protocol-only")))
    throw new Error("Memory is a separate genuine-old-UI qualification, not a workflow/controller probe.");
  const taskControls = process.argv.includes("--chat-task-controls") || chatWorkflows;
  if (taskControls && !chatWorkerJourney) throw new Error("Task controls require the full managed same-root installed journey.");
  const chatWorkerProbe = process.argv.includes("--chat-worker-probe") || chatWorkerJourney;
  if (chatWorkerJourney && (!process.argv.includes("--legacy-ui-same-root") || process.argv.includes("--probe-only") && !legacyRecipeLazyProbe))
    throw new Error("The managed worker journey requires actual legacy UI same-root adoption, not probe-only.");
  if (chatWorkerProbe && !chatWorkerJourney && !process.argv.includes("--probe-only"))
    throw new Error("Old Chat worker discovery currently requires --probe-only; it is not native migration qualification.");
  if (process.platform !== "linux" || !baseline || !path.isAbsolute(baseline))
    throw new Error("Usage: node scripts/run-native-chat-ui-installed.js --legacy-vsix=/absolute/baseline.vsix [--candidate-vsix=/absolute/target.vsix] [--probe-only|--native-protocol-only]");
  if (!process.argv.includes("--inside")) {
    const python = spawnSync("python3", ["-B", "-c", "import pathlib,playwright; print(pathlib.Path(playwright.__file__).parent.parent)"], { encoding: "utf8" });
    if (python.status) throw new Error(python.stderr);
    let chromium;
    if (recipeJourney) {
      const browser = spawnSync("python3", ["-B", "-c",
        "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()"],
      { encoding: "utf8" });
      if (browser.status) throw new Error(browser.stderr);
      chromium = browser.stdout.trim();
      assert(fs.statSync(chromium).isFile(), "Recipe UI requires an already installed local Chromium, not a network download.");
    }
    const editor = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
    const display = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const args = require("./run-next-trial-private-display").privateNamespaceArgs([process.execPath, __filename, ...process.argv.slice(2), "--inside"]);
    const result = spawnSync("unshare", args, { stdio: "inherit", timeout: 900000,
      env: { PATH: process.env.PATH, PKM_UI_EDITOR: editor, PKM_UI_XVFB: display, PYTHONPATH: python.stdout.trim(),
        ...(chromium ? { PKM_UI_CHROMIUM: chromium } : {}),
        PKM_UI_PARENT_MOUNT_NS: fs.readlinkSync("/proc/self/ns/mnt") } });
    if (result.error || result.status) throw result.error || new Error(`Private UI journey exited ${result.status ?? result.signal}`);
    return;
  }
  assert(process.env.PKM_UI_PARENT_MOUNT_NS
    && fs.readlinkSync("/proc/self/ns/mnt") !== process.env.PKM_UI_PARENT_MOUNT_NS,
  "Installed UI journeys must use the launcher's fresh private mount namespace.");
  process.umask(0o077);
  const controlFiles = ["scripts/run-native-chat-ui-installed.js", "scripts/run-next-trial-private-display.js",
    "tests/test-native-chat-ui-installed.py", "tests/next-trial-electron/native-chat-ui-host.cjs",
    "tests/next-trial-electron/api-chat-fixture.cjs", "tests/next-trial-electron/in-place-options.cjs",
    "tests/next-trial-electron/todo-board-fixture.cjs",
    "tests/next-trial-electron/native-ui-root-crash.cjs",
    "tests/next-trial-electron/native-board-files-crash.cjs"];
  if (chatWorkerProbe) controlFiles.push("tests/next-trial-electron/legacy-chat-worker-provider.cjs");
  if (chatWorkerJourney) controlFiles.push("tests/next-trial-electron/native-managed-chat-ui-host.cjs",
    "tests/next-trial-electron/native-managed-chat-ui-journey.cjs");
  if (chatWorkflows) controlFiles.push("tests/native_chat_workflow_ui.py");
  if (chatMemory) controlFiles.push("tests/next-trial-electron/legacy-chat-memory-fixture.cjs",
    "tests/next-trial-electron/native-memory-chat-ui-journey.cjs", "tests/native_chat_memory_ui.py");
  if (recipeJourney) controlFiles.push("tests/next-trial-electron/legacy-recipe-fixture.cjs",
    "tests/next-trial-electron/legacy-recipe-fixture.py", "tests/native_chat_recipe_ui.py");
  if (chatRecipe) controlFiles.push("tests/next-trial-electron/native-recipe-chat-ui-journey.cjs",
    "tests/next-trial-electron/trusted-local-recipe-adapter.cjs");
  if (recipeLibrary) controlFiles.push("tests/next-trial-electron/native-recipe-library-ui-journey.cjs");
  if (recipePublic) controlFiles.push("tests/next-trial-electron/legacy-recipe-protocol-probe.cjs",
    "tests/next-trial-electron/native-recipe-public-client.cjs");
  if (recipeLazy || legacyRecipeLazyProbe) controlFiles.push("tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs",
    "tests/next-trial-electron/legacy-recipe-lazy-probe.cjs");
  if (recipeLazy) controlFiles.push("tests/next-trial-electron/native-recipe-lazy-ui-journey.cjs",
    "tests/next-trial-electron/native-recipe-lazy-client.cjs", "tests/native_chat_recipe_lazy_ui.py");
  if (recipePython) controlFiles.push("tests/next-trial-electron/native-python-recipe-host.cjs",
    "tests/next-trial-electron/native-python-recipe-installed-fixture.cjs",
    "tests/next-trial-electron/native-python-recipe-ui-journey.cjs",
    "tests/next-trial-electron/native-python-recipe-public-client.cjs", "tests/native_python_recipe_ui.py");
  if (recipeKnowledge) controlFiles.push("tests/next-trial-electron/native-recipe-knowledge-installed-fixture.cjs",
    "tests/next-trial-electron/native-recipe-knowledge-ui-journey.cjs", "tests/native_chat_recipe_knowledge_ui.py");
  if (recipeReports) controlFiles.push("tests/next-trial-electron/native-recipe-report-installed-fixture.cjs",
    "tests/next-trial-electron/native-recipe-report-ui-journey.cjs", "tests/next-trial-electron/legacy-external-report-oracle.py",
    "tests/next-trial-electron/native-recipe-lazy-client.cjs", "tests/native_chat_recipe_report_ui.py");
  if (recipeBranches) controlFiles.push("tests/next-trial-electron/native-recipe-branch-installed-fixture.cjs",
    "tests/next-trial-electron/native-recipe-branch-ui-journey.cjs", "tests/next-trial-electron/legacy-static-branch-fixture.cjs",
    "tests/next-trial-electron/legacy-static-branch-oracle.py", "tests/next-trial-electron/native-recipe-lazy-client.cjs",
    "tests/native_chat_recipe_branch_ui.py");
  if (recipeReflectionGates) controlFiles.push("tests/next-trial-electron/native-recipe-reflection-gate-installed-fixture.cjs",
    "tests/next-trial-electron/native-recipe-reflection-gate-ui-journey.cjs",
    "tests/next-trial-electron/legacy-reflection-gate-fixture.cjs", "tests/next-trial-electron/legacy-reflection-gate-oracle.py",
    "tests/next-trial-electron/legacy-ported-branch-fixture.cjs", "tests/next-trial-electron/legacy-ported-branch-oracle.py",
    "tests/next-trial-electron/native-recipe-lazy-client.cjs", "tests/native_chat_recipe_reflection_gate_ui.py");
  const controller = Object.fromEntries(controlFiles.map(file => [file,
    createHash("sha256").update(fs.readFileSync(path.join(project, file))).digest("hex")]));
  console.log("PRIVATE_TEST_CONTROLLER_SHA256", createHash("sha256").update(JSON.stringify(controller)).digest("hex"));
  console.log("PRIVATE_VSIX_SHA256", JSON.stringify({ baseline: createHash("sha256").update(fs.readFileSync(baseline)).digest("hex"),
    candidate: candidate && createHash("sha256").update(fs.readFileSync(candidate)).digest("hex") }));
  const fixture = path.join(project, ".migration-test-work", `native-chat-ui-${randomUUID()}`);
  fs.mkdirSync(fixture, { recursive: true, mode: 0o700 });
  process.chdir(fixture);
  const short = `/proc/${process.pid}/cwd`, root = path.join(fixture, "knowledge");
  for (const name of ["h", "t", "u/User", "x", "crashes"]) fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: `${short}/h`, USERPROFILE: `${short}/h`,
    TMPDIR: `${fixture}/t`, TMP: `${fixture}/t`, TEMP: `${fixture}/t`, PYTHONPATH: process.env.PYTHONPATH,
    XDG_RUNTIME_DIR: `${short}/t`, DISPLAY: "127.0.0.1:91", XAUTHORITY: path.join(fixture, "Xauthority"),
    ...(process.env.PKM_UI_CHROMIUM ? { PKM_UI_CHROMIUM: process.env.PKM_UI_CHROMIUM } : {}) };
  const editor = process.env.PKM_UI_EDITOR, cli = path.join(path.dirname(editor), "bin/code");
  const args = ["--no-sandbox", `--user-data-dir=${fixture}/u`, `--extensions-dir=${fixture}/x`];
  const processes = new Set();
  function launch(command, parameters, extra = {}) {
    const child = spawn(command, parameters, { cwd: fixture, env: { ...env, ...extra }, stdio: "inherit" });
    processes.add(child); child.once("exit", () => processes.delete(child));
    return child;
  }
  async function run(command, parameters, extra = {}, timeout = 180000) {
    const child = launch(command, parameters, extra);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    try { await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code ?? signal}`)));
    }); } finally { clearTimeout(timer); }
  }
  const command = (name, parameters) => {
    const result = spawnSync(name, parameters, { cwd: fixture, env, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status) throw result.error || new Error(result.stderr || `${name} exited ${result.status}`);
    return result.stdout;
  };
  let code, provider, broker;
  async function stopCode() {
    if (!code || code.exitCode !== null || code.signalCode !== null) return;
    const exited = new Promise(resolve => code.once("exit", resolve));
    code.kill("SIGTERM");
    await Promise.race([exited, wait(10000)]);
    if (code.exitCode === null && code.signalCode === null) { code.kill("SIGKILL"); await exited; }
    code = undefined;
    await wait(1000);
  }
  async function startCode(extra = {}) {
    code = launch(editor, [...args, "--new-window", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry",
      "--password-store=basic",
      "--skip-release-notes", "--skip-welcome", "--locale=en", "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9333", `--crash-reporter-directory=${fixture}/crashes`,
      ...(chatWorkerProbe ? [path.join(fixture, "workspace")] : [])], extra);
    for (let attempt = 0; attempt < 160; attempt++) {
      if (code.exitCode !== null || code.signalCode !== null) throw new Error("Private VS Code exited before renderer readiness.");
      try {
        const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
        if (targets.some(target => target.url.includes("workbench"))) return;
      } catch {}
      await wait(150);
    }
    throw new Error("Actual private VS Code CDP renderer did not become ready.");
  }
  const python = stage => run("python3", ["-B", path.join(project, "tests/test-native-chat-ui-installed.py"),
    "http://127.0.0.1:9333", path.join(fixture, "api-chat-fixture.json"), stage], {}, 180000);
  try {
    command("ip", ["link", "set", "lo", "up"]);
    fs.writeFileSync("Xauthority", "", { flag: "wx", mode: 0o600 });
    command("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
    launch(process.env.PKM_UI_XVFB, [":91", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY]);
    let displayReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0) { displayReady = true; break; }
      await wait(50);
    }
    assert(displayReady, "Private network-only display did not become responsive.");
    await run(cli, [...args, "--install-extension", baseline, "--force"]);
    const installed = version => {
      const directories = fs.readdirSync("x").filter(name => /^uone\.personal-knowledge-/i.test(name)
        && fs.existsSync(path.join("x", name, "package.json"))
        && (version === undefined || JSON.parse(fs.readFileSync(path.join("x", name, "package.json"))).version === version));
      assert.equal(directories.length, 1, JSON.stringify(directories));
      return path.join(fixture, "x", directories[0]);
    };
    const legacy = installed(), legacyManifest = JSON.parse(fs.readFileSync(path.join(legacy, "package.json")));
    assert.equal(`${legacyManifest.publisher}.${legacyManifest.name}`.toLowerCase(), "uone.personal-knowledge");
    const protocolOnly = process.argv.includes("--native-protocol-only");
    const basePython = JSON.parse(command("python3", ["-B", "-c", "import sys,platform,json;print(json.dumps({'path':sys.executable,'version':platform.python_version()}))"]));
    const privateRuntime = path.join(fixture, "h/pkm-envs/pkm-mcp"), privatePython = path.join(privateRuntime, "bin/python");
    if (!protocolOnly) {
      await run(basePython.path, ["-B", "-m", "venv", "--system-site-packages", privateRuntime]);
      await run(privatePython, ["-B", "-m", "pip", "install", "--no-index", "--no-deps",
        path.join(legacy, "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl")]);
      fs.writeFileSync(path.join(privateRuntime, ".pkm-base-python.json"), JSON.stringify(basePython), { mode: 0o600 });
    }
    const fixtureModule = require("../tests/next-trial-electron/api-chat-fixture.cjs");
    const descriptor = fixtureModule.create({ extension: legacy, root,
      workspaceNamespace: createHash("sha256").update("empty").digest("hex").slice(0, 16) });
    const { ApiChatStore } = require(path.join(legacy, "dist/chat/api-chat-store.js"));
    const legacyStore = new ApiChatStore(descriptor.state, descriptor.namespace);
    const textChat = legacyStore.create();
    textChat.title = "Original ordinary API conversation for real UI sending";
    textChat.messages.push({ id: randomUUID(), role: "user", content: "Original bounded text history.", status: "complete" });
    legacyStore.save(textChat);
    descriptor.text = textChat.id;
    if (process.argv.includes("--todo-same-root"))
      require("../tests/next-trial-electron/todo-board-fixture.cjs").create({ extension: legacy, root, descriptor });
    for (const id of [descriptor.inline, descriptor.segmented, descriptor.text]) {
      const chat = legacyStore.load(id, false);
      chat.toolSelection = { disabledTools: [], disabledSources: ["builtin", "vscode"] };
      chat.builtinTools = []; chat.vscodeTools = [];
      legacyStore.save(chat);
    }
    let workerProvider;
    if (chatWorkerProbe) {
      fs.mkdirSync("workspace", { mode: 0o700 });
      const inputBytes = Buffer.from(`synthetic-worker-file-${randomUUID()}`);
      fs.writeFileSync("workspace/continuity-input.txt", inputBytes, { flag: "wx", mode: 0o600 });
      const manager = legacyStore.create();
      manager.title = "Original real worker continuity";
      manager.permissionMode = "allow-all";
      manager.builtinTools = ["session_info", "record_harness", "read_file", "spawn_workers"];
      manager.vscodeTools = [];
      manager.toolSelection = { disabledTools: [], disabledSources: ["vscode"] };
      legacyStore.save(manager);
      workerProvider = require("../tests/next-trial-electron/legacy-chat-worker-provider.cjs")
        .create({ inputPath: "continuity-input.txt", inputBytes });
      descriptor.workerManager = manager.id;
      descriptor.workerInputSha256 = workerProvider.inputSha256;
    }
    if (recipeJourney) {
      const fixtureNonce = randomUUID();
      fs.writeFileSync("native-ui-fixture-token", fixtureNonce, { flag: "wx", mode: 0o600 });
      descriptor.legacyRecipe = require("../tests/next-trial-electron/legacy-recipe-fixture.cjs").create({ extension: legacy, root, fixture });
      if (recipeReports) descriptor.recipeReports = require("../tests/next-trial-electron/native-recipe-report-installed-fixture.cjs")
        .prepare({ extension: legacy, root, fixture });
      if (recipeBranches) descriptor.recipeBranches = require("../tests/next-trial-electron/native-recipe-branch-installed-fixture.cjs")
        .prepare({ extension: legacy, root, fixture });
      if (recipeReflectionGates) descriptor.recipeReflectionGates =
        require("../tests/next-trial-electron/native-recipe-reflection-gate-installed-fixture.cjs").prepare({ extension: legacy, root, fixture });
      if (recipeKnowledge) {
        descriptor.recipeKnowledge = require("../tests/next-trial-electron/native-recipe-knowledge-installed-fixture.cjs")
          .prepare({ extension: legacy, root, fixture });
        descriptor.legacyRecipe = JSON.parse(fs.readFileSync(path.join(fixture, "original-recipe-evidence.json")));
      }
      if (recipePython) require("../tests/next-trial-electron/native-python-recipe-installed-fixture.cjs").prepare({ extension: legacy, fixture });
      if (recipeLazy || legacyRecipeLazyProbe)
        descriptor.lazyRecipe = require("../tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs").create({ extension: legacy, root, fixture });
      fs.writeFileSync("u/User/keybindings.json", JSON.stringify([{ key: "ctrl+alt+shift+r",
        command: "personalKnowledge.openRecipe", args: descriptor.legacyRecipe.recipeId }]), { flag: "wx", mode: 0o600 });
    }
    const pngChunk = (name, data) => {
      const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
      let crc = 0xffffffff;
      for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([length, body, checksum]);
    };
    const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(1, 0); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 6;
    const nativePng = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", pngHeader),
      pngChunk("IDAT", require("node:zlib").deflateSync(Buffer.from([0, 0x33, 0x88, 0xee, 0xff]))), pngChunk("IEND", Buffer.alloc(0))]);
    Object.assign(descriptor, { fixture, legacyUiActivated: !protocolOnly, imageBase64: fixtureModule.image.dataBase64,
      nativeImageBase64: nativePng.toString("base64"), nativeImageLabel: "Pasted image 1.png",
      imageUrl: `data:image/png;base64,${fixtureModule.image.dataBase64}` });
    fs.writeFileSync("api-chat-fixture.json", JSON.stringify(descriptor), { mode: 0o600 });
    fs.mkdirSync(path.join(root, "notes"), { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic original UI root.\n", { mode: 0o600 });
    const calls = [];
    provider = require("node:http").createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (workerProvider?.handle(body, response)) return;
        const latest = [...body.messages].reverse().find(message => message.role === "user").content;
        const text = Array.isArray(latest) ? latest.find(part => part.type === "text").text : latest;
        const marker = ["LEGACY_UI_ACTUAL_SEND", "NATIVE_UI_WINDOW_ONE", "NATIVE_UI_TODO_CHAT", "NATIVE_UI_MULTI_A", "NATIVE_UI_MULTI_B", "NATIVE_UI_CRASH_RESULT"].find(item => text.includes(item));
        assert(marker, `Unexpected synthetic provider request: ${text.slice(0, 200)}`);
        if (marker === "NATIVE_UI_WINDOW_ONE") {
          assert(JSON.stringify(body.messages).includes(`data:image/png;base64,${fixtureModule.image.dataBase64}`));
          assert(Array.isArray(latest) && latest.some(part => part.type === "image_url"
            && part.image_url.url === `data:image/png;base64,${descriptor.nativeImageBase64}`));
        }
        calls.push(marker);
        console.log("PRIVATE_NATIVE_UI_ACTUAL_PROVIDER", Date.now(), marker);
        if (marker === "NATIVE_UI_MULTI_A") await wait(5000);
        const answer = marker === "LEGACY_UI_ACTUAL_SEND" ? "LEGACY_UI_DURABLE_RESPONSE"
          : marker.replace("NATIVE_UI_", "NATIVE_UI_DURABLE_");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\n`
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } catch (error) { console.error("PROVIDER REFUSAL", error); response.writeHead(500); response.end(String(error)); }
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
    fs.writeFileSync("u/User/settings.json", JSON.stringify({
      "personalKnowledge.storePath": root, "personalKnowledge.apiChatProvider": "openai-compatible",
      "personalKnowledge.mcpPythonPath": basePython.path, "personalKnowledge.mcpRuntimePath": privateRuntime,
      "personalKnowledge.mcpServerPath": path.join(fixture, "legacy-mcp-server"),
      "personalKnowledge.aiEndpoint": endpoint, "personalKnowledge.aiModel": "synthetic-ui-provider",
      ...(recipePython ? { "personalKnowledge.experimental.localEnvironmentUpgrade": true } : {}),
      "personalKnowledge.apiChatModelProfiles": [{ id: "synthetic-ui-provider", status: "active",
        model: "synthetic-ui-provider", contextWindow: 8000000, maxOutputTokens: 1024 }],
      "security.workspace.trust.enabled": false, "workbench.startupEditor": "none", "window.restoreWindows": "none",
      "window.dialogStyle": "custom",
      "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false, "extensions.ignoreRecommendations": true,
    }), { mode: 0o600 });
    console.log("PRIVATE UI FIXTURE", fixture, "BASELINE", baseline, "VERSION", legacyManifest.version);
    if (!protocolOnly) {
      await startCode();
      await python("baseline");
      if (recipeJourney) await python("legacy-recipe");
      if (recipePublic) await require("../tests/next-trial-electron/legacy-recipe-protocol-probe.cjs").run({
        fixture, recipeId: descriptor.legacyRecipe.recipeId });
      if (legacyRecipeLazyProbe) await require("../tests/next-trial-electron/legacy-recipe-lazy-probe.cjs").run({ fixture });
      await stopCode();
      assert.deepEqual(calls, ["LEGACY_UI_ACTUAL_SEND"]);
      assert.equal(legacyStore.load(descriptor.text, false).messages.at(-1).content, "LEGACY_UI_DURABLE_RESPONSE");
      console.log("PASS: genuine installed legacy-writer API Chat UI loaded original PNG and segmented history and durably sent through controlled HTTP.");
      if (chatWorkerProbe) {
        const manager = legacyStore.load(descriptor.workerManager, false);
        assert.match(manager.sessionId, /^agent_session_[a-f0-9]{32}$/);
        assert(manager.messages.some(message => message.harnessReports?.some(report => report.kind === "task")));
        assert(manager.messages.some(message => message.toolCalls?.some(call => call.name === "spawn_workers" && call.status === "complete")));
        assert(workerProvider.observed.some(item => item.role === "manager" && item.name === "read_file"));
        assert(workerProvider.observed.some(item => item.role === "child" && item.name === "read_file"));
        const session = JSON.parse(fs.readFileSync(path.join(descriptor.state, "agent-sessions", `${manager.sessionId}.json`)));
        assert.equal(session.hostSessionId, manager.id);
        assert.equal(session.nativeChat.sessionId, manager.sessionId);
        assert.equal(session.nativeChat.id, manager.id);
        const tree = JSON.parse(fs.readFileSync(path.join(descriptor.state, "api-chat-worker-trees", `${manager.workerState.treeId}.json`)));
        assert.equal(tree.rootChatId, manager.id);
        assert.equal(tree.slots.length, 1);
        assert.equal(tree.slots[0].released, true);
        const worker = JSON.parse(fs.readFileSync(path.join(descriptor.state, "api-chat-worker-results", `${tree.slots[0].receiptId}.json`)));
        assert.equal(worker.schema, "pkm.chat.worker-result/v1");
        assert.equal(worker.managerChatId, manager.id);
        assert.equal(worker.chat.id, tree.slots[0].chatId);
        assert.equal(worker.chat.workerState.parentChatId, manager.id);
        assert.equal(worker.chat.workerState.receiptId, tree.slots[0].receiptId);
        const childRead = worker.chat.messages.flatMap(message => message.toolCalls ?? [])
          .filter(call => call.name === "read_file" && call.status === "complete");
        assert.equal(childRead.length, 1);
        assert.equal(createHash("sha256").update(JSON.parse(childRead[0].result).content).digest("hex"), workerProvider.inputSha256);
        const library = legacyStore.library.read(), group = library.groups.find(group => group.name === "Synthetic preserved task library");
        assert(group, "The real original Library UI must create and rename the group.");
        assert.equal(library.placements[manager.id].groupId, group.id);
        fs.writeFileSync("legacy-chat-worker-evidence.json", JSON.stringify({
          managerId: manager.id, sessionId: manager.sessionId, workerState: manager.workerState,
          inputSha256: workerProvider.inputSha256, calls: workerProvider.observed, tree,
          workerReceiptId: worker.receiptId, library,
        }), { flag: "wx", mode: 0o600 });
        console.log("PASS actual untouched installed old managed Task/Harness, manager and child real read_file calls, no fabricated tool result.");
      }
      if (chatMemory) {
        const manager = legacyStore.load(descriptor.workerManager, false);
        manager.permissionMode = "allow-all"; legacyStore.save(manager);
        descriptor.legacyMemory = await require("../tests/next-trial-electron/legacy-chat-memory-fixture.cjs").create({
          extension: legacy, profileStorage: path.join(fixture, "u/User/globalStorage/uone.personal-knowledge"),
          root, chatId: descriptor.workerManager });
        fs.writeFileSync("api-chat-fixture.json", JSON.stringify(descriptor), { mode: 0o600 });
        console.log("PASS genuine pinned old VSIX ExplicitMemoryService/Engine wrote confirmed/pending/foreign records in its actual private profile; closed writer checkpointed, no old grants inherited.");
      }
    } else console.log("NATIVE RENDERER PROTOCOL ONLY: legacy ApiChatStore wrote fixture; legacy UI activation and its ProjectStore migration are deliberately NOT covered.");
    if (process.argv.includes("--probe-only")) return;
    assert(candidate && path.isAbsolute(candidate), "A target VSIX is required after the baseline probe.");
    function inventory(directory) {
      const entries = {};
      const visit = file => {
        const stat = fs.lstatSync(file, { bigint: true });
        if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
        else {
          assert(stat.isFile() && stat.nlink === 1n, "No linked payload/source files are allowed.");
          entries[path.relative(directory, file)] = { sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
            mode: String(stat.mode), uid: String(stat.uid), gid: String(stat.gid), inode: String(stat.ino),
            mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
        }
      };
      visit(directory); return entries;
    }
    let original = inventory(root);
    const rootStat = fs.statSync(root, { bigint: true });
    if (descriptor.todoBoards?.length)
      require("../tests/next-trial-electron/todo-board-fixture.cjs").refresh({ extension: legacy, root, descriptor });
    const packagedManifest = JSON.parse(command("unzip", ["-p", candidate, "extension/package.json"]));
    if (process.argv.includes("--require-version-upgrade")) {
      const previous = legacyManifest.version.split(".").map(Number), next = packagedManifest.version.split(".").map(Number);
      assert(previous.length === 3 && next.length === 3 && [...previous, ...next].every(Number.isSafeInteger));
      const difference = next.findIndex((value, index) => value !== previous[index]);
      assert(difference >= 0 && next[difference] > previous[difference], "An actual newer extension version is required, not a same-version payload replacement.");
    }
    await run(cli, [...args, "--install-extension", candidate, "--force"]);
    const target = installed(packagedManifest.version), targetManifest = JSON.parse(fs.readFileSync(path.join(target, "package.json")));
    console.log("TARGET", candidate, "VERSION", targetManifest.version,
      legacyManifest.version === targetManifest.version ? "same-version payload replacement, not a released-version upgrade" : "version replacement");
    const installedInventory = inventory(target);
    const zipped = JSON.parse(command("python3", ["-B", "-c",
      "import hashlib,json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n[10:]:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('extension/') and not n.endswith('/') and n!='extension/package.json'}))", candidate]));
    for (const [file, digest] of Object.entries(zipped)) assert.equal(installedInventory[file]?.sha256, digest, `Installed payload differs: ${file}`);
    const { __metadata, ...manifestWithoutInstallerMetadata } = targetManifest;
    assert.deepEqual(manifestWithoutInstallerMetadata, packagedManifest);
    const runtime = path.join(target, "next-runtime/server");
    const load = name => import(pathToFileURL(path.join(runtime, "dist", `${name}.js`)).href);
    const nonce = recipeJourney ? fs.readFileSync("native-ui-fixture-token", "utf8") : randomUUID(), actorId = randomUUID();
    fs.writeFileSync("in-place-fixture-token", nonce, { flag: "wx", mode: 0o600 });
    if (!recipeJourney) fs.writeFileSync("native-ui-fixture-token", nonce, { flag: "wx", mode: 0o600 });
    const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } = await load("legacy-root-adoption");
    const options = require("../tests/next-trial-electron/in-place-options.cjs").options;
    if (process.argv.includes("--legacy-ui-same-root")) {
      assert(!protocolOnly, "Same-root qualification requires actual legacy UI activation.");
      const { inspectLinuxLegacyWriterQuiescence } = await load("linux-legacy-writer-quiescence");
      const beforeRefusal = inventory(root);
      await assert.rejects(() => prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce })),
        error => error?.code === "LEGACY_WRITERS_ACTIVE");
      assert.deepEqual(inventory(root), beforeRefusal, "Live old-writer refusal changed source state.");
      const report = await inspectLinuxLegacyWriterQuiescence(root);
      console.log("PRIVATE_OLD_UI_WRITER_REPORT", JSON.stringify(report.blockers));
      for (const blocker of report.blockers) {
        if (!["pkm-service", "legacy-mcp"].includes(blocker.kind)) continue;
        assert(blocker.pid > 1 && blocker.pid !== process.pid);
        const proc = `/proc/${blocker.pid}`, argv = fs.readFileSync(`${proc}/cmdline`, "utf8").split("\0").filter(Boolean);
        assert(argv.some(argument => argument.includes(fixture + path.sep)));
        assert.equal(fs.statSync(proc).uid, process.getuid());
        const stat = fs.readFileSync(`${proc}/stat`, "utf8");
        assert.equal(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19], blocker.startTimeTicks);
        console.log("PRIVATE_FIXTURE_ONLY_SIGTERM", blocker.pid, blocker.kind);
        process.kill(blocker.pid, "SIGTERM");
      }
      const drainDeadline = Date.now() + 10000;
      while ((await inspectLinuxLegacyWriterQuiescence(root)).blockers.length && Date.now() < drainDeadline) await wait(100);
      assert.deepEqual((await inspectLinuxLegacyWriterQuiescence(root)).blockers, [], "No unknown writer is signalled or exempted.");
      original = inventory(root);
      const marker = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, "{}", { flag: "wx", mode: 0o600 });
      try {
        await startCode();
        await wait(3000);
        await assert.rejects(() => prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce })),
          error => error?.code === "LEGACY_WRITERS_ACTIVE");
        const active = await inspectLinuxLegacyWriterQuiescence(root);
        assert(active.blockers.some(blocker => blocker.kind === "vscode-host-process" || blocker.kind === "vscode-extension-host"));
        assert.deepEqual(inventory(root), original, "Actual running VS Code host refusal changed original state.");
        console.log("PASS NEGATIVE: actual private VS Code host still blocks same-root adoption; no writer exemption. NOT seamless upgrade.");
      } finally { await stopCode(); fs.unlinkSync(marker); }
      const hostDeadline = Date.now() + 10000;
      while ((await inspectLinuxLegacyWriterQuiescence(root)).blockers.length && Date.now() < hostDeadline) await wait(100);
      assert.deepEqual((await inspectLinuxLegacyWriterQuiescence(root)).blockers, []);
      if (recipeUpgradeProbe) {
        const before = inventory(root);
        const snapshot = require("../tests/next-trial-electron/legacy-recipe-fixture.cjs").snapshot;
        const identities = snapshot(root);
        let refusal;
        try { await prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce })); }
        catch (error) { refusal = error; }
        assert(refusal, "Recipe probe unexpectedly reached adoption: stop and qualify actual native Recipe stages separately.");
        assert.match(String(refusal.message), /LEGACY_UI_RETIRED_STATE_BLOCKED|Only untouched bootstrap ProjectStore state/,
          "Unexpected refusal is not evidence of the original ProjectStore Recipe/receipt guard.");
        assert.deepEqual(inventory(root), before, "Recipe refusal changed original state.");
        assert.deepEqual(snapshot(root), identities, "Recipe refusal changed original bytes or file/directory identity.");
        assert(!fs.existsSync(path.join(root, "core.sqlite")) && !fs.existsSync(path.join(root, ".pkm-next-root-adoption.json")));
        const evidence = { status: "blocked", migrationQualified: false, fixture,
          baselineVersion: legacyManifest.version, candidateVersion: targetManifest.version,
          oldUi: JSON.parse(fs.readFileSync("legacy-recipe-ui-evidence.json")), code: refusal.code, message: refusal.message,
          originalStatePreserved: true, sourceIdentities: identities, controller };
        fs.writeFileSync("recipe-installed-blocker-evidence.json", JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
        console.log("RECIPE_INSTALLED_UPGRADE_BLOCKED_NOT_QUALIFIED", JSON.stringify(evidence));
        throw new Error(`Actual installed Recipe upgrade remains safely blocked: ${refusal.code}: ${refusal.message}`);
      }
      const compatibility = await load("legacy-ui-bootstrap-compatibility");
      const proof = compatibility.inspectLegacyUiBootstrapCompatibility(root);
      assert.equal(proof.components.project, "verified-cutover");
      console.log("PRIVATE_ACTUAL_OLD_UI_COMPATIBILITY", JSON.stringify({ project: proof.project, sourceFingerprint: proof.sourceFingerprint, files: proof.files.length }));
      const refusedFixture = path.join(fixture, "pending-marker-refusal"), refusedRoot = path.join(refusedFixture, "knowledge");
      fs.mkdirSync(refusedFixture, { mode: 0o700 });
      fs.cpSync(root, refusedRoot, { recursive: true });
      fs.writeFileSync(path.join(refusedFixture, "in-place-fixture-token"), nonce, { flag: "wx", mode: 0o600 });
      fs.writeFileSync(path.join(refusedRoot, ".pkm/state/project-store-intent.json"),
        JSON.stringify({ schema: "synthetic-unknown-pending/v1", nonce }), { flag: "wx", mode: 0o600 });
      const refusedBefore = inventory(refusedRoot);
      await assert.rejects(() => prepareLegacyRootAdoptionExperimental(refusedRoot,
        options({ fixture: refusedFixture, root: refusedRoot, nonce })),
      error => error?.code === "LEGACY_UI_COMPATIBILITY_BLOCKED" && error.message.includes("project-store-intent.json"));
      assert.deepEqual(inventory(refusedRoot), refusedBefore, "Unknown pending refusal changed the actual old-UI copy.");
      assert(!fs.existsSync(path.join(refusedRoot, "core.sqlite")) && !fs.existsSync(path.join(refusedRoot, ".pkm-next-root-adoption.json")));
      console.log("PASS NEGATIVE: installed runtime refuses unknown pending Project intent in the actual old-UI synthetic copy; all state retained, no native authority.");
    }
    if (process.argv.includes("--expect-legacy-ui-block")) {
      assert(!protocolOnly, "The old-UI refusal test must actually activate the legacy UI.");
      let firstError, preserved = original;
      try { await prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce })); }
      catch (error) { firstError = error; }
      assert(firstError, "An actual unsupported old-UI root was unexpectedly admitted.");
      if (firstError.code === "LEGACY_WRITERS_ACTIVE") {
        assert(!fs.existsSync(path.join(root, "core.sqlite")), "Writer refusal created native authority.");
        const { inspectLinuxLegacyWriterQuiescence } = await load("linux-legacy-writer-quiescence");
        const report = await inspectLinuxLegacyWriterQuiescence(root);
        assert(report.blockers.length, "The real surviving old fixture writer was not observed.");
        console.log("PRIVATE_OLD_UI_WRITER_REPORT", JSON.stringify(report.blockers));
        for (const blocker of report.blockers) {
          if (!["pkm-service", "legacy-mcp"].includes(blocker.kind)) continue;
          assert(blocker.pid > 1 && blocker.pid !== process.pid);
          const proc = `/proc/${blocker.pid}`;
          const argv = fs.readFileSync(`${proc}/cmdline`, "utf8").split("\0").filter(Boolean);
          assert(argv.some(argument => argument.includes(fixture + path.sep)),
            "Refusing to signal a process not explicitly bound to this synthetic fixture.");
          assert.equal(fs.statSync(proc).uid, process.getuid());
          const stat = fs.readFileSync(`${proc}/stat`, "utf8");
          assert.equal(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19], blocker.startTimeTicks,
            "Private fixture PID identity changed.");
          console.log("PRIVATE_FIXTURE_ONLY_SIGTERM", blocker.pid, blocker.kind);
          process.kill(blocker.pid, "SIGTERM");
        }
        const deadline = Date.now() + 10000;
        while ((await inspectLinuxLegacyWriterQuiescence(root)).blockers.length && Date.now() < deadline) await wait(100);
        assert.deepEqual((await inspectLinuxLegacyWriterQuiescence(root)).blockers, [],
          "The private old fixture service did not drain; no writer gate is bypassed.");
        preserved = inventory(root);
        console.log("PASS NEGATIVE: real surviving old fixture MCP blocked adoption; explicitly verified private services drained. Source baseline is captured after this legacy shutdown.");
        await assert.rejects(() => prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce })),
          error => error?.code === "PKM_STATE_UNSUPPORTED");
      } else assert.equal(firstError.code, "PKM_STATE_UNSUPPORTED");
      const { planLegacyProjectEnvelope } = await load("legacy-project-envelope");
      await assert.rejects(() => planLegacyProjectEnvelope(root), error => error?.code === "MIGRATION_MARKER");
      assert.deepEqual(inventory(root), preserved, "Refusal changed original old-UI root files.");
      assert.deepEqual(inventory(target), installedInventory, "Refusal changed the installed target.");
      assert.equal(String(fs.statSync(root, { bigint: true }).ino), String(rootStat.ino));
      console.log("PASS NEGATIVE ONLY: actual legacy-UI root is refused with PKM_STATE_UNSUPPORTED and MIGRATION_MARKER; original files and installed target unchanged. NOT an upgrade success.");
      return;
    }
    const prepared = await prepareLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce }));
    if (process.argv.includes("--legacy-ui-same-root")) {
      const interrupted = launch(process.execPath, [path.join(project, "tests/next-trial-electron/native-ui-root-crash.cjs"),
        fixture, root, target, nonce, prepared.workspaceId], { PKM_PRIVATE_UI_ROOT_CRASH: nonce });
      const exit = await new Promise((resolve, reject) => { interrupted.once("error", reject); interrupted.once("exit", resolve); });
      assert.equal(exit, 80, "The actual root-adoption child did not exit after its durable compatibility transaction.");
      const evidence = JSON.parse(fs.readFileSync(path.join(fixture, "ui-root-crash-evidence.json")));
      assert.equal(evidence.workspaceId, prepared.workspaceId);
      assert.equal(evidence.commitExists, false);
      assert(!fs.existsSync(path.join(root, ".pkm-next-root-adoption.commit.json")));
      const { Storage } = await load("storage");
      await assert.rejects(() => Storage.open(root), error => error?.code === "RECOVERY_REQUIRED");
      assert.deepEqual(Object.fromEntries(Object.entries(inventory(root)).filter(([file]) => file in original)), original);
      console.log("PASS: actual exit80 after native UI compatibility receipt COMMIT, before root adoption commit; default open blocked pending exact resume, original state unchanged.");
    }
    const adopted = await resumeLegacyRootAdoptionExperimental(root, options({ fixture, root, nonce, workspaceId: prepared.workspaceId }));
    await adopted.storage.close();
    const { inspectLegacyApiChatArchive } = await load("legacy-api-chat-archive");
    const archive = inspectLegacyApiChatArchive(root);
    if (chatWorkerJourney) {
      await require(recipeReflectionGates ? "../tests/next-trial-electron/native-recipe-reflection-gate-ui-journey.cjs"
        : recipeBranches ? "../tests/next-trial-electron/native-recipe-branch-ui-journey.cjs"
        : recipeReports ? "../tests/next-trial-electron/native-recipe-report-ui-journey.cjs"
        : recipeKnowledge ? "../tests/next-trial-electron/native-recipe-knowledge-ui-journey.cjs"
        : recipePython ? "../tests/next-trial-electron/native-python-recipe-ui-journey.cjs"
        : recipeLazy ? "../tests/next-trial-electron/native-recipe-lazy-ui-journey.cjs"
        : recipeLibrary ? "../tests/next-trial-electron/native-recipe-library-ui-journey.cjs"
        : chatRecipe ? "../tests/next-trial-electron/native-recipe-chat-ui-journey.cjs"
        : chatMemory ? "../tests/next-trial-electron/native-memory-chat-ui-journey.cjs"
        : "../tests/next-trial-electron/native-managed-chat-ui-journey.cjs").run({
        fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
        env, processes, startCode, stopCode, python, taskControls, chatWorkflows, recipePublic, recipeLazy, recipePython,
      });
      assert.deepEqual(Object.fromEntries(Object.entries(inventory(root)).filter(([file]) => file in original)), original);
      assert.deepEqual(inventory(target), installedInventory, "Managed UI modified the installed candidate.");
      assert.equal(String(fs.statSync(root, { bigint: true }).ino), String(rootStat.ino));
      if (chatRecipe) {
        const file = path.join(fixture, recipeReflectionGates ? "native-recipe-reflection-gate-installed-evidence.json"
          : recipeBranches ? "native-recipe-branch-installed-evidence.json"
          : recipeReports ? "native-recipe-report-installed-evidence.json"
          : recipeKnowledge ? "native-recipe-knowledge-installed-evidence.json" : "native-recipe-installed-evidence.json");
        const evidence = JSON.parse(fs.readFileSync(file));
        evidence.finalRootAndInstalledIdentityVerified = true;
        fs.writeFileSync(file, JSON.stringify(evidence), { mode: 0o600 });
      }
      return;
    }
    const chats = [descriptor.inline, descriptor.segmented, descriptor.text].map(chatId => ({ namespace: descriptor.namespace, chatId }));
    const hostDescriptor = { root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
      todoBoards: descriptor.todoBoards,
      chats, providerEndpoint: endpoint };
    fs.writeFileSync("native-host.json", JSON.stringify(hostDescriptor), { mode: 0o600 });
    const profileStorage = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge");
    fs.mkdirSync(profileStorage, { recursive: true, mode: 0o700 });
    const grantFile = path.join(profileStorage, "next-chat-ui-experiment.json");
    Object.assign(descriptor, { privateCodeCli: cli, privateCodeArgs: args, privateGrantFile: grantFile });
    fs.writeFileSync("api-chat-fixture.json", JSON.stringify(descriptor), { mode: 0o600 });
    let activeGrant;
    const fileCrashHarness = descriptor.todoBoards?.length ? await require("../tests/next-trial-electron/native-board-files-crash.cjs").create({
      fixture, root, target, nonce, host: path.join(project, "tests/next-trial-electron/native-chat-ui-host.cjs"),
    }) : undefined;
    async function startBroker(recovering = false, holdWorkerAck = false) {
      broker = spawn(process.execPath, [path.join(project, "tests/next-trial-electron/native-chat-ui-host.cjs"), fixture, root, target, nonce],
        { cwd: fixture, env: { ...env, ...fileCrashHarness?.env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce,
          PKM_NATIVE_UI_INTERRUPT_TODO_INTENT: descriptor.todoBoards?.length ? nonce : "",
          PKM_NATIVE_UI_INTERRUPT_BOARD_CREATE: descriptor.todoBoards?.length ? nonce : "",
          PKM_NATIVE_UI_HOLD_WORKER_ACK: holdWorkerAck ? nonce : "",
          PKM_NATIVE_UI_INTERRUPT_AFTER_RESULT: recovering ? "" : nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      processes.add(broker); broker.once("exit", () => processes.delete(broker));
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native UI child was not responsive.")), 30000);
        broker.once("message", message => { clearTimeout(timer); assert.equal(message.type, "ready"); resolve(message); });
        broker.once("exit", code => { clearTimeout(timer); reject(new Error(`Native UI child refused startup: ${code}`)); });
        broker.once("error", reject);
      });
      activeGrant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
        rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
        actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer, todoBoards: descriptor.todoBoards };
      fs.writeFileSync(`${grantFile}.next`, JSON.stringify(activeGrant), { flag: "wx", mode: 0o600 });
      fs.renameSync(`${grantFile}.next`, grantFile);
      const status = await rpc({ method: "status" });
      assert.equal(status.root, root); assert.equal(status.actorId, actorId);
    }
    async function rpc(input) {
      const response = await fetch(`${activeGrant.endpoint}/rpc`, { method: "POST",
        headers: { authorization: `Bearer ${activeGrant.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
        body: JSON.stringify(input) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.value;
    }
    const nativeEnv = { PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile };
    await startBroker(); await startCode(nativeEnv);
    const exited = new Promise(resolve => broker.once("exit", (code, signal) => resolve([code, signal])));
    await python("native-session");
    const actualExit = await Promise.race([exited, wait(30000).then(() => { throw new Error("No actual exit78 occurred."); })]);
    assert.deepEqual(actualExit, [78, null]);
    await stopCode();
    const beforeRecovery = calls.length;
    await startBroker(true); await startCode(nativeEnv); await python("reopen");
    if (fileCrashHarness) {
      await stopCode();
      const markerFile = path.join(fixture, "board-file-lifecycle.json");
      for (const kind of ["move", "trash", "restore"]) {
        const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
        const canonical = path.join(root, "boards", marker.boardSlug, "pkm-todo-board.json");
        const raw = fs.readFileSync(canonical);
        descriptor.boardFileCrash = { kind };
        fs.writeFileSync("api-chat-fixture.json", JSON.stringify(descriptor), { mode: 0o600 });
        const stoppedAtPrefix = fileCrashHarness.arm({ broker, kind, boardSlug: marker.boardSlug, notePath: marker.path });
        await startCode(nativeEnv); await python("board-file-interrupt");
        const proof = await stoppedAtPrefix();
        await stopCode();
        const killed = new Promise(resolve => broker.once("exit", (code, signal) => resolve([code, signal])));
        broker.kill("SIGKILL"); assert.deepEqual(await killed, [null, "SIGKILL"]); broker = undefined;
        await startBroker(true);
        const event = fileCrashHarness.recovered(proof);
        assert.equal(event.path, kind === "move" ? `Crash move/${path.posix.basename(marker.path)}` : marker.path);
        assert.deepEqual(fs.readFileSync(canonical), raw, "Board file recovery changed task history/canonical worker authority.");
        if (kind === "trash") {
          const entry = (await rpc({ method: "todo-trash" })).find(item => item.boardSlug === marker.boardSlug);
          assert(entry); assert.equal(entry.originalPath, marker.path);
        } else {
          const live = await rpc({ method: "todo", input: { kind: "read", boardSlug: marker.boardSlug } });
          assert.equal(live.note.path, event.path);
          assert.equal(live.note.knowledgeId, marker.knowledgeId); assert.equal(live.note.documentId, marker.documentId);
          assert.deepEqual(live.snapshot, marker.snapshot);
          marker.path = live.note.path;
          fs.writeFileSync(markerFile, JSON.stringify(marker), { mode: 0o600 });
        }
        await startCode(nativeEnv); await python("board-file-recovered"); await stopCode();
        console.log("PASS REAL BOARD FILE SYSCALL CRASH/RECOVERY", kind, proof.operationId, proof.source, proof.destination);
      }
    }
    assert.equal(calls.length, beforeRecovery, "Durable UI provider recovery silently issued another HTTP request.");
    const history = await rpc({ method: "history", namespace: descriptor.namespace, chatId: descriptor.inline });
    for (const marker of ["WINDOW_ONE", "MULTI_A", "MULTI_B", "CRASH_RESULT"]) {
      assert.equal(history.messages.filter(message => message.content === `NATIVE_UI_${marker}`).length, 1);
      assert.equal(history.messages.filter(message => message.content === `NATIVE_UI_DURABLE_${marker}`).length, 1);
      assert.equal(calls.filter(call => call === `NATIVE_UI_${marker}`).length, 1);
    }
    const sentImage = history.messages.find(message => message.content === "NATIVE_UI_WINDOW_ONE").images[0];
    assert.equal(sentImage.label, descriptor.nativeImageLabel);
    assert.equal(sentImage.dataBase64, descriptor.nativeImageBase64);
    assert.notEqual(sentImage.dataBase64, fixtureModule.image.dataBase64);
    assert.deepEqual(history.messages[0].images, [fixtureModule.image]);
    await stopCode();
    if (descriptor.todoBoards?.length) {
      const slug = descriptor.todoBoards[0], current = await rpc({ method: "todo", input: { kind: "read", boardSlug: slug } });
      const directory = path.join(root, "boards", slug), operationId = randomUUID();
      const input = { kind: "command", boardSlug: slug, expectedDigest: current.snapshot.digest, operationId,
        command: { action: "comment", id: "old-task", text: "NATIVE_TODO_CRASH_INTENT" } };
      command("mount", ["--bind", directory, directory]);
      const died = new Promise(resolve => broker.once("exit", code => resolve(code)));
      try {
        command("mount", ["-o", "remount,bind,ro", directory]);
        assert.throws(() => {
          const fd = fs.openSync(path.join(directory, "pkm-todo-board.json"), fs.constants.O_WRONLY | fs.constants.O_APPEND);
          fs.closeSync(fd);
        }, error => error.code === "EROFS", "The private bind must actually deny writes, even for namespace-root DAC capabilities.");
        await assert.rejects(() => rpc({ method: "todo", input }));
        assert.equal(await Promise.race([died, wait(10000).then(() => { throw new Error("No actual Todo intent exit79 occurred."); })]), 79);
      } finally { command("umount", [directory]); }
      await startBroker(true);
      const recovered = await rpc({ method: "todo", input });
      assert.equal(recovered.snapshot.items.find(item => item.id === "old-task").comments
        .filter(comment => comment.text === "NATIVE_TODO_CRASH_INTENT").length, 1);
      const replayed = await rpc({ method: "todo", input });
      assert.deepEqual(replayed.snapshot, recovered.snapshot);
      await startCode(nativeEnv); await python("reopen"); await stopCode();
      assert.equal(calls.filter(call => call === "NATIVE_UI_TODO_CHAT").length, 1);
      const old = JSON.parse(fs.readFileSync(path.join(fixture, "todo-board-fixture.json"), "utf8"));
      const fileMarkerPath = path.join(fixture, "board-file-lifecycle.json");
      const fileMarker = fs.existsSync(fileMarkerPath) ? JSON.parse(fs.readFileSync(fileMarkerPath, "utf8")) : undefined;
      for (const board of old.boards) {
        const live = await rpc({ method: "todo", input: { kind: "read", boardSlug: board.slug } });
        assert.equal(live.note.knowledgeId, board.note.knowledgeId);
        const expectedAliases = [...board.note.aliases];
        if (fileMarker?.boardSlug === board.slug) {
          assert.equal(live.note.path, fileMarker.path);
          expectedAliases.push(`note:${fileMarker.path.slice(0, -3)}`);
        }
        assert.deepEqual(live.note.aliases, [...new Set(expectedAliases)].sort());
        for (const originalItem of board.snapshot.items) {
          const item = live.snapshot.items.find(candidate => candidate.id === originalItem.id);
          assert(item, `Lost original Work Item ${originalItem.id}`);
          assert.deepEqual(item.history.slice(0, originalItem.history?.length ?? 0), originalItem.history ?? []);
          assert.deepEqual((item.comments ?? []).slice(0, originalItem.comments?.length ?? 0), originalItem.comments ?? []);
          if (originalItem.id === "old-done") assert.deepEqual(item, originalItem, "Original accepted result and all audit fields must remain untouched.");
        }
      }
      console.log("PASS: actual exit79 after durable native Todo user intent, real filesystem denial, complete broker/Code restart and exact operationId replay; one new history/comment and original identities preserved.");
      const previousWorkerHash = (await rpc({ method: "todo", input: { kind: "read", boardSlug: slug } }))
        .workerGrants["external:copilot:fixture-worker"];
      const stoppedBroker = new Promise(resolve => broker.once("exit", resolve));
      broker.kill("SIGTERM"); assert.equal(await stoppedBroker, 0);
      await startBroker(true, true);
      const held = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No actual committed worker grant reached the lost-ack barrier.")), 30000);
        broker.once("message", message => {
          clearTimeout(timer);
          if (message.type !== "worker-ack-held") reject(new Error("Unexpected private worker barrier message."));
          else resolve(message);
        });
      });
      await startCode(nativeEnv);
      const [evidence] = await Promise.all([held, python("worker-interrupt")]);
      assert.notEqual(evidence.tokenHash, previousWorkerHash, "Lost-ack test must rotate a real existing token.");
      const pendingKey = `pkm.privateNativeTodo.workerPending:${prepared.workspaceId}`;
      const workerPending = () => {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(path.join(fixture, "u/User/globalStorage/state.vscdb"), { readOnly: true });
        try {
          const row = db.prepare("SELECT value FROM ItemTable WHERE key=?").get("Uone.personal-knowledge");
          return row ? JSON.parse(String(row.value))[pendingKey] ?? {} : {};
        } finally { db.close(); }
      };
      const indexedWorker = await rpc({ method: "todo", input: { kind: "read", boardSlug: slug } });
      assert.equal(indexedWorker.workerGrants[evidence.actorId], evidence.tokenHash);
      await stopCode();
      const heldBroker = new Promise(resolve => broker.once("exit", resolve));
      broker.kill("SIGTERM"); assert.equal(await heldBroker, 0);
      await startBroker(true); await startCode(nativeEnv); await python("worker-recovered"); await stopCode();
      assert.deepEqual(workerPending(), {}, "The real profile retained a supposedly finalized pending worker grant.");
      assert.equal(createHash("sha256").update(fs.readFileSync(path.join(root, "boards", slug, "pkm-todo-board.json"))).digest("hex"),
        evidence.nativeBoardSha256, "SecretStorage recovery issued another native Board write.");
      const recoveredWorker = await rpc({ method: "todo", input: { kind: "read", boardSlug: slug } });
      assert.equal(recoveredWorker.workerGrants[evidence.actorId], evidence.tokenHash);
      fs.writeFileSync(path.join(fixture, "worker-lost-ack-evidence.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
      console.log("PASS: real worker grant COMMIT with withheld HTTP acknowledgement, native hash-indexed pending SecretStorage, full Code/broker interruption and verified pending-secret cleanup; no extra grant or Board write, no plaintext token exposed.");
      const notes = path.join(root, "notes");
      command("mount", ["--bind", notes, notes]);
      try {
        command("mount", ["-o", "remount,bind,ro", notes]);
        assert.throws(() => {
          const fd = fs.openSync(path.join(notes, `${descriptor.todoBoards[0]}.md`), fs.constants.O_WRONLY | fs.constants.O_APPEND);
          fs.closeSync(fd);
        }, error => error.code === "EROFS");
        const interruptedCreate = new Promise(resolve => broker.once("exit", resolve));
        await startCode(nativeEnv); await python("board-create-interrupt");
        assert.equal(await Promise.race([interruptedCreate, wait(10000).then(() => { throw new Error("No actual Board creation exit82."); })]), 82);
        await stopCode();
      } finally { await stopCode(); command("umount", [notes]); }
      const creationEvidence = JSON.parse(fs.readFileSync(path.join(fixture, "board-create-crash-evidence.json"), "utf8"));
      await startBroker(true);
      const recoveredCreation = await rpc({ method: "todo-create", input: creationEvidence.input });
      assert.equal(recoveredCreation.slug, "NATIVE_BOARD_CRASH_CREATION");
      assert.deepEqual(await rpc({ method: "todo-create", input: creationEvidence.input }), recoveredCreation);
      await assert.rejects(() => rpc({ method: "todo-create", input: { ...creationEvidence.input, title: "Wrong replay" } }));
      await startCode(nativeEnv); await python("board-create-recovered"); await stopCode();
      console.log("PASS: actual original Library creation hits real read-only filesystem denial after durable user create intent, exit82; default full restart publishes one identified Board and exact operationId replay is idempotent.");
    }
    const retainedGrant = `${grantFile}.retained`;
    const activationFailures = () => {
      let count = 0;
      const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else if (entry.name === "exthost.log")
            count += fs.readFileSync(file, "utf8").split("legacy initialization is blocked").length - 1;
        }
      };
      visit(path.join(fixture, "u/logs")); return count;
    };
    const previousFailures = activationFailures();
    fs.renameSync(grantFile, retainedGrant);
    fs.symlinkSync(path.join(profileStorage, "missing-native-fixture-grant"), grantFile);
    try {
      await startCode();
      const deadline = Date.now() + 20000;
      while (activationFailures() === previousFailures && Date.now() < deadline) await wait(100);
      assert(activationFailures() > previousFailures, "A marked profile without an explicit valid grant fell back to legacy activation.");
      await stopCode();
    } finally {
      await stopCode();
      fs.unlinkSync(grantFile); fs.renameSync(retainedGrant, grantFile);
    }
    console.log("PASS: actual installed profile without its grant, including a dangling grant entry, refuses legacy activation.");
    if (descriptor.todoBoards?.length) {
      for (const slug of ["NATIVE_UI_CREATED_BOARD", "NATIVE_BOARD_CRASH_CREATION"]) {
        const live = await rpc({ method: "todo", input: { kind: "read", boardSlug: slug } });
        assert.equal(live.note.documentKind, "todo-board");
      }
    }
    let fileLifecycle;
    if (descriptor.todoBoards?.length) {
      fileLifecycle = JSON.parse(fs.readFileSync(path.join(fixture, "board-file-lifecycle.json"), "utf8"));
      assert.equal(fileLifecycle.boardSlug, "OLD_UI_CREATED_BOARD");
      assert.equal(fileLifecycle.originalPath, "OLD_UI_CREATED_BOARD.md");
      const live = await rpc({ method: "todo", input: { kind: "read", boardSlug: fileLifecycle.boardSlug } });
      assert.equal(live.note.path, fileLifecycle.path);
      assert.equal(live.note.knowledgeId, fileLifecycle.knowledgeId);
      assert.deepEqual(live.snapshot, fileLifecycle.snapshot);
    }
    const stopped = new Promise(resolve => broker.once("exit", code => resolve(code)));
    broker.kill("SIGTERM"); assert.equal(await stopped, 0); broker = undefined;
    assert.deepEqual(inventory(target), installedInventory, "Actual installed target payload changed while running.");
    const after = inventory(root);
    const relocated = new Map();
    if (fileLifecycle) {
      const { readNativeBoardGenesisSource, nativeBoardLifecycleCatalog } = await import(
        pathToFileURL(path.join(target, "next-runtime/server/dist/native-board-lifecycle-state.js")).href);
      const source = `notes/${fileLifecycle.originalPath}`, destination = `notes/${fileLifecycle.path}`;
      const archived = readNativeBoardGenesisSource(root, source, original[source].sha256);
      assert(archived && createHash("sha256").update(archived).digest("hex") === original[source].sha256,
        "Original descriptor bytes lost their exact pinned immutable genesis.");
      const event = nativeBoardLifecycleCatalog(root).get(fileLifecycle.boardSlug);
      assert.equal(event.status, "active"); assert.equal(event.path, fileLifecycle.path);
      assert.equal(event.documentSha256, after[destination].sha256);
      assert.equal(event.noteId, fileLifecycle.documentId);
      assert(!after[source], "Authorized old descriptor path was silently reused.");
      relocated.set(source, null);
      const beforeAssets = source.replace(/\.md$/, ".assets/"), afterAssets = destination.replace(/\.md$/, ".assets/");
      for (const file of Object.keys(original)) if (file.startsWith(beforeAssets)) {
        const moved = afterAssets + file.slice(beforeAssets.length);
        assert(!after[file], "Original backing location was silently reused.");
        assert.deepEqual(after[moved], original[file], `Paired source backing was copied or changed: ${file}`);
        relocated.set(file, moved);
      }
    }
    for (const [file, metadata] of Object.entries(original))
      if (!relocated.has(file)) assert.deepEqual(after[file], metadata, `Original source file changed: ${file}`);
    const nativeFiles = new Set(["core.sqlite", "core.sqlite-wal", "core.sqlite-shm",
      ".pkm-next-root-adoption.json", ".pkm-next-root-adoption.commit.json", ".pkm-next-workspace"]);
    const journal = JSON.parse(fs.readFileSync(path.join(root, ".pkm-next-root-adoption.json"), "utf8"));
    for (const board of journal.todoProjection?.boards ?? []) {
      const parts = board.destination.split("/");
      for (let index = 1; index <= parts.length; index++) nativeFiles.add(parts.slice(0, index).join("/"));
    }
    if (descriptor.todoBoards?.length) {
      for (const slug of ["NATIVE_UI_CREATED_BOARD", "NATIVE_BOARD_CRASH_CREATION"]) {
        nativeFiles.add(`notes/${slug}.md`);
        nativeFiles.add(`boards/${slug}/pkm-todo-board.json`);
      }
      nativeFiles.add(`notes/${fileLifecycle.path}`);
      for (const destination of relocated.values()) if (destination) nativeFiles.add(destination);
    }
    for (const file of Object.keys(after))
      assert(file in original || nativeFiles.has(file), `Unexpected new source/workflow state: ${file}`);
    assert.equal(String(fs.statSync(root, { bigint: true }).ino), String(rootStat.ino));
    console.log("PASS: bounded installed native renderer protocol: original history/PNG, actual HTTP/durable sends, two real windows, stale-draft preservation, attachments and actual exit78/full-Code restart without provider replay.");
    console.log(protocolOnly ? "Protocol-only evidence does NOT qualify an original legacy UI activation root."
      : "PASS: original old-UI root journey within explicit private experimental scope.");
  } finally {
    await stopCode();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = new Promise(resolve => broker.once("exit", resolve));
      broker.kill("SIGTERM");
      await Promise.race([exited, wait(1000)]);
      if (broker.exitCode === null && broker.signalCode === null) { broker.kill("SIGKILL"); await exited; }
    }
    if (provider) await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    console.log("PRIVATE UI FIXTURE retained for bounded evidence:", fixture);
  }
}
main().catch(error => { console.error("FAIL: actual installed native Chat UI:", error.stack || error); process.exitCode = 1; });
