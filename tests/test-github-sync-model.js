#!/usr/bin/env node
const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  GITHUB_SYNC_CONTENT_TYPES,
  defaultGitHubSyncSelection,
  discoverGitHubSshIdentities,
  fingerprintGitHubSyncEntries,
  githubSyncAuthenticationFailureGuidance,
  githubSyncAuthenticationSessionOptions,
  githubSyncGitArguments,
  githubSyncIgnoredPath,
  githubSyncGitDependencyGuidance,
  githubSyncUnrecordedAbsenceNeedsReview,
  githubSyncDurableEntityDeletion,
  verifyGitHubStagedFiles,
  githubSyncFolderShields,
  githubSyncEntryShields,
  githubSyncIsSystemContent,
  githubSyncIsSystemItem,
  githubSyncTargetFingerprintState,
  githubSyncManifestFileFingerprints,
  githubSyncManifestFolderFingerprints,
  manifestJson,
  githubSyncManagedContent,
  githubSyncRepositoryHttpsHost,
  githubSyncRepositorySshHost,
  githubSyncSafeRelativePath,
  githubSyncShield,
  githubSyncSshCommand,
  normalizeGitHubSyncTarget,
  parseGitHubCredentialManagerAccounts,
  parseGitHubSshLogin,
  replaceGitHubSyncFilesAtomically
} = require("../dist/sync/github-sync.js");

assert.deepStrictEqual(githubSyncAuthenticationSessionOptions(), { createIfNone: true },
  "normal GitHub reconnect must reuse the extension's global session preference across VS Code windows");
assert.deepStrictEqual(githubSyncAuthenticationSessionOptions(true), { createIfNone: true, clearSessionPreference: true },
  "account selection must be cleared only after the preferred account does not match the target");

