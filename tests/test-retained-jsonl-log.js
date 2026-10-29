const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vm = require("node:vm");
const ts = require("typescript");
const { RetainedJsonlLog } = require("../dist/runtime/retained-jsonl-log");

const day = 24 * 60 * 60 * 1000;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-log-retention-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const filename = path.join(directory, "github-sync-diagnostic.jsonl");
  return { directory, filename, marker:`${filename}.retention.json`,
    rows:() => fs.readFileSync(filename, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}
function entries(count, start = 0) {
  return Array.from({ length:count }, (_, index) => JSON.stringify({ event:"fixture", index:index + start, text:"多行\névidence" }) + "\n").join("");
}

test("Sync log retains the exact latest 1000 records once per 24h, persisted across restarts", async t => {
  const f = fixture(t);
  let now = day * 10;
  const errors = [];
  fs.writeFileSync(f.filename, entries(1500), { mode:0o600 });
  fs.writeFileSync(`${f.filename}.previous`, "legacy rotation");
  const logger = new RetainedJsonlLog(f.filename, error => errors.push(error), () => now);
  await logger.flush();
  assert.deepEqual(f.rows().map(row => row.index), Array.from({ length:1000 }, (_, index) => index + 500));
  assert.equal(fs.existsSync(`${f.filename}.previous`), false);
  const originalMarker = fs.readFileSync(f.marker, "utf8");
  for (let index = 1500; index < 1700; index++) logger.append({ event:"fixture", index });
  await logger.flush();
  assert.equal(f.rows().length, 1200, "between daily compactions, new records append without tail rescans");
  assert.equal(fs.readFileSync(f.marker, "utf8"), originalMarker);
  now += day - 1;
  const restarted = new RetainedJsonlLog(f.filename, error => errors.push(error), () => now);
  await restarted.flush();
  assert.equal(f.rows().length, 1200, "a restarted window must honor the shared daily marker");
  now++;
  await restarted.flush();
  assert.deepEqual(f.rows().map(row => row.index), Array.from({ length:1000 }, (_, index) => index + 700));
  assert.equal(JSON.parse(fs.readFileSync(f.marker, "utf8")).lastCompactedAt, now);
  assert.deepEqual(errors, []);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
});

test("hot-path writes batch once and do not read log contents or retention state until due", async t => {
  const f = fixture(t), logger = new RetainedJsonlLog(f.filename, assert.fail, () => day * 10);
  await logger.flush();
  const append = fs.appendFileSync, read = fs.readFileSync, open = fs.openSync;
  let appends = 0, stateReads = 0, tailReads = 0;
  fs.appendFileSync = function(file, ...args) { if (file === f.filename) appends++; return append.call(this, file, ...args); };
  fs.readFileSync = function(file, ...args) { if (file === f.marker) stateReads++; return read.call(this, file, ...args); };
  fs.openSync = function(file, ...args) { if (file === f.filename) tailReads++; return open.call(this, file, ...args); };
  try {
    for (let index = 0; index < 1000; index++) logger.append({ index });
    assert.equal(appends, 0, "recording a burst must not block on disk per event");
    await logger.flush();
    assert.equal(appends, 1);
    assert.equal(stateReads, 0);
    assert.equal(tailReads, 0, "ordinary writes must not open the file to scan its tail");
  } finally { fs.appendFileSync = append; fs.readFileSync = read; fs.openSync = open; }
  assert.equal(f.rows().length, 1000);
});

test("automatic 250ms flush persists queued logs without a permanent polling timer", async t => {
  const f = fixture(t), errors = [];
  const logger = new RetainedJsonlLog(f.filename, error => errors.push(error));
  logger.append({ event:"automatic" });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(f.rows(), [{ event:"automatic" }]);
  assert.deepEqual(errors, []);
});

test("4MiB emergency compaction reads a bounded tail and does not scan historical JSON", async t => {
  const f = fixture(t), now = day * 10;
  fs.writeFileSync(f.marker, JSON.stringify({ schema:"pkm.sync-log-retention/v1", lastCompactedAt:now }));
  fs.writeFileSync(f.filename, entries(6000).replaceAll('"text":', `"padding":"${"x".repeat(1000)}","text":`));
  const read = fs.readSync;
  let bytesRead = 0;
  fs.readSync = function(fd, ...args) { const count = read.call(this, fd, ...args); bytesRead += count; return count; };
  try { await new RetainedJsonlLog(f.filename, assert.fail, () => now).flush(); }
  finally { fs.readSync = read; }
  assert.deepEqual(f.rows().map(row => row.index), Array.from({ length:1000 }, (_, index) => index + 5000));
  assert(bytesRead < 2 * 1024 * 1024, `read ${bytesRead} bytes instead of scanning the multi-megabyte file`);
  assert(fs.statSync(f.filename).size < 4 * 1024 * 1024);
});

test("concurrent processes append and compact without losing new diagnostic records", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.filename, entries(2000));
  const modulePath = require.resolve("../dist/runtime/retained-jsonl-log");
  const children = Array.from({ length:4 }, (_, writer) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `
      const { RetainedJsonlLog } = require(process.argv[1]);
      const logger = new RetainedJsonlLog(process.argv[2], error => { throw error; }, () => ${day * 10});
      for (let index = 0; index < 100; index++) logger.append({ writer:Number(process.argv[3]), index });
      logger.flush().catch(error => { console.error(error); process.exitCode = 1; });
    `, modulePath, f.filename, String(writer)], { stdio:["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  }));
  await Promise.all(children);
  const added = f.rows().filter(row => row.writer !== undefined);
  assert.equal(added.length, 400);
  assert.equal(new Set(added.map(row => `${row.writer}:${row.index}`)).size, 400);
  assert.equal(fs.existsSync(`${f.filename}.lock`), false);
});

test("retention errors are explicit and do not erase appended records or poison later flushes", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.marker, "{invalid");
  const logger = new RetainedJsonlLog(f.filename, assert.fail);
  logger.append({ event:"preserve-on-error" });
  await assert.rejects(logger.flush(), SyntaxError);
  assert.equal(f.rows()[0].event, "preserve-on-error");
  fs.rmSync(f.marker);
  logger.append({ event:"recovered" });
  await logger.flush();
  assert.deepEqual(f.rows().map(row => row.event), ["preserve-on-error", "recovered"]);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith(".tmp") || name.endsWith(".pending")), false);
});

