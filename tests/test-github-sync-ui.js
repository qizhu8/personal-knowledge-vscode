#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", "46-github-sync.js"), "utf8");
const coreSource = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", "00-core.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel.css"), "utf8");
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const requests = [];
const context = vm.createContext({
  ask: (command, payload) => requests.push({ command, payload }),
  esc: value => String(value),
  uiIcon: (_name, label) => label,
  Map,
  Set,
  document: { querySelector: () => null, querySelectorAll: () => [] },
  state: { tab: 'other' },
  vscode: { postMessage: () => {} },
  pendingActionButtons: new Map(),
});
vm.runInContext(source, context);
context.failedTarget = { lastFailure: { at: '2026-07-19T10:00:00Z', error: 'snapshot failed' }, lastSync: { at: '2026-07-18T10:00:00Z' }, automation: { enabled: true, initialSyncCompleted: true } };
assert.strictEqual(vm.runInContext("githubSyncEffectiveStatus(failedTarget, {status:'scheduled'}, null, false)", context), 'error', 'a scheduled timer must not hide a newer persisted synchronization failure');
assert.strictEqual(vm.runInContext("githubSyncEffectiveStatus(failedTarget, {status:'syncing'}, null, false)", context), 'syncing');
assert.strictEqual(vm.runInContext("githubSyncEffectiveError(failedTarget, {status:'scheduled',lastError:'stale earlier error'})", context), 'snapshot failed', 'a newer persisted failure must not display a stale scheduler error');
assert.strictEqual(vm.runInContext("githubSyncEffectiveError(failedTarget, {status:'error',lastError:'current attempt failed'})", context), 'current attempt failed');
context.failedTarget.lastSync.at = '2026-07-20T10:00:00Z';
assert.strictEqual(vm.runInContext("githubSyncEffectiveStatus(failedTarget, {status:'scheduled'}, null, false)", context), 'scheduled', 'a later successful sync clears the effective failure status');
assert.match(vm.runInContext("githubSyncStatusTitle('yellow')", context), /Names alone.*pending or unverified.*Refresh is read-only/);
vm.runInContext("githubSyncForce('primary', {})", context);
vm.runInContext("githubSyncForce('primary', {})", context);
assert.strictEqual(requests.length, 1, "rapid Force Sync clicks must synchronously post at most one request before host state returns");
assert.strictEqual(requests[0].command, "githubSyncRun");
assert.strictEqual(requests[0].payload.targetId, "primary");
vm.runInContext('githubSyncForcePending.clear()', context);
const phaseNode = { outerHTML: '' };
const detailNode = { textContent: '' };
context.syncButton = { closest: () => ({ querySelector: selector => selector === '.github-sync-phase' ? phaseNode : selector === '.sub-broker-meta > small:last-of-type' ? detailNode : null }) };
vm.runInContext("githubSyncForce('primary', syncButton)", context);
assert.match(phaseNode.outerHTML, /data-phase="waiting-for-lock"/, "click updates the target phase before any host reply");
assert.strictEqual(detailNode.textContent, 'Waiting for Git lock', "click updates the target detail before any host reply");
assert.strictEqual(requests.length, 2);
vm.runInContext('githubSyncForcePending.clear()', context);
vm.runInContext("tabCacheIsFresh = () => false; ensureGitHubSyncStatus(); ensureGitHubSyncStatus()", context);
assert.strictEqual(requests.filter(request => request.command === "githubSyncState").length, 1,
  "concurrent GitHub Sync status refreshes must post only one request");
