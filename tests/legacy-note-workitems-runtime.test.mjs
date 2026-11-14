import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { CoreError } from "../dist/contracts.js";
import { serializeTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import { createLegacyNoteWorkItemsJournal } from "../dist/legacy-note-workitems-journal.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { restoreWorkspaceBackup } from "../dist/workspace-backup.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true, collaborationKind: "agent" };
const slug = "Board";
const note = "---\r\ntitle: Board\r\ndocumentKind: todo-board\r\nunknown:\r\n  keep: exact\r\n---\r\n# Original Note\r\n";
const item = {
  id: "first", title: "Verify bridge", goal: "Use native authority", scope: "Batch 13",
  acceptance: ["Canonical receipt exists"], state: "Planning", evidence: [],
};
const extraItem = {
  id: "second", title: "Continue bridge", goal: "Keep exact history", scope: "Batch 13",
  acceptance: ["Public protocol parity"], kind: "Task", state: "Planning", evidence: [],
};
const board = serializeTodoBoard([item], { "external:copilot:fixture": "a".repeat(64) });
const command = {
  slug, expected_digest: readTodoBoard(board).digest,
  command: { action: "claim", id: item.id }, operationId: randomUUID(),
};

async function fixture(t) {
  const parent = join(testsRoot, `.legacy-note-runtime-${randomUUID()}`);
  const root = join(parent, "workspace");
  await mkdir(parent);
  await initialize(root);
  await mkdir(join(root, "notes", `${slug}.assets`), { recursive: true });
  await mkdir(join(root, "boards", slug), { recursive: true });
  await writeFile(join(root, "notes", `${slug}.md`), note);
  await writeFile(join(root, "notes", `${slug}.assets`, "pkm-todo-board.json"), board);
  await writeFile(join(root, "boards", slug, "pkm-todo-board.json"), board);
  const policy = {
    admissions: [{
      slug, sourceMarkdownDigest: hash(note), sourceBoardDigest: hash(board), nativeBoardDigest: hash(board),
    }],
    authorize: (who, operation) => who.id === actor.id
      && (who.canWrite || operation === "legacy.note.workitems.read" || operation === "legacy.note.workitems.notes"),
    recoveryActor: request => request.actorId === actor.id ? actor : undefined,
  };
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { root, parent, policy };
}

function call(core, method, operation, args, who = actor) {
  return core.dispatch(method, { operation, version: 1, arguments: args }, who);
}

