// Compile only these sources in memory: never race the parent's dist build.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function sourceModule(relative, overrides = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics, []);
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = compiled.require.bind(compiled);
  compiled.require = id => overrides[id] || requireOriginal(id);
  compiled._compile(result.outputText, filename);
  return compiled.exports;
}
const locator = sourceModule("src/knowledge/knowledge-locator.ts");
const storage = sourceModule("src/knowledge/storage.ts", { "./knowledge-locator": locator });

const inventory = [
  { area: "projects", relativePath: "project_fixture", slug: "project_fixture", title: "移动 Project" },
  { area: "actions", relativePath: "test.fixture", slug: "test.fixture", title: "Portable Action", knowledgeId: "action_" + "a".repeat(32) },
  { area: "components", relativePath: "core.file-path", slug: "core.file-path", title: "File Path" },
  { area: "recipes", relativePath: "Operations/My Recipe.recipe_fixture.json", slug: "Operations/My Recipe.recipe_fixture", title: "My Recipe", knowledgeId: "knowledge_" + "b".repeat(24) },
  { area: "packages", relativePath: "demo/src/数据.py", slug: "demo/src/数据.py", title: "数据.py" },
];

test("existing Action, Component, Project and package namespaces reach their consumers", () => {
  for (const [uri, area, id] of [
    ["pkm://projects/project_fixture", "projects", "project_fixture"],
    ["pkm://actions/test.fixture", "actions", "test.fixture"],
    ["pkm://knowledge/action_" + "a".repeat(32), "actions", "test.fixture"],
    ["pkm://components/core.file-path", "components", "core.file-path"],
  ]) {
    const target = locator.resolvePkmLocator(uri, inventory);
    assert.equal(target.kind, "entity");
    assert.equal(target.area, area);
    assert.equal(target.id, id);
  }
  const target = locator.resolvePkmLocator("pkm://packages/demo/src/%E6%95%B0%E6%8D%AE.py", inventory);
  assert.equal(target.type, "packageFile");
  assert.equal(target.key, "demo|src/数据.py");
});

test("both generated Action knowledge identities and Component source IDs are navigable", () => {
  // definition_value uses a 24-hex deterministic fallback; register persists a
  // 32-hex UUID. Both producers expose pkm://knowledge/<knowledgeId>.
  for (const size of [24, 32]) {
    const knowledgeId = "action_" + "c".repeat(size);
    const sourceId = "pkm://knowledge/" + knowledgeId;
    const entry = { area: "actions", relativePath: "fixture.generated", slug: "fixture.generated",
      title: "Generated Action", knowledgeId };
    assert.equal(locator.parsePkmLocator(sourceId).knowledgeId, knowledgeId);
    assert.equal(locator.resolvePkmLocator(sourceId, [entry]).id, "fixture.generated");
    assert.throws(() => locator.resolvePkmLocator(sourceId, [entry, { ...entry }]),
      error => error.code === "duplicate");
  }
  for (const size of [23, 25, 31, 33]) {
    assert.throws(() => locator.parsePkmLocator("pkm://knowledge/action_" + "c".repeat(size)),
      error => error.code === "invalid");
  }
  assert.equal(locator.resolvePkmLocator("pkm://components/core.file-path", inventory).area, "components");
});

test("canonical Recipe ID and previous category/name producer resolve identically", () => {
  for (const uri of ["pkm://recipes/recipe_fixture", "pkm://recipes/Operations/My%20Recipe",
    "pkm://knowledge/knowledge_" + "b".repeat(24)]) {
    assert.equal(locator.resolvePkmLocator(uri, inventory).recipeId, "recipe_fixture");
  }
  const moved = inventory.map(entry => entry.area === "recipes" ? {
    ...entry, slug: "Moved/Renamed.recipe_fixture", relativePath: "Moved/Renamed.recipe_fixture.json",
  } : entry);
  assert.equal(locator.resolvePkmLocator("pkm://recipes/recipe_fixture", moved).recipeId, "recipe_fixture");
  assert.throws(() => locator.resolvePkmLocator("pkm://recipes/Operations/My%20Recipe", moved),
    error => error.code === "not-found");
});

