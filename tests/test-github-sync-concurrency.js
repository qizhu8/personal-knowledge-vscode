const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, execFileSync } = require("node:child_process");
const ts = require("typescript");
const sync = require("../dist/sync/github-sync");
const { GitHubSyncCoordinator } = require("../dist/sync/github-sync-coordinator");
const { withCrossProcessLock } = require("../dist/runtime/cross-process-lock");
const { validatePortablePersonaChanges } = require("../dist/chat/persona-profiles");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error("Timed out waiting for concurrency test boundary");
}
const source = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
function section(text, start, end, globals) {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert(a >= 0 && b > a);
  const code = ts.transpileModule(text.slice(a, b).replace(/^export /gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({ Buffer, ...globals });
  vm.runInContext(code, context);
  return context;
}

function rollback(root) {
  fs.mkdirSync(root);
  const a = path.join(root, "a.md"), b = path.join(root, "b.md");
  for (const core of [false, true]) {
    fs.writeFileSync(a, "original-a");
    fs.writeFileSync(b, "original-b");
    let applied = false, injected = false;
    const syncSource = source("sync/github-sync.ts");
    const globals = {
        path, os: { tmpdir: () => root }, validatePortablePersonaChanges,
        fs: { ...fs, existsSync: destination => {
          if (applied && !injected && destination === b) {
            injected = true;
            fs.writeFileSync(a, "external-edit-a");
            fs.writeFileSync(b, "external-edit-b");
          }
          return fs.existsSync(destination);
        } },
        githubSyncLocalSnapshotMatches: sync.githubSyncLocalSnapshotMatches,
        syncLocalPath: (store, relative) => path.join(store, relative),
        isSystemManagedFile: () => false,
        writeAtomic: (destination, content) => {
          fs.writeFileSync(destination, content);
          if (destination === a) applied = true;
        },
    };
    const mutationHelper = section(syncSource, "function withActionSyncMutation<", "\nexport function replaceGitHubSyncFilesAtomically(", globals);
    const rollbackHelper = section(syncSource, "function rollbackGitHubSyncMutation(", "\nexport function replaceGitHubSyncFilesAtomically(", globals);
    const context = section(syncSource,
      core ? "interface GitHubSyncLocalWrite" : "export function replaceGitHubSyncFilesAtomically(",
      core ? "\ntype GitHubSyncEntityMap" : "\ninterface GitHubSyncLocalWrite", {
        ...globals, rollbackGitHubSyncMutation: rollbackHelper.rollbackGitHubSyncMutation,
        withActionSyncMutation: mutationHelper.withActionSyncMutation,
      });
    assert.throws(() => core ? context.applyLocalChanges(root, [
      { file: { path: "a.md", type: "notes" }, content: Buffer.from("remote-a"), expectedLocal: Buffer.from("original-a") },
      { file: { path: "b.md", type: "notes" }, content: Buffer.from("remote-b"), expectedLocal: Buffer.from("original-b") },
    ], []) : context.replaceGitHubSyncFilesAtomically([
      { destination: a, content: Buffer.from("remote-a"), guard: { original: Buffer.from("original-a") } },
      { destination: b, content: Buffer.from("remote-b"), guard: { original: Buffer.from("original-b") } },
    ]), /Concurrent edit preserved.*rollback refused/);
    assert(injected);
    assert.equal(fs.readFileSync(a, "utf8"), "external-edit-a");
    assert.equal(fs.readFileSync(b, "utf8"), "external-edit-b");
    const backups = fs.readdirSync(root).filter(name => name.startsWith("pkm-sync-rollback-"));
    assert.equal(backups.length, core ? 2 : 1);
    for (const backup of backups) assert.equal(fs.readFileSync(path.join(root, backup, "original"), "utf8"), "original-a");
  }
}

async function intents(root) {
  for (const outcome of ["failed", "skipped", "attention"]) {
    const directory = path.join(root, outcome);
    let finish, calls = 0, checks = 0;
    const coordinator = new GitHubSyncCoordinator({
      stateDirectory: directory, knowledgeRoot: root, extensionVersion: "3.2.42",
      pollMs: 10, leaseMs: 1000,
      shouldExecute: async () => {
        checks++;
        if (outcome === "skipped" && checks === 1) return new Promise(resolve => { finish = () => resolve(false); });
        return true;
      },
      execute: async () => {
        calls++;
        if (outcome !== "skipped" && calls === 1) return new Promise((_resolve, reject) => {
          finish = () => {
            const error = outcome === "attention"
              ? new (require("../dist/sync/github-sync-content-repair").GitHubSyncContentRepairError)("review", [])
              : new Error("first run failure");
            reject(error);
          };
        });
      },
    });
    try {
      coordinator.configure([{ id: "review", enabled: false, intervalMinutes: 60, syncOnChange: false }]);
      assert.equal(coordinator.request("review", "manual"), true);
      await until(() => !!finish);
      assert.equal(coordinator.request("review", "manual"), outcome !== "skipped",
        "a not-yet-claimed identical intent remains coalesced");
      finish();
      if (outcome !== "skipped") await until(() => calls === 2);
      else await until(() => !JSON.parse(fs.readFileSync(path.join(directory, "coordinator.json"))).intents.review);
      await until(() => !JSON.parse(fs.readFileSync(path.join(directory, "coordinator.json"))).claims.review);
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "coordinator.json"))).intents.review, undefined);
      if (outcome === "skipped") assert.equal(calls, 0);
    } finally { coordinator.dispose(); }
  }
}

