const vscode = acquireVsCodeApi();
const state = { tab: "subscriptions" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const uiIcon = (_name, text = "") => esc(text);
const captureRefreshView = () => null;
const captureRefreshInputs = () => [];
const restoreRefreshInputs = () => {};
const restoreRefreshView = () => {};
const settingsTabBar = () => "";
const applySettingsSubtab = () => {};
const helpText = text => text;
const problemGuidanceHtml = text => `<p>${esc(text)}</p>`;
const ask = (command, args = {}) => vscode.postMessage({ command, ...args });
const pkModal = options => {
  const dialog = document.createElement("section");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", options.title);
  const title = document.createElement("h2"), message = document.createElement("p");
  title.textContent = options.title;
  message.textContent = options.message;
  const confirm = document.createElement("button"), cancel = document.createElement("button");
  confirm.textContent = options.okLabel || "OK";
  cancel.textContent = "Cancel";
  confirm.onclick = () => { dialog.remove(); options.onOk(); };
  cancel.onclick = () => dialog.remove();
  dialog.append(title, message, confirm, cancel);
  document.body.appendChild(dialog);
};
window.addEventListener("message", event => {
  const message = event.data;
  if (message?.command === "subscriptionState") {
    subscriptionOnState(message.data);
    document.getElementById("membership-status").textContent = message.pending
      ? "Membership action requires explicit recovery; only the admitted state is shown." : "";
    const cache = document.getElementById("fixture-cache");
    cache.replaceChildren();
    for (const note of message.cache || []) {
      const item = document.createElement("article");
      item.dataset.subscriptionId = note.subscriptionId;
      item.textContent = `${note.title}: ${note.content}`;
      cache.appendChild(item);
    }
  } else if (message?.command === "fixtureError") {
    document.getElementById("fixture-error").textContent = message.message;
  } else if (message?.command === "fixtureAck") {
    document.getElementById("fixture-ack").textContent = message.message;
  }
});
