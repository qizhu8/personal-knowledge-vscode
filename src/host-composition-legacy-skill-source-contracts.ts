import { z } from "zod";
import { legacySkillSourceInstallInputSchema, legacySkillSourceRemoveInputSchema, legacySkillSourceBridgeInputSchema } from "./legacy-skill-source.js";

export const legacySkillSourceOperation = "legacy.skill.source.install";
export const legacySkillSourceRemoveOperation = "legacy.skill.source.remove";
export const legacySkillSourceBridgeOperation = "legacy.skill.source.bridge";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const legacySkillSourceOutputSchema = z.strictObject({
  operationId: z.string().uuid(),
  sourceSha256: digest,
  sourceManifestSha256: digest,
  destinationSha256: digest,
  destinationManifestSha256: digest,
});
export const legacySkillSourceDefinitions = [{
  id: legacySkillSourceOperation,
  readOnly: false,
  description: "Native-approved disposable canonical Skill source creation or upgrade and managed projection installation; requires independent durable authority.",
  input: legacySkillSourceInstallInputSchema,
  output: legacySkillSourceOutputSchema,
}, {
  id: legacySkillSourceRemoveOperation,
  readOnly: false,
  description: "Remove a source-pinned managed Skill projection under independent native authority.",
  input: legacySkillSourceRemoveInputSchema,
  output: legacySkillSourceOutputSchema.extend({ destinationSha256: digest.nullable() }),
}, {
  id: legacySkillSourceBridgeOperation,
  readOnly: false,
  description: "Independently approve an exact existing legacy Skill receipt lineage as immutable ordered source genesis; no filesystem effects.",
  input: legacySkillSourceBridgeInputSchema,
  output: legacySkillSourceOutputSchema,
}] as const;
