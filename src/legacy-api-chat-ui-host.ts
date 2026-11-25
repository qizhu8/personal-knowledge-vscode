import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { LegacyApiChatRuntime, type LegacyApiChatRuntimeOptions, type LegacyApiChatIdentity } from "./legacy-api-chat-runtime.js";
import { readLegacyChatSource } from "./legacy-api-chat-source.js";
import { nativeTodoUserInput, type NativeTodoUserAuthority } from "./native-todo-user-ui.js";
import { scanBoards } from "./boards.js";
import { todoBoardWorkers } from "./domain/todo-board.js";
import { legacyTodoBoardCreateArguments } from "./legacy-todo-board-create-contracts.js";
import { nativeBoardLifecycleInput, resolveNativeBoardKey } from "./native-board-lifecycle-state.js";
import { nativeApiChatLibraryInput } from "./legacy-api-chat-library.js";
import { LegacyManagedApiChatRuntime, type LegacyManagedChatRuntimeOptions } from "./legacy-api-chat-managed-runtime.js";
import { nativeApiChatTaskControl } from "./legacy-api-chat-task-control.js";
import { nativeApiChatQueueInput, nativeApiChatReviewInput } from "./legacy-api-chat-workflow.js";
import { nativeChatMemoryAction, type LegacyApiChatMemory } from "./legacy-api-chat-memory.js";
import { nativeChatRecipeCreate, nativeChatRecipeCancel, nativeChatRecipeLibrary, nativeChatRecipeEditor, nativeChatRecipeHistory,
  type LegacyApiChatRecipes } from "./legacy-api-chat-recipes.js";
import { recipePublicApprovalInput, recipePublicLazyRequest, recipePublicLazyApproval, type NativeRecipePublicApi } from "./native-recipe-public-api.js";
import { pythonRecipeRequestSchema, pythonRecipeApprovalSchema, type HostPythonRecipe } from "./host-python-recipe.js";
import type { LegacyApiChatProcesses } from "./legacy-api-chat-process.js";
import type { LegacyChatProcessApprovalUi } from "./legacy-api-chat-process-approval-ui.js";

const identity = { namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid() };
const requestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("status") }),
  z.strictObject({ method: z.literal("process-control"), ...identity,
    handle: z.string().regex(/^process_[a-f0-9]{64}$/), operation: z.enum(["status", "pause", "resume", "stop"]) }),
  z.strictObject({ method: z.literal("process-approvals"), ...identity }),
  z.strictObject({ method: z.literal("process-approval-decide"), ...identity, id: z.string().uuid(),
    choice: z.enum(["approve", "approve-once", "deny", "allow-all"]) }),
  z.strictObject({ method: z.literal("list") }),
  z.strictObject({ method: z.literal("library") }),
  z.strictObject({ method: z.literal("library-mutate"), input: nativeApiChatLibraryInput }),
  z.strictObject({ method: z.literal("task-control"), input: nativeApiChatTaskControl }),
  z.strictObject({ method: z.literal("queue"), input: nativeApiChatQueueInput }),
  z.strictObject({ method: z.literal("outcome-decide"), input: nativeApiChatReviewInput }),
  z.strictObject({ method: z.literal("outcome-review"), ...identity }),
  z.strictObject({ method: z.literal("memory-state"), ...identity }),
  z.strictObject({ method: z.literal("memory-action"), input: nativeChatMemoryAction }),
  z.strictObject({ method: z.literal("recipe-state"), ...identity }),
  z.strictObject({ method: z.literal("recipe-create"), input: nativeChatRecipeCreate }),
  z.strictObject({ method: z.literal("recipe-cancel"), input: nativeChatRecipeCancel }),
  z.strictObject({ method: z.literal("recipe-history-get"), input: nativeChatRecipeHistory }),
  z.strictObject({ method: z.literal("recipe-library-save"), input: nativeChatRecipeLibrary }),
  z.strictObject({ method: z.literal("recipe-public-approve"), input: recipePublicApprovalInput }),
  z.strictObject({ method: z.literal("recipe-public-lazy-preview"), ...identity, input: recipePublicLazyRequest }),
  z.strictObject({ method: z.literal("recipe-public-lazy-approve"), ...identity, input: recipePublicLazyApproval }),
  z.strictObject({ method: z.literal("recipe-python-preview"), ...identity, input: pythonRecipeRequestSchema }),
  z.strictObject({ method: z.literal("recipe-python-approve"), ...identity, input: pythonRecipeApprovalSchema }),
  z.strictObject({ method: z.literal("recipe-editor"), input: nativeChatRecipeEditor }),
  z.strictObject({ method: z.literal("recipe-validate"), ...identity, definition: z.json() }),
  z.strictObject({ method: z.literal("todo"), input: nativeTodoUserInput }),
  z.strictObject({ method: z.literal("todo-boards") }),
  z.strictObject({ method: z.literal("todo-create"), input: legacyTodoBoardCreateArguments.extend({ operationId: z.string().uuid() }) }),
  z.strictObject({ method: z.literal("todo-lifecycle"), input: nativeBoardLifecycleInput }),
  z.strictObject({ method: z.literal("todo-trash") }),
  z.strictObject({ method: z.literal("todo-link"), boardSlug: z.string().min(1).max(1024), uri: z.string().min(1).max(2048) }),
  z.strictObject({ method: z.literal("history"), ...identity }),
  z.strictObject({ method: z.literal("harness"), ...identity, sessionId: z.string().regex(/^agent_session_[a-f0-9]{32}$/) }),
  z.strictObject({ method: z.literal("continue"), ...identity, operationId: z.string().min(1).max(128),
    expectedRevision: z.number().int().nonnegative(), text: z.string().min(1).max(100_000),
    images: z.array(z.strictObject({ label: z.string(), mimeType: z.string(), dataBase64: z.string() })).max(2).optional() }),
]);

