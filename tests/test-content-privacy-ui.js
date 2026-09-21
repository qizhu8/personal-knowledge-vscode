#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const panel = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const css = fs.readFileSync(path.join(root, "dist", "webview", "panel.css"), "utf8");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");

assert.match(panel, /function privacyInherited\(path\)/);
assert.match(panel, /function privacyLock\(isPrivate\)/);
assert.match(panel, /function privacyDivider\(\)/);
assert.match(panel, /Number\(privacyInherited\(\[a\]\)\) - Number\(privacyInherited\(\[b\]\)\)/,
  "public top-level CatTree folders must sort before private folders");
assert.match(panel, /path\.length === 0 && privacyInherited\(\[name\]\)[\s\S]*?privacyDivider\(\)/,
  "the CatTree must insert a divider before its private top-level folders");
assert.doesNotMatch(panel, /function privacyLock\(isPrivate\)[^\n]*🔒/,
  "CatTree privacy locks must not use a colored emoji");
assert.match(panel, /privacyLock\(privacyInherited\(path\.concat\(name\)\)\)/,
  "every inherited CatTree subfolder must display the lock");
for (const area of ["skills", "notes", "papers", "prompts", "packages", "scripts"]) {
  assert.match(panel, new RegExp(`appendPrivacyMenu\\(items, '${area}'`), `${area} top-level CatTree menu must expose privacy`);
}
assert.match(panel, /parts\.length !== 1/,
  "subfolders must inherit privacy rather than expose an override");
assert.match(panel, /ask\('contentSetPrivacy'/);
assert.match(panel, /privacyLock\(r\.isPrivate\)/);
assert.match(panel, /privacyLock\(p\.isPrivate\)/);
assert.match(panel, /buildCatTree\(groups\[g\], r => r\.category \|\| '\(uncategorized\)'/,
  "Paper privacy CatTree must use the physical category path rather than topic metadata");
assert.match(panel, /privacyLock\(data\.isPrivate\)/);
assert.match(panel, /privacyLock\(d\.isPrivate\)/);
assert.match(panel, /function serverPrivacyLock\(path\)/);
assert.match(panel, /serverPrivacyLock\(s\.category\)/);
assert.match(panel, /excluded from Subscription sharing and public links/);
assert.match(extension, /const inheritedPrivate = isContentItemPrivate\("servers", server\)/);
assert.match(extension, /`\$\{inheritedPrivate \? "🔒 " : ""\}\$\{server\.pinned \? "★ " : ""\}\$\{server\.name\}`/,
  "private Server items must retain their inherited lock in Navigation");
assert.match(panel, /serverGroupMenu\(event/);
assert.match(extension, /case "contentSetPrivacy"/);
assert.match(extension, /currentProjectStore\(\)\.list\(\), privateTopLevels: privateTopLevels\("recipes"\)/,
  "Recipe Library state must include its private top-level categories");
assert.match(extension, /type !== "recipes"/,
  "Recipe privacy must be accepted without adding Recipes to Subscription content types");
assert.match(panel, /function recipeFolderMenu\(event, category\)/);
assert.match(panel, /buildCatTree\(matchedRecipes, recipe => recipe\.category, '\(uncategorized\)'\)/);
assert.match(panel, /type:'recipes', topLevel, isPrivate:!isPrivate/);
assert.match(extension, /isPrivate: isContentItemPrivate/);
assert.match(extension, /privateTopLevels: privacyTopLevels/);
assert.match(extension, /command: "serverPrivacy"/);
assert.match(css, /\.content-private-lock/);
assert.match(panel, /content-private-lock codicon codicon-lock/,
  "private content should use the theme-aware VS Code lock icon");
assert.match(css, /\.tree-privacy-divider/);
assert.doesNotMatch(panel, /[➕＋] Create Sub(?:folder| Folder)…/);
assert.match(panel, /label: 'Create Subfolder…'/);
assert.match(panel, /class="tree-cat-add"[\s\S]*onclick="openCatFolderAddMenu\(event/,
  "every rendered Knowledge folder must expose an independent add button");
assert.match(panel, /function openCatFolderAddMenu\(event, area, category\)[\s\S]*event\.preventDefault\(\); event\.stopPropagation\(\)/,
  "the folder add button must not toggle its folder row");
assert.match(panel, /New \$\{itemLabel\}…[\s\S]*Create Subfolder…/,
  "the folder add menu must offer both a current-type document and a subfolder");
assert.match(extension, /area !== "skills" && area !== "notes" && area !== "papers"/,
  "Research must support physical subfolder creation");

console.log("content privacy UI test: grouped locks, folder add menus, and Research subfolders OK");