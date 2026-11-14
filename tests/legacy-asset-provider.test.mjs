import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  buildLegacyScriptProjectSnapshot,
  resolveLegacyScriptProjectLocator,
  readOriginalClassificationPreview,
  validateLegacyClassificationRollback,
  validateNativeAssetOwnership,
  LegacyAssetProviderError,
} from "../dist/legacy-asset-provider.js";
import { readDocumentAssets } from "../dist/assets.js";
import { readMarkdown } from "../dist/markdown.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testsRoot, "../legacy");
const require = createRequire(import.meta.url);
const originalModules = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");

function original(path) {
  if (originalModules.has(path)) return originalModules.get(path).exports;
  const module = { exports: {} };
  originalModules.set(path, module);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => {
    if (!name.startsWith(".")) return require(name);
    const candidate = resolve(dirname(path), name);
    const file = `${candidate}.ts`;
    if (!file.startsWith(`${repositoryRoot}/`)) throw new Error(`Original fixture import escaped the repository: ${name}`);
    return original(file);
  };
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })
    (localRequire, module, module.exports, path, dirname(path));
  return module.exports;
}

function observeTargets(root, journal) {
  const observations = new Map();
  for (const entry of journal.entries) {
    const parts = entry.target.split("/");
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      if (observations.has(path)) continue;
      const full = join(root, path);
      if (!existsSync(full)) {
        observations.set(path, { path, kind: "missing", digest: null });
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) observations.set(path, { path, kind: "symlink", digest: null });
      else if (stat.isDirectory()) observations.set(path, { path, kind: "directory", digest: null });
      else if (stat.isFile()) observations.set(path, { path, kind: "regular-file", digest: hash(readFileSync(full)) });
      else observations.set(path, { path, kind: "other", digest: null });
    }
  }
  return [...observations.values()];
}

function expectProviderError(action, code) {
  assert.throws(action, error => error instanceof LegacyAssetProviderError && error.code === code);
}

