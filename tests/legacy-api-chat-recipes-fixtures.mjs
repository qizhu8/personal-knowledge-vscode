import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const dist = process.env.PKM_TEST_RECIPE_DIST;
export const load = name => import(dist ? pathToFileURL(path.join(dist, `${name}.js`)).href
  : new URL(`../dist/${name}.js`, import.meta.url).href);
const hash = value => createHash("sha256").update(value).digest("hex");
export function prepare() {
  const extension = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, "package.json")));
  if (manifest.version !== "4.0.22" || `${manifest.publisher}.${manifest.name}`.toLowerCase() !== "uone.personal-knowledge")
    throw new Error("Actual old VSIX required.");
  const base = path.resolve(`.migration-test-work/recipe-executor-${randomUUID()}`);
  const fixture = path.join(base, "original"), root = path.join(fixture, "knowledge");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(fixture, "workspace"), { mode: 0o700 });
  const nonce = randomUUID();
  fs.writeFileSync(path.join(fixture, "native-ui-fixture-token"), nonce, { mode: 0o600 });
  const evidence = require("../legacy/tests/next-trial-electron/legacy-recipe-fixture.cjs").create({ extension, root, fixture });
  const nativeRoot = path.join(base, "native-knowledge");
  return { base, fixture, nonce, originalRoot: root, root: nativeRoot, evidence, actorId: randomUUID(),
    chatId: randomUUID(), sourceFingerprint: hash(randomUUID()) };
}
export function capture(root) {
  const records = {};
  const walk = relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file, { bigint: true });
    records[relative] = [String(stat.dev), String(stat.ino), String(stat.mode), String(stat.uid), String(stat.gid),
      String(stat.mtimeNs), String(stat.ctimeNs), stat.isFile() ? hash(fs.readFileSync(file)) : null];
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
  };
  walk("");
  return records;
}
export async function open(prepared, { authorize, onHeld, library = false, publicApi = false, libraryFault, lazy = false,
  knowledgeDocuments, recipeAdapters, beforeStorageOpen, knowledgeDocumentIds, externalReports } = {}) {
  const { Storage, initialize } = await load("storage");
  const { createNativeRuntime } = await load("native-runtime");
  const { LegacyApiChatRecipes } = await load("legacy-api-chat-recipes");
  const { canonicalJson, compileWorkflowDefinitionV1 } = await load("domain/project-recipes-workflow-contracts");
  const compile = compileWorkflowDefinitionV1(prepared.evidence.definition);
  if (!compile.ok) throw new Error("Actual original Recipe failed native compiler.");
  if (!fs.existsSync(path.join(prepared.root, ".pkm-next-workspace"))) {
    await initialize(prepared.root);
    const { RecipeFilesystemStore } = require("../legacy/dist/workflows/recipe-filesystem-store.js");
    // Explicit separate-root test projection, not evidence that original ProjectStore adoption is supported.
    const projectionRoot = path.join(prepared.base, "explicit-test-projection");
    fs.mkdirSync(projectionRoot, { mode: 0o700 });
    const projection = new RecipeFilesystemStore(path.join(projectionRoot, ".pkm/state"));
    projection.put(prepared.evidence.recipe);
    for (const recipe of prepared.additionalRecipes ?? []) projection.put(recipe);
    fs.cpSync(path.join(projectionRoot, "recipes"), path.join(prepared.root, "recipes"), { recursive: true });
    fs.mkdirSync(path.join(prepared.root, "recipe-usage-reads/.pkm/state"), { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(prepared.originalRoot, ".pkm/state/recipe-runs"),
      path.join(prepared.root, "recipe-usage-reads/.pkm/state/recipe-runs"), { recursive: true });
  }
  await beforeStorageOpen?.(prepared.root);
  const storage = await Storage.open(prepared.root, { deferRecovery: true });
  let knowledgeDatabase;
  if (knowledgeDocumentIds) {
    const { readIndexedRecipeKnowledgeDocuments } = await load("recipe-knowledge-reader");
    knowledgeDatabase = storage.connectNative();
    knowledgeDocuments = () => readIndexedRecipeKnowledgeDocuments({ root: prepared.root, database: knowledgeDatabase,
      documentIds: knowledgeDocumentIds, assertLease: () => storage.assertWorkspaceLease() });
  }
  let runtime;
  const binding = { root: prepared.root, workspaceId: await storage.workspaceId(), actorId: prepared.actorId,
    sourceFingerprint: prepared.sourceFingerprint, namespace: "0123456789abcdef", chatId: prepared.chatId };
  const trusted = require("../legacy/tests/next-trial-electron/trusted-local-recipe-adapter.cjs").create({
    fixture: prepared.fixture, nonce: prepared.nonce, actorId: prepared.actorId, recipeId: prepared.evidence.recipeId,
    executableDigest: prepared.evidence.recipeExecutableDigest, definition: compile.model,
    inputSha256: prepared.evidence.inputSha256, canonicalJson, onHeld, allowNativeCopies: library,
  });
  const authority = new LegacyApiChatRecipes({ ...binding, assertLease: () => storage.assertWorkspaceLease(),
    authorize: authorize ?? (async candidate => JSON.stringify(candidate) === JSON.stringify(binding)),
    adapters: { ...trusted.adapters, ...(recipeAdapters?.({ binding, canonicalJson }) ?? {}) },
    ...(knowledgeDocuments ? { knowledgeDocuments } : {}),
    ...(library ? { library: { database: storage.connectNative(), ...(libraryFault ? { fault: libraryFault } : {}) } } : {}),
  });
  let lazyRuntime, lazyTrusted;
  try {
    if (lazy) {
      lazyTrusted = require("../legacy/tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs").adapter({
        fixture: prepared.fixture, actorId: prepared.actorId, canonicalJson });
      const reporter = externalReports ? new (await load("legacy-recipe-external-reports")).LegacyRecipeExternalReports(
        externalReports({ binding, canonicalJson })) : undefined;
      lazyRuntime = new (await load("legacy-recipe-lazy-runtime")).LegacyRecipeLazyRuntime(storage.connectNative(), {
        actorId: prepared.actorId, root: prepared.root, bindingFingerprint: hash(canonicalJson(binding)), ownerId: randomUUID(),
        adapters: lazyTrusted.adapters, catalog: () => authority.catalog(binding), resolveRecipe: authority.resolveRecipe,
        assertOwner: () => storage.assertWorkspaceLease(), requestCancel: lazyTrusted.requestCancel,
        ...(reporter ? { externalReports: reporter } : {}),
      });
    }
    const publicRecipes = publicApi ? new (await load("native-recipe-public-api")).NativeRecipePublicApi({
      recipes: authority, binding, uiApprovals: true, ...(lazyRuntime ? { lazy: lazyRuntime } : {}),
      ...(typeof publicApi === "object" ? publicApi : {}),
    }) : undefined;
    runtime = await createNativeRuntime({ storage, workspaceId: binding.workspaceId,
      ...(publicRecipes ? { recipeApi: publicRecipes } : {}),
      workflow: { adapters: authority.adapters, leaseMs: 30000,
        ...(library ? { resolveRecipe: authority.resolveRecipe } : {}) } });
    authority.bindRuntime(runtime.core, runtime.services.workflow);
    return { ...prepared, binding, storage, runtime, authority, publicRecipes, lazy: lazyRuntime, lazyTrusted, effects: trusted.effects,
      async close() { lazyRuntime?.close(); authority.close(); knowledgeDatabase?.close();
        try { await runtime.close(); } finally { await storage.close(); } } };
  } catch (error) {
    lazyRuntime?.close(); authority.close(); knowledgeDatabase?.close();
    try { await runtime?.close(); } finally { await storage.close(); } throw error;
  }
}
