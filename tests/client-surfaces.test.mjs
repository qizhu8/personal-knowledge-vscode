import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { startHttp } from "../dist/http.js";
import { ProtocolClient } from "../browser/protocol.mjs";
import {
  WORKFLOW_SURFACE_INPUT_FIELDS, WORKFLOW_SURFACE_OPERATIONS, createWorkflowSurfaceClient, mountWorkflowSurfaces,
} from "../browser/workflow-surfaces.mjs";

const actor = { id: "local:surface-reviewer", canWrite: true, collaborationKind: "human" };
const digest = value => createHash("sha256").update(value).digest("hex");
const op = (operation, args) => ({ operation, version: 1, arguments: args });
async function fixture(t) {
  const directory = resolve("tests", `.client-surfaces-${randomUUID()}`);
  const token = "surface-test-token-".padEnd(48, "x");
  await initialize(directory);
  const storage = await Storage.open(directory);
  const core = new Core(storage);
  const http = await startHttp(core, token, actor, 0);
  t.after(async () => {
    await new Promise(resolveClose => http.server.close(resolveClose));
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const protocol = new ProtocolClient({ origin: http.url, operations: WORKFLOW_SURFACE_OPERATIONS });
  protocol.authenticate(token);
  await protocol.bootstrap();
  const client = createWorkflowSurfaceClient(protocol);
  const dispatch = async (method, operation, args) => {
    const result = await core.dispatch(method, op(operation, args), actor);
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result;
  };
  const createDocument = async (id, content = "---\nunknown: keep-me\n---\n<script>unsafe()</script>\n") =>
    dispatch("capability_call", "knowledge.document.create", {
      operationId: randomUUID(), id, area: "notes", path: `${id}.md`, title: id, content,
    });
  return { directory, storage, core, http, protocol, client, dispatch, createDocument, token };
}
function findButtons(root) {
  const labels = [];
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (node.tagName === "BUTTON") labels.push(node.textContent);
    queue.push(...node.children);
  }
  return labels;
}

class MiniElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.files = [];
    this.textValue = "";
  }
  set textContent(value) {
    this.replaceChildren();
    this.textValue = String(value);
  }
  get textContent() { return this.textValue + this.children.map(child => child.textContent).join(""); }
  append(...elements) {
    for (const element of elements) {
      element.parentElement?.removeChild(element);
      element.parentElement = this;
      this.children.push(element);
    }
  }
  replaceChildren(...elements) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.textValue = "";
    if (elements.length) this.append(...elements);
  }
  removeChild(element) {
    const index = this.children.indexOf(element);
    if (index >= 0) this.children.splice(index, 1);
    element.parentElement = null;
  }
  remove() { this.parentElement?.removeChild(this); }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback); this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  click() { for (const callback of this.listeners.get("click") ?? []) callback({ target: this }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) {
    let current = this;
    while (current) {
      if (selector.startsWith(".") && current.className.split(/\s+/).includes(selector.slice(1))) return current;
      current = current.parentElement;
    }
    return null;
  }
  querySelector(selector) {
    const matches = el => selector.startsWith(".")
      ? el.className.split(/\s+/).includes(selector.slice(1))
      : selector.startsWith("[role=")
        ? el.getAttribute("role") === selector.slice(6, -1).replaceAll('"', "")
        : selector.startsWith("[data-")
          ? el.getAttribute(selector.slice(1, -1).split("=")[0]) !== null
          : false;
    const visit = parent => {
      for (const child of parent.children) {
        if (matches(child)) return child;
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this);
  }
}

class MiniDocument {
  createElement(tagName) { return new MiniElement(tagName, this); }
}

function find(root, predicate) {
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (predicate(node)) return node;
    queue.push(...node.children);
  }
  return undefined;
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}

test("surface operation table matches the live catalog and unavailable Action controls stay absent", async t => {
  const f = await fixture(t);
  for (const [key, expected] of Object.entries(WORKFLOW_SURFACE_OPERATIONS)) {
    if (!f.client.available(key)) {
      await assert.rejects(f.protocol.request("capabilities_describe", { operation: expected.operation }),
        error => ["NOT_FOUND", "NOT_AVAILABLE"].includes(error.code));
      continue;
    }
    const described = await f.protocol.request("capabilities_describe", { operation: expected.operation });
    assert.equal(described.operation, expected.operation, key);
    assert.equal(described.readOnly, expected.readOnly, key);
    assert.equal(described.version, 1, key);
    assert.equal(typeof described.inputSchema, "object", key);
    assert.deepEqual(Object.keys(described.inputSchema.properties ?? {}).sort(),
      [...WORKFLOW_SURFACE_INPUT_FIELDS[key]].sort(), `${key} input schema fields changed`);
  }
  assert.equal(f.client.available("actionGet"), false, "native Action runtime was not configured");
  assert.equal(f.client.available("workflowGet"), true);

  const root = new MiniElement("div", new MiniDocument());
  mountWorkflowSurfaces(root, { client: f.client });
  await waitFor(() => root.querySelector(".workflow-surfaces"), "surface root did not mount");
  assert.equal(find(root, node => node.tagName === "INPUT" && node.getAttribute("aria-label") === "Action run ID"), undefined);
  assert.equal(find(root, node => node.tagName === "BUTTON" && node.textContent === "Load Action status and events"), undefined);
});

