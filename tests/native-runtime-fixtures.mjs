import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createSyntheticProvider } from "./chat-turn-native-fixtures.mjs";

export const nativeActor = Object.freeze({ id: "native:synthetic-owner", canWrite: true });
export const nativeToolCatalog = Object.freeze([
  { name: "create_document", operation: "knowledge.document.create", approvalRequired: true },
]);

export async function openNativeRuntime(storage, options = {}) {
  const provider = createSyntheticProvider({
    documentId: options.documentId ?? "native-chain-document",
    onOpen: options.onOpen,
    ...(options.database ? { database: options.database } : {}),
  });
  const reviews = [], authorizations = [];
  const runtime = await createNativeRuntime({
    storage,
    workspaceId: await storage.workspaceId(),
    modelConfig: provider.modelConfig,
    providerTransport: provider.providerTransport,
    toolCatalog: nativeToolCatalog,
    reviewer: options.reviewer ?? (async request => {
      reviews.push(request);
      assert.equal(request.record.tool, "knowledge.document.create");
      assert.equal(request.record.arguments.title, "Synthetic chain");
      assert.equal(request.record.arguments.operationId, request.executionOperationId);
      return { actorId: request.actorId, decisionId: randomUUID(), decision: "approve" };
    }),
    authorizeTool: options.authorizeTool ?? (async binding => {
      authorizations.push(binding);
      return binding.operation === "knowledge.document.create";
    }),
  });
  return {
    ...runtime,
    runtime,
    provider,
    reviews,
    authorizations,
    dispose: async () => {
      await runtime.close();
      await storage.close();
    },
  };
}
