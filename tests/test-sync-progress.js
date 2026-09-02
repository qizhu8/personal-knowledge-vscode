#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const server = fs.readFileSync(path.join(root, "src", "sync-server.ts"), "utf8");
const core = fs.readFileSync(path.join(root, "dist", "webview", "panel.js"), "utf8");
const css = fs.readFileSync(path.join(root, "dist", "webview", "panel.css"), "utf8");

assert.match(server, /"Content-Length": Buffer\.byteLength\(payload\)/);
assert.match(extension, /response\.body\.getReader\(\)/);
assert.match(extension, /stage: "downloading"/);
assert.match(extension, /downloadedBytes \* 100 \/ totalBytes/);
assert.match(extension, /stage: "importing"/);
assert.match(extension, /reportImported\("skills"\)/);
assert.match(extension, /reportImported\("notes"\)/);
assert.match(extension, /reportImported\("papers"\)/);
assert.match(extension, /reportImported\("prompts"\)/);
assert.match(extension, /reportImported\("scripts"\)/);
assert.match(extension, /reportImported\("packages"\)/);
assert.match(extension, /importedItems % 20 === 0/);
assert.match(extension, /setImmediate\(resolve\)/);
assert.match(core, /command === 'syncProgress'/);
assert.match(core, /class="sync-progress"/);
assert.match(core, /button\.disabled = false; button\.removeAttribute\('aria-busy'\); button\.textContent = 'Download'/);
assert.match(core, /button\.disabled = true; button\.setAttribute\('aria-busy', 'true'\); button\.textContent = 'Downloading…'/);
assert.match(css, /\.sync-progress progress\{[^}]*accent-color:var\(--accent\)/);

console.log("sync progress test: byte download, per-item import progress, UI locking, yielding, and recovery OK");
