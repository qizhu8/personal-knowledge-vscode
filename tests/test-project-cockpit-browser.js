#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ProjectStore } = require("../dist/workflows/project-store");
const { projectCockpits } = require("../dist/workflows/project-cockpit");
const { handleProjectCockpitRequest, promoteChatProject, actionRunProject } = require("../dist/workflows/project-cockpit-host");

// Reuse the already installed Playwright driver; do not install tooling for acceptance.
function browserDriver() {
  try { return require("playwright"); } catch {}
  const libraries = path.join(__dirname, "..", ".venv", "lib");
  for (const directory of fs.readdirSync(libraries)) {
    const driver = path.join(libraries, directory, "site-packages", "playwright", "driver", "package");
    if (fs.existsSync(driver)) return require(driver);
  }
  throw Error("Install/configure the repository browser test environment before running browser acceptance.");
}
const assets = path.join(__dirname, "..", "dist", "webview");
const root = path.join(__dirname, ".project-browser-work", crypto.randomUUID());
const stateDir = path.join(root, ".pkm", "state");
const store = new ProjectStore(stateDir);
const runId = "action_run_" + "c".repeat(32);
const runFile = path.join(stateDir, "actions", "runs", runId, "run.json");
let run = { run_id: runId, action_id: "acceptance.research", state: "waiting",
  execution: { phase: "waiting", version: 7, receipts: [{ operation: "waiting", version: 7, at: 1792000000 }] },
  checkpoint: { run_id: runId, checkpoint_id: "checkpoint_fixture", kind: "artifact-review", state: "waiting", owner: "Reviewer",
    presentation: "json", proposal: { title: "Review synthesis", revision: "r1", options: ["draft", "final"], body: "</pre><script>unsafe</script>" },
    proposal_digest: "digest-r1", resume_token: "host-only-secret", evidence: [{ source: "paper:one" }],
    trigger: { kind: "human" }, answer_schema: { type: "object", required: ["approved"] }, timeout_behavior: "review" },
  artifacts: [{ artifact_id: "artifact_one", kind: "proposal", provenance: ["paper:one"] }] };
const writeRun = () => { fs.mkdirSync(path.dirname(runFile), { recursive: true }); fs.writeFileSync(runFile, JSON.stringify(run)); };
writeRun();
const command = (operation, input) => ({ commandId: crypto.randomUUID(), fingerprint: JSON.stringify({ operation, input }), expectedStoreVersion: store.list().storeVersion });
const snapshot = async () => {
  const value = store.list();
  return { ...value, cockpits: projectCockpits(root, value.projects, value.collaborationTasks), agentSessions: [], agentSnapshots: [] };
};
const calls = [], messages = [], errors = [], opened = [];
let projectId, prompts = 0, panelPage, selectedSource;
const send = async (page, message) => page.evaluate(value => window.dispatchEvent(new MessageEvent("message", { data: value })), message);
const action = async (method, params) => {
  calls.push({ method, params });
  if (method === "checkpoints") return { ok: true, checkpoints: [JSON.parse(JSON.stringify(run.checkpoint))] };
  if (method === "respond_checkpoint") {
    assert.strictEqual(params.resume_token, run.checkpoint.resume_token);
    assert.strictEqual(params.proposal_digest, run.checkpoint.proposal_digest);
    assert.strictEqual(params.event_key, run.checkpoint.checkpoint_id);
    if (!Object.hasOwn(params.answer, "approved")) throw Error("Answer does not satisfy the checkpoint schema.");
    run.checkpoint.state = "resolved"; run.checkpoint.answer = params.answer;
    run.state = "succeeded"; run.execution.phase = "completed"; writeRun();
    return { ok: true };
  }
  if (method === "cancel_run") {
    run.state = "cancelled"; run.execution.phase = "completed"; writeRun();
    return { ok: true };
  }
  throw Error("Unexpected test Action operation.");
};
function html(name) {
  let value = fs.readFileSync(path.join(assets, name), "utf8").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const panelTokens = { PANEL_JS: "panel.js", PANEL_CSS: "panel.css", CODICON_CSS: "codicon.css", HOST_HEALTH_JS: "host-health.js", HOST_HEALTH_CSS: "host-health.css" };
  const chatTokens = { styles: "api-chat.css", script: "api-chat.js", icons: "codicon.css", marked: "marked.umd.js", purify: "purify.min.js",
    libraryScript: "api-chat-library.js", retrievalScript: "chat-retrieval-flow.js", hostHealthScript: "host-health.js", hostHealthStyles: "host-health.css" };
  for (const [token, file] of Object.entries(panelTokens)) value = value.split(`%%${token}%%`).join(file);
  for (const [token, file] of Object.entries(chatTokens)) value = value.split(`{{${token}}}`).join(file);
  return value.replace(/%%[A-Z_]+%%/g, "").replaceAll("{{nonce}}", "acceptance");
}
async function mount(browser, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const saved = { tab: "projects" };
    window.acquireVsCodeApi = () => ({ getState: () => saved, setState: value => Object.assign(saved, value),
      postMessage: value => window.hostMessage(value) });
  });
  await page.route("http://cockpit.test/**", route => {
    const file = path.basename(new URL(route.request().url()).pathname);
    if (file === "index.html") return route.fulfill({ body: html(name), contentType: "text/html" });
    if (fs.existsSync(path.join(assets, file))) return route.fulfill({ path: path.join(assets, file) });
    return route.fulfill({ status: 404, body: "" });
  });
  return page;
}
const chatFixture = { type: "state", busy: false, approvals: [], chats: [], tools: [], toolGroups: [],
  library: { groups: [], chats: [{ id: "chat_fixture", title: "Research Chat", groupId: "ungroup", status: "idle" }] },
  chat: { id: "chat_fixture", title: "Research Chat", context: [], permissionMode: "protective", permissionGrants: [], messages: [], includeHistory: true },
  settings: { provider: "vscode", maxToolRounds: 30, contextWindow: 8192, maxOutputTokens: 1024,
    selectedProfile: { id: "fixture", model: "fixture", label: "Fixture", status: "active", contextWindow: 8192, maxOutputTokens: 1024 } } };

