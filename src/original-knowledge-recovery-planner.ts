import { createHash } from "node:crypto";
import { z } from "zod";
import { documentPath } from "./document-path.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const planSchema = z.object({
  schema: z.literal("pkm.knowledge-recovery/v1"),
  knowledgeRoot: z.string(),
  files: z.array(z.object({
    path: z.string(), sha256: digest, mode: z.enum(["100644", "100755"]),
  })).max(1000),
});
export type OriginalRecoveryObservation =
  | { kind: "missing" }
  | { kind: "regular"; bytes: Uint8Array }
  | { kind: "unsafe" };
export interface OriginalRecoveryCapture {
  knowledgeRoot: string;
  planBytes: Uint8Array;
  expectedPlanSha256: string;
  blobs: ReadonlyMap<string, Uint8Array>;
  destinations: ReadonlyMap<string, OriginalRecoveryObservation>;
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/**
 * Pure, bounded Original preview over captured bytes, not a native source grant or
 * a restore executor. Even "missing" observations require separate owner custody.
 * Plan bytes are bounded to 2 MiB; all inspected source and regular destination
 * bytes together are bounded to 16 MiB, counting each plan row conservatively.
 */
export function planOriginalKnowledgeRecovery(capture: OriginalRecoveryCapture) {
  if (capture.planBytes.byteLength > 2_097_152) fail("RECOVERY_CAPTURE_TOO_LARGE");
  const raw = Buffer.from(capture.planBytes);
  const planSha256 = hash(raw);
  if (!digest.safeParse(capture.expectedPlanSha256).success || planSha256 !== capture.expectedPlanSha256)
    fail("RECOVERY_PLAN_HASH_MISMATCH");
  if (!Buffer.from(raw.toString("utf8")).equals(raw)) fail("RECOVERY_PLAN_INVALID_UTF8");
  const plan = planSchema.parse(JSON.parse(raw.toString("utf8")));
  if (plan.knowledgeRoot !== capture.knowledgeRoot) fail("RECOVERY_ROOT_MISMATCH");
  const seen = new Set<string>();
  const counts = { restore: 0, identical: 0, "preserve-existing": 0 };
  let total = 0;
  const files = plan.files.map(row => {
    const [area, ...parts] = row.path.split("/");
    if (!["notes", "skills"].includes(area!) || !documentPath.safeParse(parts.join("/")).success
      || parts[0]?.toLowerCase() === "system")
      fail("RECOVERY_PORTABLE_MARKDOWN_REQUIRED");
    if (seen.has(row.path)) fail("RECOVERY_DUPLICATE_DESTINATION");
    seen.add(row.path);
    const blob = capture.blobs.get(row.sha256);
    if (!blob) fail("RECOVERY_BLOB_HASH_MISMATCH");
    total += blob.byteLength;
    if (total > 16_777_216) fail("RECOVERY_CAPTURE_TOO_LARGE");
    if (hash(blob) !== row.sha256) fail("RECOVERY_BLOB_HASH_MISMATCH");
    const observed = capture.destinations.get(row.path);
    if (!observed) fail("RECOVERY_DESTINATION_OBSERVATION_REQUIRED");
    if (observed.kind !== "missing" && observed.kind !== "regular") fail("RECOVERY_UNSAFE_DESTINATION");
    if (observed.kind === "regular") total += observed.bytes.byteLength;
    if (total > 16_777_216) fail("RECOVERY_CAPTURE_TOO_LARGE");
    const status = observed.kind === "missing" ? "restore"
      : hash(observed.bytes) === row.sha256 ? "identical" : "preserve-existing";
    counts[status]++;
    return { path: row.path, status };
  });
  return {
    schema: "pkm.knowledge-recovery-preview/v1" as const,
    knowledge_root: capture.knowledgeRoot,
    plan_sha256: planSha256,
    counts,
    files,
  };
}