test("native Core routes admitted Note reads and writes through canonical Todo receipts", async t => {
  const { root, policy } = await fixture(t);
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({
    storage, legacyNoteWorkItems: policy, hostServices: { authorizeBackup: () => true },
  });
  const token = "legacy-note-runtime-integration-token-000000000000";
  const http = await startHttp(runtime.core, token, actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(runtime.core, actor, serverTransport);
  const client = new Client({ name: "legacy-note-runtime-test", version: "1" });
  await client.connect(clientTransport);
  try {
    const response = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "legacy.note.workitems.command", version: 1, arguments: command }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.error, undefined);
    assert.equal(result.result.items[0].ownerId, actor.id);
    assert.equal(result.result.items[0].history.at(-1).action, "claim");
    const claimedSnapshot = result.result;
    const upsert = await client.callTool({
      name: "capability_call",
      arguments: { operation: "legacy.note.workitems.upsert", version: 1, arguments: {
        slug, expected_digest: claimedSnapshot.digest, item: extraItem, operationId: randomUUID(),
      } },
    });
    assert.equal(upsert.structuredContent.error, undefined);
    assert.equal(upsert.structuredContent.result.items.length, 2);

    const edit = {
      slug, expected_digest: upsert.structuredContent.result.digest, operationId: randomUUID(),
      command: { action: "edit", item: { ...upsert.structuredContent.result.items[0], links: ["test://public-core"] },
        reason: "Exercise public Core edit" },
    };
    const editResponse = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "legacy.note.workitems.command", version: 1, arguments: edit }),
    });
    assert.equal(editResponse.status, 200);
    const edited = await editResponse.json();
    assert.equal(edited.error, undefined);
    assert.equal(edited.result.items[0].links[0], "test://public-core");

    const release = {
      slug, expected_digest: edited.result.digest, operationId: randomUUID(),
      command: { action: "release", id: item.id, reason: "Exercise public MCP release" },
    };
    const released = await client.callTool({
      name: "capability_call",
      arguments: { operation: "legacy.note.workitems.command", version: 1, arguments: release },
    });
    assert.equal(released.structuredContent.error, undefined);
    assert.equal(released.structuredContent.result.items[0].ownerId, undefined);

    const historicalReplay = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "legacy.note.workitems.command", version: 1, arguments: command }),
    });
    assert.equal(historicalReplay.status, 200);
    assert.deepEqual((await historicalReplay.json()).result, claimedSnapshot);
    const snapshot = (await client.callTool({
      name: "capability_read",
      arguments: { operation: "legacy.note.workitems.read", version: 1, arguments: { slug } },
    })).structuredContent;
    assert.equal(snapshot.error, undefined);
    assert.deepEqual(snapshot.result, released.structuredContent.result);
    const database = storage.connectNative();
    try {
      const binding = database.prepare(`SELECT b.bridge_actor_id,b.bridge_operation,b.native_actor_id,b.native_operation,
        r.actor_id,r.operation FROM legacy_note_workitems_native_binding b
        JOIN receipts r ON r.operation_id=b.operation_id WHERE b.operation_id=?`).get(command.operationId);
      assert.equal(binding.bridge_actor_id, actor.id);
      assert.equal(binding.bridge_operation, "legacy.note.workitems.command");
      assert.equal(binding.native_actor_id, actor.id);
      assert.equal(binding.native_operation, "todo.workitem.claim");
      assert.equal(binding.actor_id, actor.id);
      assert.equal(binding.operation, "todo.workitem.claim");
      assert.equal(database.prepare("SELECT count(*) AS n FROM legacy_note_workitems_intent").get().n, 0);
      assert.equal(database.prepare("SELECT count(*) AS n FROM legacy_note_workitems_receipt").get().n, 4);
    } finally { database.close(); }
    assert.equal(await readFile(join(root, "notes", `${slug}.md`), "utf8"), note);
    assert.equal(await readFile(join(root, "notes", `${slug}.assets`, "pkm-todo-board.json"), "utf8"), board);
    const backupPath = join(dirname(root), "backup");
    await runtime.services.hostServices.backup(backupPath);
    const restoredRoot = join(dirname(root), "restored");
    await restoreWorkspaceBackup(backupPath, restoredRoot, { nativeRestoreAuthority });
    const restoredStorage = await Storage.open(restoredRoot);
    const restoredRuntime = await createNativeRuntime({
      storage: restoredStorage, legacyNoteWorkItems: policy,
    });
    try {
      const historicalReplay = await call(
        restoredRuntime.core, "capability_call", "legacy.note.workitems.command", command,
      );
      assert.deepEqual(historicalReplay.result, claimedSnapshot);
      assert.equal(historicalReplay.error, undefined);
    } finally {
      await restoredRuntime.close();
      await restoredStorage.close();
    }
  } finally {
    await client.close();
    await mcp.close();
    await new Promise(resolve => http.server.close(resolve));
    await runtime.close();
    await storage.close();
  }
});

