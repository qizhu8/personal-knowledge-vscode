import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
export const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
export const hash = value => createHash("sha256").update(value).digest("hex");
export const host = { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
export const identity = (rootId, kind) => `${kind === "default-project" ? "project_" : "thread_"}${hash(`pkm/${kind}/v1\0${rootId}`).slice(0, 32)}`;

export async function fixture(t) {
  const parent = resolve(testsRoot, `.batch09-original-control-${randomUUID()}`);
  const source = join(parent, "source");
  await mkdir(source, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  async function file(path, data) {
    const full = join(source, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  const rootId = "root_batch09_original";
  const projectId = identity(rootId, "default-project");
  const threadId = identity(projectId, "general-thread");
  const project = { projectId, name: "Default Project", systemKind: "default-project", version: 5 };
  const thread = { threadId, projectId, name: "General", description: "", archived: false,
    systemKind: "general-thread", legacyAliases: ["legacy-general"], version: 2 };
  const projectPath = `project/Default-Project.${projectId}/project.json`;
  const recipeId = "recipe_control";
  const recipePath = `recipes/Project/Default Project/Review/Control.${recipeId}.json`;
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {}, completion: { requiredNodes: ["work"] },
  } };
  const compiled = compileWorkflowDefinitionV1(definition);
  if (!compiled.ok) throw new Error("Synthetic original Recipe did not compile.");
  const recipe = { schema: "pkm.knowledge/v1", knowledgeId: "knowledge_1234567890abcdef12345678",
    aliases: ["recipe:recipe_control"], recipeId, scope: "global", category: "Project/Default Project/Review",
    name: "Control", description: "Original", definition, executableDigest: compiled.executableDigest, revision: 7 };
  const files = {
    [projectPath]: `${JSON.stringify(project, null, 2)}\n`,
    [`project/Default-Project.${projectId}/threads/${threadId}.json`]: `${JSON.stringify(thread, null, 2)}\n`,
    [recipePath]: `${JSON.stringify(recipe, null, 2)}\n`,
  };
  for (const [path, content] of Object.entries(files)) await file(path, content);
  for (const area of ["gantt", "collaboration"]) await mkdir(join(source, `project/Default-Project.${projectId}`, area));
  await mkdir(join(source, "notes"));
  await file(".pkm/state/recipe-store.json", '{"schema":1}\n');
  const domain = { rootId, projects: [project], threads: [thread], ganttTasks: [], collaborationTasks: [] };
  const originalReceipt = {
    commandId: "original-command-opaque",
    fingerprint: "caller fingerprint is deliberately not a SHA256",
    operation: "project.update",
    storeVersion: 8,
    entityId: projectId,
  };
  const projectControl = {
    schema: 1, rootId, storeVersion: 8, receipts: [originalReceipt], canonicalDigest: hash(canonical(domain)),
  };
  const projectControlBytes = Buffer.from(`${JSON.stringify(projectControl, null, 2)}\n`);
  const recipeControlBytes = Buffer.from('{"schema":1}\n');
  await file(".pkm/state/project-store.json", projectControlBytes);
  return {
    parent, source, target: join(parent, "target"), backup: join(parent, "backup"), restored: join(parent, "restored"),
    file, rootId, projectId, threadId, project, thread, recipe, projectPath, recipePath, files, domain,
    projectControl, projectControlBytes, recipeControlBytes, originalReceipt,
  };
}

export async function hashes(source) {
  const all = {};
  async function walk(directory, prefix = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(directory, item.name), path);
      else if (item.isFile()) all[path] = hash(await readFile(join(source, path)));
      else throw new Error("Synthetic source contains an unsupported entry");
    }
  }
  await walk(source);
  return all;
}