(async () => {
  process.env.TMPDIR = root;
  const browser = await browserDriver().chromium.launch({ args: ["--no-sandbox"] });
  try {
    panelPage = await mount(browser, "panel.html");
    let queue = Promise.resolve();
    await panelPage.exposeFunction("hostMessage", msg => {
      queue = queue.then(async () => {
        messages.push(msg);
        if (msg.command === "ready") {
          await send(panelPage, { command: "loadingProgress", data: { stage: "ready" } });
          await send(panelPage, { command: "openTab", tab: "projects" });
        }
        if (msg.command === "projectState") return send(panelPage, { command: "projectState", data: await snapshot() });
        if (msg.command === "hostHealth") return send(panelPage, msg);
        const replies = [];
        try {
          await handleProjectCockpitRequest({ store, root, command, snapshot, action, respond: value => replies.push(value),
            openSource: id => { selectedSource = id; opened.push(id); } }, msg);
        } catch (error) {
          replies.push({ command: "projectState", data: await snapshot() }, { command: "projectError", data: { action: msg.command, code: error.code, error: error.message } });
        }
        for (const reply of replies) await send(panelPage, reply);
      });
      return queue;
    });
    await panelPage.goto("http://cockpit.test/index.html");
    await panelPage.getByRole("heading", { name: "Default Project", exact: true }).waitFor();
    const chat = await mount(browser, "api-chat.html");
    await chat.exposeFunction("hostMessage", async msg => {
      if (msg.type === "ready") await send(chat, chatFixture);
      if (msg.type === "hostHealth") await send(chat, { type: "hostHealth", id: msg.id });
      if (msg.type === "promoteProject") {
        projectId = await promoteChatProject(store, { chatId: chatFixture.chat.id, title: chatFixture.chat.title },
          async () => { prompts++; return chatFixture.chat.title; }, command);
        await send(panelPage, { command: "openProject", projectId });
      }
    });
    await chat.goto("http://cockpit.test/index.html");
    await send(chat, chatFixture);
    await chat.evaluate(() => { document.body.classList.remove("chat-library-visible"); document.getElementById("library-view").hidden = true; });
    await chat.locator("#promote-project").click();
    await panelPage.getByRole("heading", { name: "Research Chat", exact: true }).waitFor();
    await chat.locator("#promote-project").click();
    await queue;
    assert.strictEqual(prompts, 1, "Repeat promotion navigates without another confirmation");
    assert.strictEqual(store.list().projects.filter(value => value.links?.some(link => link.kind === "chat")).length, 1);
    // Use production Action-to-Project command handler; same Project is chosen, then existing link short-circuits.
    assert.strictEqual(await actionRunProject(store, root, runId, async () => ({ projectId }), command), projectId);
    assert.strictEqual(await actionRunProject(store, root, runId, async () => { throw Error("No repeated picker"); }, command), projectId);
    await send(panelPage, { command: "openProject", projectId });
    await panelPage.getByRole("heading", { name: "Review inbox", exact: true }).waitFor();
    await panelPage.locator(".cockpit-checkpoint-form").waitFor();
    assert.strictEqual(await panelPage.locator(".cockpit-checkpoint-form").count(), 1);
    assert.strictEqual((await snapshot()).cockpits[projectId].reviewInbox[0].checkpoint.presentation, "json");
    assert(!(await panelPage.locator(".cockpit-checkpoint-form").innerText()).includes("choice schema"), "Proposal options do not imply legacy user-choice");
    assert(!(await panelPage.locator("#detail").innerText()).includes("host-only-secret"));
    await panelPage.locator(".cockpit-items details").first().locator("summary").click();
    assert((await panelPage.locator(".cockpit-items pre").first().innerText()).includes("</pre><script>unsafe</script>"));
    assert.strictEqual(await panelPage.locator(".cockpit-items script").count(), 0);
    await panelPage.getByRole("button", { name: "Inspect original source" }).first().click();
    await queue; assert.strictEqual(selectedSource, runId);
    await panelPage.getByRole("button", { name: "Overview", exact: true }).click();
    assert(await panelPage.getByRole("button", { name: "Archive", exact: true }).isDisabled());
    await panelPage.locator("#cockpit-goal").fill("Review sources");
    await panelPage.getByRole("button", { name: "Save Overview" }).click();
    await panelPage.getByText("Goal or success criteria changes require an explicit reason.", { exact: true }).waitFor();
    await panelPage.locator("#cockpit-reason").fill("Narrow the scope");
    await panelPage.getByRole("button", { name: "Save Overview" }).click();
    await queue;
    assert.strictEqual(store.list().projects.find(value => value.projectId === projectId).decisions.at(-1).reason, "Narrow the scope");
    // Pin displayed version even while background refresh sees a concurrent external edit.
    await panelPage.locator("#cockpit-owner").fill("Local unsaved");
    store.updateProject(command("project-overview", {}), projectId, { owner: "External owner" }, "");
    await send(panelPage, { command: "projectState", data: await snapshot() });
    assert.strictEqual(await panelPage.locator("#cockpit-owner").inputValue(), "Local unsaved");
    await panelPage.getByRole("button", { name: "Save Overview" }).click();
    await queue;
    assert.strictEqual(store.list().projects.find(value => value.projectId === projectId).owner, "External owner");
    assert(messages.some(msg => msg.command === "projectOverview" && msg.expectedStoreVersion < store.list().storeVersion));
    await panelPage.getByRole("button", { name: "Now", exact: true }).click();
    await panelPage.getByRole("button", { name: "Submit exact answer" }).click();
    await panelPage.getByText("Answer must be valid JSON.", { exact: true }).waitFor();
    assert(!calls.some(value => value.method === "respond_checkpoint"));
    await panelPage.getByRole("textbox", { name: "Checkpoint answer JSON" }).fill('{}');
    await panelPage.getByRole("button", { name: "Submit exact answer" }).click();
    await panelPage.getByText("Answer does not satisfy the checkpoint schema.", { exact: true }).waitFor();
    assert.strictEqual(run.checkpoint.state, "waiting");
    const responsesBeforeStale = calls.filter(value => value.method === "respond_checkpoint").length;
    await panelPage.getByRole("textbox", { name: "Checkpoint answer JSON" }).fill('{"approved":true}');
    run.checkpoint.proposal_digest = "digest-r2"; run.checkpoint.proposal.revision = "r2"; writeRun();
    await panelPage.getByRole("button", { name: "Submit exact answer" }).click();
    await panelPage.getByText("Checkpoint changed or is no longer waiting. Refresh and inspect the current proposal.", { exact: true }).waitFor();
    assert.strictEqual(calls.filter(value => value.method === "respond_checkpoint").length, responsesBeforeStale, "Stale proposal never reaches mutation API");
    await panelPage.getByRole("button", { name: "Refresh", exact: true }).click();
    await queue;
    await panelPage.getByRole("textbox", { name: "Checkpoint answer JSON" }).fill('{"approved":true}');
    await panelPage.getByRole("button", { name: "Submit exact answer" }).click();
    await queue;
    await panelPage.waitForFunction(() => !document.querySelector(".cockpit-checkpoint-form"));
    assert.strictEqual(run.checkpoint.state, "resolved");
    await panelPage.getByRole("button", { name: "Artifacts", exact: true }).click();
    assert((await panelPage.locator(".cockpit-evidence").innerText()).includes("paper:one"));
    await panelPage.getByRole("button", { name: "Decisions", exact: true }).click();
    assert((await panelPage.locator(".cockpit-evidence").innerText()).includes("approved"));
    await panelPage.getByRole("button", { name: "Overview", exact: true }).click();
    await panelPage.getByRole("button", { name: "Archive", exact: true }).click();
    await panelPage.locator("#pk-modal-ok").click(); await queue;
    await panelPage.getByRole("button", { name: "Remove from active map", exact: true }).click();
    await panelPage.locator("#pk-modal-ok").click(); await queue;
    assert(store.list().projects.find(value => value.projectId === projectId).deletedAt);
    assert(fs.existsSync(runFile));
    await panelPage.getByRole("button", { name: "Restore", exact: true }).focus();
    await panelPage.keyboard.press("Enter");
    await panelPage.locator("#pk-modal-ok").press("Enter"); await queue;
    assert(!store.list().projects.find(value => value.projectId === projectId).deletedAt);
    for (const width of [390, 320]) {
      await panelPage.setViewportSize({ width, height: 844 });
      await panelPage.getByRole("button", { name: "Now", exact: true }).focus();
      await panelPage.keyboard.press("Enter");
      await panelPage.getByRole("heading", { name: "Review inbox", exact: true }).waitFor();
      assert(await panelPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No document overflow at ${width}px`);
      await panelPage.getByRole("button", { name: "Overview", exact: true }).click();
    }
    run.state = "waiting"; run.execution.phase = "waiting"; run.checkpoint.state = "waiting"; writeRun();
    await send(panelPage, { command: "openProject", projectId });
    await panelPage.locator(".cockpit-checkpoint-form").waitFor();
    assert(await panelPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Long checkpoint identities and inline JSON controls fit 320px");
    await panelPage.getByRole("button", { name: "Cancel Run", exact: true }).click();
    await panelPage.getByText("Confirm cancellation of the entire Run first.", { exact: true }).waitFor();
    await panelPage.locator('.cockpit-checkpoint-form [name="confirm"]').check();
    await panelPage.getByRole("button", { name: "Cancel Run", exact: true }).click(); await queue;
    assert.strictEqual(run.state, "cancelled");
    await panelPage.waitForFunction(() => !document.querySelector(".cockpit-checkpoint-form"));
    assert.strictEqual((await snapshot()).cockpits[projectId].hasActiveRuns, false, "Terminal cancellation supersedes retained unresolved checkpoint evidence");
    assert.strictEqual(new ProjectStore(stateDir).list().projects.find(value => value.projectId === projectId).links.length, 2);
    assert.deepStrictEqual(errors, []);
    console.log("P2 Chromium integration passed: real Chat toolbar → production host → durable ProjectStore → Cockpit, source deep link, pinned checkpoint answer/cancel, stale versions, freshness, evidence, lifecycle, keyboard and 320/390px UI. Executor boundary stubbed; no human timing claim.");
  } catch (error) {
    console.error("Browser diagnostics:", errors, "last host messages:", messages.slice(-5));
    throw error;
  } finally {
    await browser.close();
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(root)); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
