import { startStandaloneHost, startStandaloneHostFromAdoptedRoot, type SelectedWorkspaceOwner, type StandaloneHost, type StandaloneHostPolicy } from "./standalone-host.js";
import { createHash } from "node:crypto";
import { Core } from "./core.js";
import { scanMarkdown } from "./markdown.js";
import type { Storage } from "./storage.js";
import { CoreError } from "./contracts.js";
import { readDocumentAssets } from "./assets.js";
import { planTodo } from "./boards.js";
import { readResearch } from "./research.js";
import { readSkills } from "./skills.js";
import { readKnowledgeMetadata } from "./metadata.js";
import { readProjectRecipes } from "./project-recipes.js";
import { readLibrary } from "./library-reads.js";
import { readMutationScan } from "./mutation-scan.js";
import { bindManagedRecipeContext, type ManagedRecipeContext } from "./managed-recipe-context.js";
import type { LegacyRecipeHostPolicy } from "./legacy-recipe-host.js";
import type { LegacyRootAdoptionResult } from "./legacy-root-adoption.js";

const actor = Object.freeze({ id: "local:owner", canWrite: true });
const operations = Object.freeze({
  list: ["capability_read", "knowledge.document.list"],
  get: ["capability_read", "knowledge.document.get"],
  "asset-list": ["capability_read", "knowledge.asset.list"],
  "asset-get": ["capability_read", "knowledge.asset.get"],
  "board-list": ["capability_read", "todo.board.list"],
  "board-get": ["capability_read", "todo.board.get"],
  "board-tasks": ["capability_read", "todo.workitem.list"],
  "board-stories": ["capability_read", "todo.story.list"],
  "research-list": ["capability_read", "knowledge.research.list"],
  "skill-list": ["capability_read", "knowledge.skill.list"],
  "skill-get": ["capability_read", "knowledge.skill.get"],
  "metadata-get": ["capability_read", "knowledge.metadata.get"],
  "recipe-list": ["capability_read", "project.recipe.list"],
  "recipe-get": ["capability_read", "project.recipe.get"],
  "library-list": ["capability_read", "knowledge.library.list"],
  "library-get": ["capability_read", "knowledge.library.get"],
  "mutation-scan": ["capability_read", "knowledge.mutation.scan"],
  "note-create": ["capability_call", "knowledge.note.create"],
  "note-update": ["capability_call", "knowledge.note.update"],
  "skill-create": ["capability_call", "knowledge.skill.create"],
  "skill-update": ["capability_call", "knowledge.skill.update"],
  "research-create": ["capability_call", "knowledge.research.create"],
  "research-update": ["capability_call", "knowledge.research.update"],
  create: ["capability_call", "knowledge.document.create"],
  update: ["capability_call", "knowledge.document.update"],
} as const);

export type ManagedDocumentOperation = keyof typeof operations;
export interface ManagedClientHost {
  readonly workspaceId: string;
  readonly writerCoverage: Readonly<{ inProcessCalls: "tracked"; external: "unknown"; cutoverAuthorized: false }>;
  invoke(operation: ManagedDocumentOperation, args: Record<string, unknown>): ReturnType<StandaloneHost["core"]["dispatch"]>;
  roomContext?(): Promise<{ storage: Storage; actorId: string; assertAuthority(): Promise<void> }>;
  recipeContext?(): Promise<ManagedRecipeContext>;
  selectedOwnerContext?(selection: SelectedWorkspaceOwner): ReturnType<StandaloneHost["selectedOwnerContext"]>;
  close(): Promise<void>;
}

