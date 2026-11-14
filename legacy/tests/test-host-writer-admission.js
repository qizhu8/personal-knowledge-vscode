"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createHash } = require("node:crypto");
const vm = require("node:vm");
const { HostWriterAdmission } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/host-writer-admission"));
const { HostGitQueue } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/host-git-queue"));

function fixture(t) {
  const directory = path.resolve(".migration-test-work", `host-writer-${randomUUID()}`);
  const root = path.join(directory, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, root };
}

test("drain rejects new work but waits for a real in-flight child and nested write", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  assert.equal(owner.status().pid, process.pid);
  if (process.platform === "linux") assert.match(owner.status().startTimeTicks, /^\d+$/);
  const target = path.join(root, "note.md");
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const writing = owner.run("ui", () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `
      process.stdin.once("data", () => {
        require("node:fs").writeFileSync(process.argv[1], "completed");
      });
      process.stdout.write("ready");
    `, target], { stdio: ["pipe", "pipe", "pipe"], cwd: root });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    child.once("error", reject);
    child.stdout.once("data", () => release(child));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  }).then(() => owner.run("git", () => fs.promises.writeFile(path.join(root, "commit-marker"), "settled"))));
  const child = await started;
  const draining = owner.drain(5000);
  assert.equal(owner.status().state, "draining");
  assert.equal(owner.status().kinds.ui, 1);
  await assert.rejects(owner.run("ui", () => fs.promises.writeFile(target, "new")), /closed/);
  child.stdin.end("finish");
  await writing;
  await draining;
  assert.equal(fs.readFileSync(target, "utf8"), "completed");
  assert.equal(fs.readFileSync(path.join(root, "commit-marker"), "utf8"), "settled");
  assert.deepEqual({ state: owner.status().state, inFlight: owner.status().inFlight,
    completeHostCoverage: owner.status().completeHostCoverage, cutoverAuthorized: owner.status().cutoverAuthorized },
  { state: "drained", inFlight: 0, completeHostCoverage: false, cutoverAuthorized: false });
});

test("failure, cancellation and timeout remain unknown rather than authorizing handoff", async t => {
  const { root } = fixture(t);
  for (const outcome of ["failure", "cancel"]) {
    const owner = new HostWriterAdmission(root, () => root);
    let reject;
    const write = owner.run("sync", () => new Promise((_, fail) => { reject = fail; }));
    const drain = owner.drain(1000);
    reject(new Error(outcome === "cancel" ? "cancelled after dispatch" : "write failed"));
    await assert.rejects(write);
    await assert.rejects(drain, /unknown/);
    assert.equal(owner.status().state, "unknown");
    await assert.rejects(owner.run("sync", () => {}), /closed/);
  }
  const owner = new HostWriterAdmission(root, () => root);
  let release;
  const pending = owner.run("chat", () => new Promise(resolve => { release = resolve; })
    .then(() => owner.observe("git", () => fs.promises.writeFile(path.join(root, "settled"), "yes"))));
  await assert.rejects(owner.drain(20), /timed out/);
  assert.throws(() => owner.resumeAfterFailedDrain(), /settled/);
  await owner.observeCancellation(() => { release(); });
  await pending;
  assert.equal(fs.readFileSync(path.join(root, "settled"), "utf8"), "yes");
  assert.equal(owner.status().state, "unknown");
  await assert.rejects(owner.observe("ui", () => {}), /closed/);
  owner.resumeAfterFailedDrain();
  assert.equal(await owner.observe("ui", () => "legacy resumed"), "legacy resumed");
  await assert.rejects(owner.drain(), /cancellation was requested/);
  assert.equal(owner.status().cutoverAuthorized, false);
  const cancelled = new HostWriterAdmission(root, () => root);
  let settle;
  const active = cancelled.run("chat", () => new Promise(resolve => { settle = resolve; }));
  const draining = cancelled.drain(1000);
  await cancelled.observeCancellation(() => { settle(); });
  await active;
  await assert.rejects(draining, /cancellation was requested/);
  assert.equal(cancelled.status().state, "unknown");
});