test("startup exact replay clears a committed Note intent before Core admission", async t => {
  const { root, policy } = await fixture(t);
  const storage = await Storage.open(root);
  const firstRuntime = await createNativeRuntime({ storage, legacyNoteWorkItems: policy });
  await firstRuntime.close();
  await storage.close();

  const interruptedStorage = await Storage.open(root);
  const database = interruptedStorage.connectNative();
  let fault = true;
  const journal = createLegacyNoteWorkItemsJournal(database, {
    async withDurableFence(_operationId, work) {
      return interruptedStorage.withWorkspaceExclusive(work);
    },
    authorize: (who, _operation, boardSlug) => who.id === actor.id && boardSlug === slug,
    async readAdmittedBoard(boardSlug) {
      assert.equal(boardSlug, slug);
      return readFile(join(root, "boards", slug, "pkm-todo-board.json"), "utf8");
    },
    async invokeNative(operation, args, who) {
      const result = await interruptedStorage.requestLegacyNoteWorkItems({
        operation, args, actorId: who.id,
      }, String(args.operationId));
      if (fault) {
        fault = false;
        throw new CoreError("SIMULATED_CRASH", "Interrupt after canonical commit.", "unknown");
      }
      return result;
    },
  });
  await assert.rejects(journal.dispatch("legacy.note.workitems.command", command, actor), { effect: "unknown" });
  assert.equal(database.prepare("SELECT count(*) AS n FROM legacy_note_workitems_intent").get().n, 1);
  database.close();
  await interruptedStorage.close();

  const restartedStorage = await Storage.open(root);
  const restarted = await createNativeRuntime({ storage: restartedStorage, legacyNoteWorkItems: policy });
  try {
    const replay = await call(restarted.core, "capability_call", "legacy.note.workitems.command", command);
    assert.equal(replay.error, undefined);
    assert.equal(replay.result.items[0].ownerId, actor.id);
    const after = restartedStorage.connectNative();
    try {
      assert.equal(after.prepare("SELECT count(*) AS n FROM legacy_note_workitems_intent").get().n, 0);
      assert.equal(after.prepare("SELECT count(*) AS n FROM legacy_note_workitems_receipt WHERE operation_id=?")
        .get(command.operationId).n, 1);
      assert.equal(after.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?")
        .get(command.operationId).n, 1);
    } finally { after.close(); }
  } finally { await restarted.close(); await restartedStorage.close(); }
});

test("public Core knowledge reads return explicit conflicts when source bytes change mid-dispatch", async t => {
  const { root, policy } = await fixture(t);
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: policy });
  const token = "legacy-read-race-http-runtime-token-000000000000";
  const http = await startHttp(runtime.core, token, actor, 0);
  try {
    const request = {
      area: "notes", offset: 0, limit: 10, includeDeleted: false,
    };
    const baseline = await call(runtime.core, "capability_read", "knowledge.document.list", request);
    assert.equal(baseline.error, undefined);
    assert.equal(typeof baseline.result.workspaceRevision, "string");
    const originalRequest = storage.request.bind(storage);
    let reached;
    const atDispatch = new Promise(resolve => { reached = resolve; });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    storage.request = async value => {
      if (value.operation === "knowledge.document.list") {
        reached();
        await hold;
      }
      return originalRequest(value);
    };
    const raced = fetch(`${http.url}/v1/capability_read`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "knowledge.document.list", version: 1, arguments: request }),
    });
    await atDispatch;
    const child = spawnSync(process.execPath, ["-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
      join(root, "notes", `${slug}.md`), `${note}Changed by an external child writer.\r\n`,
    ], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    release();
    const response = await raced;
    const conflict = await response.json();
    assert.equal(response.status, 409);
    assert.equal(conflict.error.code, "CONFLICT");
    assert.equal(conflict.result, undefined);
  } finally {
    await new Promise(resolve => http.server.close(resolve));
    await runtime.close();
    await storage.close();
  }
});