test("knowledge editor uses literal text and CAS conflict preserves draft without overwriting server", async t => {
  const f = await fixture(t);
  let initial = await f.createDocument("surface-note");
  await f.client.metadataUpdate({
    operationId: randomUUID(), id: initial.id, expectedRevision: initial.revision, expectedSha256: initial.sha256,
    set: { preservedUnknownField: { source: "fixture" } }, remove: [],
  });
  const afterMetadata = await f.client.knowledgeGet({ id: initial.id });
  assert.equal(afterMetadata.content, initial.content, "metadata patch preserves the Markdown body");
  assert.deepEqual((await f.client.metadataGet({ id: initial.id })).metadata.preservedUnknownField, { source: "fixture" });
  initial = afterMetadata;
  const firstView = createWorkflowSurfaceClient(f.protocol);
  const secondProtocol = new ProtocolClient({ origin: f.http.url, operations: WORKFLOW_SURFACE_OPERATIONS });
  secondProtocol.authenticate(f.token);
  await secondProtocol.bootstrap();
  const secondView = createWorkflowSurfaceClient(secondProtocol);

  const root = new MiniElement("div", new MiniDocument());
  const mounted = mountWorkflowSurfaces(root, { client: firstView });
  await waitFor(() => mounted.state().documentId === initial.id, "document was not loaded");
  const editor = find(root, node => node.tagName === "TEXTAREA" &&
    node.getAttribute("aria-label") === "Markdown source (literal text; no HTML preview)");
  assert.ok(editor);
  assert.match(editor.value, /<script>unsafe\(\)<\/script>/);
  assert.equal(find(root, node => node.tagName === "SCRIPT"), undefined);

  const changed = await secondView.knowledgeUpdate({
    operationId: randomUUID(), id: initial.id, expectedRevision: initial.revision, expectedSha256: initial.sha256,
    title: "Server version", content: "Server kept this literal <img src=x onerror=alert(1)>",
  });
  editor.value = "Local draft <script>alert('x')</script>";
  const save = find(root, node => node.tagName === "BUTTON" && node.textContent === "Save document");
  assert.ok(save, `buttons: ${findButtons(root).join(" | ")}`);
  save.click();
  await waitFor(() => root.querySelector(".surface-conflict"), "CAS conflict was not shown");
  assert.equal((await firstView.knowledgeGet({ id: initial.id })).content, changed.content);
  const conflict = root.querySelector(".surface-conflict");
  assert.match(conflict.textContent, /no draft was written/i);
  assert.match(conflict.textContent, /Server kept this literal/);
  assert.match(conflict.textContent, /Local draft/);
  assert.equal(find(root, node => node.tagName === "IMG"), undefined);
  mounted.dispose();
});

test("upload resumes from actor-owned durable progress and validates digest before commit", async t => {
  const f = await fixture(t);
  const doc = await f.createDocument("surface-upload");
  const bytes = new Uint8Array(70_003);
  bytes.forEach((_, index) => { bytes[index] = index % 251; });
  const expectedDigest = `sha256:${digest(bytes)}`;
  const started = await f.client.uploadBegin({
    operationId: randomUUID(), id: doc.id, expectedRevision: doc.revision, expectedSha256: doc.sha256,
    name: "resume-diagram.bin", size: bytes.length, digest: expectedDigest,
  });
  const partial = await f.client.uploadAppend({
    operationId: randomUUID(), uploadId: started.uploadId, offset: 0,
    data: Buffer.from(bytes.subarray(0, 65_536)).toString("base64"),
  });
  assert.equal(partial.receivedBytes, 65_536);

  const reconnection = new ProtocolClient({ origin: f.http.url, operations: WORKFLOW_SURFACE_OPERATIONS });
  reconnection.authenticate(f.token);
  await reconnection.bootstrap();
  const client = createWorkflowSurfaceClient(reconnection);
  const root = new MiniElement("div", new MiniDocument());
  const mounted = mountWorkflowSurfaces(root, { client });
  await waitFor(() => mounted.state().documentId === doc.id, "upload document was not loaded");
  await waitFor(() => find(root, node => node.tagName === "INPUT" && node.type === "file"), "file chooser was not mounted");
  const fileInput = find(root, node => node.tagName === "INPUT" && node.type === "file");
  assert.ok(fileInput);
  fileInput.files = [{
    name: "resume-diagram.bin",
    size: bytes.length,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  }];
  const resume = find(root, node => node.tagName === "BUTTON" && node.textContent === "Resume matching active upload");
  resume.click();
  await waitFor(async () => {
    const assets = await client.assetList({ id: doc.id });
    return assets.items?.some(item => item.digest === expectedDigest);
  }, "resumed upload did not commit the matching bytes");
  assert.equal((await client.uploadGet({ uploadId: started.uploadId })).status, "committed");
  mounted.dispose();
});

