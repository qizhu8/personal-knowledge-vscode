#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const privacy = require("../dist/content-privacy");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-content-privacy-"));
privacy.setPrivacyStoreRoot(root);

assert.deepStrictEqual(privacy.privateTopLevels("skills"), []);
assert.strictEqual(privacy.isContentPathPrivate("skills", "User/Internal/tool.md"), false);
privacy.setTopLevelPrivacy("skills", "User", true);
assert.strictEqual(privacy.isTopLevelPrivate("skills", "User"), true);
assert.strictEqual(privacy.isContentPathPrivate("skills", "User/Internal/tool.md"), true);
assert.strictEqual(privacy.isContentPathPrivate("notes", "User/Internal/note.md"), false);
assert.throws(() => privacy.setTopLevelPrivacy("skills", "User/Internal", true), /top-level folder/);
privacy.renameTopLevelPrivacy("skills", "User", "Personal");
assert.strictEqual(privacy.isContentPathPrivate("skills", "User/Internal/tool.md"), false);
assert.strictEqual(privacy.isContentPathPrivate("skills", "Personal/Internal/tool.md"), true);
privacy.setTopLevelPrivacy("skills", "Personal", false);
assert.strictEqual(privacy.isContentPathPrivate("skills", "User/Internal/tool.md"), false);
assert(fs.existsSync(path.join(root, ".pkm", "content-privacy.json")));

for (const [type, item] of [
	["skills", { metadata: { category: "Private/Nested" } }],
	["notes", { category: "Private/Nested" }],
	["papers", { category: "Private/Nested" }],
	["prompts", { project: "Private" }],
	["packages", { name: "Private" }],
	["servers", { category: "Private/Nested" }],
	["scripts", { category: "Private/Nested" }],
]) {
	privacy.setTopLevelPrivacy(type, "Private", true);
	assert.strictEqual(privacy.isContentItemPrivate(type, item), true, `${type} item shape must honor top-level privacy`);
}

fs.writeFileSync(path.join(root, ".pkm", "content-privacy.json"), "not json");
assert.throws(() => privacy.isContentPathPrivate("skills", "User/file.md"), /Cannot read content privacy metadata/);

fs.rmSync(root, { recursive: true, force: true });
console.log("content privacy test: top-level persistence, inheritance, type isolation, and public restore OK");
