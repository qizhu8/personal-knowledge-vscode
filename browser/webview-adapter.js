"use strict";
(() => {
  // Protect the bundle's Markdown sinks without changing its layout or JavaScript.
  // Browser sessions do not expose external links or library resource URLs.
  marked.use({ renderer: {
    html: () => "",
    image: () => "",
    link({ tokens }) { return this.parser.parseInline(tokens); },
  } });
  let viewState = { workspace: "knowledge", tab: "notes" };
  let listSequence = 0;
  const notice = text => {
    const status = document.getElementById("browser-release-status");
    if (status) status.textContent = text;
  };
  const originalOwner = document.getElementById("pkm-original-browser");
  const originalReadOnly = !!originalOwner && originalOwner.dataset.notesAccess !== "write";
  const defaultStatus = originalOwner ? `Browser · Original Notes${originalReadOnly ? " (read-only)" : ""}` : "Browser release gate · Notes and PKM Chat";
  const paths = new Map();
  const emit = message => window.dispatchEvent(new MessageEvent("message", { data: message }));
  async function post(path, value) {
    const response = await fetch(`/webview/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path === "message") location.replace("/webview/");
      throw Object.assign(new Error(data.error || "Browser request failed."), { effect: data.effect });
    }
    return data;
  }
  async function receive(message) {
    switch (message.command) {
      case "ready": case "webviewStartupTiming": case "webviewDiagnostic": case "webviewLibraryTiming":
      case "markdownDraftState": case "refreshKnowledgeFolder": case "noteFolderPins": case "listSubscriptionGroups":
        return;
      case "createKnowledgeItem":
        if (message.area === "notes" && !originalReadOnly) { toggleNoteForm(); return; }
        break;
      case "list":
        if (message.tab === "notes" && !message.regex) {
          const sequence = ++listSequence;
          try {
            const page = await post("message", { command: "list", q: message.q || "", caseSensitive: !!message.caseSensitive });
            if (sequence !== listSequence) return;
            paths.clear();
            for (const note of page.items) paths.set(note.slug, note.path);
            emit({ command: "list", tab: "notes", q: message.q, data: page.items, profileRequestId: message.profileRequestId });
            notice(page.total > page.items.length ? `Showing first ${page.items.length} of ${page.total} Notes` : defaultStatus);
          } catch (error) {
            if (sequence === listSequence) notice(error.message);
          }
          return;
        }
        break;
      case "detail":
        if (message.type === "note" && message.detailTab === "notes") {
          try {
            const data = await post("message", { command: "detail", path: paths.get(message.key) || `${message.key}.md` });
            emit({ command: "detail", data, detailTab: "notes", detailRequestId: message.detailRequestId });
            if (message.detailRequestId === detailRequestSequence) {
              const edit = document.querySelector('#detail button[onclick^="openMarkdownItem("]');
              if (edit && !data.editPin) { edit.disabled = true; edit.title = "Note content editing is unavailable."; }
            }
          } catch (error) {
            if (message.detailRequestId === detailRequestSequence) notice(error.message);
          }
          return;
        }
        break;
      case "toast":
        if (typeof message.text === "string") notice(message.text);
        return;
    }
    notice("That action is not available in the browser release gate.");
  }
  window.acquireVsCodeApi = () => ({
    getState: () => viewState,
    setState: next => { viewState = next; },
    postMessage: message => { void receive(message); },
  });
  document.addEventListener("DOMContentLoaded", () => {
    const byId = id => document.getElementById(id);
    const topbar = byId("topbar");
    const status = document.createElement("span");
    status.id = "browser-release-status";
    status.setAttribute("role", "status");
    status.textContent = defaultStatus;
    const signOut = document.createElement("button");
    signOut.type = "button";
    signOut.className = "tbtn";
    signOut.textContent = "Sign out";
    signOut.addEventListener("click", async () => {
      try {
        await post("sign-out", {});
        sessionStorage.removeItem("pkm-webview-thread");
        location.replace("/webview/");
      }
      catch { notice("Sign-out failed. Try again."); }
    });
    topbar.append(status, signOut);
    for (const control of document.querySelectorAll(
      ".workspace-button:not([data-workspace=knowledge]), .tab:not([data-tab=notes]), "
      + "#duplicate-pkm-tab, #go-to-pkm-path-button, #whats-new-button, #start-tour-button, #search-regex, #more-btn",
    )) {
      control.disabled = true;
      control.title = "Not available in the browser release gate";
    }
    knowledgeSearchMode.value = "filter";
    knowledgeSearchMode.hidden = true;
    byId("searchbox").setAttribute("aria-label", "Search Notes");
    byId("content-find-control").classList.add("panel-find-open");

    // Bind only explicit controls. Inline event strings remain inert under CSP,
    // including any dynamic HTML emitted by the desktop bundle.
    function bind(element, event, handler) {
      element.addEventListener(event, e => { e.preventDefault(); e.stopImmediatePropagation(); handler(e); }, true);
    }
    const create = byId("btn-add-knowledge");
    if (originalReadOnly) {
      create.disabled = true;
      create.title = "Original Note writes are not available in the browser.";
    }
    if (originalOwner && !originalOwner.dataset.notesAccess) byId("search-case").disabled = true;
    const form = byId("note-form");
    const save = form.querySelector(".form-actions button:last-child");
    const cancel = form.querySelector(".form-actions button:first-child");
    const metadata = ["note-title", "note-type", "note-tags", "note-category"].map(byId);
    let editPin = null;
    const editMode = pin => { editPin = pin; for (const field of metadata) field.disabled = !!pin; };
    bind(byId("open-pkm-chat-button"), "click", () => { location.assign("/webview/chat"); });
    bind(create, "click", () => {
      if (form.classList.contains("hidden")) { editMode(null); toggleNoteForm(); }
    });
    bind(cancel, "click", () => { if (!save.disabled) { editMode(null); toggleNoteForm(); } });
    byId("detail").addEventListener("click", event => {
      if (!event.target.closest('button[onclick^="openMarkdownItem("]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (save.disabled || !form.classList.contains("hidden")) { notice("Close the current draft first."); return; }
      if (!currentDetail?.editPin) { notice("Note content editing is unavailable."); return; }
      editMode(currentDetail.editPin);
      editNote(currentDetail);
    }, true);
    byId("note-content").addEventListener("input", updateNotePreview);
    byId("note-content").removeAttribute("oninput");
    bind(byId("content-toolbar").querySelector('[onclick="doReload()"]'), "click", () => contentSearchChanged(true));
    bind(byId("search-case"), "click", () => toggleFindOption("content", "case"));
    bind(byId("search-prev"), "click", () => navigateFind("content", -1));
    bind(byId("search-next"), "click", () => navigateFind("content", 1));
    bind(byId("content-find-control").querySelector('[onclick="closePanelFind()"]'), "click", closePanelFind);
    bind(save, "click", async () => {
      if (save.disabled) return;
      const content = byId("note-content").value.trim();
      if (!content) { notice("Enter Note content before saving."); return; }
      save.disabled = true;
      let uncertain = false;
      try {
        const operationId = crypto.randomUUID();
        await post("message", editPin ? { command: "updateNote", operationId, content, ...editPin }
          : { command: "saveNote", operationId, content,
          title: byId("note-title").value.trim() || Array.from(content).slice(0, 60).join(""),
          type: byId("note-type").value, category: byId("note-category").value.trim(),
          tags: byId("note-tags").value.split(",").map(tag => tag.trim()).filter(Boolean) });
        const reopen = editPin && currentDetail?.editPin === editPin ? currentDetail.slug : null;
        for (const id of ["note-title", "note-content", "note-tags", "note-category"]) byId(id).value = "";
        editMode(null);
        toggleNoteForm();
        emit({ command: "saved" });
        if (reopen) requestDetail("note", reopen);
      } catch (error) {
        uncertain = error.effect !== "not-committed";
        notice(uncertain ? "Save not confirmed. Check the library before submitting this draft again." : error.message);
      } finally {
        save.disabled = uncertain;
      }
    });
    const list = byId("item-list");
    const open = event => {
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      const header = event.target.closest(".tree-cat-hdr");
      const row = event.target.closest(".li[data-note-slug]");
      if (!row && !header) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.target.closest(".pc-star, .tree-cat-add, .markdown-assets")) {
        notice("That action is not available in the browser release gate.");
      } else if (row && list.contains(row)) {
        list.querySelector(".li.active")?.classList.remove("active");
        row.classList.add("active");
        requestDetail("note", row.dataset.noteSlug);
      } else if (header && list.contains(header)) {
        const key = /^toggleCat\('([a-z]*:[A-Za-z0-9+/=]+)',this\)$/.exec(header.getAttribute("onclick") || "")?.[1];
        if (key) toggleCat(key, header);
      }
    };
    for (const event of ["click", "keydown"]) list.addEventListener(event, open, true);
  });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
