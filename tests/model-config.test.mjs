import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ModelConfigService,
  modelApiKeySecretId,
} from "../dist/model-config.js";
import {
  estimateModelInputTokens,
  normalizeModelConfiguration,
  validateModelBudget,
} from "../dist/domain/model-config.js";
import { modelConfigDefinitions } from "../dist/model-config-contracts.js";

const activeProfile = (id, overrides = {}) => ({
  id,
  status: "active",
  contextWindow: 8192,
  maxOutputTokens: 2048,
  ...overrides,
});

function dependencies(configuration, options = {}) {
  const resolvedSecretIds = [];
  const service = new ModelConfigService({
    configuration,
    secretResolver: {
      async resolveSecret(id) {
        resolvedSecretIds.push(id);
        if (options.secretError) throw new Error(options.secretError);
        return options.secretHandle;
      },
    },
    registryAvailability: options.registryAvailability ?? {
      vscode: true,
      "openai-compatible": true,
      "azure-openai": true,
    },
    now: () => options.now ?? Date.UTC(2026, 10, 6),
  });
  return { service, resolvedSecretIds };
}

test("model catalog is redacted and HTTP credentials remain an opaque native handle", async () => {
  const endpoint = "https://api.example.test/v1";
  const privateValue = "native-secret-value-must-not-escape";
  const { service, resolvedSecretIds } = dependencies({
    apiChatProvider: "openai-compatible",
    aiModel: "fixture-model",
    aiEndpoint: endpoint,
    apiChatModelProfiles: [activeProfile("fixture-model", { label: "Fixture model" })],
  }, { secretHandle: Object.freeze({ opaque: privateValue }) });

  const catalog = await service.catalog();
  modelConfigDefinitions.find(definition => definition.id === "model.config.catalog").output.parse(catalog);
  const serializedCatalog = JSON.stringify(catalog);
  assert.equal(catalog.schema, "pkm.model-config.catalog/v1");
  assert.equal(catalog.providers.length, 3);
  assert.equal(catalog.providers.find(item => item.provider === "openai-compatible").status, "configured");
  assert.equal(catalog.providers.find(item => item.provider === "vscode").discovery, "unsupported");
  assert.deepEqual(resolvedSecretIds, [modelApiKeySecretId]);
  assert.equal(serializedCatalog.includes(endpoint), false);
  assert.equal(serializedCatalog.includes(privateValue), false);
  assert.equal(serializedCatalog.includes("endpoint"), true);
  assert.equal(catalog.providers.find(item => item.provider === "openai-compatible").endpointConfigured, true);

  const resolution = await service.resolve({});
  modelConfigDefinitions.find(definition => definition.id === "model.config.resolve").output.parse(resolution);
  assert.equal(resolution.status, "configured");
  assert.equal(resolution.profile.id, "fixture-model");
  assert.equal(JSON.stringify(resolution).includes(endpoint), false);
  assert.equal(JSON.stringify(resolution).includes(privateValue), false);
});

test("missing and failed credentials are reported without exposing values or resolver errors", async () => {
  const configuration = {
    apiChatProvider: "azure-openai",
    aiModel: "deployment",
    aiEndpoint: "https://azure.example.test",
  };
  const missing = dependencies(configuration);
  const missingResult = await missing.service.resolve({});
  assert.equal(missingResult.status, "credentials-missing");
  assert.equal(missingResult.credentialStatus, "missing");

  const failed = dependencies(configuration, { secretError: "secret-bearing resolver failure" });
  const failedResult = await failed.service.resolve({});
  assert.equal(failedResult.status, "credential-status-unavailable");
  assert.equal(JSON.stringify(failedResult).includes("secret-bearing"), false);

  const rawString = dependencies(configuration, { secretHandle: "raw-secret-value" });
  const rawStringResult = await rawString.service.resolve({});
  assert.equal(rawStringResult.status, "credentials-missing");
  assert.equal(JSON.stringify(rawStringResult).includes("raw-secret-value"), false);
});

