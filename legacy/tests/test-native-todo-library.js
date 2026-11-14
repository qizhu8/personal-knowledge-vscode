const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

for (const entry of ["panel", "command"]) {
test(`original Library serializes list refresh behind durable Board creation (${entry})`, async () => {
  const root = path.resolve(__dirname, ".."), commands = new Map(), errors = [];
  let listener, creating = false, reads = 0, readsBeforeCreate, release, started;
  const barrier = new Promise(resolve => { release = resolve; });
  const beginning = new Promise(resolve => { started = resolve; });
  const uri = value => ({ fsPath: value, toString: () => value });
  const panel = {
    reveal() {}, onDidDispose() {},
    webview: {
      cspSource: "private-fixture", asWebviewUri: value => value,
      onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
      async postMessage() {},
    },
  };
  const vscode = {
    ViewColumn: { One: 1 }, env: { language: "en" },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      createWebviewPanel: () => panel,
      async showQuickPick(choices) { return choices.find(choice => choice.action === "select" || choice.value === "todo-board"); },
      async showInputBox() { return "Created"; },
      async showErrorMessage(message) { errors.push(message); },
    },
  };
  const exports = {};
  const file = path.join(root, "src/chat/native-todo-library.ts");
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, Buffer,
    require: name => name === "vscode" ? vscode : name === "../ui/localization" ? {
      uiLanguageSetting: () => "en", resolveUiLanguage: () => "en",
      loadLocaleManifest: () => ({ locales: [] }), loadLocaleCatalogs: () => ({}),
    } : require(name),
  }, { filename: file });
  const opened = [];
  exports.registerNativeTodoLibrary({ extensionPath: root, extensionUri: uri(root) }, {
    root, boards: () => ["Original"], async refreshBoards() { return ["Original"]; },
    async read() {
      reads++;
      assert.equal(creating, false, "A Library refresh entered the exclusive create fence.");
      return { note: { title: "Original", slug: "Original" } };
    },
    async create() { readsBeforeCreate = reads; creating = true; started(); await barrier; creating = false; return { slug: "Created" }; },
    async open(slug) { opened.push(slug); },
  });
  await commands.get("personalKnowledge.open")();
  const creation = entry === "panel" ? listener({ command: "createKnowledgeItem", area: "notes" })
    : commands.get("personalKnowledge.addNote")();
  await beginning;
  const listing = listener({ command: "list", tab: "notes" });
  await new Promise(setImmediate);
  try { assert.equal(reads, readsBeforeCreate); } finally { release(); }
  await Promise.all([creation, listing]);
  assert.equal(reads, readsBeforeCreate + 1);
  assert.deepEqual(opened, ["Created"]);
  assert.deepEqual(errors, []);
});
}

test("original Library file messages retain stable Board identity, current paths and exact CAS through Trash/Restore", async () => {
  const root = path.resolve(__dirname, ".."), commands = new Map(), messages = [], errors = [], mutations = [];
  let listener, active = true;
  const key = "Original/Board";
  let data = { note: { slug: key, path: key + ".md", title: "Board", documentSha256: "source-0" },
    snapshot: { digest: "board-digest" } }, trashed = [];
  const uri = value => ({ fsPath: value, toString: () => value });
  const panel = { reveal() {}, onDidDispose() {}, webview: { cspSource: "private-fixture", asWebviewUri: value => value,
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(message) { messages.push(message); } } };
  const vscode = { ViewColumn: { One: 1 }, env: { language: "en" },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: { createWebviewPanel: () => panel, async showErrorMessage(message) { errors.push(message); } } };
  const exports = {}, file = path.join(root, "src/chat/native-todo-library.ts");
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Buffer, require: name => name === "vscode" ? vscode : name === "../ui/localization" ? {
    uiLanguageSetting: () => "en", resolveUiLanguage: () => "en", loadLocaleManifest: () => ({ locales: [] }), loadLocaleCatalogs: () => ({}),
  } : require(name) }, { filename: file });
  exports.registerNativeTodoLibrary({ extensionPath: root, extensionUri: uri(root) }, {
    root, boards: () => active ? [key] : [], async refreshBoards() { return active ? [key] : []; },
    async read(slug) { assert.equal(slug, key); return data; }, async open() {}, async create() {},
    async trash() { return trashed; },
    async lifecycle(input) {
      assert.equal(input.boardSlug, key);
      assert.equal(input.expectedDigest, "board-digest");
      assert.equal(input.expectedDocumentDigest, data.note.documentSha256);
      mutations.push(JSON.parse(JSON.stringify(input)));
      if (input.kind === "move") data = { ...data, note: { ...data.note,
        path: input.destinationPath, slug: input.destinationPath.slice(0, -3),
        title: input.title ?? data.note.title, documentSha256: `source-${mutations.length}` } };
      else if (input.kind === "trash") {
        active = false;
        trashed = [{ id: "exact-trash-entry", boardSlug: key, digest: "board-digest",
          documentDigest: data.note.documentSha256, originalPath: data.note.path }];
      } else { active = true; trashed = []; }
    },
  });
  await commands.get("personalKnowledge.open")();
  await listener({ command: "list", tab: "notes" });
  await listener({ command: "updateKnowledgeMetadataField", area: "notes", key, field: "title", value: "Renamed" });
  assert.equal(mutations[0].destinationPath, "Original/Renamed.md");
  await listener({ command: "noteMove", slug: "Original/Renamed", category: "Moved/Deep" });
  assert.equal(mutations[1].destinationPath, "Moved/Deep/Renamed.md");
  await listener({ command: "knowledgeTrashMove", area: "notes", kind: "item", path: "Moved/Deep/Renamed.md" });
  await listener({ command: "list", tab: "notes" });
  const listing = messages.filter(message => message.command === "list").at(-1);
  assert.equal(listing.data.length, 0); assert.equal(listing.knowledgeTrash[0].id, "exact-trash-entry");
  await listener({ command: "knowledgeTrashRestore", area: "notes", id: "wrong-entry" });
  assert.equal(mutations.length, 3);
  await listener({ command: "knowledgeTrashRestore", area: "notes", id: "exact-trash-entry" });
  assert.equal(mutations[3].kind, "restore");
  await listener({ command: "noteMove", slug: "Unknown/Outside", category: "Forged" });
  assert.equal(mutations.length, 4);
  assert.equal(errors.length, 2);
  assert(messages.some(message => message.command === "knowledgeTrashResult" && message.data.action === "restored"));
});
