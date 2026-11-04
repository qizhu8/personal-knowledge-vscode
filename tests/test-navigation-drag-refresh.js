const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const store = require("../dist/knowledge/filestore");
const { KnowledgeInventoryManager } = require("../dist/knowledge/knowledge-inventory");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
const names = ["PkTreeItem", "PkTreeProvider", "treeMoveInfo", "PkTreeDragAndDropController", "refreshKnowledgeInventory"];
const extracted = names.map(name => ast.statements.find(node => node.name?.text === name).getText(ast)).join("\n");
let refreshCommand;
function findRefreshCommand(node) {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === "personalKnowledge.refreshTree") refreshCommand = node.arguments[1].getText(ast);
  ts.forEachChild(node, findRefreshCommand);
}
findRefreshCommand(ast);
assert(refreshCommand, "native Navigation refresh command must exist");
const compiled = ts.transpileModule(`${extracted}
const treeProvider = globalThis.provider = _treeProvider = new PkTreeProvider({});
globalThis.controller = new PkTreeDragAndDropController({});
globalThis.refreshCommand = ${refreshCommand};
`, { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText;

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-navigation-drop-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  store.setStorePath(directory);
  const write = (area, relative, body = "fixture") => {
    const file = path.join(directory, area, relative);
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, body);
  };
  write("notes", "From/item.md", "---\ntitle: Drag fixture\n---\nbody");
  fs.mkdirSync(path.join(directory, "notes", "To"));
  const inventory = new KnowledgeInventoryManager(directory, path.join(directory, ".state"),
    path.join(root, "dist/knowledge/knowledge-inventory-worker.js"));
  await inventory.refresh();
  const posts = [], warnings = [], errors = [], statuses = [], changes = [], commits = [];
  const scope = {
    knowledgeInventory:inventory, _treeProvider:undefined, performanceStateDir:"",
    context:{}, inventoryTask:{ running() {}, idle() {} }, log:{ info() {}, warn() {}, action() {} },
    postToPanel:message => posts.push(message), gitCommit:message => commits.push(message),
    storeEntryMove:store.storeEntryMove, folderList:store.folderList,
    privateNavigationLabel:(_area, label) => label, isTopLevelPrivate:() => false,
    vscode:{
      TreeItem:class { constructor(label) { this.label = label; } },
      ThemeIcon:class {},
      DataTransferItem:class { constructor(value) { this.value = value; } async asString() { return this.value; } },
      EventEmitter:class { event = () => {}; fire() { changes.push(inventory.notes().map(note => note.slug)); } },
      TreeItemCollapsibleState:{ None:0, Collapsed:1 },
      window:{
        showInformationMessage:message => warnings.push(message),
        showWarningMessage:message => warnings.push(message),
        showErrorMessage:message => errors.push(message),
        setStatusBarMessage:message => statuses.push(message),
      },
    },
  };
  vm.runInNewContext(compiled, scope);
  const drop = (area, relative, target, level = "file") => {
    const type = area === "notes" ? "note" : area === "skills" ? "skill" : "script";
    const parent = path.posix.dirname(relative);
    const item = level === "folder" ? { nodeType:`${type}-folder`, nodeData:{ relPath:relative } }
      : scope.provider[`_${type}Folder`](parent === "." ? [] : parent.split("/")).find(node => node.nodeData.key === (area === "scripts" ? relative : relative.replace(/\.md$/, "")));
    assert(item, "drag must use a real Navigation item");
    const values = new Map();
    scope.controller.handleDrag([item], values);
    return scope.controller.handleDrop(
      { nodeType:target ? `${type}-folder` : `root-${area}`, nodeData:{ relPath:target } }, values);
  };
  return { directory, inventory, scope, posts, warnings, errors, statuses, changes, commits, write, drop };
}

for (const area of ["notes", "skills", "scripts"]) test(`Navigation drop refreshes committed ${area} paths without manual refresh`, async t => {
  const f = await fixture(t);
  const relative = area === "scripts" ? "From/item.py" : "From/item.md";
  if (area !== "notes") {
    f.write(area, relative);
    fs.mkdirSync(path.join(f.directory, area, "To"));
    await f.inventory.refresh();
  }
  const tree = () => f.scope.provider[area === "notes" ? "_noteRoot" : area === "skills" ? "_skillRoot" : "_scriptRoot"]();
  assert.equal(tree().folders.get("From").items.length, 1, "prime the actual tree cache");
  await f.drop(area, relative, "To");
  assert(!fs.existsSync(path.join(f.directory, area, relative)));
  assert(fs.existsSync(path.join(f.directory, area, "To", path.basename(relative))));
  assert.equal(tree().folders.get("From").items.length, 0, "source must no longer contain the moved item");
  assert.equal(tree().folders.get("To").items.length, 1, "destination must render the moved item");
  assert.equal(f.posts.at(-1).command, "reloaded");
  assert.equal(f.statuses.length, 1);
  assert.deepEqual(f.errors, []);
});