/** Filesystem-only read projection: no Storage.open, index repair, journal recovery or lease writes. */
export function bindImportedReadOnlyHost(root: string, workspaceId: string, assertSnapshot: () => Promise<void>): ManagedClientHost {
  const reader = Object.freeze({ id: "local:disposable-import-reader", canWrite: false });
  const backend = {
    async request(request: { operation: string; args: Record<string, unknown>; actorId: string }) {
      if (request.operation === "knowledge.mutation.scan") return readMutationScan(root);
      if (["knowledge.library.list", "knowledge.library.get"].includes(request.operation)) return readLibrary(root, request);
      if (["project.recipe.list", "project.recipe.get"].includes(request.operation)) return readProjectRecipes(root, request);
      if (["todo.board.list", "todo.board.get", "todo.workitem.list", "todo.story.list"].includes(request.operation)) {
        const planned = planTodo(root, request);
        if (planned.write) throw new CoreError("ACCESS_DENIED", "Board migration access is read-only.");
        return planned.result;
      }
      if (!["knowledge.document.list", "knowledge.document.get", "knowledge.asset.list", "knowledge.asset.get",
        "knowledge.research.list", "knowledge.skill.list", "knowledge.skill.get", "knowledge.metadata.get"].includes(request.operation))
        throw new CoreError("ACCESS_DENIED", "Only imported document reads are available.");
      const documents = scanMarkdown(root);
      if (request.operation === "knowledge.research.list") return readResearch(root, documents, request);
      if (["knowledge.skill.list", "knowledge.skill.get"].includes(request.operation)) return readSkills(root, documents, request);
      if (request.operation !== "knowledge.document.list") {
        const found = documents.find(({ record, metadata }) => record.id === request.args.id || metadata.get("knowledgeId") === request.args.id);
        if (!found) throw new CoreError("NOT_FOUND", "Document not found.");
        return request.operation === "knowledge.metadata.get" ? readKnowledgeMetadata(found)
          : request.operation === "knowledge.document.get" ? found.record : readDocumentAssets(root, found, request);
      }
      const revision = createHash("sha256").update(JSON.stringify(documents.map(({ record }) =>
        [record.id, record.area, record.path, record.sha256]))).digest("hex");
      if (request.args.workspaceRevision !== undefined && request.args.workspaceRevision !== revision)
        throw new CoreError("CONFLICT", "Workspace changed; restart pagination.");
      const items = documents.map(({ record }) => record).filter(record =>
        (request.args.includeDeleted || !record.deleted) && (request.args.area === undefined || request.args.area === record.area));
      const offset = Number(request.args.offset), page = items.slice(offset, offset + Number(request.args.limit))
        .map(({ content: _content, ...record }) => record);
      const next = offset + page.length;
      return { items: page, total: items.length, nextOffset: next < items.length ? next : null, workspaceRevision: revision };
    },
  };
  const core = new Core(backend as unknown as Storage, {
    assertAdmission({ method, input, actor }) {
      const operation = input && typeof input === "object" && "operation" in input ? (input as { operation?: unknown }).operation : undefined;
      if (actor.id !== reader.id || actor.canWrite !== false || method !== "capability_read"
        || !["knowledge.document.list", "knowledge.document.get", "knowledge.asset.list", "knowledge.asset.get",
          "todo.board.list", "todo.board.get", "todo.workitem.list", "todo.story.list",
          "knowledge.research.list", "knowledge.skill.list", "knowledge.skill.get", "knowledge.metadata.get",
          "project.recipe.list", "project.recipe.get", "knowledge.library.list", "knowledge.library.get", "knowledge.mutation.scan"].includes(String(operation)))
        throw new CoreError("ACCESS_DENIED", "Imported workspace is read-only.");
    },
  });
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  return Object.freeze({
    workspaceId,
    writerCoverage: Object.freeze({ inProcessCalls: "tracked" as const, external: "unknown" as const, cutoverAuthorized: false as const }),
    invoke(operation: ManagedDocumentOperation, args: Record<string, unknown>) {
      if (closed) return Promise.reject(new Error("Imported reader is closed."));
      if (!["list", "get", "asset-list", "asset-get", "board-list", "board-get", "board-tasks", "board-stories",
        "research-list", "skill-list", "skill-get", "metadata-get", "recipe-list", "recipe-get", "library-list", "library-get", "mutation-scan"].includes(operation)) return Promise.reject(new Error("Imported workspace is read-only."));
      const task = (async () => {
        await assertSnapshot();
        const result = await core.dispatch("capability_read", { operation: operations[operation][1], version: 1, arguments: args }, reader);
        await assertSnapshot();
        return result;
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    async close() { closed = true; await Promise.allSettled([...pending]); },
  });
}

/**
 * This object is a capability for the trusted embedding process, not an
 * authentication mechanism for an arbitrary remote or extension caller.
 */
export function bindManagedClientHost(host: StandaloneHost, expectedWorkspaceId: string): ManagedClientHost {
  if (!expectedWorkspaceId || host.workspaceId !== expectedWorkspaceId) throw new Error("Managed workspace binding mismatch.");
  if (host.recipeHost && host.recipeHost.binding.actorId !== actor.id) throw new Error("Managed Recipe actor binding mismatch.");
  let state: "open" | "closing" | "closed" = "open";
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const admit = <T>(work: () => T | Promise<T>): Promise<T> => {
    if (state !== "open") return Promise.reject(new Error("Managed host admission is closed."));
    const task = Promise.resolve().then(work);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  const recipeContext = host.recipeHost ? bindManagedRecipeContext(host, actor, admit) : undefined;
  return Object.freeze({
    workspaceId: host.workspaceId,
    writerCoverage: Object.freeze({ inProcessCalls: "tracked" as const, external: "unknown" as const, cutoverAuthorized: false as const }),
    ...(recipeContext ? { recipeContext: async () => {
      await recipeContext.state();
      return recipeContext;
    } } : {}),
    async roomContext() {
      if (state !== "open") throw new Error("Managed Room host admission closed.");
      const context = await host.roomContext();
      return { ...context, async assertAuthority() {
        if (state !== "open") throw new Error("Managed Room host admission revoked.");
        await context.assertAuthority();
      } };
    },
    selectedOwnerContext(selection: SelectedWorkspaceOwner) {
      if (state !== "open" || !selection || typeof selection.assertCurrent !== "function")
        throw new Error("Managed selected owner admission closed.");
      return host.selectedOwnerContext({
        get workspaceId() { return selection.workspaceId; },
        get actorId() { return selection.actorId; },
        assertCurrent() {
          if (state !== "open") throw new Error("Managed selected owner admission closed.");
          const result = selection.assertCurrent();
          if (state !== "open") throw new Error("Managed selected owner admission closed.");
          return result;
        },
      });
    },
    invoke(operation: ManagedDocumentOperation, args: Record<string, unknown>) {
      if (state !== "open") return Promise.reject(new Error("Managed host admission is closed."));
      if (!Object.hasOwn(operations, operation) || !args || typeof args !== "object" || Array.isArray(args))
        return Promise.reject(new Error("Invalid managed document request."));
      const [method, name] = operations[operation];
      if (["note-create", "note-update", "skill-create", "skill-update", "research-create", "research-update"].includes(operation))
        return Promise.reject(new Error("Structured editing requires an explicitly approved isolated import experiment."));
      const task = host.core.dispatch(method, { operation: name, version: 1, arguments: args }, actor);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    close() {
      if (closing) return closing;
      if (state === "closed") return Promise.resolve();
      state = "closing";
      closing = (async () => {
        await Promise.allSettled([...pending]);
        await host.close();
        state = "closed";
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
  });
}

/** Explicit native embedding only; this does not provision or authenticate a VS Code client. */
export async function startManagedClientHost(options: {
  optIn: true;
  dataPath: string;
  configPath: string;
  policy: StandaloneHostPolicy;
  expectedWorkspaceId: string;
  resolveSecret(reference: string): Promise<string | undefined>;
  legacyRecipes?: LegacyRecipeHostPolicy;
}): Promise<ManagedClientHost> {
  if (options?.optIn !== true || typeof options.expectedWorkspaceId !== "string" || !options.expectedWorkspaceId)
    throw new Error("Managed host requires explicit opt-in and a workspace binding.");
  if (options.legacyRecipes && options.legacyRecipes.actorId !== actor.id)
    throw new Error("Managed Recipe actor binding mismatch.");
  const host = await startStandaloneHost({
    dataPath: options.dataPath, configPath: options.configPath, policy: options.policy,
    resolveSecret: options.resolveSecret, authenticateHuman: () => null,
    ...(options.legacyRecipes ? { legacyRecipes: options.legacyRecipes } : {}),
  });
  try { return bindManagedClientHost(host, options.expectedWorkspaceId); }
  catch (error) {
    try { await host.close(); } catch { throw new Error("Managed host binding failed and shutdown is incomplete."); }
    throw error;
  }
}

/** In-process experimental adoption only; the Storage lease is not transferable over IPC. */
type AdoptedManagedClientOptions = {
  optIn: true;
  dataPath: string;
  configPath: string;
  policy: StandaloneHostPolicy;
  expectedWorkspaceId: string;
  resolveSecret(reference: string): Promise<string | undefined>;
  legacyRecipes?: LegacyRecipeHostPolicy;
};

/** Both capabilities belong to one trusted owner and one native runtime. */
export async function startAdoptedRootUnifiedHost(options: AdoptedManagedClientOptions, adoption: LegacyRootAdoptionResult): Promise<{
  managed: ManagedClientHost;
  ownerResourceContext(): ReturnType<StandaloneHost["ownerResourceContext"]>;
}> {
  if (options?.optIn !== true || !adoption || options.expectedWorkspaceId !== adoption.workspaceId
    || !options.expectedWorkspaceId)
    throw new Error("Managed adopted host requires its exact workspace binding.");
  if (options.legacyRecipes && options.legacyRecipes.actorId !== actor.id)
    throw new Error("Managed Recipe actor binding mismatch.");
  const host = await startStandaloneHostFromAdoptedRoot({
    dataPath: options.dataPath, configPath: options.configPath, policy: options.policy,
    resolveSecret: options.resolveSecret, authenticateHuman: () => null,
    ...(options.legacyRecipes ? { legacyRecipes: options.legacyRecipes } : {}),
  }, adoption);
  try {
    const managed = bindManagedClientHost(host, options.expectedWorkspaceId);
    return Object.freeze({ managed, ownerResourceContext: () => host.ownerResourceContext() });
  }
  catch (error) {
    try { await host.close(); }
    catch {
      throw Object.assign(new Error("Managed adopted host binding failed and shutdown is unconfirmed."),
        { retryCleanup: () => host.close() });
    }
    throw error;
  }
}

export async function startManagedClientHostFromAdoptedRoot(
  options: AdoptedManagedClientOptions, adoption: LegacyRootAdoptionResult,
): Promise<ManagedClientHost> {
  return (await startAdoptedRootUnifiedHost(options, adoption)).managed;
}
