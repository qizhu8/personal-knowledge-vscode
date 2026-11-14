import { z } from "zod";
import { documentPath, knowledgeArea, resourcePath } from "./document-path.js";

export const resourceLifecycleLimits = Object.freeze({
  resourceBytes: 16_777_216, markdownBytes: Number.MAX_SAFE_INTEGER, scanBytes: Number.MAX_SAFE_INTEGER,
  documents: Number.MAX_SAFE_INTEGER, entries: Number.MAX_SAFE_INTEGER, depth: 32,
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const binaryDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const name = resourcePath.max(200).regex(/^[^/]+$/);
const pins = {
  id: documentId, area: knowledgeArea, documentPath,
  expectedRevision: count.min(1), expectedSha256: digest,
  path: resourcePath, expectedDigest: binaryDigest, expectedSize: count.max(resourceLifecycleLimits.resourceBytes),
};
const documentReceipt = z.strictObject({
  id: documentId, area: knowledgeArea, path: documentPath, revision: count.min(1),
  beforeSha256: digest, afterSha256: digest,
});
const resourceReceipt = z.strictObject({
  area: knowledgeArea, path: resourcePath, digest: binaryDigest, size: count.max(resourceLifecycleLimits.resourceBytes),
});
const previewInput = z.strictObject({
  ...pins, action: z.enum(["rename", "delete"]), newName: name.optional(),
}).refine(value => (value.action === "rename") === (value.newName !== undefined), "Rename requires newName; delete forbids it.");
const mutationPins = {
  ...pins, operationId: z.string().uuid(), expectedScanRevision: digest,
};
const resultSchema = z.strictObject({
  operationId: z.string().uuid(), action: z.enum(["rename", "delete"]),
  document: documentReceipt, before: resourceReceipt, after: resourceReceipt.nullable(),
  scanRevision: digest, markdownRewritten: z.boolean(),
});
const previewSchema = z.strictObject({
  document: documentReceipt, resource: resourceReceipt, scanRevision: digest,
  destinationPath: resourcePath.nullable(), markdownRewriteRequired: z.boolean(),
  scannedDocuments: count.max(resourceLifecycleLimits.documents),
  scannedBytes: count.max(resourceLifecycleLimits.scanBytes),
});
export const resourceLifecycleDefinitions = [
  {
    id: "knowledge.asset.lifecycle.preview", readOnly: true,
    description: "Check exact document/binary pins and complete body-reference scan across notes, skills and papers. Original whole-owned-tree shared protection; legacy/shared resources and referenced deletion are refused. Returns scan CAS; no writes. Binary resources remain limited to 16 MiB; directory nesting is limited to 32 levels.",
    input: previewInput, output: previewSchema,
  },
  {
    id: "knowledge.asset.rename", readOnly: false,
    description: "Plan a same-directory owned-resource rename with operationId, exact document/binary/scan CAS and absent destination. Shared owned trees are refused. Referenced rename requires explicit rewriteMarkdown=true and a future compound shared journal; helper never writes Markdown/resources or receipts.",
    input: z.strictObject({ ...mutationPins, newName: name, expectedDestinationDigest: z.null(), rewriteMarkdown: z.boolean().default(false) }),
    output: resultSchema,
  },
  {
    id: "knowledge.asset.delete", readOnly: false,
    description: "Plan deletion of a pinned regular owned resource only after original whole-tree shared and owning-document reference checks. Never deletes legacy, unknown, Todo or linked files. Parent must journal exact before bytes and receipt before applying; helper has no persistence.",
    input: z.strictObject(mutationPins), output: resultSchema,
  },
] as const;
export type ResourceLifecycleOperation = typeof resourceLifecycleDefinitions[number]["id"];
export type ResourceLifecycleResult = z.infer<typeof resultSchema>;
export type ResourceLifecyclePreview = z.infer<typeof previewSchema>;
