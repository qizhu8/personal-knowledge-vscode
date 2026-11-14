const assert = require("node:assert/strict");
const { test, beforeEach, after } = require("node:test");
const Module = require("node:module");

let state;
const host = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  QuickPickItemKind: { Separator: -1 },
  ProgressLocation: { Notification: 15 },
  lm: {
    selectChatModels: async selector => {
      state.nativeCalls.push(selector);
      if (state.nativeError) throw state.nativeError;
      return state.nativeModels;
    },
  },
  authentication: {
    getSession: async (_provider, _scopes, options) => {
      state.events.push("account-access");
      if (state.authError) throw state.authError;
      if (!state.session && options.createIfNone) {
        state.signIns++;
        state.session = { accessToken: "fixture-only-token" };
      }
      return state.session;
    },
  },
  window: {
    showQuickPick: async (pending, options) => {
      const items = await pending;
      state.pickers.push({ items, options });
      state.events.push(options.title === "Choose model source" ? "source-picker" : "model-picker");
      assert(state.picks.length, `Unexpected picker: ${options.title}`);
      return state.picks.shift()(items);
    },
    withProgress: async (_options, run) => run({}, {
      isCancellationRequested: state.cancelProgress,
      onCancellationRequested: () => ({ dispose() {} }),
    }),
  },
};

const originalLoad = Module._load;
let ApiChatView, sdkChannel;
try {
  Module._load = function(name, ...args) {
    return name === "vscode" ? host : originalLoad.call(this, name, ...args);
  };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
  sdkChannel = require("../dist/chat/api-chat-copilot-sdk");
} finally {
  Module._load = originalLoad;
}
const originalSdkDiscovery = sdkChannel.discoverCopilotSdkModels;
sdkChannel.discoverCopilotSdkModels = async (_host, signal, _deps, interactive) => {
  assert.equal(interactive, true);
  if (signal.aborted) throw new Error("Request cancelled.");
  const session = await host.authentication.getSession("github", ["user:email"], { createIfNone: true });
  assert(session);
  state.events.push("sdk-catalog");
  if (state.sdkError) throw state.sdkError;
  return state.sdkModels;
};
after(() => { sdkChannel.discoverCopilotSdkModels = originalSdkDiscovery; });

const model = (id, vendor = "copilot") => ({
  id, vendor, name: id === "auto" ? "Auto" : id,
  maxInputTokens: 8192, maxOutputTokens: 2048,
  capabilities: { toolCalling: true, imageInput: true },
});
const source = id => items => items.find(item => item.id === id);
const chooseFirst = items => items[0];

beforeEach(() => {
  state = {
    nativeModels: [model("native-model"), model("auto")],
    sdkModels: [model("sdk-model", "copilot-sdk"), model("auto", "copilot-sdk")],
    nativeCalls: [], pickers: [], picks: [], events: [], signIns: 0,
  };
});

function fixture() {
  const chat = { id: "fixture", modelProvider: "vscode", vscodeModelId: "previous-model" };
  const persisted = [];
  let remembered = "previous-model";
  const provider = Object.assign(Object.create(ApiChatView.prototype), {
    disposed: false, discoveries: new Set(), modelEpoch: 0, vscodeModels: [],
    store: { assertAvailable: () => {} },
    settings: () => ({ provider: "vscode" }),
    persist: value => persisted.push(value.vscodeModelId),
    rememberModel: async value => { remembered = value.vscodeModelId; },
    publish: () => {},
  });
  return { chat, provider, persisted, remembered: () => remembered };
}

test("Choose Model shows exactly two sources before discovery; cancellation preserves selection", async () => {
  const f = fixture();
  state.picks.push(items => {
    assert.deepEqual(items.map(item => item.label), ["Copilot Models", "SDK"]);
    assert.equal(state.nativeCalls.length, 0);
    assert.equal(state.signIns, 0);
    return undefined;
  });
  await f.provider.chooseChatModel(f.chat);
  assert.equal(f.remembered(), "previous-model");
  assert.equal(f.persisted.length, 0);
  assert.equal(state.pickers.length, 1);
});

