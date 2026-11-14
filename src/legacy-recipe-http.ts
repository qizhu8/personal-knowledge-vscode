import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Core } from "./core.js";
import { CoreError, type Actor } from "./contracts.js";
import { recipeLibraryEditable } from "./recipe-library-fields.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";

/** Install only behind startHttp's exact-origin/bearer boundary; bind one editor resource. */
export function legacyRecipeHttp(options: { core: Core; actor: Actor; recipeId(): string;
  scope: { namespace: string; chatId: string } }) {
  async function invoke(operation: string, args: Record<string, unknown>, write = false): Promise<Record<string, unknown>> {
    const result = await options.core.dispatch(write ? "capability_call" : "capability_read",
      { operation, version: 1, arguments: args }, options.actor);
    if (result.error) throw new CoreError(result.error.code, result.error.message, result.error.effect);
    return result.result as Record<string, unknown>;
  }
  return { async handle(req: IncomingMessage, res: ServerResponse, body: () => Promise<unknown>) {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value));
    };
    try {
      if (req.url === "/api/validate" && req.method === "POST") {
        const value = await body() as Record<string, unknown>;
        const compiled = await invoke("workflow.definition.compile", { source: { kind: "inline", definition: value.definition } });
        if (compiled.status !== "valid") throw new CoreError("INVALID_ARGUMENT", "Recipe definition is invalid.");
        const definition = compiled.definition as { spec: { nodes: unknown[] } };
        reply(200, { definition, executableDigest: compiled.executableDigest, nodeCount: definition.spec.nodes.length }); return;
      }
      if (req.url !== "/api/recipe" || !["GET", "PUT"].includes(req.method || "")) {
        reply(404, { error: "Not found." }); return;
      }
      const current = await invoke("project.recipe.get", { id: options.recipeId() });
      if (req.method === "GET") { reply(200, { recipe: current.item }); return; }
      const value = await body() as Record<string, unknown>, record = current.item as Record<string, unknown>;
      if (Number(value.revision) !== record.revision)
        throw new CoreError("CONFLICT", `Recipe changed since this page opened (current revision ${record.revision}). Reload before saving.`);
      for (const key of ["recipeId", "knowledgeId", "aliases", "scope", "projectId", "origin", "schema"])
        if (key in value && canonicalJson(value[key]) !== canonicalJson(record[key] ?? null))
          throw new CoreError("CONFLICT", "Readonly Recipe identity changed.");
      const fields = Object.fromEntries(Object.keys(recipeLibraryEditable.shape).filter(key => key in value)
        .map(key => [key, value[key]]));
      const state = await invoke("recipe.library.state", {});
      const saved = await invoke("recipe.library.save", { namespace: options.scope.namespace,
        chatId: options.scope.chatId, operationId: randomUUID(),
        recipeId: record.recipeId, expectedRevision: record.revision, expectedDigest: state.digest, fields }, true);
      reply(200, { recipe: saved.recipe });
    } catch (error) {
      const failure = error instanceof CoreError ? error : new CoreError("INVALID_ARGUMENT", "Invalid Recipe request.");
      reply(failure.effect === "unknown" ? 500 : failure.code === "CONFLICT" ? 409 : failure.code === "NOT_FOUND" ? 404
        : failure.code === "ACCESS_DENIED" ? 403 : failure.code === "NOT_AVAILABLE" ? 503 : 400,
      { error: failure.message, code: failure.code, effect: failure.effect });
    }
  } };
}
