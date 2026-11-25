import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareInstalledNativeTodoSourceFixture, verifyInstalledNativeTodoSource,
  verifyInstalledNativeTodoSourceRestored } from "./installed-native-source.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Run installed-source helper regressions in the existing private Linux framework.");
process.umask(0o077);
const installed = resolve("clients/vscode-host");
const recovery = await import(pathToFileURL(join(installed,
  "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const { readTodoBoard } = await import("../../dist/domain/todo-board.js");
const writerPath = resolve("legacy/dist/knowledge/filestore.js");
const pinnedWriter = { path: writerPath, sha256: createHash("sha256").update(await readFile(writerPath)).digest("hex") };
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const componentFixture = await recovery.createOriginalMcpColdComponentFixture(join(base, `s-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(componentFixture.directory, { recursive: true }));
  return componentFixture;
}

test("installed source helper requires a pinned real original writer and does not accept copied cold fixture identities", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(prepareInstalledNativeTodoSourceFixture({ installed, componentFixture }),
    { code: "INSTALLED_SOURCE_PINNED_ORIGINAL_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTodoSourceFixture({
    installed, componentFixture, legacyWriter: { ...pinnedWriter, sha256: "0".repeat(64) },
  }), { code: "INSTALLED_SOURCE_ORIGINAL_WRITER_CHANGED" });
  await assert.rejects(prepareInstalledNativeTodoSourceFixture({
    installed, componentFixture: { ...componentFixture }, legacyWriter: pinnedWriter,
  }), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
});

test("installed source helper creates genuine legacy Todo bytes before capture; missing actual session-policy accessor fails closed", async t => {
  const componentFixture = await fixture(t);
  const sourceFixture = await prepareInstalledNativeTodoSourceFixture({ installed, componentFixture, legacyWriter: pinnedWriter });
  const board = readTodoBoard((await readFile(join(componentFixture.root, sourceFixture.boardPath))).toString("utf8"));
  const task = board.items.find(item => item.id === sourceFixture.itemId);
  assert.equal(task.title, "Keep exact installed Todo task");
  assert.equal(task.ownerId, "external:copilot:historical-source-worker");
  assert.equal(task.state, "Planning");
  assert.equal(sourceFixture.legacyWriterSha256, pinnedWriter.sha256);
  assert.match(await readFile(join(componentFixture.root, sourceFixture.notePath), "utf8"), /Board/);
  await assert.rejects(verifyInstalledNativeTodoSource({
    installed, sourceFixture, component: { fixture: componentFixture, root: componentFixture.root },
  }), { code: "INSTALLED_SOURCE_COMPONENT_ADAPTER_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoSource({
    installed, sourceFixture: { ...sourceFixture }, component: { fixture: componentFixture, root: componentFixture.root },
  }), { code: "INSTALLED_SOURCE_ACTUAL_COLD_FIXTURE_REQUIRED" });
  assert.deepEqual(await verifyInstalledNativeTodoSourceRestored(sourceFixture, componentFixture.root),
    { originalTodoB0BytesRestored: true });
  await assert.rejects(prepareInstalledNativeTodoSourceFixture({ installed, componentFixture, legacyWriter: pinnedWriter }),
    { code: "INSTALLED_SOURCE_FIXTURE_ALREADY_PREPARED" });
});