for (const ignored of ["__pycache__/module.cpython-311.pyc", "nested/module.pyc", "nested/module.pyo", ".venv/bin/python", "node_modules/package/index.js", ".git/config", ".pytest_cache/data", ".DS_Store", "Thumbs.db"]) assert(githubSyncIgnoredPath(ignored), ignored);
for (const retained of ["module.py", "native.pyd", "target/tool", "bin/tool", "objects/data.json", "cache-notes.md"]) assert(!githubSyncIgnoredPath(retained), retained);
assert.match(githubSyncGitDependencyGuidance({ code: "ENOENT", path: "git" }), /remote machine.*does not install Git automatically/);
assert.match(githubSyncGitDependencyGuidance({ code: "ENOENT", path: "git" }, false), /working directory is missing/);
assert.strictEqual(githubSyncGitDependencyGuidance({ code: "EACCES", path: "git" }), undefined);
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, false, true, false, false), true, "A previously synchronized file missing locally must not be silently resurrected from Remote");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, true, false, false, false), true, "A missing remote baseline entity must not be silently republished either");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, false, true, true, false), false, "Explicit local deletion proceeds through three-way deletion reconciliation");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, true, false, false, true), false, "Explicit remote deletion proceeds through three-way deletion reconciliation");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(false, false, true, false, false), false, "A genuine new remote entity may still be pulled on initial sync");
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, true, true, false, false), false);
assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview(true, false, false, false, false), false);
const deletedAt = "2026-10-07T23:00:00Z";
const deletionFile = (type, relative, member = "") => ({ path: `${type}/${relative}`, type, itemId: "Project/Deleted", category: "Project", privacy: "public", member, digest: "a".repeat(64) });
for (const [type, filename] of [["notes", "Deleted.md"], ["papers", "Deleted.md"], ["scripts", "deleted.py"]]) {
  const primary = deletionFile(type, `Project/${filename}`);
  const evidence = new Map([[primary.path, { deletedAt }]]);
  assert.deepStrictEqual(githubSyncDurableEntityDeletion([primary], false, evidence), {
    type, itemId: primary.itemId, category: primary.category, privacy: "public", deletedAt,
  }, `${type} must propagate durable explicit deletion`);
  assert.strictEqual(githubSyncDurableEntityDeletion([primary], true, evidence), undefined, "A recreated local entity must not be deleted by stale journal evidence");
  assert.strictEqual(githubSyncDurableEntityDeletion([primary], false, new Map()), undefined, "Absence without journal evidence must not become implicit remote deletion");
}
const promptMembers = [deletionFile("prompts", "Project/Deleted/v1/prompt.txt", "v1/prompt.txt"), deletionFile("prompts", "Project/Deleted/v2/prompt.txt", "v2/prompt.txt")];
const promptDeletions = new Map(promptMembers.map(file => [file.path, { deletedAt }]));
assert.strictEqual(githubSyncDurableEntityDeletion(promptMembers, false, promptDeletions).type, "prompts", "Whole-folder Prompt deletion is supported");
assert.strictEqual(githubSyncDurableEntityDeletion(promptMembers, true, promptDeletions), undefined, "An existing Prompt is preserved even with stale member records");
promptDeletions.delete(promptMembers[1].path);
assert.strictEqual(githubSyncDurableEntityDeletion(promptMembers, false, promptDeletions), undefined, "Deleting one member cannot authorize deleting an entire multi-file entity");
const protectedDeletedFile = deletionFile("notes", "System/Deleted.md");
assert.strictEqual(githubSyncDurableEntityDeletion([protectedDeletedFile], false, new Map([[protectedDeletedFile.path, { deletedAt }]])), undefined, "System content remains protected");
const transientRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-cache-model-"));
try {
  fs.writeFileSync(path.join(transientRoot, "module.py"), "print('source')\n");
  fs.mkdirSync(path.join(transientRoot, "__pycache__"));
  fs.writeFileSync(path.join(transientRoot, "__pycache__", "module.pyc"), "ephemeral");
  const transientCatalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  transientCatalog.servers = [{ id: "fixture", cat: "", destination: "servers/fixture", source: transientRoot, isPrivate: false }];
  const transientTarget = normalizeGitHubSyncTarget({ name: "Cache exclusion", repository: "fixture" }, () => "cache-exclusion");
  transientTarget.selection.public.servers.folders.push("");
  const beforeRemoval = githubSyncTargetFingerprintState(transientTarget, transientCatalog);
  fs.utimesSync(path.join(transientRoot, "module.py"), new Date(), new Date());
  assert.strictEqual(githubSyncTargetFingerprintState(transientTarget, transientCatalog).localChangeFingerprint,
    beforeRemoval.localChangeFingerprint, "mtime-only rewrites cannot trigger content-change synchronization");
  fs.writeFileSync(path.join(transientRoot, "__pycache__", "module.pyc"), "new ephemeral bytes");
  assert.strictEqual(githubSyncTargetFingerprintState(transientTarget, transientCatalog).localChangeFingerprint,
    beforeRemoval.localChangeFingerprint, "ignored content cannot trigger synchronization");
  transientTarget.selection.private.servers.folders.push("");
  transientCatalog.servers[0].isPrivate = true;
  assert.notStrictEqual(githubSyncTargetFingerprintState(transientTarget, transientCatalog).localChangeFingerprint,
    beforeRemoval.localChangeFingerprint, "privacy changes trigger synchronization even when file bytes are unchanged");
  transientCatalog.servers[0].isPrivate = false;
  transientCatalog.notes = [{ id: "outside", cat: "Excluded", source: path.join(transientRoot, "module.py"),
    destination: "notes/Excluded/outside.md", isPrivate: false }];
  const savedNoteSelection = transientTarget.selection.public.notes;
  transientTarget.selection.public.notes = { items: [], folders: [] };
  assert.strictEqual(githubSyncTargetFingerprintState(transientTarget, transientCatalog).localChangeFingerprint,
    beforeRemoval.localChangeFingerprint, "unselected catalog entries cannot trigger synchronization");
  transientCatalog.notes = [];
  transientTarget.selection.public.notes = savedNoteSelection;
  transientTarget.lastSync = { at: new Date().toISOString(), commit: "a".repeat(40), fingerprints: {},
    localChangeFingerprint: beforeRemoval.localChangeFingerprint };
  assert.strictEqual(normalizeGitHubSyncTarget(transientTarget).lastSync.localChangeFingerprint,
    beforeRemoval.localChangeFingerprint, "local change baseline survives target state normalization and reload");
  assert.deepStrictEqual(Object.keys(beforeRemoval.files.servers), ["servers/fixture/module.py"]);
  const legacyCacheManifest = manifestJson([
    { path: "servers/fixture/module.py", type: "servers", itemId: "fixture", member: "module.py", category: "", privacy: "public", digest: beforeRemoval.files.servers["servers/fixture/module.py"] },
    { path: "servers/fixture/__pycache__/module.pyc", type: "servers", itemId: "fixture", member: "__pycache__/module.pyc", category: "", privacy: "public", digest: "a".repeat(64) },
  ]);
  assert.deepStrictEqual(githubSyncManifestFileFingerprints(transientTarget, legacyCacheManifest).servers, beforeRemoval.files.servers, "Old cache baselines must use the same ignore scope as the current snapshot");
  fs.rmSync(path.join(transientRoot, "__pycache__"), { recursive: true });
  assert.deepStrictEqual(githubSyncTargetFingerprintState(transientTarget, transientCatalog), beforeRemoval, "Cache disappearance must not affect synchronized bytes or fingerprints");
  for (const [file, content] of [["one.md", "one"], ["two.md", "two"], ["shared.png", "shared asset"]]) fs.writeFileSync(path.join(transientRoot, file), content);
  const sharedCatalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  sharedCatalog.notes = ["one", "two"].map(name => ({
    id: name, cat: "Project/Shared", isPrivate: false,
    source: path.join(transientRoot, `${name}.md`), destination: `notes/Project/Shared/${name}.md`,
    dependencies: [{ source: path.join(transientRoot, "shared.png"), destination: "notes/Project/Shared/shared.png" }],
  }));
  const sharedCurrent = githubSyncTargetFingerprintState(transientTarget, sharedCatalog);
  const sharedManifest = manifestJson(Object.entries(sharedCurrent.files.notes).map(([file, digest]) => ({
    path: file, digest, type: "notes", itemId: path.basename(file, ".md"),
    member: file.endsWith("shared.png") ? file : "", category: "Project/Shared", privacy: "public",
  })));
  const sharedBase = githubSyncManifestFolderFingerprints(transientTarget, sharedManifest);
  assert.deepStrictEqual(sharedCurrent.files.notes, githubSyncManifestFileFingerprints(transientTarget, sharedManifest).notes);
  assert.strictEqual(sharedCurrent.fingerprints.notes, fingerprintGitHubSyncEntries(Object.entries(sharedCurrent.files.notes).map(([file, digest]) => ({ path: file, digest }))), "Shared assets must count once in the type fingerprint");
  const sharedShields = githubSyncFolderShields([transientTarget], { "cache-exclusion": sharedCurrent.fingerprints }, { "cache-exclusion": sharedCurrent.folders }, { "cache-exclusion": sharedBase });
  assert.strictEqual(sharedShields.notes.Project, "green", "Matching shared assets must not keep the parent directory yellow");
  assert.strictEqual(sharedShields.notes["Project/Shared"], "green", "Matching individual files and directory fingerprints must agree");
  fs.writeFileSync(path.join(transientRoot, "shared.png"), "changed shared asset");
  const sharedChanged = githubSyncTargetFingerprintState(transientTarget, sharedCatalog);
  assert.strictEqual(githubSyncFolderShields([transientTarget], { "cache-exclusion": sharedChanged.fingerprints }, { "cache-exclusion": sharedChanged.folders }, { "cache-exclusion": sharedBase }).notes.Project, "yellow", "A real shared-asset edit must still mark its directory pending");
} finally { fs.rmSync(transientRoot, { recursive: true, force: true }); }

