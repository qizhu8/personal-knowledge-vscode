(() => {
  globalThis.PkmChatVisualization = ({ post, steer }) => {
    const button = document.getElementById("visualization");
    const panel = document.getElementById("visualization-panel");
    const content = document.getElementById("visualization-content");
    const requests = new Map();
    let chatId, view, generation = 0, sequence = 0, opening = false, notification;
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = `chat-visualization-${++sequence}`;
        const timer = setTimeout(() => {
          requests.delete(requestId);
          reject(new Error("Visualization request timed out. Close and reopen to retry."));
        }, 30000);
        requests.set(requestId, { resolve, reject, timer, chatId });
        post("visualizationRequest", { requestId, chatId, method, params });
      });
    }
    function receive(event) {
      const message = event.data;
      if (message?.type !== "visualizationResult") return;
      const pending = requests.get(message.requestId);
      if (!pending || message.chatId !== pending.chatId) return;
      clearTimeout(pending.timer); requests.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.data);
    }
    function close(focus = false) {
      generation++; opening = false;
      clearTimeout(notification); notification = undefined;
      panel.hidden = true; button.setAttribute("aria-expanded", "false");
      view?.dispose(); view = undefined; content.replaceChildren();
      for (const pending of requests.values()) {
        clearTimeout(pending.timer); pending.reject(new Error("Visualization closed."));
      }
      requests.clear();
      if (focus) button.focus();
    }
    async function open() {
      if (!chatId || opening) return;
      opening = true;
      const current = ++generation;
      panel.hidden = false; button.setAttribute("aria-expanded", "true");
      content.textContent = "Loading execution records...";
      try {
        const initial = await request("snapshot", {});
        if (current !== generation) return;
        content.replaceChildren();
        view = globalThis.PkmAgentHarness.mount(content, { initial, request });
        view.focusCurrent();
      } catch (error) {
        if (current !== generation) return;
        content.replaceChildren();
        const failure = document.createElement("p");
        failure.setAttribute("role", "alert");
        failure.textContent = error.message;
        content.append(failure);
      } finally { if (current === generation) opening = false; }
    }
    const keydown = event => {
      if (event.key === "Escape" && !panel.hidden && !panel.querySelector("dialog[open]")) {
        close(true); event.preventDefault();
      }
    };
    button.onclick = () => { if (panel.hidden) void open(); else close(); };
    document.getElementById("visualization-close").onclick = () => close(true);
    document.getElementById("visualization-steer").onclick = steer;
    window.addEventListener("message", receive);
    panel.addEventListener("keydown", keydown);
    return {
      setChat(id) { if (id !== chatId) { close(); chatId = id; } button.disabled = !id; },
      notify() {
        if (panel.hidden || notification) return;
        notification = setTimeout(() => { notification = undefined; view?.notify(); }, 250);
      },
      close,
      dispose() { close(); window.removeEventListener("message", receive); panel.removeEventListener("keydown", keydown); }
    };
  };
})();
