import { randomUUID } from "node:crypto";
import {
  documentLifecycleDefinitions, readDocumentLifecycle, planDocumentLifecycle, serializeDocumentLifecyclePlan,
} from "../dist/document-lifecycle.js";

/** Transport adapter fixture; caller holds the shared writer lock throughout.
 * persistSharedIntent must durably commit the exact operation/actor/args/intent before apply.
 * Then applyDocumentLifecycle(root, plan, plan.operationId), or recoverDocumentLifecycle for a loaded intent.
 * Commit result receipt + stable-identity/path reindex + intent completion together in shared SQLite.
 * Recover pending intents before normal indexing; external filesystem races remain possible.
 */
export async function documentLifecycleTransportFixture(root, documents, actorId, input, persistSharedIntent) {
  const previewArgs = documentLifecycleDefinitions[0].input.parse(input);
  const preview = readDocumentLifecycle(root, documents, {
    operation: "knowledge.document.lifecycle.preview", actorId, args: previewArgs,
  });
  const args = documentLifecycleDefinitions[1].input.parse({
    ...previewArgs, operationId: randomUUID(), expectedScanRevision: preview.scanRevision,
    expectedPairedTreeDigest: preview.pairedAssets.digest, expectedDestinationSha256: null, expectedDestinationTreeDigest: null,
  });
  const plan = planDocumentLifecycle(root, documents, { operation: "knowledge.document.move", actorId, args });
  await persistSharedIntent({
    operationId: plan.operationId, actorId, operation: "knowledge.document.move", args,
    intent: serializeDocumentLifecyclePlan(plan), result: plan.result,
  });
  return { preview, args, plan, result: plan.result };
}
