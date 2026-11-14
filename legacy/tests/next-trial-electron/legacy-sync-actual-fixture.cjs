"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");

function writeLegacyTargets(globalStorage, target) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/extension.ts"), "utf8");
  const file = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["githubSyncStateDirectory", "githubSyncTargetsPath", "writeGitHubSyncTargets"];
  const functions = names.map(name => {
    const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing retained legacy function: ${name}`);
    return declaration.getText(file);
  });
  const declaration = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(file) === "GITHUB_SYNC_TARGETS_SCHEMA"));
  if (!declaration) throw new Error("Missing retained legacy target schema");
  const program = ts.transpileModule(`${declaration.getText(file)}\n${functions.join("\n")}\nglobalThis.writeTargets=writeGitHubSyncTargets;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { fs, path, process };
  vm.runInNewContext(program, scope);
  scope.writeTargets({ globalStorageUri: { fsPath: globalStorage } }, [target]);
}

// Runs the retained pre-Next Sync implementation against a private local Git remote.
async function prepareLegacySync({ fixture, root, globalStorage, legacyDist, pending = false }) {
  if (!legacyDist) {
    const project = path.resolve(__dirname, "../.."), build = path.join(fixture, "legacy-build");
    legacyDist = path.join(build, "dist");
    fs.mkdirSync(build, { mode: 0o700 });
    fs.copyFileSync(path.join(project, "package.json"), path.join(build, "package.json"));
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(project, "tsconfig.json"),
      "--outDir", legacyDist], { cwd: project, timeout: 120000, stdio: "pipe",
      env: { PATH: process.env.PATH || "", HOME: fixture, TMPDIR: path.join(fixture, "t") } });
  }
  const sync = require(path.join(legacyDist, "sync/github-sync.js"));
  const seed = path.join(fixture, "legacy-seed"), bare = path.join(fixture, "remote.git");
  fs.mkdirSync(seed, { recursive: true, mode: 0o700 });
  const environment = { PATH: process.env.PATH || "", HOME: fixture, TMPDIR: path.join(fixture, "t"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" };
  const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  fs.writeFileSync(path.join(seed, "README.md"), "private fixture\n");
  git(seed, "init", "-q"); git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@example.invalid");
  git(seed, "add", "."); git(seed, "commit", "-qm", "seed"); git(seed, "branch", "-M", "main");
  git(fixture, "clone", "--bare", "-q", seed, bare); fs.chmodSync(bare, 0o700);
  git(fixture, "--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main");
  const repository = "https://github.com/fixture/fixture.git";
  const prior = Object.fromEntries(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_ALLOW_PROTOCOL", "GIT_TERMINAL_PROMPT", "TMPDIR"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
    GIT_CONFIG_VALUE_0: repository, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", TMPDIR: path.join(fixture, "t") });
  try {
    const selection = { public: { skills: { items: [], folders: [""] }, notes: { items: [], folders: [""] } }, private: {} };
    const target = sync.normalizeGitHubSyncTarget({ id: "fixture-target", name: "Retained legacy fixture",
      repository, branch: "main", authentication: { method: "vscode", expectedLogin: "fixture" }, selection,
      automation: { enabled: false, initialSyncCompleted: true, intervalMinutes: 5, syncOnChange: false } });
    const catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    for (const [type, name] of [["skills", "InstallAlpha"], ["skills", "InstallBeta"], ["notes", "Keep"]]) {
      const source = path.join(root, type, `${name}.md`);
      catalog[type].push({ id: name, label: name, cat: "", isPrivate: false, source, destination: `${type}/${name}.md` });
    }
    const checkouts = path.join(globalStorage, "github-sync/checkouts");
    const run = () => sync.syncGitHubTarget(target, catalog, checkouts, { accessToken: "fixture-token" }, root);
    const first = await run();
    sync.completeGitHubSyncTransaction(checkouts, target.id, first.transactionId);
    target.lastSync = { at: new Date().toISOString(), commit: first.commit, fingerprints: first.fingerprints,
      repository, branch: "main", storeRoot: root };
    target.selection.public.notes = { items: [], folders: [] };
    writeLegacyTargets(globalStorage, target);
    if (pending) {
      fs.appendFileSync(path.join(root, "skills/InstallAlpha.md"), "legacy interrupted publication\n");
      await run();
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(checkouts, target.id, "transactions/latest.json")));
    if (receipt.state !== (pending ? "pushed" : "recorded")) throw new Error("Unexpected retained legacy receipt state");
    return { seed, bare, target, receipt };
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

module.exports = { prepareLegacySync };
