"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

test("the actual experimental command visibly refuses without starting Environment work", async () => {
  const source = ts.createSourceFile("extension.ts", fs.readFileSync("src/extension.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let command;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "vscode.commands.registerCommand"
      && node.arguments[0]?.getText(source) === '"personalKnowledge.checkManagedOriginalEnvironmentsExperimental"') command = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert(command, "experimental availability command must be registered");
  let handler, message;
  const sandbox = {
    managedSessionId: "session", earlyManagedProfile: {}, hostWriterAdmission: {},
    vscode: { workspace: { isTrusted: true }, commands: { registerCommand(_id, callback) { handler = callback; } },
      window: { async showWarningMessage(text) { message = text; } } },
  };
  vm.runInNewContext(ts.transpileModule(command.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox);
  const enrolled = await handler();
  assert.equal(enrolled.status, "unavailable");
  assert.match(message, /profile-writer authority.*No profile access or Refresh was started/i);
  sandbox.vscode.workspace.isTrusted = false;
  const untrusted = await handler();
  assert.equal(untrusted.status, "unavailable");
  assert.match(message, /trusted, enrolled managed host.*No profile access or Refresh was started/i);
});
