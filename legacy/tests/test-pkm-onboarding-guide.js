#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const guideStart = extension.indexOf("const guide = md(");
const guideEnd = extension.indexOf("skillUpsert({", guideStart);
assert(guideStart >= 0 && guideEnd > guideStart, "new-user onboarding guide must exist in seedExamples");
const guide = extension.slice(guideStart, guideEnd);

for (const marker of [
  "# Getting Started with Personal Knowledge Manager",
  "## Navigation and right-click menus", "## Privacy and browser links",
  "Content Gateway", "returns 404", "## Subscription Brokers",
  "Refresh from Broker", "get_subscribed_content_by_path", "Packages, and Server links",
  "Skill workflow, and Chatroom tools",
]) assert(guide.includes(marker), `new-user seed guide is missing current feature: ${marker}`);

assert.match(extension, /firstTimeSetup\(context, false\)/, "first activation must use Welcome rather than reconfigure copy");
assert.match(extension, /Use Recommended Location/);
assert.match(extension, /automatically creates or repairs its isolated runtime, generates the MCP server, builds the retrieval index/);
assert.match(extension, /firstConfiguration \|\| cfg\.get<boolean>\("openOnStartup"\)/,
  "first setup must open Config for the consent coachmark even when openOnStartup is disabled");

console.log("PKM onboarding guide test: repository-owned new-user seed covers current features OK");
