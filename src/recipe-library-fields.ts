import { z } from "zod";
const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const field = z.strictObject({ name: z.string(), description: z.string(), required: z.boolean().optional() });
export const recipeLibraryEditable = z.strictObject({
  name: z.string().trim().min(1).max(256), category: z.string().max(512).optional(),
  description: z.string().max(65536), definition: z.json(), methodology: z.json().optional(),
  metadata: z.strictObject({ applicableFunctions: z.array(z.string()), solution: z.string(),
    requiredInputs: z.array(field), expectedOutputs: z.array(field) }).optional(),
  editorLayout: z.strictObject({ nodePositions: z.record(z.string(), point),
    boundaryPositions: z.strictObject({ input: point.optional(), output: point.optional() }).optional() }).optional(),
  nodeBindings: z.array(z.strictObject({ nodeId: z.string(), bindings: z.array(z.strictObject({
    bindingId: z.string(), kind: z.enum(["skill", "note"]), knowledgeId: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), usage: z.enum(["required", "recommended", "reference"]),
  })) })).optional(),
});
