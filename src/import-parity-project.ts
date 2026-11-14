import { basename } from "node:path";
import { buildProjectRecipeKnowledge, readProjectRecipes, type RecipeRecord } from "./project-recipes.js";
import { safeRecipeFileName } from "./domain/project-recipes-storage-rules.js";
import { scanMarkdown } from "./markdown.js";
import type { ProjectRecipeExportSummary } from "./legacy-control-import.js";

type Entry = { source: string; kind: string; size?: number };

/**
 * Validate a control-free, quiescent export of the original canonical trees.
 * The legacy .pkm control/receipt state is deliberately not accepted here.
 */
export function validateProjectRecipeExport(root: string, entries: readonly Entry[]): ProjectRecipeExportSummary {
  const paths = new Set<string>();
  const files = entries.filter(entry => entry.kind !== "directory");
  for (const entry of entries) {
    const parts = entry.source.split("/");
    if (parts.some((part, index) => (part.startsWith(".")
      && !(parts[0] === "recipes" && index === 1 && part === ".trash"))
      || !part || part === ".." || part.includes("\\") || part.includes(":"))) {
      throw new Error(`Unsupported Project/Recipe path: ${entry.source}`);
    }
    const portable = entry.source.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(portable)) throw new Error(`Colliding Project/Recipe path: ${entry.source}`);
    paths.add(portable);
    if (parts[0] === "project") {
      const valid = parts.length === 1 && entry.kind === "directory"
        || parts.length === 2 && entry.kind === "directory"
        || parts.length === 3 && (entry.kind === "directory" && ["threads", "gantt", "collaboration"].includes(parts[2]!)
          || entry.kind !== "directory" && parts[2] === "project.json")
        || parts.length === 4 && entry.kind !== "directory" && ["threads", "gantt", "collaboration"].includes(parts[2]!)
          && /^[A-Za-z][A-Za-z0-9._-]{0,127}\.json$/.test(parts[3]!);
      if (!valid) throw new Error(`Unsupported Project entry: ${entry.source}`);
    } else if (parts[0] === "recipes") {
      if (parts[1] === ".trash" && !(parts.length === 2 && entry.kind === "directory"
        || parts.length === 3 && entry.kind !== "directory" && parts[2]!.endsWith(".json"))) {
        throw new Error(`Unsupported Recipe trash entry: ${entry.source}`);
      }
      if (entry.kind !== "directory" && (!parts.at(-1)!.endsWith(".json") || parts.length < 3)) {
        throw new Error(`Unsupported Recipe entry: ${entry.source}`);
      }
    } else throw new Error("Unexpected Project/Recipe area.");
  }
  if (files.some(entry => entry.size === undefined || entry.size > 2 * 1024 * 1024)) throw new Error("Project/Recipe file exceeds the read limit.");
  const request = (operation: string, args: Record<string, unknown>) =>
    readProjectRecipes(root, { operation, args, actorId: "legacy-import-validation" }, undefined,
      { originalRecipeInventory: false }) as any;
  const projects = request("project.list", { offset: 0, limit: 100 });
  const recipes: RecipeRecord[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = request("project.recipe.list", { offset, limit: 100, snapshotRevision: projects.snapshotRevision });
    for (const item of page.items) {
      const recipe = request("project.recipe.get", { id: item.recipeId, snapshotRevision: projects.snapshotRevision }).item as RecipeRecord;
      recipes.push(recipe);
      const matches = files.filter(entry => entry.source.startsWith("recipes/") && basename(entry.source) === safeRecipeFileName(recipe.name, recipe.recipeId));
      if (matches.length !== 1) throw new Error(`Recipe filename is not canonical: ${recipe.recipeId}`);
    }
    offset = page.nextOffset;
  }
  const projectRecords: Array<Record<string, unknown>> = [];
  const threads: Array<Record<string, unknown>> = [];
  const ganttTasks: Array<Record<string, unknown>> = [];
  const collaborationTasks: Array<Record<string, unknown>> = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = request("project.list", { offset, limit: 100, snapshotRevision: projects.snapshotRevision });
    for (const item of page.items) {
      const project = request("project.get", { id: item.projectId, snapshotRevision: projects.snapshotRevision });
      projectRecords.push(project.item);
      threads.push(...project.threads);
      ganttTasks.push(...project.ganttTasks);
      collaborationTasks.push(...project.collaborationTasks);
      for (const [directory, values, field] of [
        ["threads", project.threads, "threadId"], ["gantt", project.ganttTasks, "taskId"],
        ["collaboration", project.collaborationTasks, "collaborationId"],
      ] as const) {
        for (const value of values) {
          const suffix = `/${directory}/${value[field]}.json`;
          if (files.filter(entry => entry.source.startsWith("project/") && entry.source.endsWith(suffix)).length !== 1) {
            throw new Error(`Project entity filename does not match ${field}.`);
          }
        }
      }
    }
    offset = page.nextOffset;
  }
  if (recipes.some(recipe => recipe.nodeBindings?.some(node => node.bindings.length))) {
    buildProjectRecipeKnowledge(root, scanMarkdown(root), recipes);
  }
  return {
    projects: projectRecords,
    threads,
    ganttTasks,
    collaborationTasks,
    recipes: recipes as unknown as Array<Record<string, unknown>>,
  };
}
