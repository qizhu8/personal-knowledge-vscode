const fs = require("fs");
const path = require("path");
const { apiChatSessionDiagnostics } = require("../dist/chat/api-chat-store");

try {
  const [root, sessionId] = process.argv.slice(2);
  if (process.argv.length !== 4 || !root || !/^agent_session_[a-f0-9]{32}$/.test(sessionId || "")) throw new Error("Invalid arguments.");
  const file = path.join(path.resolve(root), ".pkm", "state", "agent-sessions", `${sessionId}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6_000_000) throw new Error("Unsupported Session file.");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const packet = JSON.stringify(apiChatSessionDiagnostics(record, sessionId), null, 2);
  if (Buffer.byteLength(packet) > 256 * 1024) throw new Error("Diagnostics exceed the local output limit.");
  process.stdout.write(packet + "\n");
} catch {
  process.stderr.write("Cannot export diagnostics: provide a Knowledge Root and matching, bounded PKM-native Session ID. No Session was changed.\n");
  process.exitCode = 1;
}