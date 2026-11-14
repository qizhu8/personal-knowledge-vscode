"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const extension = process.env.PKM_TRIAL_EXTENSION_DIST;
if (!extension) throw Error("Run with isolated compiled extension fixtures.");
const model = { vendor: "fixture", id: "native", name: "Synthetic", maxInputTokens: 16384,
  maxOutputTokens: 1024, capabilities: { toolCalling: true } };
const chat = { modelProvider: "vscode", vscodeModelId: "vscode:fixture:native", modelProfileId: null,
  contextWindow: null, maxOutputTokens: null };
let models = [model], picks = 0, secretReads = 0, allowAnother = false, pendingDiscovery = false, discoveries = 0;
let chooseSdk = false, allowSdk = false, sdkTokens = 0, sdkCatalogs = 0;
const host = { workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
  lm: { async selectChatModels() { discoveries++; return pendingDiscovery ? new Promise(() => {}) : models; } },
  window: { async showQuickPick(items) { picks++; return chooseSdk && items.some(item => item.sdk || item.mode === "sdk")
    ? items.find(item => item.sdk || item.mode === "sdk") : items[0]; },
    async showWarningMessage(message) { return message.startsWith("Discover Copilot") && allowSdk ? "Discover SDK Models"
      : allowAnother ? "Choose Another Model" : undefined; } } };
const context = { secrets: { async get() { secretReads++; return "synthetic-key"; } },
  globalState: { get() { return undefined; } } };
const file = path.join(extension, "runtime/next-chat-model-selection.js");
const original = Module._load;
let select;
try {
  Module._load = function (name, ...args) {
    if (name === "vscode") return host;
    return original.call(this, name, ...args);
  };
  select = require(file).selectedChatModel;
} finally { Module._load = original; }

test("native selection honors saved model without reading PKM secrets or sending a request", async () => {
  const chosen = await select(context, chat);
  assert.equal(chosen.vscodeModel, model);
  assert.equal(chosen.configuration.vscodeModelId, chat.vscodeModelId);
  assert.equal(chosen.configuration.apiKey, "");
  assert.equal(secretReads, 0);
  assert.equal(picks, 0);
});

test("native picker is explicit and unavailable saved models never silently fall back", async () => {
  const chosen = await select(context, { ...chat, vscodeModelId: null });
  assert.equal(chosen.vscodeModel, model);
  assert.equal(picks, 1);
  models = [{ ...model, vendor: "copilot-sdk" }, { ...model, vendor: "copilotcli" }];
  await assert.rejects(select(context, chat), /unavailable; no fallback/);
  assert.equal(secretReads, 0);
  models = [model];
  allowAnother = true;
  const replacement = await select(context, { ...chat, vscodeModelId: "vscode:copilot-sdk:old" });
  assert.equal(replacement.vscodeModel, model);
  assert.equal(picks, 2);
  allowAnother = false;
});

test("HTTP selection alone reads the existing PKM API key", async () => {
  const chosen = await select(context, { ...chat, modelProvider: "openai-compatible", vscodeModelId: null });
  assert.equal(chosen.configuration.apiKey, "synthetic-key");
  assert.equal(secretReads, 1);
});

test("revoked model discovery stops selection without reading secrets or making another request", async () => {
  const controller = new AbortController();
  pendingDiscovery = true;
  const selecting = select(context, chat, controller.signal);
  controller.abort();
  await assert.rejects(selecting, /revoked/);
  const before = discoveries;
  await assert.rejects(select(context, chat, controller.signal), /revoked/);
  assert.equal(discoveries, before);
  assert.equal(secretReads, 1);
  pendingDiscovery = false;
});

test("SDK discovery is explicit, uses isolated injectable auth and never silently replaces a saved SDK model", async () => {
  const deps = { async token(interactive) { assert.equal(interactive, true); sdkTokens++; return "fixture-token"; },
    async client() { return { client: { rpc: { models: { async list(input) {
      assert.equal(input.gitHubToken, "fixture-token"); sdkCatalogs++;
      return { models: [{ id: "fixture-sdk", capabilities: { limits: { max_prompt_tokens: 16384, max_output_tokens: 1024 },
        supports: { tool_calls: true, vision: true } } }] };
    } } } } }; } };
  chooseSdk = true;
  await assert.rejects(select(context, { ...chat, vscodeModelId: null }, undefined, async () => deps), /not approved/);
  assert.equal(sdkTokens, 0);
  allowSdk = true;
  const selected = await select(context, { ...chat, vscodeModelId: null }, undefined, async () => deps);
  assert.equal(selected.vscodeModel.vendor, "copilot-sdk");
  assert.equal(selected.configuration.vscodeModelId, "vscode:copilot-sdk:fixture-sdk");
  assert.equal(selected.configuration.vscodeImageInput, true);
  assert.equal(selected.configuration.vscodeTools, true);
  assert.equal(secretReads, 1);
  assert.equal(sdkTokens, 1);
  assert.equal(sdkCatalogs, 1);
  const fromHttp = await select(context, { ...chat, modelProvider: "openai-compatible" }, undefined, async () => deps);
  assert.equal(fromHttp.vscodeModel.vendor, "copilot-sdk");
  assert.equal(secretReads, 1);
  const fromSavedNative = await select(context, chat, undefined, async () => deps);
  assert.equal(fromSavedNative.vscodeModel.vendor, "copilot-sdk");
  assert.equal(secretReads, 1);
  await assert.rejects(select(context, { ...chat, vscodeModelId: "vscode:copilot-sdk:missing" }, undefined, async () => deps),
    /unavailable; no fallback/);
  chooseSdk = false; allowSdk = false;
});
