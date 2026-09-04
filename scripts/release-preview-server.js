#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const webview = path.join(root, "dist", "webview");
const port = Number(process.env.PORT || 4178);

const demoMcp = {
  installed: true,
  current: true,
  installedVersion: "2.6.0",
  expectedVersion: "2.6.0",
  knowledgeVersion: "1.0.0",
  chatVersion: "2.3.1",
  installedKnowledgeVersion: "1.0.0",
  installedChatVersion: "2.3.1",
  serverPath: "/home/demo/pkm/mcp-server/server.py",
  nativeMcpProvider: true,
  mcpProcess: { running: true, pid: "24501", available: true, detail: "Generated server process detected." },
  store: { path: "/home/demo/pkm", configured: true, valid: true },
  paths: {
    store: "/home/demo/pkm",
    environments: "/home/demo/pkm-envs",
    runtime: "/home/demo/pkm-envs/pkm-mcp",
    python: "/home/demo/pkm-envs/pkm-mcp/bin/python",
    serverDirectory: "/home/demo/pkm/mcp-server",
  },
  mcpPython: { path: "/usr/bin/python3", version: "3.12.3", valid: true, source: "PATH", error: "" },
  mcpRuntime: { path: "/home/demo/pkm-envs/pkm-mcp", python: "/home/demo/pkm-envs/pkm-mcp/bin/python", exists: true, healthy: true, registered: true, version: "3.12.3", error: "" },
  combinedRegistry: '{\n  "servers": {\n    "pkm": { "type": "stdio", "command": "/home/demo/pkm-envs/pkm-mcp/bin/python", "args": ["/home/demo/pkm/mcp-server/server.py"] }\n  }\n}',
  agencyInstallInstruction: "Register the demo unified local stdio MCP server named pkm.\nUse /home/demo/pkm-envs/pkm-mcp/bin/python and /home/demo/pkm/mcp-server/server.py.",
  pkmSkill: {
    routerVersion: "1.1.4",
    minimumMcpSchema: "2.2.3",
    sourcePath: "/home/demo/pkm/skills/System/PKM/PKM Skills.md",
    sourceExists: true,
    targets: [
      { id: "copilot", kind: "copilot", label: "GitHub Copilot", skillPath: "/home/demo/.copilot/skills/pkm-skills/SKILL.md", state: "current", installedVersion: "1.1.4", expectedVersion: "1.1.4", managed: true, detail: "Injected Skill is current." },
      { id: "agents", kind: "agents", label: "Agent Skills", skillPath: "/home/demo/.agents/skills/pkm-skills/SKILL.md", state: "current", installedVersion: "1.1.4", expectedVersion: "1.1.4", managed: true, detail: "Injected Skill is current." },
    ],
  },
  skillProposals: [],
};