async function recipes(root) {
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = path.join(root, "remote.git"), seed = path.join(root, "seed"), store = path.join(root, "store");
  fs.mkdirSync(seed); fs.mkdirSync(store);
  git(root, ["init", "--bare", remote]); git(seed, ["init"]);
  git(seed, ["config", "user.name", "Test"]); git(seed, ["config", "user.email", "test@localhost"]);
  fs.writeFileSync(path.join(seed, "README.md"), "isolated fixture");
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "seed"]); git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]); git(seed, ["push", "-u", "origin", "main"]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {}, completion: { requiredNodes: ["work"] },
  } };
  const compiled = require("../dist/workflows/workflow-contracts").compileWorkflowDefinitionV1(definition);
  assert(compiled.ok);
  const recipe = { recipeId: "recipe_review", scope: "global", category: "Shared", name: "Review",
    description: "original", revision: 1, definition, executableDigest: compiled.executableDigest };
  const empty = () => Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  const catalog = empty();
  catalog.recipes.push({ id: recipe.recipeId, label: recipe.name, cat: recipe.category, isPrivate: false,
    destination: "recipes/Shared/Review.recipe_review.json", content: JSON.stringify(recipe) });
  const target = sync.normalizeGitHubSyncTarget({ name: "review", repository: remote, branch: "main" }, () => "review");
  const checkouts = path.join(root, "checkouts");
  const original = await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store);
  target.lastSync = { at: new Date().toISOString(), commit: original.commit, fingerprints: original.fingerprints };
  await sync.syncGitHubTarget({ ...target, id: "deleter", pendingDeletions: [{
    type: "recipes", itemId: recipe.recipeId, category: recipe.category, privacy: "public", deletedAt: new Date().toISOString(),
  }] }, empty(), checkouts, undefined, store);
  let current = recipe, changed = false;
  const result = await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store, phase => {
    if (phase === "push" && !changed) { current = { ...recipe, description: "new edit", revision: 2 }; changed = true; }
  });
  assert(changed); assert.equal(result.recipeDeletes.length, 1);
  assert(Buffer.isBuffer(result.recipeDeletes[0].expectedLocal));
  const host = section(source("extension.ts"), "function applyGitHubSyncRecipeDeletes(", "\nasync function buildGitHubSyncCatalog(", {
    currentProjectStore: () => ({
      list: () => ({ recipes: current ? [current] : [] }),
      recipeSyncEntries: () => current ? [{ recipe: current, content: JSON.stringify(current) }] : [],
      moveRecipeToTrash: () => { current = undefined; },
    }),
    projectCommand: () => ({}), githubSyncManagedContent: sync.githubSyncManagedContent,
    githubSyncRecipeContent: value => sync.githubSyncManagedContent("recipes", Buffer.from(JSON.stringify(value))),
    validateGitHubSyncConflictLocalState: require("../dist/sync/github-sync-conflicts").validateGitHubSyncConflictLocalState,
  });
  assert.throws(() => host.applyGitHubSyncRecipeDeletes(result.recipeDeletes), /changed/i);
  assert.equal(current.description, "new edit");
  assert.throws(() => host.applyGitHubSyncRecipeDeletes([recipe.recipeId]), /no local version evidence/);
  current = recipe;
  host.applyGitHubSyncRecipeDeletes(result.recipeDeletes);
  assert.equal(current, undefined);
  host.applyGitHubSyncRecipeDeletes(result.recipeDeletes);
}

