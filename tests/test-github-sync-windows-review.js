#!/usr/bin/env node
// Run only after the coordinated build. All files are disposable synthetic fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const sync = require("../dist/sync/github-sync");
const conflicts = require("../dist/sync/github-sync-conflicts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-windows-review-"));
const uiTimers = new Set();
let assertions = 0;
const check = action => { action(); assertions++; };
const lf = Buffer.from("first\nsecond\n");
const crlf = Buffer.from("first\r\nsecond\r\n");
const planned = Buffer.from("first\nremote update\n");
const member = (name, overrides = {}) => ({
  path: `scripts/Review/${name}.script`, type: "scripts", itemId: name,
  category: "Review", privacy: "public", member: "", ...overrides,
});
try {
  check(() => assert(sync.githubSyncComparisonContent("scripts", crlf, "scripts/Test.script").equals(lf)));
  check(() => assert(sync.githubSyncLocalSnapshotMatches(crlf, planned, crlf)));
  check(() => assert(sync.githubSyncLocalSnapshotMatches(crlf, planned, planned)));
  check(() => assert(!sync.githubSyncLocalSnapshotMatches(crlf, planned, lf),
    "a newline-only change after capture remains a real raw-source change"));
  check(() => assert(!sync.githubSyncLocalSnapshotMatches(crlf, planned, Buffer.from("edited\r\n"))));
  check(() => assert(!sync.githubSyncLocalSnapshotMatches(undefined, planned, crlf)));
  check(() => assert(sync.githubSyncLocalSnapshotMatches(undefined, planned, undefined)));
  check(() => assert(sync.githubSyncLocalSnapshotMatches(crlf, undefined, undefined),
    "a previously completed deletion is idempotent"));
  for (const bytes of [
    Buffer.from([0xff, 13, 10]), Buffer.from("NUL\0\r\n"),
    Buffer.from([137, 80, 78, 71, 0, 13, 10]),
  ]) check(() => assert(sync.githubSyncComparisonContent("scripts", bytes, "scripts/Test.script").equals(bytes)));
  check(() => assert(sync.githubSyncComparisonContent("scripts", Buffer.from("\uFEFFfirst\r\n"), "scripts/Test.script")
    .equals(Buffer.from("\uFEFFfirst\n"))));

  const rawConflict = member("Raw", { base: lf, local: crlf, remote: planned });
  const raw = conflicts.storeGitHubSyncConflict(root, "raw", new sync.GitHubSyncConflictError("a".repeat(40), [rawConflict]));
  check(() => assert.equal(raw.files[0].candidateSource, "remote", "logical Base/Local comparison ignores CRLF"));
  const original = fs.readFileSync(conflicts.gitHubSyncConflictVariantPath(root, "raw", "local", rawConflict.path));
  check(() => assert(original.equals(crlf), "the guard variant remains raw CRLF"));
  check(() => assert.doesNotThrow(() => conflicts.validateGitHubSyncConflictLocalState(rawConflict.path, original, planned, crlf)));
  check(() => assert.throws(() => conflicts.validateGitHubSyncConflictLocalState(rawConflict.path, original, planned, lf), /changed/));
  fs.writeFileSync(conflicts.gitHubSyncConflictVariantPath(root, "raw", "merged", rawConflict.path), "tampered\n");
  check(() => assert.throws(() => conflicts.readGitHubSyncConflictCandidate(root, "raw", rawConflict.path, true), /changed after validation/));

  const members = [];
  for (let index = 0; index < 122; index++) {
    const id = `Missing-${index}`;
    members.push(member(id, { reason: "unrecorded-local-absence", base: lf, remote: planned, entityDeletion: true }));
    members.push(member(id, {
      path: `scripts/Review/${id}.metadata.json`, member: "metadata",
      reason: "unrecorded-local-absence", remote: Buffer.from('{"id":"synthetic"}\n'), entityDeletion: true,
    }));
  }
  for (let index = 0; index < 101; index++) members.push(member(`Pending-${index}`, {
    type: "notes", path: `notes/Review/Pending-${index}.md`,
    reason: index === 0 ? "concurrent-local-change" : "pending-apply",
    base: index < 7 ? lf : undefined, local: index < 7 ? crlf : undefined,
    remote: index < 7 ? undefined : planned,
    expectedLocal: index < 7 ? crlf : undefined,
    plannedContent: index < 7 ? undefined : planned,
    plannedOperation: index < 7 ? "delete" : "write", baseCommit: "b".repeat(40),
  }));
  const report = { totalFiles: 1633, assessedEntities: 904, localFiles: 1398, remoteFiles: 1505,
    rules: { "human-required": 244, unchanged: 1045, "remote-only": 97, "local-only": 243, "deterministic-three-way": 4 },
    pendingApplyMembers: 101, concurrentChangeBlockers: 1, generatedAt: new Date().toISOString() };
  const stored = conflicts.storeGitHubSyncConflict(root, "batch", new sync.GitHubSyncConflictError("c".repeat(40), members, [], [], {}, [], [], report));
  check(() => assert.equal(sync.normalizeGitHubSyncTarget({
    name: "Synthetic Windows review", repository: path.join(root, "synthetic.git"), lastResolutionReport: report,
  }).lastResolutionReport.pendingApplyMembers, 101, "target persistence retains plan/report dimensions"));
  check(() => assert.equal(stored.files.length, 345));
  check(() => assert.equal(stored.resolutionReport.totalFiles, 1633, "promotion does not double-count paths"));
  check(() => assert.equal(stored.resolutionReport.rules["human-required"], 244));
  check(() => assert.equal(stored.files.filter(file => file.candidateSource === "unresolved").length, 123,
    "122 entity intents and only the actual stale member need a new choice"));
  check(() => assert.equal(stored.files.filter(file => file.candidateSource === "plan").length, 94));
  check(() => assert.equal(stored.files.filter(file => file.candidateSource === "delete-local").length, 6));
  const pending = stored.files.find(file => file.itemId === "Pending-7");
  check(() => assert.equal(pending.hasBase, false, "expectedLocal is never invented as Common Base"));
  check(() => assert.equal(pending.plannedOperation, "write"));
  check(() => assert.equal(pending.rationale.includes("common base"), false));
  check(() => assert(fs.readFileSync(conflicts.gitHubSyncConflictVariantPath(root, "batch", "planned", pending.path)).equals(planned)));
  conflicts.selectGitHubSyncConflictCandidate(root, "batch", members[0].path, "remote");
  check(() => assert(conflicts.readGitHubSyncConflict(root, "batch").files.filter(file => file.itemId === "Missing-0")
    .every(file => file.candidateSource === "remote"), "restore covers body and sidecar"));
  conflicts.selectGitHubSyncConflictDeletion(root, "batch", members[2].path);
  check(() => assert(conflicts.readGitHubSyncConflict(root, "batch").files.filter(file => file.itemId === "Missing-1")
    .every(file => file.candidateSource === "delete"), "explicit deletion covers every entity member"));
  // A new Remote commit is never treated as the same approval provenance.
  conflicts.storeGitHubSyncConflict(root, "batch", new sync.GitHubSyncConflictError("d".repeat(40), members, [], [], {}, [], [], report));
  check(() => assert.equal(conflicts.readGitHubSyncConflict(root, "batch").files[0].candidateSource, "unresolved"));

  const ui = vm.createContext({ Map, Set, esc: String, uiIcon: (_name, label) => label,
    document: { querySelectorAll: () => [] }, state: {},
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); uiTimers.add(timer); return timer; },
    clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/webview/panel/46-github-sync.js"), "utf8"), ui);
  // Historical report fixture: counts must describe its actual stored candidates,
  // not fabricate "both changed" from Remote-only members.
  const historical = JSON.parse(JSON.stringify(stored));
  historical.files.forEach((file, index) => {
    file.candidateSource = index < 244 ? index % 2 ? "remote" : "unresolved" : index < 251 ? "unresolved" : index < 323 ? "remote" : "local";
  });
  ui.fixture = historical;
  const html = vm.runInContext("githubSyncConflictPanel('batch', fixture)", ui);
  check(() => assert.match(html, /345 workspace members · 129 choice required · 216 candidates awaiting approval/));
  check(() => assert.match(html, /122 missing entities requiring intent review/));
  check(() => assert.match(html, /101 pending apply/));
  check(() => assert.doesNotMatch(html, /changed on both sides|1734/));
  check(() => assert.match(html, /Restore GitHub entity/));
  check(() => assert.match(html, /Confirm entity deletion/));
  ui.legacyReport = { totalFiles: 1734, generatedAt: report.generatedAt, rules: report.rules };
  check(() => assert.match(vm.runInContext("githubSyncResolutionDiagram(legacyReport)", ui), /legacy rule assignments \(not unique paths\)/));
  historical.appliedAt = new Date().toISOString();
  const appliedHtml = vm.runInContext("githubSyncConflictPanel('batch', fixture)", ui);
  check(() => assert.match(appliedHtml, /not confirmation of a successful push/));

  const destination = path.join(root, "guarded.txt");
  fs.writeFileSync(destination, crlf);
  check(() => assert.doesNotThrow(() => sync.replaceGitHubSyncFilesAtomically([
    { destination, content: planned, guard: { original: crlf } },
  ])));
  fs.writeFileSync(destination, "new edit\n");
  check(() => assert.throws(() => sync.replaceGitHubSyncFilesAtomically([
    { destination, content: planned, guard: { original: crlf } },
  ]), /mutation boundary/));
  check(() => assert.equal(fs.readFileSync(destination, "utf8"), "new edit\n"));
  const originalFsync = fs.fsyncSync, originalRemove = fs.rmSync;
  fs.fsyncSync = () => { throw new Error("primary fsync failure"); };
  fs.rmSync = (file, options) => {
    if (String(file).endsWith(".tmp")) throw new Error("secondary cleanup failure");
    return originalRemove(file, options);
  };
  try {
    check(() => assert.throws(() => conflicts.markGitHubSyncConflictApplying(root, "raw"),
      /primary fsync failure.*Temporary cleanup also failed: secondary cleanup failure/,
      "secondary cleanup does not erase the primary durability failure"));
  } finally { fs.fsyncSync = originalFsync; fs.rmSync = originalRemove; }
  check(() => assert.equal(conflicts.readGitHubSyncConflict(root, "raw").applyState, undefined,
    "failed fsync does not publish an applying marker"));
  console.log(`github-sync Windows review: ${assertions} assertions passed`);
} finally {
  for (const timer of uiTimers) clearTimeout(timer);
  fs.rmSync(root, { recursive: true, force: true });
}
