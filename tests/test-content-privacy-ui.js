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
assert.match(panel, /serverGroupMenu\(event/);
assert.match(extension, /case "contentSetPrivacy"/);
assert.match(extension, /isPrivate: isContentItemPrivate/);
assert.match(extension, /privateTopLevels: privacyTopLevels/);
assert.match(extension, /command: "serverPrivacy"/);
assert.match(css, /\.content-private-lock/);
assert.doesNotMatch(panel, /➕ Create Sub Folder/);
assert.match(panel, /＋ Create Subfolder…/);

console.log("content privacy UI test: inherited CatTree, leaf, detail, Server locks, top-level menus, and plain Subfolder icon OK");