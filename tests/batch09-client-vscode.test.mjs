import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { nativeWorkspace, managerActor } from "./batch06-manager-fixtures.mjs";
import { knowledgeMutationScanRevision } from "../browser/knowledge-lifecycle.mjs";
import { createHumanReviewQueue } from "../dist/human-review.js";
import { createBrowserReview } from "../dist/host-composition-review.js";
import { startHttp } from "../dist/http.js";

async function loadBridge() {
  const path = resolve(import.meta.dirname, "../clients/vscode/knowledge-lifecycle.ts");
  const source = await readFile(path, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: path, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  }).outputText.replace(/from "(\.\.\/\.\.\/src\/[^"]+)"/g,
    (_match, specifier) => `from "${pathToFileURL(resolve(import.meta.dirname, "..", "dist", specifier.split("/").at(-1))).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("isolated VSCode typed host bridge invokes native HTTP, exposes CAS errors and never grants human review", async t => {
  const { KnowledgeLifecycleClient } = await loadBridge();
  const f = await nativeWorkspace(t);
  const workspaceId = JSON.parse(await readFile(resolve(f.root, ".pkm-next-workspace"), "utf8")).id;
  const db = new DatabaseSync(":memory:");
  const queue = createHumanReviewQueue({
    workspaceId, authenticateHuman: () => null, validateCurrent: () => false,
    storage: { read: callback => callback(db), transaction: callback => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = callback(db); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } },
  });
  const review = createBrowserReview({
    openSession: queue.native.openSession, closeSession: queue.native.closeSession, handlers: queue.handlers,
  }, {});
  const http = await startHttp(f.runtime.core, f.bearer, managerActor, 0, review);
  const url = http.url;
  f.addCleanup(async () => {
    review.close();
    await new Promise(done => http.server.close(done));
    queue.native.shutdown();
    db.close();
  });
  assert.equal((await fetch(`${url}/v1/server_info`, {
    method: "POST", headers: { authorization: `Bearer ${f.bearer}`, "content-type": "application/json" }, body: "{}",
  })).status, 200);
  const visible = [], transport = [];
  const host = {
    secrets: { get: async key => key === "isolated.lifecycle.bearer" ? f.bearer : undefined },
    attestServer: async (origin, info) => {
      assert.equal(origin, url);
      return { serverId: info.serverId, workspaceId: info.workspaceId, actorId: info.actorId, protocolVersion: info.protocolVersion };
    },
    fetch: async (request, options) => {
      transport.push({ url: request, body: JSON.parse(options.body), authorization: options.headers.authorization });
      return fetch(request, options);
    },
    onState: state => visible.push({ ...state }),
  };
  const bridge = new KnowledgeLifecycleClient(host, {
    origin: url, secretKey: "isolated.lifecycle.bearer", expectedWorkspaceId: workspaceId,
  });
  t.after(() => bridge.dispose());
  assert.equal((await bridge.connect()).status, "connected");
  assert.equal(bridge.available("noteCreate"), true);
  assert.equal(Object.hasOwn(bridge, "call"), false);
  const scanApi = { available: key => key === "documentList", documentList: args => bridge.documentList(args) };
  const scan = () => knowledgeMutationScanRevision(scanApi);
  const created = await bridge.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await scan(), title: "VSCode synthetic", content: "Original",
  });
  const pinned = await bridge.documentGet({ id: created.id });
  await bridge.noteUpdate({
    operationId: randomUUID(), id: created.id, expectedScanRevision: await scan(),
    expectedRevision: pinned.revision, expectedSha256: pinned.sha256, content: "Concurrent version",
  });
  await assert.rejects(bridge.noteUpdate({
    operationId: randomUUID(), id: created.id, expectedScanRevision: await scan(),
    expectedRevision: pinned.revision, expectedSha256: pinned.sha256, content: "Must not overwrite",
  }), error => error.code === "CONFLICT" && error.effect === "not-committed");
  assert.equal(visible.at(-1).code, "CONFLICT", "host-visible bridge state preserves actionable native CAS error");
  assert.equal((await bridge.documentGet({ id: created.id })).content, "Concurrent version");
  assert(transport.some(item => item.url === `${url}/v1/capability_call` && item.body.operation === "knowledge.note.create"));
  assert(transport.every(item => item.authorization === `Bearer ${f.bearer}` && item.url.startsWith(`${url}/v1/`)));
  assert(!JSON.stringify(visible).includes(f.bearer));
  assert(visible.every(state => !state.capabilities.some(key => /human|approve|acceptance/i.test(key))));
  for (const endpoint of ["read", "decide", "session"]) {
    const denied = await fetch(`${url}/human-review/${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${f.bearer}`, origin: url, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 403, "actual native human-review route refuses machine bearer");
    assert.equal(denied.headers.get("set-cookie"), null, "machine bearer cannot enroll a human session");
  }
  bridge.disconnect();
  assert.equal(bridge.state().capabilities.length, 0);
  await assert.rejects(bridge.documentGet({ id: created.id }), error => error.code === "NOT_CONNECTED");
});

test("isolated VSCode bridge enforces native read-only discovery and workspace attestation", async t => {
  const { KnowledgeLifecycleClient } = await loadBridge();
  const f = await nativeWorkspace(t);
  const url = await f.listen({ id: "native:vscode-reader", canWrite: false });
  const workspaceId = JSON.parse(await readFile(resolve(f.root, ".pkm-next-workspace"), "utf8")).id;
  const states = [];
  const host = {
    secrets: { get: async () => f.bearer },
    attestServer: async (_origin, info) => ({
      serverId: info.serverId, workspaceId: info.workspaceId, actorId: info.actorId, protocolVersion: info.protocolVersion,
    }),
    onState: state => states.push(state),
  };
  const bridge = new KnowledgeLifecycleClient(host, { origin: url, secretKey: "fixture", expectedWorkspaceId: workspaceId });
  t.after(() => bridge.dispose());
  await bridge.connect();
  assert.equal(bridge.available("noteList"), true);
  assert.equal(bridge.available("noteCreate"), false);
  await assert.rejects(bridge.noteCreate({}), error => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal((await bridge.noteList({})).items.length, 0);
  const wrong = new KnowledgeLifecycleClient(host, {
    origin: url, secretKey: "fixture", expectedWorkspaceId: "different-isolated-workspace",
  });
  t.after(() => wrong.dispose());
  await assert.rejects(wrong.connect(), error => error.code === "WORKSPACE_BINDING_MISMATCH");
  assert.equal(states.at(-1).status, "error");
  assert.equal(states.at(-1).code, "WORKSPACE_BINDING_MISMATCH");
});
