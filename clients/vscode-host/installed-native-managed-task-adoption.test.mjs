import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareInstalledNativeManagedTaskAdoptionFixture, installedNativeManagedTaskAdoptionProviderOptions,
  verifyInstalledNativeManagedTaskAdoption, verifyInstalledNativeManagedTaskAdoptionRestored } from "./installed-native-managed-task-adoption.mjs";
import { registerInstalledNativeManagedTaskAdoptionProvider, installedNativeManagedTaskAdoptionMarkers,
  installedNativeManagedTaskAdoptionProposals, installedNativeManagedTaskAdoptionReply } from "./installed-native-managed-task-adoption-provider.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private Linux framework.");
process.umask(0o077);
const require = createRequire(import.meta.url), installed = resolve("clients/vscode-host");
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")));
const hash = value => createHash("sha256").update(value).digest("hex");
const chatPath = resolve("legacy/dist/chat/api-chat-store.js"), goalPath = resolve("legacy/dist/chat/chat-work-goal.js");
const legacyChatStore = { path: chatPath, sha256: hash(await readFile(chatPath)) };
const legacyGoal = { path: goalPath, sha256: hash(await readFile(goalPath)) };
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery"); await mkdir(base, { recursive: true, mode: 0o700 });
  const value = await recovery.createOriginalMcpColdComponentFixture(join(base, `a-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(value.directory, { recursive: true, force: true })); return value;
}
test("installed adoption preparation requires separately pinned original ChatStore and Goal writers, real fixture and preseal ordering", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture }),
    { code: "INSTALLED_TASK_ADOPTION_PINNED_CHAT_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture, legacyChatStore }),
    { code: "INSTALLED_TASK_ADOPTION_PINNED_GOAL_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture,
    legacyChatStore, legacyGoal: { ...legacyGoal, sha256: "0".repeat(64) } }),
  { code: "INSTALLED_TASK_ADOPTION_PINNED_GOAL_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture: { ...componentFixture },
    legacyChatStore, legacyGoal }), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture, legacyChatStore, legacyGoal }),
    { code: "INSTALLED_TASK_ADOPTION_PRESEAL_REQUIRED" });
});
test("installed adoption seed uses real original Task/Group/Session/Goal IDs and preserves old claims only as source data", async t => {
  const componentFixture = await fixture(t);
  const value = await prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture, legacyChatStore, legacyGoal });
  const { ApiChatStore } = require(chatPath), store = new ApiChatStore(join(componentFixture.root, ".pkm/state"), value.namespace);
  for (const original of Object.values(value.cases)) {
    const chat = store.load(original.chatId, false), session = JSON.parse(await readFile(join(componentFixture.root, original.sessionPath)));
    assert.equal(chat.sessionId, original.taskId); assert.equal(session.sessionId, original.taskId);
    assert.equal(session.hostSessionId, original.chatId); assert.equal(session.status, "paused");
    assert.equal(session.nativeChat.workGoal.id, original.goalId); assert.equal(chat.workGoal.inputId, original.originalInputId);
    assert.equal(chat.workGoal.objective, original.objective); assert.equal(chat.workGoal.status, "resolved");
    assert.equal(chat.workGoal.acceptance[0].verified, true);
    assert.deepEqual(chat.messages.map(message => message.id), [original.originalInputId, original.historicalReplyId]);
    assert.equal(chat.modelProfileId, "historical-model-must-not-be-selected");
  }
  assert(value.sourceFiles.some(file => file.path.startsWith(".pkm/state/agent-sessions/")));
  assert(value.sourceFiles.some(file => file.path.startsWith(".pkm/state/agent-groups/")));
  const options = installedNativeManagedTaskAdoptionProviderOptions(value, componentFixture.directory);
  assert.equal(options.originalTaskId, value.cases.main.taskId);
  assert.throws(() => installedNativeManagedTaskAdoptionProviderOptions({ ...value }, componentFixture.directory),
    { code: "INSTALLED_TASK_ADOPTION_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeManagedTaskAdoption({ adoptionFixture: { ...value } }),
    { code: "INSTALLED_TASK_ADOPTION_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeManagedTaskAdoptionRestored(value, {}),
    { code: "INSTALLED_TASK_ADOPTION_VERIFIED_EFFECT_REQUIRED" });
});
async function provider(t) {
  const directory = resolve(".pkm-test-evidence", `installed-adoption-provider-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 }); t.after(() => rm(directory, { recursive: true }));
  let handler;
  const vscode = { lm: { registerLanguageModelChatProvider(_vendor, value) { handler = value; return { dispose() {} }; },
    async selectChatModels() { return []; } },
  LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  LanguageModelToolCallPart: class { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } },
  LanguageModelToolResultPart: class { constructor(callId, content) { Object.assign(this, { callId, content }); } } };
  const options = { evidencePath: join(directory, "provider.json"), expectedToolText: "Actual current Note text.",
    originalTaskId: `agent_session_${randomUUID().replaceAll("-", "")}`, originalGoalId: randomUUID(),
    originalInputId: randomUUID(), originalObjective: "Start a new task: preserve the entire original objective.", historicalEvidenceId: "old-read" };
  await registerInstalledNativeManagedTaskAdoptionProvider(vscode, options);
  const binding = { taskId: options.originalTaskId, attemptId: randomUUID(), inputId: randomUUID(), chatId: randomUUID() };
  const goal = { id: options.originalGoalId, inputId: options.originalInputId, attemptInputId: binding.inputId, objective: options.originalObjective,
    sourceInputIds: [options.originalInputId, binding.inputId],
    acceptance: [{ criterion: "The original user objective and all subsequent requirements are satisfied.", verified: false, evidenceCallIds: [] }] };
  const text = `${installedNativeManagedTaskAdoptionMarkers.positive}\nPreserved historical tool evidence\nCurrent native Task binding (not permissions or a Task completion certificate).\n${JSON.stringify(binding)}\nUser work objective (not a permission grant or a managed Task completion certificate):\n${JSON.stringify(goal)}`;
  const messages = [{ content: [new vscode.LanguageModelTextPart(text)] }], events = [], token = { isCancellationRequested: false };
  const proposals = installedNativeManagedTaskAdoptionProposals(binding, goal, options.historicalEvidenceId);
  const call = (tools = [...new Set(proposals.map(proposal => proposal.name))].map(name => ({ name }))) =>
    handler.provideLanguageModelChatResponse({ id: "fixture" }, messages, { tools }, { report: event => events.push(event) }, token);
  const result = (step, content) => messages.push({ content: [
    new vscode.LanguageModelToolResultPart(proposals[step].callId, [new vscode.LanguageModelTextPart(content)]),
  ] });
  const snapshot = status => JSON.stringify({ schema: "pkm.chat.managed-task/v1", taskId: options.originalTaskId,
    goal: { id: options.originalGoalId, status, acceptance: goal.acceptance }, attempt: { id: binding.attemptId }, taskCompletion: "not-claimed" });
  return { options, binding, goal, messages, events, proposals, call, result, snapshot,
    observed: async () => JSON.parse(await readFile(options.evidencePath)) };
}
test("adoption provider follows actual typed tool results, expects historical refusal, and only then emits the current-evidence summary", async t => {
  // API doubles check fixture rules only, never installed/native/Core authority.
  const f = await provider(t); assert.equal((await f.observed()).nativeCalls, 0);
  for (let step = 0; step < 8; step++) {
    await f.call(step === 7 ? [] : undefined);
    if (step < 7) {
      assert.equal(f.events.at(-1).callId, f.proposals[step].callId);
      assert.deepEqual(f.events.at(-1).input, f.proposals[step].arguments);
      f.result(step, step === 1 ? '{"error":{"code":"EXECUTION_FAILED"},"effect":"not-committed"}'
        : step === 2 ? "Actual current Note text." : f.snapshot(step === 6 ? "resolved" : "active"));
    }
  }
  assert.equal(f.events.at(-1).value, installedNativeManagedTaskAdoptionReply);
  const state = await f.observed(); assert.equal(state.nativeCalls, 8);
  assert(state.requests.at(-1).historicalEvidenceRefused);
});
test("adoption provider fails closed if a fabricated old-evidence success is presented instead of the required Core refusal", async t => {
  const f = await provider(t);
  await f.call(); f.result(0, f.snapshot("active"));
  await f.call(); f.result(1, f.snapshot("resolved"));
  await assert.rejects(f.call(), /Historical-only evidence was accepted/);
  assert.equal((await f.observed()).requests.at(-1).completed, false);
});
