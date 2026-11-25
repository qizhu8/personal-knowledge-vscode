import { z } from "zod";

export const originalActionCall = z.strictObject({
  action_id: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/),
  inputs: z.record(z.string(), z.json()), content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().min(1).max(200),
  trigger: z.record(z.string(), z.json()).nullable().default(null),
  project_id: z.string().min(1).max(200).nullable().default(null),
});
