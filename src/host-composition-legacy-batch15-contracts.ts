import { z } from "zod";
import { legacyScriptProjectResolveOutput, nativeAssetOwnershipOutput } from "./legacy-asset-provider.js";
import { legacySkillLifecycleDefinitions } from "./legacy-skill-lifecycle.js";
import { legacySkillSourceDefinitions } from "./host-composition-legacy-skill-source-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const batch15Definitions = [
  ...legacySkillSourceDefinitions,
  ...legacySkillLifecycleDefinitions.map(item => ({
    ...item, description: "Native-owned disposable fixture PKM Router projection only; no execution or general installation.",
  })),
  {
    id: "knowledge.legacy-links.resolve", readOnly: true,
    description: "Resolve original Script/Project locators against native, actor-filtered, root-pinned inventory. No external resolution.",
    input: z.strictObject({
      locator: z.string().min(1).max(2048),
      expectedPins: z.strictObject({ scripts: digest, projects: digest }).optional(),
    }), output: legacyScriptProjectResolveOutput,
  },
  {
    id: "knowledge.asset.ownership.validate", readOnly: true,
    description: "Validate unique asset ownership against native actor-filtered document assets; does not write or classify assets.",
    input: z.strictObject({
      path: z.string().min(1).max(2048), expectedDocumentSha256: digest,
      expectedAssetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), expectedRevision: digest,
    }), output: nativeAssetOwnershipOutput,
  },
] as const;
