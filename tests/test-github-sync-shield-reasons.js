const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sync = require("../dist/sync/github-sync");

test("shield reasons distinguish private scope changes, orphan baseline assets and unavailable evidence", () => {
  const share = sync.normalizeGitHubSyncTarget({ id: "share", name: "Share", repository: "/fixture.git" });
  const backup = sync.normalizeGitHubSyncTarget({ id: "backup", name: "Backup", repository: "/fixture.git" });
  const catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  catalog.papers = [{ id: "MyIdeas/Private", label: "Private", cat: "MyIdeas", isPrivate: true,
    destination: "papers/MyIdeas/Private.md" }];
  const files = {
    share: { papers: { "papers/Public.md": "unchanged" }, notes: {} },
    backup: { papers: { "papers/Public.md": "unchanged" }, notes: {} },
  };
  const base = {
    share: { papers: { "papers/Public.md": "unchanged", "papers/MyIdeas/Private.md": "private" },
      notes: { "notes/Old/_assets/plot.png": "image" } },
    backup: { papers: { "papers/Public.md": "unchanged" }, notes: {} },
  };
  const research = sync.githubSyncShieldReasons([share, backup], "papers", files, base, catalog);
  assert.equal(research.length, 1, "An equal Backup baseline must not inherit Share's warning");
  assert.match(research[0], /Share: 0 local-only, 0 changed, 1 baseline-only/);
  assert.match(research[0], /privacy changes.*not automatically deleted/);
  const notes = sync.githubSyncShieldReasons([share, backup], "notes", files, base, catalog);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Old\/_assets\/plot.png/);
  assert.doesNotMatch(notes[0], /privacy changes/);
  assert.match(sync.githubSyncShieldReasons([share], "notes", files, {}, catalog)[0], /baseline unavailable/);
});

test("yellow tab tooltips expose per-target reasons and preserve them during deferred snapshots", () => {
  const shields = new Map();
  const nodes = new Map(["notes", "papers"].map(type => [type, {
    querySelector: () => shields.get(type),
    appendChild: child => shields.set(type, child),
  }]));
  const context = vm.createContext({
    Map, Set, state: { tab: "other" }, ask() {}, esc: String, setTimeout: () => 1, clearTimeout() {},
    document: {
      querySelector: selector => nodes.get(selector.match(/data-tab="([^"]+)"/)?.[1]),
      querySelectorAll: () => [],
      createElement: () => ({ dataset: {}, setAttribute() {} }),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/webview/panel/46-github-sync.js"), "utf8"), context);
  vm.runInContext(`githubSyncOnState({
    shields:{notes:"green", papers:"yellow"},
    shieldReasons:{papers:["Share: 9 baseline-only files are outside the current privacy scope."]},
    targets:[]
  })`, context);
  assert.match(shields.get("papers").title, /Share: 9 baseline-only/);
  assert.doesNotMatch(shields.get("notes").title, /Share:/);
  vm.runInContext("githubSyncOnState({fingerprintsDeferred:true,targets:[]})", context);
  assert.equal(shields.get("papers").dataset.status, "yellow");
  assert.match(shields.get("papers").title, /Share: 9 baseline-only/);
});
