const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const projects = fs.readFileSync(path.join(root, "src/webview/panel/15-projects.js"), "utf8");
const knowledge = fs.readFileSync(path.join(root, "src/webview/panel/20-knowledge.js"), "utf8");
const group = (id, chat, category, title, extra = {}) => ({
  groupId: id, hostSessionId: chat, hostKind: "pkm", libraryGroupId: category,
  libraryGroupTitle: title, title: chat, ...extra,
});
const context = {
  projectSnapshot: { agentSessionGroups: [
    group("manager", "Manager", "research", "Research", { workerTreeId: "tree" }),
    group("worker", "Worker", "ungroup", "Ungroup", { workerParentChatId: "Manager", workerTreeId: "tree" }),
    group("empty", "Empty Chat", "research", "Research"),
    group("existing", "Existing Chat", "writing", "Writing"),
    group("deleted", "Deleted Chat", "research", "Research", { deletedAt: "2026-10-10" }),
  ] },
  selectedAgentSessionId: "", esc: value => String(value), agentSessionStatusIndicator: () => "",
  agentSessionLivenessLabel: () => "", captured: null,
  renderCatTree(tree, _path, _depth, _leaf, _q, _attr, _order, options) {
    context.captured = tree;
    for (const [name, child] of Object.entries(tree.folders)) {
      assert.match(options.renderFolderLabel(name), /codicon-folder/);
      for (const id of Object.keys(child.folders)) options.renderFolderLabel(id);
    }
    return "TREE";
  },
};
vm.createContext(context);
vm.runInContext(knowledge.slice(knowledge.indexOf("function buildCatTree("), knowledge.indexOf("// Ensure each given folder")), context);
vm.runInContext(projects.slice(projects.indexOf("function agentSessionGroupKey("), projects.indexOf("function renderNativeAgentArchitecture(")), context);
const sessions = [
  { sessionId: "task_manager", groupId: "manager", task: "Parent task" },
  { sessionId: "task_worker", groupId: "worker", task: "Worker task" },
  { sessionId: "task_existing", groupId: "existing", task: "Existing task" },
  { sessionId: "task_deleted", groupId: "deleted", task: "Deleted task" },
];
assert.equal(context.agentSessionTree(sessions), '<div class="agent-session-tree">TREE</div>');
const tree = context.captured;
assert.deepEqual(Object.keys(tree.folders).sort(), ["chat-library:research", "chat-library:writing"]);
const research = tree.folders["chat-library:research"];
assert.equal(research.folders.manager.items[0].sessionId, "task_manager");
assert.equal(research.folders.manager.folders.worker.items[0].sessionId, "task_worker");
assert.equal(research.folders.empty.items.length, 0, "No Task Chats belong inside their user group");
assert.equal(tree.folders["chat-library:writing"].folders.existing.items[0].sessionId, "task_existing");
context.agentSessionTree(sessions, true);
assert.equal(context.captured.folders["chat-library:research"].folders.deleted.items[0].sessionId, "task_deleted");
assert(!context.captured.folders["chat-library:research"].folders.empty, "Archived tree must not seed empty live Chats");
console.log("Agent Session tree user groups, worker nesting, existing Chat ownership and archived projection passed");

const os = require("node:os");
const Module = require("node:module");
const originalLoad = Module._load;
let ApiChatStore, apiChatGroupSnapshots;
try {
  Module._load = function(name, ...args) {
    return name === "vscode" ? { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) } } : originalLoad.call(this, name, ...args);
  };
  ({ ApiChatStore, apiChatGroupSnapshots } = require("../dist/chat/api-chat-store"));
} finally { Module._load = originalLoad; }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-session-tree-groups-"));
try {
  const store = new ApiChatStore(directory, "0123456789abcdef");
  const chat = store.create();
  const category = store.library.createGroup("Research / Group");
  store.library.move(chat.id, category);
  let snapshot = apiChatGroupSnapshots(directory).find(group => group.hostSessionId === chat.id);
  assert.equal(snapshot.libraryGroupId, category);
  assert.equal(snapshot.libraryGroupTitle, "Research / Group");
  const identity = snapshot.groupId;
  store.library.renameGroup(category, "Renamed");
  snapshot = apiChatGroupSnapshots(directory).find(group => group.hostSessionId === chat.id);
  assert.equal(snapshot.groupId, identity);
  assert.equal(snapshot.libraryGroupTitle, "Renamed");
  store.library.deleteGroup(category);
  snapshot = apiChatGroupSnapshots(directory).find(group => group.hostSessionId === chat.id);
  assert.equal(snapshot.groupId, identity);
  assert.equal(snapshot.libraryGroupId, "ungroup");
  assert.equal(snapshot.libraryGroupTitle, "Ungroup");
  console.log("Persisted Chat List group projection follows moves, renames and deletion without rebinding host groups");
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
