const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const store = require("../dist/knowledge/filestore");
const { ProjectStore } = require("../dist/workflows/project-store");
const { createNoteTodoTools } = require("../dist/chat/note-todo-tools");
const { browserNoteTodo } = require("../dist/ui/note-todo-browser");
const { manageBrowserTodo } = require("../dist/ui/note-todo-management");
const { startLiveMarkdownServer } = require("../dist/knowledge/live-note-server");
const { projectWorkItemProgress, inspectWorkItem } = require("../dist/knowledge/work-item-progress");
const { ApiChatStore, apiChatGroupSnapshots, apiChatSessionHarnessSnapshot } = require("../dist/chat/api-chat-store");
const { createAgentSnapshot, listAgentSnapshots, readAgentSnapshotContents } = require("../dist/agent-sessions/agent-snapshots");
const { ChatMemoryService, chatMemoryScope } = require("../dist/memory/chat-memory-service");
const { projectCockpits } = require("../dist/workflows/project-cockpit");
const vm = require("node:vm");
const ts = require("typescript");
const {
  GITHUB_SYNC_CONTENT_TYPES, GitHubSyncConflictError, normalizeGitHubSyncTarget, syncGitHubTarget,
} = require("../dist/sync/github-sync");

const extension = path.resolve(__dirname, "..");
const user = { id: "user:local", role: "user" };
const signal = new AbortController().signal;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const task = id => ({ id, title: id, goal: "Keep one authoritative project record", scope: "Isolated end-to-end project",
  acceptance: ["Prose, identity, evidence and audit survive all operations"], state: "Planning", evidence: [] });

