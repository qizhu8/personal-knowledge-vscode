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
  agentSessionPortalFilter:"all",
  projectSnapshot: { agentSessionGroups: [
    group("manager", "Manager", "research", "Research", { workerTreeId: "tree" }),
    group("worker", "Worker", "ungroup", "Ungroup", { workerParentChatId: "Manager", workerTreeId: "tree" }),
    group("empty", "Empty Chat", "research", "Research"),
    group("existing", "Existing Chat", "writing", "Writing"),
    group("deleted", "Deleted Chat", "research", "Research", { deletedAt: "2026-10-10" }),
  ] },
  selectedAgentSessionId: "", selectedAgentChatId: "", esc: value => String(value), agentSessionStatusIndicator: () => "",
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

Object.assign(context, {
  state: { tab: "agentSessions" }, catExpanded: {}, githubSyncTypes: [],
  privacyInherited: () => false, privacyDivider: () => "",
  uiIcon: name => `<i class="${name}"></i>`,
  btoa: value => Buffer.from(value, "binary").toString("base64"),
  unescape, encodeURIComponent,
});
vm.runInContext(knowledge.slice(knowledge.indexOf("function countTreeLeaves("), knowledge.indexOf("function openCatFolderAddMenu(")), context);
const rendered = context.agentSessionTree(sessions);
const emptyRow = rendered.match(/<div class="tree-cat-hdr[^>]*title="empty"[^>]*>[\s\S]*?<\/div>/)?.[0];
assert(emptyRow, "Empty Chat remains visible");
assert.match(emptyRow, /role="group"/);
assert.match(emptyRow, /agent-session-pkm-icon/);
assert.match(emptyRow, /No Task/);
assert.match(emptyRow, /0 Tasks/);
assert.match(emptyRow, /Chat Group actions/);
assert.doesNotMatch(emptyRow, /aria-expanded|toggleCat|chevron-down|chevron-right/);
for (const name of ["manager", "worker", "existing", "chat-library:research"]) {
  const row = rendered.match(new RegExp(`<div class="tree-cat-hdr[^>]*title="${name}"[^>]*>[\\s\\S]*?<\\/div>`))?.[0];
  assert(row, `${name} stays visible`);
  assert.match(row, /aria-expanded="true"/, `${name} has real children`);
}
assert.match(rendered, /agent-session-row/);
assert.doesNotMatch(rendered, /title="deleted"/);
context.agentSessionTree([], true);
assert.equal(context.agentSessionTree([], true), "", "Archived empty Chats are not recreated");
context.projectSnapshot.agentSessionGroups.push(group("parent-empty", "Parent", "writing", "Writing", { workerTreeId: "empty-tree" }),
  group("child-empty", "Child", "writing", "Writing", { workerTreeId: "empty-tree", workerParentChatId: "Parent" }));
const emptyWorkers = context.agentSessionTree([]);
assert.match(emptyWorkers, /aria-expanded="true"[^>]*title="parent-empty"/, "Parent with only a worker Chat is expandable");
assert.match(emptyWorkers, /role="group"[^>]*title="child-empty"/, "No Task worker is a Chat leaf");
const genericEmpty = context.renderCatTree({ folders: { Empty: { folders: {}, items: [] } }, items: [] },
  [], 0, () => "", "", null, null, { renderFolderLabel: name => name });
assert.match(genericEmpty, /aria-expanded="false"/, "Other libraries keep editable empty folder behavior");
assert.match(genericEmpty, /toggleCat/);
console.log("Empty Chats keep identity and menus without fake expansion; worker parents and generic empty folders preserve behavior");

context.projectSnapshot.agentSessionGroups.find(group => group.groupId === "manager").portal = { connected:true, binding:{ role:"controller" } };
context.projectSnapshot.agentSessionGroups.find(group => group.groupId === "empty").portal = { connected:false, binding:{ role:"controlled" } };
assert.match(context.agentSessionTree(sessions), /Controller · Connected/, "Tasks must not shadow the Chat Group's Portal role");
context.agentSessionPortalFilter = "controller";
let filtered = context.agentSessionTree(sessions);
assert.match(filtered, /Parent task/);
assert.doesNotMatch(filtered, /Worker task|Existing task|Empty Chat/);
context.agentSessionPortalFilter = "controlled";
filtered = context.agentSessionTree(sessions);
assert.match(filtered, /Controlled · Disconnected/);
assert.match(filtered, /No Task/);
assert.doesNotMatch(filtered, /Parent task|Existing task/);
context.agentSessionPortalFilter = "connected";
assert.match(context.agentSessionTree(sessions), /Controller · Connected/);
assert.doesNotMatch(context.agentSessionTree(sessions), /Controlled · Disconnected/);
context.agentSessionPortalFilter = "none";
assert.doesNotMatch(context.agentSessionTree(sessions), /Parent task|Empty Chat/);
context.agentSessionPortalFilter = "all";

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

// Evaluate the actual state-watcher directory filter: Chat metadata is included, segmented bodies are not.
const ts = require("typescript");
const extension = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const ast = ts.createSourceFile("extension.ts", extension, ts.ScriptTarget.Latest, true);
let watcher;
function visit(node) {
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === "_projectStateWatcher" && ts.isCallExpression(node.right)) watcher = node.right;
  ts.forEachChild(node, visit);
}
visit(ast);
assert(watcher && ts.isCallExpression(watcher));
const stateRoot = path.join(os.tmpdir(), "pkm-state-watcher-fixture");
const roots = vm.runInNewContext(watcher.arguments[0].getText(ast), { path, stateRoot });
assert(roots.includes(path.join(stateRoot, "api-chats")));
assert(roots.includes(path.join(stateRoot, "agent-groups")));
const descend = vm.runInNewContext(`(${watcher.arguments[2].getText(ast)})`, { path, stateRoot });
for (const relative of ["api-chats", "api-chats/71d6acd345276d69", "agent-groups", "agent-sessions"]) {
  assert(descend(path.join(stateRoot, relative)), relative);
}
for (const relative of ["api-chats/71d6acd345276d69/history", "api-chats/71d6acd345276d69/chat.segments"]) {
  assert(!descend(path.join(stateRoot, relative)), relative);
}
console.log("Agent Sessions watches Chat metadata and Library changes without traversing history bodies");