const demoChat = {
  rooms: [{ key: "demo", room: "Release Planning", roomId: "demo-room", url: "ws://127.0.0.1:7345", status: "connected", unread: 0, selfHost: true }],
  activeKey: "demo",
  active: {
    key: "demo", room: "Release Planning", roomId: "demo-room", url: "ws://127.0.0.1:7345", status: "connected", statusDetail: "",
    self: "Release Host", selfHost: true, selfMuted: false, hasRoomKey: true,
    members: [
      { user: "Release Host", participantId: "demo-host", host: true, present: true, kind: "human", runtimeState: "idle" },
      { user: "Docs Reviewer", participantId: "demo-docs", present: true, kind: "agent", runtimeState: "standby" },
      { user: "QA Agent", participantId: "demo-qa", present: true, kind: "agent", runtimeState: "thinking" },
      { user: "Build Monitor", participantId: "demo-build", present: false, kind: "agent", runtimeState: "idle" },
    ],
    messages: [
      { id: "d1", from: "Release Host", kind: "human", ts: 1787010000000, text: '@"Docs Reviewer" @"QA Agent" Please review the 2.6.0 release notes and regression matrix.', recipients: ["Docs Reviewer", "QA Agent"], replyPolicy: "required", mode: "ask", receipt: { read: 2, total: 2 } },
      { id: "d2", from: "Docs Reviewer", kind: "agent", ts: 1787010060000, text: "Documentation review is complete. The setup guide now separates server, schema, and Skill Router versions.", recipients: ["Release Host"], replyPolicy: "none" },
      { id: "d3", from: "QA Agent", kind: "agent", ts: 1787010120000, text: "Search navigation, quoted mentions, offline roster routing, and standby wake tests are passing.", recipients: ["Release Host"], replyPolicy: "none" },
      { id: "d4", from: "Release Host", kind: "human", ts: 1787010180000, text: '@all Final check: verify the package and publish workflow.', recipients: ["all"], replyPolicy: "required", mode: "announce", receipt: { read: 2, total: 2 } },
    ],
    agentStates: { "Docs Reviewer": "standby", "QA Agent": "thinking" }, files: [],
  },
  hubRunning: true, hubUrl: "ws://127.0.0.1:7345", hubHttpUrl: "http://127.0.0.1:7345", hubPort: 7345,
  hubAdminRooms: [{ roomId: "demo-room", room: "Release Planning", owner: "Release Host", members: 3, hasKey: true }],
  storedRooms: [], pendingApprovals: [], managedAgents: [],
};