test("rejected drop preserves real files and never publishes a successful move", async t => {
  const f = await fixture(t);
  f.write("notes", "To/item.md", "occupied");
  await f.inventory.refresh();
  await f.drop("notes", "From/item.md", "To");
  assert(fs.existsSync(path.join(f.directory, "notes", "From/item.md")));
  assert.equal(fs.readFileSync(path.join(f.directory, "notes", "To/item.md"), "utf8"), "occupied");
  assert.match(f.warnings[0], /already exists/);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.commits, []);
});

test("folder drop replaces cached paths for every descendant", async t => {
  const f = await fixture(t);
  f.write("notes", "From/Deep/nested.md");
  await f.inventory.refresh();
  f.scope.provider._noteRoot();
  await f.drop("notes", "From", "To", "folder");
  const tree = f.scope.provider._noteRoot();
  assert.equal(tree.folders.has("From"), false);
  assert.equal(tree.folders.get("To").folders.get("From").folders.get("Deep").items.length, 1);
  assert.deepEqual(f.inventory.notes().map(note => note.slug).sort(), ["To/From/Deep/nested", "To/From/item"]);
});

test("drop during an older inventory scan waits for a new post-mutation scan", async t => {
  const f = await fixture(t);
  let release, scanned;
  const ready = new Promise(resolve => { scanned = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const refreshInner = f.inventory.refreshInner.bind(f.inventory);
  let calls = 0;
  f.inventory.refreshInner = async progress => {
    const snapshot = await refreshInner(progress);
    if (++calls === 1) { scanned(); await gate; }
    return snapshot;
  };
  const old = f.inventory.refresh();
  await ready;
  const dropping = f.drop("notes", "From/item.md", "To");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.statuses.length, 0, "success must wait until the post-mutation scan finishes");
  release();
  await Promise.all([old, dropping]);
  assert.equal(calls, 2);
  assert.deepEqual(f.inventory.notes().map(note => note.slug), ["To/item"]);
  assert.deepEqual(f.changes.at(-1), ["To/item"]);
});

test("folders read during a scan cannot keep deleted paths after completion", async t => {
  const f = await fixture(t);
  const scanning = f.inventory.refresh(() => { f.inventory.folders("notes"); });
  f.inventory.folders("notes");
  await scanning;
  fs.renameSync(path.join(f.directory, "notes", "From"), path.join(f.directory, "notes", "Renamed"));
  const refreshed = f.inventory.refresh();
  assert(f.inventory.folders("notes").includes("From"), "prime from the old snapshot while scanning");
  await refreshed;
  assert.equal(f.inventory.folders("notes").includes("From"), false);
  assert(f.inventory.folders("notes").includes("Renamed"));
});

test("inventory failure reports that the move committed without pretending refresh succeeded", async t => {
  const f = await fixture(t);
  const refresh = f.inventory.refresh.bind(f.inventory);
  f.inventory.refresh = async () => { throw new Error("Injected inventory failure"); };
  await f.drop("notes", "From/item.md", "To");
  assert(fs.existsSync(path.join(f.directory, "notes", "To/item.md")));
  assert(!fs.existsSync(path.join(f.directory, "notes", "From/item.md")));
  assert.match(f.errors[0], /Moved to To\/item.md.*refresh failed.*Do not repeat the move.*Injected inventory failure/);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.statuses, []);
  f.inventory.refresh = refresh;
  await f.scope.refreshCommand();
  assert.deepEqual(f.inventory.notes().map(note => note.slug), ["To/item"]);
  assert.equal(f.scope.provider._noteRoot().folders.get("From").items.length, 0);
  assert.equal(f.posts.at(-1).command, "reloaded");
  assert.equal(f.commits.length, 1, "manual refresh must not repeat the committed move");
});

test("dropping onto the area root removes the previous nested path", async t => {
  const f = await fixture(t);
  await f.drop("notes", "From/item.md", "");
  assert(fs.existsSync(path.join(f.directory, "notes", "item.md")));
  assert.deepEqual(f.inventory.notes().map(note => note.slug), ["item"]);
  assert.equal(f.scope.provider._noteRoot().folders.get("From").items.length, 0);
});

test("native Navigation refresh surfaces inventory errors instead of claiming success", async t => {
  const f = await fixture(t);
  f.inventory.refresh = async () => { throw new Error("Injected refresh failure"); };
  await f.scope.refreshCommand();
  assert.match(f.errors[0], /Navigation refresh failed.*Injected refresh failure/);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.changes, []);
});
