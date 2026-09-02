#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const runtimeFiles = [
  "resources/chat_server.py.template",
  "src/chatroom-client.ts",
  "src/chatroom-browser.ts",
  "src/chatroom-hub.ts",
  "src/chat-magic-link.ts",
  "dist/webview/panel.js",
];
const legacyPhrases = /waiting-approval|waiting for Host approval|wait for Host approval|Host approval timed out|Host approval did not complete/i;
for (const file of runtimeFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert.doesNotMatch(source, legacyPhrases, `${file} must not expose obsolete manual-approval semantics`);
}

const template = fs.readFileSync(path.join(root, "resources", "chat_server.py.template"), "utf8");
const compiled = spawnSync("python", ["-c", "import sys; compile(sys.stdin.read(), 'chat_server.py', 'exec')"], {
  input: template.replaceAll("%%CHAT_MCP_VERSION%%", "2.3.1"), encoding: "utf8",
});
assert.strictEqual(compiled.status, 0, compiled.stderr || "generated Chatroom template must compile");
assert.match(template, /"manual_approval_required": False/);
assert.match(template, /"preferred_server": "pkm"/);
assert.match(template, /Identity assignment is automatic/);
assert.match(template, /self\.status = "joining"/);

const hub = fs.readFileSync(path.join(root, "src", "chatroom-hub.ts"), "utf8");
assert.match(hub, /approveAutomatic\(pending\.approval\.requestId\)/);
const nonHostBranch = /else \{\s*await this\.approvals\.approveAutomatic\(pending\.approval\.requestId\);\s*\}/;
assert.match(hub, nonHostBranch, "valid non-Host joins must always use automatic identity assignment");

const invite = fs.readFileSync(path.join(root, "src", "chat-magic-link.ts"), "utf8");
assert.match(invite, /Discover the unified MCP server pkm/);
assert.match(invite, /Identity assignment is automatic/);

console.log("Chat Join test: no manual-approval wording, automatic identity assignment, and unified pkm guidance OK");
