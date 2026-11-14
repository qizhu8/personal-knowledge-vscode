import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { hash, packageRoot } from "./migration.mjs";

const repositoryRoot = resolve(packageRoot, "legacy");
const sourceFiles = {
  projectModel: "src/workflows/project-model.ts",
  projectCockpit: "src/workflows/project-cockpit.ts",
  recipeStore: "src/workflows/recipe-filesystem-store.ts",
};
const testFiles = [
  "tests/test-workflow-project-model.js",
  "tests/test-project-cockpit.js",
  "tests/test-recipe-filesystem-store.js",
  "tests/test-workflow-project-store.js",
];
const sourceTexts = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([key, path]) => [
  key, await readFile(resolve(repositoryRoot, path), "utf8"),
])));

function declarations(sourceText, file, names) {
  const parsed = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const matches = parsed.statements.filter(statement => {
      if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) return statement.name.text === name;
      return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name);
    });
    if (matches.length !== 1) throw new Error(`Project mutation capture boundary changed: ${file}#${name}`);
    return matches[0].getText(parsed);
  });
}

const captured = new Map();
function sourceModule(name, sourcePath, names, imports = []) {
  const declarationsText = declarations(sourceTexts[name], sourcePath, names);
  const content = `${imports.length ? `${imports.join("\n")}\n\n` : ""}`
    + `export const capturedSourcePath = ${JSON.stringify(sourcePath)} as const;\n`
    + `export const capturedDeclarations = ${JSON.stringify(declarationsText)} as const;\n`;
  const capturedPath = `src/domain/project-mutations-original-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}.ts`;
  captured.set(capturedPath, content);
  return { source: sourcePath, captured: capturedPath, sourceSha256: hash(sourceTexts[name]), capturedSha256: hash(content) };
}

const records = [
  sourceModule("projectModel", sourceFiles.projectModel, [
    "deriveSystemId", "ensureSystemEntities", "createProject", "createRecipe", "updateRecipe", "normalizeRecipeNodeBindings",
  ]),
  sourceModule("projectCockpit", sourceFiles.projectCockpit, [
    "PROJECT_TEMPLATES", "fields", "updateProjectOverview", "projectEvent", "projectLifecycle",
  ]),
  sourceModule("recipeStore", sourceFiles.recipeStore, [
    "prepareStoredRecipe", "validateRecipeRecord", "normalizeRecipeCategory", "safeRecipeFileName",
    "recipeRelativePath", "deterministicKnowledgeId",
  ]),
];

const capturedTests = Object.fromEntries(await Promise.all(testFiles.map(async path => [
  path, await readFile(resolve(repositoryRoot, path), "utf8"),
])));
const testsPath = "src/domain/project-mutations-original-tests.ts";
const testsModule = `export const capturedOriginalMutationTests = ${JSON.stringify(capturedTests)} as const;\n`;
captured.set(testsPath, testsModule);
for (const path of testFiles) {
  records.push({
    source: path, captured: testsPath, sourceSha256: hash(capturedTests[path]), capturedSha256: hash(testsModule),
  });
}

for (const [path, content] of captured) {
  await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
  await writeFile(resolve(packageRoot, path), content);
}
await writeFile(resolve(packageRoot, "migration/project-mutations-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selects the original Project identity/create/update/archive and Recipe create/update/path/Knowledge-identity declarations into inert ESM string exports; captures the original focused Project model, Project cockpit, Recipe filesystem, and Project store tests verbatim as inert test-source strings. No captured source executes in the isolated adapter.",
  files: records,
  qualification: "Provenance records hash the actual source/test files and exact generated captures. Mutation implementation is independently tested only against disposable next-server roots and the read-only project-recipes model. Original host/store integrations, delete/execute/providers, runtime terminal-state projection, and actual Knowledge Root access are not claimed.",
}, null, 2) + "\n");
console.log(`Captured ${records.length} original Project/Recipe source and test records.`);