const defaults = defaultGitHubSyncSelection();
for (const type of ['notes','skills','prompts','recipes']) {
  assert(githubSyncIsSystemContent(type, 'System/PKM'));
  assert(githubSyncIsSystemContent(type, 'system\\PKM'));
  assert(githubSyncIsSystemContent(type, 'Personal', 'id', `${type}/System/file.md`));
  assert(!githubSyncIsSystemContent(type, 'Personal/System'));
}
assert(!githubSyncIsSystemContent('papers', 'System/PKM'));
assert(githubSyncIsSystemItem('recipes', {id:'builtin',cat:'Other',destination:'recipes/Other/builtin.json',content:JSON.stringify({systemKind:'built-in'})}));
const protectedCatalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
protectedCatalog.notes = [
  {id:'system-note',cat:'System/PKM',destination:'notes/System/PKM/read-only.md',content:'protected',isPrivate:false},
  {id:'user-note',cat:'Adhoc',destination:'notes/Adhoc/user.md',content:'editable',isPrivate:false},
];
const protectedTarget = normalizeGitHubSyncTarget({name:'Protected selection',repository:'https://github.com/example/knowledge.git'}, () => 'protected');
protectedTarget.selection.public.notes.items.push('system-note');
const protectedFiles = githubSyncTargetFingerprintState(protectedTarget, protectedCatalog).files.notes;
assert.deepStrictEqual(Object.keys(protectedFiles), ['notes/Adhoc/user.md'], 'System is excluded even from explicit selections and root selection');
const protectedBaseline = githubSyncManifestFileFingerprints(protectedTarget, manifestJson([
  {path:'notes/System/PKM/read-only.md',type:'notes',itemId:'System/PKM/read-only',member:'',category:'System/PKM',privacy:'public',digest:'a'.repeat(64)}
]));
assert.deepStrictEqual(protectedBaseline.notes, {}, 'old System baselines do not produce pending-sync markers');
const builtInRecipeIds = new Set(["built-in-recipe"]);
const historicalRecipeManifest = manifestJson([
  {path:"recipes/Old/BuiltIn.json", type:"recipes", itemId:"built-in-recipe", member:"", category:"Old", privacy:"public", digest:"b".repeat(64)},
  {path:"recipes/Work/User.json", type:"recipes", itemId:"user-recipe", member:"", category:"Work", privacy:"public", digest:"c".repeat(64)},
  {path:"papers/MyIdeas/Idea.md", type:"papers", itemId:"MyIdeas/Idea", member:"", category:"MyIdeas", privacy:"public", digest:"d".repeat(64)},
]);
const filteredRecipeBaseline = githubSyncManifestFileFingerprints(protectedTarget, historicalRecipeManifest, new Set(), builtInRecipeIds);
assert.deepStrictEqual(filteredRecipeBaseline.recipes, { "recipes/Work/User.json":"c".repeat(64) },
  "built-in Recipe identities are excluded even when historical paths/categories differ");
