import { legacyClassificationNativeRequest, legacyClassificationNativeResult } from "./legacy-classification-native.js";
import { legacyMemoryErasureDefinitions } from "./legacy-memory-erasure.js";
import { legacyClassificationCommandDefinitions } from "./legacy-classification-command-contracts.js";

export const batch16Definitions = [{
  id: "knowledge.classification.native-strict.command",
  readOnly: false,
  description: "Opt-in native-owned disposable fixture classification; strict whole-selection contract, not the original partial-success API.",
  input: legacyClassificationNativeRequest,
  output: legacyClassificationNativeResult,
}, {
  id: "memory.scope.forget.native",
  readOnly: false,
  description: "Native human-approved logical erasure of derived Chat memory only; not Markdown, transcripts, or physical secure deletion.",
  input: legacyMemoryErasureDefinitions[0].input,
  output: legacyMemoryErasureDefinitions[0].output,
}, ...legacyClassificationCommandDefinitions] as const;
