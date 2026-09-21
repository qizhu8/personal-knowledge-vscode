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

assert.strictEqual((html.match(/class="workspace-button/g) || []).length, 4, "four primary workspace buttons");
assert.strictEqual((html.match(/class="workspace-context-group/g) || []).length, 4, "four contextual workspace groups");
assert.match(html, /data-workspace="knowledge"[^>]*>[\s\S]*?codicon-library/);
assert.match(html, /data-workspace="tools"[^>]*>[\s\S]*?codicon-tools/);
assert.match(html, /data-workspace="projects"[^>]*>[\s\S]*?codicon-project/);
assert.match(html, /data-workspace="settings"[^>]*>[\s\S]*?codicon-settings-gear/);
assert.doesNotMatch(html, /workspace-button[^>]*>[\s\S]*?<span aria-hidden="true">[KTPS]<\/span>/, "workspace rail uses semantic icons instead of initials");
assert.doesNotMatch(html, /workspace-button[^>]*>[\s\S]*?<b>/, "workspace rail remains icon-only across locales");
assert.match(css, /\[data-workspace="tools"\],\[data-workspace-group="tools"\]\{--workspace-color:#e5a84b\}/, "rail and context headings share workspace colors");
assert.strictEqual((html.match(/class="workspace-context-title"/g) || []).length, 4, "four non-interactive workspace titles");
assert.strictEqual((html.match(/class="workspace-context-tabs" role="tablist"/g) || []).length, 4, "each workspace exposes a distinct tab list");
assert.match(html, /<span class="workspace-context-title">Tools<\/span>[\s\S]*?<button class="tab" role="tab" aria-selected="false" data-tab="prompts">Prompts<\/button>/, "Tools heading is separate from clickable tool tabs");
assert.match(css, /\.workspace-context-title\{[^}]*font-family:[^}]*font-size:16px/, "workspace headings use distinct display typography");
assert.match(css, /\.tab\.active::after\{[^}]*background:var\(--accent\)/, "active tabs have a dedicated selection indicator");
assert.match(bundle, /knowledge:\['skills','notes','papers'\]/);
assert.match(bundle, /tools:\['prompts','scripts','packages','environments','servers'\]/);
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
const messages = [];
let chatOpened = false;
const detail = {};
Object.defineProperty(detail, "innerHTML", { get: () => detailHtml, set: value => { detailHtml = value; } });
const context = {
  console,
  state: { tab: "projects" },
  vscode: { getState: () => webviewState, setState: value => { webviewState = value; } },
  document: {
    getElementById: id => id === "detail" ? detail : null,
    querySelector: selector => selector.includes('data-tab="chatroom"') ? { dispatchEvent: () => { chatOpened = true; } } : null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {} })
  },
  MouseEvent: function MouseEvent(type) { this.type = type; },
  esc: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
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
  projects: [{ projectId: "project_default", name: "Default Project", systemKind: "default-project", version: 1 }],
  threads: [{ threadId: "thread_general", projectId: "project_default", name: "General", systemKind: "general-thread", archived: false, description: "", legacyAliases: [], version: 1 }]
};
context.projectOnState(snapshot);
assert.deepStrictEqual(JSON.parse(JSON.stringify(webviewState.projectRoute)), { projectId: "project_default", section: "Overview", workflowView: "Recipes" });
assert.match(detailHtml, /Default Project/);
assert.match(detailHtml, /System · Default/);
assert.match(detailHtml, />1 Threads · 0 Runs · 0 Agents</);
assert.match(detailHtml, /No recorded activity/);
assert.doesNotMatch(detailHtml, /Run 1|Agent 1|Example Artifact/, "unbacked records are not fabricated");

context.projectNew(); modal.onOk("Roadmap");
context.projectNewThread(); modal.onOk("Delivery");
context.projectMoveThread("thread_delivery", "project_default");
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
  { command: "projectCreate", data: { name: "Roadmap" } },
  { command: "threadCreate", data: { projectId: "project_default", name: "Delivery" } },
  { command: "threadMove", data: { threadId: "thread_delivery", destinationProjectId: "project_default" } }
]);
context.projectOpenThread("thread_general");
assert.strictEqual(chatOpened, true);
assert.strictEqual(webviewState.projectThreadId, "thread_general");
assert.match(detailHtml, /New Project/);
assert.match(detailHtml, /New Thread/);

console.log("four-workspace UI tests passed");