assert.deepStrictEqual(filteredRecipeBaseline.papers, { "papers/MyIdeas/Idea.md":"d".repeat(64) },
  "retained historical public MyIdeas must not be hidden by built-in Recipe filtering");
const filteredRecipeFolders = githubSyncManifestFolderFingerprints(protectedTarget, historicalRecipeManifest, new Set(), builtInRecipeIds);
assert.equal(filteredRecipeFolders.recipes.Old, undefined);
assert(filteredRecipeFolders.recipes.Work);
assert(filteredRecipeFolders.papers.MyIdeas);
assert(githubSyncManifestFileFingerprints(protectedTarget, historicalRecipeManifest).recipes["recipes/Old/BuiltIn.json"],
  "callers without current built-in identities retain the original baseline behavior");
const recipeMarkers = githubSyncEntryShields([protectedTarget], {}, {
  protected:{recipes:{"recipes/Work/User.json":"c".repeat(64)}},
}, {protected:filteredRecipeBaseline});
assert.equal(recipeMarkers.recipes["recipes/Old/BuiltIn.json"], undefined, "built-ins use the existing not-included marker");
assert.equal(recipeMarkers.recipes["recipes/Work/User.json"], "green");
assert.equal(recipeMarkers.papers["papers/MyIdeas/Idea.md"], "yellow", "retained publication discrepancy remains visible");
const legacySkillTarget = normalizeGitHubSyncTarget({name:'Legacy Skills',repository:'repo'}, () => 'legacy-skills');
const secondSkillTarget = normalizeGitHubSyncTarget({name:'Second Skills',repository:'repo'}, () => 'second-skills');
const legacySkillCatalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
legacySkillCatalog.skills = [
  {id:'user-skill',cat:'Work',destination:'skills/Work/User.md',content:'ordinary skill',isPrivate:false},
  {id:'system-skill',cat:'Work',destination:'skills/System/Protected.md',content:'system skill',isPrivate:false},
];
const legacySkillCurrent = githubSyncTargetFingerprintState(legacySkillTarget, legacySkillCatalog);
const legacySkillFiles = [
  {path:'skills/Work/User.md',type:'skills',itemId:'user-skill',member:'',category:'Work',privacy:'public',digest:legacySkillCurrent.files.skills['skills/Work/User.md']},
  ...Array.from({length:4}, (_, index) => ({path:`skills/System/Protected${index}.md`,type:'skills',itemId:`protected-${index}`,member:'',category:'Work',privacy:'public',digest:'a'.repeat(64)})),
];
const legacySkillManifest = manifestJson(legacySkillFiles);
const legacySkillFingerprint = fingerprintGitHubSyncEntries(legacySkillFiles.map(file => ({path:file.path,digest:file.digest})));
for (const syncTarget of [legacySkillTarget, secondSkillTarget]) {
  syncTarget.lastSync = {at:'2026-01-01T00:00:00Z',commit:'abc',fingerprints:{skills:legacySkillFingerprint}};
}
const legacySkillTargets = [legacySkillTarget, secondSkillTarget];
const legacyTargetSnapshot = JSON.stringify(legacySkillTargets);
const legacySkillCurrents = Object.fromEntries(legacySkillTargets.map(syncTarget => [syncTarget.id, legacySkillCurrent.fingerprints]));
const legacySkillBaselines = Object.fromEntries(legacySkillTargets.map(syncTarget => [syncTarget.id, githubSyncManifestFileFingerprints(syncTarget, legacySkillManifest)]));
assert.strictEqual(githubSyncShield(legacySkillTargets, 'skills', legacySkillCurrents), 'yellow', 'legacy aggregate hashes still include four historical System files');
assert.strictEqual(githubSyncShield(legacySkillTargets, 'skills', legacySkillCurrents, legacySkillBaselines), 'green', 'both targets use the current System-excluded scope without requiring another sync');
assert.deepStrictEqual(Object.keys(legacySkillBaselines[legacySkillTarget.id].skills), ['skills/Work/User.md'], 'actual System paths are excluded even when old metadata says Work');
assert.strictEqual(githubSyncShield(legacySkillTargets, 'skills', {
  ...legacySkillCurrents,
  [secondSkillTarget.id]: {skills:fingerprintGitHubSyncEntries([{path:'skills/Work/User.md',digest:'b'.repeat(64)}])},
}, legacySkillBaselines), 'yellow', 'a real ordinary Skill difference on either target remains yellow');
assert.strictEqual(githubSyncShield(legacySkillTargets, 'skills', legacySkillCurrents, {
  [legacySkillTarget.id]: legacySkillBaselines[legacySkillTarget.id],
}), 'yellow', 'an unavailable cached baseline falls back to its saved fingerprint rather than assuming a match');
assert.strictEqual(githubSyncShield([legacySkillTarget], 'skills', {
  [legacySkillTarget.id]: {skills:fingerprintGitHubSyncEntries([])},
}, {[legacySkillTarget.id]: {skills:{}}}), 'green', 'an available empty filtered baseline is not mistaken for an unavailable baseline');
assert.strictEqual(JSON.stringify(legacySkillTargets), legacyTargetSnapshot, 'status comparison never rewrites stored synchronization records');
assert(GITHUB_SYNC_CONTENT_TYPES.includes("agentSnapshots"));
for (const type of GITHUB_SYNC_CONTENT_TYPES) {
  assert.deepStrictEqual(defaults.public[type], { items: [], folders: ["packages", "servers", "agentSnapshots", "actions", "action-module-sets", "profiles"].includes(type) ? [] : [""] });
  assert.deepStrictEqual(defaults.private[type], { items: [], folders: [] });
}
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
assert.match(extensionSource, /githubSyncShield\(targets, type, currentFingerprints, baseFileFingerprints\)/,
  'top-level status receives the same filtered successful manifest baseline as file markers');
const atomicRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-sync-atomic-"));
try {
  const removed = path.join(atomicRoot, "removed.md");
  const written = path.join(atomicRoot, "written.md");
  fs.writeFileSync(removed, "local only\n");
  replaceGitHubSyncFilesAtomically([
    { destination: removed, content: undefined },
    { destination: written, content: Buffer.from("remote\n") },
  ], "conflict acceptance");
  assert.strictEqual(fs.existsSync(removed), false, "atomic conflict acceptance supports explicit local deletion");
  assert.strictEqual(fs.readFileSync(written, "utf8"), "remote\n");
} finally {
  fs.rmSync(atomicRoot, { recursive: true, force: true });
}
assert.match(extensionSource, /const files = fetched\.files\.filter\(file => file\.type !== "agentSnapshots"\)/,
  "GitHub Branch subscriptions must never expose synchronized Agent Snapshots");
assert.match(extensionSource, /enabled: target\.automation\.enabled && target\.automation\.initialSyncCompleted/,
  "the scheduler must enforce the initial manual-sync gate even if persisted automation is enabled");
assert.match(extensionSource, /reason === "manual"[\s\S]*current\.automation\.initialSyncCompleted = true/,
  "only a successful manual synchronization unlocks the automation control");
assert.match(extensionSource, /existing\?\.automation\.initialSyncCompleted === true[\s\S]*automationBlocked/,
  "target save must preserve host-owned readiness and reject client attempts to bypass the gate");

const target = normalizeGitHubSyncTarget({
  name: "Primary",
  repository: "git@github.com:owner/knowledge.git",
  branch: "main"
}, () => "target-1");
assert.strictEqual(target.id, "target-1");
assert.deepStrictEqual(target.selection, defaults);
assert.deepStrictEqual(target.automation, { enabled: false, intervalMinutes: 5, syncOnChange: true, initialSyncCompleted: false });
assert.strictEqual(target.conflictResolution, "manual");
const scheduledTarget = normalizeGitHubSyncTarget({
  name: "Scheduled",
  repository: "https://github.com/qizhu8/knowledge.git",
  branch: "main",
  authentication: { method: "vscode", expectedLogin: "qizhu8", accountId: "account-1" },
  conflictResolution: "agent",
  automation: { enabled: true, intervalMinutes: 30, syncOnChange: false, initialSyncCompleted: true }
}, () => "target-scheduled");
assert.deepStrictEqual(scheduledTarget.authentication, { method: "vscode", expectedLogin: "qizhu8", accountId: "account-1" });
assert.strictEqual(scheduledTarget.conflictResolution, "agent");
assert.deepStrictEqual(scheduledTarget.automation, { enabled: true, intervalMinutes: 30, syncOnChange: false, initialSyncCompleted: true });
assert.deepStrictEqual(normalizeGitHubSyncTarget(JSON.parse(JSON.stringify(scheduledTarget))).automation, scheduledTarget.automation,
  "the per-target interval survives target-file serialization and reload");
const unsafeAutomaticTarget = normalizeGitHubSyncTarget({
  name: "Needs initial sync",
  repository: "https://github.com/qizhu8/knowledge.git",
  branch: "main",
  automation: { enabled: true, intervalMinutes: 5, syncOnChange: true }
}, () => "target-needs-initial-sync");
assert.deepStrictEqual(unsafeAutomaticTarget.automation, {
  enabled: false, intervalMinutes: 5, syncOnChange: true, initialSyncCompleted: false
}, "automatic synchronization stays off until a successful manual sync is persisted");
const legacyAutomaticTarget = normalizeGitHubSyncTarget({
  name: "Legacy synchronized target",
  repository: "https://github.com/qizhu8/knowledge.git",
  branch: "main",
  automation: { enabled: true, intervalMinutes: 5, syncOnChange: true },
  lastSync: { at: "2026-09-24T20:00:00.000Z", commit: "a".repeat(40), fingerprints: {} }
}, () => "target-legacy-ready");
assert.strictEqual(legacyAutomaticTarget.automation.initialSyncCompleted, true,
  "existing synchronized targets migrate without unexpectedly disabling their schedule");
