// @ts-check

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;

export const KNOWLEDGE_LIFECYCLE_OPERATIONS = Object.freeze({
  documentList: { operation: "knowledge.document.list", readOnly: true },
  documentGet: { operation: "knowledge.document.get", readOnly: true },
  noteList: { operation: "knowledge.note.list", readOnly: true },
  noteGet: { operation: "knowledge.note.get", readOnly: true },
  noteSearch: { operation: "knowledge.note.search", readOnly: true },
  skillList: { operation: "knowledge.skill.list", readOnly: true },
  skillGet: { operation: "knowledge.skill.get", readOnly: true },
  skillSearch: { operation: "knowledge.skill.search", readOnly: true },
  researchList: { operation: "knowledge.research.list", readOnly: true },
  researchSearch: { operation: "knowledge.research.search", readOnly: true },
  noteCreate: { operation: "knowledge.note.create", readOnly: false },
  noteUpdate: { operation: "knowledge.note.update", readOnly: false },
  skillCreate: { operation: "knowledge.skill.create", readOnly: false },
  skillUpdate: { operation: "knowledge.skill.update", readOnly: false },
  researchCreate: { operation: "knowledge.research.create", readOnly: false },
  researchUpdate: { operation: "knowledge.research.update", readOnly: false },
  assetList: { operation: "knowledge.asset.list", readOnly: true },
  assetGet: { operation: "knowledge.asset.get", readOnly: true },
  assetPreview: { operation: "knowledge.asset.lifecycle.preview", readOnly: true },
  assetRename: { operation: "knowledge.asset.rename", readOnly: false },
  assetDelete: { operation: "knowledge.asset.delete", readOnly: false },
  documentMovePreview: { operation: "knowledge.document.lifecycle.preview", readOnly: true },
  documentMove: { operation: "knowledge.document.move", readOnly: false },
  folderMovePreview: { operation: "knowledge.folder.lifecycle.preview", readOnly: true },
  folderMove: { operation: "knowledge.folder.move", readOnly: false },
  trashPreview: { operation: "knowledge.trash.lifecycle.preview", readOnly: true },
  trashMove: { operation: "knowledge.trash.move", readOnly: false },
  trashRestore: { operation: "knowledge.trash.restore", readOnly: false },
});

export const KNOWLEDGE_LIFECYCLE_SCOPE = Object.freeze({
  implemented: Object.freeze([
    "specialized-note-skill-research-read-create-update", "citation-authoring-through-native-canonicalization",
    "document-folder-move-preview-and-cas", "paired-asset-list-get-and-pinned-document-move",
    "paired-asset-rename-delete-preview-and-cas",
    "recoverable-trash-preview-move-explicit-entry-restore",
  ]),
  notImplemented: Object.freeze([
    "production-mount-and-static-allowlist", "full-production-ux-parity", "native-human-review",
    "full-browser-qualification",
  ]),
});

const inputFields = Object.freeze({
  documentList: [[], ["offset", "limit", "workspaceRevision", "includeDeleted", "area"]],
  documentGet: [["id"], []],
  noteList: [[], ["type", "offset", "limit", "snapshotRevision"]],
  noteGet: [[], ["id", "path", "snapshotRevision"]],
  noteSearch: [["query"], ["caseSensitive", "regex", "offset", "limit", "snapshotRevision"]],
  skillList: [[], ["category", "tag", "offset", "limit", "snapshotRevision"]],
  skillGet: [[], ["name", "id", "snapshotRevision"]],
  skillSearch: [["query"], ["caseSensitive", "regex", "offset", "limit", "snapshotRevision"]],
  researchList: [[], ["revision", "offset", "limit"]],
  researchSearch: [["query"], ["caseSensitive", "regex", "offset", "limit", "revision"]],
  noteCreate: [["operationId", "expectedScanRevision", "title"], ["category", "content", "description", "tags", "links", "type"]],
  noteUpdate: [["operationId", "id", "expectedScanRevision", "expectedRevision", "expectedSha256"], ["category", "content", "description", "tags", "links", "title", "type"]],
  skillCreate: [["operationId", "expectedScanRevision", "name"], ["category", "content", "description", "tags", "links", "source_project", "recipe_required", "recipe_hint", "related_skills", "priority", "pinned"]],
  skillUpdate: [["operationId", "id", "expectedScanRevision", "expectedRevision", "expectedSha256"], ["category", "content", "description", "tags", "links", "name", "source_project", "recipe_required", "recipe_hint", "related_skills", "priority", "pinned"]],
  researchCreate: [["operationId", "expectedScanRevision", "title"], ["category", "content", "description", "tags", "links", "authors", "year", "topic", "publisher", "url", "file", "conclusions", "implementation", "assumptions", "cites", "kind", "group", "pinned"]],
  researchUpdate: [["operationId", "id", "expectedScanRevision", "expectedRevision", "expectedSha256"], ["category", "content", "description", "tags", "links", "title", "authors", "year", "topic", "publisher", "url", "file", "conclusions", "implementation", "assumptions", "cites", "kind", "group", "pinned"]],
  assetList: [["id"], ["offset", "limit", "revision"]],
  assetGet: [["id", "path", "expectedDocumentSha256", "expectedDigest"], ["offset", "length"]],
  assetPreview: [["id", "area", "documentPath", "expectedRevision", "expectedSha256", "path", "expectedDigest", "expectedSize", "action"], ["newName"]],
  assetRename: [["id", "area", "documentPath", "expectedRevision", "expectedSha256", "path", "expectedDigest",
    "expectedSize", "operationId", "expectedScanRevision", "newName", "expectedDestinationDigest", "rewriteMarkdown"], []],
  assetDelete: [["id", "area", "documentPath", "expectedRevision", "expectedSha256", "path", "expectedDigest",
    "expectedSize", "operationId", "expectedScanRevision"], []],
  documentMovePreview: [["id", "area", "path", "destinationPath", "expectedRevision", "expectedSha256"], []],
  documentMove: [["id", "area", "path", "destinationPath", "expectedRevision", "expectedSha256", "operationId", "expectedScanRevision", "expectedPairedTreeDigest", "expectedDestinationSha256", "expectedDestinationTreeDigest"], []],
  folderMovePreview: [["area", "path", "destinationPath"], []],
  folderMove: [["operationId", "area", "path", "destinationPath", "expectedSourceSha256", "expectedScanRevision", "expectedDestinationSha256"], []],
  trashPreview: [["area", "path", "kind"], []],
  trashMove: [["operationId", "area", "path", "kind", "expectedTreeSha256", "expectedScanRevision"], []],
  trashRestore: [["operationId", "entryId", "expectedScanRevision"], []],
});

