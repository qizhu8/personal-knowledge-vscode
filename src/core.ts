import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError, definitions, description, discovery, invocation, parse, type Actor } from "./contracts.js";
import { Storage } from "./storage.js";
import { memoryContent, memoryDecision, memoryRecord, type MemoryAuthorizer, type MemoryDecisionRequest } from "./memory-contracts.js";
import { PluginRuntime, PluginRuntimeError } from "./plugin-runtime.js";
import type { ModelConfigService } from "./model-config.js";
import { boundedChatJson } from "./chat-session-contracts.js";
import { withLegacyReadPreflight, type LegacyReadSnapshot } from "./legacy-read-race.js";
import { recipeProtocolOperations } from "./recipe-public-contracts.js";
import { legacyRecipeLazyOperations } from "./legacy-recipe-lazy-contracts.js";

const nativeMemoryOperations = new Set(["memory.record.confirm", "memory.record.revise", "memory.record.revoke"]);
const integratedNative = (id: string) => id.startsWith("manager.") || id.startsWith("action.runtime.") || id.startsWith("channel.runtime.") || id.startsWith("portal.lifecycle.") || /^knowledge\.(?:note|skill|research)\.(?:create|update)$/.test(id)
  || id === "subscription.identity.get" || id === "subscription.broker.share-markers"
  || id === "knowledge.classification.native-strict.command" || id === "knowledge.classification.original-compatible.command" || id === "memory.scope.forget.native"
  || id.startsWith("legacy.skill.router.") || id === "legacy.skill.source.install" || id === "legacy.skill.source.remove" || id === "legacy.skill.source.bridge" || id === "knowledge.legacy-links.resolve" || id === "knowledge.asset.ownership.validate"
  || id.startsWith("remote.runtime.subscription.bundle.")
  || id.startsWith("knowledge.trash.") || id === "project.recipe.trash.command"
  || id.startsWith("legacy.note.workitems.") || id.startsWith("agent.snapshot.restore-")
  || id === "agent.snapshot.resume-native" || id === "agent.snapshot.cancel-native" || id === "agent.snapshot.confirm-native";
const guardedKnowledgeReads = new Set([
  "knowledge.document.list", "knowledge.document.get", "knowledge.note.search", "knowledge.note.list",
  "knowledge.asset.list", "knowledge.asset.get",
]);
const envelopeResult = z.record(z.string(), z.unknown());