assert.throws(() => normalizeGitHubSyncTarget({ name: "Bad interval", repository: "repo", branch: "main", automation: { intervalMinutes: 0 } }), /between 1 and 1440/);
assert.throws(() => normalizeGitHubSyncTarget({ name: "Fractional interval", repository: "repo", branch: "main", automation: { intervalMinutes: 1.5 } }), /between 1 and 1440/);
assert.throws(() => normalizeGitHubSyncTarget({ name: "Large interval", repository: "repo", branch: "main", automation: { intervalMinutes: 1441 } }), /between 1 and 1440/);
assert.throws(() => normalizeGitHubSyncTarget({ name: "Bad", repository: "repo", branch: "bad..branch" }), /valid Git branch/);
assert.throws(() => normalizeGitHubSyncTarget({ name: "", repository: "repo", branch: "main" }), /name is required/);
const emuTarget = normalizeGitHubSyncTarget({
  name: "EMU",
  repository: "git@github.com:yuwang8_microsoft/uone-knowledge-base.git",
  branch: "main",
  authentication: { identityFile: "/home/user/.ssh/id_emu", expectedLogin: "yuwang8_microsoft" }
}, () => "target-emu");
assert.deepStrictEqual(emuTarget.authentication, { method: "ssh", identityFile: "/home/user/.ssh/id_emu", expectedLogin: "yuwang8_microsoft" });
const homeIdentityTarget = normalizeGitHubSyncTarget({ name: "Home key", repository: "git@github.com:owner/repo.git", branch: "main", authentication: { identityFile: "~/.ssh/id_personal", expectedLogin: "qizhu8" } }, () => "target-home");
assert.strictEqual(homeIdentityTarget.authentication.identityFile, path.join(os.homedir(), ".ssh", "id_personal"));
assert.throws(() => normalizeGitHubSyncTarget({ name: "EMU", repository: "repo", branch: "main", authentication: { identityFile: "/tmp/key" } }), /Expected GitHub login/);
const gcmTarget = normalizeGitHubSyncTarget({
  name: "EMU via GCM",
  repository: "https://github.com/yuwang8_microsoft/uone-knowledge-base.git",
  branch: "main",
  authentication: { method: "https", expectedLogin: "yuwang8_microsoft" }
}, () => "target-gcm");
assert.deepStrictEqual(gcmTarget.authentication, { method: "https", expectedLogin: "yuwang8_microsoft" });
assert.deepStrictEqual(githubSyncGitArguments(["fetch", "origin"], gcmTarget), [
  "-c", "core.longpaths=true",
  "-c", "credential.gitHubAccountFiltering=true",
  "-c", "credential.username=yuwang8_microsoft",
  "fetch", "origin"
]);
assert.deepStrictEqual(githubSyncGitArguments(["status"]), ["-c", "core.longpaths=true", "status"],
  "all extension-managed Git commands must enable long-path support without changing global Git configuration");
assert.match(githubSyncAuthenticationFailureGuidance(gcmTarget, "remote: Repository not found.\nfatal: Authentication failed"), /did not authenticate as yuwang8_microsoft.*switch this target to VS Code GitHub Authentication/,
  "GCM failures must explain the exact account recovery path");
assert.strictEqual(githubSyncAuthenticationFailureGuidance(gcmTarget, "fatal: unable to access: connection timed out"), "",
  "non-authentication failures must not be mislabeled as credential failures");
assert.match(githubSyncAuthenticationFailureGuidance(scheduledTarget, "fatal: Authentication failed"), /Reconnect the VS Code GitHub account qizhu8/,
  "VS Code Authentication failures must identify the target account to reconnect");
