#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sync = require("../dist/sync/github-sync");
const repair = require("../dist/sync/github-sync-content-repair");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-content-repair-"));
const emptyBlock = "<<<<<<< Updated upstream\r\n\r\n=======\r\n>>>>>>> Stashed changes\r\n";
const original = `#CS\r\nvoid Run() {}\r\n${emptyBlock}#ENDCS\r\n`;
const candidate = "#CS\r\nvoid Run() {}\r\n#ENDCS\r\n";

(async () => {
  assert.equal(repair.inspectConflictMarkers(original).candidate, candidate);
  assert.deepEqual(repair.inspectConflictMarkers(original).lines, [3, 5, 6]);
  for (const content of [
    "<<<<<<< local\ncode();\n=======\nother();\n>>>>>>> remote\n",
    "<<<<<<< local\n=======\n",
    "<<<<<<< outer\n<<<<<<< inner\n=======\n>>>>>>> inner\n=======\n>>>>>>> outer\n",
    "=======\n", ">>>>>>> orphan\n",
    "<<<<<<< local\n||||||| base\n=======\n>>>>>>> remote\n",
  ]) assert.equal(repair.inspectConflictMarkers(content).candidate, undefined, content);
  assert.equal(repair.inspectConflictMarkers("ordinary code\n").lines.length, 0);
  assert.equal(repair.inspectConflictMarkers("Heading\n=======\n").lines.length, 0,
    "a Markdown heading underline alone is not evidence of merge markers");
  const catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  execFileSync("git", ["init", root], { stdio: "ignore" });
  fs.writeFileSync(path.join(root, ".gitignore"), "scripts/Ignored.script\n");
  fs.mkdirSync(path.join(root, "scripts"));
  for (const [name, text] of [["Empty", original], ["Nonempty", "<<<<<<< local\nx\n=======\ny\n>>>>>>> remote\n"], ["Ignored", original]]) {
    const source = path.join(root, "scripts", `${name}.script`);
    fs.writeFileSync(source, text);
    catalog.scripts.push({ id: name, cat: "", label: name, source, destination: `scripts/${name}.script` });
  }
  const target = sync.normalizeGitHubSyncTarget({ id: "primary", name: "Primary", repository: path.join(root, "nonexistent-remote.git") });
  const checkouts = path.join(root, "checkouts");
  let failure;
  try { await sync.syncGitHubTarget(target, catalog, checkouts, undefined, root); }
  catch (error) { failure = error; }
  assert(failure instanceof repair.GitHubSyncContentRepairError);
  assert.equal(failure.issues.length, 2, "all selected local marker issues are reported together");
  assert(!failure.issues.some(issue => issue.itemId === "Ignored"), "Git-ignored markers do not block an unrelated target");
  assert(!fs.existsSync(checkouts), "no checkout, remote fetch or push precedes local content repair");
  assert(!("remoteCommit" in failure), "unknown remote state must not be invented");
  const record = repair.storeGitHubSyncContentRepair(path.join(root, "state"), failure);
  assert.deepEqual(repair.readGitHubSyncContentRepair(path.join(root, "state"), target.id), record);
  const issue = failure.issues.find(issue => issue.itemId === "Empty");
  assert.equal(fs.readFileSync(issue.sourcePath, "utf8"), original, "candidate creation must not modify the source");
  repair.applyGitHubSyncEmptyMarkerCandidate(root, issue);
  assert.equal(fs.readFileSync(issue.sourcePath, "utf8"), candidate, "CRLF and all other bytes survive approved cleanup");
  fs.writeFileSync(issue.sourcePath, original + "user edited\n");
  assert.throws(() => repair.applyGitHubSyncEmptyMarkerCandidate(root, issue), /source changed/i);
  assert.equal(fs.readFileSync(issue.sourcePath, "utf8"), original + "user edited\n");
  assert.throws(() => repair.applyGitHubSyncEmptyMarkerCandidate(root, failure.issues.find(issue => issue.itemId === "Nonempty")), /No safe/);
  assert.throws(() => repair.storeGitHubSyncContentRepair(root, new repair.GitHubSyncContentRepairError("../unsafe", [])), /Invalid/);
  fs.writeFileSync(issue.sourcePath, candidate);
  await assert.rejects(() => sync.syncGitHubTarget(target, catalog, checkouts, undefined, root),
    error => error instanceof repair.GitHubSyncContentRepairError && error.issues.length === 1
      && error.issues[0].itemId === "Nonempty", "revalidation reads new bytes and updates the remaining marker list");
  fs.writeFileSync(path.join(root, "scripts/Nonempty.script"), "resolved by user\n");
  execFileSync("git", ["init", "--bare", target.repository], { stdio: "ignore" });
  const synced = await sync.syncGitHubTarget(target, catalog, checkouts, undefined, root);
  assert(synced.changed, "a repaired untracked source resumes ordinary reconciliation and push");
  const remote = execFileSync("git", ["--git-dir", target.repository, "show", "main:scripts/Empty.script"], { encoding: "utf8" });
  assert.equal(remote, candidate.replace(/\r\n/g, "\n"));
  repair.clearGitHubSyncContentRepair(path.join(root, "state"), target.id);
  assert.equal(repair.readGitHubSyncContentRepair(path.join(root, "state"), target.id), undefined);
  console.log("GitHub Sync content repair tests passed");
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error); process.exitCode = 1;
});