const demoPapers = [
  { slug: "demo/retrieval-planning", title: "Retrieval Planning", topic: "Retrieval", year: 2025, citationCount: 12, kind: "paper" },
  { slug: "demo/context-routing", title: "Context Routing", topic: "Agents", year: 2026, citationCount: 9, kind: "paper" },
  { slug: "demo/tool-memory", title: "Tool Memory", topic: "Memory", year: 2025, citationCount: 7, kind: "paper" },
  { slug: "demo/iterative-verification", title: "Iterative Verification", topic: "Evaluation", year: 2026, citationCount: 5, kind: "paper" },
  { slug: "demo/adaptive-index", title: "Adaptive Index", topic: "Retrieval", year: 2024, citationCount: 4, kind: "paper" },
  { slug: "demo/research-loop", title: "Research Loop", topic: "Agents", year: 2026, citationCount: 2, kind: "idea" },
];
const demoGraph = {
  total: demoPapers.length, shown: demoPapers.length,
  nodes: demoPapers.map(paper => ({ key: paper.slug, title: paper.title, topic: paper.topic, year: paper.year, citationCount: paper.citationCount, kind: paper.kind, conclusions: paper.kind === "idea" ? ["Route evidence through verification before synthesis"] : ["Synthetic release fixture", "No private research content"] })),
  edges: [
    { from: "demo/adaptive-index", to: "demo/retrieval-planning", note: "index" },
    { from: "demo/retrieval-planning", to: "demo/context-routing", note: "evidence" },
    { from: "demo/tool-memory", to: "demo/context-routing", note: "memory" },
    { from: "demo/context-routing", to: "demo/iterative-verification", note: "verify" },
    { from: "demo/iterative-verification", to: "demo/research-loop", note: "iterate" },
    { from: "demo/retrieval-planning", to: "demo/research-loop", note: "plan" },
  ],
};
const demoServers = [{
  slug: "demo-server", name: "Demo Visualization Server", command: "python server.py --port 8772", port: 8772,
  python: "/home/demo/pkm-envs/demo/bin/python", autostart: false, status: "running", pid: 24001,
  activePort: 8772, localUrl: "http://localhost:8772/", autoForward: true, remoteName: "ssh-remote",
  networkLinks: [{ interface: "ethernet0", address: "10.0.0.8", url: "http://10.0.0.8:8772/" }],
}];
let demoSubscriptions = {
  enabled: true,
  gatewayStatus: "running",
  nodeId: "demo-node-fingerprint-260",
  displayName: "Demo Publisher / Workstation",
  port: 19877,
  advertisedHost: "demo-workstation.local",
  networkAddresses: [{ interface: "Hostname", address: "demo-workstation.local", kind: "hostname" }, { interface: "ethernet0", address: "10.0.0.8", kind: "interface" }],
  shares: [{ shareId: "demo-aagl-share", name: "AAGL Working Set", visibility: "unlisted", revision: 4, protection: "secret-protected", controlPort: 19891, dataPort: 0, accessMode: "block-list", ipRules: ["10.99.*.*"], accountMode: "white-list", accountRules: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], contentTypes: ["skills", "notes", "papers"], selected: { skills: ["Pipeline Review"] }, folders: { notes: ["Research/AAGL"], papers: ["AAGL"] }, subscribers: [{ nodeId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Docs Reviewer / Laptop", names: ["Docs Reviewer / Laptop"], syncCount: 7, lastIp: "10.0.0.24", lastSeenAt: "2026-09-03T01:04:00Z", abnormal: [] }], automaticBlocks: [{ ip: "10.99.4.8", reason: "three-secret-failures", failedAttempts: 3, blockedAt: "2026-09-03T00:40:00Z" }], securityEvents: [{ at: "2026-09-03T00:40:00Z", ip: "10.99.4.8", reason: "IP blocked after three incorrect Broker secrets." }], summary: { counts: { skills: 3, notes: 8, papers: 4 }, topics: ["AAGL", "Asset Quality"], tags: ["pipeline", "evaluation"], itemCount: 15, secretProtected: true } }],
  subscriptions: [{ id: "demo-sub", alias: "", brokerName: "CreativeGen", publisher: "Colleague / Team Node", publisherUser: "colleague", publisherHost: "team-node", nodeId: "demo-peer", shareId: "demo-team-share", endpoint: "http://team-node:19877", revision: 12, collectionHash: "sha256:demo", topics: ["DLIS", "Consumer"], tags: ["docker", "research"], counts: { skills: 6, notes: 5, servers: 1 }, itemCount: 12, status: "current", lastUpdated: "2026-09-03T01:00:00Z" }],
  catalog: {
    skills: [{ id: "Pipeline Review", label: "Pipeline Review", cat: "AAGL", meta: "evaluation" }, { id: "Docker Workflow", label: "Docker Workflow", cat: "DLIS", meta: "docker" }],
    notes: [{ id: "Research/AAGL/Design", label: "Design Notes", cat: "Research/AAGL", meta: "research" }],
    papers: [{ id: "AAGL/Retrieval", label: "Retrieval Planning", cat: "AAGL", meta: "2026" }],
    prompts: [], scripts: [], packages: [], servers: [{ id: "review-api", label: "Review API", cat: "Team/APIs", meta: "api" }],
  },
};
const demoLocalPackages = [{ name: "local-evaluator", lang: "python", description: "Local package", gitTracked: true, gitRepo: false }];
const demoSubscribedPackages = [{
  subscriptionId: "demo-sub", alias: "CreativeGen", publisher: "Colleague / Team Node", nodeId: "demo-peer", shareId: "demo-team-share", revision: 12, syncedAt: "2026-09-03T01:00:00Z",
  items: [{ key: Buffer.from(JSON.stringify({ subscriptionId: "demo-sub", type: "packages", path: "asset-quality/README.md" })).toString("base64url"), title: "asset-quality", path: "asset-quality", type: "packages", packageName: "asset-quality" }],
}];
const demoSubscribedServers = [{
  subscriptionId: "demo-sub", alias: "CreativeGen", publisher: "Colleague / Team Node", nodeId: "demo-peer", shareId: "demo-team-share", revision: 12, syncedAt: "2026-09-03T01:00:00Z",
  items: [
    { key: "demo-server-link-1", title: "Asset Quality Dashboard", path: "asset-quality/server.link.json", type: "servers", link: "http://team-node:39501/s/asset-quality/", status: "running" },
    { key: "demo-server-link-2", title: "Experiment Report", path: "experiment-report/server.link.json", type: "servers", link: "http://team-node:39501/s/experiment-report/", status: "unavailable" },
  ],
}];

function bootstrap(view) {
  const sizes = { store: 18874368, environments: 1702887424, runtime: 247463936, python: 6832128, serverDirectory: 315392 };
  return `<style id="release-theme">
  :root{--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-panel-border:#343434;--vscode-focusBorder:#0078d4;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;--vscode-textCodeBlock-background:#181818;--vscode-font-family:"Segoe UI",sans-serif;--vscode-editor-font-family:"Cascadia Code",Consolas,monospace;--vscode-font-size:13px}
  </style><script>
  const __state = { tab: ${JSON.stringify(view === "chat" ? "chatroom" : view === "papers" ? "papers" : view === "subscriptions" ? "subscriptions" : "mcp")} };
  const __chat = ${JSON.stringify(demoChat)};
  let __messageSequence = 10;
  window.acquireVsCodeApi = () => ({
    getState: () => __state,
    setState: value => Object.assign(__state, value || {}),
    postMessage: message => setTimeout(() => {
      const send = (command, data) => window.dispatchEvent(new MessageEvent('message', { data: { command, data } }));
      if (message.command === 'ready') {
        send('subscriptionState', ${JSON.stringify(demoSubscriptions)});
        window.dispatchEvent(new MessageEvent('message', { data: { command: 'openTab', tab: __state.tab } }));
        send('mcpStatus', ${JSON.stringify(demoMcp)});
        Object.entries(${JSON.stringify(sizes)}).forEach(([key, bytes]) => send('mcpPathSize', { key, bytes }));
      } else if (message.command === 'checkMcp') {
        send('mcpStatus', ${JSON.stringify(demoMcp)});
        Object.entries(${JSON.stringify(sizes)}).forEach(([key, bytes]) => send('mcpPathSize', { key, bytes }));
      } else if (message.command === 'chatState') send('chatState', __chat);
      else if (message.command === 'subscriptionState') send('subscriptionState', ${JSON.stringify(demoSubscriptions)});
      else if (message.command === 'subscriptionRename') {
        const state = ${JSON.stringify(demoSubscriptions)};
        const subscription = state.subscriptions.find(item => item.id === message.id);
        if (subscription) subscription.alias = message.alias || '';
        send('subscriptionRenamed', { alias: message.alias || '' });
        send('subscriptionState', state);
      }
      else if (message.command === 'serverList') { send('serverList', ${JSON.stringify(demoServers)}); send('serverSubscriptionGroups', ${JSON.stringify(demoSubscribedServers)}); }
      else if (message.command === 'serverSubscriptionStatus') send('serverSubscriptionGroups', ${JSON.stringify(demoSubscribedServers)});
      else if (message.command === 'chatCopyInvite') {
        window.dispatchEvent(new CustomEvent('releaseInviteCopied', { detail: {
          invite: 'pkchat:v1:demo-release-invite',
          instruction: 'Call pkm.chat_join(magic_link="pkchat:v1:demo-release-invite", name="Docs Reviewer")'
        }}));
      }
      else if (message.command === 'chatSend') {
        const target = (message.recipients || []).find(name => name !== 'all') || 'Docs Reviewer';
        const hostMessage = { id: 'demo-' + (++__messageSequence), from: 'Release Host', kind: 'human', ts: Date.now(), text: message.text, recipients: message.recipients || [], replyPolicy: message.replyPolicy || 'required', mode: message.mode || 'ask', receipt: {read:1,total:1} };
        __chat.active.messages.push(hostMessage); send('chatMessage', { key: 'demo', message: hostMessage });
        __chat.active.agentStates[target] = 'thinking'; send('chatAgentState', { key: 'demo', user: target, state: 'thinking' });
        setTimeout(() => {
          const replies = {
            'Docs Reviewer': 'Documentation review complete. Installation steps and version guidance are clear.',
            'QA Agent': 'Regression pass complete. Recipient routing and standby wake behavior are verified.'
          };
          const reply = { id: 'demo-' + (++__messageSequence), from: target, kind: 'agent', ts: Date.now(), text: replies[target] || 'Task complete.', recipients: ['Release Host'], replyPolicy: 'none' };
          __chat.active.messages.push(reply); send('chatMessage', { key: 'demo', message: reply });
          __chat.active.agentStates[target] = 'standby'; send('chatAgentState', { key: 'demo', user: target, state: 'standby' });
        }, 900);
      }
      else if (message.command === 'list') {
        if (message.tab === 'papers') send('list', ${JSON.stringify(demoPapers)});
        else if (message.tab === 'packages') window.dispatchEvent(new MessageEvent('message', { data: { command: 'list', data: ${JSON.stringify(demoLocalPackages)}, subscriptionGroups: ${JSON.stringify(demoSubscribedPackages)} } }));
        else send('list', []);
      }
      else if (message.command === 'paperFacets') send('paperFacets', { topics: [{name:'Retrieval',count:2},{name:'Agents',count:2},{name:'Memory',count:1},{name:'Evaluation',count:1}], tags: [], years: [] });
      else if (message.command === 'paperGroups') send('paperGroups', [{name:'Demo Papers',count:6}]);
      else if (message.command === 'paperGraph') send('paperGraph', ${JSON.stringify(demoGraph)});
      else if (message.command === 'generateMcp') send('mcpGenerated', { preview: true, configSnippet: ${JSON.stringify(demoMcp.combinedRegistry)} });
    }, 0),
  });
  </script>`;
}

function panelHtml(view) {
  let html = fs.readFileSync(path.join(webview, "panel.html"), "utf8");
  const localeManifest = JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", "manifest.json"), "utf8"));
  const catalogs = Object.fromEntries(localeManifest.locales.map(locale => [locale.id, JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", `${locale.id}.json`), "utf8"))]));
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const replacements = {
    "%%NOTES_BASE%%": "/demo/notes", "%%HLJS_CSS%%": "/hljs.css", "%%KATEX_CSS%%": "/katex.css",
    "%%MARKED_SRC%%": "/marked.umd.js", "%%HLJS_SRC%%": "/hljs.js", "%%KATEX_SRC%%": "/katex.js",
    "%%CYTOSCAPE_SRC%%": "/cytoscape.js", "%%MERMAID_SRC%%": "/mermaid.js", "%%FORCEGRAPH3D_SRC%%": "/forcegraph3d.js",
    "%%PANEL_CSS%%": "/panel.css", "%%PANEL_JS%%": "/panel.js", "%%PKM_VERSION%%": "2.6.0",
    "%%I18N_PAYLOAD_B64%%": Buffer.from(JSON.stringify({ setting: "en", resolved: "en", locales: localeManifest.locales, catalogs }), "utf8").toString("base64"),
  };
  for (const [token, value] of Object.entries(replacements)) html = html.split(token).join(value);
  return html.replace("</head>", `${bootstrap(view)}</head>`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(panelHtml(url.searchParams.get("view") || "config"));
    return;
  }
  if (url.pathname === "/config" || url.pathname === "/chat" || url.pathname === "/papers" || url.pathname === "/subscriptions") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(panelHtml(url.pathname.slice(1)));
    return;
  }
  const file = path.join(webview, path.basename(url.pathname));
  if (!file.startsWith(webview) || !fs.existsSync(file)) { response.statusCode = 404; response.end("Not found"); return; }
  const ext = path.extname(file);
  response.setHeader("Content-Type", ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream");
  fs.createReadStream(file).pipe(response);
});
server.listen(port, "127.0.0.1", () => console.log(`Release preview: http://127.0.0.1:${port}/?view=config`));
