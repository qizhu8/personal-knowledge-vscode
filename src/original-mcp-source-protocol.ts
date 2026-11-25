import { originalMcpPlanSchema } from "./original-mcp-root-custody.js";
import { originalNativeTrashRequestSchema } from "./original-native-trash-contracts.js";
import { nativeActionModuleSnapshot, nativeActionModuleByteFile } from "./action-module-bytes.js";
import { nativeActionPackageAdmission } from "./legacy-action-catalog.js";
import { actionGcRecord } from "./action-artifact-gc-records.js";
import { cosmosRecord } from "./original-mcp-action-maintenance.js";
import { nativeActionManagedArtifact } from "./legacy-action-artifacts.js";

// Protocol compatibility is separate from the SQLite schema and code inventory.
export const originalMcpSourceProtocol = Object.freeze({
  schema: "pkm.original-mcp-source-protocol/v1",
  custody: originalMcpPlanSchema.options.map(option => option.shape.schema.value),
  trash: originalNativeTrashRequestSchema.options.map(option => option.shape.schema.value),
  action: Object.freeze({
    source: [nativeActionModuleSnapshot.shape.fileEncoding.value, nativeActionModuleByteFile.shape.schema.value],
    catalog: [nativeActionPackageAdmission.shape.schema.value],
    gc: [actionGcRecord.shape.schema.value],
    cosmos: [cosmosRecord.shape.schema.value],
    artifacts: [nativeActionManagedArtifact.shape.storage.value],
  }),
});
