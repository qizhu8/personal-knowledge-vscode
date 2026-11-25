import { z } from "zod";

// The compatibility adapter is provenance-pinned; protocol tests qualify this lightweight native schema.
export const legacyNoteInventoryArgs = z.strictObject({
  type: z.string().nullable().optional(),
  directory: z.string().nullable().optional(),
  recursive: z.boolean().default(true),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(50),
  inventory_revision: z.string().nullable().optional(),
});
