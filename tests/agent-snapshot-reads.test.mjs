import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readAgentSnapshots, agentSnapshotReadLimits } from "../dist/agent-snapshot-reads.js";
import { agentSnapshotReadDefinitions } from "../dist/agent-snapshot-reads-contracts.js";
import { snapshotReadProjection } from "../dist/domain/agent-snapshot-reads-projection.js";
import { originalProjection, originalRegressionSource } from "./agent-snapshot-reads-original.mjs";
import { snapshotFixture, workspaceMarker, snapshotId, magicCode, fixtureRequests, fixtureResults,
  installAgentSnapshotReadTransportFixtures } from "./agent-snapshot-reads-fixtures.mjs";

async function fixture(run) {
  const root = resolve(`.agent-snapshot-reads-test-${randomUUID()}`);
  const directory = join(root, "agent-snapshot-reads/.pkm/state/agent-snapshots");
  await mkdir(root);
  await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify(workspaceMarker));
  await installAgentSnapshotReadTransportFixtures(root);
  const file = join(directory, `${snapshotId}.json`);
  const put = async value => writeFile(file, JSON.stringify(value));
  try { await run({ root, directory, file, put }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const call = (root, kind, args) => readAgentSnapshots(root, {
  ...fixtureRequests[kind], args: args ?? fixtureRequests[kind].args,
});
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test("captured source regression and pure original projection remain executable", () => {
  assert.match(originalRegressionSource, /recent_messages.*0/);
  assert.match(originalRegressionSource, /Reading a Snapshot must never create an Agent Session/);
  const snapshot = snapshotFixture();
  snapshot.payload.session.todos[0].details = "😀".repeat(2200);
  snapshot.payload.session.summary = "😀".repeat(1200);
  snapshot.payload.session.nativeChat.messages[0].content = "😀".repeat(4200);
  const oracle = spawnSync("python3", ["-c", `${originalProjection}
import json, sys
snapshot = json.load(sys.stdin)
print(json.dumps(_snapshot_read_projection(snapshot, snapshot["payload"], 12)))
`], { input: JSON.stringify(snapshot), encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(oracle.status, 0, oracle.stderr);
  const migrated = snapshotReadProjection(snapshot, snapshot.payload, 12);
  // The TS summary additionally preserves the original UI's optional display name.
  delete migrated.snapshot.name;
  assert.deepEqual(migrated, JSON.parse(oracle.stdout));
});

test("list/get/read original records are immutable, paginated and snapshot-pinned", async () => {
  await fixture(async ({ root, file, directory, put }) => {
    const before = await readFile(file);
    const listed = await call(root, "list");
    assert.deepEqual(listed, fixtureResults.list);
    assert.deepEqual(await call(root, "get"), fixtureResults.get);
    assert.deepEqual(await call(root, "read"), fixtureResults.read);
    assert.equal(listed.total, 1);
    assert.equal(listed.snapshots[0].todoCount, 1);
    assert.equal(listed.snapshots[0].recipeRunCount, 1);
    assert.equal(listed.snapshots[0].recoveryCount, 0);
    assert.equal(listed.nextOffset, null);
    assert.equal(listed.adapters.encryptedPayload, "unavailable");
    assert.equal("payload" in listed.snapshots[0], false);
    assert.deepEqual((await call(root, "get")).snapshot, listed.snapshots[0]);
    const result = await call(root, "read", {
      magic_code: ` ${magicCode.toLowerCase()} `, recent_messages: 1,
      snapshotRevision: listed.snapshotRevision,
    });
    assert.equal(result.task, "Validate a synthetic capture");
    assert.equal(result.source, "pkm-chat");
    assert.equal(result.read_only, true);
    assert.deepEqual(result.todos[0].recipeRunIds, ["recipe_run_fixture"]);
    assert.equal(result.recipe_runs[0].nodes.validate, "pending");
    assert.deepEqual(result.latest_checkpoint_state.next_actions, ["run tests"]);
    assert.deepEqual(result.conversation, {
      message_count: 2, recent_messages: [{ role: "assistant", status: "complete", content: "I will run synthetic tests." }],
    });
    assert.equal((await call(root, "read", { magic_code: magicCode, recent_messages: 0 })).conversation.recent_messages.length, 0);
    assert.deepEqual((await call(root, "list", { offset: 1, limit: 1 })).snapshots, []);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(directory), [`${snapshotId}.json`]);
    const snapshot = snapshotFixture();
    snapshot.payload.session.privateContext = "Raw bytes affecting inspection pin, not summary";
    await put(snapshot);
    await rejects(call(root, "get", { snapshotId, snapshotRevision: listed.snapshotRevision }), "CONFLICT");
    await rejects(call(root, "read", { magic_code: magicCode, snapshotRevision: listed.snapshotRevision }), "CONFLICT");
  });
});

test("absent staged directory is empty and causes no writes", async () => {
  await fixture(async ({ root }) => {
    await rm(join(root, "agent-snapshot-reads"), { recursive: true });
    assert.equal((await call(root, "list")).total, 0);
    await rejects(call(root, "get"), "NOT_FOUND");
    await rejects(call(root, "read"), "NOT_FOUND");
    assert.deepEqual(await readdir(root), [".pkm-next-workspace"]);
  });
});

test("external capture excludes conversation and live Session changes do not replace captured task", async () => {
  await fixture(async ({ root, put }) => {
    const snapshot = snapshotFixture();
    delete snapshot.payload.session.origin;
    snapshot.payload.session.hostKind = "copilot";
    snapshot.sourceHostKind = "copilot";
    snapshot.payload.recipeRuns = [];
    await put(snapshot);
    const sessions = join(root, "agent-snapshot-reads/.pkm/state/agent-sessions");
    await mkdir(sessions);
    const recovery = { schema: "pkm.agent.session/v1", sessionId: "agent_session_copy",
      task: "Never project live state", provenance: { snapshotId } };
    const recoveryFile = join(sessions, "agent_session_copy.json");
    await writeFile(recoveryFile, JSON.stringify(recovery));
    const result = await call(root, "read");
    assert.equal(result.source, "external-agent");
    assert.equal(result.task, snapshot.task);
    assert.equal("conversation" in result, false);
    assert.equal("recipe_runs" in result, false);
    assert.equal((await call(root, "get")).snapshot.recoveryCount, 1);
    const pin = (await call(root, "list")).snapshotRevision;
    recovery.task = "Changed recovery count input bytes";
    await writeFile(recoveryFile, JSON.stringify(recovery));
    await rejects(call(root, "get", { snapshotId, snapshotRevision: pin }), "CONFLICT");
  });
});

test("only trusted request actor, strict public arguments, no restoration operations", async () => {
  await fixture(async ({ root }) => {
    assert.deepEqual(agentSnapshotReadDefinitions.map(item => [item.id, item.readOnly]), [
      ["agent.snapshot.list", true], ["agent.snapshot.get", true], ["agent.snapshot.read", true],
    ]);
    await rejects(readAgentSnapshots(root, { ...fixtureRequests.read, actorId: "" }), "FORBIDDEN");
    await rejects(call(root, "read", { magic_code: magicCode, role: "owner" }), "INVALID_ARGUMENT");
    await rejects(call(root, "read", { magic_code: magicCode, actorId: "owner" }), "INVALID_ARGUMENT");
    await rejects(call(root, "read", { magic_code: magicCode, transcriptPath: "/private/transcript" }), "INVALID_ARGUMENT");
    await rejects(call(root, "read", { magic_code: magicCode, recent_messages: 51 }), "INVALID_ARGUMENT");
    await rejects(call(root, "read", { magic_code: magicCode, recent_messages: -1 }), "INVALID_ARGUMENT");
    await rejects(call(root, "get", { snapshotId: "../escape" }), "INVALID_ARGUMENT");
    await rejects(readAgentSnapshots(root, { ...fixtureRequests.get, operation: "agent.snapshot.restore" }), "UNKNOWN_OPERATION");
  });
});

test("checkpoint credentials are stripped, raw receipt/native/session secrets never projected", async () => {
  await fixture(async ({ root, put }) => {
    const snapshot = snapshotFixture();
    snapshot.payload.session.accessToken = "synthetic-secret";
    snapshot.payload.session.nativeChat.accessToken = "synthetic-secret";
    snapshot.payload.session.checkpoints[0].state.access_token = "synthetic-secret";
    snapshot.payload.session.checkpoints[0].state.nested = [{ refreshToken: "synthetic-secret", safe: true }];
    snapshot.payload.recipeRuns[0].receipts = { token: "synthetic-secret" };
    await put(snapshot);
    const result = await call(root, "read");
    assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
    assert.deepEqual(result.latest_checkpoint_state.nested, [{ safe: true }]);
  });
});

test("encrypted metadata is available but decrypt, packed history and network adapters are explicit", async () => {
  await fixture(async ({ root, put }) => {
    const snapshot = snapshotFixture();
    snapshot.capture = { recipeRunCount: 1, todoCount: 1 };
    snapshot.payload = { algorithm: "A256GCM-PKM-LOCAL-OBFUSCATION/v1", iv: "fixture", tag: "fixture", ciphertext: "fixture" };
    await put(snapshot);
    assert.equal((await call(root, "get")).snapshot.todoCount, 1);
    assert.equal((await call(root, "list")).total, 1);
    await rejects(call(root, "read"), "ADAPTER_UNAVAILABLE");
    snapshot.payload.algorithm = "A256GCM-PKM-INTERNAL/v1";
    await put(snapshot);
    await rejects(call(root, "read"), "ADAPTER_UNAVAILABLE");
    const packed = snapshotFixture();
    packed.payload.session.nativeChat.messageHistory = { path: "../../../private" };
    await put(packed);
    await rejects(call(root, "read"), "ADAPTER_UNAVAILABLE");
  });
});

test("invalid records never silently disappear or fall back", async () => {
  await fixture(async ({ root, file, directory, put }) => {
    await writeFile(join(directory, "agent_snapshot_broken.json"), "{");
    await rejects(call(root, "list"), "INVALID_SNAPSHOT");
    await rejects(call(root, "get"), "INVALID_SNAPSHOT");
    await rm(join(directory, "agent_snapshot_broken.json"));
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    await rejects(call(root, "read"), "INVALID_SNAPSHOT");
    await writeFile(file, `\uFEFF${JSON.stringify(snapshotFixture())}`);
    await rejects(call(root, "read"), "INVALID_SNAPSHOT");
    await put({ ...snapshotFixture(), snapshotId: "agent_snapshot_wrong" });
    await rejects(call(root, "get"), "INVALID_SNAPSHOT");
    const malformed = snapshotFixture();
    malformed.payload.session.todos = [null];
    await put(malformed);
    await rejects(call(root, "list"), "INVALID_SNAPSHOT");
    await put(snapshotFixture());
    await writeFile(join(directory, "agent_snapshot_duplicate.json"),
      JSON.stringify({ ...snapshotFixture(), snapshotId: "agent_snapshot_duplicate" }));
    await rejects(call(root, "read"), "INVALID_SNAPSHOT");
  });
});

test("original Python capture metadata permits an explicit null checkpoint", async () => {
  await fixture(async ({ root, put }) => {
    const snapshot = snapshotFixture();
    snapshot.payload.session.checkpoints = [];
    snapshot.capture = { recipeRunCount: 1, todoCount: 1, checkpoint: null };
    await put(snapshot);
    assert.equal((await call(root, "get")).snapshot.checkpoint, null);
    assert.equal((await call(root, "read")).latest_checkpoint_state, null);
  });
});

test("UTF-8 byte/depth/record/page bounds and symlink protection", async () => {
  await fixture(async ({ root, file, directory, put }) => {
    await writeFile(file, " ".repeat(agentSnapshotReadLimits.fileBytes + 1));
    await rejects(call(root, "list"), "RESOURCE_LIMIT");
    const snapshot = snapshotFixture();
    let deep = {};
    for (let index = 0; index < 35; index++) deep = { deep };
    snapshot.payload.session.privateContext = deep;
    await put(snapshot);
    await rejects(call(root, "read"), "RESOURCE_LIMIT");
    const tooMany = snapshotFixture();
    tooMany.payload.session.todos = Array.from({ length: 4097 }, () => ({}));
    await put(tooMany);
    await rejects(call(root, "get"), "RESOURCE_LIMIT");
    await rejects(call(root, "list", { limit: 101 }), "INVALID_ARGUMENT");
    await put(snapshotFixture());
    const outside = join(root, "synthetic-outside.json");
    await writeFile(outside, JSON.stringify(snapshotFixture()));
    await rm(file);
    await symlink(outside, file);
    await rejects(call(root, "list"), "UNSAFE_PATH");
    await rm(file);
    await rm(directory, { recursive: true });
    await symlink(root, directory);
    await rejects(call(root, "get"), "UNSAFE_PATH");
  });
});

test("aggregate byte, JSON node and file-count budgets reject complete scans", async () => {
  await fixture(async ({ root, directory, put }) => {
    const snapshot = snapshotFixture();
    snapshot.payload.session.privateContext = Array.from({ length: 10 }, () => Array(10_000).fill(null));
    await put(snapshot);
    await rejects(call(root, "list"), "RESOURCE_LIMIT");
    snapshot.payload.session.privateContext = "x".repeat(2_000_000);
    await put(snapshot);
    for (let index = 0; index < 17; index++) {
      await writeFile(join(directory, `agent_snapshot_bytes_${index}.json`), JSON.stringify({
        ...snapshot, snapshotId: `agent_snapshot_bytes_${index}`, magicCode: `PKM-SNAP-BYTES-${index}`,
      }));
    }
    await rejects(call(root, "list"), "RESOURCE_LIMIT");
    for (const name of await readdir(directory)) await rm(join(directory, name));
    const small = snapshotFixture();
    for (let index = 0; index < agentSnapshotReadLimits.files; index++) {
      await writeFile(join(directory, `agent_snapshot_count_${index}.json`), JSON.stringify({
        ...small, snapshotId: `agent_snapshot_count_${index}`, magicCode: `PKM-SNAP-COUNT-${index}`,
      }));
    }
    await rejects(call(root, "list"), "RESOURCE_LIMIT");
  });
});
