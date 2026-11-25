import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { installedNativeManagedTaskProposals } from "./installed-native-managed-task-provider.mjs";

export const installedNativeManagedTaskAdoptionVendor = "pkm-native-managed-task-adoption-fixture";
export const installedNativeManagedTaskAdoptionLabel = "Synthetic installed original Task adoption model";
export const installedNativeManagedTaskAdoptionReply = "INSTALLED_ORIGINAL_TASK_ADOPTION_REVALIDATED";
export const installedNativeManagedTaskAdoptionMarkers = Object.freeze({
  adoptDeny: "INSTALLED_ORIGINAL_TASK_ADOPTION_DENY_REVIEW",
  sendDeny: "INSTALLED_ORIGINAL_TASK_ADOPTION_DENY_SEND",
  positive: "INSTALLED_ORIGINAL_TASK_ADOPTION_POSITIVE",
  collision: "INSTALLED_ORIGINAL_TASK_ADOPTION_COLLISION",
  revoked: "INSTALLED_ORIGINAL_TASK_ADOPTION_REVOKED",
});
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const child of value) strings(child, found);
  else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child, found);
  return found;
}
function manifest(texts, prefix) {
  const found = texts.flatMap(text => {
    const index = text.indexOf(prefix);
    return index < 0 ? [] : [JSON.parse(text.slice(index + prefix.length).split("\n")[0])];
  });
  assert.equal(found.length, 1, "The actual current adopted binding/Goal manifest must be unique.");
  return found[0];
}
export function installedNativeManagedTaskAdoptionProposals(binding, goal, historicalEvidenceId) {
  const base = installedNativeManagedTaskProposals(binding, goal);
  return [
    { name: "session_info", operation: "chat.task.get", callId: `installed-adoption-${binding.attemptId}-info`, arguments: {} },
    { name: "report_work", operation: "chat.task.report_work", callId: `installed-adoption-${binding.attemptId}-historical-refused`,
      arguments: { status: "resolved", reason: "This historical-only ID must be refused as current acceptance evidence.",
        sourceInputIds: goal.sourceInputIds, acceptance: goal.acceptance.map(item => ({
          criterion: item.criterion, verified: true, evidenceCallIds: [historicalEvidenceId],
        })) } },
    ...base,
  ];
}

