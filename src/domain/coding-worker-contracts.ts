import { z } from "zod";

export const CODING_WORKER_LIMITS = Object.freeze({
  files: 128, fileBytes: 32768, sourceBytes: 131072, patches: 16,
  turns: 64, concurrent: 4, inputTokens: 65536, outputTokens: 8192,
  runInputTokens: 4194304, runOutputTokens: 524288, deadlineMs: 120000,
});
export function codingWorkerPath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !value.includes("\\") && !/[\u0000-\u001f]/.test(value)
    && value.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
      && part !== "." && part !== ".." && part !== ".git");
}
const path = z.string().refine(codingWorkerPath);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const codingWorkerReadSchema = z.strictObject({ path });
export const codingWorkerListSchema = z.strictObject({});
export const codingWorkerProposalSchema = z.strictObject({
  schema: z.literal("pkm.coding.proposal/v1"),
  taskId: z.string().min(1).max(128),
  patches: z.array(z.strictObject({
    path, beforeHash: digest,
    edits: z.array(z.strictObject({
      before: z.string().min(1).max(CODING_WORKER_LIMITS.fileBytes),
      after: z.string().max(CODING_WORKER_LIMITS.fileBytes),
    })).min(1).max(16),
  })).min(1).max(CODING_WORKER_LIMITS.patches),
});
export type CodingWorkerProposal = z.infer<typeof codingWorkerProposalSchema>;
export interface CodingWorkerFile {
  path: string; content: string; hash: string;
}
export interface CodingWorkerChange {
  path: string; before: string; after: string; beforeHash: string; afterHash: string;
}
export interface CodingWorkerReceipt {
  workspaceId: string; runId: string; taskId?: string; effectId: string;
  kind: "file-intent" | "file-complete" | "check" | "delivery" | "freeze" | "merge" | "recovery";
  pin: string; outcome: "intent" | "complete" | "failed" | "unknown";
}