assert.deepStrictEqual(githubSyncGitArguments(["fetch", "origin"], scheduledTarget).slice(-2), ["fetch", "origin"]);
assert(!githubSyncGitArguments(["fetch", "origin"], scheduledTarget).join(" ").includes("github_pat_example"), "VS Code access token is never included in git arguments");
assert.strictEqual(githubSyncRepositoryHttpsHost(gcmTarget.repository), "github.com");
assert.throws(() => normalizeGitHubSyncTarget({ name: "Bad GCM", repository: "git@github.com:owner/repo.git", branch: "main", authentication: { method: "https", expectedLogin: "owner" } }), /HTTPS repository URL/);
assert.throws(() => githubSyncRepositoryHttpsHost("https://token@github.com/owner/repo.git"), /HTTPS repository URL/);
assert.strictEqual(githubSyncRepositorySshHost("git@github.com:owner/repo.git"), "github.com");
assert.strictEqual(githubSyncRepositorySshHost("ssh://git@github-emu/owner/repo.git"), "github-emu");
assert.throws(() => githubSyncRepositorySshHost("https://github.com/owner/repo.git"), /SSH repository URL/);
assert.strictEqual(githubSyncSafeRelativePath("skills/Research/One.md"), "skills/Research/One.md");
assert.throws(() => githubSyncSafeRelativePath("../outside.md"), /invalid/);
assert.throws(() => githubSyncSafeRelativePath("C:\\outside.md"), /invalid/);
assert.throws(() => githubSyncSafeRelativePath("scripts/CON.txt"), /invalid/);
assert.throws(() => githubSyncSafeRelativePath("notes/trailing. "), /invalid/);
assert.strictEqual(parseGitHubSshLogin("Hi yuwang8_microsoft! You've successfully authenticated, but GitHub does not provide shell access."), "yuwang8_microsoft");
assert.strictEqual(parseGitHubSshLogin("Permission denied (publickey)."), "");
assert.deepStrictEqual(parseGitHubCredentialManagerAccounts("github.com:\n  qizhu8\n  yuwang8_microsoft\n"), ["qizhu8", "yuwang8_microsoft"]);
assert.deepStrictEqual(parseGitHubCredentialManagerAccounts("github.com qizhu8\n* yuwang8_microsoft\n"), ["qizhu8", "yuwang8_microsoft"]);
assert.strictEqual(githubSyncSshCommand("/home/user/My Key's/id_ed25519"), "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -i '/home/user/My Key'\\''s/id_ed25519'");

const sshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-identities-"));
try {
  const sshDirectory = path.join(sshRoot, ".ssh");
  fs.mkdirSync(sshDirectory);
  const scanned = path.join(sshDirectory, "id_personal");
  const configured = path.join(sshRoot, "id_emu");
  fs.writeFileSync(scanned, "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n");
  fs.writeFileSync(`${scanned}.pub`, "ssh-ed25519 public\n");
  fs.writeFileSync(configured, "-----BEGIN RSA PRIVATE KEY-----\ntest\n");
  fs.writeFileSync(path.join(sshDirectory, "known_hosts"), "github.com ssh-ed25519 host\n");
  fs.writeFileSync(path.join(sshDirectory, "config"), `Host github-emu\n  IdentityFile ${configured}\n`);
  assert.deepStrictEqual(discoverGitHubSshIdentities(sshDirectory), [configured, scanned].sort());
} finally {
  fs.rmSync(sshRoot, { recursive: true, force: true });
}

const entryDigest = value => createHash("sha256").update(value).digest("hex");
const fingerprint = fingerprintGitHubSyncEntries([
  { path: "notes/b.md", digest: entryDigest("b") },
  { path: "skills/a.md", digest: entryDigest("a") }
]);
assert.strictEqual(fingerprint, fingerprintGitHubSyncEntries([
  { path: "skills/a.md", digest: entryDigest("a") },
  { path: "notes/b.md", digest: entryDigest("b") }
]));

const recipeWithoutLayout = {
  schema: 1,
  recipeId: "recipe-layout-test",
  name: "Layout test",
  definition: { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [], outputs: {}, completion: { requiredNodes: [] } } }
};
const recipeWithLayout = {
  ...recipeWithoutLayout,
  editorLayout: { nodePositions: { work: { x: 123, y: 456 } } }
};
assert.deepStrictEqual(
  githubSyncManagedContent("recipes", Buffer.from(JSON.stringify(recipeWithLayout))),
  githubSyncManagedContent("recipes", Buffer.from(JSON.stringify(recipeWithoutLayout))),
  "Recipe graph coordinates must not affect GitHub Sync content or fingerprints"
);
assert.deepStrictEqual(
  githubSyncManagedContent("recipes", Buffer.from(JSON.stringify(recipeWithoutLayout))),
  githubSyncManagedContent("recipes", Buffer.from(JSON.stringify(recipeWithoutLayout, null, 2) + "\n")),
  "compact and expanded Recipe JSON must have identical GitHub Sync content"
);
assert.deepStrictEqual(
  githubSyncManagedContent("notes", Buffer.from("unchanged")),
  Buffer.from("unchanged"),
  "non-Recipe content must remain byte-preserving"
);

assert.strictEqual(githubSyncShield([], "skills", {}), "outline");
const fileStates = githubSyncEntryShields([target], {}, {
  [target.id]: { notes: { "notes/Adhoc/unchanged.md": "same", "notes/Adhoc/changed.md": "new", "notes/Adhoc/added.md": "added" } },
}, {
  [target.id]: { notes: { "notes/Adhoc/unchanged.md": "same", "notes/Adhoc/changed.md": "old" } },
});
assert.strictEqual(fileStates.notes["notes/Adhoc/unchanged.md"], "green");
assert.strictEqual(fileStates.notes["notes/Adhoc/changed.md"], "yellow");
assert.strictEqual(fileStates.notes["notes/Adhoc/added.md"], "yellow");
assert.strictEqual(fileStates.notes["notes/System/PKM/Router.md"], undefined,
  "files not covered by a target have no colored status");