/** Real vscode.lm registration; deterministic response fixture only, never approval or ownership authority. */
export async function registerInstalledNativeManagedTaskAdoptionProvider(vscode, options) {
  assert.equal(typeof vscode.lm?.registerLanguageModelChatProvider, "function", "Actual native LM registration is required.");
  assert(options && isAbsolute(options.evidencePath) && typeof options.expectedToolText === "string"
    && options.expectedToolText && /^agent_session_[a-f0-9]{32}$/.test(options.originalTaskId)
    && typeof options.originalGoalId === "string" && typeof options.originalInputId === "string"
    && typeof options.originalObjective === "string" && options.originalObjective
    && typeof options.historicalEvidenceId === "string" && options.historicalEvidenceId);
  const state = { schema: "pkm.installed-native-managed-task-adoption-provider/v1", deterministicProvider: true,
    commercialProviderQualified: false, actualProfileOrKeyringQualified: false, nativeCalls: 0, tokenCalls: 0, informationCalls: 0, requests: [] };
  const persist = () => writeFileSync(options.evidencePath, JSON.stringify(state), { mode: 0o600 });
  const registration = vscode.lm.registerLanguageModelChatProvider(installedNativeManagedTaskAdoptionVendor, {
    async provideLanguageModelChatInformation() {
      state.informationCalls++; persist();
      return [{ id: "original-task-adoption-fixture", name: installedNativeManagedTaskAdoptionLabel, family: "fixture", version: "1",
        maxInputTokens: 200000, maxOutputTokens: 8192, capabilities: { toolCalling: true, imageInput: false } }];
    },
    async provideTokenCount(_model, value, token) {
      state.tokenCalls++; persist(); assert(!token.isCancellationRequested, "Adoption token counting was cancelled.");
      return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4));
    },
    async provideLanguageModelChatResponse(model, messages, requestOptions, progress, token) {
      const texts = strings(messages), content = texts.join("\n");
      const phase = Object.entries(installedNativeManagedTaskAdoptionMarkers).find(([, marker]) => content.includes(marker))?.[0];
      state.nativeCalls++;
      const observed = { call: state.nativeCalls, modelId: model.id, phase: phase ?? null, messagesSha256: digest(messages),
        tools: (requestOptions.tools ?? []).map(tool => tool.name), completed: false };
      state.requests.push(observed); persist();
      assert(!token.isCancellationRequested, "Native adoption inference was cancelled.");
      assert.equal(phase, "positive", "A denied, colliding or revoked adoption reached the actual provider.");
      const binding = manifest(texts, "Current native Task binding (not permissions or a Task completion certificate).\n");
      const goal = manifest(texts, "User work objective (not a permission grant or a managed Task completion certificate):\n");
      assert.equal(binding.taskId, options.originalTaskId); assert.equal(goal.id, options.originalGoalId);
      assert.equal(goal.inputId, options.originalInputId); assert.equal(goal.objective, options.originalObjective);
      assert.equal(goal.attemptInputId, binding.inputId);
      assert.deepEqual(goal.sourceInputIds, [options.originalInputId, binding.inputId]);
      assert(goal.acceptance.every(item => item.verified === false && item.evidenceCallIds.length === 0),
        "Current acceptance inherited a historical claim.");
      assert(content.includes("Preserved historical tool evidence"), "The old terminal tool evidence was silently discarded.");
      const proposals = installedNativeManagedTaskAdoptionProposals(binding, goal, options.historicalEvidenceId), results = new Map();
      const visit = value => {
        if (typeof vscode.LanguageModelToolResultPart === "function" && value instanceof vscode.LanguageModelToolResultPart) {
          assert(!results.has(value.callId), "Duplicate native tool-result identity.");
          results.set(value.callId, strings(value.content).join("\n")); return;
        }
        if (Array.isArray(value)) for (const child of value) visit(child);
        else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child);
      };
      visit(messages);
      let step = 0;
      while (step < proposals.length && results.has(proposals[step].callId)) {
        const actual = results.get(proposals[step].callId), parsed = step === 2 ? null : JSON.parse(actual);
        if (step === 1) {
          assert(parsed.error, "Historical-only evidence was accepted as current proof.");
          assert.equal(parsed.effect, "not-committed");
          observed.historicalEvidenceRefused = true;
        } else if (step === 2) assert(actual.includes(options.expectedToolText), "Current canonical Note evidence is missing.");
        else {
          assert.equal(parsed.schema, "pkm.chat.managed-task/v1");
          assert.equal(parsed.taskId, options.originalTaskId); assert.equal(parsed.goal.id, options.originalGoalId);
          assert.equal(parsed.attempt.id, binding.attemptId); assert.equal(parsed.taskCompletion, "not-claimed");
          if (step === 0) assert(parsed.goal.acceptance.every(item => !item.verified && item.evidenceCallIds.length === 0));
          if (step === proposals.length - 1) assert.equal(parsed.goal.status, "resolved");
        }
        step++;
      }
      assert(proposals.slice(step + 1).every(proposal => !results.has(proposal.callId)), "Tool receipts arrived out of fixture order.");
      Object.assign(observed, { binding, originalGoalId: goal.id, originalObjective: goal.objective, sourceInputIds: goal.sourceInputIds, step });
      if (step < proposals.length) {
        const proposal = proposals[step]; assert(observed.tools.includes(proposal.name), "A required real Core tool is unavailable.");
        observed.proposal = proposal; persist();
        progress.report(new vscode.LanguageModelToolCallPart(proposal.callId, proposal.name, proposal.arguments));
      } else {
        assert.deepEqual(observed.tools, [], "The final hard-limit inference must be tool-free.");
        progress.report(new vscode.LanguageModelTextPart(installedNativeManagedTaskAdoptionReply));
      }
      observed.completed = true; persist();
    },
  });
  persist();
  try {
    await vscode.lm.selectChatModels({ vendor: installedNativeManagedTaskAdoptionVendor });
    if (typeof vscode.lm.onDidChangeChatModels === "function") await new Promise((resolve, reject) => {
      let quiet;
      const finish = error => {
        clearTimeout(quiet); clearTimeout(deadline); subscription.dispose();
        if (error) reject(error); else resolve();
      };
      const settle = () => { clearTimeout(quiet); quiet = setTimeout(() => finish(), 500); };
      const subscription = vscode.lm.onDidChangeChatModels(settle);
      const deadline = setTimeout(() => finish(new Error("Native adoption model discovery did not settle.")), 5000); settle();
    });
  } catch (error) { registration.dispose(); throw error; }
  return registration;
}