const uuidFields = new Set(["operationId"]);
function validateInput(key, input) {
  const fields = inputFields[key];
  if (!fields || input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("INVALID_ARGUMENT");
  const [required, optional] = fields;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some(name => !allowed.has(name)) || required.some(name => !Object.hasOwn(input, name)))
    throw new TypeError("INVALID_ARGUMENT");
  for (const [name, value] of Object.entries(input)) {
    if (uuidFields.has(name) && (typeof value !== "string" || !uuidPattern.test(value))) throw new TypeError("INVALID_ARGUMENT");
    if (["expectedScanRevision", "expectedSha256", "expectedSourceSha256", "expectedTreeSha256",
      "revision", "snapshotRevision", "workspaceRevision"].includes(name) &&
      (typeof value !== "string" || !digestPattern.test(value))) throw new TypeError("INVALID_ARGUMENT");
    if (name === "expectedDigest" && (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)))
      throw new TypeError("INVALID_ARGUMENT");
    if (name === "expectedPairedTreeDigest" && value !== null &&
        (typeof value !== "string" || !digestPattern.test(value))) throw new TypeError("INVALID_ARGUMENT");
    if (name.startsWith("expected") && name.endsWith("Sha256") && value !== null &&
      (typeof value !== "string" || !digestPattern.test(value))) throw new TypeError("INVALID_ARGUMENT");
  }
  return structuredClone(input);
}

/**
 * Adapt the authenticated native ProtocolClient to a narrow set of lifecycle calls.
 * The returned object has no generic operation/mutation method.
 * @param {{available:(key:string)=>boolean,call:(key:string,args:Record<string,unknown>,signal?:AbortSignal)=>Promise<Record<string,unknown>>}} protocol
 */
export function createKnowledgeLifecycleClient(protocol) {
  const api = {
    available(key) { return Object.hasOwn(KNOWLEDGE_LIFECYCLE_OPERATIONS, key) && protocol.available(key); },
    availableOperations() {
      return Object.keys(KNOWLEDGE_LIFECYCLE_OPERATIONS).filter(key => protocol.available(key));
    },
  };
  for (const key of Object.keys(KNOWLEDGE_LIFECYCLE_OPERATIONS)) {
    Object.defineProperty(api, key, {
      enumerable: true,
      value: (input = {}, signal) => {
        if (!api.available(key)) throw Object.assign(new Error("CAPABILITY_UNAVAILABLE"), { code: "CAPABILITY_UNAVAILABLE" });
        return protocol.call(key, validateInput(key, input), signal);
      },
    });
  }
  return Object.freeze(api);
}

const node = (document, tag, content = "", className = "") => {
  const element = document.createElement(tag);
  if (content) element.textContent = content;
  if (className) element.className = className;
  return element;
};
const text = value => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const uuid = () => globalThis.crypto?.randomUUID?.();
const validDigest = value => typeof value === "string" && digestPattern.test(value);
const listKey = Object.freeze({ note: "noteList", skill: "skillList", research: "researchList" });
const getKey = Object.freeze({ note: "noteGet", skill: "skillGet" });
const updateKey = Object.freeze({ note: "noteUpdate", skill: "skillUpdate", research: "researchUpdate" });
const createKey = Object.freeze({ note: "noteCreate", skill: "skillCreate", research: "researchCreate" });

function showStatus(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
}

function jsonField(value, label) {
  try { return JSON.parse(value || "[]"); }
  catch { throw new Error(`${label} must be valid JSON.`); }
}

function fieldsFor(kind, source, content, form, document) {
  const metadata = { ...(source ?? {}) };
  if (typeof metadata.tags === "string") {
    try { metadata.tags = JSON.parse(metadata.tags); } catch { metadata.tags = []; }
  }
  if (metadata.source_project == null) metadata.source_project = "";
  if (metadata.year == null) metadata.year = "";
  metadata.content = content ?? "";
  const definitions = [
    ["title", kind === "skill" ? "Name" : "Title", "input", metadata[kind === "skill" ? "name" : "title"] ?? "", true],
    ["description", "Description", "textarea", metadata.description ?? "", false],
  ];
  if (kind === "note") definitions.push(["type", "Type", "input", metadata.type ?? "", false]);
  if (kind === "skill") {
    definitions.push(["source_project", "Source project", "input", metadata.source_project ?? "", false]);
    definitions.push(["recipe_hint", "Recipe hint", "textarea", metadata.recipe_hint ?? "", false]);
    definitions.push(["recipe_required", "Recipe required", "checkbox", metadata.recipe_required ?? false, false]);
    definitions.push(["priority", "Priority", "select", metadata.priority ?? "normal", false]);
    definitions.push(["pinned", "Pinned", "checkbox", metadata.pinned ?? false, false]);
  }
  if (kind === "research") {
    for (const [key, label] of [["year", "Year"], ["topic", "Topic"], ["publisher", "Publisher"], ["url", "URL"], ["file", "File"], ["kind", "Kind"], ["group", "Group"]])
      definitions.push([key, label, "input", metadata[key] ?? "", false]);
    for (const [key, label] of [["authors", "Authors"], ["conclusions", "Conclusions"], ["implementation", "Implementation"], ["assumptions", "Assumptions"], ["cites", "Citations"]])
      definitions.push([key, label, "textarea", JSON.stringify(metadata[key] ?? [], null, 2), false]);
    definitions.push(["pinned", "Pinned", "checkbox", metadata.pinned ?? false, false]);
  }
  definitions.push(["tags", "Tags (JSON array)", "textarea", JSON.stringify(metadata.tags ?? [], null, 2), false]);
  definitions.push(["links", "Typed links (JSON array)", "textarea", JSON.stringify(metadata.links ?? [], null, 2), false]);
  definitions.push(["content", "Markdown content", "textarea", content ?? "", false]);

  const controls = new Map();
  for (const [key, label, kindName, value, readOnly] of definitions) {
    const wrapper = node(document, "label", "", "surface-field");
    const control = node(document, kindName === "select" ? "select" : kindName === "textarea" ? "textarea" : "input");
    control.name = key;
    control.setAttribute("aria-label", label);
    if (kindName === "checkbox") {
      control.type = "checkbox";
      control.checked = Boolean(value);
    } else if (kindName === "select") {
      control.replaceChildren();
      for (const optionValue of ["normal", "high", "highest"]) {
        const option = node(document, "option", optionValue);
        option.value = optionValue;
        option.selected = optionValue === value;
        control.append(option);
      }
    } else control.value = String(value);
    if (readOnly) {
      control.readOnly = true;
      control.title = "Names and categories are changed only by the dedicated lifecycle operations.";
    }
    wrapper.append(node(document, "span", label), control);
    form.append(wrapper);
    controls.set(key, control);
  }
  return controls;
}

