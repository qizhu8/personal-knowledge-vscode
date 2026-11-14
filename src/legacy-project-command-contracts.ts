import { z } from "zod";

export const LEGACY_PROJECT_COMMAND_OPERATIONS = [
  "project.update", "project-create", "thread-create", "thread-rename", "thread-move",
] as const;

export const legacyProjectCommandSchema = z.strictObject({
  commandId: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(4096),
  operation: z.string().min(1).max(512),
  expectedStoreVersion: z.number().int().safe().positive(),
});

export type LegacyProjectCommand = z.infer<typeof legacyProjectCommandSchema>;
