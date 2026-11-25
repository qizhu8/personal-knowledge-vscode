import { z } from "zod";
import { documentPath, knowledgeArea } from "./document-path.js";

export const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const documentRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const documentDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const documentSchema = z.strictObject({
  id: documentId,
  // Historical receipts retain their original response shape.
  path: documentPath.optional(),
  area: knowledgeArea.optional(),
  title: z.string().min(1).max(500),
  content: z.string(),
  revision: documentRevision.min(1),
  deleted: z.boolean(),
  sha256: documentDigest,
});
export type DocumentRecord = z.infer<typeof documentSchema>;
