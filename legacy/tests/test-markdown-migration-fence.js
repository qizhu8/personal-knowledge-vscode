const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const project = path.resolve(__dirname, "..");
const scratch = path.join(project, ".migration-test-work", `markdown-fence-${randomUUID()}`);
const compiled = path.join(scratch, "extension", "dist");
fs.mkdirSync(compiled, { recursive: true });

function child(script, args) {
  return spawn(process.execPath, ["-e", script, ...args], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
}
function ready(process) {
  return new Promise((resolve, reject) => {
    process.stdout.once("data", resolve);
    process.once("error", reject);
    process.once("exit", code => reject(new Error(`child exited before readiness: ${code}`)));
  });
}
function exit(process) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    process.stderr.on("data", data => { stderr += data; });
    process.once("error", reject);
    process.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}
const writerScript = `
const fs = require('fs');
const [compiled, root, delay] = process.argv.slice(1);
const { withMarkdownAssetMutation } = require(compiled + '/knowledge/markdown-assets');
withMarkdownAssetMutation(root, () => {
  fs.writeFileSync(root + '/notes/held.md', 'started');
  process.stdout.write('admitted\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay));
  fs.writeFileSync(root + '/notes/held.md', 'complete');
});
`;
const fenceScript = `
const [compiled, root, id] = process.argv.slice(1);
require(compiled + '/knowledge/markdown-migration-fence').fenceTrackedMarkdownWrites(root, id);
`;

