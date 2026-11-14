import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Storage } from "./storage.js";
import type { NativeRuntimeOptions, createNativeRuntime } from "./native-runtime.js";
import { LegacyApiChatRecipes } from "./legacy-api-chat-recipes.js";
import { LegacyRecipeLazyRuntime } from "./legacy-recipe-lazy-runtime.js";
import { LegacyRecipeExternalReports } from "./legacy-recipe-external-reports.js";
import { NativeRecipePublicApi } from "./native-recipe-public-api.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";

type RecipeOptions = ConstructorParameters<typeof LegacyApiChatRecipes>[0];
type PublicOptions = ConstructorParameters<typeof NativeRecipePublicApi>[0];
export interface LegacyRecipeHostPolicy {
  actorId: string;
  namespace: string;
  chatId: string;
  sourceFingerprint: string;
  adapters?: RecipeOptions["adapters"];
  knowledgeDocuments?: RecipeOptions["knowledgeDocuments"];
  authorize: RecipeOptions["authorize"];
  authorizeMutation?: PublicOptions["authorizeMutation"];
  externalReports?: ConstructorParameters<typeof LegacyRecipeExternalReports>[0];
  requestCancel?: ConstructorParameters<typeof LegacyRecipeLazyRuntime>[1]["requestCancel"];
}

/** Host-only composition on the already opened root; configuration JSON and protocol clients cannot grant this policy. */
export async function composeLegacyRecipeHost(storage: Storage, policy: LegacyRecipeHostPolicy) {
  const identity = z.strictObject({
    actorId: z.string().min(1).max(256), namespace: z.string().regex(/^[a-f0-9]{16}$/),
    chatId: z.string().uuid(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(Object.fromEntries(["actorId", "namespace", "chatId", "sourceFingerprint"].map(key =>
    [key, policy[key as keyof LegacyRecipeHostPolicy]])));
  if (typeof policy.authorize !== "function") throw new Error("Recipe host authorization is required.");
  storage.assertWorkspaceLease();
  const binding = Object.freeze({ ...identity, root: storage.workspaceRoot(), workspaceId: await storage.workspaceId() });
  const database = storage.connectNative();
  let recipes: LegacyApiChatRecipes | undefined, lazy: LegacyRecipeLazyRuntime | undefined, closed = false;
  const assertOwner = () => {
    if (closed) throw new Error("Recipe host authority is closed.");
    storage.assertWorkspaceLease();
  };
  try {
    recipes = new LegacyApiChatRecipes({ ...binding, adapters: policy.adapters ?? {},
      library: { database }, assertLease: assertOwner, authorize: policy.authorize,
      ...(policy.knowledgeDocuments ? { knowledgeDocuments: policy.knowledgeDocuments } : {}) });
    const externalReports = policy.externalReports ? new LegacyRecipeExternalReports(policy.externalReports) : undefined;
    lazy = new LegacyRecipeLazyRuntime(database, {
      actorId: identity.actorId, root: binding.root, bindingFingerprint: createHash("sha256").update(canonicalJson(binding)).digest("hex"),
      ownerId: randomUUID(), adapters: policy.adapters ?? {},
      catalog: () => recipes!.catalog(binding), resolveRecipe: recipes.resolveRecipe, assertOwner,
      requestCancel: policy.requestCancel ?? (() => { throw new Error("No owned Recipe process cancellation authority is installed."); }),
      ...(externalReports ? { externalReports } : {}),
    });
    const publicApi = new NativeRecipePublicApi({ recipes, binding, lazy, uiApprovals: true,
      ...(policy.authorizeMutation ? { authorizeMutation: policy.authorizeMutation } : {}) });
    const workflow: NonNullable<NativeRuntimeOptions["workflow"]> = {
      adapters: recipes.adapters, resolveRecipe: recipes.resolveRecipe,
    };
    return {
      binding, recipes, publicApi, workflow,
      bindRuntime(runtime: Awaited<ReturnType<typeof createNativeRuntime>>) {
        assertOwner();
        if (!runtime.services.workflow) throw new Error("Recipe workflow host was not composed.");
        recipes!.bindRuntime(runtime.core, runtime.services.workflow);
      },
      close() {
        if (closed) return;
        try { lazy!.close(); }
        finally {
          closed = true;
          recipes!.close();
        }
      },
    };
  } catch (error) {
    try { lazy?.close(); } finally { if (recipes) recipes.close(); else database.close(); }
    throw error;
  }
}
