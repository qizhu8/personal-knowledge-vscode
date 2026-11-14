import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ManagedClientHost } from "./managed-client-host.js";
import { inspectLegacyApiChatArchive, validateLegacyApiChatImages } from "./legacy-api-chat-archive.js";
import { OwnedChatStartupCleanupError } from "./legacy-api-chat-process-owned-host.js";
import { startSelectedOwnerSnapshotChat } from "./managed-client-snapshot-chat.js";
import { createProductionChatModel } from "./production-chat-model.js";
import { managedVscodeModelIpc } from "./managed-vscode-model-ipc.js";
import { assertSelectedChatRecovery, type SelectedChatRecoveryPin } from "./selected-chat-recovery.js";
import type { managedSelectedOwnerIpc } from "./managed-selected-owner-ipc.js";
import type { ModelProviderTool } from "./model-provider-contracts.js";
import { selectedChatPermissionStore } from "./selected-chat-permission-store.js";

const requestSchema = z.strictObject({
  type: z.literal("selected-chat-start"), id: z.string().uuid(), session: z.string().uuid(),
  chats: z.array(z.strictObject({ namespace: z.string().regex(/^[a-f0-9]{16}$/), chatId: z.string().uuid() })).min(1).max(128),
  commands: z.array(z.strictObject({ id: z.string().min(1).max(128), program: z.string().min(1).max(1024),
    cwd: z.string().min(1).max(4096), arguments: z.array(z.array(z.string().max(8000)).max(32)).min(1).max(32) })).max(16),
  permissionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  model: z.strictObject({ provider: z.enum(["openai-compatible", "azure-openai", "vscode"]),
    endpoint: z.string().max(2048), model: z.string().max(200), apiVersion: z.string().max(128).optional(),
    apiKey: z.string().max(4096), contextWindow: z.number().int(), maxOutputTokens: z.number().int(),
    outputTokenParameter: z.enum(["max_tokens", "max_completion_tokens"]), includeUsage: z.boolean(),
    status: z.enum(["active", "unknown", "deprecated"]), deprecatedAt: z.string().optional(), timeoutMs: z.number().int().optional(),
    vscodeModelId: z.string().min(1).max(512).optional(), vscodeTools: z.boolean().optional(),
    vscodeImageInput: z.boolean().optional() }),
});

const tools: ModelProviderTool[] = [
  { name: "run_process", description: "Run an explicitly configured non-interactive program after the user's Chat approval.",
    parameters: { type: "object", properties: { program: { type: "string" }, arguments: { type: "array", items: { type: "string" } },
      cwd: { type: "string" }, timeoutSeconds: { type: "integer" }, background: { type: "boolean" },
      idempotency_key: { type: "string" } }, required: ["program", "arguments"], additionalProperties: false } },
  { name: "process_get", description: "Read this Chat's process status.",
    parameters: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false } },
  { name: "process_output", description: "Read a bounded range of this Chat's process output.",
    parameters: { type: "object", properties: { handle: { type: "string" }, stream: { type: "string", enum: ["stdout", "stderr"] },
      start: { type: "integer" }, length: { type: "integer" } }, required: ["handle", "stream"], additionalProperties: false } },
  { name: "process_cancel", description: "Request cancellation of this Chat's managed process.",
    parameters: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false } },
];

