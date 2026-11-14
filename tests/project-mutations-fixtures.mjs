import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { deriveSystemId, safeProjectDirectoryName } from "../dist/domain/project-recipes-project-rules.js";

export async function installProjectMutationTransportFixture(directory) {
  const root = resolve(directory);
  for (let current = root;; current = dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fixture workspace and ancestors must be real directories.");
    if (dirname(current) === current) break;
  }
  const markerPath = join(root, ".pkm-next-workspace");
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) throw new Error("Invalid next-workspace marker.");
  const markerBytes = await readFile(markerPath);
  const marker = JSON.parse(markerBytes.toString("utf8"));
  if (marker.schema !== "pkm.next-workspace/v2" || typeof marker.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.id)) {
    throw new Error("Fixture requires an initialized isolated workspace identity.");
  }
  const notesStat = await lstat(join(root, "notes"));
  if (!notesStat.isDirectory() || notesStat.isSymbolicLink()) throw new Error("Fixture workspace must have a real notes directory.");
  const projectId = deriveSystemId(marker.id, "pkm/default-project/v1");
  const threadId = deriveSystemId(projectId, "pkm/general-thread/v1");
  const project = { projectId, name: "Default Project", systemKind: "default-project", version: 1 };
  const thread = {
    threadId, projectId, name: "General", description: "", archived: false,
    systemKind: "general-thread", legacyAliases: [], version: 1,
  };
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const directoryPath = join(projectRoot, safeProjectDirectoryName(project.name, projectId));
  await mkdir(directoryPath);
  for (const child of ["threads", "gantt", "collaboration"]) await mkdir(join(directoryPath, child));
  await writeFile(join(directoryPath, "project.json"), `${JSON.stringify(project, null, 2)}\n`, { flag: "wx" });
  await writeFile(join(directoryPath, "threads", `${threadId}.json`), `${JSON.stringify(thread, null, 2)}\n`, { flag: "wx" });
  if (!(await readFile(markerPath)).equals(markerBytes)) throw new Error("Workspace marker changed during fixture setup.");
  return { workspaceId: marker.id, defaultProject: project, defaultThread: thread };
}

export const projectMutationFixtureOperationIds = Object.freeze({
  projectCreate: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  projectUpdate: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  recipeCreate: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  recipeUpdate: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
});

export function projectMutationFixtureRequests(snapshotRevision, projectPin, recipePin) {
  return {
    createProject: {
      operation: "project.create",
      args: {
        operationId: projectMutationFixtureOperationIds.projectCreate, expectedSnapshotRevision: snapshotRevision,
        name: "Fixture Project", at: "2026-11-06T01:00:00.000Z",
      },
    },
    ...(projectPin ? {
      updateProject: {
        operation: "project.update",
        args: {
          operationId: projectMutationFixtureOperationIds.projectUpdate,
          expectedSnapshotRevision: projectPin.snapshotRevision, projectId: projectPin.entityId,
          expectedVersion: projectPin.version, expectedSha256: projectPin.sha256,
          overview: { goal: "Fixture goal" }, reason: "Fixture decision",
          at: "2026-11-06T02:00:00.000Z",
        },
      },
      createRecipe: {
        operation: "project.recipe.create",
        args: {
          operationId: projectMutationFixtureOperationIds.recipeCreate,
          expectedSnapshotRevision: projectPin.snapshotRevision, scope: "project", projectId: projectPin.entityId,
          name: "Fixture Recipe", category: "Guides",
        },
      },
    } : {}),
    ...(recipePin ? {
      updateRecipe: {
        operation: "project.recipe.update",
        args: {
          operationId: projectMutationFixtureOperationIds.recipeUpdate,
          expectedSnapshotRevision: recipePin.snapshotRevision, recipeId: recipePin.entityId,
          expectedRevision: recipePin.version, expectedExecutableDigest: recipePin.executableDigest,
          expectedSha256: recipePin.sha256, name: "Fixture Recipe", category: "Project/Fixture Project/Guides",
          description: "Updated fixture",
          definition: {
            schema: "pkm.workflow.definition/v1",
            spec: {
              inputs: {}, nodes: [{ nodeId: "start", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
              outputs: {}, completion: { requiredNodes: ["start"] },
            },
          },
        },
      },
    } : {}),
  };
}

export const projectMutationFixtureExpected = Object.freeze({
  createdProject: { name: "Fixture Project", version: 1 },
  updatedProject: { goal: "Fixture goal", version: 2 },
  createdRecipe: { name: "Fixture Recipe", category: "Project/Fixture Project/Guides", revision: 1 },
  updatedRecipe: { description: "Updated fixture", revision: 2 },
});
