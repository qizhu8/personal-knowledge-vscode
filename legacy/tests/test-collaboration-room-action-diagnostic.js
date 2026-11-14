"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const capture = require("./next-trial-electron/collaboration-room-action-diagnostic.cjs");

function fixture(t) {
  const root = path.resolve(".migration-test-work", `action-diagnostic-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true }));
  return root;
}
test("pending command captures actual-page diagnostics without exposing private UI in public report", async t => {
  const root = fixture(t), surfaces = [{ text: "Private preparation failure", buttons: ["Dismiss"] }];
  const page = { async evaluate() { return { surfaces }; },
    async screenshot(options) { fs.writeFileSync(options.path, "screenshot fixture"); } };
  const result = await capture({ fixture: root, role: "host", operation: "upgrade", page,
    state: { phase: "prepare", version: "candidate", pendingOperation: "upgrade" } });
  assert.equal(result.pendingOperation, "upgrade");
  assert(fs.existsSync(path.join(root, result.screenshot)));
  assert(!JSON.stringify(result).includes(surfaces[0].text));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, result.privateDiagnostic))).visibleUi.surfaces, surfaces);
});
test("disposed renderer cannot erase the original pending-command evidence", async t => {
  const root = fixture(t), page = {
    async evaluate() { throw new TypeError("Disposed renderer"); },
    async screenshot() { throw new Error("Closed page"); },
  };
  const result = await capture({ fixture: root, role: "host", operation: "upgrade", page,
    state: { phase: "prepare", pendingOperation: "upgrade" } });
  assert.equal(result.domCaptureErrorType, "TypeError");
  assert.equal(result.screenshotErrorType, "Error");
  const saved = JSON.parse(fs.readFileSync(path.join(root, result.privateDiagnostic)));
  assert.equal(saved.pendingOperation, "upgrade");
  assert(!JSON.stringify(saved).includes("Disposed renderer"));
});
