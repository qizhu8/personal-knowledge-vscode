import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, writeFile, cp, readdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { packageHost, validateHostPayload } from "./package-host.mjs";
import { cachedVSCode } from "./electron-test.mjs";
import { verifyInstalledColdComponent } from "./installed-cold-component.mjs";
import { verifyInstalledNativeModels } from "./installed-native-models.mjs";
import { startOwnerObservation, collectFirstOriginLogs } from "./installed-native-model-diagnostics.mjs";
import { validateNativeModelTokenPersistence } from "./installed-native-model-counter-flush.mjs";
import { prepareInstalledNativeRoomCredentials, startInstalledNativeRoomCredentialUi } from "./installed-native-room.mjs";
import {
  prepareInstalledNativeRoomLiveCredentials, installedNativeRoomLiveCallerEnvironment,
  startInstalledNativeRoomLiveCredentialUi,
} from "./installed-native-room-live.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed: ${result.status}`);
};
async function fixtureJson(path, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Native fixture evidence did not arrive: ${path}`);
}

async function main() {
  if (process.argv.includes("--core-chat") || process.argv[2] === "--inside-core-chat") {
    const { runInstalledCoreChat } = await import("./installed-core-chat.mjs");
    await runInstalledCoreChat();
    return;
  }
  if (process.platform !== "linux") throw new Error("Installed-host acceptance currently requires Linux private network/display support.");
  if (process.argv[2] !== "--inside") {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) {
      const option = process.argv[index];
      if (["--side-by-side", "--native-identity", "--cold-component", "--native-models", "--native-source",
        "--native-action", "--native-memory", "--native-worker", "--native-recipe", "--native-assignment", "--native-room", "--native-room-live",
        "--native-program", "--native-task", "--native-task-adoption", "--native-knowledge-move", "--native-legacy-assets",
        "--native-shared-legacy-assets-move", "--native-private-resource-publication", "--native-private-resource-lifecycle", "--native-private-resource-recovery", "--native-private-inplace", "--native-skill-basic", "--native-trash", "--native-trash-lifecycle", "--native-skill-paper-trash", "--native-note-paper-basic", "--native-research-basic", "--native-knowledge-recovery", "--native-action-pure", "--native-todo-genesis", "--native-todo-lifecycle", "--native-todo-recovery", "--native-script"].includes(option) && !options[option]) {
        options[option] = true; continue;
      }
      if (["--coordinator", "--coordinator-preflight"].includes(option) && !options[option]) {
        if (options["--coordinator"] || options["--coordinator-preflight"])
          throw new Error("Choose either positive --coordinator or safety-only --coordinator-preflight.");
        options[option] = true; continue;
      }
      if (option === "--native-model-rounds" && !options[option] && ["31", "48"].includes(process.argv[index + 1])) {
        options[option] = process.argv[++index]; continue;
      }
      if (option === "--native-model-token-persistence" && !options[option] && ["sync", "buffered"].includes(process.argv[index + 1])) {
        options[option] = process.argv[++index]; continue;
      }
      if (option === "--native-model-token-persistence")
        throw new Error("Use --native-model-token-persistence sync|buffered only with --native-models --native-model-rounds 48.");
      if (["--held-old-parser-sha256", "--held-old-private-resource-parser-sha256", "--held-old-script-parser-sha256", "--held-old-trash-parser-sha256"].includes(option)
        && !options[option] && /^[a-f0-9]{64}$/.test(process.argv[index + 1] || "")) {
        options[option] = process.argv[++index]; continue;
      }
      if (!["--vsix", "--evidence", "--legacy-vsix", "--held-old-parser-vsix", "--held-old-private-resource-parser-vsix", "--held-old-script-parser-vsix", "--held-old-trash-parser-vsix"].includes(option)
        || !process.argv[index + 1] || options[option])
        throw new Error("Usage: node installed-test.mjs [--vsix HOST.vsix] [--evidence REPORT.json] [--side-by-side | --native-identity [--cold-component [--native-source] [--native-action | --native-memory | --native-worker | --native-recipe | --native-assignment | --native-room | --native-room-live | --native-program | --native-task | --native-task-adoption | --native-knowledge-move | --native-legacy-assets | --native-shared-legacy-assets-move | --native-private-resource-publication | --native-private-resource-lifecycle | --native-private-resource-recovery | --native-private-inplace | --native-skill-basic | --native-trash | --native-trash-lifecycle | --native-skill-paper-trash | --native-note-paper-basic | --native-research-basic | --native-knowledge-recovery | --native-todo-genesis | --native-todo-lifecycle | --native-todo-recovery | --native-script] --legacy-vsix ORIGINAL.vsix [--held-old-parser-vsix OLD.vsix --held-old-parser-sha256 HASH | --held-old-private-resource-parser-vsix OLD.vsix --held-old-private-resource-parser-sha256 HASH | --held-old-script-parser-vsix OLD.vsix --held-old-script-parser-sha256 HASH | --held-old-trash-parser-vsix OLD.vsix --held-old-trash-parser-sha256 HASH] | --native-models [--native-model-rounds 31|48] [--native-model-token-persistence sync|buffered]] | --coordinator | --coordinator-preflight]");
      options[option] = resolve(process.argv[++index]);
    }
    if (options["--side-by-side"] && (options["--coordinator"] || options["--coordinator-preflight"]))
      throw new Error("Side-by-side provider verification requires the default-disabled coordinator.");
    if (options["--native-identity"] && (options["--side-by-side"] || options["--coordinator"] || options["--coordinator-preflight"]))
      throw new Error("Native identity verification requires its independent isolated profile.");
    if (options["--cold-component"] && !options["--native-identity"])
      throw new Error("Cold component verification requires the genuine native identity/profile preparation.");
    if (options["--native-models"] && (!options["--native-identity"] || options["--cold-component"]))
      throw new Error("Native model protocol verification requires its independent native-identity experiment.");
    if (options["--native-model-rounds"] && !options["--native-models"])
      throw new Error("The isolated model round override requires --native-models.");
    validateNativeModelTokenPersistence(options["--native-model-token-persistence"],
      !!options["--native-models"], Number(options["--native-model-rounds"] || "31"));
    if (options["--native-source"] && (!options["--native-identity"] || !options["--cold-component"]
      || options["--native-models"] || !options["--legacy-vsix"]))
      throw new Error("Native source verification requires --native-identity --cold-component and a pinned --legacy-vsix.");
    if (options["--native-action"] && (!options["--native-identity"] || !options["--cold-component"]
      || options["--native-models"] || !options["--legacy-vsix"]))
      throw new Error("Native Action business verification requires --native-identity --cold-component and a pinned --legacy-vsix.");
    if (options["--native-memory"] && (!options["--native-identity"] || !options["--cold-component"]
      || options["--native-models"] || options["--native-action"] || !options["--legacy-vsix"]))
      throw new Error("Native Memory verification requires its cold model experiment and pinned --legacy-vsix, without --native-action.");
    const separateNativeScenarios = ["--native-worker", "--native-recipe", "--native-assignment", "--native-room", "--native-room-live", "--native-program", "--native-task", "--native-task-adoption", "--native-knowledge-move", "--native-legacy-assets", "--native-shared-legacy-assets-move", "--native-private-resource-publication", "--native-private-resource-lifecycle", "--native-private-resource-recovery", "--native-private-inplace", "--native-skill-basic", "--native-trash", "--native-trash-lifecycle", "--native-skill-paper-trash", "--native-note-paper-basic", "--native-research-basic", "--native-knowledge-recovery", "--native-action-pure", "--native-todo-genesis", "--native-todo-lifecycle", "--native-todo-recovery", "--native-script"];
    for (const option of separateNativeScenarios) {
      if (options[option] && (!options["--native-identity"] || !options["--cold-component"]
        || options["--native-models"] || !options["--legacy-vsix"]))
        throw new Error(`${option} requires --native-identity --cold-component and a pinned --legacy-vsix.`);
      if (options[option] && ["--native-source", "--native-action", "--native-memory",
        ...separateNativeScenarios].some(other => other !== option && options[other]))
        throw new Error(`${option} requires its own cold component/source selection, without other native domain scenarios.`);
    }
    if (!!options["--held-old-parser-vsix"] !== !!options["--held-old-parser-sha256"]
      || (options["--held-old-parser-vsix"] && !options["--native-shared-legacy-assets-move"]))
      throw new Error("The held old-parser VSIX and SHA-256 must be supplied together for the independent shared-legacy-asset scenario.");
    if (!!options["--held-old-private-resource-parser-vsix"] !== !!options["--held-old-private-resource-parser-sha256"]
      || (options["--held-old-private-resource-parser-vsix"] && !options["--native-private-resource-publication"]))
      throw new Error("The held private-parser VSIX and SHA-256 must be supplied together for the independent private-publication scenario.");
    if (!!options["--held-old-script-parser-vsix"] !== !!options["--held-old-script-parser-sha256"]
      || (options["--held-old-script-parser-vsix"] && !options["--native-script"]))
      throw new Error("The held Script-parser VSIX and SHA-256 must be supplied together for the independent frozen-Script scenario.");
    if (!!options["--held-old-trash-parser-vsix"] !== !!options["--held-old-trash-parser-sha256"]
      || (options["--held-old-trash-parser-vsix"] && !options["--native-skill-paper-trash"]))
      throw new Error("The held Trash-parser VSIX and SHA-256 must be supplied together for the independent Skill/Paper Trash scenario.");
    if (options["--legacy-vsix"] && !["--native-source", "--native-action", "--native-memory",
      ...separateNativeScenarios].some(option => options[option]))
      throw new Error("The original source-writer package requires a native source, Action, Memory, Worker, Recipe, assignment, Room, program or Task scenario.");
    const editor = cachedVSCode();
    const xvfb = process.env.PKM_TRIAL_XVFB || join(homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb");
    const vsce = process.env.PKM_VSCE_EXECUTABLE || execFileSync("which", ["vsce"], { encoding: "utf8" }).trim();
    const python = execFileSync("python3", ["-c", "import sys, playwright; print(sys.executable)"], { encoding: "utf8" }).trim();
    const recoveryNamespaceWitness = options["--native-private-resource-recovery"]
      ? Object.fromEntries(await Promise.all(["user", "mnt", "net", "pid"].map(async name =>
        [name, await readlink(`/proc/self/ns/${name}`)]))) : undefined;
    const isolation = options["--cold-component"] ? ["-Urnmpf", "--mount-proc"] : ["-Urn"];
    run("unshare", [...isolation, process.execPath, fileURLToPath(import.meta.url), "--inside", editor, xvfb, vsce, python,
      options["--vsix"] || "", options["--evidence"] || "",
      options["--coordinator-preflight"] ? "preflight-safety" : options["--coordinator"] ? "positive" : "",
      options["--native-identity"] ? "native-identity" : options["--side-by-side"] ? "side-by-side" : "", homedir(),
      options["--cold-component"] ? "cold-component" : options["--native-models"] ? "native-models" : "",
      options["--native-source"] ? "native-source" : "", options["--legacy-vsix"] || "",
      options["--native-action"] ? "native-action" : "", options["--native-memory"] ? "native-memory" : "",
      options["--native-worker"] ? "native-worker" : "", options["--native-recipe"] ? "native-recipe" : "",
      options["--native-assignment"] ? "native-assignment" : "",
      options["--native-room-live"] ? "native-room-live" : options["--native-room"] ? "native-room" : "",
      options["--native-program"] ? "native-program" : "",
      options["--native-task-adoption"] ? "native-task-adoption" : options["--native-task"] ? "native-task" : "",
      options["--native-script"] ? "native-script"
        : options["--native-action-pure"] ? "native-action-pure"
        : options["--native-knowledge-recovery"] ? "native-knowledge-recovery"
        : options["--native-research-basic"] ? "native-research-basic"
        : options["--native-note-paper-basic"] ? "native-note-paper-basic"
        : options["--native-skill-paper-trash"] ? "native-skill-paper-trash"
        : options["--native-todo-recovery"] ? "native-todo-recovery"
        : options["--native-todo-lifecycle"] ? "native-todo-lifecycle"
        : options["--native-todo-genesis"] ? "native-todo-genesis"
        : options["--native-trash-lifecycle"] ? "native-trash-lifecycle"
        : options["--native-trash"] ? "native-trash"
        : options["--native-skill-basic"] ? "native-skill-basic"
        : options["--native-private-inplace"] ? "native-private-inplace"
        : options["--native-private-resource-recovery"] ? "native-private-resource-recovery"
        : options["--native-private-resource-lifecycle"] ? "native-private-resource-lifecycle"
        : options["--native-private-resource-publication"] ? "native-private-resource-publication"
        : options["--native-shared-legacy-assets-move"] ? "native-shared-legacy-assets-move"
        : options["--native-legacy-assets"] ? "native-legacy-assets" : options["--native-knowledge-move"] ? "native-knowledge-move" : "",
      options["--held-old-parser-vsix"] || "", options["--held-old-parser-sha256"] || "",
      options["--held-old-private-resource-parser-vsix"] || "", options["--held-old-private-resource-parser-sha256"] || "",
      recoveryNamespaceWitness ? JSON.stringify(recoveryNamespaceWitness) : "",
      options["--held-old-script-parser-vsix"] || "", options["--held-old-script-parser-sha256"] || "",
      options["--held-old-trash-parser-vsix"] || "", options["--held-old-trash-parser-sha256"] || "",
      options["--native-model-rounds"] || "31", options["--native-model-token-persistence"] || ""], {
      env: { PATH: process.env.PATH || "" },
      timeout: options["--side-by-side"] || options["--cold-component"] ? 600000 : 300000,
    });
    return;
  }
  const [editor, xvfb, vsce, python, existingVsix, evidencePath, coordinatorMode, identityMode, nativeHome, experiment,
    sourceMarker, legacyVsix, actionMarker, memoryMarker, workerMarker, recipeMarker, assignmentMarker, roomMarker, programMarker, taskMarker, knowledgeMarker,
    heldOldParserVsix, heldOldParserSha256, heldOldPrivateParserVsix, heldOldPrivateParserSha256, recoveryNamespaceWitness,
    heldOldScriptParserVsix, heldOldScriptParserSha256, heldOldTrashParserVsix, heldOldTrashParserSha256,
    nativeModelRounds, nativeModelTokenPersistence] = process.argv.slice(3);
  const coldMode = experiment === "cold-component", modelMode = experiment === "native-models";
  const toolRoundLimit = Number(nativeModelRounds);
  assert([31, 48].includes(toolRoundLimit) && (toolRoundLimit === 31 || modelMode));
  const tokenPersistenceMode = validateNativeModelTokenPersistence(nativeModelTokenPersistence, modelMode, toolRoundLimit);
  const sourceMode = sourceMarker === "native-source";
  const actionMode = actionMarker === "native-action";
  const memoryMode = memoryMarker === "native-memory";
  const workerMode = workerMarker === "native-worker", recipeMode = recipeMarker === "native-recipe";
  const assignmentMode = assignmentMarker === "native-assignment";
  const roomLiveMode = roomMarker === "native-room-live";
  const roomMode = roomMarker === "native-room" || roomLiveMode;
  const programMode = programMarker === "native-program";
  const taskAdoptionMode = taskMarker === "native-task-adoption";
  const taskMode = taskMarker === "native-task" || taskAdoptionMode;
  const sharedLegacyAssetsMode = knowledgeMarker === "native-shared-legacy-assets-move";
  const privatePublicationMode = knowledgeMarker === "native-private-resource-publication";
  const privateLifecycleMode = knowledgeMarker === "native-private-resource-lifecycle";
  const privateRecoveryMode = knowledgeMarker === "native-private-resource-recovery";
  const privateInplaceMode = knowledgeMarker === "native-private-inplace";
  const skillBasicMode = knowledgeMarker === "native-skill-basic";
  const trashMode = knowledgeMarker === "native-trash";
  const trashLifecycleMode = knowledgeMarker === "native-trash-lifecycle";
  const todoGenesisMode = knowledgeMarker === "native-todo-genesis";
  const todoLifecycleMode = knowledgeMarker === "native-todo-lifecycle";
  const todoRecoveryMode = knowledgeMarker === "native-todo-recovery";
  const skillPaperTrashMode = knowledgeMarker === "native-skill-paper-trash";
  const notePaperBasicMode = knowledgeMarker === "native-note-paper-basic";
  const researchBasicMode = knowledgeMarker === "native-research-basic";
  const knowledgeRecoveryMode = knowledgeMarker === "native-knowledge-recovery";
  const actionPureMode = knowledgeMarker === "native-action-pure";
  const scriptMode = knowledgeMarker === "native-script";
  const legacyAssetsMode = knowledgeMarker === "native-legacy-assets" || sharedLegacyAssetsMode || privatePublicationMode || privateLifecycleMode || privateRecoveryMode;
  const knowledgeMode = knowledgeMarker === "native-knowledge-move" || legacyAssetsMode || privateInplaceMode || skillBasicMode || trashMode || trashLifecycleMode || skillPaperTrashMode || notePaperBasicMode || researchBasicMode || knowledgeRecoveryMode || actionPureMode || todoGenesisMode || todoLifecycleMode || todoRecoveryMode || scriptMode;
  if (identityMode) assert(["side-by-side", "native-identity"].includes(identityMode));
  if (experiment) assert(["cold-component", "native-models"].includes(experiment));
  if (sourceMarker) assert(sourceMode && coldMode && identityMode === "native-identity" && legacyVsix);
  if (actionMarker) assert(actionMode && coldMode && identityMode === "native-identity" && legacyVsix);
  if (memoryMarker) assert(memoryMode && coldMode && !actionMode && identityMode === "native-identity" && legacyVsix);
  if (workerMarker) assert(workerMode);
  if (recipeMarker) assert(recipeMode);
  if (assignmentMarker) assert(assignmentMode);
  if (roomMarker) assert(roomMode);
  if (programMarker) assert(programMode);
  if (taskMarker) assert(taskMode);
  if (knowledgeMarker) assert(knowledgeMode);
  if (privateRecoveryMode) assert(recoveryNamespaceWitness);
  if (heldOldParserVsix || heldOldParserSha256)
    assert(sharedLegacyAssetsMode && heldOldParserVsix && /^[a-f0-9]{64}$/.test(heldOldParserSha256));
  if (heldOldPrivateParserVsix || heldOldPrivateParserSha256)
    assert(privatePublicationMode && heldOldPrivateParserVsix && /^[a-f0-9]{64}$/.test(heldOldPrivateParserSha256));
  if (heldOldScriptParserVsix || heldOldScriptParserSha256)
    assert(scriptMode && heldOldScriptParserVsix && /^[a-f0-9]{64}$/.test(heldOldScriptParserSha256));
  if (heldOldTrashParserVsix || heldOldTrashParserSha256)
    assert(skillPaperTrashMode && heldOldTrashParserVsix && /^[a-f0-9]{64}$/.test(heldOldTrashParserSha256));
  if (workerMarker || recipeMarker || assignmentMarker || roomMarker || programMarker || taskMarker || knowledgeMarker)
    assert([workerMode, recipeMode, assignmentMode, roomMode, programMode, taskMode, knowledgeMode].filter(Boolean).length === 1 && coldMode && !sourceMode && !actionMode && !memoryMode
      && identityMode === "native-identity" && legacyVsix);
  const root = resolve(here, `.installed-host-${randomUUID()}`);
  const counterFlushConfig = tokenPersistenceMode ? { mode: tokenPersistenceMode, runId: randomUUID(), generation: 1 } : undefined;
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  await mkdir(root, { mode: 0o700 });
  let display, ui, app, evidence, nativeControl, nativeDirectory, roomCredentialIntent, roomCredentialUi, passed = false;
  let roomLiveCredentialPreparation, roomCallerEnvironment = {};
  let modelOwnerObservation, modelOwnerDiagnostics;
  const modelBudgetAbort = new AbortController();
  let modelOriginLogs;
  let modelEditorDeadline, modelEditorStartedAt;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); });
  };
  try {
    for (const dir of ["h", "t", "t/runtime", "u/User", "x", "editor", "driver", "data/source/notes",
      ...(coordinatorMode ? ["coordinator/notes", "coordinator/.pkm"] : [])])
      await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
    process.chdir(root);
    const short = `/proc/${process.pid}/cwd`;
    const env = {
      PATH: originalEnv.PATH || "", HOME: `${short}/h`, USERPROFILE: `${short}/h`,
      TMPDIR: "/proc/self/cwd/t", TMP: "/proc/self/cwd/t", TEMP: "/proc/self/cwd/t",
      XDG_CONFIG_HOME: `${short}/h/config`, XDG_DATA_HOME: `${short}/h/data`, XDG_CACHE_HOME: `${short}/h/cache`,
      XDG_RUNTIME_DIR: `${short}/t/runtime`,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1", PKM_VSCE_EXECUTABLE: vsce,
      DISPLAY: "127.0.0.1:92", XAUTHORITY: join(root, "Xauthority"),
    };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    run("ip", ["link", "set", "lo", "up"], { env });
    await writeFile(env.XAUTHORITY, "", { mode: 0o600 });
    run("xauth", ["-f", env.XAUTHORITY, "add", env.DISPLAY, "MIT-MAGIC-COOKIE-1", randomUUID().replaceAll("-", "")], { env });
    display = spawn(xvfb, [":92", "-screen", "0", "1280x900x24", "-nolock", "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp", "-auth", env.XAUTHORITY], { env, stdio: "ignore" });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnSync("xdpyinfo", ["-display", env.DISPLAY], { env, stdio: "ignore", timeout: 1000 }).status === 0) { ready = true; break; }
      if (display.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Private Xvfb unavailable; no installed-host acceptance performed.");
    const vsix = existingVsix || join(root, "host.vsix");
    if (!existingVsix) await packageHost(vsix, { env });
    const vsixSha256 = createHash("sha256").update(await readFile(vsix)).digest("hex");
    const manifest = JSON.parse(execFileSync("unzip", ["-p", vsix, "extension/package.json"],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }));
    assert.equal(`${manifest.publisher}.${manifest.name}`, "pkm-nonproduction.pkm-v5",
      "Only the explicitly isolated nonproduction host artifact may be installed");
    assert.equal(manifest.main, "./dist/extension.cjs");
    const cli = join(dirname(editor), "bin", "code");
    const profileBase = coordinatorMode || identityMode ? root : short;
    const cliArgs = ["--no-sandbox", `--user-data-dir=${profileBase}/u`, `--extensions-dir=${profileBase}/x`];
    run(cli, [...cliArgs, "--install-extension", vsix, "--force"], { env });
    const names = (await readdir(join(root, "x"))).filter(name => name.startsWith("pkm-nonproduction.pkm-v5-"));
    assert.equal(names.length, 1, "Exactly one host VSIX must be installed");
    assert(!(await readdir(join(root, "x"))).some(name => /^uone\.personal-knowledge-/i.test(name)));
    const installed = join(root, "x", names[0]);
    const installedPayload = await validateHostPayload(installed);
    let sideBySide;
    if (identityMode === "side-by-side") {
      assert(!coordinatorMode);
      assert.equal(manifest.displayName, "pkm-v5");
      assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [{ id: "pkm-v5", label: "pkm-v5" }]);
      sideBySide = { managedRoot: join(root, "managed"), data: join(root, "data/imported"),
        installedPayloadBuildId: installedPayload.buildId, allowWrites: false,
        provisioner: fileURLToPath(new URL("../../experimental/managed-migration.mjs", import.meta.url)),
        launchVerifier: fileURLToPath(new URL("../../experimental/managed-launch-client.mjs", import.meta.url)) };
    }
    await cp(new URL("installed-test-runner.cjs", import.meta.url), join(installed, "installed-test-runner.cjs"));
    await writeFile(join(root, "driver/package.json"), JSON.stringify({
      name: "host-installed-test-driver", publisher: "fixture", version: "0.0.1", engines: { vscode: "^1.96.0" },
      activationEvents: ["*"], main: "./driver.cjs",
      ...(modelMode || memoryMode || assignmentMode || taskMode ? { contributes: { languageModelChatProviders: [
        { vendor: memoryMode ? "pkm-native-memory-fixture" : taskAdoptionMode
          ? "pkm-native-managed-task-adoption-fixture" : taskMode ? "pkm-native-managed-task-fixture" : "pkm-native-fixture",
          displayName: "Isolated synthetic PKM test provider" },
      ] } } : {}),
    }));
    await writeFile(join(root, "driver/driver.cjs"), `
const vscode = require("vscode");
const fs = require("node:fs");
exports.activate = async () => {
  ${taskMode ? `
  const taskFixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
  ${taskAdoptionMode ? `
  if (taskFixture.nativeManagedTaskAdoptionProvider) {
    const {registerInstalledNativeManagedTaskAdoptionProvider} = await import(${JSON.stringify(
      new URL("./installed-native-managed-task-adoption-provider.mjs", import.meta.url).href)});
    await registerInstalledNativeManagedTaskAdoptionProvider(vscode, taskFixture.nativeManagedTaskAdoptionProvider);
  }` : `
  if (taskFixture.nativeManagedTaskProvider) {
    const {registerInstalledNativeManagedTaskProvider} = await import(${JSON.stringify(
      new URL("./installed-native-managed-task-provider.mjs", import.meta.url).href)});
    await registerInstalledNativeManagedTaskProvider(vscode, taskFixture.nativeManagedTaskProvider);
  }`}
  ` : ""}
  ${memoryMode ? `
  const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
  if (fixture.nativeMemoryProvider) {
    const {registerInstalledNativeMemoryProvider} = await import(${JSON.stringify(
      new URL("./installed-native-memory-provider.mjs", import.meta.url).href)});
    await registerInstalledNativeMemoryProvider(vscode, fixture.nativeMemoryProvider);
  }` : ""}
  let nativeModelCounterFlush;
  ${modelMode || assignmentMode ? `
  if (typeof vscode.lm.registerLanguageModelChatProvider !== "function")
    throw new Error("Native provider registration is unavailable; no fake VS Code API was substituted.");
  let nativeCalls=0, tokenCalls=0, loopCalls=0, infoCalls=0, registryEvents=0;
  ${modelMode ? `
  const {createProviderObservation}=await import(${JSON.stringify(new URL("./installed-native-model-diagnostics.mjs", import.meta.url).href)});
  const providerObservation=createProviderObservation({root:${JSON.stringify(root)},pid:process.pid});
  let providerBudgetRecorded=false;
  const observe=(stage,call)=>{
    ${toolRoundLimit === 48 ? `const state=providerObservation.snapshot();
    if(state.diagnosticProblems.length||state.maxima.rssBytes>1073741824||state.maxima.heapUsedBytes>268435456||state.maxima.loopLagMs>=1000){
      if(!providerBudgetRecorded){providerBudgetRecorded=true;fs.writeFileSync(${JSON.stringify(join(root, "native-model-provider-budget-failure.json"))},
        JSON.stringify({code:"FIXTURE_PROVIDER_BUDGET",state}),{mode:0o600});}
      throw Object.assign(new Error("Owned provider fixture resource/headroom budget exceeded."),{code:"FIXTURE_PROVIDER_BUDGET"});
    }` : ""}
    return providerObservation.observe(stage,call,{nativeCalls,tokenCalls,loopCalls,infoCalls,registryEvents});
  };
  ` : `const observe=(_stage,call)=>call();`}
  const statePath=${JSON.stringify(join(root, "native-fixture-provider.json"))};
  const persist=()=>fs.writeFileSync(statePath,JSON.stringify({scope:"synthetic deterministic native provider; not a remote model or production keyring",nativeCalls,tokenCalls,loopCalls,infoCalls,registryEvents}));
  ${counterFlushConfig ? `
  const {createNativeModelCounterPersistence,serveNativeModelCounterFlush}=await import(${JSON.stringify(
    new URL("./installed-native-model-counter-flush.mjs", import.meta.url).href)});
  const counterPersistence=createNativeModelCounterPersistence({root:${JSON.stringify(root)},mode:${JSON.stringify(tokenPersistenceMode)},
    getCounters:()=>({scope:"synthetic deterministic native provider; not a remote model or production keyring",nativeCalls,tokenCalls,loopCalls,infoCalls,registryEvents})});
  const persistToken=()=>counterPersistence.persistToken();
  nativeModelCounterFlush=request=>serveNativeModelCounterFlush({root:${JSON.stringify(root)},config:${JSON.stringify(counterFlushConfig)},
    request,flush:()=>observe("token-persist",()=>counterPersistence.flush())});
  ` : "const persistToken=persist;"}
  vscode.lm.onDidChangeChatModels(()=>observe("registry-change",()=>{registryEvents++;persist();}));
  vscode.lm.registerLanguageModelChatProvider("pkm-native-fixture",{
    async provideLanguageModelChatInformation(){return observe("provider-info",()=>{infoCalls++;observe("info-persist",persist);return [{id:"fixture",name:"Synthetic native protocol fixture",family:"fixture",version:"1",
      maxInputTokens:200000,maxOutputTokens:8192,capabilities:{toolCalling:true,imageInput:false}}];});},
    async provideTokenCount(){return observe("token-count",()=>{tokenCalls++;observe("token-persist",persistToken);return 1;});},
    async provideLanguageModelChatResponse(model,messages,options,progress,token){
      return observe("response-start",()=>{
      nativeCalls++;observe("response-persist",persist);
      if(token.isCancellationRequested)return observe("response-cancel",()=>{throw new Error("Fixture native request cancelled");});
      const serialized=JSON.stringify(messages);
      ${toolRoundLimit === 48 ? `if(Buffer.byteLength(serialized)>131072)throw Object.assign(new Error("Owned synthetic transcript fixture budget exceeded."),{code:"FIXTURE_TRANSCRIPT_BUDGET"});` : ""}
      const full=serialized.includes("rpc-full-loop-fixture");
      if(full&&options.tools?.length){loopCalls++;observe("response-persist",persist);
        observe("response-progress",()=>progress.report(new vscode.LanguageModelToolCallPart("fixture-call-"+loopCalls,"fixture_read",{round:loopCalls})));
      }else observe("response-progress",()=>progress.report(new vscode.LanguageModelTextPart(full?"synthetic tool-free final summary":"synthetic native streaming response")));
      });
    }
  });
  await vscode.lm.selectChatModels({vendor:"pkm-native-fixture"});
  await new Promise((resolve,reject)=>{
    let quiet, stop;
    const subscription=vscode.lm.onDidChangeChatModels(()=>settled());
    const settled=()=>{clearTimeout(quiet);quiet=setTimeout(()=>{clearTimeout(stop);subscription.dispose();resolve();},500);};
    stop=setTimeout(()=>{clearTimeout(quiet);subscription.dispose();reject(new Error("Synthetic native provider did not settle"));},5000);
    settled();
  });` : ""}
  let roomObserver;
  ${roomMode ? `
  try {
    const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
    const room = await import(${JSON.stringify(new URL(roomLiveMode ? "./installed-native-room-live.mjs" : "./installed-native-room.mjs", import.meta.url).href)});
    roomObserver = room.${roomLiveMode ? "observeInstalledNativeRoomLiveActivation" : "observeInstalledNativeRoomActivation"}({
      root: fixture.root, installed: fixture.installed, legacyVsix: fixture.legacyVsix,
    });
  } catch (error) {
    console.error(error);
    fs.writeFileSync(${JSON.stringify(join(root, "electron-passed.json"))}, JSON.stringify({passed:false,error:String(error)}));
    await vscode.commands.executeCommand("workbench.action.quit");
    return;
  }` : ""}
  require(${JSON.stringify(join(installed, "installed-test-runner.cjs"))}).run(
    nativeModelCounterFlush ? {nativeModelCounterFlush} : roomObserver ? {roomActivationReady:roomObserver.ready} : undefined,
  ).then(
    async () => {
      ${modelMode ? `const diagnostics=await providerObservation.finish();
      fs.writeFileSync(${JSON.stringify(join(root, "native-model-provider-observed.json"))},JSON.stringify(diagnostics),{mode:0o600});` : ""}
      fs.writeFileSync(${JSON.stringify(join(root, "electron-passed.json"))}, '{"passed":true}');
    },
  ).catch(async error => {
    const errors=[error];
    ${modelMode ? `try { const diagnostics=await providerObservation.finish();
    fs.writeFileSync(${JSON.stringify(join(root, "native-model-provider-observed.json"))},JSON.stringify(diagnostics),{mode:0o600}); }
    catch(diagnosticError) { if(diagnosticError!==error)errors.push(diagnosticError); }` : ""}
    const failure=errors.length===1?error:new AggregateError(errors,"Installed workload and diagnostics failed.");
    console.error(failure);
    fs.writeFileSync(${JSON.stringify(join(root, "electron-passed.json"))}, JSON.stringify({passed:false,error:String(failure)}));
  }).finally(() => {
    roomObserver?.dispose();
    return vscode.commands.executeCommand("workbench.action.quit");
  });
};
`);
    await writeFile(join(root, "u/User/settings.json"), JSON.stringify({
      "files.simpleDialog.enable": true, "window.dialogStyle": "custom",
      "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off",
      "update.mode": "none", "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false,
      "workbench.enableExperiments": false, "workbench.startupEditor": "none",
      "chat.mcp.autostart": "never",
      "git.enabled": false, "git.autoRepositoryDetection": false, "git.openRepositoryInParentFolders": "never",
      "http.proxy": "http://127.0.0.1:1", "http.proxySupport": "override",
      ...(coordinatorMode ? { "pkm.nextHost.productionCoordinator": { enabled: true, root: join(root, "coordinator") } } : {}),
    }));
    const note = join(root, "data/source/notes/Example.md");
    await writeFile(note, "---\nid: installed-host-fixture\ntitle: Installed host\n---\nDisposable fixture only.\n");
    const coordinator = coordinatorMode ? {
      root: join(root, "coordinator"), note: join(root, "coordinator/notes/Existing.md"),
      documentId: "native-coordinator-note", mode: coordinatorMode,
    } : undefined;
    if (coordinator) {
      await writeFile(coordinator.note,
        "---\ntitle: Native coordinator\ndocumentId: native-coordinator-note\nrevision: 1\n---\nDisposable same-root fixture.\n", { mode: 0o600 });
      await writeFile(join(coordinator.root, ".pkm/content-privacy.json"),
        '{"schema":1,"private":{"notes":["Chatroom Meetings"]}}', { mode: 0o600 });
    }
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const fixture = {
      root, installed, data: join(root, "data"), source: join(root, "data/source"),
      destination: join(root, "data/imported"), node: process.execPath, python, note, port, coordinator, sideBySide,
      nativeIdentity: identityMode === "native-identity",
      nativeModels: modelMode,
      ...(modelMode ? { nativeModelRounds: toolRoundLimit } : {}),
      ...(counterFlushConfig ? { nativeModelTokenPersistence: counterFlushConfig } : {}),
      nativeTodoSource: sourceMode,
      nativeActionBusiness: actionMode,
      nativeMemory: memoryMode,
      nativeTodoWorker: workerMode,
      nativeRecipe: recipeMode,
      nativeTodoAssignment: assignmentMode,
      nativeRoom: roomMode,
      nativeRoomLive: roomLiveMode,
      nativeActionProgram: programMode,
      nativeManagedTask: taskMode,
      nativeManagedTaskAdoption: taskAdoptionMode,
      nativeKnowledgeMove: knowledgeMode,
      nativeLegacyAssetsMove: legacyAssetsMode,
      nativeSharedLegacyAssetsMove: sharedLegacyAssetsMode,
      nativePrivateResourcePublication: privatePublicationMode,
      nativePrivateResourceLifecycle: privateLifecycleMode,
      nativePrivateResourceRecovery: privateRecoveryMode,
      nativePrivateInplace: privateInplaceMode,
      nativeSkillBasic: skillBasicMode,
      nativeOriginalTrash: trashMode,
      nativeOriginalTrashLifecycle: trashLifecycleMode,
      nativeTodoGenesis: todoGenesisMode,
      nativeTodoLifecycle: todoLifecycleMode,
      nativeTodoRecovery: todoRecoveryMode,
      nativeSkillPaperTrash: skillPaperTrashMode,
      nativeNotePaperBasic: notePaperBasicMode,
      nativeResearchBasic: researchBasicMode,
      nativeKnowledgeRecovery: knowledgeRecoveryMode,
      nativeActionPure: actionPureMode,
      nativeScript: scriptMode,
      ...(privateRecoveryMode ? { recoveryNamespaceWitness: JSON.parse(recoveryNamespaceWitness) } : {}),
      ...(heldOldParserVsix ? { heldOldParser: { vsixPath: heldOldParserVsix, vsixSha256: heldOldParserSha256 } } : {}),
      ...(heldOldPrivateParserVsix ? { heldOldPrivateParser:
        { vsixPath: heldOldPrivateParserVsix, vsixSha256: heldOldPrivateParserSha256 } } : {}),
      ...(heldOldScriptParserVsix ? { heldOldScriptParser:
        { vsixPath: heldOldScriptParserVsix, vsixSha256: heldOldScriptParserSha256 } } : {}),
      ...(heldOldTrashParserVsix ? { heldOldTrashParser:
        { vsixPath: heldOldTrashParserVsix, vsixSha256: heldOldTrashParserSha256 } } : {}),
      ...(sourceMode || actionMode || memoryMode || workerMode || recipeMode || assignmentMode || roomMode || programMode || taskMode || knowledgeMode ? { legacyVsix } : {}),
    };
    if (roomLiveMode) {
      roomLiveCredentialPreparation = await prepareInstalledNativeRoomLiveCredentials({ root, installed, legacyVsix });
      roomCallerEnvironment = installedNativeRoomLiveCallerEnvironment(roomLiveCredentialPreparation);
      roomCredentialUi = await startInstalledNativeRoomLiveCredentialUi({ root, installed, python, env, port });
    } else if (roomMode) {
      roomCredentialIntent = await prepareInstalledNativeRoomCredentials({ root, installed, legacyVsix });
      roomCredentialUi = startInstalledNativeRoomCredentialUi({ root, installed, python, env, port });
    }
    const nativeAttachment = fixture.nativeIdentity ? (async () => {
      const first = await fixtureJson(join(root, "native-identity-first.json"));
      const protocol = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-native-attachment.js")).href);
      nativeDirectory = await mkdtemp(join(nativeHome, ".pkm-native-ui-"));
      nativeControl = await protocol.startOriginalMcpNativeAttachmentServer({
        directory: nativeDirectory, identity: JSON.parse(first.publicRecord), identitySha256: first.result.sha256,
        binding: {
          root: fixture.source, workspaceId: randomUUID(), planSha256: createHash("sha256").update("isolated-native-attachment-fixture").digest("hex"),
          catalogSha256: "696d70e87c1b56697de21d0ab545eb161fed46ae11b34fce6a1f1179198d6a21",
          profileSha256: first.result.profileSha256, payloadBuildId: installedPayload.buildId,
          hostEntrySha256: createHash("sha256").update(await readFile(join(installed, "dist/extension.cjs"))).digest("hex"),
        },
        heartbeatIntervalMs: 250, heartbeatTimeoutMs: 2000, maxPacketBytes: 65536,
      });
      await writeFile(join(dirname(first.result.path), "original-mcp-native-bootstrap.json"), JSON.stringify({
        schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath: nativeControl.descriptorPath,
        descriptorSha256: nativeControl.descriptorSha256, profileSha256: first.result.profileSha256,
      }), { mode: 0o600, flag: "wx" });
      const sessionReady = nativeControl.waitForSession({ timeoutMs: 90000 });
      await writeFile(join(root, "native-attachment-bootstrap-ready.json"), '{"ready":true,"businessReady":false}');
      const session = await sessionReady;
      if (modelMode) {
        modelOwnerObservation = startOwnerObservation({ session, root });
        modelOwnerObservation.setStage("native-attachment");
      }
      protocol.assertAuthenticatedOriginalMcpNativeSession(session);
      await new Promise(resolve => setTimeout(resolve, 2750));
      protocol.assertAuthenticatedOriginalMcpNativeSession(session);
      const requests = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-native-request.js")).href);
      const { originalMcpRequestDigest } = await import(pathToFileURL(join(installed,
        "next-runtime/server/dist/original-mcp-native-host.js")).href);
      const supported = await requests.waitForOriginalMcpNativeSupport(session);
      assert(supported.includes("admission.approve") && supported.includes("public.approve"));
      assert(supported.includes("model.approve"), "The exact pending-inference gate must be available to the separately enabled model lane.");
      const binding = {
        schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
        workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256,
        profileSha256: session.binding.profileSha256, sourceCatalogSha256: session.binding.catalogSha256,
        authorityId: `native-rpc:${session.brokerId}`, epoch: session.activationId, actorId: "mcp:external",
        domains: ["mcp-public"], configurationSha256: originalMcpRequestDigest({ fixture: "read-scope-only" }),
      };
      const publicRequest = (readOnly, content = "native-exact-request") => {
        const args = readOnly ? { slug: "fixture" } : { slug: "fixture", content };
        const tool = readOnly ? "get_note" : "update_note";
        return { operation: `mcp.tool.${tool}`, version: 1, tool, readOnly,
          arguments: args, argumentsDigest: originalMcpRequestDigest(args) };
      };
      await assert.rejects(requests.requestOriginalMcpNative(session, "public.approve",
        { binding, request: publicRequest(true) }), error => error.code === "NATIVE_DENIED");
      await writeFile(join(root, "progress.json"), '{"stage":"native-request-admission"}');
      assert.deepEqual(await requests.requestOriginalMcpNative(session, "admission.approve", { binding }), { decision: "approve" });
      assert.deepEqual(await requests.requestOriginalMcpNative(session, "public.approve",
        { binding, request: publicRequest(true) }), { decision: "approve" });
      await writeFile(join(root, "progress.json"), '{"stage":"native-request-deny"}');
      assert.deepEqual(await requests.requestOriginalMcpNative(session, "public.approve",
        { binding, request: publicRequest(false) }), { decision: "deny" });
      await writeFile(join(root, "progress.json"), '{"stage":"native-request-approve"}');
      assert.deepEqual(await requests.requestOriginalMcpNative(session, "public.approve",
        { binding, request: publicRequest(false) }), { decision: "approve" });
      await writeFile(join(root, "progress.json"), '{"stage":"native-request-cancel"}');
      const cancellation = new AbortController();
      const pending = requests.requestOriginalMcpNative(session, "public.approve",
        { binding, request: publicRequest(false, "late-native-click-must-not-authorize") }, { signal: cancellation.signal });
      await fixtureJson(join(root, "native-request-cancel-visible.json"));
      cancellation.abort();
      await assert.rejects(pending, error => error.code === "NATIVE_REQUEST_CANCELLED");
      await writeFile(join(root, "native-request-cancelled.json"), '{"cancelled":true}');
      await fixtureJson(join(root, "native-request-late-click.json"));
      assert.deepEqual(await requests.requestOriginalMcpNative(session, "credential.present",
        { binding, secretId: "personalKnowledge.aiApiKey" }), { present: false });
      await assert.rejects(requests.requestOriginalMcpNative(session, "model.approve",
        { binding, provider: "vscode", model: "unavailable", requestSha256: "f".repeat(64) }),
        error => error.code === "NATIVE_DENIED");
      if (modelOwnerObservation) modelOwnerObservation.setStage("native-model-execution");
      const budgetGuard = modelMode && toolRoundLimit === 48 ? setInterval(() => {
        const state = modelOwnerObservation.snapshot();
        if (state.diagnosticProblems.length || state.maxima.rssBytes > 402653184
          || state.maxima.heapUsedBytes > 134217728 || state.maxima.loopLagMs >= 1000 || state.elapsedMs > 110000)
          modelBudgetAbort.abort(Object.assign(new Error("Owned model owner fixture budget exceeded."), { code: "FIXTURE_OWNER_BUDGET" }));
      }, 50) : undefined;
      let nativeModels;
      try {
        nativeModels = modelMode ? await verifyInstalledNativeModels({
          root, installed, session, waitJson: fixtureJson, toolRoundLimit, signal: modelBudgetAbort.signal, counterFlushConfig,
        }) : undefined;
      } finally { clearInterval(budgetGuard); }
      if (modelOwnerObservation) {
        modelOwnerObservation.setStage("native-model-complete");
        modelOwnerDiagnostics = await modelOwnerObservation.finish();
      }
      await writeFile(join(root, "native-attachment-verified.json"), JSON.stringify({
        authenticated: true, businessReady: false, brokerPid: process.pid,
        activationId: session.activationId, identitySha256: session.identitySha256, livenessPastDeadline: true,
        nativeRequests: { admission: true, readBeforeAdmissionDenied: true, scopedRead: true, writeDeny: true,
          writeApprove: true, cancelledLateClickIgnored: true, credentialPresenceOnly: true, unavailableModelRejected: true },
        ...(nativeModels ? { nativeModels } : {}),
      }));
      if (modelMode && toolRoundLimit === 48) {
        const ready = await fixtureJson(join(root, "native-model-close-ready.json"), 5000);
        assert.deepEqual(ready, { identitySha256: session.identitySha256, brokerPid: process.pid });
        modelOwnerObservation.markExpected("close");
        await nativeControl.close(); nativeControl = undefined;
        await writeFile(join(root, "native-model-close-completed.json"),
          JSON.stringify({ ...ready, closed: true }), { flag: "wx" });
      }
    })().catch(async error => {
      const errors = [error];
      if (modelOwnerObservation) try { modelOwnerDiagnostics = await modelOwnerObservation.finish(); }
      catch (diagnosticError) { if (diagnosticError !== error) errors.push(diagnosticError); }
      await writeFile(join(root, "progress.json"), JSON.stringify({ stage: "failed",
        error: `Native protocol verification failed (${error?.code || error?.name || "unknown"}).` }));
      if (errors.length > 1) throw new AggregateError(errors, "Native protocol and diagnostics failed; retain both causes.");
      throw error;
    }) : Promise.resolve();
    const fixturePath = join(root, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    // VS Code's extensionTestsPath mode rejects modal dialogs. A separate development
    // driver invokes the installed host without enabling that dialog-suppressing mode.
    modelEditorStartedAt = performance.now();
    app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`, "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-telemetry", "--disable-updates", "--skip-welcome", "--skip-release-notes",
        "--password-store=basic", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
        `--remote-debugging-port=${port}`, "--remote-allow-origins=http://127.0.0.1"], {
      env: { ...env, ...roomCallerEnvironment, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(fixture) }, stdio: "inherit",
    });
    const electron = new Promise((resolve, reject) => {
      app.once("error", reject);
      app.once("exit", code => code === 0 ? resolve() : reject(new Error(`Private VS Code exited ${code}`)));
    });
    const deadline = setTimeout(() => app.kill("SIGTERM"), coordinatorMode || identityMode ? 225000 : 105000);
    electron.then(() => clearTimeout(deadline), () => clearTimeout(deadline));
    fixture.editorPid = app.pid;
    await writeFile(fixturePath, JSON.stringify(fixture));
    ui = spawn(python, ["-B", fileURLToPath(new URL("installed-ui.py", import.meta.url)), fixturePath], { env, stdio: "inherit" });
    if (modelMode && toolRoundLimit === 48) modelEditorDeadline = setTimeout(() => {
      modelBudgetAbort.abort(Object.assign(new Error("Owned editor fixture exceeded its 150-second budget."), { code: "FIXTURE_EDITOR_BUDGET" }));
      void stop(ui); void stop(app);
    }, 150000);
    const uiDone = new Promise((resolve, reject) => {
      ui.once("error", reject);
      ui.once("exit", code => code === 0 ? resolve() : reject(new Error(`Real dialog driver failed: ${code}; inspect ${root}`)));
    });
    const results = await Promise.allSettled([electron, uiDone, nativeAttachment, ...(roomCredentialUi ? [roomCredentialUi.done] : [])]);
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Installed native verification failed; all component errors are retained.");
    if (modelMode) {
      if (nativeControl) {
        modelOwnerObservation.markExpected("close");
        await nativeControl.close(); nativeControl = undefined;
      }
      modelOriginLogs = await collectFirstOriginLogs({ root });
    }
    const activation = JSON.parse(await readFile(join(root, "activation.json"), "utf8"));
    assert.equal(activation.active, true);
    assert.equal(JSON.parse(await readFile(join(root, "electron-passed.json"), "utf8")).passed, true);
    const initialUi = JSON.parse(await readFile(join(root, "ui-passed.json"), "utf8"));
    assert.equal(initialUi.passed, true);
    let coldComponent;
    if (coldMode) {
      assert.equal(app.exitCode, 0, "The complete actual editor must exit before cold bootstrap.");
      await nativeControl.close(); nativeControl = undefined;
      coldComponent = await verifyInstalledColdComponent({
        root, fixture, installed, payloadBuildId: installedPayload.buildId, editor, cliArgs, env, short,
        python, uiScript: fileURLToPath(new URL("installed-ui.py", import.meta.url)), nativeHome, stop, roomCredentialIntent,
        roomLiveCredentialPreparation, roomCallerEnvironment,
      });
      for (const phase of ["preparation", "b0", "b1"]) {
        const quiescence = coldComponent.coldQuiescence[phase];
        assert.equal(quiescence.stableRequired, 3);
        assert(quiescence.reports.length >= 3 && quiescence.reports.slice(-3).every(report =>
          report.allowedExtensionHostPids.length === 0 && report.blockers.length === 0),
        `Cold ${phase} must retain three clean strict inventories, not only editor main-process exit.`);
      }
    }
    run(cli, [...cliArgs, "--uninstall-extension", "pkm-nonproduction.pkm-v5"], { env });
    const list = execFileSync(cli, [...cliArgs, "--list-extensions"], { env, encoding: "utf8", timeout: 120000 });
    assert(!list.includes("pkm-nonproduction.pkm-v5"));
    evidence = {
      schema: "pkm.installed-host-acceptance/v1", passed: true, timestamp: new Date().toISOString(),
      editor, vsix, vsixSha256, installedPayloadBuildId: installedPayload.buildId,
      isolation: { privateNetwork: true, privateAuthenticatedDisplay: true, privateProcessNamespace: coldMode,
        source: "synthetic-disposable-notes" },
      installation: { executable: cli, args: [...cliArgs, "--install-extension", vsix, "--force"],
        userData: join(root, "u"), extensions: join(root, "x"), installed, uninstalled: true },
      activation, ui: initialUi,
      ...(sideBySide ? { sideBySide: JSON.parse(await readFile(join(root, "side-by-side-passed.json"), "utf8")) } : {}),
      ...(fixture.nativeIdentity ? {
        nativeIdentity: JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8")),
        ...(modelMode ? { nativeModels: JSON.parse(await readFile(join(root, "native-model-rpc-passed.json"), "utf8")) } : {}),
        acceptanceScope: "isolated installed native SecretStorage enrollment/reload and real signed IPC/liveness; basic test-only password store; not actual production keyring or business activation",
      } : {}),
      ...(modelMode ? { nativeModelDiagnostics: {
        owner: modelOwnerDiagnostics.report,
        provider: JSON.parse(await readFile(join(root, "native-model-provider-observed.json"), "utf8")).report,
        producerFirstOrigins: modelOriginLogs.report,
      } } : {}),
      ...(coldComponent ? { coldComponent } : {}),
      ...(coordinatorMode === "preflight-safety"
        ? { acceptanceScope: "installed preflight safety/negative-path only",
          coordinatorPreflightSafety: JSON.parse(await readFile(join(root, "coordinator-preflight-passed.json"), "utf8")) }
        : coordinatorMode ? { coordinator: JSON.parse(await readFile(join(root, "coordinator-passed.json"), "utf8")) } : {}),
      electronExitCode: app.exitCode, productionCutover: false,
    };
    if (modelMode && toolRoundLimit === 48) {
      const { owner, provider, producerFirstOrigins } = evidence.nativeModelDiagnostics;
      assert(performance.now() - modelEditorStartedAt <= 150000, "Owned editor and cleanup exceeded the declared fixture budget.");
      assert(owner.elapsedMs <= 110000 && evidence.nativeModels.executionDurationMs <= 95000);
      assert.equal(owner.firstAbort, null);
      assert.equal(owner.diagnosticProblems.length, 0); assert.equal(provider.diagnosticProblems.length, 0);
      assert(owner.maxima.rssBytes <= 402653184 && owner.maxima.heapUsedBytes <= 134217728);
      assert(provider.maxima.rssBytes <= 1073741824 && provider.maxima.heapUsedBytes <= 268435456);
      assert(owner.maxima.loopLagMs < 1000 && provider.maxima.loopLagMs < 1000);
      assert(producerFirstOrigins.coverage.prefixes.chat && producerFirstOrigins.coverage.prefixes.attachment,
        "Missing producer first-origin coverage cannot prove the declared stability criterion.");
      assert.equal(producerFirstOrigins.diagnosticProblems.length, 0);
      const { executionStartedEpochMs: start, executionEndedEpochMs: end } = evidence.nativeModels;
      assert(!producerFirstOrigins.rows.some(row => !row.expectedShutdown && row.epochTimeMs >= start && row.epochTimeMs <= end));
      assert(!provider.firstRegistryEvents.some(row => row.epochTimeMs >= start && row.epochTimeMs <= end));
      evidence.nativeModelAcceptance = {
        declaredToolRounds: 48, declaredBudgetsSatisfied: true, pairedPingPongAvailable: false,
        historicalCauseReproduced: false, fullStabilityQualified: false,
      };
    }
    passed = true;
    console.log("PASS installed host VSIX: real file pickers, read-only preview, deny/no-write, exact-plan confirmation/publication; private profile uninstalled.");
    if (coordinatorMode === "preflight-safety")
      console.log("PASS preflight safety/negative-path only; adoption, managed read, rollback and live takeover NOT verified.");
  } finally {
    clearTimeout(modelEditorDeadline);
    await roomCredentialUi?.stop();
    await stop(ui);
    await stop(app);
    await stop(display);
    if (nativeControl) await nativeControl.close();
    if (nativeDirectory) await rm(nativeDirectory, { recursive: true });
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (passed) {
      await rm(root, { recursive: true, force: true });
      if (evidencePath) {
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(evidencePath, JSON.stringify({ ...evidence, profileRemoved: true }, null, 2) + "\n");
        console.log(`Installed-host evidence: ${evidencePath}`);
      }
    }
    else console.error(`Private fixture retained for diagnosis: ${root}`);
  }
}

await main();