const catalog = definitions.map(definition => ({
  operation: definition.id, version: 1, description: definition.description, readOnly: definition.readOnly,
  inputSchema: z.toJSONSchema(definition.input, { io: "input" }), outputSchema: z.toJSONSchema(definition.output),
  authorization: "nativeOnly" in definition && definition.nativeOnly ? "Native human exact-record decision; never HTTP/MCP"
    : !definition.readOnly && (/^recipe\.(runtime|library)\./.test(definition.id) || legacyRecipeLazyOperations.has(definition.id))
      ? "Separately composed fresh exact native host decision; bearer and recipeProtocol scope confer no execution permission"
    : definition.readOnly ? "Authenticated workspace read" : "Authenticated workspace write",
  idempotency: definition.readOnly ? "read"
    : definition.id.startsWith("plugin.runtime.") || /^recipe\.(runtime|library)\./.test(definition.id) || legacyRecipeLazyOperations.has(definition.id)
      ? "explicit-consent-no-automatic-retry" : "durable-operation-id",
}));
const catalogRevision = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
export const methods = {
  server_info: { description: "Read this experimental server's protocol, limits and isolation boundary.", schema: z.strictObject({}), readOnly: true },
  capabilities_search: { description: "Browse/search the authorized catalog; returns summaries. Pin revision when paging.", schema: discovery, readOnly: true },
  capabilities_describe: { description: "Read the exact versioned operation contract before invocation.", schema: description, readOnly: true },
  capability_read: { description: "Invoke a read-only operation through the shared Core.", schema: invocation, readOnly: true },
  capability_call: { description: "Invoke a mutation. Requires write authority and the operation's durable identifier (operationId or operation_id; read its exact contract). On uncertain transport outcome retry only the identical request with the SAME identifier.", schema: invocation, readOnly: false },
} as const;
export type Method = keyof typeof methods;
export interface NativeRuntimeDispatcher {
  available(operation: string, actor?: Readonly<Actor>): boolean;
  dispatch(operation: string, args: Record<string, unknown>, actor: Actor): Promise<unknown>;
}
export class Core {
  private readonly plugins: PluginRuntime;
  constructor(private readonly storage: Storage, private readonly options: {
    authorizeMemoryDecision?: MemoryAuthorizer; modelConfig?: ModelConfigService; nativeRuntime?: NativeRuntimeDispatcher;
    recipeApi?: NativeRuntimeDispatcher & { owns(operation: string): boolean };
    plugins?: PluginRuntime;
    runPlugin?<T>(work: () => Promise<T>): Promise<T>;
    assertAdmission?(request: Readonly<{ method: string; input: unknown; actor: Readonly<Actor> }>): void;
    legacyReadSnapshot?(operation: string, args: Readonly<Record<string, unknown>>): Promise<LegacyReadSnapshot> | LegacyReadSnapshot;
  } = {}) { this.plugins = options.plugins ?? new PluginRuntime(); }
  async closePlugins(): Promise<void> { await this.plugins.close(); }
  private available(operation: string, actor?: Readonly<Actor>) {
    const definition = definitions.find(item => item.id === operation);
    if (!definition) return false;
    if (actor?.recipeProtocol && !recipeProtocolOperations.has(operation)) return false;
    if (this.options.recipeApi?.owns(operation)) return this.options.recipeApi.available(operation, actor);
    if (/^recipe\.(runtime|library|compat)\./.test(operation) || operation.startsWith("mcp.tool.recipe_")) return false;
    if (operation.startsWith("plugin.runtime.") && !definition.readOnly) return this.options.plugins !== undefined;
    if (operation.startsWith("model.config.")) return this.options.modelConfig !== undefined;
    if (integratedNative(operation) || operation.startsWith("chat.turn.") || operation.startsWith("workflow.executor.")
      || operation.startsWith("agent.runtime.") || operation.startsWith("knowledge.folder.lifecycle.")
      || operation === "knowledge.folder.move" || operation === "knowledge.folder.promote-delete"
      || operation.startsWith("sync.apply.") || operation === "sync.apply"
      || operation.startsWith("retrieval.runtime.")
      || operation.startsWith("subscription.materialize.apply")) {
      if ("nativeOnly" in definition && definition.nativeOnly && !nativeMemoryOperations.has(operation)) return false;
      return this.options.nativeRuntime?.available(operation, actor) === true;
    }
    if ("nativeOnly" in definition && definition.nativeOnly)
      return nativeMemoryOperations.has(operation) && this.options.authorizeMemoryDecision !== undefined;
    return true;
  }
  async dispatch(method: string, input: unknown, actor: Actor) {
    const requestId = randomUUID();
    try {
      this.options.assertAdmission?.(Object.freeze({ method, input, actor: Object.freeze({ ...actor }) }));
      if (!Object.hasOwn(methods, method)) throw new CoreError("NOT_FOUND", "Unknown API method.");
      if (method === "server_info") {
        parse(methods.server_info.schema, input);
        const pluginStatus = await this.plugins.read("plugin.runtime.status", { pluginId: "teams" }) as { available: boolean };
        return { schema: "pkm.next-result/v1", requestId, result: {
          name: "pkm-next", version: "0.1.0", experimental: true, catalogRevision,
          workspaceId: await this.storage.workspaceId(), serverId: "pkm-next",
          workspaceVersion: "pkm.next-workspace/v2", protocolVersion: "v1", actorId: actor.id,
          supportedModes: this.available("manager.chat.artifacts") ? ["pinned-sqlite-text-artifacts/v1"] : [],
          isolation: "Isolated workspace only; offline disposable-copy import is library-only. No production cutover or VS Code dependency.",
          storage: { authority: "Markdown", workspaceSchema: "pkm.next-workspace/v2", knowledgeAreas: ["notes", "skills", "papers"], database: "rebuildable-index-and-durable-runtime-state" },
          limits: { storageQueue: 32 },
          features: ["knowledge-documents", "knowledge-metadata", "knowledge-link-contracts", "knowledge-link-resolution", "knowledge-resource-reads", "durable-resource-uploads", "resource-lifecycle", "paired-document-moves", "research-read-models", "skill-read-models", "skill-routing-projections", "note-read-models", "literal-knowledge-search", "project-recipe-read-models", "project-recipe-mutations", "workflow-definition-compiler", "workflow-run-state", "chat-transcript-state", "offline-sync-plans", "collaboration-state", "action-compiler", "plugin-status", "subscription-acl-reads", "agent-snapshot-reads", "explicit-memory", "todo-boards", "workitem-lifecycle", "revision-cas", "durable-receipts", "trash-restore", "same-origin-browser",
            ...(this.available("manager.runtime.start") ? ["native-manager", "canonical-manager-progress"] : []),
            ...(this.available("chat.turn.start") ? ["chat-generation"] : [])],
          unavailable: ["chat-memory", "native-memory-ui", ...(!pluginStatus.available ? ["plugin-implementation"] : []),
            ...(!this.options.plugins ? ["plugin-host-authorization"] : []),
            "execution-approval", "subscription-materialization", "remote-access",
            ...(!this.available("chat.turn.start") ? ["chat-generation"] : []),
            ...(!this.available("manager.runtime.start") ? ["native-manager"] : []),
            ...(!this.available("retrieval.runtime.search") ? ["retrieval"] : []),
            "direct-process-launch"],
        } };
      }
      if (method === "capabilities_search") {
        const args = parse(discovery, input);
        if (args.revision && args.revision !== catalogRevision) throw new CoreError("CONFLICT", "Catalog changed; restart discovery.");
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = catalog.filter(item => this.available(item.operation, actor) && (actor.canWrite || item.readOnly) && words.every(word => `${item.operation} ${item.description}`.toLowerCase().includes(word)));
        const items = matches.slice(args.offset, args.offset + args.limit).map(({ operation, version, description, readOnly }) => ({ operation, version, description, readOnly }));
        const next = args.offset + items.length;
        return { schema: "pkm.next-result/v1", requestId, result: { revision: catalogRevision, items, total: matches.length, nextOffset: next < matches.length ? next : null } };
      }
      if (method === "capabilities_describe") {
        const args = parse(description, input);
        const item = catalog.find(item => item.operation === args.operation && this.available(item.operation, actor) && (actor.canWrite || item.readOnly));
        if (!item) throw new CoreError("NOT_FOUND", "Operation is not available in this actor's catalog.");
        return { schema: "pkm.next-result/v1", requestId, result: { ...item, catalogRevision } };
      }
      const args = parse(invocation, input);
      const definition = definitions.find(item => item.id === args.operation);
      if (!definition) throw new CoreError("NOT_FOUND", "Unknown operation.");
      if (!this.available(definition.id, actor)) throw new CoreError("NOT_AVAILABLE", "This operation requires its exact trusted native integration and is unavailable through this transport.");
      if (definition.readOnly !== (method === "capability_read")) throw new CoreError("ACCESS_DENIED", "Use the matching read or mutation entry point.");
      if (!definition.readOnly && !actor.canWrite) throw new CoreError("ACCESS_DENIED", "This principal has no write authority.");
      if (definition.id.startsWith("chat.session.") && !boundedChatJson(args.arguments))
        throw new CoreError("INVALID_ARGUMENT", "Chat request exceeds portable JSON bounds.");
      const validated = parse(z.record(z.string(), z.unknown()), parse(definition.input, args.arguments));
      if (actor.boardWorker && (!definition.id.startsWith("todo.") || validated.board_slug !== actor.boardWorker.boardSlug))
        throw new CoreError("ACCESS_DENIED", "Board worker authority applies only to its exact Todo Board.");
      const request = { operation: definition.id, args: validated, actorId: actor.id,
        ...(actor.boardWorker ? { boardWorker: actor.boardWorker } : {}),
        ...(definition.id.startsWith("collaboration.state.") ? { collaborationKind: actor.collaborationKind ?? "agent" } : {}) };
      const perform = async (): Promise<unknown> => {
        if (this.options.recipeApi?.available(definition.id))
          return this.options.recipeApi.dispatch(definition.id, validated, actor);
        if (definition.id.startsWith("plugin.runtime.")) {
          const performPlugin = async () => {
            const pluginActor = Object.freeze({ id: actor.id, trusted: true });
            switch (definition.id) {
              case "plugin.runtime.enable":
                return this.plugins.enable(pluginActor, String(validated.pluginId), validated.capabilities as string[]);
              case "plugin.runtime.disable":
                return this.plugins.disable(pluginActor, String(validated.pluginId));
              case "plugin.runtime.invoke":
                return this.plugins.invoke(pluginActor, String(validated.pluginId), String(validated.capability), validated.input);
              default: return this.plugins.read(definition.id, validated);
            }
          };
          return this.options.runPlugin ? this.options.runPlugin(performPlugin) : performPlugin();
        }
        if (definition.id.startsWith("model.config.")) {
          return definition.id === "model.config.catalog" ? this.options.modelConfig!.catalog() : this.options.modelConfig!.resolve(validated);
        }
        if (nativeMemoryOperations.has(definition.id)) {
          let value = await this.storage.request({ ...request, receiptOnly: true });
          if (value !== null) return value;
          const review = memoryRecord.safeParse(await this.storage.request({
            operation: "memory.record.get", args: { id: validated.id }, actorId: actor.id,
          }));
          if (!review.success) throw new CoreError("INVALID_RESULT", "Memory review returned an invalid record.");
          if (review.data.current_revision !== validated.expected_revision) throw new CoreError("CONFLICT", "Memory changed before human review; reread it.");
          const record = Object.freeze({ ...review.data, sources: Object.freeze(review.data.sources.map(source => Object.freeze({ ...source }))) });
          const approval: MemoryDecisionRequest = {
            operation: definition.id as MemoryDecisionRequest["operation"], operationId: String(validated.operation_id),
            record,
            ...(definition.id === "memory.record.revise" ? { replacement: Object.freeze({
              content: String(validated.content),
              sources: Object.freeze(memoryContent.parse({ content: validated.content, sources: validated.sources }).sources.map(source => Object.freeze(source))),
            }) } : {}),
          };
          const authorized = await this.options.authorizeMemoryDecision!(Object.freeze(approval));
          if (authorized === null) throw new CoreError("ACCESS_DENIED", "Native human did not authorize this exact memory decision.");
          const decision = memoryDecision.safeParse(authorized);
          if (!decision.success) throw new CoreError("INVALID_RESULT", "Native memory authorizer returned an invalid decision.");
          return this.storage.request({ ...request, memoryDecision: { ...decision.data, documentSha256: review.data.documentSha256 } });
        }
        if (this.options.nativeRuntime && ((definition.id === "project.legacy.command" && this.options.nativeRuntime.available(definition.id, actor))
          || definition.id.startsWith("agent.snapshot.") || (definition.id.startsWith("subscription.") && definition.readOnly)
          || integratedNative(definition.id) || definition.id.startsWith("chat.turn.")
          || definition.id.startsWith("workflow.executor.") || definition.id.startsWith("agent.runtime.")
          || definition.id.startsWith("knowledge.folder.lifecycle.") || definition.id === "knowledge.folder.move"
          || definition.id === "knowledge.folder.promote-delete"
          || definition.id.startsWith("sync.apply.") || definition.id === "sync.apply"
          || definition.id.startsWith("retrieval.runtime.") || definition.id === "subscription.materialize.apply")) {
          return this.options.nativeRuntime.dispatch(definition.id, validated, actor);
        }
        return this.storage.request(request);
      };
      const result = method === "capability_read" && guardedKnowledgeReads.has(definition.id) && this.options.legacyReadSnapshot
        ? await withLegacyReadPreflight(() => this.options.legacyReadSnapshot!(definition.id, validated), perform)
        : await perform();
      if (!definition.output.safeParse(result).success || !envelopeResult.safeParse(result).success)
        throw new CoreError("INVALID_RESULT", "Storage returned an invalid result; reconcile the operation receipt before retrying.", definition.readOnly ? "not-committed" : "unknown");
      return { schema: "pkm.next-result/v1", requestId, operation: definition.id, version: 1, catalogRevision, result };
    } catch (error) {
      if (error instanceof PluginRuntimeError) error = new CoreError(error.code, error.message,
        ["PLUGIN_START_FAILED", "PLUGIN_HOOK_FAILED", "PLUGIN_CLEANUP_FAILED"].includes(error.code) ? "unknown" : "not-committed");
      if (!(error instanceof CoreError)) console.error("PKM next dispatch:", error);
      const failure = error instanceof CoreError ? error : new CoreError("INTERNAL", "Internal error; inspect server diagnostics.", "unknown");
      return { schema: "pkm.next-result/v1", requestId, error: { code: failure.code, message: failure.message, effect: failure.effect } };
    }
  }
}
