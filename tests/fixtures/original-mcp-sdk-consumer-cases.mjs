import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { originalSdkDigest } from "../../dist/original-mcp-sdk-model-contracts.js";

export function sdkConsumerPlan({ host, selection, source, chatUrl }) {
  return { schema: "pkm.original-sdk-api-chat-execution/v1", requestId: originalSdkDigest(randomUUID()),
    chatUrl, selectionId: selection.selectionId, sourcePlanSha256: source.planSha256,
    epoch: host.receipt.epoch, hostReceiptSha256: host.receipt.receiptSha256, deadlineAtMs: Date.now() + 15000,
    messages: [{ role: "user", content: "Synthetic signed SDK consumer transport; not an actual provider." }], tools: [],
    hardToolRoundLimit: 2, outputTokenCap: 128,
    budget: { maxRequestBytes: 65536, maxSendingBoundaries: 8, maxTotalOutputTokens: 1024, deadlineMs: 30000 } };
}
export function inspectSdkConsumerJournal(storage, requestId) {
  const db = storage.connectNative();
  try {
    const execution = db.prepare("SELECT * FROM original_native_chat_executions WHERE request_id=?").get(requestId);
    const events = db.prepare("SELECT sequence,type,payload FROM original_native_chat_events WHERE request_id=? ORDER BY sequence")
      .all(requestId).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    return { execution, events,
      nativeInferences: db.prepare("SELECT count(*) AS n FROM original_native_chat_inferences WHERE request_id=?").get(requestId).n,
      canonicalTools: db.prepare(`SELECT r.*,b.context_json FROM approval_bridge_runs r JOIN approval_bridge_bindings b
        ON b.execution_id=r.execution_id WHERE json_extract(b.context_json,'$.turnId')=?`).all(requestId) };
  } finally { db.close(); }
}
export async function sdkConsumerUntil(work) {
  for (let count = 0; count < 500; count++) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Signed SDK consumer fixture did not reach its bounded checkpoint.");
}
