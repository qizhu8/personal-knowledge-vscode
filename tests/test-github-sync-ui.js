#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", "46-github-sync.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", "00-core.js"), "utf8");
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const requests = [];
const context = vm.createContext({
  ask: (command, payload) => requests.push({ command, payload }),
  esc: value => String(value),
  uiIcon: (_name, label) => label,
  Map,
  Set,
  pendingActionButtons: new Map(),
});
vm.runInContext(source, context);
vm.runInContext("githubSyncForce('primary', {})", context);
vm.runInContext("githubSyncForce('primary', {})", context);
assert.strictEqual(requests.length, 1, "rapid Force Sync clicks must synchronously post at most one request before host state returns");
assert.strictEqual(requests[0].command, "githubSyncRun");
assert.strictEqual(requests[0].payload.targetId, "primary");

assert.match(source, /Sync interval \(minutes\)[\s\S]*min="1" max="1440" step="1" required/,
  "the per-target interval is visible and constrained");
assert.match(source, /Number\.isInteger\(intervalMinutes\)[\s\S]*intervalMinutes < 1[\s\S]*intervalMinutes > 1440/,
  "Save validates interval bounds before posting the target");
assert.match(source, /initialSyncCompleted[\s\S]*Run Initial Sync successfully[\s\S]*disabled/,
  "automatic synchronization cannot be enabled before a successful initial manual sync");
assert.match(source, /github-sync-auto-toggle[\s\S]*role="switch"[\s\S]*githubSyncAutomationToggle/,
  "each Target card exposes a direct Auto Sync switch");
assert.match(source, /'fetch':'Fetch \/ Pull'[\s\S]*'resolve-conflicts':'Resolve conflicts'[\s\S]*'commit':'Commit'[\s\S]*'push':'Push'/,
  "target cards expose Git-native runtime phases instead of an opaque syncing state");
assert.doesNotMatch(source, /'merge':'Merge'|'up-to-date':'Up to date'/,
  "target cards do not expose internal reconciliation or a terminal state instead of Scheduled");