function serializeForm(fields, baseline) {
  const values = {};
  const jsonKeys = new Set(["tags", "links", "authors", "related_skills", "conclusions", "implementation", "assumptions", "cites"]);
  const boolKeys = new Set(["pinned", "recipe_required"]);
  for (const [key, control] of fields) {
    const value = boolKeys.has(key) ? Boolean(control.checked) : control.value;
    if (jsonKeys.has(key)) values[key] = jsonField(String(value), key);
    else {
      const before = boolKeys.has(key) ? Boolean(baseline[key]) : baseline[key] == null ? "" : String(baseline[key]);
      if (value !== before) values[key] = value;
    }
  }
  for (const key of jsonKeys) {
    if (fields.has(key)) {
      const current = JSON.stringify(values[key]);
      const previous = JSON.stringify(baseline[key] ?? []);
      if (current === previous) delete values[key];
    }
  }
  if (fields.has("year") && Object.hasOwn(values, "year")) {
    const raw = String(values.year).trim();
    values.year = raw ? (/^-?\d+$/.test(raw) ? Number(raw) : raw) : null;
  }
  delete values.title;
  delete values.name;
  return values;
}

function downloadAsset(document, asset, bytes) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = node(document, "a", "Download");
  link.href = url;
  link.download = asset.path.split("/").at(-1) ?? "resource";
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function assetBytes(api, selected, asset) {
  const chunks = [];
  let offset = 0;
  do {
    const chunk = await api.assetGet({
      id: selected.doc.id, path: asset.path, expectedDocumentSha256: selected.doc.sha256,
      expectedDigest: asset.digest, offset, length: 65_536,
    });
    const binary = atob(chunk.data);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    chunks.push(bytes);
    offset += bytes.length;
    if (chunk.nextOffset !== null && chunk.nextOffset !== offset) throw new Error("Invalid resource chunk cursor.");
    if (offset > asset.size || bytes.length === 0 && chunk.nextOffset !== null) throw new Error("Invalid resource chunk size.");
    if (chunk.nextOffset === null) break;
  } while (true);
  const joined = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) { joined.set(chunk, cursor); cursor += chunk.length; }
  return joined;
}

/**
 * Mount the functional lifecycle surface after native capabilities have been discovered.
 * Call refresh() after connect/disconnect; unavailable operations are omitted, never simulated.
 * @param {HTMLElement} root
 * @param {ReturnType<typeof createKnowledgeLifecycleClient>} api
 */