test("Todo Board list, claim focus and delegated acceptance remain server-authoritative", async t => {
  const f = await fixture(t);
  const boardSlug = `surface-${randomUUID().replaceAll("-", "")}`;
  await f.dispatch("capability_call", "todo.board.create", { operationId: randomUUID(), board_slug: boardSlug });
  let board = await f.client.todoBoard({ board_slug: boardSlug });
  const addTask = (id, title) => f.dispatch("capability_call", "todo.workitem.create", {
    operationId: randomUUID(), board_slug: boardSlug, expected_digest: board.digest,
    item: { id, title, goal: "Complete a bounded test", scope: "Isolated fixture", acceptance: ["Evidence exists"] },
  });
  await addTask("focus-one", "Current focus");
  board = await f.client.todoBoard({ board_slug: boardSlug });
  await addTask("focus-two", "Next task");
  board = await f.client.todoBoard({ board_slug: boardSlug });
  const first = await f.client.todoClaim({
    operationId: randomUUID(), board_slug: boardSlug, id: "focus-one", expected_digest: board.digest,
  });
  assert.equal(first.item.state, "WIP");
  board = await f.client.todoBoard({ board_slug: boardSlug });
  const listed = await f.client.todoBoards({ offset: 0, limit: 50 });
  assert.ok(listed.items.some(item => (item.board_slug ?? item.slug) === boardSlug));

  const root = new MiniElement("div", new MiniDocument());
  const mounted = mountWorkflowSurfaces(root, { client: f.client });
  await waitFor(() => find(root, node => node.tagName === "BUTTON" && node.textContent.includes(boardSlug)),
    "Todo Board list did not render");
  find(root, node => node.tagName === "BUTTON" && node.textContent.includes(boardSlug)).click();
  await waitFor(() => find(root, node => node.tagName === "BUTTON" && node.textContent.includes("Next task")),
    "Board tasks did not render");
  find(root, node => node.tagName === "BUTTON" && node.textContent.includes("Next task")).click();
  await waitFor(() => find(root, node => node.tagName === "BUTTON" &&
    node.textContent.startsWith("Claim task (authenticated Agent")), "claim control did not render for the unassigned task");
  find(root, node => node.tagName === "BUTTON" && node.textContent.startsWith("Claim task (authenticated Agent")).click();
  const todoPanel = find(root, node => node.tagName === "SECTION" && node.dataset.surface === "todo");
  await waitFor(() => todoPanel.querySelector(".surface-status")?.textContent.includes("WORKITEM_FOCUS_CONFLICT"),
    "focus conflict was not shown in the Todo surface");
  const stillFocused = await f.client.todoItem({ board_slug: boardSlug, id: "focus-one" });
  assert.equal(stillFocused.item.state, "WIP", "conflict did not switch or release the active task");
  mounted.dispose();

  board = await f.client.todoBoard({ board_slug: boardSlug });
  await f.dispatch("capability_call", "todo.workitem.submit", {
    operationId: randomUUID(), board_slug: boardSlug, id: "focus-one", expected_digest: board.digest,
    outcome: "Success", evidence: ["Fixture completed"],
  });
  const reviewerRoot = new MiniElement("div", new MiniDocument());
  const reviewerView = mountWorkflowSurfaces(reviewerRoot, { client: f.client });
  await waitFor(() => find(reviewerRoot, node => node.tagName === "BUTTON" && node.textContent.includes(boardSlug)),
    "Todo Board list did not render for acceptance");
  find(reviewerRoot, node => node.tagName === "BUTTON" && node.textContent.includes(boardSlug)).click();
  await waitFor(() => find(reviewerRoot, node => node.tagName === "BUTTON" && node.textContent.includes("Current focus")),
    "completed task did not render");
  find(reviewerRoot, node => node.tagName === "BUTTON" && node.textContent.includes("Current focus")).click();
  await waitFor(() => find(reviewerRoot, node => node.tagName === "BUTTON" &&
    node.textContent.startsWith("Accept completed task")), "accept control did not render for completed work");
  const reason = find(reviewerRoot, node => node.tagName === "INPUT" &&
    node.getAttribute("aria-label") === "Reviewer reason for accept");
  reason.value = "Attempt without delegated reviewer authority";
  find(reviewerRoot, node => node.tagName === "BUTTON" && node.textContent.startsWith("Accept completed task")).click();
  const reviewerPanel = find(reviewerRoot, node => node.tagName === "SECTION" && node.dataset.surface === "todo");
  await waitFor(() => reviewerPanel.querySelector(".surface-status")?.textContent.includes("delegated reviewer"),
    "server authority block was not explained");
  assert.equal((await f.client.todoItem({ board_slug: boardSlug, id: "focus-one" })).item.acceptanceDecision, undefined);
  reviewerView.dispose();
});

