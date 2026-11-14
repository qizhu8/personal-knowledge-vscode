"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

test("coordinated reload warns that native MCP work is not tracked before confirmation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const host = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerExtensionHostRuntime");
  assert(host);
  const code = host.getText(ast);
  assert.match(code, /registerCommand\("personalKnowledge\.reloadAllHosts"[\s\S]*showWarningMessage[\s\S]*modal: true[\s\S]*Native MCP calls are not tracked and may be interrupted[\s\S]*if \(answer !== "Reload registered windows"\) return;[\s\S]*registry\.requestReload/);
});
