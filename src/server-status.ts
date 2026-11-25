import { z } from "zod";

export const serverStatusSchema = z.strictObject({
  schema: z.literal("pkm.server-status/v1"),
  workspaceId: z.string().uuid(),
  instanceId: z.string().uuid(),
  runtimeBuild: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["accepting", "draining", "closed", "action-required"]),
  writable: z.boolean(),
  scope: z.enum(["knowledge-content-only/v1", "native-dogfood/v1"]),
  clients: z.number().int().min(0),
  inFlight: z.number().int().min(0),
  uncertainCalls: z.number().int().min(0),
  handoff: z.strictObject({
    available: z.literal(false),
    blockers: z.tuple([
      z.literal("shared-routing-not-implemented"),
      z.literal("unmanaged-writer-coverage-unverified"),
    ]),
  }),
}).refine(value => value.uncertainCalls <= value.inFlight);

export type ServerStatus = z.infer<typeof serverStatusSchema>;