test("workflow cancellation is version-gated and concurrent stale cancellation cannot win twice", async t => {
  const f = await fixture(t);
  const source = { kind: "inline", definition: {
    schema: "pkm.workflow.definition/v1",
    spec: { inputs: {}, outputs: {}, nodes: [{
      nodeId: "noop", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
    }], completion: { requiredNodes: ["noop"] } },
  } };
  const compiled = await f.dispatch("capability_read", "workflow.definition.compile", { source });
  assert.equal(compiled.status, "valid");
  const createRun = () => f.dispatch("capability_call", "workflow.run.create", {
    operationId: randomUUID(), runId: `surfaceRun${randomUUID().replaceAll("-", "")}`,
    source, expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 60_000,
  });
  const uiRun = await createRun();
  const uiRoot = new MiniElement("div", new MiniDocument());
  const ui = mountWorkflowSurfaces(uiRoot, { client: f.client, confirm: () => true });
  const runInput = find(uiRoot, node => node.tagName === "INPUT" && node.getAttribute("aria-label") === "Workflow run ID");
  runInput.value = uiRun.runId;
  find(uiRoot, node => node.tagName === "BUTTON" && node.textContent === "Load workflow status and events").click();
  await waitFor(() => find(uiRoot, node => node.tagName === "BUTTON" && node.textContent === "Cancel workflow run"),
    "available workflow cancel action was not rendered");
  find(uiRoot, node => node.tagName === "BUTTON" && node.textContent === "Cancel workflow run").click();
  const workflowPanel = find(uiRoot, node => node.tagName === "SECTION" && node.dataset.surface === "workflow");
  await waitFor(() => workflowPanel.querySelector(".surface-status")?.textContent.includes("cancelled"),
    "workflow cancel did not refresh its status");
  ui.dispose();

  const created = await createRun();
  const inspected = await f.client.workflowGet({ runId: created.runId });
  const events = await f.client.workflowEvents({ runId: created.runId, expectedVersion: inspected.version, after: 0, limit: 100 });
  assert.ok(events.items.some(item => item.kind === "created"));
  const firstCancel = { operationId: randomUUID(), runId: created.runId, expectedVersion: inspected.version };
  const secondCancel = { operationId: randomUUID(), runId: created.runId, expectedVersion: inspected.version };
  const outcomes = await Promise.all([
    f.client.workflowCancel(firstCancel),
    f.client.workflowCancel(secondCancel).then(value => value, error => error),
  ]);
  assert.equal(outcomes.filter(item => item?.state === "cancelled").length, 1);
  assert.equal(outcomes.filter(item => item?.code === "CONFLICT").length, 1);
});

test("protocol refuses an HTTP write to a read-only operation and local shapes reject extra fields", async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.protocol.request("capability_call", op("knowledge.document.list", {}), undefined, true),
    error => ["ACCESS_DENIED", "INVALID_ARGUMENT"].includes(error.code),
  );
  await assert.rejects(f.client.knowledgeUpdate({
    operationId: randomUUID(), id: "safe-id", expectedRevision: 1, expectedSha256: "a".repeat(64),
    title: "Title", content: "Body", arbitraryOperation: "knowledge.document.trash",
  }), error => error instanceof TypeError && error.message === "INVALID_ARGUMENT");
});
