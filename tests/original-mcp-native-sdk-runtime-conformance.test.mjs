import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { chmod, mkdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Module from "node:module";

const require = createRequire(import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const build = await require("esbuild").build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-sdk-control.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const compiled = new Module(resolve("tests/.sdk-control-memory.cjs"));
compiled.filename = compiled.id; compiled.paths = Module._nodeModulePaths(resolve("."));
compiled._compile(build.outputFiles[0].text, compiled.filename);

if (!process.argv.includes("--sdk-conformance-child")) test("actual public SDK startup and bounded local TLS forwarding conformance; no model/runtime qualification", {
  timeout: 150000,
  skip: process.env.PKM_TEST_ISOLATED_NETWORK !== "1" ? "requires existing network-isolated fixture" : false,
}, async t => {
  const directory = join(".migration-test-work", `sdk-conformance-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const absolute = await realpath(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(absolute, "profile"), { mode: 0o700 });
  const cert = join(absolute, "profile/cert.pem"), key = join(absolute, "profile/key.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
  { encoding: "utf8", timeout: 10000 });
  assert.equal(generated.status, 0, "Private synthetic TLS certificate generation failed.");
  await chmod(cert, 0o600); await chmod(key, 0o600);
  const setup = `import ctypes, fcntl, os, socket, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
def checked(result):
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
uid, gid = os.getuid(), os.getgid()
checked(libc.unshare(0x10000000 | 0x40000000 | 0x20000000 | 0x00020000))
with open("/proc/self/uid_map", "w") as stream:
    stream.write(f"{uid} {uid} 1\\n")
with open("/proc/self/setgroups", "w") as stream:
    stream.write("deny\\n")
with open("/proc/self/gid_map", "w") as stream:
    stream.write(f"{gid} {gid} 1\\n")
checked(libc.mount(None, b"/", None, 0x4000 | 0x40000, None))
for path in [os.path.realpath("node_modules"), os.path.realpath("clients/vscode-host/original-mcp-native-sdk-supervisor.py")]:
    checked(libc.mount(os.fsencode(path), os.fsencode(path), None, 0x1000, None))
    checked(libc.mount(None, os.fsencode(path), None, 0x1000 | 0x20 | 1, None))
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
    current = fcntl.ioctl(control, 0x8913, struct.pack("16sH14s", b"lo", 0, b""))
    flags = struct.unpack_from("H", current, 16)[0]
    fcntl.ioctl(control, 0x8914, struct.pack("16sH14s", b"lo", flags | 1, b""))
child = os.fork()
if child == 0:
    checked(libc.prctl(1, 9, 0, 0, 0))
    checked(libc.mount(b"proc", b"/proc", b"proc", 0, None))
    os.execvp(sys.argv[1], sys.argv[1:])
_, status = os.waitpid(child, 0)
raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 125)
`;
  const child = spawnSync("python3", ["-I", "-B", "-c", setup,
    process.execPath, fileURLToPath(import.meta.url), "--sdk-conformance-child", absolute], {
    env: {
      PATH: process.env.PATH, HOME: absolute, USER: String(process.getuid()), LOGNAME: String(process.getuid()),
      LANG: "C.UTF-8", PKM_TEST_ISOLATED_NETWORK: "1",
      PKM_SDK_PARENT_NETNS: process.env.PKM_SDK_PARENT_NETNS || "net:[outside-private-fixture]",
      NODE_EXTRA_CA_CERTS: cert,
    },
    encoding: "utf8", timeout: 135000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, "Bounded actual SDK conformance child failed or timed out.");
  assert.equal(child.status, 0, child.stderr);
  const observations = JSON.parse(child.stdout.trim().split("\n").findLast(line => line.startsWith('{"sdkConformance"')));
  console.log(`SDK_CONFORMANCE ${JSON.stringify(observations.sdkConformance)}`);
  assert.equal(observations.sdkConformance.qualified, false);
  assert.equal(observations.sdkConformance.factoryStatus, "unsupported");
  assert.equal(observations.sdkConformance.startup.registered, true);
  assert(observations.sdkConformance.http.handlerContexts.length > 0);
  assert.equal(observations.sdkConformance.http.beforeApprovalRequests, 0);
  assert(observations.sdkConformance.http.afterApprovalRequests > 0);
  assert.equal(observations.sdkConformance.websocket.observed, true);
  assert.equal(observations.sdkConformance.http.settledPrompts, 2);
  assert.equal(observations.sdkConformance.websocket.settledPrompts, 2);
  assert.equal(observations.sdkConformance.websocket.distinctSendingInvocations, 2);
  assert.equal(observations.sdkConformance.http.requestsBeforeSecondApproval, 1);
  assert.equal(observations.sdkConformance.websocket.messagesBeforeSecondApproval, 1);
  assert.equal(observations.sdkConformance.egressAfterClose.drained, true);
  assert.equal(observations.sdkConformance.processesGoneAfterClose, true);
  assert.notEqual(observations.sdkConformance.egress.hostNetworkNamespace, observations.sdkConformance.egress.isolatedNetworkNamespace);
  assert.equal(observations.sdkConformance.egress.blockedProbes.hostLoopback, 101);
  assert.equal(observations.sdkConformance.egress.blockedProbes.externalTestNet, 101);
  assert.equal(observations.sdkConformance.egress.blockedProbes.unixProxy, 1);
  assert.equal(observations.sdkConformance.enforcedFactoryStatus, "awaited-host-forwarding-supported");
  assert.equal(observations.sdkConformance.catalogueControl.modelSendingHooks, 0);
  assert.equal(observations.sdkConformance.catalogueControl.officialCatalogueQualified, false);
  assert.deepEqual(observations.sdkConformance.selectorProbes.map(probe => probe.selector),
    ["auto", "pkm-deliberately-nonexistent-model-selector"]);
  for (const probe of observations.sdkConformance.selectorProbes) {
    assert.equal(probe.modelSendingHooks, 0);
    assert.equal(probe.leaseDrained, true);
    assert.equal(probe.outcome, "session-snapshot-observed-not-availability", JSON.stringify(probe));
    assert.equal(probe.cachedModelId, probe.selector);
    assert.equal(probe.currentModelId, probe.selector);
  }
  assert.deepEqual(observations.sdkConformance.egressAfterClose.runtimeChildren, []);
  assert(observations.sdkConformance.egress.runtimeChildren.every(child =>
    child.noNewPrivs && child.seccomp && child.noEffectiveCapabilities));
  assert.equal(observations.sdkConformance.websocket.beforeApprovalConnections, 0);
  assert.equal(observations.sdkConformance.websocket.beforeMessageApprovalMessages, 0);
  assert(observations.sdkConformance.websocket.afterMessageApprovalMessages > 0);
  const message = observations.sdkConformance.websocket.messageContexts[0];
  assert.deepEqual(observations.sdkConformance.websocket.connectionContexts[0], {
    requestId: message.requestId, sessionId: message.sessionId,
    agentInvocationId: message.agentInvocationId, transport: message.transport,
  });
});

if (process.argv.includes("--sdk-conformance-child")) {
  const absolute = process.argv.at(-1), sdk = require("@github/copilot-sdk");
  const moduleFile = await realpath(require.resolve("@github/copilot-sdk"));
  const moduleManifest = resolve("node_modules/@github/copilot-sdk/package.json");
  const runtimeManifest = resolve("node_modules/@github/copilot-sdk-linux-x64/package.json");
  const runtimeFile = resolve("node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime");
  const runtime = await stat(runtimeFile, { bigint: true });
  const mountRoot = await realpath("node_modules");
  assert(mountRoot.startsWith(resolve(".")), "Fixture SDK dependencies must be in the checkout.");
  const profile = join(absolute, "profile");
  const folders = Object.fromEntries(["home", "data", "work", "config", "cache", "state", "scratch"].map(name => [name, join(profile, name)]));
  for (const folder of Object.values(folders)) await mkdir(folder, { mode: 0o700 });
  const clientOptions = {
    connection: sdk.RuntimeConnection.forStdio({ path: runtimeFile }),
    mode: "empty", useLoggedInUser: false, baseDirectory: folders.data, workingDirectory: folders.work, logLevel: "error",
    env: { PATH: process.env.PATH, HOME: folders.home, USER: String(process.getuid()), LOGNAME: String(process.getuid()),
      LANG: "C.UTF-8", XDG_CONFIG_HOME: folders.config, XDG_CACHE_HOME: folders.cache, XDG_DATA_HOME: folders.data,
      XDG_STATE_HOME: folders.state, TMPDIR: folders.scratch, NODE_EXTRA_CA_CERTS: join(profile, "cert.pem") },
  };
  const selection = {
    moduleFile, moduleSha256: hash(await readFile(moduleFile)), moduleManifest,
    manifestSha256: hash(await readFile(moduleManifest)), runtimeFile, runtimeManifest,
    runtimeManifestSha256: hash(await readFile(runtimeManifest)),
    runtimeIdentity: Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(runtime[key])])),
  };
  const factoryOptions = {
    sdk, selection, profileRoot: profile, clientOptions, host: {}, retained: {},
    epoch: randomUUID(), hostReceiptSha256: "a".repeat(64), sourcePlanSha256: "b".repeat(64),
    assertCurrent() {}, async accountToken() { throw new Error("No actual account access permitted."); },
    assertDestination() {}, async approveBoundary() { throw new Error("No product sending approval permitted."); },
    signal: new AbortController().signal, fixtureProbe: { parentNetworkNamespace: process.env.PKM_SDK_PARENT_NETNS },
  };
  const factory = await compiled.exports.createOriginalMcpNativeSdkHostControl(factoryOptions);
  await assert.rejects(compiled.exports.verifyOriginalSdkPrivateSelection({
    sdk, selection, profileRoot: profile, fixtureProbe: true,
    clientOptions: { ...clientOptions, env: { ...clientOptions.env, GITHUB_TOKEN: "synthetic-forbidden-environment" } },
  }), /RUNTIME_INCOMPATIBLE/);
  await assert.rejects(compiled.exports.verifyOriginalSdkPrivateSelection({
    sdk, selection, profileRoot: profile, fixtureProbe: true,
    clientOptions: { ...clientOptions, env: { ...clientOptions.env, HOME: absolute } },
  }), /RUNTIME_INCOMPATIBLE/);
  await compiled.exports.verifyOriginalSdkPrivateSelection({ sdk, selection, profileRoot: profile, fixtureProbe: true, clientOptions });
  assert.equal(factory.status, "unsupported");
  assert.throws(() => factory.control.runtimeAdmission.assertCurrent(sdk, {}, clientOptions), /RUNTIME_INCOMPATIBLE/);
  assert.throws(() => compiled.exports.assertOriginalSdkOwnedHostControl({
    ...factory.control, runtimeAdmission: { assertCurrent() {} },
  }), /RUNTIME_INCOMPATIBLE/);
  const supervisor = resolve("clients/vscode-host/original-mcp-native-sdk-supervisor.py");
  const childClosers = new Set();
  const enforced = await compiled.exports.createOriginalMcpNativeSdkHostControl({
    ...factoryOptions,
    clientOptions: { ...clientOptions, env: Object.fromEntries(Object.entries(clientOptions.env).filter(([key]) => key !== "NODE_EXTRA_CA_CERTS")) },
    egress: { python: await realpath("/usr/bin/python3"), supervisor, supervisorSha256: hash(await readFile(supervisor)),
      registerChild(close) { childClosers.add(close); return () => childClosers.delete(close); } },
  });
  let catalogueHooks = 0;
  const catalogueControl = { method: "client.rpc.models.list", modelSendingHooks: 0,
    officialCatalogueQualified: false, outcome: "not-observed",
    reason: enforced.catalogueReason.code };
  class CatalogueHandler extends sdk.CopilotRequestHandler {
    async sendRequest() { catalogueHooks++; throw new Error("Catalogue probe cannot send model requests."); }
    async openWebSocket() { catalogueHooks++; throw new Error("Catalogue probe cannot send model requests."); }
  }
  const catalogueLease = await enforced.control.prepareClient();
  const catalogueClient = new sdk.CopilotClient({ ...catalogueLease.clientOptions, requestHandler: new CatalogueHandler() });
  catalogueLease.bindClient(() => catalogueClient.stop());
  try {
    await catalogueClient.start(); await catalogueLease.ready();
    let timer;
    try {
      catalogueControl.outcome = await Promise.race([
        catalogueClient.rpc.models.list({ gitHubToken: "synthetic-invalid-token-no-official-account" })
          .then(() => "control-response-not-an-official-catalogue-proof", () => "control-rejected-without-model-hook"),
        new Promise(resolve => { timer = setTimeout(() => resolve("bounded-timeout-without-model-hook"), 3000); }),
      ]);
    } finally { clearTimeout(timer); }
  } finally { try { await catalogueClient.stop(); } finally { await catalogueLease.close(); } }
  catalogueControl.modelSendingHooks = catalogueHooks;
  const selectorProbes = [];
  for (const selector of ["auto", "pkm-deliberately-nonexistent-model-selector"]) {
    const probe = { selector, phase: "startup", outcome: "not-observed", modelSendingHooks: 0, leaseDrained: false };
    selectorProbes.push(probe);
    class RejectSending extends sdk.CopilotRequestHandler {
      async sendRequest() { probe.modelSendingHooks++; throw new Error("Selector probe forbids model sending."); }
      async openWebSocket() { probe.modelSendingHooks++; throw new Error("Selector probe forbids model sending."); }
    }
    const lease = await enforced.control.prepareClient();
    const selectorClient = new sdk.CopilotClient({ ...lease.clientOptions, requestHandler: new RejectSending() });
    lease.bindClient(() => selectorClient.stop());
    const bounded = async (label, action) => {
      probe.phase = label;
      let timer;
      try {
        return await Promise.race([
          action(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded timeout")), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      await bounded("client-start", () => selectorClient.start());
      await bounded("lease-ready", () => lease.ready());
      const session = await bounded("create-session", () => selectorClient.createSession({
        model: selector, allowedModels: [selector], availableTools: [], tools: [],
        enableConfigDiscovery: false, skipCustomInstructions: true, enableSkills: false,
        enableSessionStore: false, enableHostGitOperations: false, enableFileChangeTracking: false,
        infiniteSessions: { enabled: false }, onPermissionRequest: () => ({ kind: "reject" }),
      }));
      const admission = await bounded("startup-admission", () => session.rpc.model.startupAdmission({ claimEnablement: false }));
      const current = await bounded("get-current", () => session.rpc.model.getCurrent());
      probe.cachedModelId = admission.selectedModel ?? null;
      probe.currentModelId = current.modelId ?? null;
      probe.outcome = "session-snapshot-observed-not-availability";
    } catch (error) {
      probe.outcome = "failed";
      probe.error = `${error.name}: ${String(error.message).slice(0, 256)}`;
    } finally {
      try { await selectorClient.stop(); } finally { await lease.close(); }
      probe.leaseDrained = lease.observation().drained;
    }
  }
  const launch = await enforced.control.prepareClient();
  const { WebSocketServer } = createRequire(resolve("legacy/package.json"))("ws");
  const observations = {
    qualified: false, scope: "kernel-enforced-egress-and-synthetic-transport-only",
    factoryStatus: factory.status, factoryReason: factory.reason.code,
    enforcedFactoryStatus: enforced.status, egressBoundaryQualified: true, startup: enforced.startup,
    catalogueControl, selectorProbes,
    http: { handlerContexts: [], beforeApprovalRequests: 0, afterApprovalRequests: 0, settledPrompts: 0 },
    websocket: { connectionContexts: [], messageContexts: [], beforeApprovalConnections: 0,
      beforeMessageApprovalMessages: 0, afterMessageApprovalMessages: 0, observed: false, failure: null, settledPrompts: 0,
      distinctSendingInvocations: 0 },
  };
  const owner = new AbortController();
  let httpRequests = 0, wsConnections = 0, wsMessages = 0;
  let responseSequence = 0;
  const responseEvents = () => {
    const id = `fixture_response_${responseSequence++}`, item = { id: `${id}_message`, type: "message", status: "completed",
      role: "assistant", content: [{ type: "output_text", text: "Synthetic transport conformance response only.", annotations: [] }] };
    const response = { id, object: "response", created_at: 1700000000, status: "completed", model: "gpt-4.1",
      output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0,
        delta: "Synthetic transport conformance response only." },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0,
        text: "Synthetic transport conformance response only." },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ].map((event, sequence_number) => ({ ...event, sequence_number }));
  };
  const server = createServer({ key: await readFile(join(profile, "key.pem")), cert: await readFile(join(profile, "cert.pem")) },
    (request, response) => { httpRequests++; request.resume(); request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of responseEvents()) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    }); });
  const wss = new WebSocketServer({ server });
  wss.on("connection", socket => {
    wsConnections++;
    socket.on("message", () => {
      wsMessages++;
      for (const event of responseEvents()) socket.send(JSON.stringify(event));
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const baseUrl = `https://127.0.0.1:${server.address().port}/v1`;
  const context = ctx => ({ requestId: ctx.requestId, sessionId: ctx.sessionId ?? null,
    agentInvocationId: ctx.agentInvocationId ?? null, transport: ctx.transport });
  let allowConnect;
  const httpReleases = [], messageReleases = [];
  const connectGate = new Promise(resolve => { allowConnect = resolve; });
  class Forwarder extends sdk.CopilotWebSocketForwarder {
    async sendRequestMessage(data, ctx) {
      let metadata = {};
      try { const parsed = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        metadata = { type: parsed.type ?? null, eventId: parsed.event_id ?? null, requestId: parsed.request_id ?? null };
      } catch {}
      observations.websocket.messageContexts.push({ ...context(ctx), metadata, payloadSha256: hash(Buffer.from(data)) });
      await new Promise(resolve => { messageReleases.push(resolve); });
      if (owner.signal.aborted) throw new Error("Synthetic conformance cancelled");
      super.sendRequestMessage(data, ctx);
    }
  }
  class Handler extends sdk.CopilotRequestHandler {
    async sendRequest(request, ctx) {
      observations.http.handlerContexts.push(context(ctx));
      await new Promise(resolve => { httpReleases.push(resolve); });
      if (owner.signal.aborted) throw new Error("Synthetic conformance cancelled");
      return super.sendRequest(request, ctx);
    }
    async openWebSocket(ctx) {
      observations.websocket.connectionContexts.push(context(ctx));
      await connectGate;
      if (owner.signal.aborted) throw new Error("Synthetic conformance cancelled");
      return new Forwarder(ctx);
    }
  }
  const client = new sdk.CopilotClient({ ...launch.clientOptions, requestHandler: new Handler() });
  launch.bindClient(() => client.stop());
  const sessions = [];
  const until = async (condition, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (!condition() && Date.now() < end) await sleep(20);
    return condition();
  };
  try {
    await client.start();
    await launch.ready();
    observations.egress = launch.observation();
    assert.equal((await client.rpc.llmInference.setProvider()).success, true);
    const sessionConfig = transport => ({
      model: "gpt-4.1", provider: { type: "openai", wireApi: "responses", transport, baseUrl, apiKey: "fixture-only-sdk-credential" },
      streaming: true, availableTools: [], tools: [], enableConfigDiscovery: false, skipCustomInstructions: true,
      enableSkills: false, enableSessionStore: false, enableHostGitOperations: false, enableFileChangeTracking: false,
      infiniteSessions: { enabled: false }, onPermissionRequest: () => ({ kind: "reject" }),
    });
    const http = await client.createSession(sessionConfig("http")); sessions.push(http);
    http.on(event => { if (event.type === "session.idle") observations.http.settledPrompts++; });
    await http.send({ prompt: "Synthetic local forwarding observation only. No tools, files, account or model completion." });
    assert(await until(() => observations.http.handlerContexts.length > 0), "Actual runtime HTTP callback was not observed.");
    await sleep(100); observations.http.beforeApprovalRequests = httpRequests;
    httpReleases[0]();
    assert(await until(() => httpRequests > 0), "Actual SDK HTTP forwarder did not reach the synthetic TLS endpoint.");
    observations.http.afterApprovalRequests = httpRequests;
    assert(await until(() => observations.http.settledPrompts === 1), "First synthetic HTTP prompt did not settle.");
    await http.send({ prompt: "Second fully settled synthetic HTTP transport prompt." });
    assert(await until(() => observations.http.handlerContexts.length === 2), "Second HTTP sending identity was not observed.");
    await sleep(100); observations.http.requestsBeforeSecondApproval = httpRequests;
    httpReleases[1]();
    assert(await until(() => observations.http.settledPrompts === 2), "Second synthetic HTTP prompt did not settle.");
    await http.abort(); await http.disconnect();
    const ws = await client.createSession(sessionConfig("websockets")); sessions.push(ws);
    ws.on(event => { if (event.type === "session.idle") observations.websocket.settledPrompts++; });
    await ws.send({ prompt: "Synthetic local WebSocket forwarding observation only." });
    if (await until(() => observations.websocket.connectionContexts.length > 0)) {
      await sleep(100); observations.websocket.beforeApprovalConnections = wsConnections;
      allowConnect();
      if (await until(() => observations.websocket.messageContexts.length > 0)) {
        await sleep(100); observations.websocket.beforeMessageApprovalMessages = wsMessages;
        messageReleases[0]();
        observations.websocket.observed = await until(() => wsMessages > 0);
        observations.websocket.afterMessageApprovalMessages = wsMessages;
        if (observations.websocket.observed) {
          assert(await until(() => observations.websocket.settledPrompts === 1), "First synthetic WebSocket prompt did not settle.");
          await ws.send({ prompt: "Second fully settled synthetic WebSocket transport prompt." });
          assert(await until(() => observations.websocket.messageContexts.length === 2), "Second WebSocket sending identity was not observed.");
          await sleep(100); observations.websocket.messagesBeforeSecondApproval = wsMessages;
          messageReleases[1]();
          assert(await until(() => observations.websocket.settledPrompts === 2), "Second synthetic WebSocket prompt did not settle.");
          observations.websocket.distinctSendingInvocations = new Set(observations.websocket.messageContexts.map(ctx => ctx.agentInvocationId)).size;
        }
      } else observations.websocket.failure = "No actual runtime WebSocket message callback reached the public forwarding hook.";
    } else observations.websocket.failure = "No actual runtime WebSocket connection callback was emitted for the explicitly selected transport.";
  } catch (error) {
    observations.websocket.failure ??= `${error.name}: ${String(error.message).slice(0, 256)}`;
  } finally {
    owner.abort(); httpReleases.forEach(resolve => resolve()); allowConnect(); messageReleases.forEach(resolve => resolve());
    for (const session of sessions) { await session.abort().catch(() => {}); await session.disconnect().catch(() => {}); }
    await client.stop();
    await launch.close(); await enforced.close();
    observations.egressAfterClose = launch.observation();
    if (observations.egress) {
      for (const pid of [observations.egress.supervisorPid, observations.egress.initPid,
        ...observations.egress.runtimeChildren.map(child => child.pid)])
        await assert.rejects(stat(`/proc/${pid}`), error => error.code === "ENOENT");
      observations.processesGoneAfterClose = true;
    }
    assert.equal(childClosers.size, 0);
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
  await writeFile(join(absolute, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify({ sdkConformance: observations }));
}
