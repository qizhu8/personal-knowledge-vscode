const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createBoundedFileWatcher, MAX_PKM_NATIVE_WATCHERS, isPkmWatchPathAllowed } = require("../dist/runtime/bounded-file-watcher");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error("Timed out waiting for bounded file watcher");
}

test("PKM watchers share a hard native limit, prune dependencies and poll unwatched directories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-bounded-watch-"));
  const originalWatch = fs.watch;
  let allocated = 0, peak = 0, initialScans = 0;
  const watchedPaths = [];
  const errors = [], events = [];
  fs.watch = (directory, options, listener) => {
    assert.equal(options.recursive, false);
    watchedPaths.push(directory);
    allocated++;
    peak = Math.max(peak, allocated);
    const watcher = originalWatch(directory, options, listener);
    const close = watcher.close.bind(watcher);
    let closed = false;
    watcher.close = () => {
      if (!closed) { closed = true; allocated--; }
      close();
    };
    return watcher;
  };
  const instances = [];
  try {
    for (let i = 0; i < 150; i++) {
      const directory = path.join(root, `item-${i}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "note.md"), "original");
    }
    for (const directory of ["node_modules", ".git", ".venv", "__pycache__"]) {
      fs.mkdirSync(path.join(root, directory, "deep"), { recursive: true });
      fs.writeFileSync(path.join(root, directory, "deep", "ignored.md"), "dependency");
    }
    fs.symlinkSync(root, path.join(root, "cycle"), directoryLinkType);
    const options = {
      toEvent: filename => filename,
      accept: filename => {
        if (filename.endsWith("note.md")) initialScans++;
        return true;
      },
      intervalMs: 40,
      onError: error => errors.push(error),
    };
    for (let i = 0; i < 2; i++) {
      const watcher = createBoundedFileWatcher([root], options);
      watcher.onDidCreate(filename => events.push(["create", filename]));
      watcher.onDidChange(filename => events.push(["change", filename]));
      watcher.onDidDelete(filename => events.push(["delete", filename]));
      instances.push(watcher);
    }
    await until(() => initialScans >= 600);
    assert.deepEqual(events, [], "initial discovery must not invalidate every existing file");
    assert.equal(peak, MAX_PKM_NATIVE_WATCHERS);
    assert(!watchedPaths.some(filename => /node_modules|\.git|\.venv|__pycache__|cycle/.test(filename)));
    const unwatched = Array.from({ length: 150 }, (_, i) => path.join(root, `item-${i}`))
      .find(directory => !watchedPaths.includes(directory));
    assert(unwatched);
    const file = path.join(unwatched, "note.md");
    fs.writeFileSync(file, "external edit after watcher cap");
    await until(() => events.some(([kind, filename]) => kind === "change" && filename === file));
    fs.unlinkSync(file);
    await until(() => events.some(([kind, filename]) => kind === "delete" && filename === file));
    const created = path.join(unwatched, "new-directory", "new.md");
    fs.mkdirSync(path.dirname(created));
    fs.writeFileSync(created, "new");
    await until(() => events.some(([kind, filename]) => kind === "create" && filename === created));
    fs.writeFileSync(path.join(root, "node_modules", "deep", "ignored.md"), "changed");
    await wait(100);
    assert(!events.some(([, filename]) => filename.includes("node_modules")));
    assert.deepEqual(errors, []);
    for (const watcher of instances) watcher.dispose();
    assert.equal(allocated, 0);
    const beforeRestart = watchedPaths.length;
    const restarted = createBoundedFileWatcher([root], options);
    instances.push(restarted);
    await until(() => watchedPaths.length >= beforeRestart + MAX_PKM_NATIVE_WATCHERS);
    assert.equal(allocated, MAX_PKM_NATIVE_WATCHERS, "a new instance can reuse all disposed slots");
  } finally {
    for (const watcher of instances) watcher.dispose();
    fs.watch = originalWatch;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(allocated, 0, "disposal releases every native watcher");
});

test("native rename events are classified by snapshot and listener errors are reported", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-watch-events-"));
  const errors = [], events = [];
  const original = path.join(root, "original.json");
  fs.writeFileSync(original, "{}");
  let baselineReads = 0;
  const watcher = createBoundedFileWatcher([root], {
    toEvent: filename => filename, intervalMs: 40, onError: error => errors.push(error),
    accept: () => { baselineReads++; return true; },
  });
  watcher.onDidDelete(() => { throw new Error("failing subscriber"); });
  watcher.onDidDelete(async () => { throw new Error("failing async subscriber"); });
  watcher.onDidDelete(filename => events.push(["delete", filename]));
  watcher.onDidCreate(filename => events.push(["create", filename]));
  try {
    await until(() => baselineReads >= 4);
    fs.unlinkSync(original);
    await until(() => events.some(([kind, filename]) => kind === "delete" && filename === original));
    await until(() => errors.length === 2);
    assert(!events.some(([kind, filename]) => kind === "create" && filename === original), "native rename must not misreport a deleted file as created");
    watcher.dispose();
    const count = events.length;
    fs.writeFileSync(path.join(root, "after-dispose.json"), "{}");
    await wait(100);
    assert.equal(events.length, count);
  } finally {
    watcher.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configured symlink roots work without following descendant symlink cycles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-watch-root-link-"));
  const target = path.join(root, "target"), link = path.join(root, "configured-root");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, directoryLinkType);
  fs.symlinkSync(target, path.join(target, "cycle"), directoryLinkType);
  let reads = 0;
  fs.writeFileSync(path.join(target, "initial.json"), "{}");
  const events = [], errors = [];
  const watcher = createBoundedFileWatcher([link], {
    toEvent: filename => filename, intervalMs: 30, onError: error => errors.push(error),
    accept: () => { reads++; return true; },
  });
  watcher.onDidCreate(filename => events.push(filename));
  try {
    await until(() => reads >= 4);
    fs.writeFileSync(path.join(target, "new.json"), "{}");
    await until(() => events.includes(path.join(link, "new.json")));
    assert(!events.some(filename => filename.includes("cycle")));
    assert.deepEqual(errors, []);
  } finally {
    watcher.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("polling scans do not overlap and disposal during IO cannot allocate or publish again", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-watch-dispose-"));
    const originalReaddir = fs.promises.readdir, originalWatch = fs.watch;
    let entered = false, calls = 0, allocations = 0;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    fs.mkdirSync(path.join(root, "child"));
    fs.writeFileSync(path.join(root, "child", "note.md"), "note");
    fs.promises.readdir = async (...args) => {
      calls++;
      entered = true;
      await blocked;
      return originalReaddir(...args);
    };
    fs.watch = (...args) => { allocations++; return originalWatch(...args); };
    const events = [], errors = [];
    const watcher = createBoundedFileWatcher([root], {
      toEvent: filename => filename, intervalMs: 10, onError: error => errors.push(error),
    });
    watcher.onDidCreate(filename => events.push(filename));
    try {
      await until(() => entered);
      await wait(80);
      assert.equal(calls, 1, "timer ticks must not start concurrent scans");
      watcher.dispose();
      const before = allocations;
      release();
      await wait(100);
      assert.equal(allocations, before, "a disposed scan cannot open child watchers");
      assert.deepEqual(events, []);
      assert.deepEqual(errors, []);
    } finally {
      watcher.dispose();
      release();
      fs.promises.readdir = originalReaddir;
      fs.watch = originalWatch;
      fs.rmSync(root, { recursive: true, force: true });
    }
});

test("an unreadable subtree reports failure without publishing false deletions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-watch-read-error-"));
    const originalReaddir = fs.promises.readdir;
    const original = path.join(root, "note.md");
    fs.writeFileSync(original, "original");
    let reads = 0, fail = false;
    const events = [], errors = [];
    fs.promises.readdir = async (...args) => {
      reads++;
      if (fail) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return originalReaddir(...args);
    };
    const watcher = createBoundedFileWatcher([root], {
      toEvent: filename => filename, intervalMs: 30, onError: error => errors.push(error),
    });
    watcher.onDidDelete(filename => events.push(["delete", filename]));
    watcher.onDidChange(filename => events.push(["change", filename]));
    try {
      await until(() => reads >= 2);
      fail = true;
      await until(() => errors.length > 0);
      assert.deepEqual(events, []);
      fail = false;
      fs.writeFileSync(original, "new version after permissions recover");
      await until(() => events.some(([kind, filename]) => kind === "change" && filename === original));
      assert(!events.some(([kind]) => kind === "delete"));
    } finally {
      watcher.dispose();
      fs.promises.readdir = originalReaddir;
      fs.rmSync(root, { recursive: true, force: true });
    }
});

test("ENOSPC keeps polling alive; absent roots and exact-file roots remain observable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-watch-enospc-"));
  const originalWatch = fs.watch;
  const errors = [], events = [];
  let attempts = 0;
  fs.watch = () => { attempts++; throw Object.assign(new Error("watch limit exceeded"), { code: "ENOSPC" }); };
  const missing = path.join(root, "missing"), exact = path.join(root, "privacy.json");
  fs.writeFileSync(exact, "{}");
  const watcher = createBoundedFileWatcher([missing, exact], {
    toEvent: filename => filename, intervalMs: 30, onError: error => errors.push(error),
  });
  watcher.onDidCreate(filename => events.push(["create", filename]));
  watcher.onDidChange(filename => events.push(["change", filename]));
  watcher.onDidDelete(filename => events.push(["delete", filename]));
  try {
    await wait(100);
    fs.mkdirSync(missing);
    fs.writeFileSync(path.join(missing, "new.json"), "{}");
    await until(() => events.some(([kind, filename]) => kind === "create" && filename.endsWith("new.json")));
    fs.writeFileSync(exact, '{"privacy":"private"}');
    await until(() => events.some(([kind, filename]) => kind === "change" && filename === exact));
    fs.unlinkSync(exact);
    await until(() => events.some(([kind, filename]) => kind === "delete" && filename === exact));
    assert.equal(attempts, 1, "a full system watch table must not cause repeated allocation attempts");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /polling remains active.*ENOSPC|polling remains active.*watch limit/);
  } finally {
    watcher.dispose();
    fs.watch = originalWatch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("all PKM recursive VS Code watcher registrations are removed", () => {
  for (const filename of ["src/extension.ts", "src/chat/api-chat-view.ts"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
    assert.doesNotMatch(text, /vscode\.workspace\.createFileSystemWatcher\(/);
    assert.match(text, /createBoundedFileWatcher/);
  }
});

test("system path policy uses component boundaries and protects Linux, macOS and Windows", () => {
  for (const filename of ["/", "/usr", "/usr/lib/", "/usr/local/lib", "/usr/lib/../share", "/lib", "/lib64", "/etc", "/proc/1", "/sys", "/dev", "/run/user"]) {
    assert.equal(isPkmWatchPathAllowed(filename, "linux"), false, filename);
  }
  for (const filename of ["/home/alice/knowledge", "/data/knowledge", "/tmp/pkm-test", "/usr-library", "/home/alice/lib"]) {
    assert.equal(isPkmWatchPathAllowed(filename, "linux"), true, filename);
  }
  for (const filename of ["/System/Library", "/Library", "/Applications", "/private/etc", "/private/var/db"]) {
    assert.equal(isPkmWatchPathAllowed(filename, "darwin"), false, filename);
  }
  for (const filename of ["C:\\", "c:\\WINDOWS\\System32", "C:\\Program Files\\Runtime", "C:\\Program Files (x86)", "\\\\?\\C:\\Windows\\System32", "\\\\.\\C:\\Windows"]) {
    assert.equal(isPkmWatchPathAllowed(filename, "win32"), false, filename);
  }
  for (const filename of ["C:\\Users\\alice\\knowledge", "D:\\knowledge", "C:\\WindowsNotes", "C:\\Program Files-notes"]) {
    assert.equal(isPkmWatchPathAllowed(filename, "win32"), true, filename);
  }
  assert.equal(isPkmWatchPathAllowed(""), false);
});

test("system roots and aliases are refused before native registration or directory scanning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-watch-system-"));
  const system = process.platform === "win32" ? process.env.SystemRoot || "C:\\Windows" : "/usr/lib";
  const alias = path.join(root, "knowledge");
  fs.symlinkSync(system, alias, directoryLinkType);
  const originalWatch = fs.watch, originalReaddir = fs.promises.readdir;
  let allocations = 0, reads = 0;
  fs.watch = (...args) => { allocations++; return originalWatch(...args); };
  fs.promises.readdir = (...args) => { reads++; return originalReaddir(...args); };
  const errors = [], events = [];
  const instances = [];
  try {
    for (const filename of [system, alias]) {
      const watcher = createBoundedFileWatcher([filename], {
        toEvent: filename => filename, intervalMs: 10, onError: error => errors.push(error),
      });
      watcher.onDidCreate(filename => events.push(filename));
      instances.push(watcher);
    }
    await until(() => errors.length === 2);
    await wait(80);
    assert.equal(allocations, 0);
    assert.equal(reads, 0, "forbidden roots must not fall back to scanning the same system tree");
    assert.equal(errors.length, 2, "a forbidden root reports once and stops polling");
    assert(errors.every(error => /refused system\/root path.*not be watched or polled/.test(error.message)));
    assert.deepEqual(events, []);
  } finally {
    for (const watcher of instances) watcher.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the production signature sweep also refuses a content-area alias into system libraries", async () => {
  const vm = require("node:vm"), ts = require("typescript");
  const guard = require("../dist/runtime/bounded-file-watcher");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-signature-system-"));
  const system = process.platform === "win32" ? process.env.SystemRoot || "C:\\Windows" : "/usr/lib";
  fs.symlinkSync(system, path.join(root, "notes"), directoryLinkType);
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const signature = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "knowledgeTreeSignature");
  assert(signature);
  let reads = 0;
  const scope = vm.createContext({
    path, getStorePath: () => root,
    assertPkmWatchRootAllowed: guard.assertPkmWatchRootAllowed,
    isPkmWatchDirectory: guard.isPkmWatchDirectory,
    githubSyncIgnoredPath: () => false,
    fs: { promises: { readdir: async () => { reads++; throw new Error("Forbidden scan started"); } } },
    loadProfiler: { record() {} }, setImmediate,
  });
  vm.runInContext(ts.transpileModule(signature.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scope);
  try {
    await assert.rejects(scope.knowledgeTreeSignature(root), /refused system\/root path/);
    assert.equal(reads, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
