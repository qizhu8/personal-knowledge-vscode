const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { githubSyncCatalogInWorker } = require("../dist/sync/github-sync-catalog-worker");
const { setPrivacyStoreRoot, setTopLevelPrivacy } = require("../dist/knowledge/content-privacy");
const { normalizeGitHubSyncTarget, syncGitHubTarget, validateGitHubSyncCandidate, replaceGitHubSyncFilesAtomically } = require("../dist/sync/github-sync");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding:"utf8", stdio:["ignore", "pipe", "pipe"] }).trim();
const definition = id => ({ schema:"pkm.action.definition/v1", action_id:id, version:1, display_name:id, effects:["pure"],
  input_schema:{ type:"object" }, output_schema:{ type:"object" },
  implementations:[{ kind:"pipeline", platforms:["Linux","Windows","Darwin"], steps:[] }] });
const catalog = root => githubSyncCatalogInWorker({ root, servers:[], recipes:[] });
function write(root, relative, value) {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
}

test("Actions and ModuleSets use isolated real Git roundtrips, privacy, explicit selection and no runtime-state propagation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-action-sync-")); t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const publisher = path.join(root, "publisher"), receiver = path.join(root, "receiver"), remote = path.join(root, "remote.git"), seed = path.join(root, "seed");
  fs.mkdirSync(seed); fs.mkdirSync(publisher); fs.mkdirSync(receiver);
  git(root, "init", "--bare", remote); git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.test");
  write(seed, "README.md", "fixture");
  git(seed, "add", "."); git(seed, "commit", "-m", "seed"); git(seed, "remote", "add", "origin", remote); git(seed, "push", "origin", "main");
  git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const id of ["test.public", "test.private", "core.delay", "system.hidden"]) write(publisher, `actions/${id}.json`, definition(id));
  write(publisher, ".pkm/state/actions/settings.json", { secret:"must-not-sync", toolchains:{}, enabled_module_sets:["test.bundle/1"] });
  write(publisher, ".pkm/state/actions/policy.json", { grants:["must-not-sync"] });
  execFileSync("python", ["-c", `
import runpy, shutil, sys
from pathlib import Path
fixtures = runpy.run_path("tests/test-action-modules.py")
Runtime = fixtures["ModuleRuntime"]
publisher = Path(sys.argv[1])
runtime = Runtime(publisher.parent / "module-publisher")
runtime.configure_workspace(str(publisher.parent / "module-workspace"))
fixtures["register_test_add"](runtime)
archive = runtime.workspace() / "bundle.zip"
runtime.module_set_export("test.bundle", 1, ["test.fixture.add"], str(archive))
receiver = Runtime(publisher)
receiver.configure_workspace(str(publisher.parent / "module-receiver-workspace"))
copied = receiver.workspace() / "bundle.zip"
shutil.copyfile(archive, copied)
receiver.module_set_import(str(copied))
`, publisher], { cwd:path.join(__dirname, ".."), stdio:"pipe" });
  write(publisher, "action-module-sets/test.bundle/1/receipts.json", { secret:"must-not-sync" });
  setPrivacyStoreRoot(publisher); setTopLevelPrivacy("actions", "test.private", true);
  const local = await catalog(publisher);
  assert.deepEqual(local.actions.map(item => item.id).sort(), ["test.private", "test.public"]);
  assert.equal(local.actions.find(item => item.id === "test.private").isPrivate, true);
  assert.deepEqual(local["action-module-sets"][0].dependencies.map(item => item.destination), ["action-module-sets/test.bundle/1/definitions/test.fixture.add.json"]);
  const target = normalizeGitHubSyncTarget({ name:"Fixture", repository:remote, branch:"main" }, () => "action-fixture");
  assert.deepEqual(target.selection.public.actions.folders, []);
  assert.deepEqual(target.selection.public["action-module-sets"].folders, []);
  target.selection.public.actions.folders = [""];
  target.selection.public["action-module-sets"].folders = [""];
  const first = await syncGitHubTarget(target, local, path.join(root, "push-cache"), undefined, publisher);
  assert(first.commit);
  const files = git(root, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main");
  assert.match(files, /actions\/test.public.json/); assert.doesNotMatch(files, /test.private|core.delay|system.hidden|settings.json|policy.json|receipts.json/);
  const pulled = await syncGitHubTarget(target, await catalog(receiver), path.join(root, "pull-cache"), undefined, receiver);
  assert(fs.existsSync(path.join(receiver, "actions/test.public.json")));
  assert(fs.existsSync(path.join(receiver, "action-module-sets/test.bundle/1/definitions/test.fixture.add.json")));
  assert.equal(fs.existsSync(path.join(receiver, ".pkm/state/actions/settings.json")), false);
  assert(pulled.pulled.includes("actions/test.public.json"));
  execFileSync("python", ["-c", `
import sys
from pathlib import Path
sys.path.insert(0, "resources")
from action_modules import ModuleRuntime
runtime = ModuleRuntime(sys.argv[1])
assert runtime.module_set_list()["module_sets"][0]["enabled"] is False
runtime.configure_workspace(str(Path(sys.argv[1]).parent / "execution-workspace"))
runtime.module_set_load("test.bundle", 1)
definition = runtime.definition("test.fixture.add")
assert runtime.validate("test.fixture.add", definition["content_hash"])["ok"]
run = runtime.call("test.fixture.add", {"left": 2, "right": 3}, "synced-fixture", definition["content_hash"])
assert runtime.wait(run["run_id"])["output"] == {"sum": 5}
`, receiver], { cwd:path.join(__dirname, ".."), stdio:"pipe" });
  const privateTarget = normalizeGitHubSyncTarget({ name:"Private", repository:remote, branch:"private-actions" }, () => "private-fixture");
  privateTarget.selection.private.actions.folders = [""];
  await syncGitHubTarget(privateTarget, local, path.join(root, "private-push"), undefined, publisher);
  const privateReceiver = path.join(root, "private-receiver"); fs.mkdirSync(privateReceiver);
  const privateResult = await syncGitHubTarget(privateTarget, await catalog(privateReceiver), path.join(root, "private-pull"), undefined, privateReceiver);
  assert.deepEqual(privateResult.privateTopLevels.actions, ["test.private"]);
  assert.equal(fs.existsSync(path.join(privateReceiver, "actions/test.public.json")), false);
  assert.throws(() => validateGitHubSyncCandidate("actions/test.bad.json", Buffer.from("{}")), /Invalid portable/);
  assert.throws(() => validateGitHubSyncCandidate("action-module-sets/test.bundle/1/settings.json", Buffer.from("{}")), /Only ModuleSet/);
  write(publisher, "action-module-sets/test.bundle/1/definitions/test.fixture.add.json", "{}");
  await assert.rejects(catalog(publisher), /hash mismatch/);
});

