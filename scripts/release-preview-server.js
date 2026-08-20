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
  installedVersion: "2.5.1",
  expectedVersion: "2.5.1",
  knowledgeVersion: "1.0.0",
  chatVersion: "2.3.0",
  installedKnowledgeVersion: "1.0.0",
  installedChatVersion: "2.3.0",
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
      { id: "d1", from: "Release Host", kind: "human", ts: 1787010000000, text: '@"Docs Reviewer" @"QA Agent" Please review the 2.5.1 release notes and regression matrix.', recipients: ["Docs Reviewer", "QA Agent"], replyPolicy: "required", mode: "ask", receipt: { read: 2, total: 2 } },
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

function bootstrap(view) {
  const sizes = { store: 18874368, environments: 1702887424, runtime: 247463936, python: 6832128, serverDirectory: 315392 };
  return `<style id="release-theme">
  :root{--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-panel-border:#343434;--vscode-focusBorder:#0078d4;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;--vscode-textCodeBlock-background:#181818;--vscode-font-family:"Segoe UI",sans-serif;--vscode-editor-font-family:"Cascadia Code",Consolas,monospace;--vscode-font-size:13px}
  </style><script>
  const __state = { tab: ${JSON.stringify(view === "chat" ? "chatroom" : view === "papers" ? "papers" : "mcp")} };
  const __chat = ${JSON.stringify(demoChat)};
  let __messageSequence = 10;
  window.acquireVsCodeApi = () => ({
    getState: () => __state,
    setState: value => Object.assign(__state, value || {}),
    postMessage: message => setTimeout(() => {
      const send = (command, data) => window.dispatchEvent(new MessageEvent('message', { data: { command, data } }));
      if (message.command === 'ready') {
        window.dispatchEvent(new MessageEvent('message', { data: { command: 'openTab', tab: __state.tab } }));
        send('mcpStatus', ${JSON.stringify(demoMcp)});
        Object.entries(${JSON.stringify(sizes)}).forEach(([key, bytes]) => send('mcpPathSize', { key, bytes }));
      } else if (message.command === 'checkMcp') {
        send('mcpStatus', ${JSON.stringify(demoMcp)});
        Object.entries(${JSON.stringify(sizes)}).forEach(([key, bytes]) => send('mcpPathSize', { key, bytes }));
      } else if (message.command === 'chatState') send('chatState', __chat);
      else if (message.command === 'serverList') send('serverList', ${JSON.stringify(demoServers)});
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
      else if (message.command === 'list') send('list', message.tab === 'papers' ? ${JSON.stringify(demoPapers)} : []);
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
    "%%PANEL_CSS%%": "/panel.css", "%%PANEL_JS%%": "/panel.js", "%%PKM_VERSION%%": "2.5.1",
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
  if (url.pathname === "/config" || url.pathname === "/chat" || url.pathname === "/papers") {
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
