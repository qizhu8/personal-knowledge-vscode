import type { StandaloneHost } from "./standalone-host.js";
import { recipePublicLazyApproval, recipePublicLazyRequest } from "./native-recipe-public-api.js";
import type { Actor } from "./contracts.js";
import type { z } from "zod";
import { nativeChatRecipeEditor, nativeChatRecipeLibrary } from "./legacy-api-chat-recipes.js";

type Request = z.infer<typeof recipePublicLazyRequest>;
type Approval = z.infer<typeof recipePublicLazyApproval>;
type Admit = <T>(work: () => T | Promise<T>) => Promise<T>;

/** An embedding-process capability, never a document operation or protocol bearer grant. */
export function bindManagedRecipeContext(host: StandaloneHost, actor: Readonly<Actor>, admit: Admit) {
  const recipeHost = host.recipeHost;
  if (!recipeHost || recipeHost.binding.actorId !== actor.id || recipeHost.binding.workspaceId !== host.workspaceId)
    throw new Error("No matching managed Recipe authority.");
  const { binding, recipes, publicApi } = recipeHost;
  const protocolActor = Object.freeze({ ...actor, recipeProtocol: true });
  return Object.freeze({
    binding,
    state: () => admit(() => recipes.state(binding)),
    catalog: () => admit(() => recipes.catalog(binding)),
    editor: (value: z.infer<typeof nativeChatRecipeEditor>) =>
      admit(() => recipes.editor(binding, nativeChatRecipeEditor.parse(value))),
    validate: (definition: unknown) => admit(() => recipes.validateLibrary(binding, definition)),
    save: (value: z.infer<typeof nativeChatRecipeLibrary>) =>
      admit(() => recipes.saveLibrary(binding, nativeChatRecipeLibrary.parse(value))),
    preview: (request: Request) => admit(() => publicApi.previewLazy(binding, recipePublicLazyRequest.parse(request))),
    approve: (approval: Approval) => admit(() => publicApi.approveLazy(binding, recipePublicLazyApproval.parse(approval))),
    invoke: (value: Request) => admit(() => {
      const request = recipePublicLazyRequest.parse(value);
      return host.core.dispatch("capability_call",
        { operation: request.operation, version: 1, arguments: request.args }, protocolActor);
    }),
  });
}
export type ManagedRecipeContext = ReturnType<typeof bindManagedRecipeContext>;
