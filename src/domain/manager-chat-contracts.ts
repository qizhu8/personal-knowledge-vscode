import { z } from "zod";

const path = z.string().min(1).max(512).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !/[:*?[\]{}\u0000-\u001f]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".."), "Canonical relative path required");
const text = z.string().trim().min(1).max(4000);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const managerChatPlannerResponseSchema = z.union([
  z.strictObject({
    kind: z.enum(["parallel", "serial"]), rationale: text,
    tasks: z.array(z.strictObject({
      id, objective: text, phase: z.enum(["worker", "integrator", "verifier", "repair"]),
      dependsOn: z.array(id).max(1024).default([]),
      readScope: z.array(path).max(256).default([]),
      writeScope: z.array(path).max(16).default([]),
      resources: z.array(text).max(16).default([]),
      acceptanceIds: z.array(id).min(1).max(256), rationale: text,
    })).min(1).max(1024),
  }),
  z.strictObject({ status: z.literal("needsClarification"), questions: z.array(text).min(1).max(32) }),
]);
export const managerChatArtifactSchema = z.strictObject({
  path, content: z.string().max(16000),
});
export const managerChatDeliverySchema = z.strictObject({
  schema: z.literal("pkm.manager.chat.delivery/v1"),
  taskId: z.string().min(1).max(128),
  artifacts: z.array(managerChatArtifactSchema).min(1).max(16),
});
export const managerChatIntegrationSchema = z.strictObject({
  schema: z.literal("pkm.manager.chat.integration/v1"),
  freeze: z.string().regex(/^[a-f0-9]{64}$/),
  paths: z.array(path).min(1).max(1024),
});
export const managerChatVerificationSchema = z.strictObject({
  schema: z.literal("pkm.manager.chat.verification/v1"),
  freeze: z.string().regex(/^[a-f0-9]{64}$/),
  integration: z.string().regex(/^[a-f0-9]{64}$/),
  acceptanceIds: z.array(z.string().min(1).max(128)).min(1).max(256),
});
export type ManagerChatArtifact = z.infer<typeof managerChatArtifactSchema>;
export type ManagerChatDelivery = z.infer<typeof managerChatDeliverySchema>;
export type ManagerChatIntegration = z.infer<typeof managerChatIntegrationSchema>;
export const managerChatWithin = (value: string, scopes: readonly string[]) =>
  scopes.some(scope => value === scope || value.startsWith(`${scope}/`));
export function managerChatCanonicalPath(value: string): boolean {
  return path.safeParse(value).success;
}