/** Explicitly selected, parent-forked Chat. It does not activate or adopt a legacy root. */
export function managedClientSelectedChatIpc(options: {
  owner: ReturnType<typeof managedSelectedOwnerIpc>;
  host(): ManagedClientHost | undefined;
  workspace(): string | undefined;
  source(): string | undefined;
  recovery?(): SelectedChatRecoveryPin | undefined;
  unavailable(): boolean;
  send(message: object): void;
}) {
  let starting: Promise<void> | undefined;
  let activeSession: string | undefined;
  const reviews = new Map<string, { session: string; resolve(approved: boolean): void }>();
  const vscodeModels = managedVscodeModelIpc({ send: options.send, connected: () => !!process.connected });
  return {
    get busy() { return !!starting; },
    async drain() { await starting; },
    handle(message: Record<string, unknown>) {
      if (vscodeModels.handle(message)) return true;
      if (message.type === "selected-chat-review-response") {
        const entry = typeof message.id === "string" ? reviews.get(message.id) : undefined;
        if (entry && entry.session === message.session && typeof message.approved === "boolean")
          entry.resolve(message.approved);
        return true;
      }
      if (message.type === "selected-chat-list") {
        if (typeof message.id !== "string" || !z.string().uuid().safeParse(message.id).success
          || typeof message.session !== "string" || !z.string().uuid().safeParse(message.session).success) return true;
        try {
          if (options.unavailable() || !options.source()) throw new Error("Chat source unavailable.");
          const selected = options.owner.capability(message.session);
          selected.assertCurrent();
          const archive = inspectLegacyApiChatArchive(options.source()!);
          if (!archive) throw new Error("No supported Chat archive.");
          const recovery = options.recovery?.();
          if (recovery) assertSelectedChatRecovery(recovery, options.source()!);
          const chats = archive.chats.filter(chat => !recovery || chat.namespace === recovery.namespace && chat.id === recovery.chatId)
            .map(chat => ({ namespace: chat.namespace, chatId: chat.id,
            title: chat.metadata.title, modelProvider: chat.metadata.modelProvider ?? null,
            modelProfileId: chat.metadata.modelProfileId ?? null, vscodeModelId: chat.metadata.vscodeModelId ?? null,
            contextWindow: chat.metadata.contextWindow ?? null, maxOutputTokens: chat.metadata.maxOutputTokens ?? null }));
          selected.assertCurrent();
          options.send({ type: "result", id: message.id, result: { chats } });
        } catch {
          options.send({ type: "result", id: message.id, error: "SELECTED_CHAT_SOURCE_CONFLICT",
            message: "Original Chat source is unavailable or changed; no history was modified." });
        }
        return true;
      }
      if (message.type !== "selected-chat-start") return false;
      const parsed = requestSchema.safeParse(message);
      if (!parsed.success) {
        if (typeof message.id === "string") options.send({ type: "result", id: message.id, error: "BUSY_OR_INVALID" });
        return true;
      }
      const input = parsed.data, root = options.source(), workspace = options.workspace(), host = options.host();
      if (starting || activeSession || options.unavailable() || !root || !workspace || !host) {
        options.send({ type: "result", id: input.id, error: "BUSY_OR_INVALID" }); return true;
      }
      activeSession = input.session;
      starting = (async () => {
        let database: DatabaseSync | undefined;
        let permissionsDatabase: DatabaseSync | undefined;
        let permissionStore: ReturnType<typeof selectedChatPermissionStore> | undefined;
        let unregister: (() => void) | undefined;
        let startup: ReturnType<typeof startSelectedOwnerSnapshotChat> | undefined;
        let child: Awaited<ReturnType<typeof startSelectedOwnerSnapshotChat>> | undefined;
        let cleanup: (() => Promise<void>) | undefined;
        try {
          const selected = options.owner.capability(input.session), signal = options.owner.signal(input.session);
          selected.assertCurrent();
          if (input.permissionKey && input.chats.length !== 1) throw new Error("Persistent permissions require one selected Chat.");
          const recovery = options.recovery?.();
          if (recovery) {
            assertSelectedChatRecovery(recovery, root);
            if (input.chats.length !== 1 || input.chats[0].namespace !== recovery.namespace || input.chats[0].chatId !== recovery.chatId)
              throw new Error("Chat recovery is restricted to the independently pinned selection.");
          }
          const allowed = new Set(input.chats.map(chat => `${chat.namespace}:${chat.chatId}`));
          if (allowed.size !== input.chats.length) throw new Error("Duplicate Chat selection.");
          const source = inspectLegacyApiChatArchive(root);
          if (!source || input.chats.some(chat => !source.chats.some(item => item.namespace === chat.namespace && item.id === chat.chatId)))
            throw new Error("Selected original Chat is unavailable.");
          const control = join(dirname(workspace), "control"), controlStat = lstatSync(control);
          if (realpathSync(control) !== control || !controlStat.isDirectory() || controlStat.isSymbolicLink()
            || controlStat.uid !== process.getuid?.() || (controlStat.mode & 0o7077) !== 0)
            throw new Error("Private Chat host directory is unavailable.");
          const parent = join(control, `selected-chat-${input.session}`);
          mkdirSync(parent, { mode: 0o700 });
          const captureDirectory = join(parent, "capture");
          mkdirSync(captureDirectory, { mode: 0o700 });
          database = new DatabaseSync(join(parent, "process.sqlite"));
          let snapshotRoot: string | undefined, closed = false, cleaning: Promise<void> | undefined;
          const grants = new Map<string, { scopes: Set<string>; allowAll: boolean }>();
          const assertCurrent = () => {
            if (signal.aborted) throw new Error("Selected Chat connection closed.");
            if (recovery) assertSelectedChatRecovery(recovery, root!);
            selected.assertCurrent();
          };
          const permitted = (binding: { namespace: string; chatId: string }) =>
            allowed.has(`${binding.namespace}:${binding.chatId}`);
          const modelOptions = { ...input.model, assertCurrent };
          if (input.model.provider === "vscode" && (!input.model.vscodeModelId || input.model.endpoint || input.model.apiKey
            || typeof input.model.vscodeTools !== "boolean" || typeof input.model.vscodeImageInput !== "boolean"
            || !Number.isSafeInteger(input.model.timeoutMs ?? 1800000)
            || (input.model.timeoutMs ?? 1800000) < 1 || (input.model.timeoutMs ?? 1800000) > 1800000))
            throw new Error("Selected VS Code model binding is invalid.");
          const model = input.model.provider === "vscode"
            ? vscodeModels.model(input.session, input.model.vscodeTools ? tools : [], assertCurrent, input.model.timeoutMs ?? 1800000, input.model.vscodeImageInput)
            : createProductionChatModel({ ...modelOptions, tools: async () => tools });
          const plainModel = input.model.provider === "vscode"
            ? vscodeModels.model(input.session, [], assertCurrent, input.model.timeoutMs ?? 1800000, input.model.vscodeImageInput)
            : createProductionChatModel({ ...modelOptions, tools: async () => [] });
          cleanup = () => {
            if (closed) return Promise.resolve();
            if (!cleaning) {
              const task = Promise.resolve().then(async () => {
                if (startup) {
                  try { child ??= await startup; }
                  catch (error) {
                    if (error instanceof OwnedChatStartupCleanupError || error instanceof AggregateError) throw error;
                  }
                }
                await child?.close();
                permissionsDatabase?.close(); database?.close(); closed = true; unregister?.(); activeSession = undefined;
              }).catch(error => {
                if (cleaning === task) cleaning = undefined;
                throw error;
              });
              cleaning = task;
            }
            return cleaning;
          };
          unregister = selected.registerChildClose(cleanup);
          startup = startSelectedOwnerSnapshotChat({
            selected, connection: signal, sourceRoot: root, privateParent: parent, commands: input.commands,
            ...(recovery ? { recovery: { root: recovery.snapshotRoot, sourceFingerprint: recovery.sourceFingerprint } } : {}),
            profile: { id: input.session, workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent,
              async policy(binding) {
                assertCurrent();
                if (!snapshotRoot || !permitted(binding)) throw new Error("Chat profile binding changed.");
                const archive = inspectLegacyApiChatArchive(snapshotRoot);
                const chat = archive?.chats.find(item => item.namespace === binding.namespace && item.id === binding.chatId);
                if (!chat) throw new Error("Selected Chat is unavailable.");
                const state = permissionStore?.read() ?? grants.get(`${binding.namespace}:${binding.chatId}`);
                const mode = chat.metadata.permissionMode === "read-only" ? "read-only"
                  : state?.allowAll ? "allow-all" : chat.metadata.permissionMode === "protective" ? "protective" : "ask";
                return { available: true, trusted: true, localControls: true, permissionMode: mode,
                  permissionGrants: [...(state?.scopes ?? [])] };
              },
              async remember(binding, scope, choice, assertCommitCurrent) {
                assertCurrent();
                if (!permitted(binding)) throw new Error("Chat approval binding changed.");
                if (permissionStore) {
                  permissionStore.remember(scope, choice, assertCommitCurrent);
                  return;
                }
                const key = `${binding.namespace}:${binding.chatId}`, state = grants.get(key) ?? { scopes: new Set<string>(), allowAll: false };
                if (choice === "allow-all") state.allowAll = true; else state.scopes.add(scope);
                grants.set(key, state);
              } },
            owner: { database, captureDirectory, originalEvidence: { root, assertCurrent } },
            chat: { chats: input.chats, authorize: async binding => permitted(binding),
              provider: async (messages, abort) => {
                const userIndex = messages.findLastIndex(message => message.role === "user");
                const currentImages = userIndex >= 0 ? messages[userIndex].images : undefined;
                validateLegacyApiChatImages(currentImages);
                if (currentImages?.length && (!plainModel.imageInput || currentImages.length > 2))
                  throw new Error("Image transport is unavailable for this Chat model.");
                let text = "";
                for await (const event of plainModel.stream({ actor: "local:owner", turnId: randomUUID(), step: 0,
                  messages: messages.map(({ images, ...message }, index) => ({ ...message,
                    content: index !== userIndex && images?.length
                      ? `${message.content}\n${images.map(image => `[image omitted: ${image.label}]`).join("\n")}` : message.content })),
                  ...(currentImages?.length ? { images: { messageIndex: userIndex,
                    items: currentImages as Array<{ label: string; mimeType: "image/png" | "image/jpeg"; dataBase64: string }> } } : {}),
                  maxInputTokens: input.model.contextWindow, maxOutputTokens: input.model.maxOutputTokens, signal: abort })) {
                  if (event.type === "text") text += event.text;
                  else if (event.type === "tool") throw new Error("Plain Chat cannot invoke tools.");
                }
                return text;
              },
              managed: { model, authorize: async binding => permitted(binding),
                authorizeQueue: async binding => { assertCurrent(); return permitted(binding); },
                authorizeUserReview: async binding => {
                  assertCurrent();
                  if (!permitted(binding) || !binding.userRequired) return false;
                  const id = randomUUID();
                  return new Promise<boolean>(resolve => {
                    let done = false;
                    const finish = (approved: boolean) => {
                      if (done) return;
                      done = true; clearTimeout(timer); signal.removeEventListener("abort", cancel); reviews.delete(id);
                      try { assertCurrent(); resolve(approved); } catch { resolve(false); }
                    };
                    const cancel = () => finish(false);
                    const timer = setTimeout(cancel, 30000);
                    reviews.set(id, { session: input.session, resolve: finish });
                    signal.addEventListener("abort", cancel, { once: true });
                    if (signal.aborted) { finish(false); return; }
                    try {
                      options.send({ type: "selected-chat-review-request", id, session: input.session,
                        namespace: binding.namespace, chatId: binding.chatId, expectedDigest: binding.expectedDigest,
                        decision: binding.decision, reason: binding.reason });
                    } catch { finish(false); }
                  });
                },
                tools: { available: true, async execute() { throw new Error("Tool is unavailable in this selected Chat."); } } } },
            onCloseError: () => {},
          });
          child = await startup;
          snapshotRoot = child.snapshotRoot;
          assertCurrent();
          if (input.permissionKey) {
            permissionsDatabase = selected.storage.connectNative();
            const sourceFingerprint = inspectLegacyApiChatArchive(snapshotRoot)?.sourceFingerprint;
            if (!sourceFingerprint) throw new Error("Chat permission source is unavailable.");
            permissionStore = selectedChatPermissionStore({ database: permissionsDatabase, secret: input.permissionKey,
              workspaceId: host.workspaceId, ...input.chats[0], sourceFingerprint, commands: input.commands, assertCurrent });
            permissionStore.read();
          }
          options.send({ type: "result", id: input.id, result: { endpoint: child.endpoint, bearer: child.bearer,
            root: snapshotRoot, workspaceId: host.workspaceId, actorId: "local:owner",
            sourceFingerprint: inspectLegacyApiChatArchive(snapshotRoot)!.sourceFingerprint } });
        } catch (error) {
          options.send({ type: "result", id: input.id, error: "SELECTED_CHAT_START_FAILED",
            message: error instanceof Error ? error.message.slice(0, 1000) : "Chat startup failed." });
          if (!startup || !(error instanceof AggregateError || error instanceof OwnedChatStartupCleanupError)) {
            try {
              if (cleanup) await cleanup();
              else { permissionsDatabase?.close(); database?.close(); unregister?.(); activeSession = undefined; }
            }
            catch { /* Preserve owner on unknown cleanup. */ }
          }
        } finally { starting = undefined; }
      })();
      return true;
    },
  };
}
