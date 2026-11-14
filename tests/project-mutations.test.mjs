import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProjectMutation, deserializeProjectMutationPlan, planProjectMutation, projectMutationDefinitions,
  projectMutationReadDefinitions, readProjectMutationPin, recoverProjectMutation, serializeProjectMutationPlan,
} from "../dist/project-mutations.js";
import { CoreError } from "../dist/contracts.js";
import { canonicalJson, compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { deriveSystemId, safeProjectDirectoryName } from "../dist/domain/project-recipes-project-rules.js";
import { safeRecipeFileName } from "../dist/domain/project-recipes-storage-rules.js";
import { decodeMarkdown } from "../dist/markdown.js";
import { readProjectRecipes } from "../dist/project-recipes.js";

const testsDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = join(testsDirectory, ".project-mutations-fixture");
const emptyRoot = join(testsDirectory, ".project-mutations-empty");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const uuid = value => `12345678-1234-4234-8234-${String(value).padStart(12, "0")}`;
const request = (operation, args) => ({ operation, args, actorId: "test-project-mutations" });
const failWith = (action, code) => assert.throws(action, error => error instanceof CoreError && error.code === code);
const workflow = {
  schema: "pkm.workflow.definition/v1",
  spec: {
    inputs: {},
    nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {},
    completion: { requiredNodes: ["work"] },
  },
};

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function recipeRecord(recipeId, category, binding) {
  const compiled = compileWorkflowDefinitionV1(workflow);
  assert.equal(compiled.ok, true);
  const recipeRelative = `${category}/${safeRecipeFileName("Pinned Recipe", recipeId)}`;
  return {
    schema: "pkm.knowledge/v1",
    knowledgeId: `knowledge_${sha256(`recipe\0${recipeId}`).slice(0, 24)}`,
    aliases: [`recipe:${recipeId}`, `recipe:${recipeRelative}`].sort(),
    recipeId, scope: "global", category, name: "Pinned Recipe", description: "Initial",
    definition: workflow, executableDigest: compiled.executableDigest, revision: 1,
    nodeBindings: [{ nodeId: "work", bindings: [binding] }],
  };
}

async function setupWorkspace(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: uuid(99) }));
  const rootId = "root_mutations";
  const defaultProject = {
    projectId: deriveSystemId(rootId, "pkm/default-project/v1"),
    name: "Default Project", systemKind: "default-project", version: 1,
  };
  const alphaProject = {
    projectId: "project_alpha", name: "Alpha Project", version: 3,
    links: [{ kind: "chat", id: "chat_existing", linkedAt: "2026-01-01T00:00:00.000Z" }],
  };
  const defaultThread = {
    threadId: deriveSystemId(defaultProject.projectId, "pkm/general-thread/v1"),
    projectId: defaultProject.projectId, name: "General", description: "", archived: false,
    systemKind: "general-thread", legacyAliases: [], version: 1,
  };
  const alphaThread = {
    threadId: deriveSystemId(alphaProject.projectId, "pkm/general-thread/v1"),
    projectId: alphaProject.projectId, name: "General", description: "", archived: false,
    legacyAliases: [], version: 1,
  };
  for (const project of [defaultProject, alphaProject]) {
    const directoryPath = join(directory, "project", safeProjectDirectoryName(project.name, project.projectId));
    await writeJson(join(directoryPath, "project.json"), project);
    await writeJson(join(directoryPath, "threads", `${project.projectId === defaultProject.projectId ? defaultThread.threadId : alphaThread.threadId}.json`),
      project.projectId === defaultProject.projectId ? defaultThread : alphaThread);
    await mkdir(join(directoryPath, "gantt"), { recursive: true });
    await mkdir(join(directoryPath, "collaboration"), { recursive: true });
  }

  const skillRaw = "---\nname: Verify\ndescription: \"\"\ntags: []\n---\nRun tests.\n";
  await mkdir(join(directory, "skills", "Coding"), { recursive: true });
  await writeFile(join(directory, "skills", "Coding", "Verify.md"), skillRaw, "utf8");
  const document = decodeMarkdown("skill_verify", skillRaw, "Coding/Verify.md", "skills");
  const skillContent = {
    name: "Verify", description: "", category: "Coding", tags: [], content: "Run tests.\n",
  };
  const binding = {
    bindingId: "verify-binding", kind: "skill", knowledgeId: "Coding/Verify",
    contentHash: sha256(canonicalJson(skillContent)), usage: "required",
  };
  const recipe = recipeRecord("recipe_pinned", "Project/Alpha Project/Playbook", binding);
  await writeJson(join(directory, "recipes", recipe.category, safeRecipeFileName(recipe.name, recipe.recipeId)), recipe);
  return { defaultProject, alphaProject, defaultThread, alphaThread, recipe, document };
}

