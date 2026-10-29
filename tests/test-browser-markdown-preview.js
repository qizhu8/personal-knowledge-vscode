#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { spawn } = require("child_process");

const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const branding = fs.readFileSync(path.join(__dirname, "..", "src", "ui/browser-branding.ts"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const chatBrowser = fs.readFileSync(path.join(__dirname, "..", "src", "chatroom/chatroom-browser.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const start = extension.indexOf("function buildStandaloneNoteHtml");
const end = extension.indexOf("// Cache the self-contained KaTeX CSS", start);
assert(start >= 0 && end > start, "standalone Markdown preview template must exist");
const preview = extension.slice(start, end);

assert.match(preview, /\.wrap\{width:calc\(100% - clamp\(32px,5vw,96px\)\)/,
  "browser Markdown preview must use the available desktop viewport width");
assert.doesNotMatch(preview, /\.wrap\{[^}]*max-width:820px/,
  "browser Markdown preview must not regress to a fixed narrow reading column");
assert.match(preview, /@media\(max-width:700px\)\{\.wrap\{width:100%;margin:0/,
  "browser Markdown preview must remain edge-to-edge and readable on narrow screens");
assert.match(preview, /@media print\{body\{background:#fff\}\.wrap\{border:none;box-shadow:none;margin:0;max-width:none\}\}/,
  "wide preview changes must preserve print layout");
assert.match(preview, /browserFaviconTag\(faviconHref\)/, "generated Markdown pages must select routed or embedded extension icons");
assert.match(branding, /function ensureBrowserFavicon\(/, "browser documents share one favicon injection helper");
assert.match(extension, /const brandedDocument = ensureBrowserFavicon\(doc\)/, "Open in Browser always applies shared branding");
assert.match(extension, /openExternal\(vscode\.Uri\.parse\(`http:\/\/\$\{externalUrlHost\(\)\}:\$\{port\}\//,
  "ephemeral browser previews must use the configured external hostname");
assert.match(extension, /function authorizeEphemeralBrowserRequest\(/,
  "hostname-bound ephemeral previews must require an access token");
assert.match(extension, /const cookieName = `pkm_ephemeral_preview_\$\{accessToken\.slice\(0, 12\)\}`/,
  "each ephemeral preview must use an instance-specific cookie");
assert.match(extension, /_pkm_token=\$\{accessToken\}/,
  "Open in Browser URLs must carry a high-entropy access token");
assert.doesNotMatch(extension, /vscode\.Uri\.parse\(`http:\/\/127\.0\.0\.1:\$\{port\}/,
  "Open in Browser must not expose a literal loopback IP");
assert.match(extension, /function publicContentPath[\s\S]{0,300}`\$\{kind\}s\/\$\{key\}`/);
assert.match(extension, /authorizePath: publicContentRouteAllowed/);
assert.match(extension, /!isContentPathPrivate\(match\[1\] as PrivacyContentType, match\[2\]\)/,
  "private content must be rejected before rendering or file reads");
assert.match(extension, /\.well-known\/pkm-content/);
assert.match(extension, /active\.protocol === "pkm-content:v1" && active\.storeId === identity\.storeId/,
  "another window serving the same store must be reused on the preferred port");
assert.doesNotMatch(extension, /Use \$\{fallback\} and save it as the new machine default/,
  "background singleton recovery must never prompt or change the stable port");
assert.match(extension, /owned by an unrelated service\. Choose another port in Config/,
  "a proven non-PKM owner must leave the stable port unchanged and direct explicit recovery");
assert.match(extension, /case "copyPublicContentLink"/);
assert.match(panel, /function copyDetailUrl\(\)/);
assert.match(panel, /onclick="copyDetailUrl\(\)" title="Copy PKM URL"/);
assert.doesNotMatch(panel, /ask\('copyPublicContentLink'/, "Content identity copying must not copy a browser gateway URL");
assert.match(panel, /setExternalLinkHost/);
assert.match(panel, /setContentGatewayPort/);
assert.match(chatBrowser, /browserFaviconTag\("\/favicon\.ico"\)/, "Chatroom browser pages must use the routed extension icon");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.externalLinkHost"].scope, "machine");
assert.strictEqual(manifest.contributes.configuration.properties["personalKnowledge.contentGatewayPort"].default, 39502);
assert.match(extension, /documentPath => liveMarkdownHtml\(documentPath, context, false\)/, "stable public pages retain a server-owned public scope");
assert.match(extension, /documentPath => liveMarkdownHtml\(documentPath, context, true\)/, "authenticated private previews retain all-content scope across navigation");

const noteFixtures = [
  {slug:"Public/Visible", title:"Visible note <safe>", content:"Public body [[Secret/Hush|Cross-link]]"},
  {slug:"Secret/Hush", title:"Hush private note", content:"Private note body"},
];
const skillFixtures = [
  {category:"Public", name:"Visible skill", content:"Public skill body"},
  {category:"Secret", name:"Hidden skill", content:"Private skill body"},
];
const readItems = [];
const paperFixtures = [
  {slug:"Public/Models/Dense", title:"Dense retrieval", content:"Research body"},
  {slug:"Secret/Research/Private", title:"Private research", content:"Private research body"},
];
const readerContext = {
  noteList:() => noteFixtures, skillList:() => skillFixtures, paperList:() => paperFixtures,
  paperGet:key => { readItems.push(key); return paperFixtures.find(paper => paper.slug === key); },
  noteGet:key => { readItems.push(key); return noteFixtures.find(note => note.slug === key); },
  skillGet:name => { readItems.push(name); return skillFixtures.find(skill => skill.name === name); },
  isContentPathPrivate:(_type, key) => key.startsWith("Secret/"),
  inlineMarkdownAssets:body => body, browserFaviconTag:() => "", katexCssForExport:() => "",
  resolveNoteSlugFromPath:target => target.replace(/\.md$/, ""),
  require:specifier => { assert.strictEqual(specifier, "./live-markdown"); return require("../dist/live-markdown"); },
};
vm.createContext(readerContext);
for (const [first, last] of [
  ["publicContentPath", "publicContentIdentity"],
  ["markdownPreviewPath", "openLiveMarkdownPreview"],
  ["outsideCode", "extractNoteLinks"],
  ["buildStandaloneNoteHtml", "// Cache the self-contained KaTeX CSS"],
]) {
  const sectionStart = extension.indexOf(`function ${first}(`);
  const sectionEnd = extension.indexOf(last.startsWith("//") ? last : `\nasync function ${last}(`, sectionStart);
  const syncEnd = extension.indexOf(`\nfunction ${last}(`, sectionStart);
  const boundary = sectionEnd < 0 ? syncEnd : syncEnd < 0 ? sectionEnd : Math.min(sectionEnd, syncEnd);
  assert(sectionStart >= 0 && boundary > sectionStart, `reader source slice ${first} must exist`);
  vm.runInContext(ts.transpile(extension.slice(sectionStart, boundary)), readerContext);
}
const publicReader = readerContext.liveMarkdownHtml("notes/Public/Visible", {});
assert.match(publicReader, /aria-label="Knowledge navigation"/);
assert.match(publicReader, /href="\/skills\/Public\/Visible%20skill\.html"/);
assert.match(publicReader, /Visible note &lt;safe&gt;/);
assert.match(publicReader, /aria-current="page"/);
assert.match(publicReader, /<h2>Research<\/h2>/);
assert.match(publicReader, /href="\/papers\/Public\/Models\/Dense\.html"/);
assert.match(publicReader, /class="reader-nav-folder" open><summary>Public<\/summary>/);
assert.doesNotMatch(publicReader, /Secret|Hush|Hidden skill|Private note body|Private skill body|Private research/, "private titles, paths and bodies never enter a public page or navigation payload");
const paperReader = readerContext.liveMarkdownHtml("papers/Public/Models/Dense", {});
assert.match(paperReader, /class="reader-nav-folder" open><summary>Models<\/summary>/);
assert.match(paperReader, /title="Public\/Models\/Dense" aria-current="page"/);
assert.match(publicReader, /Cross-link/);
const beforeDeniedRead = readItems.length;
assert.strictEqual(readerContext.liveMarkdownHtml("notes/Secret/Hush", {}), undefined);
assert.strictEqual(readerContext.liveMarkdownHtml("skills/Secret/Hidden skill", {}), undefined);
assert.strictEqual(readItems.length, beforeDeniedRead, "private paths are denied before document reads");
const privateReader = readerContext.liveMarkdownHtml("notes/Secret/Hush", {}, true);
assert.match(privateReader, /Hush private note/);
assert.match(privateReader, /Hidden skill/);
assert.match(privateReader, /Private research/);
assert.match(privateReader, /Visible note &lt;safe&gt;/);
assert.match(readerContext.liveMarkdownHtml("notes/Public/Visible", {}, true), /href="\/notes\/Secret\/Hush\.html"/, "navigating to public content from a private preview preserves its all-content scope");
const originalSkillGet = readerContext.skillGet;
readerContext.skillGet = () => ({...skillFixtures[1], name:skillFixtures[0].name});
assert.strictEqual(readerContext.liveMarkdownHtml("skills/Public/Visible skill", {}), undefined, "a duplicate Skill name cannot route public content to a private file");
readerContext.skillGet = originalSkillGet;

async function testReaderNavigationNetwork() {
  const { startLiveMarkdownServer } = require("../dist/knowledge/live-note-server");
  let browserNoteRevision = 0;
  const publicServer = await startLiveMarkdownServer([], key => {
    if (key === "notes/Public/__test_change") {
      browserNoteRevision++;
      noteFixtures[0].content = `Saved browser Note ${browserNoteRevision}\n\n` + Array(80).fill("A reading-position regression paragraph.").join("\n\n");
      return "changed";
    }
    if (key === "skills/Public/__test_change") {
      skillFixtures[0].content = "Saved browser Skill";
      return "changed";
    }
    return readerContext.liveMarkdownHtml(key, {});
  }, {}, {
    authorizePath:readerContext.publicContentRouteAllowed,
  });
  const token = "reader-navigation-test-token";
  const privateServer = await startLiveMarkdownServer([], key => readerContext.liveMarkdownHtml(key, {}, true), {}, {accessToken:token});
  try {
    const publicResponse = await fetch(`${publicServer.localBaseUrl}/notes/Public/Visible.html`);
    assert.strictEqual(publicResponse.status, 200);
    const initialVersion = publicResponse.headers.get("etag");
    assert(initialVersion);
    assert.doesNotMatch(await publicResponse.text(), /Secret|Hush|Hidden skill/);
    const unchanged = await fetch(`${publicServer.localBaseUrl}/notes/Public/Visible.html`, { method:"HEAD" });
    assert.strictEqual(unchanged.headers.get("etag"), initialVersion);
    assert.strictEqual(await unchanged.text(), "");
    const originalBody = noteFixtures[0].content;
    noteFixtures[0].content += "\nSaved local update\n";
    const changed = await fetch(`${publicServer.localBaseUrl}/notes/Public/Visible.html`, { method:"HEAD" });
    assert.notStrictEqual(changed.headers.get("etag"), initialVersion, "Saving a local Note changes the browser preview version");
    noteFixtures[0].content = originalBody;
    assert.strictEqual((await fetch(`${publicServer.localBaseUrl}/notes/Secret/Hush.html`, { method:"HEAD" })).status, 404);
    assert.strictEqual((await fetch(`${privateServer.localBaseUrl}/notes/Secret/Hush.html`, { method:"HEAD" })).status, 403);
    assert.strictEqual((await fetch(`${publicServer.localBaseUrl}/notes/Secret/Hush.html`)).status, 404);
    assert.strictEqual((await fetch(`${publicServer.localBaseUrl}/skills/Secret/Hidden%20skill.html`)).status, 404);
    assert.strictEqual((await fetch(`${privateServer.localBaseUrl}/notes/Secret/Hush.html`)).status, 403);
    const authorized = await fetch(`${privateServer.localBaseUrl}/notes/Secret/Hush.html?_pkm_token=${token}`);
    assert.strictEqual(authorized.status, 200);
    assert.match(await authorized.text(), /Hidden skill/);
    const cookie = authorized.headers.get("set-cookie").split(";", 1)[0];
    const continued = await fetch(`${privateServer.localBaseUrl}/notes/Public/Visible.html`, {headers:{Cookie:cookie}});
    assert.strictEqual(continued.status, 200);
    assert.match(await continued.text(), /Hidden skill/, "authenticated navigation keeps the initial private-entry scope");
    const publicWithPrivateCookie = await fetch(`${publicServer.localBaseUrl}/notes/Public/Visible.html?includePrivate=true&_pkm_token=${token}`, {headers:{Cookie:cookie}});
    assert.doesNotMatch(await publicWithPrivateCookie.text(), /Secret|Hush|Hidden skill/, "private cookies and caller-controlled query parameters cannot broaden the public service's scope");
    if (process.env.PKM_READER_BROWSER_TEST === "1") {
      const code = `import os
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('PKM_CHROMIUM_EXECUTABLE') or None)
    for width in [1440, 390]:
        page = browser.new_page(viewport={'width':width, 'height':900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(os.environ['PKM_READER_PUBLIC_URL'] + '/notes/Public/Visible.html')
        nav = page.locator('.reader-sidebar')
        assert nav.locator('a').count() == 3
        assert nav.locator('[aria-current=page]').get_attribute('title') == 'Public/Visible'
        search = nav.get_by_role('searchbox')
        assert not search.is_visible(), 'Find must start hidden'
        page.keyboard.press('Control+f')
        assert search.is_visible()
        research = nav.locator('.reader-nav-group').filter(has=page.get_by_role('heading', name='Research', exact=True))
        assert not research.locator('a').is_visible()
        search.fill('Dense')
        assert research.locator('a').is_visible()
        search.fill('')
        assert not research.locator('a').is_visible(), 'Clearing search restores collapsed folders'
        page.keyboard.press('Escape')
        assert not search.is_visible(), 'Escape closes the floating finder'
        page.keyboard.press('Control+f')
        search.fill('Hidden')
        assert nav.locator('a:visible').count() == 0
        search.fill('Visible skill')
        nav.locator('a:visible').click()
        assert page.locator('.doc-title').inner_text() == 'Visible skill'
        assert page.locator('.reader-sidebar a').count() == 3
        if width == 1440:
          page.goto(os.environ['PKM_READER_PUBLIC_URL'] + '/notes/Public/Visible.html')
          page.evaluate("fetch('/notes/Public/__test_change.html')")
          page.wait_for_function("document.querySelector('.prose')?.textContent.includes('Saved browser Note 1')")
          page.evaluate('scrollTo(0, 300)')
          page.evaluate("fetch('/notes/Public/__test_change.html')")
          page.wait_for_function("document.querySelector('.prose')?.textContent.includes('Saved browser Note 2')")
          page.wait_for_function('scrollY >= 280')
          page.goto(os.environ['PKM_READER_PUBLIC_URL'] + '/skills/Public/Visible%20skill.html')
          page.evaluate("fetch('/skills/Public/__test_change.html')")
          page.wait_for_function("document.querySelector('.prose')?.textContent.includes('Saved browser Skill')")
          page.clock.install()
          page.evaluate("const prose=document.querySelector('.prose');prose.contentEditable='true';prose.textContent='Unsaved browser draft';prose.dispatchEvent(new Event('input',{bubbles:true}))")
          page.evaluate("fetch('/skills/Public/__test_change.html')")
          page.clock.fast_forward(6000)
          assert page.locator('.prose').inner_text() == 'Unsaved browser draft', 'Automatic refresh must preserve an unsaved browser edit'
        page.goto(os.environ['PKM_READER_PRIVATE_URL'] + '/notes/Secret/Hush.html?_pkm_token=' + os.environ['PKM_READER_TEST_TOKEN'])
        assert page.locator('.reader-sidebar a').count() == 6
        page.keyboard.press('Control+f')
        page.get_by_role('searchbox').fill('Public/Visible')
        page.locator('.reader-sidebar a[title="Public/Visible"]').click()
        assert page.locator('.reader-sidebar a').count() == 6
        assert page.locator('.reader-sidebar a[title="Secret/Hush"]').count() == 1
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        destination = os.environ.get('PKM_READER_SCREENSHOT_DIR')
        if destination:
            Path(destination).mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(Path(destination) / ('reader-' + str(width) + '.png')))
        if width == 390:
            sidebar_box = page.locator('.reader-sidebar').bounding_box()
            article_box = page.locator('.wrap').bounding_box()
            assert abs(article_box['y'] - sidebar_box['y']) <= 1, 'Mobile reader stays side by side'
            assert article_box['x'] >= sidebar_box['x'] + sidebar_box['width'] - 1, 'Article must not overlap navigation'
            expanded_width = article_box['width']
            page.locator('.reader-sidebar > details > summary').click()
            assert not page.locator('.reader-sidebar nav').is_visible()
            assert page.locator('.wrap').bounding_box()['width'] > expanded_width, 'Collapsing navigation returns its width to the article'
        page.close()
    browser.close()
print('Reader browser privacy/navigation tests passed')`;
      await new Promise((resolve, reject) => {
        const child = spawn(process.env.PYTHON || "python", ["-c", code], {stdio:"inherit", env:{...process.env,
          PKM_READER_PUBLIC_URL:publicServer.localBaseUrl, PKM_READER_PRIVATE_URL:privateServer.localBaseUrl, PKM_READER_TEST_TOKEN:token}});
        child.once("error", reject);
        child.once("exit", exitCode => exitCode === 0 ? resolve() : reject(new Error(`Reader browser test exited with ${exitCode}`)));
      });
    }
  } finally {
    await Promise.all([publicServer, privateServer].map(started => new Promise(resolve => started.server.close(resolve))));
  }
}

async function testProtectedNetworkPreview() {
  const { startLiveMarkdownServer } = require("../dist/knowledge/live-note-server");
  const token = "test-preview-token";
  const started = await startLiveMarkdownServer([], key => key === "sample" ? "<h1>Sample</h1>" : undefined, {}, {
    listenHost: "127.0.0.1",
    accessToken: token,
  });
  try {
    assert.strictEqual((await fetch(`${started.localBaseUrl}/sample.html`)).status, 403,
      "network preview must reject requests without its access token");
    const authorized = await fetch(`${started.localBaseUrl}/sample.html?_pkm_token=${token}`);
    assert.strictEqual(authorized.status, 200);
    const cookie = authorized.headers.get("set-cookie");
    assert(cookie?.includes("HttpOnly") && cookie.includes("SameSite=Strict"));
    const continued = await fetch(`${started.localBaseUrl}/sample.html`, { headers: { Cookie: cookie.split(";", 1)[0] } });
    assert.strictEqual(continued.status, 200, "authorized preview navigation must continue through its scoped cookie");
  } finally {
    await new Promise(resolve => started.server.close(resolve));
  }

  const publicGateway = await startLiveMarkdownServer([], key => `<h1>${key}</h1>`, {}, {
    listenHost: "127.0.0.1",
    authorizePath: pathname => !pathname.includes("private"),
    identity: { storeId: "test-store", version: "1" },
    favicon: Buffer.from("test-png"),
  });
  try {
    const identity = await (await fetch(`${publicGateway.localBaseUrl}/.well-known/pkm-content`)).json();
    assert.deepStrictEqual(identity, { protocol: "pkm-content:v1", storeId: "test-store", version: "1" });
    assert.strictEqual((await fetch(`${publicGateway.localBaseUrl}/public.html`)).status, 200);
    assert.strictEqual((await fetch(`${publicGateway.localBaseUrl}/private.html`)).status, 404,
      "private content must be indistinguishable from a missing public path");
    const favicon = await fetch(`${publicGateway.localBaseUrl}/favicon.ico`);
    assert.strictEqual(favicon.status, 200);
    assert.strictEqual(favicon.headers.get("content-type"), "image/png");
    assert.strictEqual(Buffer.from(await favicon.arrayBuffer()).toString(), "test-png");
  } finally {
    await new Promise(resolve => publicGateway.server.close(resolve));
  }
}

async function testBrowserMermaidRendering() {
  const { chromium } = require("playwright");
  const { renderMarkdown } = require("../dist/live-markdown");
  const { startLiveMarkdownServer } = require("../dist/knowledge/live-note-server");
  const directory = path.join(__dirname, "../dist/webview");
  const mermaid = { library:fs.readFileSync(path.join(directory, "mermaid.js")), renderer:fs.readFileSync(path.join(directory, "standalone-mermaid.js")) };
  const browser = await chromium.launch({ headless:true });
  let publicServer, privateServer;
  try {
    let diagrams = [
      "mindmap\n  root((Weekly overview))\n    Source monitoring\n      Sample by language\n    Campaign labeling\n      Quality metrics",
      'flowchart TD\n  A["Source samples<br/>Language and quality"] --> B["Shared labeling"]',
      'flowchart LR\n  A["Campaign and asset identities"] --> B["Enrich account and channel"] --> C["Label and aggregate quality metrics"]',
    ];
    if (process.env.PKM_MERMAID_LIVE_URL) {
      const source = await browser.newPage();
      await source.goto(process.env.PKM_MERMAID_LIVE_URL);
      diagrams = await source.locator("pre code.mermaid, pre code.language-mermaid").allTextContents();
      assert(diagrams.length > 0, "live reproduction must include diagram sources");
      await source.close();
    }
    const invalid = "flowchart TD\n  A[Unclosed";
    const fenced = text => "```mermaid\n" + text + "\n```";
    const columns = '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">\n\n'
      + diagrams.slice(0, 2).map(text => '<div style="min-width:0">\n\n' + fenced(text) + '\n\n</div>').join('\n\n')
      + '\n\n</div>';
    const markdown = columns + '\n\n' + [...diagrams.slice(2), invalid].map(fenced).join("\n\n") + '\n\n```javascript\nconst ordinary = "not a diagram";\n```\n\n![Browser image](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)';
    const html = readerContext.buildStandaloneNoteHtml({ title:"Diagram regression", bodyHtml:renderMarkdown(markdown) });
    const render = key => ["sample", "notes/sample", "skills/sample"].includes(key) ? html : key === "plain" ? readerContext.buildStandaloneNoteHtml({bodyHtml:"<p>No diagrams</p>"}) : undefined;
    publicServer = await startLiveMarkdownServer([], render, {}, { mermaid, authorizePath: pathname => ["/sample.html", "/plain.html", "/notes/sample.html", "/skills/sample.html"].includes(pathname) });
    privateServer = await startLiveMarkdownServer([], render, {}, { mermaid, accessToken:"diagram-test-token" });
    const response = await fetch(publicServer.localBaseUrl + "/sample.html");
    const document = await response.text();
    assert.match(document, /<script defer src="\/_pkm\/mermaid\.js\?v=[a-f0-9]{64}"/);
    assert.doesNotMatch(await (await fetch(publicServer.localBaseUrl + "/plain.html")).text(), /src="\/_pkm\/mermaid/);
    assert.strictEqual((await fetch(privateServer.localBaseUrl + "/_pkm/mermaid.js")).status, 403);
    assert.strictEqual((await fetch(publicServer.localBaseUrl + "/_pkm/settings.json")).status, 404);
    const asset = await fetch(publicServer.localBaseUrl + "/_pkm/mermaid-renderer.js");
    assert.strictEqual(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.strictEqual(asset.headers.get("x-content-type-options"), "nosniff");
    for (const width of [1440, 390]) {
      const page = await browser.newPage({viewport:{width, height:900}});
      const errors = [];
      page.on("pageerror", error => errors.push(String(error)));
      const requests = [];
      page.on("request", request => requests.push(request.url()));
      await page.goto(publicServer.localBaseUrl + "/sample.html");
      await page.evaluate(() => globalThis.pkmMermaidReady);
      assert.strictEqual(await page.locator(".mermaid-diagram svg").count(), diagrams.length);
      assert.strictEqual(await page.locator('img[alt="Browser image"]').count(), 1);
      assert.strictEqual(await page.locator(".image-zoom").count(), 0, "ordinary browser images remain unchanged");
      assert.strictEqual(await page.locator(".mermaid-error[role=alert]").count(), 1);
      assert.strictEqual(await page.locator("code.mermaid").textContent(), invalid, "syntax errors preserve the original source");
      assert.match(await page.locator("code.language-javascript").textContent(), /const ordinary/);
      assert(await page.evaluate(() => [...document.querySelectorAll(".mermaid-diagram svg")].every(svg => svg.getBoundingClientRect().width > 0)));
      const diagram = page.locator(".mermaid-diagram").filter({ has:page.locator("svg") }).first();
      const diagramWidth = () => diagram.locator("svg").evaluate(svg => svg.getBoundingClientRect().width);
      const fittedWidth = await diagramWidth();
      const secondDiagram = page.locator(".mermaid-diagram svg").nth(1);
      const secondWidth = await secondDiagram.evaluate(svg => svg.getBoundingClientRect().width);
      const viewportWidth = await diagram.locator(".mermaid-viewport").evaluate(el => el.clientWidth);
      assert(fittedWidth <= viewportWidth + 1, "diagrams fit their container by default");
      await diagram.getByRole("button", { name:"Zoom in", exact:true }).click();
      assert(await diagramWidth() > fittedWidth, "zoom in increases rendered width");
      assert.strictEqual(await secondDiagram.evaluate(svg => svg.getBoundingClientRect().width), secondWidth,
        "side-by-side diagrams have independent zoom controls");
      await diagram.getByRole("button", { name:"Zoom out", exact:true }).click();
      assert(Math.abs(await diagramWidth() - fittedWidth) < 1, "zoom out reverses zoom in");
      await diagram.getByRole("button", { name:"Original diagram size", exact:true }).click();
      assert.strictEqual(await diagram.locator("output").textContent(), "100%");
      await diagram.locator(".mermaid-viewport").focus();
      await page.keyboard.press("-");
      assert.strictEqual(await diagram.locator("output").textContent(), "80%", "keyboard zoom is supported");
      await page.keyboard.press("f");
      assert(Math.abs(await diagramWidth() - fittedWidth) < 1, "keyboard fit restores fitted width");
      await page.setViewportSize({width:320, height:900});
      await page.waitForFunction(() => [...document.querySelectorAll(".mermaid-viewport")].every(el =>
        el.querySelector("svg").getBoundingClientRect().width <= el.clientWidth + 1));
      await diagram.getByRole("button", { name:"Original diagram size", exact:true }).click();
      await page.setViewportSize({width, height:900});
      assert.strictEqual(await diagram.locator("output").textContent(), "100%", "resize preserves manual zoom");
      await diagram.getByRole("button", { name:"Fit diagram to width", exact:true }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "large diagrams scroll in their own region, not across the whole page");
      assert(requests.every(url => url.startsWith(publicServer.localBaseUrl)), "diagram rendering must not depend on a CDN");
      assert.deepStrictEqual(errors, []);
      await page.close();
    }
    for (const kind of ["notes", "skills"]) {
      const page = await browser.newPage();
      await page.goto(`${publicServer.localBaseUrl}/${kind}/sample.html`);
      await page.evaluate(() => globalThis.pkmMermaidReady);
      assert.strictEqual(await page.locator(".mermaid-zoom-controls").count(), diagrams.length,
        `${kind} browser pages share diagram zoom controls`);
      await page.getByRole("button", {name:"View diagram fullscreen", exact:true}).first().click();
      const fullscreen = page.getByRole("dialog", {name:"Diagram full-screen view", exact:true});
      assert(await fullscreen.isVisible(), `${kind} browser diagrams open in fullscreen`);
      await page.keyboard.press("Escape");
      await fullscreen.waitFor({state:"detached"});
      await page.close();
    }
    const panelPage = await browser.newPage({viewport:{width:390, height:900}});
    const imageUri = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="blue"/></svg>');
    await panelPage.setContent('<div id="preview" style="width:300px"><a href="#original"><img alt="Linked asset"></a><pre><code class="language-mermaid">flowchart TD\nA --> B</code></pre></div>');
    await panelPage.addScriptTag({content:mermaid.library.toString()});
    await panelPage.addScriptTag({content:fs.readFileSync(path.join(__dirname, "../src/webview/components/media-zoom.js"), "utf8")});
    const core = fs.readFileSync(path.join(__dirname, "../src/webview/panel/00-core.js"), "utf8");
    const renderSource = core.slice(core.indexOf("let _mermaidReady ="), core.indexOf("const esc ="));
    await panelPage.addScriptTag({content:"async function ensurePanelLibrary() {}\n" + renderSource});
    await panelPage.evaluate(async () => { await renderMermaid(document.getElementById("preview")); });
    await panelPage.locator("img").evaluate((image, src) => { image.src = src; }, imageUri);
    await panelPage.locator(".image-zoom output").waitFor();
    assert.strictEqual(await panelPage.locator(".media-zoom-controls").count(), 2,
      "built-in previews support both diagrams and asynchronously loaded images");
    const image = panelPage.locator(".image-zoom img");
    assert(await image.evaluate(el => el.getBoundingClientRect().width <= 301), "ordinary images fit their column");
    await panelPage.locator(".image-zoom").getByRole("button", {name:"Zoom in", exact:true}).click();
    assert(await image.evaluate(el => el.getBoundingClientRect().width > 301), "ordinary images can zoom in");
    assert.strictEqual(await panelPage.evaluate(() => location.hash), "", "linked image controls do not activate the link");
    await panelPage.locator(".image-zoom").getByRole("button", {name:"Original image size", exact:true}).click();
    assert.strictEqual(await panelPage.locator(".image-zoom output").textContent(), "100%");
    await panelPage.locator(".image-zoom").getByRole("button", {name:"Zoom out", exact:true}).focus();
    await panelPage.keyboard.press("Enter");
    assert.strictEqual(await panelPage.locator(".image-zoom output").textContent(), "80%", "image buttons work with keyboard activation");
    assert.strictEqual(await panelPage.evaluate(() => location.hash), "", "keyboard controls do not activate the parent image link");
    await panelPage.locator(".image-zoom").getByRole("button", {name:"View image fullscreen", exact:true}).click();
    assert(await panelPage.getByRole("dialog", {name:"Linked asset full-screen view", exact:true}).isVisible(),
      "linked images open in fullscreen without activating their link");
    await panelPage.getByRole("button", {name:"Exit fullscreen", exact:true}).click();
    await panelPage.locator(".image-zoom output").waitFor();
    assert.strictEqual(await panelPage.locator(".image-zoom output").textContent(), "80%", "image zoom is restored after fullscreen");
    await panelPage.evaluate(async () => {
      const root = document.getElementById("preview");
      await renderMermaid(root);
      const exported = document.createElement("div");
      exported.id = "exported";
      exported.innerHTML = '<img alt="Export image"><pre><code class="language-mermaid">flowchart TD\nA --> B</code></pre>';
      document.body.append(exported);
      await renderMermaid(exported, "default", false);
    });
    assert.strictEqual(await panelPage.locator("#preview .media-zoom-controls").count(), 2, "repeat renders do not duplicate controls");
    assert.strictEqual(await panelPage.locator("#exported svg").count(), 1);
    assert.strictEqual(await panelPage.locator("#exported .media-zoom-controls").count(), 0, "static exports omit controls");
    await panelPage.close();
    const authorized = await browser.newPage();
    await authorized.goto(privateServer.localBaseUrl + "/sample.html?_pkm_token=diagram-test-token");
    await authorized.evaluate(() => globalThis.pkmMermaidReady);
    assert.strictEqual(await authorized.locator(".mermaid-diagram svg").count(), diagrams.length, "private previews load local resources through their scoped cookie");
    await authorized.close();
    const missing = await browser.newPage();
    await missing.route("**/_pkm/mermaid.js?*", route => route.abort());
    await missing.goto(publicServer.localBaseUrl + "/sample.html");
    await missing.evaluate(() => globalThis.pkmMermaidReady);
    assert.strictEqual(await missing.locator(".mermaid-error").count(), diagrams.length + 1);
    assert.strictEqual(await missing.locator("code.mermaid").count(), diagrams.length + 1, "library failures retain source and show explicit errors");
    await missing.close();
  } finally {
    await browser.close();
    for (const running of [publicServer, privateServer]) if (running) await new Promise(resolve => running.server.close(resolve));
  }
}

async function testMediaZoomBoundaries() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({viewport:{width:390, height:900}});
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setContent('<main id="root" style="width:300px"><section id="hidden" style="display:none"><div id="diagram"><svg viewBox="0 0 1200 800"><rect width="1200" height="800"/></svg></div></section><img id="cached" alt="Cached image"><img id="broken" alt="Missing image"></main>');
    const imageUri = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"/>');
    await page.locator("#cached").evaluate((image, src) => { image.src = src; return image.decode(); }, imageUri);
    await page.route("https://image.test/missing.png", route => route.fulfill({status:404, body:"missing"}));
    await page.locator("#broken").evaluate(image => {
      return new Promise(resolve => {
        image.addEventListener("error", resolve, {once:true});
        image.src = "https://image.test/missing.png";
      });
    });
    await page.evaluate(() => {
      const NativeObserver = ResizeObserver;
      globalThis.observedMedia = new Set();
      globalThis.ResizeObserver = class extends NativeObserver {
        observe(element, options) { observedMedia.add(this); super.observe(element, options); }
        disconnect() { observedMedia.delete(this); super.disconnect(); }
      };
    });
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname, "../src/webview/components/media-zoom.js"), "utf8")});
    assert(await page.evaluate(() => [0, -1, NaN, Infinity].every(width => {
      try {
        PkmMediaZoom.attach(document.createElement("div"), document.createElement("img"), width, "Invalid");
        return false;
      } catch (error) {
        return /no usable width/.test(error.message);
      }
    })), "invalid media sizes fail explicitly");
    await page.evaluate(() => {
      const diagram = document.getElementById("diagram");
      PkmMediaZoom.attach(diagram, diagram.querySelector("svg"), 1200, "Diagram");
      PkmMediaZoom.renderImages(document.getElementById("root"));
      PkmMediaZoom.renderImages(document.getElementById("root"));
      document.getElementById("hidden").style.display = "block";
    });
    await page.waitForFunction(() => document.querySelector("#diagram svg").getBoundingClientRect().width >= 299);
    assert.strictEqual(await page.locator(".image-zoom").count(), 1, "cached images are initialized once; broken images are not replaced");
    assert.strictEqual(await page.locator("#broken").count(), 1, "broken image and its alt text remain visible to the reader");
    await page.locator("#broken").evaluate((image, src) => { image.src = src; return image.decode(); }, imageUri);
    await page.locator(".image-zoom").nth(1).waitFor();
    assert.strictEqual(await page.locator(".image-zoom").count(), 2, "a repaired image gains controls after loading");
    const diagram = page.locator("#diagram");
    await diagram.locator(".media-zoom-viewport").focus();
    await page.keyboard.press("Control+-");
    assert.strictEqual(await diagram.locator("output").textContent(), "25%", "browser modifier shortcuts are not intercepted");
    await page.keyboard.press("0");
    await page.keyboard.press("+");
    assert.strictEqual(await diagram.locator("output").textContent(), "125%", "keyboard zoom in works");
    await page.keyboard.press("0");
    assert.strictEqual(await diagram.locator("output").textContent(), "100%", "keyboard reset works");
    await diagram.getByRole("button", {name:"Zoom in", exact:true}).evaluate(button => { for (let i=0; i<80; i++) button.click(); });
    assert.strictEqual(await diagram.locator("output").textContent(), "400%", "maximum zoom is bounded");
    assert(await diagram.locator(".media-zoom-viewport").evaluate(el => el.scrollWidth > el.clientWidth && el.scrollHeight > el.clientHeight),
      "large diagrams scroll in both directions inside the viewport");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "zoom never widens the document");
    await page.emulateMedia({media:"print"});
    assert.strictEqual(await diagram.locator(".media-zoom-controls").isVisible(), false, "printing hides interactive controls");
    assert(await diagram.locator("svg").evaluate(el => el.getBoundingClientRect().width <= 301), "printing fits even a manually enlarged diagram");
    assert.strictEqual(await diagram.locator(".media-zoom-viewport").evaluate(el => getComputedStyle(el).maxHeight), "none",
      "printing does not crop tall diagrams");
    await page.emulateMedia({media:"screen"});
    await diagram.getByRole("button", {name:"Zoom out", exact:true}).evaluate(button => { for (let i=0; i<80; i++) button.click(); });
    assert.strictEqual(await diagram.locator("output").textContent(), "1%", "minimum zoom is bounded");
    await diagram.getByRole("button", {name:"Fit diagram to width", exact:true}).click();
    assert.strictEqual(await diagram.locator("output").textContent(), "25%");
    assert.strictEqual(await page.evaluate(() => observedMedia.size), 3);
    await page.evaluate(() => document.getElementById("root").remove());
    await page.waitForFunction(() => observedMedia.size === 0);
    assert.deepStrictEqual(errors, [], "hide/show, image recovery and teardown produce no browser errors");
    await page.close();
  } finally {
    await browser.close();
  }
}

async function testMediaZoomInteractions() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1000, height:800}});
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setContent('<main id="root" style="width:400px"><div id="diagram"><svg viewBox="0 0 1600 1600"><rect width="1600" height="1600" fill="#ddd"/><text x="400" y="350">Selectable label text</text><a href="#diagram-link"><rect x="400" y="400" width="100" height="100" fill="blue"/></a></svg></div></main><p style="height:1800px">Page scroll</p>');
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname, "../src/webview/components/media-zoom.js"), "utf8")});
    await page.evaluate(() => {
      const holder = document.getElementById("diagram");
      PkmMediaZoom.attach(holder, holder.querySelector("svg"), 1600, "Diagram");
    });
    const diagram = page.locator("#diagram");
    const viewport = diagram.locator(".media-zoom-viewport");
    const reset = diagram.getByRole("button", {name:"Original diagram size", exact:true});
    await reset.click();
    await viewport.evaluate(el => el.scrollTo(200, 200));
    const anchor = async () => viewport.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const svg = el.querySelector("svg").getBoundingClientRect();
      const x = rect.left + 120;
      const y = rect.top + 120;
      return {x, y, imageX:(x-svg.left)/svg.width, imageY:(y-svg.top)/svg.height};
    });
    for (const modifier of ["ctrlKey", "metaKey"]) {
      const before = await anchor();
      assert(await viewport.evaluate((el, args) => {
        const event = new WheelEvent("wheel", {bubbles:true, cancelable:true, deltaY:-100, clientX:args.x, clientY:args.y, [args.modifier]:true});
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }, {...before, modifier}), `${modifier} wheel is handled by diagram zoom`);
      const after = await anchor();
      assert(Math.abs(before.imageX-after.imageX) < 0.002 && Math.abs(before.imageY-after.imageY) < 0.002,
        "wheel zoom preserves the image point beneath the mouse");
    }
    const priorScale = await diagram.locator("output").textContent();
    assert.strictEqual(await viewport.evaluate(el => {
      const event = new WheelEvent("wheel", {bubbles:true, cancelable:true, deltaY:100});
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }), false, "ordinary wheel events are not intercepted");
    assert.strictEqual(await diagram.locator("output").textContent(), priorScale);
    const scrollBefore = await viewport.evaluate(el => el.scrollTop);
    const scrollBox = await viewport.boundingBox();
    await page.mouse.move(scrollBox.x+100, scrollBox.y+100);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(before => document.querySelector("#diagram .media-zoom-viewport").scrollTop > before, scrollBefore);
    assert.strictEqual(await diagram.locator("output").textContent(), priorScale, "ordinary wheel scrolling does not change zoom");
    for (const deltaMode of [1, 2]) {
      const before = await diagram.locator("svg").evaluate(el => el.getBoundingClientRect().width);
      await viewport.dispatchEvent("wheel", {ctrlKey:true, deltaMode, deltaY:1, clientX:150, clientY:150});
      assert(await diagram.locator("svg").evaluate(el => el.getBoundingClientRect().width) < before,
        "line and page wheel delta modes both zoom out");
    }
    await reset.click();
    await viewport.evaluate(el => el.scrollTo(200, 200));
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x+100, box.y+100);
    await page.mouse.down();
    await page.mouse.move(box.x+50, box.y+50, {steps:5});
    await page.mouse.up();
    const panned = await viewport.evaluate(el => ({left:el.scrollLeft, top:el.scrollTop}));
    assert.strictEqual(panned.left, 250);
    assert.strictEqual(panned.top, 250, "dragging non-text areas pans both axes");
    assert.strictEqual(await viewport.evaluate(el => el.classList.contains("media-panning")), false);
    const text = diagram.locator("text");
    await text.scrollIntoViewIfNeeded();
    const textBox = await text.boundingBox();
    const textScroll = await viewport.evaluate(el => [el.scrollLeft, el.scrollTop]);
    await page.mouse.move(textBox.x+2, textBox.y+textBox.height/2);
    await page.mouse.down();
    await page.mouse.move(textBox.x+textBox.width-2, textBox.y+textBox.height/2, {steps:12});
    await page.mouse.up();
    assert((await page.evaluate(() => getSelection().toString())).includes("label"), "diagram label text remains selectable");
    assert.deepStrictEqual(await viewport.evaluate(el => [el.scrollLeft, el.scrollTop]), textScroll, "selecting text does not pan");
    await diagram.locator("svg a rect").click();
    assert.strictEqual(await page.evaluate(() => location.hash), "#diagram-link", "diagram links retain normal click behavior");
    await page.evaluate(() => getSelection().removeAllRanges());
    await viewport.evaluate(el => el.scrollTo(200, 200));
    const saved = await viewport.evaluate(el => ({left:el.scrollLeft, top:el.scrollTop}));
    await diagram.getByRole("button", {name:"View diagram fullscreen", exact:true}).click();
    const dialog = page.getByRole("dialog", {name:"Diagram full-screen view", exact:true});
    assert(await dialog.isVisible());
    const bounds = await dialog.boundingBox();
    assert(bounds.width >= 999 && bounds.height >= 799, "fullscreen covers the available window, including webview-sized windows");
    assert.strictEqual(await dialog.locator("output").textContent(), "100%", "manual zoom survives entering fullscreen");
    for (let i=0; i<8; i++) {
      await page.keyboard.press("Tab");
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), "keyboard focus stays inside the fullscreen dialog");
    }
    await dialog.getByRole("button", {name:"Zoom in", exact:true}).click();
    await dialog.locator(".media-zoom-viewport").evaluate(el => el.scrollTo(500, 500));
    await page.keyboard.press("Escape");
    await dialog.waitFor({state:"detached"});
    assert.strictEqual(await diagram.locator("output").textContent(), "100%", "Escape restores original zoom");
    assert.deepStrictEqual(await viewport.evaluate(el => ({left:el.scrollLeft, top:el.scrollTop})), saved, "Escape restores scroll position");
    assert(await diagram.getByRole("button", {name:"View diagram fullscreen", exact:true}).evaluate(el => document.activeElement === el),
      "closing fullscreen returns keyboard focus to its button");
    await diagram.getByRole("button", {name:"Fit diagram to width", exact:true}).click();
    await diagram.getByRole("button", {name:"View diagram fullscreen", exact:true}).click();
    await page.waitForFunction(() => document.querySelector("dialog output")?.textContent !== "25%");
    await dialog.getByRole("button", {name:"Exit fullscreen", exact:true}).click();
    await dialog.waitFor({state:"detached"});
    assert.strictEqual(await diagram.locator("output").textContent(), "25%", "fullscreen restores fit mode");
    await page.locator("#root").evaluate(el => { el.style.width = "320px"; });
    await page.waitForFunction(() => document.querySelector("#diagram output").textContent === "20%");
    await diagram.getByRole("button", {name:"View diagram fullscreen", exact:true}).click();
    await page.locator("#root").evaluate(el => el.remove());
    await dialog.waitFor({state:"detached"});
    assert.strictEqual(await page.locator("dialog").count(), 0, "removing a preview also closes its fullscreen dialog");
    const imageUri = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"/>');
    await page.evaluate(async src => {
      const root = document.createElement("section");
      root.id = "picture";
      root.style.width = "400px";
      root.innerHTML = '<img alt="Panning image">';
      document.body.prepend(root);
      const image = root.querySelector("img");
      image.src = src;
      await image.decode();
      PkmMediaZoom.renderImages(root);
    }, imageUri);
    const picture = page.locator("#picture");
    await picture.getByRole("button", {name:"Original image size", exact:true}).click();
    const imageViewport = picture.locator(".media-zoom-viewport");
    await imageViewport.evaluate(el => el.scrollTo(200, 200));
    const imageBox = await imageViewport.boundingBox();
    await page.mouse.move(imageBox.x+150, imageBox.y+150);
    await page.mouse.down();
    await page.mouse.move(imageBox.x+110, imageBox.y+100, {steps:5});
    await page.mouse.up();
    assert.deepStrictEqual(await imageViewport.evaluate(el => [el.scrollLeft, el.scrollTop]), [240, 250],
      "ordinary enlarged images support dragging on both axes");
    await page.mouse.move(imageBox.x+150, imageBox.y+150);
    await page.mouse.down();
    await page.mouse.move(imageBox.x+120, imageBox.y+120, {steps:3});
    await imageViewport.dispatchEvent("pointercancel", {pointerId:1, pointerType:"mouse"});
    const cancelledPosition = await imageViewport.evaluate(el => [el.scrollLeft, el.scrollTop]);
    await page.mouse.move(imageBox.x+90, imageBox.y+90);
    await page.mouse.up();
    assert.deepStrictEqual(await imageViewport.evaluate(el => [el.scrollLeft, el.scrollTop]), cancelledPosition,
      "cancelling a gesture stops panning and releases pointer capture");
    assert.strictEqual(await imageViewport.evaluate(el => el.classList.contains("media-panning")), false);
    await picture.getByRole("button", {name:"Fit image to width", exact:true}).click();
    assert.strictEqual(await imageViewport.evaluate(el => el.classList.contains("media-can-pan")), false,
      "images that fit their viewport are not draggable");
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
}

testProtectedNetworkPreview().then(testReaderNavigationNetwork).then(testBrowserMermaidRendering).then(testMediaZoomBoundaries).then(testMediaZoomInteractions).then(() => {
  console.log("browser Markdown preview test: wide layout, protected access and local Mermaid rendering OK");
}).catch(error => { console.error(error); process.exitCode = 1; });