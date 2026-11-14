import { z } from "zod";
import { documentPath, knowledgeArea, resourcePath } from "./document-path.js";

export const documentLifecycleLimits = Object.freeze({
  documents: Number.MAX_SAFE_INTEGER, entries: Number.MAX_SAFE_INTEGER, depth: 32,
  markdownBytes: Number.MAX_SAFE_INTEGER, scanBytes: Number.MAX_SAFE_INTEGER,
  assetEntries: 2048, assetBytes: 67_108_864, fileBytes: 16_777_216,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const documentLifecyclePreviewInput = z.strictObject({
  id, area: knowledgeArea, path: documentPath, destinationPath: documentPath,
  expectedRevision: count.min(1), expectedSha256: digest,
});
const document = z.strictObject({
  id, area: knowledgeArea, beforePath: documentPath, afterPath: documentPath,
  revision: count.min(1), beforeSha256: digest, afterSha256: digest,
});
const tree = z.strictObject({
  beforePath: resourcePath, afterPath: resourcePath, digest: digest.nullable(),
  files: count.max(documentLifecycleLimits.assetEntries), bytes: count.max(documentLifecycleLimits.assetBytes),
});
const preview = z.strictObject({
  document, pairedAssets: tree, scanRevision: digest,
  scannedDocuments: count.max(documentLifecycleLimits.documents),
  scannedBytes: count.max(documentLifecycleLimits.scanBytes),
  destinationAbsent: z.literal(true), referenceRewriteRequired: z.boolean(),
});
const result = z.strictObject({
  operationId: z.string().uuid(), action: z.literal("move"), document, pairedAssets: tree,
  scanRevision: digest, referenceRewriteRequired: z.boolean(),
});
export const documentLifecycleDefinitions = [
  {
    id: "knowledge.document.lifecycle.preview", readOnly: true,
    description: "Preview a within-area Markdown plus paired .assets move. Pins document SHA/revision, complete three-area reference scan and paired tree digest, stable identity and absent destinations. Reuses original owner-reference rebase/shared-tree protection; legacy _assets migration, path-only identity, Todo/memory descriptors and unknown/linked files are explicitly refused.",
    input: documentLifecyclePreviewInput, output: preview,
  },
  {
    id: "knowledge.document.move", readOnly: false,
    description: "Plan an exact pinned document/paired-tree move with original owner-reference rewriting. Caller must persist serialized intent and hold shared SQLite writer lock before apply/recover, atomically commit stable identity/path, result receipt and intent completion afterwards. No independent DB or folder moves. External filesystem writers can race final CAS checks; conflicts require reconciliation.",
    input: documentLifecyclePreviewInput.extend({
      operationId: z.string().uuid(), expectedScanRevision: digest, expectedPairedTreeDigest: digest.nullable(),
      expectedDestinationSha256: z.null(), expectedDestinationTreeDigest: z.null(),
    }),
    output: result,
  },
] as const;
export type DocumentLifecycleOperation = typeof documentLifecycleDefinitions[number]["id"];
export type DocumentLifecyclePreview = z.infer<typeof preview>;
export type DocumentLifecycleResult = z.infer<typeof result>;