export function mountKnowledgeLifecycle(root, api) {
  const document = root.ownerDocument;
  const panel = node(document, "section", "", "workflow-surface knowledge-lifecycle");
  panel.setAttribute("aria-label", "Knowledge lifecycle");
  const heading = node(document, "h2", "Knowledge lifecycle");
  const notice = node(document, "p", "Native server capabilities and your authenticated role determine which actions are available.", "surface-status");
  notice.setAttribute("role", "status");
  const status = node(document, "p", "", "surface-status");
  status.setAttribute("role", "status");
  const alert = node(document, "p", "", "surface-status");
  alert.setAttribute("role", "alert");
  alert.hidden = true;
  const content = node(document, "div", "", "knowledge-lifecycle-content");
  panel.append(heading, notice, status, alert, content);
  root.append(panel);

  /** @type {Array<()=>void>} */
  const listeners = [];
  /** @type {Record<string, any>|null} */
  let selected = null;
  /** @type {Record<string, any>|null} */
  let editState = null;
  let disposed = false;
  const on = (target, type, listener) => {
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  };
  const addControl = (parent, control) => { if (control) parent.append(control); };
  async function run(action, sourceEdit = false) {
    alert.hidden = true;
    showStatus(status, "Working…");
    try { await action(); }
    catch (error) {
      const code = error?.code;
      const message = code === "CONFLICT" && sourceEdit && editState
        ? "The source changed before this edit was accepted. No overwrite was made. Reload the latest source or rebase your draft, then review and save again."
        : code === "CONFLICT" && selected?.operation === "trashRestore"
          ? "Restore was not applied: the original destination is occupied or its source pins changed. Nothing was overwritten; move the conflicting item and retry with a new operation ID."
          : error instanceof Error ? error.message : "The native operation failed.";
      alert.textContent = message;
      alert.hidden = false;
      if (code === "CONFLICT" && sourceEdit && editState) editState.conflictActions.hidden = false;
      showStatus(status, "Operation not completed.", true);
    }
  }
  function jsonView(value) {
    const pre = node(document, "pre", text(value), "literal-content");
    return pre;
  }
  function showUnavailable() {
    const available = api.availableOperations();
    if (!available.length) showStatus(status, "Connect to the isolated native server to discover capabilities.");
    else {
      const read = available.some(key => ["documentList", "noteList", "skillList", "researchList"].includes(key));
      const mutationAvailable = Object.entries(KNOWLEDGE_LIFECYCLE_OPERATIONS)
        .some(([key, definition]) => !definition.readOnly && available.includes(key));
      showStatus(status, read
        ? `Read-only labels follow the original Knowledge models. ${mutationAvailable
          ? "Only exact native capabilities advertised for this authenticated role have controls."
          : "This role has no lifecycle mutation capabilities; mutation forms are omitted."}`
        : "This role has no lifecycle read capabilities; unavailable forms are omitted.");
    }
  }

  async function queryItems(kind) {
    const method = api[listKey[kind]];
    const items = [];
    let offset = 0, snapshot;
    for (;;) {
      const args = kind === "research" ? { offset, limit: 100, ...(snapshot ? { revision: snapshot } : {}) }
        : { offset, limit: 100, ...(snapshot ? { snapshotRevision: snapshot } : {}) };
      const page = await method(args);
      snapshot = kind === "research" ? page.revision : page.snapshotRevision;
      items.push(...page.items);
      if (page.nextOffset === null) {
        if (kind === "research") {
          await api.researchList({ offset: 0, limit: 1, revision: snapshot });
          const documents = await allDocuments(api);
          return items.map(item => {
            const source = documents.find(document => document.area === "papers" && document.path === `${item.slug}.md`);
            return source ? { ...item, documentId: source.id, path: source.path, documentSha256: source.sha256, revision: source.revision } : item;
          });
        }
        return items;
      }
      offset = page.nextOffset;
    }
  }

  async function loadKind(kind, listHost, detailHost) {
    if (!api.available(listKey[kind])) throw Object.assign(new Error("Native read capability unavailable for this role."), { code: "CAPABILITY_UNAVAILABLE" });
    showStatus(status, `Loading ${kind}…`);
    const items = await queryItems(kind);
    listHost.replaceChildren();
    detailHost.replaceChildren();
    selected = null; editState = null;
    for (const item of items) {
      const label = `${item.title ?? item.name ?? item.slug} · ${item.path}`;
      const choice = node(document, "button", label);
      choice.type = "button";
      on(choice, "click", () => void run(async () => loadSelected(kind, item, detailHost)));
      listHost.append(choice);
    }
    showStatus(status, `${items.length} ${kind} entries loaded from the native read model.`);
    return items;
  }

  async function readMetadata(kind, item) {
    if (kind === "note" || kind === "skill") {
      if (!api.available(getKey[kind])) return item;
      const result = await api[getKey[kind]]({ id: item.documentId });
      return result.item;
    }
    return item;
  }

  async function loadSelected(kind, item, detailHost, draftValues) {
    if (!api.available("documentGet")) throw Object.assign(new Error("Document read capability unavailable for this role."), { code: "CAPABILITY_UNAVAILABLE" });
    selected = null; editState = null;
    detailHost.replaceChildren(node(document, "p", "Loading selected source…", "surface-status"));
    const metadata = await readMetadata(kind, item);
    const doc = await api.documentGet({ id: item.documentId });
    if (item.documentSha256 !== doc.sha256 || item.revision !== undefined && item.revision !== doc.revision ||
        metadata.documentSha256 !== undefined && metadata.documentSha256 !== doc.sha256) {
      selected = null; editState = null; detailHost.replaceChildren();
      showStatus(status, "Source hash changed before editing. Refresh the list and reload the current source; no editor was opened.", true);
      return;
    }
    selected = { kind, item, metadata, doc };
    const baseline = { ...metadata, content: doc.content };
    if (typeof baseline.tags === "string") {
      try { baseline.tags = JSON.parse(baseline.tags); } catch { baseline.tags = []; }
    }
    if (baseline.source_project == null) baseline.source_project = "";
    if (baseline.year == null) baseline.year = "";
    detailHost.replaceChildren();
    detailHost.append(node(document, "h3", `${metadata.title ?? metadata.name ?? doc.title} · ${item.path}`));
    detailHost.append(node(document, "p", `${doc.area} / ${item.path} · revision ${doc.revision} · SHA-256 ${doc.sha256}`, "surface-status"));
    detailHost.append(jsonView({ metadata, content: doc.content }));
    editState = null;
    const operation = updateKey[kind];
    if (!api.available(operation) || !api.available("documentGet")) {
      detailHost.append(node(document, "p", "Read-only for this native capability/role; no edit controls are available.", "surface-status"));
      return;
    }
    const editor = node(document, "form", "", "surface-editor");
    const fields = fieldsFor(kind, baseline, doc.content, editor, document);
    const submit = node(document, "button", "Save specialized fields");
    submit.type = "submit";
    editor.append(node(document, "p", "Only changed fields are sent. Unrecognized YAML metadata remains under server authority; title/category changes use lifecycle moves.", "surface-status"), submit);
    const conflictActions = node(document, "div", "", "surface-tools");
    const reload = node(document, "button", "Reload latest (discard draft)");
    reload.type = "button";
    const rebase = node(document, "button", "Rebase draft onto latest (review before saving)");
    rebase.type = "button";
    conflictActions.hidden = true;
    conflictActions.append(reload, rebase);
    on(reload, "click", () => void run(async () => {
      conflictActions.hidden = true;
      await reloadSelected(kind, item.documentId, detailHost);
    }));
    on(rebase, "click", () => void run(async () => {
      const draft = serializeForm(fields, baseline);
      conflictActions.hidden = true;
      await reloadSelected(kind, item.documentId, detailHost, draft);
      showStatus(status, "Draft rebased on the latest source pins. Review the draft, then explicitly save; nothing was written.");
    }));
    on(editor, "submit", event => {
      event.preventDefault();
      void run(async () => {
        const changes = serializeForm(fields, baseline);
        const scan = await knowledgeMutationScanRevision(api);
        const args = {
          operationId: uuid(), id: doc.id, expectedScanRevision: scan,
          expectedRevision: doc.revision, expectedSha256: doc.sha256, ...changes,
        };
        await api[operation](args);
        conflictActions.hidden = true;
        showStatus(status, "Saved by the native server. Refresh the list to verify its authoritative revision.");
        await reloadSelected(kind, doc.id, detailHost);
      }, true);
    });
    detailHost.append(editor, conflictActions);
    editState = { kind, item, doc, metadata, editor, fields, conflictActions };
    if (draftValues) {
      for (const [key, value] of Object.entries(draftValues)) {
        const field = fields.get(key);
        if (field) {
          if (field.type === "checkbox") field.checked = Boolean(value);
          else field.value = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        }
        conflictActions.hidden = false;
      }
    }
  }

  async function reloadSelected(kind, id, detailHost, draft) {
    const items = await queryItems(kind);
    const latest = items.find(item => item.documentId === id);
    if (!latest) {
      selected = null; editState = null; detailHost.replaceChildren();
      showStatus(status, "The source is no longer active in this read model; no write was attempted.", true);
      return;
    }
    await loadSelected(kind, latest, detailHost, draft);
  }

  function formField(parent, label, value = "", type = "input") {
    const wrapper = node(document, "label", "", "surface-field");
    const control = node(document, type === "textarea" ? "textarea" : "input");
    control.setAttribute("aria-label", label);
    control.value = value;
    wrapper.append(node(document, "span", label), control);
    parent.append(wrapper);
    return control;
  }

  async function openSearchResult(kind, item, snapshotRevision, detailHost) {
    if (!api.available("documentGet")) throw Object.assign(new Error("Document read capability unavailable for this role."), { code: "CAPABILITY_UNAVAILABLE" });
    detailHost.replaceChildren(node(document, "p", "Opening pinned source…", "surface-status"));
    let metadata = item;
    let content;
    if (kind === "note" || kind === "skill") {
      const key = getKey[kind];
      if (!api.available(key)) throw Object.assign(new Error(`${kind} read capability unavailable for this role.`), { code: "CAPABILITY_UNAVAILABLE" });
      const result = await api[key]({ id: item.documentId, snapshotRevision });
      if (result.snapshotRevision !== snapshotRevision || result.item.documentSha256 !== item.documentSha256) {
        throw Object.assign(new Error("Search result changed after this snapshot. Search again to open the current source."), { code: "CONFLICT" });
      }
      metadata = result.item;
      content = result.item.content;
    } else {
      if (!api.available("researchList")) throw Object.assign(new Error("Pinned Research read capability unavailable for this role."), { code: "CAPABILITY_UNAVAILABLE" });
      const pin = await api.researchList({ offset: 0, limit: 1, revision: snapshotRevision });
      if (pin.revision !== snapshotRevision) throw Object.assign(new Error("Research snapshot changed. Search again to open the current source."), { code: "CONFLICT" });
    }
    const source = await api.documentGet({ id: item.documentId });
    if (source.sha256 !== item.documentSha256) {
      throw Object.assign(new Error("Search result source changed. Search again to open the current source."), { code: "CONFLICT" });
    }
    detailHost.replaceChildren(
      node(document, "h4", `Read-only source · ${item.title ?? item.name ?? item.slug}`),
      node(document, "p", `${item.area ?? source.area} / ${item.path} · snapshot ${snapshotRevision} · SHA-256 ${source.sha256}`, "surface-status"),
      jsonView({ metadata, content: content ?? source.content }),
    );
    showStatus(status, "Opened the exact source selected from this pinned search snapshot; no write was attempted.");
  }

  function buildListPanel() {
    const section = node(document, "section", "", "surface-details");
    section.append(node(document, "h3", "Specialized Knowledge"));
    const selector = node(document, "select");
    selector.setAttribute("aria-label", "Knowledge kind");
    for (const [value, label] of [["note", "Notes"], ["skill", "Skills"], ["research", "Research"]]) {
      if (!api.available(listKey[value])) continue;
      const option = node(document, "option", label); option.value = value; selector.append(option);
    }
    const load = node(document, "button", "Load entries");
    load.type = "button";
    const listHost = node(document, "div", "", "surface-list");
    const detailHost = node(document, "div", "", "surface-details");
    on(load, "click", () => void run(() => loadKind(selector.value, listHost, detailHost)));
    section.append(selector, load, listHost, detailHost);
    if (["noteSearch", "skillSearch", "researchSearch"].some(key => api.available(key))) {
      const searchForm = node(document, "form", "", "surface-tools");
      searchForm.append(node(document, "h4", "Literal search"));
      const searchKind = node(document, "select");
      searchKind.setAttribute("aria-label", "Search Knowledge kind");
      for (const [value, label] of [["note", "Notes"], ["skill", "Skills"], ["research", "Research"]]) {
        if (!api.available(`${value}Search`)) continue;
        const option = node(document, "option", label); option.value = value; searchKind.append(option);
      }
      searchForm.append(searchKind);
      const query = formField(searchForm, "Search terms");
      const searchResults = node(document, "div", "", "surface-list");
      searchResults.setAttribute("role", "region");
      searchResults.setAttribute("aria-label", "Literal search results");
      const search = node(document, "button", "Search");
      search.type = "submit";
      searchForm.append(search);
      on(searchForm, "submit", event => {
        event.preventDefault();
        void run(async () => {
          const searchType = searchKind.value;
          const key = `${searchType}Search`;
          if (!api.available(key)) throw new Error("Literal search is unavailable for this native role.");
          const result = await api[key]({ query: query.value, offset: 0, limit: 50 });
          searchResults.replaceChildren();
          const snapshotRevision = searchType === "research" ? result.revision : result.snapshotRevision;
          if (!validDigest(snapshotRevision)) throw new Error("Native search returned no valid snapshot pin; results were not opened.");
          for (const item of result.items) {
            const label = `${item.title ?? item.name ?? item.slug} · ${item.path}`;
            const choice = node(document, "button", label);
            choice.type = "button";
            const openAvailable = api.available("documentGet")
              && (searchType === "research" ? api.available("researchList") : api.available(getKey[searchType]));
            choice.disabled = !openAvailable;
            if (!openAvailable) choice.title = "The pinned source read capability is unavailable for this role.";
            on(choice, "click", () => void run(() => openSearchResult(searchType, item, snapshotRevision, detailHost)));
            searchResults.append(choice);
          }
          showStatus(status, `${result.total} matches from pinned snapshot ${snapshotRevision}; body text was searched internally and is not returned.`);
        });
      });
      section.append(searchForm, searchResults);
    }
    return section;
  }

  function buildCreatePanel() {
    const section = node(document, "section", "", "surface-details");
    section.append(node(document, "h3", "Create specialized document"));
    const selector = node(document, "select");
    selector.setAttribute("aria-label", "New Knowledge kind");
    for (const [value, label] of [["note", "Note"], ["skill", "Skill"], ["research", "Research"]]) {
      if (!api.available(createKey[value])) continue;
      const option = node(document, "option", label); option.value = value; selector.append(option);
    }
    const form = node(document, "form", "", "surface-editor");
    const fieldsHost = node(document, "div", "", "surface-editor");
    let controls = new Map();
    const definitions = {
      note: [["type", "Type", "input"], ["tags", "Tags (JSON array)", "textarea"], ["links", "Typed links (JSON array)", "textarea"]],
      skill: [["source_project", "Source project", "input"], ["recipe_required", "Recipe required", "checkbox"],
        ["recipe_hint", "Recipe hint", "textarea"], ["related_skills", "Related Skills (JSON array)", "textarea"],
        ["priority", "Priority", "priority"], ["pinned", "Pinned", "checkbox"],
        ["tags", "Tags (JSON array)", "textarea"], ["links", "Typed links (JSON array)", "textarea"]],
      research: [["authors", "Authors (JSON array)", "textarea"], ["year", "Year", "input"], ["topic", "Topic", "input"],
        ["publisher", "Publisher", "input"], ["url", "URL", "input"], ["file", "File", "input"],
        ["conclusions", "Conclusions (JSON array)", "textarea"], ["implementation", "Implementation (JSON array)", "textarea"],
        ["assumptions", "Assumptions (JSON array)", "textarea"], ["cites", "Citations (JSON array)", "textarea"],
        ["kind", "Research kind", "input"], ["group", "Group", "input"], ["pinned", "Pinned", "checkbox"],
        ["tags", "Tags (JSON array)", "textarea"], ["links", "Typed links (JSON array)", "textarea"]],
    };
    const common = [["name", "Title or Skill name", "input"], ["category", "Category folder", "input"],
      ["description", "Description", "textarea"], ["content", "Markdown content", "textarea"]];
    const jsonCreateFields = new Set(["tags", "links", "related_skills", "authors", "conclusions", "implementation", "assumptions", "cites"]);
    function renderCreateFields() {
      fieldsHost.replaceChildren();
      controls = new Map();
      for (const [key, label, kind] of [...common, ...definitions[selector.value]]) {
        const wrapper = node(document, "label", "", "surface-field");
        let control;
        if (kind === "priority") {
          control = node(document, "select");
          for (const value of ["normal", "high", "highest"]) {
            const option = node(document, "option", value); option.value = value; control.append(option);
          }
        } else {
          control = node(document, kind === "textarea" ? "textarea" : "input");
          if (kind === "checkbox") control.type = "checkbox";
        }
        control.name = key;
        control.setAttribute("aria-label", label);
        if (kind === "textarea" && jsonCreateFields.has(key)) control.value = "[]";
        if (key === "recipe_required" || key === "pinned") control.checked = false;
        wrapper.append(node(document, "span", label), control);
        fieldsHost.append(wrapper);
        controls.set(key, control);
      }
    }
    renderCreateFields();
    const save = node(document, "button", "Create");
    save.type = "submit";
    form.append(fieldsHost,
      node(document, "p", "Create is an explicit native mutation. Citation resolution, paths, stable identity, YAML and unknown metadata remain server-authoritative.", "surface-status"),
      save);
    on(selector, "change", renderCreateFields);
    on(form, "submit", event => {
      event.preventDefault();
      void run(async () => {
        const kind = selector.value;
        const operation = createKey[kind];
        if (!api.available(operation)) throw new Error(`Native ${kind} creation is unavailable for this role.`);
        const nameValue = controls.get("name").value.trim();
        if (!nameValue) throw new Error("A title or Skill name is required.");
        const args = {
          operationId: uuid(), expectedScanRevision: await knowledgeMutationScanRevision(api),
          category: controls.get("category").value, description: controls.get("description").value,
          content: controls.get("content").value,
          ...(kind === "skill" ? { name: nameValue } : { title: nameValue }),
        };
        for (const [key, control] of controls) {
          if (["name", "category", "description", "content"].includes(key)) continue;
          if (control.type === "checkbox") args[key] = Boolean(control.checked);
          else if (jsonCreateFields.has(key)) args[key] = jsonField(control.value, key);
          else if (control.value !== "") {
            args[key] = key === "year" && /^\d+$/.test(control.value) ? Number(control.value) : control.value;
          }
        }
        const receipt = await api[operation](args);
        showStatus(status, `Created ${receipt.area}/${receipt.path} at revision ${receipt.revision}.`);
        renderCreateFields();
      });
    });
    section.append(selector);
    section.append(form);
    return section;
  }

  function buildAssetsPanel() {
    const section = node(document, "section", "", "surface-details");
    section.append(node(document, "h3", "Paired assets"));
    const id = formField(section, "Document ID");
    const list = node(document, "button", "Load owned/referenced assets");
    list.type = "button";
    const results = node(document, "div", "", "surface-list");
    addControl(section, api.available("assetList") ? list : null);
    on(list, "click", () => void run(async () => {
      const result = await api.assetList({ id: id.value.trim() });
      results.replaceChildren();
      for (const asset of result.items) {
        const item = node(document, "article", "", "surface-details");
        item.append(node(document, "p", `${asset.path} · ${asset.size} bytes · ${asset.digest}`));
        if (api.available("assetGet")) {
          const download = node(document, "button", "Download pinned bytes");
          download.type = "button";
          on(download, "click", () => void run(async () => {
            const selectedSource = selected?.doc?.id === result.id ? selected : { doc: { id: result.id, sha256: result.documentSha256 } };
            const bytes = await assetBytes(api, selectedSource, asset);
            downloadAsset(document, asset, bytes);
          }));
          item.append(download);
        }
        if (api.available("assetPreview") && (api.available("assetRename") || api.available("assetDelete"))) {
          const newName = node(document, "input");
          newName.setAttribute("aria-label", `New asset name for ${asset.path}`);
          const previewRename = node(document, "button", "Preview asset rename");
          previewRename.type = "button";
          const rename = node(document, "button", "Rename pinned asset");
          rename.type = "button";
          const previewDelete = node(document, "button", "Preview asset delete");
          previewDelete.type = "button";
          const remove = node(document, "button", "Delete pinned asset");
          remove.type = "button";
          const previewView = node(document, "div", "", "surface-details");
          let prepared;
          const pins = async () => {
            const current = await api.documentGet({ id: result.id });
            if (current.sha256 !== result.documentSha256)
              throw Object.assign(new Error("The owning document changed after the asset list was loaded. Reload assets before mutating."), { code: "CONFLICT" });
            return {
              id: result.id, area: current.area, documentPath: current.path,
              expectedRevision: current.revision, expectedSha256: current.sha256,
              path: asset.path, expectedDigest: asset.digest, expectedSize: asset.size,
            };
          };
          const preview = async action => {
            const args = { ...await pins(), action,
              ...(action === "rename" ? { newName: newName.value.trim() } : {}) };
            const latest = await api.assetPreview(args);
            prepared = { action, args, latest };
            previewView.replaceChildren(jsonView(latest));
            showStatus(status, action === "rename"
              ? "Asset rename preview is pinned. No resource or Markdown bytes were changed."
              : "Asset delete preview is pinned. No resource bytes were changed.");
          };
          const apply = async () => {
            if (!prepared) throw new Error("Preview this exact asset action before applying it.");
            const latest = await api.assetPreview(prepared.args);
            if (JSON.stringify(latest) !== JSON.stringify(prepared.latest)) {
              prepared = null;
              throw Object.assign(new Error("The document, resource or body-reference scan changed after preview. Review a new preview."), { code: "CONFLICT" });
            }
            const { action, args } = prepared;
            if (action === "rename") {
              const { action: _action, ...renameArgs } = args;
              await api.assetRename({
                ...renameArgs, operationId: uuid(), expectedScanRevision: latest.scanRevision,
                expectedDestinationDigest: null, rewriteMarkdown: latest.markdownRewriteRequired,
              });
              showStatus(status, `Renamed ${args.path} to ${latest.destinationPath} under the native resource lifecycle pin.`);
            } else {
              const { action: _action, ...deleteArgs } = args;
              await api.assetDelete({
                ...deleteArgs, operationId: uuid(), expectedScanRevision: latest.scanRevision,
              });
              showStatus(status, `Deleted ${args.path} under the native resource lifecycle pin.`);
            }
            prepared = null;
          };
          if (api.available("assetRename")) {
            item.append(newName, previewRename, rename);
            on(newName, "input", () => { prepared = null; });
            on(previewRename, "click", () => void run(() => preview("rename")));
            on(rename, "click", () => void run(async () => {
              if (prepared?.action !== "rename") throw new Error("Preview this exact asset rename before applying it.");
              await apply();
            }));
          }
          if (api.available("assetDelete")) {
            item.append(previewDelete, remove);
            on(previewDelete, "click", () => void run(() => preview("delete")));
            on(remove, "click", () => void run(async () => {
              if (prepared?.action !== "delete") throw new Error("Preview this exact asset deletion before applying it.");
              await apply();
            }));
          }
          item.append(previewView);
        }
        results.append(item);
      }
      if (result.diagnostics?.length) results.append(jsonView(result.diagnostics));
      section.append(results);
      showStatus(status, `${result.total} paired/owned resources discovered under the native document pin.`);
    }));
    section.append(results);
    return section;
  }

  function buildMovePanel() {
    const section = node(document, "section", "", "surface-details");
    section.append(node(document, "h3", "Move document and paired assets"));
    const fields = {
      id: formField(section, "Document ID"),
      area: formField(section, "Area (notes, skills, papers)", "notes"),
      path: formField(section, "Current Markdown path"),
      destinationPath: formField(section, "Destination Markdown path"),
    };
    const previewButton = node(document, "button", "Preview pinned move");
    previewButton.type = "button";
    addControl(section, api.available("documentMovePreview") ? previewButton : null);
    const previewView = node(document, "div", "", "surface-details");
    const moveButton = node(document, "button", "Move document and paired assets");
    moveButton.type = "button";
    addControl(section, api.available("documentMove") && api.available("documentMovePreview") ? moveButton : null);
    let preview;
    let previewResult;
    on(previewButton, "click", () => void run(async () => {
      const current = selected?.doc?.id === fields.id.value ? selected.doc : await api.documentGet({ id: fields.id.value });
      preview = {
        id: current.id, area: fields.area.value, path: fields.path.value, destinationPath: fields.destinationPath.value,
        expectedRevision: current.revision, expectedSha256: current.sha256,
      };
      const result = await api.documentMovePreview(preview);
      previewResult = result;
      previewView.replaceChildren(jsonView(result));
      section.append(previewView);
      showStatus(status, "Preview pinned to source SHA/revision, full scan and paired-tree digest. No files were moved.");
    }));
    on(moveButton, "click", () => void run(async () => {
      if (!preview) throw new Error("Preview the exact document and paired assets before moving.");
      const read = await api.documentMovePreview(preview);
      if (read.document.beforeSha256 !== previewResult?.document.beforeSha256 ||
          read.scanRevision !== previewResult?.scanRevision ||
          read.pairedAssets.digest !== previewResult?.pairedAssets.digest) {
        preview = null; previewResult = null;
        throw Object.assign(new Error("Document, references or paired assets changed after preview. Review the new preview before moving."), { code: "CONFLICT" });
      }
      await api.documentMove({
        ...preview, operationId: uuid(), expectedScanRevision: read.scanRevision,
        expectedPairedTreeDigest: read.pairedAssets.digest, expectedDestinationSha256: null, expectedDestinationTreeDigest: null,
      });
      preview = null; previewResult = null;
      showStatus(status, "Document and paired assets moved by the native lifecycle operation.");
    }));
    for (const field of Object.values(fields)) on(field, "input", () => { preview = null; previewResult = null; });
    section.append(previewView);
    return section;
  }

  function buildFolderPanel() {
    const section = node(document, "section", "", "surface-details");
    section.append(node(document, "h3", "Move a folder"));
    const fields = {
      area: formField(section, "Area (notes, skills, papers)", "notes"),
      path: formField(section, "Current folder path"),
      destinationPath: formField(section, "Destination folder path"),
    };
    const previewButton = node(document, "button", "Preview folder move");
    previewButton.type = "button";
    const moveButton = node(document, "button", "Move folder");
    moveButton.type = "button";
    addControl(section, api.available("folderMovePreview") ? previewButton : null);
    addControl(section, api.available("folderMove") && api.available("folderMovePreview") ? moveButton : null);
    const previewView = node(document, "div", "", "surface-details");
    let preview;
    let previewResult;
    on(previewButton, "click", () => void run(async () => {
      preview = { area: fields.area.value, path: fields.path.value, destinationPath: fields.destinationPath.value };
      const result = await api.folderMovePreview(preview);
      previewResult = result;
      previewView.replaceChildren(jsonView(result));
      showStatus(status, "Folder move preview is pinned to source tree and reference scan; no files were moved.");
    }));
    on(moveButton, "click", () => void run(async () => {
      if (!preview) throw new Error("Preview the exact folder paths before moving.");
      const result = await api.folderMovePreview(preview);
      if (result.sourceSha256 !== previewResult?.sourceSha256 || result.scanRevision !== previewResult?.scanRevision) {
        preview = null; previewResult = null;
        throw Object.assign(new Error("Folder tree or references changed after preview. Review the new preview before moving."), { code: "CONFLICT" });
      }
      await api.folderMove({
        operationId: uuid(), ...preview, expectedSourceSha256: result.sourceSha256,
        expectedScanRevision: result.scanRevision, expectedDestinationSha256: null,
      });
      preview = null; previewResult = null;
      showStatus(status, "Folder moved by the native lifecycle operation.");
    }));
    for (const field of Object.values(fields)) on(field, "input", () => { preview = null; previewResult = null; });
    section.append(previewView);
    return section;
  }

  function buildTrashPanel() {
    const section = node(document, "section", "", "surface-details");
    section.append(node(document, "h3", "Recoverable trash"));
    const previewView = node(document, "div", "", "surface-details");
    let previewFields;
    let previewButton;
    let trashButton;
    if (api.available("trashPreview")) {
      previewFields = {
        area: formField(section, "Area (notes, skills, papers)", "notes"),
        path: formField(section, "Document or folder path"),
        kind: node(document, "select"),
      };
      previewFields.kind.setAttribute("aria-label", "Trash entry kind");
      for (const [value, label] of [["document", "Document"], ["folder", "Folder"]]) {
        const option = node(document, "option", label); option.value = value; previewFields.kind.append(option);
      }
      section.append(previewFields.kind);
      previewButton = node(document, "button", "Preview recoverable trash");
      previewButton.type = "button";
      section.append(previewButton);
      if (api.available("trashMove")) {
        trashButton = node(document, "button", "Move to recoverable trash");
        trashButton.type = "button";
        section.append(trashButton);
      }
    }
    let restoreField;
    let restoreButton;
    if (api.available("trashRestore")) {
      restoreField = formField(section, "Committed trash entry ID (UUID)");
      restoreButton = node(document, "button", "Restore this exact entry");
      restoreButton.type = "button";
      section.append(restoreField.parentElement, restoreButton);
      section.append(node(document, "p", "Restore requires an explicit entry UUID from a native receipt. The server verifies the committed entry and refuses occupied destinations; this UI never selects or overwrites a destination.", "surface-status"));
    }
    section.append(previewView);
    let preview;
    let previewResult;
    if (previewButton && previewFields) on(previewButton, "click", () => void run(async () => {
      preview = { area: previewFields.area.value, path: previewFields.path.value, kind: previewFields.kind.value };
      previewResult = await api.trashPreview(preview);
      previewView.replaceChildren(jsonView(previewResult));
      showStatus(status, "Trash preview pinned to the complete source tree and reference scan. No files were changed.");
    }));
    if (trashButton && previewFields) on(trashButton, "click", () => void run(async () => {
      if (!preview || !previewResult) throw new Error("Preview the exact source before moving it to trash.");
      const fresh = await api.trashPreview(preview);
      if (fresh.treeSha256 !== previewResult.treeSha256 || fresh.scanRevision !== previewResult.scanRevision)
        throw Object.assign(new Error("Trash source changed after preview. Review a new preview."), { code: "CONFLICT" });
      const receipt = await api.trashMove({
        operationId: uuid(), ...preview, expectedTreeSha256: fresh.treeSha256, expectedScanRevision: fresh.scanRevision,
      });
      if (restoreField) restoreField.value = receipt.entryId;
      preview = null; previewResult = null;
      showStatus(status, `Moved to recoverable trash. Restore entry ${receipt.entryId}; the source bytes are retained.`);
    }));
    if (restoreButton && restoreField) on(restoreButton, "click", () => void run(async () => {
      const entryId = restoreField.value.trim();
      if (!uuidPattern.test(entryId)) throw new Error("Enter the explicit UUID from a committed trash receipt.");
      selected = { operation: "trashRestore" }; editState = null;
      const scan = await trashRestoreScanRevision(api);
      const receipt = await api.trashRestore({ operationId: uuid(), entryId, expectedScanRevision: scan });
      restoreField.value = "";
      showStatus(status, `Restored ${receipt.area}/${receipt.path} from entry ${receipt.entryId}.`);
    }));
    if (previewFields) for (const field of [previewFields.area, previewFields.path, previewFields.kind]) on(field, "input", () => { preview = null; previewResult = null; });
    if (restoreField) on(restoreField, "input", () => { selected = { operation: "trashRestore" }; editState = null; });
    return section;
  }

  function refresh() {
    if (disposed) return;
    content.replaceChildren();
    selected = null; editState = null;
    showUnavailable();
    if (["noteList", "skillList", "researchList"].some(key => api.available(key)) &&
        api.available("documentGet") && api.available("documentList"))
      content.append(buildListPanel());
    if (Object.values(createKey).some(key => api.available(key))) {
      const create = buildCreatePanel();
      if (create) content.append(create);
    }
    if (api.available("assetList")) content.append(buildAssetsPanel());
    if (api.available("documentMovePreview")) content.append(buildMovePanel());
    if (api.available("folderMovePreview")) content.append(buildFolderPanel());
    if (api.available("trashPreview") || api.available("trashRestore")) content.append(buildTrashPanel());
  }
  refresh();

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of listeners.splice(0)) remove();
      panel.remove();
      selected = null; editState = null;
    },
  };
}

