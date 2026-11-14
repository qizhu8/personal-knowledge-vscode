const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
const store = require("../dist/knowledge/filestore");
const { panelSearchTarget } = require("../dist/retrieval/panel-search");
const source = fs.readFileSync(path.join(__dirname, "../src/webview/panel/20-knowledge.js"), "utf8");
const section = (from, to) => source.slice(source.indexOf(`function ${from}(`), source.indexOf(`function ${to}(`));

test("Ctrl+F filters the real Skill tree, opens content, and keeps ranked retrieval explicit", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-search-browser-"));
  const previous = store.getStorePath();
  t.after(() => { store.setStorePath(previous); fs.rmSync(root, { recursive: true, force: true }); });
  store.setStorePath(root);
  const name = "dlis-falcon-deployment-automation";
  store.skillUpsert({ name, category: "General/DLIS/Falcon/deployment", content: "DLIS Falcon deployment procedure." });
  store.skillUpsert({ name: "dlis-logs", category: "General/DLIS/common", content: "Only DLIS logs." });
  store.skillUpsert({ name: "other", category: "Other", content: "Unrelated procedure." });
  const skill = store.skillGet(name);
  const inventory = [{ area: "skills", relativePath: `${skill.category}/${name}.md`,
    slug: `${skill.category}/${name}`, name, title: name, knowledgeId: skill.knowledgeId }];
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(`<div id="content-find-control"><input id="searchbox" aria-label="Find files"></div>
    <div id="layout"><aside><div id="sidebar-filters"></div><div id="item-list"></div></aside><main id="detail"></main></div>`);
  await page.addStyleTag({ path: path.join(__dirname, "../src/webview/panel.css") });
  await page.exposeFunction("__hostAsk", (command, payload) => {
    if (command === "list") return { command, q: payload.q, data: payload.q ? store.skillSearch(payload.q) : store.skillList() };
    if (command === "detail") {
      assert.equal(payload.type, "skill");
      return { command, data: { type: "skill", ...store.skillGet(payload.key) } };
    }
    if (command === "knowledgeSearch") return { command, tab: payload.tab, requestId: payload.requestId, data: {
      ok: true, search_mode: payload.mode, semantic_status: "unavailable",
      semantic_reason: "Frozen Skill path unavailable: missing architecture module",
      hits: [{ title: name, contentType: "skill", sourceUri: `pkm://knowledge/${skill.knowledgeId}`,
        ...panelSearchTarget(`pkm://knowledge/${skill.knowledgeId}`, inventory),
        source_label: "from keyword search", path_evidence: [] }],
    } };
    throw new Error(`Unexpected test host request: ${command}`);
  });
  await page.evaluate(() => {
    Object.assign(window, {
      state: { tab: "skills", filter: "all", search: "", items: [], folders: ["EmptyFolder"], privateTopLevels: [],
        knowledgeGroups: { groups: [{ id: "default", name: "Files", color: "#888" }, { id: "empty", name: "Empty group", color: "#888" }] } },
      cachedKnowledgeTabs: new Set(["skills"]), searchDebounce: null, skillsListLoading: false,
      currentDetail: null, currentDetailRequest: null, renderNonce: 0,
      catExpanded: {}, paperGroupExpanded: { "skills:default": false }, knowledgeListMarkup: { tab: "", html: "" },
      githubSyncTypes: [], __posts: [],
      esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
      findOptions: () => ({ regex: false, caseSensitive: false }), compileFindPattern: () => true,
      highlightDetailMatches() {}, ensureGitHubSyncStatus() {}, renderSubscribedGroups() {}, renderKnowledgeTrashDock() {},
      privacyInherited: () => false, privacyDivider: () => "", privacyLock: () => "",
      brokerFolderMarker: () => "", brokerShareMarker: () => "", uiIcon: () => "", folkDisplayName: value => value,
      hl: value => window.esc(value), markdownAssetFolder: () => "",
      setPanelTitle() {}, detailPanelTitle: () => "", detailPathHtml: () => "",
      buildToc: () => "", wordCount: value => value.length, noteTodoDetailRefresh: () => false,
      safeMarked: value => window.esc(value), postProcess() {},
    });
    window.ask = (command, payload) => {
      window.__posts.push({ command, ...payload });
      return window.__hostAsk(command, payload).then(message => window.dispatchEvent(new MessageEvent("message", { data: message })));
    };
    window.addEventListener("message", event => {
      if (event.data.command === "list") {
        if (event.data.q !== state.search) return;
        state.items = event.data.data;
        skillsListLoading = false;
        renderList();
      } else if (event.data.command === "detail") renderDetail(event.data.data);
    });
  });
  await page.addScriptTag({ content: [
    section("buildCatTree", "openCatFolderAddMenu"),
    section("setKnowledgeListMarkup", "renderKnowledgeGroupControls"),
    section("renderKnowledgeGroupControls", "renderList"),
    section("renderList", "renderSubscribedGroups"),
    section("skillLi", "toggleSkillPin"),
    section("requestDetail", "openPromptFile"),
    section("markdownPinButton", "detailContentPath"),
    section("renderDetail", "openMarkdownItem"),
    section("contentSearchChanged", "folkDisplayName"),
    fs.readFileSync(path.join(__dirname, "../src/webview/panel/21-search.js"), "utf8"),
  ].join("\n") });
  await page.keyboard.press("Control+f");
  assert(await page.locator("#content-find-control").evaluate(node => node.classList.contains("panel-find-open")));
  await page.getByRole("textbox", { name: "Find files" }).fill("dlis falcon");
  const filtered = page.locator("#item-list [data-skill-name]");
  await page.waitForFunction(() => document.querySelectorAll("#item-list [data-skill-name]").length === 1);
  assert.equal(await filtered.getAttribute("data-skill-name"), name);
  assert.equal(await page.locator("#item-list").getByText("Empty group", { exact: true }).count(), 0);
  assert.equal(await page.locator("#item-list").getByText("EmptyFolder", { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => __posts.some(p => p.command === "knowledgeSearch")), false);
  await filtered.click();
  await page.waitForFunction(() => document.querySelector("#detail .prose")?.textContent === "DLIS Falcon deployment procedure.");
  await page.getByRole("textbox", { name: "Find files" }).fill("no-match");
  await page.getByText("No skills", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Find files" }).fill("");
  await page.waitForFunction(() => document.querySelectorAll("#item-list [data-skill-name]").length === 3);

  await page.getByRole("textbox", { name: "Find files" }).fill("dlis falcon");
  await page.locator("#knowledge-search-mode").selectOption("dual");
  await page.getByRole("button", { name, exact: true }).waitFor();
  assert(await page.locator("#item-list").isHidden());
  assert.equal(await page.locator("#knowledge-search-results .tree-cat-label").getByText("Falcon", { exact: true }).count(), 1);
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForFunction(() => __posts.filter(p => p.command === "detail").length === 2);
  assert.equal(await page.evaluate(() => __posts.filter(p => p.command === "detail").at(-1).key), name);
  assert.equal(await page.locator("#knowledge-search-results .tree-cat-add").count(), 0);
  assert.equal(await page.locator("#knowledge-search-results details[open]").count(), 0, "evidence is collapsed by default");
  assert.match(await page.locator("#knowledge-search-results [role=status]").textContent(), /missing architecture module/);
  await page.locator("#knowledge-search-mode").selectOption("filter");
  await page.waitForFunction(() => !document.getElementById("item-list").hidden && state.items.length === 1);
  assert.equal(await filtered.count(), 1);
  await page.evaluate(() => {
    const request = __posts.find(p => p.command === "knowledgeSearch");
    window.dispatchEvent(new MessageEvent("message", { data: {
      command: "knowledgeSearch", tab: "skills", requestId: request.requestId,
      data: { ok: true, hits: [{ title: "Late stale hit" }] },
    } }));
  });
  assert(await page.locator("#knowledge-search-results").isHidden(), "a late model result must not replace filtered files");
  assert.equal(await filtered.count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#content-find-control").evaluate(node => node.classList.contains("panel-find-open")), false);
  assert.deepEqual(errors, []);
});

test("document details keep Pin beside the title and expose only common toolbar actions", async t => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PKM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PKM_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<main id="detail"></main><div id="paper-form"></div><div id="paper-graph-view"></div>');
  await page.addStyleTag({ path: path.join(__dirname, "../src/webview/panel.css") });
  await page.evaluate(() => {
    Object.assign(window, {
      currentDetail: null, renderNonce: 0, ICON: {}, __posts: [], __edits: [],
      esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
      uiIcon: (icon, label = "") => `<span class="codicon codicon-${icon}" aria-hidden="true"></span>${label}`,
      privacyLock: () => "", detailPathHtml: () => "", detailPanelTitle: () => "",
      setPanelTitle() {}, noteTodoDetailRefresh: () => false, noteTodoMount() {}, postProcess() {},
      buildToc: () => "", wordCount: () => "", safeMarked: value => window.esc(value),
      ask: (command, payload) => window.__posts.push({command, ...payload}),
      pkModal: options => { window.__edits.push(options.title); options.onOk("Updated value"); },
      copyDetailUrl: () => window.__posts.push({command:"copyDetailUrl"}),
      exportMarkdown: mode => window.__posts.push({command:"exportMarkdown", mode}),
    });
  });
  await page.addScriptTag({ content: [
    section("markdownPinButton", "detailContentPath"),
    section("renderDetail", "startEditScript"),
    section("toggleNotePin", "buildCatTree"),
    section("toggleSkillPin", "noteFilename"),
    section("togglePin", "openPaperLink"),
  ].join("\n") });
  for (const width of [1000, 390]) {
    await page.setViewportSize({width, height:800});
    for (const type of ["note", "skill", "paper"]) {
      const title = "Production AAGL Pipeline Consolidation";
      await page.evaluate(({type, title}) => renderDetail({
        type, title, name:title, slug:"Project/Design", category:"Project", note_type:"general",
        content:"Document body", tags:type === "paper" ? ["design"] : '["design"]',
        description:"Description", pinned:false,
      }), {type, title});
      const pin = page.locator(".d-title").getByRole("button", {name:"Pin", exact:true});
      assert.equal(await pin.getAttribute("aria-pressed"), "false");
      assert.equal(await pin.innerText(), "", "Pin is a compact icon, not another toolbar label");
      assert.equal(await page.locator(".d-meta .detail-pin").count(), 0);
      for (const name of ["Site", "Edit Metadata"]) {
        assert.equal(await page.getByRole("button", {name, exact:true}).count(), 0);
      }
      const convert = page.getByRole("button", {name:"Convert to Todo Board", exact:true});
      assert.equal(await convert.count(), type === "note" ? 1 : 0);
      if (type === "note") {
        await convert.click();
        assert.deepEqual(await page.evaluate(() => __posts.at(-1)), {command:"todoBoardConvert", slug:"Project/Design"});
      }
      const heading = await page.locator(".d-title").boundingBox();
      const button = await pin.boundingBox();
      assert(Math.abs(button.x+button.width-heading.x-heading.width)<2, "Pin sits at the right edge of the title");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await pin.click();
      assert.deepEqual(await page.evaluate(() => __posts.at(-1)), {
        command:type === "note" ? "noteSetPinned" : type === "skill" ? "skillSetPinned" : "paperSetPinned",
        [type === "skill" ? "name" : "slug"]:type === "skill" ? title : "Project/Design",
        pinned:true,
      });
      const unpin = page.locator(".d-title").getByRole("button", {name:"Unpin", exact:true});
      assert.equal(await unpin.getAttribute("aria-pressed"), "true");
      await unpin.focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => __posts.at(-1).pinned), false);
      for (const [label, field] of [[type === "skill" ? "Edit name" : "Edit title", "title"], ["Edit tags", "tags"], ["Edit description", "description"]]) {
        await page.locator(`button[title="${label}"]`).click();
        assert.equal(await page.evaluate(() => __posts.at(-1).command), "updateKnowledgeMetadataField");
        assert.equal(await page.evaluate(() => __posts.at(-1).field), field);
      }
      await page.getByRole("button", {name:"Browser", exact:true}).click();
      assert.equal(await page.evaluate(() => __posts.at(-1).mode), "browser");
      await page.getByRole("button", {name:"Download", exact:true}).click();
      assert.equal(await page.evaluate(() => __posts.at(-1).mode), "file");
      await page.getByRole("button", {name:"Copy PKM URL", exact:true}).click();
      assert.equal(await page.evaluate(() => __posts.at(-1).command), "copyDetailUrl");
      await page.getByRole("button", {name:"Edit Content", exact:true}).click();
      assert.equal(await page.evaluate(() => __posts.at(-1).command), "openKnowledgeContent");
    }
    await page.evaluate(() => renderDetail({type:"note", title:"Todo Board", slug:"Board", documentKind:"todo-board", pinned:true}));
    assert.equal(await page.getByRole("button", {name:"Edit Content", exact:true}).count(), 0);
    assert.equal(await page.getByRole("button", {name:"Convert to Todo Board", exact:true}).count(), 0);
    assert.equal(await page.locator(".d-title .detail-pin").getAttribute("aria-pressed"), "true");
  }
  assert.deepEqual(errors, []);
});
