import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareInstalledNativeManagedTaskFixture, installedNativeManagedTaskProviderOptions,
  verifyInstalledNativeManagedTask, verifyInstalledNativeManagedTaskRestored } from "./installed-native-managed-task.mjs";
import { registerInstalledNativeManagedTaskProvider, installedNativeManagedTaskMarkers,
  installedNativeManagedTaskProposals, installedNativeManagedTaskReply } from "./installed-native-managed-task-provider.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private Linux framework.");
process.umask(0o077);
const require = createRequire(import.meta.url), installed = resolve("clients/vscode-host");
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")));
const hash = value => createHash("sha256").update(value).digest("hex");
const chatPath = resolve("legacy/dist/chat/api-chat-store.js"), legacyChatStore = { path: chatPath, sha256: hash(await readFile(chatPath)) };
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `g-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true, force: true })); return value;
}
test("installed managed Task preparation requires actual branded preseal fixture and independently pinned original writer", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(prepareInstalledNativeManagedTaskFixture({ installed, componentFixture }), { code: "INSTALLED_MANAGED_TASK_PINNED_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeManagedTaskFixture({ installed, componentFixture,
    legacyChatStore: { ...legacyChatStore, sha256: "0".repeat(64) } }), { code: "INSTALLED_MANAGED_TASK_PINNED_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeManagedTaskFixture({ installed, componentFixture: { ...componentFixture }, legacyChatStore }),
    { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeManagedTaskFixture({ installed, componentFixture, legacyChatStore }),
    { code: "INSTALLED_MANAGED_TASK_PRESEAL_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
});
test("installed managed Task source is genuinely ordinary original data; copied identities and unverified restore cannot gain authority", async t => {
  const componentFixture = await fixture(t);
  const source = await prepareInstalledNativeManagedTaskFixture({ installed, componentFixture, legacyChatStore });
  const { ApiChatStore } = require(chatPath), store = new ApiChatStore(join(componentFixture.root, ".pkm/state"), source.namespace);
  const original = store.load(source.originalChatId, false);
  assert.equal(original.sessionId, undefined); assert.equal(original.workerState, undefined);
  assert.equal(original.workGoal, undefined); assert.equal(original.messages.length, 1);
  assert.match(original.messages[0].content, /no native managed Session/);
  assert(source.sourceFiles.length >= 2);
  const options = installedNativeManagedTaskProviderOptions(source, componentFixture.directory);
  assert.equal(options.evidencePath, join(componentFixture.directory, "native-managed-task-provider.json"));
  assert.throws(() => installedNativeManagedTaskProviderOptions({ ...source }, componentFixture.directory),
    { code: "INSTALLED_MANAGED_TASK_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeManagedTask({ installed, taskFixture: { ...source } }),
    { code: "INSTALLED_MANAGED_TASK_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeManagedTaskRestored(source, {}), { code: "INSTALLED_MANAGED_TASK_VERIFIED_EFFECT_REQUIRED" });
  await assert.rejects(prepareInstalledNativeManagedTaskFixture({ installed, componentFixture, legacyChatStore }),
    { code: "INSTALLED_MANAGED_TASK_ALREADY_PREPARED" });
});
async function provider(t) {
  const directory = resolve(".pkm-test-evidence", `managed-task-provider-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 }); t.after(() => rm(directory, { recursive: true }));
  let handler;
  const vscode = {
    lm: { registerLanguageModelChatProvider(_vendor, value) { handler = value; return { dispose() {} }; }, async selectChatModels() { return []; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    LanguageModelToolCallPart: class { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } },
    LanguageModelToolResultPart: class { constructor(callId, content) { Object.assign(this, { callId, content }); } },
  };
  const path = join(directory, "provider.json");
  await registerInstalledNativeManagedTaskProvider(vscode, { evidencePath: path, expectedToolText: "Actual bounded canonical Note." });
  return { vscode, handler, observed: async () => JSON.parse(await readFile(path, "utf8")) };
}
function context(phase) {
  const binding = { schema: "pkm.original-native-task-execution/v1", taskId: `agent_session_${randomUUID().replaceAll("-", "")}`,
    attemptId: randomUUID(), inputId: randomUUID(), requestId: "a".repeat(64) };
  const goal = { id: randomUUID(), attemptInputId: binding.inputId, sourceInputIds: [randomUUID(), binding.inputId],
    objective: `Start a new task: ${installedNativeManagedTaskMarkers.plain}: original objective.`,
    acceptance: [{ criterion: "The original user objective and all subsequent requirements are satisfied.", verified: false, evidenceCallIds: [] }] };
  const text = `${installedNativeManagedTaskMarkers[phase]}\nCurrent native Task binding (not permissions or a Task completion certificate).\n${JSON.stringify(binding)}\nUser work objective (not a permission grant or a managed Task completion certificate):\n${JSON.stringify(goal)}`;
  return { binding, goal, text };
}
test("synthetic Task provider counts handler inputs only and follows actual typed result parts rather than inventing acceptance", async t => {
  // API doubles exercise fixture rules only, never installed/native/Core qualification.
  const f = await provider(t), token = { isCancellationRequested: false }, events = [];
  assert.equal((await f.observed()).nativeCalls, 0);
  const plain = context("plain");
  await f.handler.provideLanguageModelChatResponse({ id: "fixture" }, [{ content: [new f.vscode.LanguageModelTextPart(plain.text)] }],
    { tools: [] }, { report: event => events.push(event) }, token);
  const continued = `${plain.text}\nUser work objective (not a permission grant or a managed Task completion certificate):\n${JSON.stringify(plain.goal)}`;
  await f.handler.provideLanguageModelChatResponse({ id: "fixture" }, [{ content: [new f.vscode.LanguageModelTextPart(continued)] }],
    { tools: [] }, { report: event => events.push(event) }, token);
  assert.equal((await f.observed()).requests.filter(value => value.phase === "plain").length, 2);
  const followup = context("followup"), proposals = installedNativeManagedTaskProposals(followup.binding, followup.goal);
  const messages = [{ content: [new f.vscode.LanguageModelTextPart(followup.text)] }];
  for (let step = 0; step <= proposals.length; step++) {
    await f.handler.provideLanguageModelChatResponse({ id: "fixture" }, messages,
      { tools: step === proposals.length ? [] : [...new Set(proposals.map(value => value.name))].map(name => ({ name })) },
      { report: event => events.push(event) }, token);
    if (step < proposals.length) {
      assert.equal(events.at(-1).callId, proposals[step].callId);
      assert.deepEqual(events.at(-1).input, proposals[step].arguments);
      const actual = step === 0 ? "Actual bounded canonical Note." : JSON.stringify({
        schema: "pkm.chat.managed-task/v1", taskId: followup.binding.taskId, attempt: { id: followup.binding.attemptId },
        taskCompletion: "not-claimed", goal: { status: step === proposals.length - 1 ? "resolved" : "active" },
      });
      messages.push({ content: [new f.vscode.LanguageModelToolResultPart(proposals[step].callId, [new f.vscode.LanguageModelTextPart(actual)])] });
    }
  }
  assert.equal(events.at(-1).value, installedNativeManagedTaskReply);
  const stale = context("stale");
  await assert.rejects(f.handler.provideLanguageModelChatResponse({ id: "fixture" }, [{ content: [new f.vscode.LanguageModelTextPart(stale.text)] }],
    {}, { report() { assert.fail(); } }, token), /denied, stale, revoked or archived/);
  assert.equal((await f.observed()).requests.at(-1).completed, false);
});
test("synthetic Task cancellation waits for the real handler cancellation-token event and never reports a successful response", async t => {
  const f = await provider(t), value = context("cancel"), listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested(callback) {
    listeners.add(callback); return { dispose() { listeners.delete(callback); } };
  } };
  const run = f.handler.provideLanguageModelChatResponse({ id: "fixture" }, [{ content: [new f.vscode.LanguageModelTextPart(value.text)] }],
    {}, { report() { assert.fail("Cancelled fixture must not manufacture a response."); } }, token);
  void run.catch(() => {});
  assert.equal((await f.observed()).requests[0].pending, true);
  token.isCancellationRequested = true; for (const listener of listeners) listener();
  await assert.rejects(run, /actual VS Code LM cancellation token/);
  const observed = (await f.observed()).requests[0];
  assert.equal(observed.cancelled, true); assert.equal(observed.completed, false); assert.equal(observed.pending, false);
});
