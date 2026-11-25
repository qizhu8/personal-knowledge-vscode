import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const mutationReceiptPin = z.strictObject({
  operationId: z.uuid(),
  operation: z.string().regex(/^[a-z][a-z0-9.]{0,99}$/),
  bodySha256: digest,
});
export const mutationReceiptResult = z.discriminatedUnion("state", [
  z.strictObject({
    schema: z.literal("pkm.operation.receipt/v1"), state: z.literal("committed"),
    actorId: z.string().min(1).max(256), ...mutationReceiptPin.shape, receiptSha256: digest,
  }),
  z.strictObject({ schema: z.literal("pkm.operation.receipt/v1"), state: z.enum(["pending", "unknown"]) }),
]);
export const mutationReceiptDefinitions = [{
  id: "operation.receipt.get", readOnly: true, input: mutationReceiptPin, output: mutationReceiptResult,
  description: "Read this authenticated actor's exact UUID mutation receipt pin. Only committed proves a matching durable receipt; pending or unknown never proves non-commitment. Does not replay, recover, or return request arguments/results.",
}];