async function mcp(root) {
  const client = new Client({ name: "note-tracking-e2e", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.env.PKM_PYTHON || "python",
    args: [path.join(extension, "resources/knowledge_mutations.py"), "--root", root,
      "--node", process.execPath, "--extension-root", extension],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", bytes => { stderr += bytes; });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw new Error(`MCP startup failed: ${error.message}\n${stderr}`); }
  return {
    close: () => client.close(),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(result.content.map(part => part.text || "").join("\n"));
      return result.structuredContent || JSON.parse(result.content[0].text);
    },
  };
}

test("Project tracking crosses actual MCP stdio, native Chat, browser, restart, Trash and two-machine Git Sync", { timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-tracking-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "machine-a"), b = path.join(root, "machine-b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  store.setStorePath(a);
  const projects = new ProjectStore(path.join(a, ".pkm/state"));
  const commandId = randomUUID();
  const projectId = projects.createProject({ commandId, fingerprint: commandId,
    expectedStoreVersion: projects.list().storeVersion }, "Tracking reliability E2E",
  { goal: "Deliver a project without losing concurrent work", successCriteria: ["Verified persisted evidence"] }).entityId;
  const slug = "Validation/Project tracker";
  const prose = "# Project tracking\n\nManual project context must remain byte-for-byte.\n\n~~~~json\n{\"unknown\":\"preserved\"}\n~~~~\n";
  store.noteUpsert({ slug, category: "Validation", title: "Project tracker", content: prose, type: "todo", tags: [] });
  const api = await mcp(a), second = await mcp(a);
  t.after(() => api.close()); t.after(() => second.close());
  const tools = createNoteTodoTools({ actorId: "chat:e2e-worker", assertActive() {}, approve: async () => true });
  const read = () => api.call("note_work_items", { slug });
  const write = async command => {
    const snapshot = await read();
    return api.call("note_work_item_command", { slug, expected_digest: snapshot.digest, command });
  };
  await write({ action: "create", item: task("delivery") });
  // This is a controlled user fixture, not an external worker impersonating a reviewer.
  let snapshot = await read();
  store.noteWorkItemCommand(slug, snapshot.digest, { action: "edit",
    item: { ...snapshot.items[0], projectId }, reason: "User associates work with the persisted Project" }, user);
  await t.test("two independent MCP processes reject the losing write, then preserve explicit reconciliation", async () => {
    const before = await read();
    const replies = await Promise.allSettled([api, second].map((client, index) =>
      client.call("note_work_item_command", { slug, expected_digest: before.digest,
        command: { action: "comment", id: "delivery", text: `Window ${index + 1}` } })));
    assert.equal(replies.filter(reply => reply.status === "fulfilled").length, 1);
    assert.match(replies.find(reply => reply.status === "rejected").reason.message, /changed|digest|conflict/i);
    const winner = await read();
    assert.equal(winner.items[0].comments.length, 1);
    await write({ action: "comment", id: "delivery", text: "Reconciled after reading the winner" });
    const current = await read();
    assert.equal(current.items[0].comments.length, 2);
    assert.equal(current.items[0].projectId, projectId);
    assert.equal(new ProjectStore(path.join(a, ".pkm/state")).list().projects.find(p => p.projectId === projectId).name, "Tracking reliability E2E");
  });
  await t.test("native Chat claims and submits the same MCP record; protected contracts and acceptance stay separate", async () => {
    const current = JSON.parse(await tools[0].execute({ slug }, signal));
    const claimed = JSON.parse(await tools[1].execute({ slug, expectedDigest: current.digest,
      command: { action: "claim", id: "delivery" } }, signal));
    assert.equal((await read()).items[0].ownerId, "chat:e2e-worker");
    await assert.rejects(api.call("note_work_item_command", { slug, expected_digest: claimed.digest,
      command: { action: "transition", id: "delivery", state: "Done", outcome: "Success", evidence: ["not my work"] } }), /own|owner|claim/i);
    await assert.rejects(tools[1].execute({ slug, expectedDigest: claimed.digest, command: { action: "edit",
      item: { ...claimed.items[0], acceptance: ["Weaker condition"] } } }, signal), /contract|protect|acceptance/i);
    const done = JSON.parse(await tools[1].execute({ slug, expectedDigest: claimed.digest,
      command: { action: "transition", id: "delivery", state: "Done", outcome: "Unsure",
        evidence: ["test://tracking-e2e/needs-review"], reason: "A measured unknown is not Success" } }, signal));
    assert.equal(done.items[0].outcome, "Unsure");
    assert.equal(done.items[0].acceptanceDecision, undefined);
    await assert.rejects(tools[1].execute({ slug, expectedDigest: done.digest,
      command: { action: "accept", id: "delivery", reason: "Self approval" } }, signal), /user|reviewer|delegat/i);
    assert.equal((await read()).digest, done.digest);
    assert(store.noteGet(slug).content.startsWith(prose));
    assert(done.items[0].history.some(event => event.actorId === "chat:e2e-worker"));
  });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const errors = [];
  const server = await startLiveMarkdownServer([], documentPath => {
    if (documentPath !== `notes/${slug}` || !store.noteGet(slug)) return undefined;
    return browserNoteTodo("<p>Manual project context</p>", store.noteGet(slug).content, slug, "Project tracker", extension);
  }, {});
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  const url = `${server.localBaseUrl}/notes/${slug.split("/").map(encodeURIComponent).join("/")}.html`;
  await t.test("built Cockpit and Gantt inspect actual Project/MCP contracts, scoped Memory and historical Snapshots without mutation", async sub => {
    const state = path.join(a, ".pkm/state"), assets = path.join(extension, "dist/webview");
    const chats = new ApiChatStore(state, "0123456789abcdef");
    const agent = chats.create(), unrelated = chats.create();
    chats.startTask(agent, "Progress E2E Agent");
    const historical = createAgentSnapshot(a, agent.sessionId, "Progress fixture").snapshot;
    const memory = new ChatMemoryService({ extensionRoot: extension, python: process.env.PKM_PYTHON || "python",
      database: path.join(state, "progress-memory.sqlite3"), identity: "progress-e2e" });
    sub.after(() => memory.close());
    const scope = chatMemoryScope(agent.workspaceNamespace, agent.id);
    const memoryRun = async request => ({ text: request.purpose === "intent"
      ? JSON.stringify({ focus: ["new:1"], new: [{ key: "new:1", label: "Progress experience" }] })
      : request.purpose === "extract" ? JSON.stringify({ statements: [{ topic: "T1", text: "Read a digest before comparing records.", status: "proposal" }] })
      : "Progress experience summary." });
    const input = { id: "progress-input", text: "Inspect progress without executing work." };
    await memory.prepare(scope, "progress-turn", input, [], 10000, memoryRun, signal);
    await memory.commit(scope, "progress-turn", input, { id: "progress-answer", text: "Read a digest before comparing records." }, memoryRun, signal);
    assert((await memory.inspect(scope)).pieces.length > 0);
    assert.equal((await memory.inspect(chatMemoryScope(unrelated.workspaceNamespace, unrelated.id))).pieces.length, 0);
    const progressSlug = "Validation/Progress";
    store.noteUpsert({ slug: progressSlug, title: "Progress", category: "Validation", type: "todo", tags: [], content: "Project progress fixture" });
    for (const item of [ { ...task("progress-story"), kind: "UserStory", storyStatus: "draft" },
      { ...task("progress-dependency"), title: "Dependency outside this Project" },
      { ...task("progress-work"), title: "Inspect progress contract", parentId: "progress-story", projectId, dependsOn: ["progress-dependency"],
        links: ["pkm://notes/Validation/Project%20tracker.md"] } ]) {
      store.noteWorkItemCommand(progressSlug, store.noteWorkItemsRead(progressSlug).digest, { action: "create", item }, user);
    }
    const agentTools = createNoteTodoTools({ actorId: `chat:${agent.id}`, assertActive() {}, approve: async () => true });
    const beforeClaim = await api.call("note_work_items", { slug: progressSlug });
    await agentTools[1].execute({ slug: progressSlug, expectedDigest: beforeClaim.digest,
      command: { action: "claim", id: "progress-work" } }, signal);
    const panel = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    sub.after(() => panel.close());
    panel.on("pageerror", error => errors.push(error.message));
    const messages = [], harnessReads = [];
    const nativeSnapshot = () => {
      const session = JSON.parse(fs.readFileSync(path.join(state, "agent-sessions", `${agent.sessionId}.json`), "utf8"));
      return { ...session, harness: apiChatSessionHarnessSnapshot(session, agent.sessionId, state), runs: [], memoryStoreReader: true };
    };
    const snapshot = () => {
      const current = projects.list();
      return { ...current, cockpits: projectCockpits(a, current.projects, current.collaborationTasks), agentSessions: [], agentSnapshots: [] };
    };
    const hostSource = fs.readFileSync(path.join(extension, "src/extension.ts"), "utf8");
    const start = hostSource.indexOf('    case "noteTodoRead":'), end = hostSource.indexOf('    case "detail":', start);
    const context = {
      path, getStorePath: () => a, projectWorkItemProgress, inspectWorkItem, apiChatGroupSnapshots, listAgentSnapshots, readAgentSnapshotContents,
      currentProjectStore: () => projects, respond: reply => send(reply),
      vscode: { workspace: { isTrusted: true }, commands: { executeCommand: async (command, chatId, method) => {
        assert.equal(command, "personalKnowledge.readChatHarness"); assert.equal(chatId, agent.id); assert.equal(method, "snapshot");
        chats.assertAvailable(chats.load(chatId, false));harnessReads.push({ chatId, method });
        return nativeSnapshot();
      } } },
    };
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(`async function dispatch(msg){switch(msg.command){${hostSource.slice(start,end)}}}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
    const send = reply => panel.evaluate(reply => window.dispatchEvent(new MessageEvent("message", { data: reply })), reply);
    await panel.exposeFunction("hostMessage", async msg => {
      messages.push(msg);
      if (msg.command === "ready") { await send({ command: "loadingProgress", data: { stage: "ready" } }); return send({ command: "openTab", tab: "projects" }); }
      if (msg.command === "projectState") return send({ command: "projectState", data: snapshot() });
      if (["noteTodoProject","noteTodoInspect","noteTodoAgent"].includes(msg.command)) return context.dispatch(msg);
      if (msg.command === "nativeHarness") {
        assert.equal(msg.params.chatId, agent.id, "Harness never reads by display name, another owner or project-wide union");
        harnessReads.push({ chatId: msg.params.chatId, method: msg.method });
        let data;
        if (msg.method === "snapshot") data = nativeSnapshot();
        else if (msg.method === "memoryOverview") data = await memory.inspect(scope);
        else if (msg.method === "profiles") data = { scope: "Isolated fixture", agentAssigned: false };
        else throw Error(`Unexpected read ${msg.method}`);
        return send({ command: "nativeHarnessResult", requestId: msg.requestId, data });
      }
    });
    await panel.addInitScript(() => {
      let state = { tab: "projects" };
      window.acquireVsCodeApi = () => ({ getState: () => state, setState: next => { state = next; }, postMessage: value => window.hostMessage(value) });
    });
    await panel.route("http://progress.test/**", route => {
      const filename = path.basename(new URL(route.request().url()).pathname);
      if (filename === "index.html") {
        let html = fs.readFileSync(path.join(assets, "panel.html"), "utf8").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
        for (const [token,file] of Object.entries({ PANEL_JS: "panel.js", PANEL_CSS: "panel.css", CODICON_CSS: "codicon.css", HOST_HEALTH_JS: "host-health.js", HOST_HEALTH_CSS: "host-health.css",
          AGENT_HARNESS_JS: "agent-harness.js", AGENT_HARNESS_CSS: "agent-harness.css" })) html = html.replaceAll(`%%${token}%%`, file);
        return route.fulfill({ contentType: "text/html", body: html.replace(/%%[A-Z_]+%%/g, "") });
      }
      return fs.existsSync(path.join(assets, filename)) ? route.fulfill({ path: path.join(assets, filename) }) : route.fulfill({ status: 404, body: "" });
    });
    const before = store.noteWorkItemsRead(progressSlug);
    const projectVersion = projects.list().storeVersion;
    await panel.goto("http://progress.test/index.html");
    await send({ command: "projectState", data: snapshot() });
    await send({ command: "openProject", projectId });
    await panel.getByRole("heading", { name: "Review inbox", exact: true }).waitFor();
    await panel.evaluate(() => projectSection("Overview"));
    await panel.getByRole("button", { name: "Load / refresh progress" }).click();
    await panel.locator(".note-todo-progress-counts").waitFor();
    assert.match(await panel.locator("#project-note-todos").innerText(), /unmeasured|unverified/);
    assert.equal(await panel.locator("#project-note-todos details[open]").count(), 0, "progress stays compact by default");
    await panel.getByText(/^Responsibilities, remaining work & user intervention/).click();
    await panel.getByRole("button", { name: "Inspect progress contract", exact: true }).click();
    const inspector = panel.locator("#note-todo-inspector");
    await inspector.getByRole("heading", { name: "Inspect progress contract" }).waitFor();
    assert.match(await inspector.innerText(), /no heartbeat|unverified/i);
    await inspector.getByRole("button", { name: "Dependency outside this Project" }).click();
    await inspector.getByRole("heading", { name: "Dependency outside this Project" }).waitFor();
    await inspector.getByRole("button", { name: "Close inspection" }).click();
    await panel.getByRole("button", { name: "Inspect progress contract", exact: true }).click();
    await inspector.getByRole("button", { name: "View Agent Todo / Memory / Snapshot / execution" }).click();
    await inspector.locator("#note-todo-agent-harness .pkm-harness").waitFor();
    await panel.waitForFunction(() => document.querySelector("#note-todo-agent-harness")?.textContent.includes("Memory"));
    await inspector.getByText(/^Historical Snapshots/).click();
    await inspector.locator("[data-inspect-snapshot]").click();
    await inspector.locator("pre").filter({ hasText: historical.snapshotId }).waitFor();
    assert.match(await inspector.innerText(), /not live state|not proof/);
    assert.equal(listAgentSnapshots(a)[0].recoveryCount, historical.recoveryCount, "viewing does not restore");
    await inspector.getByRole("button", { name: "Close inspection" }).click();
    await panel.evaluate(() => projectSection("Gantt"));
    await panel.getByRole("button", { name: "Load / refresh progress" }).click();
    await panel.locator(".note-todo-progress-counts").waitFor();
    await panel.getByText(/^Recorded state timeline/).click();
    await panel.locator(".note-todo-timeline-row").filter({ hasText: "Inspect progress contract" }).getByRole("button", { name: "progress-story", exact: true }).click();
    await inspector.getByRole("heading", { name: "progress-story" }).waitFor();
    await inspector.getByRole("button", { name: "Close inspection" }).click();
    const savedReference = projectWorkItemProgress(projectId).records.find(record => record.item.id === "progress-work");
    await panel.evaluate(record => {
      noteTodoInspectionRequestSend(noteTodoReference(record));
      window.savedInspectionRequest = noteTodoInspectionRequest;
      noteTodoInspectionRequestSend(noteTodoReference(record,"progress-dependency"));
    }, savedReference);
    await inspector.getByRole("heading", { name: "Dependency outside this Project" }).waitFor();
    await panel.evaluate(() => noteTodoInspectionResult({ requestId: window.savedInspectionRequest, error: "Obsolete wrong response" }));
    assert.doesNotMatch(await inspector.innerText(), /Obsolete/);
    await inspector.getByRole("button", { name: "Close inspection" }).click();
    const sourceFile = path.join(a, "notes", `${progressSlug}.md`);
    const original = fs.readFileSync(sourceFile, "utf8");
    fs.appendFileSync(sourceFile, "\nConcurrent source revision\n");
    await panel.locator(".note-todo-timeline-row").filter({ hasText: "Inspect progress contract" }).getByRole("button", { name: "Inspect progress contract", exact: true }).click();
    await inspector.getByRole("alert").filter({ hasText: "Source changed" }).waitFor();
    assert.equal(store.noteWorkItemsRead(progressSlug).items.find(item=>item.id==="progress-work").ownerId, `chat:${agent.id}`);
    assert.deepEqual(store.noteWorkItemsRead(progressSlug).items, before.items, "progress, Memory and Snapshot inspection never mutate Work Items");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), original + "\nConcurrent source revision\n");
    assert.equal(projects.list().storeVersion, projectVersion);
    assert(harnessReads.some(read => read.method === "memoryOverview"), "the UI inspected real scoped Memory, not just its section label");
    assert(harnessReads.every(read => read.chatId === agent.id));
    assert.equal(messages.filter(message => /create|claim|transition|accept|restore|recover|send|run/i.test(message.command)).length, 0);
    assert.equal((await api.call("note_work_items", { slug: progressSlug })).items.find(item=>item.id==="progress-work").state, "WIP");
    await panel.close();
  });
  await t.test("served browser displays exact MCP result, distinct outcomes, reopening and durable evidence", async () => {
    await page.goto(`${url}#todo-board`);
    await page.waitForLoadState("networkidle");
    assert.match(await page.locator('[data-todo-card-id=delivery]').innerText(), /Unsure/);
    assert.equal(await page.locator('[data-todo-card-id=delivery]').getAttribute("draggable"), null);
    assert.equal(await page.locator("[data-todo-action]").count(), 0);
    const before = await read();
    const reopened = store.noteWorkItemCommand(slug, before.digest,
      { action: "reopen", id: "delivery", reason: "User requests another verification attempt" }, user);
    assert.deepEqual(reopened.items[0].evidence, before.items[0].evidence);
    assert.equal(reopened.items[0].projectId, projectId);
    await page.reload(); await page.waitForLoadState("networkidle");
    assert.equal(await page.locator('.note-todo-swimcell[data-state=Planning] [data-todo-card-id=delivery]').count(), 1);
    await page.locator('[data-todo-open=delivery]').dblclick();
    assert.match(await page.getByRole("dialog").innerText(), /needs-review/);
    await page.getByRole("button", { name: "Close Work Item details" }).click();
    for (const [id, outcome] of [["failed", "Failed"], ["success", "Success"]]) {
      await write({ action: "create", item: task(id) });
      await write({ action: "claim", id });
      await write({ action: "transition", id, state: "Done", outcome, evidence: [`test://tracking-e2e/${id}`] });
    }
    await page.reload(); await page.waitForLoadState("networkidle");
    assert.match(await page.locator(".note-todo-toolbar").innerText(), /2 closed.*1 reported Success.*0 accepted/);
    assert.equal(await page.locator('.note-todo-swimcell[data-state=Done] .note-todo-card').count(), 2);
    await page.locator("#note-todo-show-done").uncheck();
    assert.equal(await page.locator('[data-todo-card-id=delivery]').count(), 1);
    assert.equal(await page.locator('[data-todo-card-id=failed]').count(), 0);
  });
  await t.test("MCP restart, reviewed Trash, asset restore and stale digest preserve the whole project record", async () => {
    const before = await read(), markdown = fs.readFileSync(path.join(a, "notes", `${slug}.md`));
    const assets = path.join(a, "notes/Validation/Project tracker.assets");
    fs.mkdirSync(assets); fs.writeFileSync(path.join(assets, "evidence.txt"), "Measured result");
    await assert.rejects(api.call("knowledge_file_trash", { area: "notes", path: `${slug}.md`, expected_sha256: "0".repeat(64) }), /changed|match|digest/i);
    assert.equal((await read()).digest, before.digest);
    const trashed = await api.call("knowledge_file_trash", { area: "notes", path: `${slug}.md`, expected_sha256: sha(markdown) });
    await assert.rejects(read(), /ENOENT|missing|not found/i);
    await page.reload(); assert.equal((await page.request.get(url)).status(), 404);
    const trash = store.knowledgeTrashList("notes").find(entry => entry.id === trashed.trash.id);
    assert(trash, JSON.stringify(trashed));
    assert.equal(store.knowledgeTrashRestore("notes", trash.id).ok, true);
    assert.deepEqual(fs.readFileSync(path.join(a, "notes", `${slug}.md`)), markdown);
    assert.equal(fs.readFileSync(path.join(assets, "evidence.txt"), "utf8"), "Measured result");
    const restarted = await mcp(a);
    try { assert.deepEqual((await restarted.call("note_work_items", { slug })).items, before.items); }
    finally { await restarted.close(); }
    assert.equal(store.knowledgeSyncDeletionRecords(a).length, 0, "restore clears durable deletion intent");
    await page.reload(); await page.waitForLoadState("networkidle");
    assert.equal(await page.locator('[data-todo-card-id=delivery]').count(), 1);
  });
  await t.test("real local Git remote transfers complete Work Items and rejects divergent two-machine updates", async () => {
    const remote = path.join(root, "remote.git"), seed = path.join(root, "seed"), checkout = path.join(root, "checkouts");
    fs.mkdirSync(seed); git(root, "init", "--bare", remote); git(seed, "init");
    git(seed, "config", "user.name", "PKM E2E"); git(seed, "config", "user.email", "pkm-e2e@example.invalid");
    fs.writeFileSync(path.join(seed, "README.md"), "Isolated PKM validation remote\n");
    git(seed, "add", "README.md"); git(seed, "commit", "-m", "Seed isolated validation");
    git(seed, "branch", "-M", "main"); git(seed, "remote", "add", "origin", remote); git(seed, "push", "-u", "origin", "main");
    git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const target = suffix => normalizeGitHubSyncTarget({ name: suffix, repository: remote, branch: "tracking" }, () => suffix);
    const ta = target("machine-a"), tb = target("machine-b");
    const catalog = machine => {
      const result = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
      const source = path.join(machine, "notes", `${slug}.md`);
      if (fs.existsSync(source)) result.notes.push({ id: store.noteGet(slug).knowledgeId, label: "Project tracker",
        cat: "Validation", isPrivate: false, source, destination: `notes/${slug}.md` });
      return result;
    };
    const sync = async (target, machine) => {
      const result = await syncGitHubTarget(target, catalog(machine), checkout, undefined, machine);
      target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints };
      return result;
    };
    const before = await read();
    await sync(ta, a);
    const pulled = await sync(tb, b);
    assert(pulled.pulled.includes(`notes/${slug}.md`));
    const remoteApi = await mcp(b);
    try {
      assert.deepEqual((await remoteApi.call("note_work_items", { slug })).items, before.items);
      await write({ action: "comment", id: "delivery", text: "Machine A change" });
      const remoteBefore = await remoteApi.call("note_work_items", { slug });
      await remoteApi.call("note_work_item_command", { slug, expected_digest: remoteBefore.digest,
        command: { action: "comment", id: "delivery", text: "Machine B independent change" } });
      const remoteChanged = await remoteApi.call("note_work_items", { slug });
      await sync(ta, a);
      const bytes = fs.readFileSync(path.join(b, "notes", `${slug}.md`));
      await assert.rejects(sync(tb, b), error => error instanceof GitHubSyncConflictError && error.conflicts.some(c => c.path === `notes/${slug}.md`));
      assert.deepEqual(fs.readFileSync(path.join(b, "notes", `${slug}.md`)), bytes, "Sync must not overwrite either divergent Work Item history");
      assert.equal((await remoteApi.call("note_work_items", { slug })).digest, remoteChanged.digest);
      assert((await read()).items[0].comments.some(comment => comment.text === "Machine A change"));
      assert(remoteChanged.items[0].comments.some(comment => comment.text === "Machine B independent change"));
      assert.equal(remoteChanged.items[0].projectId, projectId);
    } finally { await remoteApi.close(); }
  });
  assert.deepEqual(errors, []);
});

test("authenticated browser manages a persisted Project Board while public access and stale second windows cannot write", { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-tracking-browser-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.setStorePath(root);
  const projects = new ProjectStore(path.join(root, ".pkm/state"));
  const commandId = randomUUID();
  const projectId = projects.createProject({ commandId, fingerprint: commandId,
    expectedStoreVersion: projects.list().storeVersion }, "Browser delivery").entityId;
  store.todoBoardCreate("Delivery", "Delivery");
  const token = randomUUID();
  const makeServer = managed => startLiveMarkdownServer([], documentPath => documentPath === "notes/Delivery"
    ? browserNoteTodo("", "", "Delivery", "Delivery", extension, store.noteWorkItemsRead("Delivery"), true, managed) : undefined, {},
  managed ? { accessToken: token, manageTodo: (documentPath, message) => manageBrowserTodo(documentPath, message, true, projects.list().projects) } : {});
  const privateServer = await makeServer(true), publicServer = await makeServer(false);
  for (const server of [privateServer, publicServer]) t.after(() => new Promise(resolve => server.server.close(resolve)));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage(), other = await context.newPage();
  const url = `${privateServer.localBaseUrl}/notes/Delivery.html?_pkm_token=${token}`;
  await page.goto(url); await page.waitForFunction(() => !noteTodo.pending);
  await other.goto(url); await other.waitForFunction(() => !noteTodo.pending);
  await page.locator("[data-todo-new-story]").click();
  const form = page.locator("#note-todo-editor");
  for (const [field, value] of Object.entries({ title: "Complete a Project Story", goal: "Keep one authoritative delivery record",
    scope: "Browser, MCP and persisted Project", acceptance: "Child completion is independently reviewed before Story acceptance" })) {
    await form.locator(`[name=${field}]`).fill(value);
  }
  await form.getByRole("button", { name: "Save Work Item" }).click();
  await page.waitForFunction(() => !noteTodo.pending && !noteTodo.editor);
  const storyId = store.noteWorkItemsRead("Delivery").items.find(item => item.kind === "UserStory").id;
  await page.locator("[data-todo-new]").click();
  await form.locator("[name=title]").fill("Browser-created delivery");
  await form.locator("[name=goal]").fill("Keep a real Project association");
  await form.locator("[name=scope]").fill("Project Board");
  await form.locator("[name=acceptance]").fill("MCP observes exactly the user-created work");
  await form.locator("[name=projectId]").selectOption(projectId);
  await form.locator("[name=parentId]").selectOption(storyId);
  await form.locator("[name=icon]").selectOption("eye");
  await form.locator("[name=description]").fill("Observed evidence <script>must stay text</script>");
  await form.locator("[name=links]").fill(`pkm://projects/${projectId}\npkm://actions/action_fixture\npkm://recipes/recipe_fixture`);
  await form.getByText("Collaboration contract · no extra permissions",{exact:true}).click();
  await form.locator("[name=collaboratorIds]").fill("external:claude:collaborator");
  await form.getByText("Continuous monitoring · optional bounded contract",{exact:true}).click();
  await form.locator("[name=monitoring]").check();
  await form.getByRole("button", { name: "Save Work Item" }).click();
  await page.waitForFunction(() => !noteTodo.pending && !!noteTodo.error);
  assert.match(await page.getByRole("alert").innerText(),/Monitoring requires/);
  assert.equal(store.noteWorkItemsRead("Delivery").items.length,1,"unbounded monitoring never persists");
  await form.locator("[name=monitorEndCondition]").fill("Record one observation and explicitly report the result");
  await form.getByRole("button", { name: "Save Work Item" }).click();
  await page.waitForFunction(() => !noteTodo.pending && !noteTodo.editor);
  const api = await mcp(root); t.after(() => api.close());
  const current = await api.call("note_work_items", { slug: "Delivery" });
  assert.equal(current.items.length, 2);
  const item = current.items.find(item => item.kind !== "UserStory");
  assert.equal(item.projectId, projectId);
  assert.equal(item.parentId, storyId);
  assert.equal(item.icon,"eye");
  assert.equal(item.description,"Observed evidence <script>must stay text</script>");
  assert.deepEqual(item.collaboratorIds,["external:claude:collaborator"]);
  assert.equal(item.monitoring.endCondition,"Record one observation and explicitly report the result");
  const id = item.id;
  await page.locator("[data-todo-expand-all]").click();
  await other.locator("[data-todo-new]").click();
  const draft = other.locator("#note-todo-editor");
  for (const field of ["title", "goal", "scope", "acceptance"]) await draft.locator(`[name=${field}]`).fill("Retain my stale draft");
  await draft.getByRole("button", { name: "Save Work Item" }).click();
  await other.waitForFunction(() => !noteTodo.pending && !!noteTodo.error);
  assert.match(await other.getByRole("dialog").innerText(), /changed|reload|conflict/i);
  assert.equal(await draft.locator("[name=title]").inputValue(), "Retain my stale draft");
  assert.equal((await api.call("note_work_items", { slug: "Delivery" })).digest, current.digest);
  await api.call("note_work_item_command", { slug: "Delivery", expected_digest: current.digest,
    command: { action: "claim", id } });
  const claimed = await api.call("note_work_items", { slug: "Delivery" });
  await api.call("note_work_item_command", { slug: "Delivery", expected_digest: claimed.digest,
    command: { action: "transition", id, state: "Done", outcome: "Success", evidence: ["test://browser-e2e/delivery"] } });
  await page.locator("[data-todo-refresh]").click(); await page.waitForFunction(() => !noteTodo.pending);
  const completed = await api.call("note_work_items", { slug: "Delivery" });
  await api.call("note_work_item_command", { slug: "Delivery", expected_digest: completed.digest,
    command: { action: "claim", id: storyId } });
  const storyClaimed = await api.call("note_work_items", { slug: "Delivery" });
  await assert.rejects(api.call("change_userstory_state", { board_slug: "Delivery", expected_digest: storyClaimed.digest,
    id: storyId, state: "completed", outcome: "Success", evidence: ["test://browser-e2e/story"] }), /accept/i);
  await page.locator("[data-todo-refresh]").click(); await page.waitForFunction(() => !noteTodo.pending);
  await page.locator(`[data-todo-open="${id}"]`).dblclick();
  assert.equal(await page.getByRole("dialog").locator("script").count(),0,"description is escaped, never executed");
  assert.match(await page.getByRole("dialog").innerText(),/Recorded attempts/);
  page.once("dialog", dialog => dialog.accept("User independently reviewed actual persisted evidence"));
  await page.getByRole("dialog").locator('[data-todo-action=accept]').click();
  await page.waitForFunction(() => !noteTodo.pending);
  assert.equal(await page.evaluate(() => noteTodo.error), "");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const accepted = await api.call("note_work_items", { slug: "Delivery" });
  assert.equal(accepted.items.find(item => item.id === id).acceptanceDecision.by, "user:local", "only the explicit user UI action accepts");
  await api.call("change_userstory_state", { board_slug: "Delivery", expected_digest: accepted.digest,
    id: storyId, state: "completed", outcome: "Success", evidence: ["test://browser-e2e/verified-story"] });
  await page.locator("[data-todo-refresh]").click(); await page.waitForFunction(() => !noteTodo.pending);
  await page.locator(`[data-todo-open="${storyId}"]`).dblclick();
  page.once("dialog", dialog => dialog.accept("User independently accepts the whole Story"));
  await page.getByRole("dialog").locator('[data-todo-action=accept]').click();
  await page.waitForFunction(() => !noteTodo.pending);
  assert.equal(await page.evaluate(() => noteTodo.error), "");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const storyAccepted = await api.call("note_work_items", { slug: "Delivery" });
  assert.equal(storyAccepted.items.find(item => item.id === storyId).acceptanceDecision.by, "user:local");
  await page.locator(`[data-todo-open="${id}"]`).dblclick();
  page.once("dialog", dialog => dialog.accept("User requests another iteration"));
  await page.getByRole("dialog").locator('[data-todo-action=reopen]').click();
  await page.waitForFunction(() => !noteTodo.pending);
  assert.match(await page.evaluate(() => noteTodo.error), /Reopen the parent User Story/);
  assert.equal((await api.call("note_work_items", { slug: "Delivery" })).digest, storyAccepted.digest);
  await page.getByRole("button", { name: "Close Work Item details" }).click();
  await page.locator(`[data-todo-open="${storyId}"]`).dblclick();
  page.once("dialog", dialog => dialog.accept("User reopens the parent before its child"));
  await page.getByRole("dialog").locator('[data-todo-action=reopen]').click();
  await page.waitForFunction(() => !noteTodo.pending);
  assert.equal(await page.evaluate(() => noteTodo.error), "");
  await page.locator(`[data-todo-open="${id}"]`).dblclick();
  page.once("dialog", dialog => dialog.accept("Parent reopened; request a new child attempt"));
  await page.getByRole("dialog").locator('[data-todo-action=reopen]').click();
  await page.waitForFunction(() => !noteTodo.pending);
  assert.equal(await page.evaluate(() => noteTodo.error), "");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const reopened = await api.call("note_work_items", { slug: "Delivery" });
  const reopenedItem = reopened.items.find(item => item.id === id);
  assert.equal(reopenedItem.state, "Planning");
  assert.equal(reopenedItem.acceptanceDecision, undefined);
  assert.deepEqual(reopenedItem.evidence, ["test://browser-e2e/delivery"]);
  assert.equal(reopenedItem.projectId, projectId);
  assert.equal(reopenedItem.monitoring.endCondition,"Record one observation and explicitly report the result");
  assert.equal(await page.evaluate(item=>noteTodoAttempts(item).length,reopenedItem),2,"explicit user Reopen starts the second audit attempt");
  assert(reopenedItem.history.some(event=>event.action==="accept"),"old acceptance remains historical, not current");
  const publicPage = await browser.newPage();
  await publicPage.goto(`${publicServer.localBaseUrl}/notes/Delivery.html`);
  assert.equal(await publicPage.locator("[data-todo-action],[data-todo-new]").count(), 0);
  await publicPage.locator("[data-todo-expand-all]").click();
  await publicPage.locator(`[data-todo-open="${id}"]`).dblclick();
  const readonlyDetails=publicPage.getByRole("dialog");
  assert.match(await readonlyDetails.innerText(),/not owners or reviewers|Collaborators/);
  for(const link of item.links)assert.equal(await readonlyDetails.locator("a").filter({hasText:link}).getAttribute("href"),link);
  assert.equal(await readonlyDetails.locator("script").count(),0);
  const denied = await publicPage.request.post(`${publicServer.localBaseUrl}/_pkm/todo`, {
    headers: { "X-Pkm-Todo": "1", Origin: publicServer.localBaseUrl }, data: { documentPath: "/notes/Delivery.html", message: { command: "noteTodoRead" } },
  });
  assert.equal(denied.status(), 403);
});

test("atomic contract crosses two actual MCP identities, handoff, bounded monitoring, native worker permissions and independent acceptance", {timeout:60000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"pkm-atomic-contract-e2e-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  store.setStorePath(root);
  const slug="Atomic",one="external:copilot:one",two="external:claude:two";
  store.todoBoardCreate(slug,slug);
  for(const [id,ownerId] of [["grant-one",one],["grant-two",two]]){
    store.noteWorkItemCommand(slug,store.noteWorkItemsRead(slug).digest,{action:"create",item:{...task(id),ownerId}},user);
  }
  const tokens=[one,two].map(actor=>store.todoBoardGrantWorker(slug,store.noteWorkItemsRead(slug).digest,actor));
  const first=await mcp(root),second=await mcp(root);
  t.after(()=>first.close());t.after(()=>second.close());
  const read=()=>first.call("note_work_items",{slug});
  const named=async(client,name,args,worker_token)=>{
    const snapshot=await read();
    return client.call(name,{board_slug:slug,expected_digest:snapshot.digest,...args,...(worker_token?{worker_token}:{})});
  };
  const before=await read();
  await assert.rejects(first.call("add_workitem",{board_slug:slug,expected_digest:before.digest,
    item:{id:"monitor",title:"Bounded contract",goal:"Observe",scope:"One sample",acceptance:["Explicit result"],monitoring:{}}}),/Monitoring requires/);
  assert.equal((await read()).digest,before.digest,"invalid monitoring never commits");
  await named(first,"add_workitem",{item:{id:"monitor",title:"Bounded contract",goal:"Observe, report, then independently review",
    scope:"Shared resource notes/Shared.md. Read current revision before writes; stop and report conflicts, never overwrite blindly.",
    acceptance:["Record the observation window and explicit result; do not infer acceptance"],
    description:"One owner, explicit collaborators and no automatic execution",icon:"eye",collaboratorIds:["mcp:external"],
    monitoring:{until:"2020-01-01T00:00:00Z",endCondition:"Report one observed sample or an inconclusive finding"},
    links:["pkm://notes/Shared.md","pkm://actions/action_fixture","pkm://recipes/recipe_fixture"]}});
  const current=await read();
  assert.equal(current.items.find(item=>item.id==="monitor").state,"Planning","elapsed time never claims or completes");
  const claims=await Promise.allSettled([first,second].map((client,index)=>client.call("claim_workitem",{
    board_slug:slug,id:"monitor",expected_digest:current.digest,worker_token:tokens[index]})));
  assert.equal(claims.filter(result=>result.status==="fulfilled").length,1);
  assert.match(claims.find(result=>result.status==="rejected").reason.message,/changed|digest|conflict/i);
  const claimed=await read(),owner=claimed.items.find(item=>item.id==="monitor").ownerId;
  assert([one,two].includes(owner));
  const winner=owner===one?0:1,loser=1-winner,clients=[first,second],actors=[one,two];
  await assert.rejects(named(clients[loser],"claim_workitem",{id:"monitor"},tokens[loser]),/another actor/);
  await assert.rejects(first.call("note_work_item_command",{slug,expected_digest:claimed.digest,
    command:{action:"transition",id:"monitor",state:"Done",outcome:"Success",evidence:["collaborator-result"]}}),/owned/);
  const tools=createNoteTodoTools({actorId:owner,assertActive(){},approve:async()=>true});
  const workerRead=JSON.parse(await tools[0].execute({slug},signal));
  const observed=workerRead.items.find(item=>item.id==="monitor");
  await assert.rejects(tools[1].execute({slug,expectedDigest:workerRead.digest,
    command:{action:"edit",item:{...observed,monitoring:{endCondition:"Run forever"}}}},signal),/protected/);
  await named(clients[winner],"add_workitem_comment",{id:"monitor",
    text:"Handoff request: shared resource revision changed; no uncertain write replayed. Last confirmed: one observation; next: inspect current source, resume only after reconciliation."},tokens[winner]);
  assert.equal((await read()).items.find(item=>item.id==="monitor").ownerId,owner,"requesting help is not assignment");
  await named(clients[winner],"release_workitem",{id:"monitor",reason:"Explicit handoff with last confirmed evidence, resource pin and next step in comment"},tokens[winner]);
  await named(clients[loser],"claim_workitem",{id:"monitor"},tokens[loser]);
  assert.equal((await read()).items.find(item=>item.id==="monitor").ownerId,actors[loser]);
  await assert.rejects(named(clients[winner],"submit_workitem_result",{id:"monitor",outcome:"Success",evidence:["late old-owner result"]},tokens[winner]),/owned/);
  const done=await named(clients[loser],"submit_workitem_result",{id:"monitor",outcome:"Unsure",evidence:["test://atomic/inconclusive-window"],
    verification:[{layer:"e2e",status:"not-run",evidence:[],reason:"Live provider not authorized"}]},tokens[loser]);
  assert.equal(done.item.outcome,"Unsure");
  assert.equal(done.item.acceptanceDecision,undefined);
  await assert.rejects(named(first,"accept_workitem",{id:"monitor",reason:"I am merely a collaborator"}),/reviewer/);
  const doneSnapshot=await read();
  store.noteWorkItemCommand(slug,doneSnapshot.digest,{action:"reopen",id:"monitor",reason:"User requests another observation attempt"},user);
  await assert.rejects(first.call("accept_workitem",{board_slug:slug,id:"monitor",expected_digest:doneSnapshot.digest,
    reason:"Stale review of previous result"}),/changed|digest/i);
  let reopened=await read();
  store.noteWorkItemCommand(slug,reopened.digest,{action:"edit",item:{...reopened.items.find(item=>item.id==="monitor"),reviewerIds:["mcp:external"]},
    reason:"User explicitly delegates review of this task only"},user);
  const finished=await named(clients[loser],"submit_workitem_result",{id:"monitor",outcome:"Failed",evidence:["test://atomic/observed-failure"]},tokens[loser]);
  assert.deepEqual(finished.item.evidence,["test://atomic/inconclusive-window","test://atomic/observed-failure"]);
  const accepted=await named(first,"accept_workitem",{id:"monitor",reason:"Delegated reviewer accepts the explicitly reported failure; no successful business outcome inferred"});
  assert.equal(accepted.item.acceptanceDecision.by,"mcp:external");
  assert.equal(accepted.item.outcome,"Failed","accepted does not rewrite Failed into Success");
  const restarted=await mcp(root);
  try{
    const persisted=await restarted.call("get_workitem",{board_slug:slug,id:"monitor"});
    assert.deepEqual(persisted.item.monitoring,finished.item.monitoring);
    assert.equal(persisted.item.ownerId,actors[loser]);
    const history=await restarted.call("list_workitem_history",{board_slug:slug,id:"monitor",limit:100});
    assert.equal(history.items.filter(event=>event.action==="reopen").length,1);
    assert(history.items.some(event=>event.reason?.includes("Handoff request")));
  }finally{await restarted.close();}
});
