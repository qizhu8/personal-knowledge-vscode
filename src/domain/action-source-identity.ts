import { createHash } from "node:crypto";
import { ORIGINAL_ACTION_COMPILER_CAPTURE } from "./action-compiler-original.js";
import { ACTION_SOURCE_V1_ORIGINAL } from "./action-source-v1-original.js";
import { ACTION_SOURCE_V2_CAPTURE } from "./action-source-v2-original.js";

/**
 * Development opt-in: PKM_ACTION_SOURCE_IDENTITY=frozen-original-v2; the default stays v1.
 * Verify fixture provenance with node scripts/check-action-source-v2.mjs --check.
 * This does not qualify or enable the trusted production host. Historical proposals/runs
 * remain bound to their original identity; no automatic upgrade, readmission or replay.
 * Process-start configuration only, never Action/MCP request or proposal authority.
 */
const requested = process.env.PKM_ACTION_SOURCE_IDENTITY ?? "compiler-capture-v1";
if (requested !== "compiler-capture-v1" && requested !== ACTION_SOURCE_V2_CAPTURE.identity) {
  throw new Error("Unknown PKM_ACTION_SOURCE_IDENTITY; choose compiler-capture-v1 or frozen-original-v2.");
}

if (requested === "compiler-capture-v1") {
  const { sourceHashes, componentEngineHash, originalRuntimeContentHash, originalRuntimeDigest,
    builtinDefinitions, ...shared } = ORIGINAL_ACTION_COMPILER_CAPTURE;
  // Only identity fields differed between generations. Authenticate every reused body,
  // schema and source string before applying the historical identity projection.
  const sharedCapture = {
    ...shared,
    builtinDefinitions: Object.fromEntries(Object.entries(builtinDefinitions).map(
      ([id, { implementation_hash, content_hash, ...definition }]) => [id, definition],
    )),
  };
  if (createHash("sha256").update(JSON.stringify(sharedCapture)).digest("hex")
    !== ACTION_SOURCE_V1_ORIGINAL.sharedCaptureSha256) {
    throw new Error("Action v1 shared capture differs from its authenticated historical generation.");
  }
}

export const ACTION_SOURCE_IDENTITY = Object.freeze(requested === "compiler-capture-v1" ? {
  identity: requested,
  sourceHashes: ACTION_SOURCE_V1_ORIGINAL.sourceHashes,
  componentEngineHash: ACTION_SOURCE_V1_ORIGINAL.componentEngineHash,
  builtinContentHashes: ACTION_SOURCE_V1_ORIGINAL.builtinContentHashes,
  qualification: "historical" as const,
} : {
  identity: requested,
  sourceHashes: ACTION_SOURCE_V2_CAPTURE.sourceHashes,
  componentEngineHash: ACTION_SOURCE_V2_CAPTURE.componentEngineHash,
  builtinContentHashes: ACTION_SOURCE_V2_CAPTURE.builtinContentHashes,
  qualification: ACTION_SOURCE_V2_CAPTURE.qualification,
});
