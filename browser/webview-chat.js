"use strict";
(() => {
  const get = id => document.getElementById(`chat-${id}`);
  const state = get("state"), title = get("title"), transcript = get("transcript"), list = get("list");
  const input = get("input"), send = get("send"), stop = get("stop"), create = get("create"), more = get("more");
  const share = get("share"), check = get("check"), turnState = get("turn-state");
  const terminal = s => ["completed", "cancelled", "failed", "unknown"].includes(s);
  let caps = {}, cursor, record, turn, selection = 0, pending = false, uncertain = false, timer;
  let transcriptCursor, transcriptTotal, transcriptCount = 0;
  const titles = new Map();
  const nativeKey = "pkm-webview-original-turn";
  let nativeRef, nativeStatus, nativeTimer, nativeReadySince, nativePreparing = false, nativeStopping = false, nativeChecking = false;
  const nativeDone = status => ["completed", "cancelled", "not-sent"].includes(status);
  const restoreNative = () => {
    try { return JSON.parse(sessionStorage.getItem(nativeKey)); }
    catch { return undefined; }
  };
  const sameNative = ref => nativeRef?.chatId === ref.chatId && nativeRef.turnId === ref.turnId;
  let selectedId = sessionStorage.getItem("pkm-webview-thread");
  const update = () => {
    if (caps.nativeTurns) {
      const current = nativeRef && nativeRef.chatId === selectedId;
      input.disabled = !selectedId || nativePreparing || !!nativeRef && !nativeDone(nativeStatus);
      send.disabled = input.disabled;
      stop.disabled = !current || nativeStatus !== "running" || nativeStopping;
      check.hidden = !nativeRef || nativeDone(nativeStatus);
      check.disabled = nativeChecking;
      create.disabled = true;
      return;
    }
    send.disabled = !record || !!record.archivedAt || !caps.send || (!!turn && !terminal(turn.status)) || pending || uncertain;
    input.disabled = !record || !caps.send || !!record.archivedAt;
    stop.disabled = !caps.stop || !turn || terminal(turn.status) || pending || uncertain;
    create.disabled = !caps.create || pending || uncertain;
  };
  async function call(command, args = {}) {
    const response = await fetch("/webview/message", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, ...args }) });
    if (response.status === 401) location.replace("/webview/");
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof value.error === "string" ? value.error : "Chat service unavailable."),
      { effect: value.effect });
    return value;
  }
  function row(role, content, status) {
    const article = document.createElement("article");
    const label = document.createElement("strong"), body = document.createElement("p");
    label.textContent = status ? `${role} · ${status}` : role;
    body.textContent = content;
    article.append(label, body);
    return article;
  }
  async function history(append = false) {
    const page = await call("chatList", append ? { cursor } : {});
    if (!append) list.replaceChildren();
    for (const chat of page.items) {
      titles.set(chat.id, chat.title);
      const button = document.createElement("button");
      button.textContent = chat.title;
      button.type = "button";
      button.dataset.id = chat.id;
      button.setAttribute("aria-current", String(chat.id === selectedId));
      button.addEventListener("click", () => { if (!pending) void open(chat.id); });
      list.append(button);
    }
    if (!list.children.length) list.textContent = "No conversations";
    cursor = page.nextCursor;
    more.hidden = cursor === null;
  }
  async function refresh(id, ticket, attempts = 0) {
    const base = await call("chatGet", { id });
    if (ticket !== selection) return;
    if (caps.latestReply) {
      title.textContent = base.title;
      transcript.replaceChildren();
      if (base.latestReply) transcript.append(row("assistant", base.latestReply.content, base.latestReply.status));
      state.textContent = `Original Chat · ${base.status} · ${base.latestReply
        ? `latest saved reply only${base.latestReply.truncated ? " (truncated)" : ""}` : "no reply"} · read-only`;
      update();
      return;
    }
    let after, last, active;
    for (let count = 0; count < 26; count++) {
      const page = await call("chatTurns", { sessionId: id, after });
      if (ticket !== selection) return;
      for (const item of page.items) { last = item; if (!terminal(item.status)) active = item; }
      if (page.next === null) break;
      if (count === 25 || page.next === after) throw new Error("Chat turn history exceeds the browser limit.");
      after = page.next;
    }
    let continuation, entries = [];
    for (let count = 0; count < 100; count++) {
      const page = await call("chatMessages", { id, cursor: continuation });
      if (ticket !== selection) return;
      entries.push(...page.items);
      if (!page.hasMore) break;
      if (count === 99 || page.nextCursor === continuation) throw new Error("Transcript exceeds the browser limit.");
      continuation = page.nextCursor;
    }
    const snapshot = await call("chatGet", { id });
    if (ticket !== selection) return;
    if (snapshot.revision !== base.revision) {
      if (attempts >= 3) throw new Error("Conversation changed while loading. Reopen it to try again.");
      return refresh(id, ticket, attempts + 1);
    }
    const atBottom = !record || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
    record = snapshot;
    turn = active ?? last;
    title.textContent = snapshot.title;
    transcript.replaceChildren(...entries.map(message => row(message.role, message.content, message.status)));
    if (active?.output) transcript.append(row("assistant", active.output, active.status));
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
    state.textContent = snapshot.archivedAt ? "Archived · history only"
      : active?.status === "approval" ? (caps.review ? "Waiting for separately authorized human review." : "Human review unavailable.")
        : turn ? `Turn ${turn.status}${turn.status === "cancelled" ? " · in-flight effects may require inspection" : ""}`
          : caps.send ? "Ready" : "Generation unavailable for this service or actor.";
    update();
    if (active) timer = setTimeout(() => {
      if (!pending) void refresh(id, ticket).catch(readFailed);
    }, 750);
  }
  function readFailed(error) {
    if (pending) return;
    record = undefined; turn = undefined; update();
    state.textContent = error.message;
  }
  async function open(id) {
    clearTimeout(timer);
    const ticket = ++selection;
    selectedId = id;
    sessionStorage.setItem("pkm-webview-thread", id);
    for (const button of list.querySelectorAll("button")) button.setAttribute("aria-current", String(button.dataset.id === id));
    record = undefined; turn = undefined; update();
    transcript.replaceChildren();
    share.hidden = true;
    if (caps.nativeTranscript) {
      transcriptCursor = undefined;
      transcriptCount = 0;
      transcriptTotal = undefined;
      share.disabled = false;
      share.textContent = "Request transcript";
      share.hidden = false;
      title.textContent = titles.get(id) || "Original Chat";
      state.textContent = caps.detachedOriginal ? "Read-only transcript · Only previously approved content is available."
        : "Read-only · Request the transcript, then confirm sharing in VS Code.";
      update();
      return;
    }
    state.textContent = "Loading server history…";
    try { await refresh(id, ticket); } catch (error) { if (ticket === selection) readFailed(error); }
  }
  share.addEventListener("click", async () => {
    if (!caps.nativeTranscript || !selectedId || share.disabled) return;
    const ticket = selection, next = transcriptCursor;
    share.disabled = true;
    state.textContent = next ? "Loading next transcript page…" : "Waiting for approval in the owning VS Code window…";
    try {
      const page = await call("chatMessages", { id: selectedId, cursor: next });
      if (ticket !== selection) return;
      if (page.start !== transcriptCount || transcriptTotal !== undefined && page.total !== transcriptTotal)
        throw new Error("Transcript changed. Request it again in VS Code.");
      transcript.append(...page.messages.map(message => row(message.role, message.content, message.status)));
      transcriptCount += page.messages.length;
      transcriptTotal = page.total;
      transcriptCursor = page.nextCursor;
      share.hidden = transcriptCursor === null;
      if (share.hidden) transcript.focus();
      share.textContent = "Show more messages";
      state.textContent = `Read-only · ${transcriptCount} of ${transcriptTotal} messages`;
    } catch (error) {
      if (ticket !== selection) return;
      transcript.replaceChildren();
      transcriptCount = 0;
      transcriptTotal = undefined;
      transcriptCursor = undefined;
      share.textContent = "Request transcript";
      state.textContent = error.message;
    } finally { if (ticket === selection) share.disabled = false; }
  });
  function applyNative(ref, status) {
    if (!sameNative(ref) || nativeDone(nativeStatus)) return;
    if (status === "ready") {
      if (nativeStatus && nativeStatus !== "ready") return;
      nativeReadySince ??= Date.now();
      if (Date.now() - nativeReadySince > 15000) status = "unknown";
    }
    if (status === "confirming" && ["running", "stop-requested"].includes(nativeStatus)) return;
    if (status === "running" && nativeStatus === "stop-requested") return;
    clearTimeout(nativeTimer);
    nativeStatus = status;
    const labels = {
      ready: "Waiting for the owning Chat to receive this turn.",
      confirming: caps.detachedOriginal ? "Checking prior approval for this exact message." : "Confirm the exact message in the owning VS Code window.",
      running: "Turn running in the owning Chat.",
      "stop-requested": "Stop requested in the owning Chat.",
      completed: "Turn completed. Request a fresh transcript to read the reply.",
      cancelled: "Owning Chat cancelled the turn; upstream cancellation is not confirmed.",
      "not-sent": "The owning Chat did not send the message.",
      unknown: "Outcome unknown. Inspect the owning Chat; do not resend to reconcile.",
    };
    turnState.textContent = labels[status];
    if (nativeDone(status)) {
      sessionStorage.removeItem(nativeKey);
      if (status !== "not-sent" && selectedId === ref.chatId && caps.nativeTranscript) void open(selectedId);
    } else if (status !== "unknown") nativeTimer = setTimeout(() => { void checkNative(ref); }, 850);
    update();
  }
  async function checkNative(ref = nativeRef) {
    if (!ref || nativeChecking || !sameNative(ref) || nativeDone(nativeStatus)) return;
    nativeChecking = true; update();
    try { applyNative(ref, (await call("originalChatStatus", ref)).status); }
    catch { applyNative(ref, "unknown"); }
    finally {
      nativeChecking = false;
      if (sameNative(ref) && !nativeDone(nativeStatus) && nativeStatus !== "unknown") {
        clearTimeout(nativeTimer);
        nativeTimer = setTimeout(() => { void checkNative(ref); }, 850);
      }
      update();
    }
  }
  check.addEventListener("click", () => { void checkNative(); });
  async function startNative() {
    if (send.disabled || !input.value.trim()) return;
    const chatId = selectedId, text = input.value;
    nativePreparing = true; update();
    turnState.textContent = caps.detachedOriginal ? "Checking the selected Chat and prior approval…" : "Checking the selected Chat in VS Code…";
    let ref;
    try {
      const target = await call("originalChatTarget", { chatId });
      if (selectedId !== chatId) return;
      ref = { chatId, turnId: target.turnId };
      sessionStorage.setItem(nativeKey, JSON.stringify(ref));
      nativeRef = ref; nativeStatus = undefined;
      nativeReadySince = undefined;
      input.value = "";
      applyNative(ref, "ready");
      const result = await call("originalChatSend", { ...ref, revision: target.revision, text });
      applyNative(ref, result.status);
    } catch (error) {
      if (ref && sameNative(ref)) { applyNative(ref, "unknown"); void checkNative(ref); }
      else turnState.textContent = error.message;
    } finally { nativePreparing = false; update(); }
  }
  async function mutate(fn) {
    clearTimeout(timer);
    const ticket = ++selection;
    pending = true; update();
    let failure;
    try { await fn(); }
    catch (error) { failure = error; uncertain ||= error.effect !== "not-committed"; }
    finally { pending = false; update(); }
    if (selectedId && ticket === selection) {
      try { await refresh(selectedId, ticket); } catch (error) { if (ticket === selection) readFailed(error); }
    }
    if (failure && ticket === selection) state.textContent = uncertain
      ? "Outcome not confirmed. Inspect server history before trying again; no automatic replay." : failure.message;
  }
  get("composer").addEventListener("submit", event => {
    event.preventDefault();
    if (caps.nativeTurns) { void startNative(); return; }
    if (send.disabled || !input.value.trim()) return;
    const chat = record;
    void mutate(async () => {
      await call("chatStart", { id: crypto.randomUUID(), sessionId: chat.id, expectedSessionRevision: chat.revision,
        operationId: crypto.randomUUID(), content: input.value });
      input.value = "";
    });
  });
  stop.addEventListener("click", () => {
    if (stop.disabled) return;
    if (caps.nativeTurns) {
      const ref = nativeRef;
      nativeStopping = true; update();
      void call("originalChatStop", ref).then(reply => applyNative(ref, reply.status),
        () => { void checkNative(ref); }).finally(() => { nativeStopping = false; update(); });
      return;
    }
    const pinned = turn;
    void mutate(() => call("chatStop", { id: pinned.id, expectedRevision: pinned.revision, operationId: crypto.randomUUID() }));
  });
  create.addEventListener("click", () => {
    if (create.disabled) return;
    const id = crypto.randomUUID();
    void mutate(async () => {
      await call("chatCreate", { id, operationId: crypto.randomUUID() });
      selectedId = id;
      sessionStorage.setItem("pkm-webview-thread", id);
      await history().catch(() => {});
    });
  });
  more.addEventListener("click", () => { void history(true).catch(error => { state.textContent = error.message; }); });
  (async () => {
    caps = await call("chatCapabilities");
    if (caps.nativeTurns) {
      input.maxLength = 2000;
      create.title = "Create Chats in the owning PKM Chat window.";
      turnState.hidden = false;
      nativeRef = restoreNative();
      if (nativeRef) void checkNative();
      else turnState.textContent = caps.detachedOriginal ? "Text only · Only the exact previously approved message can be sent."
        : "Text only · Send requires confirmation in the owning VS Code window.";
    }
    const review = get("review");
    if (caps.review) {
      const link = document.createElement("a");
      link.href = "/human-review"; link.textContent = "Open review desk (separate enrollment required)";
      review.replaceChildren(link);
    } else review.textContent = "Human review unavailable on this service.";
    if (!caps.history && !caps.latestReply && !caps.nativeTranscript) { state.textContent = "Chat history unavailable for this actor."; return; }
    await history();
    update();
    if (selectedId) await open(selectedId);
    else state.textContent = caps.nativeTranscript ? "Choose an Original Chat to request its transcript."
      : caps.latestReply ? "Choose an Original Chat to read its latest saved reply."
      : caps.send ? "Choose a conversation to view its history." : "Generation unavailable; history is read-only.";
  })().catch(readFailed);
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
