import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { readActionCompiler } from "../dist/action-compiler.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { invocation, managerActor, nativeWorkspace, until } from "./batch06-manager-fixtures.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");

test("headless Chromium performs CAS conflict, resumable upload, Todo denial and Action cancel over real HTTP", { timeout: 45_000 }, async t => {
  const actionCode = "setInterval(()=>{},1000)";
  const actionDefinition = structuredClone(original.example);
  actionDefinition.implementations[0].program = "fixture";
  actionDefinition.implementations[0].args = ["-e", actionCode];
  const actionSource = { kind: "inline", definition: actionDefinition };
  const compiledAction = readActionCompiler({ operation: "action.definition.compile", args: { source: actionSource } });
  assert.equal(compiledAction.status, "valid");
  const f = await nativeWorkspace(t, root => {
    const workspaceId = JSON.parse(readFileSync(resolve(root, ".pkm-next-workspace"), "utf8")).id;
    const authorize = binding => binding.actorId === managerActor.id && binding.workspaceId === workspaceId
      && binding.executableDigest === compiledAction.definitionDigest && binding.actionId === actionDefinition.action_id;
    return { hostServices: {
      action: { process: { commands: [{
        id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
        arguments: [{ literal: "-e" }, { literal: actionCode }],
        outputContractDigest: originalDigest(actionDefinition.output_schema),
        authorizationDigest: digest("isolated browser action policy"),
        authorizeDefinition: authorize,
        authorizeData: binding => authorize(binding) && binding.inputs.value === "public",
        approve: async request => request.actorId === managerActor.id && request.actionId === actionDefinition.action_id,
        redactOutput: () => ({ value: "redacted" }),
      }], limits: { graceMs: 20, closeDrainMs: 200 } } },
    } };
  });
  const created = await f.call("knowledge.document.create", {
    operationId: randomUUID(),
    id: "browser-workflow-note",
    title: "Browser workflow note",
    content: "Original text",
  });
  assert(created.result, JSON.stringify(created));
  const boardSlug = `browser-${randomUUID().replaceAll("-", "")}`;
  assert((await f.call("todo.board.create", { operationId: randomUUID(), board_slug: boardSlug })).result);
  let board = (await f.call("todo.board.get", { board_slug: boardSlug })).result;
  assert((await f.call("todo.workitem.create", {
    operationId: randomUUID(), board_slug: boardSlug, expected_digest: board.digest,
    item: { id: "review-me", title: "Browser delegated review", goal: "Complete isolated workflow",
      scope: "Browser fixture", acceptance: ["Native test evidence exists"] },
  })).result);
  board = (await f.call("todo.board.get", { board_slug: boardSlug })).result;
  assert((await f.call("todo.workitem.claim", {
    operationId: randomUUID(), board_slug: boardSlug, id: "review-me", expected_digest: board.digest,
  })).result);
  board = (await f.call("todo.board.get", { board_slug: boardSlug })).result;
  assert((await f.call("todo.workitem.submit", {
    operationId: randomUUID(), board_slug: boardSlug, id: "review-me", expected_digest: board.digest,
    outcome: "Success", evidence: ["Synthetic isolated browser fixture"],
  })).result);
  const actionRunId = `browser-action-${randomUUID()}`;
  const actionCreated = await f.call("action.runtime.create", {
    operationId: randomUUID(), runId: actionRunId, source: actionSource,
    expectedDefinitionDigest: compiledAction.definitionDigest,
    deadline: Date.now() + 60_000, inputs: { value: "public" },
  });
  assert(actionCreated.result, JSON.stringify(actionCreated));
  await until(async () => (await f.call("action.runtime.get", { runId: actionRunId })).result?.nodes
    ?.some(node => node.state === "running"));
  const url = await f.listen();
  const expectedAssetDigest = `sha256:${digest(Buffer.from(Array.from({ length: 70_003 }, (_, index) => index % 251)))}`;
  const child = spawn(process.env.PYTHON ?? "python", [resolve(import.meta.dirname, "batch08-browser-workflows.py")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes.toString(); });
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  child.stdin.end(JSON.stringify({
    url, token: f.bearer, documentId: "browser-workflow-note", documentRevision: created.result.revision,
    documentSha256: created.result.sha256, concurrentOperationId: randomUUID(), boardSlug, actionRunId,
  }) + "\n");
  const status = await closed;
  clearTimeout(timer);
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  const report = JSON.parse(stdout);
  assert(report.screenshotBytes > 10_000);
  assert.deepEqual(report.errors, []);
  const currentDocument = await f.call("knowledge.document.get", { id: "browser-workflow-note" });
  assert.equal(currentDocument.result.content, "Concurrent server version");
  assert.equal(currentDocument.result.title, "Server version");
  const assets = await f.runtime.core.dispatch("capability_read",
    invocation("knowledge.asset.list", { id: "browser-workflow-note" }), managerActor);
  assert(assets.result?.items?.some(item => item.path.endsWith("resume-diagram.bin") && item.digest === expectedAssetDigest),
    JSON.stringify(assets));
  const todo = await f.call("todo.workitem.get", { board_slug: boardSlug, id: "review-me" });
  assert.equal(todo.result.item.acceptanceDecision, undefined, "browser-authenticated user cannot forge delegated reviewer authority");
  const terminalAction = await f.call("action.runtime.get", { runId: actionRunId });
  assert.equal(terminalAction.result.state, "unknown");
  assert.equal(terminalAction.result.nodes[0].state, "unknown");
  const actionEvents = await f.call("action.runtime.events", { runId: actionRunId, after: 0, limit: 100 });
  assert.ok(actionEvents.result.items.some(event => event.kind === "cancel-requested"));
  assert.equal(actionEvents.result.items.some(event => event.kind === "run-succeeded"), false);
});
