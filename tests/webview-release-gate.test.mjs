import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { httpCall, invocation, nativeWorkspace } from "./batch06-manager-fixtures.mjs";
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
