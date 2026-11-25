// @ts-check
import { ProtocolClient, ProtocolError, LiveFeed, OPERATIONS } from "./protocol.mjs";
import { WORKFLOW_SURFACE_OPERATIONS, createWorkflowSurfaceClient, mountWorkflowSurfaces } from "./workflow-surfaces.mjs";
import { KNOWLEDGE_LIFECYCLE_OPERATIONS, createKnowledgeLifecycleClient, mountKnowledgeLifecycle } from "./knowledge-lifecycle.mjs";

/**
 * @typedef {{id:string,title:string,revision:number,archivedAt?:string|null}} ChatSession
 * @typedef {{id:string,sessionId:string,status:string,revision:number,output:string,failure?:string|null,contextDigest?:string}} ChatTurn
 * @typedef {{taskId:string,title?:string,state:string,definition?:{taskId:string,title:string},attempts?:Record<string,any>[]}} ManagerTask
 * @typedef {{schema:string,runId:string,projectId:string,version:number,state:string,phase:string,contract?:{objective:string},goal?:string,updatedAt?:number|string,updatedTime?:number,tasks?:ManagerTask[],budget?:Record<string,any>,checks?:unknown,feedback?:{state:string}[],freshness?:string,lastHeartbeatAt?:string}} ManagerRun
 * @typedef {{nextOffset:number|null,workspaceRevision:string}} KnowledgePage
 * @typedef {{nextCursor:string|null}} ChatPage
 */
/** @param {unknown} value */
function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
/** @param {unknown} value */
function timestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toLocaleString();
}
/** Safe literal Markdown/source view. @param {Document} document @param {unknown} content */
export function renderText(document, content) {
  const pre = document.createElement("pre");
  pre.className = "literal-content";
  pre.textContent = text(content);
  return pre;
}

/**
 * @param {HTMLElement} root
 * @param {{client?:ProtocolClient,operations?:Record<string,{operation:string,readOnly:boolean}>,intervalMs?:number}} [config]
 */
