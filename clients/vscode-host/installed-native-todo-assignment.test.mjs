import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  prepareInstalledNativeTodoAssignmentFixture, verifyInstalledNativeTodoAssignment, verifyInstalledNativeTodoAssignmentRestored,
} from "./installed-native-todo-assignment.mjs";
import { installedNativeTodoAssignmentUiProgram, startInstalledNativeTodoAssignmentUi } from "./installed-native-todo-assignment-ui.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Run assignment leaf regressions with the existing isolated Linux framework.");
process.umask(0o077);
const installed = resolve("clients/vscode-host"), hash = value => createHash("sha256").update(value).digest("hex");
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const boardWriter = resolve("legacy/dist/knowledge/filestore.js"), chatWriter = resolve("legacy/dist/chat/api-chat-store.js");
const pins = { legacyWriter: { path: boardWriter, sha256: hash(await readFile(boardWriter)) },
  legacyChatStore: { path: chatWriter, sha256: hash(await readFile(chatWriter)) } };
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `a-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true, force: true }));
  return value;
}

test("assignment preparation requires both exact original writers and an unsealed actual cold fixture before changing source", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, legacyWriter: pins.legacyWriter }),
    { code: "INSTALLED_TODO_ASSIGNMENT_PINNED_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, ...pins,
    legacyChatStore: { ...pins.legacyChatStore, sha256: "0".repeat(64) } }),
  { code: "INSTALLED_TODO_ASSIGNMENT_ORIGINAL_WRITER_CHANGED" });
  await assert.rejects(prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture: { ...componentFixture }, ...pins }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
  await mkdir(join(componentFixture.directory, "custody"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, ...pins }),
    { code: "INSTALLED_TODO_ASSIGNMENT_PRESEAL_PREPARATION_REQUIRED" });
});

test("original Board/ApiChatStore preparation preserves exact UUID/history without inventing a native binding, token or consent", async t => {
  const componentFixture = await fixture(t);
  const value = await prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, ...pins });
  const raw = await readFile(join(value.root, value.boardPath)), board = JSON.parse(raw.toString("utf8"));
  const task = board.items.find(item => item.id === value.itemId);
  assert.equal(task.ownerId, "external:copilot:historical-assignment-owner");
  assert.equal(task.state, "Planning"); assert(task.history.length >= 2);
  assert.equal(hash(raw), value.boardSha256);
  const metadata = JSON.parse(await readFile(join(value.root, ".pkm/state/api-chats", value.namespace, `${value.chatId}.json`), "utf8"));
  assert.equal(metadata.id, value.chatId);
  assert.equal(metadata.title, "Original installed Todo assignment Chat");
  assert.equal(value.ownerId, `chat:${metadata.id}`);
  assert.equal(value.chatUrl, `pkm://chats/${value.namespace}/${metadata.id}`);
  assert.equal(metadata.sessionId, undefined); assert.equal(metadata.workerState, undefined);
  await assert.rejects(readFile(join(value.root, "core.sqlite")), { code: "ENOENT" });
  assert.equal(Object.keys(value).some(key => /token|approval|receipt|nativeGrant/i.test(key)), false);
  await assert.rejects(verifyInstalledNativeTodoAssignment({ installed, assignmentFixture: value,
    component: { fixture: componentFixture, root: value.root } }), { code: "INSTALLED_TODO_ASSIGNMENT_COMPONENT_CANONICAL_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoAssignmentRestored(value, {
    restoredRoot: join(componentFixture.directory, "restored-b0"), archive: value.root,
  }), { code: "INSTALLED_TODO_ASSIGNMENT_VERIFIED_EFFECT_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, ...pins }),
    { code: "INSTALLED_TODO_ASSIGNMENT_ALREADY_PREPARED" });
});

test("actual cold component refuses missing retained canonical dispatch before any model/UI authority is synthesized", async t => {
  const componentFixture = await fixture(t), value = await prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture, ...pins });
  await writeFile(join(value.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const cold = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-cold-component.js")).href);
  const identityApi = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-native-identity.js")).href);
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const profileSha256 = hash("assignment-leaf-regression-profile"), identity = identityApi.originalMcpNativeIdentity(key, profileSha256);
  const directory = join(componentFixture.directory, "ipc"); await mkdir(directory, { mode: 0o700 });
  const component = await cold.bootstrapOriginalMcpColdComponent(componentFixture, {
    operatorId: "isolated-installed-assignment-leaf-regression", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 4_194_304, maxFileBytes: 2_097_152 },
    attachment: { directory, identity, identitySha256: identity.sha256,
      payloadBuildId: hash("assignment-leaf-test-only-payload"), hostEntrySha256: hash("assignment-leaf-test-only-host") },
  });
  try {
    await assert.rejects(verifyInstalledNativeTodoAssignment({
      installed, assignmentFixture: value, component, port: 0,
    }), error => ["INSTALLED_TODO_ASSIGNMENT_COMPONENT_CANONICAL_REQUIRED", "INSTALLED_TODO_ASSIGNMENT_DRIVER_LIMITS_REQUIRED"].includes(error.code));
    const db = component.storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='original_mcp_todo_assignments'").get().n, 0); }
    finally { db.close(); }
    assert.equal(hash(await readFile(join(value.root, value.boardPath))), value.boardSha256);
  } finally { await component.close(); }
});

test("assignment renderer driver is bounded/private and its real modal program parses without starting a browser", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(startInstalledNativeTodoAssignmentUi({
    root: componentFixture.root, python: process.execPath, env: process.env, port: 1, runId: randomUUID(), timeoutMs: 1000,
  }), { code: "INSTALLED_TODO_ASSIGNMENT_PRIVATE_UI_REQUIRED" });
  execFileSync("python3", ["-B", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: installedNativeTodoAssignmentUiProgram, stdio: ["pipe", "pipe", "pipe"] });
});