function snapshot(rootPath) {
  return readProjectRecipes(rootPath, request("project.list", { offset: 0, limit: 100 }));
}

async function applyAfter(rootPath, file) {
  const target = join(rootPath, ...file.relativePath.split("/"));
  if (file.afterBase64 === null) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, Buffer.from(file.afterBase64, "base64"));
}

try {
  const fixture = await setupWorkspace(root);
  await rm(emptyRoot, { recursive: true, force: true });
  await mkdir(emptyRoot, { recursive: true });
  await writeFile(join(emptyRoot, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: uuid(98) }));

  assert.deepEqual(projectMutationDefinitions.map(item => item.id), [
    "project.create", "project.update", "project.archive", "project.recipe.create", "project.recipe.update",
  ]);
  assert.ok(projectMutationDefinitions.every(item => item.readOnly === false && item.input && item.output));
  assert.equal(projectMutationDefinitions.some(item => /delete|execute|provider/i.test(item.id)), false);
  failWith(() => planProjectMutation(emptyRoot, request("project.create", {
    operationId: uuid(1), expectedSnapshotRevision: snapshot(emptyRoot).snapshotRevision,
    name: "No defaults", at: "2026-11-06T00:00:00.000Z",
  })), "CONFLICT");
  assert.equal((await snapshot(emptyRoot)).items.length, 0);
  await assert.rejects(readdir(join(emptyRoot, "project")));

  const initial = snapshot(root);
  const promotedPlan = planProjectMutation(root, request("project.create", {
    operationId: uuid(17), expectedSnapshotRevision: initial.snapshotRevision,
    name: "Ignored for existing chat", at: "2026-11-06T01:02:03.000Z",
    sources: [{ kind: "chat", id: "chat_existing" }],
  }));
  assert.equal(promotedPlan.files.length, 0);
  assert.equal(promotedPlan.result.entityId, fixture.alphaProject.projectId);
  projectMutationDefinitions[0].output.parse(promotedPlan.result);
  const createdPlan = planProjectMutation(root, request("project.create", {
    operationId: uuid(2), expectedSnapshotRevision: initial.snapshotRevision,
    name: "New Project", at: "2026-11-06T01:02:03.000Z",
  }));
  projectMutationDefinitions[0].output.parse(createdPlan.result);
  assert.equal(createdPlan.result.item.version, 1);
  assert.equal(createdPlan.files.length, 2);
  assert.equal(createdPlan.files[0].relativePath.endsWith("/project.json"), true);
  assert.equal(createdPlan.files[1].relativePath.endsWith(`/threads/${createdPlan.result.createdThread.threadId}.json`), true);
  assert.equal(recoverProjectMutation(root, deserializeProjectMutationPlan(serializeProjectMutationPlan(createdPlan))).state, "missing");
  assert.equal(createdPlan.actorId, "test-project-mutations");
  assert.equal(createdPlan.workspaceId, uuid(99));
  const wrongWorkspace = { ...createdPlan, workspaceId: uuid(98) };
  assert.equal(applyProjectMutation(root, wrongWorkspace).state, "unknown");
  failWith(() => deserializeProjectMutationPlan({ ...createdPlan, actorId: "" }), "INVALID_DOCUMENT");
  const untouchedDefault = join(root, "project", safeProjectDirectoryName(fixture.defaultProject.name, fixture.defaultProject.projectId), "project.json");
  const defaultBytes = await readFile(untouchedDefault);
  await writeFile(untouchedDefault, `${defaultBytes.toString("utf8")} `);
  assert.equal(applyProjectMutation(root, createdPlan).state, "unknown");
  await writeFile(untouchedDefault, defaultBytes);
  await applyAfter(root, createdPlan.files[0]);
  const recoveredCreate = recoverProjectMutation(root, createdPlan);
  assert.equal(recoveredCreate.state, "complete");
  assert.equal(recoveredCreate.result.entityId, createdPlan.result.entityId);
  const createdRead = readProjectRecipes(root, request("project.get", {
    id: createdPlan.result.entityId, expectedVersion: 1, snapshotRevision: snapshot(root).snapshotRevision,
  }));
  assert.deepEqual(createdRead.item, createdPlan.result.item);
  assert.deepEqual(createdRead.threads, [createdPlan.result.createdThread]);
  assert.equal(createdRead.threads[0].threadId, deriveSystemId(createdRead.item.projectId, "pkm/general-thread/v1"));
  assert.equal(snapshot(root).items.filter(item => item.systemKind === "default-project").length, 1);

  const beforeUpdate = snapshot(root);
  const alphaPath = join(root, "project", safeProjectDirectoryName(fixture.alphaProject.name, fixture.alphaProject.projectId), "project.json");
  const alphaRaw = await readFile(alphaPath);
  const updatePlan = planProjectMutation(root, request("project.update", {
    operationId: uuid(3), expectedSnapshotRevision: beforeUpdate.snapshotRevision,
    projectId: fixture.alphaProject.projectId, expectedVersion: 3, expectedSha256: sha256(alphaRaw),
    overview: { goal: "Ship safely", successCriteria: ["Review", "Test"] },
    reason: "Clarify the delivery contract", at: "2026-11-06T02:03:04.000Z",
  }));
  assert.equal(updatePlan.result.item.version, 4);
  assert.equal(updatePlan.result.item.decisions.length, 1);
  assert.deepEqual(updatePlan.result.item.decisions[0].changes.map(item => item.field), ["goal", "successCriteria"]);
  assert.equal(updatePlan.result.item.timeline.at(-1).kind, "decision");
  projectMutationDefinitions[1].output.parse(updatePlan.result);
  const alphaPin = readProjectMutationPin(root, request("project.mutation.pin", {
    entityKind: "project", id: fixture.alphaProject.projectId, snapshotRevision: beforeUpdate.snapshotRevision,
  }));
  projectMutationReadDefinitions[0].output.parse(alphaPin);
  assert.equal(alphaPin.sha256, sha256(alphaRaw));
  assert.equal(alphaPin.version, 3);
  failWith(() => planProjectMutation(root, request("project.update", {
    operationId: uuid(4), expectedSnapshotRevision: beforeUpdate.snapshotRevision,
    projectId: fixture.alphaProject.projectId, expectedVersion: 2, expectedSha256: sha256(alphaRaw),
    overview: { status: "active" }, reason: "", at: "2026-11-06T02:03:04.000Z",
  })), "CONFLICT");
  failWith(() => planProjectMutation(root, request("project.update", {
    operationId: uuid(5), expectedSnapshotRevision: beforeUpdate.snapshotRevision,
    projectId: fixture.alphaProject.projectId, expectedVersion: 3, expectedSha256: sha256(alphaRaw),
    overview: { goal: "Missing reason" }, reason: "", at: "2026-11-06T02:03:04.000Z",
  })), "INVALID_ARGUMENT");
  failWith(() => planProjectMutation(root, request("project.update", {
    operationId: uuid(12), expectedSnapshotRevision: beforeUpdate.snapshotRevision,
    projectId: fixture.alphaProject.projectId, expectedVersion: 3, expectedSha256: "0".repeat(64),
    overview: { status: "active" }, reason: "", at: "2026-11-06T02:03:04.000Z",
  })), "CONFLICT");
  failWith(() => planProjectMutation(root, request("project.update", {
    operationId: uuid(13), expectedSnapshotRevision: beforeUpdate.snapshotRevision,
    projectId: fixture.alphaProject.projectId, expectedVersion: 3, expectedSha256: sha256(alphaRaw),
    overview: { successCriteria: Array.from({ length: 101 }, () => "too many") },
    reason: "Bounded update", at: "2026-11-06T02:03:04.000Z",
  })), "INVALID_ARGUMENT");
  await applyAfter(root, updatePlan.files[0]);
  assert.equal(recoverProjectMutation(root, updatePlan).state, "complete");
  const updatedRead = readProjectRecipes(root, request("project.get", {
    id: fixture.alphaProject.projectId, expectedVersion: 4, snapshotRevision: snapshot(root).snapshotRevision,
  }));
  assert.deepEqual(updatedRead.item, updatePlan.result.item);

  const beforeRecipeCreate = snapshot(root);
  const recipeCreatePlan = planProjectMutation(root, request("project.recipe.create", {
    operationId: uuid(6), expectedSnapshotRevision: beforeRecipeCreate.snapshotRevision,
    scope: "project", projectId: fixture.alphaProject.projectId, name: "Created Recipe",
    category: "Guides/Release",
  }), [fixture.document]);
  assert.equal(recipeCreatePlan.result.item.revision, 1);
  projectMutationDefinitions[3].output.parse(recipeCreatePlan.result);
  assert.equal(recipeCreatePlan.result.item.category, "Project/Alpha Project/Guides/Release");
  assert.match(recipeCreatePlan.result.item.executableDigest, /^[a-f0-9]{64}$/);
  assert.match(recipeCreatePlan.result.item.knowledgeId, /^knowledge_[a-f0-9]{24}$/);
  assert.equal(applyProjectMutation(root, recipeCreatePlan).state, "complete");
  assert.equal(recoverProjectMutation(root, recipeCreatePlan).state, "complete");
  const createdRecipeRead = readProjectRecipes(root, request("project.recipe.get", {
    id: recipeCreatePlan.result.entityId, expectedRevision: 1,
    expectedExecutableDigest: recipeCreatePlan.result.item.executableDigest,
    snapshotRevision: snapshot(root).snapshotRevision,
  }));
  assert.deepEqual(createdRecipeRead.item, recipeCreatePlan.result.item);

  const beforeRecipeUpdate = snapshot(root);
  const originalRecipe = fixture.recipe;
  const originalRecipePath = join(root, "recipes", originalRecipe.category, safeRecipeFileName(originalRecipe.name, originalRecipe.recipeId));
  const originalRecipeRaw = await readFile(originalRecipePath);
  const recipeUpdateArgs = {
    operationId: uuid(7), expectedSnapshotRevision: beforeRecipeUpdate.snapshotRevision,
    recipeId: originalRecipe.recipeId, expectedRevision: 1,
    expectedExecutableDigest: originalRecipe.executableDigest, expectedSha256: sha256(originalRecipeRaw),
    name: "Renamed Pinned Recipe", category: "Project/Alpha Project/Published",
    description: "Updated without changing pinned content",
    definition: workflow,
  };
  const recipeUpdatePlan = planProjectMutation(root, request("project.recipe.update", recipeUpdateArgs), [fixture.document]);
  assert.equal(recipeUpdatePlan.files.length, 2);
  projectMutationDefinitions[4].output.parse(recipeUpdatePlan.result);
  assert.equal(recipeUpdatePlan.result.item.revision, 2);
  assert.equal(recipeUpdatePlan.result.item.knowledgeId, originalRecipe.knowledgeId);
  assert.equal(recipeUpdatePlan.result.item.executableDigest, originalRecipe.executableDigest);
  const skillPath = join(root, "skills", "Coding", "Verify.md");
  const skillBytes = await readFile(skillPath);
  await writeFile(skillPath, "modified\n");
  assert.equal(applyProjectMutation(root, recipeUpdatePlan, [fixture.document]).state, "unknown");
  await writeFile(skillPath, skillBytes);
  await applyAfter(root, recipeUpdatePlan.files[0]);
  const recoveredMove = recoverProjectMutation(root, recipeUpdatePlan, [fixture.document]);
  assert.equal(recoveredMove.state, "complete");
  const updatedRecipeRead = readProjectRecipes(root, request("project.recipe.get", {
    id: originalRecipe.recipeId, expectedRevision: 2,
    expectedExecutableDigest: originalRecipe.executableDigest,
    snapshotRevision: snapshot(root).snapshotRevision,
  }));
  assert.equal(updatedRecipeRead.item.name, "Renamed Pinned Recipe");
  assert.deepEqual(updatedRecipeRead.item.aliases, recipeUpdatePlan.result.item.aliases);
  assert.equal(await (async () => {
    try { await readFile(originalRecipePath); return true; } catch { return false; }
  })(), false);

  const changedBinding = structuredClone(originalRecipe.nodeBindings);
  changedBinding[0].bindings[0].contentHash = "0".repeat(64);
  const updatedRecipePath = join(root, "recipes", "Project", "Alpha Project", "Published",
    safeRecipeFileName("Renamed Pinned Recipe", originalRecipe.recipeId));
  const updatedRecipeRaw = await readFile(updatedRecipePath);
  failWith(() => planProjectMutation(root, request("project.recipe.update", {
    ...recipeUpdateArgs, operationId: uuid(8),
    expectedSnapshotRevision: snapshot(root).snapshotRevision,
    expectedRevision: 2, expectedExecutableDigest: originalRecipe.executableDigest,
    expectedSha256: sha256(updatedRecipeRaw),
    name: "Renamed Pinned Recipe", category: "Project/Alpha Project/Published",
    nodeBindings: changedBinding,
  }), [fixture.document]), "CONFLICT");
  failWith(() => planProjectMutation(root, request("project.recipe.update", {
    ...recipeUpdateArgs, operationId: uuid(14), expectedSnapshotRevision: snapshot(root).snapshotRevision,
    expectedRevision: 1,
  }), [fixture.document]), "CONFLICT");
  failWith(() => planProjectMutation(root, request("project.recipe.update", {
    ...recipeUpdateArgs, operationId: uuid(15), expectedSnapshotRevision: snapshot(root).snapshotRevision,
    expectedRevision: 2, expectedExecutableDigest: "0".repeat(64), expectedSha256: sha256(updatedRecipeRaw),
    name: "Renamed Pinned Recipe", category: "Project/Alpha Project/Published",
  }), [fixture.document]), "CONFLICT");
  failWith(() => planProjectMutation(root, request("project.recipe.update", {
    ...recipeUpdateArgs, operationId: uuid(16), expectedSnapshotRevision: snapshot(root).snapshotRevision,
    expectedRevision: 2, expectedSha256: "0".repeat(64),
    name: "Renamed Pinned Recipe", category: "Project/Alpha Project/Published",
  }), [fixture.document]), "CONFLICT");

  const afterRecipeUpdate = snapshot(root);
  const alphaLatest = await readFile(alphaPath);
  const archiveRequest = request("project.archive", {
    operationId: uuid(9), expectedSnapshotRevision: afterRecipeUpdate.snapshotRevision,
    projectId: fixture.alphaProject.projectId, expectedVersion: 4, expectedSha256: sha256(alphaLatest),
    at: "2026-11-06T03:04:05.000Z",
  });
  const archivePlan = planProjectMutation(root, archiveRequest);
  projectMutationDefinitions[2].output.parse(archivePlan.result);
  assert.equal(archivePlan.result.item.version, 5);
  assert.equal(archivePlan.result.item.archivedAt, archiveRequest.args.at);
  assert.equal(recoverProjectMutation(root, archivePlan).state, "missing");
  await applyAfter(root, archivePlan.files[0]);
  assert.equal(recoverProjectMutation(root, archivePlan).state, "complete");
  const archivedPath = join(root, "project", safeProjectDirectoryName(fixture.alphaProject.name, fixture.alphaProject.projectId), "project.json");
  await writeFile(archivedPath, "{}\n");
  assert.equal(recoverProjectMutation(root, archivePlan).state, "unknown");
  await applyAfter(root, archivePlan.files[0]);
  failWith(() => planProjectMutation(root, request("project.archive", {
    operationId: uuid(10), expectedSnapshotRevision: snapshot(root).snapshotRevision,
    projectId: fixture.defaultProject.projectId, expectedVersion: 1,
    expectedSha256: "0".repeat(64), at: "2026-11-06T03:04:05.000Z",
  })), "CONFLICT");
  await mkdir(join(root, ".pkm", "state", "recipe-runs"), { recursive: true });
  await writeFile(join(root, ".pkm", "state", "recipe-runs", "unverified.json"), "{}");
  const createdProjectFile = await readFile(join(root, "project", safeProjectDirectoryName("New Project", createdPlan.result.entityId), "project.json"));
  failWith(() => planProjectMutation(root, request("project.archive", {
    operationId: uuid(11), expectedSnapshotRevision: snapshot(root).snapshotRevision,
    projectId: createdPlan.result.entityId, expectedVersion: 1,
    expectedSha256: sha256(createdProjectFile),
    at: "2026-11-06T03:04:05.000Z",
  })), "CONFLICT");
  const tampered = structuredClone(archivePlan);
  tampered.files[0].relativePath = "../../outside.json";
  failWith(() => deserializeProjectMutationPlan(tampered), "INVALID_DOCUMENT");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(emptyRoot, { recursive: true, force: true });
}