export function mount(root, config = {}) {
  const document = root.ownerDocument;
  const client = config.client ?? new ProtocolClient({ operations: { ...OPERATIONS, ...WORKFLOW_SURFACE_OPERATIONS, ...KNOWLEDGE_LIFECYCLE_OPERATIONS, ...config.operations } });
  let workflowSurfaces;
  let knowledgeLifecycle;
  /** @type {(() => void)[]} */
  const listeners = [];
  /** @type {WeakMap<HTMLElement,()=>unknown>} */
  const actions = new WeakMap();
  /** @type {WeakSet<HTMLElement>} */
  const busyActions = new WeakSet();
  /** @type {LiveFeed[]} */
  let feeds = [];
  let disposed = false;
  let connected = false;
  let epoch = 0;
  let sourceSelection = 0;
  let chatSelection = 0;
  let runSelection = 0;
  /** @type {ChatSession|null} */
  let session = null;
  let chatLoading = false;
  let chatReady = false;
  /** @type {ChatTurn|null} */
  let turn = null;
  /** @type {ManagerRun|null} */
  let run = null;
  /** @type {{kind:string,taskId?:string,attemptId?:string,resultId?:string}|null} */
  let feedbackTarget = null;
  /** @type {KnowledgePage|null} */
  let knowledgePage = null;
  /** @type {ChatPage|null} */
  let chatPage = null;
  /** @type {Map<string,HTMLElement>} */
  const results = new Map();
  /** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} [content] @param {string} [className] @returns {HTMLElementTagNameMap[T]} */
  function node(tag, content = "", className = "") {
    const element = document.createElement(tag);
    if (content) element.textContent = content;
    if (className) element.className = className;
    return element;
  }
  /** @param {HTMLElement} element @param {string} event @param {(event:Event)=>void} handler */
  function listen(element, event, handler) {
    element.addEventListener(event, handler);
    listeners.push(() => element.removeEventListener(event, handler));
  }
  /** @param {string} label @param {()=>unknown} action @param {string} [capability] */
  function button(label, action, capability) {
    const element = node("button", label);
    element.type = "button";
    if (capability) {
      element.dataset.capability = capability;
      element.disabled = true;
    }
    actions.set(element, action);
    return element;
  }
  /** @param {string} label @param {"input"|"textarea"} [kind] @param {string} [placeholder] */
  function field(label, kind = "input", placeholder = "") {
    const wrapper = node("label", "", "field");
    const input = node(kind);
    input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    wrapper.append(node("span", label), input);
    return { wrapper, input };
  }
  /** @param {string} label */
  function details(label) {
    const element = node("details");
    element.append(node("summary", label));
    return element;
  }
  /** @param {HTMLElement} parent @param {HTMLElement} child @param {number} [limit] */
  function boundedAppend(parent, child, limit = 100) {
    parent.append(child);
    while (parent.children.length > limit) parent.firstElementChild?.remove();
  }
  const shell = node("div", "", "workspace");
  root.replaceChildren(shell);
  listen(shell, "click", event => {
    let target = /** @type {HTMLElement|null} */ (event.target);
    while (target && target !== shell) {
      const action = actions.get(target);
      if (action) {
        if (!("disabled" in target) || !target.disabled) {
          const active = target;
          busyActions.add(active);
          if ("disabled" in active) active.disabled = true;
          void execute(action).finally(() => { busyActions.delete(active); updateActions(); });
        }
        return;
      }
      target = target.parentElement;
    }
  });
  const header = node("header", "", "masthead");
  const brand = node("div");
  brand.append(node("p", "PKM / NATIVE WORKSPACE", "eyebrow"), node("h1", "Knowledge, in motion."));
  const connection = node("form", "", "connection");
  const tokenField = field("Access token", "input", "Held in memory only");
  const token = /** @type {HTMLInputElement} */ (tokenField.input);
  token.type = "password";
  token.autocomplete = "off";
  token.spellcheck = false;
  const connect = node("button", "Connect");
  connect.type = "submit";
  const disconnect = button("Disconnect", () => disconnectWorkspace());
  connection.append(tokenField.wrapper, connect, disconnect);
  header.append(brand, connection);
  const status = node("p", "Disconnected · authenticate with this server's token", "connection-status");
  status.setAttribute("role", "status");
  const error = node("p", "", "error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  shell.append(header, status, error);
  const retryMutation = button("Retry identical pending operation", recoverMutation);
  retryMutation.hidden = true;
  const pendingWarning = node("p", "", "error");
  pendingWarning.setAttribute("role", "alert");
  pendingWarning.hidden = true;
  const checkReceipts = button("Check durable write receipts", reconcilePendingWrites, "receiptGet");
  checkReceipts.hidden = true;
  shell.append(retryMutation, pendingWarning, checkReceipts);
  const navigation = node("nav", "", "section-navigation");
  navigation.setAttribute("aria-label", "Workspace sections");
  for (const [id, label] of [["knowledge", "Knowledge"], ["knowledge-lifecycle", "Lifecycle"], ["chat", "Chats"], ["manager", "Manager"]]) {
    const link = node("a", label);
    link.href = `#${id}`;
    navigation.append(link);
  }
  shell.append(navigation);
  const main = node("main", "", "workbench");
  const knowledge = node("section", "", "knowledge-panel panel");
  knowledge.id = "knowledge";
  knowledge.setAttribute("aria-label", "Knowledge");
  const knowledgeHeading = node("div", "", "section-heading");
  knowledgeHeading.append(node("h2", "Knowledge"), button("Refresh", async () => loadKnowledge(), "knowledgeList"));
  const knowledgeItems = node("div", "", "item-list");
  const source = node("article", "", "source-preview");
  source.append(node("p", "Select a document to read its original text. Embedded HTML and remote resources stay inert.", "muted"));
  const moreKnowledge = button("More documents", async () => loadKnowledge(true), "knowledgeList");
  moreKnowledge.hidden = true;
  knowledge.append(knowledgeHeading, knowledgeItems, moreKnowledge, source);
  const chat = node("section", "", "chat-panel panel");
  chat.id = "chat";
  chat.setAttribute("aria-label", "Chats");
  const chatHeading = node("div", "", "section-heading");
  chatHeading.append(node("h2", "Chats"), button("New Chat", createChat, "chatCreate"));
  let includeArchivedChats = false;
  const archivedChats = button("Show archived", async () => {
    includeArchivedChats = !includeArchivedChats;
    archivedChats.setAttribute("aria-pressed", String(includeArchivedChats));
    archivedChats.textContent = includeArchivedChats ? "Hide archived" : "Show archived";
    await loadChats();
  }, "chatList");
  archivedChats.setAttribute("aria-pressed", "false");
  chatHeading.append(archivedChats);
  const chats = node("div", "", "item-list chat-list");
  const moreChats = button("More chats", async () => loadChats(true), "chatList");
  moreChats.hidden = true;
  const messages = node("div", "", "messages");
  messages.setAttribute("aria-label", "Messages");
  const chatState = node("p", "Choose a Chat to load its server-owned transcript and turn state.", "muted");
  chatState.setAttribute("role", "status");
  const composer = node("form", "", "composer");
  const promptField = field("Message", "textarea", "Ask a question");
  promptField.input.maxLength = 16000;
  /** @type {HTMLTextAreaElement} */ (promptField.input).rows = 3;
  const send = node("button", "Send");
  send.type = "submit";
  send.dataset.capability = "chatStart";
  send.disabled = true;
  const cancelTurn = button("Cancel turn", cancelChat, "chatCancel");
  const archiveChatButton = button("Archive Chat", archiveChat, "chatArchive");
  const reconnectChat = button("Reconnect updates", () => session && selectChat(session.id), "chatTurns");
  composer.append(promptField.wrapper, send, cancelTurn, reconnectChat, archiveChatButton);
  const chatEvidence = details("Context, permissions & execution evidence");
  const chatEvidenceState = node("p", "Select a turn to read its native context and execution evidence.", "muted");
  const chatEvidenceBody = node("div");
  const refreshEvidence = button("Refresh Chat evidence", loadChatEvidence, "chatEvents");
  chatEvidence.append(chatEvidenceState,
    node("p", "Evidence is read-only. Source text and tool output never grant permissions or human approval. Native review remains a separate authenticated surface.", "muted"),
    refreshEvidence, chatEvidenceBody);
  /** @type {Map<number,Record<string,any>>} */
  const chatEvidenceEvents = new Map();
  chat.append(chatHeading, chats, moreChats, chatState, messages, composer, chatEvidence);
  const manager = node("section", "", "manager-panel panel");
  manager.id = "manager";
  manager.setAttribute("aria-label", "Manager");
  manager.append(node("p", "PROJECT CONTROL / LIVE DELIVERY", "eyebrow"), node("h2", "Manager"));
  const attachForm = node("form", "", "run-controls");
  const projectField = field("Project ID", "input", "Exact native project ID");
  const runField = field("Run ID", "input", "Existing run ID, or leave empty for a new run");
  const attach = node("button", "Open run");
  attach.type = "submit";
  attach.dataset.capability = "managerGet";
  attach.disabled = true;
  attachForm.append(projectField.wrapper, runField.wrapper, attach);
  const overview = node("div", "", "pinned-overview");
  const managerState = node("p", "No run selected · nothing has been started.", "muted");
  managerState.setAttribute("role", "status");
  const overviewBody = node("div");
  overview.append(node("h3", "Current project"), overviewBody, managerState);
  overviewBody.append(node("p", "Doing / completed / remaining / blockers appear from native run state.", "muted"));
  const acceptanceNotice = node("p", "Delivery ≠ verification ≠ E2E acceptance. Intermediate results do not mean the instruction is finished.", "acceptance-note");
  const resultFeed = node("div", "", "result-feed");
  resultFeed.setAttribute("aria-label", "Live intermediate results");
  resultFeed.append(node("p", "Waiting for native artifacts and results. No generated examples.", "empty-results"));
  const feedbackForm = node("form", "", "feedback-form");
  const targetField = field("Worker task ID (optional)", "input", "Leave empty to address the Manager");
  const feedbackField = field("Feedback to Manager", "textarea", "Clarify or redirect at the next safe checkpoint");
  /** @type {HTMLTextAreaElement} */ (feedbackField.input).rows = 2;
  feedbackField.input.maxLength = 4000;
  const feedback = node("button", "Send feedback");
  feedback.type = "submit";
  feedback.dataset.capability = "managerFeedback";
  feedback.disabled = true;
  const feedbackState = node("p", "Feedback does not cancel the run or other workers.", "muted");
  feedbackState.setAttribute("role", "status");
  feedbackForm.append(targetField.wrapper, feedbackField.wrapper, feedback, feedbackState);
  const activity = details("Detailed activity & child tasks");
  const tasks = node("div", "", "task-tree");
  const activityList = node("ol", "", "activity-list");
  activity.append(node("p", "Latest 200 activity entries. The primary result feed retains the latest 100 artifacts; full history remains in native events.", "muted"), tasks, activityList);
  const runActions = node("div", "", "run-actions");
  runActions.append(button("Reconnect updates", () => feeds.forEach(feed => feed.reconnect()), "managerEvents"),
    button("Cancel this run", cancelRun, "managerCancel"));
  const newRun = details("Plan / start a native instruction");
  const startForm = node("form", "", "start-form");
  const contractField = field("Completion contract (JSON)", "textarea",
    "Paste a pkm.manager.completion/v1 contract with objective, scope, acceptance and explicit E2E verification.");
  /** @type {HTMLTextAreaElement} */ (contractField.input).rows = 7;
  contractField.input.maxLength = 60000;
  const budgetField = field("Worker budget (JSON)", "textarea",
    '{"maxWorkers":4,"maxConcurrentWorkers":2,"maxTasks":16,"maxAttemptsPerTask":2}');
  /** @type {HTMLTextAreaElement} */ (budgetField.input).rows = 2;
  budgetField.input.maxLength = 2000;
  const start = node("button", "Plan and start");
  start.type = "submit";
  start.dataset.capability = "managerStart";
  start.disabled = true;
  startForm.append(node("p", "Native planning validates this contract before scheduling. No browser-created plans, verification claims, or implied approvals.", "muted"),
    contractField.wrapper, budgetField.wrapper, start);
  newRun.append(startForm);
  manager.append(attachForm, overview, acceptanceNotice, node("h3", "Intermediate results"), resultFeed, feedbackForm, runActions, activity, newRun);
  main.append(knowledge, chat, manager);
  const capabilities = details("Native capability availability");
  const capabilityList = node("ul");
  capabilities.append(capabilityList);
  shell.append(main, capabilities, node("footer", "Isolated shared-server client · same origin · no token storage · no external resources"));

  function updateActions() {
    for (const element of shell.querySelectorAll("button[data-capability]")) {
      const key = /** @type {HTMLElement} */ (element).dataset.capability ?? "";
      const blocked = client.pendingMutations();
      const pending = blocked.includes(key) || (key === "managerFeedback" && blocked.includes("managerProgressFeedback"));
      /** @type {HTMLButtonElement} */ (element).disabled = !connected || !capabilityAvailable(key) ||
        busyActions.has(/** @type {HTMLElement} */ (element)) || pending ||
        (key === "managerCancel" && (!run || terminal(run.state)));
    }
    send.disabled ||= !session || !chatReady || chatLoading || !chatContinuityAvailable();
    send.disabled ||= chatSubmitting || (turn !== null && !terminal(turn.status));
    send.disabled ||= !!session?.archivedAt;
    cancelTurn.disabled ||= !turn || terminal(turn.status);
    archiveChatButton.disabled ||= !session || !!session.archivedAt || chatLoading || !chatReady ||
      (turn !== null && !terminal(turn.status));
    reconnectChat.disabled ||= !session || chatLoading;
    refreshEvidence.disabled ||= !turn || chatLoading;
    feedback.disabled ||= !run || feedbackSubmitting;
    start.disabled ||= managerSubmitting;
    retryMutation.hidden = !connected || client.pendingMutations().length === 0;
    retryMutation.disabled = busyActions.has(retryMutation) || !client.pendingMutations().some(key => client.canRetryMutation(key));
    retryMutation.title = retryMutation.disabled
      ? "Pending operations require the original workspace and actor, with no request still in flight." : "";
    const recovery = client.mutationRecovery?.();
    checkReceipts.hidden = !connected || !recovery || (!recovery.blocked && recovery.markers.length === 0);
    checkReceipts.disabled ||= !!recovery?.blocked || !recovery?.markers.length;
    pendingWarning.hidden = !connected || !recovery || (!recovery.blocked && recovery.markers.length === 0);
    pendingWarning.textContent = recovery?.blocked
      ? "Write safety journal unavailable or invalid. Writes are blocked; reads remain available. No operation was automatically replayed."
      : recovery?.markers.length
        ? `Unresolved write pins: ${recovery.markers.map(marker => `${marker.operation} · ${marker.operationId} · SHA-256 ${marker.bodySha256}`).join("; ")}. Reload preserves only these nonsecret pins, not request bodies. Replacement writes remain blocked. ${client.available("receiptGet") ? "Check durable write receipts explicitly. Only a matching committed receipt unlocks the operation." : "This server does not expose actor-private receipt lookup."} Pending or unknown: give these UUID and SHA-256 pins to the authenticated server manager/operator for native reconciliation, then check again. Do not clear browser storage or reset the workspace. No automatic replay.`
        : "";
  }
  /** @param {string} key */
  function capabilityAvailable(key) {
    /** @type {Record<string,string>} */
    const projected = { managerGet: "managerProgressGet", managerEvents: "managerProgressEvents", managerFeedback: "managerProgressFeedback" };
    return client.available(key) || client.available(projected[key] ?? key);
  }
  function managerReadKey() { return client.available("managerProgressGet") ? "managerProgressGet" : "managerGet"; }
  /** @param {Record<string,any>} snapshot @returns {ManagerRun} */
  function normalizeRun(snapshot) {
    if (snapshot.schema !== "pkm.manager.progress/v1") return /** @type {ManagerRun} */ (snapshot);
    /** @type {Record<string,string>} */
    const states = { doing: "running", completed: "accepted", remaining: "pending" };
    const tasks = ["doing", "completed", "remaining"].flatMap(group => snapshot[group].map((/** @type {ManagerTask} */ task) => ({
      ...task, state: states[group],
    })));
    tasks.push(...snapshot.blockers.map((/** @type {{taskId?:string,id:string,label:string}} */ blocker) =>
      ({ taskId: blocker.taskId ?? blocker.id, title: blocker.label, state: "blocked" })));
    return /** @type {ManagerRun} */ ({ ...snapshot, phase: snapshot.phase.label, tasks });
  }
  /** @param {string} state */
  function terminal(state) {
    return ["completed", "succeeded", "cancelled", "canceled", "failed", "interrupted", "unknown", "accepted"].includes(state);
  }
  /** @param {()=>unknown} action */
  async function execute(action) {
    if (disposed) return;
    const current = epoch;
    error.hidden = true;
    try { await action(); }
    catch (failure) {
      if (disposed || epoch !== current) return;
      error.textContent = failure instanceof ProtocolError ? failure.message : "Invalid input or native response. Check the contract and refresh.";
      error.hidden = false;
      if (!connected) {
        client.disconnect();
        status.textContent = "Disconnected · authentication or bootstrap failed";
      }
    } finally { if (!disposed && current === epoch) updateActions(); }
  }
  function stopFeeds() { feeds.forEach(feed => feed.dispose()); feeds = []; }
  function disconnectWorkspace() {
    epoch++;
    connected = false;
    workflowSurfaces?.dispose();
    workflowSurfaces = undefined;
    knowledgeLifecycle?.dispose();
    knowledgeLifecycle = undefined;
    stopFeeds();
    client.disconnect();
    token.value = "";
    session = turn = run = knowledgePage = chatPage = null;
    chatSelection++;
    chatLoading = false;
    chatReady = false;
    feedbackTarget = null;
    results.clear();
    for (const element of [knowledgeItems, chats, messages, overviewBody, tasks, activityList, capabilityList]) element.replaceChildren();
    source.replaceChildren(node("p", "Authenticate to read Knowledge.", "muted"));
    resultFeed.replaceChildren(node("p", "No run selected.", "empty-results"));
    for (const input of [promptField.input, contractField.input, budgetField.input, feedbackField.input, targetField.input, projectField.input, runField.input]) input.value = "";
    status.textContent = "Disconnected · token cleared";
    chatState.textContent = "No Chat selected.";
    managerState.textContent = "No run selected.";
    feedbackState.textContent = "Feedback does not cancel the run or other workers.";
    moreKnowledge.hidden = moreChats.hidden = true;
    error.hidden = true;
    updateActions();
  }
  listen(connection, "submit", event => {
    event.preventDefault();
    if (connect.disabled) return;
    const secret = token.value;
    disconnectWorkspace();
    connect.disabled = true;
    const current = epoch;
    void execute(async () => {
      client.authenticate(secret);
      status.textContent = "Authenticating / checking native capabilities";
      await client.bootstrap();
      if (disposed || current !== epoch) return;
      connected = true;
      if (Object.keys(KNOWLEDGE_LIFECYCLE_OPERATIONS).every(key => Object.hasOwn(client.operations, key))) {
        const lifecycleRoot = node("section");
        lifecycleRoot.id = "knowledge-lifecycle";
        shell.append(lifecycleRoot);
        const mounted = mountKnowledgeLifecycle(lifecycleRoot, createKnowledgeLifecycleClient(client));
        knowledgeLifecycle = { dispose() { mounted.dispose(); lifecycleRoot.remove(); } };
      }
      if (Object.keys(WORKFLOW_SURFACE_OPERATIONS).every(key => Object.hasOwn(client.operations, key))) {
        const surfaceRoot = node("section");
        shell.append(surfaceRoot);
        const mounted = mountWorkflowSurfaces(surfaceRoot, { client: createWorkflowSurfaceClient(client),
          onError: failure => { void execute(() => { throw failure; }); } });
        workflowSurfaces = { dispose() { mounted.dispose(); surfaceRoot.remove(); } };
      }
      status.textContent = "Connected · isolated shared server";
      for (const key of Object.keys(client.operations)) {
        capabilityList.append(node("li", `${key} · ${client.available(key) ? "available" : "capability unavailable"}`));
      }
      updateActions();
      if (!client.available("chatStart")) chatState.textContent = "Chat generation capability unavailable · native provider is not configured or authorized.";
      if (!capabilityAvailable("managerGet")) managerState.textContent = "Manager capability unavailable · native runtime is not configured or authorized.";
      await Promise.all([client.available("knowledgeList") ? loadKnowledge() : Promise.resolve(),
        client.available("chatList") ? loadChats() : Promise.resolve()]);
    }).finally(() => { connect.disabled = false; });
  });
  async function loadKnowledge(more = false) {
    const current = epoch;
    const page = await client.call("knowledgeList", more && knowledgePage ? {
      offset: knowledgePage.nextOffset, workspaceRevision: knowledgePage.workspaceRevision, limit: 20,
    } : { limit: 20 });
    if (disposed || epoch !== current) return;
    if (!more) knowledgeItems.replaceChildren();
    if (!Array.isArray(page.items)) throw new ProtocolError("INVALID_RESPONSE");
    knowledgePage = /** @type {KnowledgePage} */ (page);
    for (const item of page.items) {
      const open = button(text(item.title), async () => {
        const current = epoch;
        const selected = ++sourceSelection;
        const record = await client.call("knowledgeGet", { id: item.id });
        if (disposed || current !== epoch || selected !== sourceSelection) return;
        source.replaceChildren(node("h3", text(record.title)), node("p", `Revision ${record.revision} · ${record.area ?? "knowledge"} / ${record.path ?? record.id}`, "muted"),
          renderText(document, record.content));
      }, "knowledgeGet");
      knowledgeItems.append(open);
    }
    if (!page.items.length && !more) knowledgeItems.append(node("p", "No Knowledge documents found.", "muted"));
    moreKnowledge.hidden = page.nextOffset === null;
    updateActions();
  }
  async function loadChats(more = false) {
    const current = epoch;
    const page = await client.call("chatList", { limit: 20, includeArchived: includeArchivedChats,
      ...(more && chatPage?.nextCursor ? { cursor: chatPage.nextCursor } : {}) });
    if (disposed || current !== epoch) return;
    if (!more) chats.replaceChildren();
    if (!Array.isArray(page.items)) throw new ProtocolError("INVALID_RESPONSE");
    chatPage = /** @type {ChatPage} */ (page);
    for (const item of page.items) chats.append(button(text(item.title), () => selectChat(item.id), "chatGet"));
    if (!page.items.length && !more) chats.append(node("p", "No Chats yet.", "muted"));
    moreChats.hidden = page.nextCursor === null;
    updateActions();
  }
  async function createChat() {
    const current = epoch;
    const created = await client.call("chatCreate", { id: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: 0, title: "New Chat" });
    if (disposed || current !== epoch) return;
    await loadChats();
    await selectChat(created.id);
  }
  /** @type {LiveFeed|null} */
  let chatFeed = null;
  /** @type {LiveFeed|null} */
  let managerFeed = null;
  /** @param {LiveFeed|null} old @param {LiveFeed} replacement */
  function replaceFeed(old, replacement) {
    old?.dispose();
    feeds = feeds.filter(feed => feed !== old);
    feeds.push(replacement);
    return replacement;
  }
  /** @param {string} id */
  async function selectChat(id) {
    chatFeed?.dispose();
    const selected = ++chatSelection;
    session = null;
    turn = null;
    chatLoading = true;
    chatReady = false;
    messages.replaceChildren();
    chatEvidenceEvents.clear();
    chatEvidenceBody.replaceChildren();
    chatEvidenceState.textContent = "Reading server-owned turn evidence.";
    chatState.textContent = "Loading server transcript and turns";
    updateActions();
    const current = epoch;
    try { await refreshChat(id, selected, current); }
    finally {
      if (current === epoch && selected === chatSelection) { chatLoading = false; updateActions(); }
    }
  }
  function chatContinuityAvailable() {
    return ["chatGet", "chatMessages", "chatTurns", "chatTurn", "chatEvents"].every(key => client.available(key));
  }
  /** @param {string} id @param {number} selected @param {number} current @param {number} [attempt] */
  async function refreshChat(id, selected, current, attempt = 0) {
    const active = () => !disposed && current === epoch && selected === chatSelection;
    chatReady = false;
    if (!chatContinuityAvailable()) {
      if (active()) chatState.textContent = "Chat continuity capability unavailable · server transcript and turn reads are required.";
      return;
    }
    const before = await client.call("chatGet", { id });
    if (!active()) return;
    /** @type {{role:string,content:unknown,status?:string}[]} */
    const transcript = [];
    /** @type {ChatTurn[]} */
    const turns = [];
    let after;
    for (let count = 0; count < 100; count++) {
      const page = await client.call("chatTurns", { sessionId: id, limit: 20, ...(after ? { after } : {}) });
      if (!active()) return;
      if (!Array.isArray(page.items) || (page.next !== null && (typeof page.next !== "string" || page.next === after)))
        throw new ProtocolError("INVALID_RESPONSE");
      turns.push(...page.items);
      if (page.next === null) break;
      after = page.next;
      if (count === 99) throw new ProtocolError("TURN_PAGE_LIMIT");
    }
    let cursor;
    // Read turns first so a terminal turn's atomically committed observation is included below.
    for (let count = 0; count < 100; count++) {
      const page = await client.call("chatMessages", { id, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!active()) return;
      if (!Array.isArray(page.items)) throw new ProtocolError("INVALID_RESPONSE");
      transcript.push(...page.items);
      if (!page.hasMore) break;
      if (typeof page.nextCursor !== "string" || page.nextCursor === cursor) throw new ProtocolError("INVALID_CURSOR");
      cursor = page.nextCursor;
      if (count === 99) throw new ProtocolError("TRANSCRIPT_PAGE_LIMIT");
    }
    const record = await client.call("chatGet", { id });
    if (!active()) return;
    if (before.revision !== record.revision) {
      if (attempt >= 3) throw new ProtocolError("CHAT_CHANGED_RECONNECT_REQUIRED");
      return refreshChat(id, selected, current, attempt + 1);
    }
    if (record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        turns.some(item => item.sessionId !== id)) throw new ProtocolError("INVALID_RESPONSE");
    session = /** @type {ChatSession} */ (record);
    chatReady = true;
    turn = turns.find(item => !terminal(item.status)) ?? turns.at(-1) ?? null;
    messages.replaceChildren();
    for (const message of transcript) addMessage(message.role, message.content, message.status);
    chatState.textContent = `${record.title} · ${turn ? turnStatus(turn) :
      client.available("chatStart") ? "ready" : "generation capability unavailable · model/provider not configured or authorized"}`;
    if (turn && !terminal(turn.status)) watchTurn(turn);
    else if (!client.available("chatStart")) chatState.textContent += " · generation capability unavailable";
    if (record.archivedAt) chatState.textContent += " · archived · transcript is read-only";
    await loadChatEvidence();
    updateActions();
  }
  /** @param {Record<string,any>[]} events */
  function renderChatEvidence(events) {
    for (const event of events) {
      if (["start", "model-intent", "model-complete", "tool-intent", "approval", "tool-complete", "failed", "interrupted", "cancel", "complete"].includes(event.type)) {
        chatEvidenceEvents.set(event.sequence, event);
      }
    }
    chatEvidenceBody.replaceChildren();
    if (turn) chatEvidenceBody.append(node("p", `Turn ${turn.id} · context digest ${text(turn.contextDigest ?? "not reported")}`, "muted"));
    const observed = [...chatEvidenceEvents.values()].sort((a, b) => a.sequence - b.sequence);
    for (const event of observed.slice(-100)) {
      const item = details(`${event.sequence} · ${event.type}`);
      item.append(renderText(document, event.data));
      const resource = event.data?.evidence?.resource;
      if (resource?.kind === "manager-run" && typeof resource.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(resource.id)) {
        item.append(button(`Open Manager evidence · ${resource.id}`, async () => {
          const snapshot = await client.call(managerReadKey(), { runId: resource.id });
          await watchRun(normalizeRun(snapshot));
          manager.scrollIntoView?.({ block: "start" });
        }, "managerGet"));
      }
      chatEvidenceBody.append(item);
    }
    if (observed.length > 100) chatEvidenceBody.prepend(node("p", "Latest 100 evidence entries shown. Full immutable events remain available through chat.turn.events.", "muted"));
  }
  async function loadChatEvidence() {
    if (!turn) { chatEvidenceState.textContent = "No accepted turn selected."; return; }
    const id = turn.id, selected = chatSelection, current = epoch;
    const active = () => !disposed && current === epoch && selected === chatSelection && turn?.id === id;
    try {
      let after = 0;
      for (let count = 0; count < 32; count++) {
        const page = await client.call("chatEvents", { id, after, limit: 100 });
        if (!active()) return;
        if (!Array.isArray(page.events)) throw new ProtocolError("INVALID_RESPONSE");
        renderChatEvidence(page.events);
        if (page.next === null) break;
        if (!Number.isSafeInteger(page.next) || page.next <= after || count === 31) throw new ProtocolError("EVIDENCE_PAGE_LIMIT");
        after = page.next;
      }
      let availability = "Runtime semantic retrieval capability unavailable; no fallback engine was substituted.";
      if (client.available("retrievalAvailability")) {
        const observed = await client.call("retrievalAvailability", {});
        if (!active()) return;
        availability = observed.available === true
          ? `Runtime retrieval index ${text(observed.indexId)} · model ${text(observed.model?.id)} @ ${text(observed.model?.revision)}.`
          : "Runtime semantic retrieval unavailable; no fallback engine was substituted.";
      }
      chatEvidenceState.textContent = `${availability} Runtime availability is not a claim that retrieval was injected into this turn; consult its recorded sessionContext and prompt digest.`;
    } catch (failure) {
      if (active()) chatEvidenceState.textContent = `Evidence unavailable · ${failure instanceof ProtocolError ? failure.code : "READ_FAILED"}. No evidence or authority was invented.`;
    }
  }
  /** @param {ChatTurn} record */
  function turnStatus(record) {
    return `Turn ${record.status}${record.failure ? " · " + record.failure : ""}${record.status === "cancelled" ? " · in-flight effects may require inspection" : ""}`;
  }
  /** @param {string} role @param {unknown} content @param {string} [state] */
  function addMessage(role, content, state = "") {
    const message = node("article", "", "message");
    message.append(node("p", `${role} ${state ? "· " + state : ""}`, "eyebrow"), renderText(document, content));
    messages.append(message);
    return message;
  }
  let chatSubmitting = false;
  listen(composer, "submit", event => {
    event.preventDefault();
    if (!session || chatSubmitting || send.disabled) return;
    chatSubmitting = true;
    send.disabled = true;
    void execute(async () => {
      if (!session) throw new ProtocolError("CHAT_REQUIRED");
      const content = promptField.input.value.trim();
      if (!content) throw new ProtocolError("MESSAGE_REQUIRED");
      const sessionId = session.id;
      const selected = chatSelection;
      const current = epoch;
      const record = await client.call("chatStart", { id: crypto.randomUUID(), sessionId,
        operationId: crypto.randomUUID(), expectedRevision: 0, expectedSessionRevision: session.revision,
        messages: [{ role: "user", content }], maxSteps: 4, maxOutputTokens: 4096,
        maxInputTokens: 65536, maxTotalOutputTokens: 16384, deadlineMs: 120000 });
      if (disposed || current !== epoch || selected !== chatSelection || session?.id !== sessionId) return;
      promptField.input.value = "";
      turn = /** @type {ChatTurn} */ (record);
      chatLoading = true;
      try { await refreshChat(sessionId, selected, current); }
      finally { if (current === epoch && selected === chatSelection) chatLoading = false; }
    }).finally(() => { chatSubmitting = false; updateActions(); });
  });
  /** @param {ChatTurn} record */
  function watchTurn(record) {
      chatFeed?.dispose();
      turn = record;
      const selected = chatSelection;
      const current = epoch;
      const active = () => !disposed && epoch === current && selected === chatSelection && turn?.id === record.id;
      const output = addMessage("assistant", record.output, record.status);
      output.dataset.liveTurn = record.id;
      chatFeed = replaceFeed(chatFeed, new LiveFeed({
        intervalMs: config.intervalMs,
        read: async (after, signal) => {
          const [page, snapshot] = await Promise.all([client.call("chatEvents", { id: record.id, after, limit: 100 }, signal),
            client.call("chatTurn", { id: record.id }, signal)]);
          if (snapshot.id !== record.id || snapshot.sessionId !== record.sessionId) throw new ProtocolError("INVALID_RESPONSE");
          if (!signal.aborted && active()) {
            turn = /** @type {ChatTurn} */ (snapshot);
            renderChatEvidence(page.events);
            output.replaceChildren(node("p", `assistant · ${snapshot.status}`, "eyebrow"), renderText(document, snapshot.output));
            if (terminal(snapshot.status)) {
              chatLoading = true;
              updateActions();
              try { await refreshChat(record.sessionId, selected, current); }
              finally {
                if (current === epoch && selected === chatSelection) { chatLoading = false; updateActions(); }
              }
            }
            updateActions();
          }
          const next = page.events.length ? page.events[page.events.length - 1].sequence : after;
          return { events: page.events, next, more: page.next !== null, terminal: terminal(snapshot.status) && page.next === null };
        },
        event: () => {},
        status: value => { if (active()) chatState.textContent = `${turnStatus(/** @type {ChatTurn} */ (turn))} · ${value}`; },
      }));
      chatFeed.start();
  }
  async function recoverMutation() {
    const key = client.pendingMutations().find(key => client.canRetryMutation(key));
    if (!key) return;
    const current = epoch;
    const recovered = await client.retryMutation(key);
    if (disposed || current !== epoch) return;
    error.hidden = true;
    if (key === "chatCreate") {
      await loadChats();
      await selectChat(recovered.result.id);
    } else if (key === "chatStart") {
      if (session?.id === recovered.arguments.sessionId &&
          promptField.input.value.trim() === recovered.arguments.messages[0].content) promptField.input.value = "";
      await selectChat(recovered.arguments.sessionId);
    } else if (key === "chatCancel") {
      await selectChat(recovered.result.sessionId);
    } else if (key === "chatArchive") {
      await loadChats();
      await selectChat(recovered.result.id);
    } else if (key.startsWith("manager")) {
      const snapshot = key === "managerProgressFeedback"
        ? await client.call(managerReadKey(), { runId: recovered.arguments.runId }) : recovered.result;
      await watchRun(normalizeRun(snapshot));
    }
    status.textContent = "Identical operation receipt recovered · native state refreshed";
  }
  async function reconcilePendingWrites() {
    const recovery = client.mutationRecovery(), current = epoch;
    if (recovery.blocked) throw new ProtocolError("PENDING_JOURNAL_INVALID");
    let committed = 0;
    for (const marker of recovery.markers.slice(0, 8)) {
      if (await client.reconcileMutation(marker.key) === "committed") committed++;
      if (disposed || current !== epoch) return;
    }
    if (committed) {
      if (client.available("knowledgeList")) await loadKnowledge();
      if (client.available("chatList")) await loadChats();
      if (session) await selectChat(session.id);
      if (run) await watchRun(normalizeRun(await client.call(managerReadKey(), { runId: run.runId })));
    }
    status.textContent = `${committed} matching committed receipt(s) reconciled · native lists refreshed · ${client.mutationRecovery().markers.length} unresolved pin(s). Refresh selected resource details before editing. No replay.`;
  }
  async function cancelChat() {
    if (!turn || terminal(turn.status)) throw new ProtocolError("NO_ACTIVE_TURN");
    const id = turn.id;
    const current = epoch;
    const cancelled = await client.call("chatCancel", { id, expectedRevision: turn.revision, operationId: crypto.randomUUID() });
    if (!disposed && current === epoch && turn?.id === id) {
      turn = /** @type {ChatTurn} */ (cancelled);
      if (terminal(turn.status)) await selectChat(turn.sessionId);
      else chatState.textContent = turnStatus(turn);
    }
  }
  async function archiveChat() {
    if (!session) throw new ProtocolError("CHAT_REQUIRED");
    const id = session.id;
    const current = epoch;
    await client.call("chatArchive", { id, expectedRevision: session.revision, operationId: crypto.randomUUID() });
    if (!disposed && current === epoch && session?.id === id) {
      await loadChats();
      await selectChat(id);
    }
  }
  /** @param {ManagerRun} snapshot */
  function renderOverview(snapshot) {
    overviewBody.replaceChildren();
    overviewBody.append(node("h4", text(snapshot.goal ?? snapshot.contract?.objective ?? "Native instruction")),
      node("p", `${snapshot.projectId} / ${snapshot.runId} · version ${snapshot.version}`, "muted"),
      node("p", `Phase: ${text(snapshot.phase)} · state: ${text(snapshot.state)}`, "run-phase"),
      node("p", `Updated: ${timestamp(snapshot.updatedAt ?? snapshot.updatedTime)}`, "muted"));
    const list = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const groups = node("div", "", "overview-groups");
    /** @param {ManagerTask} task */
    const stateOf = task => task.state;
    /** @param {ManagerTask} task */
    const titleOf = task => task.definition?.title ?? task.title ?? task.definition?.taskId ?? task.taskId;
    /** @type {[string,ManagerTask[]][]} */
    const summaries = [
      ["Doing", list.filter(task => ["running", "dispatched", "verifying", "validating", "delivery"].includes(stateOf(task)))],
      ["Completed", list.filter(task => ["completed", "succeeded", "accepted", "checked"].includes(stateOf(task)))],
      ["Remaining", list.filter(task => ["pending", "queued", "ready", "repair", "planned"].includes(stateOf(task)))],
      ["Blockers", list.filter(task => ["blocked", "failed", "unknown"].includes(stateOf(task)))],
    ];
    for (const [label, selected] of summaries) {
      const group = node("section");
      group.append(node("h4", label));
      const items = node("ul");
      for (const task of selected) items.append(node("li", text(titleOf(task))));
      if (!selected.length) items.append(node("li", "None reported", "muted"));
      group.append(items);
      groups.append(group);
    }
    overviewBody.append(groups);
    if (snapshot.freshness) overviewBody.append(node("p", `Freshness: ${snapshot.freshness} · heartbeat: ${timestamp(snapshot.lastHeartbeatAt)}`, "muted"));
    if (snapshot.budget) overviewBody.append(node("p", `Budget: ${text(snapshot.budget)}`, "budget"));
    if (snapshot.checks) {
      const checks = details("Native delivery / verification / E2E evidence");
      checks.append(renderText(document, snapshot.checks));
      overviewBody.append(checks);
    }
    tasks.replaceChildren();
    for (const task of list) {
      const taskDetail = details(`${titleOf(task)} · ${stateOf(task) ?? "not reported"}`);
      taskDetail.append(renderText(document, task));
      const address = button("Feedback to this worker", () => {
        targetField.input.value = task.definition?.taskId ?? task.taskId;
        feedbackTarget = null;
        feedbackField.input.focus();
      }, "managerFeedback");
      taskDetail.append(address);
      tasks.append(taskDetail);
    }
    updateActions();
  }
  /** @param {import("./protocol.mjs").LiveEvent} event */
  function renderEvent(event) {
    const data = event.data ?? {};
    const entry = node("li");
    entry.append(node("span", `${event.seq ?? event.sequence} / ${event.type} · ${timestamp(event.time ?? event.at)}`, "muted"),
      renderText(document, data));
    boundedAppend(activityList, entry, 200);
    const checks = ["worker.checked", "integration.checked", "e2e.checked"];
    if (event.type === "result" || data.artifact || data.result || data.output || checks.includes(event.type)) {
      const result = data.result ?? data;
      const id = text(result.id ?? result.artifact?.id ?? data.artifact?.id ?? `event-${event.seq ?? event.sequence}`);
      const card = node("article", "", "result-card");
      card.append(node("p", `${data.taskId ?? "Manager"} · ${timestamp(event.time ?? event.at)}`, "eyebrow"),
        node("h4", text(result.summary ?? result.title ?? event.type)),
        node("p", `Evidence grade: ${text(result.verificationGrade ?? result.grade ??
          (event.type === "worker.delivery" ? "delivery · not yet verified" : checks.includes(event.type) ? event.type : "not reported"))}`, "evidence-grade"),
        renderText(document, result));
      if (typeof data.ok === "boolean") card.append(node("p", `Native check: ${data.ok ? "passed" : "failed"} · scoped evidence, not blanket acceptance`, "evidence-grade"));
      if (typeof result.artifact === "string") card.append(renderText(document, result.artifact));
      const address = button("Discuss this result", () => {
        targetField.input.value = data.taskId ?? "";
        feedbackTarget = data.taskId && data.attemptId
          ? { kind: "result", taskId: data.taskId, attemptId: data.attemptId, resultId: id } : null;
        feedbackField.input.value = `Regarding result ${id}: `;
        feedbackField.input.focus();
      }, "managerFeedback");
      card.append(address);
      if (results.has(id)) results.get(id)?.replaceWith(card);
      else {
        if (!results.size) resultFeed.replaceChildren();
        boundedAppend(resultFeed, card, 100);
      }
      results.set(id, card);
      if (results.size > 100) results.delete(results.keys().next().value ?? "");
      updateActions();
    }
  }
  /** @param {ManagerRun} record */
  async function watchRun(record) {
    runSelection++;
    managerFeed?.dispose();
    run = record;
    feedbackTarget = null;
    runField.input.value = record.runId;
    projectField.input.value = record.projectId;
    results.clear();
    resultFeed.replaceChildren(node("p", "Waiting for native artifacts and results.", "empty-results"));
    activityList.replaceChildren();
    renderOverview(record);
    if (!capabilityAvailable("managerEvents")) {
      managerState.textContent = "Snapshot only · live event capability unavailable";
      return;
    }
    /** @type {string|undefined} */
    let projectionCursor;
    managerFeed = replaceFeed(managerFeed, new LiveFeed({
      intervalMs: config.intervalMs,
      read: async (afterSeq, signal) => {
        const projected = client.available("managerProgressEvents");
        const [page, rawSnapshot] = await Promise.all([
          client.call(projected ? "managerProgressEvents" : "managerEvents", { runId: record.runId,
            ...(projected && projectionCursor ? { cursor: projectionCursor } : { afterSeq }), limit: 100 }, signal),
          client.call(managerReadKey(), { runId: record.runId }, signal),
        ]);
        const snapshot = normalizeRun(rawSnapshot);
        if (snapshot.runId !== record.runId || snapshot.projectId !== record.projectId) throw new ProtocolError("RUN_SCOPE_MISMATCH");
        if (!signal.aborted && run?.runId === record.runId) {
          run = snapshot;
          renderOverview(run);
        }
        if (page.runId && page.runId !== record.runId) throw new ProtocolError("RUN_SCOPE_MISMATCH");
        const events = projected ? page.events.map((/** @type {Record<string,any>} */ event) => ({
          ...event, type: event.kind, data: { result: event.result, taskId: event.taskId, attemptId: event.attemptId, code: event.code },
        })) : page.items;
        const next = page.nextSeq ?? afterSeq;
        const more = projected ? page.hasMore : page.items.length === 100;
        if (projected) projectionCursor = page.nextCursor;
        return { events, next, more, gap: Boolean(page.gap) || (Array.isArray(page.gaps) && page.gaps.length > 0),
          terminal: terminal(snapshot.state) && !more };
      },
      event: renderEvent,
      status: value => { if (!disposed) managerState.textContent = value; },
    }));
    managerFeed.start();
  }
  listen(attachForm, "submit", event => {
    event.preventDefault();
    if (attach.disabled) return;
    void execute(async () => {
      const current = epoch;
      const selected = ++runSelection;
      const projectId = projectField.input.value.trim();
      const runId = runField.input.value.trim();
      if (!projectId || !runId) throw new ProtocolError("PROJECT_AND_RUN_REQUIRED");
      const snapshot = await client.call(managerReadKey(), { runId });
      if (disposed || current !== epoch || selected !== runSelection) return;
      if (snapshot.projectId !== projectId) throw new ProtocolError("RUN_SCOPE_MISMATCH");
      await watchRun(normalizeRun(snapshot));
    });
  });
  let managerSubmitting = false;
  listen(startForm, "submit", event => {
    event.preventDefault();
    if (start.disabled || managerSubmitting) return;
    managerSubmitting = true;
    start.disabled = true;
    void execute(async () => {
      const contract = JSON.parse(contractField.input.value);
      const budget = JSON.parse(budgetField.input.value);
      const projectId = projectField.input.value.trim();
      if (!projectId || contract.schema !== "pkm.manager.completion/v1" || !contract.objective ||
          !Array.isArray(contract.acceptance) || !contract.acceptance.some((/** @type {{e2e?:boolean}} */ item) => item.e2e === true))
        throw new ProtocolError("EXPLICIT_COMPLETION_AND_E2E_CONTRACT_REQUIRED");
      const current = epoch;
      const started = await client.call("managerStart", {
        operationId: crypto.randomUUID(), runId: crypto.randomUUID(), projectId, contract, budget,
      });
      if (!disposed && current === epoch) await watchRun(/** @type {ManagerRun} */ (started));
    }).finally(() => { managerSubmitting = false; updateActions(); });
  });
  let feedbackSubmitting = false;
  listen(feedbackForm, "submit", event => {
    event.preventDefault();
    if (!run || feedback.disabled || feedbackSubmitting) return;
    feedbackSubmitting = true;
    feedback.disabled = true;
    void execute(async () => {
      if (!run) throw new ProtocolError("RUN_REQUIRED");
      const message = feedbackField.input.value.trim();
      const taskId = targetField.input.value.trim();
      if (!message) throw new ProtocolError("FEEDBACK_REQUIRED");
      const id = run.runId;
      const current = epoch;
      const projected = client.available("managerProgressFeedback");
      const target = feedbackTarget?.taskId === taskId ? feedbackTarget : (taskId ? { kind: "task", taskId } : { kind: "run" });
      const receipt = await client.call(projected ? "managerProgressFeedback" : "managerFeedback", { operationId: crypto.randomUUID(),
        runId: id, expectedVersion: run.version, message, ...(projected ? { target } : taskId ? { taskId } : {}) });
      if (disposed || current !== epoch || run?.runId !== id) return;
      feedbackField.input.value = "";
      feedbackState.textContent = `Native feedback receipt · ${text(receipt.status ?? receipt.feedback?.status ?? "recorded")} · pending checkpoint is not applied success`;
      // Refresh CAS version from authority, not from an optimistic local increment.
      const snapshot = await client.call(managerReadKey(), { runId: id });
      if (!disposed && current === epoch && run?.runId === id) {
        run = normalizeRun(snapshot);
        renderOverview(run);
      }
    }).finally(() => { feedbackSubmitting = false; updateActions(); });
  });
  async function cancelRun() {
    if (!run || terminal(run.state)) throw new ProtocolError("NO_ACTIVE_RUN");
    const id = run.runId;
    const current = epoch;
    const cancelled = await client.call("managerCancel", { operationId: crypto.randomUUID(), runId: id, expectedVersion: run.version });
    if (!disposed && current === epoch && run?.runId === id) {
      run = /** @type {ManagerRun} */ (cancelled);
      renderOverview(run);
      managerState.textContent = `Native run state: ${text(run.state)} · cancellation does not roll back completed effects`;
    }
  }
  updateActions();
  return {
    client,
    dispose() {
      if (disposed) return;
      disconnectWorkspace();
      disposed = true;
      listeners.forEach(remove => remove());
      listeners.length = 0;
      client.dispose();
      root.replaceChildren();
    },
  };
}
