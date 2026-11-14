import { z } from "zod";
import { legacyProjectCommandSchema } from "./legacy-project-command.js";
import { projectMutationInputs } from "./project-mutations-contracts.js";
import { legacyExtensionInputs } from "./legacy-command-extension-runtime.js";

export const legacyProjectInvocationSchema = z.strictObject({
  operationId: z.string().uuid(),
  command: legacyProjectCommandSchema,
  update: projectMutationInputs["project.update"].omit({ operationId: true }).optional(),
  args: z.union([legacyExtensionInputs["project-archive"], legacyExtensionInputs["recipe-create"],
    legacyExtensionInputs["recipe-update"], legacyExtensionInputs["project-create"],
    legacyExtensionInputs["thread-create"], legacyExtensionInputs["thread-rename"],
    legacyExtensionInputs["thread-move"]]).optional(),
});
export const legacyProjectCommandResultSchema = z.strictObject({
  snapshot: z.json(), entityId: z.string(), replayed: z.boolean(),
  storeVersion: z.number().int().safe().positive(),
});
export const legacyProjectCommandDefinitions = [{
  id: "project.legacy.command", readOnly: false,
  description: "Replay imported original opaque command receipts or update an original Project using exact store/file CAS pins. An explicitly configured native policy additionally admits project-archive, recipe-create, recipe-update, project-create, thread-create, thread-rename and thread-move; native actor and global fingerprint are never caller inputs.",
  input: legacyProjectInvocationSchema, output: legacyProjectCommandResultSchema,
}] as const;
