"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");

const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value);
};
const skill = (name, body, digit) =>
  `---\nname: ${name}\nknowledgeId: knowledge_${digit.repeat(24)}\nrevision: 1\n---\n${body}\n`;
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = value => createHash("sha256").update(value).digest("hex");

function initialFiles(legacy) {
  return {
    [path.join(legacy, "notes/Unselected.md")]: "---\ntitle: Unselected\nknowledgeId: knowledge_333333333333333333333333\n---\nunselected note quasar\n",
    [path.join(legacy, "scripts/unselected.py")]: "# unselected script zephyr\n",
    [path.join(legacy, "scripts/.unselected.py.pkm.json")]:
      JSON.stringify({ schema: "pkm.script/v1", knowledgeId: "script_444444444444444444444444",
        aliases: ["pkm://scripts/unselected.py"] }) + "\n",
    [path.join(legacy, "skills/InstallAlpha.md")]: skill("InstallAlpha", "first installed alpha nebula", "1"),
    [path.join(legacy, "skills/InstallBeta.md")]: skill("InstallBeta", "first installed beta", "2"),
  };
}

exports.prepareRoot = legacy => {
  for (const [file, value] of Object.entries(initialFiles(legacy))) put(file, value);
};

async function until(read, predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function directoryBytes(root, areas) {
  const result = {};
  function visit(base, relative) {
    const dir = path.join(base, relative);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name), file = path.join(base, rel);
      assert(!entry.isSymbolicLink(), "Synthetic unselected files cannot contain links");
      if (entry.isDirectory()) { result[`${rel}/`] = "directory"; visit(base, rel); }
      else { assert(entry.isFile()); result[rel] = digest(fs.readFileSync(file)); }
    }
  }
  for (const area of areas) visit(root, area);
  return result;
}

