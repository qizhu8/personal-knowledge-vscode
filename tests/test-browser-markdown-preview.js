#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { spawn } = require("child_process");

const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const branding = fs.readFileSync(path.join(__dirname, "..", "src", "browser-branding.ts"), "utf8");
const panel = fs.readFileSync(path.join(__dirname, "..", "dist", "webview", "panel.js"), "utf8");
const chatBrowser = fs.readFileSync(path.join(__dirname, "..", "src", "chatroom-browser.ts"), "utf8");
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
assert.match(extension, /Private content has no public stable link/);
assert.match(panel, /const stableKey = type === 'skill' \? \[category, key\]\.filter\(Boolean\)\.join\('\/'\) : key/,
  "Skill links must retain their category for routing and privacy checks");
assert.match(panel, /copyPublicContentLink/);
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
const readerContext = {
  noteList:() => noteFixtures, skillList:() => skillFixtures,
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
assert.doesNotMatch(publicReader, /Secret|Hush|Hidden skill|Private note body|Private skill body/, "private titles, paths and bodies never enter a public page or navigation payload");
assert.match(publicReader, /Cross-link/);
const beforeDeniedRead = readItems.length;
assert.strictEqual(readerContext.liveMarkdownHtml("notes/Secret/Hush", {}), undefined);
assert.strictEqual(readerContext.liveMarkdownHtml("skills/Secret/Hidden skill", {}), undefined);
assert.strictEqual(readItems.length, beforeDeniedRead, "private paths are denied before document reads");
const privateReader = readerContext.liveMarkdownHtml("notes/Secret/Hush", {}, true);
assert.match(privateReader, /Hush private note/);
assert.match(privateReader, /Hidden skill/);
assert.match(privateReader, /Visible note &lt;safe&gt;/);
assert.match(readerContext.liveMarkdownHtml("notes/Public/Visible", {}, true), /href="\/notes\/Secret\/Hush\.html"/, "navigating to public content from a private preview preserves its all-content scope");
const originalSkillGet = readerContext.skillGet;
readerContext.skillGet = () => ({...skillFixtures[1], name:skillFixtures[0].name});
assert.strictEqual(readerContext.liveMarkdownHtml("skills/Public/Visible skill", {}), undefined, "a duplicate Skill name cannot route public content to a private file");
readerContext.skillGet = originalSkillGet;

async function testReaderNavigationNetwork() {
  const { startLiveMarkdownServer } = require("../dist/live-note-server");
  const publicServer = await startLiveMarkdownServer([], key => readerContext.liveMarkdownHtml(key, {}), {}, {
    authorizePath:readerContext.publicContentRouteAllowed,
  });
  const token = "reader-navigation-test-token";
  const privateServer = await startLiveMarkdownServer([], key => readerContext.liveMarkdownHtml(key, {}, true), {}, {accessToken:token});
  try {
    const publicResponse = await fetch(`${publicServer.localBaseUrl}/notes/Public/Visible.html`);
    assert.strictEqual(publicResponse.status, 200);
    assert.doesNotMatch(await publicResponse.text(), /Secret|Hush|Hidden skill/);
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
        assert nav.locator('a').count() == 2
        assert nav.locator('[aria-current=page]').get_attribute('title') == 'Public/Visible'
        search = nav.get_by_role('searchbox')
        search.fill('Hidden')
        assert nav.locator('a:visible').count() == 0
        search.fill('Visible skill')
        nav.locator('a:visible').click()
        assert page.locator('.doc-title').inner_text() == 'Visible skill'
        assert page.locator('.reader-sidebar a').count() == 2
        page.goto(os.environ['PKM_READER_PRIVATE_URL'] + '/notes/Secret/Hush.html?_pkm_token=' + os.environ['PKM_READER_TEST_TOKEN'])
        assert page.locator('.reader-sidebar a').count() == 4
        page.locator('.reader-sidebar a[title="Public/Visible"]').click()
        assert page.locator('.reader-sidebar a').count() == 4
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
            assert 0 <= article_box['y'] - sidebar_box['y'] - sidebar_box['height'] <= 24, 'Mobile article must follow navigation without overlap or an artificial gap'
            page.locator('.reader-sidebar summary').click()
            assert not page.locator('.reader-sidebar nav').is_visible()
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
  const { startLiveMarkdownServer } = require("../dist/live-note-server");
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

testProtectedNetworkPreview().then(testReaderNavigationNetwork).then(() => {
  console.log("browser Markdown preview test: wide layout and protected network access OK");
}).catch(error => { console.error(error); process.exitCode = 1; });