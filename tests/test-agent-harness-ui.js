const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../src/webview/panel/15-projects.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../src/webview/panel.css"), "utf8");

assert.match(source, /function renderAgentHarness\(session\)/);
assert.match(source, /Sequential framework · Recipe/);
assert.match(source, /Possibility tree · task-specific planning/);
assert.match(source, /latest\.planning\?\.possibilities \|\| harness\.planning\?\.possibilities/,
  "the possibility tree consumes explicit planner records");
assert.match(source, /Retrieval candidates are not treated as solution possibilities/,
  "retrieval evidence must not be presented as invented planning branches");
assert.match(source, /This does not claim to expose hidden model chain-of-thought/);
assert.match(source, /purposeEvidence: "associated-input"|solves current/,
  "Action purpose is presented as contextual association rather than hidden rationale");
assert.match(css, /\.agent-recipe-spine/);
assert.match(css, /\.agent-possibility-tree/);

console.log("agent harness UI contract tests passed");
