#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "dist", "webview", "panel.html"), "utf8");
const css = fs.readFileSync(path.join(root, "dist", "webview", "panel.css"), "utf8");
const bundle = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const projectsSource = fs.readFileSync(path.join(root, "src", "webview", "panel", "15-projects.js"), "utf8");

assert.strictEqual((html.match(/class="workspace-button/g) || []).length, 5, "five primary workspace buttons");
assert.strictEqual((html.match(/class="workspace-context-group/g) || []).length, 5, "five contextual workspace groups");
assert.match(html, /data-workspace="knowledge"[^>]*>[\s\S]*?codicon-library/);
assert.match(html, /data-workspace="tools"[^>]*>[\s\S]*?academy-wizard-tools[\s\S]*?wizard-hat[\s\S]*?wizard-robe[\s\S]*?wizard-wand/);
assert.match(html, /data-workspace="automation"[^>]*>[\s\S]*?academy-cauldron/);
assert.match(html, /data-workspace="projects"[^>]*>[\s\S]*?academy-witch-original/);
assert.match(html, /data-workspace="settings"[^>]*>[\s\S]*?academy-dials/);
assert.doesNotMatch(html, /workspace-button[^>]*>[\s\S]*?<span aria-hidden="true">[KTPS]<\/span>/, "workspace rail uses semantic icons instead of initials");
assert.doesNotMatch(html, /workspace-button[^>]*>[\s\S]*?<b>/, "workspace rail remains icon-only across locales");
assert.match(css, /\[data-workspace="tools"\],\[data-workspace-group="tools"\]\{--workspace-color:#e5a84b\}/, "rail and context headings share workspace colors");
assert.match(css, /\[data-workspace="automation"\],\[data-workspace-group="automation"\]\{--workspace-color:#e25555\}/, "Automation uses a distinct red identity color");
assert.strictEqual((html.match(/class="workspace-context-title"/g) || []).length, 5, "five non-interactive workspace titles");
assert.strictEqual((html.match(/class="workspace-context-tabs" role="tablist"/g) || []).length, 5, "each workspace exposes a distinct tab list");
assert.match(html, /<span class="workspace-context-title">Automation<\/span>[\s\S]*?data-tab="agentSessions">Agent Sessions<\/button>[\s\S]*?data-tab="recipes">Recipe Library<\/button>/, "Automation owns Agent Sessions and the Recipe Library");
assert.match(css, /\.workspace-context-title\{[^}]*font-family:[^}]*font-size:16px/, "workspace headings use distinct display typography");
assert.match(css, /\.tab\.active::after\{[^}]*background:var\(--accent\)/, "active tabs have a dedicated selection indicator");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-tier::after\{[^}]*border-top:1px solid var\(--agent-tech-line\)[^}]*border-left:1px solid var\(--agent-tech-line\)/, "Recipe connects to the Todo spine");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-expansion::before\{[^}]*border-bottom:1px solid var\(--agent-tech-line\)[^}]*border-left:1px solid var\(--agent-tech-line\)/, "expanded Todo connects to its nested Recipe");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-canvas>\.agent-tech-stem\{align-self:center\}/, "Project root stem stays centered on its Recipe");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-expansion>\.agent-tech-stem\{display:none\}/, "legacy detached expansion stem is hidden");
assert.match(css, /\.recipe-library-workbench\{[^}]*grid-template-columns:280px minmax\(0,1fr\)/, "Recipe Library uses a split CatTree workbench");
assert.match(css, /@media\(max-width:620px\)\{\.recipe-library-workbench\{grid-template-columns:minmax\(0,1fr\)/, "Recipe workbench stacks on narrow screens");
assert.match(bundle, /knowledge:\['skills','notes','papers'\]/);
assert.match(bundle, /tools:\['prompts','scripts','packages','environments','servers'\]/);
assert.match(bundle, /automation:\['agentSessions','recipes'\]/);
assert.match(bundle, /state\.tab === 'recipes'\) renderGlobalRecipes\(\)/, "shared CatTree expansion rerenders the Recipe Library");
assert.match(bundle, /projects:\['projects','chatroom'\]/);
assert.match(bundle, /settings:\['mcp','skillRouter','subscriptions'\]/);
assert.doesNotMatch(html, /id="(?:tabs|tabwrap)"/);
assert.doesNotMatch(css, /#tabs(?:\W|$)|#tabwrap(?:\W|$)|\.tabnav(?:\W|$)/);
assert.match(bundle, /restoredButton\.dispatchEvent\(new MouseEvent\('click'\)\)/, "saved semantic route is restored");
assert.match(css, /#workspace-rail\{width:52px;flex:0 0 52px/, "workspace rail is compact and icon-only by default");
assert.match(bundle, /command === 'openTab'[\s\S]*?\.tab\[data-tab="\$\{e\.data\.tab\}"\]/, "legacy openTab selects the semantic surface");

let webviewState = { projectRoute: { projectId: "missing", section: "Invalid", workflowView: "Other" } };
let detailHtml = "";
let modal;
let contextMenu;
const messages = [];
let chatOpened = false;
const detail = {};
const formElements = {};
Object.defineProperty(detail, "innerHTML", { get: () => detailHtml, set: value => { detailHtml = value; } });
const context = {
  console,
  state: { tab: "projects" },
  vscode: { getState: () => webviewState, setState: value => { webviewState = value; } },
  document: {
    getElementById: id => id === "detail" ? detail : formElements[id] || null,
    querySelector: selector => selector.includes('data-tab="chatroom"') ? { dispatchEvent: () => { chatOpened = true; } } : null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {} })
  },
  MouseEvent: function MouseEvent(type) { this.type = type; },
  esc: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  buildCatTree: (items, getCategory, fallback) => {
    const root = { folders: {}, items: [] };
    for (const item of items) {
      const segments = String(getCategory(item) || fallback).split("/").filter(Boolean);
      let node = root;
      for (const segment of segments) node = node.folders[segment] ||= { folders: {}, items: [] };
      node.items.push(item);
    }
    return root;
  },
  renderCatTree: function renderCatTree(node, pathParts, depth, renderLeaf, query, folderAttr) {
    return Object.entries(node.folders).map(([name, child]) => `<div class="tree-cat"><div class="tree-cat-hdr"${folderAttr ? folderAttr(child, name, [...pathParts, name]) : ""}>${context.privacyLock(context.privacyInherited([...pathParts, name]))}${name}</div>${renderCatTree(child, [...pathParts, name], depth + 1, renderLeaf, query, folderAttr)}</div>`).join("") + node.items.map(item => renderLeaf(item, depth, query)).join("");
  },
  privacyInherited: value => {
    const topLevel = String(Array.isArray(value) ? value[0] || "" : value || "").split("/").filter(Boolean)[0] || "";
    return (context.state.privateTopLevels || []).includes(topLevel);
  },
  privacyLock: isPrivate => isPrivate ? '<span class="content-private-lock codicon codicon-lock"></span>' : "",
  showPaperMenu: (x, y, items) => { contextMenu = { x, y, items }; },
  pkModal: options => { modal = options; },
  ask: (command, data) => messages.push({ command, data }),
  finishAction() {}
};
vm.createContext(context);
vm.runInContext(projectsSource, context, { filename: "15-projects.js" });

const snapshot = {
  schema: 1,
  storeVersion: 1,
  rootId: "root_test",
  projects: [{ projectId: "project_default", name: "Default Project", systemKind: "default-project", version: 1 }, { projectId: "project_pkm", name: "Personal Knowledge Manager", version: 1 }],
  threads: [{ threadId: "thread_general", projectId: "project_default", name: "General", systemKind: "general-thread", archived: false, description: "", legacyAliases: [], version: 1 }, { threadId: "thread_pkm", projectId: "project_pkm", name: "General", systemKind: "general-thread", archived: false, description: "", legacyAliases: [], version: 1 }],
  recipes: [],
  privateTopLevels: ["Software Development"]
};
context.projectOnState(snapshot);
assert.deepStrictEqual(JSON.parse(JSON.stringify(webviewState.projectRoute)), { projectId: "project_default", section: "Overview", workflowView: "Todos" });
assert.match(detailHtml, /Default Project/);
assert.doesNotMatch(detailHtml, /Global Recipes/, "global Recipes are not shown in the Projects tree");
assert.match(detailHtml, /System · Default/);
assert.match(detailHtml, />1 Threads · 0 Todo Executions · 0 Active Agents</);
assert.match(detailHtml, /No active Todos/);
assert.doesNotMatch(detailHtml, /Run 1|Agent 1|Example Artifact/, "unbacked records are not fabricated");

context.projectNew(); modal.onOk("Roadmap");
context.projectNewThread(); modal.onOk("Delivery");
context.projectMoveThread("thread_delivery", "project_default");
context.projectSection("Workflows");
assert.strictEqual(webviewState.projectRoute.section, "Todos", "legacy Workflows route maps to Todos");
assert.match(detailHtml, /No Todos/);
context.projectWorkflowView("Recipes");
assert.match(detailHtml, /No Recipes/);
assert.match(detailHtml, /New Recipe/);
context.projectNewRecipe(); modal.onOk("Daily Review");
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
  { command: "projectCreate", data: { name: "Roadmap" } },
  { command: "threadCreate", data: { projectId: "project_default", name: "Delivery" } },
  { command: "threadMove", data: { threadId: "thread_delivery", destinationProjectId: "project_default" } },
  { command: "recipeCreate", data: { scope: "project", projectId: "project_default", name: "Daily Review" } }
]);
context.projectOnResult({ action: "recipeCreate", entityId: "recipe_daily", snapshot: { ...snapshot, storeVersion: 2, recipes: [{ recipeId: "recipe_daily", scope: "project", projectId: "project_default", name: "Daily Review", description: "", revision: 1, executableDigest: "abcdef1234567890", definition: { spec: { nodes: [{ nodeId: "start" }] } } }] } });
assert.match(detailHtml, /Daily Review/);
assert.match(detailHtml, /Draft · Revision 1 · 1 step/);
assert.match(detailHtml, /abcdef123456/);
context.state.tab = "recipes";
context.renderGlobalRecipes();
assert.match(detailHtml, /Recipe Library/);
assert.match(detailHtml, /Reusable Recipes available to every Agent Task/);
assert.doesNotMatch(detailHtml, /Daily Review/, "project-owned Recipe stays out of the global library");
context.projectNewRecipe(); modal.onOk("Universal Review");
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "recipeCreate", data: { scope: "global", name: "Universal Review" } });
context.projectOnResult({ action: "recipeCreate", entityId: "recipe_global", snapshot: { ...snapshot, storeVersion: 3, recipes: [
  { recipeId: "recipe_daily", scope: "project", projectId: "project_default", name: "Daily Review", description: "", revision: 1, executableDigest: "abcdef1234567890", definition: { spec: { nodes: [{ nodeId: "start" }] } } },
  { recipeId: "recipe_global", scope: "global", category: "Software Development", name: "Universal Review", description: "", revision: 1, executableDigest: "123456abcdef7890", definition: { spec: { nodes: [{ nodeId: "start" }] } } }
] } });
assert.match(detailHtml, /Universal Review/);
assert.match(detailHtml, /Software Development/);
assert.match(detailHtml, /content-private-lock/);
assert.match(detailHtml, /recipe-library-workbench/);
assert.match(detailHtml, /recipe-editor/);
assert.match(detailHtml, /recipe-graph-canvas/);
assert.match(detailHtml, /recipe-graph-links/);
assert.match(detailHtml, /recipe-library-resizer/);
assert.match(detailHtml, /Zoom out/);
assert.match(detailHtml, /recipeOpenBrowser/);
assert.match(detailHtml, /Execution mode/);
assert.match(detailHtml, /Structured retrieval context/);
assert.match(detailHtml, /Drag a Step onto another Step to route an output into an input/);
assert.match(detailHtml, /project-recipe-row active/);
assert.doesNotMatch(detailHtml, /Daily Review/);
context.recipeGraphAddStep();
assert.deepStrictEqual(JSON.parse(JSON.stringify(modal.options)), [
  { value:"single", label:"Step" }, { value:"repeat", label:"Repeat" },
  { value:"if", label:"If / Else" }, { value:"switch", label:"Switch" }
]);
modal.onOk("finish", "", false, "repeat");
assert.match(detailHtml, /<strong>finish<\/strong>/);
assert.match(detailHtml, /recipe-repeat-badge">× 2/);
const dragTarget = { classList: { add() {}, remove() {} } };
context.recipeGraphDrop({ preventDefault() {}, currentTarget: dragTarget, dataTransfer: { getData: () => "start" } }, "finish");
assert.match(detailHtml, /recipe-dependency-route"><strong>start/);
assert.match(detailHtml, /Source output/);
assert.match(detailHtml, /Target input/);
context.recipeGraphControlMode("finish", "repeat");
assert.match(detailHtml, /recipe-repeat-badge">× 2/);
context.recipeGraphRepeatKind("finish", "dynamic");
assert.match(detailHtml, /recipe-repeat-badge">× \?/);
context.recipeGraphControlMode("finish", "branch");
assert.match(detailHtml, /If \/ Else/);
assert.match(detailHtml, /value="yes, no"/);
formElements['recipe-edit-error'] = { textContent: '' };
context.projectOnError({
  action: 'recipeUpdate',
  code: 'recipe-definition-invalid',
  error: 'Recipe definition is invalid.',
  details: { diagnostics: [{ code: 'E3203', details: { cycle: 'check → work → check', suggestedLoopEdge: { from: 'work', to: 'check' } } }] }
});
assert.match(formElements['recipe-edit-error'].textContent, /Cycle detected: check → work → check/);
assert.match(formElements['recipe-edit-error'].textContent, /mark work → check as the loop edge/);
assert.match(formElements['recipe-edit-error'].textContent, /exit condition and a positive maximum iteration count/);
context.recipeDraftField("name", "Universal Review v2");
context.recipeDraftField("category", "Software Development/Review");
context.recipeDraftField("description", "Review a change.");
context.recipeDraftFunctions("Review\nDelivery");
context.recipeDraftSolution("Inspect and report.");
context.recipeMetadataAdd("requiredInputs");
context.recipeDraftMetadataField("requiredInputs", 0, "name", "change");
context.recipeDraftMetadataField("requiredInputs", 0, "description", "Diff to inspect");
context.recipeMetadataAdd("expectedOutputs");
context.recipeDraftMetadataField("expectedOutputs", 0, "name", "report");
context.recipeDraftMetadataField("expectedOutputs", 0, "description", "Actionable findings");
context.recipeEditorModeSet("json");
assert.match(detailHtml, /id="recipe-definition"/);
formElements["recipe-definition"] = { value: JSON.stringify({ schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [], outputs: {}, completion: { requiredNodes: [] } } }) };
formElements["recipe-edit-error"] = { textContent: "" };
context.recipeSave({});
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
  command: "recipeUpdate",
  data: {
    recipeId: "recipe_global",
    name: "Universal Review v2",
    category: "Software Development/Review",
    description: "Review a change.",
    metadata: {
      applicableFunctions: ["Review", "Delivery"], solution: "Inspect and report.",
      requiredInputs: [{ name: "change", description: "Diff to inspect", required: true }],
      expectedOutputs: [{ name: "report", description: "Actionable findings" }]
    },
    editorLayout: { nodePositions: { finish: { x:344, y:24 } } },
    definition: { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [], outputs: {}, completion: { requiredNodes: [] } } }
  }
});
formElements["recipe-definition"].value = "{";
context.recipeSave({});
assert.match(formElements["recipe-edit-error"].textContent, /Definition JSON is invalid/);
assert.strictEqual(messages.at(-1).command, "recipeUpdate", "invalid JSON does not send another update");
context.recipeFolderMenu({ preventDefault() {}, stopPropagation() {}, clientX: 4, clientY: 8 }, "Software Development");
assert.strictEqual(contextMenu.items[0].label, "Set as Public");
contextMenu.items[0].onClick();
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "contentSetPrivacy", data: { type: "recipes", topLevel: "Software Development", isPrivate: false } });
context.state.tab = "projects";
context.projectSelect("project_default");
assert.match(detailHtml, /Default Project/);
assert.match(detailHtml, /New Thread/);
context.projectSelect("project_pkm");
context.projectSection("Todos");
context.projectWorkflowView("Todos");
assert.match(detailHtml, /Active Todo Execution/);
assert.match(detailHtml, /Copilot Agent/);
assert.match(detailHtml, /2 complete/);
assert.match(detailHtml, /<span>Remaining<\/span><strong>4<\/strong>/);
assert.match(detailHtml, /33%/);
assert.match(detailHtml, /Implement dashboard/);
assert.match(detailHtml, /Project Todo technology tree/);
context.agentTechToggle("implement");
assert.match(detailHtml, /Project Todo technology tree/);
assert.match(detailHtml, /UI Development/, "Project scope expands the shared nested Recipe in place");
context.agentTechToggle("implement");
context.state.tab = "agentSessions";
context.renderAgentSessions();
assert.match(detailHtml, /Interactive preview/);
assert.match(detailHtml, /Agent Session/);
assert.match(detailHtml, /Build Agent Session Dashboard/);
assert.match(detailHtml, /Implement dashboard prototype/);
assert.match(detailHtml, /Project · Personal Knowledge Manager/);
assert.match(detailHtml, /Agent Todo technology tree/);
assert.match(detailHtml, /2 of 6 Todos complete/);
assert.match(detailHtml, /33%/);
assert.match(detailHtml, /Todos not complete/);
assert.match(detailHtml, /Software Development/);
assert.match(detailHtml, /Focus current/);
assert.match(detailHtml, /Expand all/);
assert.match(detailHtml, /Collapse all/);
assert.match(detailHtml, /3 child Todos/);
assert.doesNotMatch(detailHtml, /UI Development/, "default view stops at the running Todo");
context.agentTechToggle("implement");
assert.match(detailHtml, /UI Development/);
assert.match(detailHtml, /expands selected Todo/);
assert.match(detailHtml, /COUNT ≥1/);
assert.match(detailHtml, /COUNT ALL/);
assert.match(detailHtml, /COUNT &gt;1/);
assert.match(detailHtml, /SUBSET A∧B/);
assert.match(detailHtml, /\(A∨B\)∧C/);
context.agentTechExpansionMode("none");
assert.match(detailHtml, /Root · 6 Todo nodes · collapsed/);
assert.doesNotMatch(detailHtml, /Software Development/);
context.agentTechExpansionMode("current");
assert.match(detailHtml, /Software Development/);
assert.doesNotMatch(detailHtml, /UI Development/);
assert.match(detailHtml, /Render session execution hierarchy/);
assert.match(detailHtml, /Recipe revision 3/);
assert.match(detailHtml, /Working tree diff/);
context.agentDashboardSelectStep("validate");
assert.match(detailHtml, /Validate behavior/);
assert.match(detailHtml, /Not started/);
context.agentDashboardSetView("Evidence");
assert.match(detailHtml, /Evidence ledger/);
assert.match(detailHtml, /7 records/);
context.agentDashboardSetView("Decisions");
assert.match(detailHtml, /Decision and deviation log/);
context.state.tab = "recipes";
context.renderGlobalRecipes();
assert.match(detailHtml, /Search Recipes and Steps/);
context.recipeSearch("start");
assert.match(detailHtml, /Universal Review/);
context.recipeSearch("no-qualified-recipe");
assert.match(detailHtml, /No matching Recipe/);
assert.match(detailHtml, /Design Recipe/);
context.recipeSearch("");
assert.match(detailHtml, /Software Development/);
context.state.tab = "projects";
context.renderProjects();
context.projectOpenThread("thread_general");
assert.strictEqual(chatOpened, true);
assert.strictEqual(webviewState.projectThreadId, "thread_general");
assert.match(detailHtml, /New Project/);
assert.match(detailHtml, /New Thread/);

console.log("four-workspace UI tests passed");