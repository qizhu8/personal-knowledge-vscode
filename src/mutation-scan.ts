import { z } from "zod";
import { scanMarkdown } from "./markdown.js";
import { knowledgeMutationScanRevision } from "./knowledge-mutations.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const mutationScanDefinition = {
  id: "knowledge.mutation.scan", readOnly: true,
  description: "Read a complete bounded Markdown identity/CAS inventory using the existing knowledge-mutation scan digest. Does not grant mutation authority or repair legacy identity.",
  input: z.strictObject({}),
  output: z.strictObject({
    scanRevision: digest,
    documents: z.array(z.strictObject({
      id: z.string(), area: z.enum(["notes", "skills", "papers"]), path: z.string(),
      revision: z.number().int().positive(), sha256: digest, knowledgeId: z.string().nullable(),
    })),
  }),
} as const;
export function readMutationScan(root: string) {
  const documents = scanMarkdown(root);
  return {
    scanRevision: knowledgeMutationScanRevision(documents),
    documents: documents.map(({ record, metadata }) => ({
      id: record.id, area: record.area, path: record.path, revision: record.revision, sha256: record.sha256,
      knowledgeId: typeof metadata.get("knowledgeId") === "string" ? metadata.get("knowledgeId") as string : null,
    })),
  };
}