test("selection merge preserves profile order, remembered/default precedence, and conservative legacy profiles", async () => {
  const { service } = dependencies({
    apiChatProvider: "azure-openai",
    aiModel: "configured-default",
    aiEndpoint: "https://azure.example.test",
    apiChatModels: ["additional-model"],
    apiChatModelProfiles: [
      activeProfile("configured-default", { label: "Configured default" }),
      activeProfile("remembered-model", { label: "Current configured profile" }),
      activeProfile("retired-model", { status: "deprecated" }),
      activeProfile("deprecated-alias", { model: "shared-deployment", status: "deprecated" }),
      activeProfile("active-alias", { model: "shared-deployment" }),
    ],
    rememberedModel: {
      provider: "azure-openai",
      profile: {
        ...activeProfile("remembered-model", { contextWindow: 16384, maxOutputTokens: 4096 }),
        model: "remembered-api-model",
        label: "Remembered profile",
      },
    },
  }, { secretHandle: Object.freeze({}) });

  const catalog = await service.catalog();
  assert.deepEqual(
    catalog.providers.find(item => item.provider === "azure-openai").profiles.map(profile => profile.id),
    ["configured-default", "remembered-model", "retired-model", "deprecated-alias", "active-alias", "additional-model"],
  );
  assert.equal(catalog.providers.find(item => item.provider === "azure-openai").profiles.at(-1).status, "unknown");
  assert.equal(catalog.providers.find(item => item.provider === "azure-openai").profiles.at(-1).contextWindow, 4096);
  assert.equal(catalog.providers.find(item => item.provider === "azure-openai").profiles.at(-1).maxOutputTokens, 1024);
  assert.equal(catalog.providers.find(item => item.provider === "azure-openai").profiles.at(-1).metadataSource, "legacy-fallback");

  const remembered = await service.resolve({});
  assert.equal(remembered.profile.id, "remembered-model");
  assert.equal(remembered.profile.label, "Current configured profile", "configured profile metadata wins over saved metadata");
  assert.equal(remembered.budget.contextWindow, 8192);

  const explicit = await service.resolve({ profileId: "configured-default" });
  assert.equal(explicit.profile.id, "configured-default");
  const legacy = await service.resolve({ profileId: "additional-model" });
  assert.equal(legacy.status, "model-unverified");
  assert.equal(legacy.profile.metadataSource, "legacy-fallback");
  const deprecated = await service.resolve({ profileId: "retired-model" });
  assert.equal(deprecated.status, "model-deprecated");
  assert.equal((await service.resolve({ profileId: "active-alias" })).status, "model-deprecated");

  const inherited = dependencies({
    apiChatProvider: "openai-compatible",
    aiEndpoint: "https://api.example.test/v1",
    rememberedModel: {
      provider: "azure-openai",
      profile: {
        ...activeProfile("remembered-azure"),
        model: "deployment",
        label: "Remembered Azure deployment",
      },
    },
  }, { secretHandle: Object.freeze({}) });
  const inheritedResolution = await inherited.service.resolve({});
  assert.equal(inheritedResolution.provider, "azure-openai");
  assert.equal(inheritedResolution.profile.id, "remembered-azure");

  const nativeSaved = dependencies({
    apiChatProvider: "openai-compatible",
    rememberedModel: {
      provider: "vscode",
      profile: {
        ...activeProfile("vscode:copilot:model"),
        model: "model",
        label: "Native model",
        imageInput: true,
      },
    },
  }, { secretHandle: Object.freeze({}) });
  const nativeResolution = await nativeSaved.service.resolve({});
  assert.equal(nativeResolution.provider, "vscode");
  assert.equal(nativeResolution.status, "provider-discovery-unsupported");
  assert.equal(nativeResolution.profile, null);
});

test("VS Code discovery is explicitly unsupported and never invents an available model", async () => {
  const { service, resolvedSecretIds } = dependencies({
    apiChatProvider: "vscode",
    aiModel: "configured-http-model",
    aiEndpoint: "https://api.example.test/v1",
    apiChatModelProfiles: [activeProfile("configured-http-model")],
  }, { secretHandle: Object.freeze({}) });

  const resolution = await service.resolve({ provider: "vscode" });
  assert.equal(resolution.status, "provider-discovery-unsupported");
  assert.equal(resolution.registryAvailable, true);
  assert.equal(resolution.profile, null);
  assert.equal(resolution.credentialStatus, "not-required");
  assert.deepEqual(resolvedSecretIds, []);
  const catalog = await service.catalog();
  const vscode = catalog.providers.find(item => item.provider === "vscode");
  assert.equal(vscode.status, "provider-discovery-unsupported");
  assert.deepEqual(vscode.profiles, []);
});

