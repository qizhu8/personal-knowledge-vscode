#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const guidePath = path.join(root, "..", "..", "skills", "System", "PKM", "personal-knowledge-manager-guide.md");
assert(fs.existsSync(guidePath), "canonical System PKM onboarding Skill must exist");
const guide = fs.readFileSync(guidePath, "utf8");
assert.match(guide, /^name: Personal Knowledge Manager Guide$/m);
assert.strictEqual("System/PKM/" + /^name: (.+)$/m.exec(guide)[1], "System/PKM/Personal Knowledge Manager Guide");

for (const marker of [
  "Copy Path", "Public Content Gateway", "get_subscribed_content_by_path",
  "search_subscribed_content", "Refresh from Broker", "MQTT revision notification",
  "Skills, Notes, Papers, Prompts, Scripts, Packages, and Server links",
  "returns `404`", "External Link Host", "Chatroom", "graceful handoff",
  "## First Configuration", "Setup progress", "Future Runtime, MCP schema, managed Router, and retrieval index updates are automatic",
]) assert(guide.includes(marker), `System PKM guide is missing current feature: ${marker}`);

for (const marker of [
  "## Navigation and right-click menus", "## Privacy and browser links",
  "## Subscription Brokers", "Refresh from Broker", "get_subscribed_content_by_path",
]) assert(extension.includes(marker), `new-user seed guide is missing current feature: ${marker}`);

assert.match(extension, /firstTimeSetup\(context, false\)/, "first activation must use Welcome rather than reconfigure copy");
assert.match(extension, /Use Recommended Location/);
assert.match(extension, /automatically creates or repairs its isolated runtime, generates the MCP server, builds the retrieval index/);
assert.match(extension, /firstConfiguration \|\| cfg\.get<boolean>\("openOnStartup"\)/,
  "first setup must open Config for the consent coachmark even when openOnStartup is disabled");

console.log("PKM onboarding guide test: canonical System Skill and new-user seed cover current features OK");
