import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash, checkCaptureRecords } from "./migration.mjs";

const sourceRoot = resolve(packageRoot, "legacy");
const source = "src/chat/api-chat-store.ts";
const captured = "src/domain/execution-state-progress.ts";
const original = await readFile(resolve(sourceRoot, source), "utf8");
const parsed = ts.createSourceFile(source, original, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "settleProgressSteps");
if (!declaration) throw new Error("Original progress reducer capture boundary changed.");
const content = `export interface ApiChatProgressStep {
  label: string; at: number; status?: "running" | "waiting" | "complete" | "cancelled" | "failed";
  kind?: "model" | "tool"; toolCallId?: string; finishedAt?: number;
  operation?: "inference" | "token-count" | "model-access" | "retrieval" | "preparation" | "command" | "display";
}

${declaration.getText(parsed)}
`;
await writeFile(resolve(packageRoot, captured), content);
const files = [{ source, captured, sourceSha256: hash(original), capturedSha256: hash(content) }];
const testSource = "tests/test-task-progress.js";
const testCaptured = "tests/execution-state-original.test.mjs";
const originalTest = await readFile(resolve(sourceRoot, testSource), "utf8");
const testParsed = ts.createSourceFile(testSource, originalTest, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const originalCase = testParsed.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.arguments[0]?.getText(testParsed)
    === '"activity tool steps stay running through approvals and later stages until their own result"');
if (!originalCase) throw new Error("Original progress test capture boundary changed.");
const testContent = `import test from "node:test";
import assert from "node:assert/strict";
import { settleProgressSteps } from "../dist/domain/execution-state-progress.js";

${originalCase.getText(testParsed).replace('  const { settleProgressSteps } = require("../dist/chat/api-chat-store");\n', "")}
`;
await writeFile(resolve(packageRoot, testCaptured), testContent);
files.push({ source: testSource, captured: testCaptured, sourceSha256: hash(originalTest), capturedSha256: hash(testContent) });
await writeFile(resolve(packageRoot, "migration/execution-state-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selected settleProgressSteps body unchanged; its local step type is reproduced with reducer-used fields only. Original test case captured with ESM imports rewritten.",
  files,
  qualification: "Progress reducer only; durable execution state is a conservative new projection, not original recovery parity. No model, tool, approval UI or replay adapter.",
}, null, 2) + "\n");
const issues = await checkCaptureRecords(files, sourceRoot, packageRoot);
if (issues.length) throw new Error(JSON.stringify(issues));