exports.run = async ({ root, extensionPath, legacy, python, vscode }) => {
  const fixture = path.join(root, "skills-installed"), runtime = path.join(fixture, "runtime");
  fs.mkdirSync(fixture, { mode: 0o700 });
  const run = (command, args, cwd = fixture) => execFileSync(command, args, {
    cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000,
  }).trim();
  const git = (cwd, args) => run("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], cwd);
  run(python, ["-m", "venv", "--system-site-packages", runtime]);
  const runtimePython = path.join(runtime, "bin", "python");
  const wheel = path.join(extensionPath, "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl");
  run(runtimePython, ["-m", "pip", "install", "--no-index", "--no-deps", "--no-cache-dir", wheel]);

  const skills = path.join(legacy, "skills");
  for (const [file, value] of Object.entries(initialFiles(legacy))) {
    assert.equal(fs.readFileSync(file, "utf8"), value, `Pre-activation fixture changed: ${file}`);
  }
  const areas = ["notes", "papers", "scripts", "prompts"];
  const originalBytes = directoryBytes(legacy, areas);

  const remote = path.join(fixture, "remote.git"), seed = path.join(fixture, "seed");
  fs.mkdirSync(seed);
  git(fixture, ["init", "--bare", "--quiet", remote]);
  git(seed, ["init", "--quiet"]);
  git(seed, ["config", "user.name", "Synthetic"]);
  git(seed, ["config", "user.email", "synthetic@example.invalid"]);
  put(path.join(seed, "README.md"), "isolated synthetic repository\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "--quiet", "-m", "seed"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "--quiet", "-u", "origin", "main"]);
  git(fixture, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const storage = path.join(root, "u/User/globalStorage/uone.personal-knowledge");
  const state = path.join(storage, "retrieval", digest(path.resolve(legacy)).slice(0, 16));
  const snapshotFile = path.join(state, "snapshot.json"), marker = path.join(state, "skills-only-refresh.json");
  const endpointFile = path.join(state, "worker.json");
  const targetsFile = path.join(storage, "github-sync/targets.json");
  const syncError = () => {
    if (!fs.existsSync(targetsFile)) return;
    const target = json(targetsFile).targets.find(item => item.id === "installed-skills-only");
    if (target?.lastFailure) throw new Error(`Real Skills-only Sync failed: ${JSON.stringify(target.lastFailure)}`);
  };
  const remoteSkills = () => {
    const manifest = JSON.parse(git(fixture, ["--git-dir", remote, "show", "main:.pkm-github-sync.json"]));
    assert.equal(manifest.schema, 3);
    return manifest.files.filter(file => file.type === "skills").map(file => file.path).sort();
  };
  assert(!fs.existsSync(snapshotFile), "First Skills-only run must start without an existing index");

  const originalCreate = vscode.window.createWebviewPanel;
  const originalWarning = vscode.window.showWarningMessage;
  const originalInput = vscode.window.showInputBox;
  const originalError = vscode.window.showErrorMessage;
  const originalGetSession = vscode.authentication.getSession;
  let panel, receive, fullRefreshChoice, mountInputs, mountWarningSeen = false, mountError;
  const messages = [];
  vscode.window.createWebviewPanel = function (...args) {
    const created = originalCreate.apply(this, args);
    if (args[0] !== "personalKnowledge") return created;
    const webview = new Proxy(created.webview, {
      get(target, property) {
        if (property === "onDidReceiveMessage") return callback => { receive = callback; return { dispose() {} }; };
        if (property === "postMessage") return async message => { messages.push(message); return true; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    panel = new Proxy(created, {
      get(target, property) {
        if (property === "webview") return webview;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    return panel;
  };
  vscode.window.showInputBox = async options => {
    if (options?.title === "Mount GitHub Skills" && mountInputs) {
      assert(mountInputs.length, "Unexpected mount input");
      return mountInputs.shift();
    }
    return /Force use Local|Upgrade from this machine/.test(options?.title || "") ? "isolated fixture authority" : originalInput(options);
  };
  vscode.window.showWarningMessage = async (message, options, ...items) => {
    if (message === "Mount this branch's Skills/ using PKM GitHub Sync?") {
      assert(mountInputs && options.modal);
      assert.match(options.detail, /ALL public and private local Skills/);
      assert.match(options.detail, /Initial comparison only fetches/);
      assert(items.includes("Mount Skills only"));
      mountWarningSeen = true;
      return "Mount Skills only";
    }
    if (/^(Upgrade from this machine|Force use Local) ·/.test(message)) {
      assert.equal(options.modal, true);
      assert.match(options.detail, /source of truth|authoritative/);
      return items[0];
    }
    if (/Skills search was updated without reading other Knowledge areas/.test(message)) {
      if (!fullRefreshChoice) return new Promise(resolve => { fullRefreshChoice = resolve; });
      return undefined;
    }
    if (/Skills-only Sync preserved.*indexing failed/.test(message)) throw new Error(message);
    return originalWarning(message, options, ...items);
  };
  async function send(command, data, expected, expectedError) {
    const id = randomUUID();
    const start = messages.length;
    receive({ command, ...data, profileRequestId: id });
    const response = await until(() => messages.slice(start).find(item =>
      item.profileRequestId === id && (item.command === expected || item.command === "githubSyncError")),
    Boolean, `${command} host response`);
    if (response.command === "githubSyncError") {
      if (expectedError && response.data?.action === command && response.data?.error === expectedError) return response;
      throw new Error(`${command}: ${response.data?.error}`);
    }
    if (expectedError) throw new Error(`${command}: expected ${expectedError}, got ${response.command}`);
    return response;
  }
  async function search(tab, query) {
    const response = await send("knowledgeSearch", { tab, q: query, mode: "lexical", requestId: randomUUID() }, "knowledgeSearch");
    assert.equal(response.data.ok, true, JSON.stringify(response.data));
    assert.notEqual(response.data.model_invoked, true, "Lexical fixture must not invoke a model");
    return response.data.hits;
  }
  async function stopWorker() {
    if (!fs.existsSync(endpointFile)) return;
    const endpoint = json(endpointFile);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, {
      method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token },
    });
    assert(response.ok, "Installed worker must accept authenticated shutdown");
    await until(() => fs.existsSync(endpointFile), exists => !exists, "retrieval worker drain");
  }
  try {
    await vscode.commands.executeCommand("personalKnowledge.openPanelTab", "githubSync");
    assert(panel && receive, "The production panel command must register the real host message handler");
    receive({ command: "ready" });
    await until(() => messages.find(message => message.command === "loadingProgress"), Boolean, "production panel readiness");
    const sync = require(path.join(extensionPath, "dist/sync/github-sync.js"));
    const target = sync.normalizeGitHubSyncTarget({ id: "installed-skills-only", name: "Synthetic Skills",
      repository: remote, branch: "main", automation: { enabled: false },
      selection: { public: { skills: { items: [], folders: [""] } }, private: {} } });
    const initialRemoteHead = git(fixture, ["--git-dir", remote, "rev-parse", "main"]);
    await send("githubSyncSave", { target }, "githubSyncState", "Remote repository has no PKM sync manifest yet.");
    const savedTarget = json(targetsFile).targets.find(item => item.id === target.id);
    assert(savedTarget, "Save must persist the target before the expected manifestless preview error");
    assert.equal(savedTarget.repository, remote);
    assert.equal(savedTarget.automation.enabled, false);
    assert.equal(savedTarget.automation.initialSyncCompleted, false);
    assert.equal(git(fixture, ["--git-dir", remote, "rev-parse", "main"]), initialRemoteHead);
    assert(!git(fixture, ["--git-dir", remote, "ls-tree", "--name-only", "main"]).split("\n").includes(".pkm-github-sync.json"));
    assert(!fs.existsSync(snapshotFile), "Saving a real target must not pre-seed the retrieval index");
    const config = vscode.workspace.getConfiguration("personalKnowledge");
    await config.update("mcpRuntimePath", runtime, vscode.ConfigurationTarget.Global);
    const mcp = require(path.join(extensionPath, "dist/mcp/mcp.js"));
    mcp.invalidateMcpPythonProbes();
    const health = await mcp.mcpRuntimeStatusAsync();
    assert.equal(health.healthy, true, `Offline fixture runtime must pass production health probe: ${health.error}`);
    assert(!fs.existsSync(snapshotFile), "Healthy runtime must not already have a retrieval snapshot before Skills-only Sync");
    console.log(`Trial Electron: ${new Date().toISOString()} healthy runtime, no snapshot before first Skills-only Sync`);
    const queued = await send("githubSyncForceUpdate", { targetId: target.id, publicationUpgrade: true }, "githubSyncRunQueued");
    assert.equal(queued.data.queued, true);
    await until(() => {
      syncError();
      return fs.existsSync(marker) && fs.existsSync(snapshotFile) &&
        json(marker).skillsIndexed && !fs.existsSync(path.join(state, "skills-index-pending.json"));
    },
    Boolean, "first production Skills-only Sync and index");
    const first = json(snapshotFile);
    assert.deepEqual(first.documents.map(doc => doc.skill_id).sort(), ["skill:InstallAlpha", "skill:InstallBeta"]);
    assert.deepEqual(remoteSkills(), ["skills/InstallAlpha.md", "skills/InstallBeta.md"]);
    assert.deepEqual(directoryBytes(legacy, areas), originalBytes, "First Skills-only sync changed an unselected file or sidecar");
    assert((await search("skills", "nebula")).some(hit => hit.sourceId === `pkm://knowledge/knowledge_${"1".repeat(24)}`));

    await until(() => fullRefreshChoice, Boolean, "explicit full-refresh confirmation");
    fullRefreshChoice("Refresh all now");
    await until(() => fs.existsSync(snapshotFile) && !fs.existsSync(marker) &&
      json(snapshotFile).documents.some(doc => doc.content_type === "script") &&
      json(snapshotFile).documents.some(doc => doc.content_type === "note"),
    Boolean, "explicit full refresh to establish a genuine non-Skill index");
    assert.deepEqual(directoryBytes(legacy, areas), originalBytes, "Explicit refresh changed an unselected file or sidecar");
    const before = json(snapshotFile), beforeEvents = json(path.join(state, "index-events.json"));
    const beforeManifest = json(path.join(state, "client-index.json"));
    const untouched = before.documents.filter(doc => doc.content_type !== "skill");
    assert(untouched.length >= 2);

    fs.unlinkSync(path.join(skills, "InstallAlpha.md"));
    put(path.join(skills, "InstallBeta.md"), skill("InstallBeta", "updated installed beta comet", "2"));
    put(path.join(skills, "InstallGamma.md"), skill("InstallGamma", "added installed gamma pulsar", "5"));
    const update = await send("githubSyncForceUpdate", { targetId: target.id }, "githubSyncRunQueued");
    assert.equal(update.data.queued, true);
    await until(() => {
      syncError();
      if (!fs.existsSync(marker) || !fs.existsSync(snapshotFile) || !json(marker).skillsIndexed ||
        fs.existsSync(path.join(state, "skills-index-pending.json"))) return false;
      const docs = json(snapshotFile).documents;
      return docs.some(doc => doc.skill_id === "skill:InstallGamma") &&
        docs.some(doc => doc.skill_id === "skill:InstallBeta" && doc.body.includes("comet")) &&
        !docs.some(doc => doc.skill_id === "skill:InstallAlpha");
    }, Boolean, "production Skills-only add/update/delete");
    const after = json(snapshotFile), afterEvents = json(path.join(state, "index-events.json"));
    const afterManifest = json(path.join(state, "client-index.json"));
    assert.deepEqual(remoteSkills(), ["skills/InstallBeta.md", "skills/InstallGamma.md"]);
    assert.deepEqual(after.documents.filter(doc => doc.content_type !== "skill"), untouched);
    for (const doc of untouched) {
      assert.deepEqual(afterEvents.sources[doc.source_id], beforeEvents.sources[doc.source_id]);
      assert.equal(afterManifest.hashes[doc.skill_id], beforeManifest.hashes[doc.skill_id]);
      assert.equal(afterManifest.source_ids[doc.skill_id], beforeManifest.source_ids[doc.skill_id]);
    }
    assert.deepEqual(directoryBytes(legacy, areas), originalBytes, "Skills-only update changed an unselected file or sidecar");
    const oldPid = json(endpointFile).pid;
    await stopWorker();
    const gamma = await search("skills", "pulsar");
    assert(gamma.some(hit => hit.sourceId === `pkm://knowledge/knowledge_${"5".repeat(24)}`));
    assert(!gamma.some(hit => hit.sourceId === `pkm://knowledge/knowledge_${"1".repeat(24)}`));
    assert((await search("scripts", "zephyr")).some(hit => hit.sourceId === "pkm://script/script_444444444444444444444444"));
    assert.notEqual(json(endpointFile).pid, oldPid, "Search must restart the drained installed worker");
    assert.deepEqual(directoryBytes(legacy, areas), originalBytes);
    console.log("Trial Electron: installed host Skills-only first index, scoped add/update/delete, preserved non-Skill index and restart search verified (lexical; no model).");

    const mountRepository = "https://github.com/pkm-installed-fixture/skills.git";
    const mountRemote = path.join(fixture, "mount-remote.git"), mountSeed = path.join(fixture, "mount-seed");
    fs.mkdirSync(mountSeed);
    git(fixture, ["init", "--bare", "--quiet", mountRemote]);
    git(mountSeed, ["init", "--quiet"]);
    git(mountSeed, ["config", "user.name", "Synthetic"]);
    git(mountSeed, ["config", "user.email", "synthetic@example.invalid"]);
    const remoteSkill = skill("MountRemote", "mounted remote example orion", "6");
    const remoteAsset = Buffer.from([0, 42, 255, 128]);
    put(path.join(mountSeed, "Skills/MountRemote.md"), remoteSkill);
    put(path.join(mountSeed, "Skills/MountRemote.assets/image.png"), remoteAsset);
    put(path.join(mountSeed, "notes/outside.txt"), "outside mount stays untouched\n");
    put(path.join(mountSeed, ".pkm-github-sync.json"), "unrelated root metadata\n");
    git(mountSeed, ["add", "."]);
    git(mountSeed, ["commit", "--quiet", "-m", "mount seed"]);
    git(mountSeed, ["branch", "-M", "main"]);
    git(mountSeed, ["remote", "add", "origin", mountRemote]);
    git(mountSeed, ["push", "--quiet", "-u", "origin", "main"]);
    git(fixture, ["--git-dir", mountRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const mountHead = () => git(fixture, ["--git-dir", mountRemote, "rev-parse", "main"]);
    const initialHead = mountHead(), beforeMount = directoryBytes(legacy, [...areas, "skills"]);
    mountInputs = [mountRepository, "main", "fixture-account"];
    vscode.authentication.getSession = async (provider, scopes) => {
      assert.equal(provider, "github");
      assert.deepEqual(scopes, ["repo"]);
      return { id: "fixture-session", accessToken: "fixture-token-not-a-credential",
        account: { id: "fixture-account-id", label: "fixture-account" }, scopes: ["repo"] };
    };
    vscode.window.showErrorMessage = async (message, ...args) => {
      if (mountInputs) { mountError = String(message); return undefined; }
      return originalError(message, ...args);
    };
    const messageStart = messages.length;
    await vscode.commands.executeCommand("personalKnowledge.mountGitHubSkills");
    assert.deepEqual(mountInputs, []);
    assert(mountWarningSeen);
    assert.equal(mountError, undefined, mountError);
    assert(!messages.slice(messageStart).some(message => message.command === "githubSyncError"),
      "Production mount/save/preview returned an error");
    const mounted = json(targetsFile).targets.find(item => item.repository === mountRepository);
    assert(mounted, "Production mount command must save its target");
    assert.deepEqual(mounted.skillsMount, { path: "Skills", adoption: "explicit" });
    assert.equal(mounted.authentication.method, "vscode");
    assert.equal(mounted.authentication.expectedLogin, "fixture-account");
    assert.equal(mounted.automation.enabled, false);
    assert.equal(mounted.automation.initialSyncCompleted, false);
    for (const privacy of ["public", "private"]) {
      for (const [type, selection] of Object.entries(mounted.selection[privacy])) {
        assert.deepEqual(selection.items, []);
        assert.deepEqual(selection.folders, type === "skills" ? [""] : []);
      }
    }
    const review = json(path.join(storage, "github-sync", "conflicts", mounted.id, "conflict.json"));
    assert.equal(review.purpose, "initial-preview");
    assert(review.files.some(file => file.path === "skills/MountRemote.md"));
    assert.equal(mountHead(), initialHead, "Mount preview must not push");
    assert.deepEqual(directoryBytes(legacy, [...areas, "skills"]), beforeMount, "Mount preview must not sync local files");
    assert(!mounted.lastSync?.commit, "Mount preview must not record a completed sync");

    mountInputs = undefined;
    vscode.authentication.getSession = originalGetSession;
    vscode.window.showErrorMessage = originalError;
    const manual = await send("githubSyncRun", { targetId: mounted.id }, "githubSyncRunQueued");
    assert.equal(manual.data.queued, true, "Explicit normal Sync must be queued");
    await until(() => {
      const current = json(targetsFile).targets.find(item => item.id === mounted.id);
      if (current?.lastFailure) throw new Error(`Installed mount Sync failed: ${JSON.stringify(current.lastFailure)}`);
      return current?.lastSync?.commit && fs.existsSync(path.join(skills, "MountRemote.md")) &&
        fs.existsSync(path.join(skills, "MountRemote.assets/image.png"));
    }, Boolean, "installed mount manual normal Sync");
    assert(fs.readFileSync(path.join(skills, "MountRemote.md"), "utf8").includes("mounted remote example orion"));
    assert.deepEqual(fs.readFileSync(path.join(skills, "MountRemote.assets/image.png")), remoteAsset);
    assert.deepEqual(directoryBytes(legacy, areas), originalBytes);
    const remoteManifest = JSON.parse(git(fixture, ["--git-dir", mountRemote, "show", "main:Skills/.pkm-github-sync.json"]));
    assert.equal(remoteManifest.schema, 3);
    assert(remoteManifest.files.some(file => file.path === "skills/MountRemote.md"));
    assert(remoteManifest.files.some(file => file.path === "skills/InstallGamma.md"));
    assert(remoteManifest.files.every(file => file.type === "skills" && file.path.startsWith("skills/")));
    assert.equal(git(fixture, ["--git-dir", mountRemote, "show", "main:notes/outside.txt"]), "outside mount stays untouched");
    assert.equal(git(fixture, ["--git-dir", mountRemote, "show", "main:.pkm-github-sync.json"]), "unrelated root metadata");
    console.log("Trial Electron: installed mount command saved and previewed without syncing; explicit normal Sync adopted local Git Skills and assets.");
  } finally {
    if (fullRefreshChoice) fullRefreshChoice(undefined);
    try { await stopWorker(); }
    finally {
      panel?.dispose();
      vscode.window.createWebviewPanel = originalCreate;
      vscode.window.showWarningMessage = originalWarning;
      vscode.window.showInputBox = originalInput;
      vscode.window.showErrorMessage = originalError;
      vscode.authentication.getSession = originalGetSession;
    }
  }
};