assert.strictEqual(githubSyncShield([target], "skills", { "target-1": { skills: fingerprint } }), "yellow");
target.lastSync = { at: "2026-01-01T00:00:00Z", commit: "abc", fingerprints: { skills: fingerprint } };
assert.strictEqual(githubSyncShield([target], "skills", { "target-1": { skills: fingerprint } }), "green");
assert.strictEqual(githubSyncShield([target], "skills", { "target-1": { skills: entryDigest("changed") } }), "yellow");

const notesOnly = normalizeGitHubSyncTarget({
  name: "Notes",
  repository: "repo",
  branch: "main",
  selection: {
    public: { notes: { items: ["Work/One"], folders: [] } },
    private: {}
  }
}, () => "notes-only");
assert.strictEqual(githubSyncShield([notesOnly], "skills", {}), "outline");
assert.strictEqual(githubSyncShield([notesOnly], "notes", {}), "yellow");

const folderCurrent = {
  "target-1": {
    skills: {
      Work: "work-current",
      "Work/Shared": "shared-current",
    },
  },
};
const folderBase = {
  "target-1": {
    skills: {
      Work: "work-current",
      "Work/Shared": "shared-current",
    },
  },
};
assert.deepStrictEqual(githubSyncFolderShields(
  [target],
  { "target-1": { skills: fingerprint } },
  folderCurrent,
  folderBase,
).skills, { Work: "green", "Work/Shared": "green" },
"nested folders are green when their current projection matches the exact last-sync manifest");

folderCurrent["target-1"].skills.Work = "work-changed";
folderCurrent["target-1"].skills["Work/Shared"] = "shared-changed";
assert.deepStrictEqual(githubSyncFolderShields(
  [target],
  { "target-1": { skills: entryDigest("changed") } },
  folderCurrent,
  folderBase,
).skills, { Work: "yellow", "Work/Shared": "yellow" },
"a nested edit marks both the folder and its ancestor as different");

const secondTarget = normalizeGitHubSyncTarget({
  name: "Secondary",
  repository: "repo",
  branch: "main",
}, () => "target-2");
secondTarget.lastSync = { at: "2026-01-01T00:00:00Z", commit: "def", fingerprints: { skills: fingerprint } };
assert.strictEqual(githubSyncFolderShields(
  [target, secondTarget],
  {
    "target-1": { skills: fingerprint },
    "target-2": { skills: entryDigest("changed") },
  },
  {
    "target-1": { skills: { Work: "same" } },
    "target-2": { skills: { Work: "different" } },
  },
  {
    "target-1": { skills: { Work: "same" } },
    "target-2": { skills: { Work: "base" } },
  },
).skills.Work, "yellow", "one differing target keeps a multiply-covered folder yellow");

assert.strictEqual(githubSyncFolderShields(
  [target],
  { "target-1": { skills: fingerprint } },
  { "target-1": { skills: { Work: "current" } } },
  {},
).skills.Work, "green", "legacy sync records fall back to their matching type fingerprint when the cached manifest is unavailable");

async function testStagedVerificationWithoutCommits() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-staged-verification-"));
  const stagedTarget = normalizeGitHubSyncTarget({ name:"Staged fixture", repository:"fixture" }, () => "staged");
  const checkout = path.join(root, stagedTarget.id, "repository");
  const run = args => require("child_process").execFileSync("git", args, { cwd:checkout, stdio:"pipe" });
  try {
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive:true });
    run(["init", "-q"]);
    const contents = [Buffer.from("first\n"), Buffer.from([0, 10, 255, 13, 0]), Buffer.alloc(0)];
    const files = contents.map((content, index) => {
      const relative = `scripts/member-${index}.bin`;
      fs.writeFileSync(path.join(checkout, relative), content);
      return { path:relative, type:"scripts", itemId:`member-${index}`, member:"", category:"", privacy:"public", digest:"old" };
    });
    run(["-c", "core.autocrlf=false", "add", "--", "scripts"]);
    const progress = [];
    await verifyGitHubStagedFiles(stagedTarget, root, files, count => progress.push(count));
    assert.deepStrictEqual(progress, [3]);
    files.forEach((file, index) => {
      assert(file.content.equals(contents[index]), "Batch verification preserves binary and empty staged bytes");
      assert.strictEqual(file.digest, createHash("sha256").update(contents[index]).digest("hex"));
    });
    await assert.rejects(verifyGitHubStagedFiles(stagedTarget, root, [{ ...files[0], path:"scripts/missing.bin" }]), /missing file/);
    assert.throws(() => run(["rev-parse", "--verify", "HEAD"]), "This fixture must never create a Git commit");
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
}
testStagedVerificationWithoutCommits().then(() => console.log("github-sync model tests passed (including batched index verification without commits)"), error => { console.error(error); process.exitCode = 1; });