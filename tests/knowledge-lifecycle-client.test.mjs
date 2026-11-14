import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mountKnowledgeLifecycle, KNOWLEDGE_LIFECYCLE_OPERATIONS, createKnowledgeLifecycleClient,
  knowledgeMutationScanRevision, trashRestoreScanRevision } from "../browser/knowledge-lifecycle.mjs";
import { OPERATIONS, ProtocolClient } from "../browser/protocol.mjs";
import { nativeWorkspace, managerActor } from "./batch06-manager-fixtures.mjs";

const waitFor = async (read, description, timeout = 8_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
};

async function workspace(t, configure = async () => ({})) {
  return nativeWorkspace(t, async root => {
    await mkdir(join(root, "notes", ".trash"), { recursive: true });
    await mkdir(join(root, "skills", ".trash"), { recursive: true });
    await mkdir(join(root, "papers", ".trash"), { recursive: true });
    return { trash: { layoutVersion: "pkm.trash-lifecycle/v1" }, ...await configure(root) };
  });
}

async function connectClient(f, actor = managerActor) {
  const origin = await f.listen(actor);
  const protocol = new ProtocolClient({ origin, operations: { ...OPERATIONS, ...KNOWLEDGE_LIFECYCLE_OPERATIONS } });
  protocol.authenticate(f.bearer);
  await protocol.bootstrap();
  return { protocol, api: createKnowledgeLifecycleClient(protocol) };
}

function findRaw(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const found = findRaw(child, predicate);
    if (found) return found;
  }
  return null;
}

function findAll(element, predicate, result = []) {
  if (predicate(element)) result.push(element);
  for (const child of element.children) findAll(child, predicate, result);
  return result;
}

class FakeElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.parentElement = null;
    this.classList = {
      toggle: (name, force) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force ?? !values.has(name)) values.add(name); else values.delete(name);
        this.className = [...values].join(" ");
      },
    };
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return (this._text ?? "") + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) {
    for (const child of children) {
      if (!child || typeof child !== "object") continue;
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === "SELECT" && child.tagName === "OPTION" &&
          (child.selected || this.children.length === 1)) this.value = child.value;
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = "";
    this.append(...children);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type) {
    const event = { preventDefault() {}, target: this, currentTarget: this };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  click() { this.dispatch("click"); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
}

function fakeRoot() {
  const document = { createElement: tag => new FakeElement(document, tag) };
  const root = new FakeElement(document, "div");
  return root;
}

function buttonNamed(root, label) {
  return findRaw(root, element => element.tagName === "BUTTON" && element.textContent === label);
}

test("native capabilities gate the mounted surface; read-only roles get no simulated mutations", async t => {
  const f = await workspace(t);
  const { api } = await connectClient(f, { id: "native:reader", canWrite: false });
  assert.equal(api.available("noteList"), true);
  assert.equal(api.available("noteCreate"), false);
  assert.equal(api.available("trashMove"), false);
  assert.equal(Object.hasOwn(api, "call"), false);
  assert.throws(() => api.noteCreate({}), error => error.code === "CAPABILITY_UNAVAILABLE");

  const root = fakeRoot();
  const mounted = mountKnowledgeLifecycle(root, api);
  const labels = findAll(root, element => element.tagName === "BUTTON").map(button => button.textContent);
  assert(!labels.includes("Create"));
  assert(!labels.includes("Move to recoverable trash"));
  assert(!labels.includes("Restore this exact entry"));
  assert(root.textContent.includes("authenticated role"));
  mounted.dispose();
});

test("specialized writes preserve server-owned YAML and canonicalize citations; duplicate Skills conflict", async t => {
  const f = await workspace(t);
  const { api, protocol } = await connectClient(f);
  assert.equal(api.available("noteList"), true);
  assert.equal(api.available("noteCreate"), true);
  assert.equal(protocol.operations.noteList.readOnly, true);
  assert.equal(protocol.operations.noteCreate.readOnly, false);

  const note = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Unknown metadata", category: "drafts", type: "reference", description: "before",
    tags: ["original"], links: [], content: "Original body",
  });
  assert.equal(note.path, "drafts/Unknown metadata.md");
  const notePath = join(f.root, "notes", note.path);
  const before = await readFile(notePath);
  const withUnknown = before.toString("utf8").replace(/\n---\n/, "\nvendor_extension: { mode: retain }\n---\n");
  await writeFile(notePath, Buffer.from(withUnknown));
  const current = await api.documentGet({ id: note.id });
  const updated = await api.noteUpdate({
    operationId: randomUUID(), id: note.id, expectedScanRevision: await knowledgeMutationScanRevision(api),
    expectedRevision: current.revision, expectedSha256: current.sha256,
    description: "after", content: "Updated body", tags: ["changed"],
  });
  const after = await readFile(notePath);
  assert(after.toString("utf8").includes("vendor_extension: { mode: retain }"));
  assert.equal((await api.documentGet({ id: note.id })).sha256, updated.sha256);
  assert.equal((await api.documentGet({ id: note.id })).content, "Updated body");

  const source = await api.researchCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Pinned citation source", kind: "paper", category: "papers", content: "Source",
  });
  const sourceItem = (await api.researchList({ offset: 0, limit: 100 })).items.find(item => item.title === "Pinned citation source");
  assert(sourceItem?.slug, JSON.stringify(source));
  const paper = await api.researchCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Citing paper", kind: "idea", category: "papers", content: "Claim",
    cites: [{ paper: sourceItem.slug, note: "supports this claim" }],
  });
  const research = await api.researchList({ offset: 0, limit: 100 });
  assert.deepEqual(research.items.find(item => item.title === "Citing paper").cites, [
    { paper: sourceItem.slug, note: "supports this claim" },
  ]);
  const paperDocument = await api.documentGet({ id: paper.id });
  await api.researchUpdate({
    operationId: randomUUID(), id: paper.id, expectedScanRevision: await knowledgeMutationScanRevision(api),
    expectedRevision: paperDocument.revision, expectedSha256: paperDocument.sha256,
    cites: [{ paper: sourceItem.slug, note: "updated citation" }], content: "Updated claim",
  });
  const revisedPaper = (await api.researchList({ offset: 0, limit: 100 })).items.find(item => item.title === "Citing paper");
  assert.deepEqual(revisedPaper.cites, [{ paper: sourceItem.slug, note: "updated citation" }]);
  assert.equal((await api.documentGet({ id: paper.id })).content, "Updated claim");

  const duplicate = await api.skillCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    name: "One skill", category: "skills", content: "first",
  });
  assert(duplicate.id);
  const skillDocument = await api.documentGet({ id: duplicate.id });
  await api.skillUpdate({
    operationId: randomUUID(), id: duplicate.id, expectedScanRevision: await knowledgeMutationScanRevision(api),
    expectedRevision: skillDocument.revision, expectedSha256: skillDocument.sha256,
    recipe_hint: "updated hint", content: "updated skill",
  });
  assert.equal((await api.documentGet({ id: duplicate.id })).content, "updated skill");
  await assert.rejects(api.skillCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    name: "one SKILL", category: "skills", content: "duplicate",
  }), error => error.code === "CONFLICT");
});

