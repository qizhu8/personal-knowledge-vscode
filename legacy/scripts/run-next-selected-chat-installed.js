#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { createServer } = require("node:http");
const project = path.resolve(__dirname, "..");
const old = path.join(project, ".migration-test-work/root-upgrade-validation/installed-6c4415d4-335c-4584-afec-8a4f5056d48f/extensions/uone.personal-knowledge-4.0.22");
const candidateArgument = process.argv.find(arg => arg.startsWith("--candidate="));
const sdkFixtureArgument = process.argv.find(arg => arg.startsWith("--sdk-fixture-dir="));
const freezeArgument = process.argv.find(arg => arg.startsWith("--freeze-output="));
const separateView = process.argv.includes("--separate-view");
const heartbeatFix = process.argv.includes("--heartbeat-fix");
const prepareOnly = process.argv.includes("--prepare-only");
const originalUi = process.argv.includes("--original-ui");
const afterTaskUi = process.argv.includes("--after-task-ui");
const alreadyFrozen = process.argv.includes("--already-frozen");
const sessionUi = process.argv.includes("--session-ui");
const timeoutUi = process.argv.includes("--timeout-ui");
const permissionUi = process.argv.includes("--permission-ui");
const sdkPermissionUi = process.argv.includes("--sdk-permission-ui");
const revokeUi = process.argv.includes("--revoke-ui");
const recoveryUi = process.argv.includes("--recovery-ui") || revokeUi || timeoutUi;
const steerUi = process.argv.includes("--steer-ui") || recoveryUi;
const historyImageOnly = process.argv.includes("--history-image-only");
const nativeSave = process.argv.includes("--native-save-dialog");
const historyImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=";
const editor = process.env.PKM_VSCODE_EXECUTABLE || path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code");
const xvfb = process.env.PKM_TRIAL_XVFB || path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function verifySdkFixtureBundle(directory) {
  const hashes = JSON.parse(fs.readFileSync(path.join(directory, "sha256.json"), "utf8"));
  const required = ["selected-chat-installed-driver.cjs", "sdk-stdio-proxy.cjs", "sdk-local-transport.cjs",
    "selected_chat_sdk_permission_ui.py", "selected_chat_sdk_dialogs.py"];
  assert.deepEqual(Object.keys(hashes).sort(), required.sort(), "Unexpected SDK fixture bundle manifest");
  for (const name of required)
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex"),
      hashes[name], `Frozen SDK fixture changed: ${name}`);
  return hashes;
}
function treeDigest(directory) {
  const entries = [];
  function visit(base, prefix = "") {
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name), relative = path.join(prefix, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { entries.push([relative, "directory"]); visit(file, relative); }
      else if (stat.isFile()) entries.push([relative, "file", createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
      else throw new Error("Unexpected synthetic Chat archive entry");
    }
  }
  visit(directory);
  return JSON.stringify(entries);
}

async function main() {
  if (process.argv.includes("--sdk-fixture-verify")) {
    if (!sdkFixtureArgument) throw new Error("Provide --sdk-fixture-dir for offline bundle verification.");
    console.log("Frozen SDK fixture SHA256", JSON.stringify(verifySdkFixtureBundle(
      path.resolve(sdkFixtureArgument.slice("--sdk-fixture-dir=".length)))));
    return;
  }
  if (!process.argv.includes("--inside")) {
    for (const executable of [editor, xvfb]) fs.accessSync(executable, fs.constants.X_OK);
    const args = require("./run-next-trial-private-display").privateNamespaceArgs(
      [process.execPath, __filename, "--inside", editor, xvfb, ...(candidateArgument ? [candidateArgument] : []),
        ...(freezeArgument ? [freezeArgument] : []),
        ...(separateView ? ["--separate-view"] : []), ...(heartbeatFix ? ["--heartbeat-fix"] : []),
        ...(prepareOnly ? ["--prepare-only"] : []), ...(historyImageOnly ? ["--history-image-only"] : []),
        ...(steerUi ? ["--steer-ui"] : []), ...(recoveryUi ? ["--recovery-ui"] : []), ...(revokeUi ? ["--revoke-ui"] : []),
        ...(originalUi ? ["--original-ui"] : []), ...(afterTaskUi ? ["--after-task-ui"] : []),
        ...(alreadyFrozen ? ["--already-frozen"] : []),
        ...(timeoutUi ? ["--timeout-ui"] : []), ...(sessionUi ? ["--session-ui"] : []),
        ...(permissionUi ? ["--permission-ui"] : []),
        ...(sdkPermissionUi ? ["--sdk-permission-ui"] : []),
        ...(sdkFixtureArgument ? [sdkFixtureArgument] : []),
        ...(nativeSave ? ["--native-save-dialog"] : [])]);
    const run = spawnSync("unshare", args, { cwd: project, env: { PATH: process.env.PATH }, stdio: "inherit", timeout: 900000 });
    if (run.error || run.status) throw run.error || new Error(`Private selected Chat run failed: ${run.status ?? run.signal}`);
    return;
  }
  process.umask(0o077);
  const inside = process.argv.indexOf("--inside");
  const [codeExecutable, displayExecutable] = process.argv.slice(inside + 1, inside + 3);
  if (heartbeatFix && (!candidateArgument || !separateView))
    throw new Error("Heartbeat test variant requires an explicit frozen candidate and separate view.");
  if (historyImageOnly && (!candidateArgument || !separateView || !heartbeatFix))
    throw new Error("History image test requires the explicit frozen heartbeat variant.");
  if (nativeSave && !historyImageOnly) throw new Error("Native save dialog requires the isolated image test.");
  if (originalUi && (!candidateArgument || steerUi || separateView || prepareOnly))
    throw new Error("Original UI requires its explicit original VSIX and no Next variants.");
  if (sessionUi && (!candidateArgument || !freezeArgument || steerUi || separateView || prepareOnly || originalUi))
    throw new Error("Session UI requires an explicit frozen candidate and unique output, without other variants.");
  if (afterTaskUi && (steerUi || separateView || sessionUi || !candidateArgument
    || !originalUi && !freezeArgument && !alreadyFrozen || alreadyFrozen && !!freezeArgument))
    throw new Error("After-Task UI requires an explicit candidate and, for Next, a unique private frozen output.");
  if (steerUi && (separateView || historyImageOnly || nativeSave))
    throw new Error("Steer UI requires a complete candidate, without test overlays.");
  if ((permissionUi || sdkPermissionUi) && (!candidateArgument || !alreadyFrozen || originalUi || steerUi || sessionUi || afterTaskUi || separateView))
    throw new Error("Permission UI requires its explicit already-frozen isolated candidate.");
  if (sdkFixtureArgument && !sdkPermissionUi) throw new Error("SDK fixture bundle is only for the SDK permission journey.");
  const sdkFixtureDir = sdkFixtureArgument ? path.resolve(sdkFixtureArgument.slice("--sdk-fixture-dir=".length)) : undefined;
  let sdkFixtureHashes;
  if (sdkFixtureDir) {
    sdkFixtureHashes = verifySdkFixtureBundle(sdkFixtureDir);
    console.log("Frozen SDK fixture SHA256", JSON.stringify(sdkFixtureHashes));
  }
  const fixture = path.join(project, ".migration-test-work", `selected-code-${randomUUID()}`);
  const home = path.join(fixture, "home"), local = path.join(fixture, "local"), build = path.join(fixture, "build");
  for (const name of [fixture, home, local, build, path.join(fixture, "user/User"), path.join(fixture, "extensions"),
    path.join(fixture, "legacy"), path.join(fixture, "trial"), path.join(fixture, "workspace"), path.join(fixture, "dev")])
    fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  process.chdir(fixture);
  const short = `/proc/${process.pid}/cwd`;
  const shortLocal = `${short}/local`;
  const env = { PATH: process.env.PATH, HOME: `${short}/home`, USERPROFILE: `${short}/home`, TMPDIR: shortLocal, TMP: shortLocal, TEMP: shortLocal,
    XDG_RUNTIME_DIR: shortLocal, DISPLAY: "127.0.0.1:91", XAUTHORITY: path.join(fixture, "Xauthority"),
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1", PKM_SELECTED_FIXTURE: fixture, PKM_SELECTED_NODE: fs.realpathSync(process.execPath) };
  if (nativeSave) env.GSETTINGS_BACKEND = "memory";
  Object.assign(process.env, env);
  if (historyImageOnly) env.PKM_SELECTED_IMAGE_ONLY = "1";
  if (steerUi) env.PKM_SELECTED_STEER = "1";
  if (recoveryUi) env.PKM_SELECTED_RECOVERY = "1";
  if (revokeUi || timeoutUi) env.PKM_SELECTED_REVOKE = "1";
  if (timeoutUi) env.PKM_SELECTED_TIMEOUT = "1";
  if (originalUi) env.PKM_SELECTED_ORIGINAL_UI = "1";
  if (afterTaskUi) env.PKM_SELECTED_AFTER_TASK_UI = "1";
  if (sessionUi) env.PKM_SELECTED_SESSION_UI = "1";
  if (permissionUi) env.PKM_SELECTED_PERMISSION_UI = "1";
  if (sdkPermissionUi) {
    env.PKM_SELECTED_PERMISSION_UI = "1";
    env.PKM_SELECTED_SDK_UI = "1";
    env.PKM_SELECTED_SDK_PROXY = sdkFixtureDir ? path.join(sdkFixtureDir, "sdk-stdio-proxy.cjs")
      : path.join(project, "tests/next-trial-electron/sdk-stdio-proxy.cjs");
    env.NODE_PATH = path.join(path.dirname(codeExecutable), "resources/app/node_modules.asar");
  }
  if (nativeSave) env.PKM_SELECTED_REAL_SAVE = "1";
  const children = new Set();
  function run(file, args, options = {}) {
    const result = spawnSync(file, args, { cwd: fixture, env, stdio: "inherit", timeout: 240000, ...options });
    if (result.error || result.status) throw result.error || new Error(`${path.basename(file)} failed: ${result.status ?? result.signal}`);
  }
  function launch(file, args, extraEnv = {}) {
    const child = spawn(file, args, { cwd: fixture, env: { ...env, ...extraEnv }, stdio: "inherit" });
    children.add(child); child.once("exit", () => children.delete(child)); return child;
  }
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, wait(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
  let server, sdkTransport, code, display, success = false;
  try {
    run("ip", ["link", "set", "lo", "up"]);
    fs.writeFileSync(env.XAUTHORITY, "", { flag: "wx", mode: 0o600 });
    run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomBytes(16).toString("hex")]);
    if (!prepareOnly) {
      display = launch(displayExecutable, [":91", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix",
        "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY]);
      let displayReady = false;
      for (let i = 0; i < 100; i++) {
        if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0) { displayReady = true; break; }
        await wait(50);
      }
      assert(displayReady, "Private display unavailable");
    }
    const sourceNames = ["package.json", "package-lock.json", "tsconfig.json", ".vscodeignore", "README.md", "CHANGELOG.md",
      "LICENSE", "FEATURES.md", "src", "scripts", "resources", "modules", "tools", "tests", "next-server", "docs"];
    sourceNames.push(...fs.readdirSync(project).filter(name => /^package\.nls(?:\.[^.]+)?\.json$/.test(name)));
    if (!candidateArgument) for (const name of sourceNames) {
      const source = path.join(project, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(build, name), { recursive: true, verbatimSymlinks: true,
        filter: file => !["node_modules", "dist", "__pycache__"].includes(path.basename(file)) });
    }
    let vsix = candidateArgument?.slice("--candidate=".length);
    if (vsix) {
      if (!path.isAbsolute(vsix)) throw new Error("Candidate VSIX must be an absolute path.");
      fs.accessSync(vsix, fs.constants.R_OK);
      if (sessionUi || afterTaskUi && !originalUi && !alreadyFrozen) {
        const extracted = path.join(fixture, "session-candidate");
        fs.mkdirSync(extracted, { mode: 0o700 });
        run("unzip", ["-q", vsix, "-d", extracted]);
        const adapterSource = fs.readFileSync(path.join(project, "src/chat/native-chat-ui-experiment.ts"), "utf8");
        const rendererSource = fs.readFileSync(path.join(project, "src/webview/api-chat.js"), "utf8");
        const adapter = require("typescript").transpileModule(adapterSource, { compilerOptions: {
          target: require("typescript").ScriptTarget.ES2020, module: require("typescript").ModuleKind.CommonJS, esModuleInterop: true,
        } }).outputText;
        fs.writeFileSync(path.join(extracted, "extension/dist/chat/native-chat-ui-experiment.js"), adapter);
        fs.writeFileSync(path.join(extracted, "extension/dist/webview/api-chat.js"), rendererSource);
        if (afterTaskUi) {
          const manifestPath = path.join(extracted, "extension/next-runtime/manifest.json");
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          for (const name of ["legacy-api-chat-managed-runtime", "legacy-api-chat-ui-host", "legacy-api-chat-workflow"]) {
            const relative = `server/dist/${name}.js`;
            const bytes = fs.readFileSync(path.join(project, "next-server/.migration-test-work/after-task-private-dist", `${name}.js`));
            fs.writeFileSync(path.join(extracted, "extension/next-runtime", relative), bytes);
            manifest.files[relative] = createHash("sha256").update(bytes).digest("hex");
          }
          manifest.buildId = createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex");
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        }
        const output = freezeArgument.slice("--freeze-output=".length);
        if (!path.isAbsolute(output) || !output.startsWith(path.join(project, ".migration-test-work") + path.sep)
          || fs.existsSync(output)) throw new Error("Session test candidate must be a new private project file.");
        run("zip", ["-q", "-D", "-r", output, "."], { cwd: extracted });
        vsix = output;
        console.log("Session test overlay source hashes", JSON.stringify({
          adapter: createHash("sha256").update(adapterSource).digest("hex"),
          renderer: createHash("sha256").update(rendererSource).digest("hex") }));
        console.log(afterTaskUi ? "After-Task overlay: two Chat UI files and three Next Chat runtime files, with refreshed manifest."
          : "Test overlay changes only two Chat UI files of the explicitly supplied frozen candidate.");
      }
      if (separateView) {
        const extracted = path.join(fixture, "candidate-source");
        fs.mkdirSync(extracted, { mode: 0o700 });
        run("unzip", ["-q", vsix, "-d", extracted]);
        const manifestPath = path.join(extracted, "extension/package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const source = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
        const oldViews = manifest.contributes.views.personalKnowledgeChat;
        const nextViews = oldViews.filter(view => view.id === "personalKnowledge.nextSelectedChat");
        assert.equal(nextViews.length, 1);
        manifest.contributes.views.personalKnowledgeChat = oldViews.filter(view => view.id !== "personalKnowledge.nextSelectedChat");
        manifest.contributes.views.personalKnowledgeNextChat = nextViews;
        const nextContainer = source.contributes.viewsContainers.secondarySidebar.find(item => item.id === "personalKnowledgeNextChat");
        assert(nextContainer);
        manifest.contributes.viewsContainers.secondarySidebar.push(nextContainer);
        assert.deepEqual(manifest.contributes.views.personalKnowledgeNextChat, source.contributes.views.personalKnowledgeNextChat);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        const ts = require("typescript");
        const uiSource = fs.readFileSync(path.join(project, "src/chat/selected-owner-chat-ui.ts"), "utf8");
        const ui = ts.transpileModule(uiSource, { compilerOptions: { target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
        fs.writeFileSync(path.join(extracted, "extension/dist/chat/selected-owner-chat-ui.js"), ui);
        if (historyImageOnly) {
          const adapterSource = fs.readFileSync(path.join(project, "src/chat/native-chat-ui-experiment.ts"), "utf8");
          const adapter = ts.transpileModule(adapterSource, { compilerOptions: { target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
          fs.writeFileSync(path.join(extracted, "extension/dist/chat/native-chat-ui-experiment.js"), adapter);
          console.log("Test variant history image UI source SHA256", createHash("sha256").update(adapterSource).digest("hex"));
        }
        if (heartbeatFix) {
          const sourcePath = path.join(project, "next-server/src/legacy-api-chat-private-snapshot.ts");
          const text = fs.readFileSync(sourcePath, "utf8");
          const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ES2022 } }).outputText;
          const relative = "server/dist/legacy-api-chat-private-snapshot.js";
          fs.writeFileSync(path.join(extracted, "extension/next-runtime", relative), output);
          const runtimeManifestPath = path.join(extracted, "extension/next-runtime/manifest.json");
          const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8"));
          runtimeManifest.files[relative] = createHash("sha256").update(output).digest("hex");
          runtimeManifest.buildId = createHash("sha256").update(JSON.stringify(runtimeManifest.files)).digest("hex");
          fs.writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest, null, 2) + "\n");
          console.log("Test variant snapshot source SHA256", createHash("sha256").update(text).digest("hex"));
        }
        vsix = path.join(fixture, "candidate-separate-view.vsix");
        run("zip", ["-q", "-D", "-r", vsix, "."], { cwd: extracted });
        console.log(`Candidate test variant: selected view contribution/UI${heartbeatFix ? " and heartbeat snapshot" : ""} from current source; remaining bytes from frozen candidate.`);
      }
    } else {
      fs.symlinkSync(path.join(project, "node_modules"), path.join(build, "node_modules"), "dir");
      if (steerUi) {
        const modules = path.join(build, "next-server/node_modules");
        fs.cpSync(path.join(project, "next-server/node_modules"), modules, { recursive: true, verbatimSymlinks: true });
        fs.cpSync(path.join(project, "node_modules/image-size"), path.join(modules, "image-size"), { recursive: true });
        run("npm", ["ls", "--all", "--parseable"], { cwd: path.join(build, "next-server"), timeout: 180000,
          stdio: ["ignore", "ignore", "inherit"] });
      }
      else fs.symlinkSync(path.join(project, "next-server/node_modules"), path.join(build, "next-server/node_modules"), "dir");
      run("npm", ["run", "build", "--silent"], { cwd: build, timeout: 180000 });
      require(path.join(build, "scripts/next-rehearsal-runtime.js")).stage(path.join(build, "next-runtime"), { production: true });
      vsix = path.join(fixture, "candidate.vsix");
      run("vsce", ["package", "--no-dependencies", "--out", vsix], { cwd: build,
        env: { ...env, PKM_PACKAGE_PREBUILT: "1", PKM_PACKAGE_NEXT_PAYLOAD_STAGED: "1" }, timeout: 180000 });
      const extensionModules = path.join(fixture, "package-overlay/extension/node_modules");
      fs.mkdirSync(extensionModules, { recursive: true, mode: 0o700 });
      for (const name of ["ws", "jsonc-parser"])
        fs.cpSync(path.join(project, "node_modules", name), path.join(extensionModules, name), { recursive: true });
      run("zip", ["-q", "-r", vsix, "extension/node_modules"], { cwd: path.join(fixture, "package-overlay") });
    }
    const candidateHash = createHash("sha256").update(fs.readFileSync(vsix)).digest("hex");
    if (originalUi && candidateHash !== "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27")
      throw new Error("Original UI oracle requires the verified original 4.0.22 VSIX.");
    console.log("Candidate VSIX SHA256", candidateHash);
    if (!originalUi) run("python3", ["-B", path.join(project, "scripts/verify-next-payload.py"), vsix]);
    if (prepareOnly) {
      if (freezeArgument && !afterTaskUi) {
        const output = freezeArgument.slice("--freeze-output=".length);
        if (!path.isAbsolute(output) || !output.startsWith(path.join(project, ".migration-test-work") + path.sep))
          throw new Error("Frozen candidate must be inside the isolated project test area.");
        fs.copyFileSync(vsix, output, fs.constants.COPYFILE_EXCL);
        console.log("Frozen complete candidate", output);
      }
      console.log("PASS selected Chat package verification only; no Code was launched."); success = true; return;
    }
    const cli = path.join(path.dirname(codeExecutable), "bin/code");
    const baseArgs = ["--no-sandbox", `--user-data-dir=${short}/user`, `--extensions-dir=${short}/extensions`];
    run(cli, [...baseArgs, "--install-extension", vsix, "--force"], { timeout: 120000 });
    const names = fs.readdirSync(path.join(fixture, "extensions")).filter(name => /^uone\.personal-knowledge-/i.test(name));
    assert.equal(names.length, 1, "Candidate extension must be installed.");
    const installedDriver = path.join(fixture, "extensions", names[0], "selected-chat-installed-driver.cjs");
    fs.copyFileSync(sdkFixtureDir ? path.join(sdkFixtureDir, "selected-chat-installed-driver.cjs")
      : path.join(project, "tests/next-trial-electron/selected-chat-installed-driver.cjs"), installedDriver);

    const legacy = path.join(fixture, "legacy");
    fs.mkdirSync(path.join(legacy, ".pkm/state"), { recursive: true, mode: 0o700 });
    const { ApiChatStore } = require(path.join(old, "dist/chat/api-chat-store.js"));
    const archiveStore = new ApiChatStore(path.join(legacy, ".pkm/state"), "0123456789abcdef");
    const originalChat = archiveStore.create();
    if (sessionUi) {
      const sessions = [];
      for (const [title, marker] of [["First original task", "FIRST_TASK_INPUT"], ["Second original task", "SECOND_TASK_INPUT"]]) {
        archiveStore.startTask(originalChat, title);
        const sessionId = originalChat.sessionId;
        originalChat.messages.push({ id: randomUUID(), role: "user", status: "complete", taskId: sessionId, content: marker });
        archiveStore.save(originalChat);
        archiveStore.completeTask(originalChat);
        const record = JSON.parse(fs.readFileSync(path.join(legacy, ".pkm/state/agent-sessions", `${sessionId}.json`), "utf8"));
        const { apiChatSessionHarnessSnapshot } = require(path.join(old, "dist/chat/api-chat-store.js"));
        assert.equal(apiChatSessionHarnessSnapshot(record, sessionId, path.join(legacy, ".pkm/state")).currentProblem, marker);
        sessions.push({ sessionId, title, marker });
      }
      fs.writeFileSync(path.join(fixture, "original-task-sessions.json"), JSON.stringify(sessions), { mode: 0o600 });
    }
    if (originalUi || afterTaskUi) {
      archiveStore.startTask(originalChat, "Isolated original UI task");
      if (afterTaskUi) {
        originalChat.messages.push({ id: randomUUID(), role: "user", status: "complete",
          taskId: originalChat.sessionId, content: "AFTER_TASK_ARCHIVED_HISTORY" });
        fs.writeFileSync(path.join(fixture, "after-task-original-session"), originalChat.sessionId, { mode: 0o600 });
      }
      originalChat.permissionMode = "read-only";
      archiveStore.save(originalChat);
      fs.writeFileSync(path.join(fixture, "original-chat-locator"),
        `pkm://chats/${originalChat.workspaceNamespace}/${originalChat.id}`, { mode: 0o600 });
    }
    if (recoveryUi) {
      archiveStore.startTask(originalChat, "Original archived task");
      originalChat.messages.push({ id: randomUUID(), role: "user", status: "complete", content: "ORIGINAL_RETAINED_MESSAGE" });
      originalChat.queuedInputs = [{ id: randomUUID(), text: "ORIGINAL_ARCHIVED_QUEUE", mode: "task" }];
      archiveStore.save(originalChat);
    }
    if (historyImageOnly) {
      originalChat.messages.push({ id: "original-image", role: "user", status: "complete", content: "Original image",
        images: [{ label: "original.png", mimeType: "image/png", dataBase64: historyImage }] });
      archiveStore.save(originalChat);
      if (nativeSave) fs.writeFileSync(path.join(fixture, "workspace/export.png"), "original isolated destination", { flag: "wx", mode: 0o600 });
    }
    const archive = path.join(legacy, ".pkm/state/api-chats");
    const original = treeDigest(archive);
    const originalSessions = sessionUi || afterTaskUi ? treeDigest(path.join(legacy, ".pkm/state/agent-sessions")) : undefined;
    const ticks = path.join(fixture, "ticks"), script = path.join(fixture, "background.cjs");
    fs.writeFileSync(script, permissionUi || sdkPermissionUi
      ? `require('node:fs').appendFileSync(${JSON.stringify(ticks)},'x');`
      : steerUi
      ? `const fs=require('node:fs');const root=${JSON.stringify(fixture)}, counter=root+'/process-count';const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;fs.writeFileSync(counter,String(n));fs.writeFileSync(root+'/process-pid-'+n,String(process.pid));fs.writeFileSync(root+'/process-start-'+n,'started');setInterval(()=>{if(fs.existsSync(root+'/release-process-'+n))process.exit(0)},20);`
      : `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(ticks)},'x'),20);`, { mode: 0o600 });
    let calls = 0, authCalls = 0, failureCalls = 0;
    server = createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, "Bearer selected-fixture-secret");
        authCalls++;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.model, "selected-fixture-model");
        calls++;
        if (originalUi || afterTaskUi) {
          const users = body.messages.filter(message => message.role === "user").map(message => message.content);
          fs.writeFileSync(path.join(fixture, "original-provider-observations.json"),
            JSON.stringify({ calls, users }), { mode: 0o600 });
          if (calls === 1) {
            fs.writeFileSync(path.join(fixture, "original-first-request"), "ready", { mode: 0o600 });
            const deadline = Date.now() + 60000;
            while (!fs.existsSync(path.join(fixture, "original-release"))) {
              if (Date.now() > deadline) throw new Error("Original request was not released");
              await wait(50);
            }
          }
          const delta = { content: calls === 1 ? "ORIGINAL_UI_FIRST_RESPONSE" : "ORIGINAL_UI_QUEUED_RESPONSE" };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
            + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        if (steerUi) {
          const users = body.messages.filter(message => message.role === "user").map(message => message.content);
          fs.writeFileSync(path.join(fixture, "steer-provider-observations.json"), JSON.stringify({ calls, users }), { mode: 0o600 });
          if (timeoutUi && calls === 2) {
            fs.writeFileSync(path.join(fixture, "timeout-provider-request"), "ready", { mode: 0o600 });
            await wait(15000);
            if (!res.destroyed) { res.writeHead(500); res.end("fixture request deadline passed"); }
            return;
          }
          const last = users.at(-1), done = last === "RECOVERED_EDITED_STEER";
          const delta = done ? { content: "RECOVERED_AFTER_BUDGET" } : { tool_calls: [{ index: 0, id: `run-${calls}`, type: "function",
            function: { name: "run_process", arguments: JSON.stringify({ program: env.PKM_SELECTED_NODE, arguments: [script],
              cwd: path.join(fixture, "trial/workspace"), timeoutSeconds: 60, background: false }) } }] };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
            + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        if (body.messages.some(message => typeof message.content === "string" && message.content.includes("isolated authentication failure"))) {
          failureCalls++; res.writeHead(401); res.end("selected-fixture-secret: private provider detail"); return;
        }
        const done = body.messages.some(message => message.role === "tool");
        const delta = done ? { content: "FIXTURE_SUCCESS" } : { tool_calls: [{ index: 0, id: "run", type: "function",
          function: { name: "run_process", arguments: JSON.stringify({ program: env.PKM_SELECTED_NODE, arguments: [script],
            cwd: path.join(fixture, "trial/workspace"), timeoutSeconds: 60,
            ...(permissionUi || sdkPermissionUi ? { background: false } : { background: true, idempotency_key: "selected-code-fixture" }) }) } }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } catch { res.writeHead(500); res.end("fixture mismatch"); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    if (sdkPermissionUi) {
      const rpc = require(path.join(project, ".migration-test-work/root-upgrade-validation/sdk-real-fixture/node_modules/vscode-jsonrpc/node"));
      sdkTransport = await require(sdkFixtureDir ? path.join(sdkFixtureDir, "sdk-local-transport.cjs")
        : path.join(project, "tests/next-trial-electron/sdk-local-transport.cjs")).localSdkTransport({
        rpc, program: env.PKM_SELECTED_NODE, args: [script], cwd: path.join(fixture, "trial/workspace"), mode: "foreground",
      });
      env.PKM_SELECTED_SDK_URL = sdkTransport.url;
    }
    fs.writeFileSync(path.join(fixture, "user/User/settings.json"), JSON.stringify({
      "personalKnowledge.storePath": legacy, "personalKnowledge.openOnStartup": false,
      "personalKnowledge.mcpPythonPath": path.join(fixture, "no-python"),
      "personalKnowledge.apiChatProvider": "openai-compatible",
      "personalKnowledge.aiEndpoint": `http://127.0.0.1:${server.address().port}/v1`,
      "personalKnowledge.aiModel": "selected-fixture-model",
      "personalKnowledge.apiChatModelProfiles": [{ id: "selected-fixture-model", status: "active",
        contextWindow: steerUi ? 4096 : 32768, maxOutputTokens: 1024 }],
      ...(timeoutUi ? { "personalKnowledge.apiChatTimeoutSeconds": 10 } : {}),
      "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none",
      ...(sdkPermissionUi ? { "window.dialogStyle": "custom" } : {}),
      ...(nativeSave ? { "window.dialogStyle": "native" } : {}),
      "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false,
    }), { mode: 0o600 });
    const startupDriver = nativeSave || recoveryUi || originalUi || sessionUi || afterTaskUi || permissionUi || sdkPermissionUi;
    fs.writeFileSync(path.join(fixture, "dev/package.json"), JSON.stringify({ name: "selected-test", publisher: "fixture",
      version: "1.0.0", engines: { vscode: "^1.90.0" }, main: "./empty.js",
      ...(startupDriver ? { activationEvents: ["onStartupFinished"] } : {}) }));
    fs.writeFileSync(path.join(fixture, "dev/empty.js"), startupDriver
      ? `exports.activate=()=>{require(${JSON.stringify(installedDriver)}).run().catch(error=>console.error("Private driver failed:",error));};`
      : "exports.activate=()=>{};");
    const codeArgs = [path.join(fixture, "workspace"), ...baseArgs, "--new-window", "--disable-gpu",
      "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes",
      "--password-store=basic", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9333",
      `--extensionDevelopmentPath=${path.join(fixture, "dev")}`,
      ...(startupDriver ? [] : [`--extensionTestsPath=${installedDriver}`])];
    code = launch(codeExecutable, codeArgs,
    { TMPDIR: "/proc/self/cwd/local", TMP: "/proc/self/cwd/local", TEMP: "/proc/self/cwd/local",
      XDG_RUNTIME_DIR: "/proc/self/cwd/local" });
    let ready = false;
    for (let i = 0; i < 600; i++) {
      if (code.exitCode !== null || code.signalCode !== null) throw new Error("Code exited before selected UI became ready");
      if (fs.existsSync(path.join(fixture, "driver-ready"))) { ready = true; break; }
      await wait(100);
    }
    assert(ready, "Selected Chat driver did not become ready");
    async function runRenderer(restart = false, phase = 1) {
      const script = sdkPermissionUi ? "selected_chat_sdk_permission_ui.py" : permissionUi ? "selected_chat_permission_ui.py" : afterTaskUi ? "selected_chat_after_task_ui.py" : originalUi ? "selected_chat_original_ui.py" : sessionUi ? "selected_chat_sessions_ui.py" : timeoutUi ? "selected_chat_timeout_ui.py"
        : recoveryUi ? "selected_chat_recovery_ui.py" : steerUi ? "selected_steer_installed_ui.py" : "selected_chat_installed_ui.py";
      const browser = launch("python3", ["-B", sdkPermissionUi && sdkFixtureDir ? path.join(sdkFixtureDir, script)
        : path.join(project, "tests", script), "http://127.0.0.1:9333", fixture],
        { ...(restart ? { PKM_SELECTED_RESTART: "1" } : {}), ...(permissionUi || sdkPermissionUi ? { PKM_SELECTED_PHASE: String(phase) } : {}) });
      const timer = setTimeout(() => browser.kill("SIGTERM"), steerUi ? 240000 : 120000);
      try {
        const result = await new Promise((resolve, reject) => {
          browser.once("error", reject);
          browser.once("exit", (status, signal) => resolve({ status, signal }));
        });
        assert.equal(result.status, 0, `Renderer test exited ${result.status ?? result.signal}`);
      } finally { clearTimeout(timer); }
    }
    await runRenderer();
    if (permissionUi || sdkPermissionUi) {
      for (let phase = 2; phase <= 3; phase++) {
        for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
        assert(code.exitCode !== null || code.signalCode !== null, "Permission UI Code did not close");
        code = launch(codeExecutable, codeArgs, { PKM_SELECTED_RESTART: "1", PKM_SELECTED_PHASE: String(phase),
          TMPDIR: "/proc/self/cwd/local", TMP: "/proc/self/cwd/local", TEMP: "/proc/self/cwd/local", XDG_RUNTIME_DIR: "/proc/self/cwd/local" });
        if (sdkPermissionUi) {
          for (let i = 0; i < 600 && !fs.existsSync(path.join(fixture, `sdk-phase${phase}-driver-ready`)); i++) {
            if (code.exitCode !== null || code.signalCode !== null) throw new Error(`SDK phase ${phase} Code exited before driver startup`);
            await wait(100);
          }
          assert(fs.existsSync(path.join(fixture, `sdk-phase${phase}-driver-ready`)), `SDK phase ${phase} driver unavailable`);
        }
        await runRenderer(true, phase);
      }
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(code.exitCode !== null || code.signalCode !== null, "Final permission UI Code did not close");
      assert.equal(fs.readFileSync(ticks, "utf8"), "xxx");
      let bundledSdk;
      if (sdkPermissionUi) {
        assert.equal(calls, 0, "SDK journey must not contact the HTTP provider.");
        assert.equal(sdkTransport.state.sends.length, 7, "Three completed SDK tool turns and one denied request must not be replayed.");
        assert(sdkTransport.state.creates.length >= 7 && sdkTransport.state.connections >= 3);
        bundledSdk = JSON.parse(fs.readFileSync(path.join(fixture, "bundled-sdk.json"), "utf8"));
        assert(bundledSdk.sdkDir && bundledSdk.version && bundledSdk.redirectedToLocalRpcViaStdioProxy && bundledSdk.syntheticToken);
      } else assert.equal(calls, 7, "Three completed tool turns and one denied request must not be replayed.");
      assert.equal(treeDigest(archive), original, "Original synthetic Chat archive changed");
      const evidence = path.join(project, ".migration-test-work", `permission-ui-${path.basename(fixture)}.json`);
      fs.writeFileSync(evidence, JSON.stringify({ candidateSha256: candidateHash, calls,
        ...(sdkPermissionUi ? { sdkSends: sdkTransport.state.sends.length, sdkConnections: sdkTransport.state.connections,
          sdkSessions: sdkTransport.state.creates.length, httpRequests: calls, fixtureHashes: sdkFixtureHashes, bundledSdk } : {}), executions: 3,
        originalArchiveUnchanged: true, phases: [1, 2, 3].map(phase => JSON.parse(fs.readFileSync(
          path.join(fixture, `permission-phase${phase}-complete`), "utf8"))) }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Permission UI evidence", evidence);
      success = true; return;
    }
    if (afterTaskUi && !originalUi) {
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "host-complete")), "After-Task UI host did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "After-Task Code did not close");
      assert.equal(calls, 2, "Two explicit ordinary inputs must produce exactly two requests.");
      code = launch(codeExecutable, codeArgs, { PKM_SELECTED_RESTART: "1",
        TMPDIR: "/proc/self/cwd/local", TMP: "/proc/self/cwd/local", TEMP: "/proc/self/cwd/local",
        XDG_RUNTIME_DIR: "/proc/self/cwd/local" });
      let restartReady = false;
      for (let i = 0; i < 600; i++) {
        if (code.exitCode !== null || code.signalCode !== null) throw new Error("Code exited before After-Task recovery");
        if (fs.existsSync(path.join(fixture, "restart-driver-ready"))) { restartReady = true; break; }
        await wait(100);
      }
      assert(restartReady, "After-Task recovery host unavailable");
      await runRenderer(true);
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "restart-complete")), "After-Task recovery did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Reopened Code did not close");
      assert.equal(calls, 2, "Restart must not repeat model requests");
      assert.equal(treeDigest(archive), original, "Original synthetic Chat archive changed");
      assert.equal(treeDigest(path.join(legacy, ".pkm/state/agent-sessions")), originalSessions,
        "Original synthetic Task Session changed");
      const evidence = path.join(project, ".migration-test-work", `after-task-ui-${path.basename(fixture)}.json`);
      fs.writeFileSync(evidence, JSON.stringify({ candidateSha256: createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
        ui: JSON.parse(fs.readFileSync(path.join(fixture, "ui-complete"), "utf8")),
        reopenedUi: JSON.parse(fs.readFileSync(path.join(fixture, "recovery-ui-complete"), "utf8")),
        providerCalls: calls, originalArchiveUnchanged: true, originalSessionUnchanged: true }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("After-Task UI evidence", evidence);
      success = true; return;
    }
    if (originalUi) {
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "host-complete")), "Original UI driver did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Original Code did not close");
      assert.equal(calls, 2, "Original UI sent an unexpected number of requests");
      const observation = JSON.parse(fs.readFileSync(path.join(fixture, "original-provider-observations.json"), "utf8"));
      assert(observation.users.includes("ORIGINAL_UI_QUEUED"), "Original queued input did not reach provider");
      const evidence = path.join(project, ".migration-test-work", `original-chat-ui-${path.basename(fixture)}.json`);
      fs.writeFileSync(evidence, JSON.stringify({ candidateSha256: createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
        ui: JSON.parse(fs.readFileSync(path.join(fixture, "ui-complete"), "utf8")), providerCalls: calls,
        reportedErrors: fs.existsSync(path.join(fixture, "driver-errors.json"))
          ? JSON.parse(fs.readFileSync(path.join(fixture, "driver-errors.json"), "utf8")) : [] }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Original Chat UI evidence", evidence);
      console.log("PASS original installed 4.0.22 Chat: real UI first send and queued dispatch");
      success = true; return;
    }
    if (sessionUi) {
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "host-complete")), "Session UI host did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Session UI Code did not close");
      assert.equal(calls, 0, "Historical Session inspection must not request a model");
      code = launch(codeExecutable, codeArgs, { PKM_SELECTED_RESTART: "1",
        TMPDIR: "/proc/self/cwd/local", TMP: "/proc/self/cwd/local", TEMP: "/proc/self/cwd/local",
        XDG_RUNTIME_DIR: "/proc/self/cwd/local" });
      let restartReady = false;
      for (let i = 0; i < 600; i++) {
        if (code.exitCode !== null || code.signalCode !== null) throw new Error("Code exited before Session recovery became ready");
        if (fs.existsSync(path.join(fixture, "restart-driver-ready"))) { restartReady = true; break; }
        await wait(100);
      }
      assert(restartReady, "Session recovery host did not become ready");
      await runRenderer(true);
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "restart-complete")), "Session recovery did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Reopened Session Code did not close");
      assert.equal(calls, 0, "Session recovery must not request a model");
      assert.equal(treeDigest(archive), original, "Original synthetic Chat archive changed");
      assert.equal(treeDigest(path.join(legacy, ".pkm/state/agent-sessions")), originalSessions,
        "Original synthetic Task Sessions changed");
      const evidence = path.join(project, ".migration-test-work", `selected-chat-sessions-${path.basename(fixture)}.json`);
      fs.writeFileSync(evidence, JSON.stringify({
        candidateSha256: createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
        sessions: JSON.parse(fs.readFileSync(path.join(fixture, "original-task-sessions.json"), "utf8")),
        ui: JSON.parse(fs.readFileSync(path.join(fixture, "ui-complete"), "utf8")),
        reopenedUi: JSON.parse(fs.readFileSync(path.join(fixture, "recovery-ui-complete"), "utf8")),
        sameProfileAndSelectedChatReopened: true, providerCalls: calls,
        originalSyntheticChatArchiveUnchanged: true, originalSyntheticSessionsUnchanged: true,
      }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Selected Chat historical Session UI evidence", evidence);
      console.log("PASS installed selected Chat: original completed Sessions independently inspected without model requests");
      success = true; return;
    }
    if (recoveryUi) {
      assert(fs.existsSync(path.join(fixture, "ui-crash-ready")), "Crash setup was not confirmed");
      if (revokeUi || timeoutUi) {
        for (let i = 0; i < 300 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
        assert(fs.existsSync(path.join(fixture, "host-complete")), "Selected owner did not report completed revocation");
        assert(code.exitCode !== null || code.signalCode !== null, "Code did not close after owner revocation");
      } else {
      const hostPid = Number(fs.readFileSync(path.join(fixture, "extension-host-pid"), "utf8"));
      function directChildren(pid) {
        try {
          const taskDirectory = `/proc/${pid}/task`;
          return [...new Set(fs.readdirSync(taskDirectory).flatMap(tid => {
            try {
              return fs.readFileSync(`${taskDirectory}/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
            } catch { return []; }
          }))];
        } catch { return []; }
      }
      const descendants = new Set(), pending = [code.pid];
      while (pending.length) for (const child of directChildren(pending.shift())) {
        if (!descendants.has(child)) { descendants.add(child); pending.push(child); }
      }
      assert(descendants.has(hostPid), "Fixture extension host is not a live Code descendant");
      const managed = directChildren(hostPid).filter(pid => {
        try {
          const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          return (command.includes(fixture) || command.includes(short))
            && command.includes("/next-runtime/server/dist/managed-client-child.js");
        } catch { return false; }
      });
      assert.equal(managed.length, 1, "Expected exactly one live fixture-owned managed child");
      process.kill(managed[0], "SIGKILL");
      process.kill(hostPid, "SIGKILL");
      code.kill("SIGKILL");
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(code.exitCode !== null || code.signalCode !== null, "Crashed Code did not exit");
      }
      const pid = Number(fs.readFileSync(path.join(fixture, "process-pid-1"), "utf8"));
      for (let i = 0; i < 100 && fs.existsSync(`/proc/${pid}`); i++) await wait(100);
      assert(!fs.existsSync(`/proc/${pid}`), "Crashed host left its fixture process alive");
      if (timeoutUi) {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(path.join(fixture, "trial/workspace/core.sqlite"), { readOnly: true });
        try {
          const queues = db.prepare("SELECT state_json FROM legacy_managed_chat_queue").all().map(row => JSON.parse(row.state_json));
          assert(queues.some(state => state.items.some(item => item.text === "TIMEOUT_PENDING_STEER" && item.status === "applied")),
            "Timed-out committed steer was not retained as applied");
          const turns = db.prepare("SELECT record FROM chat_turn_records").all().map(row => JSON.parse(row.record));
          assert(turns.some(turn => turn.failure === "MODEL_TIMEOUT"), "Expected the actual model timeout receipt");
        } finally { db.close(); }
      }
    } else {
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "host-complete")), "Extension host did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Code window did not close");
    }
    if (steerUi && !recoveryUi) {
      const { DatabaseSync } = require("node:sqlite");
      const pid = Number(fs.readFileSync(path.join(fixture, "process-pid-2"), "utf8"));
      assert(Number.isSafeInteger(pid) && pid > 1, "Invalid private foreground process PID");
      for (let i = 0; i < 50 && fs.existsSync(`/proc/${pid}`); i++) await wait(100);
      assert(!fs.existsSync(`/proc/${pid}`), "Cancelled foreground process is still present in the private PID namespace");
      const queueState = () => {
        const db = new DatabaseSync(path.join(fixture, "trial/workspace/core.sqlite"), { readOnly: true });
        try {
          return db.prepare("SELECT state_json FROM legacy_managed_chat_queue").all().map(row => JSON.parse(row.state_json));
        } finally { db.close(); }
      };
      const before = queueState();
      assert(before.some(state => state.items.some(item => item.text === "CANCELLED_QUEUED_STEER")),
        "Cancelled input missing from persisted queue");
      const previousCalls = calls;
      code = launch(codeExecutable, codeArgs, { PKM_SELECTED_RESTART: "1",
        TMPDIR: "/proc/self/cwd/local", TMP: "/proc/self/cwd/local", TEMP: "/proc/self/cwd/local",
        XDG_RUNTIME_DIR: "/proc/self/cwd/local" });
      for (let i = 0; i < 300 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "restart-complete")), "Actual Code restart did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Restarted Code window did not close");
      assert.equal(calls, previousCalls, "Code restart unexpectedly dispatched queued input");
      assert.deepEqual(queueState(), before, "Code restart changed the persisted selected-Chat queue");
      console.log("Actual Code restart retained the queue without a provider dispatch; selected Chat was not reopened.");
    }
    if (recoveryUi) {
      assert.equal(calls, timeoutUi ? 2 : 1, "Unexpected provider requests before restart");
      code = launch(codeExecutable, codeArgs, { PKM_SELECTED_RESTART: "1",
        TMPDIR: "/proc/self/cwd/local", TMP: "/proc/self/cwd/local", TEMP: "/proc/self/cwd/local",
        XDG_RUNTIME_DIR: "/proc/self/cwd/local" });
      let restartReady = false;
      for (let i = 0; i < 600; i++) {
        if (code.exitCode !== null || code.signalCode !== null) throw new Error("Code exited before recovery UI became ready");
        if (fs.existsSync(path.join(fixture, "restart-driver-ready"))) { restartReady = true; break; }
        await wait(100);
      }
      assert(restartReady, "Restarted extension host did not become ready");
      await runRenderer(true);
      for (let i = 0; i < 150 && code.exitCode === null && code.signalCode === null; i++) await wait(100);
      assert(fs.existsSync(path.join(fixture, "restart-complete")), "Reopened Chat journey did not complete");
      assert(code.exitCode !== null || code.signalCode !== null, "Restarted Code window did not close");
      assert.equal(calls, 2, "Unexpected provider requests during recovery");
    }
    if (historyImageOnly) {
      assert.deepEqual(fs.readFileSync(path.join(fixture, nativeSave ? "workspace/export.png" : "export.png")), Buffer.from(historyImage, "base64"));
      assert.equal(calls, 0, "Image history export must not request a model.");
      if (nativeSave) {
        const evidence = path.join(project, ".migration-test-work", `selected-native-save-${path.basename(fixture)}`);
        for (const name of ["native-save-dialog.png", "native-overwrite-dialog.png", "native-save-dialogs.txt"])
          fs.copyFileSync(path.join(fixture, name), `${evidence}-${name}`);
        console.log("Native dialog evidence prefix", evidence);
      }
    } else if (!steerUi) {
      const length = fs.readFileSync(ticks).length; await wait(500);
      assert.equal(fs.readFileSync(ticks).length, length, "Owned process survived Code window close");
    }
    assert.equal(treeDigest(archive), original, "Original synthetic Chat archive changed");
    if (historyImageOnly) console.log("PASS installed Code selected Chat: original history image saved to user-chosen new file; no model request; original fixture unchanged");
    else if (recoveryUi) {
      const evidence = path.join(project, ".migration-test-work", `selected-chat-recovery-${path.basename(fixture)}.json`);
      fs.writeFileSync(evidence, JSON.stringify({
        candidateSha256: createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
        ui: JSON.parse(fs.readFileSync(path.join(fixture, "recovery-ui-complete"), "utf8")),
        sameProfileAndTrialReopened: true,
        ...(timeoutUi ? { providerTimeoutSteerNeverReplayed: true }
          : revokeUi ? { processRevocationOutcomeNeverReplayed: true } : { processCrashOutcomeNeverReplayed: true }),
        originalSyntheticArchiveUnchanged: true,
      }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Selected Chat recovery evidence", evidence);
      console.log(`PASS installed selected Chat: original history and ${timeoutUi ? "provider timeout without replay" : `queued steer, unknown review and explicit recovery after ${revokeUi ? "owner revocation" : "crash"}`} and Code restart`);
    } else if (steerUi) {
      assert(calls >= 3, "The installed UI did not reach the controlled provider.");
      const evidence = path.join(project, ".migration-test-work", `steer-installed-${path.basename(fixture)}.json`);
      fs.writeFileSync(evidence, JSON.stringify({
        candidateSha256: createHash("sha256").update(fs.readFileSync(vsix)).digest("hex"),
        ui: JSON.parse(fs.readFileSync(path.join(fixture, "ui-complete"), "utf8")),
        actualCodeRestartWithoutSelectedChatReopen: true,
        cancelledQueueUnchangedAcrossRestart: true,
        originalSyntheticArchiveUnchanged: true,
        providerRequestsAfterRestart: calls,
      }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Steer UI evidence", evidence);
      console.log("PASS installed selected Chat steer UI; original fixture unchanged");
    } else {
      assert(calls >= 3 && authCalls === calls && failureCalls === 1, "Model selection, credentials or retry count differed");
      console.log("PASS installed Code selected Chat: real SecretStorage command, fixture HTTP, approval, 401, window cleanup; original fixture unchanged");
    }
    success = true;
  } finally {
    await stop(code);
    for (const child of [...children]) await stop(child);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (sdkTransport) await sdkTransport.close();
    if (success) fs.rmSync(fixture, { recursive: true, force: true });
    else console.error(`Private fixture retained for diagnosis: ${fixture}`);
  }
}
main().catch(error => { console.error("Selected Code test failed:", error?.stack ?? String(error)); process.exitCode = 1; });
