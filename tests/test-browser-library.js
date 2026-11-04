#!/usr/bin/env node
// Source-transpiled harness intentionally avoids rebuilding a concurrently edited extension.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
function load(file, dependencies = {}) {
  const module = { exports:{} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText, { module,exports:module.exports,require:name => dependencies[name] || require(name),Buffer,URL,setTimeout,clearTimeout,console });
  return module.exports;
}
const helper = load("src/ui/browser-navigation.ts");
const {navigationItemPath} = load("src/ui/navigation-path.ts");
const { startLiveMarkdownServer } = load("src/knowledge/live-note-server.ts");
const { browserNoteTodo } = load("src/ui/note-todo-browser.ts", {
  "../knowledge/note-work-items":require("../dist/knowledge/note-work-items"),
});
const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const fixtures = {
  notes:[{slug:"Public/Note",title:"A public note",content:"Article stays put"},{slug:"Public/Space & 中文/Topic #1",title:"Encoded note",content:"Encoded path"},
    {slug:"Secret/Note",title:"PRIVATE_NOTE",content:"PRIVATE_BODY"},
    {slug:"Secret/Nested/Note",title:"PRIVATE_NESTED_NOTE",content:"PRIVATE_NESTED_BODY"}],
  skills:[{category:"Public",name:"Skill",content:"A skill"}],
  papers:[{slug:"Public/Root",title:"Root paper",topic:"Public"},{slug:"Public/Child",title:"Child paper",topic:"Public"},{slug:"Secret/Paper",title:"PRIVATE_PAPER",topic:"PRIVATE_TOPIC"}],
};
const rawGraph = {
  nodes:fixtures.papers.map(paper => ({...paper,key:paper.slug,citationCount:99,cites:[{paper:"Secret/Paper",note:"PRIVATE_CITE"}],file:"PRIVATE_FILE",conclusions:["PRIVATE_CONCLUSION"]})),
  edges:[{from:"Public/Root",to:"Public/Child"},{from:"Public/Root",to:"Secret/Paper",note:"PRIVATE_EDGE"}],
};
const context = {
  navigationItemPath,
  vscode:{workspace:{isTrusted:false}},
  require:name => {
    if(name === "./ui/browser-navigation") return helper;
    if(name === "./live-markdown") return require("../dist/live-markdown");
    throw new Error(name);
  },
  noteList:() => fixtures.notes,skillList:() => fixtures.skills,paperList:() => fixtures.papers,paperGraph:() => rawGraph,
  noteGet:key => fixtures.notes.find(item => item.slug === key),
  skillGet:name => fixtures.skills.find(item => item.name === name),
  paperGet:key => fixtures.papers.find(item => item.slug === key),
  isContentPathPrivate:(_type,key) => key==="Secret" || key.startsWith("Secret/"),
  inlineMarkdownAssets:body => body,browserFaviconTag:() => "",katexCssForExport:() => "",
  browserNoteTodo:body => body,resolveNoteSlugFromPath:target => target.replace(/\.md$/,""),
};
vm.createContext(context);
for(const [startMarker,endMarker] of [
  ["function publicContentPath(","function publicContentIdentity("],
  ["function markdownPreviewPath(","async function openLiveMarkdownPreview("],
  ["function outsideCode(","function extractNoteLinks("],
  ["function buildStandaloneNoteHtml(","// Cache the self-contained KaTeX CSS"],
]) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker,start);
  assert(start >= 0 && end > start);
  vm.runInContext(ts.transpile(source.slice(start,end)),context);
}
async function main() {
  const publicHtml = context.liveMarkdownHtml("notes/Public/Note",{});
  assert.doesNotMatch(publicHtml,/PRIVATE_|Secret|citationCount":99/);
  assert.match(publicHtml,/"citationCount":1/);
  const originalTodo = context.browserNoteTodo;
  const boardSnapshot = {items:[],documentKind:"todo-board"};
  context.noteWorkItemsRead = () => boardSnapshot;
  context.browserNoteTodo = (...args) => { assert.strictEqual(args[5],boardSnapshot); return args[0]; };
  fixtures.notes[0].documentKind = "todo-board";
  context.liveMarkdownHtml("notes/Public/Note",{});
  delete fixtures.notes[0].documentKind;
  context.browserNoteTodo = originalTodo;
  const record = (id,title,extra = {}) => ({
    id,title,goal:"Authoritative sidecar goal",scope:"Independent Board",
    acceptance:["Authoritative result only"],state:"Planning",evidence:[],...extra,
  });
  const historical = record("historical-task","HISTORICAL_MARKDOWN_TASK");
  const historicalMarkdown = `# HISTORICAL_MARKDOWN_DESCRIPTION\n\n- [ ] HISTORICAL_CHECKBOX_TASK\n\n~~~pkm-work-item\n${JSON.stringify(historical)}\n~~~`;
  const snapshots = new Map([
    ["Public/Board",{digest:"authoritative-board-digest",items:[
      record("board-story","Authoritative Board story",{kind:"UserStory",storyStatus:"confirmed"}),
      record("board-task","Authoritative Board task",{parentId:"board-story",state:"WIP",ownerId:"user:local"}),
    ]}],
    ["Public/EmptyBoard",{digest:"empty-board-digest",items:[]}],
    ["Secret/Board",{digest:"private-board-digest",items:[record("private-task","PRIVATE_BOARD_TASK")]}],
  ]);
  for (const slug of snapshots.keys()) fixtures.notes.push({
    slug,title:slug === "Secret/Board" ? "PRIVATE_BOARD_TITLE" : slug.split("/").pop(),
    documentKind:"todo-board",content:historicalMarkdown,
  });
  const snapshotReads = [];
  context.noteWorkItemsRead = slug => {
    snapshotReads.push(slug);
    assert(snapshots.has(slug), "only independent Board documents request a sidecar snapshot");
    return snapshots.get(slug);
  };
  context.browserNoteTodo = browserNoteTodo;
  const extensionContext = {extensionPath:root};
  const boardHtml = context.liveMarkdownHtml("notes/Public/Board",extensionContext);
  assert.match(boardHtml,/Authoritative Board task/);
  assert.doesNotMatch(boardHtml,/HISTORICAL_|PRIVATE_BOARD_|Secret\/Board/,"Board HTML omits obsolete Markdown and private Board records");
  const graph = {
    cytoscape:fs.readFileSync(path.join(root,"dist/webview/cytoscape.js")),
    forcegraph3d:fs.readFileSync(path.join(root,"dist/webview/forcegraph3d.js")),
  };
  const assetRoot = path.join(__dirname, `.browser-library-assets-${process.pid}`);
  fs.mkdirSync(path.join(assetRoot,"Public"),{recursive:true});
  fs.mkdirSync(path.join(assetRoot,"Secret"),{recursive:true});
  fs.writeFileSync(path.join(assetRoot,"Public","visible.png"),"public-asset");
  fs.writeFileSync(path.join(assetRoot,"Secret","hidden.png"),"PRIVATE_ASSET");
  fs.symlinkSync(path.join(assetRoot,"Secret","hidden.png"),path.join(assetRoot,"Public","alias.png"));
  const roots = [{prefix:"notes",root:assetRoot}];
  const publicServer = await startLiveMarkdownServer(roots, key => context.liveMarkdownHtml(key,extensionContext), {}, {graph,authorizePath:context.publicContentRouteAllowed});
  const token = "browser-library-private-test";
  const privateServer = await startLiveMarkdownServer(roots, key => context.liveMarkdownHtml(key,extensionContext,true), {}, {graph,accessToken:token});
  let browser;
  try {
    for (const route of ["/notes/Secret/Note.html","/papers/Secret/Paper.html","/papers/Secret/_assets/file.pdf","/_pkm/not-allowed.js"]) {
      assert.strictEqual((await fetch(publicServer.localBaseUrl+route)).status,404);
    }
    assert.strictEqual(await (await fetch(publicServer.localBaseUrl+"/notes/Public/visible.png")).text(),"public-asset");
    for (const route of ["/notes/Secret/hidden.png","/notes/Public/alias.png"]) {
      assert.strictEqual((await fetch(publicServer.localBaseUrl+route)).status,404,"private assets and public symlink aliases cannot cross the gateway");
    }
    for (const route of ["/_pkm/cytoscape.js","/_pkm/forcegraph3d.js","/notes/Secret/Note.html"]) {
      assert.strictEqual((await fetch(privateServer.localBaseUrl+route)).status,403);
    }
    assert.strictEqual((await fetch(publicServer.localBaseUrl+"/notes/Public/Note.html",{method:"POST"})).status,405);
    const spoof = await fetch(publicServer.localBaseUrl+`/notes/Public/Note.html?includePrivate=true&_pkm_token=${token}`);
    assert.doesNotMatch(await spoof.text(),/PRIVATE_|Secret/);
    browser = await chromium.launch({headless:true,executablePath:process.env.PKM_CHROMIUM_EXECUTABLE || undefined});
    for (const width of [1440,390]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      const errors = [], writes = [];
      page.on("pageerror",error => errors.push(error.message));
      page.on("request",request => {if (!["GET","HEAD"].includes(request.method())) writes.push(request.url());});
      await page.goto(publicServer.localBaseUrl+"/notes/Public/Board.html");
      await page.waitForLoadState("networkidle");
      assert.strictEqual(await page.locator(".reader-access").innerText(),"Public");
      assert.strictEqual(await page.locator(".reader-access").getAttribute("data-access"),"public");
      assert.strictEqual(await page.locator(".reader-private-lock").count(),0,"public entry exposes no private content or locks");
      const badge = await page.locator(".reader-access").boundingBox();
      assert(badge.y+badge.height<=900&&badge.y>800,"access badge stays at the bottom of the navigation");
      const sidebarBox = await page.locator(".reader-sidebar").boundingBox();
      const toggleBox = await page.getByRole("button",{name:"Collapse navigation",exact:true}).boundingBox();
      assert(Math.abs(toggleBox.y+toggleBox.height/2-450)<1,"toggle is vertically centered on viewport");
      assert(Math.abs(toggleBox.x+toggleBox.width/2-sidebarBox.x-sidebarBox.width)<2,"toggle straddles sidebar edge");
      const articleWidth = (await page.locator(".wrap").boundingBox()).width;
      await page.getByRole("button",{name:"Collapse navigation",exact:true}).click();
      assert.strictEqual(await page.locator(".reader-sidebar nav").isVisible(),false);
      assert((await page.locator(".wrap").boundingBox()).width>articleWidth,"collapse gives space to article");
      await page.getByRole("button",{name:"Expand navigation",exact:true}).focus();
      await page.keyboard.press("Enter");
      assert.strictEqual(await page.locator(".reader-sidebar nav").isVisible(),true);
      assert.strictEqual(await page.getByRole("button",{name:"Collapse navigation",exact:true}).getAttribute("aria-expanded"),"true");
      assert.strictEqual(await page.locator('[data-note-view=board]').getAttribute("class").then(value => value.includes("active")),true);
      assert.strictEqual(await page.locator('[data-note-view=markdown]').count(),0);
      assert.strictEqual(await page.locator("#note-markdown").innerText(),"");
      assert.doesNotMatch(await page.content(),/HISTORICAL_|PRIVATE_BOARD_|Secret\/Board/);
      assert.strictEqual(await page.locator('[data-todo-open=board-task]').count(),1);
      assert.strictEqual(await page.locator('[data-todo-open=historical-task]').count(),0);
      assert.strictEqual(await page.locator("[data-todo-edit],[data-todo-action],[data-todo-new],[data-todo-worker-token]").count(),0);
      await page.locator('[data-todo-open=board-task]').dblclick();
      const dialog = page.getByRole("dialog",{name:"Work Item details"});
      await dialog.waitFor();
      assert.match(await dialog.innerText(),/Authoritative sidecar goal/);
      assert.match(await dialog.innerText(),/Authoritative result only/);
      assert.strictEqual(await dialog.locator("form").count(),0,"read-only Board modal has no editor");
      await page.keyboard.press("Escape");
      assert.strictEqual(await dialog.count(),0);
      await page.getByRole("tab",{name:"Skills",exact:true}).click();
      await page.getByRole("tab",{name:"Research",exact:true}).click();
      await page.getByRole("button",{name:"2D Graph",exact:true}).click();
      await page.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "2d");
      assert.match(await page.locator(".reader-graph-status").innerText(),/2 papers · 1 citations/);
      assert.strictEqual(await page.locator(".doc-title").innerText(),"Board","Library/Graph leaves the independent Board article intact");
      await page.locator('[data-todo-open=board-task]').dblclick();
      await dialog.waitFor();
      await dialog.getByRole("button",{name:"Close Work Item details"}).click();
      await page.locator('[data-note-view=table]').click();
      assert.strictEqual(await page.locator(".note-todo-table > tbody > tr").count(),1);
      await page.locator('[data-note-view=board]').click();
      assert.strictEqual(await page.locator('[data-todo-open=board-task]').count(),1);
      console.log(`Chromium ${width}px: authoritative Board HTTP page, read-only modal and Library/Graph coexist`);
      assert.strictEqual(await page.evaluate(() => typeof globalThis.vscode),"undefined");
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      await page.goto(publicServer.localBaseUrl+"/notes/Public/EmptyBoard.html");
      await page.waitForLoadState("networkidle");
      assert.strictEqual(await page.locator('[data-note-view=markdown]').count(),0);
      assert.strictEqual(await page.locator('[data-todo-open]').count(),0,"empty authoritative snapshot never falls back to Markdown tasks");
      assert.doesNotMatch(await page.content(),/HISTORICAL_|PRIVATE_BOARD_/);
      assert.deepStrictEqual(errors,[],"Board modal and Library/Graph scripts share the production page without collisions");
      assert.deepStrictEqual(writes,[]);
      await page.close();
    }
    const readsBeforeDenied = snapshotReads.length;
    assert.strictEqual((await fetch(publicServer.localBaseUrl+"/notes/Secret/Board.html")).status,404);
    assert.strictEqual(snapshotReads.length,readsBeforeDenied,"public route denies private Board before reading its snapshot");
    assert.strictEqual((await fetch(privateServer.localBaseUrl+"/notes/Secret/Board.html")).status,403);
    const privateBoard = await fetch(privateServer.localBaseUrl+`/notes/Secret/Board.html?_pkm_token=${token}`);
    assert.strictEqual(privateBoard.status,200);
    assert.match(await privateBoard.text(),/PRIVATE_BOARD_TASK/);
    for (const width of [1440,390]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      await page.goto(privateServer.localBaseUrl+`/notes/Public/Note.html?_pkm_token=${token}`);
      assert.strictEqual(await page.locator(".reader-access").innerText(),"Private","access mode follows the entry, not current document privacy");
      assert.strictEqual(await page.locator(".reader-access").getAttribute("title"),"Authenticated view: Public and Private knowledge");
      assert.strictEqual(await page.locator(".reader-access button,.reader-access a").count(),0);
      assert.strictEqual(await page.locator('#library-notes [data-folder="Secret"] > summary .reader-private-lock').count(),1);
      assert.strictEqual(await page.locator('#library-notes [data-folder="Secret/Nested"] > summary .reader-private-lock').count(),1,"nested folders inherit privacy");
      assert.strictEqual(await page.locator('#library-notes a[title="Secret/Note"] .reader-private-lock').count(),1);
      assert.strictEqual(await page.locator('#library-notes a[title="Secret/Nested/Note"] .reader-private-lock').count(),1);
      assert.strictEqual(await page.locator('#library-notes a[title="Public/Note"] .reader-private-lock').count(),0,"Public note remains unlocked in Private entry");
      assert.strictEqual(await page.locator('#library-notes [data-folder="Public"] > summary .reader-private-lock').count(),0);
      await page.close();
    }
    fixtures.notes.push(...Array.from({length:35},(_,index) => ({slug:`Public/Extra-${index}`,title:`Extra note ${index}`,content:"Long directory fixture"})));
    for (const width of [1440,390]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      const errors = [];
      page.on("pageerror",error => errors.push(error.message));
      await page.goto(publicServer.localBaseUrl+"/notes/Public/Note.html");
      await page.waitForLoadState("networkidle");
      assert.strictEqual(await page.getByRole("tab",{name:"Notes",exact:true}).getAttribute("aria-selected"),"true");
      await page.context().grantPermissions(["clipboard-read","clipboard-write"],{origin:publicServer.localBaseUrl});
      const folder = page.locator('#library-notes [data-folder="Public"] > summary');
      const note = page.locator('#library-notes a').filter({hasText:"A public note"});
      const folderWasOpen = await folder.evaluate(node=>node.parentElement.open);
      await folder.click({button:"right"});
      const menu = page.getByRole("menu",{name:"Library actions"});
      await menu.getByRole("menuitem",{name:"Copy path"}).click();
      assert.strictEqual(await page.evaluate(()=>navigator.clipboard.readText()),"pkm://notes/Public/");
      assert.strictEqual(await folder.evaluate(node=>node.parentElement.open),folderWasOpen,"right click must not toggle folder");
      await note.click({button:"right"});
      await menu.getByRole("menuitem",{name:"Copy path"}).click();
      assert.strictEqual(await page.evaluate(()=>navigator.clipboard.readText()),"pkm://notes/Public/Note.md");
      assert.strictEqual(await page.locator(".doc-title").innerText(),"A public note","copy does not navigate");
      const encoded = page.locator('#library-notes a').filter({hasText:"Encoded note"});
      assert.strictEqual(await encoded.getAttribute("data-pkm-path"),"pkm://notes/Public/Space%20%26%20%E4%B8%AD%E6%96%87/Topic%20%231.md");
      await folder.focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor();
      const box = await menu.boundingBox();
      assert(box.x>=0&&box.x+box.width<=width,"context menu remains inside viewport");
      await page.keyboard.press("Escape");
      assert.strictEqual(await menu.isVisible(),false);
      await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new Error("Permission denied");};});
      await note.click({button:"right"});
      await menu.getByRole("menuitem",{name:"Copy path"}).click();
      assert.match(await page.locator(".reader-path-receipt").innerText(),/Copy failed: Permission denied.*pkm:\/\/notes\/Public\/Note.md/);
      await page.keyboard.press("Control+g");
      const go = page.getByRole("dialog",{name:"Go to PKM path"});
      await go.getByRole("textbox",{name:"PKM URL"}).fill("pkm://notes/Public/");
      await go.getByRole("button",{name:"Go",exact:true}).click();
      assert.strictEqual(await go.isVisible(),false);
      assert.strictEqual(await folder.evaluate(node=>node.parentElement.open),true);
      assert.strictEqual(await folder.evaluate(node=>document.activeElement===node),true);
      await page.keyboard.press("Control+g");
      await go.getByRole("textbox",{name:"PKM URL"}).fill("pkm://notes/Secret/Note.md");
      await go.getByRole("button",{name:"Go",exact:true}).click();
      assert.match(await go.getByRole("alert").innerText(),/unavailable/);
      await go.getByRole("textbox",{name:"PKM URL"}).fill("https://example.com");
      await go.getByRole("button",{name:"Go",exact:true}).click();
      assert.match(await go.getByRole("alert").innerText(),/PKM Library URL/);
      await go.getByRole("textbox",{name:"PKM URL"}).fill("pkm://notes/Public/Note.md");
      await go.getByRole("button",{name:"Go",exact:true}).click();
      await page.waitForLoadState("networkidle");
      assert.strictEqual(await page.locator(".doc-title").innerText(),"A public note");
      const article = await page.locator(".wrap").innerHTML();
      await page.locator(".reader-sidebar").evaluate(element => {element.scrollTop=220;});
      const noteScroll = await page.locator(".reader-sidebar").evaluate(element => element.scrollTop);
      const scrolledBadge = await page.locator(".reader-access").boundingBox();
      assert(scrolledBadge.y+scrolledBadge.height<=900&&scrolledBadge.y>800,"badge stays visible while a long Library scrolls");
      assert(Math.abs((await page.getByRole("button",{name:"Collapse navigation",exact:true}).boundingBox()).y-418)<1,"edge toggle stays fixed while sidebar scrolls");
      await page.getByRole("tab",{name:"Skills",exact:true}).click();
      assert.strictEqual(await page.getByRole("tab",{name:"Notes",exact:true}).getAttribute("aria-selected"),"false");
      await page.locator("#library-skills summary").click();
      await page.getByRole("tab",{name:"Notes",exact:true}).click();
      assert(Math.abs(await page.locator(".reader-sidebar").evaluate(element => element.scrollTop)-noteScroll) < 3,"each tab retains its directory scroll");
      await page.getByRole("tab",{name:"Skills",exact:true}).click();
      assert(await page.locator("#library-skills details").evaluate(element => element.open));
      await page.getByRole("tab",{name:"Research",exact:true}).click();
      await page.getByRole("button",{name:"2D Graph",exact:true}).click();
      await page.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "2d");
      assert(await page.locator(".reader-graph-canvas canvas").count() > 0);
      assert.match(await page.locator(".reader-graph-status").innerText(),/2 papers · 1 citations/);
      await page.getByRole("tab",{name:"Notes",exact:true}).click();
      await page.getByRole("tab",{name:"Research",exact:true}).click();
      assert.strictEqual(await page.getByRole("button",{name:"2D Graph",exact:true}).getAttribute("aria-pressed"),"true");
      await page.getByRole("button",{name:"3D Graph",exact:true}).click();
      await page.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "3d" || document.querySelector(".reader-graph-status").textContent.includes("WebGL unavailable"));
      if(await page.locator(".reader-graph-canvas").getAttribute("data-mode") !== "3d") {
        assert.match(await page.locator(".reader-graph-status").innerText(),/3D graph \/ WebGL unavailable:/);
        console.log(`Chromium ${width}px: explicit WebGL-unavailable fallback`);
      } else {
        assert(await page.locator(".reader-graph-canvas canvas").count() > 0);
        console.log(`Chromium ${width}px: real ForceGraph3D WebGL canvas`);
      }
      await page.getByRole("button",{name:"Directory",exact:true}).click();
      assert.strictEqual(await page.locator(".wrap").innerHTML(),article,"tabs and graph controls cannot replace the article");
      await page.locator("#library-papers summary").click();
      await page.locator("#library-papers a").filter({hasText:"Root paper"}).click();
      assert.strictEqual(await page.getByRole("tab",{name:"Research",exact:true}).getAttribute("aria-selected"),"true","new article selects its own kind");
      assert.strictEqual(await page.locator(".doc-title").innerText(),"Root paper");
      await page.getByRole("button",{name:"2D Graph",exact:true}).click();
      await page.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "2d");
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "2d");
      assert.strictEqual(await page.getByRole("button",{name:"2D Graph",exact:true}).getAttribute("aria-pressed"),"true","Research view survives reload");
      assert(await page.locator("#library-skills details").evaluate(element => element.open),"tab folder state survives navigation/reload");
      assert.deepStrictEqual(errors,[]);
      await page.close();
    }
    const privatePage = await browser.newPage();
    await privatePage.goto(privateServer.localBaseUrl+`/notes/Secret/Note.html?_pkm_token=${token}`);
    await privatePage.getByRole("tab",{name:"Research",exact:true}).click();
    await privatePage.getByRole("button",{name:"2D Graph",exact:true}).click();
    await privatePage.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "2d");
    assert.match(await privatePage.locator(".reader-graph-status").innerText(),/3 papers · 2 citations/);
    await privatePage.goto(publicServer.localBaseUrl+"/notes/Public/Note.html");
    assert.doesNotMatch(await privatePage.content(),/PRIVATE_|Secret/);
    await privatePage.close();
    const noWebGL = await browser.newPage();
    await noWebGL.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type,...args) {
        return type.startsWith("webgl") ? null : getContext.call(this,type,...args);
      };
    });
    await noWebGL.goto(publicServer.localBaseUrl+"/papers/Public/Root.html");
    await noWebGL.getByRole("button",{name:"3D Graph",exact:true}).click();
    await noWebGL.waitForFunction(() => document.querySelector(".reader-graph-status").textContent.includes("WebGL unavailable"));
    await noWebGL.getByRole("button",{name:"2D Graph",exact:true}).click();
    await noWebGL.waitForFunction(() => document.querySelector(".reader-graph-canvas").dataset.mode === "2d");
    await noWebGL.close();
    console.log("PASS browser Library tabs, directory, real Cytoscape/3D-or-WebGL, state, article isolation, public/private data/assets and read-only routes");
  } finally {
    await browser?.close();
    await Promise.all([publicServer,privateServer].map(({server}) => new Promise(resolve => server.close(resolve))));
    fs.rmSync(assetRoot,{recursive:true,force:true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
