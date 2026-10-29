const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const runtimeKey = "__pkmCopilotSdkResponsivenessFixture";
const infos = [{ id: "fixture-model", capabilities: { limits: { max_prompt_tokens: 8192, max_output_tokens: 1024 } } }];
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation did not settle promptly")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

// Compile only the two changed modules in memory: these tests don't race a parent build's dist output.
function adapters() {
  const originalLoad = Module._load;
  let tools;
  try {
    Module._load = function (name, ...args) {
      if (name === "vscode") return {};
      return originalLoad.call(this, name, ...args);
    };
    tools = require("../dist/chat/api-chat-tools");
  } finally { Module._load = originalLoad; }
  const load = (name, sdk) => {
    const filename = path.join(root, "src/chat", `${name}.ts`);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = name => {
      if (name === "vscode") return {};
      if (name === "./api-chat-copilot-sdk") return sdk;
      if (name === "./api-chat-tools") return tools;
      return name.startsWith(".") ? require(path.join(root, "dist/chat", name)) : require(name);
    };
    mod._compile(compiled, filename);
    return mod.exports;
  };
  const sdk = load("api-chat-copilot-sdk");
  return { sdk, native: load("api-chat-vscode", sdk) };
}

async function fixture(t) {
  const directory = path.join(__dirname, `.copilot-sdk-responsiveness-${process.pid}-${randomUUID()}`);
  const sdkDir = path.join(directory, "node_modules/@github/copilot-sdk");
  const cliPath = path.join(directory, "node_modules/@github/copilot/index.js");
  await fs.promises.mkdir(sdkDir, { recursive: true });
  await fs.promises.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.promises.writeFile(path.join(sdkDir, "package.json"), JSON.stringify({ main: "index.js" }));
  await fs.promises.writeFile(path.join(sdkDir, "index.js"), `module.exports = globalThis.${runtimeKey};\n`);
  await fs.promises.writeFile(cliPath, "// Never executed: the fixture SDK does not spawn a process.\n");
  const state = { constructed: 0, started: 0, stopped: 0, lists: 0, auth: [], options: undefined };
  globalThis[runtimeKey] = {
    RuntimeConnection: { forStdio: options => options },
    CopilotClient: class {
      constructor(options) {
        state.constructed++;
        state.options = options;
        this.rpc = { models: { list: async params => {
          assert.equal(params.gitHubToken, "fixture-token");
          state.lists++;
          return { models: infos };
        } } };
      }
      async start() { state.started++; await state.start?.(); }
      async stop() { state.stopped++; }
    },
  };
  const { sdk, native } = adapters();
  sdk.configureCopilotSdk({ storageDir: path.join(directory, "storage") });
  const host = { env: { appRoot: directory }, authentication: { getSession: async (...args) => {
    state.auth.push(args);
    return { accessToken: "fixture-token" };
  } } };
  t.after(async () => {
    await sdk.disposeCopilotSdk();
    delete require.cache[path.join(sdkDir, "index.js")];
    delete globalThis[runtimeKey];
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  return { directory, sdk, native, state, host, cliPath };
}

test("installed VS Code CLI/native packages are found without a process report", t => {
  const { sdk } = adapters();
  const serverRoot = path.join(root, "tests/fixture-server");
  const sdkDir = path.join(serverRoot, "node_modules/@github/copilot-sdk");
  const manifest = path.join(sdkDir, "package.json");
  const cliPath = path.join(serverRoot, "node_modules/@github/copilot/index.js");
  let files = [manifest, cliPath];
  t.mock.method(fs, "existsSync", candidate => files.includes(candidate));
  t.mock.method(process.report, "getReport", () => { throw new Error("No synchronous process reports"); });
  assert.deepEqual(sdk.locateCopilotSdkRuntime("/missing-client", path.join(serverRoot, "node")), { sdkDir, cliPath });
  for (const id of [`${process.platform}-${process.arch}`, ...(process.platform === "linux" ? [`linuxmusl-${process.arch}`] : [])]) {
    const nativeDir = path.join(serverRoot, "node_modules/@github", `copilot-sdk-${id}`, "prebuilds", id);
    const wrapper = path.join(nativeDir, process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime");
    files = [manifest, wrapper, path.join(nativeDir, "runtime.node")];
    assert.deepEqual(sdk.locateCopilotSdkRuntime(undefined, path.join(serverRoot, "node")), { sdkDir, cliPath: wrapper });
    files.pop();
    assert.equal(sdk.locateCopilotSdkRuntime(undefined, path.join(serverRoot, "node")), undefined);
  }
});

test("cold bootstrap yields during private transcript cleanup and shares one runtime", async t => {
  const { directory, sdk, state, host, cliPath } = await fixture(t);
  const sessionState = path.join(directory, "storage/copilot-sdk/session-state");
  await fs.promises.mkdir(sessionState, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(path.join(sessionState, "interrupted-transcript"), "fixture");
  const entered = deferred(), release = deferred(), originalRm = fs.promises.rm;
  t.mock.method(fs.promises, "rm", async (file, options) => {
    if (file === sessionState) { entered.resolve(); await release.promise; }
    return originalRm(file, options);
  });
  for (const name of ["existsSync", "mkdirSync", "rmSync"]) {
    t.mock.method(fs, name, () => { throw new Error(`Bootstrap must not call ${name}`); });
  }
  t.mock.method(process.report, "getReport", () => { throw new Error("No synchronous process reports"); });
  const first = sdk.discoverCopilotSdkModels(host, undefined, undefined, true);
  const second = sdk.discoverCopilotSdkModels(host, undefined, undefined, true);
  try {
    await promptly(entered.promise);
    await tick();
    assert.equal(state.constructed, 0, "picker event loop runs before cleanup and SDK import finish");
  } finally { release.resolve(); }
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(models => models[0].id), ["fixture-model", "fixture-model"]);
  assert.equal(state.constructed, 1);
  assert.equal(state.started, 1);
  assert.equal(state.lists, 2);
  assert.equal(state.options.connection.path, cliPath);
  assert.equal(state.options.mode, "empty");
  assert.equal(state.options.useLoggedInUser, false);
  assert.equal(state.options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(state.options.baseDirectory, path.dirname(sessionState));
  assert.deepEqual(state.auth[0], ["github", ["user:email"], { createIfNone: true }]);
  await assert.rejects(fs.promises.access(sessionState), { code: "ENOENT" });
});

test("missing bundled runtime is reported without substituting a CLI or prompting during passive discovery", async t => {
  const { sdk, state, host, cliPath } = await fixture(t);
  t.mock.method(console, "warn", () => {});
  await fs.promises.rm(cliPath);
  assert.deepEqual(await sdk.discoverCopilotSdkModels(host), []);
  assert.deepEqual(state.auth[0], ["github", ["user:email"], {}]);
  await assert.rejects(sdk.discoverCopilotSdkModels(host, undefined, undefined, true), /runtime is not available in this VS Code installation/);
  assert.equal(state.constructed, 0);
});

test("disposal while async bootstrap is pending does not launch an orphan runtime", async t => {
  const { sdk, state, host } = await fixture(t);
  const entered = deferred(), release = deferred(), originalMkdir = fs.promises.mkdir;
  t.mock.method(fs.promises, "mkdir", async (...args) => {
    entered.resolve();
    await release.promise;
    return originalMkdir(...args);
  });
  const pending = sdk.discoverCopilotSdkModels(host, undefined, undefined, true);
  const rejected = assert.rejects(pending, /cancelled/);
  try {
    await promptly(entered.promise);
    await sdk.disposeCopilotSdk();
  } finally { release.resolve(); }
  await rejected;
  assert.equal(state.constructed, 0);
});

test("failed runtime startup is cleaned up and a later connection can retry", async t => {
  const { sdk, state, host } = await fixture(t);
  state.start = () => { throw new Error("fixture startup failure"); };
  await assert.rejects(sdk.discoverCopilotSdkModels(host, undefined, undefined, true), /bundled with VS Code failed to start: fixture startup failure/);
  assert.equal(state.stopped, 1);
  state.start = undefined;
  assert.equal((await sdk.discoverCopilotSdkModels(host, undefined, undefined, true))[0].id, "fixture-model");
  assert.equal(state.constructed, 2);
});

test("disposal during runtime startup stops it once and prevents catalog access", async t => {
  const { sdk, state, host } = await fixture(t);
  const entered = deferred(), release = deferred();
  state.start = async () => { entered.resolve(); await release.promise; };
  const pending = sdk.discoverCopilotSdkModels(host, undefined, undefined, true);
  const rejected = assert.rejects(pending, /cancelled/);
  try {
    await promptly(entered.promise);
    await sdk.disposeCopilotSdk();
  } finally { release.resolve(); }
  await rejected;
  assert.equal(state.stopped, 1);
  assert.equal(state.lists, 0);
});

test("cancellation interrupts pending GitHub permission access before SDK bootstrap", async () => {
  const { sdk } = adapters();
  const token = deferred(), controller = new AbortController();
  let clients = 0;
  const pending = sdk.discoverCopilotSdkModels({}, controller.signal, {
    token: () => token.promise,
    client: async () => { clients++; throw new Error("must not start"); },
  }, true);
  const rejected = assert.rejects(promptly(pending), /^Error: Request cancelled\.$/);
  controller.abort();
  await rejected;
  token.resolve("late-token");
  await tick();
  assert.equal(clients, 0);
});

test("cancellation during shared startup returns promptly and skips late model RPC", async () => {
  const { sdk } = adapters();
  const started = deferred(), entered = deferred(), controller = new AbortController();
  let lists = 0;
  const pending = sdk.discoverCopilotSdkModels({}, controller.signal, {
    token: async () => "fixture-token",
    client: () => { entered.resolve(); return started.promise; },
  }, true);
  const rejected = assert.rejects(promptly(pending), /cancelled/);
  await entered.promise;
  controller.abort();
  await rejected;
  started.resolve({ client: { rpc: { models: { list: async () => { lists++; return { models: infos }; } } } } });
  await tick();
  assert.equal(lists, 0);
});

test("cancelled RPC never updates the model cache; pre-cancelled discovery never reads it", async t => {
  const { sdk } = adapters();
  t.mock.method(console, "warn", () => {});
  const response = deferred(), entered = deferred(), controller = new AbortController();
  const deps = {
    token: async () => "fixture-token",
    client: async () => ({ client: { rpc: { models: { list: () => { entered.resolve(); return response.promise; } } } } }),
  };
  const pending = sdk.discoverCopilotSdkModels({}, controller.signal, deps);
  const rejected = assert.rejects(promptly(pending), /cancelled/);
  await entered.promise;
  controller.abort();
  await rejected;
  response.resolve({ models: infos });
  await tick();
  assert.deepEqual(await sdk.discoverCopilotSdkModels({}, undefined, { ...deps, token: async () => undefined }), [],
    "a late result from a cancelled RPC must not be served from cache");
  await sdk.discoverCopilotSdkModels({}, undefined, deps);
  let tokenReads = 0;
  await assert.rejects(sdk.discoverCopilotSdkModels({}, controller.signal, { ...deps, token: async () => { tokenReads++; } }), /cancelled/);
  assert.equal(tokenReads, 0);
});

test("passive discovery preserves consent and sanitized failures; interactive discovery reports them", async t => {
  const { sdk } = adapters();
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const deps = { token: async () => undefined, client: async () => { throw new Error("private diagnostic"); } };
  assert.deepEqual(await sdk.discoverCopilotSdkModels({}, undefined, deps), []);
  await assert.rejects(sdk.discoverCopilotSdkModels({}, undefined, deps, true), /GitHub account access/);
  const failing = { ...deps, token: async () => "token" };
  assert.deepEqual(await sdk.discoverCopilotSdkModels({}, undefined, failing), []);
  await assert.rejects(sdk.discoverCopilotSdkModels({}, undefined, failing, true),
    error => /Cannot discover Copilot SDK models/.test(error.message) && !error.message.includes("private diagnostic"));
  assert(warnings.every(message => !message.includes("private diagnostic")));
});

test("native and SDK model catalogs start concurrently and retain their actual identities", async () => {
  const { sdk, native } = adapters();
  const raw = deferred(), agent = deferred(), starts = [];
  const rawModel = { id: "raw-fixture", vendor: "copilot" };
  const agentModel = { id: "auto", vendor: "copilot-sdk" };
  sdk.discoverCopilotSdkModels = async () => { starts.push("sdk"); return agent.promise; };
  const pending = native.discoverVscodeModels({
    authentication: {},
    lm: { selectChatModels: () => { starts.push("native"); return raw.promise; } },
  });
  await tick();
  assert.deepEqual(starts.sort(), ["native", "sdk"]);
  agent.resolve([agentModel]);
  raw.resolve([{ id: "catalog-only", vendor: "copilotcli" }, rawModel]);
  assert.deepEqual(await pending, [rawModel, agentModel]);
});

test("native model discovery cancels promptly and does not invoke providers when pre-cancelled", async () => {
  const { sdk, native } = adapters();
  let calls = 0;
  const controller = new AbortController();
  sdk.discoverCopilotSdkModels = () => { calls++; return new Promise(() => {}); };
  const host = { authentication: {}, lm: { selectChatModels: () => { calls++; return new Promise(() => {}); } } };
  const pending = native.discoverVscodeModels(host, controller.signal);
  const rejected = assert.rejects(promptly(pending), /cancelled/);
  await tick();
  assert.equal(calls, 2);
  controller.abort();
  await rejected;
  await assert.rejects(native.discoverVscodeModels(host, controller.signal), /cancelled/);
  assert.equal(calls, 2);
});

test("SDK unavailability leaves real raw models usable and native permission errors stay sanitized", async () => {
  const { sdk, native } = adapters();
  const raw = { id: "raw-fixture", vendor: "copilot" };
  sdk.discoverCopilotSdkModels = async () => [];
  assert.deepEqual(await native.discoverVscodeModels({ authentication: {}, lm: { selectChatModels: async () => [raw] } }), [raw]);
  await assert.rejects(native.discoverVscodeModels({ authentication: {}, lm: { selectChatModels: () => { throw new Error("private permission diagnostic"); } } }),
    error => /permission/.test(error.message) && !error.message.includes("private permission diagnostic"));
  await assert.rejects(native.discoverVscodeModels({ lm: { selectChatModels: async () => [{ vendor: "copilotcli" }] } }), /catalog-only/);
});
