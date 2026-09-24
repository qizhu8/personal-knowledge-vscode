#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

testProtectedNetworkPreview().then(() => {
  console.log("browser Markdown preview test: wide layout and protected network access OK");
}).catch(error => { console.error(error); process.exitCode = 1; });