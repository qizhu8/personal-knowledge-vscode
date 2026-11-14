// @ts-check

const uuid = () => globalThis.crypto?.randomUUID?.();
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function hashFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { bytes, digest: `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}` };
}

export const WORKFLOW_SURFACE_OPERATIONS = Object.freeze({
  knowledgeList: { operation: "knowledge.document.list", readOnly: true },
  knowledgeGet: { operation: "knowledge.document.get", readOnly: true },
  knowledgeUpdate: { operation: "knowledge.document.update", readOnly: false },
  metadataGet: { operation: "knowledge.metadata.get", readOnly: true },
  metadataUpdate: { operation: "knowledge.metadata.update", readOnly: false },
  assetList: { operation: "knowledge.asset.list", readOnly: true },
  uploadList: { operation: "knowledge.upload.list", readOnly: true },
  uploadBegin: { operation: "knowledge.upload.begin", readOnly: false },
  uploadAppend: { operation: "knowledge.upload.append", readOnly: false },
  uploadGet: { operation: "knowledge.upload.get", readOnly: true },
  uploadCommit: { operation: "knowledge.upload.commit", readOnly: false },
  uploadAbort: { operation: "knowledge.upload.abort", readOnly: false },
  todoBoards: { operation: "todo.board.list", readOnly: true },
  todoBoard: { operation: "todo.board.get", readOnly: true },
  todoItems: { operation: "todo.workitem.list", readOnly: true },
  todoItem: { operation: "todo.workitem.get", readOnly: true },
  todoClaim: { operation: "todo.workitem.claim", readOnly: false },
  todoAccept: { operation: "todo.workitem.accept", readOnly: false },
  workflowGet: { operation: "workflow.run.get", readOnly: true },
  workflowEvents: { operation: "workflow.run.events", readOnly: true },
  workflowCancel: { operation: "workflow.run.cancel", readOnly: false },
  actionGet: { operation: "action.runtime.get", readOnly: true },
  actionEvents: { operation: "action.runtime.events", readOnly: true },
  actionCancel: { operation: "action.runtime.cancel", readOnly: false },
});

export const WORKFLOW_SURFACE_INPUT_FIELDS = Object.freeze({
  knowledgeList: ["offset", "limit", "workspaceRevision", "includeDeleted", "area"],
  knowledgeGet: ["id"],
  knowledgeUpdate: ["operationId", "id", "expectedRevision", "expectedSha256", "title", "content"],
  metadataGet: ["id"],
  metadataUpdate: ["operationId", "id", "expectedRevision", "expectedSha256", "set", "remove"],
  assetList: ["id", "offset", "limit", "revision"],
  uploadList: [],
  uploadBegin: ["operationId", "id", "expectedRevision", "expectedSha256", "name", "size", "digest"],
  uploadAppend: ["operationId", "uploadId", "offset", "data"],
  uploadGet: ["uploadId"],
  uploadCommit: ["operationId", "uploadId"],
  uploadAbort: ["operationId", "uploadId"],
  todoBoards: ["query", "offset", "limit"],
  todoBoard: ["board_slug"],
  todoItems: ["board_slug", "offset", "limit", "query", "include_deleted", "states", "story_id", "owner_id",
    "unassigned", "actionable", "expected_digest"],
  todoItem: ["board_slug", "id", "include_deleted"],
  todoClaim: ["operationId", "board_slug", "id", "expected_digest"],
  todoAccept: ["operationId", "board_slug", "id", "expected_digest", "reason"],
  workflowGet: ["runId"],
  workflowEvents: ["runId", "expectedVersion", "after", "limit"],
  workflowCancel: ["operationId", "runId", "expectedVersion"],
  actionGet: ["runId"],
  actionEvents: ["runId", "after", "limit"],
  actionCancel: ["operationId", "runId", "expectedVersion"],
});

export const WORKFLOW_SURFACE_SCOPE = Object.freeze({
  implemented: Object.freeze([
    "document-list-get-edit", "metadata-patch", "document-cas-conflict-diff", "durable-upload-resume",
    "todo-board-read", "todo-claim", "todo-delegated-accept-attempt", "workflow-status-events-cancel",
    "action-status-events-cancel-when-host-capability-exists",
  ]),
  notImplemented: Object.freeze([
    "full-production-ux-parity", "specialized-note-skill-research-editors", "citation-authoring-and-resolution",
    "knowledge-create-trash-restore", "asset-download-rename-delete", "todo-authoring-and-complete-lifecycle",
    "workflow-definition-authoring-or-step-execution", "action-create-or-step-execution",
    "native-human-review-or-approval", "role-override", "manager-and-chat-surfaces",
  ]),
});

