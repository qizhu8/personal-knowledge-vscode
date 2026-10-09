(() => {
  const vscode = globalThis.PkmWebviewApi || acquireVsCodeApi();
  const element = id => document.getElementById(id);
  let uiStrings = {};
  globalThis.PkmChatText = (text, params = {}) => {
    let value = uiStrings[text] || text;
    for (const [key, replacement] of Object.entries(params)) value = value.split(`{${key}}`).join(String(replacement));
    return value;
  };
  const t = (...args) => globalThis.PkmChatText(...args);
  const staticLabels = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.textContent.trim() && !node.parentElement.closest("script, style, #tokens, #cost, #provider")) staticLabels.push({ node, text: node.textContent.trim() });
  }
  const staticAttributes = Array.from(document.querySelectorAll("[title], [aria-label], [placeholder]")).flatMap(node =>
    ["title", "aria-label", "placeholder"].filter(name => node.hasAttribute(name)).map(name => ({ node, name, text: node.getAttribute(name) })));
  function applyLocale(localization) {
    if (!localization) return;
    uiStrings = Object.fromEntries(Object.entries(localization.english || {}).map(([key, text]) => [text, localization.strings?.[key] || text]));
    document.documentElement.lang = localization.locale || "en";
    document.documentElement.dir = localization.direction === "rtl" ? "rtl" : "ltr";
    for (const { node, text } of staticLabels) if (node.isConnected) node.textContent = t(text);
    for (const { node, name, text } of staticAttributes) if (node.isConnected) node.setAttribute(name, t(text));
  }
  const saved = vscode.getState() || {};
  let screen = "library";
  let renderedChatId;
  let jumpToLatest = false;
  let library;
  const drafts = saved.drafts || {};
  const workflowSelection = new Map();
  const workflowExpanded = new Set();
  const messageExpanded = new Set(saved.expandedMessageDetails || []);
  let state;
  let pending;
  let inputMode = saved.inputMode === "task" ? "task" : "steer";
  let frame;
  let clock;
  let budgetOwner;
  let presets = [];
  let advancedBudget = saved.advancedBudget === true;
  let acknowledgedResult;
  let renderedToolGroups;
  const expandedToolGroups = new Set();
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  function markResultRead() {
    if (!state || screen === "library" || document.visibilityState !== "visible" || !state.chat.lastResultId || state.chat.lastResultId === state.chat.readResultId) return;
    const messages = element("messages");
    if (messages.scrollHeight - messages.scrollTop - messages.clientHeight > 1) return;
    const key = `${state.chat.id}:${state.chat.lastResultId}`;
    if (acknowledgedResult === key) return;
    acknowledgedResult = key;
    post("read", { id: state.chat.id, value: state.chat.lastResultId });
  }
  function contextPresets(maximum) {
    return [...new Set([16, 8, 4, 2, 1].map(divisor => Math.max(256, Math.floor(maximum / divisor))))];
  }
  function contextLengthLabel(value) {
    return new Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "short", maximumFractionDigits: value >= 1e6 ? 1 : 0 }).format(value);
  }
  function syncContextSlider() {
    const current = Number(element("window").value);
    const slider = element("window-slider");
    slider.value = presets.reduce((best, value, index) => Math.abs(value - current) < Math.abs(presets[best] - current) ? index : best, 0);
    element("window-label").textContent = contextLengthLabel(current);
    slider.setAttribute("aria-valuetext", `${presets.includes(current) ? "" : "Custom: "}${contextLengthLabel(current)} tokens`);
  }
  function commitContext() {
    if (!element("window").checkValidity()) { tokenEstimate(); element("window").reportValidity(); return; }
    const current = Number(element("window").value);
    element("output").value = Math.min(Number(element("output").value) || state.settings.maxOutputTokens, Math.floor(current / 4));
    element("output").max = Math.min(state.settings.selectedProfile?.maxOutputTokens || 1024, current - 1);
    syncContextSlider(); tokenEstimate();
    post("budget", { contextWindow: current, maxOutputTokens: Number(element("output").value) });
  }
  const saveDraft = () => {
    if (state) drafts[state.chat.id] = element("prompt").value;
    vscode.setState({ drafts, inputMode, advancedBudget, screen, expandedMessageDetails: Array.from(messageExpanded).slice(-500), collapsedChatGroups: library ? Array.from(library.collapsed) : saved.collapsedChatGroups || [] });
    tokenEstimate();
  };
  function tokenEstimate() {
    if (!state) return;
    const input = (state.settings.inputBaseTokens || 0) + new TextEncoder().encode(element("prompt").value).length;
    const output = Number(element("output").value) || state.settings.maxOutputTokens || 1024;
    const window = Number(element("window").value) || state.settings.contextWindow || 4096;
    const hasImages = state.chat.images?.length || state.chat.includeHistory && state.chat.messages.slice(-20).some(message => message.status === "complete" && message.images?.length);
    element("tokens").textContent = `~${input.toLocaleString()} ${hasImages ? "text input · image preflight pending" : "input"}`;
    element("tokens").title = "Conservative UTF-8 text estimate including context/skills, builtin schemas and history. Image messages require provider token counting before each call. This estimate is not billed usage.";
    const profile = state.settings.selectedProfile;
    const retired = profile?.status === "deprecated" || (profile?.deprecatedAt && Date.parse(profile.deprecatedAt) <= Date.now());
    element("send").disabled = !!pending || !!state.remoteBusy || (state.busy ? !element("prompt").value.trim() || !!state.chat.images?.length : !state.chat.paused && (!element("prompt").value.trim() || !element("window").checkValidity() || !element("output").checkValidity() || input + output > window || retired || state.settings.needsModelConnection || (state.settings.provider !== "vscode" && !state.settings.endpoint)));
    if (profile?.inputPricePerMillion !== undefined && profile?.outputPricePerMillion !== undefined) {
      const price = (input * profile.inputPricePerMillion + output * profile.outputPricePerMillion) / 1e6;
      element("cost").textContent = `First-call estimate: ${profile.currency} ${price.toFixed(6)}`;
      element("cost").title = "Input estimate plus reserved output for the first model call only, not a turn spending cap. Tool loops resend growing context and add input costs each round. Cache rates, pricing tiers and surcharges are excluded.";
    } else {
      const copilot = state.settings.provider === "vscode" && profile?.id?.startsWith("vscode:copilot:");
      element("cost").textContent = copilot ? "Credits unavailable" : state.settings.provider === "vscode" ? "Billing unavailable" : "Price unavailable";
      element("cost").title = copilot ? "GitHub AI Credits are provider-accounted billing, not token counts. This public API does not expose actual credits, plan type or remaining quota; unavailable does not mean zero. Reported token usage is shown on assistant replies." : state.settings.provider === "vscode" ? "Reported token usage is shown on assistant replies when supplied. This public API does not expose account billing or remaining quota." : "Configure verified model prices in API Chat model profiles.";
    }
  }
  const elapsed = milliseconds => `${Math.floor(milliseconds / 60000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}`;
  function updateClock() {
    for (const timer of document.querySelectorAll("[data-started]")) timer.textContent = elapsed(Math.max(0, Number(timer.dataset.finished || Date.now()) - Number(timer.dataset.started)));
  }
  function messageTokenLabel(message, pending) {
    if (pending) return "Awaiting token usage";
    const usage = message.usage;
    if (!usage || ![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return "Token usage not reported";
    return `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`;
  }
  function activity(run = state.chat.progress, messageId = "", debug) {
    if (!run) return null;
    const key = run.attemptId || messageId || String(run.startedAt);
    const active = state.busy && (run.attemptId ? state.chat.progress?.attemptId === run.attemptId : run === state.chat.progress);
    const statusOf = (step, index) => step.status || (index < run.steps.length - 1 ? "complete" : active ? "running" : run.status === "running" ? "failed" : run.status);
    const section = document.createElement("details"); section.className = "workflow activity"; section.dataset.attempt = key; section.open = workflowExpanded.has(key);
    const summary = document.createElement("summary"); summary.className = "workflow-summary";
    summary.dataset.status = active && run.steps.length ? statusOf(run.steps[run.steps.length - 1], run.steps.length - 1) : run.status;
    const icon = active ? element("working-cauldron-template").content.firstElementChild.cloneNode(true) : document.createElement("span");
    if (!active) { icon.className = "workflow-dot"; icon.setAttribute("aria-hidden", "true"); }
    const label = document.createElement("span"); label.className = "activity-label";
    const completed = (run.completedDroppedSteps || 0) + run.steps.filter((step, index) => statusOf(step, index) === "complete").length;
    label.textContent = `Activity [${completed} / ${(run.droppedSteps || 0) + run.steps.length}] ${active ? run.steps[run.steps.length - 1]?.label || "Preparing request" : { complete: "Completed", cancelled: "Cancelled", failed: "Failed or interrupted" }[run.status] || run.status}`;
    label.title = `${run.model || ""} · Completed / recorded steps; future steps are not yet known`;
    const currentStep = run.steps[run.steps.length - 1];
    const timer = document.createElement("span"); timer.className = "elapsed"; timer.dataset.started = currentStep?.at ?? run.startedAt;
    if (!active) timer.dataset.finished = run.finishedAt ?? currentStep?.at ?? run.startedAt;
    timer.setAttribute("aria-hidden", "true"); timer.title = "Elapsed current step time";
    summary.append(icon, label, timer); section.append(summary);
    const list = document.createElement("ol"); list.className = "workflow-events";
    run.steps.forEach((step, index) => {
      const status = statusOf(step, index);
      const row = document.createElement("li"); const glyph = document.createElement("span");
      row.dataset.status = status;
      glyph.className = "workflow-dot"; glyph.setAttribute("aria-hidden", "true");
      const text = document.createElement("span"); text.textContent = `${step.label} · ${status}`;
      const at = document.createElement("span"); at.className = "elapsed"; at.textContent = elapsed(step.at - run.startedAt);
      row.append(glyph, text, at); list.append(row);
    });
    section.append(list);
    if (run.droppedSteps) { const omitted = document.createElement("div"); omitted.className = "workflow-tools"; omitted.textContent = `${run.droppedSteps} earlier activity events omitted; tool results retained below.`; section.append(omitted); }
    if (run.tools) { const tools = document.createElement("div"); tools.className = "workflow-tools"; tools.textContent = run.tools.length ? `Advertised tools: ${run.tools.join(", ")}` : "Advertised tools: none"; section.append(tools); }
    if (debug) section.append(debug);
    section.ontoggle = () => { if (section.isConnected) { if (section.open) workflowExpanded.add(key); else workflowExpanded.delete(key); } };
    return section;
  }
  function error(text) { element("error").textContent = text; element("error").hidden = !text; }
  function iconButton(icon, label, action) {
    const button = document.createElement("button"); button.type = "button";
    button.title = t(label); button.setAttribute("aria-label", t(label));
    const glyph = document.createElement("span"); glyph.className = `codicon codicon-${icon}`;
    button.append(glyph); button.addEventListener("click", action); return button;
  }
  function messageDisclosure(messageId, suffix, title, className) {
    const key = `${state.chat.id}:${messageId}:${suffix}`;
    const node = document.createElement("details"); node.className = className; node.open = messageExpanded.has(key);
    const summary = document.createElement("summary"); summary.textContent = title; node.append(summary);
    node.ontoggle = () => {
      if (!node.isConnected) return;
      node.open ? messageExpanded.add(key) : messageExpanded.delete(key); saveDraft();
    };
    return node;
  }
  function renderAppliedEdits() {
    const panel = element("applied-edits"); panel.replaceChildren();
    const message = [...state.chat.messages].reverse().find(item => item.role === "assistant" && item.changes?.length);
    panel.hidden = !message;
    if (!message) return;
    const known = message.changes.filter(change => change.attribution === "exact");
    const label = `Applied edits: +${known.reduce((total, change) => total + change.added, 0)} -${known.reduce((total, change) => total + change.removed, 0)}${known.length !== message.changes.length ? " · some counts unknown" : ""}`;
    const details = messageDisclosure(message.id, "edits", label, "activity applied-edits-summary");
    details.firstElementChild.title = "Successful edit operations in this response, not a net Git diff. Edits are unsaved unless separately saved.";
    for (const change of message.changes) {
      const row = document.createElement("div"); row.textContent = `[${change.workspace}] ${change.path}: ${change.attribution === "exact" ? `+${change.added} -${change.removed}` : "count unknown"}`;
      details.append(row);
    }
    panel.append(details);
  }
  function renderMessages() {
    if (!state || screen !== "chat" || document.visibilityState !== "visible") return;
    const target = element("messages");
    renderAppliedEdits();
    const previousScrollTop = target.scrollTop;
    const follow = jumpToLatest || renderedChatId !== state.chat.id || target.scrollHeight - target.scrollTop - target.clientHeight < 90;
    renderedChatId = state.chat.id;
    jumpToLatest = false;
    target.replaceChildren();
    const latestUser = [...state.chat.messages].reverse().find(message => message.role === "user");
    const pendingUserId = state.busy && state.chat.messages.at(-1)?.status === "streaming" ? latestUser?.id : undefined;
    for (const message of state.chat.messages) {
      const article = document.createElement("article"); article.className = `message ${message.role}`;
      const header = document.createElement("div"); header.className = "message-header";
      const role = document.createElement("strong"); role.textContent = message.role === "user" ? t("You") : "PKM";
      const model = document.createElement("span"); model.className = "model-name"; model.textContent = message.model || (message.contextLabels || []).join(", "); model.title = model.textContent;
      header.append(role, model, iconButton("copy", "Copy message", () => post("copy", { id: message.id })));
      if (message.role === "assistant" && message.id === state.chat.messages[state.chat.messages.length - 1]?.id && ["failed", "cancelled", "interrupted"].includes(message.status)) {
        const retry = iconButton("refresh", "Retry response (new request; earlier tools may have run)", () => post("retry", { id: message.id }));
        retry.disabled = state.busy || state.chat.paused; header.append(retry);
      }
      const content = document.createElement("div"); content.className = "content";
      if (message.role === "user") content.textContent = message.content;
      else content.innerHTML = DOMPurify.sanitize(marked.parse(message.content || ""), {
        ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "hr", "table", "thead", "tbody", "tr", "th", "td", "a"],
        ALLOWED_ATTR: ["href", "title", "start", "colspan", "rowspan"], ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^(?:https?|pkm):\/\//i,
      });
      for (const link of content.querySelectorAll("a")) {
        const href = link.getAttribute("href") || "";
        if (!/^(?:https?|pkm):\/\//i.test(href)) link.removeAttribute("href");
        else link.addEventListener("click", event => { event.preventDefault(); post("openLink", { value: href }); });
      }
      article.append(header, content);
      for (const record of message.delegations || []) {
        const result = document.createElement("section"); result.className = "delegation-result";
        const heading = document.createElement("div"); heading.className = "message-header";
        heading.append(window.PkmChatStatusIndicator(record.status === "complete" ? "completed" : record.status === "cancelled" ? "stopped" : record.status));
        const link = document.createElement("a"); link.href = record.chatUrl; link.textContent = t("Delegated Chat");
        link.addEventListener("click", event => { event.preventDefault(); post("openLink", { value: record.chatUrl }); });
        heading.append(link); result.append(heading);
        if (record.answer) { const answer = document.createElement("div"); answer.className = "content delegation-answer"; answer.textContent = record.answer; result.append(answer); }
        if (record.error) { const failure = document.createElement("div"); failure.className = "message-error"; failure.textContent = record.error; result.append(failure); }
        article.append(result);
      }
      if (message.images?.length) article.append(imagePreviews(message.images, (index) => post("saveImage", { id: message.id, value: index }), "save", "Save image"));
      const debug = document.createElement("div"); debug.className = "debug-information";
      if (message.unattributedFileChanges) {
        const warning = document.createElement("div"); warning.className = "message-status"; warning.textContent = "Program/MCP file changes are not attributed."; debug.append(warning);
      }
      for (const tool of message.toolCalls || []) {
        const detail = messageDisclosure(message.id, tool.id, "", "activity tool-call");
        const summary = document.createElement("summary");
        const glyph = document.createElement("span"); glyph.className = tool.status === "running" && state.busy ? "codicon codicon-loading codicon-modifier-spin" : `codicon codicon-${tool.status === "complete" ? "check" : "error"}`;
        const name = document.createElement("span"); name.className = "activity-label"; name.textContent = `${tool.name} · ${tool.status === "running" && !state.busy ? "interrupted" : tool.status}`;
        summary.append(glyph, name);
        const result = document.createElement("pre"); result.textContent = `${tool.arguments}\n\n${tool.result || ""}`;
        detail.firstElementChild.replaceWith(summary); detail.append(result); debug.append(detail);
      }
      const run = message.progress || (message.role === "assistant" && message.id === state.chat.messages[state.chat.messages.length - 1]?.id ? state.chat.progress : undefined);
      if (run) article.insertBefore(activity(run, message.id, debug), content);
      else if (message.unattributedFileChanges || message.toolCalls?.length) { const log = messageDisclosure(message.id, "activity", "Activity", "activity"); log.append(debug); article.insertBefore(log, content); }
      if (message.elapsedMs !== undefined || message.estimatedCost !== undefined) {
        const metadata = document.createElement("div"); metadata.className = "message-status";
        metadata.textContent = [message.elapsedMs !== undefined ? elapsed(message.elapsedMs) : "", message.estimatedCost !== undefined ? `Estimated ${message.currency} ${message.estimatedCost.toFixed(6)}` : ""].filter(Boolean).join(" · ");
        metadata.title = "Elapsed request time; cost uses configured rates, not provider billing.";
        article.append(metadata);
      }
      if (message.status !== "complete") {
        const status = document.createElement("div"); status.className = "message-error";
        status.textContent = message.status === "streaming" ? "" : message.error || message.status;
        if (message.status === "streaming") status.className = "message-status";
        article.append(status);
      }
      const tokens = document.createElement("div"); tokens.className = "message-tokens";
      tokens.textContent = messageTokenLabel(message, state.busy && (message.status === "streaming" || message.id === pendingUserId));
      tokens.title = message.role === "user" ? "Independent user-message token usage is unavailable unless the provider reports it; request input includes history/context/tools." : "Provider-reported tokens for reported rounds only; other rounds may omit usage. Input includes history/context/tools, not just the latest user message.";
      article.append(tokens);
      target.append(article);
    }
    const latest = state.chat.messages[state.chat.messages.length - 1];
    if (state.chat.progress && (latest?.role !== "assistant" || latest.progress && latest.progress.attemptId !== state.chat.progress.attemptId)) target.append(activity());
    for (const approval of state.approvals || []) {
      const section = document.createElement("section"); section.className = "approval"; section.setAttribute("aria-label", "Tool approval");
      const title = document.createElement("strong"); title.textContent = approval.title;
      const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = approval.scope;
      const input = document.createElement("pre"); input.textContent = approval.detail; details.append(summary, input);
      const actions = document.createElement("div"); actions.className = "approval-actions";
      for (const [value, icon, label] of [["approve", "check", "Approve & remember"], ["deny", "close", "Deny"], ["allow-all", "shield", "Allow All"]]) {
        const button = iconButton(icon, label, () => { for (const action of actions.children) action.disabled = true; post("approval", { id: approval.id, value }); });
        const text = document.createElement("span"); text.textContent = label; button.append(text); actions.append(button);
      }
      section.append(title, details, actions); target.append(section);
    }
    updateClock();
    target.setAttribute("aria-busy", String(state.busy));
    target.scrollTop = follow ? target.scrollHeight : previousScrollTop;
  }
  function imagePreviews(images, action, icon, label) {
    const list = document.createElement("div"); list.className = "chat-images";
    images.forEach((image, index) => {
      if (!["image/png", "image/jpeg"].includes(image.mimeType) || typeof image.dataBase64 !== "string" || image.dataBase64.length > 700000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) return;
      const item = document.createElement("figure");
      const preview = document.createElement("img"); preview.alt = image.label; preview.src = `data:${image.mimeType};base64,${image.dataBase64}`;
      const caption = document.createElement("figcaption"); caption.textContent = image.label; caption.title = image.label;
      item.append(preview, caption, iconButton(icon, `${label}: ${image.label}`, () => action(index))); list.append(item);
    });
    return list;
  }
  function renderTools(force = false) {
    const groups = state.toolGroups || [];
    const fingerprint = JSON.stringify([groups, state.chat.id, state.remoteBusy]);
    if (!force && renderedToolGroups === fingerprint) return;
    renderedToolGroups = fingerprint;
    const query = element("tool-search").value.toLowerCase().trim();
    const tree = element("tool-tree"); tree.replaceChildren();
    for (const group of groups) {
      const matches = group.tools.filter(tool => `${group.label} ${tool.label} ${tool.description}`.toLowerCase().includes(query));
      if (query && !matches.length) continue;
      const details = document.createElement("details"); details.className = "tool-source"; details.open = !!query || expandedToolGroups.has(group.id);
      const summary = document.createElement("summary"); summary.title = group.description;
      const arrow = document.createElement("span"); arrow.className = `codicon codicon-chevron-${details.open ? "down" : "right"}`;
      const label = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `Enable ${group.label}`); checkbox.disabled = !!state.remoteBusy || !group.tools.length;
      const count = group.tools.filter(tool => tool.enabled).length;
      checkbox.checked = count > 0 && count === group.tools.length; checkbox.indeterminate = count > 0 && count < group.tools.length;
      checkbox.onclick = event => event.stopPropagation(); checkbox.onchange = () => post("toolSelection", { id: group.id, value: checkbox.checked });
      const name = document.createElement("span"); name.textContent = group.label; label.append(checkbox, name); label.onclick = event => event.stopPropagation();
      const counts = document.createElement("span"); counts.className = "tool-source-count"; counts.textContent = `${count}/${group.tools.length}`;
      const only = iconButton("filter", `Enable only ${group.label}`, () => post("toolSelection", { id: group.id, value: true, only: true }));
      only.disabled = !!state.remoteBusy || !group.tools.length; only.addEventListener("click", event => event.stopPropagation());
      summary.append(arrow, label, counts, only); details.append(summary);
      details.ontoggle = () => { arrow.className = `codicon codicon-chevron-${details.open ? "down" : "right"}`; if (!query) { if (details.open) expandedToolGroups.add(group.id); else expandedToolGroups.delete(group.id); } };
      for (const tool of matches) {
        const leaf = document.createElement("label"); leaf.className = "tool-leaf"; leaf.title = tool.description;
        const check = document.createElement("input"); check.type = "checkbox"; check.checked = tool.enabled; check.disabled = !!state.remoteBusy;
        check.setAttribute("aria-label", `Enable ${tool.label}`); check.onchange = () => post("toolSelection", { id: tool.id, value: check.checked });
        const text = document.createElement("span"); text.textContent = tool.label; leaf.append(check, text); details.append(leaf);
      }
      tree.append(details);
    }
  }
  function renderMemory() {
    const receipt = [...state.chat.messages].reverse().find(message => message.role === "assistant" && message.retrieval)?.retrieval;
    const type = element("retrieval-kind"); const previousType = type.value;
    type.replaceChildren(new Option(t("All types"), "all"));
    for (const kind of [...new Set((receipt?.candidates || []).map(candidate => candidate.kind))].sort()) type.add(new Option(kind, kind));
    type.value = [...type.options].some(option => option.value === previousType) ? previousType : "all";
    element("retrieval-status").textContent = receipt ? receipt.warning || t("{selected} selected overall · {count} candidates · per-method ranking", { selected: receipt.selectedCount, count: receipt.candidates.length }) : t("No retrieval receipt");
    globalThis.PkmRetrievalFlow(element("retrieval-flow"), receipt, Number(element("retrieval-top").value), type.value, candidate => {
      element("memory-preview").textContent = JSON.stringify(candidate, null, 2); element("memory-preview").hidden = false;
      if (candidate.kind === "memory") post("memorySegment", { id: candidate.id });
    });
    const tree = element("memory-tree"); tree.replaceChildren();
    if (!state.memoryTree) return;
    const root = document.createElement("details"); root.open = true;
    const summary = document.createElement("summary"); summary.textContent = state.memoryTree.title; root.append(summary);
    for (const task of state.memoryTree.tasks) {
      const branch = document.createElement("details"); branch.open = task.id === state.chat.sessionId;
      const title = document.createElement("summary"); title.textContent = `${task.title} · ${task.segments.length} segments`; branch.append(title);
      for (const [index, segment] of task.segments.entries()) {
        const leaf = document.createElement("button"); leaf.type = "button";
        leaf.textContent = `${segment.role === "user" ? "User" : "Assistant"} · ${index + 1} · ${segment.characters} chars`;
        leaf.title = segment.id; leaf.onclick = () => post("memorySegment", { id: segment.id }); branch.append(leaf);
      }
      root.append(branch);
    }
    tree.append(root);
  }
  function render() {
    element("copy-chat-id").disabled = !state.chat?.id;
    document.body.classList.toggle("chat-backgrounded", document.visibilityState === "hidden");
    renderMessages();
    renderTools();
    renderMemory();
    element("permission-mode").value = state.chat.permissionMode || "protective";
    element("permission-mode").disabled = !!state.remoteBusy;
    const grants = state.chat.permissionGrants?.length || 0;
    element("permission-grants").textContent = t("{count} remembered approvals", { count: grants });
    element("reset-permissions").disabled = !grants || !!state.remoteBusy;
    library?.render(state.library);
    const chats = element("chats"); chats.replaceChildren();
    for (const item of state.chats) {
      const status = globalThis.PkmChatStatusIndicator(item.status);
      const option = new Option(item.title, item.id); option.title = `${status.title}: ${item.title}`;
      option.selected = item.id === state.chat.id; chats.add(option);
      if (option.selected) { chats.title = option.title; element("chat-status").replaceChildren(status); }
    }
    const native = state.settings.provider === "vscode";
    const disconnected = state.settings.needsModelConnection || (!native && !state.settings.endpoint);
    const modelLabel = disconnected ? t("Choose model") : state.settings.selectedProfile?.label || state.settings.model;
    element("model-label").textContent = modelLabel;
    element("model").title = `Choose model: ${modelLabel} (${native ? "VS Code" : state.settings.provider}). ${state.busy ? "Applies to the next request; current response keeps its model." : ""}`;
    element("model").setAttribute("aria-label", `Choose model: ${modelLabel}`);
    const window = element("window");
    const maximum = state.settings.selectedProfile?.contextWindow || 4096;
    const current = Math.min(state.settings.contextWindow || maximum, maximum);
    const editing = budgetOwner === state.chat.id;
    if (!editing || document.activeElement !== window && document.activeElement !== element("window-slider")) window.value = current;
    window.max = maximum;
    presets = contextPresets(maximum);
    const slider = element("window-slider"); slider.max = presets.length - 1; slider.disabled = presets.length < 2;
    element("window-presets").replaceChildren(...presets.map((value, index) => new Option(contextLengthLabel(value), index)));
    slider.title = `Context presets: ${presets.map(contextLengthLabel).join(" / ")}`;
    syncContextSlider();
    window.title = state.settings.selectedProfile?.status === "unknown" ? "Unverified model: conservative 4K-token local budget. Configure the provider's verified maximum." : "Total input + output token budget; applies to the next request.";
    if (!editing || document.activeElement !== element("output")) element("output").value = state.settings.maxOutputTokens || 1024;
    element("output").max = Math.min(state.settings.selectedProfile?.maxOutputTokens || 1024, Number(window.value) - 1);
    if (document.activeElement !== element("tool-rounds")) element("tool-rounds").value = state.settings.maxToolRounds || 30;
    element("tool-rounds").title = "Tool rounds before asking to continue; applies to the next request";
    element("output").title = native ? "Local per-response token guard using the model tokenizer when available (otherwise conservative UTF-8 bytes); not a provider-enforced billing or reasoning-token limit. Applies to the next request." : "Maximum output tokens sent to the API; applies to the next request.";
    budgetOwner = state.chat.id;
    element("contexts").replaceChildren();
    element("images").replaceChildren(imagePreviews(state.chat.images || [], index => post("removeImage", { value: index }), "close", "Remove image"));
    element("images").hidden = !state.chat.images?.length;
    element("image").disabled = !native || state.settings.selectedProfile?.imageInput !== true || disconnected;
    element("image").title = element("image").disabled ? "Choose a vision-capable VS Code model to attach images" : "Attach PNG/JPEG image (up to two, 512 KB each)";
    for (const item of state.chat.context) {
      const chip = document.createElement("div"); chip.className = "context-item";
      const label = document.createElement("span"); label.textContent = item.label; label.title = `${item.label} (${item.characters.toLocaleString()} characters)`;
      chip.append(label, iconButton("close", `Remove ${item.label}`, () => post("removeContext", { id: item.id })));
      element("contexts").append(chip);
    }
    element("history").checked = state.chat.includeHistory;
    element("context").title = `Add context${state.chat.context.length ? ` (${state.chat.context.length} attached)` : ""}`;
    element("options").title = state.chat.context.length ? `Model settings (${state.chat.context.length} attached)` : "Model settings";
    element("send").hidden = false; element("stop").hidden = !state.busy;
    element("input-mode").hidden = !state.busy || !!state.remoteBusy;
    element("steer-mode").setAttribute("aria-checked", String(inputMode === "steer"));
    element("task-mode").setAttribute("aria-checked", String(inputMode === "task"));
    const sendLabel = state.chat.paused ? "Resume Chat" : state.busy ? inputMode === "steer" ? "Steer" : "Queue new task" : "Send";
    element("send").title = t(sendLabel); element("send").setAttribute("aria-label", t(sendLabel));
    element("send").firstElementChild.className = `codicon codicon-${state.chat.paused ? "debug-start" : "send"}`;
    element("stop").disabled = !!state.remoteBusy;
    const queued = state.chat.queuedInputs || [];
    element("queued-inputs").hidden = !queued.length; element("queued-inputs").replaceChildren();
    if (queued.length) {
      const heading = document.createElement("div"); heading.className = "queued-input-row";
      const count = document.createElement("strong"); count.textContent = t("{count} queued", { count: queued.length }); heading.append(count);
      const run = iconButton("play", "Run queued inputs", () => post("runQueued")); run.disabled = state.busy || state.chat.paused; heading.append(run);
      element("queued-inputs").append(heading);
      for (const input of queued) {
        const row = document.createElement("div"); row.className = "queued-input-row";
        const label = document.createElement("span"); label.textContent = `${t(input.mode === "steer" ? "Steer" : "New task")}: ${input.text}`; label.title = input.text; row.append(label);
        const remove = iconButton("close", "Remove queued input", () => post("removeQueuedInput", { id: input.id })); remove.disabled = !!state.remoteBusy; row.append(remove);
        element("queued-inputs").append(row);
      }
    }
    const taskLabel = state.chat.sessionId ? "Complete Task" : "Start Task";
    element("task").title = t(taskLabel); element("task").setAttribute("aria-label", t(taskLabel));
    element("task").disabled = state.busy;
    element("task").firstElementChild.className = `codicon codicon-${state.chat.sessionId ? "check" : "checklist"}`;
    const pauseLabel = state.chat.paused ? "Resume Chat" : "Pause Chat";
    element("pause").title = t(pauseLabel); element("pause").setAttribute("aria-label", t(pauseLabel));
    element("pause").firstElementChild.className = `codicon codicon-${state.chat.paused ? "debug-start" : "debug-pause"}`;
    const permissionModes = { protective: "Protective", ask: "Ask before changes", "read-only": "Read only", "allow-all": "Allow All" };
    const permissionMode = Object.hasOwn(permissionModes, state.chat.permissionMode) ? state.chat.permissionMode : "protective";
    const permissionLabel = permissionModes[permissionMode];
    element("permissions").dataset.permissionMode = permissionMode;
    element("permissions").title = `${t("Permissions")}: ${t(permissionLabel)} · next request`;
    element("permissions").setAttribute("aria-label", element("permissions").title);
    const selected = (state.toolGroups || []).flatMap(group => group.tools.filter(tool => tool.enabled));
    const builtinCount = selected.filter(tool => tool.id.startsWith("builtin:") && (state.chat.permissionMode !== "read-only" || ["read_file", "find_files", "search_text", "ask_user", "pkm_search", "pkm_read", "session_info", "list_chats"].includes(tool.name))).length;
    const mcpCount = state.chat.permissionMode === "read-only" ? 0 : selected.filter(tool => tool.id.startsWith("mcp:")).length;
    const hostCount = state.chat.permissionMode === "read-only" ? 0 : selected.filter(tool => tool.id.startsWith("vscode:")).length;
    element("tools-label").textContent = t("{count} tools", { count: builtinCount + mcpCount + hostCount });
    element("tools").title = `Tools: ${builtinCount} builtin / ${mcpCount} HTTP MCP / ${hostCount} VS Code · next request`;
    element("tools").setAttribute("aria-label", element("tools").title);
    element("send").disabled = !element("prompt").value.trim();
    element("provider").textContent = disconnected ? "Not connected" : native ? "VS Code" : "API";
    element("provider").title = native ? "VS Code Language Model API · access and quota controlled by the model provider" : `${state.settings.provider} · ${state.settings.endpoint || "Not configured"}`;
    tokenEstimate();
    clearInterval(clock); clock = state.busy ? setInterval(updateClock, 250) : undefined;
  }
  window.addEventListener("message", event => {
    const message = event.data;
    if (message.type === "sendAccepted") {
      if (pending?.id !== message.chatId || pending?.submissionId !== message.submissionId) return;
      if (state?.chat.id === pending.id && element("prompt").value === pending.text) element("prompt").value = "";
      if (drafts[pending.id] === pending.text) drafts[pending.id] = "";
      pending = undefined; saveDraft(); error(""); return;
    }
    if (message.type === "modelPickerClosed") { element("model").removeAttribute("aria-busy"); return; }
    if (message.type === "showChat") { showScreen("chat"); return; }
    if (message.type === "showTools") { togglePopover("tools", true); element("tool-search").focus(); return; }
    if (message.type === "showMemory") { togglePopover("memory", true); return; }
    if (message.type === "memorySegment" && message.chatId === state?.chat.id) { element("memory-preview").textContent = message.segment.content; element("memory-preview").hidden = false; return; }
    if (message.type === "error") {
      if (message.submissionId ? pending?.submissionId === message.submissionId : !message.chatId || pending?.id === message.chatId) pending = undefined;
      if (!message.chatId || message.chatId === state?.chat.id) error(message.message);
      tokenEstimate(); return;
    }
    if (message.type === "state") {
      globalThis.PkmHostHealth?.ready();
      applyLocale(message.localization);
      const previous = state?.chat.id;
      if (state) drafts[state.chat.id] = element("prompt").value;
      const retained = new Set((message.library?.chats || message.chats || []).map(chat => chat.id));
      for (const id of Object.keys(drafts)) if (!retained.has(id)) delete drafts[id];
      if (!message.chat) {
        state = undefined; pending = undefined; budgetOwner = undefined;
        clearInterval(clock); element("messages").replaceChildren(); element("chats").replaceChildren();
        element("prompt").value = ""; element("applied-edits").hidden = true;
        library?.render(message.library); showScreen("library"); return;
      }
      state = message;
      if (previous !== state.chat.id) { element("prompt").value = drafts[state.chat.id] || ""; element("memory-preview").textContent = ""; element("memory-preview").hidden = true; }
      if (pending?.id === state.chat.id && state.chat.messages.some(item => item.role === "user" && item.content === pending.text && !pending.messages.includes(item.id))) {
        if (element("prompt").value === pending.text) element("prompt").value = "";
        pending = undefined; error("");
      }
      saveDraft(); render(); markResultRead(); return;
    }
    if (message.type === "delta" && message.chatId === state?.chat.id) {
      const reply = state.chat.messages.find(item => item.id === message.id);
      if (reply) reply.content += message.text;
      if (!frame) frame = requestAnimationFrame(() => { frame = undefined; renderMessages(); });
    }
  });
  element("new").onclick = () => { saveDraft(); error(""); post("new"); };
  element("messages").addEventListener("scroll", markResultRead);
  element("rename").onclick = () => post("rename");
  element("copy-chat-id").onclick = () => { if (state?.chat?.id) post("copyChatId", { id: state.chat.id }); };
  const showScreen = next => {
    if (next === "chat" && screen !== "chat") jumpToLatest = true;
    screen = next; document.body.classList.toggle("chat-library-visible", screen === "library");
    element("library-view").hidden = screen !== "library"; saveDraft();
    if (next === "chat" && state) { renderMessages(); markResultRead(); }
  };
  library = window.PkmChatLibrary({ post, showChat: () => showScreen("chat"), save: saveDraft, saved });
  element("back").onclick = () => { showScreen("library"); post("libraryRefresh"); };
  showScreen(screen);
  element("task").onclick = () => post(state.chat.sessionId ? "completeTask" : "startTask");
  element("pause").onclick = () => post(state.chat.paused ? "resume" : "pause");
  const popovers = { permissions: "permissions-panel", tools: "tools-panel", memory: "memory-panel", options: "advanced-budget", "agent-config": "agent-config-panel" };
  function closePopovers() { for (const [button, panel] of Object.entries(popovers)) { element(panel).hidden = true; element(button).setAttribute("aria-expanded", "false"); } }
  function positionPopover(panel) { const top = element("composer").getBoundingClientRect().top; panel.style.bottom = `${Math.max(8, Math.min(innerHeight - 90, innerHeight - top + 6))}px`; panel.style.maxHeight = `${Math.max(72, top - 16)}px`; }
  function togglePopover(button, forceOpen = false) { const panel = element(popovers[button]); const open = forceOpen || panel.hidden; closePopovers(); if (open) { panel.hidden = false; positionPopover(panel); element(button).setAttribute("aria-expanded", "true"); if (button === "memory") renderMemory(); } }
  for (const button of Object.keys(popovers)) element(button).onclick = () => togglePopover(button);
  document.addEventListener("pointerdown", event => { if (!event.target.closest(".chat-settings") && !event.target.closest("[aria-controls]")) closePopovers(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") { const button = Object.keys(popovers).find(id => element(id).getAttribute("aria-expanded") === "true"); closePopovers(); if (button) { element(button).focus(); event.preventDefault(); } } });
  window.addEventListener("resize", () => { for (const panel of Object.values(popovers)) if (!element(panel).hidden) positionPopover(element(panel)); });
  element("permission-mode").onchange = () => post("permissionMode", { value: element("permission-mode").value });
  element("reset-permissions").onclick = () => post("resetPermissions");
  element("diagnostics").onclick = () => post("diagnostics");
  element("settings").onclick = () => post("settings");
  for (const button of document.querySelectorAll("[data-agent-config]")) button.onclick = () => { closePopovers(); post("agentConfig", { value: button.dataset.agentConfig }); };
  element("memory-close").onclick = closePopovers;
  element("retrieval-top").onchange = renderMemory;
  element("retrieval-kind").onchange = renderMemory;
  let retrievalWidth = 0;
  new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width === retrievalWidth) return;
    retrievalWidth = width;
    if (width > 0 && state) renderMemory();
  }).observe(element("retrieval-flow"));
  element("tool-search").oninput = () => renderTools(true);
  element("tool-connections").onclick = () => post("agentConfig", { value: "mcps" });
  element("context").onclick = () => post("context");
  element("image").onclick = () => post("image");
  element("stop").onclick = () => post("cancel");
  element("chats").onchange = event => { saveDraft(); error(""); post("select", { id: event.target.value }); };
  element("model").onclick = () => { if (element("model").getAttribute("aria-busy") === "true") return; element("model").setAttribute("aria-busy", "true"); post("chooseModel"); };
  document.addEventListener("visibilitychange", () => {
    const visible = document.visibilityState === "visible";
    document.body.classList.toggle("chat-backgrounded", !visible);
    if (visible) renderMessages();
    markResultRead();
  });
  window.addEventListener("focus", markResultRead);
  element("window-slider").oninput = event => { element("window").value = presets[Number(event.target.value)]; syncContextSlider(); tokenEstimate(); };
  element("window-slider").onchange = commitContext;
  element("window").oninput = () => { syncContextSlider(); tokenEstimate(); };
  element("window").onchange = commitContext;
  element("output").oninput = tokenEstimate;
  element("output").onchange = event => { if (event.target.checkValidity()) post("budget", { maxOutputTokens: Number(event.target.value) }); else event.target.reportValidity(); tokenEstimate(); };
  element("tool-rounds").onchange = event => { if (event.target.checkValidity()) post("toolRounds", { maxToolRounds: Number(event.target.value) }); else event.target.reportValidity(); };
  element("history").onchange = event => post("history", { value: event.target.checked });
  element("prompt").oninput = saveDraft;
  for (const mode of ["steer", "task"]) element(`${mode}-mode`).onclick = () => {
    inputMode = mode; saveDraft(); render();
  };
  element("input-mode").onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const mode = event.key === "Home" || event.key === "ArrowLeft" ? "steer" : "task";
    element(`${mode}-mode`).click(); element(`${mode}-mode`).focus();
  };
  element("composer").onsubmit = event => {
    event.preventDefault(); if (globalThis.PkmHostHealth?.unavailable || !state || state.remoteBusy || pending || element("send").disabled) return;
    if (state.chat.paused) { post("resume"); return; }
    if (!element("prompt").value.trim()) return;
    const text = element("prompt").value; error("");
    pending = { id: state.chat.id, submissionId: crypto.randomUUID(), text, messages: state.chat.messages.map(item => item.id) };
    tokenEstimate(); post("send", { text, chatId: pending.id, submissionId: pending.submissionId, ...(state.busy ? { mode: inputMode } : {}) });
  };
  element("prompt").onkeydown = event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); element("composer").requestSubmit(); }
  };
  post("ready");
})();