assert.match(extensionSource, /report\(targetId, "authenticating"[\s\S]*syncGitHubTarget\([\s\S]*report\(targetId, phase, detail\)[\s\S]*report\(targetId, "refresh-index"[\s\S]*report\(targetId, "scheduled"/,
  "the extension reports Git phases from the execution path through index refresh");
assert.match(extensionSource, /report\(targetId, "refresh-index"[\s\S]*await refreshKnowledgeInventory\(context\)[\s\S]*await refreshRetrievalIndex\(context\)[\s\S]*report\(targetId, "scheduled"/,
  "Scheduled is reached only after materialization, inventory refresh, and retrieval refresh complete");
assert.match(extensionSource, /case "githubSyncAutomationToggle"[\s\S]*initialSyncCompleted[\s\S]*target\.automation\.enabled = enabled/,
  "the host owns the Auto Sync readiness gate and persists explicit user toggles");
assert.match(extensionSource, /manualVerificationCompleted[\s\S]*Fetch\/Pull, conflict resolution, Commit, Push, inventory refresh, and retrieval refresh/,
  "Auto Sync remains gated until the post-cutover manual publication cycle is verified");
assert.match(extensionSource, /case "githubSyncMigration"[\s\S]*preview[\s\S]*stage[\s\S]*verify[\s\S]*cutover[\s\S]*rollback/,
  "the host exposes the complete persisted publication migration transaction");
assert.match(source, /Start read-only check[\s\S]*Stage migration[\s\S]*Verify staged data[\s\S]*Cut over[\s\S]*Rollback/,
  "the target card exposes the ordered migration workflow and rollback");
assert.match(coreSource, /githubSyncMigration:180000/,
  "migration actions must stay visibly pending and surface backend errors instead of appearing inert");
for (const label of ["Staging…", "Verifying…", "Cutting over…", "Rolling back…"]) {
  assert(source.includes(`data-pending-label="${label}"`), `${label} must provide migration progress feedback`);
}
assert.match(source, /One-time GitHub publication upgrade[\s\S]*Required once for targets created before PKM 3\.2\.1[\s\S]*does not change local files or GitHub/,
  "the target card explains the migration purpose, scope, and read-only preview");
assert.match(source, /migrationCompleted \? ''/,
  "the one-time migration panel disappears after a successful post-cutover sync");
assert.match(source, /inventory\/retrieval refresh[\s\S]*Auto Sync remains off/,
  "the cutover UI explains the required manual verification and automation gate");
const deleteHandler = extensionSource.match(/case "githubSyncDelete":[\s\S]*?case "githubSyncAutomationToggle":/)?.[0] || "";
assert.doesNotMatch(deleteHandler, /await withGitHubSyncTargetLock/,
  "deleting a target never waits for an in-flight Git operation or a Windows checkout handle");
assert.match(deleteHandler, /mutateGitHubSyncTargets[\s\S]*configureGitHubSyncScheduler[\s\S]*cleanupDeletedGitHubSyncTarget/,
  "target configuration is removed immediately before checkout cleanup continues in the background");
assert.match(source, /Stops future pull\/push operations[\s\S]*already-started push may still finish/,
  "the delete confirmation explains immediate logical removal and the in-flight Git boundary");
assert.match(source, /Manual review · explicit choice for every file/,
  "each target defaults to explicit per-file conflict resolution");
assert.match(source, /Agent-assisted Skill\/Recipe merge · review before push/,
  "Agent resolution clearly covers both Skills and Recipes without bypassing review");
assert.match(source, /Use this machine[\s\S]*Use GitHub[\s\S]*Merge manually[\s\S]*Validate merge[\s\S]*Merge with Agent/,
  "each conflict exposes understandable local, remote, manual, and Agent resolution paths");
assert.match(source, /All Use GitHub[\s\S]*All Use This Machine[\s\S]*Ask Agent for/,
  "large conflict sets expose host-backed bulk resolution actions");
assert.match(source, /Delete GitHub[\s\S]*githubSyncConflictDeleteAll/,
  "missing-local conflict sets expose an explicit destructive GitHub deletion choice");
assert.match(source, /missing on this machine[\s\S]*missing on GitHub[\s\S]*deletion safeguard/,
  "conflict summaries distinguish missing-file safeguards from content merges");
assert.match(extensionSource, /case "githubSyncConflictChooseAll"[\s\S]*selectAllGitHubSyncConflictCandidates/,
  "bulk source selection is validated and applied by the extension host");
assert.match(extensionSource, /case "githubSyncConflictAgentAll"[\s\S]*withProgress[\s\S]*unsupported[\s\S]*failed/,
  "bulk Agent merge reports progress and preserves unsupported or failed conflicts");
assert.match(source, /Apply resolutions &amp; Sync[\s\S]*Cancel resolution workspace/,
  "conflict approval and staged-workspace cancellation describe their actual effects");
assert.match(extensionSource, /file\.type !== "skills" && file\.type !== "recipes"/,
  "Agent-assisted conflict resolution supports both Skill Markdown and Recipe JSON");
assert.match(extensionSource, /file\.type === "recipes"[\s\S]*githubSyncRecipeContent\(recipe\)/,
  "Recipe conflict safety compares against canonical Project Store content instead of a synthetic filesystem path");
assert.match(extensionSource, /replaceRecipesFromSync[\s\S]*recipeCandidates/,
  "accepted Recipe candidates are persisted through the Project Store");
assert.match(extensionSource, /applyGitHubSyncRecipePulls\(result\.recipePulls\)/,
  "ordinary GitHub pulls persist Recipe content through the Project Store");
assert.match(extensionSource, /scheduleRetrievalRefresh\(context, 0\)/,
  "pulled file content explicitly refreshes retrieval instead of relying only on filesystem watcher timing");
assert.doesNotMatch(extensionSource, /Agent-assisted merge currently supports Skills only/,
  "the obsolete Skill-only Agent failure is removed");
assert.match(extensionSource, /msg\.mode === "edit"[\s\S]*vscode\.open[\s\S]*Validate edited copy/,
  "manual conflict resolution opens an editable candidate with an explicit validation step");

const recoveredCard = vm.runInContext(`(() => {
  githubSyncData = {
    targets:[{
      id:'primary',
      name:'Primary Backup',
      repository:'https://github.com/example/backup.git',
      branch:'main',
      automation:{enabled:true,intervalMinutes:5,initialSyncCompleted:true},
      lastSync:{at:'2026-09-24T20:00:00.000Z'},
      lastFailure:{at:'2026-09-24T19:59:00.000Z',error:'stale failure'}
    }],
    runtime:{primary:{status:'scheduled'}},
    conflicts:{}
  };
  return githubSyncCards();
})()`, context);
assert.match(recoveredCard, /github-sync-status scheduled/);
assert.doesNotMatch(recoveredCard, /stale failure/, "scheduled targets must not render stale persisted failures");
assert.match(recoveredCard, /githubSyncForce\('primary',this\)" disabled/, "Auto Sync disables manual Sync with Remote");
assert.match(recoveredCard, /githubSyncForceUpdate\('primary',this\)" disabled/, "Auto Sync disables Force Update");
assert.match(recoveredCard, /githubSyncRestore\('primary',this\)" disabled/, "Auto Sync disables snapshot restore");
const enabledAutoToggle = recoveredCard.match(/<button class="github-sync-auto-toggle[\s\S]*?<\/button>/)?.[0] || "";
assert.doesNotMatch(enabledAutoToggle, /disabled/, "an enabled Auto Sync switch remains available so the user can turn Auto off");
assert.match(extensionSource, /function requireGitHubSyncManualMode[\s\S]*Turn off Auto Sync/,
  "the Extension Host owns the Auto/manual exclusivity boundary");
for (const handler of ["githubSyncRun", "githubSyncForceUpdate", "githubSyncRestore"]) {
  const block = extensionSource.match(new RegExp(`case "${handler}":[\\s\\S]*?break;`))?.[0] || "";
  assert.match(block, /requireGitHubSyncManualMode/, `${handler} rejects direct Host requests while Auto Sync is enabled`);
}

const failingCard = vm.runInContext(`(() => {
  githubSyncData.runtime.primary = {status:'error',lastError:'current failure'};
  return githubSyncCards();
})()`, context);
assert.match(failingCard, /github-sync-status error/);
assert.match(failingCard, /github-sync-error[^>]*>current failure</, "error targets show their current failure");

const conflictCard = vm.runInContext(`(() => {
  githubSyncData = {
    targets:[{
      id:'shared',
      name:'Shared Knowledge',
      repository:'https://github.com/example/knowledge.git',
      branch:'main',
      automation:{enabled:false,intervalMinutes:5,syncOnChange:true,initialSyncCompleted:false}
    }],
    runtime:{shared:{status:'paused'}},
    conflicts:{shared:{files:[
      {path:'recipes/Examples/Shared.recipe_123.json',type:'recipes',hasBase:true,hasLocal:true,hasRemote:true,candidateSource:'unresolved'},
      {path:'skills/System/PKM/PKM Skills.md',type:'skills',hasBase:true,hasLocal:true,hasRemote:true,candidateSource:'agent',rationale:'Merged both changes.'}
    ]}}
  };
  return githubSyncCards();
})()`, context);
assert.match(conflictCard, /github-sync-status conflicts">Resolve conflicts</, "conflicts replace generic Syncing with a Git-native resolve state");
assert.match(conflictCard, /Pull completed · resolve conflicts before commit and push/, "the target explains which Git phases are blocked");
assert.match(source, /Resolution flow[\s\S]*Rules resolved[\s\S]*Agent prepared[\s\S]*Human Final Review/,
  "complex reconciliation renders an algorithm-performance and review-flow diagram");
assert.doesNotMatch(source, /github-sync-resolution-bar/,
  "the persistent resolution flow omits the percentage bar and rule legend");
assert.match(extensionSource, /target\.lastResolutionReport = existing\?\.lastResolutionReport/,
  "saving an unchanged target preserves its persistent resolution report");
assert.match(source, /authoritative-migration':'Migration authority'[\s\S]*deterministic-three-way':'Three-way merge'/,
  "the resolution diagram names the deterministic rules that resolved files");
assert.match(source, /Force Update GitHub from this machine\?[\s\S]*one more native confirmation/,
  "Force Update is available only through a local danger button with a first explicit confirmation");
assert.match(extensionSource, /showInputBox\(\{[\s\S]*Explain why this destructive local-authority update is required[\s\S]*A reason is required/,
  "Force Update requires a non-empty user comment before the final native confirmation");
assert.match(extensionSource, /Actor: \$\{actor\}[\s\S]*Reason: \$\{comment\.trim\(\)\}[\s\S]*Force Update GitHub/,
  "the final native confirmation identifies the actor and audit comment");
assert.match(source, /Recheck with Remote/, "a manual sync can re-evaluate conflicts after schema migration or remote changes");
assert.match(source, /Sync with Remote/, "the primary action names the pull-merge-push workflow");
assert.match(source, /Restore snapshot…/, "historical file selection is clearly distinguished from normal synchronization");
assert.match(source, /differences found[\s\S]*Remote was fetched read-only/,
  "initial setup presents a read-only comparison before applying changes");
assert.match(source, /githubSyncDifferenceTree[\s\S]*All Use GitHub[\s\S]*All Use This Machine/,
  "initial differences are organized as a file tree with bulk remote and local choices");
assert.match(source, /Merge manually/, "modified files expose an explicit merge choice");
assert.match(extensionSource, /previewGitHubSyncTarget[\s\S]*initial-preview/,
  "saving an initial target fetches a comparison instead of immediately scheduling synchronization");
assert.match(conflictCard, /Choice required/, "unresolved files visibly require a decision");
assert.match(conflictCard, /Agent merge/, "resolved files show which candidate will be applied");
assert.match(conflictCard, /2 changed on both sides/, "the conflict workspace summarizes conflict shape");
assert.match(conflictCard, /All Use GitHub/, "the conflict workspace offers one-click GitHub staging for unresolved files");
assert.match(conflictCard, /Ask Agent for 2 supported/, "the conflict workspace counts Agent-compatible conflicts");
assert.match(conflictCard, /Apply resolutions &amp; Sync<\/button>/);
assert.match(conflictCard, /onclick="githubSyncConflictAccept\('shared',this\)" disabled/,
  "Apply remains disabled until every file has an explicit resolution");

const missingLocalCard = vm.runInContext(`(() => {
  githubSyncData.conflicts.shared = {files:[
    {path:'papers/Idea.md',type:'papers',hasBase:true,hasLocal:false,hasRemote:true,candidateSource:'unresolved'}
  ]};
  return githubSyncCards();
})()`, context);
assert.match(missingLocalCard, /All Use GitHub/, "a missing-local conflict offers the available restore candidate");
assert.doesNotMatch(missingLocalCard, /All Use This Machine/, "a missing-local conflict must not offer a no-op machine candidate");
assert.match(missingLocalCard, /Delete GitHub/, "a missing-local conflict offers an explicit remote deletion choice");
assert.match(missingLocalCard, /confirms the local deletion[\s\S]*Apply resolutions &amp; Sync/,
  "deletion safeguards explain that remote deletion is staged before approval");
assert.match(extensionSource, /candidateSource === "delete"[\s\S]*pendingDeletions/,
  "accepted deletion candidates become explicit GitHub Sync tombstones");
assert.match(extensionSource, /function refreshStaleGitHubSyncConflicts[\s\S]*refreshGitHubSyncConflictLocalCandidate/,
  "opening GitHub Sync refreshes stale machine-local conflict candidates");
assert.match(extensionSource, /async function githubSyncStateData[\s\S]*refreshStaleGitHubSyncConflicts\(context\)[\s\S]*listGitHubSyncConflicts/,
  "stale conflict snapshots are refreshed before the resolution workspace is serialized");
assert.match(extensionSource, /function clearEquivalentGitHubSyncConflict[\s\S]*current\.equals\(remote\)[\s\S]*clearGitHubSyncConflict/,
  "identity-only conflicts are retired only when every machine-local file exactly matches its remote candidate");
assert.match(extensionSource, /shouldExecute:[\s\S]*clearEquivalentGitHubSyncConflict\(context, targetId\)[\s\S]*conflict-awaiting-approval/,
  "the scheduler clears proven identity-only conflicts before applying the ordinary conflict gate");

console.log("github-sync UI tests passed");