test("production Core fences all selected HTTP/MCP reads against external child writes", async t => {
  const scenarios = [
    { protocol: "http", operation: "knowledge.document.list", args: () => ({ area: "notes", offset: 0, limit: 10 }), mutate: "markdown" },
    { protocol: "mcp", operation: "knowledge.document.get", args: id => ({ id }), mutate: "markdown" },
    { protocol: "http", operation: "knowledge.note.search", args: () => ({ query: "Board", limit: 10 }), mutate: "markdown" },
    { protocol: "mcp", operation: "knowledge.note.list", args: () => ({ offset: 0, limit: 10 }), mutate: "markdown" },
    { protocol: "http", operation: "knowledge.asset.list", args: id => ({ id, offset: 0, limit: 10 }), mutate: "asset" },
    { protocol: "mcp", operation: "knowledge.asset.get", args: (id, asset, documentSha256) => ({
      id, path: asset.path, expectedDocumentSha256: documentSha256, expectedDigest: asset.digest,
      offset: 0, length: asset.size,
    }), mutate: "asset" },
  ];

  for (const scenario of scenarios) {
    await t.test(`${scenario.protocol} ${scenario.operation}`, async subtest => {
      const { root, policy } = await fixture(subtest);
      const proofPath = join(root, "notes", `${slug}.assets`, "proof.bin");
      await writeFile(proofPath, "asset-v1");
      const storage = await Storage.open(root);
      const runtime = await createNativeRuntime({ storage, legacyNoteWorkItems: policy });
      const token = "legacy-read-race-http-runtime-token-000000000000";
      const http = scenario.protocol === "http" ? await startHttp(runtime.core, token, actor, 0) : undefined;
      let client;
      let clientTransport;
      let mcpServer;
      if (scenario.protocol === "mcp") {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        clientTransport = clientSide;
        mcpServer = await startMcp(runtime.core, actor, serverSide);
        client = new Client({ name: "legacy-read-race-production-test", version: "1" });
        await client.connect(clientTransport);
      }

      async function call(operation, args) {
        if (scenario.protocol === "http") {
          const response = await fetch(`${http.url}/v1/capability_read`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ operation, version: 1, arguments: args }),
          });
          return { status: response.status, envelope: await response.json() };
        }
        const result = await client.callTool({
          name: "capability_read", arguments: { operation, version: 1, arguments: args },
        });
        return { status: 200, envelope: result.structuredContent };
      }

      try {
        const docs = (await call("knowledge.document.list", { area: "notes", offset: 0, limit: 10 })).envelope.result;
        const document = docs.items[0];
        assert.ok(document?.id);
        assert.match(docs.workspaceRevision, /^[a-f0-9]{64}$/);

        let args = scenario.operation === "knowledge.asset.get" ? undefined : scenario.args(document.id);
        if (scenario.operation === "knowledge.asset.get") {
          const listing = (await call("knowledge.asset.list", { id: document.id, offset: 0, limit: 10 })).envelope.result;
          const asset = listing.items.find(item => item.path.endsWith("proof.bin"));
          assert.ok(asset);
          args = scenario.args(document.id, asset, listing.documentSha256);
        }
        const baseline = (await call(scenario.operation, args)).envelope;
        assert.equal(baseline.error, undefined);
        assert.ok(baseline.result);
        if (scenario.operation === "knowledge.document.get") assert.equal(baseline.result.id, document.id);
        if (scenario.operation === "knowledge.note.list" || scenario.operation === "knowledge.note.search") {
          assert.match(baseline.result.snapshotRevision, /^[a-f0-9]{64}$/);
        }
        if (scenario.operation === "knowledge.asset.list") {
          assert.match(baseline.result.revision, /^[a-f0-9]{64}$/);
          assert.ok(baseline.result.items.some(item => item.path.endsWith("proof.bin")));
        }
        if (scenario.operation === "knowledge.asset.get") {
          assert.equal(baseline.result.path, "Board.assets/proof.bin");
          assert.equal(Buffer.from(baseline.result.data, "base64").toString("utf8"), "asset-v1");
        }

        const originalRequest = storage.request.bind(storage);
        let reached;
        const atDispatch = new Promise(resolve => { reached = resolve; });
        let release;
        const hold = new Promise(resolve => { release = resolve; });
        storage.request = async value => {
          if (value.operation === scenario.operation && value.actorId !== "native-read-fence") {
            reached();
            await hold;
          }
          return originalRequest(value);
        };
        const raced = call(scenario.operation, args);
        await atDispatch;
        const target = scenario.mutate === "markdown" ? join(root, "notes", `${slug}.md`) : proofPath;
        const contents = scenario.mutate === "markdown"
          ? `${note}Changed by an external child writer.\r\n`
          : "asset-v2";
        const child = spawnSync(process.execPath, ["-e",
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
          target, contents,
        ], { encoding: "utf8", timeout: 10_000 });
        release();
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        const result = await raced;
        assert.equal(scenario.protocol === "http" ? result.status : 200,
          scenario.protocol === "http" ? 409 : 200);
        assert.equal(result.envelope.error?.code, "CONFLICT");
        assert.equal(result.envelope.error?.effect, "not-committed");
        assert.equal(result.envelope.result, undefined);
      } finally {
        if (client) await client.close();
        if (mcpServer) await mcpServer.close();
        if (http) await new Promise(resolve => http.server.close(resolve));
        await runtime.close();
        await storage.close();
      }
    });
  }
});
