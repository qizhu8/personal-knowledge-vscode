#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "publish-marketplace.yml"), "utf8");

for (const action of ["actions/checkout@v7", "actions/setup-node@v7", "actions/setup-python@v7", "azure/login@v3"]) {
  assert(workflow.includes(`uses: ${action}`), `release workflow must use ${action}`);
}
assert(!workflow.includes("azure/login@v2"), "release workflow must not regress to the Node 20 Azure Login action");
assert(workflow.includes('"fastmcp>=2.0.0,<4.0.0"'),
  "release validation must exclude incompatible FastMCP major versions");

const packageStep = workflow.indexOf("- name: Package VSIX");
const verifyStep = workflow.indexOf("- name: Verify VSIX metadata and boundaries");
const publishStep = workflow.indexOf("- name: Publish with Microsoft Entra ID");
assert(packageStep >= 0 && packageStep < verifyStep && verifyStep < publishStep,
  "release workflow must package and verify the VSIX before publishing");

console.log("Release workflow test: supported action majors and package/verify/publish order OK");