test("invalid, missing and duplicated entities fail without selecting a same-name item", () => {
  for (const uri of ["pkm://projects/../x", "pkm://actions/test.fixture?host=publisher",
    "pkm://components/core.file-path#ignored", "pkm://packages/demo//file",
    "pkm://packages/demo/%2e%2e/file", "pkm://packages/demo/C%3A/file",
    "pkm://packages/demo/folder%5Cfile", "pkm://packages/demo/folder%2ffile"]) {
    assert.throws(() => locator.parsePkmLocator(uri), error => error.code === "invalid", uri);
  }
  for (const uri of ["pkm://projects/project_missing", "pkm://actions/test.missing",
    "pkm://components/core.missing", "pkm://packages/missing/src/file"]) {
    assert.throws(() => locator.resolvePkmLocator(uri, inventory), error => error.code === "not-found");
  }
  assert.throws(() => locator.resolvePkmLocator("pkm://actions/test.fixture", [...inventory, inventory[1]]),
    error => error.code === "duplicate");
  assert.throws(() => locator.resolvePkmLocator("pkm://knowledge/action_" + "a".repeat(32), [...inventory, inventory[1]]),
    error => error.code === "duplicate");
});

test("package file consumer uses the receiver store and rejects traversal/symlink escapes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pth-package-"));
  try {
    const publisher = path.join(directory, "publisher");
    const receiver = path.join(directory, "receiver");
    fs.mkdirSync(path.join(publisher, "packages", "demo", "src"), { recursive: true });
    fs.writeFileSync(path.join(publisher, "packages", "demo", "src", "数据.py"), "print(42)");
    fs.cpSync(publisher, receiver, { recursive: true });
    fs.rmSync(publisher, { recursive: true });
    storage.setStorePath(receiver);
    assert.equal(storage.packageFileGet("demo", "src/数据.py").content, "print(42)");
    for (const [name, relative] of [["..", "file"], ["demo", "../file"], ["demo", "/etc/passwd"],
      ["demo", "C:\\publisher\\file"], ["demo/other", "file"]]) {
      assert.equal(storage.packageFileGet(name, relative), null);
    }
    if (process.platform !== "win32") {
      fs.writeFileSync(path.join(directory, "outside"), "private");
      fs.symlinkSync(path.join(directory, "outside"), path.join(receiver, "packages", "demo", "outside"));
      assert.equal(storage.packageFileGet("demo", "outside"), null);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("navigation wires live stores and never introduces a second Action executor", () => {
  const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  assert.match(extension, /currentProjectStore\(\)\.list\(\)\.projects/);
  assert.match(extension, /actionRequest\(context, "catalog", \{\}\)/);
  assert.match(extension, /openActionWorkbench\(context, undefined, target\.id\)/);
  assert.match(extension, /openProjectCockpit\(context, target\.id\)/);
  const ui = fs.readFileSync(path.join(__dirname, "../src/webview/panel/15-projects.js"), "utf8");
  assert.ok(ui.includes("recipeCopyPathMenu(`pkm://recipes/${encodeURIComponent(recipe.recipeId)}`)"));
  const copyFunction = /function projectCopyPath\(projectId\) \{[\s\S]*?\n\}/.exec(ui);
  assert.ok(copyFunction);
  const copied = [];
  const context = { copyContextPath: value => copied.push(value) };
  vm.runInNewContext(copyFunction[0] + "\nprojectCopyPath('project_fixture');projectCopyPath('../escape');", context);
  assert.deepEqual(copied, ["pkm://projects/project_fixture"]);
  assert.ok(ui.includes("projectCopyPath('${esc(project.projectId)}')"));
});