async function digestJson(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure SHA-256 is unavailable in this host.");
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function allDocuments(api) {
  if (!api.available("documentList")) throw Object.assign(new Error("Document listing is unavailable for this role."), { code: "CAPABILITY_UNAVAILABLE" });
  const documents = [];
  let offset = 0, workspaceRevision;
  for (;;) {
    const page = await api.documentList({
      offset, limit: 100, includeDeleted: true, ...(workspaceRevision ? { workspaceRevision } : {}),
    });
    workspaceRevision = page.workspaceRevision;
    documents.push(...page.items);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return documents;
}

export async function knowledgeMutationScanRevision(api) {
  const pins = (await allDocuments(api)).map(item => {
    if (!["notes", "skills", "papers"].includes(item.area) || typeof item.path !== "string" || !validDigest(item.sha256))
      throw new Error("Document listing omitted a canonical mutation pin.");
    return { area: item.area, path: item.path, sha256: item.sha256 };
  });
  pins.sort((left, right) => `${left.area}/${left.path}`.localeCompare(`${right.area}/${right.path}`));
  return digestJson(pins);
}

export async function trashRestoreScanRevision(api) {
  const pins = (await allDocuments(api)).map(item => {
    if (typeof item.id !== "string" || !["notes", "skills", "papers"].includes(item.area) ||
        typeof item.path !== "string" || !Number.isSafeInteger(item.revision) || !validDigest(item.sha256))
      throw new Error("Document listing omitted a canonical restore pin.");
    return { id: item.id, area: item.area, path: item.path, revision: item.revision, sha256: item.sha256 };
  });
  pins.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return digestJson(pins);
}