test("tracked Markdown extension and MCP helper fence, concurrent drain and crash recovery",
  { timeout: 120000, skip: process.platform !== "linux" }, async t => {
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project, "--outDir", compiled, "--sourceMap", "false"], { cwd: project });
  const preload = path.join(scratch, "use-isolated-dist.cjs");
  fs.writeFileSync(preload, `
    const Module = require("node:module"), path = require("node:path");
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...args) {
      if (request.startsWith("../dist/")) request = path.join(${JSON.stringify(compiled)}, request.slice("../dist/".length));
      return resolve.call(this, request, parent, ...args);
    };
  `);
  for (const testFile of ["test-prompt-version-note.js", "test-script-url-lifecycle.js", "test-note-work-item-lifecycle.js"]) {
    execFileSync(process.execPath, ["--require", preload, path.join(project, "tests", testFile)], {
      cwd: project, env: { ...process.env, TMPDIR: scratch }, stdio: "pipe", timeout: 60000,
    });
  }
  const { beginMarkdownMigrationTracking, fenceTrackedMarkdownWrites } = require(path.join(compiled, "knowledge/markdown-migration-fence"));
  const { withMarkdownAssetMutation } = require(path.join(compiled, "knowledge/markdown-assets"));
  const { withCrossProcessLockSync } = require(path.join(compiled, "runtime/cross-process-lock"));
  const store = require(path.join(compiled, "knowledge/filestore"));
  const library = require(path.join(compiled, "knowledge/storage"));
  const fixture = name => {
    const root = path.join(scratch, name);
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    return root;
  };
  const root = fixture("journey");
  store.setStorePath(root);
  store.writeKnowledgeMarkdown("notes", "before.md", undefined, "before");
  const operation = randomUUID();
  beginMarkdownMigrationTracking(root, operation);
  store.writeKnowledgeMarkdown("notes", "host.md", undefined, "host edit");
  library.setStorePath(root);
  fs.mkdirSync(path.join(root, "prompts/project/task/v1"), { recursive: true });
  fs.writeFileSync(path.join(root, "prompts/project/task/v1/prompt.txt"), "original");
  library.promptSaveVersionNote("project", "task", "v1", "prompt.txt", "reviewed");
  assert.equal(library.scriptImport([{ category: "a", file: "script.py", content: "print(1)" }]), 1);
  assert.equal(library.scriptMove("a/script.py", "b"), true);
  store.noteUpsert({ slug: "Plan", title: "Plan", type: "todo", content: "# Plan", tags: [] });
  let work = store.noteWorkItemsRead("Plan");
  work = store.noteWorkItemCommand("Plan", work.digest, { action: "create", item: {
    id: "one", title: "Verify", goal: "Correct response", scope: "GET /health",
    acceptance: ["200 and exact JSON"], state: "Planning", evidence: [],
  } }, { id: "user:alice", role: "user" });
  const helper = path.join(project, "resources/knowledge_mutations.js");
  const extension = path.dirname(compiled);
  const invoke = content => execFileSync(process.execPath, [helper, extension, root], {
    input: JSON.stringify({ operation: "write-markdown", area: "notes", path: "mcp.md", content }),
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  assert.match(invoke("MCP edit"), /"ok":true/);
  const invokeWork = request => execFileSync(process.execPath, [helper, extension, root], {
    input: JSON.stringify({ operation: "work-item-command", area: "notes", path: "Plan.md", ...request }),
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  const claim = JSON.parse(invokeWork({ expectedDigest: work.digest, command: { action: "claim", id: "one" } }));
  assert.equal(claim.items[0].ownerId, "mcp:external");
  work = claim;
  const python = `import sys, types
sys.path.insert(0, sys.argv[1])
todo = types.ModuleType("todo_api"); todo.register_todo_api_tools = lambda *a: None
cap = types.ModuleType("capability_api"); cap.register_capability_tools = lambda *a: None
sys.modules["todo_api"] = todo; sys.modules["capability_api"] = cap
from knowledge_mutations import write_markdown
write_markdown(sys.argv[2], "notes", "python.md", None, "managed MCP", sys.argv[3], sys.argv[4])
`;
  const pythonArgs = ["-B", "-c", python, path.join(project, "resources"), root, process.execPath, extension];
  execFileSync("python3", pythonArgs, { cwd: project, stdio: "pipe" });
  assert.equal(fs.readFileSync(path.join(root, "notes/python.md"), "utf8"), "managed MCP");
  const writer = child(writerScript, [compiled, root, "1200"]);
  const writerExit = exit(writer);
  await ready(writer);
  const drainer = child(fenceScript, [compiled, root, operation]);
  const drained = exit(drainer);
  assert.equal(await Promise.race([drained.then(() => "finished"), new Promise(resolve => setTimeout(() => resolve("waiting"), 100))]), "waiting");
  assert.equal((await writerExit).code, 0);
  assert.equal((await drained).code, 0);
  fenceTrackedMarkdownWrites(root, operation);
  assert.equal(fs.readFileSync(path.join(root, "notes/held.md"), "utf8"), "complete");
  assert.throws(() => store.writeKnowledgeMarkdown("notes", "blocked.md", undefined, "blocked"), /fenced for migration/);
  assert.throws(() => store.noteWorkItemCommand("Plan", work.digest, { action: "claim", id: "one" },
    { id: "chat:one", role: "worker" }), /fenced for migration/);
  assert.throws(() => invokeWork({ expectedDigest: work.digest, command: { action: "release", id: "one" } }), /fenced for migration/);
  assert.throws(() => library.promptSaveVersionNote("project", "task", "v1", "prompt.txt", "blocked"), /fenced for migration/);
  assert.throws(() => library.scriptImport([{ category: "b", file: "script.py", content: "blocked" }]), /fenced for migration/);
  assert.throws(() => library.scriptMove("b/script.py", "c"), /fenced for migration/);
  assert.throws(() => invoke("blocked"), /fenced for migration/);
  assert.throws(() => execFileSync("python3", pythonArgs, { cwd: project, stdio: "pipe" }), /fenced for migration/);
  assert.equal(fs.readFileSync(path.join(root, "notes/mcp.md"), "utf8"), "MCP edit");
  assert.throws(() => fenceTrackedMarkdownWrites(root, randomUUID()), /does not match/);

  const crashedRoot = fixture("crashed");
  const crashedId = randomUUID();
  beginMarkdownMigrationTracking(crashedRoot, crashedId);
  const crashed = child(writerScript, [compiled, crashedRoot, "60000"]);
  const crashedExit = exit(crashed);
  await ready(crashed);
  crashed.kill("SIGKILL");
  assert.equal((await crashedExit).signal, "SIGKILL");
  assert.equal(fs.readFileSync(path.join(crashedRoot, "notes/held.md"), "utf8"), "started");
  assert.throws(() => fenceTrackedMarkdownWrites(crashedRoot, crashedId), /abandoned lock/);
  store.setStorePath(crashedRoot);
  assert.throws(() => store.writeKnowledgeMarkdown("notes", "later.md", undefined, "later"), /outcome is unknown/);
  assert.throws(() => fenceTrackedMarkdownWrites(crashedRoot, crashedId), /outcome is unknown/);

  const failed = fixture("failed");
  const failedId = randomUUID();
  beginMarkdownMigrationTracking(failed, failedId);
  assert.throws(() => withMarkdownAssetMutation(failed, () => { throw new Error("injected failure"); }), /injected failure/);
  assert.throws(() => fenceTrackedMarkdownWrites(failed, failedId), /outcome is unknown/);

  const partial = fixture("partial-import");
  const partialId = randomUUID();
  beginMarkdownMigrationTracking(partial, partialId);
  library.setStorePath(partial);
  assert.throws(() => library.promptImport([
    { project: "project", task: "task", version: "v1", file: "first.txt", content: "written" },
    { project: "project", task: "task", version: "v1", file: "missing/second.txt", content: "not written" },
  ]));
  assert.equal(fs.readFileSync(path.join(partial, "prompts/project/task/v1/first.txt"), "utf8"), "written");
  assert.throws(() => fenceTrackedMarkdownWrites(partial, partialId), /outcome is unknown/);

  const asyncRoot = fixture("async");
  const asyncId = randomUUID();
  beginMarkdownMigrationTracking(asyncRoot, asyncId);
  assert.throws(() => withMarkdownAssetMutation(asyncRoot, () => Promise.resolve()), /Asynchronous Markdown mutations/);
  assert.throws(() => fenceTrackedMarkdownWrites(asyncRoot, asyncId), /outcome is unknown/);

  const beforeTracking = fixture("abandoned-before-tracking");
  const oldWriter = child(writerScript, [compiled, beforeTracking, "60000"]);
  const oldWriterExit = exit(oldWriter);
  await ready(oldWriter);
  oldWriter.kill("SIGKILL");
  assert.equal((await oldWriterExit).signal, "SIGKILL");
  assert.throws(() => beginMarkdownMigrationTracking(beforeTracking, randomUUID()), /abandoned lock/);
  assert.equal(withCrossProcessLockSync(path.join(beforeTracking, ".pkm/state/markdown-assets.lock"), "legacy", () => "recovered"),
    "recovered", "ordinary non-migration lock behavior remains unchanged");

  const malformed = fixture("malformed");
  fs.mkdirSync(path.join(malformed, ".pkm/state/markdown-migration-fence"), { recursive: true });
  store.setStorePath(malformed);
  assert.throws(() => store.writeKnowledgeMarkdown("notes", "not-written.md", undefined, "no"));
  assert.equal(fs.existsSync(path.join(malformed, "notes/not-written.md")), false);
});
