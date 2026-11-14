const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

assert.match(html,
  /<span class="workspace-context-title">Automation<\/span>[\s\S]*?data-tab="agentSnapshots"[\s\S]*?data-tab="recipes">Recipe Library<\/button>\s*<button[^>]*data-tab="actionLibrary">Action Library<\/button>/,
  "Automation places Recipe Library immediately before Action Library");
assert.match(core,
  /automation:\[[^\]]*'actionLibrary'/,
  "Library is a restorable Automation surface inside the main panel");
assert.match(extension,
  /case "openActionLibrary":[\s\S]*?openActionLibrary\(context\)[\s\S]*?break/,
  "legacy host requests route to Library, not the Workbench");
assert.match(extension, /registerCommand\("personalKnowledge.openEmbeddedActionLibrary"[\s\S]*?session\.snapshot\.tab = "actionLibrary"/);
assert.match(extension,/registerCommand\("personalKnowledge.openActions", \(\) => openActionWorkbench\(context\)\)/);
const library = fs.readFileSync(path.join(root,"resources","action-library.html"),"utf8");
assert.ok(!library.includes('action-workbench.html'));
assert.match(library,/Open in Workbench/);
assert.match(library, /Preparing Actions/,
  "pending proposals have a separate review section instead of entering the admitted tree");
assert.match(library, /This revision is not admitted and cannot run from the Library/);

console.log("action library entry test: embedded admitted catalog, category tree and explicit Workbench navigation");
