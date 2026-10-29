const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

assert.match(html,
  /<span class="workspace-context-title">Automation<\/span>[\s\S]*?data-tab="agentSnapshots"[\s\S]*?data-tab="actionLibrary">Action Library<\/button>\s*<button[^>]*data-tab="recipes"/,
  "Automation places Action Library third, immediately before Recipe Library (BR-03)");
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
assert.ok(!library.includes('proposal_id'),"proposals are not shown in the admitted library");

console.log("action library entry test: embedded admitted catalog, category tree and explicit Workbench navigation");
