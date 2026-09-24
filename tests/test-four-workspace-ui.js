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
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const previewSource = fs.readFileSync(path.join(root, "scripts", "release-preview-server.js"), "utf8");
const knowledgeSource = fs.readFileSync(path.join(root, "src", "webview", "panel", "20-knowledge.js"), "utf8");

assert.match(previewSource, /demoPkmTutorialRecipe/);
assert.match(previewSource, /System\/PKM\/PKM Skills/);
assert.match(previewSource, /validated","known","unknown/);
assert.match(projectsSource, /Intent & guidance/);
assert.match(projectsSource, /Start with a brief purpose/);
assert.match(projectsSource, /\['intent','parameters','references'\]/, "Recipe details expose Intent, Parameters, and References tabs");
assert.match(projectsSource, /Open in VS Code Editor/, "Intent can be opened in the native editor");
assert.match(projectsSource, /class="tbtn recipe-open-browser" data-pending-label="Opening…"/, "Open in Browser provides immediate pending feedback");
assert.match(projectsSource, /finishAction\([^\n]*'recipeOpenBrowser'/, "Open in Browser restores its button after success");
assert.match(projectsSource, /data\?\.action === 'recipeOpenBrowser'\) failAction/, "Open in Browser restores its button and reports failures");
assert.match(css, /\.recipe-open-browser:active\{[^}]*transform:/, "Open in Browser has a visible pressed state");
assert.match(css, /\.recipe-open-browser\.action-pending\{[^}]*animation:recipe-browser-pending/, "Open in Browser animates while browser startup is pending");
assert.match(projectsSource, /class=\"pk-table recipe-reference-table\"/, "References tab renders attached files as a table");
assert.match(projectsSource, /Add Reference[\s\S]*Delete Reference/, "References tab exposes the two bottom actions");
assert.match(projectsSource, /fileSelectorCategoryTree\(items\)/, "Reference Add reuses the Broker File Selector tree model");
assert.match(projectsSource, /function recipeReferenceToggle\(nodeId, kind, knowledgeId, checked/, "Recipe references can be attached and removed");
assert.match(projectsSource, /function recipeAttribute\(value\)[^\n]*&quot;[^\n]*&#39;/, "Recipe reference attributes escape both quote types");
assert.match(projectsSource, /nodeBindings:recipeDraft\.nodeBindings/, "Recipe save persists node knowledge bindings");
assert.match(projectsSource, /class="recipe-icon-button" title="Refresh Recipe Library"/, "Recipe Refresh uses the established icon control style");
assert.match(projectsSource, /oncontextmenu="recipeItemMenu\(/, "Recipe rows expose item context menus");
assert.match(projectsSource, /oncontextmenu="if\(event\.target===this\)recipeRootMenu\(event\)"/, "Recipe CatTree blank space exposes its root context menu");
assert.match(projectsSource, /agentSessionFolderMenu\(event/, "Agent Session folders expose context menus");
assert.match(projectsSource, /pkm:\/\/agent-sessions\//, "Agent Sessions expose canonical reference paths");
assert.match(projectsSource, /workspaceCatTreeDivider\('recipes',recipeTreeCollapsed,true\)/, "Recipe Library exposes the shared CatTree collapse control");
assert.match(projectsSource, /workspaceCatTreeDivider\('agentSessions',agentSessionTreeCollapsed\)/, "Agent Sessions expose the shared CatTree collapse control");
assert.match(projectsSource, /workspaceCatTreeDivider\('projects',projectTreeCollapsed\)/, "Projects expose the shared CatTree collapse control");
assert.match(projectsSource, /classList\.toggle\('cattree-collapsed', collapsed\)/, "workspace CatTree collapse toggles in place without rebuilding the detail pane");
assert.doesNotMatch(projectsSource.match(/function workspaceCatTreeToggle[\s\S]*?\n\}/)?.[0] || '', /render(?:GlobalRecipes|AgentSessions|Projects)\(/, "workspace CatTree collapse does not trigger a full graph rerender");
assert.match(projectsSource, /if \(enabled && \(!projectSnapshot \|\| projectSnapshotDirty\)\) ask\('projectState'/, "Agent Sessions reuse a clean cached Project snapshot when revisited");
assert.match(projectsSource, /tree\.innerHTML = globalRecipeTree\(recipes\)/, "Recipe search updates only the CatTree results");
assert.match(projectsSource, /agent-session-context-menu/, "Agent Session context menus use their bounded presentation");
assert.match(knowledgeSource, /const currentlyOpen = body \? body\.style\.display !== 'none'/, "default-open CatTree folders derive their first toggle from rendered state");
assert.match(knowledgeSource, /if \(body && \['agentSessions', 'recipes'\]\.includes\(state\.tab\)\)/, "Automation CatTree folders toggle locally without rerendering graphs");
assert.strictEqual((knowledgeSource.match(/if \(!projectSnapshot \|\| projectSnapshotDirty\) ask\('projectState', \{\}\);/g) || []).length, 2, "Recipe and Project revisits reuse a clean cached snapshot");
assert.match(bundle, /projectSnapshotDirty = true;[\s\S]{0,500}if \(relevant\) ask\('projectState', \{\}\)/, "hidden Project changes invalidate the cache without forcing an off-screen reload");
assert.match(projectsSource, /Ad hoc task · No Recipe run attached/, "Agent Sessions without a task graph still expose their top-level task as an ad hoc task");
assert.doesNotMatch(projectsSource, /Unplanned session/, "a managed Session task is never presented as missing merely because no Recipe ran");
assert.match(extensionSource, /function agentSessionTrashSnapshots\(\)/, "Agent Session Trash is projected from durable storage");
assert.match(extensionSource, /case "agentSessionTrash"/, "Agent Session Trash mutations have an extension handler");
assert.match(extensionSource, /fs\.renameSync\(source, target\)/, "moving or restoring a Session preserves the durable record");
assert.match(bundle, /command === 'recipeIntentEdited'/, "native editor saves return to the webview draft");
assert.match(extensionSource, /class RecipeDraftFileSystem implements vscode\.FileSystemProvider/, "Recipe intent uses a dedicated draft document provider");
assert.match(extensionSource, /registerFileSystemProvider\("pkm-recipe-draft"/, "Recipe draft provider is registered separately from persisted knowledge");
assert.match(extensionSource, /openRecipeEditorInBrowser\(recipeId\)/, "Recipe browser opens an editable workbench for the persisted Recipe identity");
assert.match(extensionSource, /case "recipeOpenBrowser"/, "Recipe Browser button has an extension-host handler");
assert.match(extensionSource, /recipeBrowserEditorDocument\(recipe, pyenvList\(\)\)/, "Recipe browser renders the Recipe and machine-local PKM Environments in the standalone editor");
assert.match(extensionSource, /requestUrl\.pathname === "\/api\/validate"/, "Recipe browser validates definitions through the extension host contract");
assert.match(extensionSource, /requestUrl\.pathname === "\/api\/recipe"/, "Recipe browser persists edits through an authenticated Recipe endpoint");
assert.match(extensionSource, /Recipe changed since this page opened/, "Recipe browser rejects stale revision overwrites");
assert.match(css, /recipe-design-tab-panel\[data-recipe-design-panel="intent"\][^}]*display:flex[^}]*min-height:330px/, "Intent owns the full detail panel");
assert.match(css, /recipe-design-tab-panel\[data-recipe-design-panel="intent"\] textarea\{width:100%/, "Intent guidance editor spans the panel width");
assert.match(css, /\.recipe-reference-table-wrap\{[^}]*overflow:auto/, "Reference files scroll inside their table region");
assert.match(css, /\.recipe-design-references\{[^}]*overflow:hidden/, "Reference picker and table scroll without pushing bottom actions away");
assert.match(css, /\.recipe-parameter-actions,\.recipe-reference-actions\{[^}]*justify-content:flex-end/, "module detail actions share a bottom action row");
assert.match(css, /\.global-recipes-workspace,[\s\S]*?\.projects-workspace,[\s\S]*?\.agent-sessions-workspace \{[\s\S]*?height: 100%;[\s\S]*?overflow: hidden;/, "Projects and Automation constrain scrolling to their viewport");
assert.match(css, /\.workspace-cattree-divider \{[\s\S]*?width: 6px;[\s\S]*?background: transparent;/, "workspace CatTrees reuse the native sidebar divider geometry");
assert.match(css, /#paper-ctx\.agent-session-context-menu \{[\s\S]*?max-width: min\(340px, calc\(100vw - 16px\)\)/, "Agent Session context menus remain compact on long tasks");
assert.match(css, /\.recipe-library-workbench\.cattree-collapsed,[\s\S]*?\.projects-workspace\.cattree-collapsed,[\s\S]*?\.agent-sessions-workspace\.cattree-collapsed/, "Projects and Automation CatTrees share a collapsed layout");

assert.strictEqual((html.match(/class="workspace-button/g) || []).length, 5, "five primary workspace buttons");
assert.strictEqual((html.match(/class="workspace-separator"/g) || []).length, 4, "four separators divide the five primary workspaces");
assert.strictEqual((html.match(/class="workspace-context-group/g) || []).length, 5, "five contextual workspace groups");
assert.match(html, /data-workspace="knowledge"[^>]*>[\s\S]*?codicon-library/);
assert.match(html, /data-workspace="tools"[^>]*>[\s\S]*?academy-magic-tools[\s\S]*?tools-wand-left[\s\S]*?tools-broom-right/);
assert.doesNotMatch(html, /wizard-(?:head|hat|robe|wand)/, "Tools icon uses a wand and broom instead of a wizard figure");
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
assert.match(html, /<span class="workspace-context-title">Projects<\/span>[\s\S]*?data-tab="projects">Overview<\/button>[\s\S]*?data-tab="chatroom">Threads<\/button>/, "Projects owns Project Overview and Chatroom Threads navigation");
assert.match(css, /\.workspace-context-title\{[^}]*font-family:[^}]*font-size:16px/, "workspace headings use distinct display typography");
assert.match(css, /\.tab\.active::after\{[^}]*background:var\(--accent\)/, "active tabs have a dedicated selection indicator");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-tier::after\{[^}]*border-top:1px solid var\(--agent-tech-line\)[^}]*border-left:1px solid var\(--agent-tech-line\)/, "Recipe connects to the Todo spine");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-expansion::before\{[^}]*border-bottom:1px solid var\(--agent-tech-line\)[^}]*border-left:1px solid var\(--agent-tech-line\)/, "expanded Todo connects to its nested Recipe");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-canvas>\.agent-tech-stem\{align-self:center\}/, "Project root stem stays centered on its Recipe");
assert.match(css, /\.agent-tech-tree\.vertical \.agent-tech-expansion>\.agent-tech-stem\{display:none\}/, "legacy detached expansion stem is hidden");
assert.match(css, /\.recipe-library-workbench\{[^}]*grid-template-columns:280px minmax\(0,1fr\)/, "Recipe Library uses a split CatTree workbench");
assert.match(css, /@media\(max-width:620px\)\{\.recipe-library-workbench\{grid-template-columns:minmax\(0,1fr\)/, "Recipe workbench stacks on narrow screens");
assert.match(css, /\.recipe-node-details\{display:none;/, "Recipe module details are collapsed by default");
assert.match(css, /\.recipe-design-overlay\{position:fixed;inset:0;z-index:2100/, "detailed module design renders on the top layer");
assert.match(css, /\.recipe-design-body>\.recipe-node-details\{display:block/, "the top-layer surface reveals detailed controls");
assert.match(projectsSource, /header\.ondblclick = event =>/, "double-clicking a Recipe module opens detailed design");
assert.match(projectsSource, /function recipeGraphGeneralInstruction\(nodeId, value\)/, "Recipe modules expose reusable general instructions");
assert.match(projectsSource, /A concrete workflow can add task-specific instructions later\./, "module instructions distinguish reusable and instantiated guidance");
assert.match(projectsSource, /function recipeValidateJson\(button\)/, "JSON definitions have an explicit validation step");
assert.match(projectsSource, /ask\('recipeValidateDefinition', \{ definition \}, button\)/, "JSON validation uses the extension-host workflow compiler");
assert.match(projectsSource, /Validate &amp; Open Graph/, "validated JSON opens the normalized Graph");
assert.match(css, /\.recipe-graph-toolbar\{[^}]*flex-wrap:nowrap[^}]*overflow-x:auto/, "Definition Graph toolbar stays on one row");
assert.match(css, /\.recipe-graph-toolbar>\.recipe-graph-tools\{[^}]*flex-direction:row[^}]*flex-wrap:nowrap/, "Definition Graph controls override the generic vertical toolbar child layout");
assert.match(projectsSource, /function recipeGraphMountDetailsOverlay\(\)/, "module details are mounted outside the graph card");
assert.match(projectsSource, /details\.querySelector\('\.recipe-graph-dependencies'\)\?\.remove\(\)/, "module details omit graph route controls");
assert.match(projectsSource, /title:'Create loop connection\?'/, "cycle connections require explicit confirmation");
assert.match(projectsSource, /function recipeGraphDeleteSelectedEdge\(\)/, "selected graph connections can be deleted");
assert.match(projectsSource, /recipe-graph-boundary source/, "Recipe graph derives a visible Source boundary");
assert.match(projectsSource, /recipe-graph-boundary sink/, "Recipe graph derives a visible Sink boundary");
assert.match(projectsSource, /function recipeGraphArrowHead\(x, y,[\s\S]*clip-path|function recipeGraphArrowHead\(x, y,[\s\S]*recipe-graph-arrow/, "Recipe connections use visible directional arrowheads");
assert.match(projectsSource, /class="edge-hit/, "Recipe connections expose a wide pointer hit target");
assert.match(projectsSource, /class="edge-visible/, "Recipe connections render a separate thin directional line");
assert.match(projectsSource, /if \(dependency\.loop\) continue;[\s\S]*?incoming\.add\(node\.nodeId\);[\s\S]*?outgoing\.add\(dependency\.from\)/, "Source and Sink derive from non-loop graph topology");
assert.match(projectsSource, /if \(dependency\.loop \|\| !byId\.has\(dependency\.from\)\) continue;/, "automatic layout ignores intentional loop back-edges");
assert.match(projectsSource, /Re-organize/, "Recipe graph exposes one-click automatic arrangement");
assert.doesNotMatch(projectsSource.match(/function recipeGraphReorganize\(\)[\s\S]*?\n\}/)?.[0] || '', /renderGlobalRecipes\(/,
  "Re-organize updates graph positions without rebuilding the editor viewport");
assert.match(projectsSource, /recipePendingViewState = recipeCaptureViewState\(\)/,
  "Recipe Save captures the editor and graph viewport before the async update");
assert.match(projectsSource, /recipeRestoreViewState\(recipeViewState\)/,
  "Recipe Save restores the viewport after the persisted snapshot rerenders");
assert.match(projectsSource, /nodes\.some\(node => !Number\.isFinite\(positions\[node\.nodeId\]\?\.x\)/,
  "Recipes with missing graph coordinates receive an organized default layout");
assert.match(projectsSource, /class="recipe-graph-tools" role="toolbar" aria-label="Definition Graph actions"/, "all Definition Graph actions share one toolbar row");
assert.match(projectsSource, /recipeGraphAddStep\(\)[\s\S]{0,300}recipeSave\(this\)/, "Save sits beside Add Step in the Definition Graph toolbar");
assert.doesNotMatch(projectsSource, /recipe-editor-header[\s\S]{0,700}recipeSave\(this\)/, "Recipe Save is not placed in the top editor header");
assert.match(projectsSource, /recipe-json-actions[\s\S]{0,500}recipeValidateJson\(this\)[\s\S]{0,500}recipeSave\(this\)/, "JSON mode keeps validation and Save together in the Definition section");
assert.match(projectsSource, /function recipeGraphEdgeRoute\(startX, startY, endX, endY, outerX\)/, "Recipe and Agent graphs share edge routing");
assert.match(projectsSource, /recipeGraphColumnPitch = 258[\s\S]*recipeGraphRowPitch = 114/, "Recipe module whitespace is reduced to 60% without overlapping cards");
assert.match(projectsSource, /rowOffset = \(widestRow - nodeIds\.length\) \* recipeGraphColumnPitch \/ 2/, "Re-organize centers each dependency rank in a top-to-bottom graph");
assert.match(projectsSource, /data-runtime-boundary="start"[\s\S]*data-runtime-boundary="end"/, "materialized Agent Todo graphs expose explicit Start and End boundaries");
assert.match(projectsSource, /paths\.unshift\(`<path class="boundary-edge"[\s\S]*paths\.push\(`<path class="boundary-edge"/, "materialized Todo roots and terminals connect to graph boundaries");
assert.match(projectsSource, /agent-tech-boundary start[\s\S]*agent-tech-boundary end/, "Project Todo technology trees expose explicit Start and End boundaries");
assert.match(css, /\.recipe-graph-canvas,\.agent-runtime-graph,\.agent-tech-tree\{--recipe-graph-line:color-mix\(in srgb,#e25555 58%,var\(--muted\)\)/, "Recipe, Agent, and Project Todo graphs share the muted red line treatment");
assert.match(css, /\.recipe-graph-arrow,\.agent-graph-arrow\{position:absolute;z-index:3;width:12px;height:10px;background:var\(--workflow-node-accent\);clip-path:polygon/, "Recipe and materialized Todo arrows use visible positioned red triangles");
assert.match(css, /\.recipe-graph-arrow\.loop-edge,\.agent-graph-arrow\.loop-edge\{background:var\(--workflow-branch-accent\)/, "loop arrows use the workflow branch accent");
assert.match(css, /\.recipe-graph-canvas,\.agent-runtime-graph,\.agent-tech-tree\{[^}]*--workflow-node-accent:#e25555[^}]*background-image:radial-gradient/, "Recipe, Agent Session, and Project Todo graphs share the Recipe canvas tokens");
assert.match(css, /\.recipe-graph-node[^}]*\.agent-runtime-node,\.agent-tech-node,\.agent-tech-root\{[^}]*border-top:3px solid var\(--workflow-node-accent\)/, "workflow graph surfaces share the Recipe module card skeleton");
assert.match(bundle, /knowledge:\['skills','notes','papers'\]/);
assert.match(bundle, /tools:\['prompts','scripts','packages','environments','servers'\]/);
assert.match(bundle, /automation:\['agentSessions','agentSnapshots','recipes'\]/);
assert.match(html, /data-tab="agentSnapshots">Agent Snapshot</);
assert.match(extensionSource, /case "agentSnapshotCreate"/);
assert.match(extensionSource, /case "agentSnapshotDelete"/);
assert.match(projectsSource, /function renderAgentSnapshots\(\)/);
assert.match(projectsSource, /Copy Recovery Prompt/);
assert.match(projectsSource, /Right-click this Snapshot to delete it/);
assert.match(projectsSource, /agent-session-adhoc' \? 'Ad hoc task' : 'Recipe run'/,
  "Agent Sessions distinguish instance-only task plans from reusable Recipe runs");
assert.match(projectsSource, /sessionTodos\.length \? 'Session todos' : 'Task runs'/, "Agent Session summaries prefer the ordered todo queue and retain the legacy run fallback");
assert.match(projectsSource, /function agentSessionTodoQueue\(todos\)/, "Agent Sessions render their durable FIFO todo queue");
assert.match(projectsSource, /agent-session-archive/, "completed Agent Sessions are grouped into an archive");
assert.match(projectsSource, /selectedAgentSessionId = activeSessions\[0\]/, "Agent Sessions prefer active work over archived history");
assert.doesNotMatch(projectsSource, /agentSessionPollTimer|agentSessionSetPolling|setInterval\([\s\S]{0,200}projectState/,
  "Agent Sessions must use file-change invalidation instead of periodic full-state polling");
assert.match(projectsSource, /agentSessionArchiveExpanded = vscode\.getState\(\)\?\.agentSessionArchiveExpanded/,
  "Agent Sessions must restore the user's Archive disclosure state");
assert.match(projectsSource, /ontoggle="agentSessionGroupToggle\('archive',this\.open\)"/,
  "Agent Sessions must persist Archive disclosure changes");
assert.match(projectsSource, /recipe-search pkm-search-field/, "Recipe Library search uses the shared search field");
assert.match(projectsSource, /onclick="recipeRefresh\(\)"[\s\S]{0,200}codicon-refresh/,
  "Recipe Library exposes an explicit icon Refresh action");
assert.match(projectsSource, /function recipeRefresh\(\) \{[\s\S]{0,100}ask\('projectState', \{\}\)/,
  "Recipe Library Refresh reloads the persisted Project store snapshot");
assert.match(projectsSource, /function recipeParameterSave\(\)/, "Parameters expose an explicit Save action");
assert.match(projectsSource, /function recipeParameterCancel\(\)/, "Parameters expose an explicit Cancel action");
assert.match(css, /\.pkm-search-field:focus-within/, "search fields share one focus treatment");
assert.match(bundle, /state\.tab === 'recipes'\) renderGlobalRecipes\(\)/, "shared CatTree expansion rerenders the Recipe Library");
assert.match(bundle, /command === 'projectStateChanged'[\s\S]{0,300}const relevant = state\.tab === 'recipes' \? scope === 'projects' \|\| scope === 'all'/,
  "managed-state invalidation reloads only the active surface whose data changed");
assert.match(projectsSource, /function recipeRerenderPreservingView\(\)[\s\S]{0,180}recipeCaptureViewState\(\)[\s\S]{0,180}recipeRestoreViewState\(viewState\)/,
  "Recipe component edits rerender without losing the graph viewport");
assert.match(projectsSource, /zoom:recipeGraphZoom, focusId:active\?\.id/,
  "Recipe viewport snapshots preserve zoom and focused controls");
assert.match(bundle, /projects:\['projects','chatroom'\]/);
assert.match(bundle, /settings:\['mcp','skillRouter','subscriptions','githubSync'\]/);
assert.match(html, /data-tab="githubSync">GitHub Sync<\/button>/, "Settings exposes GitHub Sync");
assert.match(bundle, /github-sync-privacy-grid/, "GitHub Sync renders separate privacy panes");
assert.match(bundle, /githubSyncPrivacyTree\(target, 'public'\)/, "GitHub Sync renders a Public tree");
assert.match(bundle, /githubSyncPrivacyTree\(target, 'private'\)/, "GitHub Sync renders a Private tree");
assert.match(bundle, /github-sync-shield/, "GitHub Sync decorates covered content tabs with status shields");
assert.match(bundle, /id="github-sync-expected-login"/, "GitHub Sync exposes a target-level GitHub account");
assert.match(bundle, /id = 'github-sync-auth-method'/, "GitHub Sync exposes a target-level authentication method");
assert.match(bundle, /HTTPS \/ Credential Manager/, "GitHub Sync supports cross-platform credential-helper authentication");
assert.match(bundle, /id="github-sync-identity-file"/, "GitHub Sync exposes a target-level SSH identity");
assert.match(bundle, /identity\.closest\('label'\)\.hidden = method !== 'ssh'/, "GitHub Sync hides SSH-only controls for GCM targets");
assert.match(bundle, /githubSyncPickIdentity\(this\)/, "GitHub Sync can browse for an SSH key");
assert.match(bundle, /githubSyncCreateIdentity\(this\)/, "GitHub Sync can create a dedicated SSH key");
assert.match(bundle, /github-sync-account-options/, "GitHub Sync exposes discovered GCM accounts as editable suggestions");
assert.match(bundle, /github-sync-identity-options/, "GitHub Sync exposes discovered SSH identities as editable suggestions");
assert.match(bundle, /githubSyncTestAuthentication\(this\)/, "GitHub Sync can verify the selected account");
assert.match(bundle, /aria-label="Subscription source"/, "Subscribe exposes a Broker and GitHub Branch segmented source control");
assert.match(bundle, /None \/ Public repository/, "GitHub subscriptions support public repositories without credentials");
assert.match(bundle, /ask\('subscriptionTestGitHubBranch'/, "GitHub subscriptions test repository access before mounting");
assert.match(bundle, /subscriptionGitHubTree\(result\.files\)/, "GitHub Test results expose a selectable content tree");
assert.match(bundle, /expectedCommit:result\.commit/, "GitHub subscriptions mount the exact tested commit");
assert.match(bundle, /ask\('subscriptionMountGitHub'/, "Subscribe mounts selected GitHub repository content");
assert.match(bundle, /Read-only cache/, "GitHub branch mounts are explicitly read-only");
assert.match(bundle, /function githubSyncRestore\(targetId, button\)/, "GitHub Sync retains an explicit restore action");
assert.doesNotMatch(bundle, /githubSyncRemoteBrowse|githubSyncRemotePreview|github-sync-remote/, "GitHub Sync does not duplicate Broker browsing");
assert.match(extensionSource, /if \(target\.authentication\) await testGitHubSyncAuthentication\(target\)/, "GitHub Sync verifies configured authentication before saving");
assert.match(extensionSource, /case "subscriptionMountGitHub"/, "extension host materializes GitHub branches as subscriptions");
assert.match(extensionSource, /case "subscriptionTestGitHubBranch"/, "extension host inventories a GitHub branch before subscription");
assert.match(extensionSource, /authentication: credentialTarget\?\.authentication/, "GitHub subscriptions reuse only a selected GitHub Sync credential profile");
assert.match(extensionSource, /showQuickPick\(snapshot\.files\.map/, "GitHub restore uses native searchable multi-select");
assert.doesNotMatch(extensionSource, /registerTextDocumentContentProvider\("pkm-github-remote"/, "GitHub Sync does not register a parallel remote browser");
assert.match(extensionSource, /showWarningMessage\([\s\S]{0,400}"Overwrite and Restore"/, "GitHub Sync requires explicit confirmation before overwriting local files");
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
      const category = getCategory(item);
      const segments = Array.isArray(category) ? category.filter(Boolean) : String(category || fallback).split("/").filter(Boolean);
      let node = root;
      for (const segment of segments) node = node.folders[segment] ||= { folders: {}, items: [] };
      node.items.push(item);
    }
    return root;
  },
  renderCatTree: function renderCatTree(node, pathParts, depth, renderLeaf, query, folderAttr, order, options = {}) {
    return Object.entries(node.folders).map(([name, child]) => `<div class="tree-cat"><div class="tree-cat-hdr"${folderAttr ? folderAttr(child, name, [...pathParts, name]) : ""}>${options.renderFolderLabel ? options.renderFolderLabel(name, [...pathParts, name]) : context.privacyLock(context.privacyInherited([...pathParts, name])) + name}</div>${renderCatTree(child, [...pathParts, name], depth + 1, renderLeaf, query, folderAttr, order, options)}</div>`).join("") + node.items.map(item => renderLeaf(item, depth, query)).join("");
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
assert.strictEqual(context.recipeGraphEdgeRoute(20, 30, 20, 90, 120), "M 20 30 L 20 90", "vertically aligned graph modules use a straight arrow");
assert.match(context.recipeGraphEdgeRoute(20, 30, 80, 90, 120), /^M 20 30 C /, "offset graph modules use a curved dependency line");
const organized = context.recipeGraphOrganizedPositions([
  { nodeId: "download", dependsOn: [] },
  { nodeId: "summarize", dependsOn: [{ from: "download" }] },
  { nodeId: "decide", dependsOn: [{ from: "summarize" }] },
]);
assert.ok(organized.download.y < organized.summarize.y && organized.summarize.y < organized.decide.y,
  "default Recipe layout follows dependency ranks from top to bottom");

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
  { value:"if", label:"If / Else" }, { value:"switch", label:"Switch" },
  { value:"command", label:"Background command" }, { value:"script", label:"Executable script" },
  { value:"human", label:"Required user input" }
]);
vm.runInContext("recipeDraft.definition.spec.nodes.push({ nodeId:'download', kind:'pkm.step.command/v1', config:{ program:'python3', args:[], timeoutSeconds:300, maxOutputBytes:65536 }, dependsOn:[], ports:{ inputs:[], outputs:['result'] }, control:{ mode:'single' } })", context);
context.recipeGraphCommandField("download", "args", "download.py\n${inputs.logId}");
context.recipeGraphCommandField("download", "timeoutSeconds", "45");
assert.deepStrictEqual(JSON.parse(vm.runInContext("JSON.stringify(recipeDraft.definition.spec.nodes.find(node => node.nodeId === 'download').config)", context)), {
  program:"python3", args:["download.py", "${inputs.logId}"], timeoutSeconds:45, maxOutputBytes:65536
});
assert.match(context.recipeGraphAdapterConfigHtml({ nodeId:"download", kind:"pkm.step.command/v1", config:{ program:"python3", args:["${inputs.logId}"], timeoutSeconds:45, maxOutputBytes:65536 } }), /passed directly without a shell/);
vm.runInContext("recipeDraft.definition.spec.nodes.push({ nodeId:'script', kind:'pkm.step.script/v1', config:{ runtime:'bash', script:'echo ready', timeoutSeconds:300, maxOutputBytes:65536 }, dependsOn:[], ports:{ inputs:[], outputs:['result'] }, control:{ mode:'single' } })", context);
context.recipeGraphScriptField("script", "runtime", "python");
assert.match(context.recipeGraphAdapterConfigHtml({ nodeId:"script", kind:"pkm.step.script/v1", config:{ runtime:"python", environmentId:"analysis-env", script:"print('ready')", timeoutSeconds:45, maxOutputBytes:65536 } }), /PKM Python Environment/);
assert.match(context.recipeGraphAdapterConfigHtml({ nodeId:"script", kind:"pkm.step.script/v1", config:{ runtime:"powershell", script:"Write-Output ready", timeoutSeconds:45, maxOutputBytes:65536 } }), /only on Windows/);
vm.runInContext("recipeDraft.definition.spec.nodes.pop()", context);
assert.match(context.recipeGraphAdapterConfigHtml({ nodeId:"permission", kind:"pkm.gate.human/v1", config:{ prompt:"Proceed?", inputKind:"approval" } }), /cannot be completed by an Agent report/);
vm.runInContext("recipeDraft.definition.spec.nodes.pop()", context);
modal.onOk("finish", "", false, "repeat");
assert.match(detailHtml, /<strong>finish<\/strong>/);
assert.match(detailHtml, /recipe-repeat-badge">× 2/);
const dragTarget = { classList: { add() {}, remove() {} } };
context.recipeGraphDrop({ preventDefault() {}, currentTarget: dragTarget, dataTransfer: { getData: () => "start" } }, "finish");
assert.match(detailHtml, /recipe-dependency-route"><strong>start/);
assert.match(detailHtml, /Source output/);
assert.match(detailHtml, /Target input/);
assert.deepStrictEqual(JSON.parse(JSON.stringify(context.recipeGraphCyclePath("finish", "start"))), ["start", "finish", "start"]);
context.recipeGraphDrop({ preventDefault() {}, currentTarget: dragTarget, dataTransfer: { getData: () => "finish" } }, "start");
assert.strictEqual(modal.title, "Create loop connection?");
assert.match(modal.message, /finish → start closes a cycle/);
modal.onOk();
context.recipeGraphRemoveDependency("start", "finish");
context.recipeGraphSelectEdge(null, "start", "finish");
context.recipeGraphDeleteSelectedEdge();
assert.strictEqual(context.recipeGraphCyclePath("finish", "start"), null, "deleting the selected edge removes its dependency");
context.recipeGraphDrop({ preventDefault() {}, currentTarget: dragTarget, dataTransfer: { getData: () => "start" } }, "finish");
context.recipeGraphControlMode("finish", "repeat");
assert.match(detailHtml, /recipe-repeat-badge">× 2/);
context.recipeGraphRepeatKind("finish", "dynamic");
assert.match(detailHtml, /recipe-repeat-badge">× \?/);
context.recipeGraphControlMode("finish", "branch");
assert.match(detailHtml, /If \/ Else/);
assert.match(detailHtml, /value="yes, no"/);
context.recipeParameterBegin("finish");
context.recipeGraphNodePorts("finish", "inputs", "temporary-input");
vm.runInContext("recipeReferencePickerNodeId = 'finish'; recipeReferenceSelectedKeys.add('skill:shared')", context);
context.recipeParameterCancel();
assert.doesNotMatch(detailHtml, /temporary-input/, "Parameter Cancel restores the module snapshot");
assert.strictEqual(vm.runInContext("recipeReferencePickerNodeId === '' && recipeReferenceSelectedKeys.size === 0", context), true, "Parameter Cancel clears transient Reference state");
context.recipeParameterBegin("finish");
context.recipeGraphNodePorts("finish", "inputs", "saved-input");
vm.runInContext("recipeReferencePickerNodeId = 'finish'; recipeReferenceSelectedKeys.add('skill:shared')", context);
context.recipeParameterSave();
assert.match(detailHtml, /saved-input/, "Parameter Save keeps the edited module parameters");
assert.strictEqual(vm.runInContext("recipeReferencePickerNodeId === '' && recipeReferenceSelectedKeys.size === 0", context), true, "Parameter Save clears transient Reference state");
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
context.recipeGraphToggleLoop("finish", "start", true);
context.recipeGraphLoopField("finish", "start", "condition", "score >= target");
context.recipeGraphLoopField("finish", "start", "maxIterations", "25");
context.recipeReferenceToggle("finish", "skill", "Coding/Review", true);
context.recipeReferenceUsage("finish", "skill:Coding/Review", "required");
context.recipeEditorModeSet("json");
assert.match(detailHtml, /id="recipe-definition"/);
assert.match(detailHtml, /score &gt;= target/);
assert.match(detailHtml, /"maxIterations": 25/);
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
    editorLayout: { nodePositions: { start: { x:24, y:24 }, finish: { x:282, y:24 } } },
    definition: { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [], outputs: {}, completion: { requiredNodes: [] } } },
    nodeBindings: [{ nodeId:"finish", bindings:[{ kind:"skill", knowledgeId:"Coding/Review", usage:"required" }] }]
  }
});
context.recipeReferenceToggle("finish", "skill", "Coding/Review", false);
context.recipeSave({});
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1).data.nodeBindings)), [], "removing the last reference drops the empty node binding from the save payload");
formElements["recipe-definition"].value = "{";
context.recipeSave({});
assert.match(formElements["recipe-edit-error"].textContent, /Definition JSON is invalid/);
assert.strictEqual(messages.at(-1).command, "recipeUpdate", "invalid JSON does not send another update");
context.recipeFolderMenu({ preventDefault() {}, stopPropagation() {}, clientX: 4, clientY: 8 }, "Software Development");
assert.strictEqual(contextMenu.items[0].label, "Folder: Software Development");
assert.ok(contextMenu.items.some(item => item.label === "New Recipe Here"));
const privacyMenuItem = contextMenu.items.find(item => item.label === "Set as Public");
assert.ok(privacyMenuItem);
privacyMenuItem.onClick();
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "contentSetPrivacy", data: { type: "recipes", topLevel: "Software Development", isPrivate: false } });
context.recipeItemMenu({ preventDefault() {}, stopPropagation() {}, clientX: 4, clientY: 8 }, "recipe_global");
assert.deepStrictEqual(JSON.parse(JSON.stringify(contextMenu.items.filter(item => item.label).map(item => item.label))), ["Universal Review", "Open Recipe", "Rename…", "Move to Folder…", "Copy Path", "Copy Recipe ID", "Move to Trash…"]);
contextMenu.items.find(item => item.label === "Move to Trash…").onClick();
modal.onOk();
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "recipeTrash", data: { action: "move", recipeId: "recipe_global" } });
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
assert.match(detailHtml, /No Agent Sessions/);
assert.match(detailHtml, /0 sessions/);
assert.doesNotMatch(detailHtml, /Copilot Agent/);
assert.doesNotMatch(detailHtml, /Sample preview|agt_7f31/);
assert.doesNotMatch(projectsSource, /agt_7f31|agentSessionShowPreview|agentSessionClosePreview/,
  "Agent Sessions must not expose the removed fixture as a runtime record");
context.projectOnState({ ...snapshot, recipes: [
  { recipeId: "recipe_daily", scope: "project", projectId: "project_default", name: "Daily Review", description: "", revision: 1, executableDigest: "abcdef1234567890", definition: { spec: { nodes: [{ nodeId: "start" }] } } },
  { recipeId: "recipe_global", scope: "global", category: "Software Development", name: "Universal Review", description: "", revision: 1, executableDigest: "123456abcdef7890", definition: { spec: { nodes: [{ nodeId: "start" }] } } }
], agentSessions: [{
  sessionId: "agent_session_archived", status: "completed", task: "Completed historical task",
  agent: { name: "Copilot Agent", product: "GitHub Copilot" }, createdAt: "2026-09-21T08:00:00Z", updatedAt: "2026-09-21T08:01:00Z",
  lastActivity: { tool: "agent_session_end", ok: true, at: "2026-09-21T08:01:00Z" }, runs: []
}, {
  sessionId: "agent_session_managed", status: "running", task: "Validate portable workflow",
  hostSessionId: "bad9a5a4-4dc6-4633-adef-a0858284b965",
  projectId: "project_pkm", agent: { name: "Copilot Agent", product: "GitHub Copilot" },
  createdAt: "2026-09-22T08:00:00Z", updatedAt: "2026-09-22T08:01:00Z",
  lastActivity: { tool: "recipe_run_report", ok: true, at: "2026-09-22T08:01:00Z" },
  checkpoint: { checkpointId: "checkpoint_portable", sequence: 2, createdAt: "2026-09-22T08:00:30Z", reason: "handoff", summary: "Implementation is ready for validation.", nextActionCount: 1 },
  todos: [
    { todoId: "todo_review", title: "Review existing behavior", details: "Inspect the current flow.", status: "succeeded", summary: "Review complete." },
    { todoId: "todo_implement", title: "Implement current work", details: "Keep this item running.", status: "running", recipeRunId: "recipe_run_parent" },
    { todoId: "todo_additive", title: "Handle additive request", details: "Appended after unfinished work.", status: "pending" }
  ],
  runs: [{
    runId: "recipe_run_parent", recipeId: "recipe_parent", recipeName: "Parent Workflow", recipeRevision: 3,
    executableDigest: "abcdef1234567890", status: "running", createdAt: "2026-09-22T08:00:00Z", updatedAt: "2026-09-22T08:01:00Z",
    loops: [{ source: "validate", target: "implement", state: "running", iteration: 2, maxIterations: 3, condition: "tests pass" }],
    nodes: [
      { nodeId: "understand", kind: "pkm.step.noop/v1", dependsOn: [], control: { mode: "single" }, state: "succeeded", outcome: "succeeded", error: "", childRunId: "" },
      { nodeId: "implement", kind: "pkm.step.noop/v1", dependsOn: [{ from: "understand", accept: ["succeeded"], loop: false }], control: { mode: "single" }, state: "running", outcome: "", error: "", childRunId: "" },
      { nodeId: "nested", kind: "pkm.subflow/v1", dependsOn: [{ from: "implement", accept: ["succeeded"], loop: false }], control: { mode: "single" }, state: "pending", outcome: "", error: "", childRunId: "recipe_run_child" }
    ]
  }, {
    runId: "recipe_run_child", recipeId: "recipe_child", recipeName: "Nested Validation", recipeRevision: 1,
    executableDigest: "1234567890abcdef", status: "running", parent: { runId: "recipe_run_parent", nodeId: "nested" },
    createdAt: "2026-09-22T08:00:10Z", updatedAt: "2026-09-22T08:01:00Z", loops: [],
    nodes: [{ nodeId: "check", kind: "pkm.step.noop/v1", dependsOn: [], control: { mode: "single" }, state: "pending", outcome: "", error: "", childRunId: "" }]
  }]
}, {
  sessionId: "agent_session_followup", status: "running", task: "Group related workflow",
  hostSessionId: "bad9a5a4-4dc6-4633-adef-a0858284b965",
  projectId: "project_pkm", agent: { name: "Copilot Agent", product: "GitHub Copilot" },
  createdAt: "2026-09-22T08:02:00Z", updatedAt: "2026-09-22T08:03:00Z",
  lastActivity: { tool: "agent_session_start", ok: true, at: "2026-09-22T08:03:00Z" }, runs: []
}], recipeTrash: [{
  recipeId: "recipe_trashed", scope: "global", category: "Software Development", name: "Discarded Review", description: "", revision: 1,
  executableDigest: "9876543210abcdef", trashedAt: "2026-09-22T09:00:00Z", definition: { spec: { nodes: [{ nodeId: "start" }] } }
}], agentSessionTrash: [{
  sessionId: "agent_session_trashed", status: "completed", task: "Discarded historical task",
  agent: { name: "Other Agent", product: "GitHub Copilot" }, updatedAt: "2026-09-20T08:01:00Z", trashedAt: "2026-09-22T09:00:00Z"
}], agentSnapshots: [{
  snapshotId: "agent_snapshot_portable", magicCode: "PKM-SNAP-1234-5678-90AB-CDEF",
  sourceSessionId: "agent_session_managed", sourceHostSessionId: "bad9a5a4-4dc6-4633-adef-a0858284b965",
  task: "Validate portable workflow", projectId: "project_pkm",
  agent: { name: "Copilot Agent", product: "GitHub Copilot" }, reason: "restart",
  createdAt: "2026-09-22T08:05:00Z", recipeRunCount: 2, todoCount: 3,
  checkpoint: { checkpointId: "checkpoint_portable", sequence: 2, createdAt: "2026-09-22T08:00:30Z", reason: "handoff" },
  recoveryCount: 2
}] });
assert.match(detailHtml, /3 sessions/);
assert.match(detailHtml, /Validate portable workflow/);
assert.match(detailHtml, /<details class="agent-session-archive"(?![^>]*\sopen(?:\s|>))[^>]*>/, "completed Sessions are collapsed by default");
assert.match(detailHtml, /Completed historical task/);
assert.match(detailHtml, /agent-session-tree/, "Agent Sessions use the shared CatTree surface");
assert.strictEqual((detailHtml.match(/class="tree-cat"/g) || []).length, 4, "active and archived Sessions share Agent and Copilot Session hierarchy levels");
assert.doesNotMatch(detailHtml, /agent-session-agent-group|agent-session-host-group/, "Agent Sessions do not maintain a parallel tree schema");
assert.strictEqual((detailHtml.match(/Copilot Session bad9a5a4/g) || []).length, 1, "Sessions sharing one Copilot ID render in one host group");
assert.match(detailHtml, /Group related workflow/, "Every managed task remains visible within its Copilot Session group");
assert.match(detailHtml, /managed/, "Session short identity remains visible within an Agent group");
assert.match(detailHtml, /agentSessionContextMenu/, "Agent Sessions expose right-click actions");
assert.match(detailHtml, /cattree-item-menu/, "Agent Session leaves expose the shared explicit action menu");
assert.match(detailHtml, /cattree-trash-dock[\s\S]*codicon-trash[\s\S]*Trash/, "Agent Session Trash uses the shared bottom CatTree dock");
assert.match(detailHtml, /Discarded historical task/);
assert.match(projectsSource, /action:'restore'/);
assert.match(projectsSource, /Delete Permanently/);
assert.match(detailHtml, /Checkpoint 2/);
assert.match(detailHtml, /Implementation is ready for validation/);
assert.match(detailHtml, /Parent Workflow/);
assert.match(detailHtml, /understand/);
assert.match(detailHtml, /implement/);
assert.match(detailHtml, /running/);
assert.match(detailHtml, /2\/3/);
assert.match(detailHtml, /Nested Recipe/);
assert.match(detailHtml, /Nested Validation/);
assert.strictEqual((detailHtml.match(/class="agent-runtime-graph-links"/g) || []).length, 2, "parent and nested Recipe runs own separate edge layers");
assert.match(detailHtml, /data-node-id="understand"/, "instantiated Recipe nodes expose graph-local identities");
assert.match(detailHtml, /Session Todos/);
assert.ok(detailHtml.indexOf('Implement current work') < detailHtml.indexOf('Handle additive request'), "additive work remains after the running todo");
assert.match(detailHtml, /1 \/ 3/, "Agent Sessions expose visible Session todo progress");
assert.match(detailHtml, /33% complete/);
context.state.tab = "agentSnapshots";
context.renderAgentSnapshots();
assert.match(detailHtml, /Create Agent Snapshot/);
assert.match(detailHtml, /PKM-SNAP-1234-5678-90AB-CDEF/);
assert.match(detailHtml, /2 recoveries/);
assert.match(detailHtml, /agent_session_snapshot_recover/);
assert.match(detailHtml, /Right-click this Snapshot to delete it/);
context.agentSnapshotContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 4, clientY: 8 }, "agent_snapshot_portable");
assert.ok(contextMenu.items.some(item => item.label === "Delete Snapshot…"));
contextMenu.items.find(item => item.label === "Delete Snapshot…").onClick();
modal.onOk();
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "agentSnapshotDelete", data: { snapshotId: "agent_snapshot_portable" } });
context.state.tab = "recipes";
context.renderGlobalRecipes();
assert.match(detailHtml, /Search Recipes and Steps/);
assert.match(detailHtml, /recipe-library-tree-scroll/, "Recipe Library reserves a scrolling CatTree region above its dock");
assert.match(detailHtml, /cattree-item-menu/, "Recipe leaves expose the shared explicit action menu");
assert.match(detailHtml, /cattree-trash-dock[\s\S]*Discarded Review/, "Recipe Trash uses the shared bottom CatTree dock");
context.recipeTrashItemMenu({ preventDefault() {}, stopPropagation() {}, clientX: 4, clientY: 8 }, "recipe_trashed");
contextMenu.items.find(item => item.label === "Restore").onClick();
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "recipeTrash", data: { action: "restore", recipeId: "recipe_trashed" } });
context.recipeTrashItemMenu({ preventDefault() {}, stopPropagation() {}, clientX: 4, clientY: 8 }, "recipe_trashed");
contextMenu.items.find(item => item.label === "Delete Permanently…").onClick();
modal.onOk();
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.at(-1))), { command: "recipeTrash", data: { action: "delete", recipeId: "recipe_trashed" } });
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