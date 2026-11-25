import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createOriginalMcpColdComponentFixture, bootstrapOriginalMcpColdComponent,
  preserveOriginalMcpColdComponentB1, retireOriginalMcpColdComponent, restoreOriginalMcpColdComponentB0,
} from "../dist/original-mcp-cold-component.js";
import {
  captureOriginalMcpComponentB0, preserveOriginalMcpComponentB1,
} from "../dist/original-mcp-component-recovery.js";
import { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot, rollbackOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { bootstrapOriginalMcpNativeRuntime, assertOriginalMcpNativeRuntimeBootstrap } from "../dist/original-mcp-native-bootstrap.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { startOriginalMcpNativeBroker } from "../dist/original-mcp-broker.js";
import { pinOriginalMcpBrokerFile } from "../dist/original-mcp-relay.js";
import { writeOriginalMcpHotSwitchTarget } from "../dist/original-mcp-hot-switch-target.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import {
  originalMcpNativeRequestProtocol, parseOriginalMcpNativeRequest, originalMcpNativeResult,
} from "../dist/original-mcp-native-request.js";
import { verifyOriginalMcpImplementationReadiness } from "../dist/original-mcp-public.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { hydrateOriginalMcpTodo, hydrateOriginalMcpMemory } from "../dist/original-mcp-domains.js";
import { admitLegacyRetrievalModel } from "../dist/legacy-retrieval-model.js";
import { originalMcpTodoGenesisMethod, parseOriginalMcpTodoGenesisPayload } from "../dist/original-mcp-todo-genesis-contracts.js";
import { originalMcpNativeRequestMethods } from "../dist/original-mcp-native-request.js";
import { readOriginalMcpDomain } from "../dist/original-mcp-domain-state.js";
import { readOriginalMcpTodoGenesisSources, prepareOriginalMcpTodoGenesis, prepareOriginalMcpTodoGenesisIntent } from "../dist/original-mcp-todo-genesis.js";
import { withOriginalMcpPublicRequest, originalMcpRequestDigest } from "../dist/original-mcp-native-host.js";
import { getOriginalMcpTodoGenesisPort, withOriginalMcpTodoGenesisContext, withApprovedOriginalMcpTodoGenesis,
  originalMcpTodoGenesisStorageAdmission } from "../dist/original-mcp-todo-genesis-native.js";