test("concurrent writers and reentrant writes drain without changing root permissions", async t => {
  const { root } = fixture(t);
  fs.chmodSync(root, 0o750);
  const mode = fs.statSync(root).mode & 0o7777;
  const owner = new HostWriterAdmission(root, () => root);
  const releases = [];
  const work = ["ui", "sync", "chat"].map(kind => owner.observe(kind, () =>
    new Promise(resolve => releases.push(resolve)).then(() => owner.observe("git", async () => {
      await fs.promises.writeFile(path.join(root, `${kind}.md`), kind);
    }))));
  const drain = owner.drain(5000);
  await assert.rejects(owner.drain(5000), /another drain/);
  assert.equal(owner.status().inFlight, 3);
  await assert.rejects(owner.observe("sync", () => {}), /closed/);
  assert.throws(() => owner.observeSync("ui", () => {}), /closed/);
  releases.forEach(release => release());
  await Promise.all(work);
  await drain;
  assert.equal(fs.statSync(root).mode & 0o7777, mode);
  assert.deepEqual(fs.readdirSync(root).sort(), ["chat.md", "sync.md", "ui.md"]);
  assert.equal(owner.status().cutoverAuthorized, false);
});

test("a drained host loses its drain evidence if its Root directory is replaced", async t => {
  const { directory, root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  await owner.drain();
  const original = path.join(directory, "original-root");
  fs.renameSync(root, original);
  fs.mkdirSync(root);
  assert.equal(owner.status().state, "unknown");
  assert.match(owner.status().detail, /root binding changed/i);
  assert.equal(owner.status().cutoverAuthorized, false);
  assert.throws(() => owner.resumeAfterFailedDrain(), /identity changed/);
  fs.rmdirSync(root);
  fs.renameSync(original, root);
  owner.resumeAfterFailedDrain();
  assert.equal(await owner.observe("ui", () => "legacy available"), "legacy available");
  await assert.rejects(owner.drain(), /root binding changed/i);
});

test("uncertain evidence discovered after a drain invalidates its status", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  await owner.drain();
  owner.markUncertain("late writer completion unknown");
  assert.equal(owner.status().state, "unknown");
  assert.match(owner.status().detail, /late writer completion unknown/);
  assert.equal(owner.status().cutoverAuthorized, false);
  await assert.rejects(owner.observe("ui", () => {}), /closed/);
  owner.resumeAfterFailedDrain();
  assert.equal(await owner.observe("ui", () => "legacy available"), "legacy available");
  await assert.rejects(owner.drain(), /late writer completion unknown/);
});

test("failed host drain cannot resume while a Next writer or rollback marker exists", { skip: process.platform !== "linux" }, async t => {
  for (const name of [".pkm-next-writer-fenced.json", ".pkm-next-root-adoption-rollback.json"]) {
    const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
    owner.markUncertain("host operation outcome unknown");
    await assert.rejects(owner.drain(), /outcome unknown/);
    const marker = path.join(root, name);
    fs.writeFileSync(marker, "preserve", { mode: 0o600 });
    assert.throws(() => owner.resumeAfterFailedDrain(), /fenced|handed to next-server/i);
    assert.equal(owner.status().state, "unknown");
    assert.equal(fs.readFileSync(marker, "utf8"), "preserve");
    fs.unlinkSync(marker);
    owner.resumeAfterFailedDrain();
    assert.equal(await owner.observe("ui", () => "legacy available"), "legacy available");
    await assert.rejects(owner.drain(), /outcome unknown/);
  }
});

test("failed host drain cannot resume while the Root's exclusive writer fence is held", { skip: process.platform !== "linux" }, async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  owner.markUncertain("host operation outcome unknown");
  await assert.rejects(owner.drain(), /outcome unknown/);
  const holder = spawn("flock", ["--exclusive", root, process.execPath, "-e",
    "process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
  { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM"); });
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.stdout.once("data", resolve);
    holder.once("exit", code => reject(new Error(`exclusive fence holder exited ${code}`)));
  });
  assert.throws(() => owner.resumeAfterFailedDrain(), /fence|lock holder|readiness/i);
  assert.equal(owner.status().state, "unknown");
  holder.stdin.end();
  await new Promise(resolve => holder.once("exit", resolve));
  owner.resumeAfterFailedDrain();
  assert.equal(await owner.observe("ui", () => "legacy available"), "legacy available");
  await assert.rejects(owner.drain(), /outcome unknown/);
});

