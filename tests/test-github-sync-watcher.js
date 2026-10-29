#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const start = source.indexOf("  const onChange = (uri: vscode.Uri) => {", source.indexOf("function startFileWatcher("));
const end = source.indexOf("  _watcher.onDidCreate(onChange);", start);
assert(start > 0 && end > start);
let timer;
let selected = false;
let ignored = true;
let stopped = false;
let ignoreInputs;
const calls = [];
const context = vm.createContext({
  path, Set, Promise,
  getStorePath: () => "/knowledge",
  signatureRoot: "/knowledge",
  signatureController: { signal: { get aborted() { return stopped; } } },
  githubSyncIgnoredPath: () => false,
  githubSyncExcludedPaths: async (_root, paths) => {
    ignoreInputs = paths;
    return new Set(ignored ? paths.filter(relative => relative.startsWith("servers/runtime/")) : []);
  },
  _watcherRefreshTimer: undefined, _watcherSkillProjectionChanged: false,
  knowledgePaths: new Set(),
  setTimeout: callback => { timer = callback; return { unref() {} }; },
  clearTimeout() { throw new Error("Continuous runtime writes must not postpone the already queued content batch"); },
  invalidateSharedContentCatalog: () => calls.push("catalog"),
  checkContents: () => calls.push("signature"),
  _treeProvider: { refresh: () => calls.push("tree") },
  panel: { webview: { postMessage: () => calls.push("ui") } },
  postToPanel: () => calls.push("ui"),
  schedulePublishedShareRefresh: () => calls.push("share"),
  scheduleRetrievalRefresh: () => calls.push("retrieval"),
  refreshKnowledgeInventory: () => calls.push("inventory"),
  githubSyncScheduler: { notifyContentChanged: () => calls.push("sync") },
  GITHUB_SYNC_CONTENT_TYPES: ["servers", "notes"],
  readGitHubSyncTargets: () => [{
    automation: { enabled: true, syncOnChange: true },
    selection: {
      public: { servers: { items: selected ? ["server"] : [], folders: [] }, notes: { items: ["note"], folders: [] } },
      private: { servers: { items: [], folders: [] }, notes: { items: [], folders: [] } },
    },
  }],
  log: { warn: message => calls.push(`error:${message}`) },
  context: {},
});
vm.runInContext(ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + "\nglobalThis.change = onChange;", context);
const flush = async paths => {
  calls.length = 0;
  for (const relative of paths) context.change({ fsPath: path.join("/knowledge", relative) });
  timer();
  await new Promise(resolve => setImmediate(resolve));
};
(async () => {
  await flush(["servers/runtime/collector.sqlite3-wal", "servers/runtime/transcript-cursor.json"]);
  assert.deepEqual(calls, [], "ignored runtime writes must not invalidate catalog, scan, update UI, or notify Sync");
  ignored = false;
  await flush(["servers/config.json"]);
  assert(calls.includes("catalog"), "unselected content still refreshes the library");
  assert(!calls.includes("sync"), "an unselected content type must not schedule a Sync scan");
  selected = true;
  await flush(["servers/config.json"]);
  assert(calls.includes("sync"));
  ignored = true;
  await flush(["servers/runtime/collector.sqlite3-wal", "notes/selected.md"]);
  assert(calls.includes("sync") && calls.includes("catalog"),
    "ignored noise in the same batch must not suppress a genuine selected edit");
  ignored = false;
  await flush(["notes/selected.md"]);
  assert(calls.includes("sync"), "real edits and deletions continue to notify selected targets");
  ignored = true;
  await flush([".pkm/content-privacy.json"]);
  assert.equal(ignoreInputs.length, 0, "privacy changes bypass .pkm Git ignore");
  assert(calls.includes("sync"));
  stopped = true;
  await flush([".pkm/content-privacy.json"]);
  assert.deepEqual(calls, [], "a disposed watcher must not publish asynchronous filter results");
  console.log("GitHub Sync watcher tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