assert(process.env.PKM_TEST_WORKSPACE, "Run under the isolated Linux fixture framework.");
process.umask(0o077);
const hash = value => createHash("sha256").update(value).digest("hex");
const limits = { maxEntries: 30000, maxDepth: 32, maxBytes: 1073741824, maxFileBytes: 536870912 };
const base = join(homedir(), ".local/state/pkm-v5-recovery");
async function fixture(t) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = join(base, `c-${randomBytes(4).toString("hex")}`);
  const fixture = await createOriginalMcpColdComponentFixture(directory);
  const identity = await lstat(directory, { bigint: true });
  let component, runtimeFence;
  t.after(async () => {
    await component?.close();
    const now = await lstat(directory, { bigint: true });
    assert.equal(now.dev, identity.dev); assert.equal(now.ino, identity.ino); assert.equal(now.uid, identity.uid);
    await rm(directory, { recursive: true });
  });
  for (const name of ["notes", "skills", ".pkm/state/actions", "chatrooms", "mcp-server"])
    await mkdir(join(fixture.root, name), { recursive: true, mode: 0o700 });
  await writeFile(join(fixture.root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal fixture Note.\n", { mode: 0o600 });
  await writeFile(join(fixture.root, "skills/Base.md"), "---\ntitle: Base\n---\nOriginal fixture Skill.\n", { mode: 0o600 });
  await writeFile(join(fixture.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  await writeFile(join(fixture.root, ".pkm/state/actions/settings.json"), '{"fixture":"archive-only"}', { mode: 0o600 });
  const database = new DatabaseSync(join(fixture.root, "knowledge.db"));
  database.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('baseline');"); database.close();
  const keys = generateKeyPairSync("ed25519"), profileSha256 = hash("component-socket-fixture-profile");
  const publicIdentity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const endpoint = join(directory, "ipc"); await mkdir(endpoint, { mode: 0o700 });
  const options = { operatorId: "isolated-component-fixture", profileSha256, limits, attachment: {
    directory: endpoint, identity: publicIdentity, identitySha256: publicIdentity.sha256,
    payloadBuildId: hash("fixture-payload"), hostEntrySha256: hash("fixture-host"),
  } };
  return { fixture, options, keys, publicIdentity, directory,
    async bootstrap() { return component = await bootstrapOriginalMcpColdComponent(fixture, options); },
    runtimeFence: () => runtimeFence,
    async bootstrapRuntime() {
      const writerFence = runtimeFence = await acquireOriginalMcpRootFence(fixture.root);
      try {
        const plan = await captureOriginalMcpCustody({
          root: fixture.root, backup: join(directory, "runtime-custody"),
          operatorId: options.operatorId, profileSha256, limits,
        }, { writerFence });
        return component = await bootstrapOriginalMcpNativeRuntime({ plan, writerFence, attachment: options.attachment });
      } catch (error) { await writerFence.release(); throw error; }
    } };
}
async function socketProducer(t, f, component, { todoGenesis = false } = {}) {
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath, "utf8"));
  const socket = connect(descriptor.socketPath);
  const requests = [], pending = new Map(), cancels = [];
  let input = "", session, attachedResolve, allow = true, hold = false;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  socket.on("error", () => {});
  socket.on("data", chunk => {
    input += chunk.toString("utf8");
    for (let end; (end = input.indexOf("\n")) !== -1;) {
      const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, f.publicIdentity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, f.keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        session = { brokerId: frame.brokerId, activationId: frame.activationId, identitySha256: frame.identitySha256,
          epoch: frame.activationId, binding: descriptor.binding };
        send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session, maxPacketBytes: 65536,
          methods: ["admission.approve", "public.approve", "tool.approve", "tool.review", "credential.present",
            ...(todoGenesis ? [originalMcpTodoGenesisMethod] : [])] });
        attachedResolve();
      } else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, session); requests.push(request);
        if (request.method === originalMcpTodoGenesisMethod) {
          const payload = parseOriginalMcpTodoGenesisPayload(request.payload, session);
          send(originalMcpNativeResult(request, allow ? { decision: "approve", actorId: "mcp:external",
            decisionId: randomUUID(), operationId: payload.request.operationId, epoch: payload.request.nativeEpoch,
            requestSha256: payload.requestSha256, expiresAtMs: Date.now() + 60000 } : null));
        } else if (hold) pending.set(request.requestId, request);
        else send(originalMcpNativeResult(request, request.method === "credential.present"
          ? { present: false } : { decision: allow ? "approve" : "deny" }));
      } else if (frame.type === "native-cancel") cancels.push(frame);
    }
  });
  await attached;
  t.after(() => socket.destroy());
  return { requests, pending, cancels, socket,
    allow(value) { allow = value; }, hold(value) { hold = value; },
    reply(request) { send(originalMcpNativeResult(request, { decision: "approve" })); } };
}
async function until(check) {
  for (let n = 0; n < 1000; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Owned component fixture timeout.");
}

test("native runtime bootstrap composes signed consent and public writes on the original cold owner without publishing business transport", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), bootstrap = await f.bootstrapRuntime();
  const lease = { ...bootstrap.owner.workspaceLease() };
  assertOriginalMcpNativeRuntimeBootstrap(bootstrap);
  assert.throws(() => assertOriginalMcpNativeRuntimeBootstrap({ ...bootstrap }), { code: "NATIVE_BOOTSTRAP_REQUIRED" });
  assert.throws(() => assertOriginalMcpNativeRuntimeBootstrap(bootstrap, true), { code: "NATIVE_BOOTSTRAP_REQUIRED" });
  assert.equal(bootstrap.status().businessReady, false);
  const completing = bootstrap.complete(), producer = await socketProducer(t, f, bootstrap);
  const host = await completing;
  assertOriginalMcpNativeRuntimeBootstrap(bootstrap, true);
  assert.equal(bootstrap.status().admitted, true);
  assert.equal(bootstrap.status().modelChannel, false);
  assert.equal(bootstrap.status().businessReady, false);
  assert.equal((await bootstrap.owner.ensureFull()).storage, bootstrap.storage);
  assert.deepEqual(bootstrap.owner.workspaceLease(), lease);
  assert.throws(() => bootstrap.complete({ enableModels: true }), { code: "NATIVE_BOOTSTRAP_ADMISSION_CHANGED" });
  const backend = createNativePublicOwnerBackend(bootstrap.owner, {
    actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host,
  });
  t.after(() => backend.close());
  const request = { tool: "update_note", arguments: { slug: "Entry", content: "Admitted through the same runtime." } };
  producer.allow(false);
  await assert.rejects(backend.invoke("original_mcp_public", request), { code: "ACCESS_DENIED" });
  assert.match(await readFile(join(f.fixture.root, "notes/Entry.md"), "utf8"), /Original fixture Note/);
  producer.allow(true);
  await backend.invoke("original_mcp_public", request);
  assert.match(await readFile(join(f.fixture.root, "notes/Entry.md"), "utf8"), /same runtime/);
  producer.socket.destroy();
  await until(() => bootstrap.status().failure !== null);
  assert.throws(() => assertOriginalMcpNativeRuntimeBootstrap(bootstrap), { code: "NATIVE_BOOTSTRAP_CLOSED" });
  await backend.close();
  await bootstrap.close();
  assert.throws(() => bootstrap.owner.workspaceLease());
});

test("native bootstrap close cancels unattached admission and releases its actual owner", { timeout: 60000 }, async t => {
  const f = await fixture(t), bootstrap = await f.bootstrapRuntime();
  const completion = bootstrap.complete();
  const cancelled = assert.rejects(completion);
  await bootstrap.close();
  await cancelled;
  assert.equal(bootstrap.status().admitted, false);
  assert.throws(() => bootstrap.owner.workspaceLease());
});

