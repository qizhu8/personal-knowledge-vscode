import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { CoreError } from "./contracts.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";
import { verifyOriginalMcpOptionalSchemaGroup } from "./original-mcp-sqlite-schema.js";

type Schema = Array<Record<string, SQLOutputValue>>;
const digest = /^[a-f0-9]{64}$/;
function fail(message: string): never { throw new CoreError("RECOVERY_REQUIRED", message); }

/** Closed historical metadata, never live source consent, execution authority or recovery permission. */
async function readHistoricalSchema(database: DatabaseSync, schema: Schema,
  journal: OriginalMcpJournal | undefined) {
  const verified = new Set<string>();
  const present = (names: readonly string[]) => schema.some(row => names.includes(String(row.tbl_name)));
  const group = (ddl: string, names: readonly string[]) => {
    if (!present(names)) return false;
    if (!journal) fail("Historical native source metadata requires its exact original custody.");
    for (const name of verifyOriginalMcpOptionalSchemaGroup(schema, ddl, [...names])) verified.add(name);
    return true;
  };
  const action = await import("./original-mcp-action-historical-schema.js");
  const actualSchema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  const projectedNames = new Set(schema.map(row => String(row.name)));
  for (const name of action.verifyOriginalMcpActionAuthoringReadSchema(journal?.plan.root ?? "", database, actualSchema, journal))
    if (projectedNames.has(name)) verified.add(name);
  const learningNames = ["legacy_original_learning_heads", "legacy_original_learning_versions",
    "legacy_original_learning_receipts", "legacy_original_learning_genesis"];
  if (present(learningNames)) {
    const learning = await import("./legacy-retrieval-learning.js");
    for (const item of learning.legacyRetrievalLearningOptionalSchemaGroups) group(item.ddl, item.tables);
    learning.verifyLegacyRetrievalLearning(database, journal!.workspaceId);
    const expected = createHash("sha256").update(JSON.stringify([journal!.workspaceId, "mcp:external"])).digest("hex");
    if (database.prepare("SELECT 1 FROM legacy_original_learning_heads WHERE namespace<>? LIMIT 1").get(expected)
      || database.prepare("SELECT 1 FROM legacy_original_learning_receipts WHERE actor_id<>'mcp:external' LIMIT 1").get())
      fail("Historical original learning belongs to another public actor namespace.");
  }
  if (present(["original_recipe_usage_rows", "original_recipe_usage_admission"])) {
    const usage = await import("./original-mcp-recipe-usage.js");
    group(usage.originalMcpRecipeUsageDdl, ["original_recipe_usage_rows", "original_recipe_usage_admission"]);
    await usage.verifyOriginalMcpRecipeUsageReadState(database, journal!);
  }
  if (present(["original_recipe_terminal_sources"])) {
    const terminal = await import("./original-mcp-recipe-terminal.js");
    group(terminal.originalMcpRecipeTerminalDdl, ["original_recipe_terminal_sources"]);
    await terminal.verifyOriginalMcpRecipeTerminalReadState(database, journal!);
  }
  let library: Awaited<ReturnType<typeof import("./original-mcp-recipe-library.js")["verifyOriginalMcpRecipeLibraryReadState"]>> | undefined;
  if (present(["original_recipe_library_source"])) {
    const source = await import("./original-mcp-recipe-library.js");
    group(source.originalMcpRecipeLibraryDdl, ["original_recipe_library_source"]);
    library = await source.verifyOriginalMcpRecipeLibraryReadState(database, journal!);
  }
  let nativeLibrary: Awaited<ReturnType<typeof import("./original-mcp-recipe-authoring.js")["verifyOriginalMcpNativeRecipeLibraryReadState"]>> = [];
  const libraryNames = ["native_recipe_library_records", "native_recipe_library_receipts"];
  if (present(libraryNames)) {
    const native = await import("./native-recipe-library.js");
    group(native.nativeRecipeLibraryDdl, libraryNames);
    const author = await import("./original-mcp-recipe-authoring.js");
    nativeLibrary = await author.verifyOriginalMcpNativeRecipeLibraryReadState(database, journal!);
  }
  const lazyNames = ["legacy_recipe_lazy_runs", "legacy_recipe_lazy_receipts"];
  if (present(lazyNames)) {
    const lazy = await import("./legacy-recipe-lazy-runtime.js");
    group(lazy.legacyRecipeLazyDdl, lazyNames);
    const runs = database.prepare("SELECT * FROM legacy_recipe_lazy_runs LIMIT 4097").all();
    const receipts = database.prepare("SELECT * FROM legacy_recipe_lazy_receipts LIMIT 16385").all();
    if (runs.length > 4096 || receipts.length > 16384) fail("Historical lazy Recipe state exceeds its bounded envelope.");
    const ids = new Set<string>();
    const libraries = [...(library ? [library] : []), ...nativeLibrary].flatMap(item => [
      { source: item.source, recipeId: item.source.recipeId, revision: item.source.revision,
        executableDigest: item.source.executableDigest },
      ...("recipes" in item ? item.recipes.filter(recipe => recipe.recipeId !== item.source.recipeId).map(recipe => {
        const pin = item.source.reachableRecipes?.find(value => value.recipeId === recipe.recipeId
          && value.revision === recipe.revision && value.executableDigest === recipe.executableDigest);
        if (!pin) fail("Historical child Recipe lost its exact reachable source witness.");
        return { source: item.source, recipeId: pin.recipeId, revision: pin.revision, executableDigest: pin.executableDigest };
      }) : []),
    ]);
    const { originalDigest } = await import("./domain/action-compiler-validation.js");
    for (const row of runs) {
      const run = lazy.parseLegacyRecipeLazyRun(String(row.record));
      const selected = libraries.find(item => run.recipeId === item.recipeId && run.revision === item.revision
        && run.executableDigest === item.executableDigest
        && row.binding === originalDigest({ root: journal!.plan.root, workspaceId: journal!.workspaceId,
          source: item.source.planSha256, actorId: "mcp:external" }));
      if (!selected || row.actor_id !== "mcp:external" || row.run_id !== run.runId || row.version !== run.version)
        fail("Historical lazy Recipe state lost its exact actor/source/definition/version binding.");
      ids.add(run.runId);
    }
    for (const row of receipts) {
      if (row.actor_id !== "mcp:external" || !ids.has(String(row.run_id))
        || typeof row.command_id !== "string" || !row.command_id.trim() || !digest.test(String(row.fingerprint)))
        fail("Historical lazy Recipe receipt is orphaned or foreign.");
      if (row.response !== null) {
        const response = JSON.parse(String(row.response));
        if (!response || response.schema !== "pkm.recipe.api/v1" || typeof response.ok !== "boolean")
          fail("Historical lazy Recipe response is malformed.");
      }
    }
  }
  return verified;
}
export async function verifyOriginalMcpHistoricalReadSchema(database: DatabaseSync, schema: Schema,
  journal: OriginalMcpJournal | undefined) {
  try { return await readHistoricalSchema(database, schema, journal); }
  catch (error) {
    if (error instanceof CoreError && error.code === "RECOVERY_REQUIRED") throw error;
    throw new CoreError("RECOVERY_REQUIRED", "Historical native source metadata failed its exact production reader; preserve it for offline reconciliation.", "unknown");
  }
}
