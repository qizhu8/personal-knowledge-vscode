"use strict";
const fs = require("node:fs"), path = require("node:path");

module.exports = async ({ fixture, role, operation, page, state }) => {
  const stem = `action-failure-${role}-${operation}`.replace(/[^a-z0-9-]/gi, "_");
  const result = { role, operation, phase: state.phase, version: state.version,
    pendingOperation: state.pendingOperation, actionStartedAt: state.actionStartedAt };
  let visibleUi;
  try {
    visibleUi = await page.evaluate(() => {
      const visible = element => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      return {
        focus: { tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute("role") },
        surfaces: Array.from(document.querySelectorAll(
          ".monaco-dialog-box, .quick-input-widget, .notifications-toasts .notification-toast"))
          .filter(visible).map(element => ({ classes: element.className, text: element.innerText,
            buttons: Array.from(element.querySelectorAll("button, [role=button]")).map(button => button.innerText) })),
      };
    });
  } catch (error) { result.domCaptureErrorType = error.name; }
  try {
    await page.screenshot({ path: path.join(fixture, `${stem}.png`), timeout: 7000 });
    result.screenshot = `${stem}.png`;
  } catch (error) { result.screenshotErrorType = error.name; }
  result.privateDiagnostic = `${stem}.json`;
  fs.writeFileSync(path.join(fixture, result.privateDiagnostic), JSON.stringify({ ...result, visibleUi }, null, 2),
    { mode: 0o600 });
  return result;
};
