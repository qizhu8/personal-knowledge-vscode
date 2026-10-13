/* Packaged standalone, network-free GitHub Sync conflict workbench. */
(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const node = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let state;
  let selected;
  let dirty = false;
  let busy = false;
  let validated = new Set();
  let draft = "";
  let differenceBlocks = [];
  let pickMappingValid = true;
  const fileTreeOpen = new Map();
  const current = () => state?.files.find(file => file.path === selected);
  const metadata = () => state?.record.files.find(file => file.path === selected);
  const applied = () => !!state?.record.appliedAt;
  const isDelete = file => ["delete", "delete-local"].includes(file?.candidateSource);
  const supportedAgent = () => !current()?.binary && metadata()?.candidateSource === "unresolved" &&
    ["skill", "recipe"].includes(metadata()?.type);
  const safePreview = uri => typeof uri === "string" && (
    /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\r\n]+$/.test(uri) ||
    /^vscode-webview-resource:\/\//.test(uri) || /^https:\/\/[a-z0-9-]+\.vscode-(?:cdn\.net|webview\.net)\//.test(uri));
  function error(message) { node("error").textContent = message; }
  function discard() {
    if (!dirty) return true;
    if (!window.confirm("Discard the unsaved result edits? Save & validate first to keep them.")) return false;
    dirty = false;
    draft = current()?.binary ? "" : current()?.merged ?? "";
    return true;
  }
  function readyToApply() {
    if (applied()) return !dirty;
    return !!state && state.record.files.length > 0 && state.record.files.every(file =>
      file.candidateSource !== "unresolved" && validated.has(file.path)) && !dirty;
  }
  function updateButtons() {
    const result = node("result");
    if (result) result.disabled = busy;
    for (const button of document.querySelectorAll("button")) button.disabled = busy || button.dataset.unavailable === "true" ||
      (button.dataset.command === "pick" && (!pickMappingValid || isDelete(metadata()))) ||
      (applied() && ["pick", "choose", "save", "agent", "delete-remote", "delete-local"].includes(button.dataset.command));
    node("apply").textContent = applied() ? "Retry sync…" : "Review & apply all…";
    node("apply").disabled = busy || !readyToApply();
  }
  function navigate(path) {
    if (busy || path === selected || !state?.files.some(file => file.path === path) || !discard()) return;
    selected = path;
    draft = current()?.binary ? "" : current()?.merged ?? "";
    render();
  }
  function request(command, source) {
    if (busy || !state) return;
    if (command !== "save" && !discard()) return;
    if (applied() && !["refresh", "apply", "compare"].includes(command)) return;
    if (command === "apply" && (!readyToApply() || !window.confirm(applied() ?
      "Retry GitHub Sync for these already-applied local decisions? This is not confirmation of a successful GitHub push." :
      "Apply all saved and validated decisions to local knowledge and queue GitHub Sync?\n\nThis is not confirmation of a successful GitHub push. Deletions will affect the indicated local and/or synchronized files."))) return;
    if (command === "delete-remote" && !window.confirm(
      "Delete this file from the synchronized result (local knowledge and GitHub on the next sync)? This is a deletion decision, not an empty text file. Nothing is deleted until final apply.")) return;
    if (command === "delete-local" && !window.confirm(
      "Delete this file from local knowledge only and leave the GitHub variant unchanged? Review this destructive decision before final apply.")) return;
    if (command === "agent" && !supportedAgent()) return;
    if (command === "save" && (!current() || isDelete(metadata()) ||
        (current().binary && metadata()?.candidateSource === "unresolved"))) return;
    busy = true;
    error("");
    node("status").textContent = command === "agent" ? "Agent reviewing candidate… human review still required." : "Working…";
    updateButtons();
    vscode.postMessage({
      command, conflictId: state.record.id, revision: state.record.revision ?? 0,
      ...(!["refresh", "apply"].includes(command) ? { path: selected } : {}),
      ...(source ? { source } : {}),
      ...(command === "save" && !current().binary ? { content: draft } : {}),
    });
  }
  function binaryPreview(file, source) {
    const uri = file.previews?.[source];
    return safePreview(uri) ? `<img src="${esc(uri)}" alt="${esc(source)} image preview"><p><a href="${esc(uri)}" download="${esc(file.path.split("/").pop())}">Download ${esc(source)} image</a></p>` :
      '<p class="muted">No safe inline preview. Use native compare to inspect or save the original bytes.</p>';
  }
  function pickDifference(index, source) {
    const block = differenceBlocks[index];
    if (busy || applied() || !pickMappingValid || isDelete(metadata()) || !block ||
        !["local", "remote"].includes(source) || block.resultStart === undefined || block.resultEnd === undefined) return;
    const start = block.resultStart, end = block.resultEnd, replacement = block[source];
    draft = draft.slice(0, start) + replacement + draft.slice(end);
    const shift = replacement.length - (end - start);
    for (const [otherIndex, other] of differenceBlocks.entries()) {
      if (otherIndex === index || other.resultStart === undefined || other.resultEnd === undefined) continue;
      if (otherIndex > index && other.resultStart >= end) { other.resultStart += shift; other.resultEnd += shift; }
      else if (other.resultEnd > start) { other.resultStart = undefined; other.resultEnd = undefined; }
    }
    block.resultEnd = start + replacement.length; block.choice = source;
    node("result").value = draft;
    dirty = draft !== (current()?.merged ?? "");
    node("dirty").textContent = dirty ? "Unsaved block picks — save & validate before applying" : "No unsaved edits";
    node(`choice-${index}`).textContent = `Picked ${source} for this block`;
    node("status").textContent = "Difference picked into the editable result. Nothing has been saved or applied.";
    renderDifferences();
    updateButtons();
  }
  function renderDifferences() {
    const container = node("difference-blocks");
    if (!container) return;
    const comparison = current()?.comparison;
    container.innerHTML = comparison?.warning ? `<p class="error">${esc(comparison.warning)}</p>` :
      !differenceBlocks.length ? `<p>Local and GitHub text are identical.</p><div class="difference-sides">
        ${["local", "remote"].map(source => `<pre>${esc(current()?.[source] ?? "")}</pre>`).join("")}</div>` :
      differenceBlocks.map((block, index) => `<section class="difference-block" aria-label="Difference ${index + 1}">
        <h3>Difference ${index + 1}</h3>
        ${block.contextBefore ? `<pre class="difference-context">${esc(block.contextBefore)}</pre>` : ""}
        <div class="difference-sides">${["local", "remote"].map(source => `<section>
          <strong>${source === "local" ? "Left · Local" : "Right · GitHub"} · line ${block[`${source}Line`]}</strong>
          <pre class="difference-${source}">${esc(block[source] || "(No lines on this side — picking it removes this block)")}</pre>
          <button data-command="pick" data-index="${index}" data-source="${source}" data-unavailable="${block.resultStart === undefined}">Pick ${source === "local" ? "left" : "right"} · difference ${index + 1}</button>
        </section>`).join("")}</div>
        ${block.contextAfter ? `<pre class="difference-context">${esc(block.contextAfter)}</pre>` : ""}
        <p id="choice-${index}" class="difference-choice">${block.choice ? `Picked ${esc(block.choice)} for this block` : "Not picked — existing result kept"}</p>
        ${block.resultStart === undefined ? '<p class="error">This result edit spans multiple difference boundaries. Edit the result directly; no safe block replacement is available.</p>' : ""}
      </section>`).join("");
    for (const button of container.querySelectorAll("button")) button.addEventListener("click", () => pickDifference(Number(button.dataset.index), button.dataset.source));
  }
  function renderFileTree() {
    const root = { folders: new Map(), files: [] };
    for (const file of state?.record.files || []) {
      const parts = file.path.split("/");
      let branch = root, prefix = "";
      for (const part of parts.slice(0, -1)) {
        prefix += `${prefix ? "/" : ""}${part}`;
        if (!branch.folders.has(part)) branch.folders.set(part, { folders: new Map(), files: [], path: prefix });
        branch = branch.folders.get(part);
      }
      branch.files.push({ ...file, name: parts.at(-1) });
    }
    const contents = branch => [...branch.folders].map(([name, folder]) =>
      `<details data-folder="${esc(folder.path)}" ${fileTreeOpen.get(folder.path) !== false ? "open" : ""}>
        <summary>${esc(name)}</summary><div class="file-tree-children">${contents(folder)}</div></details>`).join("") +
      branch.files.map(file => `<button data-path="${esc(file.path)}" title="${esc(file.path)}"
        class="${file.path === selected ? "active" : ""}" ${file.path === selected ? 'aria-current="true"' : ""}>
        <span>${esc(file.name)}</span><small>${esc(file.candidateSource)}${validated.has(file.path) ? " ✓" : ""}</small></button>`).join("");
    node("files").innerHTML = contents(root);
    for (const button of node("files").querySelectorAll("button")) button.addEventListener("click", () => navigate(button.dataset.path));
    for (const folder of node("files").querySelectorAll("details")) folder.addEventListener("toggle", () => fileTreeOpen.set(folder.dataset.folder, folder.open));
  }
  function render() {
    const unresolved = state?.record.files.filter(file => file.candidateSource === "unresolved").length ?? 0;
    node("count").textContent = applied() ? "Applied locally · sync pending" : state ?
      `${unresolved} unresolved · ${validated.size}/${state.record.files.length} saved & validated` : "No active conflict";
    renderFileTree();
    const file = current();
    const meta = metadata();
    if (!file || !meta) { node("detail").textContent = "No active conflict. Refresh to check for new conflicts."; updateButtons(); return; }
    const present = source => meta[source === "base" ? "hasBase" : source === "local" ? "hasLocal" : "hasRemote"];
    differenceBlocks = (file.comparison?.blocks || []).map(block => ({ ...block }));
    pickMappingValid = true;
    node("detail").innerHTML = `<h2>${esc(file.path)}</h2><p>Candidate: ${esc(meta.candidateSource)} · ${file.binary ? "Binary / image — never editable" : "Text"}${file.mime ? ` · ${esc(file.mime)}` : ""}</p>
      ${!file.binary && file.comparison ? `<section class="differences"><div class="difference-headings">
        <section><h2>Local (this machine)</h2><button data-command="choose" data-source="local">Pick all left (local)</button>
          <button data-command="compare" data-source="local">Native compare local / result</button>
          ${meta.localPath ? `<p class="muted">${esc(meta.localPath)}</p>` : ""}</section>
        <section><h2>GitHub (remote)</h2><button data-command="choose" data-source="remote">Pick all right (GitHub)</button>
          <button data-command="compare" data-source="remote">Native compare remote / result</button>
          ${meta.remotePath ? `<p class="muted">${esc(meta.remotePath)}</p>` : ""}</section></div>
        <p class="muted">Highlighted differences: red is local, green is GitHub; neither color means correct or incorrect. Pick blocks, then freely edit the result below.</p>
        <p id="pick-status" class="muted">Picks only change the draft. Save &amp; validate before applying. Empty blocks remove lines, not the whole file.</p><div id="difference-blocks"></div></section>` :
      `<div class="variants">${[["local", "Local (this machine)"], ["remote", "GitHub (remote)"]].map(([source, label]) =>
        `<section class="variant"><h2>${label}</h2>${meta[`${source}Path`] ? `<p class="muted">${esc(meta[`${source}Path`])}</p>` : ""}${!present(source) ? "<p>Absent — no file</p>" :
          file.binary ? binaryPreview(file, source) : `<pre>${esc(file[source] ?? "")}</pre>`}
        <button data-command="choose" data-source="${source}" data-unavailable="${!present(source)}">${source === "local" ? "Pick all left (local)" : "Pick all right (GitHub)"}</button>
        <button data-command="compare" data-source="${source}" data-unavailable="${!present(source)}">Native compare ${source} / result</button></section>`).join("")}</div>`}
      <details class="base-preview"><summary>Common base (last shared snapshot)</summary>
        ${meta.basePath ? `<p class="muted">${esc(meta.basePath)}</p>` : ""}
        ${!present("base") ? "<p>Absent — no file</p>" : file.binary ? binaryPreview(file, "base") : `<pre>${esc(file.base ?? "")}</pre>`}
        <button data-command="choose" data-source="base" data-unavailable="${!present("base")}">Choose base</button>
        <button data-command="compare" data-source="base" data-unavailable="${!present("base")}">Native compare base / result</button></details>
      <section class="result"><h2>${file.binary || applied() ? "Result (read-only)" : "Editable result"}</h2>
      ${meta.resultPath ? `<p class="muted">${esc(meta.resultPath)}</p>` : ""}
      ${isDelete(meta) ? `<p class="error">${meta.candidateSource === "delete-local" ? "Delete local only; GitHub stays unchanged." : "Delete local and from GitHub on the next sync."}</p>` :
        file.binary ? binaryPreview(file, "merged") : '<textarea id="result" aria-label="Editable merged result" spellcheck="false"></textarea>'}
      <p id="dirty" class="muted">${dirty ? "Unsaved edits" : validated.has(selected) ? "Saved & validated" : "Review and explicitly save & validate this result"}</p>
      <div class="toolbar"><button data-command="save" data-unavailable="${isDelete(meta) || (file.binary && meta.candidateSource === "unresolved")}">Save &amp; validate</button>
      <button data-command="agent" data-unavailable="${!supportedAgent()}">Ask Agent</button>
      <button data-command="delete-remote" data-unavailable="${!meta.hasRemote}">Delete from synced result…</button>
      <button data-command="delete-local" data-unavailable="${!meta.hasLocal}">Delete local only…</button></div>
      ${meta.rationale ? `<p>${esc(meta.rationale)}</p>` : ""}
      ${meta.agentReview ? `<h2>Agent review — human final review required</h2><pre>${esc(JSON.stringify(meta.agentReview, null, 2))}</pre>` : ""}</section>`;
    const result = node("result");
    if (result) {
      result.value = draft;
      result.readOnly = applied();
      result.addEventListener("input", () => {
        draft = result.value;
        dirty = draft !== (current()?.merged ?? "");
        pickMappingValid = false;
        if (node("pick-status")) node("pick-status").textContent = "Manual result edits detected. Save & validate to recalculate safe block positions before picking again.";
        node("dirty").textContent = dirty ? "Unsaved edits — save & validate before applying" : "No unsaved edits";
        updateButtons();
      });
    }
    for (const button of node("detail").querySelectorAll("button")) button.addEventListener("click", () => request(button.dataset.command, button.dataset.source));
    renderDifferences();
    updateButtons();
  }
  node("previous").addEventListener("click", () => {
    const index = state?.files.findIndex(file => file.path === selected) ?? -1;
    if (index > 0) navigate(state.files[index - 1].path);
  });
  node("next").addEventListener("click", () => {
    const index = state?.files.findIndex(file => file.path === selected) ?? -1;
    if (state && index >= 0 && index < state.files.length - 1) navigate(state.files[index + 1].path);
  });
  for (const command of ["refresh", "apply"]) node(command).addEventListener("click", () => request(command));
  node("toggle-files").addEventListener("click", () => {
    const collapsed = node("files").hidden = !node("files").hidden;
    node("layout").classList.toggle("files-collapsed", collapsed);
    node("toggle-files").textContent = collapsed ? "Show file tree" : "Hide file tree";
    node("toggle-files").setAttribute("aria-expanded", String(!collapsed));
  });
  window.addEventListener("beforeunload", event => {
    if (dirty) { event.preventDefault(); event.returnValue = "Unsaved conflict result"; }
  });
  window.addEventListener("message", event => {
    const message = event.data;
    if (message?.type === "navigate") { navigate(message.path); return; }
    if (message?.type === "error") {
      busy = false;
      error(message.error || "Conflict action failed.");
      node("status").textContent = applied() ?
        "Action failed. Applied locally; GitHub sync pending. Retry sync or refresh to check completion." :
        "Action failed. Your result edits are retained; refresh if the conflict changed.";
      updateButtons();
      return;
    }
    if (message?.type !== "state") return;
    // A failed or unsolicited refresh must never erase an unsaved editor buffer.
    if (dirty && message.completed !== "save") {
      busy = false;
      error("A new conflict state arrived while the result has unsaved edits. Save or discard edits, then refresh.");
      updateButtons();
      return;
    }
    state = message.state;
    validated = new Set(message.validatedPaths || []);
    if (!state?.files.some(file => file.path === selected)) selected =
      state?.files.find(file => file.path === message.initialPath)?.path ?? state?.files[0]?.path;
    dirty = false;
    busy = false;
    draft = current()?.binary ? "" : current()?.merged ?? "";
    error(message.error || "");
    node("status").textContent = !state ?
      "No active conflict workspace. Check GitHub Sync status for push completion." : applied() ?
      "Applied locally; GitHub sync pending. Refresh to check completion. Retry sync if the queued sync failed." : message.completed === "apply" ?
      "Local decisions accepted; GitHub Sync queued. GitHub push success is reported separately by sync status." :
      message.completed === "save" ? "Candidate saved & validated. Local knowledge has not been applied." :
      message.completed === "agent" ? "Agent candidate ready. Review it, then save & validate; nothing has been applied." :
      "Review each result. All decisions require explicit validation before final apply.";
    render();
  });
  vscode.postMessage({ command: "ready" });
})();
