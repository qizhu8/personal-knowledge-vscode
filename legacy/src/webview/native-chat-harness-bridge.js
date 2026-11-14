(function () {
  "use strict";
  const vscode = acquireVsCodeApi(), pending = new Map(), container = document.getElementById("harness");
  let view, closed = false;
  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("Task inspection is closed."));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Task inspection timed out.")); }, 35000);
      pending.set(id, { resolve, reject, timer });
      vscode.postMessage({ type: "nativeHarnessRequest", id, method, params });
    });
  }
  window.addEventListener("message", event => {
    const message = event.data;
    if (message?.type === "nativeHarnessChanged") { view?.notify(); return; }
    if (message?.type !== "nativeHarnessResponse") return;
    const operation = pending.get(message.id);
    if (!operation) return;
    clearTimeout(operation.timer); pending.delete(message.id);
    message.error ? operation.reject(new Error(message.error)) : operation.resolve(message.value);
  });
  window.addEventListener("pagehide", () => {
    closed = true; view?.dispose();
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error("Task inspection closed.")); }
    pending.clear();
  });
  void request("snapshot").then(initial => {
    if (!closed) view = PkmAgentHarness.mount(container, { initial, request, openBrowser: () => request("browser") });
  }, error => { container.textContent = error.message; container.setAttribute("role", "alert"); });
})();
