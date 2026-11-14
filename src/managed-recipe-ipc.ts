import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ManagedClientHost } from "./managed-client-host.js";
import { nativeChatRecipeEditor, nativeChatRecipeLibrary } from "./legacy-api-chat-recipes.js";
import { recipePublicLazyRequest } from "./native-recipe-public-api.js";
import type { LegacyRecipeHostPolicy } from "./legacy-recipe-host.js";

const commandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("state") }),
  z.strictObject({ operation: z.literal("editor"), input: nativeChatRecipeEditor }),
  z.strictObject({ operation: z.literal("validate"), definition: z.json() }),
  z.strictObject({ operation: z.literal("save"), input: nativeChatRecipeLibrary }),
  z.strictObject({ operation: z.literal("execute"), input: recipePublicLazyRequest }),
]);

export function managedRecipeIpc(options: {
  host(): ManagedClientHost | undefined;
  unavailable(): boolean;
  send(message: object): void;
}) {
  let work: Promise<void> | undefined, closing = false, approvalId: string | undefined;
  const challenges = new Map<string, (approved: boolean) => void>();
  const review = async (binding: unknown, operation: string, approval: unknown) => {
    if (closing || options.unavailable() || !approvalId) return false;
    const challenge = randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { challenges.delete(challenge); resolve(false); }, 120_000);
      challenges.set(challenge, approved => { clearTimeout(timer); challenges.delete(challenge); resolve(approved); });
      options.send({ type: "recipe-approval-request", approvalId, challenge, binding, operation, approval });
    });
  };
  return {
    get busy() { return !!work; },
    review: review as NonNullable<LegacyRecipeHostPolicy["authorize"]>,
    close() { closing = true; for (const resolve of challenges.values()) resolve(false); },
    async drain() { await work; },
    handle(message: Record<string, unknown>) {
      if (message.type === "recipe-approval-result") {
        if (typeof message.challenge === "string" && message.approvalId === approvalId)
          challenges.get(message.challenge)?.(!closing && message.approved === true);
        return true;
      }
      if (message.type !== "recipe-command") return false;
      const id = message.id;
      if (typeof id !== "string" || !z.string().uuid().safeParse(id).success) return true;
      const parsed = commandSchema.safeParse(message.command);
      const host = options.host();
      if (closing || options.unavailable() || work || !host?.recipeContext || !parsed.success
        || !z.string().uuid().safeParse(message.approvalId).success || Buffer.byteLength(JSON.stringify(message)) > 1_048_576) {
        options.send({ type: "result", id, error: "BUSY_OR_INVALID", message: "Recipe access requires an eligible writable native host and a bounded exact request." });
        return true;
      }
      approvalId = String(message.approvalId);
      work = (async () => {
        try {
          const context = await host.recipeContext!(), command = parsed.data;
          let result: unknown;
          if (command.operation === "state")
            result = { binding: context.binding, state: await context.state(), catalog: await context.catalog() };
          else if (command.operation === "editor") result = await context.editor(command.input);
          else if (command.operation === "validate") result = await context.validate(command.definition);
          else if (command.operation === "save") result = await context.save(command.input);
          else {
            const preview = await context.preview(command.input);
            if (!await review(context.binding, "lazy", preview)) throw new Error("Exact Recipe decision declined; no lifecycle request was dispatched.");
            if (closing || options.unavailable()) throw new Error("Recipe host closed during review.");
            await context.approve({ operation: preview.operation, args: preview.args, previewDigest: preview.previewDigest });
            result = await context.invoke({ operation: preview.operation, args: preview.args });
          }
          options.send({ type: "result", id, result });
        } catch (error) {
          options.send({ type: "result", id, error: "RECIPE_REQUEST_FAILED",
            message: error instanceof Error ? error.message.slice(0, 4096) : "Recipe outcome unavailable; never retry automatically." });
        } finally { approvalId = undefined; work = undefined; }
      })();
      return true;
    },
  };
}
