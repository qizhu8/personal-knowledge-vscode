const fs = require("fs");
const path = require("path");
const { ApiChatStore, apiChatDiagnostics, apiChatSessionDiagnostics } = require("../dist/chat/api-chat-store");

try {
  const [root, identity] = process.argv.slice(2);
  const chat = /^pkm:\/\/chats\/([a-f0-9]{16})\/([a-f0-9-]{36})$/.exec(identity || "");
  if (process.argv.length !== 4 || !root || (!chat && !/^agent_session_[a-f0-9]{32}$/.test(identity || ""))) throw new Error("Invalid arguments.");
  const state = path.join(path.resolve(root), ".pkm", "state");
  const file = chat ? path.join(state, "api-chats", chat[1], `${chat[2]}.json`)
    : path.join(state, "agent-sessions", `${identity}.json`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported Session file.");
  const diagnostics = chat ? apiChatDiagnostics(new ApiChatStore(state, chat[1]).load(chat[2], false))
    : apiChatSessionDiagnostics(JSON.parse(fs.readFileSync(file, "utf8")), identity, state);
  const packet = JSON.stringify(diagnostics);
  if (Buffer.byteLength(packet) > 256 * 1024) throw new Error("Diagnostics exceed the local output limit.");
  process.stdout.write(packet + "\n");
} catch {
  process.stderr.write("Cannot export diagnostics: provide a Knowledge Root and matching PKM Chat URL or bounded PKM-native Session ID. No Chat or Session was changed.\n");
  process.exitCode = 1;
}