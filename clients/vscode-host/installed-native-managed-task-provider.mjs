import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const installedNativeManagedTaskVendor = "pkm-native-managed-task-fixture";
export const installedNativeManagedTaskModelLabel = "Synthetic installed managed Task evidence model";
export const installedNativeManagedTaskMarkers = Object.freeze(Object.fromEntries(
  ["archive", "deny", "plain", "followup", "cancel", "stale", "revoked"]
    .map(name => [name, `INSTALLED_NATIVE_MANAGED_TASK_${name.toUpperCase()}`])));
export const installedNativeManagedTaskReply = "INSTALLED_NATIVE_MANAGED_TASK_RESOLVED_REPLY";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const child of value) strings(child, found);
  else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child, found);
  return found;
}
function lineJson(texts, prefix, repeated = false) {
  const found = texts.flatMap(text => {
    const index = text.indexOf(prefix);
    return index < 0 ? [] : [JSON.parse(text.slice(index + prefix.length).split("\n")[0])];
  });
  assert(found.length > 0 && (repeated || found.length === 1), `Expected one actual current native ${prefix.trim()} manifest.`);
  if (repeated) for (const value of found) {
    assert.equal(value.id, found[0].id); assert.equal(value.attemptInputId, found[0].attemptInputId);
    assert.equal(value.objective, found[0].objective);
  }
  return found.at(-1);
}
export function installedNativeManagedTaskProposals(binding, goal) {
  assert.equal(goal.attemptInputId, binding.inputId);
  assert(Array.isArray(goal.sourceInputIds) && goal.sourceInputIds.includes(binding.inputId));
  const id = name => `installed-managed-task-${binding.attemptId}-${name}`;
  return [
    { name: "get_document", operation: "knowledge.document.get", callId: id("read"), arguments: { id: "Entry" } },
    { name: "record_harness", operation: "chat.task.record_harness", callId: id("task"), arguments: {
      kind: "task", goal: goal.objective, sourceInputIds: goal.sourceInputIds,
    } },
    { name: "record_harness", operation: "chat.task.record_harness", callId: id("start"), arguments: {
      kind: "validation", stepId: "installed-note-check", status: "start",
      summary: "Check the actual canonical fixture Note.", sourceInputIds: goal.sourceInputIds,
    } },
    { name: "record_harness", operation: "chat.task.record_harness", callId: id("complete"), arguments: {
      kind: "validation", stepId: "installed-note-check", status: "complete",
      summary: "The actual canonical Note read is the check evidence.", evidenceCallIds: [id("read")],
    } },
    { name: "report_work", operation: "chat.task.report_work", callId: id("resolved"), arguments: {
      status: "resolved", reason: "The exact canonical fixture Note was read through the approved Core tool.",
      sourceInputIds: goal.sourceInputIds, acceptance: goal.acceptance.map(item => ({
        criterion: item.criterion, verified: true, evidenceCallIds: [id("read")],
      })), contract: { scope: ["Read the exact canonical fixture Note"], nonGoals: ["No additional side effects"],
        stopWhen: "The required Note is observed and the actual evidence is reported." }, phase: "verifying",
    } },
  ];
}