/** Explicit private native host port, never registered or started by the default server/CLI. */
export async function startLegacyApiChatUiHost(options: LegacyApiChatRuntimeOptions & {
  chats: readonly LegacyApiChatIdentity[]; todoBoards?: readonly string[];
  managed?: Omit<LegacyManagedChatRuntimeOptions, "storage" | "actorId" | "chatSource">;
  memory?: LegacyApiChatMemory;
  recipes?: LegacyApiChatRecipes;
  publicRecipes?: NativeRecipePublicApi;
  pythonRecipes?: HostPythonRecipe;
  processes?: LegacyApiChatProcesses;
  processApprovalUi?: LegacyChatProcessApprovalUi;
  todoAuthority?: NativeTodoUserAuthority;
  authorizeTodo?: (binding: { root: string; workspaceId: string; actorId: string; boardSlug: string; readOnly: boolean }) => Promise<boolean>;
  authorizeTodoCreate?: (binding: { root: string; workspaceId: string; actorId: string }) => Promise<boolean>;
  authorizeTodoLifecycle?: (binding: { root: string; workspaceId: string; actorId: string;
    boardSlug: string | null; kind: "move" | "trash" | "restore" | "list" }) => Promise<boolean>;
}) {
  if (options.processApprovalUi && !options.processes) throw new Error("Chat process approval UI requires its process authority.");
  if (options.chatSource && options.chatSource.root !== options.storage.workspaceRoot()
    && (options.memory || options.recipes || options.publicRecipes || options.pythonRecipes
      || options.todoAuthority || options.todoBoards?.length))
    throw new Error("A separate Chat source does not authorize Memory, Recipe or Todo hosts.");
  const runtime = new LegacyApiChatRuntime({ ...options, libraryChatIds: options.chats.map(chat => chat.chatId) });
  let managed: LegacyManagedApiChatRuntime | undefined;
  try { if (options.managed) managed = new LegacyManagedApiChatRuntime({
    ...options.managed, storage: options.storage, actorId: options.actorId, chatSource: options.chatSource,
    tools: { ...options.managed.tools, execute: request => {
      if (options.processes?.handles(request.call.name)) {
        const args = request.call.arguments;
        if (request.call.name === "process_get" && Object.keys(args).length === 1
          && typeof args.handle === "string" && !/^process_[a-f0-9]{64}$/.test(args.handle)
          && !request.signal.aborted)
          return Promise.resolve({ executionId: request.operationId, resultStatus: "failed" as const,
            content: JSON.stringify({ error: "Choose an exact process handle returned by run_process." }) });
        return options.processes.execute(request.binding, request);
      }
      return options.managed!.tools.execute(request);
    } },
  }); } catch (error) { await runtime.drain(); throw error; }
  const isManaged = (chat: LegacyApiChatIdentity) => {
    const source = readLegacyChatSource(options.storage, options.chatSource)?.chats
      .find(source => source.namespace === chat.namespace && source.id === chat.chatId);
    return !!(source?.metadata.sessionId || source?.metadata.workerState || managed?.hasTaskControl(chat));
  };
  const historyFor = async (chat: LegacyApiChatIdentity) => {
    if (managed && isManaged(chat)) return managed.history(chat);
    const history = await runtime.history(chat);
    return managed ? { ...history, taskControl: await managed.controlState(chat) } : history;
  };
  const bearer = randomBytes(32).toString("base64url");
  let admitting = true;
  const allowed = new Set(options.chats.map(chat => `${chat.namespace}:${chat.chatId}`));
  const todoBoards = new Set(options.todoBoards ?? []);
  const server = createServer(async (request, response) => {
    const disconnected = new AbortController();
    response.once("close", () => { if (!response.writableEnded) disconnected.abort(); });
    try {
      const authorization = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${bearer}`);
      if (!admitting || authorization.length !== expected.length
        || !timingSafeEqual(authorization, expected) || request.headers["x-pkm-native-actor"] !== options.actorId) {
        response.writeHead(403); response.end(); return;
      }
      if (request.method !== "POST" || request.url !== "/rpc" || request.headers.origin) {
        response.writeHead(400); response.end(); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_097_152) throw new Error("Native UI request exceeds 2 MiB.");
        chunks.push(chunk);
      }
      const input = requestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      options.storage.assertWorkspaceLease();
      let value: unknown;
      if (input.method === "status") {
        const archive = readLegacyChatSource(options.storage, options.chatSource);
        if (!archive) throw new Error("Original API Chat archive is unavailable.");
        value = { root: archive.root, workspaceId: await options.storage.workspaceId(), actorId: options.actorId,
          sourceFingerprint: archive.sourceFingerprint, todoBoards: [...todoBoards], library: !!options.authorizeLibrary,
          managed: !!managed, memory: !!options.memory, recipes: !!options.recipes, processes: !!options.processes,
          processApprovalUi: !!options.processApprovalUi };
      } else if (input.method === "process-control" || input.method === "process-approvals" || input.method === "process-approval-decide") {
        if (!options.processes || !allowed.has(`${input.namespace}:${input.chatId}`))
          throw new Error("Process control is outside this exact freshly authorized native Chat host.");
        await historyFor(input);
        const archive = readLegacyChatSource(options.storage, options.chatSource);
        if (!archive) throw new Error("Original Chat anchor is unavailable.");
        const binding = { root: archive.root, workspaceId: await options.storage.workspaceId(),
          actorId: options.actorId, sourceFingerprint: archive.sourceFingerprint,
          namespace: input.namespace, chatId: input.chatId };
        if (input.method === "process-control")
          value = await options.processes.control(binding, input.handle, input.operation, disconnected.signal);
        else {
          if (!options.processApprovalUi) throw new Error("Interactive Chat process approval is not composed.");
          value = input.method === "process-approvals" ? await options.processApprovalUi.list(binding)
            : await options.processApprovalUi.decide(binding, input.id, input.choice);
        }
      } else if (input.method === "library" || input.method === "library-mutate") {
        value = input.method === "library" ? await runtime.library() : await runtime.mutateLibrary(input.input);
      } else if (input.method === "memory-state" || input.method === "memory-action") {
        const chat = input.method === "memory-state" ? input : input.input;
        if (!options.memory || !allowed.has(`${chat.namespace}:${chat.chatId}`))
          throw new Error("Memory is outside this exact freshly authorized native host.");
        const archive = readLegacyChatSource(options.storage, options.chatSource);
        if (!archive) throw new Error("Original Memory Chat anchor is unavailable.");
        const binding = { root: archive.root, workspaceId: await options.storage.workspaceId(),
          actorId: options.actorId, sourceFingerprint: archive.sourceFingerprint, namespace: chat.namespace, chatId: chat.chatId };
        value = input.method === "memory-state" ? await options.memory.state(binding)
          : await options.memory.action(binding, input.input);
      } else if (input.method === "recipe-state" || input.method === "recipe-create" || input.method === "recipe-cancel" || input.method === "recipe-history-get"
        || input.method === "recipe-library-save" || input.method === "recipe-editor" || input.method === "recipe-validate"
        || input.method === "recipe-public-approve" || input.method === "recipe-public-lazy-preview" || input.method === "recipe-public-lazy-approve"
        || input.method === "recipe-python-preview" || input.method === "recipe-python-approve") {
        const chat = input.method === "recipe-state" || input.method === "recipe-validate"
          || input.method === "recipe-public-lazy-preview" || input.method === "recipe-public-lazy-approve"
          || input.method === "recipe-python-preview" || input.method === "recipe-python-approve" ? input
          : input.method === "recipe-public-approve" ? input.input.args : input.input;
        if (!options.recipes || !allowed.has(`${chat.namespace}:${chat.chatId}`))
          throw new Error("Recipe is outside this exact freshly authorized native host.");
        if (["recipe-public-approve", "recipe-public-lazy-preview", "recipe-public-lazy-approve"].includes(input.method) && !options.publicRecipes)
          throw new Error("Public Recipe host approval is not composed.");
        const archive = readLegacyChatSource(options.storage, options.chatSource);
        if (!archive) throw new Error("Original Recipe Chat anchor is unavailable.");
        const binding = { root: archive.root, workspaceId: await options.storage.workspaceId(),
          actorId: options.actorId, sourceFingerprint: archive.sourceFingerprint, namespace: chat.namespace, chatId: chat.chatId };
        if (input.method === "recipe-python-preview" || input.method === "recipe-python-approve") {
          if (!options.pythonRecipes)
            throw new Error("Separate private SQL Python Recipe authority is not composed.");
          const request = input.method === "recipe-python-preview" ? input.input : input.input.request;
          if (request.args.namespace !== binding.namespace || request.args.chatId !== binding.chatId)
            throw new Error("Python Recipe approval Chat scope changed.");
          await options.recipes.catalog(binding);
        }
        value = input.method === "recipe-state" ? { ...await options.recipes.state(binding),
          publicApiEnabled: !!options.publicRecipes, publicLazyEnabled: options.publicRecipes?.lazyEnabled() === true }
          : input.method === "recipe-python-preview" ? await options.pythonRecipes!.preview(input.input)
          : input.method === "recipe-python-approve" ? await options.pythonRecipes!.approve(input.input)
          : input.method === "recipe-public-lazy-preview" ? await options.publicRecipes!.previewLazy(binding, input.input)
          : input.method === "recipe-public-lazy-approve" ? await options.publicRecipes!.approveLazy(binding, input.input)
          : input.method === "recipe-public-approve" ? await options.publicRecipes?.approve(binding, input.input)
          : input.method === "recipe-create" ? await options.recipes.create(binding, input.input)
          : input.method === "recipe-history-get" ? await options.recipes.originalRun(binding, input.input.runId, input.input.expectedSha256)
          : input.method === "recipe-cancel" ? await options.recipes.cancel(binding, input.input)
          : input.method === "recipe-editor" ? await options.recipes.editor(binding, input.input)
          : input.method === "recipe-validate" ? await options.recipes.validateLibrary(binding, input.definition)
          : await options.recipes.saveLibrary(binding, input.input);
      } else if (input.method === "task-control" || input.method === "queue" || input.method === "outcome-decide") {
        if (!managed || !allowed.has(`${input.input.namespace}:${input.input.chatId}`))
          throw new Error("Task control is outside this exact freshly authorized native host.");
        value = input.method === "task-control" ? await managed.control(input.input)
          : input.method === "queue" ? await managed.queue(input.input) : await managed.review(input.input);
        if (input.method === "task-control" && input.input.kind === "cancel" && options.processes) {
          const archive = readLegacyChatSource(options.storage, options.chatSource);
          if (!archive) throw new Error("Original Chat anchor is unavailable.");
          await options.processes.cancelAll({ root: archive.root, workspaceId: await options.storage.workspaceId(),
            actorId: options.actorId, sourceFingerprint: archive.sourceFingerprint,
            namespace: input.input.namespace, chatId: input.input.chatId });
        }
      } else if (input.method === "todo-boards" || input.method === "todo-create") {
        if (!options.todoAuthority || !options.authorizeTodoCreate || !await options.authorizeTodoCreate({
          root: options.storage.workspaceRoot(), workspaceId: await options.storage.workspaceId(), actorId: options.actorId,
        })) throw new Error("Trusted user Board creation/list authority is unavailable.");
        value = input.method === "todo-create"
          ? await options.storage.createNativeTodoUserBoard(input.input, options.todoAuthority)
          : options.storage.nativeTodoUserBoards(options.todoAuthority);
      } else if (input.method === "todo-lifecycle" || input.method === "todo-trash") {
        if (!options.todoAuthority || !options.authorizeTodoLifecycle || !await options.authorizeTodoLifecycle({
          root: options.storage.workspaceRoot(), workspaceId: await options.storage.workspaceId(), actorId: options.actorId,
          boardSlug: input.method === "todo-lifecycle" ? input.input.boardSlug : null,
          kind: input.method === "todo-lifecycle" ? input.input.kind : "list",
        })) throw new Error("Trusted user Board file lifecycle authority is unavailable.");
        value = input.method === "todo-trash" ? options.storage.nativeTodoUserBoardTrash(options.todoAuthority)
          : await options.storage.requestNativeBoardLifecycle(input.input, options.todoAuthority);
      } else if (input.method === "todo-link") {
        if (!options.todoAuthority || !options.storage.nativeTodoUserBoards(options.todoAuthority).includes(input.boardSlug)
          || !options.authorizeTodo || !await options.authorizeTodo({
            root: options.storage.workspaceRoot(), workspaceId: await options.storage.workspaceId(), actorId: options.actorId,
            boardSlug: input.boardSlug, readOnly: true,
          })) throw new Error("Linked Note is outside this exact private Board authority.");
        const snapshot = await options.storage.requestNativeTodoUser({ kind: "read", boardSlug: input.boardSlug }, [], options.todoAuthority) as {
          items: Array<{ links?: string[]; evidence?: string[] }>;
        };
        const match = /^pkm:\/\/knowledge\/([A-Za-z0-9_-]{1,80})$/.exec(input.uri);
        if (!match || !snapshot.items.some(item => [...(item.links ?? []), ...(item.evidence ?? [])].includes(input.uri)))
          throw new Error("Open only an exact identity link recorded on this current Board.");
        const note = await options.storage.request({ operation: "knowledge.note.get", actorId: options.actorId,
          args: { id: match[1] } }) as { item: Record<string, unknown> };
        const key = resolveNativeBoardKey(options.storage.workspaceRoot(), String(note.item.path).replace(/\.md$/i, ""));
        value = note.item.documentKind === "todo-board" && options.storage.nativeTodoUserBoards(options.todoAuthority).includes(key)
          ? { kind: "board", boardSlug: key, note: note.item } : { kind: "note", note: note.item };
      } else if (input.method === "todo") {
        const admitted = options.todoAuthority ? options.storage.nativeTodoUserBoards(options.todoAuthority) : [...todoBoards];
        if (!admitted.includes(input.input.boardSlug) || !options.authorizeTodo || !await options.authorizeTodo({
          root: options.storage.workspaceRoot(), workspaceId: await options.storage.workspaceId(), actorId: options.actorId,
          boardSlug: input.input.boardSlug, readOnly: input.input.kind === "read",
        })) throw new Error("Original Todo user authority is outside its explicit private host grant.");
        const chats = [];
        for (const chat of options.chats) {
          const history = await historyFor(chat);
          chats.push({ id: `chat:${chat.chatId}`, title: history.metadata.title,
            chatUrl: `pkm://chats/${chat.namespace}/${chat.chatId}` });
        }
        const snapshot = await options.storage.requestNativeTodoUser(input.input, chats, options.todoAuthority);
        const note = await options.storage.request({ operation: "knowledge.note.get",
          args: { path: `${input.input.boardSlug}.md` }, actorId: options.actorId }) as { item: Record<string, unknown> };
        const projects = await options.storage.request({ operation: "project.list", args: {}, actorId: options.actorId }) as { items: unknown[] };
        value = { snapshot, content: note.item.content, note: note.item, projects: projects.items,
          chats: chats.map(chat => ({ ...chat, id: chat.id.slice("chat:".length) })), documentKind: "todo-board",
          workerGrants: todoBoardWorkers(scanBoards(options.storage.workspaceRoot()).get(input.input.boardSlug)!.raw) };
      } else if (input.method === "list") {
        const rows = [];
        const library = options.authorizeLibrary ? (await runtime.library()).state : undefined;
        for (const chat of options.chats) {
          const history = await historyFor(chat);
          const placement = library?.placements[chat.chatId];
          rows.push({ ...chat, id: chat.chatId, groupId: placement?.groupId ?? "ungroup",
            ...(placement?.trashedAt ? { trashedAt: placement.trashedAt } : {}), title: history.metadata.title,
            createdAt: history.metadata.createdAt, updatedAt: Math.max(Number(history.metadata.updatedAt) || 0,
              ...((history as any).nativeTurns ?? []).map((turn: any) => turn.updatedAt),
              ...((history as any).nativeWorkers ?? []).map((turn: any) => turn.updatedAt)),
            revision: history.revision, taskControl: history.taskControl, queueControl: history.queueControl,
            pending: history.pending.map((item: any) => ({ operationId: item.operationId, status: item.status })),
            nativeTurns: (history as any).nativeTurns, nativeWorkers: (history as any).nativeWorkers?.map((worker: any) => ({
              id: worker.id, status: worker.status, updatedAt: worker.updatedAt, uncertain: worker.uncertain,
            })),
            status: history.pending.some((item: any) => item.status === "prepared") ? "failed"
              : history.pending.length ? "running" : "completed" });
        }
        value = rows;
      } else {
        if (!allowed.has(`${input.namespace}:${input.chatId}`)) throw new Error("Native UI Chat is outside its exact host grant.");
        if (input.method === "outcome-review") {
          if (!managed) throw new Error("No dedicated outcome-review host is configured.");
          value = await managed.reviewSnapshot(input);
        } else if (input.method === "harness") {
          const history = await historyFor(input), archive = readLegacyChatSource(options.storage, options.chatSource);
          const nativeTask = history.taskControl?.tasks.find((task: any) => task.sessionId === input.sessionId && task.authority === "native_core");
          const sourceSession = archive?.managed?.sessions.find(session => session.sessionId === input.sessionId
            && session.hostSessionId === input.chatId && session.nativeChat.workspaceNamespace === input.namespace);
          if (!sourceSession && !nativeTask) throw new Error("Harness Session is outside this exact original Chat.");
          const session = sourceSession ?? { schema: "pkm.agent.session/v1", sessionId: nativeTask.sessionId,
            taskId: nativeTask.sessionId, origin: "pkm-native", runtimeOwner: "pkm", hostKind: "pkm",
            hostSessionId: input.chatId, task: nativeTask.title, createdAt: nativeTask.createdAt,
            status: nativeTask.completedAt ? "completed" : history.taskControl.stopped ? "stopped"
              : history.taskControl.paused ? "paused" : "running",
            ...(nativeTask.completedAt ? { completedAt: nativeTask.completedAt } : {}),
            todos: [], recipeRunIds: [], nativeChat: { ...history.metadata, sessionId: input.sessionId,
              workerState: undefined, queuedInputs: [], portalCommands: [], portalTransfers: [] } };
          const originalIds = new Set(sourceSession?.nativeChat.messages.map((message: any) => message.id) ?? []);
          value = { record: session, metadataAuthority: nativeTask ? "native_core" : "archive_only",
            history: { ...history, metadata: { ...session.nativeChat, sessionId: input.sessionId },
              messages: history.messages.filter((message: any) => message.taskId === input.sessionId || originalIds.has(message.id)),
              nativeWorkers: (history.nativeWorkers ?? []).filter((worker: any) =>
                !worker.casual && (worker.taskSessionId ?? history.sourceSessionId) === input.sessionId) },
            sourceWorkers: sourceSession ? archive!.managed!.results.filter(result =>
              archive!.managed!.trees.some(tree => tree.rootChatId === input.chatId && tree.id === result.chat.workerState.treeId)) : [] };
        } else if (input.method === "history") value = await historyFor(input);
        else if (managed && isManaged(input)) {
          await managed.start(input);
          value = await managed.history(input);
        } else value = await runtime.continue(input);
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ value }));
    } catch (error) {
      response.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Native UI refused." }));
    }
  });
  try { await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }); } catch (error) { await managed?.close(); await runtime.drain(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { await runtime.drain(); server.close(); throw new Error("Private native UI listener unavailable."); }
  let closing: Promise<void> | undefined;
  return {
    endpoint: `http://127.0.0.1:${address.port}`, bearer, runtime, managed,
    close(): Promise<void> {
      return closing ??= (async () => {
        admitting = false;
        managed?.closeAdmission();
        options.processApprovalUi?.close();
        await options.processes?.close();
        await managed?.close();
        await runtime.drain();
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
        });
      })().catch(error => {
        closing = undefined;
        throw error;
      });
    },
  };
}
