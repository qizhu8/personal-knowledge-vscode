import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const installedNativeMemoryVendor = "pkm-native-memory-fixture";
export const installedNativeMemoryMarkers = Object.freeze({
  off: "INSTALLED_NATIVE_MEMORY_OFF_REQUEST",
  missing: "INSTALLED_NATIVE_MEMORY_MISSING_REQUEST",
  positive: "INSTALLED_NATIVE_MEMORY_POSITIVE_REQUEST",
  revoke: "INSTALLED_NATIVE_MEMORY_REVOKE_REQUEST",
});
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function strings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const child of value) strings(child, found);
  else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child, found);
  return found;
}
function manifests(messages) {
  const found = [];
  for (const text of strings(messages)) {
    const start = text.indexOf('{"schema":"pkm.native-explicit-memory-context/v1"');
    if (start < 0) continue;
    const value = JSON.parse(text.slice(start).trim());
    if (value.schema === "pkm.native-explicit-memory-context/v1") found.push(value);
  }
  return found;
}

/**
 * Development-driver hook using the actual VS Code registration API. This is a
 * deterministic local model, never a commercial provider or authority producer.
 */
export async function registerInstalledNativeMemoryProvider(vscode, options) {
  assert.equal(typeof vscode.lm?.registerLanguageModelChatProvider, "function",
    "Actual native model-provider registration is required; no API substitute is installed.");
  assert(options && isAbsolute(options.evidencePath) && typeof options.scope === "string"
    && typeof options.recordId === "string" && typeof options.query === "string"
    && typeof options.expectedToolText === "string" && options.expectedToolText.length > 0);
  const state = { schema: "pkm.installed-native-memory-provider/v1",
    scope: "deterministic local native LM fixture; not a commercial model or production keyring",
    nativeCalls: 0, tokenCalls: 0, informationCalls: 0, requests: [] };
  const persist = () => writeFileSync(options.evidencePath, JSON.stringify(state), { mode: 0o600 });
  const registration = vscode.lm.registerLanguageModelChatProvider(installedNativeMemoryVendor, {
    async provideLanguageModelChatInformation() {
      state.informationCalls++; persist();
      return [{ id: "memory-fixture", name: "Synthetic installed Memory evidence model", family: "fixture", version: "1",
        maxInputTokens: 200000, maxOutputTokens: 8192, capabilities: { toolCalling: true, imageInput: false } }];
    },
    async provideTokenCount(_model, value, token) {
      state.tokenCalls++; persist();
      if (token.isCancellationRequested) throw new Error("Installed Memory token counting was cancelled.");
      return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4));
    },
    async provideLanguageModelChatResponse(model, messages, requestOptions, progress, token) {
      const serialized = JSON.parse(JSON.stringify(messages)), content = strings(serialized).join("\n");
      const selected = manifests(serialized);
      const marker = Object.entries(installedNativeMemoryMarkers).find(([, text]) => content.includes(text))?.[0];
      state.nativeCalls++;
      const observed = { call: state.nativeCalls, modelId: model.id, marker: marker ?? null,
        messagesSha256: digest(serialized), manifests: selected, tools: (requestOptions.tools ?? []).map(tool => tool.name),
        toolResultObserved: content.includes(options.expectedToolText), proposedTool: false,
        cancelled: token.isCancellationRequested, completed: false };
      state.requests.push(observed); persist();
      if (token.isCancellationRequested) throw new Error("Installed Memory inference was cancelled.");
      assert(!["missing", "revoke"].includes(marker),
        "A missing-grant or revoked prepared request reached the real provider.");
      if (marker === "off") {
        assert.equal(selected.length, 0, "Default off must not send a live Memory manifest.");
        progress.report(new vscode.LanguageModelTextPart("INSTALLED_NATIVE_MEMORY_OFF_REPLY"));
      } else {
        assert.equal(marker, "positive", "Only the exact labelled synthetic request may use this test provider.");
        assert.equal(selected.length, 1, "The real provider must receive one exact live-Memory manifest.");
        const manifest = selected[0];
        assert.equal(manifest.scope, options.scope);
        assert.equal(manifest.binding.query, options.query);
        assert.equal(manifest.binding.limit, 3);
        assert.deepEqual(manifest.records.map(record => record.id), [options.recordId]);
        assert.match(manifest.notice, /not instructions/);
        if (requestOptions.tools?.some(tool => tool.name === "get_document")) {
          assert.equal(observed.toolResultObserved, false, "The one-round fixture must not replay a previous tool result.");
          observed.proposedTool = true; persist();
          progress.report(new vscode.LanguageModelToolCallPart(`installed-memory-read-${state.nativeCalls}`,
            "get_document", { id: "Entry" }));
        } else {
          assert(observed.toolResultObserved, "The final tool-free request must contain the actual same-Core read result.");
          progress.report(new vscode.LanguageModelTextPart("INSTALLED_NATIVE_MEMORY_POSITIVE_REPLY"));
        }
      }
      observed.completed = true; persist();
    },
  });
  persist();
  try {
    await vscode.lm.selectChatModels({ vendor: installedNativeMemoryVendor });
    if (typeof vscode.lm.onDidChangeChatModels === "function") await new Promise((resolve, reject) => {
      let quiet;
      const finish = error => {
        clearTimeout(quiet); clearTimeout(deadline); subscription.dispose();
        if (error) reject(error); else resolve();
      };
      const settle = () => { clearTimeout(quiet); quiet = setTimeout(() => finish(), 500); };
      const subscription = vscode.lm.onDidChangeChatModels(settle);
      const deadline = setTimeout(() => finish(new Error("Installed Memory fixture model discovery did not settle.")), 5000);
      settle();
    });
  } catch (error) { registration.dispose(); throw error; }
  return registration;
}