test("paired asset reads and document/folder moves preserve exact resource bytes", async t => {
  const f = await workspace(t);
  const { api } = await connectClient(f);
  const created = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Paired", content: "body",
  });
  const bytes = Buffer.from([0, 1, 2, 0xff, 0x80, 65, 66]);
  const assetPath = join(f.root, "notes", "Paired.assets", "payload.bin");
  await mkdir(join(f.root, "notes", "Paired.assets"), { recursive: true });
  await writeFile(assetPath, bytes);
  const assets = await api.assetList({ id: created.id });
  assert.equal(assets.items.length, 1);
  assert.equal(assets.items[0].path, "Paired.assets/payload.bin");
  const chunk = await api.assetGet({
    id: created.id, path: assets.items[0].path, expectedDocumentSha256: assets.documentSha256,
    expectedDigest: assets.items[0].digest, offset: 0, length: 65_536,
  });
  assert.deepEqual(Buffer.from(chunk.data, "base64"), bytes);

  const source = await api.documentGet({ id: created.id });
  const destinationPath = "Renamed.md";
  const moveInput = {
    id: created.id, area: "notes", path: "Paired.md", destinationPath,
    expectedRevision: source.revision, expectedSha256: source.sha256,
  };
  const preview = await api.documentMovePreview(moveInput);
  await api.documentMove({
    ...moveInput, operationId: randomUUID(), expectedScanRevision: preview.scanRevision,
    expectedPairedTreeDigest: preview.pairedAssets.digest, expectedDestinationSha256: null,
    expectedDestinationTreeDigest: null,
  });
  assert.deepEqual(await readFile(join(f.root, "notes", "Renamed.assets", "payload.bin")), bytes);
  await assert.rejects(readFile(join(f.root, "notes", "Paired.assets", "payload.bin")), error => error.code === "ENOENT");

  const nested = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Inside", category: "Folder", content: "nested",
  });
  const nestedRaw = await readFile(join(f.root, "notes", nested.path));
  const folderArgs = { area: "notes", path: "Folder", destinationPath: "Moved" };
  const folderPreview = await api.folderMovePreview(folderArgs);
  await api.folderMove({
    operationId: randomUUID(), ...folderArgs, expectedSourceSha256: folderPreview.sourceSha256,
    expectedScanRevision: folderPreview.scanRevision, expectedDestinationSha256: null,
  });
  assert.deepEqual(await readFile(join(f.root, "notes", "Moved", "Inside.md")), nestedRaw);
});

test("trash refuses externally referenced trees and restore is explicitly pinned and never overwrites", async t => {
  const f = await workspace(t);
  const { api } = await connectClient(f);
  const owner = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Guarded", category: "references", content: "[asset](Guarded.assets/payload.bin)",
  });
  const assetRoot = join(f.root, "notes", "references", "Guarded.assets");
  await mkdir(assetRoot, { recursive: true });
  await writeFile(join(assetRoot, "payload.bin"), Buffer.from("guarded"));
  await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Outside", content: "[external](references/Guarded.assets/payload.bin)",
  });
  await assert.rejects(api.trashPreview({ area: "notes", path: owner.path, kind: "document" }),
    error => ["CONFLICT", "UNSUPPORTED_OPERATION"].includes(error.code));

  const source = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Recover me", content: "byte-preserved source",
  });
  const sourceFile = join(f.root, "notes", source.path);
  const sourceBytes = await readFile(sourceFile);
  const pairedDirectory = join(f.root, "notes", "Recover me.assets");
  await mkdir(pairedDirectory, { recursive: true });
  const pairedBytes = Buffer.from([0, 13, 10, 255, 17]);
  await writeFile(join(pairedDirectory, "exact.bin"), pairedBytes);
  const trashInput = { area: "notes", path: source.path, kind: "document" };
  const preview = await api.trashPreview(trashInput);
  assert(preview.documents.some(pin => pin.id === source.id && pin.path === source.path));
  const operationId = randomUUID();
  const receipt = await api.trashMove({
    operationId, ...trashInput, expectedTreeSha256: preview.treeSha256, expectedScanRevision: preview.scanRevision,
  });
  assert.equal(receipt.entryId, operationId);
  assert.deepEqual(await readFile(join(f.root, "notes", ".trash", receipt.entryId, "payload")), sourceBytes);

  await writeFile(sourceFile, Buffer.from("# competing destination\n"));
  const root = fakeRoot();
  const mounted = mountKnowledgeLifecycle(root, api);
  const entryField = findRaw(root, item => item.tagName === "INPUT" &&
    item.attributes["aria-label"] === "Committed trash entry ID (UUID)");
  assert(entryField);
  entryField.value = receipt.entryId;
  buttonNamed(root, "Restore this exact entry").click();
  await waitFor(() => root.textContent.includes("Nothing was overwritten"), "restore collision notice");
  assert.equal((await readFile(sourceFile, "utf8")), "# competing destination\n");
  mounted.dispose();
  await rm(sourceFile);
  const restored = await api.trashRestore({
    operationId: randomUUID(), entryId: receipt.entryId, expectedScanRevision: await trashRestoreScanRevision(api),
  });
  assert.equal(restored.action, "restore");
  assert.deepEqual(await readFile(sourceFile), sourceBytes);
  assert.deepEqual(await readFile(join(f.root, "notes", "Recover me.assets", "exact.bin")), pairedBytes);
});