/** Explicit deterministic fixture registration through the real VS Code LM API, never an authority/consent producer. */
export async function registerInstalledNativeManagedTaskProvider(vscode, options) {
  assert.equal(typeof vscode.lm?.registerLanguageModelChatProvider, "function", "Actual vscode.lm registration is required.");
  assert(options && isAbsolute(options.evidencePath) && typeof options.expectedToolText === "string" && options.expectedToolText);
  const state = { schema: "pkm.installed-native-managed-task-provider/v1", deterministicProvider: true,
    commercialProviderQualified: false, actualProfileOrKeyringQualified: false,
    nativeCalls: 0, tokenCalls: 0, informationCalls: 0, requests: [] };
  const persist = () => writeFileSync(options.evidencePath, JSON.stringify(state), { mode: 0o600 });
  const registration = vscode.lm.registerLanguageModelChatProvider(installedNativeManagedTaskVendor, {
    async provideLanguageModelChatInformation() {
      state.informationCalls++; persist();
      return [{ id: "managed-task-fixture", name: installedNativeManagedTaskModelLabel, family: "fixture", version: "1",
        maxInputTokens: 200000, maxOutputTokens: 8192, capabilities: { toolCalling: true, imageInput: false } }];
    },
    async provideTokenCount(_model, value, token) {
      state.tokenCalls++; persist();
      assert(!token.isCancellationRequested, "Native Task token counting was cancelled.");
      return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4));
    },
    async provideLanguageModelChatResponse(model, messages, requestOptions, progress, token) {
      const texts = strings(messages), content = texts.join("\n");
      const phase = ["revoked", "stale", "cancel", "followup", "plain", "deny", "archive"]
        .find(name => content.includes(installedNativeManagedTaskMarkers[name]));
      state.nativeCalls++;
      const observed = { call: state.nativeCalls, modelId: model.id, phase: phase ?? null,
        messagesSha256: hash(messages), tools: (requestOptions.tools ?? []).map(tool => tool.name),
        pending: false, cancelled: false, completed: false };
      state.requests.push(observed); persist();
      assert(!token.isCancellationRequested, "Native Task inference was already cancelled.");
      assert(["plain", "followup", "cancel"].includes(phase), "A denied, stale, revoked or archived request reached the provider.");
      const binding = lineJson(texts, "Current native Task binding (not permissions or a Task completion certificate).\n");
      const goal = lineJson(texts, "User work objective (not a permission grant or a managed Task completion certificate):\n", true);
      assert.equal(binding.schema, "pkm.original-native-task-execution/v1");
      assert.equal(goal.attemptInputId, binding.inputId);
      Object.assign(observed, { binding, objective: goal.objective, sourceInputIds: goal.sourceInputIds });
      persist();
      if (phase === "plain") {
        assert(goal.objective.includes(installedNativeManagedTaskMarkers.plain));
        progress.report(new vscode.LanguageModelTextPart("INSTALLED_NATIVE_MANAGED_TASK_PLAIN_REPLY"));
      } else if (phase === "cancel") {
        observed.pending = true; persist();
        await new Promise((resolve, reject) => {
          const cancelled = () => {
            observed.pending = false; observed.cancelled = true; persist();
            clearTimeout(timer); subscription?.dispose(); resolve();
          };
          let subscription;
          const timer = setTimeout(() => { subscription?.dispose(); reject(new Error("Native Task cancellation did not arrive.")); }, 90000);
          subscription = token.onCancellationRequested(cancelled);
          if (token.isCancellationRequested) cancelled();
        });
        throw new Error("The actual VS Code LM cancellation token stopped the synthetic Task provider.");
      } else {
        assert(goal.objective.includes(installedNativeManagedTaskMarkers.plain), "Follow-up replaced the original objective.");
        assert.equal(goal.sourceInputIds.length, 2, "Follow-up omitted the original source input.");
        const proposals = installedNativeManagedTaskProposals(binding, goal), results = new Map();
        const visit = value => {
          if (typeof vscode.LanguageModelToolResultPart === "function" && value instanceof vscode.LanguageModelToolResultPart) {
            assert(!results.has(value.callId), "Native tool-result identity was duplicated.");
            results.set(value.callId, strings(value.content).join("\n")); return;
          }
          if (Array.isArray(value)) for (const child of value) visit(child);
          else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
        };
        visit(messages);
        let step = 0;
        while (step < proposals.length && results.has(proposals[step].callId)) {
          const actual = results.get(proposals[step].callId);
          if (step === 0) assert(actual.includes(options.expectedToolText), "The actual canonical Note evidence is missing.");
          else {
            const snapshot = JSON.parse(actual);
            assert.equal(snapshot.schema, "pkm.chat.managed-task/v1");
            assert.equal(snapshot.taskId, binding.taskId);
            assert.equal(snapshot.attempt.id, binding.attemptId);
            assert.equal(snapshot.taskCompletion, "not-claimed");
            if (step === proposals.length - 1) assert.equal(snapshot.goal.status, "resolved");
          }
          step++;
        }
        assert(proposals.slice(step + 1).every(proposal => !results.has(proposal.callId)), "A fixture tool/result was replayed out of order.");
        observed.step = step;
        if (step < proposals.length) {
          const proposal = proposals[step];
          assert(observed.tools.includes(proposal.name), "The actual Task scope omitted its required Core tool.");
          observed.proposal = proposal; persist();
          progress.report(new vscode.LanguageModelToolCallPart(proposal.callId, proposal.name, proposal.arguments));
        } else {
          assert.deepEqual(observed.tools, [], "The final hard-limit inference must be tool-free.");
          progress.report(new vscode.LanguageModelTextPart(installedNativeManagedTaskReply));
        }
      }
      observed.completed = true; persist();
    },
  });
  persist();
  try {
    await vscode.lm.selectChatModels({ vendor: installedNativeManagedTaskVendor });
    if (typeof vscode.lm.onDidChangeChatModels === "function") await new Promise((resolve, reject) => {
      let quiet;
      const finish = error => {
        clearTimeout(quiet); clearTimeout(deadline); subscription.dispose();
        if (error) reject(error); else resolve();
      };
      const settle = () => { clearTimeout(quiet); quiet = setTimeout(() => finish(), 500); };
      const subscription = vscode.lm.onDidChangeChatModels(settle);
      const deadline = setTimeout(() => finish(new Error("Native Task fixture model discovery did not settle.")), 5000);
      settle();
    });
  }
  catch (error) { registration.dispose(); throw error; }
  return registration;
}