test("invalid configuration, unavailable providers, and unsafe public inputs are bounded", async () => {
  const duplicate = dependencies({
    apiChatModelProfiles: [activeProfile("same"), activeProfile("same")],
    aiEndpoint: "https://api.example.test/v1",
  }, { secretHandle: Object.freeze({}) });
  assert.equal((await duplicate.service.resolve({})).status, "invalid-configuration");
  assert.equal((await duplicate.service.catalog()).providers[1].status, "invalid-configuration");

  const unavailable = dependencies({
    apiChatProvider: "openai-compatible",
    aiEndpoint: "https://api.example.test/v1",
  }, {
    secretHandle: Object.freeze({}),
    registryAvailability: { "openai-compatible": false, "azure-openai": true, vscode: false },
  });
  assert.equal((await unavailable.service.resolve({})).status, "provider-unavailable");

  const { service, resolvedSecretIds } = dependencies({
    aiEndpoint: "https://api.example.test/v1?token=private",
    apiChatModelProfiles: [activeProfile("one")],
  }, { secretHandle: Object.freeze({}) });
  const endpointWithQuery = await service.resolve({});
  assert.equal(endpointWithQuery.status, "endpoint-missing");
  assert.equal(endpointWithQuery.endpointConfigured, false);
  assert.equal(JSON.stringify(endpointWithQuery).includes("api.example.test"), false);
  await assert.rejects(service.resolve({ apiKey: "caller-supplied-secret" }), /Invalid model configuration request/);
  assert.deepEqual(resolvedSecretIds, []);
  assert.equal(modelConfigDefinitions.every(definition => definition.readOnly), true);
  assert.equal(modelConfigDefinitions.find(definition => definition.id === "model.config.resolve")
    .input.safeParse({ endpoint: "https://caller.example", apiKey: "secret" }).success, false);
  assert.equal(modelConfigDefinitions.find(definition => definition.id === "model.config.resolve")
    .input.safeParse({ messages: Array.from({ length: 33 }, () => ({ role: "user", content: "x".repeat(65_536) })) }).success, false);
  assert.equal(normalizeModelConfiguration({ aiModel: "x".repeat(300_000) }).valid, false);
  assert.equal(normalizeModelConfiguration({
    aiModel: "default",
    apiChatModels: Array.from({ length: 128 }, (_, index) => `model-${index}`),
    apiChatModelProfiles: Array.from({ length: 128 }, (_, index) => activeProfile(`profile-${index}`)),
  }).valid, false);
});

test("endpoint readiness matches original provider URL rules", async () => {
  for (const endpoint of [
    "http://localhost:8123/v1",
    "http://127.0.0.1:8123/v1",
    "http://[::1]:8123/v1",
  ]) {
    assert.equal(normalizeModelConfiguration({ aiEndpoint: endpoint }).endpointConfigured, true, endpoint);
  }

  const remoteCleartext = dependencies({
    aiEndpoint: "http://provider.example.test/v1",
    aiModel: "fixture-model",
    apiChatModelProfiles: [activeProfile("fixture-model")],
  }, { secretHandle: Object.freeze({}) });
  const result = await remoteCleartext.service.resolve({});
  assert.equal(result.status, "endpoint-missing");
  assert.equal(result.endpointConfigured, false);
  assert.equal(JSON.stringify(result).includes("provider.example.test"), false);
  assert.deepEqual(remoteCleartext.resolvedSecretIds, []);
});

test("budget estimate matches the verified legacy UTF-8 byte formula and enforces bounded arithmetic", async () => {
  assert.equal(estimateModelInputTokens([{ role: "user", content: "你好" }]), 70);
  const toolCalls = [{ id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }];
  const withTools = 32 + Buffer.byteLength(`x${JSON.stringify(toolCalls)}`, "utf8") + 32;
  assert.equal(estimateModelInputTokens([{ role: "assistant", content: "x", tool_calls: toolCalls }]), withTools);

  const profile = {
    id: "budget-model", model: "budget-model", label: "Budget model", status: "active", metadataSource: "configured-profile",
    contextWindow: 8192, maxOutputTokens: 2048, currency: "USD", includeUsage: false,
    outputTokenParameter: "max_completion_tokens",
  };
  const budget = validateModelBudget(profile, 1024, 256, [{ role: "user", content: "hello" }]);
  assert.equal(budget.inputBudget, 768);
  assert.equal(budget.estimatedInputTokens, 69);
  assert.equal(budget.fits, true);
  assert.throws(() => validateModelBudget(profile, 256, 128, [{ role: "user", content: "x".repeat(200) }]), /invalid-budget/);
  assert.throws(() => validateModelBudget(profile, 8_192_001, 128), /invalid-budget/);
  assert.throws(() => estimateModelInputTokens(Array.from({ length: 257 }, () => ({ role: "user", content: "" }))), /invalid-budget/);

  const { service } = dependencies({
    apiChatProvider: "openai-compatible",
    aiEndpoint: "https://api.example.test/v1",
    apiChatModelProfiles: [activeProfile("budget-model")],
  }, { secretHandle: Object.freeze({}) });
  const invalid = await service.resolve({
    profileId: "budget-model",
    contextWindow: 256,
    outputTokens: 128,
    messages: [{ role: "user", content: "x".repeat(200) }],
  });
  assert.equal(invalid.status, "invalid-budget");
  assert.equal(invalid.budget, null);
});
