import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApprovalBridge } from "../dist/approval-bridge.js";
import { ToolGateway } from "../dist/tool-gateway.js";
import { FakeToolCore } from "./tool-gateway-fixtures.mjs";

test("native exact approval -> durable started -> actual gateway verifier -> Core-shaped dispatch -> durable completion", async () => {
  for (const readOnly of [false, true]) {
    const db = new DatabaseSync(":memory:"), core = new FakeToolCore();
    const actor = { id: "fixture-actor", canWrite: true };
    const context = { workspaceId: "fixture-workspace", turnId: "fixture-turn", contextDigest: "a".repeat(64) };
    const name = readOnly ? "read_document" : "create_document";
    let gateway, humanCalls = 0;
    const bridge = createApprovalBridge({
      workspaceId: context.workspaceId,
      storage: {
        read: fn => fn(db),
        transaction: fn => {
          db.exec("BEGIN IMMEDIATE");
          try { const result = fn(db); db.exec("COMMIT"); return result; }
          catch (error) { db.exec("ROLLBACK"); throw error; }
        },
      },
      reviewer: async value => {
        humanCalls++;
        assert.equal(db.isTransaction, false);
        assert.equal(value.executionOperationId, operationId);
        assert.equal(value.record.tool, readOnly ? "knowledge.document.get" : "knowledge.document.create");
        return { decision: "approve", actorId: actor.id, decisionId: randomUUID() };
      },
      dispatch: async request => {
        assert.equal(db.isTransaction, false);
        assert.equal(db.prepare("SELECT status FROM execution_records WHERE id=?").get(request.execution.id).status, "running");
        const result = await gateway.execute({
          name, arguments: request.execution.arguments,
          ...(!readOnly ? { operationId: request.operationId } : {}), approval: request.approval,
        }, { signal: request.signal });
        if (result.effect === "unknown" || result.status === "unknown") throw new Error("Uncertain host result");
        assert.equal(result.status, "complete");
        return { status: result.status === "complete" ? "succeeded" : "failed", result };
      },
    });
    gateway = new ToolGateway({
      actor, context, dispatcher: core, verifyApproval: bridge.native.verifyApproval,
      catalog: [{ name, operation: readOnly ? "knowledge.document.get" : "knowledge.document.create", approvalRequired: true }],
    });
    const operationId = randomUUID();
    try {
      const prepared = gateway.prepare({
        name, arguments: readOnly ? { id: "synthetic" } : { id: "synthetic", title: " Synthetic ", content: "Synthetic content" },
        ...(!readOnly ? { operationId } : {}),
      });
      const record = bridge.native.create(actor.id, {
        tool: prepared.operation, arguments: prepared.arguments, operationId, approvalRequired: true,
        context: { turnId: context.turnId, contextDigest: context.contextDigest, readOnly },
      });
      const pending = bridge.public.request(actor.id, { executionId: record.id, expectedRevision: record.revision, operationId: randomUUID() });
      const approved = await bridge.native.review(actor.id, pending.id);
      assert.equal(approved.status, "approved");
      const input = { executionId: record.id, expectedRevision: approved.resolvedExecutionRevision, operationId };
      const completed = await bridge.native.execute(actor.id, input);
      assert.equal(completed.execution.status, "succeeded");
      assert.equal(completed.result.status, "complete");
      assert.equal(completed.result.result.title, "Synthetic");
      assert.deepEqual(await bridge.native.execute(actor.id, input), completed);
      assert.equal(humanCalls, 1);
      assert.equal(core.calls.length, 1);
    } finally { db.close(); }
  }
});
