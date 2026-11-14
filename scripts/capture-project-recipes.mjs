import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot } from "./migration.mjs";

const repositoryRoot = resolve(packageRoot, "legacy");
const sources = {
  workflow: "src/workflows/workflow-contracts.ts",
  values: "src/workflows/value-contracts.ts",
  methodology: "src/workflows/methodology-model.ts",
  bundle: "src/workflows/project-recipe-bundle.ts",
  recipeStore: "src/workflows/recipe-filesystem-store.ts",
  projectModel: "src/workflows/project-model.ts",
  projectStore: "src/workflows/project-filesystem-store.ts",
  projectStoreApi: "src/workflows/project-store.ts",
  collaborationModel: "src/chatroom/collaboration-model.ts",
};
const sourceText = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([key, file]) => [
  key, await readFile(resolve(repositoryRoot, file), "utf8"),
])));
const hash = value => createHash("sha256").update(value).digest("hex");
const outputs = new Map();
const rewritten = (text, replacements) => {
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`Project/Recipe capture import changed: ${from}`);
    text = text.replaceAll(from, to);
  }
  return text;
};

outputs.set("src/domain/project-recipes-workflow-contracts.ts", rewritten(sourceText.workflow, [
  ['from "./value-contracts";', 'from "./project-recipes-value-contracts.js";'],
]));
outputs.set("src/domain/project-recipes-value-contracts.ts", rewritten(sourceText.values, [
  ['from "./workflow-contracts";', 'from "./project-recipes-workflow-contracts.js";'],
]));
outputs.set("src/domain/project-recipes-methodology-model.ts", rewritten(sourceText.methodology, [
  ['from "./workflow-contracts";', 'from "./project-recipes-workflow-contracts.js";'],
]));
outputs.set("src/domain/project-recipes-bundle.ts", rewritten(sourceText.bundle, [
  ['import { ProjectRecord, RecipeKnowledgeBinding, RecipeRecord } from "./project-model";',
    'import type { ProjectRecord, RecipeKnowledgeBinding, RecipeRecord } from "../project-recipes.js";'],
  ['from "./workflow-contracts";', 'from "./project-recipes-workflow-contracts.js";'],
  ['from "./methodology-model";', 'from "./project-recipes-methodology-model.js";'],
  ['  project: ProjectRecord;\n  recipes: RecipeRecord[];\n  knowledge: BundledKnowledgeContent[];',
    '  project: unknown;\n  recipes: unknown[];\n  knowledge: BundledKnowledgeContent[];'],
]));

function declarationRecords(sourceTextValue, sourcePath, names) {
  const parsed = ts.createSourceFile(sourcePath, sourceTextValue, ts.ScriptTarget.Latest, true);
  const result = [];
  for (const name of names) {
    const matches = parsed.statements.filter(statement => {
      if ("name" in statement && statement.name && ts.isIdentifier(statement.name) && statement.name.text === name) return true;
      return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name);
    });
    if (matches.length !== 1) throw new Error(`Project/Recipe capture boundary changed: ${sourcePath}#${name}`);
    result.push({ name, source: matches[0].getText(parsed) });
  }
  return result;
}
function declarations(sourceTextValue, sourcePath, names) {
  return declarationRecords(sourceTextValue, sourcePath, names).map(item => item.source).join("\n\n");
}

const recipeRules = declarations(sourceText.recipeStore, sources.recipeStore, [
  "UNCATEGORIZED_RECIPE_DIRECTORY", "validateRecipeRecord", "normalizeRecipeCategory",
  "safeRecipeCategorySegment", "safeRecipeFileName", "recipeIdFromFile", "validRecipeId",
]).replaceAll("function validateRecipeRecord(", "export function validateRecipeRecord(")
  .replaceAll("function normalizeRecipeCategory(", "export function normalizeRecipeCategory(")
  .replaceAll("function recipeIdFromFile(", "export function recipeIdFromFile(")
  .replaceAll("function validRecipeId(", "export function validRecipeId(")
  ;
