"use strict";
const fs = require("node:fs"), path = require("node:path"), { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

async function main() {
  const [fixture, root, extension, nonce] = process.argv.slice(2);
  assert.equal(fs.realpathSync(fixture), fixture);
  assert.equal(fs.realpathSync(root), path.join(fixture, "knowledge"));
  assert.equal(fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8"), nonce);
  assert.equal(process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE, nonce);
  const descriptor = JSON.parse(fs.readFileSync(path.join(fixture, "native-host.json")));
  assert.equal(descriptor.root, root); assert.equal(descriptor.nonce, nonce);
  const runtime = path.join(fs.realpathSync(extension), "next-runtime/server");
  const load = name => import(pathToFileURL(path.join(runtime, "dist", `${name}.js`)).href);
  const { Storage } = await load("storage"), { createNativeRuntime } = await load("native-runtime");
  const { startLegacyApiChatUiHost } = await load("legacy-api-chat-ui-host");
  const { createLegacyApiChatLocalProvider } = await load("legacy-api-chat-local-provider");
  const { admitNativeTodoUserAuthority } = await load("native-todo-user-ui");
  const storage = await Storage.open(root, { deferRecovery: true });
  let native, ui, stopping;
  const close = () => stopping ??= (async () => {
    try { await ui?.close(); } finally { try { await native?.close(); } finally { await storage.close(); } }
  })();
  try {
    assert.equal(await storage.workspaceId(), descriptor.workspaceId);
    native = await createNativeRuntime({ storage, workspaceId: descriptor.workspaceId });
    const todoAuthority = descriptor.todoBoards?.length ? admitNativeTodoUserAuthority({ root, fixture, nonce,
      workspaceId: descriptor.workspaceId, boards: descriptor.todoBoards }) : undefined;
    ui = await startLegacyApiChatUiHost({ storage, actorId: descriptor.actorId, chats: descriptor.chats, todoBoards: descriptor.todoBoards,
      todoAuthority,
      authorizeTodoCreate: async binding => binding.root === root && binding.workspaceId === descriptor.workspaceId
        && binding.actorId === descriptor.actorId && !!todoAuthority
        && fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8") === nonce,
      authorizeTodoLifecycle: async binding => binding.root === root && binding.workspaceId === descriptor.workspaceId
        && binding.actorId === descriptor.actorId && !!todoAuthority
        && fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8") === nonce,
      authorizeTodo: async binding => binding.root === root && binding.workspaceId === descriptor.workspaceId
        && binding.actorId === descriptor.actorId && !!todoAuthority
        && storage.nativeTodoUserBoards(todoAuthority).includes(binding.boardSlug)
        && fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8") === nonce,
      provider: createLegacyApiChatLocalProvider({ endpoint: descriptor.providerEndpoint,
        apiKey: "synthetic-ui-provider-token", model: "synthetic-ui-provider" }),
      authorize: async binding => binding.root === root && binding.workspaceId === descriptor.workspaceId
        && binding.actorId === descriptor.actorId && binding.sourceFingerprint === descriptor.sourceFingerprint
        && descriptor.chats.some(chat => chat.namespace === binding.namespace && chat.chatId === binding.chatId)
        && ["history", "continue"].includes(binding.operation),
    });
    const continuing = ui.runtime.continue.bind(ui.runtime);
    const createBoard = storage.requestLegacyTodoBoardCreate.bind(storage);
    storage.requestLegacyTodoBoardCreate = async (input, ...rest) => {
      try { return await createBoard(input, ...rest); }
      catch (error) {
        if (process.env.PKM_NATIVE_UI_INTERRUPT_BOARD_CREATE === nonce && input.title === "NATIVE_BOARD_CRASH_CREATION") {
          const db = storage.connectNative();
          try {
            const pending = db.prepare("SELECT * FROM pending_todo").get();
            const row = db.prepare("SELECT plan_json FROM legacy_todo_board_create_intent WHERE operation_id=?").get(input.operationId);
            assert.equal(pending.operation_id, input.operationId); assert.equal(pending.actor_id, "user:local");
            assert.equal(pending.operation, "todo.board.create+original-note");
            assert.equal(JSON.parse(row.plan_json).actorId, "user:local");
            assert.match(String(error.message), /EROFS|read-only file system/i);
            assert(!db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(input.operationId));
            assert(!fs.existsSync(path.join(root, "notes", `${input.title}.md`)));
            assert(!fs.existsSync(path.join(root, "boards", input.title, "pkm-todo-board.json")));
            fs.writeFileSync(path.join(fixture, "board-create-crash-evidence.json"), JSON.stringify({
              input, actorId: pending.actor_id, code: error.code,
            }), { flag: "wx", mode: 0o600 });
            console.error("PRIVATE_NATIVE_BOARD_CREATE_ACTUAL_EXIT82_AFTER_DURABLE_INTENT_AND_FS_DENIAL");
            process.exit(82);
          } finally { db.close(); }
        }
        throw error;
      }
    };
    const todoUser = storage.requestNativeTodoUser.bind(storage);
    storage.requestNativeTodoUser = async (input, ...rest) => {
      try {
        const result = await todoUser(input, ...rest);
        if (process.env.PKM_NATIVE_UI_HOLD_WORKER_ACK === nonce && input.kind === "worker-grant"
          && input.actorId === "external:copilot:fixture-worker") {
          const db = storage.connectNative();
          try {
            assert.equal(db.prepare("SELECT actor_id FROM receipts WHERE operation_id=?").get(input.operationId)?.actor_id, "user:local");
            assert(!db.prepare("SELECT 1 FROM pending_todo WHERE operation_id=?").get(input.operationId));
          } finally { db.close(); }
          const raw = fs.readFileSync(path.join(root, "boards", input.boardSlug, "pkm-todo-board.json"), "utf8");
          const { todoBoardWorkers } = await load("domain/todo-board");
          assert.equal(todoBoardWorkers(raw)[input.actorId], input.tokenHash);
          process.send({ type: "worker-ack-held", operationId: input.operationId, boardSlug: input.boardSlug,
            actorId: input.actorId, tokenHash: input.tokenHash, nativeBoardSha256: createHash("sha256").update(raw).digest("hex") });
          await new Promise(() => {});
        }
        return result;
      }
      catch (error) {
        if (process.env.PKM_NATIVE_UI_INTERRUPT_TODO_INTENT === nonce
          && input.kind === "command" && input.command?.text === "NATIVE_TODO_CRASH_INTENT") {
          const db = storage.connectNative();
          try {
            const row = db.prepare("SELECT operation_id,actor_id,after_json FROM pending_todo").get();
            assert.equal(row.operation_id, input.operationId); assert.equal(row.actor_id, "user:local");
            assert(db.prepare("SELECT 1 FROM native_todo_user_intent WHERE operation_id=?").get(input.operationId));
            assert(!db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(input.operationId));
            const bytes = fs.readFileSync(path.join(root, "boards", input.boardSlug, "pkm-todo-board.json"), "utf8");
            assert.notEqual(bytes, row.after_json);
            console.error("PRIVATE_NATIVE_TODO_ACTUAL_EXIT79_AFTER_DURABLE_USER_INTENT_AND_REAL_FS_DENIAL");
            process.exit(79);
          } finally { db.close(); }
        }
        throw error;
      }
    };
    ui.runtime.continue = input => {
      console.log("PRIVATE_NATIVE_UI_ACTUAL_ADMISSION", Date.now(), input.text, input.expectedRevision);
      return continuing(input);
    };
    const publish = ui.runtime.publish.bind(ui.runtime);
    ui.runtime.publish = (input, ...rest) => {
      if (process.env.PKM_NATIVE_UI_INTERRUPT_AFTER_RESULT === nonce && input.text === "NATIVE_UI_CRASH_RESULT") {
        const db = storage.connectNative();
        try {
          const row = db.prepare("SELECT status FROM legacy_api_chat_operations WHERE actor_id=? AND operation_id=?")
            .get(descriptor.actorId, input.operationId);
          assert.equal(row.status, "result");
        } finally { db.close(); }
        console.error("PRIVATE_NATIVE_UI_ACTUAL_EXIT78_AFTER_DURABLE_PROVIDER_RESULT");
        process.exit(78);
      }
      return publish(input, ...rest);
    };
    process.send({ type: "ready", endpoint: ui.endpoint, bearer: ui.bearer });
    const stop = () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    process.once("SIGTERM", stop); process.once("SIGINT", stop); process.once("disconnect", stop);
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error("PRIVATE_NATIVE_UI_HOST_REFUSED", error); process.exitCode = 1; process.disconnect?.(); });