test("Action Sync/restore mutation guard preserves active Runs, qualification, enabled modules and the original shared lock", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-action-sync-guard-")); t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const target = path.join(root, "actions/test.fixture.json"), runtime = path.join(root, ".pkm/state/actions");
  write(root, "actions/test.fixture.json", definition("test.fixture"));
  const original = fs.readFileSync(target);
  const apply = () => replaceGitHubSyncFilesAtomically([{ destination:target, content:Buffer.from("changed") }], "fixture", root);
  for (const state of ["running", "waiting", "outcome_unknown"]) {
    write(root, ".pkm/state/actions/runs/fixture/run.json", { state });
    assert.throws(apply, /Action Runs/);
    assert.deepEqual(fs.readFileSync(target), original);
    assert.equal(fs.existsSync(path.join(runtime, "mutation.lock")), false);
  }
  write(root, ".pkm/state/actions/runs/fixture/run.json", { state:"succeeded" });
  write(root, ".pkm/state/actions/validation-queue.json", { jobs:{ fixture:{ state:"queued" } } });
  assert.throws(apply, /qualification/);
  write(root, ".pkm/state/actions/validation-queue.json", { jobs:{} });
  write(root, ".pkm/state/actions/mutation.lock", { pid:process.pid });
  assert.throws(apply, /busy/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, "mutation.lock"))), { pid:process.pid });
  fs.unlinkSync(path.join(runtime, "mutation.lock"));
  write(root, ".pkm/state/actions/settings.json", { enabled_module_sets:{ "test.bundle":1 } });
  assert.throws(() => replaceGitHubSyncFilesAtomically([{ destination:path.join(root, "action-module-sets/test.bundle/1/manifest.json"), content:Buffer.from("{}") }], "fixture", root), /Unload/);
  assert.equal(fs.existsSync(path.join(runtime, "mutation.lock")), false);
  apply();
  assert.equal(fs.readFileSync(target, "utf8"), "changed");
});