outputs.set("src/domain/project-recipes-storage-rules.ts", `import { compileWorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";
import { compileRecipeMethodologyV1 } from "./project-recipes-methodology-model.js";
import type { RecipeRecord } from "../project-recipes.js";
import * as path from "node:path";

export class CapturedRecipeValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new CapturedRecipeValidationError(code, message); }
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

${recipeRules}
`);

const projectTypes = declarations(sourceText.projectModel, sources.projectModel, [
  "ProjectSystemKind", "ThreadSystemKind", "RecipeSystemKind", "RecipeKnowledgeBinding", "RecipeNodeBindings",
  "RecipeMetadataField", "RecipeMetadata", "ProjectRecord", "ProjectSourceLink", "ProjectDecision",
  "ProjectTimelineEvent", "ThreadRecord", "GanttTaskStatus", "GanttTaskOwner", "GanttTaskRecord",
  "RecipeRecord", "RecipeTrashRecord",
]);
const projectRules = [
  projectTypes,
  declarations(sourceText.projectStore, sources.projectStore, ["PROJECT_ENTITY_DIRECTORIES", "safeProjectDirectoryName"])
    .replace("const PROJECT_ENTITY_DIRECTORIES =", "export const PROJECT_ENTITY_DIRECTORIES ="),
  declarations(sourceText.projectModel, sources.projectModel, ["deriveSystemId"]),
];
outputs.set("src/domain/project-recipes-project-rules.ts", `import { createHash } from "node:crypto";
import type { WorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";
import type { RecipeMethodologyV1 } from "./project-recipes-methodology-model.js";

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

${projectRules.join("\n\n").replaceAll("export function deriveSystemId(", "export function deriveSystemId(").replaceAll("export function safeProjectDirectoryName(", "export function safeProjectDirectoryName(")}
`);

const projectFilesystemExcerptNames = [
  "PROJECT_FILESYSTEM_STORE_SCHEMA", "PROJECT_RECEIPT_LIMIT", "ProjectDomainState", "ProjectFilesystemReceipt",
  "ProjectMigrationPhase", "ProjectMigrationReceipt", "ProjectStoreControl", "MigrationMarker",
  "ProjectFilesystemSnapshot", "ProjectFilesystemMutationResult", "ProjectFilesystemCommand",
  "LegacyProjectMigrationSource", "ProjectFilesystemStoreError", "ProjectFilesystemStore",
  "safeProjectDirectoryName", "projectDomain", "toModelState", "makeControl", "compactReceipts",
  "migrationReceipt", "withoutInternalMarker", "fenceSource", "domainDigest", "sortDomain",
  "PROJECT_ENTITY_DIRECTORIES", "projectTreeFiles", "syncProjectTree", "writeProjectTree",
  "readProjectTreeAt", "readEntityDirectory", "readEntity", "safeEntityFileName", "atomicWriteJson",
  "validateReceipt", "fsyncDirectory", "TRANSIENT_FS_CODES", "fsRetryPolicy",
  "setProjectStoreFsRetryPolicyForTests", "withFsRetry", "removeWithRetry", "clone", "isRecord", "fail",
];
const projectFilesystemExcerpts = declarationRecords(sourceText.projectStore, sources.projectStore, projectFilesystemExcerptNames);
outputs.set("src/domain/project-recipes-original-project-filesystem-store.ts",
  `export const originalProjectFilesystemStoreExcerpts = ${JSON.stringify(projectFilesystemExcerpts, null, 2)} as const;\n`);

const projectStoreExcerptNames = [
  "PROJECT_STORE_SCHEMA", "ProjectStoreCommand", "ProjectSnapshot", "ProjectStoreResult",
  "RecipeRecompilePreview", "ProjectStoreOptions", "ProjectReceipt", "ProjectStorePayload",
  "ProjectStoreEnvelope", "ProjectStoreError", "ProjectStore", "makeEnvelope", "verifyEnvelope",
  "validateCommand", "digest", "isRecipeOperation", "mergeLegacyRecipeState",
  "stripLegacyRecipeState", "canonicalRecipeState", "derivedRecipeFolders", "safeLegacyRecipeName",
  "fsyncDirectory", "clone", "isRecord", "fail",
];
const projectStoreExcerpts = declarationRecords(sourceText.projectStoreApi, sources.projectStoreApi, projectStoreExcerptNames);
outputs.set("src/domain/project-recipes-original-project-store.ts",
  `export const originalProjectStoreExcerpts = ${JSON.stringify(projectStoreExcerpts, null, 2)} as const;\n`);