test("Copilot Models lists every available Copilot model, Auto first, without SDK access", async () => {
  const f = fixture();
  state.nativeModels = [
    ...Array.from({ length: 120 }, (_, index) => model(`native-${index}`)),
    model("auto"), model("other-provider", "fixture"), model("catalog-only", "copilotcli"),
  ];
  state.picks.push(source("copilot"), items => {
    assert.equal(items.length, 121);
    assert.equal(items[0].id, "vscode:copilot:auto");
    assert(items.every(item => item.description === "copilot"));
    return items[1];
  });
  await f.provider.chooseChatModel(f.chat);
  assert.deepEqual(state.nativeCalls, [{ vendor: "copilot" }]);
  assert.equal(state.signIns, 0);
  assert(!state.events.includes("account-access"));
  assert.equal(f.chat.vscodeModelId, "vscode:copilot:native-0");
  assert.equal(f.remembered(), f.chat.vscodeModelId);
  assert.equal(f.provider.discoveries.size, 0);
});

test("SDK signs in before listing every SDK model, with Auto first and no native discovery", async () => {
  const f = fixture();
  state.sdkModels = [
    ...Array.from({ length: 120 }, (_, index) => model(`sdk-${index}`, "copilot-sdk")),
    model("auto", "copilot-sdk"), model("native-only"),
  ];
  state.picks.push(source("copilot-sdk"), items => {
    assert.equal(state.signIns, 1);
    assert.equal(items.length, 121);
    assert.equal(items[0].id, "vscode:copilot-sdk:auto");
    assert(items.every(item => item.description === "copilot-sdk"));
    return items[1];
  });
  await f.provider.chooseChatModel(f.chat);
  assert.deepEqual(state.events, ["source-picker", "account-access", "sdk-catalog", "model-picker"]);
  assert.equal(state.nativeCalls.length, 0);
  assert.equal(f.chat.vscodeModelId, "vscode:copilot-sdk:sdk-0");
  assert.equal(f.remembered(), f.chat.vscodeModelId);
});

test("an already signed-in SDK account loads models without another login", async () => {
  const f = fixture();
  state.session = { accessToken: "fixture-only-token" };
  state.picks.push(source("copilot-sdk"), chooseFirst);
  await f.provider.chooseChatModel(f.chat);
  assert.equal(state.signIns, 0);
  assert.equal(f.chat.vscodeModelId, "vscode:copilot-sdk:auto");
});

test("cancelling either source's model list leaves the Chat and default unchanged", async () => {
  for (const id of ["copilot", "copilot-sdk"]) {
    const f = fixture();
    state.picks.push(source(id), () => undefined);
    await f.provider.chooseChatModel(f.chat);
    assert.equal(f.chat.vscodeModelId, "previous-model");
    assert.equal(f.remembered(), "previous-model");
    assert.equal(f.persisted.length, 0);
    assert.equal(f.provider.discoveries.size, 0);
  }
});

test("SDK authentication and empty-catalog failures are explicit and never select a fallback", async () => {
  const f = fixture();
  state.authError = new Error("SDK account access denied");
  state.picks.push(source("copilot-sdk"));
  await assert.rejects(f.provider.chooseChatModel(f.chat), /account access denied/);
  assert.equal(state.pickers.length, 1);
  state.authError = undefined;
  state.sdkModels = [];
  state.picks.push(source("copilot-sdk"));
  await assert.rejects(f.provider.chooseChatModel(f.chat), /No available SDK models/);
  assert.equal(f.remembered(), "previous-model");
  assert.equal(f.persisted.length, 0);
  assert.equal(f.provider.discoveries.size, 0);
});

test("cancelling SDK connection does not open a model list or change the selection", async () => {
  const f = fixture();
  state.cancelProgress = true;
  state.picks.push(source("copilot-sdk"));
  await f.provider.chooseChatModel(f.chat);
  assert.equal(state.pickers.length, 1);
  assert.equal(state.signIns, 0);
  assert.equal(f.remembered(), "previous-model");
  assert.equal(f.provider.discoveries.size, 0);
});

test("native discovery failure remains explicit, while SDK stays independently reachable", async () => {
  const f = fixture();
  state.nativeError = new Error("fixture provider failure");
  state.picks.push(source("copilot"));
  await assert.rejects(f.provider.chooseChatModel(f.chat), /Cannot access VS Code models/);
  assert.equal(f.remembered(), "previous-model");
  state.picks.push(source("copilot-sdk"), chooseFirst);
  await f.provider.chooseChatModel(f.chat);
  assert.equal(f.chat.vscodeModelId, "vscode:copilot-sdk:auto");
});

test("a catalog change while selecting requires a fresh picker rather than persisting a stale model", async () => {
  const f = fixture();
  state.picks.push(source("copilot"), items => {
    f.provider.modelEpoch++;
    return items[0];
  });
  await assert.rejects(f.provider.chooseChatModel(f.chat), /catalog changed/);
  assert.equal(f.remembered(), "previous-model");
  assert.equal(f.persisted.length, 0);
});