assert.match(source, /function showGitHubSyncTab\(\) \{[\s\S]*?ensureGitHubSyncStatus\(\);/,
  "opening GitHub Sync uses the same deduplicated status request");
assert.match(source, /function showGitHubSyncTab\(\) \{[\s\S]*?ask\('githubSyncRuntimeSnapshot', \{\}, null, true\)/,
  "reopening GitHub Sync gets the current runtime even while the content cache is fresh");
assert.match(extensionSource, /case "githubSyncRuntimeSnapshot":[\s\S]*?githubSyncScheduler\?\.snapshot\(\)/,
  "the runtime refresh avoids catalog and fingerprint scans");
assert.match(coreSource, /action === 'githubSyncState'\) githubSyncOnRefreshError\(message\)/,
  "a failed background status request must release the refresh guard for the next retry");
assert.match(source, /function githubSyncOnRefreshError\(message\) \{\s*githubSyncStatusRequested = false/);

assert.match(source, /Sync interval \(minutes\)[\s\S]*min="1" max="1440" step="1" required/,
  "the per-target interval is visible and constrained");
assert.match(source, /Number\.isInteger\(intervalMinutes\)[\s\S]*intervalMinutes < 1[\s\S]*intervalMinutes > 1440/,
  "Save validates interval bounds before posting the target");
assert.match(source, /initialSyncCompleted[\s\S]*Run Initial Sync successfully[\s\S]*disabled/,
  "automatic synchronization cannot be enabled before a successful initial manual sync");
assert.match(source, /github-sync-auto-toggle[\s\S]*role="switch"[\s\S]*githubSyncAutomationToggle/,
  "each Target card exposes a direct Auto Sync switch");
assert.match(styles, /\.github-sync-dashboard \.sub-broker-row\{grid-template-columns:minmax\(0,1fr\)/,
  "GitHub target details use the full card width rather than a compressed first grid column");
assert.match(styles, /\.github-sync-flow\{[^}]*overflow-x:auto/,
  "the phase diagram scrolls inside narrow target cards without splitting node labels");
assert.match(styles, /\.github-sync-phase-current\.error\{color:#f85149\}/,
  "a failed sync label is red");
assert.match(styles, /\.github-sync-error\{[^}]*color:#f85149!important/,
  "the error reason is visibly red");
assert.match(styles, /\.github-sync-folder-status\{[^}]*width:5px;height:5px[^}]*font-size:5px/,
  "tree Git status markers remain small and have stable dimensions");
assert.match(source, /\['fetch', 'Fetch \/ Pull'\][\s\S]*\['resolve-conflicts', 'Resolve conflicts'\][\s\S]*\['commit', 'Commit'\][\s\S]*\['push', 'Push'\]/,
  "the diagram follows Git-native runtime phases in order");
assert.doesNotMatch(source, /'merge':'Merge'|'up-to-date':'Up to date'/,
  "target cards do not expose internal reconciliation or a terminal state instead of Scheduled");
assert.match(extensionSource, /const report = \(phase:[\s\S]*githubSyncScheduler\?\.report\(targetId, phase, detail\)[\s\S]*report\(targetId, "authenticating"[\s\S]*syncGitHubTarget\([\s\S]*\n\s+report,[\s\S]*report\(targetId, "refresh-index"[\s\S]*report\(targetId, "scheduled"/,
  "the extension reports Git phases from the execution path through index refresh");
assert.match(extensionSource, /const credentials = await readGitHubSyncCredentials\(context, target\);\s*report\("fetch", [^\n]+\);\s*invalidateSharedContentCatalog\(\);\s*const catalog = await githubSyncCatalog\(\);/,
  "Authentication ends before catalog loading; each Sync attempt refreshes stale source paths even when a watcher missed a rename");
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
assert.match(source, /data-pending-label="Deleting…"[\s\S]*githubSyncDelete\('\$\{esc\(target\.id\)\}',this\)/,
  "the target delete button exposes immediate pending feedback");
assert.match(source, /function githubSyncDelete\(targetId, button\)[\s\S]*ask\('githubSyncDelete',\{targetId\},button\)/,
  "the confirmed delete request binds the original target button to the action lifecycle");
assert.match(coreSource, /githubSyncDelete:120000/,
  "slow target deletion remains visibly pending and reports timeout failures");
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
assert.match(extensionSource, /const comparisonVariant = selected\.hasRemote \? "remote" : selected\.hasBase \? "base" : "local";[\s\S]*const leftLabel = comparisonVariant === "remote" \? "GitHub"[\s\S]*const rightLabel = selected\.candidateSource === "unresolved" \? "Merge candidate \(unresolved\)"[\s\S]*`LEFT: \$\{leftLabel\} \| RIGHT: \$\{rightLabel\}/,
  "the compare title identifies the actual left source and right merge candidate");

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
assert.match(recoveredCard, /github-sync-flow-step current" data-phase="scheduled"/);
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
  githubSyncData.runtime.primary = {status:'error',phase:'fetch',lastError:'current failure'};
  return githubSyncCards();
})()`, context);
assert.match(failingCard, /github-sync-flow-step error" data-phase="fetch"/);
assert.match(failingCard, /github-sync-phase-current error" aria-hidden="true">Fetch \/ Pull failed</,
  "the current failure stays visible when its node is scrolled out of view");
assert.match(failingCard, /github-sync-error[^>]*>current failure</, "error targets show their current failure");
assert.match(failingCard, /github-sync-flow-step done" data-phase="authenticating"/,
  "a Fetch / Pull failure keeps the completed Authentication stage successful");
const retryButton = failingCard.match(/<button[^>]*githubSyncForce\('primary',this\)[\s\S]*?<\/button>/)?.[0] || '';
assert.match(retryButton, /Pause Auto &amp; Retry|Pause Auto & Retry/);
assert.doesNotMatch(retryButton, / disabled/, 'failed Auto targets expose an actionable ordinary retry');
assert.match(failingCard, /githubSyncForceUpdate\('primary',this\)" disabled/, 'failure recovery never enables destructive Force Update while Auto is on');
vm.runInContext("githubSyncForcePending.clear(); githubSyncForce('primary', {}); githubSyncForce('primary', {})", context);
assert.strictEqual(requests.filter(request => request.command === 'githubSyncRun' && request.payload.pauseAutomation === true).length, 1,
  'pause-and-retry is one explicit, duplicate-safe request rather than a race between toggle and sync');
vm.runInContext('githubSyncForcePending.clear(); githubSyncPendingAfter.clear()', context);
const retryHandler = extensionSource.match(/case "githubSyncRun":[\s\S]*?break;\s*}/)?.[0] || '';
assert.match(retryHandler, /migration\.phase[\s\S]*msg\.pauseAutomation === true[\s\S]*selected\.automation\.enabled = false[\s\S]*configureGitHubSyncScheduler[\s\S]*requireGitHubSyncManualMode[\s\S]*request\(targetId, "manual"\)/,
  'host validates migration before pausing only the selected target and queueing ordinary manual Sync');
assert.doesNotMatch(failingCard, /github-sync-flow-step error" data-phase="authenticating"|Authentication failed/,
  "a Fetch / Pull failure must never paint Authentication red");
const authenticationFailure = vm.runInContext("githubSyncPhaseDiagram('authenticating', 'error')", context);
assert.match(authenticationFailure, /github-sync-flow-step error" data-phase="authenticating"/,
  "a real credential failure still marks Authentication red");
assert.match(authenticationFailure, />Authentication failed</);
const manualFailureCard = vm.runInContext(`(() => {
  githubSyncData.targets[0].automation.enabled = false;
  githubSyncData.runtime.primary = {status:'error',lastError:'authentication expired'};
  return githubSyncCards();
})()`, context);
assert.match(manualFailureCard, /github-sync-phase-current error" aria-hidden="true">Sync failed</,
  "manual failures without a reported phase use a red, non-duplicated failure label");
assert.match(manualFailureCard, /github-sync-error[^>]*>authentication expired</,
  "manual failures display the actual error even with Auto Sync off");
const missingErrorCard = vm.runInContext(`(() => {
  githubSyncData.runtime.primary = {status:'error'};
  delete githubSyncData.targets[0].lastFailure;
  return githubSyncCards();
})()`, context);
assert.match(missingErrorCard, /github-sync-error[^>]*>No error details were recorded\. Open Sync Diagnostic Log for this attempt\.</,
  'a failed target without recorded details still displays an explicit diagnostic message');
const persistedFailureCard = vm.runInContext(`(() => {
  githubSyncData.runtime.primary = {status:'error'};
  githubSyncData.targets[0].lastFailure = {error:'Local content changed during synchronization: notes/Images/diagram.png'};
  return githubSyncCards();
})()`, context);
assert.match(persistedFailureCard, /<small>Local content changed during synchronization: notes\/Images\/diagram\.png<\/small>/,
  "a persisted failure gives the actual cause directly on the target card");
assert.match(persistedFailureCard, /githubSyncForce\('primary',this\)" >Sync with Remote<\/button>/,
  "a persisted manual failure exposes an enabled retry action instead of an unusable instruction");
const queuedCard = vm.runInContext(`(() => {
  githubSyncData.runtime.primary = {status:'error',phase:'resolve-conflicts',lastError:'old failure',lastAttemptAt:'2026-09-30T20:00:00Z',activityAt:'2026-09-30T20:00:00Z'};
  githubSyncForce('primary', {});
  githubSyncOnRunQueued({targetId:'primary',queued:true});
  return githubSyncCards();
})()`, context);
assert.match(queuedCard, /github-sync-flow-step current" data-phase="waiting-for-lock"/,
  "a queued manual retry immediately shows Git lock instead of the previous failure");
assert.doesNotMatch(queuedCard, /old failure|github-sync-error/, "the old error is hidden while a retry is pending");
vm.runInContext(`githubSyncOnState({runtime:{primary:{status:'error',phase:'resolve-conflicts',lastError:'old failure',lastAttemptAt:'2026-09-30T20:00:00Z',activityAt:'2026-09-30T20:00:00Z'}}})`, context);
assert.match(vm.runInContext('githubSyncCards()', context), /github-sync-flow-step current" data-phase="waiting-for-lock"/,
  "an old failure snapshot must not cancel the newly queued sync");
vm.runInContext(`githubSyncOnState({runtime:{primary:{status:'syncing',phase:'authenticating',lastAttemptAt:'2026-09-30T21:00:00Z',activityAt:'2026-09-30T21:00:01Z'}}})`, context);
assert.match(vm.runInContext('githubSyncCards()', context), /github-sync-flow-step current" data-phase="authenticating"/,
  "a new attempt moves from Git lock to Authentication");
vm.runInContext(`githubSyncOnRuntimeState({targetId:'primary',state:{status:'syncing',phase:'fetch',detail:'Validating Remote',lastAttemptAt:'2026-09-30T21:00:00Z',activityAt:'2026-09-30T21:00:02Z'}})`, context);
assert.match(vm.runInContext('githubSyncCards()', context), /github-sync-flow-step current" data-phase="fetch"/,
  "the authoritative runtime phase replaces the optimistic Git lock phase");
vm.runInContext(`githubSyncOnRuntimeState({targetId:'primary',state:{status:'syncing',phase:'waiting-for-lock',lastAttemptAt:'2026-09-30T21:00:00Z',activityAt:'2026-09-30T21:00:01Z'}})`, context);
assert.match(vm.runInContext('githubSyncCards()', context), /github-sync-flow-step current" data-phase="fetch"/,
  "an older runtime event cannot move Fetch back to Git lock");
vm.runInContext(`githubSyncOnState({runtime:{primary:{status:'error',phase:'resolve-conflicts',lastError:'old failure',lastAttemptAt:'2026-09-30T20:00:00Z',activityAt:'2026-09-30T20:00:00Z'}}})`, context);
assert.match(vm.runInContext('githubSyncCards()', context), /github-sync-flow-step current" data-phase="fetch"/,
  "a late stale snapshot cannot roll Fetch back to the previous failure");
vm.runInContext(`githubSyncForcePending.add('primary'); githubSyncPendingAfter.set('primary','2026-09-30T20:00:00Z'); githubSyncOnRuntimeState({targetId:'primary',state:{status:'error',phase:'fetch',lastError:'current failure',lastAttemptAt:'2026-09-30T21:00:00Z',activityAt:'2026-09-30T21:00:03Z'}})`, context);
assert.match(vm.runInContext('githubSyncCards()', context), /github-sync-phase-current error" aria-hidden="true">Fetch \/ Pull failed</,
  "a terminal runtime error replaces the optimistic Git lock even without a full state snapshot");
vm.runInContext(`githubSyncForcePending.add('primary'); githubSyncOnRunQueued({targetId:'primary',queued:false})`, context);
assert.doesNotMatch(vm.runInContext('githubSyncCards()', context), /github-sync-flow-step current" data-phase="waiting-for-lock"/,
  "a rejected queue request clears the optimistic Git lock phase");

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
assert.match(conflictCard, /github-sync-flow-step conflicts" data-phase="resolve-conflicts"/, "conflicts highlight the resolution node instead of a generic Syncing state");
assert.match(conflictCard, /Choose a candidate for each file, then Apply resolutions & Sync/, "the target gives a next step even when the conflict occurs after a push");
const skillConflictPanel = vm.runInContext(`githubSyncConflictPanel('shared', { files: [{
  path: 'skills/Shared/One.md', type: 'skills', hasBase: true, hasLocal: true, hasRemote: true,
  candidateSource: 'unresolved'
}] })`, context);
assert.match(skillConflictPanel, /Use this machine[\s\S]*Use GitHub[\s\S]*Merge manually[\s\S]*Merge with Agent/,
  "a divergent Skill offers Local, Remote, human merge, and Agent merge");
const imageConflictPanel = vm.runInContext(`githubSyncConflictPanel('shared', { files: [{
  path: 'notes/Images/diagram.png', type: 'notes', hasBase: true, hasLocal: true, hasRemote: true,
  candidateSource: 'unresolved'
}] })`, context);
assert.match(imageConflictPanel, /Use this machine[\s\S]*Use GitHub[\s\S]*Apply resolutions &amp; Sync/, "PNG conflicts provide a human resolution path");
assert.doesNotMatch(imageConflictPanel, /Merge with Agent|Ask Agent for/, "binary PNG conflicts do not offer an unsupported Agent merge");
const breakdown = vm.runInContext(`githubSyncResolutionDiagram({
  localFiles:12,remoteFiles:11,totalFiles:13,rules:{unchanged:8,'remote-only':2,'local-only':1,'human-required':2},generatedAt:'2026-09-30T20:00:00Z'
}, [{candidateSource:'unresolved'},{candidateSource:'agent'}])`, context);
assert.match(breakdown, /<b>12<\/b><small>On this machine<\/small>[\s\S]*<b>11<\/b><small>On GitHub<\/small>[\s\S]*<b>13<\/b><small>Assessed<\/small>[\s\S]*<b>8<\/b><small>Unchanged<\/small>[\s\S]*<b>3<\/b><small>Rules resolved<\/small>[\s\S]*<b>2<\/b><small>Conflicts<\/small>/,
  "resolution counts distinguish local, remote, unchanged, rule-resolved and true conflicts");
assert.match(breakdown, /1 still need a choice · 1 Agent prepared for review/);
assert.match(vm.runInContext('githubSyncResolutionDiagram(undefined)', context), /<b>—<\/b><small>On this machine<\/small>/,
  "reports from before the count upgrade do not invent local or remote totals");
assert.doesNotMatch(source, /github-sync-resolution-bar/,
  "the persistent resolution flow omits the percentage bar and rule legend");
assert.match(extensionSource, /target\.lastResolutionReport = existing\?\.lastResolutionReport/,
  "saving an unchanged target preserves its persistent resolution report");
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
assert.doesNotMatch(conflictCard, /Agent merge|skills\/System\/PKM\/PKM Skills\.md/,
  "selected files disappear from the working tree instead of rendering hidden cards");
assert.match(conflictCard, /github-sync-resolved-group"[^>]*><summary>Resolved<small>1 · show completed<\/small>/,
  "selected files leave only one compact opt-in review entry");
assert.doesNotMatch(conflictCard, /github-sync-resolved-group" open/,
  "the resolved group is collapsed by default");
const expandedResolvedCard = vm.runInContext(`(() => {
  githubSyncResolvedExpanded.add('shared');
  return githubSyncCards();
})()`, context);
assert.match(expandedResolvedCard, /skills\/System\/PKM\/PKM Skills\.md[\s\S]*Agent merge/,
  "completed files remain available only after the user explicitly expands them");
vm.runInContext("githubSyncResolvedExpanded.delete('shared')", context);
assert.match(conflictCard, /2 changed on both sides/, "the conflict workspace summarizes conflict shape");
assert.match(conflictCard, /All Use GitHub/, "the conflict workspace offers one-click GitHub staging for unresolved files");
assert.match(conflictCard, /Ask Agent for 1 unresolved/, "the Agent bulk action counts only unresolved compatible files");
assert.match(conflictCard, /Apply resolutions &amp; Sync<\/button>/);
assert.match(conflictCard, /onclick="githubSyncConflictAccept\('shared',this\)" disabled/,
  "Apply remains disabled until every file has an explicit resolution");
assert.match(source, /data-pending-label="\$\{initialPreview \? 'Preparing Initial Sync…' : 'Applying resolutions…'\}"[\s\S]*githubSyncConflictAccept/,
  "Apply choices exposes immediate Initial Sync feedback");
assert.match(coreSource, /githubSyncConflictAccept:900000/,
  "Initial Sync Apply has a dedicated stalled-operation timeout");
assert.match(coreSource, /githubSyncConflictAcceptProgress[\s\S]*updateActionProgress\('githubSyncConflictAccept'/,
  "Initial Sync progress renews the timeout and updates the pending button");
assert.doesNotMatch(/command === 'githubSyncState'[^\n]*/.exec(coreSource)?.[0] || "", /githubSyncConflictAccept/,
  "ordinary state refreshes cannot prematurely clear Initial Sync Apply feedback");
assert.match(extensionSource, /case "githubSyncConflictAccept"[\s\S]*githubSyncConflictAcceptProgress[\s\S]*githubSyncConflictAccepted/,
  "the host sends dedicated progress and terminal completion events for conflict acceptance");
assert.match(source, /Delete this machine[\s\S]*githubSyncConflictDeleteLocal/,
  "local-only files can explicitly accept GitHub absence");
assert.match(source, /Delete This Machine \(\$\{localOnly\}\)[\s\S]*githubSyncConflictDeleteLocalAll/,
  "local-only files support a visible bulk deletion action");
assert.match(extensionSource, /filter\(candidate => !candidate\.deleteRemote && !!candidate\.destination\)[\s\S]*map\(\(\{ destination, content \}\) => \(\{ destination: destination!, content \}\)\)/,
  "accepted machine-local deletions are applied through the atomic file mutation path");
assert.match(extensionSource, /candidate\.deleteLocal && candidate\.file\.type === "recipes"[\s\S]*applyGitHubSyncRecipeDeletes/,
  "accepted machine-local Recipe deletions use Project Store trash semantics");
assert.match(source, /aria-label="Open Sync Diagnostic Log"[^>]*openGitHubSyncDiagnosticLog/,
  "GitHub Sync exposes its persistent diagnostic log directly in the pane");
assert.match(extensionSource, /github_sync\.started[\s\S]*github_sync\.phase[\s\S]*github_sync\.catalog[\s\S]*github_sync\.completed/,
  "successful GitHub Sync runs emit structured lifecycle diagnostics");
assert.match(extensionSource, /github_sync\.failed[\s\S]*stack: diagnostic/,
  "failed GitHub Sync runs persist the full error stack");

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

const initialResolvedCard = vm.runInContext(`(() => {
  githubSyncData.conflicts.shared = {purpose:'initial-preview',remoteSchema:3,files:[
    {path:'notes/Remote.md',type:'notes',hasBase:false,hasLocal:false,hasRemote:true,candidateSource:'remote'},
    {path:'notes/Local.md',type:'notes',hasBase:false,hasLocal:true,hasRemote:false,candidateSource:'local'}
  ]};
  return githubSyncCards();
})()`, context);
assert.match(initialResolvedCard, /github-sync-resolved-group"[^>]*><summary>Resolved<small>2 · show completed<\/small>/,
  "automatically preserved one-sided files stay collapsed even for large initial comparisons");
assert.doesNotMatch(initialResolvedCard, /github-sync-conflict-file unresolved/,
  "a fully selected initial comparison does not render expanded unresolved files");
assert.doesNotMatch(initialResolvedCard, /notes\/Remote\.md|notes\/Local\.md/,
  "collapsed completed files are not rendered into the initial comparison DOM");
assert.match(source, /const previousScrollTop = detail\?\.scrollTop \|\| 0[\s\S]*detail\.scrollTop = Math\.min\(previousScrollTop/,
  "choosing a file preserves the comparison scroll position after host state rerenders");
assert.match(extensionSource, /candidateSource === "delete"[\s\S]*pendingDeletions/,
  "accepted deletion candidates become explicit GitHub Sync tombstones");
assert.match(extensionSource, /function refreshStaleGitHubSyncConflicts[\s\S]*refreshGitHubSyncConflictLocalCandidate/,
  "opening GitHub Sync refreshes stale machine-local conflict candidates");
assert.match(extensionSource, /function refreshStaleGitHubSyncConflicts[\s\S]*recipeSyncEntries\(\)[\s\S]*githubSyncManagedContent\("recipes"/,
  "Recipe stale checks compare the same layout-free canonical content used by GitHub publication");
assert.match(extensionSource, /function applyGitHubSyncRecipePulls[\s\S]*recipeSyncEntries\(\)[\s\S]*githubSyncManagedContent\("recipes"/,
  "Recipe pull safety checks ignore machine-local editor layout without weakening executable validation");
assert.match(extensionSource, /async function githubSyncStateData[\s\S]*refreshStaleGitHubSyncConflicts\(context\)[\s\S]*listGitHubSyncConflicts/,
  "stale conflict snapshots are refreshed before the resolution workspace is serialized");
assert.match(extensionSource, /function clearEquivalentGitHubSyncConflict[\s\S]*current\.equals\(remote\)[\s\S]*clearGitHubSyncConflict/,
  "identity-only conflicts are retired only when every machine-local file exactly matches its remote candidate");
assert.match(extensionSource, /completeGitHubSyncTransaction[\s\S]*clearGitHubSyncConflict[\s\S]*report\(targetId, "refresh-index"/,
  "a successful recheck explicitly retires the previous conflict workspace before post-processing");
assert.match(extensionSource, /shouldExecute:[\s\S]*clearEquivalentGitHubSyncConflict\(context, targetId\)[\s\S]*conflict-awaiting-approval/,
  "the scheduler clears proven identity-only conflicts before applying the ordinary conflict gate");
assert.match(extensionSource, /if \(waitForExpensive\)[\s\S]*githubSyncFingerprintInWorker[\s\S]*readGitHubCachedManifest/,
  "the deferred state pass computes current type/folder fingerprints against the cached last-sync commit");
assert.match(source, /fingerprintsDeferred && shield\.dataset\.status[\s\S]*continue/,
  "the lightweight state pass preserves a previously resolved tab status instead of forcing yellow");
assert.match(source, /function githubSyncFolderMarker[\s\S]*folderShields/,
  "folder markers consume the deferred folder-level GitHub Sync status payload");
const fileMarker = vm.runInContext(`(() => {
  githubSyncData.catalog = {notes:[{id:'Adhoc/changed',syncPath:'notes/Adhoc/changed.md'}]};
  githubSyncData.fileShields = {notes:{'notes/Adhoc/changed.md':'yellow','notes/Adhoc/same.md':'green'}};
  return githubSyncFileMarker('notes','Adhoc/changed');
})()`, context);
assert.match(fileMarker, /github-sync-file-status/);
assert.match(fileMarker, /data-status="yellow"/);
assert.match(fileMarker, /File notes\/Adhoc\/changed\.md differs from at least one selected target/);
assert.match(vm.runInContext("githubSyncFileMarker('notes','same','notes/Adhoc/same.md')", context), /data-status="green"/);
assert.match(source, /function githubSyncOnState[\s\S]*updateGitHubSyncFileShields\(\)/,
  "file statuses patch existing leaf markers without rebuilding the active tree");
assert.match(source, /function githubSyncOnState[\s\S]*updateGitHubSyncFolderShields\(\)/,
  "deferred folder status updates patch existing markers in place");
assert.doesNotMatch(source.match(/function githubSyncOnState[\s\S]*?\n}/)?.[0] || "", /renderList|renderGlobalRecipes/,
  "GitHub Sync status responses must not rebuild or temporarily blank the active Knowledge view");
assert.match(source, /githubSyncStatusRequested \|\| tabCacheIsFresh/,
  "knowledge navigation coalesces lazy GitHub Sync status requests");

async function verifyRetryHost() {
  const targets = [
    {id:'primary',automation:{enabled:true,initialSyncCompleted:true}},
    {id:'other',automation:{enabled:true,initialSyncCompleted:true}},
  ];
  const queued = [];
  const host = vm.createContext({
    msg:{targetId:'primary'}, context:{},
    githubSyncTargetById: (_context, id) => targets.find(target => target.id === id),
    githubPublicationMigration: () => ({status:() => host.migration}),
    mutateGitHubSyncTargets: async (_context, _reason, change) => change(targets),
    configureGitHubSyncScheduler: () => {},
    requireGitHubSyncManualMode: target => { if (target.automation.enabled) throw new Error('Turn off Auto Sync'); },
    githubSyncScheduler:{request:(id, reason) => { queued.push({id,reason}); return true; }},
    githubSyncStateData: async () => ({}), respond:() => {}, migration:undefined,
  });
  const execute = () => vm.runInContext(`(async () => { switch ('githubSyncRun') { ${retryHandler} } })()`, host);
  await assert.rejects(execute(), /Turn off Auto Sync/, 'ordinary direct requests still honor the Auto/manual boundary');
  assert.strictEqual(queued.length, 0);
  host.msg.pauseAutomation = true;
  host.migration = {phase:'staged'};
  await assert.rejects(execute(), /Complete or roll back/, 'invalid migration is rejected before pausing Auto');
  assert.strictEqual(targets[0].automation.enabled, true);
  host.migration = undefined;
  await execute();
  assert.strictEqual(targets[0].automation.enabled, false, 'explicit retry pauses only the chosen target');
  assert.strictEqual(targets[1].automation.enabled, true, 'other target automation is unchanged');
  assert.deepStrictEqual(queued, [{id:'primary',reason:'manual'}], 'recovery queues ordinary Sync, never Force Update');
  const autoPauseHandler = extensionSource.match(/onAutoPaused: targetId => \{([\s\S]*?)\n      \},\n      stateDirectory:/)?.[1];
  assert(autoPauseHandler, 'the host persists automatic-pause decisions');
  targets[0].automation.enabled = true;
  targets[0].lastFailure = {error:'network unavailable', attempts:3};
  const updates = [];
  host.log = {warn:() => {},error:message => { throw new Error(message); }};
  host.panel = {visible:true,webview:{postMessage:message => updates.push(message)}};
  const autoPause = vm.runInContext(`targetId => { ${autoPauseHandler} }`, host);
  autoPause('primary');
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(targets[0].automation.enabled, false, 'automatic exhaustion persists Auto off in the host target store');
  assert.strictEqual(targets[1].automation.enabled, true, 'automatic exhaustion never disables another target');
  assert.strictEqual(targets[0].lastFailure.error, 'network unavailable', 'automatic exhaustion retains failure details');
  assert.strictEqual(updates[0].command, 'githubSyncState', 'the persisted Auto off state is sent to the visible panel');
  host.msg.pauseAutomation = false;
  await execute();
  assert.strictEqual(queued.length, 2, 'normal Sync with Remote passes the host guard after automatic exhaustion');
}
verifyRetryHost().then(() => console.log("github-sync UI tests passed")).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