const collaborationDeclarations = declarations(sourceText.collaborationModel, sources.collaborationModel, [
  "CollaborationActorRole", "CollaborationPhase", "CollaborationStatus", "CollaborationAction",
  "CollaborationConvergenceState", "CollaborationWarning", "CollaborationOwnerPartition",
  "CollaborationContract", "CollaborationLinks", "CollaborationHistoryEntry", "CollaborationTaskRecord",
  "names", "texts", "ownerPartitions", "missingContractFields", "collaborationConvergenceState",
  "normalizeContract", "normalizeCollaborationTaskRecord",
]);
outputs.set("src/domain/project-recipes-collaboration-model.ts", `${collaborationDeclarations}\n`);

const sourceToOutput = [
  [sources.projectModel, "src/domain/project-recipes-project-rules.ts"],
  [sources.projectStore, "src/domain/project-recipes-project-rules.ts", ["PROJECT_ENTITY_DIRECTORIES", "safeProjectDirectoryName"]],
  [sources.projectStore, "src/domain/project-recipes-original-project-filesystem-store.ts", projectFilesystemExcerptNames],
  [sources.projectStoreApi, "src/domain/project-recipes-original-project-store.ts", projectStoreExcerptNames],
  [sources.recipeStore, "src/domain/project-recipes-storage-rules.ts"],
  [sources.workflow, "src/domain/project-recipes-workflow-contracts.ts"],
  [sources.values, "src/domain/project-recipes-value-contracts.ts"],
  [sources.methodology, "src/domain/project-recipes-methodology-model.ts"],
  [sources.bundle, "src/domain/project-recipes-bundle.ts"],
  [sources.collaborationModel, "src/domain/project-recipes-collaboration-model.ts"],
];
const records = await Promise.all(sourceToOutput.map(async ([source, captured, excerptNames]) => ({
  source,
  captured,
  ...(excerptNames ? { excerptNames } : {}),
  sourceSha256: hash(sourceText[Object.keys(sources).find(key => sources[key] === source)]),
  capturedSha256: hash(outputs.get(captured) ?? await readFile(resolve(packageRoot, captured))),
})));
const provenance = JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "Repeatably captures the original workflow/value/methodology compilers, Project Recipe bundle implementation, Collaboration task read normalizer, and exact Project identity/directory, Project filesystem-store, Project-store, and Recipe storage declarations. Original Project store excerpts are inert source text in dedicated generated capture modules; src/project-recipes.ts is a separate native read implementation and is not an original-source capture. The host-neutral adapter adds strict bounded filesystem inventory, identity checks, snapshot pinning, and read projections; no execution, provider, VS Code, storage initialization, or Knowledge Root adapter is captured.",
  files: records,
  qualification: "Project, Recipe, and bound Knowledge reads are limited to the explicit workspace root and optional caller-supplied Knowledge documents. Missing project/recipes directories are empty; malformed data and unsafe entries fail closed. Project bundle binding resolution is unavailable unless verified documents are supplied.",
}, null, 2) + "\n";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node scripts/capture-project-recipes.mjs [--check]");
}
const files = new Map([...outputs, ["migration/project-recipes-provenance.json", provenance]]);
if (args[0] === "--check") {
  for (const [file, expected] of files) {
    const actual = await readFile(resolve(packageRoot, file), "utf8");
    if (actual !== expected) throw new Error(`Project/Recipe capture is stale: ${file}`);
  }
  console.log(`Project/Recipe capture verified (${records.length} source fingerprints; no files rewritten).`);
} else {
  await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
  for (const [file, text] of files) {
    let existing;
    try { existing = await readFile(resolve(packageRoot, file), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing !== text) await writeFile(resolve(packageRoot, file), text);
  }
  console.log(`Captured ${records.length} Project/Recipe source fingerprints and ${outputs.size} generated read-only modules.`);
}