test("stale edit exposes explicit reload/rebase and never saves until reviewed", async t => {
  const f = await workspace(t);
  const { api } = await connectClient(f);
  const created = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "Edit conflict", content: "original",
  });
  const root = fakeRoot();
  const mounted = mountKnowledgeLifecycle(root, api);
  const load = buttonNamed(root, "Load entries");
  assert(load, `${api.availableOperations().join(",")} :: ${root.textContent}`);
  load.click();
  await waitFor(() => root.textContent.includes("entries loaded"), "note list");
  const choice = findRaw(root, item => item.tagName === "BUTTON" && item.textContent.includes("Edit conflict ·"));
  assert(choice);
  choice.click();
  await waitFor(() => buttonNamed(root, "Save specialized fields"), "specialized editor");
  const content = findRaw(root, item => item.tagName === "TEXTAREA" && item.attributes["aria-label"] === "Markdown content");
  content.value = "local draft";

  const current = await api.documentGet({ id: created.id });
  await api.noteUpdate({
    operationId: randomUUID(), id: created.id, expectedScanRevision: await knowledgeMutationScanRevision(api),
    expectedRevision: current.revision, expectedSha256: current.sha256, content: "concurrent server version",
  });
  const editor = findRaw(root, item => item.tagName === "FORM" && item.children.some(child => child.textContent === "Save specialized fields"));
  assert(editor);
  editor.dispatch("submit");
  await waitFor(() => root.textContent.includes("No overwrite was made"), "source mismatch notice");
  const rebase = buttonNamed(root, "Rebase draft onto latest (review before saving)");
  assert(rebase && !rebase.hidden);
  rebase.click();
  await waitFor(() => root.textContent.includes("nothing was written"), "explicit rebase");
  assert.equal((await api.documentGet({ id: created.id })).content, "concurrent server version");
  const rebasedContent = findRaw(root, item => item.tagName === "TEXTAREA" && item.attributes["aria-label"] === "Markdown content");
  assert.equal(rebasedContent.value, "local draft");
  const save = buttonNamed(root, "Save specialized fields");
  const rebasedEditor = findRaw(root, item => item.tagName === "FORM" && item.children.some(child => child === save));
  rebasedEditor.dispatch("submit");
  await waitFor(() => root.textContent.includes("Saved by the native server"), "reviewed save");
  assert.equal((await api.documentGet({ id: created.id })).content, "local draft");
  mounted.dispose();
});

test("literal source content is rendered as text, not markup", async t => {
  const f = await workspace(t);
  const { api } = await connectClient(f);
  const created = await api.noteCreate({
    operationId: randomUUID(), expectedScanRevision: await knowledgeMutationScanRevision(api),
    title: "<img src=x>", content: "<script>not executable</script>",
  });
  const root = fakeRoot();
  const mounted = mountKnowledgeLifecycle(root, api);
  const load = buttonNamed(root, "Load entries");
  assert(load, `${api.availableOperations().join(",")} :: ${root.textContent}`);
  load.click();
  await waitFor(() => root.textContent.includes("entries loaded"), "note list");
  findRaw(root, item => item.tagName === "BUTTON" && item.textContent.includes("<img src=x> ·")).click();
  await waitFor(() => root.textContent.includes("not executable"), "literal note content");
  assert.equal(findRaw(root, item => item.tagName === "IMG" || item.tagName === "SCRIPT"), null);
  assert(root.textContent.includes(created.path));
  mounted.dispose();
});
