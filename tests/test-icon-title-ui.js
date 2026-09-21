#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const codiconCss = fs.readFileSync(path.join(root, "dist", "webview", "codicon.css"), "utf8");

assert.strictEqual(typeof manifest.dependencies["@vscode/codicons"], "string");
assert.ok(fs.existsSync(path.join(root, "dist", "webview", "codicon.css")));
assert.ok(fs.existsSync(path.join(root, "dist", "webview", "codicon.ttf")));
assert.match(html, /href="%%CODICON_CSS%%"/);
assert.match(extension, /%%CODICON_CSS%%/);
assert.match(extension, /target\.iconPath = vscode\.Uri\.file\(path\.join\(context\.extensionPath, "resources", "brand-icon\.svg"\)\)/,
  "editor tabs must use the colorful brand icon");
assert.strictEqual(manifest.contributes.viewsContainers.activitybar[0].icon, "resources/sidebar-icon.svg",
  "Activity Bar navigation must retain a theme-colored monochrome icon");
const brandIcon = fs.readFileSync(path.join(root, "resources", "brand-icon.svg"), "utf8");
const sidebarIcon = fs.readFileSync(path.join(root, "resources", "sidebar-icon.svg"), "utf8");
assert.match(brandIcon, /#[0-9a-fA-F]{6}/, "the editor-tab brand icon must carry explicit color");
for (const role of ["wand", "star", "cauldron", "potion"]) {
  assert.match(brandIcon, new RegExp(`data-role=["']${role}["']`), `brand icon must include ${role}`);
}
assert.doesNotMatch(brandIcon, /data-role=["']book["']/, "the rejected book motif must not return");
assert.doesNotMatch(sidebarIcon, /#[0-9a-fA-F]{3,8}/, "the Activity Bar icon must not hard-code theme colors");
assert.match(sidebarIcon, /currentColor/, "the Activity Bar icon must follow VS Code foreground colors");
assert.match(sidebarIcon, /data-role=["']cauldron["']/, "the Activity Bar icon must use the approved cauldron");
assert.match(sidebarIcon, /data-role=["']smoke["'][^>]*stroke-width=["']\.75["']/, "the Activity Bar smoke must retain its fine outline");
assert.strictEqual((sidebarIcon.match(/<path /g) || []).length, 5, "the Activity Bar icon must contain three smoke wisps and two cauldron paths");
assert.doesNotMatch(sidebarIcon, /data-role=["'](?:wand|star|potion|flame)["']/, "the Activity Bar icon must remain a focused smoking cauldron");
assert.match(html, /knowledge-library-icon[^>]*[\s\S]{0,120}codicon-library/,
  "Knowledge must retain the original VS Code library icon");
for (const icon of ["academy-wand", "academy-witch-original", "academy-dials"]) {
  assert(html.includes(icon), `workspace rail must include ${icon}`);
}
assert.doesNotMatch(html, /academy-banner/, "the replaced Projects quest banner must not return");
assert.doesNotMatch(html, /academy-broom-rider/, "the rejected Projects line-art rider must not return");
assert.match(html, /academy-loading-sigil/);
assert.match(html, /loading-cauldron/);
assert.strictEqual((html.match(/class="loading-steam-(?:one|two|three)"/g) || []).length, 3,
  "the in-product brand animation must include three steam wisps");
assert.strictEqual((html.match(/class="loading-bubble loading-bubble-(?:one|two)"/g) || []).length, 2,
  "the in-product brand animation must include rolling potion bubbles");
assert.doesNotMatch(html, /<div class="loading-logo">📚<\/div>/);
const panelCss = fs.readFileSync(path.join(root, "src", "webview", "panel.css"), "utf8");
assert.match(panelCss, /@keyframes academySteamRise/);
assert.match(panelCss, /@keyframes academyPotionRoll/);
assert.match(panelCss, /@keyframes academyWitchFlight/);
assert.match(panelCss, /@keyframes academyWitchCape/);
assert.match(panelCss, /@media\(prefers-reduced-motion:reduce\)/,
  "academy motion must respect reduced-motion preferences");
assert.match(panelCss, /prefers-reduced-motion:reduce[^}]*loading-steam path[^}]*loading-bubble/,
  "cauldron motion must stop when reduced motion is requested");
assert.match(panelCss, /prefers-reduced-motion:reduce[^}]*witch-flight[^}]*witch-cape/,
  "Projects witch motion must stop when reduced motion is requested");
assert.doesNotMatch(extension, /iconPath = vscode\.Uri\.parse\([^\n]*📚/);
assert.match(panel, /const uiIcon = \(name, label = ''\)/);
assert.match(panel, /function setPanelTitle\(title\)/);
assert.match(panel, /vscode\.postMessage\(\{ command:'setPanelTitle', title:next \}\)/);
assert.match(panel, /setPanelTitle\(surfacePanelTitles\[state\.tab\]/);
assert.match(panel, /setPanelTitle\(detailPanelTitle\(data\)\)/);
for (const field of ["data.name", "data.title", "data.meta?.title", "data.file", "data.task", "data.path"]) {
  assert.ok(panel.includes(field), `detail title mapping must include ${field}`);
}
assert.match(extension, /case "setPanelTitle":[\s\S]{0,300}panel\.title = title/);
assert.match(extension, /replace\(\/\[\\r\\n\\t\]\+\/g, " "\)[\s\S]{0,80}slice\(0, 120\)/);

const availableIcons = new Set([...codiconCss.matchAll(/\.codicon-([a-z0-9-]+):before/g)].map(match => match[1]));
const referencedIcons = [...panel.matchAll(/uiIcon\(['"]([a-z0-9-]+)['"]/g)].map(match => match[1]);
assert.deepStrictEqual([...new Set(referencedIcons.filter(name => !availableIcons.has(name)))], [], "every uiIcon name must exist in the packaged Codicon font");
for (const legacyLabel of ["📂 Folder", "⚙ Settings", "🗑 Delete", "↻ Refresh", "💾 Save", "＋ Add Row", "✏️ Rename me"]) {
  assert.ok(!panel.includes(legacyLabel), `legacy product icon must not return: ${legacyLabel}`);
}

console.log("icon/title UI test: Codicons packaged and document-aware VS Code panel titles wired OK");