const uuidValue = value => typeof value === "string" && UUID.test(value);
const digestValue = value => typeof value === "string" && DIGEST.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
function jsonValue(value, depth = 0) {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  return record(value) && Object.values(value).every(item => jsonValue(item, depth + 1));
}
function exact(value, required, optional = []) {
  if (!record(value)) throw new TypeError("INVALID_ARGUMENT");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key)))
    throw new TypeError("INVALID_ARGUMENT");
  return value;
}
function checkArgs(key, value) {
  switch (key) {
    case "knowledgeList":
      exact(value, [], ["offset", "limit", "workspaceRevision", "includeDeleted", "area"]);
      if (value.offset !== undefined && !integer(value.offset) || value.limit !== undefined && (!integer(value.limit, 1) || value.limit > 100) ||
          value.workspaceRevision !== undefined && !digestValue(value.workspaceRevision) ||
          value.includeDeleted !== undefined && typeof value.includeDeleted !== "boolean" ||
          value.area !== undefined && !["notes", "skills", "papers"].includes(value.area)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "knowledgeGet":
    case "metadataGet":
      exact(value, ["id"]);
      if (typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "knowledgeUpdate":
      exact(value, ["operationId", "id", "expectedRevision", "expectedSha256", "title", "content"]);
      if (!uuidValue(value.operationId) || typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id) ||
          !integer(value.expectedRevision, 1) || !digestValue(value.expectedSha256) || typeof value.title !== "string" ||
          !value.title.trim() || value.title.length > 500 || typeof value.content !== "string" || value.content.length > 100_000)
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "metadataUpdate":
      exact(value, ["operationId", "id", "expectedRevision", "expectedSha256", "set", "remove"]);
      if (!uuidValue(value.operationId) || typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id) ||
          !integer(value.expectedRevision, 1) || !digestValue(value.expectedSha256) || !record(value.set) ||
          Object.values(value.set).some(item => !jsonValue(item)) ||
          !Array.isArray(value.remove) || value.remove.length > 100 ||
          value.remove.some(key => typeof key !== "string" || !key || key.length > 200) ||
          (!Object.keys(value.set).length && !value.remove.length)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "assetList":
      exact(value, ["id"], ["offset", "limit", "revision"]);
      if (typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id))
        throw new TypeError("INVALID_ARGUMENT");
      if (value.offset !== undefined && (!integer(value.offset) || value.offset > 2048) ||
          value.limit !== undefined && (!integer(value.limit, 1) || value.limit > 100) ||
          value.revision !== undefined && !digestValue(value.revision)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "uploadList":
      exact(value, []);
      break;
    case "uploadBegin":
      exact(value, ["operationId", "id", "expectedRevision", "expectedSha256", "name", "size", "digest"]);
      if (!uuidValue(value.operationId) || typeof value.id !== "string" || !integer(value.expectedRevision, 1) ||
          !digestValue(value.expectedSha256) || typeof value.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id) ||
          !value.name || value.name.length > 200 ||
          value.name.includes("/") || /[\\\u0000-\u001f\u007f:*?"<>|]/.test(value.name) || value.name === "." || value.name === ".." ||
          value.name.endsWith(".") || value.name.endsWith(" ") ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.name) ||
          !integer(value.size, 1) || value.size > 16_777_216 || typeof value.digest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(value.digest)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "uploadAppend":
      exact(value, ["operationId", "uploadId", "offset", "data"]);
      if (!uuidValue(value.operationId) || !uuidValue(value.uploadId) || !integer(value.offset) || value.offset > 16_777_216 ||
          typeof value.data !== "string" || value.data.length < 4 || value.data.length > 87_384 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new TypeError("INVALID_ARGUMENT");
      try {
        const decoded = atob(value.data);
        if (!decoded.length || decoded.length > 65_536 || btoa(decoded) !== value.data) throw new TypeError("INVALID_ARGUMENT");
      } catch { throw new TypeError("INVALID_ARGUMENT"); }
      break;
    case "uploadGet":
      exact(value, ["uploadId"]);
      if (!uuidValue(value.uploadId)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "uploadCommit":
    case "uploadAbort":
      exact(value, ["operationId", "uploadId"]);
      if (!uuidValue(value.operationId) || !uuidValue(value.uploadId)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "todoBoards":
      exact(value, [], ["offset", "limit", "query"]);
      if (value.offset !== undefined && !integer(value.offset) || value.limit !== undefined && (!integer(value.limit, 1) || value.limit > 100) ||
          value.query !== undefined && (typeof value.query !== "string" || !value.query.trim() || value.query.length > 1024))
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "todoBoard":
      exact(value, ["board_slug"]);
      if (typeof value.board_slug !== "string" || !value.board_slug || value.board_slug.length > 1024) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "todoItems":
      exact(value, ["board_slug"], ["offset", "limit", "states", "story_id", "owner_id", "unassigned", "actionable", "expected_digest", "query", "include_deleted"]);
      if (typeof value.board_slug !== "string" || value.offset !== undefined && !integer(value.offset) ||
          value.limit !== undefined && (!integer(value.limit, 1) || value.limit > 100) ||
          value.board_slug.length > 1024 ||
          value.expected_digest !== undefined && !digestValue(value.expected_digest) ||
          value.states !== undefined && (!Array.isArray(value.states) || value.states.length > 5 ||
            value.states.some(state => !["todo", "active", "blocked", "on-hold", "completed"].includes(state))) ||
          ["story_id", "owner_id", "query"].some(key => value[key] !== undefined && typeof value[key] !== "string") ||
          ["unassigned", "actionable", "include_deleted"].some(key => value[key] !== undefined && typeof value[key] !== "boolean"))
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "todoItem":
      exact(value, ["board_slug", "id"], ["include_deleted"]);
      if (typeof value.board_slug !== "string" || value.board_slug.length > 1024 ||
          typeof value.id !== "string" || !value.id || value.id.length > 1024 ||
          value.include_deleted !== undefined && typeof value.include_deleted !== "boolean")
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "todoClaim":
      exact(value, ["operationId", "board_slug", "id", "expected_digest"]);
      if (!uuidValue(value.operationId) || typeof value.board_slug !== "string" || typeof value.id !== "string" ||
          !digestValue(value.expected_digest)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "todoAccept":
      exact(value, ["operationId", "board_slug", "id", "expected_digest", "reason"]);
      if (!uuidValue(value.operationId) || typeof value.board_slug !== "string" || typeof value.id !== "string" ||
          !digestValue(value.expected_digest) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 8000)
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "workflowGet":
      exact(value, ["runId"]);
      if (typeof value.runId !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value.runId)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "workflowEvents":
      exact(value, ["runId", "expectedVersion"], ["after", "limit"]);
      if (typeof value.runId !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value.runId) || !integer(value.expectedVersion, 1) ||
          value.after !== undefined && !integer(value.after) || value.limit !== undefined && (!integer(value.limit, 1) || value.limit > 100))
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "workflowCancel":
    case "actionCancel":
      exact(value, ["operationId", "runId", "expectedVersion"]);
      if (!uuidValue(value.operationId) || typeof value.runId !== "string" ||
          !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value.runId) || !integer(value.expectedVersion, 1))
        throw new TypeError("INVALID_ARGUMENT");
      break;
    case "actionGet":
      exact(value, ["runId"]);
      if (typeof value.runId !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value.runId)) throw new TypeError("INVALID_ARGUMENT");
      break;
    case "actionEvents":
      exact(value, ["runId"], ["after", "limit"]);
      if (typeof value.runId !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value.runId) ||
          value.after !== undefined && !integer(value.after) ||
          value.limit !== undefined && (!integer(value.limit, 1) || value.limit > 100)) throw new TypeError("INVALID_ARGUMENT");
      break;
    default: throw new TypeError("INVALID_ACTION");
  }
  return value;
}

/**
 * Adapt the trusted, capability-discovering ProtocolClient to a closed set of named operations.
 * The returned UI client has no generic operation executor.
 * @param {{available(key:string):boolean,call(key:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>,retryMutation?(key:string):Promise<unknown>}} protocol
 */
export function createWorkflowSurfaceClient(protocol) {
  if (!protocol || typeof protocol.available !== "function" || typeof protocol.call !== "function")
    throw new TypeError("INVALID_HOST_CONFIGURATION");
  const invoke = (key, args, signal) => {
    if (!protocol.available(key)) return Promise.reject(Object.assign(new Error("CAPABILITY_UNAVAILABLE"), { code: "CAPABILITY_UNAVAILABLE" }));
    try { return protocol.call(key, checkArgs(key, args), signal); }
    catch (error) { return Promise.reject(error); }
  };
  const methods = {};
  for (const key of Object.keys(WORKFLOW_SURFACE_OPERATIONS)) {
    methods[key] = (args, signal) => invoke(key, args, signal);
  }
  methods.available = key => Object.hasOwn(WORKFLOW_SURFACE_OPERATIONS, key) && protocol.available(key);
  methods.retryPending = key => {
    if (!Object.hasOwn(WORKFLOW_SURFACE_OPERATIONS, key) || WORKFLOW_SURFACE_OPERATIONS[key].readOnly ||
        typeof protocol.retryMutation !== "function") return Promise.reject(Object.assign(new Error("NO_RETRYABLE_OPERATION"), { code: "NO_RETRYABLE_OPERATION" }));
    return protocol.retryMutation(key);
  };
  return Object.freeze(methods);
}

const terminal = new Set(["succeeded", "failed", "cancelled"]);
const actionTerminal = new Set(["succeeded", "failed", "cancelled", "unknown"]);

/**
 * Mount a bounded client for document editing, durable uploads, Todo Board task actions,
 * Workflow status and Action status. All untrusted server/user strings are rendered as text.
 * @param {HTMLElement} root
 * @param {{client:ReturnType<typeof createWorkflowSurfaceClient>, confirm?:(message:string)=>boolean, onError?:(error:unknown)=>void}} options
 */
export function mountWorkflowSurfaces(root, options) {
  if (!root || !options?.client) throw new TypeError("INVALID_HOST_CONFIGURATION");
  const doc = root.ownerDocument;
  const c = options.client;
  let disposed = false;
  let docEpoch = 0;
  let boardEpoch = 0;
  let workflowEpoch = 0;
  let actionEpoch = 0;
  let documentRecord;
  let metadataRecord;
  let boardRecord;
  let workItem;
  let workflowRun;
  let actionRun;
  let uploads = [];
  const cleanups = [];
  const node = (tag, text = "", className = "") => {
    const el = doc.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const listen = (element, type, fn) => {
    element.addEventListener(type, fn);
    cleanups.push(() => element.removeEventListener(type, fn));
  };
  const button = (label, fn, capability, parent) => {
    const el = node("button", label);
    el.type = "button";
    if (capability && !c.available(capability)) {
      el.hidden = true;
      el.disabled = true;
    } else listen(el, "click", () => void run(fn, el.closest?.(".workflow-surface"), label));
    if (parent && !el.hidden) parent.append(el);
    return el;
  };
  const appendAvailable = (parent, ...elements) => parent.append(...elements.filter(element => !element.hidden));
  const field = (label, type = "input") => {
    const wrap = node("label", "", "surface-field");
    const control = node(type);
    control.setAttribute("aria-label", label);
    wrap.append(node("span", label), control);
    return { wrap, control };
  };
  const message = (section, value, isError = false) => {
    const el = section.querySelector(".surface-status");
    if (!el) return;
    el.textContent = value;
    el.setAttribute("role", isError ? "alert" : "status");
    el.className = isError ? "surface-status error" : "surface-status";
  };
  async function run(action, owner, label = "") {
    try { await action(); }
    catch (error) {
      options.onError?.(error);
      const code = error?.code || error?.message || "REQUEST_FAILED";
      const section = owner;
      if (section) message(section, code === "WORKITEM_FOCUS_CONFLICT"
        ? "WORKITEM_FOCUS_CONFLICT: resolve your current active work explicitly; no task was switched."
        : (code === "ACCESS_DENIED" || code === "DOMAIN_REJECTED") && label.startsWith("Accept completed")
          ? "ACCESS_DENIED: only the authenticated user or explicitly delegated reviewer can accept this task."
          : `${code}${error?.effect === "unknown" ? " · outcome unknown; reconcile server state or retry the identical pending operation." : ""}`, true);
    }
  }
  const section = (name, title) => {
    const el = node("section", "", "workflow-surface");
    el.dataset.surface = name;
    el.setAttribute("aria-label", title);
    const heading = node("h2", title);
    const status = node("p", "", "surface-status");
    status.setAttribute("role", "status");
    el.append(heading, status);
    return el;
  };
  const shell = node("div", "", "workflow-surfaces");
  root.replaceChildren(shell);

  const knowledge = section("knowledge", "Knowledge editing");
  knowledge.dataset.surfaceActive = "";
  const docList = node("div", "", "surface-list");
  const docTools = node("div", "", "surface-tools");
  const refreshDocs = button("Refresh documents", () => loadDocuments(), "knowledgeList", knowledge);
  appendAvailable(docTools, refreshDocs);
  const editor = node("div", "", "surface-editor");
  const metadata = node("div", "", "surface-metadata");
  const attachments = node("div", "", "surface-attachments");
  let attachmentLoad = 0;
  knowledge.append(docTools, docList, editor, metadata, attachments);
  shell.append(knowledge);

  function clearAttachments() {
    attachmentLoad++;
    attachments.replaceChildren(node("h3", "Attachments"), node("p", "Refreshing attachment list…"));
  }

  async function selectDocument(id, epoch = ++docEpoch) {
    clearAttachments();
    if (!c.available("knowledgeGet")) return;
    const record = await c.knowledgeGet({ id });
    if (disposed || epoch !== docEpoch) return;
    documentRecord = record;
    renderEditor(record);
    const metadataLoad = loadMetadata(record, epoch);
    if (disposed || epoch !== docEpoch) return;
    await Promise.all([metadataLoad, loadAttachments(record, epoch)]);
  }
  async function loadDocuments() {
    const epoch = ++docEpoch;
    if (!c.available("knowledgeList")) {
      message(knowledge, "Knowledge document listing is unavailable in this server context.");
      return;
    }
    const page = await c.knowledgeList({ offset: 0, limit: 50 });
    if (disposed || epoch !== docEpoch) return;
    docList.replaceChildren();
    for (const item of page.items ?? []) {
      const label = `${item.title} · ${item.area ?? "document"} · r${item.revision}`;
      const entry = c.available("knowledgeGet")
        ? button(label, () => selectDocument(item.id), "knowledgeGet")
        : node("p", label);
      if ("disabled" in entry) entry.disabled = item.deleted === true;
      docList.append(entry);
    }
    message(knowledge, `${page.total ?? docList.children.length} documents · Markdown source is shown literally.`);
    const first = page.items?.find(item => !item.deleted);
    if (!documentRecord && first) await selectDocument(first.id, epoch);
  }
  function renderEditor(record) {
    editor.replaceChildren();
    const title = field("Document title");
    title.control.value = record.title;
    const content = field("Markdown source (literal text; no HTML preview)", "textarea");
    content.control.value = record.content;
    content.control.spellcheck = false;
    content.control.rows = 16;
    content.control.readOnly = !c.available("knowledgeUpdate");
    title.control.readOnly = !c.available("knowledgeUpdate");
    const save = button("Save document", async () => {
      const epoch = docEpoch;
      const draft = { title: title.control.value, content: content.control.value };
      try {
        const saved = await c.knowledgeUpdate({
          operationId: uuid(), id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
          title: draft.title, content: draft.content,
        });
        if (disposed || epoch !== docEpoch) return;
        documentRecord = saved;
        renderEditor(saved);
        message(knowledge, `Saved revision ${saved.revision}.`);
        await loadMetadata(saved, epoch);
        if (disposed || epoch !== docEpoch) return;
        await loadAttachments(saved, epoch);
      } catch (error) {
        if (error?.code !== "CONFLICT") throw error;
        const latest = await c.knowledgeGet({ id: record.id });
        if (disposed || epoch !== docEpoch) return;
        editor.querySelector(".surface-conflict")?.remove();
        const conflict = node("div", "", "surface-conflict");
        conflict.setAttribute("role", "alert");
        conflict.append(node("h3", "Save conflict — no draft was written"));
        conflict.append(node("p", "The server document changed since this editor loaded. Compare the saved server text with your draft; reload to discard the draft. There is no overwrite or automatic merge."));
        const server = node("pre", latest.content, "literal-content");
        server.setAttribute("aria-label", "Latest server Markdown");
        const local = node("pre", draft.content, "literal-content");
        local.setAttribute("aria-label", "Unsaved local draft");
        const versions = node("div", "", "surface-diff");
        const remoteLabel = node("div", "Latest server version");
        const draftLabel = node("div", "Unsaved local draft");
        remoteLabel.append(server); draftLabel.append(local); versions.append(remoteLabel, draftLabel);
        const reload = button("Reload server version (discard draft)", async () => {
          if (disposed || epoch !== docEpoch) return;
          clearAttachments();
          documentRecord = latest;
          renderEditor(latest);
          await loadMetadata(latest, epoch);
          if (disposed || epoch !== docEpoch) return;
          await loadAttachments(latest, epoch);
          if (disposed || epoch !== docEpoch) return;
          message(knowledge, `Loaded latest revision ${latest.revision}; unsaved draft discarded.`);
        });
        conflict.append(versions, reload);
        editor.append(conflict);
        message(knowledge, `CONFLICT · latest revision ${latest.revision} loaded for comparison; draft preserved locally.`, true);
      }
    }, "knowledgeUpdate", editor);
    const revision = node("p", `Revision ${record.revision} · SHA-256 ${record.sha256}`);
    appendAvailable(editor, title.wrap, content.wrap, save, revision);
  }
  async function loadMetadata(record, epoch) {
    metadata.replaceChildren();
    if (!c.available("metadataGet")) return;
    const read = await c.metadataGet({ id: record.id });
    if (disposed || epoch !== docEpoch) return;
    metadataRecord = read;
    const heading = node("h3", "Metadata patch (server preserves the existing Markdown body and untouched frontmatter)");
    const set = field("Fields to set (JSON object)", "textarea");
    set.control.value = "{}";
    set.control.rows = 4;
    const remove = field("Field names to remove (JSON array)", "textarea");
    remove.control.value = "[]";
    remove.control.rows = 2;
    const existing = node("pre", JSON.stringify(read.metadata ?? {}, null, 2), "literal-content");
    existing.setAttribute("aria-label", "Current metadata");
    set.control.readOnly = !c.available("metadataUpdate");
    remove.control.readOnly = !c.available("metadataUpdate");
    const save = button("Save metadata patch", async () => {
      const setValue = JSON.parse(set.control.value);
      const removeValue = JSON.parse(remove.control.value);
      if (!record || !record.revision || !record.sha256 || !record.id) throw new TypeError("INVALID_ARGUMENT");
      try {
        const saved = await c.metadataUpdate({
          operationId: uuid(), id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
          set: setValue, remove: removeValue,
        });
        documentRecord = saved;
        metadataRecord = await c.metadataGet({ id: saved.id });
        renderEditor(saved);
        await loadMetadata(saved, docEpoch);
        message(knowledge, `Metadata saved at revision ${saved.revision}; other fields and Markdown body were preserved.`);
      } catch (error) {
        if (error?.code !== "CONFLICT") throw error;
        const latest = await c.metadataGet({ id: record.id });
        const conflict = node("div", "", "surface-conflict");
        conflict.setAttribute("role", "alert");
        conflict.append(node("h3", "Metadata conflict — no patch was written"));
        conflict.append(node("p", "Compare the current server metadata with your pending set/remove patch. Nothing was merged or overwritten."));
        conflict.append(node("pre", JSON.stringify(latest.metadata ?? {}, null, 2), "literal-content"));
        conflict.append(node("pre", JSON.stringify({ set: setValue, remove: removeValue }, null, 2), "literal-content"));
        metadata.querySelector(".surface-conflict")?.remove();
        metadata.append(conflict);
        message(knowledge, `CONFLICT · latest metadata revision ${latest.revision} shown beside the unsaved patch.`, true);
      }
    }, "metadataUpdate", metadata);
    appendAvailable(metadata, heading, existing, set.wrap, remove.wrap, save);
  }
  async function loadAttachments(record, epoch) {
    if (disposed || epoch !== docEpoch) return;
    const request = ++attachmentLoad;
    const heading = node("h3", "Attachments");
    const listing = node("div", "", "surface-attachment-list");
    listing.append(node("p", "Loading attachments…"));
    attachments.replaceChildren(heading, listing);
    const uploadControls = [];
    if (!c.available("uploadBegin") && !c.available("uploadList") && !c.available("uploadAbort")) {
      attachments.append(node("p", "Resource upload actions are unavailable in this server context."));
    } else {
      const chooser = field("Choose file to attach", "input");
      chooser.control.type = "file";
      const attach = button("Upload selected file", async () => {
        const file = chooser.control.files?.[0];
        if (!file) throw new TypeError("SELECT_FILE");
        if (file.size < 1 || file.size > 16_777_216) throw new TypeError("UPLOAD_SIZE_LIMIT");
        const { bytes, digest } = await hashFile(file);
        const begun = await c.uploadBegin({
          operationId: uuid(), id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
          name: file.name, size: bytes.length, digest,
        });
        await appendUpload(begun, bytes);
      }, "uploadBegin", attachments);
      attach.disabled = true;
      const recover = button("Resume matching active upload", async () => {
        const file = chooser.control.files?.[0];
        if (!file) throw new TypeError("SELECT_FILE");
        const { bytes, digest } = await hashFile(file);
        const active = await c.uploadList({});
        const match = (active.items ?? []).find(item => item.documentId === record.id && item.name === file.name &&
          item.size === file.size && item.digest === digest && item.status === "active");
        if (!match) throw new TypeError("NO_MATCHING_ACTIVE_UPLOAD");
        const current = await c.uploadGet({ uploadId: match.uploadId });
        await appendUpload(current, bytes);
      }, c.available("uploadList") && c.available("uploadGet") ? "uploadList" : "missingUploadGet", attachments);
      recover.disabled = true;
      const abort = button("Abort selected upload", async () => {
        const file = chooser.control.files?.[0];
        if (!file) throw new TypeError("SELECT_FILE");
        const { digest } = await hashFile(file);
        const active = await c.uploadList({});
        const match = active.items?.find(item => item.documentId === record.id && item.name === file.name &&
          item.size === file.size && item.digest === digest && item.status === "active");
        if (!match) throw new TypeError("NO_ACTIVE_UPLOAD");
        await c.uploadAbort({ operationId: uuid(), uploadId: match.uploadId });
        message(knowledge, "Upload aborted; no resource was written.");
      }, "uploadAbort", attachments);
      appendAvailable(attachments, chooser.wrap, attach, recover, abort);
      uploadControls.push(attach, recover, abort);
    }
    if (!c.available("assetList")) {
      listing.replaceChildren(node("p", "Attachment listing is unavailable in this server context."));
      for (const control of uploadControls) control.disabled = false;
      return;
    }
    try {
      const listed = await c.assetList({ id: record.id });
      if (disposed || epoch !== docEpoch || request !== attachmentLoad) return;
      listing.replaceChildren(...(listed.items ?? []).map(asset =>
        node("p", `${asset.path} · ${asset.size} bytes · ${asset.digest}`)));
      if (!(listed.items ?? []).length) listing.append(node("p", "No attachments."));
      for (const control of uploadControls) control.disabled = false;
    } catch (error) {
      if (disposed || epoch !== docEpoch || request !== attachmentLoad) return;
      listing.replaceChildren(node("p", error?.code === "CONFLICT"
        ? "The document changed while attachments were loading. Reload the current server version before relying on its attachment list."
        : "The attachment list could not be loaded; reload the current server version before continuing."));
      if (error?.code !== "CONFLICT") throw error;
    }
  }
  async function appendUpload(upload, bytes) {
    const chunkSize = 65_536;
    let offset = upload.receivedBytes;
    if (offset > bytes.length) throw new TypeError("UPLOAD_PROGRESS_MISMATCH");
    while (offset < bytes.length) {
      const part = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      const binary = Array.from(part, byte => String.fromCharCode(byte)).join("");
      const updated = await c.uploadAppend({
        operationId: uuid(), uploadId: upload.uploadId, offset, data: btoa(binary),
      });
      offset = updated.receivedBytes;
      message(knowledge, `Uploading ${offset}/${bytes.length} bytes…`);
    }
    const committed = await c.uploadCommit({ operationId: uuid(), uploadId: upload.uploadId });
    message(knowledge, committed.status === "committed" ? `Attachment committed: ${committed.resource.uri}` : "Upload did not commit.");
    if (documentRecord) await loadAttachments(documentRecord, docEpoch);
  }
  const todo = section("todo", "Todo Boards");
  const boardId = field("Board slug");
  const taskId = field("Task ID");
  const taskReason = field("Reviewer reason for accept");
  const todoList = node("div", "", "surface-list");
  const todoDetails = node("div", "", "surface-details");
  async function loadBoards() {
    const result = await c.todoBoards({ offset: 0, limit: 50 });
    todoList.replaceChildren();
    for (const item of result.items ?? []) {
      const slug = item.board_slug ?? item.slug;
      const label = `${slug} · ${item.title ?? "Todo Board"}`;
      const pick = c.available("todoBoard") && c.available("todoItems") ? button(label, async () => {
        boardId.control.value = slug;
        await loadBoard();
      }, "todoBoard") : node("p", label);
      todoList.append(pick);
    }
    message(todo, `${result.total ?? todoList.children.length} Todo Boards listed.`);
  }
  const boards = button("Load Boards", loadBoards, "todoBoards", todo);
  async function loadBoardTasks(slug) {
    const board = await c.todoBoard({ board_slug: slug });
    boardRecord = board;
    const result = await c.todoItems({ board_slug: slug, offset: 0, limit: 50, expected_digest: board.digest });
    todoList.replaceChildren();
    for (const entry of result.items ?? []) {
      const item = entry.item ?? entry;
      const label = `${item.title ?? item.id} · ${item.state ?? "unknown"} · ${item.ownerId ?? item.owner_id ?? "unassigned"}`;
      const pick = c.available("todoItem") ? button(label, async () => {
        taskId.control.value = item.id;
        await loadTask(slug, item.id);
      }, "todoItem") : node("p", label);
      todoList.append(pick);
    }
    message(todo, `${result.total ?? todoList.children.length} tasks listed from ${slug}.`);
  }
  const loadTasks = button("List tasks", () => loadBoardTasks(boardId.control.value),
    c.available("todoBoard") && c.available("todoItems") ? "todoItems" : "missingTodoBoard", todo);
  async function loadBoard() {
    const slug = boardId.control.value;
    await loadBoardTasks(slug);
  }
  async function loadTask(slug, id) {
    const epoch = ++boardEpoch;
    const result = await c.todoItem({ board_slug: slug, id });
    if (disposed || epoch !== boardEpoch) return;
    workItem = result.item ?? result;
    todoDetails.replaceChildren();
    todoDetails.append(node("h3", workItem.title ?? id));
    todoDetails.append(node("pre", JSON.stringify(workItem, null, 2), "literal-content"));
    const expectedDigest = result.digest ?? boardRecord?.digest;
    if (!(workItem.ownerId ?? workItem.owner ?? workItem.owner_id) && c.available("todoClaim")) {
      button("Claim task (authenticated Agent; focus checks apply)", async () => {
        await c.todoClaim({ operationId: uuid(), board_slug: slug, id, expected_digest: expectedDigest });
        message(todo, "Task claimed. If WORKITEM_FOCUS_CONFLICT is returned, explicitly hold or complete current work first.");
        await loadBoardTasks(slug);
      }, "todoClaim", todoDetails);
    }
    if ((workItem.state === "Done" || workItem.status === "completed" || workItem.state === "completed") && c.available("todoAccept")) {
      button("Accept completed task (delegated reviewer only)", async () => {
        await c.todoAccept({ operationId: uuid(), board_slug: slug, id, expected_digest: expectedDigest, reason: taskReason.control.value });
        message(todo, "Task acceptance recorded by the authenticated delegated reviewer.");
        await loadTask(slug, id);
      }, "todoAccept", todoDetails);
    }
    message(todo, `Task ${id} · state ${workItem.state ?? "unknown"} · owner ${workItem.owner_id ?? "unassigned"}`);
  }
  boardId.wrap.hidden = !c.available("todoBoards") && !c.available("todoItems");
  taskId.wrap.hidden = !c.available("todoItem");
  taskReason.wrap.hidden = !c.available("todoAccept");
  if (!c.available("todoBoards") && !c.available("todoItems")) todo.append(node("p", "Todo Board reads are unavailable in this server context."));
  else appendAvailable(todo, boardId.wrap, taskId.wrap, taskReason.wrap, boards, loadTasks, todoList, todoDetails);
  shell.append(todo);

  const workflow = section("workflow", "Workflow run");
  workflow.dataset.surfaceActive = "";
  const workflowId = field("Workflow run ID");
  const workflowResult = node("div", "", "surface-details");
  async function loadWorkflowRun() {
    const epoch = ++workflowEpoch;
    const runId = workflowId.control.value;
    const run = await c.workflowGet({ runId });
    if (disposed || epoch !== workflowEpoch) return;
    workflowRun = run;
    const events = c.available("workflowEvents")
      ? await c.workflowEvents({ runId, expectedVersion: run.version, after: 0, limit: 100 })
      : undefined;
    if (disposed || epoch !== workflowEpoch) return;
    workflowResult.replaceChildren(node("pre", JSON.stringify({ run, events }, null, 2), "literal-content"));
    if (!terminal.has(run.state) && c.available("workflowCancel")) {
      button("Cancel workflow run", async () => {
        if (!(options.confirm?.("Cancel this nonterminal workflow run?") ?? globalThis.confirm?.("Cancel this nonterminal workflow run?") ?? false)) return;
        const cancelled = await c.workflowCancel({ operationId: uuid(), runId, expectedVersion: run.version });
        workflowRun = cancelled;
        message(workflow, `Workflow state: ${cancelled.state}`);
        await loadWorkflowRun();
      }, "workflowCancel", workflowResult);
    }
    message(workflow, `Workflow ${runId} · ${run.state} · version ${run.version}` +
      (events ? events.nextAfter === null ? " · events through the latest retained record." : " · first 100 events shown; more are available." : " · event reads are unavailable."));
  }
  const loadWorkflow = button("Load workflow status and events", loadWorkflowRun, "workflowGet", workflow);
  if (c.available("workflowGet")) workflow.append(workflowId.wrap, loadWorkflow, workflowResult);
  else workflow.append(node("p", "Workflow run reads are unavailable in this server context."));
  shell.append(workflow);

  const action = section("action", "Action run");
  action.dataset.surfaceActive = "";
  const actionId = field("Action run ID");
  const actionResult = node("div", "", "surface-details");
  async function loadActionRun() {
    const epoch = ++actionEpoch;
    const runId = actionId.control.value;
    const run = await c.actionGet({ runId });
    if (disposed || epoch !== actionEpoch) return;
    actionRun = run;
    const events = c.available("actionEvents") ? await c.actionEvents({ runId, after: 0, limit: 100 }) : undefined;
    if (disposed || epoch !== actionEpoch) return;
    actionResult.replaceChildren(node("pre", JSON.stringify({ run, events }, null, 2), "literal-content"));
    if (!actionTerminal.has(run.state) && c.available("actionCancel")) {
      button("Cancel Action run", async () => {
        if (!(options.confirm?.("Cancel this Action run? Started side effects may have an unknown outcome.") ?? globalThis.confirm?.("Cancel this Action run? Started side effects may have an unknown outcome.") ?? false)) return;
        const cancelled = await c.actionCancel({ operationId: uuid(), runId, expectedVersion: run.version });
        actionRun = cancelled;
        message(action, `Action state: ${cancelled.state}`);
        await loadActionRun();
      }, "actionCancel", actionResult);
    }
    message(action, `Action ${runId} · ${run.state} · version ${run.version}` +
      (events?.gap ? " · event retention gap; earlier events may be missing." :
        events ? " · bounded events shown." : " · event reads are unavailable."));
  }
  const loadAction = button("Load Action status and events", loadActionRun, "actionGet", action);
  if (c.available("actionGet")) action.append(actionId.wrap, loadAction, actionResult);
  else action.append(node("p", "Action run status is unavailable; this host has no Action runtime capability."));
  shell.append(action);

  if (c.available("uploadList")) void run(async () => {
    const state = await c.uploadList({});
    uploads = state.items ?? [];
  });
  if (c.available("knowledgeList")) void run(loadDocuments, knowledge);
  if (c.available("todoBoards")) void run(loadBoards, todo);

  return {
    sections: Object.freeze(["knowledge", "todo", "workflow", "action"]),
    dispose() {
      if (disposed) return;
      disposed = true;
      docEpoch++; boardEpoch++; workflowEpoch++; actionEpoch++;
      for (const cleanup of cleanups) cleanup();
      root.replaceChildren();
    },
    refresh: Object.freeze({
      knowledge: loadDocuments,
      todo: loadBoards,
      workflow: loadWorkflowRun,
      action: loadActionRun,
    }),
    state: () => ({ documentId: documentRecord?.id, metadataRevision: metadataRecord?.revision,
      board: boardRecord?.board_slug, taskId: workItem?.id, workflowRunId: workflowRun?.runId,
      actionRunId: actionRun?.runId, activeUploads: uploads.length, disposed }),
  };
}