test("legacy Script/Project link and asset validation are source-qualified and read-only", async t => {
  const root = join(testsRoot, `.legacy-asset-provider-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = {
    actor: { id: "legacy-provider-test-actor", canWrite: false },
    workspaceId: "legacy-provider-source-workspace",
    sourceRootId: hash("disposable-source-root"),
    sourceRootPath: root,
  };

  const { setStorePath, scriptGet } = original(join(repositoryRoot, "src/knowledge/storage.ts"));
  const { parsePkmLocator, resolvePkmLocator } = original(join(repositoryRoot, "src/knowledge/knowledge-locator.ts"));
  const { ProjectStore } = original(join(repositoryRoot, "src/workflows/project-store.ts"));
  setStorePath(root);
  mkdirSync(join(root, "scripts", "Engineering"), { recursive: true });
  writeFileSync(join(root, "scripts", "Engineering", "run.py"), "print('original script')\n");
  const script = scriptGet("Engineering/run.py");
  assert.equal(script.path, "Engineering/run.py");
  assert.match(script.knowledgeId, /^script_[a-f0-9]{24}$/);
  assert.deepEqual(script.aliases, [
    `pkm://script/${script.knowledgeId}`,
    "pkm://scripts/Engineering/run.py",
  ]);

  const projectStore = new ProjectStore(join(root, ".pkm", "state"), () => "project-source-oracle", { autoMigrate: false });
  const initial = projectStore.list();
  const created = projectStore.createProject({
    commandId: "original-source-project-create",
    fingerprint: "source-oracle-project-fingerprint",
    expectedStoreVersion: initial.storeVersion,
  }, "Original source project");
  const project = created.snapshot.projects.find(item => item.projectId === created.entityId);
  assert.ok(project);

  const inventory = [
    {
      area: "scripts", relativePath: script.path, slug: script.path, title: script.file,
      knowledgeId: script.knowledgeId, aliases: script.aliases,
    },
    { area: "projects", relativePath: `${project.projectId}.json`, slug: project.projectId, title: project.name },
  ];
  const scriptLocator = `pkm://script/${script.knowledgeId}`;
  const legacyScriptLocator = "pkm://scripts/Engineering/run.py";
  const projectLocator = `pkm://projects/${project.projectId}`;
  const sourceRows = {
    scope: { workspaceId: context.workspaceId, sourceRootId: context.sourceRootId },
    scripts: [{
      relativePath: script.path,
      slug: script.path,
      title: script.file,
      sourceRevision: hash(readFileSync(join(root, "scripts", script.path))),
      knowledgeId: script.knowledgeId,
      aliases: script.aliases,
    }],
    projects: [{
      relativePath: `${project.projectId}.json`,
      slug: project.projectId,
      title: project.name,
      sourceRevision: hash(JSON.stringify(project)),
    }],
  };
  const snapshot = buildLegacyScriptProjectSnapshot(sourceRows);
  for (const locator of [scriptLocator, legacyScriptLocator, projectLocator]) {
    const originalResult = resolvePkmLocator(locator, inventory);
    const nativeResult = resolveLegacyScriptProjectLocator({ locator, snapshot }, context);
    assert.deepEqual(nativeResult.resolved, originalResult);
  }

  const mismatchPins = { scripts: "0".repeat(64), projects: snapshot.pins.projects };
  expectProviderError(
    () => resolveLegacyScriptProjectLocator({ locator: scriptLocator, snapshot, expectedPins: mismatchPins }, context),
    "SNAPSHOT_MISMATCH",
  );
  const tampered = structuredClone(snapshot);
  tampered.entries[0].title += " changed";
  expectProviderError(() => resolveLegacyScriptProjectLocator({ locator: scriptLocator, snapshot: tampered }, context), "SNAPSHOT_MISMATCH");

  for (const bad of ["pkm://scripts/%2e%2e/secrets.txt", "pkm://scripts/Engineering/%2fetc", "pkm://projects/a/extra"]) {
    assert.throws(() => parsePkmLocator(bad));
    expectProviderError(() => resolveLegacyScriptProjectLocator({ locator: bad, snapshot }, context), "invalid");
  }
  assert.throws(() => parsePkmLocator("pkm://unknown/x"), error => error.code === "unsupported");
  expectProviderError(() => resolveLegacyScriptProjectLocator({ locator: "pkm://unknown/x", snapshot }, context), "unsupported");

  const duplicateSnapshot = buildLegacyScriptProjectSnapshot({
    scope: sourceRows.scope,
    scripts: [
      ...sourceRows.scripts,
      { ...sourceRows.scripts[0], relativePath: "Other/run.py", slug: "Other/run.py" },
    ],
    projects: [
      sourceRows.projects[0],
      { ...sourceRows.projects[0], relativePath: "other-project.json" },
    ],
  });
  assert.throws(
    () => resolvePkmLocator(scriptLocator, [...inventory, { ...inventory[0], relativePath: "Other/run.py", slug: "Other/run.py" }]),
    error => error.code === "duplicate",
  );
  expectProviderError(() => resolveLegacyScriptProjectLocator({ locator: scriptLocator, snapshot: duplicateSnapshot }, context), "duplicate");
  expectProviderError(() => resolveLegacyScriptProjectLocator({ locator: projectLocator, snapshot: duplicateSnapshot }, context), "duplicate");

  mkdirSync(join(root, "notes", "Engineering", "Owner.assets"), { recursive: true });
  writeFileSync(join(root, "notes", "Engineering", "Owner.md"), "# Native asset owner\n");
  writeFileSync(join(root, "notes", "Engineering", "Owner.assets", "diagram.png"), "source asset bytes");
  const nativeDocument = readMarkdown(root, "native-owner", "Engineering/Owner.md", "notes");
  const page = readDocumentAssets(root, nativeDocument, {
    operation: "knowledge.asset.list", args: { offset: 0, limit: 2048 }, actorId: context.actor.id,
  });
  assert.equal(page.nextOffset, null);
  assert.equal(page.items.length, 1);
  const documentSha = page.documentSha256;
  const assetDigest = page.items[0].digest;
  const ownershipItems = page.items;
  const ownershipRevision = page.revision;
  const ownerSnapshot = {
    id: page.id,
    workspaceId: context.workspaceId,
    sourceRootId: context.sourceRootId,
    area: page.area,
    documentSha256: documentSha,
    revision: ownershipRevision,
    items: ownershipItems,
  };
  assert.equal(validateNativeAssetOwnership({
    snapshots: [ownerSnapshot],
    path: ownershipItems[0].path,
    expectedDocumentSha256: documentSha,
    expectedAssetDigest: assetDigest,
    expectedRevision: ownershipRevision,
  }, context).ownerId, ownerSnapshot.id);
  expectProviderError(() => validateNativeAssetOwnership({
    snapshots: [ownerSnapshot], path: "../outside.png",
    expectedDocumentSha256: documentSha, expectedAssetDigest: assetDigest, expectedRevision: ownershipRevision,
  }, context), "INVALID_ARGUMENT");
  expectProviderError(() => validateNativeAssetOwnership({
    snapshots: [ownerSnapshot, { ...ownerSnapshot, id: "other-owner" }],
    path: ownershipItems[0].path,
    expectedDocumentSha256: documentSha,
    expectedAssetDigest: assetDigest,
    expectedRevision: ownershipRevision,
  }, context), "DUPLICATE_OWNER");
  expectProviderError(() => validateNativeAssetOwnership({
    snapshots: [ownerSnapshot],
    path: ownershipItems[0].path,
    expectedDocumentSha256: "0".repeat(64),
    expectedAssetDigest: assetDigest,
    expectedRevision: ownershipRevision,
  }, context), "CONFLICT");
  const forgedOwner = structuredClone(ownerSnapshot);
  forgedOwner.items[0].digest = `sha256:${"0".repeat(64)}`;
  expectProviderError(() => validateNativeAssetOwnership({
    snapshots: [forgedOwner],
    path: ownershipItems[0].path,
    expectedDocumentSha256: documentSha,
    expectedAssetDigest: assetDigest,
    expectedRevision: ownershipRevision,
  }, context), "CONFLICT");
  writeFileSync(join(root, "notes", "Engineering", "Owner.assets", "diagram.png"), "changed native asset");
  const nextPage = readDocumentAssets(root, nativeDocument, {
    operation: "knowledge.asset.list", args: { offset: 0, limit: 2048 }, actorId: context.actor.id,
  });
  expectProviderError(() => validateNativeAssetOwnership({
    snapshots: [{ ...ownerSnapshot, revision: nextPage.revision, items: nextPage.items }],
    path: ownershipItems[0].path,
    expectedDocumentSha256: documentSha,
    expectedAssetDigest: assetDigest,
    expectedRevision: ownershipRevision,
  }, context), "CONFLICT");
  mkdirSync(join(root, "papers", "Paper.assets"), { recursive: true });
  writeFileSync(join(root, "papers", "Paper.md"), "# Research\n");
  writeFileSync(join(root, "papers", "Paper.assets", "chart.bin"), "paper chart");
  const paperDocument = readMarkdown(root, "native-paper-owner", "Paper.md", "papers");
  const paperPage = readDocumentAssets(root, paperDocument, {
    operation: "knowledge.asset.list", args: { offset: 0, limit: 2048 }, actorId: context.actor.id,
  });
  assert.equal(validateNativeAssetOwnership({
    snapshots: [{
      id: paperPage.id, workspaceId: context.workspaceId, sourceRootId: context.sourceRootId,
      area: paperPage.area, documentSha256: paperPage.documentSha256,
      revision: paperPage.revision, items: paperPage.items,
    }],
    path: paperPage.items[0].path,
    expectedDocumentSha256: paperPage.documentSha256,
    expectedAssetDigest: paperPage.items[0].digest,
    expectedRevision: paperPage.revision,
  }, context).area, "papers");

  const { previewAssetClassification, applyAssetClassification, rollbackAssetClassification } =
    original(join(repositoryRoot, "src/knowledge/asset-classification.ts"));
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "classified.md"), "---\ntitle: Oracle\n---\nOriginal source classification writer.\n", { flag: "w" });
  expectProviderError(() => readOriginalClassificationPreview(context), "PROVIDER_UNAVAILABLE");
  const checkedPreview = readOriginalClassificationPreview(context, {
    readOriginalClassificationPreview: previewAssetClassification,
  });
  const originalPreview = previewAssetClassification(root);
  assert.deepEqual(checkedPreview, originalPreview);
  assert.deepEqual(checkedPreview, originalPreview);
  assert.equal(checkedPreview.modelCalls, 0);
  const noteProposal = checkedPreview.proposals.find(item => item.asset === "notes/classified.md" && item.type === "classification");
  const scriptProposal = checkedPreview.proposals.find(item => item.asset === "scripts/Engineering/run.py" && item.type === "classification");
  assert.ok(noteProposal && scriptProposal);
  assert.equal(scriptProposal.locator, scriptLocator);

  const applied = applyAssetClassification(root, checkedPreview, [noteProposal.id, scriptProposal.id]);
  assert.deepEqual(applied.applied, [noteProposal.id, scriptProposal.id]);
  const originalJournal = JSON.parse(readFileSync(join(root, ".pkm", "state", "asset-classification", `${applied.journalId}.json`), "utf8"));
  const rollbackInput = {
    journalId: applied.journalId,
    journal: originalJournal,
    expectedJournalDigest: hash(JSON.stringify(originalJournal)),
    observations: observeTargets(root, originalJournal),
  };
  const plan = validateLegacyClassificationRollback(rollbackInput, context);
  assert.equal(plan.safeToRollback, true);
  assert.deepEqual(plan.entries.map(item => item.status), ["ready-to-restore", "ready-to-restore"]);
  const originalRollback = rollbackAssetClassification(root, applied.journalId);
  assert.equal(originalRollback.applied.length, 2);
  const changedJournal = structuredClone(originalJournal);
  changedJournal.entries[0].afterHash = hash("tampered-after-image");
  expectProviderError(() => validateLegacyClassificationRollback({
    ...rollbackInput,
    journal: changedJournal,
  }, context), "CONFLICT");
  const restoredPlan = validateLegacyClassificationRollback({
    ...rollbackInput,
    observations: observeTargets(root, originalJournal),
  }, context);
  assert.equal(restoredPlan.safeToRollback, true);
  assert.ok(restoredPlan.entries.every(item => item.status === "already-restored-or-not-written"));

  const secondPreview = previewAssetClassification(root);
  const secondNote = secondPreview.proposals.find(item => item.asset === "notes/classified.md" && item.type === "classification");
  const secondApply = applyAssetClassification(root, secondPreview, [secondNote.id]);
  const secondJournal = JSON.parse(readFileSync(join(root, ".pkm", "state", "asset-classification", `${secondApply.journalId}.json`), "utf8"));
  writeFileSync(join(root, "notes", "classified.md"), "edited after original apply");
  const stalePlan = validateLegacyClassificationRollback({
    journalId: secondApply.journalId,
    journal: secondJournal,
    expectedJournalDigest: hash(JSON.stringify(secondJournal)),
    observations: observeTargets(root, secondJournal),
  }, context);
  assert.equal(stalePlan.safeToRollback, false);
  assert.equal(stalePlan.entries[0].status, "changed-since-apply");
  assert.equal(rollbackAssetClassification(root, secondApply.journalId).skipped[0].reason, "changed-since-apply");

  const thirdPreview = previewAssetClassification(root);
  const thirdScript = thirdPreview.proposals.find(item => item.asset === "scripts/Engineering/run.py" && item.type === "classification");
  const thirdApply = applyAssetClassification(root, thirdPreview, [thirdScript.id]);
  const thirdJournal = JSON.parse(readFileSync(join(root, ".pkm", "state", "asset-classification", `${thirdApply.journalId}.json`), "utf8"));
  const target = thirdJournal.entries[0].target;
  rmSync(join(root, target));
  symlinkSync(join(root, "scripts", "Engineering", "run.py"), join(root, target));
  const symlinkPlan = validateLegacyClassificationRollback({
    journalId: thirdApply.journalId,
    journal: thirdJournal,
    expectedJournalDigest: hash(JSON.stringify(thirdJournal)),
    observations: observeTargets(root, thirdJournal),
  }, context);
  assert.equal(symlinkPlan.safeToRollback, false);
  assert.equal(symlinkPlan.entries[0].status, "unsafe-or-unavailable");
  assert.throws(() => rollbackAssetClassification(root, "invalid"), /Invalid classification journal ID/);
});
