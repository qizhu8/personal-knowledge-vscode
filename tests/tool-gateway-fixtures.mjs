import { createHash } from "node:crypto";
import { ToolGateway, toolApprovalDigest } from "../dist/tool-gateway.js";
import { CoreError, definitions } from "../dist/contracts.js";

export const toolGatewayActor = Object.freeze({ id: "chat:synthetic", canWrite: true });
export const toolGatewayContext = Object.freeze({
  workspaceId: "workspace:synthetic", turnId: "turn:synthetic", contextDigest: "a".repeat(64),
});
export const toolGatewayOperationId = "30ddf01e-a234-4468-8592-2101573acf0d";
export const toolGatewayCatalog = Object.freeze([
  { name: "read_document", operation: "knowledge.document.get" },
  { name: "create_document", operation: "knowledge.document.create" },
]);
export const toolGatewayDocument = (input = {}) => ({
  id: "synthetic", title: "Synthetic", content: "Synthetic content", revision: 1, deleted: false,
  sha256: createHash("sha256").update("Synthetic content").digest("hex"), ...input,
});

/** In-memory Core-shaped dispatcher: enforces static schemas, actor authority and durable-ID identity. */
export class FakeToolCore {
  calls = [];
  receipts = new Map();
  deny = false;
  mode = "normal";
  result;
  async dispatch(method, input, actor) {
    this.calls.push({ method, input, actor });
    if (this.deny || (!actor.canWrite && method === "capability_call")) throw new CoreError("ACCESS_DENIED", "secret=must-not-leak");
    const definition = definitions.find(item => item.id === input.operation);
    if (!definition || definition.readOnly !== (method === "capability_read")) throw new CoreError("ACCESS_DENIED", "Wrong method");
    const args = definition.input.parse(input.arguments);
    if (this.mode === "hang") return new Promise(() => {});
    if (this.mode === "unknown") throw new CoreError("IO_FAILED", "password=must-not-leak", "unknown");
    if (this.mode === "throw") throw new Error("api_key=must-not-leak");
    if (!definition.readOnly) {
      const digest = JSON.stringify(args);
      if (this.receipts.has(args.operationId) && this.receipts.get(args.operationId) !== digest)
        throw new CoreError("CONFLICT", "Changed receipt");
      this.receipts.set(args.operationId, digest);
    }
    return {
      schema: "pkm.next-result/v1", requestId: "synthetic-request",
      result: this.result ?? toolGatewayDocument({
        ...(args.id ? { id: args.id } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.content !== undefined ? { content: args.content } : {}),
      }),
    };
  }
}
export function createToolGatewayFixture(options = {}) {
  const core = options.core ?? new FakeToolCore();
  const proofs = new WeakMap();
  const gateway = new ToolGateway({
    dispatcher: core, actor: toolGatewayActor, context: toolGatewayContext, catalog: toolGatewayCatalog,
    verifyApproval: async (binding, proof, signal) =>
      !signal.aborted && proofs.get(proof) === toolApprovalDigest(binding),
    ...options,
  });
  return {
    gateway, core,
    approve(request) {
      const proof = Object.freeze({});
      proofs.set(proof, toolApprovalDigest(gateway.prepare(request)));
      return proof;
    },
  };
}
export const toolGatewayReadRequest = Object.freeze({ name: "read_document", arguments: { id: "synthetic" } });
export const toolGatewayWriteRequest = Object.freeze({
  name: "create_document", operationId: toolGatewayOperationId,
  arguments: { id: "synthetic", title: " Synthetic ", content: "Synthetic content" },
});
