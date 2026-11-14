import { z } from "zod";
import { managerCompletionContractSchema } from "./domain/manager-plan-contracts.js";
import { managerChatCanonicalPath } from "./domain/manager-chat-contracts.js";
export const managerTextConfigSchema = z.strictObject({
  mode: z.literal("pinned-sqlite-text-artifacts/v1"),
  contract: managerCompletionContractSchema,
  expected: z.record(z.string().refine(managerChatCanonicalPath), z.string().max(100000)),
  maxConcurrentTurns: z.number().int().min(1).max(32).default(4),
  context: z.array(z.strictObject({ path: z.string().refine(managerChatCanonicalPath), content: z.string().max(100000) })).max(128).default([]),
}).refine(value => Object.keys(value.expected).length > 0 && Object.keys(value.expected).length <= 128
  && new Set(value.context.map(item => item.path)).size === value.context.length
  && value.context.every(item => Object.hasOwn(value.expected, item.path)));
export type ManagerTextConfig = z.infer<typeof managerTextConfigSchema>;
export const managerArtifactDefinitions = [{
  id: "manager.chat.artifacts", description: "Read actor-owned frozen SQLite text artifacts in the explicitly pinned text-artifact mode. No filesystem writes or general coding authority.",
  readOnly: true,
  input: z.strictObject({ runId: z.string().min(1).max(160), freeze: z.string().regex(/^[a-f0-9]{64}$/) }),
  output: z.strictObject({ mode: z.literal("pinned-sqlite-text-artifacts/v1"),
    artifacts: z.array(z.strictObject({ path: z.string(), content: z.string() })) }),
}] as const;
