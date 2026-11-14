const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { diagnosticLogs, redactDiagnosticLine } = require("../dist/chat/chat-diagnostic-logs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-diagnostic-logs-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const root = path.join(directory, ".vscode-server", "data", "logs");
  const relative = "20261023T000000/exthost1/GitHub.copilot-chat/GitHub Copilot Chat.log";
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive:true });
  return { directory, root, relative, roots:{ fixture:root }, signal:new AbortController().signal };
}

test("diagnostic access discovers only allowed log names, not arbitrary hidden data or credentials", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, f.relative), "2026-10-23 [error] Authentication refresh failed: HTTP 401\n");
  fs.writeFileSync(path.join(f.root, "credentials.json"), '{"access_token":"SYNTHETIC_SECRET"}');
  fs.writeFileSync(path.join(f.root, "private.log"), "private prompt");
  const found = diagnosticLogs({ operation:"discover" }, f.signal, f.roots);
  assert.deepEqual(found.files.map(file => file.file), [f.relative]);
  const read = diagnosticLogs({ operation:"read", root:"fixture", file:f.relative }, f.signal, f.roots);
  assert.equal(read.excerpts.length, 1);
  assert.match(read.excerpts[0], /Authentication refresh failed: HTTP 401/);
  assert.equal(read.redacted, true);
  for (const file of ["../credentials.json", "/etc/passwd", "credentials.json", "private.log", "x/../main.log", ".secret/main.log", "a\\main.log"]) {
    assert.throws(() => diagnosticLogs({ operation:"read", root:"fixture", file }, f.signal, f.roots), /allowlisted/);
  }
  assert.throws(() => diagnosticLogs({ operation:"read", root:"__proto__", file:"main.log" }, f.signal, f.roots), /root/);
});

test("diagnostic excerpts redact authentication secrets, identity, URL paths and prompt payloads", () => {
  const input = "2026 [error] auth Bearer secretBearer access_token=secretAccess refresh_token:secretRefresh cookie=sessionSecret person@example.com "
    + "https://example.test/private?code=secretCode /home/synthetic-user/private ghp_AbCdEfG123";
  const output = redactDiagnosticLine(input);
  for (const secret of ["secretBearer", "secretAccess", "secretRefresh", "sessionSecret", "person@example.com", "secretCode", "synthetic-user", "ghp_AbCdEfG123"]) {
    assert(!output.includes(secret), secret);
  }
  assert(!redactDiagnosticLine('auth error payload={"messages":[{"content":"PRIVATE_PROMPT"}]}').includes("PRIVATE_PROMPT"));
  assert(redactDiagnosticLine("Authentication identity changed. Has token: true").includes("Has token: true"));
  assert.equal(redactDiagnosticLine("Got Copilot token for synthetic_account"), "Got Copilot token for [ACCOUNT]");
});

test("diagnostic reads reject symlink files and directories without opening them", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, "private"), "SYNTHETIC_PRIVATE");
  fs.symlinkSync(path.join(f.directory, "private"), path.join(f.root, f.relative));
  assert.equal(diagnosticLogs({ operation:"discover" }, f.signal, f.roots).files.length, 0);
  assert.throws(() => diagnosticLogs({ operation:"read", root:"fixture", file:f.relative }, f.signal, f.roots), /symbolic links/);
  fs.symlinkSync(path.dirname(path.join(f.root, f.relative)), path.join(f.root, "redirect"), "dir");
  assert.throws(() => diagnosticLogs({ operation:"read", root:"fixture", file:"redirect/GitHub Copilot Chat.log" }, f.signal, f.roots), /symbolic links/);
});

test("diagnostic reads are bounded, filterable and page older byte windows explicitly", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, f.relative), "2026 [error] EARLY_AUTH_FAILURE HTTP 401\n" + "unrelated line\n".repeat(30000) + "2026 [warning] token refresh pending\n".repeat(200));
  const latest = diagnosticLogs({ operation:"read", root:"fixture", file:f.relative }, f.signal, f.roots);
  assert(latest.endByte - latest.startByte <= 256 * 1024);
  assert(latest.beforeByte > 0);
  assert(latest.omittedLines > 0);
  assert(latest.excerpts.join("\n").length <= 12000);
  assert(latest.excerpts.length <= 40);
  const older = diagnosticLogs({ operation:"read", root:"fixture", file:f.relative, beforeByte:latest.beforeByte, query:"EARLY_AUTH_FAILURE" }, f.signal, f.roots);
  assert(older.excerpts.some(line => line.includes("HTTP 401")));
  assert.throws(() => diagnosticLogs({ operation:"read", root:"fixture", file:f.relative, beforeByte:-1 }, f.signal, f.roots), /cursor/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => diagnosticLogs({ operation:"discover" }, controller.signal, f.roots), /cancelled/);
});

test("diagnostic paging returns a boundary-crossing error as a whole line on the older page", t => {
  const f = fixture(t);
  const boundary = "2026 [error] Authentication BOUNDARY_START " + "X".repeat(600) + " HTTP 403 BOUNDARY_END\n";
  fs.writeFileSync(path.join(f.root, f.relative), "normal\n".repeat(100) + boundary + "ordinary\n".repeat(29100));
  const latest = diagnosticLogs({ operation:"read", root:"fixture", file:f.relative }, f.signal, f.roots);
  assert(!latest.excerpts.some(line => line.includes("BOUNDARY_START")));
  const older = diagnosticLogs({ operation:"read", root:"fixture", file:f.relative, beforeByte:latest.beforeByte }, f.signal, f.roots);
  assert(older.excerpts.some(line => line.includes("BOUNDARY_START")));
  assert(older.excerpts.some(line => line.includes("HTTP 403 BOUNDARY_END")));
  assert.equal(older.partialLinesOmitted, 0);
});
