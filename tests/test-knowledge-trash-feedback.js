const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const store = require("../dist/knowledge/filestore");
const { withMarkdownAssetMutation } = require("../dist/knowledge/markdown-assets");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
const handler = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "handleMessage");
assert(handler);
function evaluate(node, scope) {
  return vm.runInNewContext(ts.transpileModule(`(${node.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
}
function host(overrides = {}) {
  const errors = [];
  const scope = {
    activePanel: () => undefined, panelSession: () => ({}), checkPanelEdit() {},
    log: { debug() {}, action() {}, error: message => errors.push(message) },
    knowledgeMoveToTrash: store.knowledgeMoveToTrash, skillFolderMoveToTrash: store.skillFolderMoveToTrash,
    gitCommit() {}, ...overrides,
  };
  return { handle: evaluate(handler, scope), errors };
}

test("Trash errors always return actionable results, including precondition failures", async () => {
  for (const message of [
    { command: "knowledgeTrashMove", area: "notes" },
    { command: "knowledgeTrashMove", area: "papers" },
    { command: "skillTrashFolder" }, { command: "deleteSkill" },
    { command: "deleteNote" }, { command: "deletePaper" },
    { command: "deleteScript" }, { command: "deleteAllPapers" },
    { command: "knowledgeTrashRestore", area: "notes" }, { command: "skillTrashRestore" },
    { command: "knowledgeTrashDelete", area: "papers" }, { command: "skillTrashDelete" },
    { command: "knowledgeTrashEmpty", area: "scripts" }, { command: "skillTrashEmpty" },
  ]) {
    const fixture = host({ checkPanelEdit() { throw new Error("Mutation precondition failed; original content preserved."); } });
    const replies = [];
    await fixture.handle(message, reply => replies.push(reply), {});
    assert.equal(replies.length, 1, message.command);
    assert.equal(replies[0].command, /skill|Skill/.test(message.command) ? "skillTrashResult" : "knowledgeTrashResult");
    assert.equal(replies[0].data.ok, false);
    assert.match(replies[0].data.error, /original content preserved/);
    assert.equal(fixture.errors.length, 1);
  }
});

test("Navigation folder Trash shows progress and reports thrown failures", async () => {
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "vscode.commands.registerCommand"
      && node.arguments[0]?.text === "personalKnowledge.deleteSubgroup") callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(callback);
  for (const area of ["notes", "skills", "papers"]) {
    const errors = [], progress = [];
    const fail = () => { throw new Error("Resource is shared by External.md"); };
    const run = evaluate(callback, {
      ensureSetup: async () => true, context: {}, navigationGroupInfo: () => ({ area, path: "Shared" }),
      skillFolderMoveToTrash: fail, knowledgeMoveToTrash: fail, path, setTimeout,
      log: { error: message => errors.push(message) },
      vscode: { ProgressLocation: { Notification: 15 }, window: {
        showWarningMessage: async () => "Move to Trash",
        withProgress: async (options, action) => { progress.push(options); return action(); },
        showErrorMessage: message => errors.push(message),
      } },
    });
    await run({});
    assert.equal(progress.length, 1);
    assert.equal(progress[0].cancellable, false);
    assert.match(progress[0].title, /Moving .* folder to Trash/);
    assert.equal(errors.length, 2, "failure must be logged and shown");
    assert.match(errors[1], /External.md/);
  }
});

test("real filesystem and mutation-lock failures preserve folders and return Trash errors", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-trash-errors-"));
  const rename = fs.renameSync;
  try {
    store.setStorePath(temporary);
    for (const area of ["notes", "skills", "papers"]) {
      const folder = path.join(temporary, area, "Keep");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "payload.txt"), "original bytes");
      fs.renameSync = (from, to) => {
        if (from === folder) throw new Error("EACCES: simulated rename failure");
        return rename(from, to);
      };
      const fixture = host(), replies = [];
      await fixture.handle({ command: area === "skills" ? "skillTrashFolder" : "knowledgeTrashMove",
        area, path: "Keep", kind: "folder" }, message => replies.push(message), {});
      fs.renameSync = rename;
      assert.equal(replies[0]?.data.ok, false);
      assert.match(replies[0].data.error, /EACCES/);
      assert.equal(fs.readFileSync(path.join(folder, "payload.txt"), "utf8"), "original bytes");
    }
    withMarkdownAssetMutation(temporary, () => {
      assert.throws(() => store.knowledgeMoveToTrash("notes", "Keep", "folder", "Keep"), /busy in another PKM window/);
    });
    assert(fs.existsSync(path.join(temporary, "notes", "Keep")));
  } finally {
    fs.renameSync = rename;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("connected folder menu, Host/store and browser feedback across Notes, Skills and Research", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-trash-feedback-"));
  store.setStorePath(temporary);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}),
    });
    const webview = path.join(root, "dist/webview");
    let html = fs.readFileSync(path.join(webview, "panel.html"), "utf8").replaceAll("%%CSP_SOURCE%%", "'self'");
    for (const [key, file] of Object.entries({
      PANEL_JS: "panel.js", PANEL_CSS: "panel.css", CODICON_CSS: "codicon.css", AGENT_HARNESS_CSS: "agent-harness.css",
      MARKED_SRC: "marked.umd.js", HLJS_SRC: "hljs.js", HLJS_CSS: "hljs.css", KATEX_SRC: "katex.js",
      KATEX_CSS: "katex.css", CYTOSCAPE_SRC: "cytoscape.js", MERMAID_SRC: "mermaid.js", FORCEGRAPH3D_SRC: "forcegraph3d.js",
    })) html = html.replaceAll(`%%${key}%%`, `http://pkm.test/${file}`);
    html = html.replaceAll("%%I18N_PAYLOAD_B64%%", Buffer.from(JSON.stringify({
      setting: "en", resolved: "en", catalogs: { en: { strings: {} } },
    })).toString("base64")).replace(/%%[A-Z_]+%%/g, "");
    for (const area of ["notes", "skills", "papers"]) await t.test(area, async () => {
      const base = path.join(temporary, area);
      fs.mkdirSync(path.join(base, "Empty"), { recursive: true });
      fs.writeFileSync(path.join(base, "Empty", ".gitkeep"), "");
      fs.writeFileSync(path.join(base, "External.md"), "![missing](Empty/missing.png)");
      const fixture = host(), queued = [], errors = [];
      const page = await browser.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.route("http://pkm.test/**", route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
        const file = path.join(webview, pathname);
        return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: "" });
      });
      await page.exposeFunction("trashHostRequest", message => {
        if (message.command === "list") return {
          command: "list", tab: area, data: [], folders: store.folderList(area), knowledgeTrash:
            area === "skills" ? store.skillTrashList() : store.knowledgeTrashList(area),
        };
        if (["skillTrashFolder", "knowledgeTrashMove"].includes(message.command)) queued.push(message);
        return null;
      });
      await page.addInitScript(area => {
        window.__requests = [];
        window.deliver = data => window.dispatchEvent(new MessageEvent("message", { data }));
        window.acquireVsCodeApi = () => ({
          getState: () => ({ tab: area, workspace: "knowledge" }), setState() {},
          postMessage(message) {
            window.__requests.push(message);
            void window.trashHostRequest(message).then(reply => { if (reply) window.deliver(reply); });
          },
        });
      }, area);
      await page.goto("http://pkm.test/");
      await page.waitForFunction(() => typeof state !== "undefined" && state.folders.includes("Empty"));
      const open = async folder => {
        await page.evaluate(({ area, folder }) => {
          const event = { preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 };
          if (area === "notes") noteFolderMenu(event, btoa(folder), folder);
          else if (area === "skills") skillFolderMenu(event, btoa(folder), folder);
          else paperFolderMenu(event, btoa("[]"), folder, folder);
        }, { area, folder });
        await page.getByText(/Move folder to Trash/, { exact: false }).click();
        await page.locator("#pk-modal-ok").click();
        await page.locator(".pk-action-progress").waitFor({ state: "visible" });
        await page.waitForFunction(() => window.__requests.some(message =>
          ["skillTrashFolder", "knowledgeTrashMove"].includes(message.command)));
      };
      const flush = async () => {
        assert.equal(queued.length, 1);
        const replies = [];
        await fixture.handle(queued.shift(), message => replies.push(message), {});
        assert.equal(replies.length, 1);
        await page.evaluate(reply => window.deliver(reply), replies[0]);
        await page.locator(".pk-action-progress").waitFor({ state: "detached" });
        return replies[0].data;
      };
      await open("Empty");
      assert(fs.existsSync(path.join(base, "Empty")), "pending operation must not pretend the folder is already deleted");
      await page.evaluate(() => finishAction("list"));
      assert(await page.locator(".pk-action-progress").isVisible(), "unrelated refresh must not end Trash progress");
      await page.evaluate(area => ask(area === "skills" ? "skillTrashFolder" : "knowledgeTrashMove",
        { area, path: "Empty", kind: "folder" }), area);
      assert.equal(queued.length, 1, "repeat activation cannot dispatch a duplicate mutation");
      assert.equal((await flush()).ok, true);
      assert(!fs.existsSync(path.join(base, "Empty")));
      await page.waitForFunction(() => !state.folders.includes("Empty"));
      assert(await page.evaluate(() => window.__requests.some(message => message.command === "toast" && /Moved to Trash/.test(message.text))));

      fs.mkdirSync(path.join(base, "Shared"), { recursive: true });
      fs.writeFileSync(path.join(base, "Shared", "image.png"), "keep");
      fs.writeFileSync(path.join(base, "External.md"), "![shared](Shared/image.png)");
      await page.evaluate(() => { currentDetail = { type: "skill", name: "Unsaved selection" }; });
      await open("Shared");
      assert.equal((await flush()).ok, false);
      await page.locator(".pk-modal-msg").filter({ hasText: "External.md" }).waitFor();
      assert.equal(await page.evaluate(() => currentDetail.name), "Unsaved selection", "failed deletion preserves detail selection");
      assert.equal(fs.readFileSync(path.join(base, "Shared", "image.png"), "utf8"), "keep");
      await page.locator("#pk-modal-ok").click();
      fs.unlinkSync(path.join(base, "External.md"));
      await open("Shared");
      assert.equal((await flush()).ok, true, "fresh retry succeeds after resolving the live reference");

      await page.clock.install();
      await open("Already-gone");
      await page.clock.fastForward(15001);
      await page.locator(".pk-action-progress").waitFor({ state: "detached" });
      await page.getByRole("alert").filter({ hasText: "background operation may still be running" }).waitFor();
      assert.equal((await flush()).ok, false);
      await page.locator(".pk-modal-msg").filter({ hasText: /not found/ }).waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    });
  } finally {
    await browser?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
