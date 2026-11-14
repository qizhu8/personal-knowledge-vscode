import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { validateLegacyRetrievalLearningSnapshot } from "./legacy-retrieval-learning.js";

const row = z.array(z.union([z.string(), z.number().finite(), z.null()]));
export const legacyRetrievalLearningUpgradeSchema = z.strictObject({
  columns: z.strictObject({
    settings: z.array(z.string()), models: z.array(z.string()), calls: z.array(z.string()), query_judgments: z.array(z.string()),
  }),
  tables: z.strictObject({
    settings: z.array(row), models: z.array(row), calls: z.array(row).max(512), query_judgments: z.array(row),
  }),
});
export async function upgradeLegacyRetrievalLearningSnapshot(input: z.infer<typeof legacyRetrievalLearningUpgradeSchema>) {
  const safe = legacyRetrievalLearningUpgradeSchema.parse(input);
  return validateLegacyRetrievalLearningSnapshot(await runLegacyMcpPython(
    fileURLToPath(new URL("../compat/legacy-retrieval-learning.py", import.meta.url)), [], safe));
}