test("Sync diagnostic wrapper flushes before opening and reports asynchronous retention errors", async t => {
  const f = fixture(t);
  const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const source = extension.slice(extension.indexOf("class GitHubSyncDiagnostics {"), extension.indexOf("\nconst githubSyncDiagnostics ="));
  const warnings = [], documents = [];
  const sandbox = {
    RetainedJsonlLog, fs, path, process,
    log:{ warn:message => warnings.push(message) },
    vscode:{ env:{ remoteName:"fixture" }, workspace:{ openTextDocument:async filename => {
      documents.push(fs.readFileSync(filename, "utf8")); return filename;
    } }, window:{ showTextDocument:async () => {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(`${source}\nglobalThis.TestDiagnostics = GitHubSyncDiagnostics;`, {
    compilerOptions:{ target:ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  const logger = new sandbox.TestDiagnostics();
  logger.init({ globalStorageUri:{ fsPath:f.directory } });
  await logger.flush();
  logger.record("github_sync.failed", { targetId:"fixture", error:"Canceled" });
  await logger.open();
  assert.equal(JSON.parse(documents.at(-1)).error, "Canceled");
  assert.equal(warnings.length, 0);
  fs.writeFileSync(f.marker, "{invalid");
  const restarted = new sandbox.TestDiagnostics();
  restarted.init({ globalStorageUri:{ fsPath:f.directory } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(warnings.some(message => message.includes("retention failed")));
  assert.equal(f.rows().length, 1);
  assert(extension.indexOf("await githubSyncDiagnostics.flush();", extension.indexOf("export async function deactivate")) >
    extension.indexOf("githubSyncScheduler?.dispose();", extension.indexOf("export async function deactivate")));
});