test("source-only cold factory composes the same-Core Todo Note journal without model execution and preserves settled genesis reads and planning edits", { timeout: 120000 }, async t => {
  assert(originalMcpNativeRequestMethods.includes(originalMcpTodoGenesisMethod), "Use Parent's actual normal method26 emission.");
  const f = await fixture(t);
  await mkdir(join(f.fixture.root, "notes/Private"), { mode: 0o700 });
  await writeFile(join(f.fixture.root, "notes/Private/Control.md"), "GENESIS_PRIVATE_CONTROL_UNCHANGED", { mode: 0o600 });
  await writeFile(join(f.fixture.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Private"]}}', { mode: 0o600 });
  const controls = ["notes/Entry.md", "skills/Base.md", "notes/Private/Control.md", ".pkm/content-privacy.json", ".pkm/state/actions/settings.json"];
  const beforeControls = await Promise.all(controls.map(path => readFile(join(f.fixture.root, path))));
  const component = await f.bootstrap(), completing = component.complete();
  const producer = await socketProducer(t, f, component, { todoGenesis: true }), host = await completing;
  const full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, component.storage);
  assert.equal(full.runtime.services.modelProvider, undefined);
  assert.equal(full.runtime.services.chatTurns, undefined);
  assert.equal(full.runtime.services.agentRuntime, undefined);
  await assert.rejects(full.runtime.enrollOriginalMcpTodoNoteGenesis(host, "Unadmitted"), { code: "NATIVE_AUTHORITY_REQUIRED" },
    "The genuine cold factory must contain its data journal; an unadmitted target is not an unavailable composer.");
  const call = async (tool, args) => {
    const response = await component.invoke(tool, args);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  const created = await call("todo_board_create", { title: "ColdGenesis" });
  assert.equal(created.slug, "ColdGenesis"); assert.equal(created.ok, true);
  const board = { board_slug: created.slug }, task = { ...board, id: "cold-task" };
  const pair = await Promise.all(["notes/ColdGenesis.md", "notes/ColdGenesis.assets/pkm-todo-board.json"]
    .map(path => readFile(join(component.root, path))));
  const empty = await call("get_board", board); assert.equal(empty.digest, created.digest);
  const added = await call("add_workitem", { ...board, expected_digest: empty.digest, item: {
    id: task.id, title: "Cold factory task", goal: "Use actual installed composition", scope: "Disposable signed Source only",
    acceptance: ["Same journal, actor and durable read"], plannedStart: "2026-11-22", plannedEnd: "2026-11-23",
  } });
  const edited = await call("update_workitem", { ...task, expected_digest: added.digest,
    patch: { title: "Cold factory task edited" }, reason: "Verify bounded planning metadata" });
  assert.deepEqual(await call("get_workitem", task), edited);
  const snapshot = await call("note_work_items", { slug: created.slug });
  assert.equal(snapshot.digest, edited.digest);
  assert.deepEqual(snapshot.items[0].history.map(event => event.action), ["create", "edit"]);
  assert(snapshot.items[0].history.every(event => event.actorId === "mcp:external"));
  assert.deepEqual(await Promise.all(["notes/ColdGenesis.md", "notes/ColdGenesis.assets/pkm-todo-board.json"]
    .map(path => readFile(join(component.root, path)))), pair);
  assert.deepEqual(component.owner.workspaceLease(), lease);
  assert(!producer.requests.some(request => request.method.startsWith("model.") || request.method.startsWith("chat.")));
  const canonical = await readFile(join(component.root, ".pkm-next-todo/ColdGenesis/pkm-todo-board.json"));
  const db = component.storage.connectNative();
  let sourceRows, receipts;
  try {
    assert.equal(readOriginalMcpDomain(component.root, "todo", db), undefined);
    sourceRows = readOriginalMcpTodoGenesisSources(component.root, db);
    assert.equal(sourceRows.length, 1); assert.equal(sourceRows[0].key, created.slug);
    receipts = db.prepare("SELECT operation_id,operation,actor_id,result FROM receipts WHERE json_extract(result,'$.board_slug')=? ORDER BY rowid").all(created.slug);
    assert.deepEqual(receipts.map(row => row.operation), ["todo.board.create", "todo.workitem.create", "todo.workitem.update"]);
    assert(receipts.every(row => row.actor_id === "mcp:external"));
    assert.equal(JSON.parse(String(receipts.at(-1).result)).digest, hash(canonical));
  } finally { db.close(); }
  assert.deepEqual(await Promise.all(controls.map(path => readFile(join(component.root, path)))), beforeControls);
  await component.close();
  assert.throws(() => component.owner.workspaceLease());
  const stoppedCoreSha256 = hash(await readFile(join(component.root, "core.sqlite")));
  const ticket = await preserveOriginalMcpColdComponentB1(component); t.after(() => ticket.close());
  assert.equal(ticket.kind, "pkm.original-mcp-component-b1/v1");
  assert.deepEqual(ticket.optionalDirectories, [".pkm-next-todo"]);
  const b1ManifestBytes = await readFile(join(ticket.b1Path, "manifest.json")), b1 = JSON.parse(b1ManifestBytes);
  assert.equal(hash(b1ManifestBytes), ticket.b1Sha256);
  assert.equal(b1.rows.find(row => row.path === "core.sqlite").sha256, stoppedCoreSha256);
  assert.equal(hash(await readFile(join(ticket.b1Path, "payload/core.sqlite"))), stoppedCoreSha256);
  const retirement = await retireOriginalMcpColdComponent(ticket);
  assert.equal(hash(await readFile(join(retirement.archive, "core.sqlite"))), stoppedCoreSha256,
    "Exact stopped Core image binds the already observed live source/receipt rows without reopening archived SQLite.");
  for (const [path, bytes] of [["notes/ColdGenesis.md", pair[0]],
    ["notes/ColdGenesis.assets/pkm-todo-board.json", pair[1]],
    [".pkm-next-todo/ColdGenesis/pkm-todo-board.json", canonical]])
    assert.deepEqual(await readFile(join(retirement.archive, path)), bytes);
  assert.deepEqual(await Promise.all(controls.map(path => readFile(join(retirement.archive, path)))), beforeControls);
  const restored = await restoreOriginalMcpColdComponentB0(retirement);
  assert.equal(restored.originalRootOverwritten, false); assert.equal(restored.fullCutoverQualified, false);
  assert.deepEqual(await Promise.all(controls.map(path => readFile(join(restored.root, path)))), beforeControls);
  for (const path of ["notes/ColdGenesis.md", "notes/ColdGenesis.assets", ".pkm-next-todo", "core.sqlite",
    ".pkm-next-workspace", ".pkm-next-original-mcp.json", ".pkm-native"])
    await assert.rejects(lstat(join(restored.root, path)), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ scope: "genuine cold Source factory, not installed qualification",
    genesisOnly: true, sourceOperationId: sourceRows[0].operationId, receipts: receipts.map(row => row.operation),
    stoppedCoreSha256, b1Sha256: ticket.b1Sha256, privateControlsPreserved: true, freshB0NoBoardOrSourceGrants: true }));
});