test("a replaced Root invalidates an accepting host status without blocking legacy work", async t => {
  const { directory, root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  fs.renameSync(root, path.join(directory, "original-root"));
  fs.mkdirSync(root);
  assert.equal(owner.status().state, "unknown");
  assert.equal(owner.status().cutoverAuthorized, false);
  assert.equal(await owner.observe("ui", () => "legacy available"), "legacy available");
});

test("root reconfiguration is admitted, blocks drain, and preserves successful legacy root changes", async t => {
  const { directory, root } = fixture(t);
  const next = path.join(directory, "next");
  fs.mkdirSync(next);
  let current = root, release;
  const owner = new HostWriterAdmission(root, () => current);
  const changing = owner.observeRootReconfiguration(async () => {
    await new Promise(resolve => { release = resolve; });
    current = next;
    return { ok: true };
  });
  const draining = owner.drain(5000);
  await assert.rejects(owner.observeRootReconfiguration(() => "should not run"), /closed/);
  release();
  assert.deepEqual(await changing, { ok: true });
  await assert.rejects(draining, /root binding changed/i);
  assert.equal(owner.status().state, "unknown");
  assert.equal(owner.status().cutoverAuthorized, false);
  await assert.rejects(owner.observe("ui", () => "not admitted"), /closed/);
  current = root;
  const normal = new HostWriterAdmission(root, () => current);
  assert.deepEqual(await normal.observeRootReconfiguration(() => { current = next; return { ok: true }; }), { ok: true });
  assert.equal(normal.status().state, "unknown");
  assert.equal(await normal.observe("ui", () => "legacy available"), "legacy available");
});

test("a cancelled root reconfiguration leaves admission and binding intact", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  assert.deepEqual(await owner.observeRootReconfiguration(() => ({ cancelled: true })), { cancelled: true });
  await owner.drain();
  assert.equal(owner.status().state, "drained");
});