async function locks(root) {
  fs.mkdirSync(root);
  const child = spawn(process.execPath, [__filename, "--child", root], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", value => { errors += value; });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(errors || `child exit ${code}`)));
  });
  try {
    await until(() => fs.existsSync(path.join(root, "initializing")));
    await withCrossProcessLock(path.join(root, "sync.lock"), "second", 2000, async () => {
      fs.writeFileSync(path.join(root, "second-active"), "active");
      await wait(450);
      assert(!fs.existsSync(path.join(root, "child-entered")));
      fs.unlinkSync(path.join(root, "second-active"));
    });
    await done;
    assert(!fs.existsSync(path.join(root, "overlap")));
    assert(fs.existsSync(path.join(root, "child-entered")));
    const dead = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      const { withCrossProcessLock } = require(process.argv[1]);
      withCrossProcessLock(process.argv[2], "crashing owner", 2000, async () => {
        fs.writeFileSync(process.argv[3], "owned"); process.exit(0);
      });
    `, require.resolve("../dist/runtime/cross-process-lock"), path.join(root, "dead.lock"), path.join(root, "dead-ready")],
    { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      dead.once("error", reject);
      dead.once("exit", code => code === 0 ? resolve() : reject(new Error(`dead fixture exit ${code}`)));
    });
    assert(fs.existsSync(path.join(root, "dead-ready")));
    const contenders = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, ["-e", `
        const fs = require("fs"), path = require("path");
        const { withCrossProcessLock } = require(process.argv[1]);
        (async () => {
          for (let i = 0; i < 5; i++) await withCrossProcessLock(process.argv[2], "contender", 4000, async () => {
            const marker = process.argv[3];
            const fd = fs.openSync(marker, "wx"); fs.closeSync(fd);
            await new Promise(resolve => setTimeout(resolve, 5));
            fs.unlinkSync(marker);
          });
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `, require.resolve("../dist/runtime/cross-process-lock"), path.join(root, "dead.lock"), path.join(root, "exclusive")],
      { stdio: ["ignore", "ignore", "pipe"] });
      let detail = "";
      worker.stderr.on("data", value => { detail += value; });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(detail || `contender exit ${code}`)));
    }));
    await Promise.all(contenders);
    assert(!fs.existsSync(path.join(root, "dead.lock")));
    const lock = path.join(root, "legacy.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "live", acquiredAt: 1, owner: "live" }));
    await assert.rejects(() => withCrossProcessLock(lock, "contender", 60, async () => assert.fail("live owner revoked"), 1), /timed out/);
    assert(fs.existsSync(lock));
  } finally {
    if (child.exitCode === null) { child.kill(); await done.catch(() => {}); }
  }
}

if (process.argv[2] === "--child") {
  const root = process.argv[3], originalWrite = fs.writeFileSync;
  let delayed = false;
  fs.writeFileSync = function(destination, ...args) {
    if (typeof destination === "number" && !delayed) {
      delayed = true;
      originalWrite(path.join(root, "initializing"), "ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    return originalWrite(destination, ...args);
  };
  withCrossProcessLock(path.join(root, "sync.lock"), "first", 2000, async () => {
    if (fs.existsSync(path.join(root, "second-active"))) originalWrite(path.join(root, "overlap"), "overlap");
    originalWrite(path.join(root, "child-entered"), "entered");
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-concurrency-"));
    try {
      rollback(path.join(root, "rollback"));
      await intents(path.join(root, "intents"));
      await recipes(root);
      await locks(path.join(root, "locks"));
      console.log("github-sync concurrency regressions passed: guarded rollback, versioned Recipe deletion, sequenced intents, atomic locks");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
