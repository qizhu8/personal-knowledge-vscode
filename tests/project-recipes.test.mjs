import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_RECIPE_LIMITS, buildProjectRecipeKnowledge, projectRecipeDefinitions, readProjectRecipes, readProjectRecipeSnapshot,
} from "../dist/project-recipes.js";
import { CoreError } from "../dist/contracts.js";
import {
  canonicalJson, compileWorkflowDefinitionV1,
} from "../dist/domain/project-recipes-workflow-contracts.js";
import { deriveSystemId, safeProjectDirectoryName } from "../dist/domain/project-recipes-project-rules.js";
import { safeRecipeFileName } from "../dist/domain/project-recipes-storage-rules.js";
import { decodeMarkdown } from "../dist/markdown.js";

const testsDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = join(testsDirectory, ".project-recipes-fixture");
const limitsRoot = join(testsDirectory, ".project-recipes-limits");
const request = (operation, args = {}) => ({ operation, args, actorId: "test-reader" });
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const failWith = (action, code) => assert.throws(action, error => error instanceof CoreError && error.code === code);
const workflow = {
  schema: "pkm.workflow.definition/v1",
  spec: {
    inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {}, completion: { requiredNodes: ["work"] },
  },
};

function recipeRecord(recipeId, name, category, bindings = []) {
  const compiled = compileWorkflowDefinitionV1(workflow);
  assert.equal(compiled.ok, true);
  return {
    schema: "pkm.knowledge/v1",
    knowledgeId: `knowledge_${sha256(recipeId).slice(0, 24)}`,
    aliases: [`recipe:${recipeId}`],
    recipeId, scope: "global", category, name, description: `${name} description`,
    definition: workflow, executableDigest: compiled.executableDigest, revision: 1,
    ...(bindings.length ? { nodeBindings: [{ nodeId: "work", bindings }] } : {}),
  };
}

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function makeWorkspace(directory) {
  await rm(directory, { recursive: true, force: true });
  const rootId = "root_fixture";
  const defaultProjectId = deriveSystemId(rootId, "pkm/default-project/v1");
  const defaultProject = {
    projectId: defaultProjectId, name: "Default Project", systemKind: "default-project", version: 1,
  };
  const defaultThread = {
    threadId: deriveSystemId(defaultProjectId, "pkm/general-thread/v1"), projectId: defaultProjectId,
    name: "General", description: "", archived: false, systemKind: "general-thread", legacyAliases: [], version: 1,
  };
  const alphaProject = { projectId: "project_alpha", name: "Alpha Project", version: 3, status: "active" };
  const alphaThread = {
    threadId: "thread_alpha", projectId: "project_alpha", name: "General", description: "",
    archived: false, legacyAliases: [], version: 1,
  };
  const task = {
    taskId: "task_alpha", projectId: "project_alpha", threadId: "thread_alpha", title: "Verify migration",
    startDate: "2026-01-02", endDate: "2026-01-03", progress: 10, status: "in-progress",
    owners: [{ name: "Ada", role: "Reviewer" }], dependencyIds: [], version: 1,
  };
  const collaboration = {
    collaborationId: "collab_alpha", title: "Review migration", projectId: "project_alpha",
    threadId: "thread_alpha", ganttTaskId: "task_alpha", version: 1, status: "assigned",
    phase: "assignment", lead: "Ada", owners: ["Ada"], reviewers: [], expectedResponders: [],
    primaryOwner: "Ada", acceptanceCriteria: [], decisionRequired: false, evidenceLinks: [],
    blockedWaitingOn: [], completionClaim: false, ownerPartitions: [], resolvedResponders: [],
    reviewerApprovals: [], expectedReviewers: [], warnings: [], history: [],
    convergenceState: "contract-incomplete",
  };
  for (const project of [defaultProject, alphaProject]) {
    const projectDirectory = join(directory, "project", safeProjectDirectoryName(project.name, project.projectId));
    await writeJson(join(projectDirectory, "project.json"), project);
    for (const child of ["threads", "gantt", "collaboration"]) await mkdir(join(projectDirectory, child), { recursive: true });
    const threads = project.projectId === defaultProjectId ? [defaultThread] : [alphaThread];
    for (const thread of threads) await writeJson(join(projectDirectory, "threads", `${thread.threadId}.json`), thread);
    if (project.projectId === "project_alpha") {
      await writeJson(join(projectDirectory, "gantt", `${task.taskId}.json`), task);
      await writeJson(join(projectDirectory, "collaboration", `${collaboration.collaborationId}.json`), collaboration);
    }
  }
  const skill = {
    knowledgeId: "Coding/Verify", kind: "skill", contentHash: "",
    document: { name: "Verify", description: "", category: "Coding", tags: [], content: "Run tests.\n" },
  };
  const note = {
    knowledgeId: "Projects/Release", kind: "note", contentHash: "",
    document: { title: "Release", type: "general", category: "Projects", tags: [], content: "No publishing.\n" },
  };
  skill.contentHash = sha256(canonicalJson(skill.document));
  note.contentHash = sha256(canonicalJson(note.document));
  const skillRaw = "---\nname: Verify\ndescription: \"\"\ntags: []\n---\nRun tests.\n";
  const noteRaw = "---\ntitle: Release\ntype: general\ntags: []\n---\nNo publishing.\n";
  await mkdir(join(directory, "skills", "Coding"), { recursive: true });
  await mkdir(join(directory, "notes", "Projects"), { recursive: true });
  await writeFile(join(directory, "skills", "Coding", "Verify.md"), skillRaw, "utf8");
  await writeFile(join(directory, "notes", "Projects", "Release.md"), noteRaw, "utf8");
  const markdownDocuments = [
    decodeMarkdown("skill_verify", skillRaw, "Coding/Verify.md", "skills"),
    decodeMarkdown("note_release", noteRaw, "Projects/Release.md", "notes"),
  ];
  const category = "Project/Alpha Project/Design";
  const recipe = recipeRecord("recipe_alpha", "Verification Recipe", category, [
    { bindingId: "verify-skill", kind: "skill", knowledgeId: skill.knowledgeId, contentHash: skill.contentHash, usage: "required" },
    { bindingId: "release-note", kind: "note", knowledgeId: note.knowledgeId, contentHash: note.contentHash, usage: "reference" },
  ]);
  const unbound = recipeRecord("recipe_beta", "Unbound Recipe", category);
  for (const entry of [recipe, unbound]) {
    const file = join(directory, "recipes", category, safeRecipeFileName(entry.name, entry.recipeId));
    await writeJson(file, entry);
  }
  return { defaultProject, alphaProject, alphaThread, task, collaboration, recipe, skill, note, markdownDocuments };
}

