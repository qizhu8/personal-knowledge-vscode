function stableJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
}
function detail(entry) {
  const intent = entry.intent;
  if (intent.authority === "approval") {
    const request = intent.request;
    return [
      `Command: ${request.record.tool}`, `Exact arguments:\n${stableJSON(request.record.arguments)}`,
      `Execution: ${request.record.id} · revision ${request.record.revision}`,
      `Execution operation: ${request.executionOperationId}`, `Turn: ${request.context.turnId}`,
      `Context/source pin: ${request.context.contextDigest}`, `Record pin: ${request.recordDigest}`,
      `Arguments pin: ${request.argumentsDigest}`,
      "Document impact: exact supplied command/arguments only. No inferred document changes or general permission grant.",
    ].join("\n");
  }
  const { record, replacement, operation } = intent.request;
  const sources = items => items.map(source =>
    `Source ID: ${source.id}\nChat: ${source.chat}\nRevision: ${source.revision}\nLocator: ${source.locator}`).join("\n");
  return [
    `Command: ${operation}`, `Record: ${record.id} · revision ${record.revision}`, `Scope: ${record.scope}`,
    `Document pin: ${record.documentSha256}`, `Current status: ${record.current_status}`,
    `Current content:\n${record.content}`, `Current source pins:\n${sources(record.sources)}`,
    ...(replacement ? [`Replacement content:\n${replacement.content}`, `Replacement source pins:\n${sources(replacement.sources)}`] : []),
    `Document impact: ${operation === "memory.record.confirm" ? "Future active Memory search."
      : operation === "memory.record.revise" ? "New pending revision; no inherited confirmation."
      : "Future search exclusion; history retained, not erased."}`,
  ].join("\n");
}

/** Bind read/decide out of band in the native host. No bearer, credential storage, fetch or generic tool calls. */
export function createHumanReviewComponent(root, transport) {
  const document = root.ownerDocument;
  let disposed = false, generation = 0, busy = false;
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const shell = node("section", undefined, "human-review");
  shell.setAttribute("aria-label", "Exact native human review queue");
  const header = node("header", undefined, "human-review-header");
  header.append(node("span", "NATIVE / HUMAN ONLY", "human-review-eyebrow"), node("h2", "Review desk"));
  const refreshButton = node("button", "Refresh queue", "human-review-refresh");
  refreshButton.type = "button";
  header.append(refreshButton);
  const message = node("p", "Human session required. Nothing is approved automatically.", "human-review-status");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const list = node("div", undefined, "human-review-list");
  shell.append(header, message, list); root.replaceChildren(shell);
  async function refresh() {
    if (disposed || busy) return;
    const epoch = ++generation;
    refreshButton.disabled = true;
    try {
      const result = await transport.read({});
      if (disposed || epoch !== generation) return;
      list.replaceChildren();
      message.textContent = result.entries.length ? `${result.entries.length} exact record(s) awaiting your decision.`
        : "No pending records. No authorization is inferred.";
      for (const entry of result.entries) {
        const card = node("article", undefined, "human-review-card");
        card.append(node("h3", entry.authority === "memory" ? "Memory · exact version" : "Execution · exact command"),
          node("p", `Workspace ${entry.workspaceId} / Actor ${entry.actorId}`, "human-review-scope"),
          node("p", `Operation ${entry.operationId} · Review revision ${entry.revision}`),
          node("p", `Expires ${new Date(entry.expiresAt).toISOString()}`),
          node("pre", detail(entry), "human-review-detail"),
          node("p", `Intent pin: ${entry.intentDigest}`, "human-review-pin"));
        const controls = node("div", undefined, "human-review-actions");
        for (const [decision, label] of [["approve", "Approve exact record"], ["reject", "Reject"], ["cancel", "Cancel review"]]) {
          const button = node("button", label, `human-review-${decision}`);
          button.type = "button";
          button.addEventListener("click", async () => {
            if (disposed || busy || epoch !== generation) return;
            busy = true;
            for (const item of shell.querySelectorAll("button")) item.disabled = true;
            try {
              const result = await transport.decide({ id: entry.id, expectedRevision: entry.revision,
                intentDigest: entry.intentDigest, decision });
              if (!disposed) message.textContent = `Review ${result.status}.`;
            } catch {
              if (!disposed) message.textContent = "Decision unavailable or stale. No authorization was inferred.";
            } finally {
              busy = false;
              if (!disposed) await refresh();
            }
          });
          controls.append(button);
        }
        card.append(controls); list.append(card);
      }
    } catch {
      if (!disposed && epoch === generation) {
        list.replaceChildren();
        message.textContent = "Native human session unavailable. Machine credentials cannot review.";
      }
    } finally {
      if (!disposed && epoch === generation) refreshButton.disabled = busy;
    }
  }
  refreshButton.addEventListener("click", refresh);
  return Object.freeze({ refresh, dispose() { disposed = true; generation++; root.replaceChildren(); } });
}
