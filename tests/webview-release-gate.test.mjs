import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { httpCall, invocation, nativeWorkspace } from "./batch06-manager-fixtures.mjs";
import { startBrowserHttpsListener } from "../dist/browser-https-listener.js";
import { createOriginalBrowserRoute } from "../dist/browser-original-owner.js";
import { createBrowserReleaseGate } from "../dist/browser-release-gate.js";
import { initialize } from "../dist/storage.js";
import { startSharedManagedServer } from "../dist/shared-managed-server.js";
import { sharedManagedRequest } from "../dist/shared-managed-client.js";
import { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const bundle = resolve(import.meta.dirname, "../legacy/dist/webview");
async function gate(start) {
  const prior = process.env.PKM_BROWSER_WEBVIEW_DIR;
  process.env.PKM_BROWSER_WEBVIEW_DIR = bundle;
  try { return await start(); }
  finally {
    if (prior === undefined) delete process.env.PKM_BROWSER_WEBVIEW_DIR;
    else process.env.PKM_BROWSER_WEBVIEW_DIR = prior;
  }
}

async function browserTransport(t, handler, tls) {
  let port;
  if (tls) {
    const listener = await startBrowserHttpsListener({ address: "127.0.0.1", port: 0, tls, route: handler });
    t.after(() => listener.close());
    port = listener.port;
  } else {
    const server = createServer(async (req, res) => {
      if (!await handler(req, res)) res.writeHead(404).end();
    });
    t.after(() => new Promise(ok => server.close(ok)));
    await new Promise((ok, reject) => server.once("error", reject).listen(0, "127.0.0.1", ok));
    port = server.address().port;
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    request(path, headers = {}, body) {
      return new Promise((ok, reject) => {
        const request = tls ? httpsRequest : httpRequest;
        const req = request({ host: "127.0.0.1", port, path, headers, agent: false,
          method: body === undefined ? "GET" : "POST", ...(tls && { ca: tls.cert, servername: "pkm.test" }) }, res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    },
  };
}

test("browser transport: explicit HTTPS rejects non-origin configuration", async () => {
  for (const httpsOrigin of ["", "http://pkm.test", "https://*.pkm.test", "https://pkm.test/webview/",
    "https://pkm.test/", "https://user@pkm.test", "https://pkm.test?query", "https://pkm.test#fragment"]) {
    await assert.rejects(createBrowserReleaseGate("fixture", false, { httpsOrigin }), /exact serialized HTTPS origin/);
  }
});

test("browser transport: default HTTP still requires exact loopback Host and same-origin JSON POST", async t => {
  const token = randomUUID();
  const handler = await gate(() => createBrowserReleaseGate(token, false));
  const { origin, request } = await browserTransport(t, (req, res) => handler(req, res, { accepting: () => true, dispatch: async () => {
    throw new Error("Unexpected dispatch");
  } }));
  const body = { token, remember: false };
  const type = { "content-type": "application/json" };
  assert.equal((await request("/webview/")).status, 200);
  assert.equal((await request("/webview/", { host: new URL(origin).host.replace("127.0.0.1", "localhost") })).status, 403);
  assert.equal((await request("/webview/session", type, body)).status, 403);
  assert.equal((await request("/webview/session", { ...type, origin: origin.replace("http:", "https:") }, body)).status, 403);
  assert.equal((await request("/webview/session", { ...type, origin }, body)).status, 200);
});

test("browser transport: direct HTTPS serves authenticated Original Webview and Chat without trusting proxy headers", async t => {
  const directory = join(import.meta.dirname, `.webview-tls-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=pkm.test", "-addext", "subjectAltName=DNS:pkm.test", "-keyout", key, "-out", cert], { stdio: "pipe" });
  const token = randomUUID(), origin = "https://pkm.test:8443";
  const chatId = randomUUID();
  const page = { chatId, start: 0, total: 1, nextCursor: null,
    messages: [{ id: "message", role: "assistant", content: "Existing Chat reply", status: "complete" }] };
  let authorized = true, calls = 0;
  const handler = await gate(() => createOriginalBrowserRoute({
    token,
    grant: { actorId: "fixture", workspaceRoot: directory, generation: "fixture", chatHostId: randomUUID() },
    assertCurrent() { if (!authorized) throw new Error("Grant revoked"); },
    async capabilityRead() { throw new Error("Unexpected gateway request"); },
    async readChatTranscript(_grant, input) {
      calls++;
      assert.deepEqual(input, { chatId, cursor: undefined, limit: 20 });
      return page;
    },
  }, { allowDevelopment: true, httpsOrigin: origin }));
  const { request } = await browserTransport(t, handler, { key: await readFile(key), cert: await readFile(cert) });
  const http = await browserTransport(t, handler);
  const host = new URL(origin).host, headers = { host, origin, "content-type": "application/json" };
  const forwarded = { forwarded: `proto=https;host="${host}"`, "x-forwarded-host": host, "x-forwarded-proto": "https" };
  const signIn = { token, remember: true };
  assert.equal((await request("/mcp", headers, {})).status, 404);
  assert.equal((await http.request("/webview/session", { ...headers, ...forwarded }, signIn)).status, 403);
  assert.equal((await request("/webview/", { host: "other.test", ...forwarded })).status, 403);
  assert.equal((await request("/webview/chat", { host, origin: "https://other.test" })).status, 403);
  assert.equal((await request("/webview/chat", { host })).status, 303);
  assert.equal((await request("/webview/panel.js", { host })).status, 404);
  for (const invalid of [{ origin: undefined }, { origin: "null" }, { origin: `http://${host}` },
    { origin: "https://pkm.test" }, { "content-type": "text/plain" }]) {
    const invalidHeaders = { ...headers, ...invalid };
    if (invalidHeaders.origin === undefined) delete invalidHeaders.origin;
    assert.equal((await request("/webview/session", invalidHeaders, signIn)).status, 403);
  }
  const session = await request("/webview/session", headers, signIn);
  assert.equal(session.status, 200);
  assert.match(session.headers["set-cookie"][0], /; Path=\/webview\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  const cookie = session.headers["set-cookie"][0].split(";")[0];
  assert.match((await request("/webview/", { host, cookie })).body, /id="pkm-original-browser"/);
  assert.match((await request("/webview/chat", { host, cookie })).body, /<title>PKM Chat<\/title>/);
  const message = { command: "chatMessages", id: chatId };
  assert.equal((await request("/webview/message", { ...headers, cookie, origin: "https://other.test" }, message)).status, 403);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse((await request("/webview/message", { ...headers, cookie }, message)).body), page);
  authorized = false;
  assert.equal((await request("/webview/message", { ...headers, cookie }, message)).status, 503);
  authorized = true;
  assert.equal((await request("/webview/sign-out", { ...headers, cookie }, {})).status, 200);
  assert.equal((await request("/webview/message", { ...headers, cookie }, message)).status, 401);
  assert.equal(calls, 1);
});

async function qualify(t, { url, token, root, thread, enrollment, webview = bundle }) {
  const bytes = await readFile(resolve(webview, "panel.js"));
  assert.equal((await fetch(`${url}/webview/panel.js`)).status, 404);
  const child = spawn(process.env.PYTHON || "python3", ["-B", resolve(import.meta.dirname, "webview-release-gate.py")],
    { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ url, token, bundle: webview, thread, enrollment }));
  const code = await new Promise((ok, reject) => { child.once("error", reject); child.once("close", ok); });
  assert.equal(code, 0, stderr.split("\n").filter(line => !line.includes(token) && (!enrollment || !line.includes(enrollment))).join("\n"));
  const { id, hash, query } = JSON.parse(stdout);
  assert.equal(hash, createHash("sha256").update(bytes).digest("hex"));
  const stored = await httpCall(url, token, "capability_read", invocation("knowledge.note.get", { id }));
  assert.equal(stored.status, 200);
  assert.equal(stored.body.result.item.title, "Browser-created Note");
  assert.equal(stored.body.result.item.category, "Gate/Qualification");
  assert.match(stored.body.result.item.content, new RegExp(query));
  assert.equal(stored.body.result.item.revision, 2);
  assert.match(await readFile(resolve(root, "notes", stored.body.result.item.path), "utf8"), new RegExp(query));
}

test("standalone: Chromium uses the exact Webview and edits a Note with stored CAS preconditions", { timeout: 45_000 }, async t => {
  const fixture = await nativeWorkspace(t);
  await qualify(t, { url: await gate(() => fixture.listen()), token: fixture.bearer, root: fixture.root });
});

test("shared manager loopback: exact Webview, Note CAS, persisted Chat send/stop, and separate review authority", { timeout: 180_000 }, async t => {
  const root = resolve(import.meta.dirname, `.webview-manager-${randomUUID()}`);
  const token = randomUUID() + randomUUID(), managementToken = randomUUID() + randomUUID();
  const keyName = `PKM_GATE_FIXTURE_${randomUUID().replaceAll("-", "_")}`;
  const key = randomUUID();
  process.env[keyName] = key;
  let service, starts = 0, held = 0;
  const provider = createServer(async (req, res) => {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    if (req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(403); res.end(); return;
    }
    const message = JSON.parse(bytes).messages.at(-1)?.content;
    if (message !== "Reply through the actual provider" && message !== "Hold this real turn") {
      res.writeHead(400); res.end(); return;
    }
    starts++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (content, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
    if (message === "Hold this real turn") {
      held++;
      res.write(event("Waiting on the local model", null));
    } else res.end(event("Answer from the local model", null) + event("", "stop") + "data: [DONE]\n\n");
  });
  t.after(async () => {
    await service?.close();
    provider.closeAllConnections();
    await new Promise(ok => provider.close(ok));
    delete process.env[keyName];
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(ok => provider.listen(0, "127.0.0.1", ok));
  await mkdir(root, { mode: 0o700 });
  let openManager = startSharedManagedServer, stage = stageIsolatedManagedGeneration, publish = publishIsolatedManagedGeneration;
  let initializeData = initialize, webview = bundle, launch = gate;
  if (process.env.PKM_TEST_BROWSER_VSIX) {
    const extension = join(root, "installed", "extension");
    execFileSync("unzip", ["-q", resolve(process.env.PKM_TEST_BROWSER_VSIX), "-d", join(root, "installed")]);
    const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
    assert.equal(`${manifest.publisher}.${manifest.name}`, "Uone.personal-knowledge");
    webview = join(extension, "dist/webview");
    const runtime = join(extension, "next-runtime/server");
    const load = name => import(pathToFileURL(join(runtime, name)).href);
    createRequire(import.meta.url)(join(runtime, "legacy/dist/runtime/next-payload-verifier.js")).verifyNextPayload(extension);
    ({ initialize: initializeData } = await load("dist/storage.js"));
    ({ startSharedManagedServer: openManager } = await load("dist/shared-managed-server.js"));
    ({ stageIsolatedManagedGeneration: stage, publishIsolatedManagedGeneration: publish } = await load("experimental/managed-migration.mjs"));
    const { createBrowserReleaseGate } = await load("dist/browser-release-gate.js");
    const packed = join(runtime, "browser/webview/bundle/panel.js");
    const original = await readFile(packed);
    assert.deepEqual(original, await readFile(join(webview, "panel.js")));
    await writeFile(packed, "/* tampered fixture */");
    await assert.rejects(createBrowserReleaseGate(token, true), /asset digest mismatch/);
    await writeFile(packed, original);
    launch = async start => {
      const previous = process.env.PKM_BROWSER_WEBVIEW_DIR;
      delete process.env.PKM_BROWSER_WEBVIEW_DIR;
      try { return await start(); }
      finally { if (previous !== undefined) process.env.PKM_BROWSER_WEBVIEW_DIR = previous; }
    };
  }
  const data = await initializeData(join(root, "data"), { storageLayout: "separated" });
  const managedRoot = join(root, "managed"), directory = join(data, "server-data", "runtime-control", "shared-manager");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const coreHostProfile = {
    schema: "pkm.shared-core-host/v1",
    config: { schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
      secretRef: "secret:fixture/webview-chat", model: "webview-fixture", contextWindow: 16384, maxOutputTokens: 4096,
      outputTokenParameter: "max_tokens", includeUsage: false, tools: ["knowledge.document.get"] },
    policy: { allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["webview-fixture"],
      allowedTools: ["knowledge.document.get"], allowInsecureLoopback: true },
    secretEnvironment: { "secret:fixture/webview-chat": keyName }, humanReview: "browser",
  };
  const candidate = await stage({ managedRoot, data, allowWrites: true, coreHostProfile });
  await publish(managedRoot, candidate.generation);
  service = await launch(() => openManager({ directory, managedRoot, token, managementToken, backendKind: "standalone-core" }));
  const thread = randomUUID();
  const seed = await httpCall(service.url, token, "capability_call", invocation("chat.session.create", {
    id: thread, operationId: randomUUID(), title: "Existing shared conversation", expectedRevision: 0,
  }));
  assert.equal(seed.status, 200);
  const admin = { origin: service.url, serviceId: service.serviceId, token: managementToken };
  const approved = await sharedManagedRequest(admin, "/manage/approve", { action: "human-review-enrollment" });
  const enrollment = await sharedManagedRequest(admin, "/manage/human-review-enrollment", { approvalId: approved.approvalId });
  await qualify(t, { url: service.url, token, root: data, thread, enrollment: enrollment.code, webview });
  const turns = await httpCall(service.url, token, "capability_read", invocation("chat.turn.list", { sessionId: thread }));
  assert.deepEqual(turns.body.result.items.map(item => item.status), ["completed", "cancelled"]);
  assert.equal(starts, 2);
  assert.equal(held, 1);
});