try {
  await rm(root, { recursive: true, force: true });
  await rm(limitsRoot, { recursive: true, force: true });
  const fixture = await makeWorkspace(root);
  const definitionIds = projectRecipeDefinitions.map(definition => definition.id);
  assert.deepEqual(definitionIds, [
    "project.list", "project.get", "project.recipe.list", "project.recipe.get", "project.recipe.bundle.get",
  ]);
  for (const definition of projectRecipeDefinitions) {
    assert.equal(typeof definition.description, "string");
    assert.equal(definition.readOnly, true);
    assert.ok(definition.input && definition.output);
  }
  assert.deepEqual(projectRecipeDefinitions[0].input.parse({}), { offset: 0, limit: 20 });

  const projectPage = readProjectRecipes(root, request("project.list", { offset: 0, limit: 1 }));
  const recipeSnapshot = readProjectRecipeSnapshot(root);
  assert.equal(recipeSnapshot.snapshotRevision, projectPage.snapshotRevision);
  assert.deepEqual(recipeSnapshot.recipes.find(recipe => recipe.recipeId === fixture.recipe.recipeId),
    readProjectRecipes(root, request("project.recipe.get", { id: fixture.recipe.recipeId })).item);
  assert.deepEqual(projectRecipeDefinitions[0].output.parse(projectPage), projectPage);
  assert.equal(projectPage.items.length, 1);
  assert.equal(projectPage.total, 2);
  assert.equal(projectPage.nextOffset, 1);
  const nextProjectPage = readProjectRecipes(root, request("project.list", {
    offset: projectPage.nextOffset, limit: 1, snapshotRevision: projectPage.snapshotRevision,
  }));
  assert.equal(nextProjectPage.items.length, 1);
  assert.equal(nextProjectPage.nextOffset, null);
  failWith(() => readProjectRecipes(root, request("project.list", { snapshotRevision: "0".repeat(64) })), "CONFLICT");

  const projectResult = readProjectRecipes(root, request("project.get", {
    id: "project_alpha", expectedVersion: fixture.alphaProject.version,
  }));
  assert.deepEqual(projectRecipeDefinitions[1].output.parse(projectResult), projectResult);
  assert.equal(projectResult.item.projectId, "project_alpha");
  assert.equal(projectResult.threads[0].threadId, "thread_alpha");
  assert.equal(projectResult.ganttTasks[0].taskId, "task_alpha");
  assert.equal(projectResult.collaborationTasks[0].collaborationId, "collab_alpha");
  failWith(() => readProjectRecipes(root, request("project.get", { id: "project_alpha", expectedVersion: 2 })), "CONFLICT");

  const recipePage = readProjectRecipes(root, request("project.recipe.list", {
    projectId: "project_alpha", offset: 0, limit: 1,
  }));
  assert.deepEqual(projectRecipeDefinitions[2].output.parse(recipePage), recipePage);
  assert.equal(recipePage.total, 2);
  assert.equal(recipePage.nextOffset, 1);
  assert.equal(recipePage.items[0].recipeId, "recipe_alpha");
  const recipeResult = readProjectRecipes(root, request("project.recipe.get", {
    id: "recipe_alpha", expectedRevision: 1, expectedExecutableDigest: fixture.recipe.executableDigest,
  }));
  assert.deepEqual(projectRecipeDefinitions[3].output.parse(recipeResult), recipeResult);
  assert.equal(recipeResult.item.recipeId, "recipe_alpha");
  assert.equal(recipeResult.item.nodeBindings[0].bindings.length, 2);
  failWith(() => readProjectRecipes(root, request("project.recipe.get", {
    id: "recipe_alpha", expectedRevision: 2,
  })), "CONFLICT");
  failWith(() => readProjectRecipes(root, request("project.recipe.get", {
    id: "recipe_alpha", expectedExecutableDigest: "0".repeat(64),
  })), "CONFLICT");

  failWith(() => readProjectRecipes(root, request("project.recipe.bundle.get", { projectId: "project_alpha" })), "NOT_FOUND");
  const builtKnowledge = buildProjectRecipeKnowledge(root, fixture.markdownDocuments, [fixture.recipe]);
  assert.deepEqual(builtKnowledge.map(item => item.knowledgeId), ["Coding/Verify", "Projects/Release"]);
  assert.equal(builtKnowledge.find(item => item.kind === "skill").contentHash, fixture.skill.contentHash);
  assert.equal(builtKnowledge.find(item => item.kind === "note").contentHash, fixture.note.contentHash);
  const bundleResult = readProjectRecipes(root, request("project.recipe.bundle.get", {
    projectId: "project_alpha", exportedAt: "2026-11-06T00:00:00.000Z",
  }), fixture.markdownDocuments);
  assert.equal(bundleResult.item.schema, "pkm.project-recipe-bundle/v1");
  assert.equal(bundleResult.item.project.projectId, "project_alpha");
  assert.equal(bundleResult.item.recipes.length, 2);
  assert.deepEqual(bundleResult.item.knowledge.map(item => item.knowledgeId), ["Coding/Verify", "Projects/Release"]);
  assert.deepEqual(projectRecipeDefinitions[4].output.parse(bundleResult), bundleResult);
  const changedNote = {
    ...fixture.markdownDocuments[1],
    record: { ...fixture.markdownDocuments[1].record, content: "changed body\n" },
  };
  assert.equal(buildProjectRecipeKnowledge(root, [fixture.markdownDocuments[0], changedNote], [fixture.recipe])
    .find(item => item.kind === "note").contentHash, fixture.note.contentHash,
  "bundle reads revalidated Markdown content instead of trusting caller-supplied record metadata");
  failWith(() => buildProjectRecipeKnowledge(root, fixture.markdownDocuments, [{
    nodeBindings: [{ nodeId: "work", bindings: [{
      ...fixture.recipe.nodeBindings[0].bindings[0], contentHash: "0".repeat(64),
    }] }],
  }]), "CONFLICT");

  const before = await Promise.all([readdir(root), readFile(join(root, "recipes", "Project", "Alpha Project", "Design", safeRecipeFileName(fixture.recipe.name, fixture.recipe.recipeId)))]);
  failWith(() => readProjectRecipes(root, request("project.get", { id: "../escape" })), "INVALID_ARGUMENT");
  assert.deepEqual(await readdir(root), before[0]);
  assert.deepEqual(await readFile(join(root, "recipes", "Project", "Alpha Project", "Design", safeRecipeFileName(fixture.recipe.name, fixture.recipe.recipeId))), before[1]);

  const invalidRoot = join(root, "invalid-schema-workspace");
  await mkdir(join(invalidRoot, "project", "bad.project_bad"), { recursive: true });
  await writeJson(join(invalidRoot, "project", "bad.project_bad", "project.json"), {
    projectId: "project_bad", name: "Bad", version: 1, unexpected: true,
  });
  failWith(() => readProjectRecipes(invalidRoot, request("project.list")), "INVALID_DOCUMENT");
  const invalidRecipeRoot = join(root, "invalid-recipe-workspace");
  await mkdir(join(invalidRecipeRoot, "recipes", "Uncategorized"), { recursive: true });
  await writeJson(join(invalidRecipeRoot, "recipes", "Uncategorized", "Bad.recipe_bad.json"), {
    ...recipeRecord("recipe_bad", "Bad", ""), unreviewed: true,
  });
  failWith(() => readProjectRecipes(invalidRecipeRoot, request("project.recipe.list")), "INVALID_DOCUMENT");

  const missingRoot = join(root, "absent-directories");
  await mkdir(missingRoot, { recursive: true });
  const entriesBeforeMissingRead = await readdir(missingRoot);
  const absent = readProjectRecipes(missingRoot, request("project.list"));
  assert.deepEqual(absent.items, []);
  assert.deepEqual(absent.total, 0);
  assert.deepEqual(await readdir(missingRoot), entriesBeforeMissingRead);
  assert.equal(await exists(join(missingRoot, "project")), false);
  assert.equal(await exists(join(missingRoot, "recipes")), false);

  const unsafeRoot = join(root, "unsafe-workspace");
  await mkdir(join(unsafeRoot, "recipes"), { recursive: true });
  await symlink(join(root, "recipes", "Project"), join(unsafeRoot, "recipes", "linked"));
  failWith(() => readProjectRecipes(unsafeRoot, request("project.recipe.list")), "INVALID_DOCUMENT");

  const invalidUtf8Root = join(root, "invalid-utf8");
  const invalidUtf8File = join(invalidUtf8Root, "recipes", "Uncategorized", "Bad.recipe_bad.json");
  await mkdir(join(invalidUtf8Root, "recipes", "Uncategorized"), { recursive: true });
  await writeFile(invalidUtf8File, Buffer.from([0xc3, 0x28]));
  failWith(() => readProjectRecipes(invalidUtf8Root, request("project.recipe.list")), "INVALID_DOCUMENT");

  const changedRoot = join(root, "changed-snapshot");
  const changedFixture = await makeWorkspace(changedRoot);
  const pinnedList = readProjectRecipes(changedRoot, request("project.recipe.list", { limit: 1 }));
  const changedRecipePath = join(changedRoot, "recipes", "Project", "Alpha Project", "Design",
    safeRecipeFileName(changedFixture.recipe.name, changedFixture.recipe.recipeId));
  await writeFile(changedRecipePath, `${await readFile(changedRecipePath, "utf8")} `);
  failWith(() => readProjectRecipes(changedRoot, request("project.recipe.list", {
    limit: 1, snapshotRevision: pinnedList.snapshotRevision,
  })), "CONFLICT");

  const exactRoot = join(root, "exact-file-limit");
  const exactFixture = await makeWorkspace(exactRoot);
  const defaultDirectory = join(exactRoot, "project", safeProjectDirectoryName(exactFixture.defaultProject.name, exactFixture.defaultProject.projectId));
  const defaultPath = join(defaultDirectory, "project.json");
  const defaultText = JSON.stringify(exactFixture.defaultProject);
  await writeFile(defaultPath, `${defaultText}${" ".repeat(PROJECT_RECIPE_LIMITS.fileBytes - Buffer.byteLength(defaultText))}`);
  const exactLimitRead = readProjectRecipes(exactRoot, request("project.list"));
  assert.equal(exactLimitRead.items.length, 2, "exact per-file byte limit is accepted");
  await writeFile(defaultPath, `${await readFile(defaultPath, "utf8")} `);
  failWith(() => readProjectRecipes(exactRoot, request("project.list")), "RESOURCE_LIMIT");

  await mkdir(limitsRoot, { recursive: true });
  for (let index = 0; index < 17; index++) {
    const id = `project_bound_${index}`;
    const directory = join(limitsRoot, "project", `bound.${id}`);
    await mkdir(directory, { recursive: true });
    const text = JSON.stringify({ projectId: id, name: `Bound ${index}`, version: 1 });
    await writeFile(join(directory, "project.json"), `${text}${" ".repeat(PROJECT_RECIPE_LIMITS.fileBytes - Buffer.byteLength(text))}`);
  }
  failWith(() => readProjectRecipes(limitsRoot, request("project.list")), "RESOURCE_LIMIT");

  console.log("Project/Recipe read model: captured layouts, strict validation, pins, bundles, no-write absence and exact limits OK");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(limitsRoot, { recursive: true, force: true });
}

async function exists(path) {
  try { await readFile(path); return true; }
  catch { try { await readdir(path); return true; } catch { return false; } }
}