test("genuine pending genesis blocks cold B1 closure even when its approved files are fully published without a commit receipt", { timeout: 120000 }, async t => {
  for (const fullyPublished of [false, true]) await t.test(fullyPublished ? "fully-published-pending" : "unpublished-pending", async t => {
    const f = await fixture(t), component = await f.bootstrap(), completing = component.complete();
    await socketProducer(t, f, component, { todoGenesis: true }); const host = await completing;
    const args = { title: "PendingClosure" }, plan = await prepareOriginalMcpTodoGenesis(component.storage, host, args, randomUUID());
    const request = { operation: "todo.board.create", actorId: "mcp:external",
      args: { board_slug: plan.request.selection.boardSlug, operationId: plan.request.operationId } };
    const port = getOriginalMcpTodoGenesisPort(component.storage, host);
    await withOriginalMcpPublicRequest(component.storage, host, { operation: "mcp.tool.todo_board_create",
      tool: "todo_board_create", version: 1, readOnly: false, arguments: args, argumentsDigest: originalMcpRequestDigest(args) },
    () => withOriginalMcpTodoGenesisContext(port, args, () => withApprovedOriginalMcpTodoGenesis(component.storage, plan, async () => {
      const admission = originalMcpTodoGenesisStorageAdmission(component.storage, request);
      assert(admission, "Use the actual signed one-use review, never fabricated pending SQL authority.");
      await component.storage.withWorkspaceExclusive(async () => {
        const db = component.storage.connectNative();
        try {
          db.exec("BEGIN IMMEDIATE"); prepareOriginalMcpTodoGenesisIntent(component.root, db, request, admission); db.exec("COMMIT");
          assert.equal(Number(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='todo.board.create'").get().n), 0);
        } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; } finally { db.close(); }
        if (fullyPublished) {
          for (const path of [".pkm-next-todo", ".pkm-next-todo/PendingClosure", "notes/PendingClosure.assets"])
            await mkdir(join(component.root, path), { mode: 0o700 });
          await writeFile(join(component.root, plan.request.selection.notePath), plan.descriptor, { mode: 0o600 });
          for (const path of [plan.request.selection.backingPath, plan.request.selection.canonicalBoardPath])
            await writeFile(join(component.root, path), plan.backing, { mode: 0o600 });
        }
      });
    })));
    await component.close();
    await assert.rejects(preserveOriginalMcpColdComponentB1(component), { code: "COMPONENT_PENDING_DOMAIN_CLOSURE_UNQUALIFIED" });
    await assert.rejects(readFile(join(f.directory, "retirement-complete.json")), { code: "ENOENT" });
  });
});

test("native bootstrap never treats public consent as an implemented model lane", { timeout: 60000 }, async t => {
  const f = await fixture(t), bootstrap = await f.bootstrapRuntime();
  const completion = bootstrap.complete({ enableModels: true }), refused = assert.rejects(completion, { code: "MISSING_NATIVE_METHOD" });
  const producer = await socketProducer(t, f, bootstrap);
  await refused;
  assert.equal(bootstrap.status().admitted, false);
  assert.equal(producer.requests.length, 0);
  await bootstrap.close();
});

test("signed native startup publishes a live hot-switch target for the same owner and hybrid MCP writes", { timeout: 120000 }, async t => {
  const f = await fixture(t), bootstrap = await f.bootstrapRuntime();
  const completing = bootstrap.complete(), producer = await socketProducer(t, f, bootstrap), nativeHost = await completing;
  const directory = join(f.directory, "business");
  await mkdir(directory, { mode: 0o700 });
  const node = pinOriginalMcpBrokerFile(process.execPath), relay = pinOriginalMcpBrokerFile(resolve("dist/original-mcp-relay-cli.js"));
  const runtime = { node, relay, buildSha256: hash("isolated native business build") };
  const manifest = { schema: "pkm.mcp.lifecycle/v1", managedRoot: f.directory, generation: randomUUID(),
    version: "0.1.0", runtimeBuild: runtime.buildSha256,
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    enabledFeatureDomains: [] };
  await writeFile(join(f.directory, "active-generation.json"),
    JSON.stringify({ schema: manifest.schema, generation: manifest.generation }), { mode: 0o600 });
  const broker = await startOriginalMcpNativeBroker({
    plan: bootstrap.custody, writerFence: f.runtimeFence(), directory, runtime, manifest,
    owner: bootstrap.owner, storage: bootstrap.storage, nativeHost,
    authorization: { schema: "pkm.original-mcp-broker-authorization/v1", operatorId: bootstrap.custody.operatorId,
      profileSha256: bootstrap.custody.profileSha256, planSha256: bootstrap.planSha256,
      acceptedScope: "native-dogfood/v1", writable: true },
  });
  const client = new Client({ name: "same-owner-hot-target-fixture", version: "1" });
  try {
    assert.equal(broker.owner, bootstrap.owner);
    assert.equal(broker.storage, bootstrap.storage);
    const targetInput = { descriptorPath: broker.descriptorPath, descriptorSha256: broker.descriptorSha256,
      profileSha256: bootstrap.custody.profileSha256, knowledgeRoot: f.fixture.root, targetPath: join(f.directory, "target.json") };
    await assert.rejects(writeOriginalMcpHotSwitchTarget({ ...targetInput, profileSha256: hash("different native profile") }));
    await assert.rejects(writeOriginalMcpHotSwitchTarget({ ...targetInput, knowledgeRoot: f.directory }), /UNQUALIFIED/);
    await assert.rejects(writeOriginalMcpHotSwitchTarget({ ...targetInput,
      targetPath: join(f.fixture.root, "target.json") }), /OUTSIDE_ROOT_REQUIRED/);
    await assert.rejects(readFile(targetInput.targetPath), { code: "ENOENT" });
    const written = await writeOriginalMcpHotSwitchTarget(targetInput);
    const bytes = await readFile(written.path), target = JSON.parse(bytes);
    assert.equal(hash(bytes), written.sha256);
    assert.equal((await lstat(written.path)).mode & 0o777, 0o600);
    assert(!Object.hasOwn(target, "token"));
    await assert.rejects(writeOriginalMcpHotSwitchTarget(targetInput), { code: "EEXIST" });
    await client.connect(new StdioClientTransport({ command: target.command.path, args: [target.entry.path, ...target.args], stderr: "pipe" }));
    const version = (await client.callTool({ name: "check_version", arguments: {} })).structuredContent;
    assert.equal(version.version, target.expectedVersion);
    assert.equal(version.runtime.runtimeBuild, target.runtimeBuild);
    const tools = (await client.listTools()).tools;
    assert(tools.some(tool => tool.name === "note_read"));
    assert(tools.some(tool => tool.name === "note_modify"));
    const request = { name: "note_modify", arguments: { slug: "Entry", content: "Written through the live native target." } };
    producer.allow(false);
    assert.equal((await client.callTool(request)).isError, true);
    producer.allow(true);
    assert.notEqual((await client.callTool(request)).isError, true);
    assert.match(await readFile(join(f.fixture.root, "notes/Entry.md"), "utf8"), /live native target/);
    await client.close();
    bootstrap.owner.assertWorkspaceLease();
    await broker.stop();
    bootstrap.owner.assertWorkspaceLease();
    await assert.rejects(writeOriginalMcpHotSwitchTarget({ ...targetInput, targetPath: join(f.directory, "dead-target.json") }));
  } finally { await client.close(); await broker.stop(); }
  await bootstrap.close();
});

test("socket producer fixture composes one cold owner/Core, exact Note/Skill writes, B1 retirement then fresh B0 restoration", { timeout: 120000 }, async t => {
  const f = await fixture(t), original = await readFile(join(f.fixture.root, "notes/Entry.md"));
  const component = await f.bootstrap(), lease = { ...component.owner.workspaceLease() };
  await assert.rejects(component.invoke("get_note", { slug: "Entry" }), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await assert.rejects(component.storage.request({ operation: "knowledge.document.list", actorId: "mcp:external", arguments: {} }),
    /recovery must complete/);
  await assert.rejects(preserveOriginalMcpColdComponentB1(component), { code: "COMPONENT_CONFIRMED_SHUTDOWN_REQUIRED" });
  const completion = component.complete(), producer = await socketProducer(t, f, component);
  await completion;
  const attachment = await component.owner.ensureFull();
  assert.equal(attachment.storage, component.storage); assert.deepEqual(component.owner.workspaceLease(), lease);
  producer.allow(false);
  await assert.rejects(component.invoke("update_note", { slug: "Entry", content: "Denied." }), { code: "ACCESS_DENIED" });
  assert.deepEqual(await readFile(join(f.fixture.root, "notes/Entry.md")), original);
  producer.allow(true);
  await component.invoke("update_note", { slug: "Entry", content: "Fresh Note mutation." });
  await component.invoke("add_skill", { name: "Created", content: "Fresh Skill mutation." });
  const createdSkill = await component.invoke("get_skill", { name: "Created" });
  assert.notEqual(createdSkill.isError, true);
  assert.equal((createdSkill.structuredContent ?? JSON.parse(createdSkill.content[0].text)).content, "Fresh Skill mutation.");
  await component.invoke("update_skill", { name: "Created", content: "Second Skill revision." });
  const updatedSkill = await component.invoke("get_skill", { name: "Created" });
  assert.notEqual(updatedSkill.isError, true);
  assert.equal((updatedSkill.structuredContent ?? JSON.parse(updatedSkill.content[0].text)).content, "Second Skill revision.");
  await component.invoke("add_skill", { name: "Created", content: "Third Skill replacement." });
  const overwrittenSkill = await component.invoke("get_skill", { name: "Created" });
  assert.notEqual(overwrittenSkill.isError, true);
  assert.equal((overwrittenSkill.structuredContent ?? JSON.parse(overwrittenSkill.content[0].text)).content, "Third Skill replacement.");
  const skills = await component.invoke("list_skills", {});
  assert.notEqual(skills.isError, true);
  assert(JSON.stringify(skills.structuredContent ?? JSON.parse(skills.content[0].text)).includes('"Created"'));
  const retrievedSkill = await component.invoke("search_skills", { query: "Third Skill replacement", route: "lexical", limit: 5 });
  assert.notEqual(retrievedSkill.isError, true);
  assert(JSON.stringify(retrievedSkill.structuredContent ?? JSON.parse(retrievedSkill.content[0].text)).includes('"Created"'));
  assert.match(await readFile(join(f.fixture.root, "notes/Entry.md"), "utf8"), /Fresh Note mutation/);
  assert.match(await readFile(join(f.fixture.root, "skills/Created.md"), "utf8"), /Third Skill replacement/);
  const read = await component.invoke("get_note", { slug: "Entry" });
  assert.notEqual(read.isError, true);
  assert.match(JSON.stringify(read), /Fresh Note mutation/);
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
  const readerPids = [];
  for (const pid of children) {
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (command.includes("legacy-knowledge-mcp.py") && command.includes("--persistent")) readerPids.push(pid);
  }
  assert.equal(readerPids.length, 1, "The actual public read must start its owned persistent original reader.");
  const source = originalPublicMcpContracts();
  assert.equal(verifyOriginalMcpImplementationReadiness({ acceptedScope: "preserve-existing-mcp/v1",
    catalogSha256: source.provenance.metadataSha256, catalogRevision: source.provenance.producer.revision }).ready, false);
  await assert.rejects(component.invoke("api_chat_send", {}), { code: "COMPONENT_TOOL_NOT_ADMITTED" });
  await component.close(); assert.throws(() => component.owner.workspaceLease());
  for (const pid of readerPids) await assert.rejects(lstat(`/proc/${pid}`), { code: "ENOENT" });
  await assert.rejects(rollbackOriginalMcpRoot(component.custody, { root: component.root, workspaceId: component.workspaceId,
    planSha256: component.planSha256, journalSha256: component.journalSha256 }), /source identity changed/);
  const ticket = await preserveOriginalMcpColdComponentB1(component); t.after(() => ticket.close());
  assert(ticket.sqliteChecks >= 2); assert.deepEqual(ticket.optionalDirectories, []);
  await assert.rejects(restoreOriginalMcpColdComponentB0({ ...ticket }), { code: "COMPONENT_TYPED_RETIREMENT_REQUIRED" });
  const retirement = await retireOriginalMcpColdComponent(ticket);
  assert.match(await readFile(join(retirement.archive, "notes/Entry.md"), "utf8"), /Fresh Note mutation/);
  const restored = await restoreOriginalMcpColdComponentB0(retirement);
  assert.notEqual(restored.root, component.root);
  assert.deepEqual(await readFile(join(restored.root, "notes/Entry.md")), original);
  await assert.rejects(readFile(join(restored.root, "skills/Created.md")), { code: "ENOENT" });
  assert.equal(restored.originalRootOverwritten, false);
  assert.equal(restored.fullCutoverQualified, false);
  assert.notEqual((await lstat(restored.root)).ino, (await lstat(component.root)).ino);
  const core = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try { assert(Number(core.prepare("SELECT count(*) AS n FROM receipts").get().n) >= 3); } finally { core.close(); }
  assert.equal(producer.requests.filter(frame => frame.method === "admission.approve").length, 1);
  assert.equal(producer.requests.filter(frame => frame.method === "public.approve").length, 11);
});

test("component cancellation traverses the actual dispatcher and a late socket approval cannot write Core", { timeout: 60000 }, async t => {
  const f = await fixture(t), component = await f.bootstrap();
  const completion = component.complete(), producer = await socketProducer(t, f, component); await completion;
  producer.hold(true);
  const abort = new AbortController();
  const cancelled = component.invoke("update_note", { slug: "Entry", content: "Must not commit." }, abort.signal);
  const refusal = assert.rejects(cancelled, { code: "NATIVE_REQUEST_CANCELLED" });
  await until(() => producer.pending.size === 1); abort.abort(); await refusal;
  await until(() => producer.cancels.length === 1);
  producer.reply([...producer.pending.values()][0]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.doesNotMatch(await readFile(join(f.fixture.root, "notes/Entry.md"), "utf8"), /Must not commit/);
  await component.close();
});

test("fixture and retirement brands reject clones; unknown optional bytes/links never become a complete B1", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(bootstrapOriginalMcpColdComponent({ ...f.fixture }, f.options), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  await assert.rejects(createOriginalMcpColdComponentFixture(f.directory));
  const component = await f.bootstrap(); await component.close();
  await mkdir(join(f.fixture.root, ".pkm-next-memory"), { mode: 0o700 });
  await writeFile(join(f.fixture.root, ".pkm-next-memory/unreceipted.md"), "Never omitted.", { mode: 0o600 });
  await assert.rejects(preserveOriginalMcpColdComponentB1(component));
  assert(!(await readdir(f.directory)).some(name => name.startsWith("b1-")));
  await rm(join(f.fixture.root, ".pkm-next-memory"), { recursive: true });
  await symlink("/never-follow-component-fixture-link", join(f.fixture.root, "notes/linked.md"));
  await assert.rejects(preserveOriginalMcpColdComponentB1(component), /linked|LINK|source identity|source entry/i);
});

test("B1 mutation refuses before retirement or B0 restoration", { timeout: 60000 }, async t => {
  const f = await fixture(t), component = await f.bootstrap(); await component.close();
  const ticket = await preserveOriginalMcpColdComponentB1(component); t.after(() => ticket.close());
  await writeFile(join(f.fixture.root, "notes/Entry.md"), "Changed after B1.", { mode: 0o600 });
  await assert.rejects(retireOriginalMcpColdComponent(ticket), { code: "COMPONENT_B1_SOURCE_CHANGED" });
  assert((await readdir(f.fixture.root)).includes("core.sqlite"));
  assert(!(await readdir(f.directory)).includes("retirement-complete.json"));
  await assert.rejects(retireOriginalMcpColdComponent({ ...ticket }), { code: "COMPONENT_B1_RETIREMENT_TICKET_REQUIRED" });
  await assert.rejects(restoreOriginalMcpColdComponentB0({}), { code: "COMPONENT_TYPED_RETIREMENT_REQUIRED" });
});

test("sealed B0 corruption and changed retired B1 refuse without overwriting original or restoring an image", { timeout: 60000 }, async t => {
  const f = await fixture(t), component = await f.bootstrap(); await component.close();
  const ticket = await preserveOriginalMcpColdComponentB1(component); t.after(() => ticket.close());
  await writeFile(join(component.b0.path, "payload/notes/Entry.md"), "Corrupted sealed B0.", { mode: 0o600 });
  await assert.rejects(retireOriginalMcpColdComponent(ticket), { code: "COMPONENT_IMAGE_CHANGED" });
  assert((await readdir(component.root)).includes("core.sqlite"));
  const g = await fixture(t), other = await g.bootstrap(); await other.close();
  const otherTicket = await preserveOriginalMcpColdComponentB1(other); t.after(() => otherTicket.close());
  const retirement = await retireOriginalMcpColdComponent(otherTicket);
  await writeFile(join(retirement.archive, "notes/Entry.md"), "Changed after retirement.", { mode: 0o600 });
  await assert.rejects(restoreOriginalMcpColdComponentB0(retirement), { code: "COMPONENT_RETIRED_B1_CHANGED" });
  assert(!(await readdir(g.directory)).includes("restored-b0"));
});

test("baseline capture accepts only its real fence; source links refuse without following targets", async t => {
  const f = await fixture(t);
  await assert.rejects(captureOriginalMcpComponentB0(f.fixture, limits,
    { root: f.fixture.root, assertHeld() {} }), { code: "COMPONENT_BASELINE_ALREADY_BOUND" });
  const fence = await acquireOriginalMcpRootFence(f.fixture.root); t.after(() => fence.release());
  await symlink("/not-authorized-component-target", join(f.fixture.root, "notes/link.md"));
  await assert.rejects(captureOriginalMcpComponentB0(f.fixture, limits, fence), { code: "COMPONENT_LINK_OR_SPECIAL_FILE" });
});

async function seedDomains(f) {
  const store = createRequire(import.meta.url)("../legacy/dist/knowledge/filestore.js");
  store.setStorePath(f.fixture.root); store.todoBoardCreate("Team/Board", "Board", "Team");
  const scope = JSON.stringify({ account: "fixture", project: hash(f.fixture.root), repository: hash(f.fixture.root) });
  const preservedSource = join(f.fixture.root, ".pkm/state/actions/original-memory.sqlite3");
  const sourceSnapshot = join(f.directory, "separate-closed-memory-snapshot.sqlite3");
  const script = [
    "import hashlib,sys", "from pkm_memory_engine import Engine",
    "db,scope=sys.argv[1:3]", "e=Engine(db,'closure-fixture-not-native-authority')",
    "id='explicit-'+hashlib.sha256((scope+'\\0proposal').encode()).hexdigest()",
    "e.mutate('proposal','explicit_propose',{'id':id,'scope':scope,'content':'Original fixture memory.','sources':[{'id':'source','chat':'fixture','revision':'one','locator':'message/1'}]})",
    "e.mutate('confirm','explicit_confirm',{'id':id,'scope':scope,'expected_revision':1,'host_authorization':{'decision_id':'historical-fixture','actor_id':'human:old-fixture'}})",
    "e.close()", "print(id)",
  ].join("\n");
  const environment = { ...process.env, TMPDIR: f.directory, PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: resolve("compute"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", OMP_NUM_THREADS: "1" };
  const id = execFileSync("python3", ["-c", script, preservedSource, scope], { env: environment, encoding: "utf8" }).trim();
  await writeFile(sourceSnapshot, await readFile(preservedSource), { mode: 0o600, flag: "wx" });
  return { sourceSnapshot, sourceScopeSha256: hash(scope), id, environment };
}
const domainFixturePolicy = {
  async authorize() {
    return { actorId: "mcp:external", decisionId: `source-closure-fixture-${randomUUID()}`, expiresAtMs: Date.now() + 60000 };
  },
};

test("committed Todo, Memory and retrieval inventories survive complete B1/SQL validation and typed retirement (source closure only)", { timeout: 180000 }, async t => {
  const f = await fixture(t), memory = await seedDomains(f);
  const model = JSON.parse(execFileSync("python3", [resolve("tests/legacy-retrieval-tiny-model.py"),
    join(f.fixture.root, "packages/retrieval-source")], { env: memory.environment, encoding: "utf8" }));
  const component = await f.bootstrap(), completion = component.complete();
  await socketProducer(t, f, component); const host = await completion;
  await hydrateOriginalMcpTodo(component.storage, host, ["Team/Board"], domainFixturePolicy);
  const stagingDirectory = join(f.directory, "memory-stage"); await mkdir(stagingDirectory, { mode: 0o700 });
  await hydrateOriginalMcpMemory(component.storage, host, { sourceSnapshot: memory.sourceSnapshot,
    sourceScopeSha256: memory.sourceScopeSha256, stagingDirectory }, domainFixturePolicy);
  await admitLegacyRetrievalModel(component.storage, { id: "mcp:external", canWrite: true }, {
    sourceRoot: model.root, packageId: model.packageId,
    authorityId: "source-closure-fixture-not-native-grant", authorize: () => true,
  });
  await component.close();
  await assert.rejects(rollbackOriginalMcpRoot(component.custody, { root: component.root, workspaceId: component.workspaceId,
    planSha256: component.planSha256, journalSha256: component.journalSha256 }), /independent B1 preservation/);
  const ticket = await preserveOriginalMcpColdComponentB1(component); t.after(() => ticket.close());
  assert.deepEqual(ticket.optionalDirectories, [".pkm-next-todo", ".pkm-next-memory", ".pkm-next-retrieval-models"]);
  assert(ticket.sqliteChecks >= 3, "Extensionless/SQLite3 sources are checked by header, not omitted.");
  const retirement = await retireOriginalMcpColdComponent(ticket);
  for (const [name, path] of [
    [".pkm-next-todo", "Team/Board/pkm-todo-board.json"],
    [".pkm-next-memory", `${memory.id}.md`],
    [".pkm-next-retrieval-models", `${model.packageId}/manifest.json`],
  ]) {
    const retained = await readFile(join(retirement.archive, name, path));
    assert.deepEqual(retained, await readFile(join(ticket.b1Path, "payload", name, path)));
  }
  const restored = await restoreOriginalMcpColdComponentB0(retirement);
  for (const name of ticket.optionalDirectories) await assert.rejects(lstat(join(restored.root, name)), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(restored.root, ".pkm/state/actions/original-memory.sqlite3")),
    await readFile(join(f.directory, "b0/payload/.pkm/state/actions/original-memory.sqlite3")));
});

test("pending Memory external staging references refuse B1 even before the optional root directory exists", { timeout: 60000 }, async t => {
  const f = await fixture(t), memory = await seedDomains(f), component = await f.bootstrap();
  const completion = component.complete(); await socketProducer(t, f, component); const host = await completion;
  const stagingDirectory = join(f.directory, "pending-memory-stage"); await mkdir(stagingDirectory, { mode: 0o700 });
  await assert.rejects(hydrateOriginalMcpMemory(component.storage, host, { sourceSnapshot: memory.sourceSnapshot,
    sourceScopeSha256: memory.sourceScopeSha256, stagingDirectory }, {
    ...domainFixturePolicy, checkpoint(point) { if (point === "intent-durable") throw new Error("owned-memory-interruption"); },
  }), /owned-memory-interruption/);
  await component.close();
  await assert.rejects(preserveOriginalMcpColdComponentB1(component), { code: "COMPONENT_PENDING_DOMAIN_CLOSURE_UNQUALIFIED" });
  assert(!(await readdir(f.directory)).some(name => name.startsWith("b1-")));
});

test("exact admitted optional DDL rejects extra objects and orphan commitments without leaving SQLite sidecars", { timeout: 180000 }, async t => {
  for (const tamper of ["extra-index", "weaken-trigger", "orphan-commit", "invalid-worker"]) await t.test(tamper, async t => {
    const f = await fixture(t);
    await seedDomains(f);
    const component = await f.bootstrap(), completion = component.complete();
    await socketProducer(t, f, component); const host = await completion;
    await hydrateOriginalMcpTodo(component.storage, host, ["Team/Board"], domainFixturePolicy);
    await component.close();
    const fence = await acquireOriginalMcpRootFence(f.fixture.root); t.after(() => fence.release());
    const database = new DatabaseSync(join(f.fixture.root, "core.sqlite"));
    try {
      if (tamper === "extra-index") database.exec("CREATE INDEX unrecognized_domain_index ON original_mcp_domain_intents(domain)");
      if (tamper === "weaken-trigger") database.exec(`DROP TRIGGER original_mcp_domain_intents_no_delete;
        CREATE TRIGGER original_mcp_domain_intents_no_delete BEFORE DELETE ON original_mcp_domain_intents
        BEGIN SELECT 1; END;`);
      if (tamper === "orphan-commit") database.prepare("INSERT INTO original_mcp_domain_commits VALUES(?,?)")
        .run("unadmitted-domain", hash("unadmitted"));
      if (tamper === "invalid-worker") database.prepare("INSERT INTO original_mcp_domain_workers VALUES(?,?)")
        .run(hash("invalid-worker"), "{}");
    } finally { database.close(); }
    const before = await readFile(join(f.fixture.root, "core.sqlite")), names = (await readdir(f.fixture.root)).sort();
    await assert.rejects((await import("../dist/original-mcp-root.js")).validateOriginalMcpWorkspace(f.fixture.root, undefined, fence),
      { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(await readFile(join(f.fixture.root, "core.sqlite")), before);
    assert.deepEqual((await readdir(f.fixture.root)).sort(), names);
    assert(!names.some(name => /core\.sqlite-(wal|shm|journal)/.test(name)));
  });
});