test("the actual root reconfiguration command registration closes admission during drain", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  const ts = require("typescript");
  const text = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", text, ts.ScriptTarget.Latest, true);
  const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerRootReconfigurationCommand");
  let command;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "registerRootReconfigurationCommand"
      && node.arguments[0]?.getText(ast) === '"personalKnowledge.reconfigureKnowledgeRoot"') command = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(helper && command, "root reconfiguration must use the admission registration helper");
  let registered, invoked = false;
  const scope = {
    hostWriterAdmission: owner,
    vscode: { commands: { registerCommand(_name, callback) { registered = callback; } } },
  };
  vm.runInNewContext(ts.transpileModule(`${helper.getText(ast)}\nregisterRootReconfigurationCommand("personalKnowledge.reconfigureKnowledgeRoot", async () => { invoked = true; });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, Object.assign(scope, { invoked }));
  await owner.drain();
  await assert.rejects(registered(), /closed/);
  assert.equal(scope.invoked, false);
});

test("hosted Room mutation commands use the actual admitted registration", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  const ts = require("typescript");
  const text = fs.readFileSync(path.resolve("src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", text, ts.ScriptTarget.Latest, true);
  const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerHostWriterCommand");
  const expected = new Set(["renameHostedRoom", "repairStoredRoom", "forceCloseHostedRoom", "closeHostedRoom", "deleteHostedRoom"]);
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "registerHostWriterCommand") {
      const name = node.arguments[0];
      if (ts.isStringLiteral(name) && name.text.startsWith("personalKnowledge.")) expected.delete(name.text.slice("personalKnowledge.".length));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(helper);
  assert.deepEqual([...expected], []);
  let registered;
  const scope = {
    observeHostWriter: (kind, work) => owner.observe(kind, work),
    vscode: { commands: { registerCommand(_name, callback) { registered = callback; } } },
  };
  vm.runInNewContext(ts.transpileModule(`${helper.getText(ast)}\nregisterHostWriterCommand("test", async () => "called");`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
  assert.equal(await registered(), "called");
  await owner.drain();
  await assert.rejects(registered(), /closed/);
});

test("synchronous editor saves honor admission while allowing admitted reentrant work", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const writing = owner.observe("ui", async () => {
    await waiting;
    owner.observeSync("ui", () => fs.writeFileSync(path.join(root, "editor.md"), "saved"));
  });
  const drain = owner.drain(5000);
  assert.throws(() => owner.observeSync("ui", () => {}), /closed/);
  release();
  await writing;
  await drain;
  assert.equal(fs.readFileSync(path.join(root, "editor.md"), "utf8"), "saved");
});

test("the actual Markdown editor provider rejects saves during a host drain", async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  const compiled = fs.readFileSync(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "extension.js"), "utf8");
  const start = compiled.indexOf("class KnowledgeContentFileSystem");
  const end = compiled.indexOf("class RecipeDraftFileSystem", start);
  assert(start >= 0 && end > start);
  let content = "original", commits = 0;
  const sandbox = {
    Buffer, _treeProvider: undefined,
    vscode: { EventEmitter: class { event() {} fire() {} }, FileChangeType: { Changed: 1 } },
    knowledgeMarkdownInfo: () => ({ area: "notes", key: "editor" }),
    filestore_1: {
      noteGet: () => ({ slug: "editor", content, tags: "[]" }),
      noteUpsert: value => { content = value.content; },
    },
    gitCommit: () => { commits++; }, postToPanel: () => {},
    observeHostWriterSync: (kind, work) => owner.observeSync(kind, work),
  };
  vm.runInNewContext(`${compiled.slice(start, end)}; globalThis.Provider = KnowledgeContentFileSystem;`, sandbox);
  const provider = new sandbox.Provider();
  provider.writeFile({}, Buffer.from("saved"));
  assert.equal(content, "saved");
  assert.equal(commits, 1);
  let release;
  const pending = owner.observe("sync", () => new Promise(resolve => { release = resolve; }));
  const draining = owner.drain(5000);
  assert.throws(() => provider.writeFile({}, Buffer.from("not saved")), /closed/);
  assert.equal(content, "saved");
  assert.equal(commits, 1);
  release();
  await pending;
  await draining;
});

test("admission preserves actual legacy root and .pkm permissions on an isolated copy", {
  skip: !process.env.PKM_INSTALLED_LEGACY_FIXTURE || process.platform === "win32",
}, async t => {
  const { directory } = fixture(t);
  const source = path.join(path.resolve(process.env.PKM_INSTALLED_LEGACY_FIXTURE), "root");
  const clone = path.join(directory, "legacy-root");
  const stat = file => {
    const value = fs.statSync(file);
    return { mode: value.mode & 0o7777, uid: value.uid, gid: value.gid };
  };
  const before = [stat(source), stat(path.join(source, ".pkm"))];
  const copied = spawnSync("cp", ["-a", "--", source, clone], { encoding: "utf8" });
  assert.equal(copied.status, 0, copied.stderr);
  assert.deepEqual([stat(clone), stat(path.join(clone, ".pkm"))], before);
  const owner = new HostWriterAdmission(clone, () => clone);
  await owner.observe("ui", () => fs.promises.writeFile(path.join(clone, "notes", "admission-probe.md"), "private"));
  await owner.drain();
  assert.deepEqual([stat(clone), stat(path.join(clone, ".pkm"))], before);
  assert.deepEqual([stat(source), stat(path.join(source, ".pkm"))], before);
});

test("cancelling a real in-flight child waits for exit and preserves its partial effect", { skip: process.platform === "win32" }, async t => {
  const { root } = fixture(t), owner = new HostWriterAdmission(root, () => root);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let child;
  const writing = owner.run("chat", () => new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["-e", `
      process.on("SIGTERM", () => setTimeout(() => {
        require("node:fs").writeFileSync(process.argv[1], "partial");
        process.exit(0);
      }, 100));
      setInterval(() => {}, 1000);
      process.stdout.write("ready");
    `, path.join(root, "partial.md")], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.stdout.once("data", started);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  }));
  await ready;
  let finished = false;
  const drained = assert.rejects(owner.drain(5000), /cancellation was requested/).finally(() => { finished = true; });
  await owner.observeCancellation(() => child.kill("SIGTERM"));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(finished, false);
  assert.equal(owner.status().kinds.chat, 1);
  await writing;
  await drained;
  assert.equal(fs.readFileSync(path.join(root, "partial.md"), "utf8"), "partial");
  assert.equal(owner.status().state, "unknown");
});

test("the production Git queue remains in flight until a real commit exits", { skip: process.platform === "win32" }, async t => {
  const { root } = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Private fixture");
  git("config", "user.email", "fixture@example.invalid");
  const hook = path.join(root, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, '#!/bin/sh\n: > .git/test-ready\nn=0\nwhile [ ! -f .git/test-release ]; do n=$((n+1)); [ "$n" -lt 200 ] || exit 1; sleep 0.05; done\n', { mode: 0o700 });
  t.after(() => { if (fs.existsSync(path.join(root, ".git"))) fs.writeFileSync(path.join(root, ".git/test-release"), ""); });
  fs.writeFileSync(path.join(root, "note.md"), "private fixture");
  const owner = new HostWriterAdmission(root, () => root);
  const queue = new HostGitQueue(() => owner);
  queue.enqueue(root, "fixture commit");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(root, ".git/test-ready"))) {
    if (Date.now() >= deadline) throw new Error("Git hook did not start.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  fs.writeFileSync(path.join(root, "second.md"), "queued after staging");
  queue.enqueue(root, "second fixture commit");
  const draining = owner.drain(5000);
  assert.equal(owner.status().kinds.git, 2);
  fs.writeFileSync(path.join(root, ".git/test-release"), "");
  await draining;
  assert.equal(git("log", "-1", "--format=%s"), "second fixture commit");
  assert.equal(git("log", "--format=%s"), "second fixture commit\nfixture commit");
  fs.writeFileSync(path.join(root, "later.md"), "not admitted");
  queue.enqueue(root, "must not commit");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(git("log", "-1", "--format=%s"), "second fixture commit");
  assert.equal(owner.status().state, "drained");
  assert.equal(owner.status().cutoverAuthorized, false);
});

test("the Git queue commits and drains with an unwritable root parent", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async t => {
  const { directory, root } = fixture(t);
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(git("config", "user.name", "Private fixture").status, 0);
  assert.equal(git("config", "user.email", "fixture@example.invalid").status, 0);
  fs.writeFileSync(path.join(root, "note.md"), "legacy");
  fs.chmodSync(directory, 0o500);
  try {
    const owner = new HostWriterAdmission(root, () => root);
    new HostGitQueue(() => owner).enqueue(root, "automatic");
    await owner.drain(5000);
    assert.equal(owner.status().cutoverAuthorized, false);
    assert.equal(git("log", "-1", "--format=%s").stdout.trim(), "automatic");
  } finally { fs.chmodSync(directory, 0o700); }
});

test("a preexisting private fence directory supports Git and restart with an unwritable root parent", {
  skip: process.platform !== "linux" || process.getuid?.() === 0,
}, async t => {
  const { directory, root } = fixture(t);
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(git("config", "user.name", "Private fixture").status, 0);
  assert.equal(git("config", "user.email", "fixture@example.invalid").status, 0);
  fs.mkdirSync(path.join(directory, ".pkm-next-root-adoption-locks"), { mode: 0o700 });
  fs.chmodSync(directory, 0o500);
  try {
    for (const [file, message] of [["first.md", "first"], ["second.md", "restart"]]) {
      fs.writeFileSync(path.join(root, file), message);
      const owner = new HostWriterAdmission(root, () => root);
      new HostGitQueue(() => owner).enqueue(root, message);
      await owner.drain(5000);
      const log = git("log", "-1", "--format=%s");
      assert.equal(log.status, 0, log.stderr);
      assert.equal(log.stdout.trim(), message);
    }
    const { markLinuxRootNextOwned } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/linux-root-writer-fence"));
    markLinuxRootNextOwned(root);
    fs.writeFileSync(path.join(root, "blocked.md"), "must not commit");
    const blockedOwner = new HostWriterAdmission(root, () => root);
    new HostGitQueue(() => blockedOwner).enqueue(root, "must not commit");
    await assert.rejects(blockedOwner.drain(5000), /unknown/);
    assert.equal(git("log", "-1", "--format=%s").stdout.trim(), "restart");
    assert.equal(fs.statSync(directory).mode & 0o777, 0o500);
  } finally { fs.chmodSync(directory, 0o700); }
});

test("a previous sibling preview lock fails closed without modifying its files", {
  skip: process.platform !== "linux",
}, async t => {
  const { directory, root } = fixture(t);
  const old = path.join(directory, ".pkm-next-root-adoption-locks");
  fs.mkdirSync(old, { mode: 0o700 });
  const id = createHash("sha256").update(root).digest("hex").slice(0, 40);
  const lock = path.join(old, `${id}.writer.lock`);
  fs.writeFileSync(lock, "old lock", { mode: 0o600 });
  const legacy = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/linux-root-writer-fence"));
  assert.throws(() => legacy.withLegacyLinuxRootWriter(root, () => assert.fail("must not write")), /previous experimental sibling/);
  await assert.rejects(legacy.withLegacyLinuxRootWriterAsync(root, async () => assert.fail("must not write")), /previous experimental sibling/);
  assert.equal(fs.readFileSync(lock, "utf8"), "old lock");
});

test("original 4.0.22 Git queue commits inside a writable root with an unwritable parent", {
  skip: process.platform !== "linux" || process.getuid?.() === 0 || !process.env.PKM_ORIGINAL_VSIX,
}, async t => {
  const { directory, root } = fixture(t);
  const archive = path.resolve(process.env.PKM_ORIGINAL_VSIX);
  const original = spawnSync("unzip", ["-p", archive, "extension/dist/extension.js"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(original.status, 0, original.stderr);
  const start = original.stdout.indexOf("let gitCommitQueue = Promise.resolve();");
  const end = original.stdout.indexOf("// (Notes & skills", start);
  assert(start >= 0 && end > start);
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(git("config", "user.name", "Private fixture").status, 0);
  assert.equal(git("config", "user.email", "fixture@example.invalid").status, 0);
  fs.writeFileSync(path.join(root, "first.md"), "original queue");
  const scope = {
    process, child_process_1: require("node:child_process"),
    filestore_1: { getStorePath: () => root }, invalidateSharedContentCatalog() {},
  };
  vm.runInNewContext(`${original.stdout.slice(start, end)}\nglobalThis.enqueue = gitCommit; globalThis.finished = () => gitCommitQueue;`, scope);
  fs.chmodSync(directory, 0o500);
  try {
    scope.enqueue("4.0.22 first");
    scope.enqueue("4.0.22 second");
    await scope.finished();
    const history = git("log", "--format=%s");
    assert.equal(history.status, 0, history.stderr);
    assert.equal(history.stdout.trim(), "4.0.22 first");
    assert.equal(git("status", "--porcelain").stdout, "");
  } finally { fs.chmodSync(directory, 0o700); }
});

test("an owned Git hook keeps the shared root fence after its host crashes", { skip: process.platform !== "linux" }, async t => {
  const { root } = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Private fixture");
  git("config", "user.email", "fixture@example.invalid");
  const ready = path.join(root, ".git/hook-ready"), release = path.join(root, ".git/hook-release");
  fs.writeFileSync(path.join(root, ".git/hooks/pre-commit"),
    '#!/bin/sh\n: > .git/hook-ready\nn=0\nwhile [ ! -f .git/hook-release ]; do n=$((n+1)); [ "$n" -lt 400 ] || exit 1; sleep 0.05; done\n', { mode: 0o700 });
  fs.writeFileSync(path.join(root, "note.md"), "in flight");
  t.after(() => { if (fs.existsSync(path.join(root, ".git"))) fs.writeFileSync(release, ""); });
  const code = `
    const path = require("node:path");
    const { HostWriterAdmission } = require(path.join(process.env.PKM_TEST_DIST, "runtime/host-writer-admission"));
    const { HostGitQueue } = require(path.join(process.env.PKM_TEST_DIST, "runtime/host-git-queue"));
    const root = process.argv[1], owner = new HostWriterAdmission(root, () => root);
    new HostGitQueue(() => owner).enqueue(root, "survives owner exit");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", code, root], {
    env: { ...process.env, PKM_TEST_DIST: process.env.PKM_TEST_DIST || path.resolve("dist") }, stdio: "ignore",
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    if (Date.now() >= deadline || child.exitCode !== null) throw new Error("Owned Git hook did not start.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const exited = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGKILL");
  await exited;
  const exclusive = () => spawnSync("flock", ["-x", "-n", root, "true"]).status;
  assert.equal(exclusive(), 1, "the running owned Git descendant still holds the real shared fence");
  fs.writeFileSync(release, "");
  const finishBy = Date.now() + 10000;
  while (exclusive() !== 0) {
    if (Date.now() >= finishBy) throw new Error("Git descendants did not release their fence.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(git("log", "-1", "--format=%s"), "survives owner exit");
});

test("Git admission waits for an owned hook descendant even after Git exits", { skip: process.platform !== "linux" }, async t => {
  const { root } = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Private fixture");
  git("config", "user.email", "fixture@example.invalid");
  const ready = path.join(root, ".git/hook-ready"), release = path.join(root, ".git/hook-release");
  fs.writeFileSync(path.join(root, ".git/hooks/pre-commit"),
    '#!/bin/sh\n( : > .git/hook-ready; n=0; while [ ! -f .git/hook-release ]; do n=$((n+1)); [ "$n" -lt 400 ] || exit 1; sleep 0.05; done ) </dev/null >/dev/null 2>&1 &\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(root, "note.md"), "in flight");
  t.after(() => { if (fs.existsSync(path.join(root, ".git"))) fs.writeFileSync(release, ""); });
  const owner = new HostWriterAdmission(root, () => root);
  new HostGitQueue(() => owner).enqueue(root, "git exited");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) || spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" }).status !== 0) {
    if (Date.now() >= deadline) throw new Error("Git commit or its owned descendant did not start.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  let done = false;
  const draining = owner.drain(5000).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(done, false);
  assert.equal(owner.status().kinds.git, 1);
  fs.writeFileSync(release, "");
  await draining;
  assert.equal(git("log", "-1", "--format=%s"), "git exited");
});

test("Git keeps legacy execution but cannot claim a safe drain without descendant supervision", { skip: process.platform !== "linux" }, async t => {
  const { root, directory } = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  git("config", "user.name", "Private fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(root, "note.md"), "legacy");
  const tools = path.join(directory, "tools");
  fs.mkdirSync(tools);
  for (const command of ["git", "flock", "sh"]) {
    const found = spawnSync("which", [command], { encoding: "utf8" });
    assert.equal(found.status, 0);
    fs.symlinkSync(found.stdout.trim(), path.join(tools, command));
  }
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  process.env.PATH = tools;
  const owner = new HostWriterAdmission(root, () => root);
  new HostGitQueue(() => owner).enqueue(root, "legacy without python");
  await assert.rejects(owner.drain(5000), /supervision is unavailable/);
  assert.equal(owner.status().state, "unknown");
  process.env.PATH = oldPath;
  git("log", "-1", "--format=%s");
});

test("replaced or rebound root cannot be reported drained", async t => {
  const { root, directory } = fixture(t);
  let current = root;
  const owner = new HostWriterAdmission(root, () => current);
  current = directory;
  assert.equal(await owner.observe("ui", () => "legacy remains usable"), "legacy remains usable");
  assert.equal(owner.status().state, "unknown");
  await assert.rejects(owner.drain(), /cannot start/);
  const cancelling = new HostWriterAdmission(root, () => root);
  let release;
  const active = cancelling.run("chat", () => new Promise(resolve => { release = resolve; }));
  const drain = cancelling.drain(1000);
  const activeRejected = assert.rejects(active, /identity changed/);
  const drainRejected = assert.rejects(drain, /identity changed/);
  fs.renameSync(root, path.join(directory, "cancel-old"));
  fs.mkdirSync(root);
  await cancelling.observeCancellation(() => { release(); });
  await activeRejected;
  await drainRejected;
  assert.equal(cancelling.status().state, "unknown");
  const replacement = new HostWriterAdmission(root, () => root);
  fs.renameSync(root, path.join(directory, "old"));
  fs.mkdirSync(root);
  await assert.rejects(replacement.drain(), /identity changed/);
  assert.equal(replacement.status().state, "unknown");
});
